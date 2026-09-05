import type { AuditEvent, ResourceRef } from "./index.ts";

/** A projection of the audit envelope; this version does not change AuditEvent v1. */
export const SECURITY_EVENT_SCHEMA = "openclaw.security-event/v1" as const;
export const SECURITY_EVENT_POLICY = Object.freeze({
  maxEventBytes: 8192,
  maxReferenceInputBytes: 256,
  maxDepth: 6,
  spoolMaxEvents: 10000,
  spoolMaxBytes: 64 * 1024 * 1024,
  appendDeadlineMs: 2000,
  exportBatchMaxEvents: 100,
  exportMaxAttempts: 5,
  exportRetryDelaysMs: Object.freeze([1000, 2000, 4000, 8000]),
  retentionDays: 30,
  deletionSweepHours: 24,
  maxReaderGrants: 64,
  maxContextsPerGrant: 128,
});

const SOURCES = ["api", "occ", "gateway", "identity", "credential", "runtime"] as const;
const CATEGORIES = [
  "management",
  "access",
  "credential",
  "identity",
  "lifecycle",
  "dispatch",
  "confinement",
] as const;
const ACTIONS = [
  "create",
  "read",
  "update",
  "delete",
  "deploy",
  "operate",
  "administer",
  "issue",
  "use",
  "register",
  "rotate",
  "replace",
  "expire",
  "disable",
  "revoke",
  "stop",
  "admit",
  "cancel",
] as const;
const DECISIONS = ["allowed", "denied", "not_applicable", "unknown"] as const;
const PHASES = ["requested", "accepted", "observed", "unknown"] as const;
const RESULTS = [
  "pending",
  "completed",
  "denied",
  "failed",
  "queued",
  "busy",
  "duplicate",
  "interrupted",
  "revoked",
  "expired",
  "unknown",
] as const;
const REASONS = [
  "Authorized",
  "AccessDenied",
  "IdentityUnresolved",
  "WrongScope",
  "StaleGeneration",
  "IdentityRegistered",
  "IdentityRotated",
  "IdentityReplaced",
  "PolicyRejected",
  "CredentialAllowed",
  "CredentialDenied",
  "RequestReceived",
  "DurablyAccepted",
  "Serving",
  "Disabled",
  "StopUnconfirmed",
  "Stopped",
  "ProviderConfirmed",
  "Expired",
  "RuntimeUnreachable",
  "Queued",
  "Busy",
  "Duplicate",
  "Interrupted",
  "AuditUnavailable",
  "ResourceLimitExceeded",
  "Unknown",
] as const;
const RESOURCE_KINDS = [
  "installation",
  "namespace",
  "configuration",
  "service_account",
  "secret",
  "agent",
  "agent_revision",
] as const;
const REFERENCE_KINDS = [
  "event",
  "installation",
  "namespace",
  "resource",
  "principal",
  "workload",
  "agent",
  "revision",
  "assignment",
  "request",
  "decision",
  "conversation",
  "channel_event",
  "turn",
  "attempt",
  "grant",
  "policy",
  "registration",
] as const;
type ReferenceKind = (typeof REFERENCE_KINDS)[number];
type State = "unresolved" | "not_applicable";
type Human =
  { readonly state: "verified"; readonly principalId: string } | { readonly state: State };
type Workload =
  | {
      readonly state: "verified";
      readonly principalId: string;
      readonly assignmentId: string;
      readonly agentId: string;
      readonly revisionId: string;
      readonly generation: number;
    }
  | { readonly state: State };

export interface SecurityEventV1 extends Pick<
  AuditEvent,
  | "id"
  | "installationId"
  | "namespaceId"
  | "occurredAt"
  | "requestId"
  | "admissionDecisionId"
  | "resource"
