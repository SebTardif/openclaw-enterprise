import type { Permission } from "./identity/authorization.ts";
import type { ResourceRef } from "./resources/scope.ts";

/** Representation and template evaluation only. Decoding never authenticates a writer. */
export const MANUAL_NATIVE_POLICY_LIMITS_V1 = Object.freeze({
  maxCommandBytes: 16 * 1024,
  maxRegistrationBytes: 8 * 1024,
  maxResultBytes: 16 * 1024,
  maxPrincipals: 8,
  maxReferencesPerKind: 8,
  maxOperations: 16,
  maxBindings: 64,
});

export type ManualPolicyTemplateV1 =
  | "account-baseline"
  | "agent-operator"
  | "agent-administrator"
  | "agent-collaborator"
  | "audience-reader";

export type ManualPolicyOperationV1 =
  | "installation.read"
  | "agent.status"
  | "agent.deploy"
  | "agent.disable"
  | "agent.stop"
  | "agent.resume"
  | "agent.reconcile-observation"
  | "agent.administer"
  | "context.recover-pristine"
  | "context.accept-residual-workspace"
  | "conversation.read"
  | "turn.admit"
  | "turn.dispatch"
  | "grant.use"
  | "model.generate"
  | "repository.token.issue"
  | "reply.deliver"
  | "turn.cancel.own";

export type ManualPolicyTargetV1 =
  | Readonly<{ kind: "installation" }>
  | Readonly<{ kind: "agent"; namespaceId: string; agentId: string }>;

export interface ManualPolicyTemplateSpecV1 {
  readonly template: ManualPolicyTemplateV1;
  readonly target: ManualPolicyTargetV1;
  readonly operationCeiling: readonly ManualPolicyOperationV1[];
  readonly references: Readonly<{
    configurationIds: readonly string[];
    serviceAccountIds: readonly string[];
    secretIds: readonly string[];
  }>;
}

export interface ManualPolicyCommandV1 {
  readonly schemaVersion: 1;
  readonly operationRef: string;
  readonly expectedPolicyVersion: number;
  readonly change: "create" | "narrow" | "withdraw";
  readonly specification: ManualPolicyTemplateSpecV1;
  readonly principalIds: readonly string[];
  readonly previousBindings: readonly Readonly<{
    bindingId: string;
    roleId: string;
    expectedRegistrationVersion: number;
  }>[];
}

/** Attached to an actual AccessBinding by the original transactional policy writer. */
export interface ManualPolicyRegistrationV1 {
  readonly schemaVersion: 1;
  readonly version: number;
  readonly status: "enabled" | "disabled";
  readonly installationId: string;
  readonly roleId: string;
  readonly specification: ManualPolicyTemplateSpecV1;
}

export interface ManualPolicyReadV1 {
  readonly schemaVersion: 1;
  readonly operationRef: string;
}

/** Safe outcome data. Current replay/read authorization is still required. */
export type ManualPolicyResultV1 =
  | Readonly<{
      schemaVersion: 1;
      kind: "committed";
      operationRef: string;
      commandDigest: string;
      policyVersion: number;
      roleIds: readonly string[];
      registrations: readonly Readonly<{
        bindingId: string;
        roleId: string;
        version: number;
        status: "enabled" | "disabled";
      }>[];
    }>
  | Readonly<{ schemaVersion: 1; kind: "unknown"; operationRef: string }>
  | Readonly<{ schemaVersion: 1; kind: "conflict" | "denied" | "unavailable" }>;

export type ManualPolicyDecodeResultV1<T> =
  Readonly<{ kind: "valid"; value: T }> | Readonly<{ kind: "invalid" }>;

export interface ManualPolicyGrantDescriptorV1 {
  readonly resource: ResourceRef;
  readonly permissions: readonly Permission[];
}

