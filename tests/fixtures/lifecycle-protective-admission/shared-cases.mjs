import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  seedRuntimeOwner,
  profiles,
} from "../../conformance/runtime-assignment-store.contract.mjs";

export { seedRuntimeOwner };
export const copy = (value) => structuredClone(value);
export function protectiveWrite(owner, kind = "disable", expectedLifecycleGeneration = null) {
  const actorId = "test/trusted-storage-input";
  const requestId = `req_${randomUUID()}`;
  return {
    request: {
      schemaVersion: 1,
      kind,
      namespaceId: owner.namespace.id,
      agentId: owner.agent.id,
      expectedLifecycleGeneration,
    },
    transitionRef: randomUUID(),
    attribution: { actorId, requestId },
    workId: `lifecycle-test:${randomUUID()}`,
    responsibilityRef: randomUUID(),
    audit: {
      id: `aud_${randomUUID()}`,
      installationId: owner.installation.id,
      namespaceId: owner.namespace.id,
      occurredAt: new Date().toISOString(),
      kind: "mutation",
      actorId,
      requestId,
      actor: { principalId: actorId },
      action: `openclaw.agents.${kind}`,
      resource: { kind: "agent", id: owner.agent.id, namespaceId: owner.namespace.id },
      outcome: "success",
    },
  };
}
export const apply = (state, input) =>
  state.transact((unit) => unit.lifecycleAdmissions.applyProtective(input));
export const committed = (state, owner, input) =>
  state.read((view) => view.lifecycleAdmissions.findCommitted(owner.scope, input.transitionRef));
export const head = (state, owner) =>
  state.read((view) => view.runtimeAssignments.findRuntimeIntentHead(owner.scope));
export const audits = (state) => state.read((view) => view.audit.list());

export function assertRetained(record, owner, input, revisionId, generation) {
  const { association, work, audit, cleanup } = record;
  assert.deepEqual(copy(association.request), input.request);
  assert.equal(association.intent.installationId, owner.installation.id);
  assert.equal(association.intent.namespaceId, owner.namespace.id);
  assert.equal(association.intent.agentId, owner.agent.id);
  assert.equal(association.intent.transitionRef, input.transitionRef);
  assert.equal(association.intent.actorId, input.attribution.actorId);
  assert.equal(association.intent.requestId, input.attribution.requestId);
  assert.equal(association.intent.generation, generation);
  assert.equal(
    association.intent.desiredMode,
    input.request.kind === "disable" ? "disabled" : "stopped",
  );
  assert.equal(association.intent.revisionId, revisionId);
  assert.equal(association.auditEventId, input.audit.id);
  assert.equal(association.workId, input.workId);
  assert.notEqual(input.workId, input.transitionRef);
  assert.deepEqual(copy(audit), input.audit);
  assert.equal(work.schemaVersion, 1);
  assert.equal(work.input.handler, "ReconcileAgentLifecycleV1");
  assert.equal(work.input.namespaceId, owner.namespace.id);
  assert.equal(work.input.agentId, owner.agent.id);
  assert.equal(work.input.operationRef, input.transitionRef);
  assert.equal(work.input.lifecycleGeneration, generation);
  assert.equal(work.input.workId, input.workId);
  assert.equal(work.row.idempotencyKey, input.workId);
  assert.equal(work.row.agentId, owner.agent.id);
  assert.equal(work.row.namespaceId, owner.namespace.id);
  assert.equal(work.row.revisionId ?? null, revisionId);
  assert.equal(work.row.actorId, input.attribution.actorId);
  assert.equal(work.row.runtimeTransitionRef, input.transitionRef);
  assert.equal(work.row.lifecycleGeneration, generation);
  assert.equal(work.row.state, "queued");
  assert.equal(work.row.attemptCount, 0);
  assert.equal(work.row.claimToken, undefined);
  assert.equal(work.row.completedAt, undefined);
  assert.equal(cleanup.responsibilityRef, input.responsibilityRef);
  assert.equal(cleanup.installationId, owner.installation.id);
  assert.equal(cleanup.namespaceId, owner.namespace.id);
  assert.equal(cleanup.agentId, owner.agent.id);
  assert.equal(cleanup.responsibilityVersion, 1);
  assert.equal(cleanup.originKind, "lifecycle-protective-v1");
  assert.equal(cleanup.originOperationRef, input.transitionRef);
  assert.equal(cleanup.lifecycleGeneration, generation);
  assert.equal(cleanup.inventoryStatus, "unresolved");
  assert.equal(
    cleanup.kind,
    input.request.kind === "disable" ? "protective-fence" : "retained-stop",
  );
  assert.equal(record.export.auditEventId, input.audit.id);
  assert.equal(record.export.installationId, owner.installation.id);
  assert.equal(record.export.namespaceId, owner.namespace.id);
  assert.equal(record.export.originKind, "lifecycle-protective-v1");
  assert.equal(record.export.originOperationRef, input.transitionRef);
  assert.equal(record.export.state, "pending");
}

