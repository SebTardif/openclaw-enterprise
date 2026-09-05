import { asRecord, isNonEmptyString } from "@openclaw-enterprise/utils";
import type { DriverImplementation, ProviderDefinition } from "@openclaw-enterprise/contracts";
import { parseRuntimeAuthoritySource, type RuntimeAuthoritySource } from "@openclaw-enterprise/occ";
import { Check } from "typebox/value";
import type { LoggingConfiguration } from "../../logging.ts";

export type ConfigurationRecord = Readonly<Record<string, unknown>>;

export interface StartupConfigurationSnapshot {
  readonly configuration?: ConfigurationRecord;
  readonly logging: LoggingConfiguration;
}

export interface SelectedDriverConfiguration<T = ConfigurationRecord> {
  readonly id: string;
  readonly implementation: string;
  readonly package?: string;
  readonly configuration: T;
}

export interface InstallationStartupConfiguration {
  readonly occ: { readonly cluster: string };
  readonly logging: LoggingConfiguration;
  readonly provider: readonly ProviderDefinition[];
  readonly runtimeAuthoritySources?: readonly RuntimeAuthoritySource[];
  readonly drivers: {
    readonly configuration: SelectedDriverConfiguration;
    readonly iam: SelectedDriverConfiguration<ConfigurationRecord>;
    readonly compute: SelectedDriverConfiguration;
    readonly secret: SelectedDriverConfiguration;
    readonly sandbox?: SelectedDriverConfiguration;
    readonly service_account?: { readonly id: string };
  };
}

const FORBIDDEN_SECRET_KEY =
  /(?:password|passwd|api[_-]?key|(?:access[_-]?)?token|private[_-]?key|(?:client[_-]?)?secret|credentials?)$/i;
const FORBIDDEN_SECRET_VALUE =
  /\bBearer\s+[A-Za-z0-9._~-]+|\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{12,}|\bAKIA[0-9A-Z]{16}\b/i;

export function object(value: unknown, path: string): ConfigurationRecord {
  const result = asRecord(value);
  if (result === undefined) {
    throw new Error(`${path} must be one object.`);
  }
  return result;
}

export function closed(value: ConfigurationRecord, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new Error(`${path} contains unsupported option ${key}.`);
    }
  }
}

export function nonempty(value: unknown, path: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`${path} must be a nonempty string.`);
  }
  return value;
}

export function safe(value: unknown, path: string): void {
  if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new Error(`${path} must be a safe integer.`);
  }
  if (typeof value === "string" && FORBIDDEN_SECRET_VALUE.test(value)) {
    throw new Error(`${path} must not contain a plaintext credential.`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => safe(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "installationId" || key === "installation_id") {
      throw new Error("Installation startup configuration must not contain an Installation ID.");
    }
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`${path} contains an unsafe configuration key.`);
    }
    if (FORBIDDEN_SECRET_KEY.test(key) && typeof entry === "string") {
      throw new Error(`${path}.${key} must not contain a plaintext credential.`);
    }
    if (key === "secretRef") {
      nonempty(entry, `${path}.${key}`);
      throw new Error("Installation-scoped secret references cannot be resolved safely.");
    }
    safe(entry, `${path}.${key}`);
  }
}

export function selected(
  value: unknown,
  capability: "configuration" | "iam" | "compute" | "secret" | "sandbox",
  implementation: string,
  driver: DriverImplementation,
): SelectedDriverConfiguration {
  const path = `drivers.${capability}`;
  const selection = object(value, path);
  const id = nonempty(selection.id, `${path}.id`);
  const configuration = object(selection.configuration, `${path}.configuration`);
  const schema = object(driver.configurationSchema, `${path}.configurationSchema`);
  if (schema.additionalProperties !== false) {
    throw new Error(`${path} must expose a closed configuration schema before construction.`);
  }
  let validSchema = false;
  try {
    validSchema = Check(schema, configuration);
  } catch {
    // An unsupported schema must fail closed instead of skipping validation.
  }
  if (!validSchema) {
    throw new Error(`${path}.configuration does not match its Driver configuration schema.`);
  }
  driver.validateConfiguration(configuration);
  return Object.freeze({
    id,
    implementation,
    ...(Object.hasOwn(selection, "package")
      ? { package: nonempty(selection.package, `${path}.package`) }
      : {}),
    configuration,
  });
}

export function validateStartupConfiguration(value: unknown): ConfigurationRecord {
  const configuration = object(value, "Installation startup configuration");
  safe(configuration, "Installation startup configuration");
  if (Object.hasOwn(configuration, "integrations")) {
    throw new Error(
      "integrations is retired; configure ChatGPT with provider[].configuration.apiKeyPath.",
    );
  }
  closed(
    configuration,
    ["occ", "drivers", "provider", "logging", "runtimeAuthoritySources"],
    "Installation startup configuration",
  );
  return configuration;
}

export function parseInstallationConfiguration(configuration: ConfigurationRecord): {
  readonly cluster: string;
  readonly drivers: ConfigurationRecord;
} {
  const occ = object(configuration.occ, "occ");
  closed(occ, ["cluster"], "occ");
  const cluster = nonempty(occ.cluster, "occ.cluster");
  const drivers = object(configuration.drivers, "drivers");
  closed(
    drivers,
    ["configuration", "iam", "compute", "secret", "sandbox", "service_account"],
    "drivers",
  );

  return { cluster, drivers };
}

export function runtimeAuthoritySourcesConfiguration(
  value: unknown,
): readonly RuntimeAuthoritySource[] {
  const rawSources = value ?? [];
  if (!Array.isArray(rawSources) || rawSources.length > 32)
    throw new Error("runtimeAuthoritySources must contain at most 32 protected technical sources.");
  const runtimeAuthoritySources = Object.freeze(rawSources.map(parseRuntimeAuthoritySource));
  if (
    new Set(runtimeAuthoritySources.map((source) => source.sourceRef)).size !==
    runtimeAuthoritySources.length
  )
    throw new Error("runtimeAuthoritySources refs must be unique.");

  return runtimeAuthoritySources;
}

export function selectedDriverConfigurations(drivers: ConfigurationRecord) {
  const configurationSelection = object(drivers.configuration, "drivers.configuration");
  const iamSelection = object(drivers.iam, "drivers.iam");
  const computeSelection = object(drivers.compute, "drivers.compute");
  const secretSelection = object(drivers.secret, "drivers.secret");
  const sandboxSelection =
    drivers.sandbox === undefined ? undefined : object(drivers.sandbox, "drivers.sandbox");
  for (const [capability, selection] of [
    ["configuration", configurationSelection],
    ["iam", iamSelection],
    ["compute", computeSelection],
    ["secret", secretSelection],
    ...(sandboxSelection === undefined ? [] : ([["sandbox", sandboxSelection]] as const)),
  ] as const) {
    closed(
      selection,
      capability === "secret" ? ["id", "configuration"] : ["id", "package", "configuration"],
      `drivers.${capability}`,
    );
  }

  return {
    configurationSelection,
    iamSelection,
    computeSelection,
    secretSelection,
    sandboxSelection,
  };
}
