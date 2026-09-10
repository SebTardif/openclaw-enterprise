import { createHash } from "node:crypto";
import { types } from "node:util";
import type { ServicePrincipal } from "@openclaw-enterprise/contracts/identity/identity";
import type { RepositoryTargetV2 } from "../credential-inventory-v1/repository-lease-v2.ts";
import type {
  WorkExecutionAssociationV2,
  WorkRepositoryProtocolVersionV2,
  WorkRepositoryPolicyArmV2,
  WorkOriginalOperationV2,
  WorkProfileRefV2,
} from "./work-authority-ports-v2.ts";

/** Administrator-managed repository business-use data. Original State authenticates
 * management, current acquisition and execution admission; this parser does not. */
export interface RepositoryWorkPolicyV2 {
  readonly schemaVersion: 2;
  readonly policyRef: string;
  readonly version: number;
  readonly status: "enabled" | "disabled";
  readonly scope: Readonly<{ installationId: string; namespaceId: string; agentId: string }>;
  readonly servicePrincipalId: string;
  readonly repository: Readonly<{
    target: RepositoryTargetV2;
    owner: string;
    name: string;
    profile: WorkProfileRefV2;
  }>;
  readonly executionProfile: WorkProfileRefV2;
  readonly operations: readonly ("metadata:read" | "git:read")[];
  readonly bounds: Readonly<{
    notBefore: string;
    notAfter: string;
    maximumWorkMilliseconds: number;
  }>;
}
/** These operands must be obtained from the original admitted execution and its
 * current State readset. Copying this record cannot enroll an execution. */
export interface RepositoryWorkPolicyUseV2 {
  readonly scope: WorkOriginalOperationV2["scope"];
  readonly service: ServicePrincipal;
  readonly execution: WorkExecutionAssociationV2;
  readonly admitted: Readonly<{
    policyRef: string;
    policyVersion: number;
    policyDigest: string;
    execution: WorkExecutionAssociationV2;
    originalHorizon: string;
  }>;
  readonly repository: RepositoryWorkPolicyV2["repository"];
  readonly operation: "metadata:read" | "git:read";
  readonly workBeganAt: string;
  readonly originalHorizon: string;
  readonly now: string;
}
export type RepositoryWorkPolicyDecisionV2 =
  | Readonly<{
      kind: "matches";
      policyRef: string;
      policyVersion: number;
      policyDigest: string;
      requiredPermissions: readonly ("metadata:read" | "contents:read")[];
      originalHorizon: string;
    }>
  | Readonly<{
      kind: "refused";
      reason:
        | "invalid"
        | "disabled"
        | "fresh-context-required"
        | "scope"
        | "service"
        | "repository"
        | "profile"
        | "operation"
        | "horizon";
    }>;
