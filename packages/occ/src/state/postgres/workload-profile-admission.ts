import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../errors.ts";
import type { QueryRepositoryFactoryContext } from "../../ports/repository-factory.ts";
import {
  decodeWorkloadProfileAdmissionHeadV2,
  decodeWorkloadProfileAdmissionHistoryV2,
  workloadProfileInvalidationV2,
  withdrawWorkloadProfileAdmissionV2,
  type WorkloadProfileAdmissionBackendV2,
  type WorkloadProfileAdmissionHeadV2,
} from "../../workload-profiles/admission-record.ts";
import { profileUuid } from "../../workload-profiles/types.ts";
import { createPostgresWorkloadProfileBackend } from "./workload-profile.ts";

function recordText(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new DependencyUnavailableError("The retained profile row is invalid.");
  return value as Record<string, unknown>;
}

/** One original transaction/client and one admissionRef history. The authentic
 * account/policy/definition participant belongs to the enclosing owner. This
 * backend cannot issue a current-use lease or commit its borrowed writes. */
export function createPostgresWorkloadProfileAdmissionBackendV2(
  context: QueryRepositoryFactoryContext,
  appendAudit: WorkloadProfileAdmissionBackendV2["appendAudit"],
): WorkloadProfileAdmissionBackendV2 {
  const preparation = createPostgresWorkloadProfileBackend(context);
  const locked = new Map<string, "share" | "update">();
  const namespaces = new Set<string>();
  let capacityLocked = false;
  const key = (namespaceId: string, ref: string) => JSON.stringify([namespaceId, ref]);
  const installationId = () => preparation.installationId();
  const query = async (statement: string, values: readonly unknown[] = []) => {
    context.transaction.assertActive();
    const result = await context.query.query(statement, values);
    context.transaction.assertActive();
    return result;
  };
  const own = (head: WorkloadProfileAdmissionHeadV2) => {
    if (
      head.scope.installationId !== installationId() ||
      locked.get(key(head.scope.namespaceId, head.selection.admissionRef)) !== "update"
    )
      throw new ScopeViolationError("The profile head is not locked by this owner.");
  };
  const insertHistory = async (input: unknown) => {
    const history = decodeWorkloadProfileAdmissionHistoryV2(input);
    own(history.head);
    const { head } = history;
    const result = await query(
      `INSERT INTO occ.workload_profile_admission_history
      (installation_id,namespace_id,admission_ref,admission_version,manifest_ref,manifest_digest,history_ref,record)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [
        installationId(),
        head.scope.namespaceId,
        head.selection.admissionRef,
        head.selection.admissionVersion,
        head.selection.manifestRef,
        head.selection.manifestDigest,
        history.historyRef,
        JSON.stringify(history),
      ],
    );
    if (result.rowCount !== 1)
      throw new DependencyUnavailableError("The profile history was not retained.");
  };
  return {
    ...preparation,
    lockCapacity: async () => {
      await preparation.lockCapacity();
      capacityLocked = true;
    },
    lockOperation: async (locator) => {
      if (!capacityLocked) throw new ScopeViolationError("The profile capacity prefix is missing.");
      await preparation.lockOperation(locator);
    },
    namespaceExists: async (namespaceId) => {
      const exists = await preparation.namespaceExists(namespaceId);
      if (exists) namespaces.add(namespaceId);
      return exists;
    },
    lockHeads: async (namespaceId, refsInput, mode) => {
      const refs = immutableCopy(refsInput);
      if (
        (mode !== "share" && mode !== "update") ||
        refs.length < 1 ||
        refs.length > 2 ||
        new Set(refs).size !== refs.length ||
        (mode === "update" && (!capacityLocked || !namespaces.has(namespaceId)))
      )
        throw new ScopeViolationError("The profile head lock order is invalid.");
      for (const ref of refs) profileUuid(ref);
      for (const ref of [...refs].sort()) {
        if (locked.get(key(namespaceId, ref)) === "share" && mode === "update")
          throw new ScopeViolationError("A selected-use lock cannot become a management write.");
        // The advisory prefix also serializes an absent initial head. There is
        // no lock on a successor Agent and no admission-wide Configuration/H.
        await query(
          mode === "share"
            ? "SELECT pg_advisory_xact_lock_shared(hashtextextended('workload-profile-head:' || $1 || ':' || $2,0))"
            : "SELECT pg_advisory_xact_lock(hashtextextended('workload-profile-head:' || $1 || ':' || $2,0))",
          [installationId(), ref],
        );
        await query(
          `SELECT admission_ref FROM occ.workload_profile_admissions
          WHERE installation_id=$1 AND namespace_id=$2 AND admission_ref=$3 FOR ${mode === "share" ? "SHARE" : "UPDATE"}`,
          [installationId(), namespaceId, ref],
        );
        locked.set(key(namespaceId, ref), mode);
      }
    },
    head: async (namespaceId, admissionRef) => {
      profileUuid(admissionRef);
      const result = await query(
        `SELECT record FROM occ.workload_profile_admissions
        WHERE installation_id=$1 AND namespace_id=$2 AND admission_ref=$3`,
        [installationId(), namespaceId, admissionRef],
      );
      if (result.rows.length > 1)
        throw new DependencyUnavailableError("The profile head is ambiguous.");
      return result.rows[0] === undefined ? undefined : object(result.rows[0]).record;
    },
    acceptedOperation: async (locator) => {
      if (locator.installationId !== installationId()) return undefined;
      // Replacement's old terminal history is secondary. Its new admitted
      // history is the one original command result; standalone withdrawal is primary.
      const result = await query(
        `SELECT record FROM occ.workload_profile_admission_history
        WHERE installation_id=$1
          AND (record#>>'{head,state}'='admitted' OR record#>>'{head,withdrawal,reason}'='withdrawn')
          AND (CASE WHEN record#>>'{head,state}'='admitted' THEN record#>>'{head,acceptance,actor,principalRef}'
            ELSE record#>>'{head,withdrawal,actor,principalRef}' END)=$2
          AND (CASE WHEN record#>>'{head,state}'='admitted' THEN record#>>'{head,acceptance,operationRef}'
            ELSE record#>>'{head,withdrawal,operationRef}' END)=$3`,
        [installationId(), locator.actor.principalRef, locator.operationRef],
      );
      if (result.rows.length > 1)
        throw new DependencyUnavailableError("The profile command result is ambiguous.");
      return result.rows[0] === undefined ? undefined : object(result.rows[0]).record;
    },
    insertAdmission: async (input, historyInput) => {
      const head = decodeWorkloadProfileAdmissionHeadV2(input);
      const history = decodeWorkloadProfileAdmissionHistoryV2(historyInput);
      own(head);
      if (recordText(head) !== recordText(history.head))
        throw new ScopeViolationError("The profile history differs from its exact head.");
      if (head.state !== "admitted" || head.selection.admissionVersion !== 1)
        throw new ScopeViolationError("An initial profile admission requires version one.");
      const result = await query(
        `INSERT INTO occ.workload_profile_admissions
        (installation_id,namespace_id,admission_ref,admission_version,state,manifest_ref,manifest_digest,record)
        VALUES ($1,$2,$3,1,'admitted',$4,$5,$6::jsonb)`,
        [
          installationId(),
          head.scope.namespaceId,
          head.selection.admissionRef,
          head.selection.manifestRef,
          head.selection.manifestDigest,
          JSON.stringify(head),
        ],
      );
      if (result.rowCount !== 1)
        throw new DependencyUnavailableError("The profile admission was not retained.");
      await insertHistory(history);
    },
    withdrawAdmission: async (expectedInput, headInput, historyInput, invalidationInput) => {
      const expected = decodeWorkloadProfileAdmissionHeadV2(expectedInput);
      const head = decodeWorkloadProfileAdmissionHeadV2(headInput);
      const history = decodeWorkloadProfileAdmissionHistoryV2(historyInput);
      const invalidation = immutableCopy(invalidationInput);
      if (
        head.state !== "withdrawn" ||
        expected.state !== "admitted" ||
        recordText(head) !== recordText(history.head) ||
        recordText(invalidation) !== recordText(workloadProfileInvalidationV2(head)) ||
        recordText(head) !==
          recordText(
            withdrawWorkloadProfileAdmissionV2(
              expected,
              {
                actor: head.withdrawal.actor,
                operationRef: head.withdrawal.operationRef,
                requestRef: head.withdrawal.requestRef,
                decisionRef: head.withdrawal.decisionRef,
              },
              head.withdrawal.reason,
              head.withdrawal.acceptedAt,
            ),
          )
      )
        throw new ScopeViolationError(
          "The terminal profile association differs from its original record.",
        );
      own(head);
      own(expected);
      if (
        expected.state !== "admitted" ||
        head.state !== "withdrawn" ||
        expected.selection.admissionVersion === Number.MAX_SAFE_INTEGER ||
        head.selection.admissionVersion !== expected.selection.admissionVersion + 1
      )
        throw new ResourceConflictError("The profile withdrawal version conflicts.");
      const result = await query(
        `UPDATE occ.workload_profile_admissions
        SET admission_version=$4,state='withdrawn',record=$5::jsonb
        WHERE installation_id=$1 AND namespace_id=$2 AND admission_ref=$3
          AND state='admitted' AND admission_version=$6 AND record=$7::jsonb`,
        [
          installationId(),
          head.scope.namespaceId,
          head.selection.admissionRef,
          head.selection.admissionVersion,
          JSON.stringify(head),
          expected.selection.admissionVersion,
          JSON.stringify(expected),
        ],
      );
      if (result.rowCount !== 1)
        throw new ResourceConflictError("The profile admission changed before withdrawal.");
      await insertHistory(history);
      const queued = await query(
        `INSERT INTO occ.workload_profile_invalidations
        (installation_id,namespace_id,admission_ref,admission_version,manifest_ref,manifest_digest,invalidation_ref,record)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          installationId(),
          head.scope.namespaceId,
          head.selection.admissionRef,
          head.selection.admissionVersion,
          head.selection.manifestRef,
          head.selection.manifestDigest,
          head.terminal.invalidationRef,
          JSON.stringify(invalidation),
        ],
      );
      if (queued.rowCount !== 1)
        throw new DependencyUnavailableError("The profile invalidation was not retained.");
    },
    updateCapacity: async (expected, next) => {
      if (!capacityLocked) throw new ScopeViolationError("The profile capacity prefix is missing.");
      const result = await query(
        `UPDATE occ.workload_profile_capacity
        SET ordinary_operations=$2,pending_ordinary_operations=$3,terminal_slots=$4
        WHERE installation_id=$1 AND ordinary_operations=$5 AND pending_ordinary_operations=$6 AND terminal_slots=$7`,
        [
          installationId(),
          next.ordinaryOperations,
          next.pendingOrdinaryOperations,
          next.terminalSlots,
          expected.ordinaryOperations,
          expected.pendingOrdinaryOperations,
          expected.terminalSlots,
        ],
      );
      if (result.rowCount !== 1) throw new ResourceConflictError("The profile capacity changed.");
    },
    appendAudit: async (attribution, history) => {
      own(history.head);
      await appendAudit(
        immutableCopy(attribution),
        decodeWorkloadProfileAdmissionHistoryV2(history),
      );
      context.transaction.assertActive();
    },
  };
}
