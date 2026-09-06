import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import {
  encodeRetirementPurgeV1,
  initialPurgeProgressV1,
  type PurgeManifestV1,
} from "@openclaw-enterprise/contracts/retirement-purge-manifest-v1";
import {
  encodePurgeCallableV1,
  parsePurgeCallableV1,
  purgeHistoryMatchesV1,
  type PurgeHistoryQueryV1,
  type PurgeObservationInputObservationV1,
  type PurgeObservationResultV1,
  type PurgePublicationResultV1,
  type PurgeRetirementBindingV1,
  type PurgeRetirementInputObservationV1,
  type PurgeRetirementProvenanceV1,
  type PurgeRetirementReadResultV1,
  type VerifiedPurgeObservationInputV1,
  type VerifiedPurgeRetirementInputV1,
} from "@openclaw-enterprise/contracts/retirement-purge-journal-v1";
import { ResourceConflictError, ScopeViolationError } from "../../errors.ts";
import type { QueryRepositoryFactoryContext } from "../../ports/repository-factory.ts";
import type { TurnJournalTransactionGuard } from "../../turn-journal/transaction-guard.ts";
import {
  advanceReplayObservationV1,
  decodeReplayObservationReceiptV1,
  decodeReplayRetirementRecordV1,
  digestReplayReservationTargetV1,
  digestReplayRetiredTargetV1,
  encodeReplayReservationTargetV1,
  encodeReplayRetiredTargetV1,
  parseReplayReservationTargetV1,
  parseReplayRetiredTargetV1,
  replayReservationCanBindTargetV1,
  replayObservationReceiptMatchesV1,
  replayReservationTargetsMatchV1,
  REPLAY_BARRIER_CAPACITY_PER_INSTALLATION,
  type ReplayReservationTargetV1,
  type ReplayRetiredTargetV1,
} from "../../turn-journal/replay-barrier.ts";

/** Internal persistence participant on the original transaction owner's client.
 * Its caller must enter the journal phase before any parent or Agent row lock.
 * The outer owner retains authorization, poisoning, drain and commit ownership.
 */
export interface PostgresTurnJournalReplayContext extends QueryRepositoryFactoryContext {
  currentInstallation(): Promise<Readonly<Installation> | undefined>;
  /** The same guard owned by the enclosing journal transaction. Never create a
   * replacement here or enter these methods from an already running mutate. */
  readonly guard: TurnJournalTransactionGuard;
}

export type ReplayCapacityReservationV1 = Readonly<{
  target: ReplayReservationTargetV1;
  reservationRef: string;
  originalTransactionRef: string;
}>;

export type ReplayReservationRecordV1 = Readonly<{
  target: ReplayReservationTargetV1;
  activatedTarget: ReplayRetiredTargetV1 | null;
  reservationRef: string;
  originalTransactionRef: string;
  capacitySlot: number;
  state: "reserved" | "active" | "retired";
  recordVersion: number;
  lineage: Readonly<{ ref: string; version: number }> | null;
}>;

type Absent = Readonly<{ kind: "not-found" }>;
type Unavailable = Readonly<{ kind: "unavailable" }>;
type Conflict = Readonly<{ kind: "conflict" }>;
type Row = Record<string, unknown>;
const unavailable: Unavailable = Object.freeze({ kind: "unavailable" });
const conflict: Conflict = Object.freeze({ kind: "conflict" });

function invalid(): never {
  throw new TypeError("Invalid retained replay journal record.");
}

function reference(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._:/-]{1,200}$/.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)
  )
    invalid();
  return value;
}

function integer(value: unknown): number {
  const number = typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) invalid();
  return number;
}

function row(value: unknown): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Row;
}

