import { randomBytes } from "node:crypto";
import type {
  AgentRevision,
  ComputeDriver,
  ComputeReadiness,
  Driver,
  Namespace,
  NamespaceDeleteResult,
  NamespaceEnsureResult,
  LoggingLevel,
} from "@openclaw-enterprise/contracts";
import { admittedLoggingLevel } from "@openclaw-enterprise/contracts";
import { immutableCopy, sha256Hex } from "@openclaw-enterprise/utils";
import { ComputeLifecycleDispatcher } from "../lifecycle-hooks.ts";
import {
  AGENT_READINESS_ENTRYPOINT,
  AGENT_RUNTIME_ENTRYPOINT,
} from "../kubernetes/runtime-entrypoints.ts";
import {
  dockerRequest,
  image,
  network,
  removeNetwork,
  container,
  removeContainer,
  statusCode,
} from "./client.ts";
import type { DockerContainerInspect, DockerNetworkInspect } from "./client.ts";
import {
  OwnershipFailure,
  REVISION_LABEL,
  ownershipMetadata,
  gatewayOwnership,
  agentOwnership,
  verifyOwnership,
  networkName,
  gatewayContainerName,
  agentContainerName,
  containerIdsForNamespace,
} from "./ownership.ts";
import type { Ownership } from "./ownership.ts";
import {
  ConfigurationFailure,
  required,
  optionalEnvironment,
  dockerLoggingAddress,
  runtimeContainerPayload,
  providerEnvironment,
  gatewayEnvironment,
  gatewayUsesTrustedProxy,
  agentEnvironment,
  GATEWAY_PORT,
  AGENT_TRANSPORT_PORT,
} from "./container-plan.ts";
import type { RuntimeContainerInput } from "./container-plan.ts";
import {
  healthy,
  validTopology,
  gatewayRevisionDisposition,
  REVISION_NUMBER_LABEL,
  CONFIGURATION_HASH_LABEL,
  HARNESS_VERSION_LABEL,
} from "./revisions.ts";

export interface DockerComputeDriverOptions {
  readonly images: {
    readonly gateway: string;
    readonly agent: string;
  };
  readonly loggingAddress?: string;
}

const DRIVER_ID = "compute-docker-development";
const DRIVER_IMPLEMENTATION = "docker-local";
const STARTUP_TIMEOUT_MS = 120_000;

const GATEWAY_RUNTIME_ENTRYPOINT = String.raw`
const { mkdirSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");

function forwardTermination(child) {
  let terminating = false;
  const forward = (signal) => {
    if (terminating) return;
    terminating = true;
    child.kill(signal);
    setTimeout(() => child.kill("SIGKILL"), 8_000).unref();
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
}

mkdirSync("/home/node/.openclaw", { recursive: true });
mkdirSync("/home/node/workspace", { recursive: true });
writeFileSync(process.env.OPENCLAW_CONFIG_PATH, process.env.OPENCLAW_CONFIG_JSON, { mode: 0o600 });
delete process.env.OPENCLAW_CONFIG_JSON;
delete process.env.OPENCLAW_LOG_LEVEL;
const child = spawn(
  "node",
  ["/app/openclaw.mjs", "gateway", "--port", process.env.OPENCLAW_GATEWAY_PORT],
  { stdio: "inherit" },
);
forwardTermination(child);
child.on("exit", (code, signal) => process.exit(code ?? (signal === "SIGTERM" ? 0 : 1)));
`;

function failure(error: unknown): "retryable" | "permanent" {
  return error instanceof OwnershipFailure ||
    error instanceof ConfigurationFailure ||
    [400, 401, 403, 404, 409, 422].includes(statusCode(error) ?? 0)
    ? "permanent"
    : "retryable";
}

export class DockerComputeDriver implements ComputeDriver {
  readonly id = DRIVER_ID;
  readonly capability = "compute" as const;
  readonly implementation = DRIVER_IMPLEMENTATION;
  private readonly options: DockerComputeDriverOptions;
  private lifecycle = new ComputeLifecycleDispatcher([]);
  private lifecycleStarted = false;

  constructor(options: DockerComputeDriverOptions) {
    required(options.images.gateway, "Docker gateway image");
    required(options.images.agent, "Docker Codex Agent image");
    const loggingAddress = dockerLoggingAddress(options.loggingAddress);
    this.options = immutableCopy({
      ...options,
      ...(loggingAddress === undefined ? {} : { loggingAddress }),
    });
  }

