import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { seedAuthority, writer } from "../fixtures/runtime-authority-state/seed.mjs";

const data = (value) => JSON.parse(JSON.stringify(value));

export async function verifyRuntimeAuthorityState(t, store) {
  await t.test(
    "immutable binding and separately versioned historical evidence round-trip",
    async () => {
      const f = await seedAuthority(store);
      assert.equal((await f.record()).authority.state, "allocated");
      const saved = await f.append(f.bind);
      assert.equal(saved.result, "applied");
      assert.equal(saved.receipt.assignmentRecordVersion, 2);
      f.bind.binding.podUid = "mutated-caller-value";
      const record = await f.record();
      assert.notEqual(record.binding.instance.podUid, f.bind.binding.podUid);
      assert.ok(Object.isFrozen(record.binding.instance));
      assert.equal(record.authority.state, "bound");
      assert.equal(record.allocation.bindingCondition, "unbound");
      const evidence = await f.append(f.evidence);
      assert.equal(evidence.receipt.outcome.kind, "record-evidence");
      assert.equal((await f.record()).authority.state, "bound");
      assert.deepEqual(
        await store.read((u) =>
          u.runtimeAuthority.listEvidence(f.target, f.allocation.assignmentRef),
        ),
        [f.evidence.evidence],
      );
    },
  );
  await t.test(
    "exact original-service replay survives head advancement and retirement",
    async () => {
      const f = await seedAuthority(store);
      const original = await f.append(f.bind);
      await f.stop();
      const retirement = await f.append({ ...f.retire, expectedLifecycleGeneration: 2 });
      assert.equal(retirement.receipt.outcome.termination, "not-asserted");
      assert.equal(retirement.receipt.outcome.providerCredentialRevocation, "not-asserted");
      const before = await f.record();
      const replay = await f.append({ ...f.bind, requestRef: "different/transport-request" });
      assert.equal(replay.result, "exact-replay");
      assert.deepEqual(replay.receipt, original.receipt);
      assert.deepEqual(await f.record(), before);
      await assert.rejects(
        f.append({
          ...f.bind,
          observation: { ...f.bind.observation, observationRef: "different/observation" },
        }),
        { reasonCode: "operation-payload-mismatch" },
      );
      await assert.rejects(
        f.append(f.bind, { ...writer, acceptedServiceIdentityRef: "service/other" }),
        { reasonCode: "operation-payload-mismatch" },
      );
      assert.deepEqual(
        data((await f.operation(f.bind.operationRef)).receipt),
        data(original.receipt),
      );
    },
  );
  await t.test("binding refresh preserves every immutable tuple field", async () => {
    const f = await seedAuthority(store);
    await f.append(f.bind);
    const refreshed = {
      ...f.bind,
      operationRef: randomUUID(),
      expectedAssignmentRecordVersion: 2,
      expectedBindingVersion: 1,
      observation: { ...f.bind.observation, observationRef: "observation/new-reference" },
    };
    await f.append(refreshed);
    assert.deepEqual(data((await f.record()).binding.instance), f.bind.binding);
    for (const field of [
      "podUid",
      "runscSandboxId",
      "runtimeInstanceRef",
      "protectedRestartDiscriminator",
      "deploymentUid",
      "policyRevision",
    ]) {
      await assert.rejects(
        f.append({
          ...refreshed,
          operationRef: randomUUID(),
          expectedAssignmentRecordVersion: 3,
          binding: { ...refreshed.binding, [field]: "different/instance" },
        }),
        { reasonCode: "binding-mismatch" },
      );
    }
    assert.equal((await f.record()).authority.assignmentRecordVersion, 3);
  });
  await t.test(
    "delayed evidence is retained without refreshing prior sources or activating",
    async () => {
      const f = await seedAuthority(store);
      await f.append(f.bind);
      await f.append(f.evidence);
      const delayed = {
        ...f.evidence,
        operationRef: randomUUID(),
        expectedAssignmentRecordVersion: 3,
        expectedEvidenceVersion: 1,
        evidence: {
          ...f.evidence.evidence,
          evidenceVersion: 2,
          providerObservedAt: "2025-12-31T23:59:59.000Z",
          policyObservedAt: "2025-12-31T23:59:59.000Z",
          readinessObservedAt: "2025-12-31T23:59:59.000Z",
        },
      };
      await f.append(delayed);
      const history = await store.read((u) =>
        u.runtimeAuthority.listEvidence(f.target, f.allocation.assignmentRef),
      );
      assert.deepEqual(history, [f.evidence.evidence, delayed.evidence]);
      assert.equal((await f.record()).authority.state, "bound");
      await assert.rejects(
        f.append({ ...delayed, operationRef: randomUUID(), expectedAssignmentRecordVersion: 4 }),
        { reasonCode: "record-version-mismatch" },
      );
    },
  );
  await t.test(
    "identity evidence has independent versions and exact admitted profile",
    async () => {
      const f = await seedAuthority(store);
      await f.append(f.bind);
      await f.append(f.evidence);
      const input = {
        ...f.evidence,
        operationRef: randomUUID(),
        expectedAssignmentRecordVersion: 3,
        evidence: {
          schemaVersion: 1,
          kind: "identity",
          target: f.target,
          bindingVersion: 1,
          evidenceVersion: 1,
          verifierEvidenceRef: "verifier/test",
          registrationId: "registration/test",
          registrationVersion: 1,
          identityProfileRef: f.allocation.identityProfileRef,
          verifiedAt: "2026-01-01T00:00:00.000Z",
          receivedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T00:00:10.000Z",
          uncertaintyMs: 0,
          outcome: { result: "verified", reasonCode: "peer-verified" },
        },
      };
      await assert.rejects(
        f.append({
          ...input,
          evidence: { ...input.evidence, identityProfileRef: "profile/foreign" },
        }),
        { reasonCode: "binding-mismatch" },
      );
      await f.append(input);
      assert.equal((await f.record()).authority.state, "bound");
    },
  );
  await t.test("caught later validation rejects the entire enclosing transaction", async () => {
    const f = await seedAuthority(store);
    await assert.rejects(
      store.transact(async (unit) => {
        await unit.runtimeAuthority.appendMutation(f.bind, writer);
        try {
          await unit.runtimeAuthority.appendMutation(
            {
              ...f.evidence,
              target: { ...f.target, revisionId: `rev_${randomUUID()}` },
              evidence: {
                ...f.evidence.evidence,
                target: { ...f.target, revisionId: `rev_${randomUUID()}` },
              },
            },
            writer,
          );
        } catch {}
      }),
    );
    assert.equal((await f.record()).authority.assignmentRecordVersion, 1);
    assert.equal(await f.operation(f.bind.operationRef), undefined);
  });
  await t.test("concurrent caught same-unit failure poisons commit", async () => {
    const f = await seedAuthority(store);
    await assert.rejects(
      store.transact(async (unit) => {
        const outcomes = await Promise.allSettled([
          unit.runtimeAuthority.appendMutation(f.bind, writer),
          unit.runtimeAuthority.appendMutation({ ...f.bind, operationRef: randomUUID() }, writer),
        ]);
        assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
        assert.equal(outcomes.filter((o) => o.status === "rejected").length, 1);
      }),
    );
    assert.equal((await f.record()).authority.assignmentRecordVersion, 1);
    assert.equal(await f.operation(f.bind.operationRef), undefined);
    assert.equal((await f.append(f.bind)).result, "applied");
  });
  await t.test("competing independent transactions admit one assignment version", async () => {
    const f = await seedAuthority(store);
    const results = await Promise.allSettled([
      f.append(f.bind),
      f.append({ ...f.bind, operationRef: randomUUID() }),
    ]);
    assert.equal(results.filter((o) => o.status === "fulfilled").length, 1);
    assert.equal(results.filter((o) => o.status === "rejected").length, 1);
    assert.equal((await f.record()).authority.assignmentRecordVersion, 2);
  });
  await t.test("exact foreign Installation, Namespace and Agent reads stay empty", async () => {
    const f = await seedAuthority(store);
    await f.append(f.bind);
    for (const [field, prefix] of [
      ["installationId", "ins"],
      ["namespaceId", "ns"],
      ["agentId", "agt"],
    ]) {
      const scope = { ...f.target, [field]: `${prefix}_${randomUUID()}` };
      assert.equal(
        await store.read((u) =>
          u.runtimeAuthority.findAssignment(scope, f.allocation.assignmentRef),
        ),
        undefined,
      );
      assert.equal(
        await store.read((u) => u.runtimeAuthority.findOperation(scope, f.bind.operationRef)),
        undefined,
      );
      assert.deepEqual(
        await store.read((u) => u.runtimeAuthority.listEvidence(scope, f.allocation.assignmentRef)),
        [],
      );
      await assert.rejects(f.append({ ...f.bind, target: scope }));
    }
  });
  await t.test(
    "unbound retirement retains no invented provider instance and cannot reopen",
    async () => {
      const f = await seedAuthority(store);
      const retired = await f.append({
        ...f.retire,
        expectedAssignmentRecordVersion: 1,
        bindingVersion: null,
      });
      assert.equal(retired.receipt.outcome.authority, "retired");
      assert.deepEqual(data((await f.record()).binding), { status: "unbound" });
      await assert.rejects(f.append({ ...f.bind, expectedAssignmentRecordVersion: 2 }), {
        reasonCode: "generation-mismatch",
      });
      assert.equal((await f.record()).authority.state, "retired");
    },
  );
  await t.test("unsupported selected retirement cannot claim selection withdrawal", async () => {
    const f = await seedAuthority(store);
    await f.append(f.bind);
    await assert.rejects(
      f.append({
        ...f.retire,
        expectedCurrentSelection: { assignmentRef: f.target.assignmentRef, selectionVersion: 1 },
      }),
      { reasonCode: "generation-mismatch" },
    );
    assert.equal((await f.record()).authority.state, "bound");
  });
  await t.test(
    "extra attribution cannot replace the pretransaction operation locator",
    async () => {
      const f = await seedAuthority(store);
      const injected = randomUUID();
      await assert.rejects(f.append(f.bind, { ...writer, operationRef: injected }));
      assert.equal(await f.operation(f.bind.operationRef), undefined);
      assert.equal(await f.operation(injected), undefined);
      assert.equal((await f.record()).authority.assignmentRecordVersion, 1);
      const saved = await f.append(f.bind);
      assert.equal(saved.receipt.operationRef, f.bind.operationRef);
    },
  );
  await t.test("escaped completed transaction cannot append authority state later", async () => {
    const f = await seedAuthority(store);
    const escaped = await store.transact(async (unit) => unit.runtimeAuthority);
    await assert.rejects(escaped.appendMutation(f.bind, writer));
    assert.equal(await f.operation(f.bind.operationRef), undefined);
    assert.equal((await f.record()).authority.assignmentRecordVersion, 1);
  });
  await t.test(
    "a chained late submission cannot mutate a draining or completed transaction",
    async () => {
      const f = await seedAuthority(store);
      let detached;
      await store.transact((unit) => {
        const first = unit.runtimeAuthority.appendMutation(f.bind, writer);
        detached = first.then(() => unit.runtimeAuthority.appendMutation(f.evidence, writer));
        // Attach a rejection observer immediately; the actual late submission must fail.
        detached.catch(() => {});
        return Promise.resolve();
      });
      const immediate = await f.record();
      await assert.rejects(detached);
      assert.equal(immediate.authority.assignmentRecordVersion, 2);
      assert.deepEqual(await f.record(), immediate);
      assert.equal(await f.operation(f.evidence.operationRef), undefined);
    },
  );
  await t.test(
    "retirement is rolled back when a later caught authority mutation fails",
    async () => {
      const f = await seedAuthority(store);
      await f.append(f.bind);
      await assert.rejects(
        store.transact(async (unit) => {
          await unit.runtimeAuthority.appendMutation(f.retire, writer);
          try {
            await unit.runtimeAuthority.appendMutation(
              {
                ...f.bind,
                operationRef: randomUUID(),
                expectedAssignmentRecordVersion: 3,
                expectedBindingVersion: 1,
              },
              writer,
            );
          } catch {}
        }),
      );
      assert.equal((await f.record()).authority.state, "bound");
      assert.equal((await f.record()).authority.assignmentRecordVersion, 2);
      assert.equal(await f.operation(f.retire.operationRef), undefined);
    },
  );
  await t.test(
    "later transaction failure rolls back binding and immutable receipt together",
    async () => {
      const f = await seedAuthority(store);
      await assert.rejects(
        store.transact(async (u) => {
          await u.runtimeAuthority.appendMutation(f.bind, writer);
          throw new Error("caller rollback");
        }),
      );
      assert.equal(await f.operation(f.bind.operationRef), undefined);
      assert.equal((await f.record()).authority.assignmentRecordVersion, 1);
    },
  );
}
