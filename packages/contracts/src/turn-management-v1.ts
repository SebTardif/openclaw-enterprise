import { createHash } from "node:crypto";
import { Type, type Static, type TProperties } from "typebox";
import { Check } from "typebox/value";
import {
  ACCOUNT_AUTHORITY_LIMITS_V1,
  ACCOUNT_CURRENTNESS_PROFILE_V1,
  AccountVersionVectorSchemaV1,
  ResolveAccountRequestSchemaV1,
  decodeResolveAccountRequestV1,
  type AuthenticatedRequestHandleV1,
  type CurrentAccountAuthorityPortV1,
  type ExactAccountActionRequestV1,
} from "./account-authority-v1.ts";
import { ExactAttemptSchemaV1, parseCompletedContextV1 } from "./completed-context-v1.ts";
import {
  ExactCancellationOperationSchemaV1,
  parseTurnJournalV1,
  parseTurnJournalResultV1,
  type AttemptRecordV1,
  type CancellationResultV1,
  type CancellationStateV1,
  type JournalCommitResultV1,
  type JournalEvidenceProvenanceV1,
  type TurnJournalStoreV1,
  type ExactCancellationOperationV1,
} from "./turn-journal-v1.ts";

/** Bounded application definition hosted by an existing service. Values, hashes
 * and projections never authenticate, authorize disclosure, interrupt execution
 * or release a reservation. Real accepting owners remain mandatory. */
export const TURN_MANAGEMENT_PROFILE_V1 = "turn-management-v1" as const;
export const TURN_MANAGEMENT_LIMITS_V1 = Object.freeze({
  maxRequestBytes: ACCOUNT_AUTHORITY_LIMITS_V1.maxRequestBytes,
  maxResultBytes: ACCOUNT_AUTHORITY_LIMITS_V1.maxObservationBytes,
  maxInvocationMs: ACCOUNT_AUTHORITY_LIMITS_V1.maxDependencyCallMs,
  maxJsonDepth: 12,
  maxJsonNodes: 2048,
  maxConcurrentPerInstallation: 32,
  queuedInvocations: 0,
  automaticMutationRetries: 0,
  automaticReadbackAttempts: 0,
});
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const one = Type.Literal(1);
const ref = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
});
const instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const mode = Type.Enum(["own", "shared"]);
const cancellationOutcome = Type.Enum(["requested", "cancelled-before-dispatch"]);
const tag = <T extends string>(kind: T) => object({ kind: Type.Literal(kind) });

/** Caller expectations, never server-resolved ownership or authority. Compare
 * every field to the same original journal record. No normalization/truncation. */
export const TurnManagementLocatorSchemaV1 = object({
  attempt: ExactAttemptSchemaV1,
  receiptRef: ref,
  originalPrincipalRef: ref,
  callerPrincipalRef: ref,
  commonGrantRef: ref,
});
export type TurnManagementLocatorV1 = Immutable<Static<typeof TurnManagementLocatorSchemaV1>>;
/** Fresh read authority may inspect old operations without extending their deadline. */
export const TurnManagementInvocationSchemaV1 = object({
  account: ResolveAccountRequestSchemaV1,
  expectedCurrentVersions: AccountVersionVectorSchemaV1,
});
export type TurnManagementInvocationV1 = Immutable<Static<typeof TurnManagementInvocationSchemaV1>>;
/** Preknown before submission. transactionRef differs from operationRef/requestId.
 * The operation digest binds ALL this identity except itself, including original
 * start/deadline, mode, caller, exact target and the original version vector. */
