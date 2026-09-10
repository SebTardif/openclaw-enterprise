import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresRepositoryWorkSelectedExecutionAdmissionV2 } from "../../packages/occ/src/state/postgres/repository-work-selected-execution-v2.ts";
import { CredentialInventoryOwnerPhaseV1 } from "../../packages/occ/src/ports/platform-unit-of-work.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { canonicalRepositoryWorkV2 as canonical } from "../../packages/occ/src/state/postgres/repository-work-canonical-v2.ts";
import {
  githubMetadataDigest,
  githubGitReadDigest,
  EMPTY_BODY_SHA256,
} from "../../packages/occ/src/github-mediation-v2/wire.ts";
import { parseTurnJournalV1 } from "../../packages/contracts/src/turn-journal-v1.ts";
import { parseRepositoryWorkPolicyV2 } from "../../packages/occ/src/lifecycle/repository-work-policy-v2.ts";
import { seedPreparation } from "../fixtures/runtime-preparation.mjs";
import * as journalValues from "../fixtures/turn-journal-v1/values.mjs";

// Actual State admission owner, existing repositories and decoders. ONLY the
// original native/selected source, IAM and PostgreSQL protocol are controlled.
// No mock grants native membership, execution, credentials or production rights.
const clone = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const settle = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};
async function until(entered) {
  for (let n = 0; n < 100 && !entered(); n++) await settle();
  assert.equal(entered(), true, "the selected original callback must be reached");
}

