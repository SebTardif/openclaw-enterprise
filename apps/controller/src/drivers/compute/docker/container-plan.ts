import type { LoggingLevel } from "@openclaw-enterprise/contracts";
import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import { ownershipMetadata } from "./ownership.ts";
import type { Ownership } from "./ownership.ts";

export interface RuntimeContainerInput {
  readonly name: string;
  readonly image: string;
  readonly network: string;
  readonly ownership: Ownership;
  readonly role: "agent" | "gateway";
  readonly environment: Readonly<Record<string, string>>;
  readonly command: string;
  readonly healthcheckScript: string;
  readonly exposedPort: number;
  readonly labels?: Readonly<Record<string, string>>;
  readonly portBindings?: Readonly<
    Record<string, readonly { readonly HostIp: string; readonly HostPort: string }[]>
  >;
}

export class ConfigurationFailure extends Error {}

const ROLE_LABEL = "org.openclaw.enterprise.role";
const VERSION_LABEL = "org.openclaw.enterprise.version";
export const GATEWAY_PORT = 8080;
export const AGENT_TRANSPORT_PORT = 18_790;
const MODEL_API_KEY = "OPENAI_API_KEY";
const CONFIGURATION_DOCUMENT = "/home/node/.openclaw/openclaw.json";

export function required(value: unknown, description: string): string {
  if (!isNonEmptyString(value)) {
    throw new ConfigurationFailure(`${description} must be explicitly configured.`);
  }
  return value;
}

export function optionalEnvironment(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function loopbackHost(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
}

export function dockerLoggingAddress(value: string | undefined): string | undefined {
  const trimmed = optionalEnvironment(value);
  if (trimmed === undefined) return undefined;
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(trimmed);
  const plain = bracketed === null ? /^([^:]+):(\d+)$/.exec(trimmed) : null;
  const host = bracketed?.[1] ?? plain?.[1];
  const portText = bracketed?.[2] ?? plain?.[2];
  const port = Number(portText);
  if (
    host === undefined ||
    portText === undefined ||
    !loopbackHost(host) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new ConfigurationFailure("Docker logging address must be a loopback host:port.");
  }
  return host === "::1" ? `[::1]:${port}` : `${host}:${port}`;
}

export function logConfig(
  labels: Readonly<Record<string, string>>,
  loggingAddress: string,
): {
  readonly Type: "fluentd";
  readonly Config: Readonly<Record<string, string>>;
} {
  const exportedLabels = Object.keys(labels)
    .filter((name) => name.startsWith("org.openclaw.enterprise."))
    .sort()
    .join(",");
  return {
    Type: "fluentd",
    Config: {
      "fluentd-address": required(loggingAddress, "Docker logging address"),
      "fluentd-async": "true",
      "fluentd-buffer-limit": "1024",
      "fluentd-write-timeout": "1s",
      mode: "non-blocking",
      "max-buffer-size": "1m",
      "cache-disabled": "false",
      "cache-max-size": "10m",
      "cache-max-file": "2",
      "cache-compress": "true",
      labels: exportedLabels,
    },
  };
}

export function providerEnvironment(
  credential: string | undefined,
): Readonly<Record<string, string>> {
  if (credential === undefined || credential.trim().length === 0) {
    throw new ConfigurationFailure("OPENAI_API_KEY must be present for Docker runtime execution.");
  }
  return { [MODEL_API_KEY]: credential };
}

export function runtimeContainerPayload(input: RuntimeContainerInput, loggingAddress?: string) {
  const labels = {
    ...ownershipMetadata(input.ownership),
    [ROLE_LABEL]: input.role,
    ...input.labels,
    [VERSION_LABEL]: input.image,
  };
  return {
    Image: input.image,
    User: "1000:1000",
    Env: Object.entries(input.environment).map(([name, value]) => `${name}=${value}`),
    Entrypoint: ["node"],
    Cmd: ["-e", input.command],
    Labels: labels,
    ExposedPorts: { [`${input.exposedPort}/tcp`]: {} },
    Healthcheck: {
      Test: ["CMD", "node", "-e", input.healthcheckScript],
      Interval: 2_000_000_000,
      Timeout: 2_000_000_000,
      Retries: 15,
    },
    HostConfig: {
      NetworkMode: input.network,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Tmpfs: {
        "/home/node": "size=1024m,uid=1000,gid=1000,mode=700",
        "/tmp": "size=64m,uid=1000,gid=1000,mode=1777",
      },
      ...(input.portBindings === undefined ? {} : { PortBindings: input.portBindings }),
      ...(loggingAddress === undefined ? {} : { LogConfig: logConfig(labels, loggingAddress) }),
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [input.network]: { Aliases: [input.name] },
      },
    },
  };
}

export function gatewayUsesTrustedProxy(configuration: Readonly<Record<string, unknown>>): boolean {
  return asRecord(asRecord(configuration.gateway)?.auth)?.mode === "trusted-proxy";
}

export function gatewayEnvironment(
  configuration: string,
  environment: Readonly<Record<string, string>>,
  gatewayToken: string | undefined,
): Readonly<Record<string, string>> {
  return {
    ...environment,
    OPENCLAW_CONFIG_JSON: configuration,
    OPENCLAW_CONFIG_PATH: CONFIGURATION_DOCUMENT,
    OPENCLAW_GATEWAY_PORT: String(GATEWAY_PORT),
    ...(gatewayToken === undefined ? {} : { OPENCLAW_GATEWAY_TOKEN: gatewayToken }),
    OPENCLAW_STATE_DIR: "/home/node/.openclaw",
    HOME: "/home/node",
  };
}

export function agentEnvironment(
  environment: Readonly<Record<string, string>>,
  appServerToken: string,
  loggingLevel: LoggingLevel,
): Readonly<Record<string, string>> {
  return {
    ...environment,
    APP_SERVER_PORT: String(AGENT_TRANSPORT_PORT),
    APP_SERVER_TOKEN: appServerToken,
    CODEX_HOME: "/home/node/.codex",
    LOG_FORMAT: "json",
    RUST_LOG: `${loggingLevel},codex_otel=off`,
    HOME: "/home/node",
    PATH: "/app/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
}
