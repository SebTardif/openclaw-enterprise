import assert from "node:assert/strict";
import test from "node:test";
import {
  createPostgresCredentialInventoryV1,
  preparePostgresCredentialInventoryScopeV1,
  preparePostgresCredentialInventoryKeysV1,
} from "../../packages/occ/src/credential-inventory-v1/postgres.ts";
import { createCredentialInventoryV1 } from "../../packages/occ/src/credential-inventory-v1/inventory.ts";
import { SyntheticInventoryBackendV1 } from "../fixtures/credential-inventory-v1/synthetic-backend.ts";
import { inventoryIntentDigestV1 } from "../../packages/occ/src/credential-inventory-v1/transactions.ts";
import * as c from "../fixtures/credential-inventory-v1/cases.ts";
const bounds = () => ({ signal: new AbortController().signal });

/** Query doubles exercise the actual repository; they do not execute SQL or
 * establish database isolation, encryption, runtime authority or COMMIT facts. */
function borrowed(handler = () => ({ rows: [], rowCount: 0 }), options = {}) {
  const input = c.reserve(),
    calls = [],
    failures = [],
    effects = [];
  let closed = false,
    preparation = null,
    writer = true;
  const assertActive = () => {
    if (closed || failures.length) throw new Error("Synthetic owning phase closed.");
  };
  const context = {
    scope: { installationId: input.scope.installationId, namespaceId: input.scope.namespaceId },
    inventoryScope: { ...input.scope },
    commitRef: "commit/borrowed",
    transaction: { assertActive },
    phase: {
      assertActive: () => {
        assertActive();
        if (preparation !== null) throw new Error("Synthetic acceptance incomplete.");
      },
      assertPreparing: (stage) => {
        assertActive();
        assert.equal(preparation, stage);
      },
      assertWriting: () => {
        assertActive();
        if (!writer) throw new Error("Synthetic read-only admission.");
      },
      recordEffect: (effect) => effects.push(structuredClone(effect)),
      poison: (error) => failures.push(error),
    },
    query: {
      query: async (statement, parameters) => {
        calls.push({ statement, parameters: structuredClone(parameters) });
        return handler(statement, parameters);
      },
    },
  };
  const repo = createPostgresCredentialInventoryV1(context, options);
  return {
    repo,
    context,
    calls,
    failures,
    effects,
    preparing: (stage) => {
      preparation = stage;
    },
    readOnly: () => {
      writer = false;
    },
    close: () => {
      closed = true;
    },
  };
}
const scopedRow = (value, scope = c.reserve().scope) => ({
  installation_id: scope.installationId,
  namespace_id: scope.namespaceId,
  agent_id: scope.agentId,
  document: value,
});
async function reserved() {
  const b = new SyntheticInventoryBackendV1(),
    input = c.reserve(),
    result = await b.port().reserveIssuanceV1(input, b.current(input), bounds());
  assert.equal(result.kind, "reserved");
  return { b, input, record: result.record };
}