async function fixture(hooks = {}, version = 2) {
  const seed = await seedPreparation(new InMemoryPlatformState());
  await seed.append(seed.plan);
  await seed.append(seed.child);
  const history = await seed.history();
  const scope = {
    installationRef: seed.scope.installationId,
    namespaceRef: seed.scope.namespaceId,
    agentRef: seed.scope.agentId,
    revisionRef: seed.allocation.revisionId,
  };
  const substitutions = new Map([
    [journalValues.context.installationRef, scope.installationRef],
    [journalValues.context.namespaceRef, scope.namespaceRef],
    [journalValues.context.agentRef, scope.agentRef],
    [journalValues.identity.admittedRevisionRef, scope.revisionRef],
    [journalValues.identity.harnessAssignment.id, seed.allocation.assignmentRef],
  ]);
  const replace = (value) =>
    typeof value === "string"
      ? (substitutions.get(value) ?? value)
      : Array.isArray(value)
        ? value.map(replace)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]))
          : value;
  const attempt = replace(journalValues.attemptRecord);
  const exact = {
    attempt: attempt.binding.attempt,
    dispatchOperationRef: attempt.binding.dispatchOperationRef,
    consumption: attempt.consumption.operation,
    executionRef: "selected/execution",
    recipientRef: "recipient/occ",
  };
  const intent = {
    execution: exact,
    operationRef: "selected/intent",
    operationDigest: "a".repeat(64),
    executionLimitRef: "selected/limit",
    executionLimitVersion: 1,
    maximumExecutionMs: 60000,
    dispatchClock: {
      kind: "pre-commit-monotonic-v2",
      clockSourceRef: "clock/original",
      clockEpochRef: "epoch/original",
      anchorAtMs: 1000,
    },
  };
  const control = {
    kind: "host-stop-v2",
    intent,
    operationRef: "selected/deadline",
    operationDigest: "b".repeat(64),
    nativeIncarnationRef: "incarnation/original",
    nativeConstructionRef: "construction/original",
    responsibilityRef: "responsibility/original",
    responsibilityVersion: 1,
    deadlineAtMs: 61000,
  };
  const start = {
    kind: "host-controlled-v2",
    intent,
    operationRef: "selected/start",
    operationDigest: "c".repeat(64),
    nativeExecutionRef: "native/execution",
    nativeIncarnationRef: control.nativeIncarnationRef,
    nativeReservationRef: "native/reservation",
    nativeSessionRef: "native/session",
    nativeTurnRef: "native/turn",
    acceptanceEvidenceRef: "evidence/start",
    deadlineControl: control,
  };
  parseTurnJournalV1("executionStart", start);
  const request = {
    version,
    sequence: 1,
    request_ref: "1".repeat(32),
    method: "open-read",
    attachment_ref: "attachment/original",
    repository_owner: "owner",
    repository_name: "name",
    ...(version === 3
      ? {
          git_operation: "discovery",
          git_protocol: "version=2",
          body_bytes: 0,
          body_sha256: EMPTY_BODY_SHA256,
        }
      : {}),
    request_sha256:
      version === 3
        ? githubGitReadDigest("owner", "name", "discovery", 0, EMPTY_BODY_SHA256)
        : githubMetadataDigest("owner", "name"),
  };
  const now = Date.now(),
    horizon = new Date(now + 60000).toISOString();
  const abort = new AbortController(),
    lifetime = new AbortController();
  const call = {
    context: Object.freeze({}),
    requestRef: request.request_ref,
    recipientRef: exact.recipientRef,
    deadline: new Date(now + 2500).toISOString(),
    signal: abort.signal,
  };
  const session = Object.freeze({}),
    originalE = Object.freeze({});
  const executions = new Set([originalE]),
    acquiredExecutions = [];
  const service = {
    kind: "service_principal",
    id: seed.allocation.servicePrincipalId,
    namespaceId: scope.namespaceRef,
    agentId: scope.agentRef,
  };
  const execution = {
    attempt: exact.attempt,
    assignmentRef: seed.allocation.assignmentRef,
    assignmentVersion: "1",
    executionIncarnationRef: start.nativeIncarnationRef,
    executionGeneration: "1",
    receiverRef: "receiver/original",
    protectedOriginRef: "origin/original",
    executionProfile: { ref: "execution/profile", revision: "1" },
    predecessor: { kind: "none" },
  };
  const original = Object.freeze({
    operationRef: "work/admission",
    requestDigest: request.request_sha256,
    invocationRef: "work/invocation",
    scope,
  });
  const data = {
    start,
    execution,
    runtime: {
      target: seed.target,
      preparationRef: seed.plan.preparationRef,
      preparationVersion: 2,
      childEffectRef: seed.child.child.effect.effectRef,
    },
    service,
    requesterPrincipalId: attempt.binding.identity.principalRef,
    admission: {
      original,
      membershipProfile: { ref: "work/membership", revision: "1" },
      mode: { kind: "admit-root" },
      workBeganAt: new Date(now).toISOString(),
      originalHorizon: horizon,
      policyRef: "repository/policy",
    },
    attachmentRef: request.attachment_ref,
    dnsBindingRef: "dns/original",
    upstreamIpv4: "192.0.2.1",
    validUntil: horizon,
  };
  const policy = {
    schemaVersion: 2,
    policyRef: data.admission.policyRef,
    version: 1,
    status: "enabled",
    scope: seed.scope,
    servicePrincipalId: service.id,
    repository: {
      target: {
        installationId: scope.installationRef,
        githubHost: "github.com",
        appId: "100",
        githubInstallationId: "200",
        repositoryId: "42",
      },
      owner: "owner",
      name: "name",
      profile: { ref: "repository/profile", revision: "1" },
    },
    executionProfile: execution.executionProfile,
    operations: ["metadata:read", "git:read"],
    bounds: {
      notBefore: new Date(now - 1000).toISOString(),
      notAfter: new Date(now + 120000).toISOString(),
      maximumWorkMilliseconds: 60000,
    },
  };
  assert.ok(parseRepositoryWorkPolicyV2(policy), "original policy fixture must parse");
  const transportBinding = Object.freeze({});
  const verified = {
    configuration: {
      schemaVersion: 1,
      installationId: scope.installationRef,
      configurationVersion: 1,
      serviceIdentityRef: "service/original",
      serviceTrustProfileRef: "trust/original",
      serviceTrustProfileDigest: "a".repeat(64),
      trustRootsRef: "roots/original",
      verifierProfileRef: "verifier/original",
      permittedRecipientRef: call.recipientRef,
      role: "repository-issuer",
      allowedScope: { kind: "agent", ...seed.scope },
    },
    authenticatedAt: new Date(now).toISOString(),
    expiresAt: horizon,
    peerEvidenceRef: "peer/original",
    transportBinding,
  };
  const events = [],
    statements = [],
    accepted = new Set(),
    liveContexts = new Set();
  const durable = { heads: new Map(), operations: new Map() };
  let sourceParticipant,
    state,
    currentContext,
    currentPhase,
    openTransactions = 0,
    releases = 0,
    retainedReleases = 0,
    commits = 0;
  function contextCurrent(context, executionOperand, nativeSession, exactCall) {
    assert.ok(liveContexts.has(context), "actual source sees enrolled original context");
    assert.ok(executions.has(executionOperand));
    assert.equal(nativeSession, session);
    assert.equal(exactCall.context, call.context);
  }
  const native = {
    async acquire() {
      return session;
    },
    async inspect(n, c) {
      assert.equal(n, session);
      assert.equal(c.context, call.context);
      await hooks.nativeInspect?.(n, c);
      return {
        context: c.context,
        verified,
        lifetime: lifetime.signal,
        sessionRef: "github-native/connection",
      };
    },
    assertCurrent(n, c) {
      assert.equal(n, session);
      assert.equal(c.context, call.context);
      assert.equal(lifetime.signal.aborted, false);
      return hooks.nativeCurrent?.(c);
    },
    async release() {
      throw new Error("State cannot release the whole native Session");
    },
  };
  const source = {
    bindState(participant) {
      assert.equal(sourceParticipant, undefined);
      sourceParticipant = participant;
      return undefined;
    },
    async acquire(n, r, c) {
      assert.equal(n, session);
      assert.equal(r.request_sha256, request.request_sha256);
      await hooks.acquire?.(data, c);
      const e = hooks.freshExecution ? Object.freeze({}) : originalE;
      executions.add(e);
      acquiredExecutions.push(e);
      return {
        original: e,
        inspect() {
          return hooks.inspect?.(data) ?? data;
        },
        assertCurrent(next) {
          assert.equal(next.context, call.context);
          return hooks.current?.(next);
        },
        async release() {
          events.push("source-release");
          releases++;
          await hooks.release?.();
        },
      };
    },
    async retain(context, e, n, c) {
      currentContext = context;
      liveContexts.add(context);
      sourceParticipant.assertOriginal(context, e, n, c);
      contextCurrent(context, e, n, c);
      events.push("retain-source");
      await hooks.retain?.(context, data, c);
      return {
        assertCurrent() {
          sourceParticipant.assertOriginal(context, e, n, c);
          return hooks.heldCurrent?.(context, c);
        },
        async prepareCommit() {
          sourceParticipant.assertOriginal(context, e, n, c);
          events.push("prepare-source");
          await hooks.prepare?.(context, c);
        },
        async release() {
          events.push("retained-release");
          retainedReleases++;
          liveContexts.delete(context);
          await hooks.heldRelease?.();
        },
      };
    },
  };
  const columns = (a) => ({
    installation_id: a.installationRef,
    namespace_id: a.namespaceRef,
    agent_id: a.agentRef,
    conversation_ref: a.conversationRef,
    turn_ref: a.turnRef,
    attempt_ref: a.attemptRef,
    reservation_ref: a.reservationRef,
  });
  const operationRow = (kind, record) => ({
    ...columns(exact.attempt),
    operation_kind: kind,
    operation_ref: record.operationRef,
    request: clone(record),
    record: clone(record),
  });
  const enter = async (scopeInput, bounds, phase, body) => {
    assert.ok(bounds.timeoutMs > 0 && bounds.timeoutMs <= 3000);
    assert.equal(openTransactions, 0, "one original State transaction at a time");
    openTransactions++;
    currentPhase = phase;
    events.push("begin");
    const heads = new Map(durable.heads),
      operations = new Map(durable.operations);
    let active = true,
      iamLocked = false;
    const read = async (sql, params = []) => {
      assert.equal(active, true);
      phase.phase.assertOperationActive();
      statements.push(sql);
      events.push(sql);
      const override = await hooks.query?.(sql, params, {
        data,
        policy,
        durable,
        heads,
        operations,
        phase,
      });
      if (override !== undefined) return override;
      let rows;
      if (sql.includes("FROM occ.runtime_preparation_submissions")) rows = [];
      else if (sql.includes("FROM occ.runtime_preparation_operations"))
        rows = sql.includes("child_effect_ref")
          ? [{ record: history[1] }]
          : history.map((record) => ({ record }));
      else if (sql.startsWith("SELECT id FROM"))
        rows = [{ id: sql.includes("occ.agents") ? params[1] : params[0] }];
      else if (sql.includes("FROM occ.turn_journal_attempts")) {
        assert.ok(
          events.some(
            (s) =>
              typeof s === "string" && s.includes("occ.agents") && s.includes("FOR NO KEY UPDATE"),
          ),
        );
        rows = [
          {
            ...columns(exact.attempt),
            channel_installation_id: attempt.binding.identity.locator.channelInstallationRef,
            admission_receipt_ref: attempt.binding.identity.receipt.receiptRef,
            reservation: attempt.binding.reservation,
            first_received_at: journalValues.admission.decidedAt,
            version: String(attempt.version),
            record: attempt,
          },
        ];
      } else if (sql.includes("FROM occ.turn_journal_operations")) {
        rows = [
          operationRow("execution-intent", intent),
          operationRow("deadline-control", control),
          operationRow("execution-start", start),
        ];
        rows = hooks.journal?.(rows) ?? rows;
      } else if (sql.includes("FROM occ.turn_journal_reservations")) rows = [{ held: 1 }];
      else if (sql.startsWith("SELECT v.canonical_document"))
        rows = [
          {
            canonical_document: canonical({
              ...seed.scope,
              policyRef: policy.policyRef,
              version: policy.version,
              status: policy.status,
              servicePrincipalId: policy.servicePrincipalId,
              repositoryId: "42",
              document: policy,
            }),
          },
        ];
      else if (sql.startsWith("INSERT INTO occ.repository_work_heads_v2")) {
        const document = params[10];
        assert.equal(heads.has(params[4]), false);
        heads.set(params[4], document);
        rows = [{ canonical_document: document }];
      } else if (sql.startsWith("INSERT INTO occ.repository_work_operations_v2")) {
        const document = params[9];
        assert.equal(operations.has(params[4]), false);
        operations.set(params[4], document);
        rows = [{ canonical_document: document }];
      } else if (sql.includes("FROM occ.repository_work_operations_v2"))
        rows = operations.has(params[4]) ? [{ canonical_document: operations.get(params[4]) }] : [];
      else if (sql.includes("FROM occ.repository_work_heads_v2"))
        rows = heads.has(params[4]) ? [{ canonical_document: heads.get(params[4]) }] : [];
      else assert.fail(`Unexpected owned query: ${sql}`);
      return { rows, rowCount: rows.length };
    };
    const backend = {
      context: {
        scope: { installationId: scopeInput.installationId, namespaceId: scopeInput.namespaceId },
        transaction: {
          assertActive() {
            assert.equal(active, true);
            phase.phase.assertOperationActive();
          },
        },
        query: { query: read },
      },
      joinAccepted(pending) {
        assert.equal(active, true);
        accepted.add(pending);
        events.push("joined");
        void pending.then(
          () => accepted.delete(pending),
          () => accepted.delete(pending),
        );
        return undefined;
      },
      iam: {
        async lookupIdentity() {
          throw new Error("not selected");
        },
        async authorize(request) {
          assert.equal(iamLocked, true);
          assert.equal(request.principalId, data.requesterPrincipalId);
          assert.equal(request.action, "operate");
          events.push("iam-authorize");
          return { allowed: hooks.denied !== true };
        },
        assertCurrent() {
          assert.equal(active, true);
          return hooks.iamCurrent?.();
        },
      },
      async lockIAM() {
        assert.equal(iamLocked, false);
        iamLocked = true;
        events.push("lock-iam");
      },
      async readRuntimeAllocation(ref) {
        assert.equal(ref, execution.assignmentRef);
        events.push("allocation");
        return hooks.allocation?.(seed.allocation) ?? seed.allocation;
      },
      async appendAudit(actor, op, kind) {
        assert.equal(actor, data.requesterPrincipalId);
        assert.equal(op, original.operationRef);
        assert.equal(kind, "admission");
        events.push("audit");
        await hooks.audit?.();
      },
    };
    try {
      const result = await body(backend);
      await phase.prepareCommit();
      phase.assertCommitReady();
      phase.disposition = "sent";
      events.push("COMMIT");
      durable.heads = heads;
      durable.operations = operations;
      await hooks.commit?.(phase);
      phase.observeAcknowledgment();
      commits++;
      return result;
    } catch (error) {
      while (accepted.size) await Promise.allSettled([...accepted]);
      if (phase.disposition === "not-sent") {
        events.push("ROLLBACK");
        phase.establishedNoCommit = true;
      } else events.push("COMMIT-UNKNOWN");
      throw error;
    } finally {
      active = false;
      openTransactions--;
      phase.phase.close();
      events.push("outer-retired");
    }
  };
  state = createPostgresRepositoryWorkSelectedExecutionAdmissionV2(
    enter,
    () => new CredentialInventoryOwnerPhaseV1(),
    {
      protocolVersion: version,
      maximumAdmissions: 4,
      native,
      executions: source,
    },
  );
  state.bindState({
    assertOriginal() {
      throw new Error("M1 does not impersonate later Work-use enrollment");
    },
    assertObservationOriginal() {
      throw new Error("M1 does not impersonate later observer enrollment");
    },
  });
  return {
    state,
    seed,
    request,
    call,
    session,
    originalE,
    acquiredExecutions,
    data,
    attempt,
    policy,
    events,
    statements,
    durable,
    abort,
    lifetime,
    acquire: () => state.acquire(request, session, call),
    get currentContext() {
      return currentContext;
    },
    get currentPhase() {
      return currentPhase;
    },
    get releases() {
      return releases;
    },
    get retainedReleases() {
      return retainedReleases;
    },
    get commits() {
      return commits;
    },
    get openTransactions() {
      return openTransactions;
    },
    get sourceParticipant() {
      return sourceParticipant;
    },
  };
}

