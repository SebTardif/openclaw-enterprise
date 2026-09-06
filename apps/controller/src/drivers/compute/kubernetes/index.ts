import { KubernetesOwnership, OwnershipFailure, verifyNamespaceOwnership } from "./ownership.ts";
export { kubernetesNamespaceName, resolveKubernetesNamespace } from "./ownership.ts";
import type {
  KubernetesRecord,
  ManagedKubernetesObject,
  ReadableResourceKind,
} from "./ownership.ts";
import { KubernetesConditionalMutations } from "./conditional-mutations.ts";
import { KubernetesReadiness, IsolationFailure } from "./readiness.ts";
import { KubernetesRouting } from "./routing.ts";
import { KubernetesCleanup } from "./cleanup.ts";
import {
  KubernetesRuntimeObservations,
  type KubernetesRuntimeObservationDependencies,
} from "./runtime-observations.ts";
import * as KubernetesIdentity from "./resources/identity.ts";
import * as KubernetesNetwork from "./resources/network.ts";
import * as KubernetesGateway from "./resources/gateway.ts";
import * as KubernetesStorage from "./resources/storage.ts";
import * as KubernetesChannelPolicy from "./resources/channel-policy.ts";
import * as KubernetesSecretProjection from "./resources/secret-projection.ts";
import * as KubernetesHarness from "./resources/harness.ts";
import type { Ownership } from "./resources/identity.ts";
import { ConfigurationFailure } from "./resources/identity.ts";
import { TOKEN_PATH } from "./resources/identity.ts";
import { AGENT_REVISION_ANNOTATION } from "./resources/identity.ts";
import { AGENT_REVISION_ID_ANNOTATION } from "./resources/identity.ts";
export { GVISOR_RUNTIME_CLASS } from "./resources/identity.ts";
import { required } from "./resources/identity.ts";
import type { KubernetesWorkloadPeer } from "./resources/network.ts";
export type { KubernetesWorkloadPeer } from "./resources/network.ts";
import type { KubernetesGatewayRoutingOptions } from "./resources/gateway.ts";
export type { KubernetesGatewayRoutingOptions } from "./resources/gateway.ts";
import type { GatewayConfigurationSnapshot } from "./resources/gateway.ts";
import { CONFIGURATION_VOLUME } from "./resources/gateway.ts";
import { GATEWAY_API_VERSION } from "./resources/gateway.ts";
import { SHARED_WORKSPACE_VOLUME } from "./resources/storage.ts";
import type { SharedWorkspaceRole } from "./resources/storage.ts";
import { CHANNEL_REQUIREMENTS } from "./resources/channel-policy.ts";
import type { ChannelRequirements } from "./resources/channel-policy.ts";
import { channelProxy } from "./resources/channel-policy.ts";
import { SERVICE_ACCOUNT_TOKEN_KEY } from "./resources/secret-projection.ts";
import { SERVICE_ACCOUNT_WORKSPACE_KEY } from "./resources/secret-projection.ts";
import { asRecord, immutableCopy, numericErrorStatus, sha256Hex } from "@openclaw-enterprise/utils";
import { isAbsolute } from "node:path";
import type {
  AppsV1Api,
  CoreV1Api,
  DiscoveryV1Api,
  KubernetesObjectApi,
  NetworkingV1Api,
  V1NetworkPolicyPeer,
  V1ResourceRequirements,
  V1VolumeMount,
} from "@kubernetes/client-node";
import type {
  AgentRevision,
  ComputeDriver,
  ComputeReadiness,
  ComputeRevisionContext,
  Driver,
  HarnessWorkloadRequirements,
  Namespace,
  NamespaceDeleteResult,
  NamespaceEnsureResult,
  SandboxDriver,
  SandboxEnvironmentVariable,
  SandboxNamespaceContext,
  SandboxResourceRef,
  SandboxWorkspaceMount,
  SecretEnvironmentProjection,
  LoggingLevel,
  ExactCreateEffectV1,
  DiscoveryResultV1,
  RuntimeObservationInputV1,
  RuntimeObservationResultV1,
  RuntimeReadCallV1,
} from "@openclaw-enterprise/contracts";
import { createKubernetesClientConfiguration } from "../../kubernetes/client.ts";
import { ComputeLifecycleDispatcher } from "../lifecycle-hooks.ts";
import { currentComputeAbortSignal, withComputeAbortSignal } from "../operation-context.ts";

interface KubernetesApiClients {
  readonly core: CoreV1Api;
  readonly apps: AppsV1Api;
  readonly discovery: DiscoveryV1Api;
  readonly networking: NetworkingV1Api;
  readonly objects: KubernetesObjectApi;
}

export const GVISOR_IMPLEMENTATION = "occ/kubernetes-gvisor";

export interface KubernetesComputeDriverOptions {
  readonly isolationProfile?: "gvisor-systrap";
  readonly authentication:
    | { readonly mode: "inCluster" }
    | { readonly mode: "kubeconfig"; readonly kubeconfigPath: string; readonly context: string };
  readonly images: {
    readonly gateway: string;
    readonly agent: string;
    readonly requireImmutableDigest: boolean;
  };
  readonly resources: {
    readonly gateway: V1ResourceRequirements;
    readonly agent: V1ResourceRequirements;
    readonly namespace: {
      readonly quota: Readonly<Record<string, string>>;
      readonly containerDefaults: V1ResourceRequirements;
    };
  };
  readonly network: {
    readonly dns: KubernetesWorkloadPeer;
    readonly gatewayPort: number;
    readonly gatewayClients?: readonly KubernetesWorkloadPeer[];
  };
  readonly servicePrincipalCredentials:
    | { readonly mode: "disabled" }
    | {
        readonly mode: "projectedServiceAccountToken";
        readonly audience: string;
        readonly expirationSeconds: number;
      };
  readonly runtime?: {
    readonly transportSecretPrefix: string;
    readonly modelSecretPrefix: string;
    readonly gatewayStorageClassName: string;
    readonly channels?: {
      readonly secretPrefix: string;
      readonly proxyUrl: string;
    };
  };
  readonly gatewayRouting?: KubernetesGatewayRoutingOptions;
}

const APPLY_CONTENT_TYPE = "application/apply-patch+yaml";
const REQUEST_TIMEOUT_MS = 10_000;
const RESOURCE_REQUIREMENTS_SCHEMA = Object.freeze({
  type: "object",
  required: ["requests", "limits"],
  additionalProperties: false,
  properties: {
    requests: {
      type: "object",
      required: ["cpu", "memory"],
      additionalProperties: false,
      properties: { cpu: { type: "string" }, memory: { type: "string" } },
    },
    limits: {
      type: "object",
      required: ["cpu", "memory"],
      additionalProperties: false,
      properties: { cpu: { type: "string" }, memory: { type: "string" } },
    },
  },
});
const WORKLOAD_PEER_SCHEMA = Object.freeze({
  type: "object",
  required: ["namespace", "podLabels"],
  additionalProperties: false,
  properties: {
    namespace: { type: "string" },
    podLabels: { type: "object", additionalProperties: { type: "string" } },
  },
});

function failure(error: unknown): "retryable" | "permanent" {
  return error instanceof OwnershipFailure ||
    error instanceof ConfigurationFailure ||
    [400, 401, 403, 422].includes(numericErrorStatus(error) ?? 0)
    ? "permanent"
    : "retryable";
}

function validatePort(value: number, description: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new ConfigurationFailure(`${description} must be a valid port.`);
  }
}

function validateResources(value: V1ResourceRequirements, description: string): void {
  const resources = asRecord(value);
  const requests = asRecord(resources?.requests);
  const limits = asRecord(resources?.limits);
  if (requests === undefined || limits === undefined) {
    throw new ConfigurationFailure(`${description} requests and limits must be configured.`);
  }
  required(requests.cpu, `${description} CPU request`);
  required(requests.memory, `${description} memory request`);
  required(limits.cpu, `${description} CPU limit`);
  required(limits.memory, `${description} memory limit`);
}

function validatePeer(value: KubernetesWorkloadPeer, description: string): void {
  if (asRecord(value) === undefined) throw new ConfigurationFailure(`${description} is required.`);
  required(value.namespace, `${description} namespace`);
  const labels = asRecord(value.podLabels);
  if (labels === undefined || Object.keys(labels).length === 0) {
    throw new ConfigurationFailure(`${description} Pod labels cannot be empty.`);
  }
  for (const [key, label] of Object.entries(labels)) {
    required(key, `${description} label key`);
    if (typeof label !== "string")
      throw new ConfigurationFailure(`${description} labels must be strings.`);
  }
}

function validateDnsHostname(value: string, description: string): void {
  if (
    value.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(value)
  ) {
    throw new ConfigurationFailure(`${description} must be a DNS hostname without a port or path.`);
  }
}

function validateKubernetesResourceName(value: string, description: string): void {
  if (
    value.length > 253 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(value)
  ) {
    throw new ConfigurationFailure(`${description} must be a DNS-safe Kubernetes resource name.`);
  }
}

export class KubernetesComputeDriver implements ComputeDriver {
  static readonly configurationSchema = Object.freeze({
    type: "object",
    required: ["authentication", "images", "resources", "network", "servicePrincipalCredentials"],
    additionalProperties: false,
    properties: {
      isolationProfile: { enum: ["gvisor-systrap"] },
      authentication: {
        type: "object",
        required: ["mode"],
        additionalProperties: false,
        properties: {
          mode: { enum: ["inCluster", "kubeconfig"] },
          kubeconfigPath: { type: "string" },
          context: { type: "string" },
        },
      },
      images: {
        type: "object",
        required: ["gateway", "agent", "requireImmutableDigest"],
        additionalProperties: false,
        properties: {
          gateway: { type: "string" },
          agent: { type: "string" },
          requireImmutableDigest: { type: "boolean" },
        },
      },
      resources: {
        type: "object",
        required: ["gateway", "agent", "namespace"],
        additionalProperties: false,
        properties: {
          gateway: RESOURCE_REQUIREMENTS_SCHEMA,
          agent: RESOURCE_REQUIREMENTS_SCHEMA,
          namespace: {
            type: "object",
            required: ["quota", "containerDefaults"],
            additionalProperties: false,
            properties: {
              quota: { type: "object", additionalProperties: { type: "string" } },
              containerDefaults: RESOURCE_REQUIREMENTS_SCHEMA,
            },
          },
        },
      },
      network: {
        type: "object",
        required: ["dns", "gatewayPort"],
        additionalProperties: false,
        properties: {
          dns: WORKLOAD_PEER_SCHEMA,
          gatewayPort: { type: "integer" },
          gatewayClients: { type: "array", items: WORKLOAD_PEER_SCHEMA },
        },
      },
      servicePrincipalCredentials: {
        type: "object",
        required: ["mode"],
        additionalProperties: false,
        properties: {
          mode: { enum: ["disabled", "projectedServiceAccountToken"] },
          audience: { type: "string" },
          expirationSeconds: { type: "integer" },
        },
      },
      runtime: {
        type: "object",
        required: ["transportSecretPrefix", "modelSecretPrefix", "gatewayStorageClassName"],
        additionalProperties: false,
        properties: {
          transportSecretPrefix: { type: "string" },
          modelSecretPrefix: { type: "string" },
          gatewayStorageClassName: { type: "string", minLength: 1 },
          channels: {
            type: "object",
            required: ["secretPrefix", "proxyUrl"],
            additionalProperties: false,
            properties: {
              secretPrefix: { type: "string" },
              proxyUrl: { type: "string" },
            },
          },
        },
      },
      gatewayRouting: {
        type: "object",
        required: ["gatewayName", "gatewayNamespace", "envoyNamespace"],
        additionalProperties: false,
        properties: {
          hostname: { type: "string" },
          gatewayName: { type: "string" },
          gatewayNamespace: { type: "string" },
          envoyNamespace: { type: "string" },
        },
      },
    },
  });

