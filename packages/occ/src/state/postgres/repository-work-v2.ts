import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { types } from "node:util";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type {
  WorkOriginalOperationV2,
  WorkExecutionAssociationV2,
  VersionedWorkRefV2,
  WorkRepositoryGitReadV3,
} from "../../lifecycle/work-authority-ports-v2.ts";
import type { QueryRepositoryFactoryContext } from "../../ports/repository-factory.ts";
import type { PostgresCredentialInventoryEffectV1 } from "../../credential-inventory-v1/postgres.ts";
import {
  parseRepositoryTokenMutationV2,
  repositoryInventoryDigestV2,
  type RepositoryTokenMutationV2,
  type RepositoryInventoryOperationV2,
  type RepositoryLeaseInventoryTransactionV2,
} from "../../credential-inventory-v1/repository-lease-v2.ts";
import { transitionRepositoryInventoryV2 } from "../../credential-inventory-v1/repository-lease-transactions-v2.ts";
import { ScopeViolationError } from "../../errors.ts";
import { createPostgresRepositoryWorkPolicyV2 } from "./repository-work-policy-v2.ts";
import type { RepositoryWorkSelectedExecutionContextsV2 } from "./repository-work-selected-execution-context-v2.ts";
import { readRepositoryWorkInventoryCurrentV2 } from "./repository-work-current-inventory-v2.ts";
import {
  canonicalRepositoryWorkV2,
  repositoryWorkObjectV2 as object,
  repositoryWorkUnavailableV2 as fail,
} from "./repository-work-canonical-v2.ts";
export { canonicalRepositoryWorkV2 } from "./repository-work-canonical-v2.ts";

import type {
  RepositoryWorkJsonV2,
  RepositoryWorkScopeV2,
  RepositoryWorkRecordV2,
  RepositoryWorkReadsetV2,
  RepositoryWorkAdmissionV2,
  RepositoryWorkPreparationV2,
  RepositoryWorkDispatchV2,
  RepositoryWorkClosureV2,
  RepositoryWorkObservationV2,
  RepositoryWorkOperationV2,
  RepositoryWorkOperationReadV2,
  RepositoryWorkHeldLeaseV2,
  RepositoryWorkTransactionContextV2,
  RepositoryWorkSourceLeaseV2,
  RepositoryWorkOriginalSourceV2,
  RepositoryWorkCustodyLeaseV2,
  RepositoryWorkCustodySourceV2,
  RepositoryWorkCommittedV2,
  RepositoryWorkCommittedReleaseV2,
  RepositoryWorkUnitV2,
  RepositoryWorkStoreV2,
  RepositoryWorkCommittedUseLeaseV2,
  RepositoryWorkCommittedMintUseLeaseV2,
  RepositoryWorkCommittedRevocationUseLeaseV2,
  RepositoryWorkStateParticipantV2,
  RepositoryWorkStateBindingV2,
  RepositoryWorkInventoryCurrentV2,
} from "../../ports/repository-work-v2.ts";
export type {
  RepositoryWorkJsonV2,
  RepositoryWorkScopeV2,
  RepositoryWorkRecordV2,
  RepositoryWorkReadsetV2,
  RepositoryWorkAdmissionV2,
  RepositoryWorkPreparationV2,
  RepositoryWorkDispatchV2,
  RepositoryWorkClosureV2,
  RepositoryWorkObservationV2,
  RepositoryWorkOperationV2,
  RepositoryWorkOperationReadV2,
  RepositoryWorkHeldLeaseV2,
  RepositoryWorkTransactionContextV2,
  RepositoryWorkSourceLeaseV2,
  RepositoryWorkOriginalSourceV2,
  RepositoryWorkCustodyLeaseV2,
  RepositoryWorkCustodySourceV2,
  RepositoryWorkCommittedV2,
  RepositoryWorkCommittedReleaseV2,
  RepositoryWorkUnitV2,
  RepositoryWorkStoreV2,
  RepositoryWorkCommittedUseLeaseV2,
  RepositoryWorkCommittedMintUseLeaseV2,
  RepositoryWorkStateParticipantV2,
  RepositoryWorkCommittedRevocationUseLeaseV2,
  RepositoryWorkStateBindingV2,
  RepositoryWorkInventoryCurrentV2,
} from "../../ports/repository-work-v2.ts";

const ref = (value: unknown): string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}(?![\s\S])/.test(value)
    ? value
    : fail();
const positive = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail();
const integer = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail();
const repositoryRequestDigest = (value: unknown): string =>
  typeof value === "string" && /^sha256:[a-f0-9]{64}(?![\s\S])/.test(value) ? value : fail();
const instant = (value: unknown): string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value
    ? value
    : fail();
function json(value: unknown): RepositoryWorkJsonV2 {
  // This parser only copies canonical data. It does not assign a Work/authority brand.
  const parsed: RepositoryWorkJsonV2 = JSON.parse(canonicalRepositoryWorkV2(value));
  const freeze = (node: RepositoryWorkJsonV2): RepositoryWorkJsonV2 => {
    if (node && typeof node === "object") {
      for (const child of Object.values(node)) freeze(child);
      Object.freeze(node);
    }
    return node;
  };
  return freeze(parsed);
}
function scope(value: unknown): RepositoryWorkScopeV2 {
  const data = object(value);
  return Object.freeze({
    installationId: ref(data.installationId),
    namespaceId: ref(data.namespaceId),
    agentId: ref(data.agentId),
    revisionRef: ref(data.revisionRef),
  });
}
function record(value: unknown): RepositoryWorkRecordV2 {
  const data = object(value);
  const state = data.state;
  if (state !== "open" && state !== "closed") return fail();
  const result = Object.freeze({
    scope: scope(data.scope),
    workRef: ref(data.workRef),
    revision: positive(data.revision),
    withdrawalRevision: integer(data.withdrawalRevision),
    parentWorkRef: data.parentWorkRef === null ? null : ref(data.parentWorkRef),
    rootWorkRef: ref(data.rootWorkRef),
    originalHorizon: instant(data.originalHorizon),
    state,
    execution: json(data.execution),
    policy: json(data.policy),
    originalAdmission: json(data.originalAdmission),
  });
  if ((result.parentWorkRef === null) !== (result.rootWorkRef === result.workRef)) return fail();
  return result;
}
function operation(value: unknown): RepositoryWorkOperationV2 {
  const data = object(value);
  const kind = data.kind;
  if (
    kind !== "admission" &&
    kind !== "preparation" &&
    kind !== "dispatch" &&
    kind !== "closure" &&
    kind !== "observation"
  )
    return fail();
  return Object.freeze({
    operationRef: ref(data.operationRef),
    requestDigest: repositoryRequestDigest(data.requestDigest),
    invocationRef: ref(data.invocationRef),
    scope: scope(data.scope),
    commitRef: ref(data.commitRef),
    kind,
    document: json(data.document),
  });
}
function gitRead(value: unknown, expectedDigest: string): WorkRepositoryGitReadV3 {
  const data = object(value);
  if (
    Object.keys(data).sort().join(",") !==
      "bodyBytes,bodySha256,gitOperation,gitProtocol,operation,requestDigest,version" ||
    data.version !== 3 ||
    data.operation !== "git:read" ||
    data.gitProtocol !== "version=2" ||
    (data.gitOperation !== "discovery" && data.gitOperation !== "upload-pack") ||
    typeof data.bodyBytes !== "number" ||
    !Number.isSafeInteger(data.bodyBytes) ||
    data.bodyBytes < 0 ||
    data.bodyBytes > 4194304 ||
    repositoryRequestDigest(data.requestDigest) !== expectedDigest
  )
    return fail();
  const bodySha256 = repositoryRequestDigest(data.bodySha256);
  if (
    data.gitOperation === "discovery"
      ? data.bodyBytes !== 0 ||
        bodySha256 !== "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      : data.bodyBytes === 0
  )
    return fail();
  return Object.freeze({
    version: 3,
    operation: "git:read",
    gitOperation: data.gitOperation,
    gitProtocol: "version=2",
    bodyBytes: data.bodyBytes,
    bodySha256,
    requestDigest: expectedDigest,
  });
}
function preparation(value: unknown): RepositoryWorkPreparationV2 {
  const data = object(value);
  const requestDigest = repositoryRequestDigest(data.requestDigest);
  return Object.freeze({
    workRef: ref(data.workRef),
    workRevision: positive(data.workRevision),
    requestDigest,
    receiverRef: ref(data.receiverRef),
    sessionRef: ref(data.sessionRef),
    dnsBindingRef: ref(data.dnsBindingRef),
    repositoryTarget: json(data.repositoryTarget),
    ...(Object.hasOwn(data, "repositoryRequest")
      ? { repositoryRequest: gitRead(data.repositoryRequest, requestDigest) }
      : {}),
  });
}
function requirePreparationProfile(
  own: RepositoryWorkRecordV2,
  value: RepositoryWorkPreparationV2,
): void {
  const policy = object(own.policy);
  const git = policy.repositoryOperation === "git:read";
  if (
    (Object.hasOwn(policy, "repositoryOperation") && !git) ||
    (Object.hasOwn(policy, "requiredPermissions") && !git) ||
    (git &&
      (Object.hasOwn(policy, "permission") ||
        !equal(policy.requiredPermissions, ["contents:read", "metadata:read"]))) ||
    Object.hasOwn(value, "repositoryRequest") !== git
  )
    fail();
  if (git) gitRead(value.repositoryRequest, value.requestDigest);
}
function dispatch(value: unknown): RepositoryWorkDispatchV2 {
  const data = object(value);
  return Object.freeze({
    ...preparation(data),
    preparationOperationRef: ref(data.preparationOperationRef),
    accessLeaseRef: ref(data.accessLeaseRef),
    inventoryRecordRef: ref(data.inventoryRecordRef),
    inventoryVersion: positive(data.inventoryVersion),
    releaseRef: ref(data.releaseRef),
  });
}
const equal = (a: unknown, b: unknown) =>
  canonicalRepositoryWorkV2(a) === canonicalRepositoryWorkV2(b);

