import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { PostgresWorkQueue } from "../../packages/occ/src/state/postgres-work-queue.ts";
import { createPostgresControllerAuth } from "../../apps/controller/src/auth/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { workloadProfileAdmissionAuditV2 } from "../../packages/occ/src/state/platform-state.ts";
import { createPostgresWorkloadProfileAdmissionBackendV2 } from "../../packages/occ/src/state/postgres/workload-profile-admission.ts";
import { createWorkloadProfileAdmissionRepositoryV2 } from "../../packages/occ/src/workload-profiles/admission-record.ts";
import { WorkloadProfileTransactionGuard } from "../../packages/occ/src/workload-profiles/repository.ts";
import { retainRuntimePreparationOriginV1 } from "../../packages/occ/src/state/postgres/runtime-preparation-origin.ts";
import { runtimeAllocationTarget } from "../../packages/occ/src/runtime-authority/repository.ts";
import { seedRuntimeOwner, profiles } from "../conformance/runtime-assignment-store.contract.mjs";
import { signInWithEmailPassword } from "../helpers/auth-session.mjs";
import { createRuntimeAdmissionContext } from "./runtime-admission-context.mjs";
import { workloadProfileAdmissionFixture } from "./workload-profile-admission-v2.mjs";
import { bindingCandidateFixture } from "./runtime-binding-candidate.mjs";
import { rebuildPreparationChild, preparationWriter } from "./runtime-preparation.mjs";

export const invocationControllerRole = "occ_controller_workload_profile";
export const invocationSessionHelper =
  "occ.read_locked_workload_profile_session_v1(text,text,text,text,text,text)";

/** Real selected-role SQL, BetterAuth session and original storage repositories.
 * The consuming test separately exercises the original current-use owner with
 * actual Native IAM and a real queue claim. The profile dictionary/qualifier and
 * provider response remain controlled storage fixtures; this does not qualify a
 * protected HTTP deployment, installed capabilities or provider execution. */