export async function assertAbsent(state, owner, input) {
  assert.equal(await committed(state, owner, input), undefined);
  assert.equal(
    (await audits(state)).some((event) => event.id === input.audit.id),
    false,
  );
}

// Real ordinary storage operations establish original deploy correspondence;
// none of these synthetic profile/actor values authenticates a caller or starts a runtime.
export async function seedRunning(state, owner) {
  const input = protectiveWrite(owner);
  const deployAudit = {
    ...input.audit,
    action: "openclaw.agents.deploy",
    resource: { kind: "agent_revision", id: owner.revision.id, namespaceId: owner.namespace.id },
  };
  return state.transact(async (unit) => {
    const intent = await unit.runtimeAssignments.initializeRuntimeIntent(
      owner.scope,
      owner.revision.id,
      input.transitionRef,
      input.attribution,
    );
    await unit.audit.append(deployAudit);
    await unit.runtimeAdmissions.recordAdmission({
      ...owner.scope,
      revisionId: owner.revision.id,
      runtimeTransitionRef: intent.transitionRef,
      lifecycleGeneration: intent.generation,
      auditEventId: deployAudit.id,
    });
    await unit.operations.append({
      action: "reconcile",
      kind: "agent_revision",
      namespaceId: owner.namespace.id,
      resourceId: owner.revision.id,
      actorId: intent.actorId,
      runtimeTransitionRef: intent.transitionRef,
      lifecycleGeneration: intent.generation,
    });
    const allocation = await unit.runtimeAssignments.allocateUnboundRuntime(
      owner.scope,
      1,
      "harness",
      0,
      randomUUID(),
      profiles,
    );
    return { intent, allocation, audit: deployAudit };
  });
}