for (const version of [2, 3])
  test(`READ V${version} admits one exact logical Work after outer ACK and reacquires its current readset`, async () => {
    const f = await fixture({}, version),
      a = await f.acquire();
    assert.ok(a);
    assert.equal(f.commits, 1);
    assert.equal(f.durable.heads.size, 1);
    assert.equal(f.durable.operations.size, 1);
    assert.equal(f.openTransactions, 1);
    f.state.assertCurrent(a, f.session, f.call);
    const first = await f.state.inspect(a, f.session, f.call);
    const second = await f.state.inspect(a, f.session, f.call);
    assert.equal(first.selection.current.original, second.selection.current.original);
    assert.equal(first.selection.preparation, second.selection.preparation);
    assert.equal(first.selection.observation, second.selection.observation);
    assert.notEqual(
      first.selection.preparation.operationRef,
      first.selection.current.original.operationRef,
    );
    assert.equal(second.selection.admission.kind, "existing");
    assert.equal(second.selection.current.work.revision, 1);
    assert.equal(second.selection.current.lineage.kind, "root");
    assert.equal(second.selection.current.withdrawals[0].kind, "not-withdrawn-at-cut");
    if (version === 3)
      assert.deepEqual(second.selection.current.policy.requiredPermissions, [
        "contents:read",
        "metadata:read",
      ]);
    else assert.equal(second.selection.current.policy.permission, "metadata:read");
    await f.state.release(a);
    await f.state.release(a);
    assert.equal(f.openTransactions, 0);
    assert.equal(f.releases, 1);
    assert.ok(f.events.indexOf("audit") < f.events.indexOf("COMMIT"));
    assert.ok(f.events.indexOf("retain-source") < f.events.indexOf("lock-iam"));
    assert.throws(() => f.state.assertCurrent(a, f.session, f.call));
  });