export const TurnCancellationIdentitySchemaV1 = object({
  schemaVersion: one,
  locator: TurnManagementLocatorSchemaV1,
  mode,
  transactionRef: ref,
  startedAt: instant,
  deadline: instant,
  expectedVersions: AccountVersionVectorSchemaV1,
  // Preserve the original module's explicit value type. Its schema builder has a
  // widened TSchema return; runtime checks still use that exact original schema.
  operation: Type.Unsafe<ExactCancellationOperationV1>(ExactCancellationOperationSchemaV1),
});
export type TurnCancellationIdentityV1 = Immutable<Static<typeof TurnCancellationIdentitySchemaV1>>;
export const TurnStatusRequestSchemaV1 = object({
  schemaVersion: one,
  kind: Type.Literal("status"),
  invocation: TurnManagementInvocationSchemaV1,
  locator: TurnManagementLocatorSchemaV1,
});
export type TurnStatusRequestV1 = Immutable<Static<typeof TurnStatusRequestSchemaV1>>;
export const TurnCancellationRequestSchemaV1 = object({
  schemaVersion: one,
  kind: Type.Literal("request-cancellation"),
  invocation: TurnManagementInvocationSchemaV1,
  cancellation: TurnCancellationIdentitySchemaV1,
});
export type TurnCancellationRequestV1 = Immutable<Static<typeof TurnCancellationRequestSchemaV1>>;
export const TurnCancellationReadRequestSchemaV1 = object({
  schemaVersion: one,
  kind: Type.Literal("find-cancellation"),
  invocation: TurnManagementInvocationSchemaV1,
  cancellation: TurnCancellationIdentitySchemaV1,
});
export type TurnCancellationReadRequestV1 = Immutable<
  Static<typeof TurnCancellationReadRequestSchemaV1>
>;
export type TurnManagementRequestV1 =
  TurnStatusRequestV1 | TurnCancellationRequestV1 | TurnCancellationReadRequestV1;

/** No principal/resource/provider/internal transaction or existence detail. */
const failure = Type.Union([
  tag("not-visible"),
  tag("unavailable"),
  tag("overloaded"),
  tag("invalid-request"),
]);
export type TurnManagementFailureV1 = Immutable<Static<typeof failure>>;
const unsuccessful = Type.Enum(["failed", "interrupted", "outcome-unknown", "cancelled"]);
const statusOutcome = Type.Union([
  object({ kind: Type.Enum(["accepted-undispatched", "dispatch-intent", "consumed", "running"]) }),
  object({
    kind: unsuccessful,
    stage: Type.Enum(["before-dispatch", "dispatch", "execution", "checkpoint"]),
  }),
  object({ kind: Type.Literal("completed"), completion: Type.Literal("journal-published") }),
]);
/** Content-free status; completion names the journal's checkpoint publication,
 * without exporting payload or native IDs. No variant asserts physical stop/release. */
export const TurnStatusObservationSchemaV1 = object({
  schemaVersion: one,
  kind: Type.Literal("status"),
  locator: TurnManagementLocatorSchemaV1,
  observedAt: instant,
  recordVersion: version,
  dispatchEvidence: Type.Enum(["none", "intent", "consumed"]),
  outcome: statusOutcome,
});
export type TurnStatusObservationV1 = Immutable<Static<typeof TurnStatusObservationSchemaV1>>;
export const TurnStatusResultSchemaV1 = Type.Union([TurnStatusObservationSchemaV1, failure]);
export type TurnStatusResultV1 = Immutable<Static<typeof TurnStatusResultSchemaV1>>;
export const TurnCancellationResultSchemaV1 = Type.Union([
  object({
    schemaVersion: one,
    kind: Type.Literal("intent"),
    cancellation: TurnCancellationIdentitySchemaV1,
    disposition: Type.Enum(["recorded", "existing"]),
    outcome: cancellationOutcome,
    observedAt: instant,
  }),
  tag("commit-unknown"),
  tag("conflict"),
  tag("too-late"),
  failure,
]);
export type TurnCancellationResultV1 = Immutable<Static<typeof TurnCancellationResultSchemaV1>>;
export const TurnCancellationReadResultSchemaV1 = Type.Union([
  object({
    schemaVersion: one,
    kind: Type.Literal("found"),
    cancellation: TurnCancellationIdentitySchemaV1,
    outcome: cancellationOutcome,
    observedAt: instant,
  }),
  failure,
]);
export type TurnCancellationReadResultV1 = Immutable<
  Static<typeof TurnCancellationReadResultSchemaV1>
>;
export type TurnManagementResultV1 =
  TurnStatusResultV1 | TurnCancellationResultV1 | TurnCancellationReadResultV1;
