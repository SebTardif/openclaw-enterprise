import { createHash } from "node:crypto";
import { Check } from "typebox/value";
import { ExactAttemptSchemaV1 } from "@openclaw-enterprise/contracts/completed-context-v1";
import {
  CredentialExpirySchemaV1,
  CREDENTIAL_STORAGE_LIMITS_V1,
  type CredentialExpiryV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import type {
  WorkOriginalOperationV2,
  VersionedWorkRefV2,
  WorkExecutionAssociationV2,
} from "../lifecycle/work-authority-ports-v2.ts";
import type { InventoryScopeV1, ProviderMintClaimV1 } from "./ports.ts";

/** Persisted correspondence only. No decoder here creates Work, current authority,
 * a receiver, a credential handle or permission to execute an operation. */
export interface RepositoryTargetV2 {
  readonly installationId: string;
  readonly githubHost: "github.com";
  readonly appId: string;
  readonly githubInstallationId: string;
  readonly repositoryId: string;
}
export interface RepositoryAccessLeaseV2 {
  readonly schemaVersion: 2;
  readonly accessLeaseRef: string;
  readonly target: RepositoryTargetV2;
  readonly original: WorkOriginalOperationV2;
  readonly work: VersionedWorkRefV2;
  readonly execution: WorkExecutionAssociationV2;
  readonly createdAt: string;
  readonly notAfter: string;
}
/** Nonsecret original material correspondence, committed before the one provider
 * attempt. It is sufficient to address the same encrypted material after restart;
 * the original material owner authenticates the selected immutable key. */
export interface RepositoryCustodyIdentityV2 {
  readonly lease: RepositoryAccessLeaseV2;
  readonly key: Readonly<{
    clientId: string;
    bindingRef: string;
    immutableVersion: string;
  }>;
  readonly providerAttemptRef: string;
  readonly tokenRef: string;
  readonly protectedRevocationRef: string;
}
export interface RepositoryMintClaimV2 extends ProviderMintClaimV1 {
  readonly schemaVersion: 2;
  readonly custodyIdentity: RepositoryCustodyIdentityV2;
}
export type RepositoryPermissionsV2 = Readonly<
  Partial<Record<"metadata" | "contents" | "issues" | "pull_requests", "read" | "write">>
>;
/** Retain the actual bounded permission observation, including broader scope.
 * Missing, malformed or historically unretained evidence is explicitly unavailable;
 * an empty map means the provider actually returned an empty permission map. */
export type RepositoryReturnedPermissionsV2 =
  Readonly<Record<string, "read" | "write" | "admin">> | Readonly<{ kind: "unavailable" }>;
interface RepositoryMutationBaseV2 {
  readonly schemaVersion: 2;
  readonly operationRef: string;
  readonly scope: InventoryScopeV1;
  readonly createdAt: string;
}
export interface ReserveRepositoryTokenV2 extends RepositoryMutationBaseV2 {
  readonly method: "reserveRepositoryToken";
  readonly lease: RepositoryAccessLeaseV2;
  readonly bindingRef: string;
  readonly permissionProfile: Readonly<{ ref: string; revision: string }>;
  readonly requestedPermissions: RepositoryPermissionsV2;
  readonly deadline: string;
}
interface ExistingRepositoryTokenV2 extends RepositoryMutationBaseV2 {
  readonly target: Readonly<{
    issuanceOperationRef: string;
    recordRef: string;
    intentDigest: string;
  }>;
  readonly expectedInventoryVersion: number;
}
export interface ClaimRepositoryRevocationV2 extends ExistingRepositoryTokenV2 {
  readonly method: "claimRepositoryRevocation";
  readonly tokenRef: string;
  readonly protectedRevocationRef: string;
  readonly revocationOperationRef: string;
  readonly expectedRevocationVersion: number;
  readonly previousAttempt:
    | Readonly<{ kind: "none" }>
    | Readonly<{
        kind: "reconcile";
        providerAttemptRef: string;
        providerOutcome: "unknown" | "not-dispatched";
      }>;
}
export interface RecordRepositoryRevocationV2 extends ExistingRepositoryTokenV2 {
  readonly method: "recordRepositoryRevocation";
  readonly tokenRef: string;
  readonly protectedRevocationRef: string;
  readonly revocationOperationRef: string;
  readonly claimRef: string;
  readonly claimVersion: number;
  readonly providerAttemptRef: string;
  readonly outcome: "confirmed" | "unknown" | "not-dispatched";
  readonly evidenceRef: string;
  readonly observedAt: string;
}
export interface RepositoryRevocationClaimV2 {
  readonly schemaVersion: 2;
  readonly input: ClaimRepositoryRevocationV2;
  readonly claimRef: string;
  readonly claimVersion: number;
  readonly providerAttemptRef: string;
  readonly claimedAt: string;
  readonly claimNotAfter: string;
}
export type RepositoryRevocationStateV2 = Readonly<{
  version: number;
  revocationOperationRef: string;
  providerAttemptRef: string;
  claimRef: string;
  claimVersion: number;
  claimedAt: string;
  claimNotAfter: string;
  priorOutcome: "none" | "unknown" | "not-dispatched";
}> &
  (
    | Readonly<{ state: "claimed" }>
    | Readonly<{
        state: "unknown" | "not-dispatched" | "confirmed";
        observedAt: string;
        evidenceRef: string;
      }>
  );
export type RepositoryTokenMutationV2 =
  | ReserveRepositoryTokenV2
  | ClaimRepositoryRevocationV2
  | RecordRepositoryRevocationV2
  | (ExistingRepositoryTokenV2 &
      Readonly<{
        method: "claimRepositoryMint";
        providerAttemptRef: string;
        custodyIdentity: RepositoryCustodyIdentityV2;
      }>)
  | (ExistingRepositoryTokenV2 &
      Readonly<{
        method: "recordRepositoryMint";
        providerAttemptRef: string;
        evidenceRef: string;
      }> &
      (
        | Readonly<{ outcome: "unknown"; expiry: CredentialExpiryV1 }>
        | Readonly<{ outcome: "definitely-rejected" }>
        | Readonly<{ outcome: "definitely-not-dispatched" }>
        | Readonly<{
            outcome: "accepted";
            tokenRef: string;
            protectedRevocationRef: string;
            expiry: CredentialExpiryV1;
            returnedPermissions: RepositoryReturnedPermissionsV2;
            scopeAccepted: boolean;
          }>
      ))
  | (ExistingRepositoryTokenV2 & Readonly<{ method: "retireRepositoryToken"; evidenceRef: string }>)
  | (ExistingRepositoryTokenV2 &
      Readonly<{ method: "resolveRepositoryToken"; evidenceRef: string }> &
      (
        | Readonly<{ outcome: "provider-revoked" | "definitely-not-dispatched" }>
        | Readonly<{
            outcome: "expired";
            expiry: Extract<CredentialExpiryV1, { kind: "provider-expiry" }>;
            uncertaintyMs: number;
          }>
      ));
interface RepositoryTokenRecordBaseV2 {
  readonly schemaVersion: 2;
  readonly target: ExistingRepositoryTokenV2["target"];
  readonly inventoryVersion: number;
  readonly issuance: ReserveRepositoryTokenV2;
  readonly updatedAt: string;
  readonly expiry: CredentialExpiryV1;
  /** Absent on a record with no cleanup claim. History uses the original claim
   * table; this projection identifies its current cleanup version and attempt. */
  readonly revocation?: RepositoryRevocationStateV2;
}
export type RepositoryTokenRecordV2 = RepositoryTokenRecordBaseV2 &
  (
    | Readonly<{ state: "reserved"; disposition: "scope-held" }>
    | Readonly<{ state: "mint-unknown"; disposition: "scope-held"; providerAttemptRef: string }>
    | Readonly<{
        state: "outstanding";
        disposition: "current-check-required" | "mitigation-only";
        providerAttemptRef: string;
        tokenRef: string;
        protectedRevocationRef: string;
        returnedPermissions: RepositoryReturnedPermissionsV2;
        evidenceRef: string;
      }>
    | Readonly<{
        state: "not-issued" | "resolved-without-token";
        disposition: "resolved-no-live-token";
        providerAttemptRef: string | null;
        evidenceRef: string;
      }>
  );
export interface RepositoryInventoryOperationV2 {
  readonly input: RepositoryTokenMutationV2;
  readonly digest: string;
  readonly state: "intent-recorded" | "effect-pending" | "effect-unknown" | "completed";
  readonly record: RepositoryTokenRecordV2;
  readonly commitRef: string;
  readonly recordedAt: string;
}

/** Query-only extension of the original inventory transaction. These methods are
 * internal storage leaves; the original owner must authenticate, audit and check
 * complete transition facts before COMMIT. Results inside the unit are provisional.
 * There is no second transaction, public inventory facade or token release here. */
export interface RepositoryLeaseInventoryTransactionV2 {
  assertActive(): void;
  readonly commitRef: string;
  findLease(accessLeaseRef: string): Promise<RepositoryAccessLeaseV2 | undefined>;
  insertLease(lease: RepositoryAccessLeaseV2): Promise<void>;
  findRecord(recordRef: string): Promise<RepositoryTokenRecordV2 | undefined>;
  findOperation(operationRef: string): Promise<RepositoryInventoryOperationV2 | undefined>;
  listLeaseRecords(accessLeaseRef: string): Promise<readonly RepositoryTokenRecordV2[]>;
  capacity(
    target: RepositoryTargetV2,
    accessLeaseRef: string,
  ): Promise<
    Readonly<{
      installationLive: number;
      leaseLive: number;
      mintActive: boolean;
      targetHeld: boolean;
      freeSlot: 1 | 2 | undefined;
    }>
  >;
  insertRecord(record: RepositoryTokenRecordV2, liveSlot: 1 | 2): Promise<void>;
  replaceRecord(expectedVersion: number, record: RepositoryTokenRecordV2): Promise<void>;
  appendOperation(operation: RepositoryInventoryOperationV2): Promise<void>;
  findMintClaim(recordRef: string): Promise<RepositoryMintClaimV2 | undefined>;
  insertMintClaim(claim: RepositoryMintClaimV2): Promise<void>;
  findRevocationClaim(claimRef: string): Promise<RepositoryRevocationClaimV2 | undefined>;
  appendRevocationClaim(claim: RepositoryRevocationClaimV2): Promise<void>;
}

function fail(): never {
  throw new Error("Repository inventory metadata is invalid.");
}
const reference = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}(?![\s\S])/.test(v);
const digest = (v: unknown): v is string =>
  typeof v === "string" && /^sha256:[0-9a-f]{64}(?![\s\S])/.test(v);