const operations: Readonly<Record<ManualPolicyTemplateV1, readonly ManualPolicyOperationV1[]>> = {
  "account-baseline": ["installation.read"],
  "agent-operator": [
    "agent.status",
    "agent.deploy",
    "agent.disable",
    "agent.stop",
    "agent.resume",
    "agent.reconcile-observation",
  ],
  "agent-administrator": [
    "agent.status",
    "agent.administer",
    "context.recover-pristine",
    "context.accept-residual-workspace",
  ],
  "agent-collaborator": [
    "conversation.read",
    "turn.admit",
    "turn.dispatch",
    "grant.use",
    "model.generate",
    "repository.token.issue",
    "reply.deliver",
    "turn.cancel.own",
  ],
  "audience-reader": ["conversation.read"],
};

const invalid = Object.freeze({ kind: "invalid" as const });
const refPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const idPatterns = Object.freeze({
  installation: new RegExp(`^ins_${uuid}$`),
  agent: new RegExp(`^agt_${uuid}$`),
  namespace: new RegExp(`^ns_${uuid}$`),
  configuration: new RegExp(`^cfg_${uuid}$`),
  serviceAccount: new RegExp(`^sa_${uuid}$`),
  secret: new RegExp(`^sec_${uuid}$`),
});
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const version = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const ref = (v: unknown): v is string => typeof v === "string" && refPattern.test(v);
const id = (v: unknown, kind: keyof typeof idPatterns): v is string =>
  typeof v === "string" && idPatterns[kind].test(v);
const keys = (v: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(v).sort().join("\0") === [...expected].sort().join("\0");

/** Copy descriptors before validating; never invoke input getters or toJSON. */
function copyJson(
  value: unknown,
  seen: Set<object>,
  budget: { nodes: number },
  depth = 0,
): unknown {
  if (++budget.nodes > 4096 || depth > 12) throw new TypeError("Invalid policy data.");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string" && value.length <= 200) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "object" || value === null || seen.has(value))
    throw new TypeError("Invalid policy data.");
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    throw new TypeError("Invalid policy data.");
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > 65 || ownKeys.some((key) => typeof key !== "string" || key.length > 200))
    throw new TypeError("Invalid policy data.");
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string"))
    throw new TypeError("Invalid policy data.");
  if (array) {
    const length = descriptors.length?.value;
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 64 ||
      Reflect.ownKeys(descriptors).length !== length + 1
    )
      throw new TypeError("Invalid policy data.");
    const result: unknown[] = [];
    for (let i = 0; i < length; i++) {
      const property = descriptors[String(i)];
      if (!property || !property.enumerable || !("value" in property))
        throw new TypeError("Invalid policy data.");
      result.push(copyJson(property.value, seen, budget, depth + 1));
    }
    seen.delete(value);
    // Every array in this closed format is a set, including prior binding IDs.
    result.sort((left, right) => {
      const a = JSON.stringify(left),
        b = JSON.stringify(right);
      if (a === b) return 0;
      return a < b ? -1 : 1;
    });
    return Object.freeze(result);
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(descriptors).sort()) {
    const property = descriptors[key]!;
    if (!property.enumerable || !("value" in property)) throw new TypeError("Invalid policy data.");
    result[key] = copyJson(property.value, seen, budget, depth + 1);
  }
  seen.delete(value);
  return Object.freeze(result);
}

function list(
  value: unknown,
  max: number,
  predicate: (entry: unknown) => boolean,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every(predicate) &&
    new Set(value).size === value.length
  );
}