for (const kind of [
  "intent-only",
  "wrong-start",
  "wrong-consumption",
  "wrong-dispatch",
  "cancelled",
  "missing-reservation",
  "wrong-principal",
  "wrong-assignment",
]) {
  test(`original journal ${kind} refuses before Work insertion`, async () => {
    const f = await fixture({
      query(sql) {
        if (kind === "missing-reservation" && sql.includes("FROM occ.turn_journal_reservations"))
          return { rows: [], rowCount: 0 };
      },
      journal(rows) {
        if (kind === "intent-only")
          return rows.filter((row) => row.operation_kind !== "execution-start");
        if (kind === "wrong-start") {
          const start = rows.find((row) => row.operation_kind === "execution-start");
          start.record.nativeSessionRef = "different-native-session";
          start.request = clone(start.record);
        }
        return rows;
      },
    });
    if (kind === "wrong-consumption") {
      f.attempt.consumption = {
        ...f.attempt.consumption,
        operation: {
          ...f.attempt.consumption.operation,
          operationRef: "different-consumption",
        },
      };
      f.attempt.outcome.consumptionOperationRef = "different-consumption";
    }
    if (kind === "wrong-dispatch") f.attempt.binding.dispatchOperationRef = "different-dispatch";
    if (kind === "cancelled")
      f.attempt.outcome = {
        kind: "cancelled",
        stage: "execution",
        evidenceRef: "cancelled/evidence",
      };
    if (kind === "wrong-principal") f.attempt.binding.identity.principalRef = "other-principal";
    if (kind === "wrong-assignment")
      f.attempt.binding.identity.harnessAssignment.id = "00000000-0000-4000-8000-000000000099";
    assert.equal(await f.acquire(), undefined);
    assert.equal(f.commits, 0);
    assert.equal(f.durable.heads.size, 0);
    assert.equal(f.releases, 1);
    assert.equal(f.openTransactions, 0);
  });
}