> {
  readonly schema: typeof SECURITY_EVENT_SCHEMA;
  readonly schemaVersion: 1;
  readonly receivedAt: string;
  readonly source: (typeof SOURCES)[number];
  readonly category: (typeof CATEGORIES)[number];
  readonly action: (typeof ACTIONS)[number];
  readonly decision: (typeof DECISIONS)[number];
  readonly phase: (typeof PHASES)[number];
  readonly result: (typeof RESULTS)[number];
  readonly reasonCode: (typeof REASONS)[number];
  readonly human: Human;
  readonly workload: Workload;
  readonly correlation: {
    readonly agentId?: string;
    readonly revisionId?: string;
    readonly conversationId?: string;
    readonly channelEventId?: string;
    readonly turnId?: string;
    readonly attemptId?: string;
    readonly grantId?: string;
    readonly policyId?: string;
    readonly registrationId?: string;
  };
  readonly credential?: {
    readonly destination: "model" | "github";
    readonly mode: "mediated" | "native" | "history_isolated";
    readonly expiresAt?: string;
  };
  readonly previousRuntime?: {
    readonly assignmentId: string;
    readonly generation: number;
  };
  readonly observation?: {
    readonly observedAt: string;
    readonly source:
      "controller" | "runtime" | "identity_provider" | "credential_provider" | "gateway";
  };
}

/**
 * Supply facts from the authenticated producer, never from a request body. The
 * resolver must look up a preapproved opaque UUID under this exact scope. It
 * must not manufacture a reference from arbitrary caller labels or secret bytes.
 */
export interface SecurityEventProjectionContext extends Omit<
  SecurityEventV1,
  "schema" | "id" | "occurredAt" | "requestId" | "admissionDecisionId"
> {
  readonly resolveReference: (kind: ReferenceKind, value: string) => string | undefined;
}

export class SecurityEventContractError extends Error {
  readonly code = "SECURITY_EVENT_REJECTED";
  constructor() {
    super("Security event rejected by contract.");
    this.name = "SecurityEventContractError";
  }
}
function reject(): never {
  throw new SecurityEventContractError();
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) reject();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject();
  return value as Record<string, unknown>;
}
function field(value: unknown, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object(value), name);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) reject();
  return descriptor.value;
}
function exact(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const record = object(value);
  const names = Reflect.ownKeys(record);
  if (names.length > required.length + optional.length) reject();
  for (const name of names) {
    if (typeof name !== "string" || (!required.includes(name) && !optional.includes(name)))
      reject();
    field(record, name);
  }
  for (const name of required) if (field(record, name) === undefined) reject();
  return record;
}
function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) reject();
  return value as T;
}
function reference(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  )
    reject();
  return value;
}
function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 24 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    reject();
  return value;
}
function optionalReferences(value: unknown, names: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of names)
    if (field(value, name) !== undefined) result[name] = reference(field(value, name));
  return result;
}
function attribution(value: unknown, workload: false): Human;
function attribution(value: unknown, workload: true): Workload;
function attribution(value: unknown, workload: boolean): Human | Workload {
  const state = enumeration(field(value, "state"), ["verified", "unresolved", "not_applicable"]);
  if (state !== "verified") {
    exact(value, ["state"]);
    return { state };
  }
  if (!workload) {
    exact(value, ["state", "principalId"]);
    return { state, principalId: reference(field(value, "principalId")) };
  }
  exact(value, ["state", "principalId", "assignmentId", "agentId", "revisionId", "generation"]);
  const generation = field(value, "generation");
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1)
    reject();
  return {
    state,
    principalId: reference(field(value, "principalId")),
    assignmentId: reference(field(value, "assignmentId")),
    agentId: reference(field(value, "agentId")),
    revisionId: reference(field(value, "revisionId")),
    generation,
  };
}
function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const CORRELATION = [
  "agentId",
  "revisionId",
  "conversationId",
  "channelEventId",
  "turnId",
  "attemptId",
  "grantId",
  "policyId",
  "registrationId",
] as const;