export const TurnManagementSchemasV1 = Object.freeze({
  locator: TurnManagementLocatorSchemaV1,
  invocation: TurnManagementInvocationSchemaV1,
  cancellationIdentity: TurnCancellationIdentitySchemaV1,
  statusRequest: TurnStatusRequestSchemaV1,
  cancellationRequest: TurnCancellationRequestSchemaV1,
  cancellationReadRequest: TurnCancellationReadRequestSchemaV1,
  statusResult: TurnStatusResultSchemaV1,
  cancellationResult: TurnCancellationResultSchemaV1,
  cancellationReadResult: TurnCancellationReadResultSchemaV1,
});
export interface TurnManagementWireValuesV1 {
  locator: TurnManagementLocatorV1;
  invocation: TurnManagementInvocationV1;
  cancellationIdentity: TurnCancellationIdentityV1;
  statusRequest: TurnStatusRequestV1;
  cancellationRequest: TurnCancellationRequestV1;
  cancellationReadRequest: TurnCancellationReadRequestV1;
  statusResult: TurnStatusResultV1;
  cancellationResult: TurnCancellationResultV1;
  cancellationReadResult: TurnCancellationReadResultV1;
}
function invalid(): never {
  throw new TypeError("Invalid turn management value.");
}
function snapshot(input: unknown, maxBytes: number): unknown {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (
      ++nodes > TURN_MANAGEMENT_LIMITS_V1.maxJsonNodes ||
      depth > TURN_MANAGEMENT_LIMITS_V1.maxJsonDepth
    )
      invalid();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (
        value.length > maxBytes ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
      )
        invalid();
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid();
      return value;
    }
    if (typeof value !== "object" || seen.has(value)) invalid();
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length > 128 || (array && (value.length > 64 || keys.length !== value.length + 1)))
      invalid();
    seen.add(value);
    const out: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string") invalid();
      if (array && key === "length") continue;
      if (key === "__proto__" || key === "constructor" || key === "prototype") invalid();
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
      out[key] = visit(descriptor.value, depth + 1);
    }
    seen.delete(value);
    return array ? Object.keys(out).map((key) => out[key]) : out;
  };
  const result = visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maxBytes) invalid();
  return result;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key]))
      .join(",") +
    "}"
  );
}
function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
function validInstant(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) invalid();
  return time;
}
function interval(start: string, end: string): void {
  const duration = validInstant(end) - validInstant(start);
  if (duration <= 0 || duration > TURN_MANAGEMENT_LIMITS_V1.maxInvocationMs) invalid();
}
function locatorChecks(value: TurnManagementLocatorV1): void {
  parseCompletedContextV1("exactAttempt", value.attempt);
}
function invocationChecks(value: TurnManagementInvocationV1): void {
  if (decodeResolveAccountRequestV1(value.account).kind !== "valid") invalid();
}
function identityChecks(value: TurnCancellationIdentityV1, checkDigest = true): void {
  locatorChecks(value.locator);
  parseTurnJournalV1("cancellation", value.operation);
  interval(value.startedAt, value.deadline);
  if (
    !same(value.locator.attempt, value.operation.attempt) ||
    value.locator.callerPrincipalRef !== value.operation.requesterPrincipalRef ||
    value.locator.originalPrincipalRef !== value.operation.originalPrincipalRef ||
    value.transactionRef === value.operation.operationRef ||
    (value.mode === "own" &&
      value.locator.callerPrincipalRef !== value.locator.originalPrincipalRef)
  )
    invalid();
  if (checkDigest && value.operation.requestDigest !== digestIdentity(value)) invalid();
}
function digestIdentity(value: TurnCancellationIdentityV1): string {
  const { requestDigest: _digest, ...operation } = value.operation;
  return createHash("sha256")
    .update(TURN_MANAGEMENT_PROFILE_V1 + "\n" + canonical({ ...value, operation }), "utf8")
    .digest("hex");
}
/** Pure digest; supply a syntactically valid placeholder. Only that field is excluded. */
export function turnCancellationDigestV1(input: TurnCancellationIdentityV1): string {
  const value = snapshot(
    input,
    TURN_MANAGEMENT_LIMITS_V1.maxRequestBytes,
  ) as TurnCancellationIdentityV1;
  if (!Check(TurnCancellationIdentitySchemaV1, value)) invalid();
  identityChecks(value, false);
  return digestIdentity(value);
}
function requestChecks(value: TurnManagementRequestV1): void {
  invocationChecks(value.invocation);
  const locator = value.kind === "status" ? value.locator : value.cancellation.locator;
  locatorChecks(locator);
  if (value.invocation.account.installationId !== locator.attempt.installationRef) invalid();
  if (value.kind === "status") return;
  const identity = value.cancellation;
  identityChecks(identity);
  if (
    value.invocation.account.requestId === identity.transactionRef ||
    value.invocation.account.requestId === identity.operation.operationRef
  )
    invalid();
  if (
    value.kind === "request-cancellation" &&
    (!same(value.invocation.expectedCurrentVersions, identity.expectedVersions) ||
      validInstant(value.invocation.account.createdAt) < validInstant(identity.startedAt) ||
      validInstant(value.invocation.account.deadline) > validInstant(identity.deadline))
  )
    invalid();
}
function statusChecks(value: TurnStatusObservationV1): void {
  locatorChecks(value.locator);
  validInstant(value.observedAt);
  const kind = value.outcome.kind;
  if (kind === "accepted-undispatched" && value.dispatchEvidence !== "none") invalid();
  if (kind === "dispatch-intent" && value.dispatchEvidence !== "intent") invalid();
  if (["consumed", "running", "completed"].includes(kind) && value.dispatchEvidence !== "consumed")
    invalid();
  if ("stage" in value.outcome) {
    if (value.outcome.stage === "before-dispatch" && value.dispatchEvidence !== "none") invalid();
    if (value.outcome.stage === "dispatch" && value.dispatchEvidence === "none") invalid();
    if (
      ["execution", "checkpoint"].includes(value.outcome.stage) &&
      value.dispatchEvidence !== "consumed"
    )
      invalid();
  }
}
export function parseTurnManagementV1<K extends keyof TurnManagementWireValuesV1>(
  kind: K,
  input: unknown,
): TurnManagementWireValuesV1[K] {
  try {
    const schema = TurnManagementSchemasV1[kind];
    if (!schema) invalid();
    const value = snapshot(
      input,
      kind.endsWith("Result")
        ? TURN_MANAGEMENT_LIMITS_V1.maxResultBytes
        : TURN_MANAGEMENT_LIMITS_V1.maxRequestBytes,
    );
    if (!Check(schema, value)) invalid();
    if (kind === "locator") locatorChecks(value as TurnManagementLocatorV1);
    else if (kind === "invocation") invocationChecks(value as TurnManagementInvocationV1);
    else if (kind === "cancellationIdentity") identityChecks(value as TurnCancellationIdentityV1);
    else if (kind.endsWith("Request")) requestChecks(value as TurnManagementRequestV1);
    else {
      const result = value as TurnManagementResultV1;
      if (result.kind === "status") statusChecks(result);
      else if (result.kind === "intent" || result.kind === "found") {
        identityChecks(result.cancellation);
        validInstant(result.observedAt);
        if (result.observedAt < result.cancellation.startedAt) invalid();
      }
    }
    return freeze(value) as TurnManagementWireValuesV1[K];
  } catch {
    return invalid();
  }
}
/** Bounded serialized input; duplicate members (including escaped aliases) reject. */
export function parseTurnManagementJsonV1<K extends keyof TurnManagementWireValuesV1>(
  kind: K,
  input: string,
): TurnManagementWireValuesV1[K] {
  const limit = kind.endsWith("Result")
    ? TURN_MANAGEMENT_LIMITS_V1.maxResultBytes
    : TURN_MANAGEMENT_LIMITS_V1.maxRequestBytes;
  if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > limit) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return invalid();
  }
  const stack: Array<Set<string> | null> = [];
  const tokens = input.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) ?? [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token?.startsWith('"') && tokens[i + 1] === ":") {
      const members = stack[stack.length - 1];
      const key = JSON.parse(token) as string;
      if (!members || members.has(key)) invalid();
      members.add(key);
    }
  }
  return parseTurnManagementV1(kind, parsed);
}
/** Pure operand composition. Resolve the exact locator in the authorized view,
 * compare the actual authenticated subject, then use the real selected-IAM port.
 * Its observation still requires the accepting guard before disclosure/write. */
