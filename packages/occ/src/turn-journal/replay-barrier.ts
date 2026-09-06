import { createHash } from "node:crypto";
import {
  parseCompletedContextV1,
  type ContextKeyV1,
} from "@openclaw-enterprise/contracts/completed-context-v1";
import {
  AgentId,
  ChannelInstallationId,
  InstallationId,
  NamespaceId,
} from "@openclaw-enterprise/contracts/api/common";
import {
  comparePurgeProgressV1,
  encodeRetirementPurgeV1,
  parseRetirementPurgeV1,
  type PurgeManifestV1,
  type PurgeRetiredIdentityV1,
} from "@openclaw-enterprise/contracts/retirement-purge-manifest-v1";
import {
  encodePurgeCallableV1,
  parsePurgeCallableV1,
  type PurgeObservationInputObservationV1,
  type PurgeObservationReceiptV1,
  type PurgeRetirementRecordV1,
} from "@openclaw-enterprise/contracts/retirement-purge-journal-v1";
import {
  JournalAdmissionIdentitySchemaV1,
  type HostedChannelEnvelopeV1,
} from "@openclaw-enterprise/contracts/turn-journal-v1";
import { isChannelBindingReference } from "@openclaw-enterprise/contracts/channel-bindings";

/** Permanent replay obligations are reserved in the sole journal before creation.
 * This arithmetic is data validation, not activation or capacity ownership proof.
 */
export const REPLAY_BARRIER_CAPACITY_PER_INSTALLATION = 10_000;

/** A full installation still permits preservation and retirement of existing rows.
 * Call this only to decide whether a new permanent obligation may be reserved.
 */
export function replayBarrierCapacityAvailable(reservedRecords: number): boolean {
  return (
    Number.isSafeInteger(reservedRecords) &&
    !Object.is(reservedRecords, -0) &&
    reservedRecords >= 0 &&
    reservedRecords < REPLAY_BARRIER_CAPACITY_PER_INSTALLATION
  );
}

/** A retained association with the original native route. The supplied routeKey
 * is never recomputed with another algorithm or inferred from a channel mapping.
 * This value does not authenticate the association or activate its generation.
 */
export type ReplayRouteProjectionV1 = Readonly<{
  routeKey: string;
  native: Pick<
    HostedChannelEnvelopeV1,
    | "installationRef"
    | "channelInstallationRef"
    | "platform"
    | "providerTenantRef"
    | "recipientAppRef"
    | "nativeConversation"
  >;
}>;

/** Reservation identity only. Complete activation lineage additionally needs the
 * actual original activation and measured-clock observations, currently absent.
 */
export type ReplayRetiredTargetV1 = Readonly<{
  schemaVersion: 1;
  scope: PurgeManifestV1["scope"];
  channelInstallationRef: string;
  identity: PurgeRetiredIdentityV1;
  route: ReplayRouteProjectionV1 | null;
}>;

/** The permanent obligation is reserved before activation generations exist.
 * creationOperationRef is the original preknown creation operation, not a clock,
 * installation generation, route version or activation authority claim.
 */
export type ReplayReservationTargetV1 = Readonly<{
  schemaVersion: 1;
  scope: Readonly<{ installationId: string }> | PurgeManifestV1["scope"];
  channelInstallationRef: string;
  creationOperationRef: string;
  subject:
    | Readonly<{ kind: "channel-installation" }>
    | Readonly<{ kind: "context"; context: ContextKeyV1; creationRef: string }>
    | Readonly<{ kind: "route"; route: ReplayRouteProjectionV1 }>;
}>;

function invalid(): never {
  throw new TypeError("Invalid replay journal value.");
}

