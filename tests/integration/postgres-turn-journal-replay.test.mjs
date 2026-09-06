import assert from "node:assert/strict";
import test from "node:test";
import {
  createPurgeManifestV1,
  initialPurgeProgressV1,
} from "@openclaw-enterprise/contracts/retirement-purge-manifest-v1";
import { createPostgresTurnJournalReplayParticipant } from "../../packages/occ/src/state/postgres/turn-journal-replay.ts";
import { TurnJournalTransactionGuard } from "../../packages/occ/src/turn-journal/transaction-guard.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";
import {
  manifestBody,
  retirementBinding,
  observationInput,
} from "../fixtures/turn-journal-replay/values.mjs";

// These executable cases exercise only the actual participant's unavailable
// composition boundary and its two existing owner guards. Dependencies below are
// tripwires: they never return a row, grant authority, or emulate PostgreSQL.
// Passing these cases is not evidence that PostgreSQL or a complete outer owner
// has been integrated. The real PG obligations remain TODO below.
function unavailableComposition() {
  const lifetime = new RepositoryTransactionLifetime();
  const guard = new TurnJournalTransactionGuard();
  const calls = { query: 0, scope: 0, installation: 0, retirement: 0, observation: 0 };
  const forbidden = (name) => {
    calls[name]++;
    throw new Error(`Unavailable composition accessed ${name}.`);
  };
  const participant = createPostgresTurnJournalReplayParticipant({
    transaction: lifetime,
    guard,
    get scope() {
      return forbidden("scope");
    },
    query: { query: async () => forbidden("query") },
    currentInstallation: async () => forbidden("installation"),
  });
  const provenance = {
    inspectRetirement: async () => forbidden("retirement"),
    inspectObservation: async () => forbidden("observation"),
  };
  return { lifetime, guard, calls, participant, provenance };
}

function carriers() {
  const manifest = createPurgeManifestV1(manifestBody());
  const record = {
    schemaVersion: 1,
    binding: retirementBinding(manifest),
    progress: initialPurgeProgressV1(manifest),
    auditIntentRef: "synthetic-audit-intent-reference",
    durableProgressResponsibilityRef: "synthetic-progress-responsibility-reference",
  };
  return {
    retirement: {
      binding: record.binding,
      manifest,
      auditIntentRef: record.auditIntentRef,
      durableProgressResponsibilityRef: record.durableProgressResponsibilityRef,
    },
    observation: observationInput(record),
  };
}

function assertNoCompositionCalls(boundary) {
  assert.deepEqual(boundary.calls, {
    query: 0,
    scope: 0,
    installation: 0,
    retirement: 0,
    observation: 0,
  });
}

test("local participant boundary: parseable carriers cannot publish without the whole owner", async () => {
  const boundary = unavailableComposition();
  const values = carriers();
  try {
    // These are deliberately plain data and an invalid call, never owner-issued
    // VerifiedPurge handles. The original required producers are unavailable.
    assert.deepEqual(
      await boundary.participant.publishRetirement(
        values.retirement.binding.originalTransactionRef,
        values.retirement,
        Object.freeze({}),
        boundary.provenance,
      ),
      { kind: "unavailable" },
    );
    assert.deepEqual(
      await boundary.participant.recordObservation(
        values.observation.originalTransactionRef,
        values.observation,
        Object.freeze({}),
        boundary.provenance,
      ),
      { kind: "unavailable" },
    );
    // A self-consistent ref/version pair is not the absent original activation
    // and measured-clock producer, including after an old backup is reopened.
    assert.deepEqual(await boundary.participant.inspectLineage(values.retirement.binding), {
      kind: "unavailable",
    });
    assertNoCompositionCalls(boundary);
    // The participant borrows the existing owner guard; it cannot finish or
    // close the outer owner's transaction through an outward method.
    assert.equal("finish" in boundary.participant, false);
    assert.equal("close" in boundary.participant, false);
    await boundary.guard.finish();
    await boundary.lifetime.finish();
  } finally {
    boundary.guard.close();
    boundary.lifetime.close();
  }
});