  readonly id: string;
  readonly capability = "compute" as const;
  readonly implementation: string;
  private readonly options: KubernetesComputeDriverOptions;
  private readonly sandboxDriver: SandboxDriver | undefined;
  private lifecycle: ComputeLifecycleDispatcher;
  private lifecycleStarted = false;
  private readonly ownership: KubernetesOwnership;
  private readonly mutations: KubernetesConditionalMutations;
  private readonly readiness: KubernetesReadiness;
  private readonly routing: KubernetesRouting;
  private readonly cleanup: KubernetesCleanup;
  private readonly runtimeObservations: KubernetesRuntimeObservations;
  private apiClients: Promise<KubernetesApiClients> | undefined;
  private patchOptions:
    ReturnType<typeof import("@kubernetes/client-node").setHeaderOptions> | undefined;

  static validateConfiguration(configuration: unknown): void {
    const candidate = asRecord(configuration);
    if (candidate === undefined) throw new ConfigurationFailure("Kubernetes options are required.");
    if ("clients" in candidate) {
      throw new ConfigurationFailure("Injected Kubernetes API clients are not supported.");
    }
    for (const key of Object.keys(candidate)) {
      if (!(key in KubernetesComputeDriver.configurationSchema.properties)) {
        throw new ConfigurationFailure(
          `The Kubernetes driver configuration contains unsupported option ${key}.`,
        );
      }
    }
    const options = candidate as unknown as KubernetesComputeDriverOptions;
    if (options.isolationProfile !== undefined) {
      if (options.isolationProfile !== "gvisor-systrap") {
        throw new ConfigurationFailure("Unsupported isolation profile.");
      }
    }
    const authentication = options.authentication;
    if (asRecord(authentication) === undefined) {
      throw new ConfigurationFailure(
        "Exactly one explicit Kubernetes authentication mode is required.",
      );
    }
    if (authentication.mode === "inCluster") {
      if ("kubeconfigPath" in authentication || "context" in authentication) {
        throw new ConfigurationFailure(
          "In-cluster and kubeconfig authentication cannot be combined.",
        );
      }
    } else if (authentication.mode === "kubeconfig") {
      const path = required(authentication.kubeconfigPath, "Dedicated kubeconfig path");
      if (!isAbsolute(path))
        throw new ConfigurationFailure("Dedicated kubeconfig path must be absolute.");
      required(authentication.context, "Explicit Kubernetes context");
    } else {
      throw new ConfigurationFailure(
        "Exactly one explicit Kubernetes authentication mode is required.",
      );
    }
    if (
      asRecord(options.images) === undefined ||
      typeof options.images.requireImmutableDigest !== "boolean"
    ) {
      throw new ConfigurationFailure(
        "Image references and immutable-image policy must be configured.",
      );
    }
    for (const [description, image] of [
      ["Gateway", options.images.gateway],
      ["Agent", options.images.agent],
    ] as const) {
      required(image, `${description} image`);
      if (options.images.requireImmutableDigest && !/@sha256:[a-f0-9]{64}$/i.test(image)) {
        throw new ConfigurationFailure(
          `${description} image must use an immutable SHA-256 digest.`,
        );
      }
    }
    if (
      asRecord(options.resources) === undefined ||
      asRecord(options.resources.namespace) === undefined
    ) {
      throw new ConfigurationFailure("Workload and namespace resource policies are required.");
    }
    validateResources(options.resources.gateway, "Gateway");
    validateResources(options.resources.agent, "Agent");
    validateResources(options.resources.namespace.containerDefaults, "Namespace default");
    const quota = asRecord(options.resources.namespace.quota);
    if (quota === undefined || Object.keys(quota).length === 0) {
      throw new ConfigurationFailure("Namespace resource quota must be configured.");
    }
    for (const [key, quantity] of Object.entries(quota)) {
      required(key, "Quota resource");
      required(quantity, `Quota ${key}`);
    }
    if (asRecord(options.network) === undefined)
      throw new ConfigurationFailure("Network policy is required.");
    validatePeer(options.network.dns, "DNS peer");
    validatePort(options.network.gatewayPort, "Gateway port");
    const hasDirectGatewayClients = Object.hasOwn(options.network, "gatewayClients");
    if (options.gatewayRouting === undefined) {
      if (
        !Array.isArray(options.network.gatewayClients) ||
        options.network.gatewayClients.length === 0
      ) {
        throw new ConfigurationFailure("At least one exact gateway client peer is required.");
      }
      options.network.gatewayClients.forEach((peer, index) =>
        validatePeer(peer, `Gateway client ${index}`),
      );
    } else if (hasDirectGatewayClients) {
      throw new ConfigurationFailure(
        "Gateway routing derives the Envoy gateway client peer; do not configure network.gatewayClients.",
      );
    }
    const credentials = options.servicePrincipalCredentials;
    if (asRecord(credentials) === undefined) {
      throw new ConfigurationFailure(
        "ServicePrincipal credential projection must be explicitly configured.",
      );
    }
    if (credentials.mode === "projectedServiceAccountToken") {
      required(credentials.audience, "ServicePrincipal token audience");
      const expiration = credentials.expirationSeconds;
      if (!Number.isSafeInteger(expiration) || expiration < 600 || expiration > 86_400) {
        throw new ConfigurationFailure(
          "ServicePrincipal token expiration must be between 600 and 86400 seconds.",
        );
      }
    } else if (credentials.mode !== "disabled") {
      throw new ConfigurationFailure(
        "ServicePrincipal credential projection must be explicitly configured.",
      );
    }
    if (options.runtime !== undefined) {
      const { transportSecretPrefix, modelSecretPrefix, channels } = options.runtime;
      required(transportSecretPrefix, "Agent transport Secret name prefix");
      required(modelSecretPrefix, "Agent model Secret name prefix");
      required(options.runtime.gatewayStorageClassName, "SQLite-compatible gateway storage class");
      if (transportSecretPrefix === modelSecretPrefix) {
        throw new ConfigurationFailure(
          "Gateway, Agent transport, and model credentials must remain separate.",
        );
      }
      if (channels !== undefined) {
        if (asRecord(channels) === undefined) {
          throw new ConfigurationFailure(
            "Channel runtime credentials must be explicitly configured.",
          );
        }
        const prefix = required(channels.secretPrefix, "Agent channel Secret name prefix");
        if ([transportSecretPrefix, modelSecretPrefix].includes(prefix)) {
          throw new ConfigurationFailure("Agent channel credentials must remain separate.");
        }
        channelProxy(channels.proxyUrl);
      }
    }
    if (options.gatewayRouting !== undefined) {
      const routing = options.gatewayRouting;
      if (asRecord(routing) === undefined) {
        throw new ConfigurationFailure("Gateway routing must be explicitly configured.");
      }
      if (routing.hostname !== undefined) {
        if (typeof routing.hostname !== "string") {
          throw new ConfigurationFailure(
            "Gateway routing hostname must be a DNS hostname without a port or path.",
          );
        }
        if (routing.hostname.length > 0) {
          validateDnsHostname(routing.hostname, "Gateway routing hostname");
        }
      }
      validateKubernetesResourceName(
        required(routing.gatewayName, "Gateway routing Gateway name"),
        "Gateway routing Gateway name",
      );
      validateKubernetesResourceName(
        required(routing.gatewayNamespace, "Gateway routing Gateway namespace"),
        "Gateway routing Gateway namespace",
      );
      validateKubernetesResourceName(
        required(routing.envoyNamespace, "Gateway routing Envoy namespace"),
        "Gateway routing Envoy namespace",
      );
    }
  }