function parse(input: unknown): SecurityEventV1 {
  exact(
    input,
    [
      "schema",
      "schemaVersion",
      "id",
      "installationId",
      "occurredAt",
      "receivedAt",
      "source",
      "category",
      "action",
      "resource",
      "decision",
      "phase",
      "result",
      "reasonCode",
      "human",
      "workload",
      "correlation",
    ],
    [
      "namespaceId",
      "requestId",
      "admissionDecisionId",
      "credential",
      "observation",
      "previousRuntime",
    ],
  );
  if (field(input, "schema") !== SECURITY_EVENT_SCHEMA || field(input, "schemaVersion") !== 1)
    reject();
  const resource = exact(field(input, "resource"), ["kind", "id"], ["namespaceId"]);
  const correlation = exact(field(input, "correlation"), [], CORRELATION);
  const event: SecurityEventV1 = {
    schema: SECURITY_EVENT_SCHEMA,
    schemaVersion: 1,
    id: reference(field(input, "id")),
    installationId: reference(field(input, "installationId")),
    ...optionalReferences(input, ["namespaceId", "requestId", "admissionDecisionId"]),
    occurredAt: timestamp(field(input, "occurredAt")),
    receivedAt: timestamp(field(input, "receivedAt")),
    source: enumeration(field(input, "source"), SOURCES),
    category: enumeration(field(input, "category"), CATEGORIES),
    action: enumeration(field(input, "action"), ACTIONS),
    decision: enumeration(field(input, "decision"), DECISIONS),
    phase: enumeration(field(input, "phase"), PHASES),
    result: enumeration(field(input, "result"), RESULTS),
    reasonCode: enumeration(field(input, "reasonCode"), REASONS),
    resource: {
      kind: enumeration(field(resource, "kind"), RESOURCE_KINDS),
      id: reference(field(resource, "id")),
      ...optionalReferences(resource, ["namespaceId"]),
    },
    human: attribution(field(input, "human"), false),
    workload: attribution(field(input, "workload"), true),
    correlation: optionalReferences(correlation, CORRELATION),
    ...(field(input, "credential") === undefined
      ? {}
      : { credential: parseCredential(field(input, "credential")) }),
    ...(field(input, "previousRuntime") === undefined
      ? {}
      : { previousRuntime: parsePreviousRuntime(field(input, "previousRuntime")) }),
    ...(field(input, "observation") === undefined
      ? {}
      : { observation: parseObservation(field(input, "observation")) }),
  };
  if (event.namespaceId !== event.resource.namespaceId) reject();
  if (event.resource.kind !== "installation" && event.namespaceId === undefined) reject();
  if (
    event.resource.kind === "installation" &&
    (event.namespaceId !== undefined || event.resource.id !== event.installationId)
  )
    reject();
  if (event.resource.kind === "namespace" && event.resource.id !== event.namespaceId) reject();
  if (Date.parse(event.receivedAt) < Date.parse(event.occurredAt)) reject();
  if (
    event.workload.state === "verified" &&
    (event.namespaceId === undefined ||
      event.correlation.agentId !== event.workload.agentId ||
      event.correlation.revisionId !== event.workload.revisionId)
  )
    reject();
  if (
    event.action === "replace" &&
    event.category === "identity" &&
    event.result === "completed" &&
    (event.previousRuntime === undefined || event.workload.state !== "verified")
  )
    reject();
  if (
    event.previousRuntime !== undefined &&
    (event.category !== "identity" ||
      event.action !== "replace" ||
      event.workload.state !== "verified" ||
      event.previousRuntime.assignmentId === event.workload.assignmentId ||
      event.previousRuntime.generation >= event.workload.generation)
  )
    reject();
  if (event.correlation.revisionId !== undefined && event.correlation.agentId === undefined)
    reject();
  if (
    (event.correlation.conversationId !== undefined ||
      event.correlation.turnId !== undefined ||
      event.correlation.channelEventId !== undefined) &&
    (event.namespaceId === undefined ||
      event.correlation.agentId === undefined ||
      event.correlation.conversationId === undefined)
  )
    reject();
  if (
    event.category === "dispatch" &&
    (event.correlation.conversationId === undefined ||
      event.correlation.channelEventId === undefined)
  )
    reject();
  if ((event.category === "credential") !== (event.credential !== undefined)) reject();
  if (
    event.category === "credential" &&
    event.decision === "allowed" &&
    (event.workload.state !== "verified" ||
      event.correlation.grantId === undefined ||
      event.correlation.policyId === undefined)
  )
    reject();
  if (event.decision === "allowed" && event.human.state === "unresolved") reject();
  if (
    event.category === "dispatch" &&
    event.decision === "allowed" &&
    event.human.state !== "verified"
  )
    reject();
  if (
    event.decision === "allowed" &&
    event.human.state !== "verified" &&
    event.workload.state !== "verified"
  )
    reject();
  if (event.phase === "unknown" && event.result !== "unknown") reject();
  if (event.phase === "requested" && event.result !== "pending") reject();
  if (event.phase === "accepted" && !["pending", "queued", "duplicate"].includes(event.result))
    reject();
  if (
    event.phase === "observed" &&
    (event.observation === undefined || ["pending", "queued", "unknown"].includes(event.result))
  )
    reject();
  if (event.phase !== "observed" && event.observation !== undefined) reject();
  if (event.decision === "denied" && (event.phase !== "observed" || event.result !== "denied"))
    reject();
  if (event.result === "denied" && event.decision !== "denied") reject();
  if (
    event.observation !== undefined &&
    (Date.parse(event.observation.observedAt) < Date.parse(event.occurredAt) ||
      Date.parse(event.observation.observedAt) > Date.parse(event.receivedAt))
  )
    reject();
  if (
    [
      "Stopped",
      "ProviderConfirmed",
      "Expired",
      "Serving",
      "Disabled",
      "IdentityRegistered",
      "IdentityRotated",
      "IdentityReplaced",
    ].includes(event.reasonCode) &&
    event.phase !== "observed"
  )
    reject();
  if (event.reasonCode === "Stopped" && (event.action !== "stop" || event.result !== "completed"))
    reject();
  if (
    event.reasonCode === "StopUnconfirmed" &&
    (event.action !== "stop" || event.phase !== "unknown")
  )
    reject();
  if (event.result === "revoked" && event.action !== "revoke") reject();
  if (event.action === "revoke" && event.result === "completed") reject();
  if (event.credential?.destination === "model" && event.credential.mode !== "mediated") reject();
  if (
    event.action === "revoke" &&
    event.result === "revoked" &&
    (event.reasonCode !== "ProviderConfirmed" ||
      event.observation?.source !== "credential_provider")
  )
    reject();
  if (
    event.action === "revoke" &&
    event.result === "expired" &&
    (event.reasonCode !== "Expired" ||
      event.credential?.expiresAt === undefined ||
      Date.parse(event.credential.expiresAt) > Date.parse(event.observation?.observedAt ?? ""))
  )
    reject();
  if (
    event.action === "stop" &&
    event.result === "completed" &&
    (event.reasonCode !== "Stopped" || event.observation?.source !== "runtime")
  )
    reject();
  if (
    new TextEncoder().encode(JSON.stringify(event)).byteLength > SECURITY_EVENT_POLICY.maxEventBytes
  )
    reject();
  return freeze(event);
}
function parsePreviousRuntime(value: unknown): NonNullable<SecurityEventV1["previousRuntime"]> {
  exact(value, ["assignmentId", "generation"]);
  const generation = field(value, "generation");
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1)
    reject();
  return { assignmentId: reference(field(value, "assignmentId")), generation };
}
function parseCredential(value: unknown): NonNullable<SecurityEventV1["credential"]> {
  exact(value, ["destination", "mode"], ["expiresAt"]);
  return {
    destination: enumeration(field(value, "destination"), ["model", "github"]),
    mode: enumeration(field(value, "mode"), ["mediated", "native", "history_isolated"]),
    ...(field(value, "expiresAt") === undefined
      ? {}
      : { expiresAt: timestamp(field(value, "expiresAt")) }),
  };
}
function parseObservation(value: unknown): NonNullable<SecurityEventV1["observation"]> {
  exact(value, ["observedAt", "source"]);
  return {
    observedAt: timestamp(field(value, "observedAt")),
    source: enumeration(field(value, "source"), [
      "controller",
      "runtime",
      "identity_provider",
      "credential_provider",
      "gateway",
    ]),
  };
}
/** Rejects unknown keys/versions. Errors contain no input values or causes. */
export function parseSecurityEvent(input: unknown): SecurityEventV1 {
  try {
    return parse(input);
  } catch {
    return reject();
  }
}
/** Enforce the byte bound before decoding any imported JSON. */
export function parseSecurityEventJson(input: string): SecurityEventV1 {
  try {
    if (
      typeof input !== "string" ||
      input.length > SECURITY_EVENT_POLICY.maxEventBytes ||
      new TextEncoder().encode(input).byteLength > SECURITY_EVENT_POLICY.maxEventBytes
    )
      reject();
    return parse(JSON.parse(input));
  } catch {
    return reject();
  }
}
export function serializeSecurityEvent(input: unknown): string {
  return JSON.stringify(parseSecurityEvent(input));
}