test("local participant boundary: a closed original guard rejects both command entries", async () => {
  const boundary = unavailableComposition();
  const values = carriers();
  boundary.guard.close();
  try {
    await assert.rejects(
      boundary.participant.publishRetirement(
        values.retirement.binding.originalTransactionRef,
        values.retirement,
        {},
        boundary.provenance,
      ),
      ScopeViolationError,
    );
    await assert.rejects(
      boundary.participant.recordObservation(
        values.observation.originalTransactionRef,
        values.observation,
        {},
        boundary.provenance,
      ),
      ScopeViolationError,
    );
    assertNoCompositionCalls(boundary);
  } finally {
    boundary.lifetime.close();
  }
});

test("local participant boundary: caught borrowed-lifetime failure poisons the same guard", async () => {
  const boundary = unavailableComposition();
  const values = carriers();
  boundary.lifetime.close();
  try {
    await assert.rejects(
      boundary.participant.publishRetirement(
        values.retirement.binding.originalTransactionRef,
        values.retirement,
        {},
        boundary.provenance,
      ),
      ScopeViolationError,
    );
    await assert.rejects(
      boundary.participant.recordObservation(
        values.observation.originalTransactionRef,
        values.observation,
        {},
        boundary.provenance,
      ),
      ScopeViolationError,
    );
    await assert.rejects(boundary.guard.finish(), ScopeViolationError);
    assertNoCompositionCalls(boundary);
  } finally {
    boundary.guard.close();
  }
});

test("local participant boundary: finish drains an unawaited rejected command before refusing", async () => {
  const boundary = unavailableComposition();
  const values = carriers();
  boundary.lifetime.close();
  try {
    const operation = boundary.participant.recordObservation(
      values.observation.originalTransactionRef,
      values.observation,
      {},
      boundary.provenance,
    );
    // Attach a rejection observer immediately, but do not await the operation
    // before the original guard finishes. No database work is being simulated.
    const observedFailure = operation.then(
      () => assert.fail("A revoked borrowed transaction returned a result."),
      (error) => error,
    );
    await assert.rejects(boundary.guard.finish(), ScopeViolationError);
    assert.ok((await observedFailure) instanceof ScopeViolationError);
    assertNoCompositionCalls(boundary);
  } finally {
    boundary.guard.close();
  }
});

// AUTHOR-ONLY PostgreSQL obligations. No database is opened by this file, even
// when ordinary PostgreSQL environment settings are present. There is no mock
// store, SQL emulator, replacement authority, or synthetic clock-success port.
// TODO(PER-13 owner composition): replace each declaration with executable tests
// using the real outer owner after allocation of its hooks, a reviewed additive
// migration, and a dedicated database with the limited application role.
const prerequisites =
  "UNEXECUTED: requires allocated PostgreSQL/migration and actual original owner, activation, measured-clock, mandatory-audit and progress-responsibility hooks";