export function turnManagementAccountRequestV1(
  request: TurnManagementRequestV1,
): ExactAccountActionRequestV1 {
  const value =
    request.kind === "status"
      ? parseTurnManagementV1("statusRequest", request)
      : request.kind === "request-cancellation"
        ? parseTurnManagementV1("cancellationRequest", request)
        : parseTurnManagementV1("cancellationReadRequest", request);
  const locator = value.kind === "status" ? value.locator : value.cancellation.locator;
  const target = {
    namespaceId: locator.attempt.namespaceRef,
    agentId: locator.attempt.agentRef,
    conversationRef: locator.attempt.conversationRef,
    commonGrantRef: locator.commonGrantRef,
  };
  return freeze({
    ...value.invocation.account,
    currentnessProfile: ACCOUNT_CURRENTNESS_PROFILE_V1,
    expectedVersions: value.invocation.expectedCurrentVersions,
    operation:
      value.kind === "status"
        ? { kind: "conversation.read", target }
        : {
            kind: value.cancellation.mode === "own" ? "turn.cancel.own" : "turn.cancel.shared",
            target: { ...target, turnRef: locator.attempt.turnRef },
          },
  });
}
/** Correlation only: does not establish the caller's actual identity or read grant. */
export function turnManagementRecordMatchesV1(
  locatorInput: TurnManagementLocatorV1,
  recordInput: AttemptRecordV1,
): boolean {
  const locator = parseTurnManagementV1("locator", locatorInput);
  const record = parseTurnJournalV1("attempt", recordInput);
  return (
    same(locator.attempt, record.binding.attempt) &&
    locator.receiptRef === record.binding.identity.receipt.receiptRef &&
    locator.originalPrincipalRef === record.binding.identity.principalRef &&
    locator.commonGrantRef === record.binding.identity.commonGrantRef
  );
}
/** Semantic equality against the same canonical journal operation, including its
 * digest. Key insertion order is not part of the selected identity. */
