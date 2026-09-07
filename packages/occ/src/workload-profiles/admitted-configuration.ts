import { Check } from "typebox/value";
import {
  AgentId,
  ConfigurationGeneration,
  ConfigurationId,
  InstallationId,
  NamespaceId,
  ServiceAccountId,
  ServiceAccountCredentialSchema,
  SecretReference,
} from "@openclaw-enterprise/contracts/api/common";
import {
  WorkloadProfileDigestSchemaV1,
  WorkloadProfileRolesSchemaV1,
  type WorkloadProfileRolesV1,
} from "@openclaw-enterprise/contracts/workload-profile-v1";
import type { ServiceAccountRevision } from "@openclaw-enterprise/contracts/resources/service-account";
import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts/resources/configuration";
import type { SecretBindings } from "@openclaw-enterprise/contracts/resources/secret";
import { normalizeSecretBindings } from "@openclaw-enterprise/contracts/secret-bindings";
import { admittedLoggingLevel } from "@openclaw-enterprise/contracts/logging";
import { frozenValues, resolveConfiguredHarnessId } from "../services/deployment/configuration.ts";
import {
  canonicalizeWorkloadProfileJson,
  decodeWorkloadProfileJson,
  workloadProfileDigest,
} from "./canonical.ts";

/** Logical immutable policy members, before any PVC/Pod/effect realization. */
export interface AdmittedStorePolicyBindingV1 {
  readonly component: "gateway" | "harness";
  readonly name: string;
  readonly path: string;
  readonly store: Readonly<{ ref: string; version: number; contentDigest: string }>;
  readonly access: "read-only" | "read-write";
}

export interface AdmittedConfigurationProjectionV1 {
  readonly manifestDigest: string;
  readonly configurationRef: string;
  readonly configurationGeneration: number;
  readonly immutableConfigurationContent: Readonly<{
    kind: "agent";
    values: OpenClawConfigurationDocument;
    secretBindings: SecretBindings;
  }>;
  readonly resolvedProfileBindingParameters: Readonly<{
    installationId: string;
    namespaceId: string;
    agentId: string;
    serviceAccountAssociation: Readonly<{
      servicePrincipalId: string;
      serviceAccount: ServiceAccountRevision;
    }>;
    storePolicyBindings: readonly AdmittedStorePolicyBindingV1[];
    roleBindings: WorkloadProfileRolesV1;
  }>;
}

export class AdmittedConfigurationError extends Error {
  readonly code: "unsupported-configuration" | "invalid-binding";
  constructor(code: "unsupported-configuration" | "invalid-binding") {
    super(`Admitted Configuration refused: ${code}`);
    this.code = code;
  }
}

type RecordValue = Record<string, unknown>;
const fail = (code: AdmittedConfigurationError["code"] = "unsupported-configuration"): never => {
  throw new AdmittedConfigurationError(code);
};
function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const result = value as RecordValue;
  if (
    required.some((key) => !Object.hasOwn(result, key)) ||
    Object.keys(result).some((key) => !required.includes(key) && !optional.includes(key))
  )
    fail();
  return result;
}
function string(value: unknown, max = 255): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.trim() !== value
  )
    fail();
}
function literal(value: unknown, allowed: readonly unknown[]): void {
  if (!allowed.includes(value)) fail();
}
function array(value: unknown, max: number, min = 0): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return fail();
  return value;
}
function entries(value: unknown, max: number, min = 0): [string, unknown][] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const result = Object.entries(value);
  if (result.length < min || result.length > max) fail();
  for (const [key] of result) string(key);
  return result;
}
function uniqueStrings(value: unknown, max: number, allowed?: readonly string[]): string[] {
  const result = array(value, max).map((item) => {
    string(item);
    if (allowed && !allowed.includes(item)) fail();
    return item;
  });
  if (new Set(result).size !== result.length) fail();
  return result;
}
function runtime(value: unknown): void {
  literal(object(value, ["id"]).id, ["openclaw", "codex"]);
}
function model(value: unknown): void {
  string(value, 255);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:/-]+$/.test(value)) fail();
}

