import { randomUUID, createHash } from "node:crypto";
import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import {
  parseCompletedContextV1,
  type ContextKeyV1,
  type ExactAttemptV1,
} from "@openclaw-enterprise/contracts/completed-context-v1";
import {
  TURN_JOURNAL_LIMITS_V1,
  classifyJournalAdmissionV1,
  digestJournalAdmissionIdentityV1,
  journalCancellationBeforeDispatchMatchesV1,
  journalCompletionMatchesV1,
  journalDispatchIntentMatchesV1,
  journalOutcomeTransitionAllowedV1,
  journalReleaseMatchesV1,
  parseTurnJournalV1,
  parseTurnJournalResultV1,
  parseRejectedAdmissionV1,
  parseNonTurnIntakeV1,
  parseNonTurnReceiptV1,
  parseExactIncomingLinkV1,
  type TurnJournalUnitOfWorkV1,
  type JournalAdmissionProvenanceV1,
  type NonTurnProvenanceV1,
  type JournalEvidenceProvenanceV1,
  type JournalDeniedV1,
  type JournalUnavailableV1,
  type JournalAdmissionOwnerV1,
  type IncomingAdmissionLinkV1,
  type AdmissionRecordV1,
  type RejectedAdmissionRecordV1,
  type NonTurnReceiptV1,
  type ExactNonTurnIntakeV1,
  type JournalAdmissionIdentityV1,
  type AttemptRecordV1,
  type ExpectedCompletionHeadV1,
  type ExactCheckpointAllocationV1,
  type ExactCompletionOperationV1,
  type CompletionRecordV1,
  type ExactDeliveryOperationV1,
  type ExactDeliveryOutcomeV1,
  type DeliveryStateV1,
  type ExactOutcomeOperationV1,
  type JournalReleaseObservationV1,
} from "@openclaw-enterprise/contracts/turn-journal-v1";
import type { QueryRepositoryFactoryContext } from "../ports/repository-factory.ts";
import { DependencyUnavailableError, ScopeViolationError } from "../errors.ts";
import { TurnJournalTransactionGuard } from "./transaction-guard.ts";
import {
  canonicalJournalValue,
  sameJournalValue,
  parseOwnerRow,
  parseAttemptRow,
  parseHeadRow,
  parseIncomingLinkRow,
  parseOperationRow,
  parseDeliveryRow,
  parseAttemptFirstReceivedAt,
} from "./rows.ts";

export interface PostgresTurnJournalContext extends QueryRepositoryFactoryContext {
  currentInstallation(): Promise<Readonly<Installation> | undefined>;
  readonly guard: TurnJournalTransactionGuard;
}

/** Each selected owner operates on this same borrowed transaction. These ports
 * are mandatory; decoded values and caller-supplied identities confer no trust. */
export interface PostgresTurnJournalProvenance {
  readonly admission: Pick<JournalAdmissionProvenanceV1<never>, "inspect" | "inspectRejected">;
  readonly nonTurn: Pick<NonTurnProvenanceV1<never>, "inspectNonTurn">;
  readonly evidence: JournalEvidenceProvenanceV1;
  readonly authorization: {
    authorize(
      input: Readonly<{ operation: keyof TurnJournalUnitOfWorkV1; value: unknown }>,
      call: AuthorityCallV1,
    ): Promise<Readonly<{ kind: "authorized" }> | JournalDeniedV1 | JournalUnavailableV1>;
  };
}
export interface PostgresTurnJournalOptions {
  /** Bind the selected SDK's hostedChannelRouteKeyV1 directly. This pure
   * correlation callback is not a verifier or an authority issuer. */
  readonly canonicalRouteKey: (
    envelope: RejectedAdmissionRecordV1["envelope"],
  ) => JournalAdmissionIdentityV1["routeKey"];

  bind(context: PostgresTurnJournalContext): PostgresTurnJournalProvenance;
  readonly capacity: Readonly<{
    maxOwnersPerInstallation: number;
    maxIncomingLinksPerInstallation: number;
    maxAttemptsPerInstallation: number;
  }>;
}

type Row = Record<string, unknown>;
const denied = { kind: "denied" } as const;
const unavailable = { kind: "unavailable" } as const;
const conflict = { kind: "conflict" } as const;
const absent = { kind: "absent" } as const;
const failure = (value: object): value is JournalDeniedV1 | JournalUnavailableV1 =>
  "kind" in value && (value.kind === "denied" || value.kind === "unavailable");
const ownerReceipt = (owner: JournalAdmissionOwnerV1) =>
  "intake" in owner
    ? {
        receiptRef: owner.receiptRef,
        eventKey: owner.intake.eventKey,
        logicalMessageKey:
          owner.intake.logicalMessage.kind === "equivalent-original"
            ? owner.intake.logicalMessage.logicalMessageKey
            : null,
        eventDigest: owner.intake.eventDigest,
      }
    : "identity" in owner
      ? owner.identity.receipt
      : owner.receipt;
const contextValues = (key: ContextKeyV1) => [
  key.installationRef,
  key.namespaceRef,
  key.agentRef,
  key.conversationRef,
];
const attemptValues = (attempt: ExactAttemptV1) => [
  ...contextValues(attempt),
  attempt.turnRef,
  attempt.attemptRef,
  attempt.reservationRef,
];
const contextWhere =
  "installation_id=$1 AND namespace_id=$2 AND agent_id=$3 AND conversation_ref=$4";
const attemptWhere = `${contextWhere} AND turn_ref=$5 AND attempt_ref=$6 AND reservation_ref=$7`;
const digestValue = (value: unknown) =>
  createHash("sha256").update(canonicalJournalValue(value)).digest("hex");