  setLifecycleDrivers(drivers: readonly Driver[]): void {
    if (this.lifecycleStarted) {
      throw new Error("Compute lifecycle Drivers cannot change after lifecycle operations begin.");
    }
    this.lifecycle = new ComputeLifecycleDispatcher(drivers);
  }

  async preflight(): Promise<void> {
    const ping = await this.request("GET", "/_ping", undefined, [200]);
    if (String(ping ?? "").trim() !== "OK") {
      throw new Error("Docker Engine ping returned an invalid response.");
    }
    await this.image(this.options.images.gateway);
    await this.image(this.options.images.agent);
  }

  async ensureNamespace(namespace: Namespace): Promise<NamespaceEnsureResult> {
    this.lifecycleStarted = true;
    const result = { namespaceId: namespace.id, namespaceReady: false };
    const name = this.networkName(namespace.id);
    let created = false;
    try {
      const ownership = { namespaceId: namespace.id };
      const existing = await this.network(name);
      if (existing === undefined) {
        await this.request(
          "POST",
          "/networks/create",
          {
            Name: name,
            Driver: "bridge",
            CheckDuplicate: true,
            Labels: this.ownershipMetadata(ownership),
          },
          [201],
        );
        created = true;
      } else {
        this.verifyOwnership(existing.Labels, ownership, `network ${name}`);
      }
      const observed = await this.network(name);
      if (observed === undefined) return result;
      this.verifyOwnership(observed.Labels, ownership, `network ${name}`);
      await this.lifecycle.afterNamespacePrepared(namespace);
      return { ...result, namespaceReady: true };
    } catch (error) {
      if (created) await this.removeNetwork(name).catch(() => {});
      return { ...result, failure: failure(error) };
    }
  }

  async deleteNamespace(namespace: Namespace): Promise<NamespaceDeleteResult> {
    this.lifecycleStarted = true;
    const result = { namespaceId: namespace.id, namespaceDeleted: false };
    const name = this.networkName(namespace.id);
    try {
      const existing = await this.network(name);
      if (existing === undefined) return { ...result, namespaceDeleted: true };
      this.verifyOwnership(existing.Labels, { namespaceId: namespace.id }, `network ${name}`);
      await this.lifecycle.beforeNamespaceDelete(namespace);
      for (const containerId of await this.containerIdsForNamespace(namespace.id)) {
        await this.removeContainer(containerId, true);
      }
      await this.removeNetwork(name);
      return { ...result, namespaceDeleted: true };
    } catch (error) {
      return { ...result, failure: failure(error) };
    }
  }