for (const kind of [
  "disabled",
  "wrong-service",
  "wrong-repository",
  "wrong-profile",
  "short-policy",
  "denied-IAM",
  "absent-existing",
]) {
  test(`admission requires actual ${kind} policy/admission correspondence`, async () => {
    const f = await fixture({ denied: kind === "denied-IAM" });
    if (kind === "disabled") f.policy.status = "disabled";
    if (kind === "wrong-service") f.policy.servicePrincipalId = "sp_other";
    if (kind === "wrong-repository") f.policy.repository.name = "other";
    if (kind === "wrong-profile") f.policy.executionProfile = { ref: "other", revision: "1" };
    if (kind === "short-policy")
      f.policy.bounds.notAfter = new Date(Date.now() + 1000).toISOString();
    if (kind === "absent-existing")
      f.data.admission.mode = { kind: "existing", workRef: "missing/work" };
    assert.equal(await f.acquire(), undefined);
    assert.equal(f.commits, 0);
    assert.equal(f.durable.heads.size, 0);
    assert.equal(f.releases, 1);
  });
}

test("the native monotonic deadline is never compared with a UTC Work horizon", async () => {
  const f = await fixture();
  assert.equal(f.data.start.deadlineControl.deadlineAtMs, 61000);
  const a = await f.acquire();
  assert.ok(a);
  await f.state.release(a);
});