export function turnManagementCancellationOperationMatchesV1(
  identityInput: TurnCancellationIdentityV1,
  operation: ExactCancellationOperationV1,
): boolean {
  const identity = parseTurnManagementV1("cancellationIdentity", identityInput);
  return same(identity.operation, parseTurnJournalV1("cancellation", operation));
}
/** Protected content-free projection, never disclosure permission. */
export function projectTurnStatusV1(
  locator: TurnManagementLocatorV1,
  recordInput: AttemptRecordV1,
  observedAt: string,
): TurnStatusObservationV1 {
  const record = parseTurnJournalV1("attempt", recordInput);
  if (!turnManagementRecordMatchesV1(locator, record)) invalid();
  const outcome = record.outcome;
  const before =
    outcome.kind === "accepted-undispatched" ||
    ("stage" in outcome && outcome.stage === "before-dispatch");
  const projected =
    outcome.kind === "completed"
      ? { kind: outcome.kind, completion: "journal-published" }
      : "stage" in outcome
        ? { kind: outcome.kind, stage: outcome.stage }
        : { kind: outcome.kind };
  return parseTurnManagementV1("statusResult", {
    schemaVersion: 1,
    kind: "status",
    locator,
    observedAt,
    recordVersion: record.version,
    dispatchEvidence: record.consumption !== null ? "consumed" : before ? "none" : "intent",
    outcome: projected,
  }) as TurnStatusObservationV1;
}
const cancellationCommitCarrier = Type.Union([
  object({ kind: Type.Literal("committed"), value: Type.Unknown() }),
  object({ kind: Type.Literal("commit-unknown"), transactionRef: ref }),
  tag("unavailable"),
]);
/** Supply the real OUTERMOST commit result. UoW-local success has the wrong type.
 * Exceptions/disconnect after submission map to commit-unknown; never auto-retry. */
