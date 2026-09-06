import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { NativeIAMDriver, createAuthPrincipalSeed } from "../../../packages/iam/src/index.ts";
import {
  InMemoryPlatformState,
  OpenClawController,
  PostgresPlatformState,
} from "../../../packages/occ/src/index.ts";
import { PostgresWorkQueue } from "../../../packages/occ/src/state/postgres-work-queue.ts";
import { parseLifecycleAdmissionV1 } from "../../../packages/contracts/src/lifecycle-admission-v1.ts";
import { LifecycleWorkPreflightV1 } from "../../../packages/occ/src/lifecycle/work-preflight-v1.ts";
import { encodeLifecycleWorkV1 } from "../../../packages/occ/src/lifecycle/work-codec-v1.ts";
import { parseControllerWorkV1 } from "../../../packages/occ/src/lifecycle/work-v1.ts";
import { resolveApprovedHarness } from "../../../apps/controller/src/composition/production-harness.ts";
import { createRuntimeAdmissionContext } from "../runtime-admission-context.mjs";
import { createTestConfigurationDriver } from "../../helpers/configuration-driver.mjs";
import { createDevelopmentComputeDriver } from "../../helpers/development.mjs";

function rowWork(row) {
  if (!row) return null;
  const optional = {
    agentId: row.agent_id,
    revisionId: row.revision_id,
    runtimeTransitionRef: row.runtime_transition_ref,
    lifecycleGeneration:
      row.lifecycle_generation === null ? null : Number(row.lifecycle_generation),
    claimToken: row.claim_token,
    leaseExpiresAt: row.lease_expires_at,
    completedAt: row.completed_at,
    namespaceTarget: row.namespace_target,
  };
  return parseControllerWorkV1({
    idempotencyKey: row.idempotency_key,
    namespaceId: row.namespace_id,
    actorId: row.actor_id,
    state: row.state,
    availableAt: row.available_at,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== null)),
  });
}

/** Real OCC admission/repositories, with a test-only worker-read adapter. The
 * installed deploy bridge does not persist the future CAS request object: its
 * original request expectation is retained independently by this fixture. Service
 * context checks here verify only fixture custody, not production authentication.
 */
