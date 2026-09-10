import { types as nodeTypes } from "node:util";
import { type TSchema } from "typebox";
import { Check } from "typebox/value";
import { immutableCopy, sha256Hex } from "@openclaw-enterprise/utils";
import {
  CREDENTIAL_STORAGE_LIMITS_V1,
  parseCredentialStorageV1,
  canonicalCredentialStorageRequestV1,
  type CredentialStorageSchemaNameV1,
  type OutstandingTokenRecordV1,
} from "./credential-storage-v1.ts";
import {
  REPOSITORY_PREPARATION_LIMITS_V1,
  RepositoryPreparationSchemasV1,
  type RepositoryPreparationSchemaNameV1,
  type RepositoryPreparationValueV1,
  type PreparationAffectedTokenQueryV1,
  type PreparationCheckoutRequestV1,
  type PreparationReceiptDiagnosticV1,
  type RuntimeEffectClockV1,
} from "./repository-preparation-v1.ts";

// These bounded plain-data, clock and inventory checks preserve the existing
// credential V1 invariants. Preparation adds an explicit purpose domain; it never
// reconstructs a fake original turn in order to invoke the old owner or codec.
function plainJson(
  value: unknown,
  stack = new Set<object>(),
  depth = 0,
  budget = { nodes: 0 },
): boolean {
  if (depth > CREDENTIAL_STORAGE_LIMITS_V1.maxJsonDepth || ++budget.nodes > 32_768) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 1024;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || nodeTypes.isProxy(value) || stack.has(value)) return false;
  const array = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
    return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 256 || (array && (value.length > 128 || keys.length !== value.length + 1)))
    return false;
  stack.add(value);
  for (const key of keys) {
    if (typeof key !== "string") return false;
    if (array && key === "length") continue;
    if (
      array &&
      (!Number.isSafeInteger(Number(key)) ||
        Number(key) < 0 ||
        Number(key) >= value.length ||
        String(Number(key)) !== key)
    )
      return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      !plainJson(descriptor.value, stack, depth + 1, budget)
    )
      return false;
  }
  stack.delete(value);
  return true;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function equal(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
function semanticBytes(input: Record<string, unknown>): string {
  // Only per-call correlation/bounds can change on exact read/reconciliation.
  // Original scope, audit, service, method, operation and every CAS remain bound.
  const { requestId: _request, createdAt: _created, deadline: _deadline, ...intent } = input;
  return canonical(intent);
}
function time(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}
function duration(start: unknown, end: unknown, max: number): boolean {
  const elapsed = time(end) - time(start);
  return elapsed > 0 && elapsed <= max;
}
function validTimes(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(validTimes);
  if (!record(value)) return true;
  for (const [key, item] of Object.entries(value)) {
    if (key === "turnNotAfter" && item === null) continue;
    if (
      /(?:At|NotAfter)$/.test(key) ||
      key === "deadline" ||
      key === "validUntil" ||
      key === "notAfter"
    ) {
      if (
        typeof item !== "string" ||
        !Number.isFinite(time(item)) ||
        new Date(item).toISOString() !== item
      )
        return false;
    } else if (!validTimes(item)) return false;
  }
  return true;
}
/** Checks representation and internal consistency only. Current record lookup,
 * authenticated provenance and guarded acceptance remain real owner duties.
 */
function relationships(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(relationships);
  if (!record(value)) return true;
  if (!Object.values(value).every(relationships) || !preparationRelationships(value)) return false;
  if (
    value.method !== undefined &&
    !duration(value.createdAt, value.deadline, CREDENTIAL_STORAGE_LIMITS_V1.maxCallMs)
  )
    return false;
  if (
    value.turnNotAfter !== undefined &&
    value.turnNotAfter !== null &&
    !duration(value.committedDispatchAt, value.turnNotAfter, Number.MAX_SAFE_INTEGER)
  )
    return false;
  if (value.scope !== undefined) {
    for (const key of [
      "original",
      "profile",
      "binding",
      "expectedBinding",
      "replacement",
      "filter",
    ]) {
      const nested = value[key];
      if (record(nested) && nested.scope !== undefined && !equal(value.scope, nested.scope))
        return false;
    }
  }
  if (record(value.profile)) {
    for (const key of ["binding", "expectedBinding", "replacement"]) {
      const binding = value[key];
      if (
        record(binding) &&
        (binding.providerId !== value.profile.providerId ||
          !equal(binding.account, value.profile.account))
      )
        return false;
    }
    const grant = value.grant;
    if (
      record(grant) &&
      Array.isArray(grant.repositoryIds) &&
      (value.profile.kind !== "repository" ||
        grant.providerInstallationRef !== value.profile.providerInstallationRef ||
        !equal(grant.permissionProfile, value.profile.permissionProfile))
    )
      return false;
  }
  if (record(value.modelBinding)) {
    if (
      !equal(value.scope, value.modelBinding.scope) ||
      !equal(value.profile, value.modelBinding.profile) ||
      !equal(value.binding, value.modelBinding.binding)
    )
      return false;
  }
  if (
    value.custody === "external-protected-owner" &&
    record(value.profile) &&
    record(value.setup)
  ) {
    const expectedClass = value.setup.kind === "api-key-import" ? "api-key" : value.setup.kind;
    if (value.profile.credentialClass !== expectedClass) return false;
  }
  if (value.repositoryIds !== undefined) {
    const ids = value.repositoryIds as string[];
    if (ids.some((id, i) => i > 0 && ids[i - 1]! >= id)) return false;
    const permissions = value.permissions as { name: string; access: string }[];
    if (
      permissions.some(
        (p, i) =>
          (p.name === "metadata" && p.access !== "read") ||
          (i > 0 && permissions[i - 1]!.name >= p.name),
      )
    )
      return false;
  }
  if (value.purpose !== undefined && record(value.profile)) {
    if ((value.purpose === "model-use") !== (value.profile.kind === "model")) return false;
  }
  if (
    value.method === "reserveIssuance" &&
    record(value.profile) &&
    value.profile.kind !== "repository"
  )
    return false;
  if (
    value.method === "deliverRecordedToken" &&
    record(value.profile) &&
    (value.profile.kind !== "repository" || value.profile.mode !== "native")
  )
    return false;
  if (
    value.method === "rotateBinding" &&
    record(value.expectedBinding) &&
    record(value.replacement)
  ) {
    const previous = value.expectedBinding;
    const replacement = value.replacement;
    if (
      previous.bindingRef !== replacement.bindingRef ||
      previous.secretId !== replacement.secretId ||
      previous.driverId !== replacement.driverId ||
      !equal(previous.scope, replacement.scope) ||
      replacement.bindingVersion !== Number(previous.bindingVersion) + 1 ||
      Number(replacement.secretVersion) <= Number(previous.secretVersion)
    )
      return false;
  }
  if (value.comparedAt !== undefined && record(value.original) && record(value.profile)) {
    if (
      !equal(value.original.scope, value.profile.scope) ||
      time(value.comparedAt) < time(value.original.committedDispatchAt) ||
      !duration(value.comparedAt, value.startNotAfter, 5000) ||
      time(value.startNotAfter) > time(value.leaseNotAfter) ||
      (value.original.turnNotAfter !== null &&
        time(value.leaseNotAfter) > time(value.original.turnNotAfter))
    )
      return false;
    if ((value.effect === "model-use") !== (value.profile.kind === "model")) return false;
    if (value.effect === "deliver-token" && value.profile.mode !== "native") return false;
  }
  if (
    value.claimedAt !== undefined &&
    !duration(
      value.claimedAt,
      value.claimNotAfter,
      CREDENTIAL_STORAGE_LIMITS_V1.revocationClaimLeaseMs,
    )
  )
    return false;
  if (
    (value.outcome === "expired" ||
      value.outcome === "unknown-expired" ||
      value.state === "expired" ||
      value.kind === "expired") &&
    record(value.expiry)
  ) {
    if (
      value.expiry.kind !== "provider-expiry" ||
      time(value.observedAt) - Number(value.uncertaintyMs) < time(value.expiry.expiresAt)
    )
      return false;
  }
  if (
    value.observedAt !== undefined &&
    record(value.expiry) &&
    value.expiry.kind === "provider-expiry" &&
    time(value.expiry.observedAt) > time(value.observedAt)
  )
    return false;
  if (record(value.issuance) && record(value.target)) {
    if (
      value.target.issuanceOperationRef !== value.issuance.operationRef ||
      value.target.intentDigest !== `sha256:${sha256Hex(semanticBytes(value.issuance))}` ||
      Number(value.invalidationVersion) < Number(value.issuance.invalidationVersion)
    )
      return false;
    if (
      value.state === "outstanding" &&
      record(value.expiry) &&
      record(value.returnedScope) &&
      record(value.revocation) &&
      record(value.delivery)
    ) {
      if (
        (value.expiry.kind === "expiry-unproven" ||
          value.returnedScope.status !== "matches-request") &&
        value.disposition !== "mitigation-only"
      )
        return false;
      if (
        value.expiry.kind === "provider-expiry" &&
        value.revocation.state === "expired" &&
        record(value.revocation.expiry) &&
        value.expiry.expiresAt !== value.revocation.expiry.expiresAt
      )
        return false;
      if (value.revocation.state !== "unrequested" && value.disposition !== "mitigation-only")
        return false;
      if (
        Number(value.invalidationVersion) > Number(value.issuance.invalidationVersion) &&
        value.disposition !== "mitigation-only"
      )
        return false;
      if (
        value.delivery.state !== "not-delivered" &&
        value.issuance.profile !== undefined &&
        record(value.issuance.profile) &&
        value.issuance.profile.mode !== "native"
      )
        return false;
    }
  }
  if (record(value.receipt) && record(value.record)) {
    if (value.receipt.inventoryVersion !== value.record.inventoryVersion) return false;
    if (
      value.kind === "reserved" &&
      (!record(value.record.issuance) ||
        !record(value.record.target) ||
        value.receipt.operationRef !== value.record.issuance.operationRef ||
        value.receipt.intentDigest !== value.record.target.intentDigest)
    )
      return false;
  }
  if (value.kind === "claimed" && record(value.record)) {
    const revocationValue = value.record.revocation;
    if (
      value.record.state !== "outstanding" ||
      !record(revocationValue) ||
      revocationValue.state !== "claimed" ||
      revocationValue.claimRef !== value.claimRef ||
      revocationValue.version !== value.claimVersion ||
      revocationValue.claimNotAfter !== value.claimNotAfter ||
      value.record.disposition !== "mitigation-only"
    )
      return false;
    if (
      (revocationValue.priorOutcome === "none") !==
      (value.nextAction === "attempt-exact-revocation")
    )
      return false;
  }
  if (
    value.method === "listAffected" &&
    record(value.cursor) &&
    value.cursor.filterDigest !== `sha256:${sha256Hex(canonical(value.filter))}`
  )
    return false;
  if (value.kind === "page") {
    if (!duration(value.createdAt, value.expiresAt, CREDENTIAL_STORAGE_LIMITS_V1.snapshotMaxAgeMs))
      return false;
    if (value.filterDigest !== `sha256:${sha256Hex(canonical(value.filter))}`) return false;
    if (
      record(value.next) &&
      (value.next.snapshotRef !== value.snapshotRef ||
        value.next.snapshotVersion !== value.snapshotVersion ||
        value.next.filterDigest !== value.filterDigest)
    )
      return false;
    const rows = value.records as OutstandingTokenRecordV1[];
    if (new Set(rows.map((row) => row.target.recordRef)).size !== rows.length) return false;
    if (
      rows.some(
        (row) =>
          !record(value.filter) ||
          !equal(row.issuance.scope, value.filter.scope) ||
          row.issuance.binding.bindingRef !== value.filter.bindingRef,
      )
    )
      return false;
    const knownLive = rows.filter(
      (row) =>
        row.state === "outstanding" &&
        row.revocation.state !== "confirmed" &&
        row.revocation.state !== "expired",
    ).length;
    const unknownLive = rows.filter(
      (row) => row.state === "reserved" || row.state === "mint-unknown",
    ).length;
    if (
      Number(value.outstandingCount) < knownLive ||
      Number(value.unresolvedIssuanceCount) < unknownLive ||
      Number(value.outstandingCount) + Number(value.unresolvedIssuanceCount) >
        CREDENTIAL_STORAGE_LIMITS_V1.maxOutstandingPerAgent
    )
      return false;
    if (
      record(value.next) &&
      (rows.length === 0 || value.next.afterRecordRef !== rows[rows.length - 1]!.target.recordRef)
    )
      return false;
  }
  return true;
}

function canonicalClockConsistent(value: unknown): boolean {
  if (!record(value)) return false;
  const source = time(value.sourceObservedAt);
  const received = time(value.receivedAt);
  const until = time(value.validUntil);
  return (
    source <= received + Number(value.uncertaintyMs) &&
    until >= source &&
    until <= source + REPOSITORY_PREPARATION_LIMITS_V1.observationMaxAgeMs
  );
}
function preparationRelationships(value: Record<string, unknown>): boolean {
  const limits = REPOSITORY_PREPARATION_LIMITS_V1;
  if (
    value.sourceObservedAt !== undefined &&
    value.receivedAt !== undefined &&
    value.validUntil !== undefined &&
    !canonicalClockConsistent(value)
  )
    return false;
  if (value.purpose === "candidate-repository-preparation" && value.preparationRef !== undefined) {
    if (
      !record(value.gate) ||
      !record(value.gate.responsibility) ||
      !record(value.profile) ||
      !record(value.staging) ||
      value.gate.mode !== "running" ||
      value.gate.responsibility.kind !== "preparation" ||
      !equal(value.scope, value.gate.scope) ||
      !equal(value.scope, value.profile.scope) ||
      !equal(value.scope, value.staging.scope) ||
      !duration(value.createdAt, value.notAfter, limits.preparationMaxMs) ||
      new Date(String(value.notAfter)).toISOString() !== value.notAfter
    )
      return false;
  }
  if (record(value.preparation)) {
    const subject = value.preparation;
    if (value.scope !== undefined && !equal(value.scope, subject.scope)) return false;
    if (value.profile !== undefined && !equal(value.profile, subject.profile)) return false;
    if (
      record(value.binding) &&
      (!equal(value.binding.scope, subject.scope) ||
        !record(subject.profile) ||
        value.binding.providerId !== subject.profile.providerId ||
        !equal(value.binding.account, subject.profile.account))
    )
      return false;
    if (record(value.grant) && Array.isArray(value.grant.repositoryIds)) {
      if (!equal(value.grant.repositoryIds, [subject.repositoryId])) return false;
      const permissions = value.grant.permissions;
      if (
        !Array.isArray(permissions) ||
        !permissions.some((p) => record(p) && p.name === "contents") ||
        permissions.some(
          (p) =>
            !record(p) || p.access !== "read" || (p.name !== "contents" && p.name !== "metadata"),
        )
      )
        return false;
    }
    if (
      value.method === "reserveIssuance" ||
      value.method === "withNamedCredential" ||
      value.method === "deliverRecordedToken"
    ) {
      if (
        time(value.createdAt) < time(subject.createdAt) ||
        time(value.deadline) > time(subject.notAfter)
      )
        return false;
    }
    if (value.comparedAt !== undefined) {
      if (
        time(value.comparedAt) < time(subject.createdAt) ||
        !duration(value.comparedAt, value.startNotAfter, limits.storageCallMaxMs) ||
        time(value.startNotAfter) > time(value.leaseNotAfter) ||
        time(value.leaseNotAfter) > time(subject.notAfter)
      )
        return false;
    }
    if (record(value.filter) && !equal(value.filter.preparation, subject)) return false;
    if (value.method === "fencePreparation") {
      if (
        !record(subject.grant) ||
        value.expectedGrantVersion !== subject.grant.version ||
        Number(value.invalidationVersion) !== Number(value.expectedInvalidationVersion) + 1
      )
        return false;
    }
    if (
      value.kind === "fenced" &&
      (!record(subject.grant) || Number(value.grantVersion) <= Number(subject.grant.version))
    )
      return false;
  }
  if (value.kind === "page" && record(value.filter) && record(value.filter.preparation)) {
    const rows = value.records;
    if (
      !Array.isArray(rows) ||
      rows.some(
        (r) =>
          !record(r) ||
          !record(r.issuance) ||
          !equal(
            r.issuance.preparation,
            value.filter && record(value.filter) ? value.filter.preparation : undefined,
          ),
      )
    )
      return false;
  }
  if (
    value.effectRef !== undefined &&
    value.operationRef !== undefined &&
    value.requestDigest !== undefined &&
    record(value.preparation) &&
    value.method === undefined
  ) {
    if (
      !duration(value.createdAt, value.deadline, limits.preparationMaxMs) ||
      time(value.createdAt) < time(value.preparation.createdAt) ||
      time(value.deadline) > time(value.preparation.notAfter) ||
      value.requestDigest !== checkoutDigest(value)
    )
      return false;
  }
  if (value.outcome === "checkout-complete") {
    if (
      !record(value.request) ||
      !record(value.request.preparation) ||
      !record(value.provenance) ||
      !record(value.provenance.clock)
    )
      return false;
    const request = value.request;
    const subject = value.request.preparation;
    const clock = value.provenance.clock;
    if (
      value.effectRef !== request.effectRef ||
      value.effectRequestDigest !== request.requestDigest ||
      value.incarnationRef !== subject.incarnationRef ||
      value.revisionId !== subject.revisionId ||
      !equal(value.actualCommit, subject.commit) ||
      !equal(value.staging, subject.staging) ||
      time(clock.sourceObservedAt) < time(request.createdAt) ||
      time(clock.sourceObservedAt) > time(request.deadline) ||
      time(clock.receivedAt) + Number(clock.uncertaintyMs) < time(clock.sourceObservedAt) ||
      time(clock.validUntil) < time(clock.sourceObservedAt) ||
      time(clock.validUntil) > time(subject.notAfter)
    )
      return false;
  }
  if (value.status !== undefined && value.reason !== undefined && value.request !== undefined) {
    const allowed: Readonly<Record<string, readonly string[]>> = {
      incomplete: ["not-submitted", "evidence-incomplete", "capability-unavailable"],
      unknown: ["provider-outcome-unknown", "authority-unavailable"],
      rejected: [
        "authority-denied",
        "scope-mismatch",
        "commit-mismatch",
        "incarnation-mismatch",
        "storage-mismatch",
      ],
      cancelled: ["cancelled"],
      stale: ["deadline-exceeded", "replaced", "evidence-stale"],
      conflict: ["operation-conflict"],
    };
    if (!allowed[String(value.status)]?.includes(String(value.reason))) return false;
  }
  return true;
}

function checkoutBytes(value: Record<string, unknown>): string {
  const {
    requestId: _request,
    createdAt: _created,
    deadline: _deadline,
    requestDigest: _digest,
    ...intent
  } = value;
  return canonical({ domain: "repository-checkout-v1", ...intent });
}
function checkoutDigest(value: Record<string, unknown>): string {
  return `sha256:${sha256Hex(checkoutBytes(value))}`;
}

export class RepositoryPreparationContractErrorV1 extends Error {
  constructor() {
    super("Invalid repository preparation V1 value.");
    this.name = "RepositoryPreparationContractErrorV1";
  }
}
function invalid(): never {
  throw new RepositoryPreparationContractErrorV1();
}
const legacyRequestKinds: Readonly<Record<string, CredentialStorageSchemaNameV1>> = {
  withNamedCredential: "namedUse",
  reserveIssuance: "reserve",
  recordMintOutcome: "mintOutcome",
  deliverRecordedToken: "deliver",
  listAffected: "affectedQuery",
  claimRevocation: "claimRevocation",
  recordRevocation: "revocationOutcome",
  readOperation: "readOperation",
};
const legacyResultKinds: Readonly<Record<string, CredentialStorageSchemaNameV1>> = {
  withNamedCredential: "useResult",
  reserveIssuance: "reservationResult",
  recordMintOutcome: "writeResult",
  deliverRecordedToken: "deliveryResult",
  listAffected: "affectedPage",
  claimRevocation: "claimResult",
  recordRevocation: "writeResult",
  readOperation: "operationResult",
};
function maxBytes(kind: RepositoryPreparationSchemaNameV1): number {
  return kind.endsWith("Result") ||
    ["record", "inventoryUnion", "page", "exchangeUnion", "checkoutReceipt"].includes(kind)
    ? REPOSITORY_PREPARATION_LIMITS_V1.maxResponseBytes
    : REPOSITORY_PREPARATION_LIMITS_V1.maxRequestBytes;
}
function validateOriginalMembers(value: unknown): void {
  if (!record(value) || value.purpose !== "original-turn-runtime") return;
  if (value.original !== undefined) parseCredentialStorageV1("originalBinding", value.original);
  if (value.observation !== undefined) {
    const observation = parseCredentialStorageV1("authorityObservation", value.observation);
    if (observation.profile.kind !== "repository") invalid();
  }
  if (value.record !== undefined) parseCredentialStorageV1("record", value.record);
  if (record(value.request)) {
    const kind = legacyRequestKinds[String(value.request.method)];
    if (!kind || !record(value.request.profile) || value.request.profile.kind !== "repository")
      invalid();
    parseCredentialStorageV1(kind, value.request);
    if (value.result !== undefined) {
      const resultKind = legacyResultKinds[String(value.request.method)];
      if (!resultKind) invalid();
      parseCredentialStorageV1(resultKind, value.result);
    }
  }
}
function exchangeCorresponds(value: unknown): boolean {
  if (!record(value) || !record(value.request) || !record(value.result)) return false;
  const request = value.request;
  const result = value.result;
  const requestHash = `sha256:${sha256Hex(semanticBytes(request))}`;
  if (
    result.operationRef !== undefined &&
    request.method !== "readOperation" &&
    result.operationRef !== request.operationRef
  )
    return false;
  if (
    result.intentDigest !== undefined &&
    request.method !== "readOperation" &&
    result.intentDigest !== requestHash
  )
    return false;
  if (
    record(result.receipt) &&
    (result.receipt.operationRef !== request.operationRef ||
      result.receipt.intentDigest !== requestHash)
  )
    return false;
  if (result.deliveryRef !== undefined && result.deliveryRef !== request.deliveryRef) return false;
  if (
    request.method === "claimRevocation" &&
    result.kind === "busy" &&
    result.revocationOperationRef !== request.revocationOperationRef
  )
    return false;
  if (
    (request.method === "recordMintOutcome" || request.method === "recordRevocation") &&
    result.kind === "evidence-missing" &&
    result.providerOutcome !== undefined &&
    result.providerOutcome !== request.outcome
  )
    return false;
  if (
    result.kind === "fenced" &&
    (!equal(result.preparation, request.preparation) ||
      result.responsibilityRef !== request.responsibilityRef ||
      result.invalidationVersion !== request.invalidationVersion)
  )
    return false;
  if (record(result.record)) {
    const row = result.record;
    if (!record(row.issuance) || !record(row.target)) return false;
    if (request.method === "reserveIssuance") {
      if (semanticBytes(row.issuance) !== semanticBytes(request)) return false;
    } else if (request.target !== undefined && !equal(row.target, request.target)) return false;
    if (request.preparation !== undefined && !equal(row.issuance.preparation, request.preparation))
      return false;
    if (
      request.tokenRef !== undefined &&
      row.state === "outstanding" &&
      row.tokenRef !== request.tokenRef
    )
      return false;
  }
  if (request.method === "readOperation" && result.kind === "found") {
    if (
      result.operationRef !== request.originalOperationRef ||
      result.intentDigest !== request.originalIntentDigest ||
      result.originalMethod !== request.originalMethod
    )
      return false;
  }
  if (request.method === "listAffected" && result.kind === "page") {
    if (
      !equal(result.filter, request.filter) ||
      !Array.isArray(result.records) ||
      result.records.length > Number(request.limit)
    )
      return false;
    if (
      record(request.cursor) &&
      (request.cursor.snapshotRef !== result.snapshotRef ||
        request.cursor.snapshotVersion !== result.snapshotVersion ||
        request.cursor.filterDigest !== result.filterDigest)
    )
      return false;
  }
  return true;
}

/** Validates values/correspondence only. No parsed result authenticates its producer. */
export function parseRepositoryPreparationV1<K extends RepositoryPreparationSchemaNameV1>(
  kind: K,
  input: unknown,
): RepositoryPreparationValueV1<K> {
  try {
    if (typeof kind !== "string" || !Object.hasOwn(RepositoryPreparationSchemasV1, kind)) invalid();
    const schema: TSchema = RepositoryPreparationSchemasV1[kind];
    if (
      !plainJson(input) ||
      new TextEncoder().encode(JSON.stringify(input)).byteLength > maxBytes(kind) ||
      !Check(schema, input) ||
      !validTimes(input) ||
      !relationships(input)
    )
      invalid();
    validateOriginalMembers(input);
    if (kind === "exchangeUnion" && !exchangeCorresponds(input)) invalid();
    return immutableCopy(input) as RepositoryPreparationValueV1<K>;
  } catch {
    return invalid();
  }
}

/** Raw JSON grammar is validated first; this second bounded pass rejects duplicate
 * decoded keys and numeric lexemes that JSON.parse could otherwise round or alias. */
function validateJsonLexemes(text: string): void {
  let at = 0;
  const space = () => {
    while (at < text.length && /\s/.test(text[at] ?? "")) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === "\\") at++;
      else if (c === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    return invalid();
  };
  const visit = (depth: number): void => {
    if (depth > REPOSITORY_PREPARATION_LIMITS_V1.maxJsonDepth) invalid();
    space();
    if (text[at] === '"') {
      string();
      return;
    }
    if (text[at] === "{") {
      at++;
      space();
      const seen = new Set<string>();
      if (text[at] === "}") {
        at++;
        return;
      }
      for (;;) {
        space();
        const key = string();
        if (seen.has(key)) invalid();
        seen.add(key);
        space();
        at++;
        visit(depth + 1);
        space();
        if (text[at++] === "}") return;
      }
    }
    if (text[at] === "[") {
      at++;
      space();
      if (text[at] === "]") {
        at++;
        return;
      }
      for (;;) {
        visit(depth + 1);
        space();
        if (text[at++] === "]") return;
      }
    }
    const start = at;
    while (at < text.length && !/[\s,}\]]/.test(text[at]!)) at++;
    const token = text.slice(start, at);
    if (token === "true" || token === "false" || token === "null") return;
    if (!/^(?:0|[1-9][0-9]*)$/.test(token) || !Number.isSafeInteger(Number(token))) invalid();
  };
  visit(0);
}
export function parseRepositoryPreparationJsonV1<K extends RepositoryPreparationSchemaNameV1>(
  kind: K,
  text: string,
): RepositoryPreparationValueV1<K> {
  try {
    if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > maxBytes(kind))
      invalid();
    const value: unknown = JSON.parse(text);
    validateJsonLexemes(text);
    return parseRepositoryPreparationV1(kind, value);
  } catch {
    return invalid();
  }
}
export function canonicalRepositoryPreparationRequestV1<
  K extends RepositoryPreparationSchemaNameV1,