test("copied A, wrong Session and copied source context cannot borrow the original owner", async () => {
  const f = await fixture(),
    a = await f.acquire();
  assert.ok(a);
  assert.throws(() => f.state.assertCurrent({ ...a }, f.session, f.call));
  await assert.rejects(f.state.inspect(a, {}, f.call));
  assert.throws(() =>
    f.sourceParticipant.assertOriginal({ ...f.currentContext }, f.originalE, f.session, f.call),
  );
  f.state.assertCurrent(a, f.session, f.call);
  await f.state.release(a);
});

test("a changed original admission object is refused even with identical comparison data", async () => {
  let copied = false;
  const f = await fixture({
    inspect(data) {
      return copied
        ? { ...data, admission: { ...data.admission, original: { ...data.admission.original } } }
        : data;
    },
  });
  const a = await f.acquire();
  assert.ok(a);
  copied = true;
  assert.throws(() => f.state.assertCurrent(a, f.session, f.call));
  await f.state.release(a);
  assert.equal(f.releases, 1);
});

test("unknown outer COMMIT retains actual admission history without emitting A", async () => {
  const first = new Error("lost-original-COMMIT-ack");
  const f = await fixture({
    commit() {
      throw first;
    },
  });
  assert.equal(await f.acquire(), undefined);
  assert.equal(f.durable.operations.size, 1);
  assert.equal(f.commits, 0);
  assert.equal(f.events.includes("COMMIT-UNKNOWN"), true);
  assert.equal(f.releases, 1);
  assert.equal(f.openTransactions, 0);
  assert.equal(await f.acquire(), undefined);
  assert.equal(f.durable.operations.size, 1);
});

test("mandatory audit refusal rolls the original admission back", async () => {
  const f = await fixture({
    audit() {
      throw new Error("audit-refused");
    },
  });
  assert.equal(await f.acquire(), undefined);
  assert.equal(f.events.includes("COMMIT"), false);
  assert.equal(f.durable.heads.size, 0);
  assert.equal(f.durable.operations.size, 0);
  assert.equal(f.releases, 1);
});