/** Closed query-only repository. The original owner already holds account/source,
 * Installation, Namespace and Agent locks, then the complete root-to-own Work
 * chain. No pool, retries, transaction control or provider dispatch occurs here. */
export function createPostgresRepositoryWorkV2(
  context: QueryRepositoryFactoryContext,
  originalScope: RepositoryWorkScopeV2,
  commitRef: string,
) {
  const fixed = scope(originalScope);
  const commit = ref(commitRef);
  const keys = [fixed.installationId, fixed.namespaceId, fixed.agentId, fixed.revisionRef];
  const active = () => {
    context.transaction.assertActive();
    if (
      context.scope.installationId !== fixed.installationId ||
      context.scope.namespaceId !== fixed.namespaceId
    )
      fail();
  };
  const query = async (text: string, values: readonly unknown[]) => {
    active();
    const result = await context.query.query(text, values);
    active();
    if (!Number.isSafeInteger(result.rowCount) || result.rowCount !== result.rows.length)
      return fail();
    return result;
  };
  const where = "installation_id=$1 AND namespace_id=$2 AND agent_id=$3 AND revision_ref=$4";
  const decode = <T>(row: unknown, read: (value: unknown) => T): T => {
    const data = object(row);
    if (typeof data.canonical_document !== "string") return fail();
    const value = JSON.parse(data.canonical_document);
    if (canonicalRepositoryWorkV2(value) !== data.canonical_document) return fail();
    return read(value);
  };
  const findOperation = async (operationRef: string): Promise<RepositoryWorkOperationReadV2> => {
    const found = await query(
      `SELECT canonical_document FROM occ.repository_work_operations_v2 WHERE ${where} AND operation_ref=$5`,
      [...keys, ref(operationRef)],
    );
    if (found.rows.length === 0) return { kind: "absent" };
    if (found.rows.length !== 1) return fail();
    const value = decode(found.rows[0], operation);
    if (!equal(value.scope, fixed) || value.operationRef !== operationRef) return fail();
    return { kind: "recorded", operation: value };
  };
  const appendOperation = async (
    original: WorkOriginalOperationV2,
    kind: RepositoryWorkOperationV2["kind"],
    document: unknown,
  ) => {
    if (
      original.scope.installationRef !== fixed.installationId ||
      original.scope.namespaceRef !== fixed.namespaceId ||
      original.scope.agentRef !== fixed.agentId ||
      original.scope.revisionRef !== fixed.revisionRef
    )
      return fail();
    const value: RepositoryWorkOperationV2 = {
      operationRef: ref(original.operationRef),
      requestDigest: repositoryRequestDigest(original.requestDigest),
      invocationRef: ref(original.invocationRef),
      scope: fixed,
      commitRef: commit,
      kind,
      document: json(document),
    };
    const encoded = canonicalRepositoryWorkV2(value);
    const result = await query(
      `INSERT INTO occ.repository_work_operations_v2 (installation_id,namespace_id,agent_id,revision_ref,operation_ref,request_digest,invocation_ref,commit_ref,kind,canonical_document) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING canonical_document`,
      [
        ...keys,
        value.operationRef,
        value.requestDigest,
        value.invocationRef,
        commit,
        kind,
        encoded,
      ],
    );
    if (result.rows.length !== 1 || !equal(decode(result.rows[0], operation), value)) return fail();
  };
  const readChain = async (workRef: string): Promise<RepositoryWorkReadsetV2> => {
    // The Installation capacity lock serializes creation/closure in this scope;
    // discover exact parent references first, then lock the root-to-own chain.
    const chain: RepositoryWorkRecordV2[] = [];
    const visited = new Set<string>();
    let next: string | null = ref(workRef);
    while (next !== null) {
      if (visited.has(next) || chain.length >= 64) return fail();
      visited.add(next);
      const found = await query(
        `SELECT canonical_document FROM occ.repository_work_heads_v2 WHERE ${where} AND work_ref=$5`,
        [...keys, next],
      );
      if (found.rows.length !== 1) return fail();
      const value = decode(found.rows[0], record);
      if (!equal(value.scope, fixed) || value.workRef !== next) return fail();
      chain.unshift(value);
      next = value.parentWorkRef;
    }
    const root = chain[0];
    if (
      !root ||
      root.parentWorkRef !== null ||
      chain.some((value) => value.rootWorkRef !== root.workRef)
    )
      return fail();
    for (const value of chain) {
      const locked = await query(
        `SELECT canonical_document FROM occ.repository_work_heads_v2 WHERE ${where} AND work_ref=$5 FOR UPDATE`,
        [...keys, value.workRef],
      );
      if (locked.rows.length !== 1 || !equal(decode(locked.rows[0], record), value)) return fail();
    }
    return Object.freeze({ scope: fixed, lineage: Object.freeze(chain) });
  };
  return Object.freeze({
    findOperation,
    readChain,
    async admit(original: WorkOriginalOperationV2, candidate: RepositoryWorkAdmissionV2) {
      const value = record(candidate.record);
      if (
        !equal(value.scope, fixed) ||
        value.revision !== 1 ||
        value.withdrawalRevision !== 0 ||
        value.state !== "open"
      )
        return fail();
      if (value.parentWorkRef !== null) {
        const parents = await readChain(value.parentWorkRef);
        if (
          parents.lineage[0]?.workRef !== value.rootWorkRef ||
          parents.lineage.some(
            (parent) =>
              parent.state !== "open" ||
              Date.parse(parent.originalHorizon) < Date.parse(value.originalHorizon),
          )
        )
          return fail();
      }
      const encoded = canonicalRepositoryWorkV2(value);
      const inserted = await query(
        `INSERT INTO occ.repository_work_heads_v2 (installation_id,namespace_id,agent_id,revision_ref,work_ref,parent_work_ref,root_work_ref,revision,withdrawal_revision,state,canonical_document) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING canonical_document`,
        [
          ...keys,
          value.workRef,
          value.parentWorkRef,
          value.rootWorkRef,
          value.revision,
          value.withdrawalRevision,
          value.state,
          encoded,
        ],
      );
      if (inserted.rows.length !== 1 || !equal(decode(inserted.rows[0], record), value))
        return fail();
      await appendOperation(original, "admission", candidate);
    },
    async close(
      original: WorkOriginalOperationV2,
      readset: RepositoryWorkReadsetV2,
      input: RepositoryWorkClosureV2,
    ) {
      const own = readset.lineage.at(-1);
      if (
        !own ||
        own.workRef !== input.workRef ||
        own.revision !== input.expectedRevision ||
        own.withdrawalRevision !== input.expectedWithdrawalRevision ||
        own.state !== "open"
      )
        return fail();
      if (!["completed", "cancelled", "failed", "withdrawn"].includes(input.cause)) return fail();
      ref(input.evidenceRef);
      const value = {
        ...own,
        revision: positive(own.revision + 1),
        withdrawalRevision:
          input.cause === "withdrawn"
            ? positive(own.withdrawalRevision + 1)
            : own.withdrawalRevision,
        state: "closed" as const,
      };
      const updated = await query(
        `UPDATE occ.repository_work_heads_v2 SET revision=$6,withdrawal_revision=$7,state='closed',canonical_document=$8 WHERE ${where} AND work_ref=$5 AND revision=$9 AND withdrawal_revision=$10 AND state='open' RETURNING canonical_document`,
        [
          ...keys,
          own.workRef,
          value.revision,
          value.withdrawalRevision,
          canonicalRepositoryWorkV2(value),
          own.revision,
          own.withdrawalRevision,
        ],
      );
      if (updated.rows.length !== 1 || !equal(decode(updated.rows[0], record), value))
        return fail();
      await appendOperation(original, "closure", input);
    },
    async prepare(original: WorkOriginalOperationV2, input: RepositoryWorkPreparationV2) {
      await appendOperation(original, "preparation", preparation(input));
    },
    async dispatch(original: WorkOriginalOperationV2, input: RepositoryWorkDispatchV2) {
      const value = dispatch(input);
      const preparation = await findOperation(value.preparationOperationRef);
      if (preparation.kind !== "recorded" || preparation.operation.kind !== "preparation")
        return fail();
      const prepared = object(preparation.operation.document);
      for (const key of [
        "workRef",
        "workRevision",
        "requestDigest",
        "receiverRef",
        "sessionRef",
        "dnsBindingRef",
        "repositoryTarget",
      ] as const)
        if (!equal(prepared[key], value[key])) return fail();
      if (
        Object.hasOwn(prepared, "repositoryRequest") !==
          Object.hasOwn(value, "repositoryRequest") ||
        (Object.hasOwn(value, "repositoryRequest") &&
          !equal(prepared.repositoryRequest, value.repositoryRequest))
      )
        return fail();
      const encoded = canonicalRepositoryWorkV2(value);
      const inserted = await query(
        `INSERT INTO occ.repository_work_releases_v2 (installation_id,namespace_id,agent_id,revision_ref,operation_ref,preparation_operation_ref,release_ref,receiver_ref,inventory_record_ref,inventory_version,commit_ref,canonical_document) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING canonical_document`,
        [
          ...keys,
          ref(original.operationRef),
          value.preparationOperationRef,
          value.releaseRef,
          value.receiverRef,
          value.inventoryRecordRef,
          value.inventoryVersion,
          commit,
          encoded,
        ],
      );
      if (inserted.rows.length !== 1 || !equal(decode(inserted.rows[0], dispatch), value))
        return fail();
      await appendOperation(original, "dispatch", value);
    },
    async observe(original: WorkOriginalOperationV2, input: RepositoryWorkObservationV2) {
      const target = await findOperation(input.dispatchOperationRef);
      if (target.kind !== "recorded" || target.operation.kind !== "dispatch") return fail();
      ref(input.observationRef);
      ref(input.evidenceRef);
      if (!["not-dispatched", "completed", "unknown"].includes(input.outcome)) return fail();
      // Initial dispatch/unknown history is immutable; observations are separate.
      await appendOperation(original, "observation", input);
    },
  });
}