/** Read bounded plain own data only; never invoke user supplied accessors. */
function object(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length || keys.some((key) => typeof key !== "string")) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function identifier(value: unknown, schema: unknown): string {
  if (typeof value !== "string" || schema === null || typeof schema !== "object") invalid();
  const pattern = Object.getOwnPropertyDescriptor(schema, "pattern");
  if (
    !pattern ||
    !("value" in pattern) ||
    typeof pattern.value !== "string" ||
    !new RegExp(pattern.value).test(value)
  )
    invalid();
  return value;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseRoute(
  input: unknown,
  scope: PurgeManifestV1["scope"],
  channelInstallationRef: string,
): ReplayRouteProjectionV1 {
  const projection = object(input, ["routeKey", "native"]);
  const native = object(projection.native, [
    "installationRef",
    "channelInstallationRef",
    "platform",
    "providerTenantRef",
    "recipientAppRef",
    "nativeConversation",
  ]);
  const conversation = object(native.nativeConversation, ["channelRef", "scope", "rootThreadRef"]);
  // This content-free metadata projection uses the supported channel binding
  // datum domain: exact Unicode scalars, no controls, at most 1024 UTF-8 bytes.
  // It neither normalizes native references nor replaces the original producer's
  // full envelope verification, route-key computation or authentication.
  const nativeReference = (value: unknown): string => {
    if (!isChannelBindingReference(value)) invalid();
    return value;
  };
  const platform = native.platform;
  const nativeScope = conversation.scope;
  if (platform !== "slack" && platform !== "msteams") invalid();
  if (nativeScope !== "slack-private-channel" && nativeScope !== "teams-standard-channel")
    invalid();
  const parsedNative: ReplayRouteProjectionV1["native"] = {
    installationRef: identifier(native.installationRef, InstallationId),
    channelInstallationRef: identifier(native.channelInstallationRef, ChannelInstallationId),
    platform,
    providerTenantRef: nativeReference(native.providerTenantRef),
    recipientAppRef: nativeReference(native.recipientAppRef),
    nativeConversation: {
      channelRef: nativeReference(conversation.channelRef),
      scope: nativeScope,
      rootThreadRef: nativeReference(conversation.rootThreadRef),
    },
  };
  const routeKey = identifier(
    projection.routeKey,
    JournalAdmissionIdentitySchemaV1.properties.routeKey,
  );
  if (
    parsedNative.installationRef !== scope.installationId ||
    parsedNative.channelInstallationRef !== channelInstallationRef ||
    (parsedNative.platform === "slack"
      ? parsedNative.nativeConversation.scope !== "slack-private-channel"
      : parsedNative.nativeConversation.scope !== "teams-standard-channel")
  )
    invalid();
  return { routeKey, native: parsedNative };
}

export function parseReplayRetiredTargetV1(input: unknown): ReplayRetiredTargetV1 {
  try {
    const value = object(input, [
      "schemaVersion",
      "scope",
      "channelInstallationRef",
      "identity",
      "route",
    ]);
    if (value.schemaVersion !== 1) invalid();
    const rawScope = object(value.scope, ["installationId", "namespaceId", "agentId"]);
    const scope = {
      installationId: identifier(rawScope.installationId, InstallationId),
      namespaceId: identifier(rawScope.namespaceId, NamespaceId),
      agentId: identifier(rawScope.agentId, AgentId),
    };
    const channelInstallationRef = identifier(value.channelInstallationRef, ChannelInstallationId);
    const identity = parseRetirementPurgeV1("retiredIdentity", value.identity);
    let route: ReplayRouteProjectionV1 | null = null;
    if (identity.kind === "route") {
      route = parseRoute(value.route, scope, channelInstallationRef);
    } else if (value.route !== null) invalid();
    if (
      identity.kind === "context" &&
      (identity.context.installationRef !== scope.installationId ||
        identity.context.namespaceRef !== scope.namespaceId ||
        identity.context.agentRef !== scope.agentId)
    )
      invalid();
    if (
      identity.kind === "channel-installation" &&
      identity.channelInstallationRef !== channelInstallationRef
    )
      invalid();
    const target: ReplayRetiredTargetV1 = {
      schemaVersion: 1,
      scope,
      channelInstallationRef,
      identity,
      route,
    };
    if (Buffer.byteLength(canonical(target)) > 16_384) invalid();
    return freeze(target);
  } catch {
    return invalid();
  }
}

export function parseReplayReservationTargetV1(input: unknown): ReplayReservationTargetV1 {
  try {
    const value = object(input, [
      "schemaVersion",
      "scope",
      "channelInstallationRef",
      "creationOperationRef",
      "subject",
    ]);
    if (value.schemaVersion !== 1) invalid();
    const descriptor =
      value.subject !== null && typeof value.subject === "object"
        ? Object.getOwnPropertyDescriptor(value.subject, "kind")
        : undefined;
    if (!descriptor || !("value" in descriptor)) invalid();
    const installationOnly = descriptor.value === "channel-installation";
    const rawScope = object(
      value.scope,
      installationOnly ? ["installationId"] : ["installationId", "namespaceId", "agentId"],
    );
    const scope: ReplayReservationTargetV1["scope"] = installationOnly
      ? { installationId: identifier(rawScope.installationId, InstallationId) }
      : {
          installationId: identifier(rawScope.installationId, InstallationId),
          namespaceId: identifier(rawScope.namespaceId, NamespaceId),
          agentId: identifier(rawScope.agentId, AgentId),
        };
    const channelInstallationRef = identifier(value.channelInstallationRef, ChannelInstallationId);
    const ref = (v: unknown): string => {
      if (
        typeof v !== "string" ||
        !/^[A-Za-z0-9._:/-]{1,200}$/.test(v) ||
        /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(v)
      )
        invalid();
      return v;
    };
    const creationOperationRef = ref(value.creationOperationRef);
    let subject: ReplayReservationTargetV1["subject"];
    if (descriptor.value === "channel-installation") {
      object(value.subject, ["kind"]);
      subject = { kind: "channel-installation" };
    } else if (descriptor.value === "context") {
      const raw = object(value.subject, ["kind", "context", "creationRef"]);
      const context = parseCompletedContextV1("contextKey", raw.context);
      if (!("namespaceId" in scope)) invalid();
      if (
        context.installationRef !== scope.installationId ||
        context.namespaceRef !== scope.namespaceId ||
        context.agentRef !== scope.agentId
      )
        invalid();
      const creationRef = ref(raw.creationRef);
      if (creationRef.includes("://")) invalid();
      subject = { kind: "context", context, creationRef };
    } else if (descriptor.value === "route") {
      const raw = object(value.subject, ["kind", "route"]);
      if (!("namespaceId" in scope)) invalid();
      subject = { kind: "route", route: parseRoute(raw.route, scope, channelInstallationRef) };
    } else return invalid();
    const target: ReplayReservationTargetV1 = {
      schemaVersion: 1,
      scope,
      channelInstallationRef,
      creationOperationRef,
      subject,
    };
    if (Buffer.byteLength(canonical(target)) > 16_384) invalid();
    return freeze(target);
  } catch {
    return invalid();
  }
}

export function encodeReplayRetiredTargetV1(value: ReplayRetiredTargetV1): string {
  return canonical(parseReplayRetiredTargetV1(value));
}

export function digestReplayRetiredTargetV1(value: ReplayRetiredTargetV1): string {
  return createHash("sha256").update(encodeReplayRetiredTargetV1(value)).digest("hex");
}

/** Exact data association only; generation and current activation provenance
 * still have to come from the original owner before this may be persisted.
 */
export function replayReservationCanBindTargetV1(
  reservation: ReplayReservationTargetV1,
  activated: ReplayRetiredTargetV1,
): boolean {
  const pending = parseReplayReservationTargetV1(reservation);
  const target = parseReplayRetiredTargetV1(activated);
  if (
    pending.scope.installationId !== target.scope.installationId ||
    ("namespaceId" in pending.scope && canonical(pending.scope) !== canonical(target.scope)) ||
    pending.channelInstallationRef !== target.channelInstallationRef ||
    pending.subject.kind !== target.identity.kind
  )
    return false;
  if (pending.subject.kind === "context" && target.identity.kind === "context")
    return (
      pending.subject.creationRef === target.identity.creationRef &&
      canonical(pending.subject.context) === canonical(target.identity.context)
    );
  if (pending.subject.kind === "route")
    return canonical(pending.subject.route) === canonical(target.route);
  return pending.subject.kind === "channel-installation";
}

export function encodeReplayReservationTargetV1(value: ReplayReservationTargetV1): string {
  return canonical(parseReplayReservationTargetV1(value));
}

/** An index key only; SQL readback also compares the complete retained value. */
export function digestReplayReservationTargetV1(value: ReplayReservationTargetV1): string {
  return createHash("sha256").update(encodeReplayReservationTargetV1(value)).digest("hex");
}

export function replayReservationTargetsMatchV1(
  a: ReplayReservationTargetV1,
  b: ReplayReservationTargetV1,
): boolean {
  return encodeReplayReservationTargetV1(a) === encodeReplayReservationTargetV1(b);
}

export function decodeReplayRetirementRecordV1(value: unknown): PurgeRetirementRecordV1 {
  return parsePurgeCallableV1("record", value);
}

export function decodeReplayObservationReceiptV1(value: unknown): PurgeObservationReceiptV1 {
  return parsePurgeCallableV1("receipt", value);
}

/** Expected CAS version is intentionally absent from immutable receipt identity.
 * An exact original observation remains the same after other progress advances.
 */
export function replayObservationReceiptMatchesV1(
  receipt: PurgeObservationReceiptV1,
  input: PurgeObservationInputObservationV1,
): boolean {
  const r = parsePurgeCallableV1("receipt", receipt);
  const i = parsePurgeCallableV1("observationInputObservation", input);
  return (
    r.originalTransactionRef === i.originalTransactionRef &&
    encodePurgeCallableV1("binding", r.binding) === encodePurgeCallableV1("binding", i.binding) &&
    encodeRetirementPurgeV1("observation", r.observation) ===
      encodeRetirementPurgeV1("observation", i.observation)
  );
}

/** Pure next-record calculation. Callers first inspect current provenance and
 * look up immutable receipts; this function grants no observation authority.
 */
export function advanceReplayObservationV1(
  record: PurgeRetirementRecordV1,
  input: PurgeObservationInputObservationV1,
):
  | Readonly<{
      kind: "advance";
      record: PurgeRetirementRecordV1;
      receipt: PurgeObservationReceiptV1;
    }>
  | Readonly<{ kind: "conflict" }> {
  const before = parsePurgeCallableV1("record", record);
  const i = parsePurgeCallableV1("observationInputObservation", input);
  if (
    encodePurgeCallableV1("binding", before.binding) !==
      encodePurgeCallableV1("binding", i.binding) ||
    before.progress.recordVersion !== i.expectedRecordVersion ||
    before.progress.recordVersion === Number.MAX_SAFE_INTEGER
  )
    return { kind: "conflict" };
  const stores = before.progress.stores.map((entry) =>
    entry.entry.deletionOperationRef === i.observation.deletionOperationRef
      ? { entry: entry.entry, state: { kind: i.observation.outcome, observation: i.observation } }
      : entry,
  );
  let progress;
  try {
    progress = parseRetirementPurgeV1("progress", {
      ...before.progress,
      recordVersion: before.progress.recordVersion + 1,
      stores,
      state: stores.every((entry) => entry.state.kind === "observed-absent")
        ? "live-objects-absent"
        : "purge-incomplete",
    });
  } catch {
    return { kind: "conflict" };
  }
  if (comparePurgeProgressV1(before.progress, progress, i.expectedRecordVersion).kind !== "advance")
    return { kind: "conflict" };
  return freeze({
    kind: "advance" as const,
    record: parsePurgeCallableV1("record", { ...before, progress }),
    receipt: parsePurgeCallableV1("receipt", {
      schemaVersion: 1,
      binding: i.binding,
      originalTransactionRef: i.originalTransactionRef,
      observation: i.observation,
      recordedAtRecordVersion: progress.recordVersion,
    }),
  });
}