test("policy replacement is observed by a fresh held read without admitting Work again", async () => {
  const f = await fixture(),
    a = await f.acquire();
  assert.ok(a);
  f.policy.version = 2;
  await assert.rejects(f.state.inspect(a, f.session, f.call));
  assert.equal(f.commits, 1);
  assert.equal(f.durable.operations.size, 1);
  assert.equal(f.releases, 1);
});

for (const location of ["source", "held"])
  for (const rejection of [false, true]) {
    test(`${location} asynchronous fence ${rejection ? "rejection" : "completion"} drains before rollback and source release`, async () => {
      const gate = deferred();
      let armed = false,
        called = 0;
      const current = () => {
        if (armed) {
          armed = false;
          called++;
          return gate.promise;
        }
      };
      const f = await fixture(location === "source" ? { current } : { heldCurrent: current });
      const a = await f.acquire();
      assert.ok(a);
      const before = f.events.length;
      armed = true;
      assert.throws(() => f.state.assertCurrent(a, f.session, f.call));
      const releasing = f.state.release(a);
      await settle();
      assert.equal(called, 1);
      assert.equal(f.events.slice(before).includes("joined"), true);
      assert.equal(f.events.slice(before).includes("ROLLBACK"), false);
      assert.equal(f.releases, 0);
      if (rejection) gate.reject(new Error("late-original-failure"));
      else gate.resolve();
      await releasing;
      assert.equal(f.releases, 1);
      assert.equal(f.openTransactions, 0);
    });
  }

test("native retirement during accepted SQL acquisition joins before native borrow release", async () => {
  const gate = deferred();
  let entered = false,
    f;
  f = await fixture({
    async query(sql) {
      if (!entered && sql.includes("FROM occ.turn_journal_attempts")) {
        entered = true;
        f.lifetime.abort();
        await gate.promise;
      }
    },
  });
  const acquiring = f.acquire();
  await until(() => entered);
  assert.equal(f.releases, 0);
  assert.equal(f.openTransactions, 1);
  gate.resolve();
  assert.equal(await acquiring, undefined);
  assert.equal(f.releases, 1);
  assert.equal(f.events.includes("COMMIT"), false);
  assert.equal(f.openTransactions, 0);
});

test("late returned source cleanup is captured after caller cancellation", async () => {
  const gate = deferred();
  let entered = false;
  const f = await fixture({
    async acquire() {
      entered = true;
      await gate.promise;
    },
  });
  const acquiring = f.acquire();
  await until(() => entered);
  f.abort.abort();
  gate.resolve();
  assert.equal(await acquiring, undefined);
  assert.equal(f.releases, 1);
  assert.equal(f.events.includes("COMMIT"), false);
});

test("final preparation-time source refusal preserves no-COMMIT and one cleanup", async () => {
  const first = new Error("original-prepare-refusal");
  const f = await fixture({
    prepare() {
      throw first;
    },
  });
  assert.equal(await f.acquire(), undefined);
  assert.equal(f.events.includes("COMMIT"), false);
  assert.equal(f.durable.operations.size, 0);
  assert.equal(f.retainedReleases, 1);
  assert.equal(f.releases, 1);
});

for (const rejection of [false, true])
  test(`a phase-poisoning currentness callback joins its ${rejection ? "rejected" : "fulfilled"} work before retirement`, async () => {
    const gate = deferred(),
      first = new Error("original-phase-abort");
    let armed = false,
      f;
    f = await fixture({
      current() {
        if (!armed) return;
        armed = false;
        f.currentPhase.phase.poison(first);
        f.abort.abort();
        return gate.promise;
      },
    });
    const a = await f.acquire();
    assert.ok(a);
    const before = f.events.length;
    armed = true;
    assert.throws(
      () => f.state.assertCurrent(a, f.session, f.call),
      (error) => error === first,
    );
    const releasing = f.state.release(a);
    await settle();
    assert.equal(f.events.slice(before).includes("joined"), true);
    assert.equal(f.events.slice(before).includes("ROLLBACK"), false);
    assert.equal(f.releases, 0);
    if (rejection) gate.reject(new Error("later-completion-error"));
    else gate.resolve();
    await releasing;
    assert.equal(f.releases, 1);
    assert.equal(f.openTransactions, 0);
    assert.equal(f.commits, 1, "only the earlier admission committed");
  });