/** The original State execute owns raw COMMIT and invokes these hooks in its
 * existing credential phase. This is an internal constructor operand. */
export interface RepositoryWorkExecutionV2 {
  readonly commitRef: string;
  /** Private fresh-use owner only. Expiry invalidates authority immediately;
   * already-entered physical use drains before original SQL rollback/release. */
  readonly submittedUse?: { held(): boolean; invalidate(): void };
  readonly phase: import("../../ports/platform-unit-of-work.ts").CredentialInventoryOwnerPhaseV1;
  prepareCommit(): Promise<void>;
  assertCommitReady(): void;
  observeAcknowledgment(): void;
  close(): void;
  disposition: "not-sent" | "sent" | "acknowledged";
  establishedNoCommit: boolean;
}
export interface RepositoryWorkBackendV2 {
  readonly context: QueryRepositoryFactoryContext;
  /** Private exact State transaction pending set; no new work callback. */
  joinAccepted(pending: Promise<unknown>): undefined;
  readRuntimeAllocation?(
    assignmentRef: string,
  ): Promise<import("@openclaw-enterprise/contracts").RuntimeAllocation | undefined>;
  inventory(phase: {
    assertPreparing(stage: "scope" | "keys"): void;
    assertActive(): void;
    assertWriting(): void;
    poison(error: unknown): void;
    recordEffect(
      effect: import("../../credential-inventory-v1/postgres.ts").PostgresCredentialInventoryEffectV1,
    ): void;
  }): RepositoryLeaseInventoryTransactionV2;
  appendAudit(actorId: string, operationRef: string, kind: string): Promise<void>;
}
export type RepositoryWorkEnterV2 = <T>(
  scope: RepositoryWorkScopeV2,
  bounds: { readonly signal: AbortSignal; readonly timeoutMs: number },
  execution: RepositoryWorkExecutionV2,
  body: (backend: RepositoryWorkBackendV2) => Promise<T>,
) => Promise<T>;

interface Held {
  readonly raw: RepositoryWorkHeldLeaseV2;
  readonly assertCurrent: () => undefined;
  readonly prepareCommit: () => Promise<void>;
}
interface Enrollment {
  readonly original: WorkOriginalOperationV2;
  readonly originalCanonical: string;
  readonly call: AuthorityCallV1;
  readonly context: RepositoryWorkTransactionContextV2;
  readonly phase: import("../../ports/platform-unit-of-work.ts").CredentialInventoryOwnerPhaseV1;
  readonly backend: RepositoryWorkBackendV2;
  readonly scope: RepositoryWorkScopeV2;
  readonly held: Map<object, Held>;
  readonly releases: (() => Promise<void>)[];
  readonly pending: Set<Promise<void>>;
  active: boolean;
  accepting: boolean;
  checking: boolean;
  stage: "source" | "scope" | "policy" | "work" | "writing" | "finalizing" | "closed";
  readset?: RepositoryWorkReadsetV2;
  readWork?: VersionedWorkRefV2;
  readExecution?: WorkExecutionAssociationV2;
  written?: RepositoryWorkOperationV2["kind"] | "inventory";
  inventoryInput?: RepositoryTokenMutationV2;
  inventoryResult?: RepositoryInventoryOperationV2;
  release?: RepositoryWorkDispatchV2;
  receiver?: object;
  session?: object;
  inventory?: RepositoryLeaseInventoryTransactionV2;
  readonly inventoryEffects: PostgresCredentialInventoryEffectV1[];
  qualifyRelease?: (dispatch: RepositoryWorkDispatchV2) => Promise<void>;
  qualifyMint?: (operation: RepositoryInventoryOperationV2) => Promise<void>;
  qualifyRevocation?: (operation: RepositoryInventoryOperationV2) => Promise<void>;
  releaseUntil?: number;
  actorId?: string;
  policyAcquired?: boolean;
  policyReady?: boolean;
  readsetQualified?: boolean;
  readsetAcquired?: boolean;
  inventoryCurrent?: RepositoryWorkInventoryCurrentV2;
}

