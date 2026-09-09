import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { workloadProfileAdmissionAuditV2 } from "../../packages/occ/src/state/platform-state.ts";
import { createPostgresWorkloadProfileAdmissionBackendV2 } from "../../packages/occ/src/state/postgres/workload-profile-admission.ts";
import { createWorkloadProfileAdmissionRepositoryV2 } from "../../packages/occ/src/workload-profiles/admission-record.ts";
import { WorkloadProfileTransactionGuard } from "../../packages/occ/src/workload-profiles/repository.ts";
import { seedRuntimeOwner } from "../conformance/runtime-assignment-store.contract.mjs";
import { workloadProfileAdmissionFixture } from "./workload-profile-admission-v2.mjs";
import { seedPreparation } from "./runtime-preparation.mjs";

// Borrow only the original state transaction's actual client. Controlled profile
// definitions exercise relational storage, never live qualification or authority.
export function profileState(pool) {
  let held;
  const state = new PostgresPlatformState({
    options: pool.options,
    end: async () => {},
    async connect() {
      assert.equal(held, undefined);
      const client = await pool.connect();
      const current = { client, active: false };
      held = current;
      return {
        on: client.on.bind(client),
        removeListener: client.removeListener.bind(client),
        async query(statement, values) {
          const result = await client.query(statement, values);
          if (/^BEGIN\b/.test(statement)) current.active = true;
          if (/^(COMMIT|ROLLBACK)\b/.test(statement)) current.active = false;
          return result;
        },
        release(destroy) {
          current.active = false;
          held = undefined;
          client.release(destroy);
        },
      };
    },
  });
  const transactProfile = (installationId, action, after) =>
    state.transact(async (unit) => {
      const current = held;
      assert.ok(current?.active);
      const guard = new WorkloadProfileTransactionGuard();
      const assertActive = () => {
        assert.equal(held, current);
        assert.equal(current.active, true);
      };
      const repository = createWorkloadProfileAdmissionRepositoryV2(
        createPostgresWorkloadProfileAdmissionBackendV2(
          {
            scope: { installationId },
            transaction: { assertActive },
            query: {
              query: async (statement, values) => {
                assertActive();
                const result = await current.client.query(statement, values);
                assertActive();
                return result;
              },
            },
          },
          (attribution, history) =>
            unit.audit.append(workloadProfileAdmissionAuditV2(attribution, history)),
        ),
        guard,
      );
      try {
        const value = await action(repository);
        await after?.(unit, current.client, value);
        return value;
      } finally {
        await guard.finish();
      }
    });
  return { state, transactProfile };
}

export async function seedProfileGate(pool, { initialize = true } = {}) {
  const bound = profileState(pool),
    { state, transactProfile } = bound;
  const original = await seedRuntimeOwner(state);
  const actor = { accountRef: randomUUID(), principalRef: `prn_${randomUUID()}` };
  const accept = async (expected = null) => {
    const fixture = workloadProfileAdmissionFixture({
      installationId: original.installation.id,
      namespaceId: original.namespace.id,
      actor,
      expected,
    });
    const prepared = await state.transact((unit) =>
      unit.workloadProfiles.prepareOperation(fixture.request, actor),
    );
    const result = await transactProfile(original.installation.id, (repository) =>
      repository.accept(
        { installationId: original.installation.id, actor, operationRef: prepared.operationRef },
        { ...fixture.attribution, operationRef: prepared.operationRef },
        async () => undefined,
      ),
    );
    return result.history.head;
  };
  const head = await accept();
  const revision = {
    ...original.revision,
    id: `rev_${randomUUID()}`,
    revision: 2,
    workloadProfileUse: {
      schemaVersion: 2,
      installationId: original.installation.id,
      namespaceId: original.namespace.id,
      component: "gateway-harness-pair",
      ...head.selection,
      canonicalFormat: head.canonicalFormat,
      profileRefs: head.profileRefs,
      admittedConfigurationDigest: `sha256:${"a".repeat(64)}`,
    },
  };
  await state.transact((unit) => unit.revisions.createRevision(revision));
  const owner = await seedPreparation(state, { owner: { ...original, revision } });
  await owner.append(owner.plan);
  const initializeGate = () =>
    state.transact((unit) =>
      unit.runtimeEffectAdmission.retainClosedGate(owner.scope, owner.plan.operationRef),
    );
  if (initialize) await initializeGate();
  const anotherAgent = async (selectedHead = head, { initialize = true } = {}) => {
    const agent = {
      ...original.agent,
      id: `agt_${randomUUID()}`,
      name: `Profile owner ${randomUUID()}`,
      servicePrincipalId: randomUUID(),
    };
    const nextRevision = {
      ...revision,
      id: `rev_${randomUUID()}`,
      agentId: agent.id,
      revision: 1,
      servicePrincipalId: agent.servicePrincipalId,
      workloadProfileUse: {
        ...revision.workloadProfileUse,
        ...selectedHead.selection,
        profileRefs: selectedHead.profileRefs,
      },
    };
    await state.transact(async (unit) => {
      await unit.agents.createAgent(agent);
      await unit.revisions.createRevision(nextRevision);
    });
    const next = await seedPreparation(state, {
      owner: {
        ...original,
        agent,
        revision: nextRevision,
        scope: { namespaceId: original.namespace.id, agentId: agent.id },
      },
    });
    await next.append(next.plan);
    if (initialize)
      await state.transact((unit) =>
        unit.runtimeEffectAdmission.retainClosedGate(next.scope, next.plan.operationRef),
      );
    return {
      owner: next,
      read: () => state.read((view) => view.runtimeEffectAdmission.findGate(next.scope)),
      closure: () =>
        state.read((view) =>
          view.runtimeEffectAdmission.findProfileClosure(
            next.scope,
            selectedHead.terminal.invalidationRef,
          ),
        ),
    };
  };
  const attribution = () => ({
    actor,
    operationRef: randomUUID(),
    requestRef: `profile-withdraw/${randomUUID()}`,
    decisionRef: `decision/${randomUUID()}`,
  });
  const withdraw = (input = attribution(), after) =>
    transactProfile(
      original.installation.id,
      (repository) => repository.withdraw(original.namespace.id, head.selection, input),
      after,
    );
  const read = () => state.read((view) => view.runtimeEffectAdmission.findGate(owner.scope));
  const closure = () =>
    state.read((view) =>
      view.runtimeEffectAdmission.findProfileClosure(owner.scope, head.terminal.invalidationRef),
    );
  return {
    anotherAgent,
    ...bound,
    original,
    owner,
    head,
    actor,
    accept,
    withdraw,
    attribution,
    initializeGate,
    read,
    closure,
  };
}