for (const persisted of [false, true])
  test(`unknown COMMIT ${persisted ? "present" : "absent"} quarantines the operation across fresh genuine E`, async () => {
    let attempts = 0,
      f;
    f = await fixture({
      freshExecution: true,
      commit() {
        if (++attempts !== 1) return;
        if (!persisted) {
          f.durable.heads.clear();
          f.durable.operations.clear();
        }
        throw new Error("one-shot-ambiguous-COMMIT");
      },
    });
    const original = f.data.admission.original;
    assert.equal(await f.acquire(), undefined);
    assert.equal(f.durable.operations.size, persisted ? 1 : 0);
    assert.equal(await f.acquire(), undefined);
    assert.equal(f.data.admission.original, original);
    assert.equal(f.acquiredExecutions.length, 2);
    assert.notEqual(f.acquiredExecutions[0], f.acquiredExecutions[1]);
    assert.equal(attempts, 1, "a second transaction would acknowledge, so it must not start");
    assert.equal(f.events.filter((e) => e === "begin").length, 1);
    assert.equal(f.events.filter((e) => e === "COMMIT").length, 1);
    assert.equal(f.durable.heads.size, persisted ? 1 : 0);
    assert.equal(f.durable.operations.size, persisted ? 1 : 0);
    assert.equal(f.releases, 2);
    assert.equal(f.openTransactions, 0);
  });

for (const priorFailure of [false, true])
  for (const rejected of [false, true]) {
    test(`direct join ${rejected ? "reject" : "fulfill"}, prior failure ${priorFailure}, refuses and drains before retirement`, async () => {
      const gate = deferred(),
        first = new Error("first-phase-failure");
      let armed = false,
        f;
      f = await fixture({
        heldCurrent(context) {
          if (!armed) return;
          armed = false;
          if (priorFailure) {
            f.currentPhase.phase.poison(first);
            f.abort.abort();
          }
          try {
            context.joinAccepted(gate.promise);
          } catch (error) {
            if (priorFailure) assert.equal(error, first);
          }
          return undefined;
        },
      });
      const a = await f.acquire();
      assert.ok(a);
      const before = f.events.length;
      armed = true;
      assert.throws(
        () => f.state.assertCurrent(a, f.session, f.call),
        (error) => !priorFailure || error === first,
      );
      const releasing = f.state.release(a);
      await settle();
      assert.equal(f.events.slice(before).includes("joined"), true);
      assert.equal(f.events.slice(before).includes("ROLLBACK"), false);
      assert.equal(f.releases, 0);
      assert.equal(f.openTransactions, 1);
      if (rejected) gate.reject(new Error("later-join-rejection"));
      else gate.resolve();
      await releasing;
      assert.equal(f.releases, 1);
      assert.equal(f.openTransactions, 0);
      assert.equal(f.commits, 1);
    });
  }

test("known existing admission remains usable through a fresh E without another Work insertion", async () => {
  const f = await fixture({ freshExecution: true }),
    a = await f.acquire();
  assert.ok(a);
  const data = await f.state.inspect(a, f.session, f.call);
  await f.state.release(a);
  f.data.admission.mode = { kind: "existing", workRef: data.selection.current.work.workRef };
  const b = await f.acquire();
  assert.ok(b);
  assert.notEqual(f.acquiredExecutions[0], f.acquiredExecutions[1]);
  assert.equal(f.durable.heads.size, 1);
  assert.equal(f.durable.operations.size, 1);
  assert.equal(f.events.filter((e) => e === "audit").length, 1);
  await f.state.release(b);
  assert.equal(f.releases, 2);
});

test("ordinary preparation completion joins remain permitted", async () => {
  let joins = 0;
  const f = await fixture({
    async prepare(context) {
      const pending = Promise.resolve().then(() => {
        joins++;
      });
      assert.equal(context.joinAccepted(pending), undefined);
      await pending;
    },
  });
  const a = await f.acquire();
  assert.ok(a);
  assert.equal(joins, 1);
  await f.state.release(a);
  assert.equal(f.commits, 1);
  assert.equal(f.releases, 1);
});