export async function seedRuntimePreparationInvocation(pool, { retainOrigin = true } = {}) {
  let checkedOut;
  const borrowedPool = {
    options: pool.options,
    async connect() {
      assert.equal(checkedOut, undefined, "The fixture permits only one state checkout.");
      const client = await pool.connect();
      const held = { client, active: false };
      checkedOut = held;
      return {
        on: client.on.bind(client),
        removeListener: client.removeListener.bind(client),
        async query(statement, values) {
          const result = await client.query(statement, values);
          if (/^BEGIN\b/.test(statement)) held.active = true;
          if (/^(COMMIT|ROLLBACK)\b/.test(statement)) held.active = false;
          return result;
        },
        release(destroy) {
          held.active = false;
          checkedOut = undefined;
          client.release(destroy);
        },
      };
    },
    end: async () => {},
  };
  function transactionIo() {
    const held = checkedOut;
    assert.ok(held?.active, "A real original state transaction must own the client.");
    const assertActive = () => {
      assert.equal(checkedOut, held);
      assert.equal(held.active, true);
    };
    return {
      assertActive,
      async query(statement, values) {
        assertActive();
        const result = await held.client.query(statement, values);
        assertActive();
        return result;
      },
    };
  }
  const state = new PostgresPlatformState(borrowedPool);
  const owner = await seedRuntimeOwner(state);
  let auth;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const result = await auth.auth.handler(
        new Request(new URL(request.url, endpoint), {
          method: request.method,
          headers: request.headers,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        }),
      );
      response.statusCode = result.status;
      for (const [key, value] of result.headers)
        if (key !== "set-cookie") response.setHeader(key, value);
      response.setHeader("set-cookie", result.headers.getSetCookie());
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.statusCode = 500;
      response.end("Authentication fixture request failed.");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const credentials = {
    email: `invocation-${randomUUID()}@example.test`,
    password: `invocation-password-${randomUUID()}`,
  };
  let account;
  let session;
  let sessionCookie;
  try {
    auth = await createPostgresControllerAuth({
      pool,
      mode: "development",
      installationId: owner.installation.id,
      baseURL: endpoint,
      secret: `invocation-fixture-${randomUUID()}-${randomUUID()}`,
      secureCookies: false,
    });
    account = await auth.createAccount({ ...credentials, name: "Invocation storage fixture" });
    const authenticated = await signInWithEmailPassword({
      ...credentials,
      origin: endpoint,
      headers: { origin: endpoint },
    });
    sessionCookie = authenticated.cookie;
    await authenticated.response.arrayBuffer();
    session = await auth.auth.api.getSession({
      headers: new Headers({ cookie: authenticated.cookie }),
    });
  } finally {
    const closed = new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closed;
  }
  assert.equal(server.listening, false, "The real sign-in transport closes before worker use.");
  assert.equal(session?.user.id, account.id);
  assert.ok(session.session.token);
  const lookup = {
    installationId: owner.installation.id,
    accountId: account.id,
    issuer: auth.issuer,
    subject: account.id,
    sessionId: session.session.id,
    sessionCredentialDigest: createHash("sha256").update(session.session.token).digest("hex"),
  };
  const workerRole = {
    id: `role_invocation_${randomUUID()}`,
    name: "Invocation current-use fixture",
    permissions: [
      { action: "deploy", resourceKind: "agent" },
      { action: "read", resourceKind: "configuration" },
    ],
  };
  const originalPrincipal = auth.principalSeed(account, { roleId: workerRole.id }).principal;
  const iamSeed = {
    principal: originalPrincipal,
    roles: [workerRole],
    bindings: [
      { resourceKind: "agent", resourceId: owner.agent.id },
      { resourceKind: "configuration", resourceId: owner.revision.configurationId },
    ].map((target) => ({
      id: `iab_${randomUUID()}`,
      namespaceId: owner.namespace.id,
      subjectKind: "identity",
      subjectId: originalPrincipal.id,
      roleId: workerRole.id,
      ...target,
    })),
  };
  assert.notEqual(iamSeed.principal.id, account.id);
  assert.equal(iamSeed.principal.subject, account.id);
  await state.seedNativeIAM({
    identities: [iamSeed.principal],
    roles: iamSeed.roles,
    bindings: iamSeed.bindings,
    groups: [],
    memberships: [],
    restrictions: [],
  });
  const drivers = new DriverSelection();
  const iam = new NativeIAMDriver(state, { id: `invocation-native-iam-${randomUUID()}` });
  drivers.registerDriver(iam);
  drivers.selectDriver("iam", iam.id);
  // Never return credentials, token or cookie to test diagnostics.
  const profileFixture = workloadProfileAdmissionFixture({
    installationId: owner.installation.id,
    namespaceId: owner.namespace.id,
    actor: { accountRef: account.id, principalRef: iamSeed.principal.id },
  });
  const prepared = await state.transact((unit) =>
    unit.workloadProfiles.prepareOperation(profileFixture.request, profileFixture.actor),
  );
  const accepted = await state.transact(async (unit) => {
    const io = transactionIo();
    const guard = new WorkloadProfileTransactionGuard();
    const repository = createWorkloadProfileAdmissionRepositoryV2(
      createPostgresWorkloadProfileAdmissionBackendV2(
        {
          scope: { installationId: owner.installation.id },
          transaction: { assertActive: io.assertActive },
          query: { query: io.query },
        },
        (attribution, history) =>
          unit.audit.append(workloadProfileAdmissionAuditV2(attribution, history)),
      ),
      guard,
    );
    try {
      // Explicitly controlled definition data for relational storage testing.
      // This callback is not supplied to the live controller composition.
      return await repository.accept(
        {
          installationId: owner.installation.id,
          actor: profileFixture.actor,
          operationRef: prepared.operationRef,
        },
        { ...profileFixture.attribution, operationRef: prepared.operationRef },
        async () => undefined,
      );
    } finally {
      await guard.finish();
    }
  });
  const head = accepted.history.head;
  const revision = {
    ...owner.revision,
    id: `rev_${randomUUID()}`,
    revision: 2,
    workloadProfileUse: {
      schemaVersion: 2,
      installationId: owner.installation.id,
      namespaceId: owner.namespace.id,
      component: "gateway-harness-pair",
      ...head.selection,
      canonicalFormat: head.canonicalFormat,
      profileRefs: head.profileRefs,
      admittedConfigurationDigest: `sha256:${"a".repeat(64)}`,
    },
  };
  await state.transact((unit) => unit.revisions.createRevision(revision));
  const admission = createRuntimeAdmissionContext(owner.installation.id, iamSeed.principal.id);
  const command = {
    schemaVersion: 2,
    operationRef: admission.transitionRef,
    expectedLifecycleGeneration: null,
    revisionSource: "saved-draft",
    expectedDraft: {
      configurationId: revision.configurationId,
      configurationGeneration: revision.configurationGeneration,
      providerId: revision.providerId,
      executionMode: revision.harness.mode,
      serviceAccountId: null,
      workloadProfileSelection: head.selection,
    },
  };
  let originInput;
  const { intent, allocation } = await state.transact(async (unit) => {
    const io = transactionIo();
    const { rows } = await io.query(
      "SELECT * FROM occ.read_locked_workload_profile_session_v1($1,$2,$3,$4,$5,$6)",
      Object.values(lookup),
    );
    assert.equal(rows.length, 1, "The real selected-role session source must be current.");
    assert.equal(rows[0].state, "active");
    const origin = {
      ...lookup,
      accountIncarnation: rows[0].incarnation,
      accountVersion: Number(rows[0].account_version),
    };
    await unit.runtimeAdmissions.lockDeployCommand(owner.scope, command.operationRef);
    const intent = await unit.runtimeAssignments.initializeRuntimeIntent(
      owner.scope,
      revision.id,
      admission.transitionRef,
      { actorId: iamSeed.principal.id, requestId: admission.requestId },
    );
    const audit = admission.createAuditEvent(revision);
    await unit.audit.append(audit);
    await unit.runtimeAdmissions.recordAdmission(
      {
        ...owner.scope,
        revisionId: revision.id,
        runtimeTransitionRef: intent.transitionRef,
        lifecycleGeneration: intent.generation,
        auditEventId: audit.id,
      },
      { command, actorId: iamSeed.principal.id },
    );
    await unit.operations.append({
      kind: "agent_revision",
      action: "reconcile",
      namespaceId: owner.namespace.id,
      resourceId: revision.id,
      actorId: iamSeed.principal.id,
      runtimeTransitionRef: intent.transitionRef,
      lifecycleGeneration: intent.generation,
    });
    originInput = {
      deployment: { ...owner.scope, command },
      revisionId: revision.id,
      principalId: iamSeed.principal.id,
      accountRef: account.id,
      requestId: admission.requestId,
      admissionDecisionId: `storage-fixture/${randomUUID()}`,
      origin,
    };
    if (retainOrigin) await retainRuntimePreparationOriginV1(io, originInput);
    const allocation = await unit.runtimeAssignments.allocateUnboundRuntime(
      owner.scope,
      intent.generation,
      "harness",
      0,
      randomUUID(),
      profiles,
    );
    return { intent, allocation };
  });
  const target = runtimeAllocationTarget(allocation);
  const scope = {
    installationId: target.installationId,
    namespaceId: target.namespaceId,
    agentId: target.agentId,
  };
  const childTemplate = structuredClone(bindingCandidateFixture().options.child);
  const request = childTemplate.request;
  const preparationRef = randomUUID();
  request.preparation.preparationRef = preparationRef;
  request.effect.effectRef = randomUUID();
  request.effect.target = target;
  Object.assign(request.gate, {
    scope,
    intentRef: intent.transitionRef,
    lifecycleGeneration: intent.generation,
    admittedChildCutoff: 0,
  });
  request.gate.responsibility.responsibilityRef = randomUUID();
  request.effect.responsibility = request.gate.responsibility;
  request.plan.scope = scope;
  for (const entry of request.plan.targets) {
    entry.target.ownerAssignmentRef = target.assignmentRef;
    entry.target.ownerCreateEffectRef = target.createEffectRef;
  }
  for (const value of [request.providerTarget, request.predicate]) {
    value.ownerAssignmentRef = target.assignmentRef;
    value.ownerCreateEffectRef = target.createEffectRef;
  }
  request.admittedRuntime.runtimeProfileRef = allocation.runtimeProfileRef;
  request.admittedRuntime.configurationDigest =
    revision.workloadProfileUse.admittedConfigurationDigest;
  request.preparation.admittedProfileDigest = revision.workloadProfileUse.manifestDigest;
  const providerWireUtf8 = '{"kind":"storage-only-wire"}';
  const child = rebuildPreparationChild(childTemplate, providerWireUtf8);
  const common = {
    schemaVersion: 1,
    preparationRef,
    target,
    currentIntent: {
      intentRef: intent.transitionRef,
      mode: intent.desiredMode,
      lifecycleGeneration: intent.generation,
    },
    guard: child.guard,
  };
  const plan = {
    ...common,
    kind: "retain-plan",
    operationRef: randomUUID(),
    expectedVersion: null,
    plan: child.request.plan,
    preparation: child.request.preparation,
  };
  const childOperation = {
    ...common,
    kind: "retain-child",
    operationRef: randomUUID(),
    expectedVersion: 1,
    child,
    providerWireUtf8,
  };
  const append = (input) =>
    state.transact((unit) => unit.runtimePreparation.retain(input, preparationWriter));
  await append(plan);
  await append(childOperation);
  const currentUseRequest = {
    selection: {
      schemaVersion: 2,
      ...scope,
      revisionId: revision.id,
      configurationRef: revision.configurationId,
      configurationVersion: revision.configurationGeneration,
      selection: head.selection,
    },
    preparationRef,
    preparationVersion: 2,
    effectRef: child.effect.effectRef,
    guard: child.guard,
  };
  const queue = new PostgresWorkQueue(pool, { leaseDurationMs: 60_000 });
  let originFailure;
  return {
    state,
    owner,
    revision,
    intent,
    allocation,
    child,
    plan,
    childOperation,
    originInput,
    drivers,
    currentUseRequest,
    iamSeed,
    signInTransportClosed: !server.listening,
    revokeAccount: () => auth.deleteAccount(account),
    async signOut() {
      const result = await auth.auth.api.signOut({
        headers: new Headers({ cookie: sessionCookie }),
      });
      assert.equal(result.success, true);
      assert.equal(
        await auth.auth.api.getSession({ headers: new Headers({ cookie: sessionCookie }) }),
        null,
      );
    },
    async claimOriginalWork() {
      // Temporarily lock unrelated fixture rows. Original claim() then selects
      // this untouched admitted work via its real SKIP LOCKED query.
      const blocker = await pool.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT idempotency_key FROM occ.controller_work WHERE revision_id IS DISTINCT FROM $1 FOR UPDATE",
          [revision.id],
        );
        const claimed = await queue.claim();
        assert.equal(claimed?.revisionId, revision.id);
        assert.equal(claimed.actorId, iamSeed.principal.id);
        assert.equal(claimed.runtimeTransitionRef, intent.transitionRef);
        return { idempotencyKey: claimed.idempotencyKey, claimToken: claimed.claimToken };
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
      }
    },
    releaseClaim: (claim) => queue.defer(claim, { code: "INVOCATION_STORAGE_FIXTURE_COMPLETE" }),
    append,
    get originFailure() {
      return originFailure;
    },
    retainOriginAgain: () =>
      state.transact(async () => {
        try {
          await retainRuntimePreparationOriginV1(transactionIo(), originInput);
        } catch (error) {
          // Inspect only this trigger's fixed code/message before the original
          // state owner maps SQL errors; never inspect bind values or credentials.
          originFailure = {
            code: error.code,
            associationRejected: error.message === "Runtime preparation origin association differs",
          };
          throw error;
        }
      }),
  };
}