  async prepareRevision(revision: AgentRevision): Promise<ComputeReadiness> {
    this.lifecycleStarted = true;
    const result = {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      revisionId: revision.id,
      ready: false,
    };
    if (
      revision.compute.id !== this.id ||
      revision.compute.implementation !== this.implementation ||
      !validTopology(revision) ||
      revision.servicePrincipalId.trim().length === 0
    ) {
      return result;
    }
    if (
      revision.configurationKind !== "agent" ||
      !Number.isSafeInteger(revision.revision) ||
      revision.revision < 1 ||
      !Number.isSafeInteger(revision.configurationGeneration) ||
      revision.configurationGeneration < 1
    ) {
      throw new ConfigurationFailure("AgentRevision Configuration ownership is invalid.");
    }

    const network = this.networkName(revision.namespaceId);
    const observed = await this.network(network);
    if (observed === undefined) return result;
    this.verifyOwnership(
      observed.Labels,
      { namespaceId: revision.namespaceId },
      `network ${network}`,
    );

    const loggingLevel = admittedLoggingLevel(revision.configuration);
    const prepared = immutableCopy(revision);
    let launchPrepared = false;
    let agentCreated: string | undefined;
    let gatewayCreated: string | undefined;
    try {
      const launch = await this.lifecycle.beforeWorkloadStart(prepared);
      launchPrepared = true;
      const provider = this.providerEnvironment();
      if (prepared.harness.mode === "embedded") {
        const gateway = await this.reconcileGateway(prepared, network, {
          ...provider,
          ...launch.environment,
        });
        gatewayCreated = gateway.created ? gateway.containerName : undefined;
        return { ...result, ready: gateway.ready };
      }

      const appServerToken = randomBytes(32).toString("hex");
      const agent = await this.reconcileAgent(prepared, network, appServerToken, loggingLevel, {
        ...provider,
        ...launch.environment,
      });
      agentCreated = agent.created ? agent.containerName : undefined;
      if (!agent.ready) return result;
      const gateway = await this.reconcileGateway(prepared, network, {
        APP_SERVER_URL: `ws://${agent.containerName}:${AGENT_TRANSPORT_PORT}`,
        APP_SERVER_TOKEN: appServerToken,
      });
      gatewayCreated = gateway.created ? gateway.containerName : undefined;
      return { ...result, ready: gateway.ready };
    } catch (error) {
      const failures = [error];
      for (const name of [gatewayCreated, agentCreated]) {
        if (name === undefined) continue;
        try {
          await this.removeContainer(name, true);
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (launchPrepared) {
        try {
          await this.lifecycle.beforeWorkloadStop(prepared, { cleanup: true });
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Docker workload preparation and cleanup failed.");
      }
      throw error;
    }
  }

  async retireRevision(revision: AgentRevision): Promise<void> {
    this.lifecycleStarted = true;
    if (
      revision.compute.id !== this.id ||
      revision.compute.implementation !== this.implementation
    ) {
      throw new Error("Refusing to retire an AgentRevision pinned to another Compute Driver.");
    }
    await this.lifecycle.beforeWorkloadStop(revision);
    const agentName = this.agentContainerName(revision.namespaceId, revision.agentId, revision.id);
    const agent = await this.container(agentName);
    if (agent !== undefined) {
      this.verifyOwnership(
        agent.Config?.Labels,
        this.agentOwnership(revision),
        `container ${agentName}`,
      );
      await this.removeContainer(agentName, true);
    }
    const gatewayName = this.gatewayContainerName(revision.namespaceId, revision.agentId);
    const gateway = await this.container(gatewayName);
    if (gateway !== undefined) {
      this.verifyOwnership(
        gateway.Config?.Labels,
        this.gatewayOwnership(revision),
        `container ${gatewayName}`,
      );
      if (gateway.Config?.Labels?.[REVISION_LABEL] === revision.id) {
        await this.removeContainer(gatewayName, true);
      }
    }
  }

  private async reconcileGateway(
    revision: Readonly<AgentRevision>,
    network: string,
    environment: Readonly<Record<string, string>>,
  ): Promise<{
    readonly containerName: string;
    readonly created: boolean;
    readonly ready: boolean;
  }> {
    const containerName = this.gatewayContainerName(revision.namespaceId, revision.agentId);
    const ownership = this.gatewayOwnership(revision);
    const existing = await this.container(containerName);
    const configuration = JSON.stringify(revision.configuration);
    const configurationHash = sha256Hex(configuration, 32);
    if (existing !== undefined) {
      this.verifyOwnership(existing.Config?.Labels, ownership, `container ${containerName}`);
      const disposition = gatewayRevisionDisposition(
        existing,
        revision,
        configurationHash,
        containerName,
      );
      if (disposition === "stale") return { containerName, created: false, ready: false };
      if (disposition === "ready") return { containerName, created: false, ready: true };
      await this.removeContainer(containerName, true);
    }

    const inspect = await this.createRuntimeContainer({
      name: containerName,
      image: this.options.images.gateway,
      network,
      ownership,
      role: "gateway",
      environment: gatewayEnvironment(
        configuration,
        environment,
        // Native trusted-proxy authentication rejects a simultaneously configured shared token.
        gatewayUsesTrustedProxy(revision.configuration)
          ? undefined
          : randomBytes(32).toString("hex"),
      ),
      command: GATEWAY_RUNTIME_ENTRYPOINT,
      healthcheckScript: `fetch("http://127.0.0.1:${GATEWAY_PORT}/readyz").then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));`,
      exposedPort: GATEWAY_PORT,
      labels: {
        [REVISION_LABEL]: revision.id,
        [REVISION_NUMBER_LABEL]: String(revision.revision),
        [CONFIGURATION_HASH_LABEL]: configurationHash,
        [HARNESS_VERSION_LABEL]: revision.harness.version,
      },
      portBindings: {
        [`${GATEWAY_PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "" }],
      },
    });
    this.verifyOwnership(inspect.Config?.Labels, ownership, `container ${containerName}`);
    return { containerName, created: true, ready: true };
  }

  private async reconcileAgent(
    revision: Readonly<AgentRevision>,
    network: string,
    appServerToken: string,
    loggingLevel: LoggingLevel,
    environment: Readonly<Record<string, string>>,
  ): Promise<{
    readonly containerName: string;
    readonly created: boolean;
    readonly ready: boolean;
  }> {
    const containerName = this.agentContainerName(
      revision.namespaceId,
      revision.agentId,
      revision.id,
    );
    const ownership = this.agentOwnership(revision);
    const existing = await this.container(containerName);
    if (existing !== undefined) {
      this.verifyOwnership(existing.Config?.Labels, ownership, `container ${containerName}`);
      if (healthy(existing)) return { containerName, created: false, ready: true };
      await this.removeContainer(containerName, true);
    }
    await this.createRuntimeContainer({
      name: containerName,
      image: this.options.images.agent,
      network,
      ownership,
      role: "agent",
      environment: agentEnvironment(environment, appServerToken, loggingLevel),
      command: AGENT_RUNTIME_ENTRYPOINT,
      healthcheckScript: AGENT_READINESS_ENTRYPOINT,
      exposedPort: AGENT_TRANSPORT_PORT,
      labels: {
        [REVISION_LABEL]: revision.id,
        [REVISION_NUMBER_LABEL]: String(revision.revision),
        [HARNESS_VERSION_LABEL]: revision.harness.version,
      },
    });
    return { containerName, created: true, ready: true };
  }

  private async createRuntimeContainer(
    input: RuntimeContainerInput,
  ): Promise<DockerContainerInspect> {
    await this.request(
      "POST",
      `/containers/create?name=${encodeURIComponent(input.name)}`,
      runtimeContainerPayload(input, this.options.loggingAddress),
      [201],
    );
    try {
      await this.request(
        "POST",
        `/containers/${encodeURIComponent(input.name)}/start`,
        undefined,
        [204, 304],
      );
      return await this.waitForHealthyContainer(input.name);
    } catch (error) {
      await this.removeContainer(input.name, true).catch(() => {});
      throw error;
    }
  }

  private providerEnvironment(): Readonly<Record<string, string>> {
    return providerEnvironment(process.env.OPENAI_API_KEY);
  }

  private ownershipMetadata(ownership: Ownership): Record<string, string> {
    return ownershipMetadata(ownership);
  }

  private gatewayOwnership(revision: Readonly<AgentRevision>): Ownership {
    return gatewayOwnership(revision);
  }

  private agentOwnership(revision: Readonly<AgentRevision>): Ownership {
    return agentOwnership(revision);
  }

  private verifyOwnership(
    labels: Readonly<Record<string, string>> | undefined,
    ownership: Ownership,
    description: string,
  ): void {
    return verifyOwnership(labels, ownership, description);
  }

  private networkName(namespaceId: string): string {
    return networkName(namespaceId);
  }

  private gatewayContainerName(namespaceId: string, agentId: string): string {
    return gatewayContainerName(namespaceId, agentId);
  }

  private agentContainerName(namespaceId: string, agentId: string, revisionId: string): string {
    return agentContainerName(namespaceId, agentId, revisionId);
  }

  private async image(ref: string): Promise<void> {
    return image(this.request.bind(this), ref);
  }

  private async network(name: string): Promise<DockerNetworkInspect | undefined> {
    return network(this.request.bind(this), name);
  }

  private async removeNetwork(name: string): Promise<void> {
    return removeNetwork(this.request.bind(this), name);
  }

  private async container(name: string): Promise<DockerContainerInspect | undefined> {
    return container(this.request.bind(this), name);
  }

  private async containerIdsForNamespace(namespaceId: string): Promise<readonly string[]> {
    return containerIdsForNamespace(
      this.request.bind(this),
      this.container.bind(this),
      namespaceId,
    );
  }

  private async removeContainer(name: string, force: boolean): Promise<void> {
    return removeContainer(this.request.bind(this), name, force);
  }

  private async waitForHealthyContainer(name: string): Promise<DockerContainerInspect> {
    const started = Date.now();
    while (Date.now() - started < STARTUP_TIMEOUT_MS) {
      const inspected = await this.container(name);
      if (inspected === undefined) throw new Error(`Docker container ${name} disappeared.`);
      if (healthy(inspected)) return inspected;
      if (inspected.State?.Running === false) {
        throw new Error(`Docker container ${name} exited before readiness.`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Docker container ${name} readiness timed out.`);
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    expected: readonly number[],
  ): Promise<unknown> {
    return dockerRequest(method, path, body, expected);
  }
}

export function createDockerDevelopmentComputeDriverFromEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DockerComputeDriver {
  const shared = optionalEnvironment(environment.OCC_DOCKER_RUNTIME_IMAGE);
  const loggingAddress = dockerLoggingAddress(environment.OCC_DOCKER_LOGGING_ADDRESS);
  return new DockerComputeDriver({
    images: {
      gateway: optionalEnvironment(environment.OCC_DOCKER_GATEWAY_IMAGE) ?? shared ?? "",
      agent: optionalEnvironment(environment.OCC_DOCKER_AGENT_IMAGE) ?? shared ?? "",
    },
    ...(loggingAddress === undefined ? {} : { loggingAddress }),
  });
}