>(kind: K, input: RepositoryPreparationValueV1<K>): string {
  const value: unknown = parseRepositoryPreparationV1(kind, input);
  if (!record(value)) return invalid();
  if (kind === "requestUnion" && record(value.request)) {
    if (value.purpose === "original-turn-runtime") {
      const originalKind = legacyRequestKinds[String(value.request.method)];
      if (!originalKind) return invalid();
      return canonicalCredentialStorageRequestV1(
        originalKind,
        parseCredentialStorageV1(originalKind, value.request),
      );
    }
    return semanticBytes(value.request);
  }
  if (kind === "checkoutRequest") return checkoutBytes(value);
  if (
    typeof value.method !== "string" ||
    value.credentialPurpose !== "candidate-repository-preparation"
  )
    return invalid();
  return semanticBytes(value);
}
/** Compute this only from a closed request with a placeholder digest; the helper checks
 * shape using the actual dictionary after inserting the resulting digest. */
export function preparationCheckoutRequestDigestV1(input: PreparationCheckoutRequestV1): string {
  if (!plainJson(input)) return invalid();
  const result = checkoutDigest(input);
  parseRepositoryPreparationV1("checkoutRequest", { ...input, requestDigest: result });
  return result;
}
export function preparationAffectedFilterDigestV1(input: PreparationAffectedTokenQueryV1): string {
  // A cursor binds the digest too; callers start from a cursor-free query, then retain it.
  if (!plainJson(input)) return invalid();
  const { cursor: _cursor, ...withoutCursor } = input;
  const value = parseRepositoryPreparationV1("affected", withoutCursor);
  return `sha256:${sha256Hex(canonical(value.filter))}`;
}

