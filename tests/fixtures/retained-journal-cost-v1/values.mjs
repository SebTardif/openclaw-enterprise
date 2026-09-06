// Synthetic workload parameters for planning and measurement tests. These values
// contain no authority, provenance, repository result, or measured performance.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const WORKLOAD_CONFIG = Object.freeze({
  schemaVersion: 1,
  seed: 203040,
  agents: 4,
  retainedTurnsPerAgent: 16,
  uncertainAgents: 1,
  replyBytes: 512,
  clients: 4,
  operationsPerClient: 128,
  hotKeyPercent: 70,
  readPercent: 70,
  duplicatePercent: 20,
  uncertainReadPercent: 20,
  maxRunMs: 10_000,
});

const detached = (value) => structuredClone(value);
const equal = (left, right) => isDeepStrictEqual(detached(left), detached(right));
const sha256 = (value) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

/** Internal benchmark composition of the existing PostgreSQL storage fixture.
 * Importing workload parameters does not load its SDK or repository dependencies.
 * This helper neither supplies a replacement journal nor initiates native work.
 */
export async function createRepositoryWorkload(pool, input, signal) {
  const { parseWorkloadConfig, createWorkloadPlan, summarizeLatencies } =
    await import("../../../tools/benchmarks/retained-journal-cost-v1.mjs");
  const config = parseWorkloadConfig(input);
  if (!(signal instanceof AbortSignal) || signal.aborted) {
    throw new Error("An active workload cancellation signal is required.");
  }
  const plan = createWorkloadPlan(config);
  const plannedOperations = plan.clients.flatMap((client) => client.operations);
  const plannedAppends = plannedOperations.filter(
    (operation) => operation.kind === "append-completed-turn",
  ).length;
  if (plan.dataset.totalAttempts + plannedAppends > 2_048 || plannedOperations.length > 4_096) {
    throw new Error("The workload exceeds the bounded repository execution profile.");
  }
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new Error("The existing PostgreSQL pool is required.");
  }
  const allowedOperations = new Set(
    plannedOperations.map((operation) => JSON.stringify(operation)),
  );
  const fixture = await import("../turn-journal-storage/values.mjs");
  const { PostgresCommitOutcomeUnknownError } =
    await import("../../../packages/occ/src/ports/transaction-errors.ts");
  const harness = fixture.journalHarness(pool);
  const owners = [];
  const entries = [];
  const initialCompleted = new Map();
  const initialUncertain = new Map();
  const attemptedAppends = new Set();
  let setupState = "not-started";
  let lastFailure = null;
  const commitUnknownFailures = [];
  const transactionTimings = new Map();
  let stopped = false;
  const counts = {
    agentsCreated: 0,
    completedSetupTurns: 0,
    uncertainSetupAttempts: 0,
    completedAppends: 0,
    busyAppends: 0,
    committedTransactions: 0,
    readOperations: 0,
  };
  const sizes = {
    request: { count: 0, totalBytes: 0, minBytes: null, maxBytes: null },
    record: { count: 0, totalBytes: 0, minBytes: null, maxBytes: null },
  };
  const observeBytes = (kind, value) => {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    const summary = sizes[kind];
    summary.count++;
    summary.totalBytes += bytes;
    summary.minBytes = summary.minBytes === null ? bytes : Math.min(summary.minBytes, bytes);
    summary.maxBytes = summary.maxBytes === null ? bytes : Math.max(summary.maxBytes, bytes);
  };
  const locator = (entry) =>
    entry
      ? {
          agentIndex: entry.agentIndex,
          turnIndex: entry.turnIndex,
          cohort: entry.cohort,
          attempt: detached(entry.values.attempt),
          channelInstallationRef: entry.values.locator.channelInstallationRef,
          eventKey: entry.values.locator.eventKey,
          logicalMessageKey: entry.values.locator.logicalMessageKey,
          incomingIdentityDigest: fixture.incomingLookup(entry.values.identity)
            .incomingIdentityDigest,
          admissionReceiptRef: entry.values.receipt.receiptRef,
          incomingLinkRef: entry.admission?.incomingLink.incomingLinkRef ?? null,
          checkpointId: entry.values.allocation.checkpointId,
          operationRefs: {
            dispatch: entry.values.binding.dispatchOperationRef,
            consumption: entry.values.consumption.operationRef,
            allocation: entry.values.allocation.operationRef,
            completion: entry.values.completionOperation.operationRef,
            release: entry.values.release.releaseOperationRef,
            outcome: entry.values.outcome.operationRef,
            delivery: entry.values.delivery.operationRef,
          },
          requestDigests: {
            consumption: entry.values.consumption.requestDigest,
            completion: entry.values.completionOperation.requestDigest,
            outcome: entry.values.outcome.requestDigest,
          },
        }
      : null;
  const manifestPointer = (entry) => ({
    agentIndex: entry.agentIndex,
    turnIndex: entry.turnIndex,
    admissionReceiptRef: entry.values.receipt.receiptRef,
  });
  const fail = (outcome, stage, entry, extra = {}) => {
    const failure = { outcome, details: { stage, locator: locator(entry), ...extra } };
    if (outcome === "commit-unknown") commitUnknownFailures.push(detached(failure));
    if (lastFailure?.outcome !== "commit-unknown" || outcome === "commit-unknown")
      lastFailure = detached(failure);
    if (outcome === "unavailable" || outcome === "commit-unknown") stopped = true;
    return failure;
  };
  const invariant = (entry, stage, condition, reason) => {
    if (condition) return;
    const failure = fail("unavailable", stage, entry, { reason });
    const error = new Error("Retained journal workload invariant failed.");
    error.details = failure.details;
    throw error;
  };
  const freshCall = () => {
    const original = harness.provenance.call();
    return Object.freeze({
      ...original,
      signal: AbortSignal.any([original.signal, signal]),
    });
  };
  const rememberRequest = (entry, stage, request) => {
    observeBytes("request", request);
    if (entry) entry.requestSha256[stage] = sha256(request);
  };
  const mutate = async (entry, stage, request, work) => {
    if (signal.aborted || stopped)
      return { failure: fail("unavailable", stage, entry, { reason: "workload-stopped" }) };
    const call = freshCall();
    const transactionRef = fixture.ref("retained-cost-transaction");
    entry.transactions.push({ stage, transactionRef, outcome: "pending" });
    const transaction = entry.transactions.at(-1);
    rememberRequest(entry, stage, request);
    const phase = setupState === "complete" ? "measurement" : "setup";
    const started = performance.now();
    const result = await harness.store.transact(
      transactionRef,
      (journal) => work(journal, call),
      call,
    );
    const elapsedMs = performance.now() - started;
    const timingKey = `${phase}:${stage}:${result.kind}:${result.value?.kind ?? ""}`;
    const timing = transactionTimings.get(timingKey) ?? {
      phase,
      stage,
      commitOutcome: result.kind,
      repositoryOutcome: result.value?.kind ?? null,
      samplesMs: [],
    };
    timing.samplesMs.push(elapsedMs);
    transactionTimings.set(timingKey, timing);
    transaction.outcome = result.kind;
    if (result.kind !== "committed") {
      return {
        failure: fail(
          result.kind === "commit-unknown" ? "commit-unknown" : "unavailable",
          stage,
          entry,
          { transactionRef },
        ),
      };
    }
    counts.committedTransactions++;
    transaction.repositoryResultKind = result.value?.kind ?? null;
    if (result.value?.record) observeBytes("record", result.value.record);
    return { value: result.value };
  };
  const read = async (entry, stage, request, work) => {
    if (signal.aborted)
      return { failure: fail("unavailable", stage, entry, { reason: "workload-aborted" }) };
    const call = freshCall();
    rememberRequest(entry, stage, request);
    try {
      const value = await harness.store.read((journal) => work(journal, call), call);
      counts.readOperations++;
      if (value?.record) observeBytes("record", value.record);
      return { value };
    } catch {
      return { failure: fail("unavailable", stage, entry) };
    }
  };
  const requireKind = (result, expected, entry, stage) => {
    if (result.failure) return result.failure;
    const actualKind = result.value?.kind;
    if (actualKind === expected) return null;
    if (["conflict", "denied", "unavailable", "held"].includes(actualKind)) {
      return fail(actualKind === "held" ? "unavailable" : actualKind, stage, entry, { actualKind });
    }
    invariant(entry, stage, false, "unexpected-repository-result");
  };
  const newEntry = (agentIndex, turnIndex, cohort) => {
    invariant(
      null,
      "allocate-workload-locator",
      entries.length < 2_048,
      "execution-profile-exhausted",
    );
    const values = fixture.journalValues(owners[agentIndex], { now: Date.now() });
    if (cohort === "uncertain") {
      values.outcome = {
        ...values.outcome,
        outcome: {
          kind: "outcome-unknown",
          stage: "execution",
          evidenceRef: fixture.ref("retained-cost-unknown"),
        },
      };
    }
    const entry = {
      agentIndex,
      turnIndex,
      cohort,
      values,
      admissionHandle: harness.issue("admission", values.observation),
      admission: null,
      completion: null,
      attemptRecord: null,
      stage: "values-created",
      canonicalAttemptCreated: false,
      transactions: [],
      requestSha256: {},
    };
    entries.push(entry);
    return entry;
  };
  const runNewAttempt = async (entry, allowBusy) => {
    const v = entry.values;
    let result = await mutate(entry, "admission", v.observation, (journal, call) =>
      journal.admit(entry.admissionHandle, call),
    );
    let failure = requireKind(result, "recorded", entry, "admission");
    if (failure) return failure;
    const admitted = result.value;
    invariant(
      entry,
      "admission",
      equal(admitted.record.identity, v.identity) &&
        equal(admitted.record.expectedHead, v.head) &&
        admitted.record.schemaVersion === 1 &&
        admitted.record.decisionRef === v.observation.decisionRef &&
        admitted.record.auditIntentRef === v.observation.auditIntentRef,
      "admission-identity-mismatch",
    );
    const incoming = fixture.incomingLookup(v.identity);
    invariant(
      entry,
      "admission",
      admitted.duplicate === false &&
        admitted.incomingLink.disposition === "original" &&
        equal(admitted.incomingLink.originalReceiptRefs, [v.receipt.receiptRef]) &&
        equal(admitted.incomingLink.locator, v.locator) &&
        admitted.incomingLink.incomingIdentityDigest === incoming.incomingIdentityDigest &&
        admitted.incomingLink.incomingEventDigest === incoming.incomingEventDigest &&
        admitted.incomingLink.incomingContentDigest === incoming.incomingContentDigest &&
        admitted.incomingLink.auditIntentRef === v.observation.auditIntentRef,
      "admission-link-mismatch",
    );
    entry.admission = detached(admitted);
    if (admitted.record.decision.kind === "busy") {
      entry.stage = "busy";
      if (allowBusy) counts.busyAppends++;
      else
        return fail("busy", "admission", entry, { committed: true, duplicate: admitted.duplicate });
      return {
        outcome: "busy",
        details: {
          stage: "admission",
          manifestPointer: manifestPointer(entry),
          committed: true,
          duplicate: admitted.duplicate,
        },
      };
    }
    invariant(
      entry,
      "admission",
      admitted.record.decision.kind === "accepted" &&
        equal(admitted.record.decision.attempt, v.attempt),
      "fresh-attempt-not-accepted",
    );
    entry.canonicalAttemptCreated = true;
    entry.stage = "admitted";
    result = await mutate(entry, "dispatch", v.binding, (journal, call) =>
      journal.recordDispatchIntent(harness.issue("dispatch", v.binding), call),
    );
    failure = requireKind(result, "recorded", entry, "dispatch");
    if (failure) return failure;
    invariant(
      entry,
      "dispatch",
      equal(result.value.record, {
        binding: v.binding,
        version: 2,
        consumption: null,
        outcome: { kind: "dispatch-intent", dispatchOperationRef: v.binding.dispatchOperationRef },
      }),
      "dispatch-record-mismatch",
    );
    entry.stage = "dispatched";
    const consumption = { operation: v.consumption, binding: v.binding };
    result = await mutate(entry, "consumption", consumption, (journal, call) =>
      journal.consumeAttempt(harness.issue("consumption", consumption), call),
    );
    failure = requireKind(result, "claim-pending", entry, "consumption");
    if (failure) return failure;
    // The opaque claim is deliberately neither inspected nor passed to initiation.
    result = await read(entry, "consumption-readback", v.attempt, (journal, call) =>
      journal.findAttempt(v.attempt, call),
    );
    failure = requireKind(result, "found", entry, "consumption-readback");
    if (failure) return failure;
    const consumed = result.value.record;
    invariant(
      entry,
      "consumption-readback",
      consumed.version === 3 &&
        consumed.outcome.kind === "consumed" &&
        equal(consumed.binding, v.binding) &&
        equal(consumed.consumption?.operation, v.consumption) &&
        consumed.outcome.consumptionOperationRef === v.consumption.operationRef &&
        consumed.outcome.consumedAt === consumed.consumption.consumedAt,
      "consumption-record-mismatch",
    );
    entry.attemptRecord = detached(consumed);
    entry.stage = "consumed";
    if (entry.cohort === "uncertain") {
      result = await mutate(entry, "outcome-unknown", v.outcome, (journal, call) =>
        journal.recordOutcome(harness.issue("outcome", v.outcome), call),
      );
      failure = requireKind(result, "recorded", entry, "outcome-unknown");
      if (failure) return failure;
      invariant(
        entry,
        "outcome-unknown",
        equal(result.value.record, { ...consumed, version: 4, outcome: v.outcome.outcome }),
        "uncertain-record-mismatch",
      );
      entry.attemptRecord = detached(result.value.record);
      entry.stage = "outcome-unknown-unreleased";
      return {
        outcome: "completed",
        details: { stage: entry.stage, manifestPointer: manifestPointer(entry) },
      };
    }
    result = await mutate(entry, "allocation", v.allocation, (journal, call) =>
      journal.allocateCheckpoint(v.allocation, call),
    );
    failure = requireKind(result, "allocated", entry, "allocation");
    if (failure) return failure;
    invariant(
      entry,
      "allocation",
      equal(result.value.allocation, v.allocation),
      "allocation-record-mismatch",
    );
    entry.stage = "allocated";
    result = await mutate(entry, "completion", v.completion, (journal, call) =>
      journal.publishCompleted(harness.issue("completion", v.completion), call),
    );
    failure = requireKind(result, "published", entry, "completion");
    if (failure) return failure;
    const expectedCompletion = {
      operation: v.completionOperation,
      checkpoint: v.checkpoint,
      head: {
        ...v.head,
        headVersion: v.head.headVersion + 1,
        completionSequence: v.head.completionSequence + 1,
        checkpointId: v.checkpoint.checkpointId,
      },
      outcomeVersion: 4,
      pendingDelivery: v.delivery,
    };
    invariant(
      entry,
      "completion",
      equal(result.value.record, expectedCompletion),
      "completion-record-mismatch",
    );
    entry.completion = detached(result.value.record);
    entry.attemptRecord = {
      ...detached(consumed),
      version: 4,
      outcome: {
        kind: "completed",
        checkpoint: detached(v.checkpoint),
        completionOperationRef: v.completionOperation.operationRef,
      },
    };
    entry.stage = "published";
    result = await mutate(entry, "release", v.release, (journal, call) =>
      journal.releaseReservation(harness.issue("release", v.release), call),
    );
    failure = requireKind(result, "released", entry, "release");
    if (failure) return failure;
    invariant(
      entry,
      "release",
      result.value.releaseOperationRef === v.release.releaseOperationRef,
      "release-operation-mismatch",
    );
    entry.stage = "completed-released";
    return {
      outcome: "completed",
      details: {
        stage: entry.stage,
        manifestPointer: manifestPointer(entry),
        completionPublished: true,
        deliveryState: "pending",
      },
    };
  };
  const setup = async () => {
    invariant(null, "setup", setupState === "not-started", "setup-already-attempted");
    setupState = "in-progress";
    for (let agentIndex = 0; agentIndex < config.agents; agentIndex++) {
      if (signal.aborted || stopped) {
        setupState = "failed";
        return fail("unavailable", "seed-owner", null, { agentIndex, reason: "workload-stopped" });
      }
      try {
        owners.push(await fixture.seedJournalOwner(harness.state));
      } catch (error) {
        setupState = "failed";
        return fail(
          error instanceof PostgresCommitOutcomeUnknownError ? "commit-unknown" : "unavailable",
          "seed-owner",
          null,
          { agentIndex, locatorUnavailable: "original-owner-seed-did-not-return" },
        );
      }
      counts.agentsCreated++;
      for (let turnIndex = 0; turnIndex < config.retainedTurnsPerAgent; turnIndex++) {
        const entry = newEntry(agentIndex, turnIndex, "initial-completed");
        const result = await runNewAttempt(entry, false);
        if (result.outcome !== "completed") {
          setupState = "failed";
          return result;
        }
        initialCompleted.set(`${agentIndex}:${turnIndex}`, entry);
        counts.completedSetupTurns++;
      }
      if (agentIndex < config.uncertainAgents) {
        const entry = newEntry(agentIndex, config.retainedTurnsPerAgent, "uncertain");
        const result = await runNewAttempt(entry, false);
        if (result.outcome !== "completed") {
          setupState = "failed";
          return result;
        }
        initialUncertain.set(agentIndex, entry);
        counts.uncertainSetupAttempts++;
      }
    }
    setupState = "complete";
    return { outcome: "completed", details: detached(counts) };
  };
  const execute = async (operation) => {
    invariant(null, "execute", setupState === "complete", "setup-not-complete");
    const keys = Reflect.ownKeys(operation ?? {});
    invariant(
      null,
      "execute",
      keys.length === 4 &&
        ["index", "kind", "agentIndex", "turnIndex"].every(
          (key) =>
            Object.hasOwn(operation, key) &&
            "value" in Object.getOwnPropertyDescriptor(operation, key),
        ),
      "invalid-planned-operation",
    );
    const exact = {
      index: operation.index,
      kind: operation.kind,
      agentIndex: operation.agentIndex,
      turnIndex: operation.turnIndex,
    };
    invariant(
      null,
      "execute",
      allowedOperations.has(JSON.stringify(exact)),
      "operation-not-in-plan",
    );
    const key = `${exact.agentIndex}:${exact.turnIndex}`;
    if (signal.aborted || stopped)
      return fail("unavailable", "execute", null, {
        plannedOperation: exact,
        reason: "workload-stopped",
      });
    if (exact.kind === "append-completed-turn") {
      invariant(
        null,
        "append",
        exact.agentIndex >= config.uncertainAgents && !attemptedAppends.has(key),
        "append-locator-already-attempted-or-ineligible",
      );
      attemptedAppends.add(key);
      const entry = newEntry(exact.agentIndex, exact.turnIndex, "append");
      const result = await runNewAttempt(entry, true);
      if (result.outcome === "completed") counts.completedAppends++;
      return result;
    }
    const entry =
      exact.kind === "uncertain-attempt-read"
        ? initialUncertain.get(exact.agentIndex)
        : initialCompleted.get(key);
    invariant(entry, "execute", entry !== undefined, "planned-target-missing");
    const v = entry.values;
    if (exact.kind === "duplicate-admission") {
      const result = await mutate(entry, "exact-replay", v.observation, (journal, call) =>
        journal.admit(entry.admissionHandle, call),
      );
      const failure = requireKind(result, "recorded", entry, "exact-replay");
      if (failure) return failure;
      invariant(
        entry,
        "exact-replay",
        result.value.duplicate === false &&
          equal(result.value.record, entry.admission.record) &&
          equal(result.value.incomingLink, entry.admission.incomingLink),
        "original-owner-or-link-changed",
      );
      return {
        outcome: "exact-replay",
        details: {
          stage: "exact-replay",
          manifestPointer: manifestPointer(entry),
          duplicate: result.value.duplicate,
        },
      };
    }
    const uncertain = exact.kind === "uncertain-attempt-read";
    const result = await read(
      entry,
      exact.kind,
      uncertain ? v.attempt : v.completionOperation,
      (journal, call) =>
        uncertain
          ? journal.findAttempt(v.attempt, call)
          : journal.findCompletion(v.completionOperation, call),
    );
    const failure = requireKind(result, uncertain ? "found" : "published", entry, exact.kind);
    if (failure) return failure;
    invariant(
      entry,
      exact.kind,
      equal(result.value.record, uncertain ? entry.attemptRecord : entry.completion),
      "protected-record-changed",
    );
    return {
      outcome: "verified-read",
      details: { stage: exact.kind, manifestPointer: manifestPointer(entry) },
    };
  };
  const verify = async () => {
    if (setupState !== "complete")
      return fail("unavailable", "verify", null, { reason: "setup-not-complete" });
    const verified = {
      completedTurnsVerified: 0,
      uncertainAttemptsVerified: 0,
      busyOwnersVerified: 0,
      headsVerified: 0,
      pendingDeliveriesVerified: 0,
      admissionOwnersVerified: 0,
      incomingLinksVerified: 0,
      uncertainReservationVerification: "not-exposed-by-public-journal-read",
      unverifiedGeneratedEntries: [],
    };
    for (const entry of entries) {
      if (!["completed-released", "outcome-unknown-unreleased", "busy"].includes(entry.stage)) {
        verified.unverifiedGeneratedEntries.push({
          manifestPointer: manifestPointer(entry),
          stage: entry.stage,
          reason: "partial-or-uncertain-lifecycle",
        });
        continue;
      }
      const v = entry.values;
      const incoming = fixture.incomingLookup(v.identity);
      let result = await read(entry, "verify-incoming-link", incoming, (journal, call) =>
        journal.findIncomingLink(incoming, call),
      );
      let failure = requireKind(result, "found", entry, "verify-incoming-link");
      if (failure) return failure;
      invariant(
        entry,
        "verify-incoming-link",
        equal(result.value.link, entry.admission.incomingLink) &&
          equal(result.value.original, entry.admission.record),
        "protected-admission-owner-or-link-changed",
      );
      verified.admissionOwnersVerified++;
      verified.incomingLinksVerified++;
      if (entry.stage === "busy") {
        verified.busyOwnersVerified++;
        continue;
      }
      result = await read(entry, "verify-attempt", v.attempt, (journal, call) =>
        journal.findAttempt(v.attempt, call),
      );
      failure = requireKind(result, "found", entry, "verify-attempt");
      if (failure) return failure;
      invariant(
        entry,
        "verify-attempt",
        equal(result.value.record, entry.attemptRecord),
        "protected-attempt-changed",
      );
      if (entry.cohort === "uncertain") {
        verified.uncertainAttemptsVerified++;
        result = await read(entry, "verify-uncertain-head", v.context, (journal, call) =>
          journal.readHead(v.context, call),
        );
        if (result.failure) return result.failure;
        invariant(
          entry,
          "verify-uncertain-head",
          result.value.kind === "unavailable" && result.value.reason === "store-unavailable",
          "uncertain-context-exposed-head",
        );
        continue;
      }
      result = await read(entry, "verify-completion", v.completionOperation, (journal, call) =>
        journal.findCompletion(v.completionOperation, call),
      );
      failure = requireKind(result, "published", entry, "verify-completion");
      if (failure) return failure;
      invariant(
        entry,
        "verify-completion",
        equal(result.value.record, entry.completion),
        "protected-completion-changed",
      );
      verified.completedTurnsVerified++;
      result = await read(entry, "verify-head", v.context, (journal, call) =>
        journal.readHead(v.context, call),
      );
      failure = requireKind(result, "completed", entry, "verify-head");
      if (failure) return failure;
      invariant(
        entry,
        "verify-head",
        equal(result.value.head, entry.completion.head) &&
          equal(result.value.checkpoint, entry.completion.checkpoint),
        "protected-head-changed",
      );
      verified.headsVerified++;
      result = await read(entry, "verify-delivery", v.delivery, (journal, call) =>
        journal.findDelivery(v.delivery, call),
      );
      failure = requireKind(result, "pending", entry, "verify-delivery");
      if (failure) return failure;
      verified.pendingDeliveriesVerified++;
    }
    invariant(
      null,
      "verify",
      verified.completedTurnsVerified === counts.completedSetupTurns + counts.completedAppends &&
        verified.uncertainAttemptsVerified === counts.uncertainSetupAttempts &&
        verified.busyOwnersVerified === counts.busyAppends,
      "protected-cohort-count-mismatch",
    );
    return { outcome: "verified-read", details: verified };
  };
  const manifest = () => ({
    schemaVersion: 1,
    evidence: "synthetic-repository-fixture",
    semanticSeed: config.seed,
    configSha256: plan.configSha256,
    identifierGeneration:
      "random-identifiers-from-original-storage-fixture; semantic seed does not reproduce UUIDs",
    setupState,
    counts: detached(counts),
    countScope: "acknowledged observations only; unknown commit effects are not counted as absent",
    transactionCountScope:
      "journal store transactions; original owner seed commits are outside this counter",
    contextCount: entries.filter((entry) => entry.canonicalAttemptCreated).length,
    generatedContextCount: entries.length,
    contextLayout: "one distinct conversation per generated turn",
    replyDimension: {
      status: "unmeasured",
      requestedBytes: config.replyBytes,
      reason: "repository-fixture-has-no-reply-payload-field",
    },
    observedJsonUtf8Bytes: {
      scope:
        "synthetic fixture request values and returned journal .record fields, not wire requests, database rows, or canonical payloads",
      ...detached(sizes),
    },
    transactionLatency: {
      scope: "transaction-total-including-commit-acknowledgment",
      excludes: "isolated SQL COMMIT duration, fsync latency, and post-transaction readback",
      groups: [...transactionTimings.values()].map(({ samplesMs, ...identity }) => ({
        ...identity,
        ...summarizeLatencies(samplesMs),
      })),
    },
    uncertainReservationVerification:
      "not-exposed-by-public-journal-read; helper never requests release of uncertain entries",
    owners: owners.map((owner, agentIndex) => ({
      agentIndex,
      installationRef: owner.installation.id,
      namespaceRef: owner.namespace.id,
      agentRef: owner.agent.id,
      revisionRef: owner.revision.id,
      channelInstallationRef: owner.channelInstallation.id,
    })),
    entries: entries.map((entry) => ({
      ...locator(entry),
      stage: entry.stage,
      stageMeaning: "last acknowledged phase",
      canonicalAttemptAcknowledged: entry.canonicalAttemptCreated,
      requestSha256: detached(entry.requestSha256),
      transactions: detached(entry.transactions),
      completionRecordSha256: entry.completion ? sha256(entry.completion) : null,
      attemptRecordSha256: entry.attemptRecord ? sha256(entry.attemptRecord) : null,
    })),
    lastFailure: detached(lastFailure),
    commitUnknownFailures: detached(commitUnknownFailures),
  });
  return Object.freeze({ setup, execute, verify, manifest });
}