/** Sole journal adapter. It never obtains a connection or controls a transaction. */
export function createPostgresTurnJournal(
  context: PostgresTurnJournalContext,
  options: PostgresTurnJournalOptions,
): TurnJournalUnitOfWorkV1 {
  for (const limit of Object.values(options.capacity))
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000)
      throw new TypeError("Journal capacity must be between one and 100000 records.");
  const capacity = Object.freeze({ ...options.capacity });
  const ports = options.bind(context);
  const calls = new WeakMap<AuthorityCallV1, AuthorityCallV1>();
  const checkedCall = (call: AuthorityCallV1): AuthorityCallV1 => {
    const retained = calls.get(call);
    if (retained) return retained;
    if (
      !(call.signal instanceof AbortSignal) ||
      typeof call.requestRef !== "string" ||
      typeof call.recipientRef !== "string" ||
      typeof call.deadline !== "string"
    )
      throw new TypeError("A bounded journal authority call is required.");
    const snapshot = Object.freeze({
      requestRef: call.requestRef,
      recipientRef: call.recipientRef,
      deadline: call.deadline,
      signal: call.signal,
      context: call.context,
    });
    calls.set(call, snapshot);
    calls.set(snapshot, snapshot);
    return snapshot;
  };
  if (
    !options.canonicalRouteKey ||
    !ports.admission?.inspect ||
    !ports.admission.inspectRejected ||
    !ports.nonTurn?.inspectNonTurn ||
    !ports.evidence ||
    !ports.authorization?.authorize
  )
    throw new TypeError("All journal provenance owners are required.");
  const active = (call: AuthorityCallV1) => {
    call = checkedCall(call);
    context.transaction.assertActive();
    if (
      call.signal.aborted ||
      !Number.isFinite(Date.parse(call.deadline)) ||
      Date.now() >= Date.parse(call.deadline)
    )
      throw new DependencyUnavailableError("The journal call has expired.");
  };
  const query = async (sql: string, values: readonly unknown[] = []): Promise<Row[]> => {
    context.transaction.assertActive();
    const result = await context.query.query(sql, values);
    context.transaction.assertActive();
    return result.rows as Row[];
  };
  const authorize = async (
    operation: keyof TurnJournalUnitOfWorkV1,
    value: unknown,
    call: AuthorityCallV1,
  ) => {
    active(call);
    const result = await ports.authorization.authorize({ operation, value }, checkedCall(call));
    active(call);
    if (result.kind !== "authorized") return result;
    const installation = await context.currentInstallation();
    active(call);
    if (!installation || installation.id !== context.scope.installationId) return unavailable;
    const candidate = value as {
      installationRef?: unknown;
      attempt?: { installationRef?: unknown };
      locator?: { installationRef?: unknown };
    };
    const supplied =
      candidate?.installationRef ??
      candidate?.attempt?.installationRef ??
      candidate?.locator?.installationRef;
    if (supplied !== undefined && supplied !== installation.id) return denied;
    return { kind: "authorized", installation } as const;
  };
  const read = async <T>(
    method: keyof TurnJournalUnitOfWorkV1,
    input: unknown,
    call: AuthorityCallV1,
    work: (installation: Readonly<Installation>) => Promise<T>,
  ): Promise<T | JournalDeniedV1 | JournalUnavailableV1> => {
    const authorized = await authorize(method, input, call);
    if (authorized.kind !== "authorized") return authorized;
    const value = await work(authorized.installation);
    active(call);
    return value;
  };
  const mutate = <T>(call: AuthorityCallV1, work: () => Promise<T>) =>
    context.guard.mutate(async () => {
      active(call);
      const result = await work();
      active(call);
      return result;
    });
  const admissionLock = async (installation: string) => {
    await query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `turn-journal-admission:${installation}`,
    ]);
  };
  const agentLock = async (key: ContextKeyV1) => {
    const rows = await query(
      "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR UPDATE",
      [key.namespaceRef, key.agentRef],
    );
    return rows.length === 1;
  };
  const findOwner = async (
    installation: string,
    channel: string,
    kind: "event" | "logical-message",
    key: string,
  ) => {
    const rows = await query(
      "SELECT o.* FROM occ.turn_journal_keys k JOIN occ.turn_journal_owners o USING (installation_id,channel_installation_id,receipt_ref) WHERE k.installation_id=$1 AND k.channel_installation_id=$2 AND k.key_kind=$3 AND k.key_digest=$4",
      [installation, channel, kind, key],
    );
    return rows[0] ? parseOwnerRow(rows[0]).record : null;
  };
  const eventAnchor = async (installation: string, channel: string, eventKey: string) => {
    const rows = await query(
      "SELECT * FROM occ.turn_journal_incoming_links WHERE installation_id=$1 AND channel_installation_id=$2 AND event_key=$3 AND event_owner",
      [installation, channel, eventKey],
    );
    if (!rows[0]) return null;
    const link = parseIncomingLinkRow(rows[0]);
    const receiptRef =
      link.originalReceiptRefs[0] ?? ("intake" in link ? link.receiptRef : undefined);
    const owners = await query(
      "SELECT * FROM occ.turn_journal_owners WHERE installation_id=$1 AND channel_installation_id=$2 AND receipt_ref=$3",
      [installation, channel, receiptRef],
    );
    if (!owners[0])
      throw new DependencyUnavailableError("The retained event owner is unavailable.");
    return { link, owner: parseOwnerRow(owners[0]).record };
  };
  const getAttempt = async (attempt: ExactAttemptV1) => {
    const rows = await query(
      `SELECT * FROM occ.turn_journal_attempts WHERE ${attemptWhere} FOR UPDATE`,
      attemptValues(attempt),
    );
    return rows[0];
  };
  const reservationHeld = async (attempt: ExactAttemptV1) =>
    (
      await query(
        `SELECT 1 FROM occ.turn_journal_reservations WHERE ${attemptWhere}`,
        attemptValues(attempt),
      )
    ).length === 1;
  const contextUsed = async (key: ContextKeyV1) =>
    (
      await query(
        `SELECT 1 FROM occ.turn_journal_attempts WHERE ${contextWhere} AND record->>'phase' IS DISTINCT FROM 'admitted-undispatched' LIMIT 1`,
        contextValues(key),
      )
    ).length > 0;
  const getHead = async (key: ContextKeyV1) => {
    const rows = await query(
      `SELECT * FROM occ.turn_journal_heads WHERE ${contextWhere}`,
      contextValues(key),
    );
    return rows[0] ? parseHeadRow(rows[0]) : null;
  };
  const getOperation = async (attempt: ExactAttemptV1, kind: string, ref: string) => {
    const rows = await query(
      "SELECT * FROM occ.turn_journal_operations WHERE installation_id=$1 AND operation_kind=$2 AND operation_ref=$3",
      [attempt.installationRef, kind, ref],
    );
    return rows[0] ? parseOperationRow(rows[0]) : null;
  };
  const putOperation = async (
    attempt: ExactAttemptV1,
    kind: string,
    ref: string,
    request: unknown,
    record: unknown,
  ) => {
    // Final outcome, cancellation, allocation, completion and release each retain
    // reserved capacity. Repeated uncertainty never evicts its original evidence.
    const finalOutcome =
      kind === "outcome" &&
      ["failed", "interrupted", "cancelled"].includes(
        (request as ExactOutcomeOperationV1).outcome.kind,
      );
    if (kind === "outcome" && !finalOutcome) {
      const [count] = await query(
        `SELECT count(*) AS total FROM occ.turn_journal_operations WHERE ${attemptWhere} AND operation_kind='outcome'`,
        attemptValues(attempt),
      );
      if (!count || Number(count.total) >= 32)
        throw new DependencyUnavailableError("The journal operation capacity is exhausted.");
    }
    await query(
      "INSERT INTO occ.turn_journal_operations (installation_id,namespace_id,agent_id,conversation_ref,turn_ref,attempt_ref,reservation_ref,operation_kind,operation_ref,request,record) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [...attemptValues(attempt), kind, ref, JSON.stringify(request), JSON.stringify(record)],
    );
  };
  const updateAttempt = async (attempt: ExactAttemptV1, record: AttemptRecordV1) => {
    parseTurnJournalV1("attempt", record);
    const rows = await query(
      `UPDATE occ.turn_journal_attempts SET record=$8,version=$9 WHERE ${attemptWhere} AND version=$10 RETURNING attempt_ref`,
      [...attemptValues(attempt), JSON.stringify(record), record.version, record.version - 1],
    );
    if (rows.length !== 1)
      throw new DependencyUnavailableError("The journal attempt changed during its locked update.");
  };
  const capacityAvailable = async (
    installation: string,
    newOwner: boolean,
    newAttempt: boolean,
  ) => {
    const [r] = await query(
      "SELECT (SELECT count(*) FROM occ.turn_journal_owners WHERE installation_id=$1) AS owners,(SELECT count(*) FROM occ.turn_journal_incoming_links WHERE installation_id=$1) AS links,(SELECT count(*) FROM occ.turn_journal_attempts WHERE installation_id=$1) AS attempts,(SELECT count(*) FROM occ.turn_journal_attempts a JOIN occ.turn_journal_reservations r USING (installation_id,namespace_id,agent_id,conversation_ref,turn_ref,attempt_ref,reservation_ref) WHERE a.installation_id=$1 AND a.record->>'phase'='admitted-undispatched') AS pending",
      [installation],
    );
    return (
      r !== undefined &&
      Number(r.links) < capacity.maxIncomingLinksPerInstallation &&
      (!newOwner || Number(r.owners) < capacity.maxOwnersPerInstallation) &&
      (!newAttempt ||
        (Number(r.attempts) < capacity.maxAttemptsPerInstallation &&
          Number(r.pending) < TURN_JOURNAL_LIMITS_V1.pendingReceiptsPerInstallation))
    );
  };
  const putOwner = async (
    installation: string,
    channel: string,
    owner: JournalAdmissionOwnerV1,
  ) => {
    const receipt = ownerReceipt(owner);
    const kind = "intake" in owner ? "non-turn" : "identity" in owner ? "admission" : "rejected";
    await query(
      "INSERT INTO occ.turn_journal_owners (installation_id,channel_installation_id,receipt_ref,owner_kind,record) VALUES ($1,$2,$3,$4,$5)",
      [installation, channel, receipt.receiptRef, kind, JSON.stringify(owner)],
    );
    for (const [keyKind, value] of [
      ["event", receipt.eventKey],
      ["logical-message", receipt.logicalMessageKey],
    ]) {
      if (value)
        await query(
          "INSERT INTO occ.turn_journal_keys (installation_id,channel_installation_id,key_kind,key_digest,receipt_ref) VALUES ($1,$2,$3,$4,$5)",
          [installation, channel, keyKind, value, receipt.receiptRef],
        );
    }
  };
  const exactLink = async (
    locator: IncomingAdmissionLinkV1["locator"],
    identityDigest: string,
    eventDigest: string,
    contentDigest: string,
  ) => {
    const rows = await query(
      "SELECT * FROM occ.turn_journal_incoming_links WHERE installation_id=$1 AND channel_installation_id=$2 AND event_key=$3 AND incoming_identity_digest=$4 AND incoming_event_digest=$5 AND incoming_content_digest=$6 AND link_kind='admission'",
      [
        locator.installationRef,
        locator.channelInstallationRef,
        locator.eventKey,
        identityDigest,
        eventDigest,
        contentDigest,
      ],
    );
    if (!rows[0]) return null;
    const link = parseIncomingLinkRow(rows[0]);
    return "locator" in link && sameJournalValue(link.locator, locator) ? link : null;
  };
  const putLink = async (link: IncomingAdmissionLinkV1) => {
    parseTurnJournalV1("incomingLink", link);
    await query(
      "INSERT INTO occ.turn_journal_incoming_links (installation_id,channel_installation_id,incoming_link_ref,incoming_identity_digest,event_key,incoming_event_digest,incoming_content_digest,record,link_kind,event_owner) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'admission',$9)",
      [
        link.locator.installationRef,
        link.locator.channelInstallationRef,
        link.incomingLinkRef,
        link.incomingIdentityDigest,
        link.locator.eventKey,
        link.incomingEventDigest,
        link.incomingContentDigest,
        JSON.stringify(link),
        (await eventAnchor(
          link.locator.installationRef,
          link.locator.channelInstallationRef,
          link.locator.eventKey,
        )) === null,
      ],
    );
  };
  const linkFor = (
    identity: JournalAdmissionIdentityV1,
    originals: readonly string[],
    disposition: IncomingAdmissionLinkV1["disposition"],
    auditIntentRef: string,
  ): IncomingAdmissionLinkV1 => ({
    incomingLinkRef: randomUUID(),
    incomingIdentityDigest: digestJournalAdmissionIdentityV1(identity),
    locator: identity.locator,
    incomingEventDigest: identity.receipt.eventDigest,
    incomingContentDigest: identity.receipt.contentDigest,
    originalReceiptRefs: originals,
    disposition,
    auditIntentRef,
  });

  const repository: TurnJournalUnitOfWorkV1 = {
    async findAdmission(input, call) {
      const key = parseTurnJournalV1("lookup", input);
      return read("findAdmission", key, call, async () => {
        let owner = await findOwner(
          key.installationRef,
          key.channelInstallationRef,
          key.kind,
          key.kind === "event" ? key.eventKey : key.logicalMessageKey,
        );
        if (!owner && key.kind === "event")
          owner =
            (await eventAnchor(key.installationRef, key.channelInstallationRef, key.eventKey))
              ?.owner ?? null;
        if (!owner) return absent;
        if ("intake" in owner) return { kind: "found-non-turn", receipt: owner } as const;
        return "identity" in owner
          ? ({ kind: "found", record: owner } as const)
          : ({ kind: "found-rejected", record: owner } as const);
      });
    },
    async findRejectedAdmission(input, call) {
      const key = parseTurnJournalV1("lookup", input);
      return read("findRejectedAdmission", key, call, async () => {
        let owner = await findOwner(
          key.installationRef,
          key.channelInstallationRef,
          key.kind,
          key.kind === "event" ? key.eventKey : key.logicalMessageKey,
        );
        if (!owner && key.kind === "event")
          owner =
            (await eventAnchor(key.installationRef, key.channelInstallationRef, key.eventKey))
              ?.owner ?? null;
        return owner && "envelope" in owner ? ({ kind: "found", record: owner } as const) : absent;
      });
    },
    async findIncomingLink(input, call) {
      const key = parseExactIncomingLinkV1(input);
      return read("findIncomingLink", key, call, async () => {
        const link = await exactLink(
          key.locator,
          key.incomingIdentityDigest,
          key.incomingEventDigest,
          key.incomingContentDigest,
        );
        if (!link) return absent;
        const rows = await query(
          "SELECT * FROM occ.turn_journal_owners WHERE installation_id=$1 AND channel_installation_id=$2 AND receipt_ref=$3",
          [
            key.locator.installationRef,
            key.locator.channelInstallationRef,
            link.originalReceiptRefs[0],
          ],
        );
        if (!rows[0])
          throw new DependencyUnavailableError("The incoming link owner is unavailable.");
        const original = parseOwnerRow(rows[0]).record;
        if ("intake" in original) return { kind: "found-non-turn", link, original } as const;
        return "identity" in original
          ? ({ kind: "found", link, original } as const)
          : ({ kind: "found-rejected", link, original } as const);
      });
    },
    async findAttempt(input, call) {
      const attempt = parseCompletedContextV1("exactAttempt", input);
      return read("findAttempt", attempt, call, async () => {
        const rows = await query(
          `SELECT * FROM occ.turn_journal_attempts WHERE ${attemptWhere}`,
          attemptValues(attempt),
        );
        return rows[0] ? ({ kind: "found", record: parseAttemptRow(rows[0]) } as const) : absent;
      });
    },
    async readHead(input, call) {
      const key = parseCompletedContextV1("contextKey", input);
      const state = await read("readHead", key, call, async () => {
        const head = await getHead(key);
        if (!head) return { kind: "unavailable", reason: "store-unavailable" } as const;
        if (!head.checkpoint && (await contextUsed(key)))
          return { kind: "unavailable", reason: "store-unavailable" } as const;
        const unresolved = await query(
          `SELECT 1 FROM occ.turn_journal_reservations WHERE ${contextWhere}`,
          contextValues(key),
        );
        if (unresolved.length) return { kind: "unavailable", reason: "unresolved-work" } as const;
        return head.checkpoint
          ? ({ kind: "completed", head: head.head, checkpoint: head.checkpoint } as const)
          : ({ kind: "new-context", head: head.head } as const);
      });
      return state.kind === "denied" || (state.kind === "unavailable" && !("reason" in state))
        ? { kind: "unavailable", reason: "store-unavailable" }
        : state;
    },
    async findCheckpointAllocation(input, call) {
      const allocation = parseTurnJournalV1("checkpointAllocation", input);
      return read("findCheckpointAllocation", allocation, call, async () => {
        const op = await getOperation(
          allocation.attempt,
          "checkpoint-allocation",
          allocation.operationRef,
        );
        return op && sameJournalValue(op.request, allocation)
          ? ({
              kind: "found",
              allocation: parseTurnJournalV1("checkpointAllocation", op.record),
            } as const)
          : absent;
      });
    },
    async findCompletion(input, call) {
      const operation = parseTurnJournalV1("completionOperation", input);
      return read("findCompletion", operation, call, async () => {
        const op = await getOperation(operation.attempt, "completion", operation.operationRef);
        if (!op) return absent;
        return sameJournalValue(op.request, operation)
          ? ({ kind: "published", record: parseTurnJournalV1("completion", op.record) } as const)
          : conflict;
      });
    },
    async findCancellation(input, call) {
      const operation = parseTurnJournalV1("cancellation", input);
      return read("findCancellation", operation, call, async () => {
        const op = await getOperation(operation.attempt, "cancellation", operation.operationRef);
        if (!op || op.operationKind !== "cancellation" || !sameJournalValue(op.request, operation))
          return absent;
        return { kind: "found", ...op.record } as const;
      });
    },
    async findRelease(input, call) {
      const observation = parseTurnJournalV1("releaseObservation", input);
      return read("findRelease", observation, call, async () => {
        const op = await getOperation(
          observation.attempt,
          "release",
          observation.releaseOperationRef,
        );
        return op && sameJournalValue(op.request, observation)
          ? ({
              kind: "released",
              observation: parseTurnJournalV1("releaseObservation", op.record),
            } as const)
          : absent;
      });
    },
    async findNonTurnIntake(input, call) {
      const intake = parseNonTurnIntakeV1(input);
      return read("findNonTurnIntake", intake, call, async () => {
        const rows = await query(
          "SELECT * FROM occ.turn_journal_incoming_links WHERE installation_id=$1 AND channel_installation_id=$2 AND event_key=$3 AND incoming_identity_digest=$4 AND link_kind='non-turn'",
          [
            intake.installationRef,
            intake.channelInstallationRef,
            intake.eventKey,
            digestValue(intake),
          ],
        );
        if (!rows[0]) return { kind: "not-found" } as const;
        const receipt = parseNonTurnReceiptV1(parseIncomingLinkRow(rows[0]));
        return sameJournalValue(receipt.intake, intake)
          ? ({ kind: "found", receipt } as const)
          : ({ kind: "not-found" } as const);
      });
    },
    // Mutation methods are assigned below so internal calls never reenter the
    // owner's outward admission wrapper while accepted work drains.
    ...mutations(),
  };
  return Object.freeze(repository);

  function mutations(): Pick<
    TurnJournalUnitOfWorkV1,
    | "admit"
    | "admitRejected"
    | "admitNonTurn"
    | "recordDispatchIntent"
    | "consumeAttempt"
    | "allocateCheckpoint"
    | "publishCompleted"
    | "recordOutcome"
    | "commitCancellation"
    | "releaseReservation"
    | "reserveDelivery"
    | "recordDelivery"
    | "findDelivery"
  > {
    return {
      admit: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("admit", input, call);
          if (auth.kind !== "authorized") return auth;
          let observation = await ports.admission.inspect(input, checkedCall(call));
          active(call);
          if (failure(observation)) return observation;
          const identity = parseTurnJournalV1("admissionIdentity", observation.identity);
          const attempt = parseCompletedContextV1("exactAttempt", observation.attempt);
          const expectedHead = parseTurnJournalV1("head", observation.expectedHead);
          const admittedBinding = parseTurnJournalV1("commonAttemptBinding", {
            attempt,
            identity,
            reservation: observation.reservation,
            expectedHead,
          });
          const firstReceivedAt = observation.envelope.receivedAt;
          const firstReceived = Date.parse(firstReceivedAt);
          if (
            identity.locator.installationRef !== auth.installation.id ||
            !sameJournalValue(identity.context, expectedHead.context) ||
            !sameJournalValue(contextValues(attempt), contextValues(identity.context))
          )
            return denied;
          await admissionLock(auth.installation.id);
          observation = await ports.admission.inspect(input, checkedCall(call));
          active(call);
          if (failure(observation)) return observation;
          if (
            !sameJournalValue(observation.identity, identity) ||
            !sameJournalValue(observation.attempt, attempt) ||
            !sameJournalValue(observation.expectedHead, expectedHead) ||
            !sameJournalValue(observation.reservation, admittedBinding.reservation) ||
            observation.envelope.receivedAt !== firstReceivedAt
          )
            return denied;
          const repeated = await exactLink(
            identity.locator,
            digestJournalAdmissionIdentityV1(identity),
            identity.receipt.eventDigest,
            identity.receipt.contentDigest,
          );
          const event = await findOwner(
            auth.installation.id,
            identity.locator.channelInstallationRef,
            "event",
            identity.locator.eventKey,
          );
          const logical = await findOwner(
            auth.installation.id,
            identity.locator.channelInstallationRef,
            "logical-message",
            identity.locator.logicalMessageKey,
          );
          const anchor = await eventAnchor(
            auth.installation.id,
            identity.locator.channelInstallationRef,
            identity.locator.eventKey,
          );
          const anchorLink = anchor && "locator" in anchor.link ? anchor.link : null;
          const changedEvent =
            anchor !== null &&
            (anchorLink === null ||
              anchorLink.disposition === "conflict" ||
              anchorLink.locator.logicalMessageKey !== identity.locator.logicalMessageKey ||
              anchorLink.incomingEventDigest !== identity.receipt.eventDigest ||
              anchorLink.incomingContentDigest !== identity.receipt.contentDigest);
          const anchoredOwner = anchor?.owner ?? null;
          const retainedRefs = [
            ...new Set(
              [anchoredOwner, logical]
                .filter((owner): owner is JournalAdmissionOwnerV1 => owner !== null)
                .map((owner) => ownerReceipt(owner).receiptRef),
            ),
          ];
          const existing =
            anchor && "intake" in anchor.owner
              ? {
                  kind: "non-turn-owned" as const,
                  original: anchor.owner,
                  originalReceiptRefs: retainedRefs,
                }
              : changedEvent
                ? { kind: "conflict" as const, originalReceiptRefs: retainedRefs }
                : classifyJournalAdmissionV1({
                    incoming: identity,
                    byEvent: event,
                    byLogicalMessage:
                      logical ??
                      (anchoredOwner &&
                      ownerReceipt(anchoredOwner).logicalMessageKey ===
                        identity.locator.logicalMessageKey
                        ? anchoredOwner
                        : null),
                    agentReserved: false,
                  });
          if (existing.kind !== "candidate") {
            const refs =
              existing.kind === "duplicate"
                ? [ownerReceipt(existing.original).receiptRef]
                : "originalReceiptRefs" in existing
                  ? existing.originalReceiptRefs
                  : [];
            const link =
              repeated ??
              linkFor(
                identity,
                refs,
                existing.kind === "duplicate" ? "duplicate" : "conflict",
                observation.auditIntentRef,
              );
            if (!repeated) {
              if (!(await capacityAvailable(auth.installation.id, false, false)))
                return unavailable;
              await putLink(link);
            }
            if (existing.kind === "duplicate")
              return "identity" in existing.original
                ? {
                    kind: "recorded",
                    record: existing.original,
                    incomingLink: link,
                    duplicate: link.disposition !== "original",
                  }
                : { kind: "rejected-existing", record: existing.original, incomingLink: link };
            if (existing.kind === "non-turn-owned")
              return { kind: "non-turn-owned", original: existing.original, incomingLink: link };
            const original = event ?? anchoredOwner ?? logical;
            if (!original || "intake" in original)
              throw new DependencyUnavailableError("The admission conflict owner is unavailable.");
            return {
              kind: "conflict",
              incomingLink: link,
              originalReceipt:
                "identity" in original ? original.identity.receipt : original.receipt,
            };
          }
          if (!(await agentLock(attempt))) return denied;
          const reserved =
            (
              await query(
                "SELECT 1 FROM occ.turn_journal_reservations WHERE installation_id=$1 AND namespace_id=$2 AND agent_id=$3",
                contextValues(attempt).slice(0, 3),
              )
            ).length > 0;
          observation = await ports.admission.inspect(input, checkedCall(call));
          active(call);
          if (failure(observation)) return observation;
          if (
            !sameJournalValue(observation.identity, identity) ||
            !sameJournalValue(observation.attempt, attempt) ||
            !sameJournalValue(observation.expectedHead, expectedHead) ||
            !sameJournalValue(observation.reservation, admittedBinding.reservation) ||
            !Number.isFinite(firstReceived) ||
            observation.envelope.receivedAt !== firstReceivedAt ||
            firstReceived > Date.now() ||
            Date.now() >= firstReceived + TURN_JOURNAL_LIMITS_V1.intakeDeadlineMs
          )
            return denied;
          const current = await getHead(attempt);
          if (!reserved && current && !current.checkpoint && (await contextUsed(attempt)))
            return denied;
          // Only authenticated first-creation evidence can establish an empty head.
          if (
            (current && !sameJournalValue(current.head, expectedHead)) ||
            (!current &&
              (expectedHead.headVersion !== 1 ||
                expectedHead.completionSequence !== 0 ||
                expectedHead.checkpointId !== null))
          )
            return denied;
          if (!(await capacityAvailable(auth.installation.id, true, !reserved))) return unavailable;
          const record = parseTurnJournalV1("admission", {
            schemaVersion: 1,
            identity,
            decision: reserved ? { kind: "busy" } : { kind: "accepted", attempt },
            expectedHead,
            decisionRef: observation.decisionRef,
            auditIntentRef: observation.auditIntentRef,
            decidedAt: new Date().toISOString(),
          });
          const link = linkFor(
            identity,
            [identity.receipt.receiptRef],
            "original",
            observation.auditIntentRef,
          );
          await putOwner(auth.installation.id, identity.locator.channelInstallationRef, record);
          await putLink(link);
          if (!reserved) {
            if (!current)
              await query(
                "INSERT INTO occ.turn_journal_heads (installation_id,namespace_id,agent_id,conversation_ref,record,checkpoint) VALUES ($1,$2,$3,$4,$5,NULL)",
                [...contextValues(attempt), JSON.stringify(expectedHead)],
              );
            const admitted = parseTurnJournalV1("attempt", {
              phase: "admitted-undispatched",
              binding: admittedBinding,
              version: 1,
              consumption: null,
              outcome: { kind: "accepted-undispatched" },
            });
            await query(
              "INSERT INTO occ.turn_journal_attempts (installation_id,namespace_id,agent_id,conversation_ref,turn_ref,attempt_ref,reservation_ref,channel_installation_id,admission_receipt_ref,reservation,first_received_at,record,version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1)",
              [
                ...attemptValues(attempt),
                identity.locator.channelInstallationRef,
                identity.receipt.receiptRef,
                JSON.stringify(admittedBinding.reservation),
                firstReceivedAt,
                JSON.stringify(admitted),
              ],
            );
            await query(
              "INSERT INTO occ.turn_journal_reservations (installation_id,namespace_id,agent_id,conversation_ref,turn_ref,attempt_ref,reservation_ref) VALUES ($1,$2,$3,$4,$5,$6,$7)",
              attemptValues(attempt),
            );
          }
          active(call);
          return { kind: "recorded", record, incomingLink: link, duplicate: false };
        }),
      admitRejected: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("admitRejected", input, call);
          if (auth.kind !== "authorized") return unavailable;
          const inspected = await ports.admission.inspectRejected(input, checkedCall(call));
          active(call);
          if (failure(inspected)) return unavailable;
          const incoming = parseRejectedAdmissionV1(inspected);
          if (incoming.envelope.installationRef !== auth.installation.id) return unavailable;
          const receipt = incoming.receipt;
          const locator = {
            schemaVersion: 1 as const,
            installationRef: auth.installation.id,
            channelInstallationRef: incoming.envelope.channelInstallationRef,
            eventKey: receipt.eventKey,
            logicalMessageKey: receipt.logicalMessageKey,
          };
          const identityDigest = digestValue({
            envelope: {
              platform: incoming.envelope.platform,
              providerTenantRef: incoming.envelope.providerTenantRef,
              recipientAppRef: incoming.envelope.recipientAppRef,
              sender: incoming.envelope.sender,
              nativeConversation: incoming.envelope.nativeConversation,
            },
            locator,
            eventDigest: receipt.eventDigest,
            contentDigest: receipt.contentDigest,
            profileConfigurationDigest: receipt.profileConfigurationDigest,
          });
          await admissionLock(auth.installation.id);
          const currentRejected = await ports.admission.inspectRejected(input, checkedCall(call));
          active(call);
          if (
            failure(currentRejected) ||
            !sameJournalValue(parseRejectedAdmissionV1(currentRejected), incoming)
          )
            return unavailable;
          const repeated = await exactLink(
            locator,
            identityDigest,
            receipt.eventDigest,
            receipt.contentDigest,
          );
          const event = await findOwner(
            auth.installation.id,
            locator.channelInstallationRef,
            "event",
            receipt.eventKey,
          );
          const logical = await findOwner(
            auth.installation.id,
            locator.channelInstallationRef,
            "logical-message",
            receipt.logicalMessageKey,
          );
          const anchor = await eventAnchor(
            auth.installation.id,
            locator.channelInstallationRef,
            receipt.eventKey,
          );
          const anchorLink = anchor && "locator" in anchor.link ? anchor.link : null;
          const originals = [
            ...new Map(
              [event ?? anchor?.owner ?? null, logical]
                .filter((owner): owner is JournalAdmissionOwnerV1 => owner !== null)
                .map((owner) => [ownerReceipt(owner).receiptRef, owner]),
            ).values(),
          ];
          const original = originals[0];
          const nonTurn = originals.find((owner): owner is NonTurnReceiptV1 => "intake" in owner);
          const originalSdk =
            original && !("intake" in original)
              ? "identity" in original
                ? original.identity.receipt
                : original.receipt
              : null;
          const subjectMatches =
            original &&
            !("intake" in original) &&
            ("identity" in original
              ? original.identity.providerSubjectRef
              : original.envelope.sender.providerSubjectRef) ===
              incoming.envelope.sender.providerSubjectRef;
          const incomingRoute = options.canonicalRouteKey(incoming.envelope);
          if (!/^[a-f0-9]{64}$/.test(incomingRoute)) return unavailable;
          const originalRoute =
            original && !("intake" in original)
              ? "identity" in original
                ? original.identity.routeKey
                : options.canonicalRouteKey(original.envelope)
              : null;
          // Logical-message identity does not contain the native root thread.
          // Compare the selected SDK route separately to preserve its exact target.
          const duplicate =
            originals.length === 1 &&
            originalSdk !== null &&
            subjectMatches &&
            originalRoute === incomingRoute &&
            originalSdk.logicalMessageKey === receipt.logicalMessageKey &&
            originalSdk.contentDigest === receipt.contentDigest &&
            originalSdk.profileConfigurationDigest === receipt.profileConfigurationDigest &&
            (!event || ownerReceipt(event).eventDigest === receipt.eventDigest) &&
            (!anchor ||
              (anchorLink !== null &&
                anchorLink.disposition !== "conflict" &&
                anchorLink.locator.logicalMessageKey === receipt.logicalMessageKey &&
                anchorLink.incomingEventDigest === receipt.eventDigest &&
                anchorLink.incomingContentDigest === receipt.contentDigest));
          const link: IncomingAdmissionLinkV1 = repeated ?? {
            incomingLinkRef: randomUUID(),
            incomingIdentityDigest: identityDigest,
            locator,
            incomingEventDigest: receipt.eventDigest,
            incomingContentDigest: receipt.contentDigest,
            originalReceiptRefs: originals.length
              ? originals.map((owner) => ownerReceipt(owner).receiptRef)
              : [receipt.receiptRef],
            disposition: originals.length ? (duplicate ? "duplicate" : "conflict") : "original",
            auditIntentRef: incoming.auditIntentRef,
          };
          if (!repeated) {
            if (!(await capacityAvailable(auth.installation.id, !originals.length, false)))
              return unavailable;
            if (!originals.length)
              await putOwner(auth.installation.id, locator.channelInstallationRef, incoming);
            await putLink(link);
          }
          if (nonTurn) return { kind: "non-turn-owned", original: nonTurn, incomingLink: link };
          if (duplicate && original && "identity" in original)
            return { kind: "resolved-existing", record: original, incomingLink: link };
          if (duplicate && original && "envelope" in original)
            return {
              kind: link.disposition === "original" ? "recorded" : "existing",
              record: original,
              incomingLink: link,
            };
          if (originalSdk)
            return { kind: "conflict", originalReceipt: originalSdk, incomingLink: link };
          active(call);
          return { kind: repeated ? "existing" : "recorded", record: incoming, incomingLink: link };
        }),
      admitNonTurn: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("admitNonTurn", input, call);
          if (auth.kind !== "authorized") return { kind: "not-responsible" };
          const inspected = await ports.nonTurn.inspectNonTurn(input, checkedCall(call));
          active(call);
          if (failure(inspected)) return { kind: "not-responsible" };
          const intake = parseNonTurnIntakeV1(inspected);
          if (intake.installationRef !== auth.installation.id) return { kind: "not-responsible" };
          await admissionLock(auth.installation.id);
          const currentNonTurn = await ports.nonTurn.inspectNonTurn(input, checkedCall(call));
          active(call);
          if (
            failure(currentNonTurn) ||
            !sameJournalValue(parseNonTurnIntakeV1(currentNonTurn), intake)
          )
            return { kind: "not-responsible" };
          const repeated = await query(
            "SELECT * FROM occ.turn_journal_incoming_links WHERE installation_id=$1 AND channel_installation_id=$2 AND event_key=$3 AND incoming_identity_digest=$4 AND link_kind='non-turn'",
            [
              intake.installationRef,
              intake.channelInstallationRef,
              intake.eventKey,
              digestValue(intake),
            ],
          );
          if (repeated[0]) {
            const receipt = parseNonTurnReceiptV1(parseIncomingLinkRow(repeated[0]));
            return sameJournalValue(receipt.intake, intake)
              ? { kind: "recorded", receipt }
              : { kind: "not-responsible" };
          }
          const anchor = await eventAnchor(
            intake.installationRef,
            intake.channelInstallationRef,
            intake.eventKey,
          );
          const event =
            (await findOwner(
              intake.installationRef,
              intake.channelInstallationRef,
              "event",
              intake.eventKey,
            )) ??
            anchor?.owner ??
            null;
          const logical =
            intake.logicalMessage.kind === "equivalent-original"
              ? await findOwner(
                  intake.installationRef,
                  intake.channelInstallationRef,
                  "logical-message",
                  intake.logicalMessage.logicalMessageKey,
                )
              : null;
          const refs = [
            ...new Set(
              [event, logical]
                .filter((owner): owner is JournalAdmissionOwnerV1 => owner !== null)
                .map((owner) => ownerReceipt(owner).receiptRef),
            ),
          ];
          const original = event ?? logical;
          const exact =
            original && "intake" in original && sameJournalValue(original.intake, intake);
          if (!(await capacityAvailable(auth.installation.id, refs.length === 0, false)))
            return { kind: "not-responsible" };
          const receipt = parseNonTurnReceiptV1({
            schemaVersion: 1,
            receiptRef: randomUUID(),
            intake,
            disposition: refs.length && !exact ? "conflict" : "ignored",
            incomingLinkRef: randomUUID(),
            originalReceiptRefs: refs,
            auditIntentRef: randomUUID(),
          });
          if (!refs.length)
            await putOwner(intake.installationRef, intake.channelInstallationRef, receipt);
          await query(
            "INSERT INTO occ.turn_journal_incoming_links (installation_id,channel_installation_id,incoming_link_ref,incoming_identity_digest,event_key,incoming_event_digest,incoming_content_digest,record,link_kind,event_owner) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,'non-turn',$8)",
            [
              intake.installationRef,
              intake.channelInstallationRef,
              receipt.incomingLinkRef,
              digestValue(intake),
              intake.eventKey,
              intake.eventDigest,
              JSON.stringify(receipt),
              anchor === null,
            ],
          );
          active(call);
          return { kind: "recorded", receipt };
        }),
      ...executionMutations(),
    };
  }

  function executionMutations(): Pick<
    TurnJournalUnitOfWorkV1,
    | "recordDispatchIntent"
    | "consumeAttempt"
    | "allocateCheckpoint"
    | "publishCompleted"
    | "recordOutcome"
    | "commitCancellation"
    | "releaseReservation"
    | "reserveDelivery"
    | "recordDelivery"
    | "findDelivery"
  > {
    return {
      recordDispatchIntent: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("recordDispatchIntent", input, call);
          if (auth.kind !== "authorized") return auth;
          let observed = await ports.evidence.inspectDispatch(input, checkedCall(call));
          active(call);
          if (failure(observed)) return observed;
          const binding = parseTurnJournalV1("attemptBinding", observed);
          if (
            binding.attempt.installationRef !== auth.installation.id ||
            !(await agentLock(binding.attempt))
          )
            return denied;
          const row = await getAttempt(binding.attempt);
          if (!row) return conflict;
          observed = await ports.evidence.inspectDispatch(input, checkedCall(call));
          active(call);
          if (failure(observed)) return observed;
          if (!sameJournalValue(parseTurnJournalV1("attemptBinding", observed), binding))
            return denied;
          const current = parseAttemptRow(row);
          // Replays retain actual intent or later progress. Neither a common
          // record nor early authority is an existing dispatch intent.
          if (current.outcome.kind !== "accepted-undispatched") {
            if (
              "phase" in current ||
              ("stage" in current.outcome && current.outcome.stage === "before-dispatch") ||
              !sameJournalValue(current.binding, binding)
            )
              return conflict;
            return parseTurnJournalResultV1("dispatchIntent", {
              kind: "existing",
              record: current,
            });
          }
          if (current.version === Number.MAX_SAFE_INTEGER) return conflict;
          const result = parseTurnJournalResultV1("dispatchIntent", {
            kind: "recorded",
            record: {
              binding,
              version: current.version + 1,
              consumption: null,
              outcome: {
                kind: "dispatch-intent",
                dispatchOperationRef: binding.dispatchOperationRef,
              },
            },
          });
          if (result.kind !== "recorded")
            throw new DependencyUnavailableError("The dispatch intent result is unavailable.");
          if (!journalDispatchIntentMatchesV1(current, result.record, current.version))
            return conflict;
          const ownerRows = await query(
            "SELECT * FROM occ.turn_journal_owners WHERE installation_id=$1 AND channel_installation_id=$2 AND receipt_ref=$3",
            [auth.installation.id, row.channel_installation_id, row.admission_receipt_ref],
          );
          const owner = ownerRows[0] && parseOwnerRow(ownerRows[0]).record;
          if (
            !owner ||
            !("identity" in owner) ||
            owner.decision.kind !== "accepted" ||
            !sameJournalValue(owner.decision.attempt, binding.attempt) ||
            !sameJournalValue(owner.identity, binding.identity) ||
            !sameJournalValue(owner.expectedHead, binding.expectedHead) ||
            !sameJournalValue(row.reservation, binding.reservation)
          )
            return conflict;
          if (
            !(await reservationHeld(binding.attempt)) ||
            Date.parse(binding.expiresAt) <= Date.now() ||
            Date.now() >=
              Date.parse(parseAttemptFirstReceivedAt(row)) + TURN_JOURNAL_LIMITS_V1.intakeDeadlineMs
          )
            return denied;
          const cancellations = await query(
            `SELECT 1 FROM occ.turn_journal_operations WHERE ${attemptWhere} AND operation_kind='cancellation'`,
            attemptValues(binding.attempt),
          );
          if (cancellations.length) return denied;
          const head = await getHead(binding.attempt);
          if (!head || !sameJournalValue(head.head, binding.expectedHead)) return conflict;
          await updateAttempt(binding.attempt, result.record);
          active(call);
          return result;
        }),
      consumeAttempt: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("consumeAttempt", input, call);
          if (auth.kind !== "authorized") return auth;
          let observed = await ports.evidence.inspectConsumption(input, checkedCall(call));
          active(call);
          if (failure(observed)) return observed;
          const operation = parseTurnJournalV1("consumption", observed.operation);
          if (
            operation.attempt.installationRef !== auth.installation.id ||
            !(await agentLock(operation.attempt))
          )
            return denied;
          const row = await getAttempt(operation.attempt);
          const record = row && parseAttemptRow(row);
          if (!record || "phase" in record) return conflict;
          if (record.consumption)
            return sameJournalValue(record.consumption.operation, operation)
              ? { kind: "already-consumed", operation: record.consumption.operation }
              : conflict;
          observed = await ports.evidence.inspectConsumption(input, checkedCall(call));
          active(call);
          if (failure(observed)) return observed;
          if (
            !sameJournalValue(observed.operation, operation) ||
            !sameJournalValue(observed.binding, record.binding)
          )
            return denied;
          if (
            record.outcome.kind !== "dispatch-intent" ||
            record.version === Number.MAX_SAFE_INTEGER ||
            Date.now() >= Date.parse(record.binding.expiresAt) ||
            !(await reservationHeld(operation.attempt))
          )
            return denied;
          const cancellations = await query(
            `SELECT 1 FROM occ.turn_journal_operations WHERE ${attemptWhere} AND operation_kind='cancellation'`,
            attemptValues(operation.attempt),
          );
          if (cancellations.length) return denied;
          const consumedAt = new Date().toISOString();
          const next = parseTurnJournalV1("attempt", {
            ...record,
            version: record.version + 1,
            consumption: { operation, consumedAt },
            outcome: {
              kind: "consumed",
              consumptionOperationRef: operation.operationRef,
              consumedAt,
            },
          });
          await updateAttempt(operation.attempt, next);
          active(call);
          return {
            kind: "claim-pending",
            claim: context.guard.createClaim(
              operation,
              new Date(
                Math.min(
                  Date.parse(record.binding.expiresAt),
                  Date.parse(call.deadline),
                  Date.now() + TURN_JOURNAL_LIMITS_V1.startWindowMs,
                ),
              ).toISOString(),
            ),
          };
        }),
      allocateCheckpoint: (input, call) =>
        mutate(call, async () => {
          const allocation = parseTurnJournalV1("checkpointAllocation", input);
          const auth = await authorize("allocateCheckpoint", allocation, call);
          if (auth.kind !== "authorized") return auth;
          if (!(await agentLock(allocation.attempt))) return denied;
          const existing = await getOperation(
            allocation.attempt,
            "checkpoint-allocation",
            allocation.operationRef,
          );
          if (existing)
            return sameJournalValue(existing.request, allocation)
              ? {
                  kind: "existing",
                  allocation: parseTurnJournalV1("checkpointAllocation", existing.record),
                }
              : conflict;
          const row = await getAttempt(allocation.attempt);
          const record = row && parseAttemptRow(row);
          const head = await getHead(allocation.attempt);
          if (
            !record?.consumption ||
            !head ||
            !sameJournalValue(record.binding.expectedHead, allocation.expectedHead) ||
            !sameJournalValue(head.head, allocation.expectedHead) ||
            !(await reservationHeld(allocation.attempt))
          )
            return conflict;
          if (!["consumed", "running", "outcome-unknown"].includes(record.outcome.kind))
            return denied;
          const prior = await query(
            `SELECT 1 FROM occ.turn_journal_operations WHERE ${attemptWhere} AND operation_kind='checkpoint-allocation'`,
            attemptValues(allocation.attempt),
          );
          if (prior.length) return conflict;
          const current = await authorize("allocateCheckpoint", allocation, call);
          if (current.kind !== "authorized") return current;
          await putOperation(
            allocation.attempt,
            "checkpoint-allocation",
            allocation.operationRef,
            allocation,
            allocation,
          );
          active(call);
          return { kind: "allocated", allocation };
        }),
      publishCompleted: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("publishCompleted", input, call);
          if (auth.kind !== "authorized") return auth;
          let observation = await ports.evidence.inspectCompletion(input, checkedCall(call));
          active(call);
          if (failure(observation)) return observation;
          const operation = parseTurnJournalV1("completionOperation", observation.operation);
          if (
            operation.attempt.installationRef !== auth.installation.id ||
            !(await agentLock(operation.attempt))
          )
            return denied;
          const existing = await getOperation(
            operation.attempt,
            "completion",
            operation.operationRef,
          );
          if (existing)
            return sameJournalValue(existing.request, operation)
              ? { kind: "existing", record: parseTurnJournalV1("completion", existing.record) }
              : conflict;
          const row = await getAttempt(operation.attempt);
          const current = row && parseAttemptRow(row);
          const head = await getHead(operation.attempt);
          if (
            !current ||
            "phase" in current ||
            !current.consumption ||
            !head ||
            !(await reservationHeld(operation.attempt))
          )
            return conflict;
          if (
            current.version !== operation.expectedAttemptVersion ||
            head.head.completionSequence !== operation.expectedCompletionSequence
          )
            return conflict;
          observation = await ports.evidence.inspectCompletion(input, checkedCall(call));
          active(call);
          if (failure(observation)) return observation;
          if (!sameJournalValue(operation, observation.operation)) return denied;
          const allocationOp = await getOperation(
            operation.attempt,
            "checkpoint-allocation",
            observation.allocation.operationRef,
          );
          if (
            !allocationOp ||
            !sameJournalValue(allocationOp.record, observation.allocation) ||
            !sameJournalValue(head.head, observation.allocation.expectedHead)
          )
            return conflict;
          const checkpoint = parseCompletedContextV1(
            "checkpointRef",
            observation.canonical.checkpointRef,
          );
          if (
            observation.canonical.kind !== "verified" ||
            !observation.canonical.verificationReceiptRef ||
            !observation.nativeTerminalEvidenceRef ||
            !observation.noMutatorEvidenceRef ||
            observation.workspaceCompletionRef !== checkpoint.workspaceCompletionRef ||
            !sameJournalValue(
              observation.gatewayAssignment,
              current.binding.identity.gatewayAssignment,
            ) ||
            !sameJournalValue(
              observation.harnessAssignment,
              current.binding.identity.harnessAssignment,
            ) ||
            !sameJournalValue(observation.reservation, current.binding.reservation)
          )
            return denied;
          const record = parseTurnJournalV1("completion", {
            operation,
            checkpoint,
            head: {
              ...head.head,
              headVersion: head.head.headVersion + 1,
              completionSequence: head.head.completionSequence + 1,
              checkpointId: checkpoint.checkpointId,
            },
            outcomeVersion: current.version + 1,
            pendingDelivery: observation.pendingDelivery,
          });
          if (
            !journalCompletionMatchesV1({
              currentAttempt: current,
              currentHead: head.head,
              allocation: observation.allocation,
              candidate: record,
              expectedAttemptVersion: operation.expectedAttemptVersion,
            })
          )
            return conflict;
          const slots = await query(
            `SELECT 1 FROM occ.turn_journal_deliveries WHERE ${attemptWhere} AND slot='completed-result'`,
            attemptValues(operation.attempt),
          );
          if (slots.length) return conflict;
          const updated = await query(
            `UPDATE occ.turn_journal_heads SET record=$5,checkpoint=$6 WHERE ${contextWhere} AND record=$7::jsonb RETURNING conversation_ref`,
            [
              ...contextValues(operation.attempt),
              JSON.stringify(record.head),
              JSON.stringify(checkpoint),
              JSON.stringify(head.head),
            ],
          );
          if (updated.length !== 1)
            throw new DependencyUnavailableError(
              "The completed context head changed during publication.",
            );
          await updateAttempt(operation.attempt, {
            ...current,
            version: current.version + 1,
            outcome: {
              kind: "completed",
              checkpoint,
              completionOperationRef: operation.operationRef,
            },
          });
          await putOperation(
            operation.attempt,
            "completion",
            operation.operationRef,
            operation,
            record,
          );
          await insertDeliverySlot(record.pendingDelivery);
          active(call);
          return { kind: "published", record };
        }),
      recordOutcome: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("recordOutcome", input, call);
          if (auth.kind !== "authorized") return auth;
          let observed = await ports.evidence.inspectOutcome(input, checkedCall(call));
          active(call);
          if (failure(observed)) return observed;
          const operation = parseTurnJournalV1("outcomeOperation", observed);
          if (
            operation.attempt.installationRef !== auth.installation.id ||
            !(await agentLock(operation.attempt))
          )
            return denied;
          const existing = await getOperation(operation.attempt, "outcome", operation.operationRef);
          if (existing)
            return sameJournalValue(existing.request, operation)
              ? { kind: "existing", record: parseTurnJournalV1("attempt", existing.record) }
              : conflict;
          const row = await getAttempt(operation.attempt);
          const current = row && parseAttemptRow(row);
          if (!current) return unavailable;
          observed = await ports.evidence.inspectOutcome(input, checkedCall(call));
          active(call);
          if (failure(observed)) return observed;
          if (!sameJournalValue(observed, operation)) return denied;
          if (!journalOutcomeTransitionAllowedV1(current, operation)) return conflict;
          const next = parseTurnJournalV1("attempt", {
            ...current,
            version: current.version + 1,
            outcome: operation.outcome,
          });
          await updateAttempt(operation.attempt, next);
          await putOperation(operation.attempt, "outcome", operation.operationRef, operation, next);
          active(call);
          return { kind: "recorded", record: next };
        }),
      commitCancellation: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("commitCancellation", input, call);
          if (auth.kind !== "authorized") return auth;
          let observed = await ports.evidence.inspectCancellation(input, checkedCall(call));
          active(call);
          if (failure(observed)) return observed;
          const operation = parseTurnJournalV1("cancellation", observed);
          if (
            operation.attempt.installationRef !== auth.installation.id ||
            !(await agentLock(operation.attempt))
          )
            return denied;
          const existing = await getOperation(
            operation.attempt,
            "cancellation",
            operation.operationRef,
          );
          if (existing) {
            if (
              existing.operationKind !== "cancellation" ||
              !sameJournalValue(existing.request, operation)
            )
              return conflict;
            return { kind: "existing", ...existing.record };
          }
          const previousCancellation = await query(
            `SELECT 1 FROM occ.turn_journal_operations WHERE ${attemptWhere} AND operation_kind='cancellation'`,
            attemptValues(operation.attempt),
          );
          if (previousCancellation.length) return conflict;
          const row = await getAttempt(operation.attempt);
          if (!row) return conflict;
          const current = parseAttemptRow(row);
          if (["completed", "failed", "interrupted", "cancelled"].includes(current.outcome.kind))
            return { kind: "too-late" };
          if (
            current.version !== operation.expectedAttemptVersion ||
            current.version === Number.MAX_SAFE_INTEGER
          )
            return conflict;
          const owners = await query(
            "SELECT * FROM occ.turn_journal_owners WHERE installation_id=$1 AND channel_installation_id=$2 AND receipt_ref=$3",
            [auth.installation.id, row.channel_installation_id, row.admission_receipt_ref],
          );
          const owner = owners[0] && parseOwnerRow(owners[0]).record;
          if (
            !owner ||
            !("identity" in owner) ||
            owner.decision.kind !== "accepted" ||
            !sameJournalValue(owner.decision.attempt, operation.attempt) ||
            !sameJournalValue(owner.identity, current.binding.identity) ||
            !sameJournalValue(owner.expectedHead, current.binding.expectedHead) ||
            operation.originalPrincipalRef !== owner.identity.principalRef
          )
            return denied;
          observed = await ports.evidence.inspectCancellation(input, checkedCall(call));
          active(call);
          if (failure(observed)) return observed;
          if (!sameJournalValue(observed, operation)) return denied;
          const beforeDispatch = journalCancellationBeforeDispatchMatchesV1(current, operation);
          // Before-dispatch uncertainty is not proof of accepted, unstarted
          // work. Its original outcome owner must resolve it before cancellation.
          if (
            !beforeDispatch &&
            ("phase" in current ||
              ("stage" in current.outcome && current.outcome.stage === "before-dispatch"))
          )
            return conflict;
          if (!(await reservationHeld(operation.attempt))) return { kind: "too-late" };
          const outcome = beforeDispatch ? "cancelled-before-dispatch" : "requested";
          const next = parseTurnJournalV1("attempt", {
            ...current,
            version: current.version + 1,
            outcome: beforeDispatch
              ? {
                  kind: "cancelled",
                  stage: "before-dispatch",
                  evidenceRef: operation.operationRef,
                }
              : current.outcome,
          });
          await putOperation(operation.attempt, "cancellation", operation.operationRef, operation, {
            operation,
            outcome,
          });
          await updateAttempt(operation.attempt, next);
          active(call);
          return { kind: "recorded", operation, outcome };
        }),
      releaseReservation: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("releaseReservation", input, call);
          if (auth.kind !== "authorized") return auth;
          let observed = await ports.evidence.inspectRelease(input, checkedCall(call));
          active(call);
          if (failure(observed)) return observed;
          const observation = parseTurnJournalV1("releaseObservation", observed);
          if (
            observation.attempt.installationRef !== auth.installation.id ||
            !(await agentLock(observation.attempt))
          )
            return denied;
          const existing = await getOperation(
            observation.attempt,
            "release",
            observation.releaseOperationRef,
          );
          if (existing)
            return sameJournalValue(existing.request, observation)
              ? { kind: "existing", releaseOperationRef: observation.releaseOperationRef }
              : conflict;
          const row = await getAttempt(observation.attempt);
          const current = row && parseAttemptRow(row);
          if (!current) return { kind: "held" };
          observed = await ports.evidence.inspectRelease(input, checkedCall(call));
          active(call);
          if (failure(observed)) return observed;
          if (!sameJournalValue(observed, observation)) return denied;
          if (!journalReleaseMatchesV1(current, observation)) return conflict;
          if (
            !["completed", "failed", "interrupted", "cancelled", "outcome-unknown"].includes(
              current.outcome.kind,
            ) ||
            !(await reservationHeld(observation.attempt))
          )
            return { kind: "held" };
          await putOperation(
            observation.attempt,
            "release",
            observation.releaseOperationRef,
            observation,
            observation,
          );
          const removed = await query(
            `DELETE FROM occ.turn_journal_reservations WHERE ${attemptWhere} RETURNING reservation_ref`,
            attemptValues(observation.attempt),
          );
          if (removed.length !== 1)
            throw new DependencyUnavailableError("The reservation owner changed during release.");
          active(call);
          return { kind: "released", releaseOperationRef: observation.releaseOperationRef };
        }),
      ...deliveryMethods(),
    };
  }

  async function insertDeliverySlot(operation: ExactDeliveryOperationV1) {
    parseTurnJournalV1("deliveryOperation", operation);
    await query(
      "INSERT INTO occ.turn_journal_deliveries (installation_id,namespace_id,agent_id,conversation_ref,turn_ref,attempt_ref,reservation_ref,slot,operation_ref,operation,delivery_attempt_ref,attempt_number,episode_started_at,outcome,update_used) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,0,NULL,NULL,false)",
      [
        ...attemptValues(operation.attempt),
        operation.slot,
        operation.operationRef,
        JSON.stringify(operation),
      ],
    );
  }
  function deliveryMethods(): Pick<
    TurnJournalUnitOfWorkV1,
    "reserveDelivery" | "recordDelivery" | "findDelivery"
  > {
    const slotRow = async (operation: ExactDeliveryOperationV1) => {
      const rows = await query(
        `SELECT * FROM occ.turn_journal_deliveries WHERE ${attemptWhere} AND slot=$8`,
        [...attemptValues(operation.attempt), operation.slot],
      );
      return rows[0];
    };
    const stateFor = async (operation: ExactDeliveryOperationV1): Promise<DeliveryStateV1> => {
      const slot = await slotRow(operation);
      if (slot && slot.operation_ref === operation.operationRef) {
        const record = parseDeliveryRow(slot);
        if (!sameJournalValue(record.operation, operation)) return conflict;
        return record.outcome
          ? { kind: "recorded", record: record.outcome }
          : { kind: "pending", operation };
      }
      const history = await query(
        "SELECT * FROM occ.turn_journal_delivery_attempts WHERE installation_id=$1 AND operation_ref=$2 ORDER BY attempt_number DESC LIMIT 1",
        [operation.attempt.installationRef, operation.operationRef],
      );
      if (!history[0]) return unavailable;
      const record = parseDeliveryRow(history[0]);
      if (!sameJournalValue(record.operation, operation)) return conflict;
      return record.outcome
        ? { kind: "recorded", record: record.outcome }
        : { kind: "pending", operation };
    };
    return {
      async findDelivery(input, call) {
        const operation = parseTurnJournalV1("deliveryOperation", input);
        return read("findDelivery", operation, call, () => stateFor(operation));
      },
      reserveDelivery: (input, call) =>
        mutate(call, async () => {
          const auth = await authorize("reserveDelivery", input, call);
          if (auth.kind !== "authorized") return auth;
          let observed = await ports.evidence.inspectDelivery(input, checkedCall(call));
          active(call);
          if (failure(observed)) return observed;
          const operation = parseTurnJournalV1("deliveryOperation", observed);
          if (
            operation.attempt.installationRef !== auth.installation.id ||
            !(await agentLock(operation.attempt))
          )
            return denied;
          let raw = await slotRow(operation);
          let slot = raw && parseDeliveryRow(raw);
          const sameOperation = slot && sameJournalValue(slot.operation, operation);
          const historical = await query(
            "SELECT * FROM occ.turn_journal_delivery_attempts WHERE installation_id=$1 AND operation_ref=$2 ORDER BY attempt_number DESC LIMIT 1",
            [operation.attempt.installationRef, operation.operationRef],
          );
          if (historical[0] && !sameOperation)
            return { kind: "existing", state: await stateFor(operation) };
          if (
            slot &&
            sameOperation &&
            slot.deliveryAttemptRef !== null &&
            (!slot.outcome ||
              slot.outcome.outcome.kind !== "definitive-no-effect" ||
              slot.outcome.outcome.retryClass !== "transient")
          )
            return { kind: "existing", state: await stateFor(operation) };
          const attemptRow = await getAttempt(operation.attempt);
          const attempt = attemptRow && parseAttemptRow(attemptRow);
          if (
            !attempt ||
            operation.replyDestinationRef !== attempt.binding.identity.replyDestinationRef ||
            operation.replyBindingVersion !== attempt.binding.identity.replyBindingVersion ||
            operation.outcomeVersion !== attempt.version
          )
            return denied;
          observed = await ports.evidence.inspectDelivery(input, checkedCall(call));
          active(call);
          if (failure(observed)) return observed;
          if (!sameJournalValue(observed, operation)) return denied;
          if (
            operation.slot === "completed-result" &&
            (attempt.outcome.kind !== "completed" || !slot)
          )
            return conflict;
          if (
            operation.slot === "outcome-status" &&
            !["failed", "interrupted", "cancelled", "outcome-unknown"].includes(
              attempt.outcome.kind,
            )
          )
            return denied;
          if (operation.slot === "cancel-ack") {
            const cancelled = await query(
              `SELECT 1 FROM occ.turn_journal_operations WHERE ${attemptWhere} AND operation_kind='cancellation'`,
              attemptValues(operation.attempt),
            );
            if (!cancelled.length) return denied;
          }
          const update = operation.operation.kind === "update";
          if (slot && !sameOperation) {
            if (
              !update ||
              operation.slot !== "outcome-status" ||
              raw?.update_used !== false ||
              slot.outcome?.outcome.kind !== "delivered" ||
              operation.operation.kind !== "update" ||
              operation.operation.providerMessageRef !== slot.outcome.outcome.providerMessageRef
            )
              return conflict;
          } else if (update) return { kind: "existing", state: await stateFor(operation) };
          if (!slot) {
            if (update) return conflict;
            await insertDeliverySlot(operation);
            raw = await slotRow(operation);
            slot = raw && parseDeliveryRow(raw);
          }
          if (!slot) throw new DependencyUnavailableError("The delivery slot is unavailable.");
          const now = Date.now();
          const episodeStartedAt = slot.episodeStartedAt ?? new Date(now).toISOString();
          if (
            now >= Date.parse(episodeStartedAt) + TURN_JOURNAL_LIMITS_V1.deliveryWindowMs ||
            (!update && slot.attemptNumber >= TURN_JOURNAL_LIMITS_V1.deliveryAttemptsPerSlot)
          )
            return { kind: "existing", state: await stateFor(slot.operation) };
          const attemptNumber = update ? 1 : slot.attemptNumber + 1;
          const deliveryAttemptRef = randomUUID();
          await query(
            "INSERT INTO occ.turn_journal_delivery_attempts (installation_id,namespace_id,agent_id,conversation_ref,turn_ref,attempt_ref,reservation_ref,slot,operation_ref,delivery_attempt_ref,operation,attempt_number,episode_started_at,outcome) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL)",
            [
              ...attemptValues(operation.attempt),
              operation.slot,
              operation.operationRef,
              deliveryAttemptRef,
              JSON.stringify(operation),
              attemptNumber,
              episodeStartedAt,
            ],
          );
          await query(
            `UPDATE occ.turn_journal_deliveries SET operation_ref=$9,operation=$10,delivery_attempt_ref=$11,attempt_number=$12,episode_started_at=$13,outcome=NULL,update_used=$14 WHERE ${attemptWhere} AND slot=$8`,
            [
              ...attemptValues(operation.attempt),
              operation.slot,
              operation.operationRef,
              JSON.stringify(operation),
              deliveryAttemptRef,
              update ? slot.attemptNumber : attemptNumber,
              episodeStartedAt,
              update || raw?.update_used === true,
            ],
          );
          active(call);
          return {
            kind: "reserved",
            operation,
            deliveryAttemptRef,
            attemptNumber,
            episodeStartedAt,
          };
        }),
      recordDelivery: (input, call) =>
        mutate(call, async () => {
          const outcome = parseTurnJournalV1("delivery", input);
          const auth = await authorize("recordDelivery", outcome, call);
          if (auth.kind !== "authorized") return auth;
          const operation = outcome.operation;
          if (
            operation.attempt.installationRef !== auth.installation.id ||
            !(await agentLock(operation.attempt))
          )
            return denied;
          const history = await query(
            "SELECT * FROM occ.turn_journal_delivery_attempts WHERE installation_id=$1 AND delivery_attempt_ref=$2 FOR UPDATE",
            [operation.attempt.installationRef, outcome.deliveryAttemptRef],
          );
          if (!history[0]) return conflict;
          const reserved = parseDeliveryRow(history[0]);
          if (!sameJournalValue(reserved.operation, operation)) return conflict;
          if (reserved.outcome)
            return sameJournalValue(reserved.outcome, outcome)
              ? { kind: "existing", record: reserved.outcome }
              : conflict;
          const raw = await slotRow(operation);
          if (
            !raw ||
            raw.delivery_attempt_ref !== outcome.deliveryAttemptRef ||
            !sameJournalValue(raw.operation, operation)
          )
            return conflict;
          const current = await authorize("recordDelivery", outcome, call);
          if (current.kind !== "authorized") return current;
          await query(
            "UPDATE occ.turn_journal_delivery_attempts SET outcome=$3 WHERE installation_id=$1 AND delivery_attempt_ref=$2 AND outcome IS NULL",
            [
              operation.attempt.installationRef,
              outcome.deliveryAttemptRef,
              JSON.stringify(outcome),
            ],
          );
          await query(
            `UPDATE occ.turn_journal_deliveries SET outcome=$9 WHERE ${attemptWhere} AND slot=$8`,
            [...attemptValues(operation.attempt), operation.slot, JSON.stringify(outcome)],
          );
          active(call);
          return { kind: "recorded", record: outcome };
        }),
    };
  }
}