export async function verifyProtectiveAdmissionStore(t, state) {
  for (const kind of ["disable", "stop"]) {
    await t.test(
      `first ${kind} retains a null selected revision despite an owned saved draft`,
      async () => {
        const owner = await seedRuntimeOwner(state);
        const input = protectiveWrite(owner, kind);
        const result = await apply(state, input);
        assert.equal(result.kind, "provisional");
        assertRetained(result.retained, owner, input, null, 1);
        assert.equal(result.retained.cleanup.predecessor, null);
        assert.deepEqual(result.retained.cleanup.allocations, []);
        assert.deepEqual(await committed(state, owner, input), result.retained);
        assert.equal((await head(state, owner)).revisionId, null);
        // The existing legacy projection must not mislabel Agent-only V1 work.
        const operations = await state.read((view) => view.operations.list());
        assert.equal(
          operations.some((operation) => operation.runtimeTransitionRef === input.transitionRef),
          false,
        );
      },
    );
  }

  await t.test(
    "same mode is unchanged only after exact CAS; no replacement IDs are retained",
    async () => {
      const owner = await seedRuntimeOwner(state);
      const original = protectiveWrite(owner);
      const first = await apply(state, original);
      const before = await audits(state);
      const noop = protectiveWrite(owner, "disable", 1);
      assert.deepEqual(copy(await apply(state, noop)), {
        kind: "unchanged",
        lifecycleGeneration: 1,
        desiredMode: "disabled",
      });
      await assertAbsent(state, owner, noop);
      assert.deepEqual(await audits(state), before);
      const stale = protectiveWrite(owner, "disable", null);
      await assert.rejects(apply(state, stale));
      await assertAbsent(state, owner, stale);
      await assert.rejects(apply(state, original));
      const reusedOperation = {
        ...protectiveWrite(owner, "disable", 1),
        transitionRef: original.transitionRef,
      };
      await assert.rejects(apply(state, reusedOperation));
      assert.deepEqual(await committed(state, owner, original), first.retained);
    },
  );

  for (const identity of ["workId", "responsibilityRef", "auditId"]) {
    await t.test(`a material admission cannot replace retained ${identity}`, async () => {
      const owner = await seedRuntimeOwner(state);
      const original = protectiveWrite(owner);
      const first = await apply(state, original);
      const collision = protectiveWrite(owner, "stop", 1);
      if (identity === "auditId") collision.audit.id = original.audit.id;
      else collision[identity] = original[identity];
      await assert.rejects(apply(state, collision));
      assert.equal(await committed(state, owner, collision), undefined);
      assert.deepEqual(await committed(state, owner, original), first.retained);
      assert.equal((await head(state, owner)).generation, 1);
    });
  }

  await t.test(
    "disable then stop retains the original null lineage and immutable historical records",
    async () => {
      const owner = await seedRuntimeOwner(state);
      const disable = protectiveWrite(owner);
      const first = await apply(state, disable);
      const stop = protectiveWrite(owner, "stop", 1);
      const second = await apply(state, stop);
      assertRetained(second.retained, owner, stop, null, 2);
      assert.deepEqual(copy(second.retained.cleanup.predecessor), {
        transitionRef: disable.transitionRef,
        generation: 1,
      });
      assert.deepEqual(await committed(state, owner, disable), first.retained);
      const forbidden = protectiveWrite(owner, "disable", 2);
      await assert.rejects(apply(state, forbidden));
      await assertAbsent(state, owner, forbidden);
      const foreign = await seedRuntimeOwner(state);
      assert.equal(await committed(state, foreign, disable), undefined);
    },
  );

  await t.test(
    "selected revision, original deploy work and uncertain allocation remain original",
    async () => {
      const owner = await seedRuntimeOwner(state);
      const original = await seedRunning(state, owner);
      const oldOperations = await state.read((view) => view.operations.list());
      const disable = protectiveWrite(owner, "disable", 1);
      const result = await apply(state, disable);
      assertRetained(result.retained, owner, disable, owner.revision.id, 2);
      assert.deepEqual(copy(result.retained.cleanup.predecessor), {
        transitionRef: original.intent.transitionRef,
        generation: 1,
      });
      assert.deepEqual(result.retained.cleanup.allocations, [original.allocation]);
      assert.deepEqual(await state.read((view) => view.operations.list()), oldOperations);
      assert.equal(
        (
          await state.read((view) =>
            view.runtimeAdmissions.findCommittedAdmission(
              owner.scope,
              original.intent.transitionRef,
              { actorId: original.intent.actorId, requestId: original.intent.requestId },
            ),
          )
        ).id,
        owner.revision.id,
      );
      await assert.rejects(
        state.transact((unit) =>
          unit.runtimeAssignments.advanceRuntimeIntent(
            owner.scope,
            2,
            { desiredMode: "running", revisionId: owner.revision.id },
            randomUUID(),
            { actorId: original.intent.actorId, requestId: original.intent.requestId },
          ),
        ),
      );
      await assert.rejects(
        state.transact((unit) =>
          unit.runtimeAssignments.allocateUnboundRuntime(
            owner.scope,
            1,
            "harness",
            1,
            randomUUID(),
            profiles,
          ),
        ),
      );
      assert.deepEqual(await committed(state, owner, disable), result.retained);
    },
  );

  await t.test("an outer rollback discards every provisional admission component", async () => {
    const owner = await seedRuntimeOwner(state);
    const input = protectiveWrite(owner);
    let provisional;
    const abort = new Error("controlled outer transaction rollback");
    await assert.rejects(
      state.transact(async (unit) => {
        provisional = await unit.lifecycleAdmissions.applyProtective(input);
        assert.equal(provisional.kind, "provisional");
        throw abort;
      }),
      (error) => error === abort,
    );
    assert.equal(await head(state, owner), undefined);
    await assertAbsent(state, owner, input);
  });

  await t.test(
    "the original installation read is permitted before isolated admission",
    async () => {
      const owner = await seedRuntimeOwner(state);
      const input = protectiveWrite(owner);
      const result = await state.transact(async (unit) => {
        assert.equal((await unit.installations.getInstallation()).id, owner.installation.id);
        return unit.lifecycleAdmissions.applyProtective(input);
      });
      assert.equal(result.kind, "provisional");
      assert.deepEqual(await committed(state, owner, input), result.retained);
    },
  );

  for (const ordering of ["before", "after", "second-apply"]) {
    await t.test(`caught ${ordering} isolation failure still poisons the outer unit`, async () => {
      const owner = await seedRuntimeOwner(state);
      const input = protectiveWrite(owner);
      const other = protectiveWrite(owner, "stop", 1);
      await assert.rejects(
        state.transact(async (unit) => {
          if (ordering === "before") await unit.namespaces.findNamespace(owner.namespace.id);
          try {
            await unit.lifecycleAdmissions.applyProtective(input);
            if (ordering === "after") await unit.audit.list();
            if (ordering === "second-apply") await unit.lifecycleAdmissions.applyProtective(other);
          } catch {
            /* The transaction owner must retain this failure independently. */
          }
        }),
      );
      await assertAbsent(state, owner, input);
      await assertAbsent(state, owner, other);
      assert.equal(await head(state, owner), undefined);
    });
  }

  await t.test(
    "accepted unawaited work is drained before commit and escaped units close",
    async () => {
      const owner = await seedRuntimeOwner(state);
      const input = protectiveWrite(owner);
      let pending;
      let escaped;
      await state.transact((unit) => {
        escaped = unit;
        pending = unit.lifecycleAdmissions.applyProtective(input);
      });
      const result = await pending;
      assert.equal(result.kind, "provisional");
      assert.deepEqual(await committed(state, owner, input), result.retained);
      const late = protectiveWrite(owner, "stop", 1);
      await assert.rejects(escaped.lifecycleAdmissions.applyProtective(late));
      await assertAbsent(state, owner, late);
    },
  );

  await t.test("an unawaited rejected admission cannot escape transaction failure", async () => {
    const owner = await seedRuntimeOwner(state);
    const input = protectiveWrite(owner);
    input.audit.actorId = "different-attribution";
    let pending;
    await assert.rejects(
      state.transact((unit) => {
        pending = unit.lifecycleAdmissions.applyProtective(input);
        void pending.catch(() => {});
      }),
    );
    await assert.rejects(pending);
    await assertAbsent(state, owner, input);
  });

  for (const invalid of [
    "audit-actor",
    "audit-resource",
    "audit-action",
    "unresolved-actor",
    "authorization-metadata",
    "foreign-request-owner",
  ]) {
    await t.test(`${invalid} failure cannot commit even if its rejection is caught`, async () => {
      const owner = await seedRuntimeOwner(state);
      const input = protectiveWrite(owner);
      if (invalid === "audit-actor") input.audit.actorId = "different-attribution";
      if (invalid === "audit-resource") input.audit.resource.id = `agt_${randomUUID()}`;
      if (invalid === "audit-action") input.audit.action = "openclaw.agents.deploy";
      if (invalid === "unresolved-actor") input.audit.actor.unresolved = true;
      if (invalid === "authorization-metadata")
        input.audit.authorization = {
          principalId: "different-attribution",
          action: "operate",
          resource: input.audit.resource,
        };
      if (invalid === "foreign-request-owner") input.request.agentId = `agt_${randomUUID()}`;
      await assert.rejects(
        state.transact(async (unit) => {
          await unit.lifecycleAdmissions.applyProtective(input).catch(() => {});
        }),
      );
      await assertAbsent(state, owner, input);
    });
  }
}
