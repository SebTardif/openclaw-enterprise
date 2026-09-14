import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { seedAuthority, writer } from "../fixtures/runtime-authority-state/seed.mjs";

const data = (value) => JSON.parse(JSON.stringify(value));

export async function verifyRuntimeAuthorityState(t, store) {
  await t.test("initial binding is immutable and rejects another instance or refresh", async () => {
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
          ...f.bind,
          operationRef: randomUUID(),
          expectedAssignmentRecordVersion: 2,
          binding: { ...saved.receipt.outcome.binding, [field]: "different/instance" },
        }),
        { reasonCode: "binding-mismatch" },
      );
    }
    await assert.rejects(
      f.append({
        ...f.bind,
        operationRef: randomUUID(),
        expectedAssignmentRecordVersion: 2,
        binding: saved.receipt.outcome.binding,
      }),
      { reasonCode: "binding-mismatch" },
    );
    assert.equal((await f.record()).authority.assignmentRecordVersion, 2);
  });
  await t.test("exact original-service replay survives head advancement", async () => {
    const f = await seedAuthority(store);
    const original = await f.append(f.bind);
    await f.stop();
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
  });
  await t.test("caught later validation rejects the entire enclosing transaction", async () => {
    const f = await seedAuthority(store);
    await assert.rejects(
      store.transact(async (unit) => {
        await unit.runtimeAuthority.appendMutation(f.bind, writer);
        try {
          await unit.runtimeAuthority.appendMutation(
            {
              ...f.bind,
              operationRef: randomUUID(),
              observation: { ...f.bind.observation, sourceObservedAt: "2026-02-30T00:00:00.000Z" },
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
      await assert.rejects(f.append({ ...f.bind, target: scope }));
    }
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
      const late = { ...f.bind, operationRef: randomUUID(), expectedAssignmentRecordVersion: 2 };
      let detached;
      await store.transact((unit) => {
        const first = unit.runtimeAuthority.appendMutation(f.bind, writer);
        detached = first.then(() => unit.runtimeAuthority.appendMutation(late, writer));
        // Attach a rejection observer immediately; the actual late submission must fail.
        detached.catch(() => {});
        return Promise.resolve();
      });
      const immediate = await f.record();
      await assert.rejects(detached);
      assert.equal(immediate.authority.assignmentRecordVersion, 2);
      assert.deepEqual(await f.record(), immediate);
      assert.equal(await f.operation(late.operationRef), undefined);
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