export async function repositoryFixture(t, databaseUrl) {
  if (databaseUrl) {
    const url = new URL(databaseUrl);
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
      "Use an allocated loopback test database.",
    );
  }
  const pool = databaseUrl
    ? new pg.Pool({ connectionString: databaseUrl, max: 3, query_timeout: 3000 })
    : undefined;
  let namespaceId;
  t.after(async () => {
    if (!pool) return;
    try {
      // No provider was started. Retire only this fixture's leftover queue rows
      // so later cases cannot claim them; retain immutable admission history.
      if (namespaceId)
        await pool.query(
          "UPDATE occ.controller_work SET state='failed_permanent',completed_at=clock_timestamp(),claim_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE namespace_id=$1 AND state IN ('queued','claimed')",
          [namespaceId],
        );
    } finally {
      await pool.end();
    }
  });
  let state = pool ? new PostgresPlatformState(pool) : new InMemoryPlatformState();
  const installation = (pool && (await state.loadInstallation())) || {
    id: `ins_${randomUUID()}`,
    name: "Lifecycle work repository fixture",
    createdAt: new Date().toISOString(),
  };
  const seed = createAuthPrincipalSeed(installation.id, "work-preflight-test", {
    id: randomUUID(),
  });
  const iamState = {
    identities: [seed.principal],
    groups: [],
    memberships: [],
    restrictions: [],
    roles: seed.roles,
    bindings: seed.bindings,
  };
  if (pool) {
    if (!(await state.loadInstallation())) {
      state.setBootstrapNativeIAM(iamState);
      await state.transact((unit) => unit.installations.createInstallation(installation));
    } else await state.seedNativeIAM(iamState);
  }
  const controller = new OpenClawController(installation, { state, recordOperations: false });
  const iam = new NativeIAMDriver(pool ? state : { loadNativeIAMState: async () => iamState });
  for (const driver of [iam, createTestConfigurationDriver(), createDevelopmentComputeDriver()]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  const actorId = seed.principal.id;
  const namespace = await controller.createNamespace(actorId, {
    name: `work-preflight-${randomUUID()}`,
  });
  namespaceId = namespace.id;
  const configuration = await controller.createConfiguration(actorId, {
    namespaceId: namespace.id,
    kind: "agent",
    values: { model: "gpt-test" },
  });
  const agent = await controller.createAgent(actorId, {
    namespaceId: namespace.id,
    name: "Work preflight test",
    configurationId: configuration.id,
  });
  await state.transact((unit) =>
    unit.namespaces.transitionNamespaceStatus(namespace.id, "provisioning", "ready"),
  );
  const scope = { namespaceId: namespace.id, agentId: agent.id };
  const originals = new Map();
  const syntheticClaims = new Map();
  const context = Object.freeze({ fixture: randomUUID() });
  const callFor = (claim) => ({
    context,
    requestRef: randomUUID(),
    recipientRef: "fixture-work-reader",
    deadline: new Date(Date.now() + 20_000).toISOString(),
    signal: new AbortController().signal,
    claim: { idempotencyKey: claim.idempotencyKey, claimToken: claim.claimToken },
  });
  const checkCall = (call) => {
    assert.equal(call.context, context);
    assert.equal(call.recipientRef, "fixture-work-reader");
    assert.equal(call.signal.aborted, false);
  };
  const queueOptions = { leaseDurationMs: 1000, maxAttempts: 10, random: () => 0 };
  let queue = pool ? new PostgresWorkQueue(pool, queueOptions) : undefined;

  async function read(input, call) {
    checkCall(call);
    return state.read(
      async (view) => {
        const expected = originals.get(input.operationRef);
        if (!expected) return { kind: "unavailable", reasonCode: "UNAVAILABLE" };
        const intent = await view.runtimeAssignments.findRuntimeIntent(scope, input.operationRef);
        const committed = await view.runtimeAdmissions.findCommittedAdmission(
          scope,
          input.operationRef,
          { actorId: expected.intent.actorId, requestId: expected.intent.requestId },
        );
        if (!intent || !committed) return { kind: "unavailable", reasonCode: "UNAVAILABLE" };
        const admission = await view.runtimeAdmissions.findRevisionAdmission(scope, committed.id);
        if (!admission) return { kind: "unavailable", reasonCode: "UNAVAILABLE" };
        return {
          kind: "read",
          association: parseLifecycleAdmissionV1("association", {
            schemaVersion: 1,
            request: expected.request,
            intent,
            auditEventId: admission.auditEventId,
            workId: `agent_revision:${committed.id}:reconcile`,
          }),
          currentIntent: (await view.runtimeAssignments.findRuntimeIntentHead(scope)) ?? null,
        };
      },
      { signal: call.signal, timeoutMs: Math.min(3000, Date.parse(call.deadline) - Date.now()) },
    );
  }

  async function readQueue(input, call) {
    checkCall(call);
    const work = pool
      ? rowWork(
          (
            await pool.query(
              "SELECT * FROM occ.controller_work WHERE idempotency_key=$1 AND namespace_id=$2 AND agent_id=$3",
              [input.workId, scope.namespaceId, scope.agentId],
            )
          ).rows[0],
        )
      : syntheticClaims.get(input.workId);
    if (!work) return null;
    const operation = await state.read(async (view) =>
      (await view.operations.list()).find(
        (item) =>
          item.runtimeTransitionRef === input.operationRef &&
          item.kind === "agent_revision" &&
          item.namespaceId === scope.namespaceId,
      ),
    );
    return operation ? { operation, work } : null;
  }

  const createPreflight = () =>
    new LifecycleWorkPreflightV1({
      installationId: installation.id,
      now: () => new Date(),
      lifecycle: { readAdmittedWork: read },
      readQueue,
    });

  async function deploy({ claimWork = true } = {}) {
    const prior = await state.read((view) => view.runtimeAssignments.findRuntimeIntentHead(scope));
    const admissionCall = createRuntimeAdmissionContext(installation.id, actorId, {
      requestId: `req_${randomUUID()}`,
    });
    const revision = await controller.deployAgent(
      actorId,
      scope,
      resolveApprovedHarness,
      admissionCall,
    );
    const association = await state.read(async (view) => {
      const intent = await view.runtimeAssignments.findRuntimeIntent(
        scope,
        admissionCall.transitionRef,
      );
      const admission = await view.runtimeAdmissions.findRevisionAdmission(scope, revision.id);
      return parseLifecycleAdmissionV1("association", {
        schemaVersion: 1,
        request: {
          schemaVersion: 1,
          kind: "deploy",
          ...scope,
          expectedLifecycleGeneration: prior?.generation ?? null,
        },
        intent,
        auditEventId: admission.auditEventId,
        workId: `agent_revision:${revision.id}:reconcile`,
      });
    });
    originals.set(admissionCall.transitionRef, association);
    const input = {
      schemaVersion: 1,
      handler: "ReconcileAgentLifecycleV1",
      ...scope,
      operationRef: association.intent.transitionRef,
      lifecycleGeneration: association.intent.generation,
      workId: association.workId,
    };
    let claim;
    if (queue && claimWork) {
      claim = await queue.claim();
      assert.equal(
        claim?.idempotencyKey,
        input.workId,
        "The allocated test database must not have competing queued work.",
      );
    } else if (!pool && claimWork) {
      // Memory has genuine admission repositories but no durable leased queue.
      // This claim is controlled input only; PostgreSQL supplies lease evidence.
      const now = new Date();
      claim = {
        idempotencyKey: input.workId,
        ...scope,
        revisionId: revision.id,
        runtimeTransitionRef: input.operationRef,
        lifecycleGeneration: input.lifecycleGeneration,
        actorId,
        state: "claimed",
        availableAt: now,
        createdAt: now,
        updatedAt: now,
        attemptCount: 1,
        claimToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      };
      syntheticClaims.set(input.workId, claim);
    }
    const call = claim === undefined ? undefined : callFor(claim);
    return { input, association, claim, call, revision, wire: encodeLifecycleWorkV1(input) };
  }

  return {
    state,
    pool,
    scope,
    controller,
    configuration,
    installation,
    actorId,
    deploy,
    callFor,
    readQueue,
    createPreflight,
    syntheticClaims,
    get queue() {
      return queue;
    },
    restart() {
      if (pool) {
        state = new PostgresPlatformState(pool);
        queue = new PostgresWorkQueue(pool, queueOptions);
      }
      return createPreflight();
    },
    inspect(delivery, preflight = createPreflight()) {
      return preflight.inspect(delivery.wire, delivery.association, delivery.call);
    },
  };
}