  constructor(
    options: KubernetesComputeDriverOptions,
    selection: {
      readonly id?: string;
      readonly implementation?: string;
      readonly lifecycleDrivers?: readonly Driver[];
      readonly sandboxDriver?: SandboxDriver;
      readonly runtimeObservationDependencies?: KubernetesRuntimeObservationDependencies;
    } = {},
  ) {
    KubernetesComputeDriver.validateConfiguration(options);
    this.id = required(selection.id ?? "compute-kubernetes-local", "Kubernetes Compute Driver ID");
    const gvisor = options.isolationProfile === "gvisor-systrap";
    this.implementation = required(
      selection.implementation ?? (gvisor ? GVISOR_IMPLEMENTATION : "kubernetes-local"),
      "Kubernetes Compute Driver implementation",
    );
    if (gvisor !== (this.implementation === GVISOR_IMPLEMENTATION)) {
      throw new ConfigurationFailure("gVisor Alpha requires its distinct Compute implementation.");
    }
    if (gvisor && selection.sandboxDriver !== undefined) {
      throw new ConfigurationFailure("gVisor Alpha cannot be combined with a SandboxDriver.");
    }
    this.options = immutableCopy(options);
    this.sandboxDriver = selection.sandboxDriver;
    this.lifecycle = new ComputeLifecycleDispatcher(selection.lifecycleDrivers ?? []);
    this.runtimeObservations = new KubernetesRuntimeObservations(
      {
        clients: () => this.clients(),
        request: (operation) => this.request(operation),
      },
      selection.runtimeObservationDependencies,
      this.options.isolationProfile,
    );
    this.ownership = new KubernetesOwnership(
      {
        clients: () => this.clients(),
        request: (operation, options) => this.request(operation, options),
        get: (kind, name, namespace) => this.get(kind, name, namespace),
        patchOptions: () => this.patchOptions,
      },
      () => this.gatewayMembershipLabels(),
    );
    this.mutations = new KubernetesConditionalMutations({
      clients: () => this.clients(),
      request: (operation, options) => this.request(operation, options),
      getOwned: (kind, name, namespace, ownership) =>
        this.getOwned(kind, name, namespace, ownership),
      patchOptions: () => this.patchOptions,
    });
    this.readiness = new KubernetesReadiness(
      {
        clients: () => this.clients(),
        request: (operation, options) => this.request(operation, options),
        getOwned: (kind, name, namespace, ownership) =>
          this.getOwned(kind, name, namespace, ownership),
      },
      this.options.isolationProfile,
    );
    this.routing = new KubernetesRouting(
      {
        clients: () => this.clients(),
        request: (operation, options) => this.request(operation, options),
        getOwned: (kind, name, namespace, ownership) =>
          this.getOwned(kind, name, namespace, ownership),
        reconcile: (desired, ownership, namespace) => this.reconcile(desired, ownership, namespace),
      },
      {
        gatewayRouting: this.options.gatewayRouting,
        gatewayPort: this.options.network.gatewayPort,
      },
    );
    this.cleanup = new KubernetesCleanup(
      {
        clients: () => this.clients(),
        request: (operation, options) => this.request(operation, options),
        getOwned: (kind, name, namespace, ownership) =>
          this.getOwned(kind, name, namespace, ownership),
        gatewayRouteForRevision: (name, ownership, namespace, revisionId) =>
          this.routing.gatewayRouteForRevision(name, ownership, namespace, revisionId),
        deleteGatewayRoute: (name, ownership, namespace, revisionId) =>
          this.routing.deleteGatewayRoute(name, ownership, namespace, revisionId),
      },
      {
        runtimeEnabled: this.options.runtime !== undefined,
        gatewayStorageClassName: this.options.runtime?.gatewayStorageClassName,
      },
    );
  }

  setLifecycleDrivers(drivers: readonly Driver[]): void {
    if (this.lifecycleStarted) {
      throw new Error("Compute lifecycle owners cannot change after lifecycle operations begin.");
    }
    this.lifecycle = new ComputeLifecycleDispatcher(drivers);
  }

  discover(input: ExactCreateEffectV1, call: RuntimeReadCallV1): Promise<DiscoveryResultV1> {
    return this.runtimeObservations.discover(input, call);
  }

  observe(
    input: RuntimeObservationInputV1,
    call: RuntimeReadCallV1,
  ): Promise<RuntimeObservationResultV1> {
    return this.runtimeObservations.observe(input, call);
  }

  async preflight(): Promise<void> {
    await this.verifyIsolationProfile();
    const clients = await this.clients();
    const namespaces = await this.request(() =>
      clients.core.listNamespace({
        limit: 1,
        timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
      }),
    );
    if (!Array.isArray(namespaces.items)) {
      throw new Error("The authenticated Kubernetes Namespace preflight returned invalid data.");
    }
  }

  getGatewayEndpoint(revision: AgentRevision): string | undefined {
    const routing = this.options.gatewayRouting;
    if (routing === undefined) return undefined;
    return `wss://${this.gatewayRoutingHostname(routing)}${this.gatewayRoutePath(revision)}`;
  }

  async storeServiceAccountCredential(input: {
    readonly namespaceId: string;
    readonly serviceAccountId: string;
    readonly accessToken: string;
    readonly workspaceId: string;
  }): Promise<{ readonly name: string; readonly key: string }> {
    const namespaceId = required(input.namespaceId, "ServiceAccount Namespace ID");
    const serviceAccountId = required(input.serviceAccountId, "ServiceAccount ID");
    const accessToken = required(input.accessToken, "ServiceAccount access token");
    const workspaceId = required(input.workspaceId, "ServiceAccount workspace ID");
    const { name: namespace, external } = await this.resolveNamespace(namespaceId);
    const observed = await this.get("Namespace", namespace);
    if (observed === undefined || observed.status?.phase !== "Active") {
      throw new OwnershipFailure("The ServiceAccount Kubernetes namespace is unavailable.");
    }
    this.verifyNamespaceOwnership(observed, { namespaceId }, external);

    const name = `service-account-${sha256Hex(serviceAccountId, 32)}`;
    const ownership = { namespaceId, serviceAccountId };
    const existing = await this.getOwned("Secret", name, namespace, ownership);
    if (existing !== undefined) {
      throw new ConfigurationFailure("The ServiceAccount credential Secret already exists.");
    }

    const clients = await this.clients();
    await this.request(
      () =>
        clients.core.createNamespacedSecret({
          namespace,
          body: {
            ...this.manifest("v1", "Secret", name, ownership, namespace),
            type: "Opaque",
            stringData: {
              [SERVICE_ACCOUNT_TOKEN_KEY]: accessToken,
              [SERVICE_ACCOUNT_WORKSPACE_KEY]: workspaceId,
            },
          },
        }),
      { mutating: true },
    );
    return { name, key: SERVICE_ACCOUNT_TOKEN_KEY };
  }

  async deleteServiceAccountCredential(input: {
    readonly namespaceId: string;
    readonly serviceAccountId: string;
    readonly secretRef: { readonly name: string; readonly key: string };
  }): Promise<void> {
    const namespaceId = required(input.namespaceId, "ServiceAccount Namespace ID");
    const serviceAccountId = required(input.serviceAccountId, "ServiceAccount ID");
    const name = `service-account-${sha256Hex(serviceAccountId, 32)}`;
    if (input.secretRef.name !== name || input.secretRef.key !== SERVICE_ACCOUNT_TOKEN_KEY) {
      throw new OwnershipFailure("Refusing another ServiceAccount's credential Secret.");
    }

    const { name: namespace, external } = await this.resolveNamespace(namespaceId);
    const tenant = await this.get("Namespace", namespace);
    if (tenant === undefined) return;
    this.verifyNamespaceOwnership(tenant, { namespaceId }, external);
    const existing = await this.getOwned("Secret", name, namespace, {
      namespaceId,
      serviceAccountId,
    });
    if (existing === undefined) return;
    const clients = await this.clients();
    await this.request(
      () =>
        clients.core.deleteNamespacedSecret({
          name,
          namespace,
          ...(existing.metadata.uid === undefined
            ? {}
            : { body: { preconditions: { uid: existing.metadata.uid } } }),
        }),
      { mutating: true },
    );
  }

  async ensureNamespace(namespace: Namespace): Promise<NamespaceEnsureResult> {
    this.lifecycleStarted = true;
    const result = { namespaceId: namespace.id, namespaceReady: false };
    let tenantAccessRequired = false;
    try {
      const ownership = { namespaceId: namespace.id };
      const selection = namespace.existingNamespace;
      const placement =
        selection === undefined
          ? await this.resolveNamespace(namespace.id)
          : { name: selection, external: true };
      const { name, external: externallyManaged } = placement;
      if (externallyManaged && selection === undefined) {
        throw new OwnershipFailure(
          `Existing Kubernetes namespace ${name} was not explicitly selected.`,
        );
      }
      if (!externallyManaged) {
        const desired = this.manifest("v1", "Namespace", name, ownership);
        desired.metadata.labels = {
          ...desired.metadata.labels,
          ...this.gatewayMembershipLabels(),
          "pod-security.kubernetes.io/enforce": "restricted",
          "pod-security.kubernetes.io/audit": "restricted",
          "pod-security.kubernetes.io/warn": "restricted",
        };
        await this.reconcile(desired, ownership);
      }
      const observed = await this.get("Namespace", name);
      if (observed === undefined) {
        if (externallyManaged) {
          throw new OwnershipFailure(`Existing Kubernetes namespace ${name} does not exist.`);
        }
        return result;
      }
      if (externallyManaged) {
        this.verifyAdoptableNamespace(observed, ownership);
        await this.verifyUniqueExistingNamespace(name, ownership);
      } else {
        this.verifyNamespaceOwnership(observed, ownership, false);
      }
      if (
        observed.status?.phase !== "Active" ||
        (externallyManaged && observed.metadata.deletionTimestamp !== undefined)
      ) {
        if (externallyManaged) {
          throw new OwnershipFailure(`Existing Kubernetes namespace ${name} must be active.`);
        }
        return result;
      }
      tenantAccessRequired = true;
      if (externallyManaged) {
        await this.verifyExistingNetworkPolicies(name, ownership);
        await this.claimExistingNamespace(observed, ownership);
      }
      await this.reconcile(
        {
          ...this.manifest("v1", "ResourceQuota", "openclaw-quota", ownership, name),
          spec: { hard: { ...this.options.resources.namespace.quota } },
        },
        ownership,
        name,
      );
      await this.reconcile(
        {
          ...this.manifest("v1", "LimitRange", "openclaw-limits", ownership, name),
          spec: {
            limits: [
              {
                type: "Container",
                default: { ...this.options.resources.namespace.containerDefaults.limits },
                defaultRequest: { ...this.options.resources.namespace.containerDefaults.requests },
              },
            ],
          },
        },
        ownership,
        name,
      );
      for (const policy of this.networkPolicies(ownership, name)) {
        await this.reconcile(policy, ownership, name);
      }
      await this.lifecycle.afterNamespacePrepared(namespace);
      await this.sandboxDriver?.ensureNamespace?.(
        await this.sandboxNamespaceContext(namespace, name),
      );
      return { ...result, namespaceReady: true };
    } catch (error) {
      if (tenantAccessRequired && numericErrorStatus(error) === 403) return result;
      return { ...result, failure: failure(error) };
    }
  }