function reservationFromRow(value: Row): ReplayReservationRecordV1 {
  const target = parseReplayReservationTargetV1(value.target);
  if (
    value.installation_id !== target.scope.installationId ||
    value.channel_installation_id !== target.channelInstallationRef ||
    value.target_key !== digestReplayReservationTargetV1(target)
  )
    invalid();
  const activatedTarget =
    value.activated_target === null ? null : parseReplayRetiredTargetV1(value.activated_target);
  const ownerScope = activatedTarget?.scope ?? target.scope;
  if (
    value.namespace_id !== ("namespaceId" in ownerScope ? ownerScope.namespaceId : null) ||
    value.agent_id !== ("agentId" in ownerScope ? ownerScope.agentId : null) ||
    (activatedTarget === null
      ? value.activated_target_key !== null
      : value.activated_target_key !== digestReplayRetiredTargetV1(activatedTarget) ||
        !replayReservationCanBindTargetV1(target, activatedTarget))
  )
    invalid();
  const state = value.state;
  if (state !== "reserved" && state !== "active" && state !== "retired") invalid();
  const lineage =
    value.lineage_ref === null && value.lineage_version === null
      ? null
      : Object.freeze({
          ref: reference(value.lineage_ref),
          version: integer(value.lineage_version),
        });
  if (
    (state === "reserved") !== (lineage === null) ||
    (state === "reserved") !== (activatedTarget === null)
  )
    invalid();
  const capacitySlot = integer(value.capacity_slot);
  if (capacitySlot > REPLAY_BARRIER_CAPACITY_PER_INSTALLATION) invalid();
  return Object.freeze({
    target,
    activatedTarget,
    reservationRef: reference(value.reservation_ref),
    originalTransactionRef: reference(value.reservation_transaction_ref),
    capacitySlot,
    state,
    recordVersion: integer(value.record_version),
    lineage,
  });
}

/** Internal domain infrastructure, never a public partial unit of work. The
 * original owner authorizes the complete operation and enters its exclusive
 * phase before calling a mutation here. SQL metadata results are neither commit
 * acknowledgements nor activation, deletion, dispatch or release permissions.
 *
 * TODO: the original composition must bind this same guard/client before any
 * parent locks, drain it before commit, and atomically establish stopped-head,
 * mandatory audit and durable progress responsibility. Until then the complete
 * command entrypoints below are unavailable and the schema rejects active
 * lineage/publication insertion. This factory does not activate that schema.
 */