/** No actor, details, reason text, URL, exception or payload is copied from audit. */
export function projectSecurityEvent(
  audit: AuditEvent,
  context: SecurityEventProjectionContext,
): SecurityEventV1 {
  try {
    if (field(audit, "schemaVersion") !== 1 || context.schemaVersion !== 1) reject();
    enumeration(field(audit, "kind"), ["bootstrap", "mutation", "authorization_denial"]);
    enumeration(field(audit, "outcome"), ["success", "denied", "failure"]);
    const map = (kind: ReferenceKind, value: unknown): string => {
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        new TextEncoder().encode(value).byteLength > SECURITY_EVENT_POLICY.maxReferenceInputBytes
      )
        reject();
      return reference(context.resolveReference(kind, value));
    };
    const resource = field(audit, "resource");
    if (
      field(audit, "installationId") !== context.installationId ||
      field(audit, "namespaceId") !== context.namespaceId ||
      field(resource, "namespaceId") !== context.namespaceId ||
      field(resource, "kind") !== context.resource.kind ||
      field(resource, "id") !== context.resource.id ||
      context.resource.namespaceId !== context.namespaceId
    )
      reject();
    if (field(audit, "outcome") === "denied" && context.decision !== "denied") reject();
    const human = context.human;
    const workload = context.workload;
    if (human.state === "verified" && field(audit, "actorId") !== human.principalId) reject();
    if (
      human.state === "not_applicable" &&
      workload.state === "verified" &&
      field(audit, "actorId") !== workload.principalId
    )
      reject();
    const mapOptional = (input: unknown, key: string, kind: ReferenceKind) =>
      field(input, key) === undefined ? {} : { [key]: map(kind, field(input, key)) };
    const correlation: Record<string, string> = {};
    const kinds: readonly ReferenceKind[] = [
      "agent",
      "revision",
      "conversation",
      "channel_event",
      "turn",
      "attempt",
      "grant",
      "policy",
      "registration",
    ];
    for (let index = 0; index < CORRELATION.length; index++) {
      const key = CORRELATION[index]!;
      if (field(context.correlation, key) !== undefined)
        correlation[key] = map(kinds[index]!, field(context.correlation, key));
    }
    const mappedResource: ResourceRef = {
      kind: context.resource.kind,
      id: map("resource", context.resource.id),
      ...mapOptional(context, "namespaceId", "namespace"),
    };
    return parse({
      schema: SECURITY_EVENT_SCHEMA,
      schemaVersion: 1,
      id: map("event", field(audit, "id")),
      installationId: map("installation", context.installationId),
      ...mapOptional(context, "namespaceId", "namespace"),
      occurredAt: field(audit, "occurredAt"),
      receivedAt: context.receivedAt,
      ...mapOptional(audit, "requestId", "request"),
      ...mapOptional(audit, "admissionDecisionId", "decision"),
      source: context.source,
      category: context.category,
      action: context.action,
      resource: mappedResource,
      decision: context.decision,
      phase: context.phase,
      result: context.result,
      reasonCode: context.reasonCode,
      human:
        human.state === "verified"
          ? { state: human.state, principalId: map("principal", human.principalId) }
          : { state: human.state },
      workload:
        workload.state === "verified"
          ? {
              state: workload.state,
              principalId: map("workload", workload.principalId),
              assignmentId: map("assignment", workload.assignmentId),
              agentId: map("agent", workload.agentId),
              revisionId: map("revision", workload.revisionId),
              generation: workload.generation,
            }
          : { state: workload.state },
      correlation,
      ...(context.credential === undefined ? {} : { credential: context.credential }),
      ...(context.previousRuntime === undefined
        ? {}
        : {
            previousRuntime: {
              assignmentId: map("assignment", context.previousRuntime.assignmentId),
              generation: context.previousRuntime.generation,
            },
          }),
      ...(context.observation === undefined ? {} : { observation: context.observation }),
    });
  } catch {
    return reject();
  }
}