/** Clock is a trusted-owner input convention, not a proof. receivedAt is evaluation
 * time; all timestamps/uncertainty are checked. This is correspondence only and cannot
 * return a protected receipt handle or a readiness permission. */
export function parsePreparationReceiptExchangeV1(
  input: PreparationCheckoutRequestV1,
  result: unknown,
  clock: RuntimeEffectClockV1,
): PreparationReceiptDiagnosticV1 {
  try {
    const request = parseRepositoryPreparationV1("checkoutRequest", input);
    const receipt = parseRepositoryPreparationV1("receiptResult", result);
    if (
      !plainJson(clock) ||
      !Check(
        RepositoryPreparationSchemasV1.checkoutReceipt.properties.provenance.properties.clock,
        clock,
      ) ||
      !validTimes(clock) ||
      !canonicalClockConsistent(clock) ||
      !Number.isSafeInteger(clock.uncertaintyMs) ||
      clock.uncertaintyMs < 0 ||
      clock.uncertaintyMs > REPOSITORY_PREPARATION_LIMITS_V1.uncertaintyMaxMs ||
      !Number.isFinite(time(clock.receivedAt)) ||
      time(clock.validUntil) < time(clock.receivedAt)
    )
      invalid();
    if (receipt.status === "not-visible") return receipt;
    const actual = receipt.status === "complete" ? receipt.receipt.request : receipt.request;
    // Read-call correlation/bounds may change; the retained producer request keeps
    // the originally accepted effect deadline. A retry never extends that effect.
    if (
      checkoutBytes(actual) !== checkoutBytes(request) ||
      actual.requestDigest !== request.requestDigest
    )
      invalid();
    if (receipt.status === "complete") {
      const evidenceClock = receipt.receipt.provenance.clock;
      const uncertainty = clock.uncertaintyMs + evidenceClock.uncertaintyMs;
      if (
        time(clock.receivedAt) + uncertainty < time(evidenceClock.sourceObservedAt) ||
        time(clock.receivedAt) - time(evidenceClock.sourceObservedAt) + uncertainty >
          REPOSITORY_PREPARATION_LIMITS_V1.observationMaxAgeMs ||
        time(clock.receivedAt) + uncertainty > time(evidenceClock.validUntil) ||
        time(clock.receivedAt) + uncertainty > time(request.deadline) ||
        time(clock.receivedAt) + uncertainty > time(actual.deadline) ||
        time(clock.receivedAt) + uncertainty > time(request.preparation.notAfter)
      )
        invalid();
    }
    return receipt;
  } catch {
    return invalid();
  }
}