/** Closed supported native branch. This preserves every accepted content byte;
 * it never strips an unknown native option or substitutes a default value.
 * Driver/native semantic validation remains mandatory in the admitting unit. */
function nativeConfiguration(
  input: unknown,
  secretBindings: SecretBindings,
): Readonly<OpenClawConfigurationDocument> {
  const value = object(
    input,
    ["agents", "models", "logging", "diagnostics"],
    ["gateway", "plugins", "secrets", "tools"],
  );
  const agents = object(value.agents, ["defaults"], ["list"]);
  if (agents.list !== undefined && array(agents.list, 0).length !== 0) fail();
  const defaults = object(agents.defaults, ["model", "models"]);
  if (typeof defaults.model === "string") model(defaults.model);
  else {
    const selected = object(defaults.model, ["primary", "fallbacks"]);
    model(selected.primary);
    for (const fallback of uniqueStrings(selected.fallbacks, 32)) model(fallback);
  }
  for (const [name, policy] of entries(defaults.models, 64, 1)) {
    model(name);
    runtime(object(policy, ["agentRuntime"]).agentRuntime);
  }
  const providerRefs = new Map<string, Readonly<{ provider: string; id: string }>>();
  const providers = object(value.models, ["providers"]);
  for (const [name, inputProvider] of entries(providers.providers, 16, 1)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) fail();
    const provider = object(
      inputProvider,
      ["baseUrl", "api", "models"],
      ["agentRuntime", "apiKey"],
    );
    string(provider.baseUrl, 2048);
    let url: URL;
    try {
      url = new URL(provider.baseUrl);
    } catch {
      return fail();
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" && provider.baseUrl !== "http://127.0.0.1:9")
    )
      fail();
    literal(provider.api, ["openai-responses"]);
    if (provider.agentRuntime !== undefined) runtime(provider.agentRuntime);
    const ids = new Set<string>();
    for (const entry of array(provider.models, 64, 1)) {
      const item = object(entry, ["id", "name"], ["input", "agentRuntime"]);
      string(item.id);
      string(item.name);
      if (ids.has(item.id)) fail();
      ids.add(item.id);
      if (item.input !== undefined) uniqueStrings(item.input, 2, ["text", "image"]);
      if (item.agentRuntime !== undefined) runtime(item.agentRuntime);
    }
    if (provider.apiKey !== undefined) {
      const ref = object(provider.apiKey, ["source", "provider", "id"]);
      literal(ref.source, ["env"]);
      string(ref.provider);
      string(ref.id);
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,252}$/.test(ref.id)) fail();
      providerRefs.set(name, { provider: ref.provider, id: ref.id });
    }
  }
  const secretProviders = new Map<string, string[]>();
  if (value.secrets !== undefined) {
    const secrets = object(value.secrets, ["providers"]);
    for (const [name, source] of entries(secrets.providers, 16, 1)) {
      const definition = object(source, ["source", "allowlist"]);
      literal(definition.source, ["env"]);
      const allowlist = uniqueStrings(definition.allowlist, 64);
      if (allowlist.some((environment) => !Object.hasOwn(secretBindings, environment)))
        fail("invalid-binding");
      secretProviders.set(name, allowlist);
    }
  }
  for (const ref of providerRefs.values()) {
    if (!secretProviders.get(ref.provider)?.includes(ref.id)) fail();
  }
  if (value.gateway !== undefined) {
    const gateway = object(value.gateway, ["mode", "bind", "controlUi", "auth", "http"]);
    literal(gateway.mode, ["local"]);
    literal(gateway.bind, ["lan"]);
    literal(object(gateway.controlUi, ["enabled"]).enabled, [false]);
    const auth = object(gateway.auth, ["mode", "token"]);
    literal(auth.mode, ["token"]);
    literal(auth.token, ["${OPENCLAW_GATEWAY_TOKEN}"]);
    const http = object(gateway.http, ["endpoints"]);
    const endpoints = object(http.endpoints, ["chatCompletions"]);
    literal(object(endpoints.chatCompletions, ["enabled"]).enabled, [true]);
  }
  if (value.plugins !== undefined) {
    const plugins = object(value.plugins, ["allow", "entries"]);
    const allow = uniqueStrings(plugins.allow, 1, ["codex"]);
    if (allow.length !== 1) fail();
    const pluginEntries = object(plugins.entries, ["codex"]);
    const codex = object(pluginEntries.codex, ["enabled", "config"]);
    literal(codex.enabled, [true]);
    const config = object(codex.config, ["appServer"]);
    const app = object(config.appServer, [
      "mode",
      "approvalPolicy",
      "sandbox",
      "transport",
      "url",
      "authToken",
    ]);
    literal(app.mode, ["guardian"]);
    literal(app.approvalPolicy, ["on-request"]);
    literal(app.sandbox, ["read-only"]);
    literal(app.transport, ["websocket"]);
    literal(app.url, ["${APP_SERVER_URL}"]);
    literal(app.authToken, ["${APP_SERVER_TOKEN}"]);
  }
  if (value.tools !== undefined) {
    const tools = object(value.tools, ["allow", "fs"]);
    uniqueStrings(tools.allow, 3, ["read", "write", "edit"]);
    literal(object(tools.fs, ["workspaceOnly"]).workspaceOnly, [true]);
  }
  object(value.logging, ["level", "consoleLevel", "consoleStyle", "redactSensitive"]);
  const diagnostics = object(value.diagnostics, ["otel"]);
  object(diagnostics.otel, ["logs"]);
  const values = frozenValues(value);
  admittedLoggingLevel(values);
  resolveConfiguredHarnessId(values);
  return values;
}