const MAX_TIME = 253402300799999;
function invalid(): never {
  throw new Error("Repository Work policy data is invalid.");
}
function snapshot(value: unknown): unknown {
  let nodes = 0;
  const seen = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 2048 || depth > 16) invalid();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.length > 4096) invalid();
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid();
      return value;
    }
    if (!value || typeof value !== "object" || types.isProxy(value) || seen.has(value)) invalid();
    seen.add(value);
    const array = Array.isArray(value),
      proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== null && proto !== Object.prototype) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors).filter((key) => !(array && key === "length"));
    if (keys.length > 128 || (array && keys.length !== value.length)) invalid();
    const result = array ? [] : {};
    for (const key of keys) {
      if (typeof key !== "string" || key === "__proto__") invalid();
      const d = descriptors[key];
      if (
        !d ||
        !("value" in d) ||
        !d.enumerable ||
        (array && (!/^(0|[1-9][0-9]*)$/.test(key) || +key >= value.length))
      )
        invalid();
      Object.defineProperty(result, key, { value: copy(d.value, depth + 1), enumerable: true });
    }
    seen.delete(value);
    return Object.freeze(result);
  };
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > 32768) invalid();
  return result;
}
function object(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")
  )
    invalid();
  return value as Record<string, unknown>;
}
const reference = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}(?![\s\S])/.test(value);
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
function instant(value: unknown): number {
  if (typeof value !== "string") invalid();
  const time = Date.parse(value);
  if (
    !Number.isSafeInteger(time) ||
    time < 0 ||
    time > MAX_TIME ||
    new Date(time).toISOString() !== value
  )
    invalid();
  return time;
}
function profile(value: unknown): void {
  const p = object(value, ["ref", "revision"]);
  if (!reference(p.ref) || !reference(p.revision)) invalid();
}
function target(value: unknown): void {
  const t = object(value, [
    "installationId",
    "githubHost",
    "appId",
    "githubInstallationId",
    "repositoryId",
  ]);
  if (
    !reference(t.installationId) ||
    t.githubHost !== "github.com" ||
    [t.appId, t.githubInstallationId, t.repositoryId].some(
      (x) => typeof x !== "string" || !/^[1-9][0-9]{0,19}(?![\s\S])/.test(x),
    )
  )
    invalid();
}
function repository(value: unknown): void {
  const r = object(value, ["target", "owner", "name", "profile"]);
  target(r.target);
  profile(r.profile);
  if (
    typeof r.owner !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?![\s\S])/.test(r.owner) ||
    typeof r.name !== "string" ||
    !/^[A-Za-z0-9._-]{1,100}(?![\s\S])/.test(r.name) ||
    r.name === "." ||
    r.name === ".."
  )
    invalid();
}
function execution(value: unknown): void {
  const e = object(value, [
    "attempt",
    "assignmentRef",
    "assignmentVersion",
    "executionIncarnationRef",
    "executionGeneration",
    "receiverRef",
    "protectedOriginRef",
    "executionProfile",
    "predecessor",
  ]);
  const attempt = object(e.attempt, [
    "installationRef",
    "namespaceRef",
    "agentRef",
    "conversationRef",
    "turnRef",
    "attemptRef",
    "reservationRef",
  ]);
  if (
    Object.values(attempt).some((v) => !reference(v)) ||
    [
      e.assignmentRef,
      e.assignmentVersion,
      e.executionIncarnationRef,
      e.executionGeneration,
      e.receiverRef,
      e.protectedOriginRef,
    ].some((v) => !reference(v))
  )
    invalid();
  profile(e.executionProfile);
  const p = e.predecessor as Record<string, unknown>;
  if (p?.kind === "none") object(p, ["kind"]);
  else if (p?.kind === "terminated-original") {
    object(p, [
      "kind",
      "attempt",
      "assignmentRef",
      "executionIncarnationRef",
      "terminationEvidenceRef",
    ]);
    const old = object(p.attempt, [
      "installationRef",
      "namespaceRef",
      "agentRef",
      "conversationRef",
      "turnRef",
      "attemptRef",
      "reservationRef",
    ]);
    if (
      Object.values(old).some((v) => !reference(v)) ||
      ![p.assignmentRef, p.executionIncarnationRef, p.terminationEvidenceRef].every(reference)
    )
      invalid();
  } else invalid();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const equal = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
export function parseRepositoryWorkPolicyV2(input: unknown): RepositoryWorkPolicyV2 | undefined {
  try {
    const p = object(snapshot(input), [
      "schemaVersion",
      "policyRef",
      "version",
      "status",
      "scope",
      "servicePrincipalId",
      "repository",
      "executionProfile",
      "operations",
      "bounds",
    ]);
    const scope = object(p.scope, ["installationId", "namespaceId", "agentId"]);
    if (
      p.schemaVersion !== 2 ||
      !reference(p.policyRef) ||
      !positive(p.version) ||
      (p.status !== "enabled" && p.status !== "disabled") ||
      !reference(p.servicePrincipalId) ||
      Object.values(scope).some((x) => !reference(x))
    )
      invalid();
    repository(p.repository);
    profile(p.executionProfile);
    if (
      (p.repository as RepositoryWorkPolicyV2["repository"]).target.installationId !==
      scope.installationId
    )
      invalid();
    if (
      !Array.isArray(p.operations) ||
      p.operations.length < 1 ||
      p.operations.length > 2 ||
      new Set(p.operations).size !== p.operations.length ||
      p.operations.some((x) => x !== "metadata:read" && x !== "git:read") ||
      !p.operations.includes("metadata:read")
    )
      invalid();
    const bounds = object(p.bounds, ["notBefore", "notAfter", "maximumWorkMilliseconds"]);
    if (
      instant(bounds.notBefore) >= instant(bounds.notAfter) ||
      !positive(bounds.maximumWorkMilliseconds) ||
      bounds.maximumWorkMilliseconds > MAX_TIME
    )
      invalid();
    return p as unknown as RepositoryWorkPolicyV2;
  } catch {
    return undefined;
  }
}
export function repositoryWorkPolicyDigestV2(input: RepositoryWorkPolicyV2): string {
  const parsed = parseRepositoryWorkPolicyV2(input);
  if (!parsed) invalid();
  return `sha256:${createHash("sha256").update(canonical(parsed)).digest("hex")}`;
}

/** Closed comparison only, after authentic original State acquisition. A matches
 * result never supplies private membership, a transaction or an allow callback. */
export function evaluateRepositoryWorkPolicyV2(
  input: unknown,
  useInput: RepositoryWorkPolicyUseV2,
): RepositoryWorkPolicyDecisionV2 {
  const refuse = (
    reason: Extract<RepositoryWorkPolicyDecisionV2, { kind: "refused" }>["reason"],
  ): RepositoryWorkPolicyDecisionV2 => ({ kind: "refused", reason });
  try {
    const policy = parseRepositoryWorkPolicyV2(input);
    if (!policy) return refuse("invalid");
    const use = snapshot(useInput) as RepositoryWorkPolicyUseV2;
    object(use, [
      "scope",
      "service",
      "execution",
      "admitted",
      "repository",
      "operation",
      "workBeganAt",
      "originalHorizon",
      "now",
    ]);
    object(use.scope, ["installationRef", "namespaceRef", "agentRef", "revisionRef"]);
    object(use.admitted, [
      "policyRef",
      "policyVersion",
      "policyDigest",
      "execution",
      "originalHorizon",
    ]);
    repository(use.repository);
    execution(use.execution);
    execution(use.admitted.execution);
    if (policy.status !== "enabled") return refuse("disabled");
    const digest = repositoryWorkPolicyDigestV2(policy);
    if (
      use.admitted.policyRef !== policy.policyRef ||
      use.admitted.policyVersion !== policy.version ||
      use.admitted.policyDigest !== digest ||
      !equal(use.admitted.execution, use.execution)
    )
      return refuse("fresh-context-required");
    if (
      use.scope.installationRef !== policy.scope.installationId ||
      use.scope.namespaceRef !== policy.scope.namespaceId ||
      use.scope.agentRef !== policy.scope.agentId ||
      !reference(use.scope.revisionRef) ||
      use.execution.attempt.installationRef !== use.scope.installationRef ||
      use.execution.attempt.namespaceRef !== use.scope.namespaceRef ||
      use.execution.attempt.agentRef !== use.scope.agentRef
    )
      return refuse("scope");
    if (
      use.service.kind !== "service_principal" ||
      use.service.id !== policy.servicePrincipalId ||
      use.service.namespaceId !== policy.scope.namespaceId ||
      use.service.agentId !== policy.scope.agentId
    )
      return refuse("service");
    if (!equal(use.repository, policy.repository)) return refuse("repository");
    if (!equal(use.execution.executionProfile, policy.executionProfile)) return refuse("profile");
    if (
      !policy.operations.includes(use.operation) ||
      (use.operation !== "metadata:read" && use.operation !== "git:read")
    )
      return refuse("operation");
    const now = instant(use.now),
      begin = instant(use.workBeganAt),
      end = instant(use.originalHorizon);
    if (
      now < instant(policy.bounds.notBefore) ||
      now >= instant(policy.bounds.notAfter) ||
      begin < instant(policy.bounds.notBefore) ||
      begin > now ||
      end <= now ||
      end > instant(policy.bounds.notAfter) ||
      end - begin > policy.bounds.maximumWorkMilliseconds ||
      end !== instant(use.admitted.originalHorizon)
    )
      return refuse("horizon");
    return Object.freeze({
      kind: "matches",
      policyRef: policy.policyRef,
      policyVersion: policy.version,
      policyDigest: digest,
      requiredPermissions: Object.freeze(
        use.operation === "git:read"
          ? (["contents:read", "metadata:read"] as const)
          : (["metadata:read"] as const),
      ),
      originalHorizon: use.originalHorizon,
    });
  } catch {
    return refuse("invalid");
  }
}

/** Exact protocol/use arm from the original State projection. No extra provider
 * permission, crossed version, or reordered Git permission tuple is accepted. */
export function repositoryWorkPolicyArmMatchesV2<V extends WorkRepositoryProtocolVersionV2>(
  version: V,
  input: unknown,
): input is WorkRepositoryPolicyArmV2<V> {
  try {
    const arm = snapshot(input);
    if (version === 2) return object(arm, ["permission"]).permission === "metadata:read";
    if (version !== 3) return false;
    const git = object(arm, ["repositoryOperation", "requiredPermissions"]);
    return (
      git.repositoryOperation === "git:read" &&
      equal(git.requiredPermissions, ["contents:read", "metadata:read"])
    );
  } catch {
    return false;
  }
}
/** Evaluate genuine policy data for the constructor-selected protocol. Parsing
 * the arm cannot replace its original State admission or held policy source. */
export function evaluateRepositoryWorkProtocolPolicyV2<V extends WorkRepositoryProtocolVersionV2>(
  input: unknown,
  use: RepositoryWorkPolicyUseV2,
  version: V,
  arm: unknown,
): RepositoryWorkPolicyDecisionV2 {
  if (
    !repositoryWorkPolicyArmMatchesV2(version, arm) ||
    use.operation !== (version === 3 ? "git:read" : "metadata:read")
  )
    return { kind: "refused", reason: "operation" };
  const result = evaluateRepositoryWorkPolicyV2(input, use);
  if (
    result.kind === "matches" &&
    !equal(
      result.requiredPermissions,
      version === 3 ? ["contents:read", "metadata:read"] : ["metadata:read"],
    )
  )
    return { kind: "refused", reason: "operation" };
  return result;
}