export function projectTurnCancellationCommitV1(
  identityInput: TurnCancellationIdentityV1,
  commit: JournalCommitResultV1<CancellationResultV1>,
  observedAt: string,
): TurnCancellationResultV1 {
  const identity = parseTurnManagementV1("cancellationIdentity", identityInput);
  const raw = snapshot(commit, TURN_MANAGEMENT_LIMITS_V1.maxResultBytes);
  if (!Check(cancellationCommitCarrier, raw)) invalid();
  const outer = raw as JournalCommitResultV1<CancellationResultV1>;
  if (outer.kind === "commit-unknown") {
    if (outer.transactionRef !== identity.transactionRef) invalid();
    return { kind: "commit-unknown" };
  }
  if (outer.kind === "unavailable") return { kind: "unavailable" };
  if (outer.kind !== "committed") invalid();
  const value = parseTurnJournalResultV1("cancellation", outer.value);
  if (value.kind === "denied") return { kind: "not-visible" };
  if (value.kind === "recorded" || value.kind === "existing") {
    if (!same(identity.operation, value.operation)) invalid();
    return parseTurnManagementV1("cancellationResult", {
      schemaVersion: 1,
      kind: "intent",
      cancellation: identity,
      disposition: value.kind,
      outcome: value.outcome,
      observedAt,
    });
  }
  return parseTurnManagementV1("cancellationResult", value);
}
export function projectTurnCancellationReadV1(
  identityInput: TurnCancellationIdentityV1,
  state: CancellationStateV1,
  observedAt: string,
): TurnCancellationReadResultV1 {
  const identity = parseTurnManagementV1("cancellationIdentity", identityInput);
  const value = parseTurnJournalResultV1("cancellationState", state);
  if (value.kind === "absent" || value.kind === "denied") return { kind: "not-visible" };
  if (value.kind === "unavailable") return { kind: "unavailable" };
  if (!same(identity.operation, value.operation)) invalid();
  return parseTurnManagementV1("cancellationReadResult", {
    schemaVersion: 1,
    kind: "found",
    cancellation: identity,
    outcome: value.outcome,
    observedAt,
  });
}
export function turnManagementResultMatchesRequestV1(
  request: TurnManagementRequestV1,
  result: TurnManagementResultV1,
): boolean {
  if (request.kind === "status") {
    const req = parseTurnManagementV1("statusRequest", request),
      res = parseTurnManagementV1("statusResult", result);
    return (
      res.kind !== "status" ||
      (same(req.locator, res.locator) &&
        res.observedAt >= req.invocation.account.createdAt &&
        res.observedAt <= req.invocation.account.deadline)
    );
  }
  const req =
    request.kind === "request-cancellation"
      ? parseTurnManagementV1("cancellationRequest", request)
      : parseTurnManagementV1("cancellationReadRequest", request);
  const res =
    request.kind === "request-cancellation"
      ? parseTurnManagementV1("cancellationResult", result)
      : parseTurnManagementV1("cancellationReadResult", result);
  return (
    (res.kind !== "intent" && res.kind !== "found") ||
    (same(req.cancellation, res.cancellation) &&
      res.observedAt >= req.invocation.account.createdAt &&
      res.observedAt <= req.invocation.account.deadline)
  );
}
/** Existing dependencies only; no authority or second journal constructor.
 * Runtime interruption and native delivery remain their original effect owners. */
export type TurnManagementDependenciesV1 = Readonly<{
  authority: CurrentAccountAuthorityPortV1;
  journal: TurnJournalStoreV1;
  cancellation: Pick<JournalEvidenceProvenanceV1, "authorizeCancellation" | "inspectCancellation">;
}>;
/** Implemented by the existing accepting service owner. Authentication handles
 * come from its real invocation factory, never JSON. Each call resolves original
 * receipt/context/attempt + actual caller, uses current selected IAM/owning view,
 * and rechecks its real guard after awaits and before disclosure/write.
 * Cancellation inspects real provenance in the sole journal transaction. Shared
 * cancel uses requester's explicit grant independently of initiator revocation.
 *
 * At most 32 active invocations per installation across this surface, no queue.
 * Reject overflow before journal submission. Propagate deadlines/cancellation,
 * retaining losing-work settlement until the actual operation finishes. Neither
 * abort nor timeout releases a possible writer or establishes transaction rollback. */
export interface TurnManagementApplicationV1 {
  status(
    authenticated: AuthenticatedRequestHandleV1,
    request: TurnStatusRequestV1,
    signal: AbortSignal,
  ): Promise<TurnStatusResultV1>;
  requestCancellation(
    authenticated: AuthenticatedRequestHandleV1,
    request: TurnCancellationRequestV1,
    signal: AbortSignal,
  ): Promise<TurnCancellationResultV1>;
  /** Fresh current original-purpose authority, exact status only even after the
   * mutation deadline; no result gives a new mutation, initiation or send permit. */
  findCancellation(
    authenticated: AuthenticatedRequestHandleV1,
    request: TurnCancellationReadRequestV1,
    signal: AbortSignal,
  ): Promise<TurnCancellationReadResultV1>;
}