test("borrowed inventory factory does no I/O and binds exact owner installation before queries", async () => {
  const h = borrowed();
  assert.equal(h.calls.length, 0);
  h.context.scope.installationId = "ins_00000000-0000-4000-8000-000000000099";
  await assert.rejects(h.repo.findRecord("record/any"), /scope differs/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.failures.length, 1);
});
test("accepted exact reads remain scoped and acquire no new upstream lock", async () => {
  const s = await reserved();
  const h = borrowed(() => ({ rows: [scopedRow(s.record)], rowCount: 1 }));
  assert.deepEqual(await h.repo.findRecord(s.record.target.recordRef), s.record);
  assert.equal(h.calls.length, 1);
  assert.match(
    h.calls[0].statement,
    /installation_id=\$1 AND namespace_id=\$2 AND agent_id=\$3 AND record_ref=\$4/,
  );
  assert.deepEqual(h.calls[0].parameters, [
    ...Object.values(s.input.scope),
    s.record.target.recordRef,
  ]);
  assert.equal(
    h.calls.some((call) =>
      /FOR UPDATE|FOR NO KEY UPDATE|advisory|\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/.test(
        call.statement,
      ),
    ),
    false,
  );
});
test("preparation locks the actual Installation then Namespace then Agent before acceptance", async () => {
  const input = c.reserve(),
    h = borrowed((_statement, parameters) => ({ rows: [{ id: parameters.at(-1) }], rowCount: 1 }));
  h.preparing("scope");
  await preparePostgresCredentialInventoryScopeV1(h.context);
  assert.deepEqual(
    h.calls.map((call) => call.statement),
    [
      "SELECT id FROM occ.installation WHERE id = $1 FOR NO KEY UPDATE",
      "SELECT id FROM occ.namespaces WHERE id = $1 FOR NO KEY UPDATE",
      "SELECT id FROM occ.agents WHERE namespace_id = $1 AND id = $2 FOR NO KEY UPDATE",
    ],
  );
  assert.deepEqual(
    h.calls.map((call) => call.parameters),
    [
      [input.scope.installationId],
      [input.scope.namespaceId],
      [input.scope.namespaceId, input.scope.agentId],
    ],
  );
  // Preparation returning is not completed canonical acceptance.
  await assert.rejects(h.repo.findRecord("record/early"), /acceptance incomplete/);
  assert.equal(h.calls.length, 3);
});
test("missing scope parent aborts preparation before downstream locks", async () => {
  const h = borrowed();
  h.preparing("scope");
  await assert.rejects(preparePostgresCredentialInventoryScopeV1(h.context), /parent unavailable/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.failures.length, 1);
});
test("bounded key preparation preserves class order and byte order under original scope locks", async () => {
  const h = borrowed((_statement, parameters) => ({
    rows: parameters[3].map((key) => ({ key })),
    rowCount: parameters[3].length,
  }));
  h.preparing("keys");
  await preparePostgresCredentialInventoryKeysV1(h.context, {
    operations: ["op/z", "op/a"],
    records: ["record/z", "record/a"],
    mintClaims: ["record/a"],
    revocationClaims: ["claim/a"],
    snapshots: ["snapshot/a"],
  });
  assert.deepEqual(
    h.calls.map((call) => call.statement.match(/FROM (\S+)/)[1]),
    [
      "occ.credential_inventory_operations",
      "occ.credential_inventory_records",
      "occ.credential_inventory_mint_claims",
      "occ.credential_inventory_revocation_claims",
      "occ.credential_inventory_snapshots",
    ],
  );
  assert.deepEqual(h.calls[0].parameters[3], ["op/a", "op/z"]);
  assert.ok(h.calls.every((call) => call.statement.endsWith('COLLATE "C" FOR UPDATE')));
});
test("a cross-scope response and an altered document key are rejected before disclosure", async () => {
  const s = await reserved();
  for (const row of [
    scopedRow(s.record, { ...s.input.scope, agentId: "agt_00000000-0000-4000-8000-000000000099" }),
    scopedRow({ ...s.record, target: { ...s.record.target, recordRef: "record/foreign" } }),
  ]) {
    const h = borrowed(() => ({ rows: [row], rowCount: 1 }));
    await assert.rejects(h.repo.findRecord(s.record.target.recordRef));
    assert.equal(h.failures.length, 1);
  }
});
test("cross-scope inventory writes do not reach a data statement", async () => {
  const s = await reserved(),
    h = borrowed();
  const other = structuredClone(s.record);
  other.issuance.scope.agentId = "agt_00000000-0000-4000-8000-000000000099";
  await assert.rejects(h.repo.insertRecord(other));
  assert.equal(
    h.calls.some((call) => /^(INSERT|UPDATE)/.test(call.statement)),
    false,
  );
});
test("CAS binds the exact expected version and immutable issuance/locator without upsert", async () => {
  const s = await reserved(),
    next = { ...s.record, inventoryVersion: 2 };
  const h = borrowed(() => ({ rows: [{ record_ref: next.target.recordRef }], rowCount: 1 }));
  await h.repo.replaceRecord(1, next);
  const call = h.calls.at(-1);
  assert.match(
    call.statement,
    /inventory_version=\$10 AND document->'issuance'=\$11::jsonb AND document->'target'=\$12::jsonb/,
  );
  assert.equal(call.parameters[9], 1);
  assert.deepEqual(JSON.parse(call.parameters[10]), s.record.issuance);
  assert.deepEqual(JSON.parse(call.parameters[11]), s.record.target);
  assert.doesNotMatch(call.statement, /ON CONFLICT|DELETE/);
  assert.deepEqual(h.effects, [{ kind: "record-replaced", expectedVersion: 1, record: next }]);
  const stale = borrowed(() => ({ rows: [], rowCount: 0 }));
  await assert.rejects(stale.repo.replaceRecord(1, next), /compare-and-swap/);
  assert.equal(stale.failures.length, 1);
  await assert.rejects(stale.repo.findRecord(next.target.recordRef), /closed/);
});
test("unsafe counter increments and ambiguous query row counts fail before successful writes", async () => {
  const s = await reserved(),
    h = borrowed();
  await assert.rejects(
    h.repo.replaceRecord(Number.MAX_SAFE_INTEGER, {
      ...s.record,
      inventoryVersion: Number.MAX_SAFE_INTEGER,
    }),
  );
  assert.equal(
    h.calls.some((call) => call.statement.startsWith("UPDATE")),
    false,
  );
  const malformed = borrowed(() => ({ rows: [], rowCount: null }));
  await assert.rejects(
    malformed.repo.findRecord(s.record.target.recordRef),
    /query acknowledgment/,
  );
  assert.equal(malformed.failures.length, 1);
});
test("owner lifetime is checked before submission and after an awaited query", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const h = borrowed(() => pending);
  const read = h.repo.findRecord("record/pending");
  await new Promise((resolve) => setImmediate(resolve));
  h.close();
  release({ rows: [], rowCount: 0 });
  await assert.rejects(read, /closed/);
  const count = h.calls.length;
  await assert.rejects(h.repo.findRecord("record/pending"), /closed/);
  assert.equal(h.calls.length, count);
});
test("borrowed query failure is preserved and poisoned without guessing rollback or retry", async () => {
  const ambiguous = new Error("Synthetic transport lost an acknowledgment.");
  const h = borrowed(() => {
    throw ambiguous;
  });
  await assert.rejects(h.repo.findRecord("record/pending"), (error) => error === ambiguous);
  assert.equal(h.failures[0], ambiguous);
  assert.equal(
    h.calls.filter((call) => !call.statement.includes("pg_advisory_xact_lock")).length,
    1,
  );
});
test("immutable operation readback keeps the original request/CAS and supplies no invented receipt", async () => {
  const s = await reserved();
  const stored = {
    input: s.input,
    digest: inventoryIntentDigestV1(s.input),
    state: "intent-recorded",
    record: s.record,
    commitRef: "commit/original",
    recordedAt: new Date(c.start).toISOString(),
  };
  const h = borrowed(() => ({ rows: [scopedRow(stored)], rowCount: 1 }));
  assert.deepEqual(await h.repo.findOperation(s.input.operationRef), stored);
  assert.equal("originalReceipt" in (await h.repo.findOperation(s.input.operationRef)), false);
  const foreign = borrowed(() => ({
    rows: [scopedRow({ ...stored, digest: "sha256:" + "f".repeat(64) })],
    rowCount: 1,
  }));
  await assert.rejects(
    foreign.repo.findOperation(s.input.operationRef),
    /immutable inventory operation/,
  );
});
test("missing custody and mandatory audit producers cannot create positive evidence", async () => {
  const s = await reserved(),
    h = borrowed();
  await assert.rejects(h.repo.appendAudit(s.input, false), /audit producer is unavailable/);
  assert.equal(
    h.calls.some((call) => /^(INSERT|UPDATE)/.test(call.statement)),
    false,
  );
  const accepted = c.accepted(s.record, "provider/attempt");
  const custody = borrowed();
  await assert.rejects(custody.repo.retainToken(accepted, {}), /custody is unavailable/);
  assert.equal(
    custody.calls.some((call) => /^(INSERT|UPDATE)/.test(call.statement)),
    false,
  );
});
test("injected actual audit projection must correspond to this event and outer unit", async () => {
  const input = c.reserve();
  for (const evidence of [
    {
      state: "accepted",
      eventRef: input.originalAuditRef,
      commitRef: "commit/other",
      source: "credential",
      category: "credential",
    },
    {
      state: "obligation-recorded",
      eventRef: "aud_00000000-0000-4000-8000-000000000999",
      commitRef: "commit/borrowed",
      obligationRef: "obligation/test",
    },
  ]) {
    const h = borrowed(undefined, { audit: { appendAudit: async () => evidence } });
    await assert.rejects(h.repo.appendAudit(input, true), /correlation mismatch/);
    assert.equal(h.failures.length, 1);
  }
  const evidence = {
    state: "evidence-missing",
    eventRef: input.originalAuditRef,
    incidentRef: "incident/test",
  };
  const h = borrowed(undefined, { audit: { appendAudit: async () => evidence } });
  assert.deepEqual(await h.repo.appendAudit(input, true), evidence);
});
test("only outer owner classifies unknown COMMIT after provisional SQL reservation", async () => {
  const synthetic = new SyntheticInventoryBackendV1(),
    input = c.reserve();
  let operations = 0,
    transactions = 0;
  const h = borrowed(
    (statement) => {
      if (statement.includes("count(*)"))
        return { rows: [{ installation: "0", agent: "0", unresolved: "0" }], rowCount: 1 };
      if (statement.startsWith("INSERT")) {
        operations++;
        return { rows: [{}], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    {
      audit: {
        appendAudit: async () => ({
          state: "accepted",
          eventRef: input.originalAuditRef,
          commitRef: "commit/borrowed",
          source: "credential",
          category: "credential",
        }),
      },
    },
  );
  const port = createCredentialInventoryV1({
    acceptingOwner: synthetic.acceptingOwner,
    clock: { read: () => ({ now: c.start, uncertaintyMs: 0 }) },
    transactions: {
      run: async (_scope, _bounds, work) => {
        transactions++;
        const provisional = await work(h.repo);
        assert.equal(provisional.kind, "reserved");
        return { kind: "commit-unknown" };
      },
    },
  });
  assert.deepEqual(await port.reserveIssuanceV1(input, synthetic.current(input), bounds()), {
    kind: "commit-unknown",
    operationRef: input.operationRef,
    intentDigest: inventoryIntentDigestV1(input),
    nextAction: "exact-readback-only",
  });
  assert.equal(transactions, 1);
  assert.equal(operations, 2);
});

test("a read-only accepted phase cannot mutate or stage custody", async () => {
  const s = await reserved(),
    h = borrowed();
  h.readOnly();
  await assert.rejects(h.repo.insertRecord(s.record), /read-only admission/);
  assert.equal(h.calls.length, 0);
});
test("post-SQL completion-fact failure poisons the transition even when caller catches it", async () => {
  const s = await reserved(),
    h = borrowed(() => ({ rows: [{ record_ref: s.record.target.recordRef }], rowCount: 1 }));
  const failure = new Error("Synthetic private completion accounting failed.");
  h.context.phase.recordEffect = () => {
    throw failure;
  };
  await h.repo
    .replaceRecord(1, { ...s.record, inventoryVersion: 2 })
    .catch((error) => assert.equal(error, failure));
  assert.equal(h.calls.length, 1);
  assert.equal(h.failures[0], failure);
  await assert.rejects(h.repo.findRecord(s.record.target.recordRef), /closed/);
});

for (const kind of ["accessor", "nonenumerable", "symbol", "foreign-prototype"]) {
  test(`audit projection rejects ${kind} properties before recording completion facts`, async () => {
    const input = c.reserve();
    let getterCalls = 0;
    const evidence = {
      state: "accepted",
      eventRef: input.originalAuditRef,
      commitRef: "commit/borrowed",
      source: "credential",
      category: "credential",
    };
    if (kind === "accessor")
      Object.defineProperty(evidence, "eventRef", {
        enumerable: true,
        get: () => {
          getterCalls++;
          return input.originalAuditRef;
        },
      });
    if (kind === "nonenumerable") Object.defineProperty(evidence, "hidden", { value: true });
    if (kind === "symbol") evidence[Symbol("hidden")] = true;
    if (kind === "foreign-prototype") Object.setPrototypeOf(evidence, { inherited: true });
    const h = borrowed(undefined, { audit: { appendAudit: async () => evidence } });
    await assert.rejects(h.repo.appendAudit(input, false), /audit projection/);
    assert.equal(getterCalls, 0);
    assert.deepEqual(h.effects, []);
    assert.equal(h.failures.length, 1);
  });
}
test("audit recordEffect and caller receive the same immutable snapshot without a producer alias", async () => {
  const input = c.reserve();
  const produced = {
    state: "accepted",
    eventRef: input.originalAuditRef,
    commitRef: "commit/borrowed",
    source: "credential",
    category: "credential",
  };
  const h = borrowed(undefined, { audit: { appendAudit: async () => produced } });
  let recorded;
  h.context.phase.recordEffect = (effect) => {
    recorded = effect.evidence;
  };
  const returned = await h.repo.appendAudit(input, false);
  assert.equal(Object.isFrozen(returned), true);
  assert.notEqual(returned, produced);
  assert.equal(recorded, returned);
  produced.eventRef = "aud_00000000-0000-4000-8000-000000000999";
  produced.commitRef = "commit/foreign";
  assert.equal(returned.eventRef, input.originalAuditRef);
  assert.equal(recorded.commitRef, "commit/borrowed");
});