function specification(value: unknown): value is ManualPolicyTemplateSpecV1 {
  if (
    !record(value) ||
    !keys(value, ["template", "target", "operationCeiling", "references"]) ||
    typeof value.template !== "string" ||
    !Object.hasOwn(operations, value.template)
  )
    return false;
  const template = value.template as ManualPolicyTemplateV1;
  if (!record(value.target) || !record(value.references)) return false;
  if (template === "account-baseline") {
    if (!keys(value.target, ["kind"]) || value.target.kind !== "installation") return false;
  } else if (
    !keys(value.target, ["kind", "namespaceId", "agentId"]) ||
    value.target.kind !== "agent" ||
    !id(value.target.namespaceId, "namespace") ||
    !id(value.target.agentId, "agent")
  )
    return false;
  if (
    !list(
      value.operationCeiling,
      MANUAL_NATIVE_POLICY_LIMITS_V1.maxOperations,
      (entry) =>
        typeof entry === "string" &&
        operations[template].includes(entry as ManualPolicyOperationV1),
    ) ||
    value.operationCeiling.length === 0
  )
    return false;
  if (!keys(value.references, ["configurationIds", "serviceAccountIds", "secretIds"])) return false;
  for (const [key, kind] of [
    ["configurationIds", "configuration"],
    ["serviceAccountIds", "serviceAccount"],
    ["secretIds", "secret"],
  ] as const) {
    if (
      !list(value.references[key], MANUAL_NATIVE_POLICY_LIMITS_V1.maxReferencesPerKind, (entry) =>
        id(entry, kind),
      )
    )
      return false;
  }
  const refs = value.references as unknown as ManualPolicyTemplateSpecV1["references"];
  const selected = value.operationCeiling;
  const deploy = selected.includes("agent.deploy") || selected.includes("agent.resume");
  if (deploy && (refs.configurationIds.length !== 1 || refs.serviceAccountIds.length > 1))
    return false;
  if (!deploy && (refs.configurationIds.length > 0 || refs.serviceAccountIds.length > 0))
    return false;
  const secretUse =
    deploy || selected.includes("model.generate") || selected.includes("repository.token.issue");
  if (!secretUse && refs.secretIds.length > 0) return false;
  if (
    (selected.includes("model.generate") || selected.includes("repository.token.issue")) &&
    refs.secretIds.length === 0
  )
    return false;
  if (
    (template === "agent-collaborator" || template === "audience-reader") &&
    !selected.includes("conversation.read")
  )
    return false;
  return true;
}

function decode<T>(
  value: unknown,
  bound: number,
  validate: (value: unknown) => boolean,
): ManualPolicyDecodeResultV1<T> {
  try {
    const copied = copyJson(value, new Set(), { nodes: 0 });
    if (new TextEncoder().encode(JSON.stringify(copied)).byteLength > bound || !validate(copied))
      return invalid;
    return Object.freeze({ kind: "valid", value: copied as T });
  } catch {
    return invalid;
  }
}

export function isManualPolicyInstallationIdV1(value: unknown): value is string {
  return id(value, "installation");
}

export function decodeManualPolicyTemplateV1(
  value: unknown,
): ManualPolicyDecodeResultV1<ManualPolicyTemplateSpecV1> {
  return decode(value, MANUAL_NATIVE_POLICY_LIMITS_V1.maxRegistrationBytes, specification);
}

export function decodeManualPolicyCommandV1(
  value: unknown,
): ManualPolicyDecodeResultV1<ManualPolicyCommandV1> {
  return decode(value, MANUAL_NATIVE_POLICY_LIMITS_V1.maxCommandBytes, (input) => {
    if (
      !record(input) ||
      !keys(input, [
        "schemaVersion",
        "operationRef",
        "expectedPolicyVersion",
        "change",
        "specification",
        "principalIds",
        "previousBindings",
      ]) ||
      input.schemaVersion !== 1 ||
      !ref(input.operationRef) ||
      !version(input.expectedPolicyVersion) ||
      !["create", "narrow", "withdraw"].includes(String(input.change)) ||
      !specification(input.specification) ||
      !list(
        input.principalIds,
        MANUAL_NATIVE_POLICY_LIMITS_V1.maxPrincipals,
        (entry) => ref(entry) && entry.startsWith("prn_"),
      ) ||
      !Array.isArray(input.previousBindings) ||
      input.previousBindings.length > MANUAL_NATIVE_POLICY_LIMITS_V1.maxBindings
    )
      return false;
    if (
      input.specification.template === "account-baseline"
        ? input.principalIds.length !== 0
        : input.principalIds.length === 0
    )
      return false;
    const references = input.specification.references;
    const grantsPerPrincipal =
      1 +
      references.configurationIds.length +
      references.serviceAccountIds.length +
      references.secretIds.length;
    if (input.principalIds.length * grantsPerPrincipal > MANUAL_NATIVE_POLICY_LIMITS_V1.maxBindings)
      return false;
    if (
      input.change === "create"
        ? input.previousBindings.length !== 0
        : input.previousBindings.length === 0
    )
      return false;
    const ids = new Set<string>();
    return input.previousBindings.every((entry) => {
      if (
        !record(entry) ||
        !keys(entry, ["bindingId", "roleId", "expectedRegistrationVersion"]) ||
        !ref(entry.bindingId) ||
        !ref(entry.roleId) ||
        !version(entry.expectedRegistrationVersion) ||
        ids.has(entry.bindingId)
      )
        return false;
      ids.add(entry.bindingId);
      return true;
    });
  });
}