/** A contract predicate over already authenticated, server-owned reader grants. */
function hasGrant(
  input: unknown,
  access: unknown,
  requiredRole: "audit_reader" | "audit_retention_admin",
): boolean {
  try {
    const event = parse(input);
    exact(access, ["principalId", "installationId", "grants"]);
    reference(field(access, "principalId"));
    if (reference(field(access, "installationId")) !== event.installationId) return false;
    const grants = field(access, "grants");
    if (!Array.isArray(grants) || grants.length > SECURITY_EVENT_POLICY.maxReaderGrants)
      return false;
    let allowed = false;
    for (const grant of grants) {
      exact(grant, ["role", "contextIds"], ["namespaceId"]);
      const role = enumeration(field(grant, "role"), ["audit_reader", "audit_retention_admin"]);
      const namespaceId = field(grant, "namespaceId");
      if (namespaceId !== undefined) reference(namespaceId);
      const contexts = field(grant, "contextIds");
      if (!Array.isArray(contexts) || contexts.length > SECURITY_EVENT_POLICY.maxContextsPerGrant)
        return false;
      for (const context of contexts) reference(context);
      if (
        role === requiredRole &&
        namespaceId === event.namespaceId &&
        (event.correlation.conversationId === undefined ||
          contexts.includes(event.correlation.conversationId))
      )
        allowed = true;
    }
    return allowed;
  } catch {
    return false;
  }
}

export function canReadSecurityEvent(input: unknown, access: unknown): boolean {
  return hasGrant(input, access, "audit_reader");
}
/** This predicate does not execute deletion or authenticate its grant input. */
export function canDeleteExpiredSecurityEvent(
  input: unknown,
  access: unknown,
  now: string,
): boolean {
  return hasGrant(input, access, "audit_retention_admin") && isSecurityEventExpired(input, now);
}

/** Retention eligibility is not deletion authorization or proof of erasure. */
export function isSecurityEventExpired(input: unknown, now: string): boolean {
  try {
    const event = parse(input);
    return (
      Date.parse(timestamp(now)) >=
      Date.parse(event.receivedAt) + SECURITY_EVENT_POLICY.retentionDays * 86400000
    );
  } catch {
    return false;
  }
}
