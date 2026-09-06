import assert from "node:assert/strict";
import test from "node:test";
import { createCredentialInventoryV1 } from "../../packages/occ/src/credential-inventory-v1/inventory.ts";
import { SyntheticInventoryBackendV1 } from "../fixtures/credential-inventory-v1/synthetic-backend.ts";
import * as c from "../fixtures/credential-inventory-v1/cases.ts";
import {
  inventoryIntentDigestV1,
  terminalInventoryRetentionElapsedV1,
} from "../../packages/occ/src/credential-inventory-v1/transactions.ts";
import {
  canonicalCredentialStorageRequestV1,
  parseCredentialStorageV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import { createHash } from "node:crypto";
import { compose } from "../fixtures/credential-inventory-v1/producer.ts";
import { bindCredentialInventoryBackendV1 } from "../fixtures/credential-inventory-v1/consumer.ts";
const bounds = () => ({ signal: new AbortController().signal });
async function reserved(b = new SyntheticInventoryBackendV1(), suffix = "example") {
  const p = b.port(),
    input = c.reserve("reserve/" + suffix, b.now);
  const result = await p.reserveIssuanceV1(input, b.current(input), bounds());
  assert.equal(result.kind, "reserved");
  return { b, p, input, row: result.record };
}
async function minted(b = new SyntheticInventoryBackendV1(), suffix = "example") {
  const s = await reserved(b, suffix);
  const claim = c.mintClaim(s.row, "mint-use/" + suffix, b.now);
  const claimed = await s.p.claimProviderMintV1(claim, b.current(claim), bounds());
  assert.equal(claimed.kind, "claimed");
  const row = b.records().find((row) => row.target.recordRef === s.row.target.recordRef);
  const input = c.accepted(row, claim.providerAttemptRef, "mint-outcome/" + suffix, b.now);
  const token = b.token(input.tokenRef, input.protectedRevocationRef);
  const result = await s.p.recordMintOutcomeV1(input, b.mitigation(input), token, bounds());
  assert.equal(result.kind, "recorded");
  assert.equal(result.record.state, "outstanding");
  return { ...s, claim, accepted: input, token, result, row: result.record };
}
test("actual contract canonical digest, immutable reservation and exact duplicate conflict", async () => {
  const s = await reserved();
  const expected =
    "sha256:" +
    createHash("sha256")
      .update(canonicalCredentialStorageRequestV1("reserve", s.input))
      .digest("hex");
  assert.equal(inventoryIntentDigestV1(s.input), expected);
  assert.equal(s.row.target.intentDigest, expected);
  s.input.grant.repositoryIds.push("202");
  const changed = await s.p.reserveIssuanceV1(s.input, s.b.current(s.input), bounds());
  assert.deepEqual(changed, { kind: "conflict", reason: "operation-conflict" });
  const original = s.b.operations()[0].input;
  const duplicate = await s.p.reserveIssuanceV1(original, s.b.current(original), bounds());
  assert.equal(duplicate.kind, "existing");
  assert.equal(duplicate.nextAction, "reconcile-only");
  assert.deepEqual(s.b.records()[0].issuance.grant.repositoryIds, ["101"]);
});
test("synthetic two-instance serialization permits one pending issuance per scope", async () => {
  const b = new SyntheticInventoryBackendV1(),
    p1 = b.port(),
    p2 = b.port();
  const a = c.reserve("reserve/a"),
    z = c.reserve("reserve/z");
  const results = await Promise.all([
    p1.reserveIssuanceV1(a, b.current(a), bounds()),
    p2.reserveIssuanceV1(z, b.current(z), bounds()),
  ]);
  assert.deepEqual(results.map((r) => r.kind).sort(), ["capacity-exhausted", "reserved"]);
});
test("unknown reservation commit retains exact digest and readback after synthetic reconstruction", async () => {
  const b = new SyntheticInventoryBackendV1(),
    input = c.reserve();
  b.fault = "unknown-committed";
  const unknown = await b.port().reserveIssuanceV1(input, b.current(input), bounds());
  assert.equal(unknown.kind, "commit-unknown");
  assert.equal(unknown.intentDigest, inventoryIntentDigestV1(input));
  const restarted = new SyntheticInventoryBackendV1();
  restarted.restore(b.checkpoint());
  const read = c.read(input);
  const result = await restarted.port().readOperationV1(read, restarted.reader(read), bounds());
  assert.equal(result.kind, "found");
  assert.equal(result.nextAction, "observation-only");
  const duplicate = await restarted
    .port()
    .reserveIssuanceV1(input, restarted.current(input), bounds());
  assert.equal(duplicate.kind, "existing");
});
test("unknown noncommit readback stays not-found/exact-readback-only", async () => {
  const b = new SyntheticInventoryBackendV1(),
    input = c.reserve();
  b.fault = "unknown-rolled-back";
  assert.equal(
    (await b.port().reserveIssuanceV1(input, b.current(input), bounds())).kind,
    "commit-unknown",
  );
  const read = c.read(input);
  assert.deepEqual(await b.port().readOperationV1(read, b.reader(read), bounds()), {
    kind: "not-found",
    nextAction: "exact-readback-only",
  });
});
test("unclassified error after commit remains unknown and found on exact readback", async () => {
  const b = new SyntheticInventoryBackendV1(),
    input = c.reserve();
  b.fault = "throw-after-commit";
  assert.equal(
    (await b.port().reserveIssuanceV1(input, b.current(input), bounds())).kind,
    "commit-unknown",
  );
  const read = c.read(input);
  assert.equal((await b.port().readOperationV1(read, b.reader(read), bounds())).kind, "found");
});
test("single mint claim persists before outcome and cannot be reissued by another operation", async () => {
  const s = await reserved();
  const claim = c.mintClaim(s.row);
  s.b.fault = "unknown-committed";
  assert.equal(
    (await s.p.claimProviderMintV1(claim, s.b.current(claim), bounds())).kind,
    "commit-unknown",
  );
  assert.equal(s.b.records()[0].state, "mint-unknown");
  const second = { ...claim, operationRef: "mint-use/other", providerAttemptRef: "attempt/other" };
  assert.deepEqual(await s.p.claimProviderMintV1(second, s.b.current(second), bounds()), {
    kind: "existing",
    nextAction: "reconcile-only",
  });
  assert.equal(
    s.b.operations().filter((op) => op.input.method === "withNamedCredential").length,
    1,
  );
});
test("accepted token custody and mitigation-only disposition precede any disabled delivery", async () => {
  const s = await minted();
  let deliveries = 0;
  assert.equal(s.row.disposition, "mitigation-only");
  assert.equal(s.row.delivery.state, "not-delivered");
  assert.equal(
    (
      await s.p.deliverRecordedTokenV1(
        {},
        {},
        async () => {
          deliveries++;
        },
        bounds(),
      )
    ).kind,
    "unavailable",
  );
  assert.equal(deliveries, 0);
});
test("missing or foreign material never records accepted token", async () => {
  const s = await reserved(),
    claim = c.mintClaim(s.row);
  await s.p.claimProviderMintV1(claim, s.b.current(claim), bounds());
  const input = c.accepted(s.b.records()[0], claim.providerAttemptRef);
  assert.equal(
    (await s.p.recordMintOutcomeV1(input, s.b.mitigation(input), undefined, bounds())).kind,
    "denied",
  );
  const wrong = s.b.token("foreign/token", "foreign/revoke");
  assert.equal(
    (await s.p.recordMintOutcomeV1(input, s.b.mitigation(input), wrong, bounds())).kind,
    "commit-unknown",
  );
  assert.equal(s.b.records()[0].state, "mint-unknown");
});
test("changed duplicate mint body conflicts and exact duplicate preserves original receipt after time advance", async () => {
  const s = await minted(),
    writes = s.b.writes;
  s.b.now += 1000;
  const repeated = {
    ...s.accepted,
    createdAt: new Date(s.b.now).toISOString(),
    deadline: new Date(s.b.now + 5000).toISOString(),
  };
  const duplicate = await s.p.recordMintOutcomeV1(
    repeated,
    s.b.mitigation(repeated),
    s.token,
    bounds(),
  );
  assert.equal(duplicate.kind, "recorded");
  assert.deepEqual(duplicate.receipt, s.result.receipt);
  assert.equal(s.b.writes, writes);
  const changed = { ...repeated, providerEvidenceRef: "different/evidence" };
  assert.equal(
    (await s.p.recordMintOutcomeV1(changed, s.b.mitigation(changed), s.token, bounds())).kind,
    "conflict",
  );
});
test("missing original receipt yields inventory-unavailable while original operation remains found", async () => {
  const b = new SyntheticInventoryBackendV1();
  b.retainReceipts = false;
  const s = await minted(b),
    writes = b.writes;
  b.now += 1000;
  const repeated = {
    ...s.accepted,
    createdAt: new Date(b.now).toISOString(),
    deadline: new Date(b.now + 5000).toISOString(),
  };
  assert.deepEqual(
    await s.p.recordMintOutcomeV1(repeated, b.mitigation(repeated), s.token, bounds()),
    { kind: "unavailable", reason: "inventory-unavailable" },
  );
  const read = c.read(s.accepted, b.now);
  assert.equal((await s.p.readOperationV1(read, b.reader(read), bounds())).kind, "found");
  assert.equal(b.writes, writes);
});
test("known tokens overlap up to finite capacity; unresolved rows never age out", async () => {
  const b = new SyntheticInventoryBackendV1();
  for (let i = 0; i < 4; i++) await minted(b, "token-" + i);
  const fifth = c.reserve("reserve/fifth");
  assert.equal(
    (await b.port().reserveIssuanceV1(fifth, b.current(fifth), bounds())).kind,
    "capacity-exhausted",
  );
  assert.equal(b.records().length, 4);
  for (const row of b.records())
    assert.equal(terminalInventoryRetentionElapsedV1(row, b.now + 100 * 86400000), false);
});
test("persisted snapshot preserves unknown member across late mint and synthetic owner reconstruction", async () => {
  const b = new SyntheticInventoryBackendV1();
  const known = await minted(b, "known"),
    pending = await reserved(b, "pending");
  const query = c.query(known.row);
  const first = await b.port().listAffectedV1(query, b.reader(query), bounds());
  assert.equal(first.kind, "page");
  assert.equal(first.unresolvedIssuanceCount, 1);
  assert.ok(first.next);
  const claim = c.mintClaim(pending.row, "mint-use/late");
  await b.port().claimProviderMintV1(claim, b.current(claim), bounds());
  const input = c.accepted(
    b.records().find((row) => row.target.recordRef === pending.row.target.recordRef),
    claim.providerAttemptRef,
    "mint-outcome/late",
  );
  await b
    .port()
    .recordMintOutcomeV1(
      input,
      b.mitigation(input),
      b.token(input.tokenRef, input.protectedRevocationRef),
      bounds(),
    );
  const restarted = new SyntheticInventoryBackendV1();
  restarted.restore(b.checkpoint());
  const nextQuery = { ...query, cursor: first.next };
  const last = await restarted
    .port()
    .listAffectedV1(nextQuery, restarted.reader(nextQuery), bounds());
  assert.equal(last.kind, "page");
  assert.equal(last.next, null);
  assert.equal(last.unresolvedIssuanceCount, 1);
  const states = [...first.records, ...last.records].map((row) => row.state).sort();
  assert.deepEqual(states, ["outstanding", "reserved"]);
  const fresh = await restarted.port().listAffectedV1(query, restarted.reader(query), bounds());
  assert.equal(fresh.unresolvedIssuanceCount, 0);
  assert.equal(fresh.outstandingCount, 2);
  assert.equal(last.coverage, "persisted-snapshot-only");
});
test("tampered/expired snapshot continuation never broadens or silently restarts", async () => {
  const b = new SyntheticInventoryBackendV1(),
    a = await minted(b, "a");
  await minted(b, "z");
  const query = c.query(a.row),
    first = await b.port().listAffectedV1(query, b.reader(query), bounds());
  assert.ok(first.next);
  const tampered = { ...query, cursor: { ...first.next, continuation: "changed" } };
  assert.equal(
    (await b.port().listAffectedV1(tampered, b.reader(tampered), bounds())).kind,
    "snapshot-invalid",
  );
  b.now += 60001;
  const expired = { ...c.query(a.row, "scan/expired", b.now), cursor: first.next };
  assert.equal(
    (await b.port().listAffectedV1(expired, b.reader(expired), bounds())).kind,
    "snapshot-invalid",
  );
});
test("audit failure denies reservation but exact preauthorized revocation survives", async () => {
  const s = await minted();
  s.b.audit = "evidence-missing";
  const reserve = c.reserve("reserve/denied");
  assert.deepEqual(await s.p.reserveIssuanceV1(reserve, s.b.current(reserve), bounds()), {
    kind: "unavailable",
    reason: "audit-unavailable",
  });
  const claim = c.claimRevoke(s.row);
  const result = await s.p.claimRevocationV1(claim, s.b.mitigation(claim), bounds());
  assert.equal(result.kind, "claimed");
  assert.equal(result.audit.state, "evidence-missing");
  const outcome = c.confirmed(result.record);
  const saved = await s.p.recordRevocationV1(outcome, s.b.mitigation(outcome), bounds());
  assert.equal(saved.kind, "recorded");
  assert.equal(saved.record.revocation.state, "confirmed");
});
test("expired revoke claim reconciles same attempt and accepts late old claim at fresh CAS", async () => {
  const s = await minted(),
    claim1 = c.claimRevoke(s.row);
  const first = await s.p.claimRevocationV1(claim1, s.b.mitigation(claim1), bounds());
  assert.equal(first.kind, "claimed");
  const late = c.confirmed(first.record);
  s.b.now += 5001;
  const claim2 = {
    ...c.claimRevoke(first.record, "claim/takeover", s.b.now),
    previousAttempt: {
      kind: "reconcile",
      attemptRef: first.record.revocation.attemptRef,
      providerOutcome: "unknown",
    },
  };
  const second = await s.p.claimRevocationV1(claim2, s.b.mitigation(claim2), bounds());
  assert.equal(second.kind, "claimed");
  assert.equal(second.nextAction, "reconcile-previous-attempt");
  assert.equal(second.record.revocation.attemptRef, first.record.revocation.attemptRef);
  const stale = {
    ...late,
    createdAt: new Date(s.b.now).toISOString(),
    deadline: new Date(s.b.now + 5000).toISOString(),
  };
  assert.equal(
    (await s.p.recordRevocationV1(stale, s.b.mitigation(stale), bounds())).kind,
    "conflict",
  );
  const reconciled = {
    ...stale,
    operationRef: "outcome/reconciled",
    expectedInventoryVersion: second.record.inventoryVersion,
  };
  const saved = await s.p.recordRevocationV1(reconciled, s.b.mitigation(reconciled), bounds());
  assert.equal(saved.kind, "recorded");
  assert.equal(saved.record.revocation.state, "confirmed");
  assert.equal(saved.record.revocation.attemptRef, first.record.revocation.attemptRef);
  assert.equal(
    s.b.operations().find((op) => op.input.operationRef === claim1.operationRef).input
      .expectedInventoryVersion,
    claim1.expectedInventoryVersion,
  );
});
test("terminal confirmation cannot be replaced by unknown evidence", async () => {
  const s = await minted(),
    claim = c.claimRevoke(s.row);
  const claimed = await s.p.claimRevocationV1(claim, s.b.mitigation(claim), bounds());
  const input = c.confirmed(claimed.record);
  const saved = await s.p.recordRevocationV1(input, s.b.mitigation(input), bounds());
  const { confirmationEvidenceRef: _, ...common } = input;
  const weaker = {
    ...common,
    operationRef: "outcome/weaker",
    expectedInventoryVersion: saved.record.inventoryVersion,
    outcome: "unknown",
    outcomeEvidenceRef: "unknown/evidence",
  };
  assert.equal(
    (await s.p.recordRevocationV1(weaker, s.b.mitigation(weaker), bounds())).kind,
    "conflict",
  );
  assert.equal(s.b.records()[0].revocation.state, "confirmed");
  assert.equal(
    terminalInventoryRetentionElapsedV1(saved.record, s.b.now + 30 * 86400000 - 1),
    false,
  );
  assert.equal(terminalInventoryRetentionElapsedV1(saved.record, s.b.now + 30 * 86400000), true);
});
test("foreign read capability, forged current handle, bad codec values and closed unit fail", async () => {
  const b = new SyntheticInventoryBackendV1(),
    input = c.reserve();
  const forged = { handle: {}, observation: {} };
  assert.equal((await b.port().reserveIssuanceV1(input, forged, bounds())).kind, "denied");
  const bad = { ...input, surprise: "not-allowed" };
  assert.equal((await b.port().reserveIssuanceV1(bad, b.current(input), bounds())).kind, "denied");
  const s = await reserved(b),
    read = c.read(s.input);
  assert.equal((await b.port().readOperationV1(read, {}, bounds())).kind, "not-visible");
  assert.throws(() => b.assertClosed(), /closed/);
  const changed = { ...read, originalIntentDigest: "sha256:" + "b".repeat(64) };
  assert.equal(
    (await b.port().readOperationV1(changed, b.reader(changed), bounds())).kind,
    "not-visible",
  );
});
test("unknown mint without provider expiry remains unresolved after long elapsed time", async () => {
  const s = await reserved(),
    claim = c.mintClaim(s.row);
  await s.p.claimProviderMintV1(claim, s.b.current(claim), bounds());
  const row = s.b.records()[0],
    known = c.accepted(row, claim.providerAttemptRef);
  const { tokenRef, protectedRevocationRef, returnedScope, providerEvidenceRef, ...common } = known;
  const unknown = {
    ...common,
    outcome: "unknown",
    expiry: { kind: "expiry-unproven" },
    uncertaintyEvidenceRef: "uncertain/example",
  };
  const saved = await s.p.recordMintOutcomeV1(
    unknown,
    s.b.mitigation(unknown),
    undefined,
    bounds(),
  );
  assert.equal(saved.kind, "recorded");
  assert.equal(saved.record.expiry.kind, "expiry-unproven");
  assert.equal(terminalInventoryRetentionElapsedV1(saved.record, s.b.now + 365 * 86400000), false);
  parseCredentialStorageV1("record", saved.record);
});

test("actual public OCC subpaths load while absent selected backend stays unavailable", () => {
  assert.equal(typeof compose, "function");
  assert.deepEqual(bindCredentialInventoryBackendV1({}), {
    kind: "unavailable",
    reason: "invalid-profile",
  });
});
test("expired bounds and uncertain clock cannot produce new inventory authority", async () => {
  const b = new SyntheticInventoryBackendV1(),
    input = c.reserve();
  b.now += 5001;
  assert.equal(
    (await b.port().reserveIssuanceV1(input, b.current(input), bounds())).kind,
    "denied",
  );
  b.now = c.start;
  b.uncertaintyMs = 2001;
  assert.equal(
    (await b.port().reserveIssuanceV1(input, b.current(input), bounds())).kind,
    "denied",
  );
  assert.equal(b.records().length, 0);
});
test("unknown mint provider expiry can be established but future expiry does not resolve", async () => {
  const s = await reserved(),
    claim = c.mintClaim(s.row);
  await s.p.claimProviderMintV1(claim, s.b.current(claim), bounds());
  const template = c.accepted(s.b.records()[0], claim.providerAttemptRef);
  const { tokenRef, protectedRevocationRef, returnedScope, providerEvidenceRef, ...common } =
    template;
  const expiry = { ...common, outcome: "unknown-expiry-established" };
  const established = await s.p.recordMintOutcomeV1(
    expiry,
    s.b.mitigation(expiry),
    undefined,
    bounds(),
  );
  assert.equal(established.kind, "recorded");
  assert.equal(established.record.state, "mint-unknown");
  const premature = {
    ...expiry,
    operationRef: "expiry/premature",
    expectedInventoryVersion: established.record.inventoryVersion,
    outcome: "unknown-expired",
    clockEvidenceRef: "clock/example",
    uncertaintyMs: 0,
  };
  const capability = s.b.mitigation(expiry);
  assert.equal(
    (await s.p.recordMintOutcomeV1(premature, capability, undefined, bounds())).kind,
    "denied",
  );
  assert.equal(s.b.records()[0].state, "mint-unknown");
});

for (const [name, patch] of [
  ["extra field", { extra: "not-allowed" }],
  ["operation", { operationRef: "foreign/operation" }],
  ["digest", { intentDigest: "sha256:" + "f".repeat(64) }],
  ["commit", { commitRef: "foreign/commit" }],
  ["version", { inventoryVersion: 1 }],
  ["timestamp", { committedAt: "not-a-time" }],
]) {
  test(
    "original receipt " + name + " mismatch stays unavailable with exact found evidence",
    async () => {
      const s = await minted();
      // Corrupt only the synthetic owner's retained receipt projection. The real
      // facade must validate it before returning a historical receipt.
      const state = JSON.parse(s.b.checkpoint());
      const operation = state.operations.find(
        (op) => op.input.operationRef === s.accepted.operationRef,
      );
      Object.assign(operation.originalReceipt, patch);
      s.b.restore(JSON.stringify(state));
      const before = [s.b.writes, s.b.auditCalls, s.b.custodyCalls];
      const result = await s.p.recordMintOutcomeV1(
        s.accepted,
        s.b.mitigation(s.accepted),
        s.token,
        bounds(),
      );
      assert.deepEqual(result, { kind: "unavailable", reason: "inventory-unavailable" });
      const read = c.read(s.accepted);
      assert.equal((await s.p.readOperationV1(read, s.b.reader(read), bounds())).kind, "found");
      assert.deepEqual([s.b.writes, s.b.auditCalls, s.b.custodyCalls], before);
    },
  );
}
function replaceSyntheticRow(b, recordRef, update) {
  const state = JSON.parse(b.checkpoint());
  const index = state.rows.findIndex((row) => row.target.recordRef === recordRef);
  state.rows[index] = update(state.rows[index]);
  // Legal maximum codec values model counter exhaustion; this does not imitate
  // a production database migration or bypass the component's input parser.
  parseCredentialStorageV1("record", state.rows[index]);
  b.restore(JSON.stringify(state));
  return state.rows[index];
}
test("mint-claim inventory counter exhaustion rejects before audit or writes", async () => {
  const s = await reserved();
  const row = replaceSyntheticRow(s.b, s.row.target.recordRef, (row) => ({
    ...row,
    inventoryVersion: Number.MAX_SAFE_INTEGER,
  }));
  const input = c.mintClaim(row);
  const before = [s.b.writes, s.b.auditCalls, s.b.custodyCalls];
  assert.deepEqual(await s.p.claimProviderMintV1(input, s.b.current(input), bounds()), {
    kind: "conflict",
    reason: "version-conflict",
  });
  assert.deepEqual([s.b.writes, s.b.auditCalls, s.b.custodyCalls], before);
});
test("mint-outcome inventory counter exhaustion rejects before token custody", async () => {
  const s = await reserved(),
    claim = c.mintClaim(s.row);
  await s.p.claimProviderMintV1(claim, s.b.current(claim), bounds());
  const row = replaceSyntheticRow(s.b, s.row.target.recordRef, (row) => ({
    ...row,
    inventoryVersion: Number.MAX_SAFE_INTEGER,
  }));
  const input = c.accepted(row, claim.providerAttemptRef);
  const before = [s.b.writes, s.b.auditCalls, s.b.custodyCalls];
  assert.deepEqual(
    await s.p.recordMintOutcomeV1(
      input,
      s.b.mitigation(input),
      s.b.token(input.tokenRef, input.protectedRevocationRef),
      bounds(),
    ),
    { kind: "conflict", reason: "version-conflict" },
  );
  assert.deepEqual([s.b.writes, s.b.auditCalls, s.b.custodyCalls], before);
});
for (const field of ["inventory", "revocation"]) {
  test(
    "revocation claim " + field + " counter exhaustion rejects before side effects",
    async () => {
      const s = await minted();
      const row = replaceSyntheticRow(s.b, s.row.target.recordRef, (row) =>
        field === "inventory"
          ? { ...row, inventoryVersion: Number.MAX_SAFE_INTEGER }
          : { ...row, revocation: { ...row.revocation, version: Number.MAX_SAFE_INTEGER } },
      );
      const input = c.claimRevoke(row);
      const before = [s.b.writes, s.b.auditCalls, s.b.custodyCalls];
      assert.deepEqual(await s.p.claimRevocationV1(input, s.b.mitigation(input), bounds()), {
        kind: "conflict",
        reason: "version-conflict",
      });
      assert.deepEqual([s.b.writes, s.b.auditCalls, s.b.custodyCalls], before);
    },
  );
  test(
    "revocation outcome " + field + " counter exhaustion rejects before side effects",
    async () => {
      const s = await minted(),
        claim = c.claimRevoke(s.row);
      const claimed = await s.p.claimRevocationV1(claim, s.b.mitigation(claim), bounds());
      const original = c.confirmed(claimed.record);
      const row = replaceSyntheticRow(s.b, s.row.target.recordRef, (row) =>
        field === "inventory"
          ? { ...row, inventoryVersion: Number.MAX_SAFE_INTEGER }
          : {
              ...row,
              revocation: {
                state: "unknown",
                version: Number.MAX_SAFE_INTEGER,
                revocationOperationRef: original.revocationOperationRef,
                attemptRef: original.providerAttemptRef,
                observedAt: original.observedAt,
              },
            },
      );
      const input = { ...original, expectedInventoryVersion: row.inventoryVersion };
      const before = [s.b.writes, s.b.auditCalls, s.b.custodyCalls];
      assert.deepEqual(await s.p.recordRevocationV1(input, s.b.mitigation(input), bounds()), {
        kind: "conflict",
        reason: "version-conflict",
      });
      assert.deepEqual([s.b.writes, s.b.auditCalls, s.b.custodyCalls], before);
    },
  );
}

for (const mode of ["unknown-mint", "known-token"]) {
  test(mode + " expiry includes the accepting inventory clock uncertainty", async () => {
    const b = new SyntheticInventoryBackendV1();
    let p, input, row;
    if (mode === "unknown-mint") {
      const s = await reserved(b);
      p = s.p;
      const claim = c.mintClaim(s.row);
      await p.claimProviderMintV1(claim, b.current(claim), bounds());
      row = b.records()[0];
      const accepted = c.accepted(row, claim.providerAttemptRef);
      const { tokenRef, protectedRevocationRef, returnedScope, providerEvidenceRef, ...common } =
        accepted;
      input = {
        ...common,
        operationRef: "expiry/uncertain",
        outcome: "unknown-expired",
        clockEvidenceRef: "clock/provider",
        uncertaintyMs: 0,
      };
    } else {
      const s = await minted(b);
      p = s.p;
      const claim = c.claimRevoke(s.row);
      const claimed = await p.claimRevocationV1(claim, b.mitigation(claim), bounds());
      row = claimed.record;
      const confirmed = c.confirmed(row);
      const { confirmationEvidenceRef, ...common } = confirmed;
      input = {
        ...common,
        operationRef: "expiry/uncertain",
        outcome: "expired",
        expiry: row.expiry,
        clockEvidenceRef: "clock/provider",
        uncertaintyMs: 0,
      };
    }
    b.now = Date.parse(input.expiry.expiresAt);
    b.uncertaintyMs = 2000;
    input = {
      ...input,
      createdAt: new Date(b.now).toISOString(),
      deadline: new Date(b.now + 5000).toISOString(),
      observedAt: new Date(b.now).toISOString(),
    };
    const before = [b.writes, b.auditCalls, b.custodyCalls];
    const invoke = (value) =>
      mode === "unknown-mint"
        ? p.recordMintOutcomeV1(value, b.mitigation(value), undefined, bounds())
        : p.recordRevocationV1(value, b.mitigation(value), bounds());
    assert.deepEqual(await invoke(input), { kind: "conflict", reason: "version-conflict" });
    assert.deepEqual([b.writes, b.auditCalls, b.custodyCalls], before);
    b.now += 2000;
    const elapsed = {
      ...input,
      operationRef: "expiry/after-uncertainty",
      createdAt: new Date(b.now).toISOString(),
      deadline: new Date(b.now + 5000).toISOString(),
      observedAt: new Date(b.now).toISOString(),
    };
    const result = await invoke(elapsed);
    assert.equal(result.kind, "recorded");
    assert.equal(
      mode === "unknown-mint" ? result.record.state : result.record.revocation.state,
      mode === "unknown-mint" ? "resolved-without-token" : "expired",
    );
  });
}

function withAuditProjection(b, project) {
  return createCredentialInventoryV1({
    transactions: {
      run: (scope, options, work) =>
        b.run(scope, options, (tx) =>
          work({
            ...tx,
            appendAudit: async (input, mitigation) =>
              project(await tx.appendAudit(input, mitigation)),
          }),
        ),
    },
    acceptingOwner: b.acceptingOwner,
    clock: { read: () => ({ now: b.now, uncertaintyMs: b.uncertaintyMs }) },
  });
}
const foreignAudit = [
  [
    "foreign event",
    (evidence) => ({ ...evidence, eventRef: "aud_00000000-0000-4000-8000-000000000999" }),
  ],
  ["foreign commit", (evidence) => ({ ...evidence, commitRef: "commit/foreign" })],
  ["extra property", (evidence) => ({ ...evidence, unrelated: true })],
];
for (const [label, project] of foreignAudit) {
  test(`reservation refuses accepted audit with ${label} before publication`, async () => {
    const b = new SyntheticInventoryBackendV1(),
      p = withAuditProjection(b, project),
      input = c.reserve();
    const result = await p.reserveIssuanceV1(input, b.current(input), bounds());
    assert.equal(result.kind, "commit-unknown");
    assert.equal(result.operationRef, input.operationRef);
    assert.deepEqual(b.records(), []);
    assert.equal(b.writes, 0);
  });
  test(`mint claim refuses accepted audit with ${label} before publication`, async () => {
    const s = await reserved(),
      p = withAuditProjection(s.b, project),
      input = c.mintClaim(s.row);
    const before = s.b.checkpoint(),
      writes = s.b.writes;
    const result = await p.claimProviderMintV1(input, s.b.current(input), bounds());
    assert.equal(result.kind, "commit-unknown");
    assert.equal(s.b.checkpoint(), before);
    assert.equal(s.b.writes, writes);
  });
  test(`exact mitigation refuses misattributed obligation with ${label}`, async () => {
    const s = await minted();
    s.b.audit = "obligation-recorded";
    const p = withAuditProjection(s.b, project),
      input = c.claimRevoke(s.row);
    const before = s.b.checkpoint(),
      writes = s.b.writes,
      custody = s.b.custodyCalls;
    const result = await p.claimRevocationV1(input, s.b.mitigation(input), bounds());
    assert.equal(result.kind, "commit-unknown");
    assert.equal(s.b.checkpoint(), before);
    assert.equal(s.b.writes, writes);
    assert.equal(s.b.custodyCalls, custody);
  });
}
test("exact mitigation retains actual missing-audit incident without a fabricated commit", async () => {
  const s = await minted();
  s.b.audit = "evidence-missing";
  const input = c.claimRevoke(s.row);
  const result = await s.p.claimRevocationV1(input, s.b.mitigation(input), bounds());
  assert.equal(result.kind, "claimed");
  assert.equal(result.audit.state, "evidence-missing");
  assert.equal(result.audit.eventRef, input.originalAuditRef);
  assert.equal(typeof result.audit.incidentRef, "string");
  assert.equal("commitRef" in result.audit, false);
  assert.deepEqual(result.record.audit, result.audit);
});
test("listing reuses the validated second clock sample and takes no raw third sample", async () => {
  const s = await reserved();
  let reads = 0;
  const p = createCredentialInventoryV1({
    transactions: s.b,
    acceptingOwner: s.b.acceptingOwner,
    clock: {
      read: () => {
        reads++;
        return { now: s.b.now, uncertaintyMs: reads > 2 ? 9000 : 0 };
      },
    },
  });
  const input = c.query(s.row),
    result = await p.listAffectedV1(input, s.b.reader(input), bounds());
  assert.equal(result.kind, "page");
  assert.equal(reads, 2);
  assert.equal(result.createdAt, new Date(s.b.now).toISOString());
});
test("snapshot continuation uses the validated clock upper bound near expiry", async () => {
  const s = await minted();
  await reserved(s.b, "second");
  const firstInput = c.query(s.row),
    first = await s.p.listAffectedV1(firstInput, s.b.reader(firstInput), bounds());
  assert.equal(first.kind, "page");
  assert.ok(first.next);
  const expires = Date.parse(first.expiresAt);
  s.b.uncertaintyMs = 200;
  s.b.now = expires - 1000;
  const control = { ...c.query(s.row, "scan/control", s.b.now), cursor: first.next };
  assert.equal((await s.p.listAffectedV1(control, s.b.reader(control), bounds())).kind, "page");
  s.b.now = expires - 100;
  const edge = { ...c.query(s.row, "scan/edge", s.b.now), cursor: first.next };
  assert.deepEqual(await s.p.listAffectedV1(edge, s.b.reader(edge), bounds()), {
    kind: "snapshot-invalid",
    nextAction: "restart-exact-filter",
  });
});
test("repository mint rejects a codec-valid model use before clock, owner or transaction work", async () => {
  const r = c.reserve(),
    ref = (name) => ({ ref: name + "/example", version: 1, digest: r.profile.account.digest });
  const profile = {
    schemaVersion: 1,
    scope: r.scope,
    profile: r.profile.profile,
    providerId: r.profile.providerId,
    account: r.profile.account,
    transport: r.profile.transport,
    kind: "model",
    mode: "mediated",
    modelProfile: ref("model"),
    credentialClass: "api-key",
  };
  const input = parseCredentialStorageV1("namedUse", {
    schemaVersion: 1,
    method: "withNamedCredential",
    purpose: "model-use",
    operationRef: "model/use",
    requestId: r.requestId,
    callerServiceRef: r.callerServiceRef,
    scope: r.scope,
    profile,
    originalAuditRef: r.originalAuditRef,
    createdAt: r.createdAt,
    deadline: r.deadline,
    original: r.original,
    binding: r.binding,
    modelBinding: {
      schemaVersion: 1,
      scope: r.scope,
      profile,
      binding: r.binding,
      accountLink: ref("account-link"),
      upstreamWorkspaceRef: "workspace/model",
      invocationProfile: ref("invocation"),
      custody: "external-protected-owner",
      setup: {
        kind: "api-key-import",
        invocationMaterial: "api-key",
        rotationOwnerRef: "owner/rotation",
        lifecycleProfile: ref("lifecycle"),
      },
    },
  });
  let calls = 0;
  const unexpected = () => {
    calls++;
    throw new Error("Unexpected accepting-owner work.");
  };
  const p = createCredentialInventoryV1({
    transactions: { run: unexpected },
    acceptingOwner: {
      acceptCurrent: unexpected,
      acceptRead: unexpected,
      acceptMitigation: unexpected,
    },
    clock: { read: unexpected },
  });
  assert.deepEqual(await p.claimProviderMintV1(input, {}, bounds()), {
    kind: "denied",
    reason: "invalid-input",
  });
  assert.equal(calls, 0);
});