export function createPostgresTurnJournalReplayParticipant(
  context: PostgresTurnJournalReplayContext,
) {
  let lockedPrefix: Readonly<{ installationId: string; targets: readonly string[] }> | undefined;

  function active(): void {
    context.transaction.assertActive();
    context.guard.assertActive();
  }

  function enter<T>(work: () => Promise<T>): Promise<T> {
    return context.guard.mutate(async () => {
      active();
      const result = await work();
      active();
      return result;
    });
  }

  async function query(statement: string, parameters: readonly unknown[] = []): Promise<Row[]> {
    active();
    const result = await context.query.query(statement, parameters);
    active();
    return result.rows.map(row);
  }

  async function installation(
    scope?: ReplayReservationTargetV1["scope"],
  ): Promise<string | undefined> {
    active();
    const current = await context.currentInstallation();
    active();
    if (!current) return undefined;
    if (
      context.scope.installationId !== current.id ||
      (scope &&
        (scope.installationId !== current.id ||
          (context.scope.namespaceId !== undefined &&
            (!("namespaceId" in scope) || context.scope.namespaceId !== scope.namespaceId))))
    )
      throw new ScopeViolationError("The replay target does not belong to the server-owned scope.");
    return current.id;
  }

  function targetsForManifest(
    values: readonly ReplayRetiredTargetV1[],
    manifest: PurgeManifestV1,
  ): readonly ReplayRetiredTargetV1[] {
    if (!Array.isArray(values) || values.length !== manifest.retiredIdentities.length) invalid();
    const targets = values.map(parseReplayRetiredTargetV1);
    const expected = manifest.retiredIdentities
      .map((identity) => encodeRetirementPurgeV1("retiredIdentity", identity))
      .sort();
    const actual = targets
      .map((target) => {
        if (
          target.scope.installationId !== manifest.scope.installationId ||
          target.scope.namespaceId !== manifest.scope.namespaceId ||
          target.scope.agentId !== manifest.scope.agentId
        )
          invalid();
        return encodeRetirementPurgeV1("retiredIdentity", target.identity);
      })
      .sort();
    if (
      actual.some(
        (identity, index) =>
          identity !== expected[index] || (index > 0 && identity === actual[index - 1]),
      )
    )
      invalid();
    return targets;
  }

  /** Called exactly once before any downstream row lock. Another target set
   * cannot extend the prefix after Namespace/Agent/head locks have been taken.
   */
  async function lockPrefix(
    targets: readonly (ReplayReservationTargetV1 | ReplayRetiredTargetV1)[],
  ): Promise<boolean> {
    const first = targets[0];
    if (!first) invalid();
    const id = await installation(first.scope);
    if (!id) return false;
    const exact = targets
      .map((target) =>
        "subject" in target
          ? encodeReplayReservationTargetV1(target)
          : encodeReplayRetiredTargetV1(target),
      )
      .sort();
    if (lockedPrefix) {
      if (
        lockedPrefix.installationId !== id ||
        exact.length !== lockedPrefix.targets.length ||
        exact.some((target, index) => target !== lockedPrefix!.targets[index])
      )
        throw new ScopeViolationError("A replay operation cannot extend an acquired lock prefix.");
      return true;
    }
    for (const target of targets) {
      if (
        target.scope.installationId !== id ||
        JSON.stringify(target.scope) !== JSON.stringify(first.scope)
      )
        invalid();
    }
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `turn-journal-admission:${id}`,
    ]);
    const parents = [...new Set(targets.map((target) => target.channelInstallationRef))].sort();
    const found = await query(
      `SELECT id FROM occ.channel_installations WHERE installation_id=$1 AND id=ANY($2::text[])
       ORDER BY id COLLATE "C" FOR UPDATE`,
      [id, parents],
    );
    const creatingChannel =
      targets.length === 1 && "subject" in first && first.subject.kind === "channel-installation";
    if (
      (!creatingChannel && found.length !== parents.length) ||
      found.some((parent) => !parents.includes(String(parent.id)))
    )
      throw new ResourceConflictError(
        "The replay operation's exact channel parents are unavailable.",
      );
    // A new channel parent is inserted by the same original owner after this
    // reservation; the deferred FK requires it to exist before commit.
    if ("namespaceId" in first.scope) {
      const namespaces = await query("SELECT id FROM occ.namespaces WHERE id=$1 FOR UPDATE", [
        first.scope.namespaceId,
      ]);
      const agents = await query(
        "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR UPDATE",
        [first.scope.namespaceId, first.scope.agentId],
      );
      if (namespaces.length !== 1 || agents.length !== 1)
        throw new ResourceConflictError("The replay operation's exact owner is unavailable.");
    }
    lockedPrefix = Object.freeze({ installationId: id, targets: Object.freeze(exact) });
    return true;
  }

  async function findHead(
    target: ReplayReservationTargetV1,
    lock = false,
  ): Promise<ReplayReservationRecordV1 | undefined> {
    const result = await query(
      `SELECT * FROM occ.turn_journal_replay_heads WHERE installation_id=$1 AND target_key=$2${lock ? " FOR UPDATE" : ""}`,
      [target.scope.installationId, digestReplayReservationTargetV1(target)],
    );
    const found = result[0];
    if (!found) return undefined;
    const record = reservationFromRow(found);
    if (!replayReservationTargetsMatchV1(record.target, target))
      throw new ResourceConflictError("The replay index conflicts with its retained target.");
    return record;
  }

  async function findActivatedHead(
    target: ReplayRetiredTargetV1,
  ): Promise<ReplayReservationRecordV1 | undefined> {
    const found = (
      await query(
        "SELECT * FROM occ.turn_journal_replay_heads WHERE installation_id=$1 AND activated_target_key=$2 FOR UPDATE",
        [target.scope.installationId, digestReplayRetiredTargetV1(target)],
      )
    )[0];
    if (!found) return undefined;
    const record = reservationFromRow(found);
    if (
      !record.activatedTarget ||
      encodeReplayRetiredTargetV1(record.activatedTarget) !== encodeReplayRetiredTargetV1(target)
    )
      throw new ResourceConflictError("The replay index conflicts with its activated target.");
    return record;
  }

  async function findPublication(binding: PurgeRetirementBindingV1, lock = false) {
    const found = (
      await query(
        `SELECT record,record_version FROM occ.turn_journal_retirement_publications
       WHERE installation_id=$1 AND namespace_id=$2 AND agent_id=$3 AND purge_operation_ref=$4${lock ? " FOR UPDATE" : ""}`,
        [
          binding.scope.installationId,
          binding.scope.namespaceId,
          binding.scope.agentId,
          binding.manifest.purgeOperationRef,
        ],
      )
    )[0];
    if (!found) return undefined;
    const record = decodeReplayRetirementRecordV1(found.record);
    if (integer(found.record_version) !== record.progress.recordVersion) invalid();
    return record;
  }

  async function retainedLineage(binding: PurgeRetirementBindingV1): Promise<boolean> {
    // The migration's validator is deliberately FALSE until the actual original
    // activation/clock producer supplies its exact complete retained schema.
    const found = await query(
      `SELECT lineage_ref FROM occ.turn_journal_replay_lineage WHERE installation_id=$1
       AND namespace_id=$2 AND agent_id=$3 AND lineage_ref=$4 AND lineage_version=$5
       AND occ.turn_journal_replay_lineage_valid(record) IS TRUE FOR UPDATE`,
      [
        binding.scope.installationId,
        binding.scope.namespaceId,
        binding.scope.agentId,
        binding.activationReplayLineageRef,
        binding.activationReplayLineageVersion,
      ],
    );
    return found.length === 1;
  }

  async function reserveCapacity(
    input: ReplayCapacityReservationV1,
  ): Promise<
    | Readonly<{ kind: "reserved" | "existing"; record: ReplayReservationRecordV1 }>
    | Readonly<{ kind: "capacity-exhausted" }>
    | Conflict
    | Unavailable
  > {
    const target = parseReplayReservationTargetV1(input.target);
    const reservationRef = reference(input.reservationRef);
    const originalTransactionRef = reference(input.originalTransactionRef);
    if (!(await lockPrefix([target]))) return unavailable;
    const existing = await findHead(target, true);
    if (existing)
      return existing.reservationRef === reservationRef &&
        existing.originalTransactionRef === originalTransactionRef
        ? { kind: "existing", record: existing }
        : conflict;
    const reused = await query(
      "SELECT target_key FROM occ.turn_journal_replay_heads WHERE installation_id=$1 AND reservation_ref=$2",
      [target.scope.installationId, reservationRef],
    );
    if (reused.length) return conflict;
    // The installation mutex serializes slot selection. The unique bounded slot
    // constraint independently prevents an old writer from exceeding capacity.
    const slots = await query(
      `SELECT candidate AS slot FROM generate_series(1,$2::integer) candidate
       WHERE NOT EXISTS (SELECT 1 FROM occ.turn_journal_replay_heads h
         WHERE h.installation_id=$1 AND h.capacity_slot=candidate) ORDER BY candidate LIMIT 1`,
      [target.scope.installationId, REPLAY_BARRIER_CAPACITY_PER_INSTALLATION],
    );
    if (!slots[0]) return { kind: "capacity-exhausted" };
    const inserted = await query(
      `INSERT INTO occ.turn_journal_replay_heads
       (installation_id,namespace_id,agent_id,channel_installation_id,target_key,target,capacity_slot,
        reservation_ref,reservation_transaction_ref,state,record_version,lineage_ref,lineage_version,activated_target,activated_target_key)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,'reserved',1,NULL,NULL,NULL,NULL) RETURNING *`,
      [
        target.scope.installationId,
        "namespaceId" in target.scope ? target.scope.namespaceId : null,
        "agentId" in target.scope ? target.scope.agentId : null,
        target.channelInstallationRef,
        digestReplayReservationTargetV1(target),
        encodeReplayReservationTargetV1(target),
        integer(slots[0].slot),
        reservationRef,
        originalTransactionRef,
      ],
    );
    if (inserted.length !== 1) invalid();
    return { kind: "reserved", record: reservationFromRow(inserted[0]!) };
  }

  async function findRetirementHistory(
    input: PurgeHistoryQueryV1,
  ): Promise<PurgeRetirementReadResultV1> {
    const expected = parsePurgeCallableV1("query", input);
    if (!(await installation(expected.binding.scope))) return { kind: "not-found" };
    const record = await findPublication(expected.binding);
    if (!record) return { kind: "not-found" };
    let observationReceipt = null;
    if (expected.kind === "observation") {
      const found = (
        await query(
          `SELECT receipt FROM occ.turn_journal_retirement_observations WHERE installation_id=$1
         AND purge_operation_ref=$2 AND observation_ref=$3`,
          [
            expected.binding.scope.installationId,
            expected.binding.manifest.purgeOperationRef,
            expected.observation.observationRef,
          ],
        )
      )[0];
      if (!found) return { kind: "not-found" };
      observationReceipt = decodeReplayObservationReceiptV1(found.receipt);
    }
    const result = parsePurgeCallableV1("readResult", {
      kind: "found",
      record,
      observationReceipt,
    });
    return purgeHistoryMatchesV1(expected, result) ? result : conflict;
  }

  /** Metadata primitive for the accepting original owner only. This is not the
   * complete public publication command. All failures after an insert throw into
   * the same owner guard, so catching them cannot make a partial write commit.
   */
  async function persistRetirementMetadata(
    input: PurgeRetirementInputObservationV1,
    originalTargets: readonly ReplayRetiredTargetV1[],
  ): Promise<PurgePublicationResultV1> {
    const inspected = parsePurgeCallableV1("retirementInputObservation", input);
    const { binding, manifest } = inspected;
    const targets = targetsForManifest(originalTargets, manifest);
    if (!(await lockPrefix(targets))) return unavailable;
    const heads: ReplayReservationRecordV1[] = [];
    for (const target of [...targets].sort((a, b) =>
      digestReplayRetiredTargetV1(a) < digestReplayRetiredTargetV1(b) ? -1 : 1,
    )) {
      const head = await findActivatedHead(target);
      if (
        !head ||
        head.state !== "active" ||
        !head.lineage ||
        head.lineage.ref !== binding.activationReplayLineageRef ||
        head.lineage.version !== binding.activationReplayLineageVersion
      )
        return unavailable;
      if (head.recordVersion === Number.MAX_SAFE_INTEGER) return conflict;
      heads.push(head);
    }
    if (!(await retainedLineage(binding))) return unavailable;
    if (await findPublication(binding, true)) return conflict;
    const record = parsePurgeCallableV1("record", {
      schemaVersion: 1,
      binding,
      progress: initialPurgeProgressV1(manifest),
      auditIntentRef: inspected.auditIntentRef,
      durableProgressResponsibilityRef: inspected.durableProgressResponsibilityRef,
    });
    await query(
      `INSERT INTO occ.turn_journal_retirement_publications
       (installation_id,namespace_id,agent_id,purge_operation_ref,original_transaction_ref,
        barrier_ref,barrier_version,lineage_ref,lineage_version,audit_intent_ref,
        durable_progress_responsibility_ref,record_version,record)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12::jsonb)`,
      [
        binding.scope.installationId,
        binding.scope.namespaceId,
        binding.scope.agentId,
        manifest.purgeOperationRef,
        binding.originalTransactionRef,
        binding.barrierRef,
        binding.barrierVersion,
        binding.activationReplayLineageRef,
        binding.activationReplayLineageVersion,
        inspected.auditIntentRef,
        inspected.durableProgressResponsibilityRef,
        encodePurgeCallableV1("record", record),
      ],
    );
    for (const head of heads) {
      const target = head.activatedTarget!;
      await query(
        `INSERT INTO occ.turn_journal_retired_identities
         (installation_id,namespace_id,agent_id,purge_operation_ref,barrier_ref,barrier_version,
          lineage_ref,lineage_version,identity_key,identity,target_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
          occ.turn_journal_replay_digest(jsonb_build_object('scope',$9::jsonb,'identity',$10::jsonb)),$10::jsonb,$11)`,
        [
          binding.scope.installationId,
          binding.scope.namespaceId,
          binding.scope.agentId,
          manifest.purgeOperationRef,
          binding.barrierRef,
          binding.barrierVersion,
          binding.activationReplayLineageRef,
          binding.activationReplayLineageVersion,
          JSON.stringify(binding.scope),
          encodeRetirementPurgeV1("retiredIdentity", target.identity),
          digestReplayReservationTargetV1(head.target),
        ],
      );
      const changed = await query(
        `UPDATE occ.turn_journal_replay_heads SET state='retired',record_version=record_version+1
         WHERE installation_id=$1 AND target_key=$2 AND target=$3::jsonb AND state='active'
          AND record_version=$4 AND lineage_ref=$5 AND lineage_version=$6 RETURNING target_key`,
        [
          binding.scope.installationId,
          digestReplayReservationTargetV1(head.target),
          encodeReplayReservationTargetV1(head.target),
          head.recordVersion,
          binding.activationReplayLineageRef,
          binding.activationReplayLineageVersion,
        ],
      );
      if (changed.length !== 1)
        throw new ResourceConflictError("The retirement head changed during publication.");
    }
    return { kind: "published", record };
  }

  async function persistObservationMetadata(
    input: PurgeObservationInputObservationV1,
    originalTargets: readonly ReplayRetiredTargetV1[],
  ): Promise<PurgeObservationResultV1> {
    const inspected = parsePurgeCallableV1("observationInputObservation", input);
    const { binding } = inspected;
    if (!(await installation(binding.scope))) return unavailable;
    // Initial discovery is only used to select the complete parent set. The
    // manifest and exact set are rechecked under the shared ordered prefix.
    const discovered = await findPublication(binding);
    if (!discovered) return unavailable;
    const targets = targetsForManifest(originalTargets, discovered.progress.manifest);
    if (!(await lockPrefix(targets))) return unavailable;
    for (const target of [...targets].sort((a, b) =>
      digestReplayRetiredTargetV1(a) < digestReplayRetiredTargetV1(b) ? -1 : 1,
    )) {
      const head = await findActivatedHead(target);
      if (
        !head ||
        head.state !== "retired" ||
        !head.lineage ||
        head.lineage.ref !== binding.activationReplayLineageRef ||
        head.lineage.version !== binding.activationReplayLineageVersion
      )
        return unavailable;
    }
    if (!(await retainedLineage(binding))) return unavailable;
    const record = await findPublication(binding, true);
    if (
      !record ||
      encodePurgeCallableV1("binding", record.binding) !==
        encodePurgeCallableV1("binding", binding) ||
      encodeRetirementPurgeV1("manifest", record.progress.manifest) !==
        encodeRetirementPurgeV1("manifest", discovered.progress.manifest)
    )
      return conflict;
    const receipts = await query(
      `SELECT receipt FROM occ.turn_journal_retirement_observations WHERE installation_id=$1
       AND (original_transaction_ref=$2 OR (purge_operation_ref=$3 AND
        (observation_ref=$4 OR (deletion_operation_ref=$5 AND observation_sequence=$6)))) FOR UPDATE`,
      [
        binding.scope.installationId,
        inspected.originalTransactionRef,
        binding.manifest.purgeOperationRef,
        inspected.observation.observationRef,
        inspected.observation.deletionOperationRef,
        inspected.observation.observationSequence,
      ],
    );
    if (receipts.length) {
      if (receipts.length !== 1) return conflict;
      const receipt = decodeReplayObservationReceiptV1(receipts[0]!.receipt);
      if (!replayObservationReceiptMatchesV1(receipt, inspected)) return conflict;
      return parsePurgeCallableV1("observationResult", { kind: "existing", record, receipt });
    }
    const next = advanceReplayObservationV1(record, inspected);
    if (next.kind === "conflict") return conflict;
    // Receipt insertion and the one-target progress CAS are in the same owner
    // transaction; deferred graph constraints require both or neither.
    await query(
      `INSERT INTO occ.turn_journal_retirement_observations
       (installation_id,namespace_id,agent_id,purge_operation_ref,barrier_ref,barrier_version,
        lineage_ref,lineage_version,observation_ref,deletion_operation_ref,observation_sequence,
        original_transaction_ref,recorded_at_record_version,receipt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
      [
        binding.scope.installationId,
        binding.scope.namespaceId,
        binding.scope.agentId,
        binding.manifest.purgeOperationRef,
        binding.barrierRef,
        binding.barrierVersion,
        binding.activationReplayLineageRef,
        binding.activationReplayLineageVersion,
        inspected.observation.observationRef,
        inspected.observation.deletionOperationRef,
        inspected.observation.observationSequence,
        inspected.originalTransactionRef,
        next.receipt.recordedAtRecordVersion,
        encodePurgeCallableV1("receipt", next.receipt),
      ],
    );
    const changed = await query(
      `UPDATE occ.turn_journal_retirement_publications SET record_version=$1,record=$2::jsonb
       WHERE installation_id=$3 AND namespace_id=$4 AND agent_id=$5 AND purge_operation_ref=$6
        AND record_version=$7 AND record=$8::jsonb RETURNING record,record_version`,
      [
        next.record.progress.recordVersion,
        encodePurgeCallableV1("record", next.record),
        binding.scope.installationId,
        binding.scope.namespaceId,
        binding.scope.agentId,
        binding.manifest.purgeOperationRef,
        record.progress.recordVersion,
        encodePurgeCallableV1("record", record),
      ],
    );
    if (changed.length !== 1)
      throw new ResourceConflictError(
        "Retirement progress changed during observation persistence.",
      );
    return parsePurgeCallableV1("observationResult", {
      kind: "recorded",
      record: next.record,
      receipt: next.receipt,
    });
  }

  return Object.freeze({
    reserveCapacity: (input: ReplayCapacityReservationV1) => enter(() => reserveCapacity(input)),
    findReservation: (
      input: ReplayReservationTargetV1,
    ): Promise<Readonly<{ kind: "found"; record: ReplayReservationRecordV1 }> | Absent> =>
      enter(async () => {
        const target = parseReplayReservationTargetV1(input);
        if (!(await installation(target.scope))) return { kind: "not-found" };
        const record = await findHead(target);
        return record ? { kind: "found", record } : { kind: "not-found" };
      }),
    findRetiredIdentity: (
      input: ReplayRetiredTargetV1,
    ): Promise<
      Readonly<{ kind: "found"; binding: PurgeRetirementBindingV1 }> | Absent | Conflict
    > =>
      enter(async () => {
        const target = parseReplayRetiredTargetV1(input);
        if (!(await installation(target.scope))) return { kind: "not-found" };
        const found = (
          await query(
            `SELECT r.identity,h.activated_target_key,h.activated_target AS target,p.record FROM occ.turn_journal_retired_identities r
         JOIN occ.turn_journal_replay_heads h ON h.installation_id=r.installation_id AND h.target_key=r.target_key
         JOIN occ.turn_journal_retirement_publications p ON p.installation_id=r.installation_id AND p.purge_operation_ref=r.purge_operation_ref
         WHERE r.installation_id=$1 AND r.identity_key=occ.turn_journal_replay_digest(
          jsonb_build_object('scope',$2::jsonb,'identity',$3::jsonb))`,
            [
              target.scope.installationId,
              JSON.stringify(target.scope),
              encodeRetirementPurgeV1("retiredIdentity", target.identity),
            ],
          )
        )[0];
        if (!found) return { kind: "not-found" };
        const retained = parseReplayRetiredTargetV1(found.target);
        if (
          encodeReplayRetiredTargetV1(target) !== encodeReplayRetiredTargetV1(retained) ||
          found.activated_target_key !== digestReplayRetiredTargetV1(target) ||
          encodeRetirementPurgeV1("retiredIdentity", target.identity) !==
            encodeRetirementPurgeV1(
              "retiredIdentity",
              found.identity as ReplayRetiredTargetV1["identity"],
            )
        )
          return conflict;
        return { kind: "found", binding: decodeReplayRetirementRecordV1(found.record).binding };
      }),
    findRetirementHistory: (input: PurgeHistoryQueryV1) =>
      enter(() => findRetirementHistory(input)),
    persistRetirementMetadata: (
      input: PurgeRetirementInputObservationV1,
      targets: readonly ReplayRetiredTargetV1[],
    ) => enter(() => persistRetirementMetadata(input, targets)),
    persistObservationMetadata: (
      input: PurgeObservationInputObservationV1,
      targets: readonly ReplayRetiredTargetV1[],
    ) => enter(() => persistObservationMetadata(input, targets)),
    inspectLineage: (_binding: PurgeRetirementBindingV1): Promise<Unavailable> =>
      enter(async () => unavailable),
    // TODO: implement complete original-owner stopped/audit/responsibility and
    // fresh authority composition before invoking either metadata primitive.
    // Refuse before inspecting handles or making any RPC/query when absent.
    publishRetirement: (
      _originalTransactionRef: string,
      _input: VerifiedPurgeRetirementInputV1,
      _call: AuthorityCallV1,
      _provenance: PurgeRetirementProvenanceV1,
    ): Promise<PurgePublicationResultV1> => enter(async () => unavailable),
    recordObservation: (
      _originalTransactionRef: string,
      _input: VerifiedPurgeObservationInputV1,
      _call: AuthorityCallV1,
      _provenance: PurgeRetirementProvenanceV1,
    ): Promise<PurgeObservationResultV1> => enter(async () => unavailable),
  });
}