function stores(input: unknown): readonly AdmittedStorePolicyBindingV1[] {
  const result: AdmittedStorePolicyBindingV1[] = [];
  const identities = new Set<string>();
  const paths = new Set<string>();
  for (const entry of array(input, 32, 2)) {
    const binding = object(entry, ["component", "name", "path", "store", "access"]);
    literal(binding.component, ["gateway", "harness"]);
    string(binding.name);
    string(binding.path, 1024);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(binding.name) ||
      !/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(binding.path) ||
      binding.path.split("/").some((part) => part === "." || part === "..")
    )
      fail("invalid-binding");
    literal(binding.access, ["read-only", "read-write"]);
    const policy = object(binding.store, ["ref", "version", "contentDigest"]);
    string(policy.ref);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,254}$/.test(policy.ref) ||
      !Check(ConfigurationGeneration, policy.version) ||
      !Check(WorkloadProfileDigestSchemaV1, policy.contentDigest)
    )
      fail("invalid-binding");
    const key = `${binding.component}/${binding.name}`;
    const pathKey = `${binding.component}:${binding.path}`;
    if (identities.has(key) || paths.has(pathKey)) fail("invalid-binding");
    identities.add(key);
    paths.add(pathKey);
    result.push(binding as unknown as AdmittedStorePolicyBindingV1);
  }
  if (
    !result.some((entry) => entry.component === "gateway") ||
    !result.some((entry) => entry.component === "harness")
  )
    fail("invalid-binding");
  if (
    ["gateway", "harness"].some(
      (component) => result.filter((entry) => entry.component === component).length > 16,
    )
  )
    fail("invalid-binding");
  result.sort((a, b) => {
    const left = `${a.component}/${a.name}`;
    const right = `${b.component}/${b.name}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return Object.freeze(result);
}

/** Decode the full original projection before hashing. The caller supplies the
 * actual values AFTER sandbox/logging normalization and current reference checks.
 * This pure codec neither authenticates those inputs nor writes an admission.
 * Every applicable reference must have been resolved by the same admitting unit. */
export function deriveAdmittedConfigurationV1(input: unknown): Readonly<{
  projection: AdmittedConfigurationProjectionV1;
  canonicalBytes: Uint8Array;
  admittedConfigurationDigest: string;
}> {
  try {
    // Preserve the existing byte domain and inspect object brands before the
    // closed field checks. Raw byte input keeps duplicate detection in decode.
    const snapshot = decodeWorkloadProfileJson(canonicalizeWorkloadProfileJson(input)).value;
    const value = object(snapshot, [
      "manifestDigest",
      "configurationRef",
      "configurationGeneration",
      "immutableConfigurationContent",
      "resolvedProfileBindingParameters",
    ]);
    if (
      !Check(WorkloadProfileDigestSchemaV1, value.manifestDigest) ||
      !Check(ConfigurationId, value.configurationRef) ||
      !Check(ConfigurationGeneration, value.configurationGeneration)
    )
      fail("invalid-binding");
    const content = object(value.immutableConfigurationContent, [
      "kind",
      "values",
      "secretBindings",
    ]);
    literal(content.kind, ["agent"]);
    const bindings = object(value.resolvedProfileBindingParameters, [
      "installationId",
      "namespaceId",
      "agentId",
      "serviceAccountAssociation",
      "storePolicyBindings",
      "roleBindings",
    ]);
    if (
      !Check(InstallationId, bindings.installationId) ||
      !Check(NamespaceId, bindings.namespaceId) ||
      !Check(AgentId, bindings.agentId) ||
      !Check(WorkloadProfileRolesSchemaV1, bindings.roleBindings)
    )
      fail("invalid-binding");
    const roles = bindings.roleBindings as WorkloadProfileRolesV1;
    if (new Set(Object.values(roles).map((role) => role.ref)).size !== 5) fail("invalid-binding");
    const association = object(bindings.serviceAccountAssociation, [
      "servicePrincipalId",
      "serviceAccount",
    ]);
    string(association.servicePrincipalId);
    const account = object(association.serviceAccount, ["id", "credential"]);
    if (
      !Check(ServiceAccountId, account.id) ||
      !Check(ServiceAccountCredentialSchema, account.credential)
    )
      fail("invalid-binding");
    const credential = object(account.credential, ["kind", "secretRef"]);
    literal(credential.kind, ["api_key", "access_token"]);
    const secrets = normalizeSecretBindings(content.secretBindings);
    for (const { source } of Object.values(secrets)) {
      if (!Check(SecretReference, source) || source.namespaceId !== bindings.namespaceId)
        fail("invalid-binding");
    }
    const normalized = {
      ...value,
      immutableConfigurationContent: {
        kind: "agent",
        values: nativeConfiguration(content.values, secrets),
        secretBindings: secrets,
      },
      resolvedProfileBindingParameters: {
        ...bindings,
        storePolicyBindings: stores(bindings.storePolicyBindings),
      },
    };
    const canonicalBytes = canonicalizeWorkloadProfileJson(normalized);
    const projection = decodeWorkloadProfileJson(canonicalBytes)
      .value as unknown as AdmittedConfigurationProjectionV1;
    return Object.freeze({
      projection,
      canonicalBytes,
      admittedConfigurationDigest: workloadProfileDigest("admittedConfigurationDigest", projection),
    });
  } catch (error) {
    if (error instanceof AdmittedConfigurationError) throw error;
    throw new AdmittedConfigurationError("unsupported-configuration");
  }
}

/** Retained byte input keeps duplicate-key and encoding rejection before any
 * ordinary JSON parser can erase them. It does not authenticate a stored row. */
export function decodeAdmittedConfigurationV1(input: Uint8Array) {
  try {
    return deriveAdmittedConfigurationV1(decodeWorkloadProfileJson(input).value);
  } catch (error) {
    if (error instanceof AdmittedConfigurationError) throw error;
    throw new AdmittedConfigurationError("unsupported-configuration");
  }
}