export function decodeManualPolicyRegistrationV1(
  value: unknown,
): ManualPolicyDecodeResultV1<ManualPolicyRegistrationV1> {
  return decode(
    value,
    MANUAL_NATIVE_POLICY_LIMITS_V1.maxRegistrationBytes,
    (input) =>
      record(input) &&
      keys(input, [
        "schemaVersion",
        "version",
        "status",
        "installationId",
        "roleId",
        "specification",
      ]) &&
      input.schemaVersion === 1 &&
      version(input.version) &&
      (input.status === "enabled" || input.status === "disabled") &&
      id(input.installationId, "installation") &&
      ref(input.roleId) &&
      specification(input.specification),
  );
}

export function decodeManualPolicyReadV1(
  value: unknown,
): ManualPolicyDecodeResultV1<ManualPolicyReadV1> {
  return decode(
    value,
    1024,
    (input) =>
      record(input) &&
      keys(input, ["schemaVersion", "operationRef"]) &&
      input.schemaVersion === 1 &&
      ref(input.operationRef),
  );
}

/** Stable command equality only; the result is not authenticated or a persistence locator. */
export function canonicalManualPolicyCommandV1(value: unknown): string | undefined {
  const parsed = decodeManualPolicyCommandV1(value);
  if (parsed.kind !== "valid") return undefined;
  const canonical = (input: unknown): string => {
    if (Array.isArray(input)) return `[${input.map(canonical).sort().join(",")}]`;
    if (record(input))
      return `{${Object.keys(input)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`)
        .join(",")}}`;
    return JSON.stringify(input);
  };
  return canonical(parsed.value);
}

export function decodeManualPolicyResultV1(
  value: unknown,
): ManualPolicyDecodeResultV1<ManualPolicyResultV1> {
  return decode(value, MANUAL_NATIVE_POLICY_LIMITS_V1.maxResultBytes, (input) => {
    if (!record(input) || input.schemaVersion !== 1) return false;
    if (input.kind === "unknown")
      return keys(input, ["schemaVersion", "kind", "operationRef"]) && ref(input.operationRef);
    if (input.kind === "conflict" || input.kind === "denied" || input.kind === "unavailable")
      return keys(input, ["schemaVersion", "kind"]);
    if (
      input.kind !== "committed" ||
      !keys(input, [
        "schemaVersion",
        "kind",
        "operationRef",
        "commandDigest",
        "policyVersion",
        "roleIds",
        "registrations",
      ]) ||
      !ref(input.operationRef) ||
      typeof input.commandDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.commandDigest) ||
      !version(input.policyVersion) ||
      !list(input.roleIds, MANUAL_NATIVE_POLICY_LIMITS_V1.maxBindings, ref) ||
      input.roleIds.length === 0 ||
      !Array.isArray(input.registrations) ||
      input.registrations.length > MANUAL_NATIVE_POLICY_LIMITS_V1.maxBindings
    )
      return false;
    const roles = new Set(input.roleIds);
    const bindings = new Set<string>();
    return input.registrations.every((entry) => {
      if (
        !record(entry) ||
        !keys(entry, ["bindingId", "roleId", "version", "status"]) ||
        !ref(entry.bindingId) ||
        !ref(entry.roleId) ||
        !roles.has(entry.roleId) ||
        !version(entry.version) ||
        (entry.status !== "enabled" && entry.status !== "disabled") ||
        bindings.has(entry.bindingId)
      )
        return false;
      bindings.add(entry.bindingId);
      return true;
    });
  });
}