// Each entry is an explicit future setup/interleaving/assertion contract. Its
// registration is TODO evidence only; it is never counted as a passed PG case.
export const futurePostgresReplayCases = Object.freeze(
  [
    {
      name: "fresh admission commits before retirement",
      setup:
        "Use an authentically activated exact native root-thread route and two original owner transactions.",
      interleave:
        "Pause retirement at the shared installation admission lock while fresh admission commits, then resume retirement.",
      expect:
        "The accepted owner/reservation persists without renewal; retirement blocks later fresh ownership and retains the already accepted or uncertain work for containment.",
    },
    {
      name: "retirement commits before fresh admission of the same generation",
      setup:
        "Use the real stopped head, full immutable lineage, manifest inventory, mandatory audit and durable progress responsibility.",
      interleave:
        "Hold the retirement owner before commit while a fresh admission waits on the same installation lock; commit retirement and release the waiter.",
      expect:
        "Fresh admission creates no owner or reservation for the retired tuple and invokes no initiation callback; rejected/non-turn persistence cannot bypass this decision.",
    },
    {
      name: "activation wins against stale retirement inventory",
      setup:
        "Prepare a real original activation operation and a retirement command whose exact predecessor projection predates it.",
      interleave:
        "Commit activation first under the shared lock prefix, then let retirement acquire the prefix and revalidate the full target set.",
      expect:
        "Retirement conflicts on the stale lineage/set and atomically leaves stopped head, barrier, manifest, audit and responsibility unchanged.",
    },
    {
      name: "retirement wins against reactivation of an existing identity",
      setup:
        "Reserve an original target obligation at creation and retain its original activation and clock association.",
      interleave:
        "Commit retirement before an activation attempt for that exact retired route/context/channel generation.",
      expect:
        "Permanent retirement is monotonic; no update, retry, mapping status change or new receipt revives the retired identity.",
    },
    {
      name: "channel-parent versus Agent contention has one lock order",
      setup:
        "Use real createAgentBinding, fresh journal admission and retirement operations contending for the same ChannelInstallation and Agent.",
      interleave:
        "Pause each original owner in turn at J, sorted exact ChannelInstallation parents, Namespace, Agent, mapping/head, then lineage/barrier/progress.",
      expect:
        "All owners use turn-journal-admission:<installationId> before parent and Agent locks; bounded completion and actual lock observations show no inverse parent/Agent wait cycle.",
    },
    {
      name: "multiple exact parents are selected, sorted and revalidated",
      setup:
        "Use a real retirement inventory spanning several ChannelInstallation parents with distinct byte-sort order.",
      interleave:
        "Compete with a mapping change while retirement acquires its complete sorted parent set under J.",
      expect:
        "The owner revalidates that exact set before writing; a newly appearing or changed parent conflicts instead of acquiring an upstream parent lock after Agent.",
    },
    {
      name: "cancellation across retirement keeps original uncertain ownership",
      setup:
        "Use a genuinely accepted attempt and original cancellation/protective lifecycle owners.",
      interleave:
        "Race cancellation and retirement before and after accepted work enters its uncertain external state.",
      expect:
        "Retirement prevents new initiation, while existing unknown work remains owned until authentic observation/containment permits resolution; historical lookup never initiates work.",
    },
    {
      name: "completion across retirement does not reopen acceptance",
      setup:
        "Use actual checkpoint allocation/completion and an accepted attempt associated with the soon-retired generation.",
      interleave:
        "Race completion and retirement in both commit orders using the original mutation entry prefixes.",
      expect:
        "Canonical completion ownership stays coherent, the permanent barrier remains, and completion cannot mint new generation eligibility or restart a consumed callback.",
    },
    {
      name: "first observation receipt survives another target advancing progress",
      setup:
        "Publish a real two-store retirement manifest and record an authentically observed first receipt at record version 2.",
      interleave:
        "Advance the second store to global record version 3, then repeat the exact original observation command with its original transaction locator and stale original expected version.",
      expect:
        "After current authorization, the owner returns existing with current progress and byte-equivalent first receipt still stamped version 2; progress and original receipt are unchanged.",
    },
    {
      name: "same-target later progress retains the exact original receipt",
      setup:
        "Record an original present/unknown observation, then a genuinely later sequence for the same immutable target.",
      interleave: "Read and replay the original observation after the later sequence commits.",
      expect:
        "First transaction, evidence, source time, target precondition and recorded version remain immutable; an absent receipt can never have a successor observation.",
    },
    {
      name: "changed contents under an original observation identity conflict",
      setup:
        "Retain one actual first receipt and its original binding, target, deletion operation, sequence and evidence.",
      interleave:
        "Individually change original transaction, stopped head, barrier, lineage, object version, evidence, source time or contents while reusing the observation identity.",
      expect:
        "Every changed retry conflicts and leaves the original receipt and progress byte-equivalent; no field is overwritten or silently treated as a new observation.",
    },
    {
      name: "current authorization denial precedes exact receipt replay and history",
      setup:
        "Record a receipt with authentic authority, then revoke that operation's current permission through the real owner.",
      interleave:
        "Retry the exact observation and perform its exact historical read under fresh denied and unavailable calls.",
      expect:
        "Denied/unavailable results expose no stored record or receipt; the original cached success cannot bypass current inspection.",
    },
    {
      name: "competing new observations use one global progress CAS",
      setup:
        "Use two authentic new observations for separate stores sharing the same expected current record version.",
      interleave: "Release both original observation owner transactions concurrently.",
      expect:
        "Exactly one advances the global version and creates its first receipt; the stale competitor conflicts with no receipt or partial progress.",
    },
    {
      name: "caught participant failure poisons the real outer unit",
      setup:
        "Enter the actual complete owner command and induce a genuine SQL/participant failure after earlier writes in that transaction.",
      interleave:
        "Catch the failure in accepted work and attempt a later mutation before owner completion.",
      expect:
        "The owner poison guard refuses later work and COMMIT; stopped head, barrier, manifest, mandatory audit, responsibility and progress all roll back.",
    },
    {
      name: "unawaited accepted failure is drained and prevents COMMIT",
      setup:
        "Use the real borrowed lifetime and owner poison/drain path with an accepted operation whose actual query later fails.",
      interleave:
        "Let outer work return without awaiting that accepted operation, then release the failing query while finish drains.",
      expect:
        "The owner waits for accepted work, records the poison and rolls back; no positive result or callback escapes before the actual outcome.",
    },
    {
      name: "cancellation revokes borrowed access before and after an await",
      setup:
        "Use original transaction cancellation and a participant operation paused at a genuine database await.",
      interleave:
        "Cancel the original owner, release the await, then attempt to reuse a captured participant reference.",
      expect:
        "Borrowed access fails closed on both sides of the await; no nested transaction, independent connection or surviving write capability is created.",
    },
    {
      name: "rollback has no durable retirement or initiation callback",
      setup:
        "Use the original whole retirement command and a real transaction that will roll back after staged participant work.",
      interleave:
        "Cause the actual outer rollback, wait for complete owner unwind, then read exact history through a new authorized read owner.",
      expect:
        "All command writes are absent, readback is non-actionable and no initiation/deletion callback is invoked.",
    },
    {
      name: "lost COMMIT acknowledgment permits exact readback only after unwind",
      setup:
        "Use an allocated PostgreSQL transport fault at the actual outer COMMIT acknowledgment boundary; retain the preknown original locator.",
      interleave:
        "Allow the database outcome to settle, lose its acknowledgment, unwind the old owner and perform one fresh authorized exact history lookup.",
      expect:
        "commit-unknown retains the original transactionRef; matching history returns only original immutable metadata; no automatic resubmission, callback, deletion or new transaction identity occurs.",
    },
    {
      name: "retirement head, barrier, manifest, audit and progress responsibility are atomic",
      setup:
        "Use genuine protected stopped-head, complete inventory, measured-clock lineage, mandatory-audit and durable-responsibility producers.",
      interleave:
        "Fail each actual internal phase in a separate transaction, then run a successful complete owner command.",
      expect:
        "Failure leaves none of the new linked rows; success commits exactly one mutually corresponding stopped head/barrier/manifest/audit/responsibility/progress set on the same owner transaction.",
    },
    {
      name: "predecessor or original activation lineage mismatch rejects publication",
      setup:
        "Retain original activation operation, full target tuple, installation/activation generations, notBefore, acceptance/pruning boundary and measured-clock association.",
      interleave:
        "Attempt publication with each independently changed predecessor or lineage field, including route root thread and context creationRef.",
      expect:
        "Every mismatch conflicts without publication; current mapping/version, lifecycle generation, first receipt time or opaque reference strings do not substitute for original lineage.",
    },
    {
      name: "capacity is durably reserved before original generation creation",
      setup:
        "Use the actual channel/route creation owner and installation-scoped reservation accounting, initially below 10000 obligations; reserve the original known identity before the protected producer assigns a future generation. First channel creation uses installation-only scope before the channel parent row exists; route/context reservations require their real scoped parents.",
      interleave:
        "Compete to create the final available original generations; separately abort a creation transaction after its reservation step.",
      expect:
        "Committed generations never exceed 10000 reserved obligations; pending reservation contains no guessed activation/installation generation, active eligibility and its matching reservation commit atomically, an aborted creation leaves neither, and arithmetic alone is not counted as a reservation. The exact deferred channel-parent foreign key must hold at actual outer COMMIT; an absent parent aborts that transaction.",
    },
    {
      name: "full capacity still permits disabling and retiring an existing generation",
      setup:
        "Fill the allocated installation through real original generation creation until 10000 permanent obligations are reserved.",
      interleave:
        "Attempt one new generation while disabling/retiring an already reserved exact target.",
      expect:
        "Only the new obligation is refused; retirement consumes its existing reservation and permanently preserves the barrier without freeing capacity or requiring record 10001.",
    },
    {
      name: "limited application role cannot rewrite immutable headers or erase barriers",
      setup:
        "Apply the reviewed additive migration with its migrator role, then operate only as the less-privileged application role.",
      interleave:
        "Attempt direct changes to owner/operation headers, first receipts, full lineage, retained target identity and permanent barriers through the allocated database connection.",
      expect:
        "Database constraints and role restrictions refuse each forbidden mutation; permitted exact owner operations still work and retained headers remain unchanged.",
    },
    {
      name: "direct old writers cannot bypass retirement checks",
      setup:
        "Use the final combined original journal/channel/lifecycle writers and a permanently retired exact generation.",
      interleave:
        "Exercise every old fresh-admission, rejected/non-turn, mapping activation and generation-accepting writer under the application role.",
      expect:
        "Each accepting path consults the sole barrier under the agreed prefix; no legacy write creates active eligibility or ownership without its required reservation and original lineage.",
    },
    {
      name: "reopen and additive upgrade preserve old journal and retirement state",
      setup:
        "Use an allocated disposable database with real preexisting journal ownership; apply only the reviewed new additive migration without editing already applied 0022.",
      interleave:
        "Create retirement/receipt state with genuine owner commands, close all owners, reopen a fresh owner and read original exact history.",
      expect:
        "Prior owner identities and permanent retirement persist; receipt/history correspondence survives reopen; no destructive reset or implicit schema/bootstrap operation occurs in the test runner.",
    },
    {
      name: "restart or restored backup cannot prove its own current activation",
      setup:
        "Use an explicitly allocated restart/backup exercise retaining self-consistent old journal rows but without current independent original activation/clock correspondence.",
      interleave:
        "Start the original owner against those rows and attempt fresh activation/admission, then perform allowed exact historical discovery.",
      expect:
        "Fresh eligibility remains unavailable until genuine original-owner recovery; retained old records cannot attest their own currentness or renew notBefore, while permanent retirement and unknown ownership survive.",
    },
    {
      name: "acceptance boundary permits legitimate out-of-order messages without renewal",
      setup:
        "Use authentic original activation notBefore and acceptance/pruning history with two native messages whose creation order differs from arrival order.",
      interleave:
        "Admit the later-created message first, then the earlier-created but still eligible message; replay a duplicate afterward.",
      expect:
        "A maximum observed message timestamp does not become an invented watermark; the duplicate retains original receipt, ownership, notBefore and retention without gaining initiation eligibility.",
    },
  ].map((entry) => Object.freeze(entry)),
);

for (const scenario of futurePostgresReplayCases) {
  test.todo(`PostgreSQL replay: ${scenario.name}`, { todo: prerequisites });
}