export function createPostgresRepositoryWorkBindingV2(
  enter: RepositoryWorkEnterV2,
  createPhase: () => import("../../ports/platform-unit-of-work.ts").CredentialInventoryOwnerPhaseV1,
  selectedContexts?: RepositoryWorkSelectedExecutionContextsV2,
): RepositoryWorkStateBindingV2 {
  const members = new WeakMap<object, Enrollment>();
  const committed = new WeakMap<
    object,
    {
      value: RepositoryWorkCommittedReleaseV2;
      receiver: object;
      session: object;
      original: WorkOriginalOperationV2;
      work: VersionedWorkRefV2;
      execution: WorkExecutionAssociationV2;
      useStarted: boolean;
    }
  >();
  const inventoryCommits = new WeakMap<
    object,
    {
      operation: RepositoryInventoryOperationV2;
      original: WorkOriginalOperationV2;
      work?: VersionedWorkRefV2;
      execution?: WorkExecutionAssociationV2;
      useStarted: boolean;
    }
  >();
  let acquireMint: RepositoryWorkStateParticipantV2["acquireCommittedMint"] | undefined;
  let acquireRevocation: RepositoryWorkStateParticipantV2["acquireCommittedRevocation"] | undefined;
  let acquireUse: RepositoryWorkStateParticipantV2["acquireCommittedRelease"] | undefined;
  const active = new AsyncLocalStorage<Enrollment>();
  const submittedUses = new AsyncLocalStorage<
    NonNullable<RepositoryWorkExecutionV2["submittedUse"]>
  >();
  const custodyOperation = new AsyncLocalStorage<{
    readonly enrollment: Enrollment;
    active: boolean;
  }>();
  let bound = false;
  function reject(entry: Enrollment): never {
    const error = new ScopeViolationError(
      "The original repository Work participant is unavailable.",
    );
    entry.phase.poison(error);
    throw error;
  }
  const assertEntry = (entry: Enrollment, acquisition = true) => {
    if (
      !entry.active ||
      active.getStore() !== entry ||
      entry.checking ||
      (acquisition && !entry.accepting)
    )
      reject(entry);
    entry.phase.assertActive();
  };
  const tracked = <T>(entry: Enrollment, promise: Promise<T>): Promise<T> => {
    const completion = promise.then(
      () => {},
      (error) => entry.phase.poison(error),
    );
    entry.pending.add(completion);
    void completion.then(() => entry.pending.delete(completion));
    return promise;
  };
  const retain = (entry: Enrollment, raw: RepositoryWorkHeldLeaseV2) => {
    // Cleanup transfer from an already-entered acquisition remains open until
    // that acquisition and the original transaction have both been joined.
    if (
      !entry.active ||
      active.getStore() !== entry ||
      entry.checking ||
      !raw ||
      typeof raw !== "object"
    )
      reject(entry);
    const existing = entry.held.get(raw);
    if (existing) return existing;
    const release = raw.release;
    if (typeof release !== "function") reject(entry);
    entry.releases.push(() => Promise.resolve(Reflect.apply(release, raw, [])));
    const check = raw.assertCurrent;
    const prepare = raw.prepareCommit;
    if (typeof check !== "function" || typeof prepare !== "function") reject(entry);
    const held: Held = Object.freeze({
      raw,
      assertCurrent: () => Reflect.apply(check, raw, []),
      prepareCommit: () => Reflect.apply(prepare, raw, []),
    });
    entry.held.set(raw, held);
    return held;
  };
  const fence = (entry: Enrollment) => {
    if (!entry.active || entry.checking) reject(entry);
    entry.phase.assertActive();
    if (canonicalRepositoryWorkV2(entry.original) !== entry.originalCanonical) reject(entry);
    if (entry.releaseUntil !== undefined && Date.now() >= entry.releaseUntil) reject(entry);
    entry.checking = true;
    try {
      for (const held of entry.held.values()) {
        const value: unknown = held.assertCurrent();
        if (value !== undefined) {
          entry.context.joinAccepted(Promise.resolve(value));
          reject(entry);
        }
      }
      entry.phase.assertActive();
    } catch (error) {
      entry.phase.poison(error);
      throw error;
    } finally {
      entry.checking = false;
    }
  };
  const inCustody = async <T>(entry: Enrollment, work: () => Promise<T>): Promise<T> => {
    const token = { enrollment: entry, active: true };
    try {
      return await custodyOperation.run(token, work);
    } finally {
      token.active = false;
    }
  };
  const participant = Object.freeze<RepositoryWorkStateParticipantV2>({
    assertOriginal(context, original, call) {
      const entry = members.get(context);
      if (!entry) {
        const origin = active.getStore();
        if (origin) reject(origin);
        fail();
      }
      assertEntry(entry);
      if (
        entry.original !== original ||
        entry.call.context !== call.context ||
        entry.call.requestRef !== call.requestRef ||
        entry.call.recipientRef !== call.recipientRef ||
        entry.call.deadline !== call.deadline ||
        call.signal.aborted
      )
        reject(entry);
      return undefined;
    },
    acquireCurrentReadset(context, original, call, work, execution) {
      try {
        participant.assertOriginal(context, original, call);
        const entry = members.get(context)!;
        if (
          entry.stage !== "policy" ||
          !entry.policyReady ||
          entry.readsetAcquired ||
          entry.readset
        )
          reject(entry);
        entry.readsetAcquired = true;
        const selectedWork = json(work),
          selectedExecution = json(execution);
        return tracked(
          entry,
          (async () => {
            const repository = createPostgresRepositoryWorkV2(
              entry.backend.context,
              entry.scope,
              entry.inventory!.commitRef,
            );
            const readset = await repository.readChain(work.workRef);
            assertEntry(entry);
            const own = readset.lineage.at(-1);
            if (
              entry.stage !== "policy" ||
              !own ||
              own.revision !== work.revision ||
              !equal(own.execution, selectedExecution) ||
              !equal(work, selectedWork) ||
              readset.lineage.some(
                (row) => row.state !== "open" || Date.parse(row.originalHorizon) <= Date.now(),
              )
            )
              reject(entry);
            entry.readset = readset;
            entry.readWork = work;
            entry.readExecution = execution;
            let held = true;
            const check = (): undefined => {
              if (!held || !entry.active) reject(entry);
              entry.phase.assertActive();
              return undefined;
            };
            const lease = Object.freeze({
              readset,
              assertCurrent: check,
              async prepareCommit() {
                check();
              },
              async release() {
                held = false;
              },
            });
            retain(entry, lease);
            check();
            return lease;
          })(),
        );
      } catch (error) {
        active.getStore()?.phase.poison(error);
        const result = Promise.reject<never>(error);
        void result.catch(() => {});
        return result;
      }
    },
    acquireCurrentPolicy(context, original, call, policyRef) {
      try {
        participant.assertOriginal(context, original, call);
        const entry = members.get(context)!;
        if (entry.stage !== "policy" || entry.policyAcquired) reject(entry);
        entry.policyAcquired = true;
        const exactRef = ref(policyRef);
        return tracked(
          entry,
          (async () => {
            const repository = createPostgresRepositoryWorkPolicyV2(
              entry.backend.context,
              entry.scope,
              entry.inventory!.commitRef,
            );
            const stored = await repository.find(exactRef);
            assertEntry(entry);
            if (entry.stage !== "policy" || !stored) reject(entry);
            let live = true;
            const check = (): undefined => {
              // Query-free: the same transaction still owns I/N/A and head SHARE.
              // Work owns semantic version/profile/time comparison of this document.
              if (!live || !entry.active) reject(entry);
              entry.phase.assertActive();
              return undefined;
            };
            const lease = Object.freeze({
              policy: stored.document,
              assertCurrent: check,
              async prepareCommit() {
                check();
              },
              async release() {
                live = false;
              },
            });
            retain(entry, lease);
            check();
            entry.policyReady = true;
            return lease;
          })(),
        );
      } catch (error) {
        active.getStore()?.phase.poison(error);
        const rejected = Promise.reject<never>(error);
        void rejected.catch(() => {});
        return rejected;
      }
    },
    assertInventoryCurrent(context, original, call, current) {
      participant.assertOriginal(context, original, call);
      const entry = members.get(context)!;
      if (entry.stage !== "work" || entry.inventoryCurrent !== current) reject(entry);
      return undefined;
    },
    inventory(context) {
      const entry = members.get(context);
      if (!entry) {
        const origin = active.getStore();
        if (origin) reject(origin);
        fail();
      }
      assertEntry(entry, false);
      const token = custodyOperation.getStore();
      if (
        !token?.active ||
        token.enrollment !== entry ||
        (entry.stage !== "work" && entry.stage !== "writing" && entry.stage !== "finalizing") ||
        !entry.inventory
      )
        reject(entry);
      return entry.inventory;
    },
    recognizeCommittedInventory(commit, original) {
      const entry = inventoryCommits.get(commit);
      if (!entry || entry.original !== original) fail();
      return entry.operation;
    },
    acquireCommittedMint(commit, call) {
      return acquireMint ? acquireMint(commit, call) : Promise.resolve(undefined);
    },
    acquireCommittedRevocation(commit, call) {
      return acquireRevocation ? acquireRevocation(commit, call) : Promise.resolve(undefined);
    },
    acquireCommittedRelease(commit, call, receiver, session) {
      if (!acquireUse) return Promise.resolve(undefined);
      return acquireUse(commit, call, receiver, session);
    },
    recognizeCommittedRelease(commit, releaseRef, receiver, session) {
      const entry = committed.get(commit);
      if (
        !entry ||
        entry.value.dispatch.releaseRef !== releaseRef ||
        entry.receiver !== receiver ||
        entry.session !== session
      )
        fail();
      return entry.value;
    },
  });
  return Object.freeze<RepositoryWorkStateBindingV2>({
    participant,
    bindOriginalSources(workSource, custodySource) {
      if (bound) fail();
      const acquireWork = workSource?.acquire;
      const acquireCustody = custodySource?.acquire;
      if (typeof acquireWork !== "function" || typeof acquireCustody !== "function") fail();
      bound = true;
      const run: RepositoryWorkStoreV2["run"] = async (original, call, bounds, body) => {
        const ambient = active.getStore();
        if (ambient) {
          ambient.phase.poison(
            new ScopeViolationError("Repository Work cannot nest transactions."),
          );
          return { kind: "not-committed" };
        }
        let entry: Enrollment | undefined;
        let value: Awaited<ReturnType<typeof body>> | undefined;
        let acknowledgedAt: string | undefined;
        let failed = false;
        let disposeSelectedContext: (() => void) | undefined;
        let finishSelectedRetired!: () => void;
        const selectedRetired = new Promise<void>((resolve) => {
          finishSelectedRetired = resolve;
        });
        const phase = createPhase();
        const commitRef = randomUUID();
        const fixedScope = scope({
          installationId: original.scope.installationRef,
          namespaceId: original.scope.namespaceRef,
          agentId: original.scope.agentRef,
          revisionRef: original.scope.revisionRef,
        });
        const originalData = canonicalRepositoryWorkV2(original);
        const execution: RepositoryWorkExecutionV2 = {
          phase,
          commitRef,
          ...(submittedUses.getStore() ? { submittedUse: submittedUses.getStore()! } : {}),
          disposition: "not-sent",
          establishedNoCommit: false,
          async prepareCommit() {
            const current = entry;
            if (!current) fail();
            current.accepting = false;
            current.stage = "finalizing";
            while (current.pending.size) await Promise.all([...current.pending]);
            fence(current);
            for (const held of current.held.values()) {
              await active.run(current, () => inCustody(current, () => held.prepareCommit()));
              fence(current);
            }
            while (current.pending.size) await Promise.all([...current.pending]);
            const effects = current.inventoryEffects;
            const operations = effects.filter(
              (effect) => effect.kind === "repository-operation-appended",
            );
            for (const effect of effects) {
              if (effect.kind === "repository-operation-appended") {
                if (
                  effect.operation.commitRef !== commitRef ||
                  !equal(effect.operation.input.scope, {
                    installationId: current.scope.installationId,
                    namespaceId: current.scope.namespaceId,
                    agentId: current.scope.agentId,
                  })
                )
                  reject(current);
                const writes = effects.filter(
                  (other) =>
                    (other.kind === "repository-record-inserted" ||
                      other.kind === "repository-record-replaced") &&
                    equal(other.record, effect.operation.record),
                );
                if (writes.length !== 1) reject(current);
                const write = writes[0]!;
                const input = effect.operation.input;
                const result = effect.operation.record;
                if (input.method === "reserveRepositoryToken") {
                  if (
                    write.kind !== "repository-record-inserted" ||
                    result.state !== "reserved" ||
                    result.inventoryVersion !== 1 ||
                    !equal(result.issuance, input)
                  )
                    reject(current);
                } else {
                  if (
                    write.kind !== "repository-record-replaced" ||
                    write.expectedVersion !== input.expectedInventoryVersion ||
                    result.inventoryVersion !== input.expectedInventoryVersion + 1 ||
                    !equal(result.target, input.target)
                  )
                    reject(current);
                  switch (input.method) {
                    case "claimRepositoryMint":
                      if (
                        result.state !== "mint-unknown" ||
                        result.providerAttemptRef !== input.providerAttemptRef
                      )
                        reject(current);
                      break;
                    case "recordRepositoryMint":
                      if (
                        result.state === "reserved" ||
                        result.providerAttemptRef !== input.providerAttemptRef
                      )
                        reject(current);
                      if (input.outcome === "accepted") {
                        if (
                          result.state !== "outstanding" ||
                          result.tokenRef !== input.tokenRef ||
                          result.protectedRevocationRef !== input.protectedRevocationRef ||
                          !equal(result.returnedPermissions, input.returnedPermissions) ||
                          result.evidenceRef !== input.evidenceRef
                        )
                          reject(current);
                      } else if (input.outcome === "unknown") {
                        if (result.state !== "mint-unknown") reject(current);
                      } else if (
                        result.state !== "not-issued" ||
                        result.evidenceRef !== input.evidenceRef
                      )
                        reject(current);
                      break;
                    case "claimRepositoryRevocation":
                      if (
                        result.state !== "outstanding" ||
                        result.tokenRef !== input.tokenRef ||
                        result.protectedRevocationRef !== input.protectedRevocationRef ||
                        result.revocation?.state !== "claimed" ||
                        result.revocation.revocationOperationRef !== input.revocationOperationRef
                      )
                        reject(current);
                      break;
                    case "recordRepositoryRevocation": {
                      const cleanup = result.revocation;
                      if (
                        !cleanup ||
                        cleanup.state === "claimed" ||
                        cleanup.state !== input.outcome ||
                        cleanup.revocationOperationRef !== input.revocationOperationRef ||
                        cleanup.providerAttemptRef !== input.providerAttemptRef ||
                        cleanup.claimRef !== input.claimRef ||
                        cleanup.claimVersion !== input.claimVersion ||
                        cleanup.evidenceRef !== input.evidenceRef ||
                        cleanup.observedAt !== input.observedAt
                      )
                        reject(current);
                      if (input.outcome === "confirmed") {
                        if (
                          result.state !== "resolved-without-token" ||
                          result.evidenceRef !== input.evidenceRef
                        )
                          reject(current);
                      } else if (
                        result.state !== "outstanding" ||
                        result.tokenRef !== input.tokenRef ||
                        result.protectedRevocationRef !== input.protectedRevocationRef
                      )
                        reject(current);
                      break;
                    }
                    case "retireRepositoryToken":
                      if (
                        result.state !== "outstanding" ||
                        result.disposition !== "mitigation-only" ||
                        result.evidenceRef !== input.evidenceRef
                      )
                        reject(current);
                      break;
                    case "resolveRepositoryToken":
                      if (input.outcome === "definitely-not-dispatched") {
                        if (
                          result.state !== "not-issued" ||
                          result.providerAttemptRef !== null ||
                          result.evidenceRef !== input.evidenceRef
                        )
                          reject(current);
                      } else if (
                        result.state !== "resolved-without-token" ||
                        result.evidenceRef !== input.evidenceRef
                      )
                        reject(current);
                      break;
                  }
                }
                const mintClaims = effects.filter(
                  (other) => other.kind === "repository-mint-claim-inserted",
                );
                const cleanupClaims = effects.filter(
                  (other) => other.kind === "repository-revocation-claim-appended",
                );
                if (
                  mintClaims.length !==
                    (effect.operation.input.method === "claimRepositoryMint" ? 1 : 0) ||
                  cleanupClaims.length !==
                    (effect.operation.input.method === "claimRepositoryRevocation" ? 1 : 0)
                )
                  reject(current);
              } else if (
                effect.kind === "repository-record-inserted" ||
                effect.kind === "repository-record-replaced"
              ) {
                if (
                  operations.filter((other) => equal(other.operation.record, effect.record))
                    .length !== 1
                )
                  reject(current);
              } else if (effect.kind === "repository-lease-inserted") {
                if (
                  !operations.some(
                    (other) =>
                      other.operation.input.method === "reserveRepositoryToken" &&
                      equal(other.operation.input.lease, effect.lease),
                  )
                )
                  reject(current);
              } else if (effect.kind === "repository-mint-claim-inserted") {
                if (
                  operations.filter(
                    (other) =>
                      other.operation.input.method === "claimRepositoryMint" &&
                      effect.claim.schemaVersion === 2 &&
                      other.operation.input.providerAttemptRef ===
                        effect.claim.providerAttemptRef &&
                      other.operation.record.state === "mint-unknown" &&
                      other.operation.record.providerAttemptRef ===
                        effect.claim.providerAttemptRef &&
                      other.operation.record.target.recordRef === effect.claim.recordRef &&
                      other.operation.record.target.issuanceOperationRef ===
                        effect.claim.issuanceOperationRef &&
                      other.operation.record.target.intentDigest ===
                        effect.claim.issuanceIntentDigest &&
                      other.operation.input.operationRef === effect.claim.useOperationRef &&
                      other.operation.digest === effect.claim.useIntentDigest &&
                      other.operation.record.inventoryVersion === effect.claim.inventoryVersion &&
                      equal(other.operation.input.custodyIdentity, effect.claim.custodyIdentity),
                  ).length !== 1
                )
                  reject(current);
              } else if (effect.kind === "repository-revocation-claim-appended") {
                if (
                  operations.filter((other) => {
                    const cleanup = other.operation.record.revocation;
                    return (
                      other.operation.input.method === "claimRepositoryRevocation" &&
                      effect.claim.schemaVersion === 2 &&
                      equal(other.operation.input, effect.claim.input) &&
                      cleanup?.state === "claimed" &&
                      cleanup.revocationOperationRef ===
                        effect.claim.input.revocationOperationRef &&
                      other.operation.record.state === "outstanding" &&
                      other.operation.record.tokenRef === effect.claim.input.tokenRef &&
                      other.operation.record.protectedRevocationRef ===
                        effect.claim.input.protectedRevocationRef &&
                      cleanup.claimRef === effect.claim.claimRef &&
                      cleanup.claimVersion === effect.claim.claimVersion &&
                      cleanup.version === effect.claim.claimVersion &&
                      cleanup.providerAttemptRef === effect.claim.providerAttemptRef &&
                      cleanup.claimedAt === effect.claim.claimedAt &&
                      cleanup.claimNotAfter === effect.claim.claimNotAfter
                    );
                  }).length !== 1
                )
                  reject(current);
              } else reject(current);
            }
            if (effects.length && current.written !== "dispatch" && current.written !== "inventory")
              reject(current);
            if (current.written === "inventory") {
              if (
                !current.inventoryInput ||
                !current.inventoryResult ||
                operations.length !== 1 ||
                !equal(operations[0]?.operation, current.inventoryResult) ||
                !equal(current.inventoryResult.input, current.inventoryInput) ||
                current.inventoryInput.operationRef !== original.operationRef
              )
                reject(current);
            }
            for (const effect of operations) {
              await current.backend.appendAudit(
                ref(current.actorId),
                effect.operation.input.operationRef,
                `inventory.${effect.operation.input.method}`,
              );
              fence(current);
            }
            phase.assertActive();
          },
          assertCommitReady() {
            if (!entry || entry.pending.size) fail();
            fence(entry);
          },
          observeAcknowledgment() {
            acknowledgedAt = new Date().toISOString();
          },
          close() {
            if (entry) {
              entry.accepting = false;
              entry.stage = "closed";
            }
          },
        };
        try {
          if (
            bounds.signal.aborted ||
            call.signal.aborted ||
            !Number.isFinite(bounds.timeoutMs) ||
            bounds.timeoutMs <= 0 ||
            bounds.timeoutMs > 3000 ||
            Date.parse(call.deadline) <= Date.now()
          )
            fail();
          value = await enter(fixedScope, bounds, execution, async (backend) => {
            const context = Object.freeze<RepositoryWorkTransactionContextV2>({
              installationId: fixedScope.installationId,
              assertActive: () => {
                if (!entry) fail();
                assertEntry(entry);
                backend.context.transaction.assertActive();
                return undefined;
              },
              retain: (lease) => {
                if (!entry) fail();
                retain(entry, lease);
                return undefined;
              },
              joinAccepted(pending) {
                if (
                  !entry ||
                  this !== context ||
                  !entry.active ||
                  !types.isPromise(pending) ||
                  (!entry.checking && active.getStore() !== entry)
                ) {
                  if (entry) reject(entry);
                  fail();
                }
                // Preserve completion ownership before a callback's synchronous
                // cancellation/poison can refuse operation permission. The exact
                // receiver/private context/Promise checks above still apply.
                backend.joinAccepted(pending);
                tracked(entry, pending);
                if (!entry.checking) entry.phase.assertOperationActive();
                if (entry.checking)
                  entry.phase.poison(
                    new ScopeViolationError("Asynchronous currentness is unavailable."),
                  );
                return undefined;
              },
            });
            const current: Enrollment = {
              original,
              originalCanonical: originalData,
              call,
              context,
              phase,
              backend,
              scope: fixedScope,
              held: new Map(),
              releases: [],
              pending: new Set(),
              active: true,
              accepting: true,
              checking: false,
              stage: "source",
              inventoryEffects: [],
            };
            entry = current;
            members.set(context, current);
            const repository = createPostgresRepositoryWorkV2(
              backend.context,
              fixedScope,
              commitRef,
            );
            const repositoryInventory = backend.inventory({
              assertPreparing: (stage) => {
                assertEntry(current, false);
                if (stage === "scope" ? current.stage !== "scope" : current.stage !== "work")
                  reject(current);
              },
              assertActive: () => {
                assertEntry(current, false);
                phase.assertOperationActive();
              },
              assertWriting: () => {
                assertEntry(current, false);
                if (current.stage !== "writing" && current.stage !== "finalizing") reject(current);
              },
              poison: (error) => phase.poison(error),
              recordEffect: (effect) => {
                if (
                  (current.stage !== "writing" && current.stage !== "finalizing") ||
                  current.inventoryEffects.length >= 64
                )
                  reject(current);
                current.inventoryEffects.push(effect);
              },
            });
            const borrow = <Args extends unknown[], Result>(
              invoke: (...args: Args) => Promise<Result>,
            ) => {
              const captured = invoke.bind(repositoryInventory);
              return (...args: Args): Promise<Result> => {
                try {
                  participant.inventory(context);
                  phase.assertOperationActive();
                  return tracked(current, captured(...args));
                } catch (error) {
                  phase.poison(error);
                  const rejected = Promise.reject<Result>(error);
                  void rejected.catch(() => {});
                  return rejected;
                }
              };
            };
            current.inventory = Object.freeze<RepositoryLeaseInventoryTransactionV2>({
              commitRef,
              assertActive: () => {
                participant.inventory(context);
                phase.assertOperationActive();
              },
              findLease: borrow(repositoryInventory.findLease),
              insertLease: borrow(repositoryInventory.insertLease),
              findRecord: borrow(repositoryInventory.findRecord),
              findOperation: borrow(repositoryInventory.findOperation),
              listLeaseRecords: borrow(repositoryInventory.listLeaseRecords),
              capacity: borrow(repositoryInventory.capacity),
              insertRecord: borrow(repositoryInventory.insertRecord),
              replaceRecord: borrow(repositoryInventory.replaceRecord),
              appendOperation: borrow(repositoryInventory.appendOperation),
              findMintClaim: borrow(repositoryInventory.findMintClaim),
              insertMintClaim: borrow(repositoryInventory.insertMintClaim),
              findRevocationClaim: borrow(repositoryInventory.findRevocationClaim),
              appendRevocationClaim: borrow(repositoryInventory.appendRevocationClaim),
            });
            current.qualifyRelease = async (fixed) => {
              const own = current.readset?.lineage.at(-1);
              if (!own) reject(current);
              requirePreparationProfile(own, fixed);
              const inventoryRecord = await repositoryInventory.findRecord(
                fixed.inventoryRecordRef,
              );
              const access = await repositoryInventory.findLease(fixed.accessLeaseRef);
              if (
                !inventoryRecord ||
                !access ||
                inventoryRecord.inventoryVersion !== fixed.inventoryVersion ||
                inventoryRecord.state !== "outstanding" ||
                inventoryRecord.disposition !== "current-check-required" ||
                inventoryRecord.issuance.lease.accessLeaseRef !== fixed.accessLeaseRef ||
                !equal(inventoryRecord.issuance.lease, access) ||
                !equal(access.target, fixed.repositoryTarget) ||
                access.work.workRef !== fixed.workRef ||
                access.work.revision !== fixed.workRevision ||
                !equal(access.execution, current.readExecution) ||
                access.original.requestDigest !== fixed.requestDigest ||
                inventoryRecord.expiry.kind !== "provider-expiry" ||
                Date.parse(inventoryRecord.expiry.expiresAt) <= Date.now() ||
                Date.parse(access.notAfter) <= Date.now()
              )
                reject(current);
              current.releaseUntil = Math.min(
                Date.parse(access.notAfter),
                Date.parse(inventoryRecord.expiry.expiresAt),
              );
              fence(current);
            };
            return active.run(current, () =>
              phase.runTransition(async () => {
                let source: RepositoryWorkSourceLeaseV2;
                let custody: RepositoryWorkCustodyLeaseV2;
                let methods:
                  | {
                      actorId: string;
                      qualifyReadset: RepositoryWorkSourceLeaseV2["qualifyReadset"];
                      qualifyAdmission: RepositoryWorkSourceLeaseV2["qualifyAdmission"];
                      qualifyClosure: RepositoryWorkSourceLeaseV2["qualifyClosure"];
                      qualifyObservation: RepositoryWorkSourceLeaseV2["qualifyObservation"];
                      stageRelease: RepositoryWorkCustodyLeaseV2["stageRelease"];
                      receiverRef: string;
                      sessionRef: string;
                      inventory: RepositoryWorkSourceLeaseV2["qualifyInventory"];
                      inventoryRead: RepositoryWorkSourceLeaseV2["qualifyInventoryRead"];
                      inventoryCurrent: RepositoryWorkSourceLeaseV2["qualifyInventoryCurrent"];
                      custodyInventory: RepositoryWorkCustodyLeaseV2["qualifyInventory"];
                      custodyInventoryRead: RepositoryWorkCustodyLeaseV2["qualifyInventoryRead"];
                      custodyInventoryCurrent: RepositoryWorkCustodyLeaseV2["qualifyInventoryCurrent"];
                      inventoryClock: RepositoryWorkCustodyLeaseV2["inventoryClock"];
                      mint: RepositoryWorkSourceLeaseV2["qualifyMintUse"];
                      custodyMint: RepositoryWorkCustodyLeaseV2["qualifyMintUse"];
                      revocation: RepositoryWorkSourceLeaseV2["qualifyRevocationUse"];
                      custodyRevocation: RepositoryWorkCustodyLeaseV2["qualifyRevocationUse"];
                    }
                  | undefined;
                await phase.runAcceptance(async () => {
                  if (selectedContexts) {
                    disposeSelectedContext = selectedContexts.enrollWorkContext(
                      backend,
                      execution,
                      context,
                      original,
                      call,
                      () => {
                        phase.poison(
                          new ScopeViolationError("The original selected Work use was retired."),
                        );
                        execution.close();
                      },
                      selectedRetired,
                      () => {
                        assertEntry(current);
                        if (current.stage !== "policy") reject(current);
                      },
                    );
                    // Retain only the native/source/preparation prefix here.
                    // Live A/policy/Work currentness remains absent until prepareUse.
                    await tracked(
                      current,
                      selectedContexts.acquireWorkTransfer(context, original, call),
                    );
                  }
                  source = await Reflect.apply(acquireWork, workSource, [context, original, call]);
                  retain(current, source);
                  const actorId = ref(source.actorId);
                  current.actorId = actorId;
                  const prepareUse = source.prepareUse;
                  const qualifyReadset = source.qualifyReadset;
                  const qualifyAdmission = source.qualifyAdmission;
                  const qualifyClosure = source.qualifyClosure;
                  const qualifyObservation = source.qualifyObservation;
                  const inventory = source.qualifyInventory,
                    inventoryRead = source.qualifyInventoryRead,
                    inventoryCurrent = source.qualifyInventoryCurrent,
                    mint = source.qualifyMintUse,
                    revocation = source.qualifyRevocationUse;
                  if (canonicalRepositoryWorkV2(original) !== originalData) reject(current);
                  custody = await inCustody(current, () =>
                    Reflect.apply(acquireCustody, custodySource, [context, original, call]),
                  );
                  retain(current, custody);
                  const stageRelease = custody.stageRelease;
                  const custodyInventory = custody.qualifyInventory,
                    custodyInventoryRead = custody.qualifyInventoryRead,
                    custodyInventoryCurrent = custody.qualifyInventoryCurrent,
                    custodyMint = custody.qualifyMintUse,
                    custodyRevocation = custody.qualifyRevocationUse;
                  const clock = custody.inventoryClock,
                    readClock = clock?.read;
                  const inventoryClock =
                    typeof readClock === "function"
                      ? Object.freeze({ read: () => Reflect.apply(readClock, clock, []) })
                      : undefined;
                  const receiver = custody.receiver;
                  const session = custody.session;
                  const receiverRef = ref(custody.receiverRef);
                  const sessionRef = ref(custody.sessionRef);
                  if (
                    !receiver ||
                    typeof receiver !== "object" ||
                    !session ||
                    typeof session !== "object" ||
                    [
                      prepareUse,
                      qualifyReadset,
                      qualifyAdmission,
                      qualifyClosure,
                      qualifyObservation,
                      stageRelease,
                    ].some((method) => typeof method !== "function")
                  )
                    reject(current);
                  current.receiver = receiver;
                  current.session = session;
                  methods = {
                    actorId,
                    qualifyReadset,
                    qualifyAdmission,
                    qualifyClosure,
                    qualifyObservation,
                    stageRelease,
                    receiverRef,
                    sessionRef,
                    inventory,
                    inventoryRead,
                    inventoryCurrent,
                    custodyInventory,
                    custodyInventoryRead,
                    custodyInventoryCurrent,
                    inventoryClock,
                    mint,
                    custodyMint,
                    revocation,
                    custodyRevocation,
                  };
                  fence(current);
                  current.stage = "scope";
                  for (const [statement, parameters, expected] of [
                    [
                      "SELECT id FROM occ.installation WHERE id=$1 FOR NO KEY UPDATE",
                      [fixedScope.installationId],
                      fixedScope.installationId,
                    ],
                    [
                      "SELECT id FROM occ.namespaces WHERE id=$1 FOR NO KEY UPDATE",
                      [fixedScope.namespaceId],
                      fixedScope.namespaceId,
                    ],
                    [
                      "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR NO KEY UPDATE",
                      [fixedScope.namespaceId, fixedScope.agentId],
                      fixedScope.agentId,
                    ],
                  ] as const) {
                    const found = await backend.context.query.query(statement, parameters);
                    if (
                      found.rowCount !== 1 ||
                      found.rows.length !== 1 ||
                      object(found.rows[0]).id !== expected
                    )
                      reject(current);
                    fence(current);
                  }
                  current.stage = "policy";
                  // The entered completion is captured once and joined under the
                  // original acceptance/terminal owner, including cancellation.
                  await tracked(
                    current,
                    Promise.resolve().then(async () => {
                      // Custody cleanup is captured and the real I/N/A locks
                      // are held. Complete the same selected use only here.
                      if (selectedContexts)
                        await selectedContexts.completeWorkTransfer(context, original, call);
                      await Reflect.apply(prepareUse, source, []);
                    }),
                  );
                  while (current.pending.size) await Promise.allSettled([...current.pending]);
                  fence(current);
                  current.stage = "work";
                  return true;
                });
                if (!methods) reject(current);
                const {
                  actorId,
                  qualifyReadset,
                  qualifyAdmission,
                  qualifyClosure,
                  qualifyObservation,
                  stageRelease,
                  receiverRef,
                  sessionRef,
                  inventory,
                  inventoryRead,
                  inventoryCurrent,
                  custodyInventory,
                  custodyInventoryRead,
                  custodyInventoryCurrent,
                  inventoryClock,
                  mint,
                  custodyMint,
                  revocation,
                  custodyRevocation,
                } = methods;
                current.qualifyMint = async (receipt) => {
                  if (
                    typeof mint !== "function" ||
                    typeof custodyMint !== "function" ||
                    receipt.input.method !== "claimRepositoryMint" ||
                    !current.readset
                  )
                    reject(current);
                  const record = await repositoryInventory.findRecord(
                    receipt.record.target.recordRef,
                  );
                  const claim = record
                    ? await repositoryInventory.findMintClaim(record.target.recordRef)
                    : undefined;
                  if (
                    !record ||
                    !claim ||
                    record.state !== "mint-unknown" ||
                    record.inventoryVersion !== receipt.record.inventoryVersion ||
                    record.providerAttemptRef !== receipt.input.providerAttemptRef ||
                    claim.providerAttemptRef !== receipt.input.providerAttemptRef ||
                    claim.useOperationRef !== original.operationRef ||
                    claim.useIntentDigest !== receipt.digest ||
                    !equal(claim.custodyIdentity, receipt.input.custodyIdentity) ||
                    !equal(record.issuance, receipt.record.issuance) ||
                    !equal(record.issuance.lease.work, current.readWork) ||
                    !equal(record.issuance.lease.execution, current.readExecution) ||
                    Date.parse(record.issuance.lease.notAfter) <= Date.now()
                  )
                    reject(current);
                  await Reflect.apply(mint, source!, [receipt, record, current.readset]);
                  fence(current);
                  await inCustody(current, () =>
                    Reflect.apply(custodyMint, custody!, [receipt, record, current.readset]),
                  );
                  fence(current);
                  current.releaseUntil = Date.parse(record.issuance.lease.notAfter);
                };
                current.qualifyRevocation = async (receipt) => {
                  if (
                    typeof revocation !== "function" ||
                    typeof custodyRevocation !== "function" ||
                    receipt.input.method !== "claimRepositoryRevocation"
                  )
                    reject(current);
                  const record = await repositoryInventory.findRecord(
                    receipt.record.target.recordRef,
                  );
                  const cleanup = record?.revocation;
                  const claim = cleanup
                    ? await repositoryInventory.findRevocationClaim(cleanup.claimRef)
                    : undefined;
                  if (
                    !record ||
                    !cleanup ||
                    !claim ||
                    record.state !== "outstanding" ||
                    record.disposition !== "mitigation-only" ||
                    cleanup.state !== "claimed" ||
                    !equal(record, receipt.record) ||
                    !equal(claim.input, receipt.input) ||
                    claim.claimRef !== cleanup.claimRef ||
                    claim.claimVersion !== cleanup.claimVersion ||
                    claim.providerAttemptRef !== cleanup.providerAttemptRef ||
                    claim.claimedAt !== cleanup.claimedAt ||
                    claim.claimNotAfter !== cleanup.claimNotAfter ||
                    cleanup.revocationOperationRef !== receipt.input.revocationOperationRef ||
                    record.tokenRef !== receipt.input.tokenRef ||
                    record.protectedRevocationRef !== receipt.input.protectedRevocationRef ||
                    Date.parse(cleanup.claimNotAfter) <= Date.now()
                  )
                    reject(current);
                  await Reflect.apply(revocation, source!, [receipt, record]);
                  fence(current);
                  await inCustody(current, () =>
                    Reflect.apply(custodyRevocation, custody!, [receipt, record]),
                  );
                  fence(current);
                  current.releaseUntil = Date.parse(cleanup.claimNotAfter);
                };
                const operation = <T>(work: () => Promise<T>): Promise<T> => {
                  if (!current.accepting || current.checking)
                    return phase.rejectOutward<T>(
                      new ScopeViolationError("Repository Work operation admission is closed."),
                    );
                  return phase.runOperation(async () => {
                    assertEntry(current);
                    fence(current);
                    const result = await work();
                    fence(current);
                    return result;
                  });
                };
                const beforeWrite = () => {
                  if (current.written !== undefined) reject(current);
                  current.stage = "writing";
                };
                const audited = async (kind: RepositoryWorkOperationV2["kind"]) => {
                  await backend.appendAudit(actorId, original.operationRef, kind);
                  current.written = kind;
                };
                const requireReadset = () => {
                  if (!current.readset || !current.readsetQualified) reject(current);
                  return current.readset;
                };
                const unit = Object.freeze<RepositoryWorkUnitV2>({
                  context,
                  readForMutation: (work, execution) =>
                    operation(async () => {
                      if (
                        current.written ||
                        current.readsetQualified ||
                        (current.readset &&
                          (!equal(current.readWork, work) ||
                            !equal(current.readExecution, execution)))
                      )
                        reject(current);
                      const readset = current.readset ?? (await repository.readChain(work.workRef));
                      const own = readset.lineage.at(-1);
                      if (
                        !own ||
                        own.revision !== work.revision ||
                        !equal(own.execution, execution) ||
                        readset.lineage.some(
                          (member) =>
                            member.state !== "open" ||
                            Date.parse(member.originalHorizon) <= Date.now(),
                        )
                      )
                        reject(current);
                      await Reflect.apply(qualifyReadset, source!, [readset]);
                      current.readset = readset;
                      current.readsetQualified = true;
                      current.readWork = Object.freeze({ ...work });
                      current.readExecution = execution;
                      return readset;
                    }),
                  stageAdmission: (input) =>
                    operation(async () => {
                      const fixed = { record: record(input.record) };
                      beforeWrite();
                      await Reflect.apply(qualifyAdmission, source!, [fixed]);
                      await repository.admit(original, fixed);
                      await audited("admission");
                    }),
                  stagePreparation: (input) =>
                    operation(async () => {
                      const fixed = preparation(input);
                      const own = requireReadset().lineage.at(-1);
                      if (
                        !own ||
                        own.workRef !== fixed.workRef ||
                        own.revision !== fixed.workRevision ||
                        original.requestDigest !== fixed.requestDigest ||
                        fixed.receiverRef !== receiverRef ||
                        fixed.sessionRef !== sessionRef
                      )
                        reject(current);
                      requirePreparationProfile(own, fixed);
                      beforeWrite();
                      await repository.prepare(original, fixed);
                      await audited("preparation");
                    }),
                  stageDispatchAndRelease: (input) =>
                    operation(async () => {
                      const fixed = dispatch(input);
                      const readset = requireReadset();
                      const own = readset.lineage.at(-1);
                      if (
                        !own ||
                        own.workRef !== fixed.workRef ||
                        own.revision !== fixed.workRevision ||
                        original.requestDigest !== fixed.requestDigest ||
                        fixed.receiverRef !== receiverRef ||
                        fixed.sessionRef !== sessionRef
                      )
                        reject(current);
                      requirePreparationProfile(own, fixed);
                      beforeWrite();
                      await inCustody(current, () =>
                        Reflect.apply(stageRelease, custody!, [fixed]),
                      );
                      if (!current.qualifyRelease) reject(current);
                      await current.qualifyRelease(fixed);
                      await repository.dispatch(original, fixed);
                      await audited("dispatch");
                      current.release = fixed;
                    }),
                  stageClosure: (input) =>
                    operation(async () => {
                      const fixed = Object.freeze({ ...input });
                      const readset = requireReadset();
                      beforeWrite();
                      await Reflect.apply(qualifyClosure, source!, [readset, fixed]);
                      await repository.close(original, readset, fixed);
                      await audited("closure");
                    }),
                  appendObservation: (input) =>
                    operation(async () => {
                      const fixed = Object.freeze({ ...input });
                      const found = await repository.findOperation(fixed.dispatchOperationRef);
                      if (found.kind !== "recorded") reject(current);
                      await Reflect.apply(qualifyObservation, source!, [found.operation, fixed]);
                      beforeWrite();
                      await repository.observe(original, fixed);
                      await audited("observation");
                    }),
                  stageRepositoryInventory: (raw) =>
                    operation(async () => {
                      const input = parseRepositoryTokenMutationV2(raw);
                      if (
                        typeof inventory !== "function" ||
                        typeof custodyInventory !== "function" ||
                        !inventoryClock ||
                        input.operationRef !== original.operationRef ||
                        !equal(input.scope, {
                          installationId: fixedScope.installationId,
                          namespaceId: fixedScope.namespaceId,
                          agentId: fixedScope.agentId,
                        })
                      )
                        reject(current);
                      const old =
                        input.method === "reserveRepositoryToken"
                          ? undefined
                          : await repositoryInventory.findRecord(input.target.recordRef);
                      const claim = old
                        ? await repositoryInventory.findMintClaim(old.target.recordRef)
                        : undefined;
                      const cleanupRef =
                        input.method === "recordRepositoryRevocation"
                          ? input.claimRef
                          : old?.revocation?.claimRef;
                      const revocationClaim = cleanupRef
                        ? await repositoryInventory.findRevocationClaim(cleanupRef)
                        : undefined;
                      if (
                        input.method !== "reserveRepositoryToken" &&
                        (!old || !equal(old.target, input.target))
                      )
                        reject(current);
                      const access =
                        input.method === "reserveRepositoryToken"
                          ? input.lease
                          : old?.issuance.lease;
                      if (!access) reject(current);
                      // New issuance needs the actual open chain. Outcome and cleanup
                      // qualification intentionally do not reuse the expired live chain.
                      if (
                        input.method === "reserveRepositoryToken" ||
                        input.method === "claimRepositoryMint"
                      ) {
                        const chain = requireReadset();
                        const own = chain.lineage.at(-1);
                        if (
                          !own ||
                          own.workRef !== access.work.workRef ||
                          own.revision !== access.work.revision ||
                          !equal(own.execution, access.execution) ||
                          access.original.requestDigest !== original.requestDigest ||
                          access.original.scope.installationRef !== fixedScope.installationId ||
                          access.original.scope.namespaceRef !== fixedScope.namespaceId ||
                          access.original.scope.agentRef !== fixedScope.agentId ||
                          access.original.scope.revisionRef !== fixedScope.revisionRef
                        )
                          reject(current);
                      }
                      const facts = Object.freeze({
                        input,
                        record: old,
                        mintClaim: claim,
                        revocationClaim,
                        readset: current.readset,
                      });
                      await Reflect.apply(inventory, source!, [facts]);
                      fence(current);
                      await inCustody(current, () =>
                        Reflect.apply(custodyInventory, custody!, [facts]),
                      );
                      fence(current);
                      beforeWrite();
                      current.inventoryInput = input;
                      const result = await transitionRepositoryInventoryV2(
                        repositoryInventory,
                        input,
                        inventoryClock,
                      );
                      if (result.kind === "staged") {
                        if (
                          !equal(result.operation.input, input) ||
                          result.operation.digest !== repositoryInventoryDigestV2(input)
                        )
                          reject(current);
                        current.inventoryResult = result.operation;
                        current.written = "inventory";
                      } else {
                        // Replay/conflict is data; no provider/release authority is made.
                        if (current.inventoryEffects.length) reject(current);
                        current.stage = "work";
                      }
                      return result;
                    }),
                  readRepositoryInventoryOperation: () =>
                    operation(async () => {
                      if (
                        typeof inventoryRead !== "function" ||
                        typeof custodyInventoryRead !== "function"
                      )
                        reject(current);
                      const found = await repositoryInventory.findOperation(original.operationRef);
                      if (
                        found &&
                        (found.input.operationRef !== original.operationRef ||
                          !equal(found.input.scope, {
                            installationId: fixedScope.installationId,
                            namespaceId: fixedScope.namespaceId,
                            agentId: fixedScope.agentId,
                          }))
                      )
                        reject(current);
                      await Reflect.apply(inventoryRead, source!, [found]);
                      fence(current);
                      await inCustody(current, () =>
                        Reflect.apply(custodyInventoryRead, custody!, [found]),
                      );
                      fence(current);
                      return found;
                    }),
                  readRepositoryInventoryCurrent: (target) =>
                    operation(async () => {
                      if (
                        current.written ||
                        current.inventoryCurrent ||
                        typeof inventoryCurrent !== "function" ||
                        typeof custodyInventoryCurrent !== "function"
                      )
                        reject(current);
                      const facts = await readRepositoryWorkInventoryCurrentV2(
                        repositoryInventory,
                        fixedScope,
                        target,
                      );
                      current.inventoryCurrent = facts;
                      await Reflect.apply(inventoryCurrent, source!, [facts]);
                      fence(current);
                      await inCustody(current, () =>
                        Reflect.apply(custodyInventoryCurrent, custody!, [facts]),
                      );
                      fence(current);
                      return facts;
                    }),
                  readExactOperation: () =>
                    operation(async () => {
                      const found = await repository.findOperation(original.operationRef);
                      if (
                        found.kind === "recorded" &&
                        (found.operation.requestDigest !== original.requestDigest ||
                          found.operation.invocationRef !== original.invocationRef)
                      )
                        reject(current);
                      return found;
                    }),
                  assertCurrent: () => {
                    assertEntry(current);
                    fence(current);
                    return undefined;
                  },
                });
                try {
                  return await body(unit);
                } finally {
                  current.accepting = false;
                }
              }),
            );
          });
        } catch {
          failed = true;
        } finally {
          if (entry) {
            while (entry.pending.size) await Promise.all([...entry.pending]);
            entry.active = false;
            members.delete(entry.context);
            disposeSelectedContext?.();
            for (const release of [...entry.releases].reverse()) {
              try {
                await release();
              } catch {
                failed = true;
              }
            }
          }
          // Inner leases above never await this outer retirement: it includes
          // their own cleanup. Original admission shutdown may join it safely.
          finishSelectedRetired();
        }
        if (failed || !acknowledgedAt)
          return execution.disposition !== "not-sent" && !execution.establishedNoCommit
            ? { kind: "unknown", operationRef: original.operationRef }
            : { kind: "not-committed" };
        const witness: RepositoryWorkCommittedV2 = Object.freeze({ commitRef });
        if (entry?.inventoryResult)
          inventoryCommits.set(witness, {
            operation: entry.inventoryResult,
            original,
            ...(entry.readWork ? { work: entry.readWork } : {}),
            ...(entry.readExecution ? { execution: entry.readExecution } : {}),
            useStarted: false,
          });
        if (
          entry?.release &&
          entry.receiver &&
          entry.session &&
          entry.readWork &&
          entry.readExecution
        )
          committed.set(witness, {
            value: Object.freeze({
              operationRef: original.operationRef,
              commitRef,
              dispatch: entry.release,
            }),
            receiver: entry.receiver,
            session: entry.session,
            original,
            work: entry.readWork,
            execution: entry.readExecution,
            useStarted: false,
          });
        return { kind: "committed", value: value!, commit: witness, acknowledgedAt };
      };
      acquireUse = async (commit, call, receiver, session) => {
        const member = committed.get(commit);
        if (
          !member ||
          member.receiver !== receiver ||
          member.session !== session ||
          member.useStarted ||
          call.signal.aborted
        )
          return undefined;
        member.useStarted = true;
        let deliver: (lease: RepositoryWorkCommittedUseLeaseV2 | undefined) => void = () => {};
        const ready = new Promise<RepositoryWorkCommittedUseLeaseV2 | undefined>((resolve) => {
          deliver = resolve;
        });
        let close: () => void = () => {};
        let live = true,
          submitted = false,
          settled = false;
        const released = new Promise<void>((resolve) => {
          close = () => {
            live = false;
            settled = true;
            resolve();
          };
        });
        const invalidate = () => {
          live = false;
          if (!submitted) close();
        };
        const submission = Object.freeze({ held: () => submitted && !settled, invalidate });
        const remaining = Math.max(1, Math.min(3000, Date.parse(call.deadline) - Date.now()));
        if (!Number.isFinite(remaining)) return undefined;
        const end = performance.now() + remaining;
        const timer = setTimeout(invalidate, remaining);
        call.signal.addEventListener("abort", invalidate, { once: true });
        let joined: Promise<unknown>;
        joined = submittedUses
          .run(submission, () =>
            run(
              member.original,
              call,
              {
                signal: call.signal,
                timeoutMs: Math.max(1, Math.min(3000, Date.parse(call.deadline) - Date.now())),
              },
              async (unit) => {
                await unit.readForMutation(member.work, member.execution);
                const read = await unit.readExactOperation();
                const entry = active.getStore();
                if (
                  !entry ||
                  read.kind !== "recorded" ||
                  read.operation.kind !== "dispatch" ||
                  read.operation.commitRef !== member.value.commitRef ||
                  !equal(read.operation.document, member.value.dispatch) ||
                  entry.receiver !== receiver ||
                  entry.session !== session
                )
                  fail();
                const qualifyRelease = entry.qualifyRelease;
                if (!qualifyRelease) fail();
                await entry.phase.runOperation(() => qualifyRelease(member.value.dispatch));
                const assertPermission = (): undefined => {
                  if (
                    !live ||
                    !entry.active ||
                    !entry.accepting ||
                    call.signal.aborted ||
                    Date.parse(call.deadline) <= Date.now() ||
                    performance.now() >= end
                  )
                    reject(entry);
                  fence(entry);
                  return undefined;
                };
                const lease = Object.freeze<RepositoryWorkCommittedUseLeaseV2>({
                  committed: member.value,
                  assertCurrent: assertPermission,
                  beginSubmittedUse: () => {
                    if (submitted) reject(entry);
                    assertPermission();
                    submitted = true;
                    return undefined;
                  },
                  release: async () => {
                    live = false;
                    close();
                    await joined;
                  },
                });
                unit.assertCurrent();
                deliver(lease);
                // The permission deadline never proves settlement of an entered write.
                // Custody releases only after ACK or actual transport/child retirement.
                await released;
                return undefined;
              },
            ),
          )
          .finally(() => {
            live = false;
            clearTimeout(timer);
            call.signal.removeEventListener("abort", invalidate);
            deliver(undefined);
          });
        void joined.catch(() => {});
        return ready;
      };
      const acquireInventoryUse = async (
        commit: RepositoryWorkCommittedV2,
        call: AuthorityCallV1,
        method: "claimRepositoryMint" | "claimRepositoryRevocation",
      ): Promise<
        | RepositoryWorkCommittedMintUseLeaseV2
        | RepositoryWorkCommittedRevocationUseLeaseV2
        | undefined
      > => {
        const member = inventoryCommits.get(commit);
        if (
          !member ||
          member.operation.input.method !== method ||
          (method === "claimRepositoryMint" && (!member.work || !member.execution)) ||
          member.useStarted ||
          call.signal.aborted
        )
          return undefined;
        const remaining = Math.max(1, Math.min(3000, Date.parse(call.deadline) - Date.now()));
        if (!Number.isFinite(remaining)) return undefined;
        member.useStarted = true;
        let deliver: (lease: RepositoryWorkCommittedMintUseLeaseV2 | undefined) => void = () => {};
        const ready = new Promise<RepositoryWorkCommittedMintUseLeaseV2 | undefined>((resolve) => {
          deliver = resolve;
        });
        let close: () => void = () => {},
          live = true,
          submitted = false,
          settled = false;
        const released = new Promise<void>((resolve) => {
          close = () => {
            live = false;
            settled = true;
            resolve();
          };
        });
        const invalidate = () => {
          live = false;
          if (!submitted) close();
        };
        const control = Object.freeze({ held: () => submitted && !settled, invalidate });
        const end = performance.now() + remaining,
          timer = setTimeout(invalidate, remaining);
        call.signal.addEventListener("abort", invalidate, { once: true });
        let joined: Promise<unknown>;
        joined = submittedUses
          .run(control, () =>
            run(
              member.original,
              call,
              { signal: call.signal, timeoutMs: remaining },
              async (unit) => {
                if (method === "claimRepositoryMint")
                  await unit.readForMutation(member.work!, member.execution!);
                const read = await unit.readRepositoryInventoryOperation();
                const entry = active.getStore();
                const qualify =
                  method === "claimRepositoryMint" ? entry?.qualifyMint : entry?.qualifyRevocation;
                if (!entry || !read || !equal(read, member.operation) || !qualify) fail();
                await entry.phase.runOperation(() => qualify(read));
                const assertPermission = (): undefined => {
                  if (
                    !live ||
                    !entry.active ||
                    !entry.accepting ||
                    call.signal.aborted ||
                    performance.now() >= end ||
                    Date.parse(call.deadline) <= Date.now()
                  )
                    reject(entry);
                  fence(entry);
                  return undefined;
                };
                const lease = Object.freeze<RepositoryWorkCommittedMintUseLeaseV2>({
                  operation: member.operation,
                  assertCurrent: assertPermission,
                  beginSubmittedUse: () => {
                    if (submitted) reject(entry);
                    assertPermission();
                    submitted = true;
                    return undefined;
                  },
                  release: async () => {
                    close();
                    await joined;
                  },
                });
                unit.assertCurrent();
                deliver(lease);
                await released;
              },
            ),
          )
          .finally(() => {
            live = false;
            clearTimeout(timer);
            call.signal.removeEventListener("abort", invalidate);
            deliver(undefined);
          });
        void joined.catch(() => {});
        return ready;
      };
      acquireMint = (commit, call) => acquireInventoryUse(commit, call, "claimRepositoryMint");
      acquireRevocation = (commit, call) =>
        acquireInventoryUse(commit, call, "claimRepositoryRevocation");
      return Object.freeze<RepositoryWorkStoreV2>({
        run,
        async recoverAfterUnwind(original, call, bounds) {
          const result = await run(original, call, bounds, (unit) => unit.readExactOperation());
          return result.kind === "committed" ? result.value : { kind: "unavailable" };
        },
      });
    },
  });
}