  async deleteNamespace(namespace: Namespace): Promise<NamespaceDeleteResult> {
    this.lifecycleStarted = true;
    const result = { namespaceId: namespace.id, namespaceDeleted: false };
    try {
      const clients = await this.clients();
      const { name, external } =
        namespace.existingNamespace === undefined
          ? await this.resolveNamespace(namespace.id)
          : { name: namespace.existingNamespace, external: true };
      const ownership = { namespaceId: namespace.id };
      const existing = await this.get("Namespace", name);
      if (existing === undefined) return { ...result, namespaceDeleted: true };
      if (
        external &&
        existing.metadata.labels?.["openclaw.dev/namespace"] === undefined &&
        existing.metadata.annotations?.["openclaw.dev/namespace-id"] === undefined
      ) {
        return { ...result, namespaceDeleted: true };
      }
      this.verifyNamespaceOwnership(existing, ownership, external);
      if (
        existing.metadata.deletionTimestamp !== undefined ||
        existing.status?.phase === "Terminating"
      ) {
        return result;
      }
      await this.lifecycle.beforeNamespaceDelete(namespace);
      if (this.sandboxDriver !== undefined) {
        await this.sandboxDriver.cleanup(await this.sandboxNamespaceContext(namespace, name));
      }
      if (external) {
        const deleted = await this.deleteOwnedNamespaceResources(name, ownership);
        if (!deleted) return result;
        const remaining = await this.get("Namespace", name);
        if (remaining !== undefined) this.verifyNamespaceOwnership(remaining, ownership, true);
        return { ...result, namespaceDeleted: true };
      }
      await this.request(
        () =>
          clients.core.deleteNamespace({
            name,
            ...(existing.metadata.uid === undefined
              ? {}
              : { body: { preconditions: { uid: existing.metadata.uid } } }),
          }),
        { mutating: true },
      );
      const remaining = await this.get("Namespace", name);
      if (remaining === undefined) return { ...result, namespaceDeleted: true };
      this.verifyNamespaceOwnership(remaining, ownership, false);
      return result;
    } catch (error) {
      return { ...result, failure: failure(error) };
    }
  }

  async prepareRevision(
    revision: AgentRevision,
    context?: ComputeRevisionContext,
  ): Promise<ComputeReadiness> {
    return this.withIsolationContainment(revision, () =>
      this.prepareIsolatedRevision(revision, context),
    );
  }