const version = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const instant = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const obj = (v: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    fail();
  return v as Record<string, unknown>;
};
/** Refuse accessors/non-JSON data before bounded copying. The copy is inert data. */
function snapshot(value: unknown): unknown {
  let count = 0;
  function walk(v: unknown, depth: number): unknown {
    if (++count > 4096 || depth > 20) fail();
    if (v === null || typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) fail();
      return v;
    }
    if (!v || typeof v !== "object") fail();
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length) fail();
      return Object.freeze(
        Array.from({ length: v.length }, (_, i) => {
          const d = Object.getOwnPropertyDescriptor(v, String(i));
          if (!d || !("value" in d)) fail();
          return walk(d.value, depth + 1);
        }),
      );
    }
    if (Object.getPrototypeOf(v) !== Object.prototype) fail();
    const entries = Reflect.ownKeys(v).map((k) => {
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (typeof k !== "string" || !d || !d.enumerable || !("value" in d)) fail();
      return [k, walk(d.value, depth + 1)];
    });
    return Object.freeze(Object.fromEntries(entries));
  }
  const copied = walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(copied)) > 65536) fail();
  return copied;
}
export function canonicalRepositoryInventoryV2(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalRepositoryInventoryV2).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonicalRepositoryInventoryV2((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const repositoryInventoryDigestV2 = (value: unknown): string =>
  "sha256:" + createHash("sha256").update(canonicalRepositoryInventoryV2(value)).digest("hex");
function target(v: unknown): void {
  const o = obj(v, [
    "installationId",
    "githubHost",
    "appId",
    "githubInstallationId",
    "repositoryId",
  ]);
  if (
    !reference(o.installationId) ||
    o.githubHost !== "github.com" ||
    [o.appId, o.githubInstallationId, o.repositoryId].some(
      (n) => typeof n !== "string" || !/^[1-9][0-9]{0,19}(?![\s\S])/.test(n),
    )
  )
    fail();
}
export function repositoryTargetDigestV2(value: RepositoryTargetV2): string {
  const fixed = snapshot(value) as RepositoryTargetV2;
  target(fixed);
  // Each field excludes newline. The database checks this same stable encoding;
  // aliases, Namespace and credential generations cannot select another hold key.
  return (
    "sha256:" +
    createHash("sha256")
      .update(
        [
          fixed.installationId,
          fixed.githubHost,
          fixed.appId,
          fixed.githubInstallationId,
          fixed.repositoryId,
        ].join("\n"),
      )
      .digest("hex")
  );
}
function permissions(v: unknown): void {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail();
  const keys = Object.keys(v);
  if (
    keys.length < 1 ||
    keys.length > 4 ||
    keys.some((k) => !["metadata", "contents", "issues", "pull_requests"].includes(k))
  )
    fail();
  if (
    Object.values(v).some((n) => n !== "read" && n !== "write") ||
    (v as RepositoryPermissionsV2).metadata !== "read"
  )
    fail();
}
function returnedPermissions(v: unknown): void {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail();
  if ((v as Record<string, unknown>).kind === "unavailable") {
    obj(v, ["kind"]);
    return;
  }
  if (
    Object.keys(v).length > 64 ||
    Object.keys(v).some((k) => !/^[a-z][a-z0-9_]{0,63}(?![\s\S])/.test(k)) ||
    Object.values(v).some((n) => n !== "read" && n !== "write" && n !== "admin")
  )
    fail();
}
function scope(v: unknown): InventoryScopeV1 {
  const o = obj(v, ["installationId", "namespaceId", "agentId"]);
  if (Object.values(o).some((n) => !reference(n))) fail();
  return o as unknown as InventoryScopeV1;
}
function profile(v: unknown): void {
  const o = obj(v, ["ref", "revision"]);
  if (!reference(o.ref) || !reference(o.revision)) fail();
}
function lease(v: unknown): void {
  const o = obj(v, [
    "schemaVersion",
    "accessLeaseRef",
    "target",
    "original",
    "work",
    "execution",
    "createdAt",
    "notAfter",
  ]);
  if (
    o.schemaVersion !== 2 ||
    !reference(o.accessLeaseRef) ||
    !instant(o.createdAt) ||
    !instant(o.notAfter) ||
    Date.parse(o.notAfter) <= Date.parse(o.createdAt)
  )
    fail();
  target(o.target);
  const original = obj(o.original, ["operationRef", "requestDigest", "invocationRef", "scope"]);
  if (
    !reference(original.operationRef) ||
    !digest(original.requestDigest) ||
    !reference(original.invocationRef)
  )
    fail();
  const s = obj(original.scope, ["installationRef", "namespaceRef", "agentRef", "revisionRef"]);
  if (
    Object.values(s).some((n) => !reference(n)) ||
    s.installationRef !== (o.target as RepositoryTargetV2).installationId
  )
    fail();
  const work = obj(o.work, ["workRef", "revision"]);
  if (!reference(work.workRef) || !version(work.revision)) fail();
  const execution = obj(o.execution, [
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
  if (
    !Check(ExactAttemptSchemaV1, execution.attempt) ||
    [
      "assignmentRef",
      "assignmentVersion",
      "executionIncarnationRef",
      "executionGeneration",
      "receiverRef",
      "protectedOriginRef",
    ].some((k) => !reference(execution[k]))
  )
    fail();
  const a = execution.attempt as WorkExecutionAssociationV2["attempt"];
  if (
    a.installationRef !== s.installationRef ||
    a.namespaceRef !== s.namespaceRef ||
    a.agentRef !== s.agentRef
  )
    fail();
  profile(execution.executionProfile);
  const p = execution.predecessor as Record<string, unknown>;
  if (p?.kind === "none") obj(p, ["kind"]);
  else {
    obj(p, [
      "kind",
      "attempt",
      "assignmentRef",
      "executionIncarnationRef",
      "terminationEvidenceRef",
    ]);
    if (
      p.kind !== "terminated-original" ||
      !Check(ExactAttemptSchemaV1, p.attempt) ||
      ![p.assignmentRef, p.executionIncarnationRef, p.terminationEvidenceRef].every(reference)
    )
      fail();
  }
}
export function parseRepositoryAccessLeaseV2(value: unknown): RepositoryAccessLeaseV2 {
  const v = snapshot(value);
  lease(v);
  return v as RepositoryAccessLeaseV2;
}
function custodyIdentity(value: unknown): void {
  const o = obj(value, [
    "lease",
    "key",
    "providerAttemptRef",
    "tokenRef",
    "protectedRevocationRef",
  ]);
  lease(o.lease);
  const key = obj(o.key, ["clientId", "bindingRef", "immutableVersion"]);
  if (
    typeof key.clientId !== "string" ||
    !/^[A-Za-z0-9._-]{1,200}(?![\s\S])/.test(key.clientId) ||
    !reference(key.bindingRef) ||
    !reference(key.immutableVersion) ||
    ![o.providerAttemptRef, o.tokenRef, o.protectedRevocationRef].every(reference)
  )
    fail();
}
export function parseRepositoryCustodyIdentityV2(value: unknown): RepositoryCustodyIdentityV2 {
  const fixed = snapshot(value);
  custodyIdentity(fixed);
  return fixed as RepositoryCustodyIdentityV2;
}
export function repositoryLeaseScopeV2(value: RepositoryAccessLeaseV2): InventoryScopeV1 {
  return {
    installationId: value.original.scope.installationRef,
    namespaceId: value.original.scope.namespaceRef,
    agentId: value.original.scope.agentRef,
  };
}
function locator(v: unknown): void {
  const o = obj(v, ["issuanceOperationRef", "recordRef", "intentDigest"]);
  if (!reference(o.issuanceOperationRef) || !reference(o.recordRef) || !digest(o.intentDigest))
    fail();
}
function previousRevocation(value: unknown): void {
  const v = value as Record<string, unknown>;
  if (v?.kind === "none") obj(v, ["kind"]);
  else {
    obj(v, ["kind", "providerAttemptRef", "providerOutcome"]);
    if (
      v.kind !== "reconcile" ||
      !reference(v.providerAttemptRef) ||
      !["unknown", "not-dispatched"].includes(String(v.providerOutcome))
    )
      fail();
  }
}
function revocationState(value: unknown): void {
  const v = value as Record<string, unknown>;
  const common = [
    "version",
    "revocationOperationRef",
    "providerAttemptRef",
    "claimRef",
    "claimVersion",
    "claimedAt",
    "claimNotAfter",
    "priorOutcome",
    "state",
  ];
  if (v?.state === "claimed") obj(v, common);
  else {
    obj(v, [...common, "observedAt", "evidenceRef"]);
    if (
      !["unknown", "not-dispatched", "confirmed"].includes(String(v.state)) ||
      !instant(v.observedAt) ||
      !reference(v.evidenceRef)
    )
      fail();
  }
  if (
    !version(v.version) ||
    !version(v.claimVersion) ||
    Number(v.claimVersion) > Number(v.version) ||
    ![v.revocationOperationRef, v.providerAttemptRef, v.claimRef].every(reference) ||
    !instant(v.claimedAt) ||
    !instant(v.claimNotAfter) ||
    Date.parse(v.claimNotAfter) <= Date.parse(v.claimedAt) ||
    Date.parse(v.claimNotAfter) - Date.parse(v.claimedAt) >
      CREDENTIAL_STORAGE_LIMITS_V1.revocationClaimLeaseMs ||
    !["none", "unknown", "not-dispatched"].includes(String(v.priorOutcome))
  )
    fail();
}
function mutation(v: unknown): void {
  const o = v as Record<string, unknown>;
  if (
    !o ||
    typeof o !== "object" ||
    o.schemaVersion !== 2 ||
    !reference(o.operationRef) ||
    !instant(o.createdAt)
  )
    fail();
  const s = scope(o.scope),
    base = ["schemaVersion", "operationRef", "scope", "createdAt", "method"];
  if (o.method === "reserveRepositoryToken") {
    obj(o, [
      ...base,
      "lease",
      "bindingRef",
      "permissionProfile",
      "requestedPermissions",
      "deadline",
    ]);
    lease(o.lease);
    profile(o.permissionProfile);
    permissions(o.requestedPermissions);
    if (
      !reference(o.bindingRef) ||
      !instant(o.deadline) ||
      Date.parse(o.deadline) <= Date.parse(o.createdAt) ||
      Date.parse(o.deadline) > Date.parse((o.lease as RepositoryAccessLeaseV2).notAfter) ||
      canonicalRepositoryInventoryV2(s) !==
        canonicalRepositoryInventoryV2(repositoryLeaseScopeV2(o.lease as RepositoryAccessLeaseV2))
    )
      fail();
    return;
  }
  locator(o.target);
  if (!version(o.expectedInventoryVersion)) fail();
  const existing = [...base, "target", "expectedInventoryVersion"];
  switch (o.method) {
    case "claimRepositoryRevocation":
      obj(o, [
        ...existing,
        "tokenRef",
        "protectedRevocationRef",
        "revocationOperationRef",
        "expectedRevocationVersion",
        "previousAttempt",
      ]);
      if (
        ![o.tokenRef, o.protectedRevocationRef, o.revocationOperationRef].every(reference) ||
        !Number.isSafeInteger(o.expectedRevocationVersion) ||
        Number(o.expectedRevocationVersion) < 0
      )
        fail();
      previousRevocation(o.previousAttempt);
      break;
    case "recordRepositoryRevocation":
      obj(o, [
        ...existing,
        "tokenRef",
        "protectedRevocationRef",
        "revocationOperationRef",
        "claimRef",
        "claimVersion",
        "providerAttemptRef",
        "outcome",
        "evidenceRef",
        "observedAt",
      ]);
      if (
        ![
          o.tokenRef,
          o.protectedRevocationRef,
          o.revocationOperationRef,
          o.claimRef,
          o.providerAttemptRef,
          o.evidenceRef,
        ].every(reference) ||
        !version(o.claimVersion) ||
        !instant(o.observedAt) ||
        !["confirmed", "unknown", "not-dispatched"].includes(String(o.outcome))
      )
        fail();
      break;
    case "claimRepositoryMint":
      obj(o, [...existing, "providerAttemptRef", "custodyIdentity"]);
      if (!reference(o.providerAttemptRef)) fail();
      custodyIdentity(o.custodyIdentity);
      if (
        (o.custodyIdentity as RepositoryCustodyIdentityV2).providerAttemptRef !==
        o.providerAttemptRef
      )
        fail();
      break;
    case "recordRepositoryMint": {
      const common = [...existing, "providerAttemptRef", "evidenceRef", "outcome"];
      if (!reference(o.providerAttemptRef) || !reference(o.evidenceRef)) fail();
      if (o.outcome === "definitely-rejected" || o.outcome === "definitely-not-dispatched")
        obj(o, common);
      else if (o.outcome === "unknown") {
        obj(o, [...common, "expiry"]);
        if (!Check(CredentialExpirySchemaV1, o.expiry)) fail();
      } else {
        obj(o, [
          ...common,
          "tokenRef",
          "protectedRevocationRef",
          "expiry",
          "returnedPermissions",
          "scopeAccepted",
        ]);
        if (
          o.outcome !== "accepted" ||
          !reference(o.tokenRef) ||
          !reference(o.protectedRevocationRef) ||
          !Check(CredentialExpirySchemaV1, o.expiry) ||
          typeof o.scopeAccepted !== "boolean"
        )
          fail();
        returnedPermissions(o.returnedPermissions);
      }
      break;
    }
    case "retireRepositoryToken":
      obj(o, [...existing, "evidenceRef"]);
      if (!reference(o.evidenceRef)) fail();
      break;
    case "resolveRepositoryToken":
      if (o.outcome === "provider-revoked" || o.outcome === "definitely-not-dispatched")
        obj(o, [...existing, "evidenceRef", "outcome"]);
      else {
        obj(o, [...existing, "evidenceRef", "outcome", "expiry", "uncertaintyMs"]);
        if (
          o.outcome !== "expired" ||
          !Check(CredentialExpirySchemaV1, o.expiry) ||
          (o.expiry as CredentialExpiryV1).kind !== "provider-expiry" ||
          !Number.isSafeInteger(o.uncertaintyMs) ||
          Number(o.uncertaintyMs) < 0 ||
          Number(o.uncertaintyMs) > 2000
        )
          fail();
      }
      if (!reference(o.evidenceRef)) fail();
      break;
    default:
      fail();
  }
}
export function parseRepositoryTokenMutationV2(value: unknown): RepositoryTokenMutationV2 {
  const v = snapshot(value);
  mutation(v);
  return v as RepositoryTokenMutationV2;
}
export function parseRepositoryTokenRecordV2(value: unknown): RepositoryTokenRecordV2 {
  const v = snapshot(value),
    o = v as Record<string, unknown>;
  if (
    !o ||
    o.schemaVersion !== 2 ||
    !version(o.inventoryVersion) ||
    !instant(o.updatedAt) ||
    !Check(CredentialExpirySchemaV1, o.expiry)
  )
    fail();
  locator(o.target);
  mutation(o.issuance);
  if ((o.issuance as ReserveRepositoryTokenV2).method !== "reserveRepositoryToken") fail();
  const common = [
    "schemaVersion",
    "target",
    "inventoryVersion",
    "issuance",
    "updatedAt",
    "expiry",
    "state",
    "disposition",
  ];
  if (Object.hasOwn(o, "revocation")) {
    revocationState(o.revocation);
    common.push("revocation");
    if (
      (o.revocation as RepositoryRevocationStateV2).version >= Number(o.inventoryVersion) ||
      o.state === "reserved" ||
      o.state === "mint-unknown" ||
      (o.state === "outstanding" && o.disposition !== "mitigation-only")
    )
      fail();
  }
  if (o.state === "reserved") {
    obj(o, common);
    if (
      o.disposition !== "scope-held" ||
      (o.expiry as CredentialExpiryV1).kind !== "expiry-unproven"
    )
      fail();
  } else if (o.state === "mint-unknown") {
    obj(o, [...common, "providerAttemptRef"]);
    if (o.disposition !== "scope-held" || !reference(o.providerAttemptRef)) fail();
  } else if (o.state === "outstanding") {
    obj(o, [
      ...common,
      "providerAttemptRef",
      "tokenRef",
      "protectedRevocationRef",
      "returnedPermissions",
      "evidenceRef",
    ]);
    if (
      ![o.providerAttemptRef, o.tokenRef, o.protectedRevocationRef, o.evidenceRef].every(
        reference,
      ) ||
      !["current-check-required", "mitigation-only"].includes(String(o.disposition))
    )
      fail();
    returnedPermissions(o.returnedPermissions);
    if (
      o.disposition === "current-check-required" &&
      ((o.expiry as CredentialExpiryV1).kind !== "provider-expiry" ||
        canonicalRepositoryInventoryV2(o.returnedPermissions) !==
          canonicalRepositoryInventoryV2(
            (o.issuance as ReserveRepositoryTokenV2).requestedPermissions,
          ))
    )
      fail();
  } else {
    obj(o, [...common, "providerAttemptRef", "evidenceRef"]);
    if (
      !["not-issued", "resolved-without-token"].includes(String(o.state)) ||
      o.disposition !== "resolved-no-live-token" ||
      !(o.providerAttemptRef === null || reference(o.providerAttemptRef)) ||
      !reference(o.evidenceRef)
    )
      fail();
  }
  const r = v as RepositoryTokenRecordV2;
  if (
    r.target.issuanceOperationRef !== r.issuance.operationRef ||
    r.target.intentDigest !== repositoryInventoryDigestV2(r.issuance)
  )
    fail();
  return r;
}
export function parseRepositoryInventoryOperationV2(
  value: unknown,
): RepositoryInventoryOperationV2 {
  const v = snapshot(value),
    o = obj(v, ["input", "digest", "state", "record", "commitRef", "recordedAt"]);
  const input = parseRepositoryTokenMutationV2(o.input),
    record = parseRepositoryTokenRecordV2(o.record);
  if (
    o.digest !== repositoryInventoryDigestV2(input) ||
    !reference(o.commitRef) ||
    !instant(o.recordedAt) ||
    !["intent-recorded", "effect-pending", "effect-unknown", "completed"].includes(
      String(o.state),
    ) ||
    canonicalRepositoryInventoryV2(input.scope) !==
      canonicalRepositoryInventoryV2(record.issuance.scope)
  )
    fail();
  if (
    input.method === "reserveRepositoryToken"
      ? canonicalRepositoryInventoryV2(input) !== canonicalRepositoryInventoryV2(record.issuance)
      : canonicalRepositoryInventoryV2(input.target) !==
        canonicalRepositoryInventoryV2(record.target)
  )
    fail();
  return v as RepositoryInventoryOperationV2;
}
export function parseRepositoryMintClaimV2(value: unknown): RepositoryMintClaimV2 {
  const v = snapshot(value),
    o = obj(v, [
      "schemaVersion",
      "custodyIdentity",
      "issuanceOperationRef",
      "recordRef",
      "issuanceIntentDigest",
      "useOperationRef",
      "useIntentDigest",
      "providerAttemptRef",
      "inventoryVersion",
    ]);
  if (
    o.schemaVersion !== 2 ||
    ![o.issuanceOperationRef, o.recordRef, o.useOperationRef, o.providerAttemptRef].every(
      reference,
    ) ||
    !digest(o.issuanceIntentDigest) ||
    !digest(o.useIntentDigest) ||
    !version(o.inventoryVersion)
  )
    fail();
  custodyIdentity(o.custodyIdentity);
  if (
    (o.custodyIdentity as RepositoryCustodyIdentityV2).providerAttemptRef !== o.providerAttemptRef
  )
    fail();
  return v as RepositoryMintClaimV2;
}
export function parseRepositoryRevocationClaimV2(value: unknown): RepositoryRevocationClaimV2 {
  const fixed = snapshot(value);
  const v = obj(fixed, [
    "schemaVersion",
    "input",
    "claimRef",
    "claimVersion",
    "providerAttemptRef",
    "claimedAt",
    "claimNotAfter",
  ]);
  mutation(v.input);
  const input = v.input as ClaimRepositoryRevocationV2;
  if (
    v.schemaVersion !== 2 ||
    input.method !== "claimRepositoryRevocation" ||
    !reference(v.claimRef) ||
    !version(v.claimVersion) ||
    v.claimVersion !== input.expectedRevocationVersion + 1 ||
    !reference(v.providerAttemptRef) ||
    !instant(v.claimedAt) ||
    !instant(v.claimNotAfter) ||
    Date.parse(v.claimNotAfter) <= Date.parse(v.claimedAt) ||
    Date.parse(v.claimNotAfter) - Date.parse(v.claimedAt) >
      CREDENTIAL_STORAGE_LIMITS_V1.revocationClaimLeaseMs ||
    (input.previousAttempt.kind === "reconcile" &&
      input.previousAttempt.providerAttemptRef !== v.providerAttemptRef)
  )
    fail();
  return fixed as RepositoryRevocationClaimV2;
}
export function repositoryRecordLiveV2(record: RepositoryTokenRecordV2): boolean {
  return (
    record.state === "reserved" || record.state === "mint-unknown" || record.state === "outstanding"
  );
}
export function repositoryRecordHeldV2(record: RepositoryTokenRecordV2): boolean {
  return (
    record.state === "mint-unknown" ||
    (record.state === "outstanding" && record.disposition === "mitigation-only")
  );
}