  private async prepareIsolatedRevision(
    revision: AgentRevision,
    context?: ComputeRevisionContext,
  ): Promise<ComputeReadiness> {
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
      typeof revision.servicePrincipalId !== "string" ||
      revision.servicePrincipalId.trim().length === 0
    )
      return result;
    required(revision.agentId, "Agent ID");
    required(revision.id, "AgentRevision ID");
    required(revision.configurationId, "Agent Configuration ID");
    if (
      revision.configurationKind !== "agent" ||
      !Number.isSafeInteger(revision.revision) ||
      revision.revision < 1 ||
      !Number.isSafeInteger(revision.configurationGeneration) ||
      revision.configurationGeneration < 1
    ) {
      throw new ConfigurationFailure("AgentRevision Configuration ownership is invalid.");
    }
    this.verifyGatewayRoutingConfiguration(revision);
    const embedded = revision.harness.mode === "embedded";
    if (
      (embedded && revision.harness.id !== "openclaw") ||
      (!embedded && (revision.harness.mode !== "dedicated" || revision.harness.id !== "codex"))
    ) {
      throw new ConfigurationFailure("AgentRevision Harness execution topology is unsupported.");
    }
    if (
      this.options.isolationProfile !== undefined &&
      (embedded || revision.sandboxDriverId !== undefined)
    ) {
      throw new ConfigurationFailure(
        "gVisor Alpha requires a dedicated Harness without a SandboxDriver.",
      );
    }
    await this.verifyIsolationProfile();
    const sandboxDriver = this.sandboxDriverForRevision(revision);
    if (sandboxDriver !== undefined && embedded) {
      throw new ConfigurationFailure("SandboxDriver support is limited to dedicated Harnesses.");
    }
    if (revision.serviceAccount?.credential.kind === "access_token") {
      if (embedded || this.options.runtime === undefined) {
        throw new ConfigurationFailure(
          "ServiceAccount access tokens require a dedicated Codex runtime.",
        );
      }
      const { id, credential } = revision.serviceAccount;
      const expectedName = `service-account-${sha256Hex(required(id, "ServiceAccount ID"), 32)}`;
      if (
        credential.secretRef.name !== expectedName ||
        credential.secretRef.key !== SERVICE_ACCOUNT_TOKEN_KEY
      ) {
        throw new OwnershipFailure("Refusing another ServiceAccount's credential Secret.");
      }
    }
    const channels = this.enabledChannels(revision);
    const { name: namespace, external } = await this.resolveNamespace(revision.namespaceId);
    const secretEnvironment = this.secretEnvironmentForRevision(revision, context, namespace);
    const tenantOwnership = { namespaceId: revision.namespaceId };
    const observed = await this.get("Namespace", namespace);
    if (observed === undefined) return result;
    this.verifyNamespaceOwnership(observed, tenantOwnership, external);
    if (observed.status?.phase !== "Active") return result;
    for (const policy of this.networkPolicies(tenantOwnership, namespace)) {
      const existing = await this.getOwned(
        "NetworkPolicy",
        policy.metadata.name,
        namespace,
        tenantOwnership,
      );
      if (existing === undefined) return result;
    }
    const agentName = `agent-${sha256Hex(revision.agentId, 12)}`;
    const gatewayName = `gateway-${sha256Hex(revision.agentId, 12)}`;
    const gatewayOwnership = { ...tenantOwnership, agentId: revision.agentId };
    const agentOwnership = {
      ...tenantOwnership,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
    };
    const document = JSON.stringify(revision.configuration);
    const configuration = this.gatewayConfiguration(revision);
    const existingGateway = await this.getOwned(
      "Deployment",
      gatewayName,
      namespace,
      gatewayOwnership,
    );
    let existingGatewayRevision: number | undefined;
    if (existingGateway !== undefined) {
      if (existingGateway.spec?.replicas !== 1) return result;
      const annotations = existingGateway.metadata.annotations ?? {};
      const currentRevision = Number(annotations[AGENT_REVISION_ANNOTATION]);
      const currentRevisionId = annotations[AGENT_REVISION_ID_ANNOTATION];
      if (
        !Number.isSafeInteger(currentRevision) ||
        currentRevision < 1 ||
        typeof currentRevisionId !== "string" ||
        currentRevisionId.trim().length === 0
      ) {
        throw new OwnershipFailure(`Refusing invalid Agent gateway revision ${gatewayName}.`);
      }
      const template = asRecord(existingGateway.spec?.template);
      const pod = asRecord(template?.spec);
      const volumes = Array.isArray(pod?.volumes) ? pod.volumes : [];
      const volume = volumes.find(
        (candidate) => asRecord(candidate)?.name === CONFIGURATION_VOLUME,
      );
      const currentConfiguration = asRecord(asRecord(volume)?.configMap)?.name;
      if (typeof currentConfiguration !== "string") {
        throw new OwnershipFailure(`Refusing unconfigured Agent gateway ${gatewayName}.`);
      }
      if (revision.revision < currentRevision) return result;
      if (revision.revision === currentRevision) {
        if (revision.id !== currentRevisionId || currentConfiguration !== configuration.name) {
          throw new ConfigurationFailure(
            "Immutable AgentRevision gateway configuration cannot change.",
          );
        }
      }
      existingGatewayRevision = currentRevision;
    }
    await this.reconcile(
      KubernetesGateway.gatewayConfigurationMap(
        configuration,
        document,
        gatewayOwnership,
        namespace,
      ),
      gatewayOwnership,
      namespace,
    );
    const gatewayAccountName = embedded ? agentName : gatewayName;
    const gatewayAccountOwnership = embedded ? agentOwnership : gatewayOwnership;
    await this.reconcile(
      {
        ...this.manifest(
          "v1",
          "ServiceAccount",
          gatewayAccountName,
          gatewayAccountOwnership,
          namespace,
        ),
        automountServiceAccountToken: false,
      },
      gatewayAccountOwnership,
      namespace,
    );
    if (!embedded) {
      await this.reconcile(
        this.sharedWorkspaceClaim(revision.agentId, gatewayOwnership, namespace),
        gatewayOwnership,
        namespace,
      );
    }
    if (this.options.runtime !== undefined) {
      await this.reconcile(
        this.gatewayPrivateStateClaim(revision.agentId, gatewayOwnership, namespace),
        gatewayOwnership,
        namespace,
      );
    }
    let launchPrepared = false;
    try {
      const prepareEmbeddedGateway =
        embedded &&
        (existingGateway === undefined ||
          this.options.runtime === undefined ||
          existingGateway.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION] === revision.id);
      const embeddedEnvironment = prepareEmbeddedGateway
        ? (await this.lifecycle.beforeWorkloadStart(revision)).environment
        : {};
      if (prepareEmbeddedGateway) launchPrepared = true;
      if (
        existingGateway === undefined ||
        this.options.runtime === undefined ||
        existingGateway.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION] === revision.id
      ) {
        await this.reconcileChannelNetworkPolicy(revision, channels, namespace);
        await this.reconcile(
          this.deployment(
            gatewayName,
            gatewayOwnership,
            namespace,
            this.options.images.gateway,
            gatewayAccountName,
            "gateway",
            embeddedEnvironment,
            configuration.loggingLevel,
            configuration,
            embedded,
            embedded ? revision.servicePrincipalId : undefined,
            undefined,
            channels,
            secretEnvironment,
          ),
          gatewayOwnership,
          namespace,
        );
      }
      const existingGatewayService = await this.getOwned(
        "Service",
        gatewayName,
        namespace,
        gatewayOwnership,
      );
      const inactiveEmbeddedGateway =
        embedded &&
        this.options.runtime !== undefined &&
        (existingGatewayService === undefined ||
          asRecord(existingGatewayService.spec?.selector)?.["app.kubernetes.io/name"] ===
            `${gatewayName}-inactive`);
      await this.reconcile(
        this.service(gatewayName, gatewayOwnership, namespace, {
          "app.kubernetes.io/name": inactiveEmbeddedGateway
            ? `${gatewayName}-inactive`
            : gatewayName,
        }),
        gatewayOwnership,
        namespace,
      );
      await this.reconcileGatewayRoute(revision, gatewayOwnership, namespace);
      if (
        embedded &&
        this.options.runtime !== undefined &&
        existingGatewayRevision !== undefined &&
        existingGatewayRevision < revision.revision
      ) {
        // A broken old gateway must not block recovery. This only stages the replacement;
        // post-commit activation replaces the Deployment and verifies its readiness.
        return { ...result, ready: true };
      }
      if (inactiveEmbeddedGateway) {
        const gateway = await this.getOwned("Deployment", gatewayName, namespace, gatewayOwnership);
        if (gateway === undefined || !this.deploymentReady(gateway)) return result;
      } else if (!(await this.gatewayReady(gatewayOwnership, gatewayName, namespace))) {
        return result;
      }
      if (embedded) return { ...result, ready: true };
      await this.reconcile(
        {
          ...this.manifest("v1", "ServiceAccount", agentName, agentOwnership, namespace),
          automountServiceAccountToken: false,
        },
        agentOwnership,
        namespace,
      );
      const existingService = await this.getOwned("Service", agentName, namespace, agentOwnership);
      if (existingService === undefined) {
        await this.reconcile(
          this.service(agentName, agentOwnership, namespace, {
            "app.kubernetes.io/name": `${agentName}-inactive`,
          }),
          agentOwnership,
          namespace,
        );
      }
      const revisionName = `${agentName}-rev-${sha256Hex(revision.id, 12)}`;
      const revisionOwnership = { ...agentOwnership, revisionId: revision.id };
      if (revision.serviceAccount?.credential.kind === "access_token") {
        await this.reconcile(
          this.agentAuthenticationNetworkPolicy(revision, namespace),
          agentOwnership,
          namespace,
        );
      }
      const launch = await this.lifecycle.beforeWorkloadStart(revision);
      launchPrepared = true;
      const agentDeployment = this.deployment(
        revisionName,
        revisionOwnership,
        namespace,
        this.options.images.agent,
        agentName,
        "agent",
        launch.environment,
        configuration.loggingLevel,
        undefined,
        false,
        undefined,
        revision.serviceAccount,
      );
      if (sandboxDriver?.provisionHarness !== undefined) {
        const requirements = this.harnessRequirementsFromDeployment(agentDeployment);
        const sandbox = await sandboxDriver.provisionHarness({
          ...(await this.sandboxNamespaceContext(
            this.sandboxNamespaceForRevision(revision, namespace),
            namespace,
          )),
          revision,
          requirements,
        });
        this.verifySandboxResourceRef(sandbox, revision, namespace);
        return {
          ...result,
          ready: await this.providerHarnessReady(revision, namespace, requirements.labels),
        };
      }
      await this.reconcile(agentDeployment, revisionOwnership, namespace);
      const deployment = await this.getOwned(
        "Deployment",
        revisionName,
        namespace,
        revisionOwnership,
      );
      if (deployment === undefined) {
        await this.lifecycle.beforeWorkloadStop(revision, { cleanup: true });
        return result;
      }
      return { ...result, ready: await this.dedicatedDeploymentReady(deployment, namespace) };
    } catch (error) {
      const failures = [error];
      if (launchPrepared && !(error instanceof IsolationFailure)) {
        try {
          await this.lifecycle.beforeWorkloadStop(revision, { cleanup: true });
        } catch (cleanupError) {
          failures.push(cleanupError);
        }
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Agent workload preparation and cleanup failed.");
      }
      throw error;
    }
  }

  async activateRevision(revision: AgentRevision, context?: ComputeRevisionContext): Promise<void> {
    return this.withIsolationContainment(revision, () =>
      this.activateIsolatedRevision(revision, context),
    );
  }

  private async activateIsolatedRevision(
    revision: AgentRevision,
    context?: ComputeRevisionContext,
  ): Promise<void> {
    if (
      revision.compute.id !== this.id ||
      revision.compute.implementation !== this.implementation
    ) {
      throw new ConfigurationFailure("AgentRevision is pinned to another Compute implementation.");
    }
    if (
      this.options.isolationProfile !== undefined &&
      (revision.harness.mode !== "dedicated" || revision.sandboxDriverId !== undefined)
    ) {
      throw new ConfigurationFailure(
        "gVisor Alpha requires a dedicated Harness without a SandboxDriver.",
      );
    }
    if (this.options.runtime === undefined) return;
    this.verifyGatewayRoutingConfiguration(revision);
    const channels = this.enabledChannels(revision);
    const { name: namespace } = await this.resolveNamespace(revision.namespaceId);
    const secretEnvironment = this.secretEnvironmentForRevision(revision, context, namespace);
    const agentName = `agent-${sha256Hex(revision.agentId, 12)}`;
    const gatewayName = `gateway-${sha256Hex(revision.agentId, 12)}`;
    const gatewayOwnership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    const ownership = {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
    };
    if (revision.harness.mode === "embedded") {
      if (this.sandboxDriverForRevision(revision) !== undefined) {
        throw new ConfigurationFailure("SandboxDriver support is limited to dedicated Harnesses.");
      }
      const gateway = await this.getOwned("Deployment", gatewayName, namespace, gatewayOwnership);
      if (gateway === undefined) throw new Error("The Agent gateway workload is unavailable.");
      const annotations = gateway.metadata.annotations ?? {};
      const currentRevision = Number(annotations[AGENT_REVISION_ANNOTATION]);
      const currentRevisionId = annotations[AGENT_REVISION_ID_ANNOTATION];
      if (
        !Number.isSafeInteger(currentRevision) ||
        currentRevision < 1 ||
        typeof currentRevisionId !== "string" ||
        currentRevisionId.trim().length === 0
      ) {
        throw new OwnershipFailure(`Refusing invalid Agent gateway revision ${gatewayName}.`);
      }
      if (
        currentRevision > revision.revision ||
        (currentRevision === revision.revision && currentRevisionId !== revision.id)
      ) {
        throw new ConfigurationFailure("Refusing stale AgentRevision gateway activation.");
      }
      if (currentRevisionId !== revision.id) {
        const launch = await this.lifecycle.beforeWorkloadStart(revision);
        try {
          await this.reconcile(
            this.gatewayPrivateStateClaim(revision.agentId, gatewayOwnership, namespace),
            gatewayOwnership,
            namespace,
          );
          await this.reconcileChannelNetworkPolicy(revision, channels, namespace);
          await this.reconcile(
            this.deployment(
              gatewayName,
              gatewayOwnership,
              namespace,
              this.options.images.gateway,
              agentName,
              "gateway",
              launch.environment,
              this.gatewayConfiguration(revision).loggingLevel,
              this.gatewayConfiguration(revision),
              true,
              revision.servicePrincipalId,
              undefined,
              channels,
              secretEnvironment,
            ),
            gatewayOwnership,
            namespace,
          );
        } catch (error) {
          await this.lifecycle.beforeWorkloadStop(revision, { cleanup: true });
          throw error;
        }
      }
      for (const policy of this.agentNetworkPolicies(revision, namespace)) {
        await this.reconcile(policy, gatewayOwnership, namespace);
      }
      await this.reconcile(
        this.service(gatewayName, gatewayOwnership, namespace, {
          "app.kubernetes.io/name": gatewayName,
        }),
        gatewayOwnership,
        namespace,
      );
      await this.reconcileGatewayRoute(revision, gatewayOwnership, namespace);
      if (!(await this.gatewayReady(gatewayOwnership, gatewayName, namespace))) {
        throw new Error("The exact AgentRevision gateway is not ready.");
      }
      return;
    }
    const revisionName = `${agentName}-rev-${sha256Hex(revision.id, 12)}`;
    const sandboxDriver = this.sandboxDriverForRevision(revision);
    const configuration = this.gatewayConfiguration(revision);
    const agentDeployment = this.deployment(
      revisionName,
      { ...ownership, revisionId: revision.id },
      namespace,
      this.options.images.agent,
      agentName,
      "agent",
      {},
      configuration.loggingLevel,
      undefined,
      false,
      undefined,
      revision.serviceAccount,
    );
    if (sandboxDriver?.provisionHarness === undefined) {
      const deployment = await this.getOwned("Deployment", revisionName, namespace, {
        ...ownership,
        revisionId: revision.id,
      });
      if (
        deployment === undefined ||
        !(await this.dedicatedDeploymentReady(deployment, namespace))
      ) {
        throw new Error("The exact AgentRevision workload is not ready.");
      }
    } else {
      const requirements = this.harnessRequirementsFromDeployment(agentDeployment);
      if (!(await this.providerHarnessReady(revision, namespace, requirements.labels))) {
        throw new Error("The exact AgentRevision workload is not ready.");
      }
    }
    await this.reconcileChannelNetworkPolicy(revision, channels, namespace);
    await this.reconcile(
      this.sharedWorkspaceClaim(revision.agentId, gatewayOwnership, namespace),
      gatewayOwnership,
      namespace,
    );
    await this.reconcile(
      this.gatewayPrivateStateClaim(revision.agentId, gatewayOwnership, namespace),
      gatewayOwnership,
      namespace,
    );
    await this.reconcile(
      this.deployment(
        gatewayName,
        gatewayOwnership,
        namespace,
        this.options.images.gateway,
        gatewayName,
        "gateway",
        {},
        configuration.loggingLevel,
        configuration,
        false,
        undefined,
        undefined,
        channels,
      ),
      gatewayOwnership,
      namespace,
    );
    await this.reconcile(
      this.service(gatewayName, gatewayOwnership, namespace, {
        "app.kubernetes.io/name": gatewayName,
      }),
      gatewayOwnership,
      namespace,
    );
    await this.reconcileGatewayRoute(revision, gatewayOwnership, namespace);
    if (!(await this.gatewayReady(gatewayOwnership, gatewayName, namespace))) {
      throw new Error("The exact AgentRevision gateway is not ready.");
    }
    for (const policy of this.agentNetworkPolicies(revision, namespace)) {
      await this.reconcile(policy, gatewayOwnership, namespace);
    }
    await this.reconcile(
      this.service(agentName, ownership, namespace, {
        "openclaw.dev/agent": revision.agentId,
        "openclaw.dev/revision": revision.id,
        "openclaw.dev/workload-role": "agent",
        ...(sandboxDriver?.provisionHarness === undefined
          ? { "app.kubernetes.io/name": revisionName }
          : {}),
      }),
      ownership,
      namespace,
    );
  }

  async deactivateRevision(revision: AgentRevision): Promise<void> {
    if (this.options.runtime === undefined) return;
    const { name: namespace } = await this.resolveNamespace(revision.namespaceId);
    if (revision.harness.mode === "embedded") {
      if (this.sandboxDriverForRevision(revision) !== undefined) {
        throw new ConfigurationFailure("SandboxDriver support is limited to dedicated Harnesses.");
      }
      const gatewayName = `gateway-${sha256Hex(revision.agentId, 12)}`;
      const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
      const service = await this.getOwned("Service", gatewayName, namespace, ownership);
      if (service === undefined) return;
      const gateway = await this.getOwned("Deployment", gatewayName, namespace, ownership);
      if (gateway === undefined) return;
      if (gateway.metadata.annotations?.[AGENT_REVISION_ID_ANNOTATION] !== revision.id) return;
      if (asRecord(service.spec?.selector)?.["app.kubernetes.io/name"] !== gatewayName) return;
      await this.reconcile(
        this.service(gatewayName, ownership, namespace, {
          "app.kubernetes.io/name": `${gatewayName}-inactive`,
        }),
        ownership,
        namespace,
      );
      return;
    }
    const agentName = `agent-${sha256Hex(revision.agentId, 12)}`;
    const ownership = {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
    };
    await this.reconcileServiceForSelector(
      this.service(agentName, ownership, namespace, {
        "app.kubernetes.io/name": `${agentName}-inactive`,
      }),
      ownership,
      namespace,
      { "openclaw.dev/revision": revision.id },
    );
  }

  async retireRevision(revision: AgentRevision): Promise<void> {
    this.lifecycleStarted = true;
    if (
      revision.compute.id !== this.id ||
      revision.compute.implementation !== this.implementation
    ) {
      throw new Error("Refusing to retire an AgentRevision pinned to another Compute Driver.");
    }
    required(revision.agentId, "Agent ID");
    required(revision.id, "AgentRevision ID");
    required(revision.servicePrincipalId, "Agent ServicePrincipal ID");
    const clients = await this.clients();
    const { name: namespace, external } = await this.resolveNamespace(revision.namespaceId);
    const existingNamespace = await this.get("Namespace", namespace);
    if (existingNamespace === undefined) {
      await this.lifecycle.beforeWorkloadStop(revision);
      return;
    }
    this.verifyNamespaceOwnership(
      existingNamespace,
      { namespaceId: revision.namespaceId },
      external,
    );
    if (revision.harness.mode === "embedded") {
      if (this.sandboxDriverForRevision(revision) !== undefined) {
        throw new ConfigurationFailure("SandboxDriver support is limited to dedicated Harnesses.");
      }
      await this.lifecycle.beforeWorkloadStop(revision);
      await this.removeRetiredGateway(revision, namespace);
      return;
    }
    const sandboxDriver = this.sandboxDriverForRevision(revision);
    if (sandboxDriver?.provisionHarness !== undefined) {
      await this.lifecycle.beforeWorkloadStop(revision);
      await sandboxDriver.cleanup({
        ...(await this.sandboxNamespaceContext(
          this.sandboxNamespaceForRevision(revision, namespace),
          namespace,
        )),
        revision,
      });
      await this.removeRetiredGateway(revision, namespace);
      return;
    }
    const name = `agent-${sha256Hex(revision.agentId, 12)}-rev-${sha256Hex(revision.id, 12)}`;
    const deployment = await this.getOwned("Deployment", name, namespace, {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
      revisionId: revision.id,
    });
    if (deployment === undefined) {
      await this.lifecycle.beforeWorkloadStop(revision);
      await this.removeRetiredGateway(revision, namespace);
      return;
    }
    await this.lifecycle.beforeWorkloadStop(revision);
    await this.request(
      () =>
        clients.apps.deleteNamespacedDeployment({
          name,
          namespace,
          ...(deployment.metadata.uid === undefined
            ? {}
            : { body: { preconditions: { uid: deployment.metadata.uid } } }),
        }),
      { mutating: true },
    );
    await this.removeRetiredGateway(revision, namespace);
  }

  private async removeRetiredGateway(revision: AgentRevision, namespace: string): Promise<void> {
    return this.cleanup.removeRetiredGateway(revision, namespace);
  }

  private async deleteGateway(
    name: string,
    ownership: Ownership,
    namespace: string,
  ): Promise<void> {
    return this.cleanup.deleteGateway(name, ownership, namespace);
  }

  private async resolveNamespace(
    namespaceId: string,
  ): Promise<{ readonly name: string; readonly external: boolean }> {
    return this.ownership.resolveNamespace(namespaceId);
  }

  private verifyAdoptableNamespace(
    namespace: ManagedKubernetesObject<"Namespace">,
    ownership: Ownership,
  ): boolean {
    return this.ownership.verifyAdoptableNamespace(namespace, ownership);
  }

  private async verifyUniqueExistingNamespace(name: string, ownership: Ownership): Promise<void> {
    return this.ownership.verifyUniqueExistingNamespace(name, ownership);
  }

  private async claimExistingNamespace(
    namespace: ManagedKubernetesObject<"Namespace">,
    ownership: Ownership,
  ): Promise<void> {
    return this.ownership.claimExistingNamespace(namespace, ownership);
  }

  private async verifyExistingNetworkPolicies(
    namespace: string,
    ownership: Ownership,
  ): Promise<void> {
    return this.ownership.verifyExistingNetworkPolicies(namespace, ownership);
  }

  private async deleteOwnedNamespaceResources(
    namespace: string,
    ownership: Ownership,
  ): Promise<boolean> {
    return this.cleanup.deleteOwnedNamespaceResources(namespace, ownership);
  }

  private async clients(): Promise<KubernetesApiClients> {
    if (this.apiClients === undefined) this.apiClients = this.createClients();
    return this.apiClients;
  }

  private async createClients(): Promise<KubernetesApiClients> {
    const { sdk, clientConfiguration } = await createKubernetesClientConfiguration(
      this.options.authentication,
      (message) => new ConfigurationFailure(message),
    );
    this.patchOptions = sdk.setHeaderOptions("Content-Type", APPLY_CONTENT_TYPE);
    return {
      core: new sdk.CoreV1Api(clientConfiguration),
      apps: new sdk.AppsV1Api(clientConfiguration),
      discovery: new sdk.DiscoveryV1Api(clientConfiguration),
      networking: new sdk.NetworkingV1Api(clientConfiguration),
      objects: new sdk.KubernetesObjectApi(clientConfiguration),
    };
  }

  private async request<T>(
    operation: () => Promise<T>,
    options: { readonly mutating?: boolean } = {},
  ): Promise<T> {
    const ownerSignal = currentComputeAbortSignal();
    for (let attempt = 1; ; attempt += 1) {
      ownerSignal?.throwIfAborted();
      const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const signal =
        ownerSignal === undefined ? deadline : AbortSignal.any([ownerSignal, deadline]);
      try {
        return await withComputeAbortSignal(signal, operation);
      } catch (error) {
        if (ownerSignal?.aborted) throw ownerSignal.reason;
        if (deadline.aborted) throw new Error("Kubernetes API request timed out.");
        const status = numericErrorStatus(error);
        const retryable =
          status === 429 ||
          (status !== undefined && status >= 500) ||
          (status === undefined &&
            !(error instanceof ConfigurationFailure) &&
            !(error instanceof OwnershipFailure));
        if (!retryable || options.mutating === true || attempt >= 3) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, attempt * 25));
      }
    }
  }

  private operationSignal(): AbortSignal {
    return currentComputeAbortSignal() ?? new AbortController().signal;
  }

  private sandboxNamespaceContext(
    namespace: Readonly<Namespace>,
    namespaceName: string,
  ): Promise<SandboxNamespaceContext> {
    return this.clients().then(({ objects: kubernetes }) => ({
      namespace: { ...namespace, name: namespaceName },
      kubernetes,
      signal: this.operationSignal(),
    }));
  }

  private sandboxNamespaceForRevision(revision: AgentRevision, namespaceName: string): Namespace {
    return {
      id: revision.namespaceId,
      name: namespaceName,
      status: "ready",
      createdAt: revision.createdAt,
    };
  }

  private sandboxDriverForRevision(revision: AgentRevision): SandboxDriver | undefined {
    if (revision.sandboxDriverId === undefined) return undefined;
    const driver = this.sandboxDriver;
    if (driver === undefined) {
      throw new ConfigurationFailure("AgentRevision requires an unavailable SandboxDriver.");
    }
    if (revision.sandboxDriverId !== driver.id) {
      throw new ConfigurationFailure("AgentRevision is pinned to another SandboxDriver.");
    }
    return driver;
  }

  private verifySandboxResourceRef(
    sandbox: SandboxResourceRef,
    revision: AgentRevision,
    namespace: string,
  ): void {
    if (
      sandbox.namespaceName !== namespace ||
      sandbox.agentId !== revision.agentId ||
      sandbox.revisionId !== revision.id ||
      typeof sandbox.resourceName !== "string" ||
      sandbox.resourceName.trim().length === 0
    ) {
      throw new OwnershipFailure("SandboxDriver returned an ambiguous Sandbox identity.");
    }
  }

  private async providerHarnessReady(
    revision: Pick<AgentRevision, "agentId" | "id">,
    namespace: string,
    labels: Readonly<Record<string, string>>,
    requiredRuntimeClass?: string,
  ): Promise<boolean> {
    return this.readiness.providerHarnessReady(revision, namespace, labels, requiredRuntimeClass);
  }

  private harnessRequirementsFromDeployment(
    deployment: ManagedKubernetesObject,
  ): HarnessWorkloadRequirements {
    const template = asRecord(deployment.spec?.template);
    const metadata = asRecord(template?.metadata);
    const labels = asRecord(metadata?.labels);
    const spec = asRecord(template?.spec);
    const serviceAccountName = required(spec?.serviceAccountName, "Harness ServiceAccount");
    const containers = Array.isArray(spec?.containers) ? spec.containers : [];
    if (containers.length !== 1) {
      throw new ConfigurationFailure("Dedicated Harness requires one workload container.");
    }
    const container = asRecord(containers[0]);
    const image = required(container?.image, "Harness image");
    const command = [
      ...(Array.isArray(container?.command) ? container.command : []),
      ...(Array.isArray(container?.args) ? container.args : []),
    ];
    if (command.some((entry) => typeof entry !== "string") || command.length === 0) {
      throw new ConfigurationFailure("Dedicated Harness command must be explicit.");
    }
    const environment = this.sandboxEnvironmentVariables(container?.env);
    const workspaceMounts = this.sandboxWorkspaceMounts(spec?.volumes, container?.volumeMounts);
    const serviceAccountToken = this.sandboxServiceAccountToken(
      spec?.volumes,
      container?.volumeMounts,
    );
    const harnessLabels = Object.fromEntries(
      Object.entries(labels ?? {}).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
      ),
    );
    if (
      harnessLabels["openclaw.dev/workload-role"] !== "agent" ||
      typeof harnessLabels["openclaw.dev/agent"] !== "string" ||
      typeof harnessLabels["openclaw.dev/revision"] !== "string"
    ) {
      throw new ConfigurationFailure("Dedicated Harness labels must include exact revision scope.");
    }
    return {
      image,
      command: command as readonly string[],
      serviceAccountName,
      serviceAccountToken,
      workspaceMounts,
      environment,
      labels: harnessLabels,
    };
  }

  private sandboxEnvironmentVariables(value: unknown): readonly SandboxEnvironmentVariable[] {
    const variables = Array.isArray(value) ? value : [];
    return variables.map((item) => {
      const variable = asRecord(item);
      const name = required(variable?.name, "Harness environment variable name");
      if (typeof variable?.value === "string") return { name, value: variable.value };
      const secretKeyRef = asRecord(asRecord(variable?.valueFrom)?.secretKeyRef);
      if (
        typeof secretKeyRef?.name === "string" &&
        secretKeyRef.name.trim().length > 0 &&
        typeof secretKeyRef.key === "string" &&
        secretKeyRef.key.trim().length > 0
      ) {
        return {
          name,
          valueFrom: { secretKeyRef: { name: secretKeyRef.name, key: secretKeyRef.key } },
        };
      }
      throw new ConfigurationFailure(
        `Harness environment variable ${name} must be a literal or SecretKeyRef.`,
      );
    });
  }

  private sandboxServiceAccountToken(
    volumes: unknown,
    volumeMounts: unknown,
  ): HarnessWorkloadRequirements["serviceAccountToken"] {
    const configured = this.options.servicePrincipalCredentials;
    if (configured.mode !== "projectedServiceAccountToken") {
      throw new ConfigurationFailure(
        "Provider-owned Harness requires a projected ServicePrincipal token.",
      );
    }
    const observedVolumes = Array.isArray(volumes) ? volumes : [];
    const tokenVolumes = observedVolumes.filter(
      (item) => asRecord(item)?.name === "openclaw-service-principal",
    );
    if (tokenVolumes.length !== 1) {
      throw new ConfigurationFailure(
        "Provider-owned Harness requires exactly one projected ServicePrincipal token volume.",
      );
    }
    const sources = asRecord(asRecord(tokenVolumes[0])?.projected)?.sources;
    if (!Array.isArray(sources) || sources.length !== 1) {
      throw new ConfigurationFailure(
        "Provider-owned Harness requires exactly one projected ServicePrincipal token source.",
      );
    }
    const token = asRecord(asRecord(sources[0])?.serviceAccountToken);
    const audience = required(token?.audience, "Harness ServicePrincipal token audience");
    const expirationSeconds = token?.expirationSeconds;
    const path = required(token?.path, "Harness ServicePrincipal token path");
    if (
      audience !== configured.audience ||
      expirationSeconds !== configured.expirationSeconds ||
      typeof expirationSeconds !== "number" ||
      !Number.isSafeInteger(expirationSeconds) ||
      expirationSeconds < 600 ||
      expirationSeconds > 86_400 ||
      path !== "token"
    ) {
      throw new ConfigurationFailure(
        "Provider-owned Harness must preserve the approved ServicePrincipal token projection.",
      );
    }
    const observedMounts = Array.isArray(volumeMounts) ? volumeMounts : [];
    const tokenMounts = observedMounts.filter(
      (item) => asRecord(item)?.name === "openclaw-service-principal",
    );
    const mount = tokenMounts.length === 1 ? asRecord(tokenMounts[0]) : undefined;
    if (mount?.mountPath !== TOKEN_PATH || mount.readOnly !== true) {
      throw new ConfigurationFailure(
        "Provider-owned Harness must mount its ServicePrincipal token read-only at the approved path.",
      );
    }
    return { audience, expirationSeconds, mountPath: mount.mountPath, path, readOnly: true };
  }

  private sandboxWorkspaceMounts(
    volumes: unknown,
    volumeMounts: unknown,
  ): readonly SandboxWorkspaceMount[] {
    const observedVolumes = Array.isArray(volumes) ? volumes : [];
    const workspaceVolume = observedVolumes.find(
      (item) => asRecord(item)?.name === SHARED_WORKSPACE_VOLUME,
    );
    const claimName = required(
      asRecord(asRecord(workspaceVolume)?.persistentVolumeClaim)?.claimName,
      "Harness shared workspace claim",
    );
    const observedMounts = Array.isArray(volumeMounts) ? volumeMounts : [];
    const workspaceMounts = observedMounts
      .filter((item) => asRecord(item)?.name === SHARED_WORKSPACE_VOLUME)
      .map((item) => {
        const mount = asRecord(item);
        return {
          claimName,
          subPath: required(mount?.subPath, "Harness workspace subPath"),
          mountPath: required(mount?.mountPath, "Harness workspace mount path"),
          readOnly: mount?.readOnly === true,
        };
      });
    const expected = this.sharedWorkspaceVolumeMounts("agent");
    if (workspaceMounts.length !== expected.length) {
      throw new ConfigurationFailure("Dedicated Harness must mount every approved workspace path.");
    }
    for (const mount of expected) {
      if (
        !workspaceMounts.some(
          (observed) =>
            observed.subPath === mount.subPath &&
            observed.mountPath === mount.mountPath &&
            observed.readOnly === (mount.readOnly === true),
        )
      ) {
        throw new ConfigurationFailure(
          "Dedicated Harness workspace mounts must match the approved shared PVC paths.",
        );
      }
    }
    return workspaceMounts;
  }

  private async gatewayReady(
    ownership: Ownership,
    gatewayName: string,
    namespace: string,
  ): Promise<boolean> {
    return this.readiness.gatewayReady(ownership, gatewayName, namespace);
  }

  private async withIsolationContainment<T>(
    revision: AgentRevision,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const isolationFailed =
        error instanceof IsolationFailure ||
        (error instanceof AggregateError &&
          error.errors.some((failure) => failure instanceof IsolationFailure));
      if (
        this.options.isolationProfile !== undefined &&
        isolationFailed &&
        revision.compute.id === this.id &&
        revision.compute.implementation === this.implementation &&
        revision.harness.mode === "dedicated" &&
        revision.sandboxDriverId === undefined
      ) {
        try {
          await this.containIsolationViolation(revision);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "gVisor isolation failed and containment could not be confirmed.",
          );
        }
      }
      throw error;
    }
  }

  private async containIsolationViolation(revision: AgentRevision): Promise<void> {
    const { name: namespace, external } = await this.resolveNamespace(revision.namespaceId);
    const observedNamespace = await this.get("Namespace", namespace);
    if (observedNamespace === undefined) return;
    this.verifyNamespaceOwnership(
      observedNamespace,
      { namespaceId: revision.namespaceId },
      external,
    );
    const clients = await this.clients();
    const agentName = `agent-${sha256Hex(revision.agentId, 12)}`;
    const ownership = {
      namespaceId: revision.namespaceId,
      agentId: revision.agentId,
      servicePrincipalId: revision.servicePrincipalId,
    };
    const failures: unknown[] = [];
    try {
      const service = await this.getOwned("Service", agentName, namespace, ownership);
      const selector = asRecord(service?.spec?.selector);
      if (
        service !== undefined &&
        selector?.["openclaw.dev/revision"] === revision.id &&
        selector["openclaw.dev/agent"] === revision.agentId
      ) {
        const uid = required(service.metadata.uid, "Isolation containment Service UID");
        const resourceVersion = required(
          service.metadata.resourceVersion,
          "Isolation containment Service resourceVersion",
        );
        const sdk = await import("@kubernetes/client-node");
        // Atomic tests prevent a stale observation from disabling a replacement revision's route.
        await this.request(
          () =>
            clients.core.patchNamespacedService(
              {
                name: agentName,
                namespace,
                body: [
                  { op: "test", path: "/metadata/uid", value: uid },
                  { op: "test", path: "/metadata/resourceVersion", value: resourceVersion },
                  { op: "test", path: "/spec/selector", value: selector },
                  {
                    op: "replace",
                    path: "/spec/selector",
                    value: { "app.kubernetes.io/name": `${agentName}-inactive` },
                  },
                ],
              },
              sdk.setHeaderOptions("Content-Type", "application/json-patch+json"),
            ),
          { mutating: true },
        );
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.lifecycle.beforeWorkloadStop(revision, { cleanup: true });
    } catch (error) {
      failures.push(error);
    }
    try {
      const name = `${agentName}-rev-${sha256Hex(revision.id, 12)}`;
      const deployment = await this.getOwned("Deployment", name, namespace, {
        ...ownership,
        revisionId: revision.id,
      });
      if (deployment !== undefined) {
        const uid = required(deployment.metadata.uid, "Isolation containment Deployment UID");
        // Request termination without deleting the shared workspace, gateway, or another revision.
        // Kubernetes deletion is asynchronous; retain the original failure instead of claiming a stopped workload.
        await this.request(
          () =>
            clients.apps.deleteNamespacedDeployment({
              name,
              namespace,
              body: { preconditions: { uid }, propagationPolicy: "Foreground" },
            }),
          { mutating: true },
        );
      }
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0)
      throw new AggregateError(failures, "gVisor isolation containment requests failed.");
  }

  private async verifyIsolationProfile(): Promise<void> {
    return this.readiness.verifyIsolationProfile();
  }

  private async dedicatedDeploymentReady(
    deployment: ManagedKubernetesObject,
    namespace: string,
  ): Promise<boolean> {
    return this.readiness.dedicatedDeploymentReady(deployment, namespace);
  }

  private deploymentReady(deployment: ManagedKubernetesObject): boolean {
    return this.readiness.deploymentReady(deployment);
  }

  private ownershipMetadata(ownership: Ownership): {
    labels: Record<string, string>;
    annotations: Record<string, string>;
  } {
    return KubernetesIdentity.ownershipMetadata(ownership);
  }

  private verifyNamespaceOwnership(
    namespace: ManagedKubernetesObject<"Namespace">,
    ownership: Ownership,
    external: boolean,
  ): void {
    return verifyNamespaceOwnership(namespace, ownership, external);
  }

  private manifest<Kind extends ReadableResourceKind>(
    apiVersion: string,
    kind: Kind,
    name: string,
    ownership: Ownership,
    namespace?: string,
  ): ManagedKubernetesObject<Kind> {
    return KubernetesIdentity.manifest(apiVersion, kind, name, ownership, namespace);
  }

  private peer(peer: KubernetesWorkloadPeer): V1NetworkPolicyPeer {
    return KubernetesNetwork.peer(peer);
  }

  private networkPolicies(ownership: Ownership, namespace: string): ManagedKubernetesObject[] {
    return KubernetesNetwork.networkPolicies(
      {
        network: this.options.network,
        ...(this.options.gatewayRouting === undefined
          ? {}
          : { gatewayRouting: this.options.gatewayRouting }),
      },
      ownership,
      namespace,
    );
  }

  private gatewayConfiguration(revision: AgentRevision): GatewayConfigurationSnapshot {
    return KubernetesGateway.gatewayConfiguration(revision);
  }

  private gatewayMembershipLabels(): Record<string, string> {
    return KubernetesGateway.gatewayMembershipLabels(this.options.gatewayRouting);
  }

  private gatewayRoutePath(revision: AgentRevision): string {
    return this.routing.gatewayRoutePath(revision);
  }

  private gatewayRoutingHostname(routing: KubernetesGatewayRoutingOptions): string {
    return this.routing.gatewayRoutingHostname(routing);
  }

  private verifyGatewayRoutingConfiguration(revision: AgentRevision): void {
    return this.routing.verifyGatewayRoutingConfiguration(revision);
  }

  private gatewayRoute(
    revision: AgentRevision,
    ownership: Ownership,
    namespace: string,
    service: ManagedKubernetesObject<"Service">,
  ): ManagedKubernetesObject<"HTTPRoute"> | undefined {
    return this.routing.gatewayRoute(revision, ownership, namespace, service);
  }

  private async reconcileGatewayRoute(
    revision: AgentRevision,
    ownership: Ownership,
    namespace: string,
  ): Promise<void> {
    return this.routing.reconcileGatewayRoute(revision, ownership, namespace);
  }

  private sharedWorkspaceClaimName(agentId: string): string {
    return KubernetesStorage.sharedWorkspaceClaimName(agentId);
  }

  private gatewayPrivateStateClaimName(agentId: string): string {
    return KubernetesStorage.gatewayPrivateStateClaimName(agentId);
  }

  private sharedWorkspaceClaim(
    agentId: string,
    ownership: Ownership,
    namespace: string,
  ): ManagedKubernetesObject<"PersistentVolumeClaim"> {
    return KubernetesStorage.sharedWorkspaceClaim(agentId, ownership, namespace);
  }

  private gatewayPrivateStateClaim(
    agentId: string,
    ownership: Ownership,
    namespace: string,
  ): ManagedKubernetesObject<"PersistentVolumeClaim"> {
    return KubernetesStorage.gatewayPrivateStateClaim(
      this.options.runtime?.gatewayStorageClassName,
      agentId,
      ownership,
      namespace,
    );
  }

  private sharedWorkspaceVolumeMounts(role: SharedWorkspaceRole): V1VolumeMount[] {
    return KubernetesStorage.sharedWorkspaceVolumeMounts(role);
  }

  private gatewayPrivateStateVolumeMounts(embedded: boolean): V1VolumeMount[] {
    return KubernetesStorage.gatewayPrivateStateVolumeMounts(embedded);
  }

  private privateStateDirectories(role: SharedWorkspaceRole): string[] {
    return KubernetesStorage.privateStateDirectories(role);
  }

  private privateStateInitContainer(
    role: SharedWorkspaceRole,
    image: string,
    embedded: boolean,
  ): KubernetesRecord {
    return KubernetesStorage.privateStateInitContainer(
      this.options.runtime !== undefined,
      role,
      image,
      embedded,
    );
  }

  private async deleteGatewayPrivateStateClaim(
    ownership: Ownership,
    namespace: string,
  ): Promise<void> {
    return this.cleanup.deleteGatewayPrivateStateClaim(ownership, namespace);
  }

  private agentAuthenticationNetworkPolicy(
    revision: AgentRevision,
    namespace: string,
  ): ManagedKubernetesObject {
    return KubernetesChannelPolicy.agentAuthenticationNetworkPolicy(
      this.options.runtime !== undefined,
      revision,
      namespace,
    );
  }

  private enabledChannels(revision: AgentRevision): readonly ChannelRequirements[] {
    return KubernetesChannelPolicy.enabledChannels(
      this.options.runtime?.channels !== undefined,
      revision,
    );
  }

  private channelNetworkPolicy(
    revision: AgentRevision,
    enabled: readonly ChannelRequirements[],
    namespace: string,
  ): ManagedKubernetesObject {
    return KubernetesChannelPolicy.channelNetworkPolicy(
      this.options.runtime?.channels?.proxyUrl,
      revision,
      enabled,
      namespace,
    );
  }

  private async reconcileChannelNetworkPolicy(
    revision: AgentRevision,
    enabled: readonly ChannelRequirements[],
    namespace: string,
  ): Promise<void> {
    const policy = this.channelNetworkPolicy(revision, enabled, namespace);
    const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
    if (this.options.runtime?.channels === undefined) {
      const existing = await this.getOwned(
        "NetworkPolicy",
        policy.metadata.name,
        namespace,
        ownership,
      );
      if (existing === undefined) return;
    }
    await this.reconcile(policy, ownership, namespace);
  }

  private agentNetworkPolicies(
    revision: AgentRevision,
    namespace: string,
  ): ManagedKubernetesObject[] {
    return KubernetesChannelPolicy.agentNetworkPolicies(
      this.options.runtime !== undefined,
      revision,
      namespace,
    );
  }

  private secretEnvironmentForRevision(
    revision: AgentRevision,
    context: ComputeRevisionContext | undefined,
    namespace: string,
  ): readonly SecretEnvironmentProjection[] {
    return KubernetesSecretProjection.secretEnvironmentForRevision(revision, context, namespace);
  }

  private deployment(
    name: string,
    ownership: Ownership,
    namespace: string,
    image: string,
    serviceAccountName: string,
    role: "gateway" | "agent",
    environment: Readonly<Record<string, string>>,
    loggingLevel: LoggingLevel,
    configuration?: GatewayConfigurationSnapshot,
    embedded = false,
    workloadServicePrincipalId?: string,
    serviceAccount?: AgentRevision["serviceAccount"],
    enabledChannels: readonly ChannelRequirements[] = [],
    secretEnvironment: readonly SecretEnvironmentProjection[] = [],
  ): ManagedKubernetesObject {
    return KubernetesHarness.deployment(
      {
        ...(this.options.isolationProfile === undefined
          ? {}
          : { isolationProfile: this.options.isolationProfile }),
        resources: { gateway: this.options.resources.gateway, agent: this.options.resources.agent },
        network: { gatewayPort: this.options.network.gatewayPort },
        servicePrincipalCredentials: this.options.servicePrincipalCredentials,
        ...(this.options.runtime === undefined ? {} : { runtime: this.options.runtime }),
      },
      name,
      ownership,
      namespace,
      image,
      serviceAccountName,
      role,
      environment,
      loggingLevel,
      configuration,
      embedded,
      workloadServicePrincipalId,
      serviceAccount,
      enabledChannels,
      secretEnvironment,
    );
  }

  private service(
    name: string,
    ownership: Ownership,
    namespace: string,
    selector: Record<string, string>,
  ): ManagedKubernetesObject<"Service"> {
    return KubernetesNetwork.service(
      {
        gatewayPort: this.options.network.gatewayPort,
        runtimeEnabled: this.options.runtime !== undefined,
      },
      name,
      ownership,
      namespace,
      selector,
    );
  }

  private async reconcile(
    desired: ManagedKubernetesObject,
    ownership: Ownership,
    namespace?: string,
  ): Promise<void> {
    return this.mutations.reconcile(desired, ownership, namespace);
  }

  private async reconcileServiceForSelector(
    desired: ManagedKubernetesObject<"Service">,
    ownership: Ownership,
    namespace: string,
    serviceSelector: Readonly<Record<string, string>>,
  ): Promise<void> {
    return this.mutations.reconcileServiceForSelector(
      desired,
      ownership,
      namespace,
      serviceSelector,
    );
  }

  private async getOwned<Kind extends ReadableResourceKind>(
    kind: Kind,
    name: string,
    namespace: string | undefined,
    ownership: Ownership,
  ): Promise<ManagedKubernetesObject<Kind> | undefined> {
    return this.ownership.getOwned(kind, name, namespace, ownership);
  }

  private async get<Kind extends ReadableResourceKind>(
    kind: Kind,
    name: string,
    namespace?: string,
  ): Promise<ManagedKubernetesObject<Kind> | undefined> {
    const clients = await this.clients();
    try {
      const value = asRecord(
        await this.request(async () => {
          switch (kind) {
            case "Namespace":
              return clients.core.readNamespace({ name });
            case "Pod":
              return clients.core.readNamespacedPod({
                name,
                namespace: required(namespace, "Pod namespace"),
              });
            case "ConfigMap":
              return clients.core.readNamespacedConfigMap({
                name,
                namespace: required(namespace, "ConfigMap namespace"),
              });
            case "Secret":
              return clients.core.readNamespacedSecret({
                name,
                namespace: required(namespace, "Secret namespace"),
              });
            case "ServiceAccount":
              return clients.core.readNamespacedServiceAccount({
                name,
                namespace: required(namespace, "ServiceAccount namespace"),
              });
            case "Service":
              return clients.core.readNamespacedService({
                name,
                namespace: required(namespace, "Service namespace"),
              });
            case "ResourceQuota":
              return clients.core.readNamespacedResourceQuota({
                name,
                namespace: required(namespace, "ResourceQuota namespace"),
              });
            case "LimitRange":
              return clients.core.readNamespacedLimitRange({
                name,
                namespace: required(namespace, "LimitRange namespace"),
              });
            case "PersistentVolumeClaim":
              return clients.core.readNamespacedPersistentVolumeClaim({
                name,
                namespace: required(namespace, "PersistentVolumeClaim namespace"),
              });
            case "Deployment":
              return clients.apps.readNamespacedDeployment({
                name,
                namespace: required(namespace, "Deployment namespace"),
              });
            case "NetworkPolicy":
              return clients.networking.readNamespacedNetworkPolicy({
                name,
                namespace: required(namespace, "NetworkPolicy namespace"),
              });
            case "HTTPRoute":
              return clients.objects.read({
                apiVersion: GATEWAY_API_VERSION,
                kind,
                metadata: { name, namespace: required(namespace, "HTTPRoute namespace") },
              });
            default: {
              const unsupported: never = kind;
              throw new ConfigurationFailure(
                `Unsupported managed Kubernetes resource ${unsupported}.`,
              );
            }
          }
        }),
      );
      const metadata = asRecord(value?.metadata);
      if (
        value === undefined ||
        typeof value.apiVersion !== "string" ||
        value.kind !== kind ||
        metadata === undefined ||
        metadata.name !== name ||
        (namespace !== undefined && metadata.namespace !== namespace)
      ) {
        throw new Error(`The Kubernetes client returned an invalid or ambiguous ${kind} ${name}.`);
      }
      return value as unknown as ManagedKubernetesObject<Kind>;
    } catch (error) {
      if (numericErrorStatus(error) === 404) return undefined;
      throw error;
    }
  }
}

export function createKubernetesComputeDriver(
  options: KubernetesComputeDriverOptions,
): KubernetesComputeDriver {
  return new KubernetesComputeDriver(options);
}
