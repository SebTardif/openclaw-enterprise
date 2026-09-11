// Source-entry R3 successor. Retains the complete 45-case ORDER-01 control suite.
// Receiving dependency: the original lifecycle declaration adds optional fourth
// prepareStateUse operand { context, original }, and its real source.acquire
// branch supplies the genuine entered Work context with native checks around it.
// The bounded peers below exercise that call shape; they do not replace the
// original lifecycle owner or claim end-to-end issuer/provider execution.
import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresRepositoryWorkSelectedExecutionAdmissionV2 } from "../../packages/occ/src/state/postgres/repository-work-selected-execution-v2.ts";
import { createPostgresRepositoryWorkBindingV2 } from "../../packages/occ/src/state/postgres/repository-work-v2.ts";
import { createPostgresRepositoryWorkSelectionBindingV2 } from "../../packages/occ/src/state/postgres/repository-work-selection-v2.ts";
import { RepositoryWorkSelectedExecutionContextsV2 } from "../../packages/occ/src/state/postgres/repository-work-selected-execution-context-v2.ts";
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

// ORDER-01 correction: original custody precedes parents and live qualification.
// Preserves the frozen 35 controls with affected phase expectations corrected.
// New Work-transfer component suite. Fixture data and SQL protocol are adapted
// from the frozen 56-case correction-r2 suite; none of its case bodies are copied.
// Real core, selector, WorkBinding and phase own admission and context membership.
// Native, SQL, IAM and Work/custody are explicit controlled protocol peers.
// This suite establishes no real PostgreSQL, provider, credential or native rights.
const workParentName = (sql) =>
  sql.startsWith("SELECT id FROM") && sql.includes("FOR NO KEY UPDATE")
    ? sql.includes("occ.installation")
      ? "installation"
      : sql.includes("occ.namespaces")
        ? "namespace"
        : sql.includes("occ.agents")
          ? "agent"
          : undefined
    : undefined;
const workQualificationSql = (sql) =>
  sql.includes("FROM occ.turn_journal_") ||
  sql.startsWith("SELECT v.canonical_document") ||
  sql.includes("FROM occ.repository_work_operations_v2") ||
  sql.includes("FROM occ.repository_work_heads_v2");
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
  const call = hooks.sharedCall ?? {
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
  const registry = hooks.sharedRegistry ?? new RepositoryWorkSelectedExecutionContextsV2(),
    selectedDriver = Object.freeze({});
  const traces = [],
    workTransactions = [];
  const actualSelectorTransactions = [],
    retainedSourceLeases = [];
  let binding, workBinding, assignment, selection, selectedData, admission;
  const origin = Object.freeze({});
  const admissions = [],
    workSources = [],
    custodySources = [];
  let backendSequence = 0;
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
      const work = workTransactions.find((t) => !t.sqlRetired);
      if (work)
        traces.push({ kind: "work", id: work.id, event: "native-current", session: n, call: c });
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
      const selector = actualSelectorTransactions.find((transaction) => !transaction.sqlRetired);
      const work = workTransactions.find((transaction) => !transaction.sqlRetired);
      const retained = {
        context,
        execution: e,
        session: n,
        call: c,
        selectorId: selector?.id,
        workId: work?.id,
        prepares: 0,
        releaseStarts: 0,
        releaseCompletions: 0,
      };
      if (work) traces.push({ kind: "work", id: work.id, event: "retain-source", retained });
      retainedSourceLeases.push(retained);
      if (selector)
        traces.push({ kind: "actual-selector", id: selector.id, event: "retain-source", retained });
      return {
        assertCurrent() {
          sourceParticipant.assertOriginal(context, e, n, c);
          return hooks.heldCurrent?.(context, c);
        },
        async prepareCommit() {
          sourceParticipant.assertOriginal(context, e, n, c);
          events.push("prepare-source");
          retained.prepares++;
          await hooks.prepare?.(context, c, retained);
        },
        async release() {
          events.push("retained-release");
          retainedReleases++;
          liveContexts.delete(context);
          retained.releaseStarts++;
          await hooks.heldRelease?.(retained);
          retained.releaseCompletions++;
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
  // Both controlled outer owners use this one unchanged SQL/row peer. Identity
  // traces distinguish transactions; the fixture does not reproduce selection.
  const transactionBackend = (scopeInput, phase, pending = accepted, kind = "admission") => {
    const id = ++backendSequence,
      transactionKind = kind;
    const heads = new Map(durable.heads),
      operations = new Map(durable.operations);
    let active = true,
      iamLocked = false;
    const parents = [];
    const custodyCaptured = () =>
      traces.some(
        (event) =>
          event.kind === "work" && event.id === id && event.event === "custody-cleanup-captured",
      );
    const read = async (sql, params = []) => {
      assert.equal(active, true);
      phase.phase.assertOperationActive();
      if (kind === "work") {
        const parent = workParentName(sql);
        if (parent) {
          assert.equal(
            custodyCaptured(),
            true,
            "original custody cleanup must be captured before parent locks",
          );
          assert.equal(
            parent,
            ["installation", "namespace", "agent"][parents.length],
            "one original ordered I/N/A loop",
          );
          parents.push(parent);
        }
        if (workQualificationSql(sql)) {
          assert.equal(custodyCaptured(), true);
          assert.deepEqual(
            parents,
            ["installation", "namespace", "agent"],
            "journal and live policy/Work belong after custody and parents",
          );
        }
      }
      statements.push(sql);
      events.push(sql);
      traces.push({ kind, id, event: "query", sql, backend });
      const override = await hooks.query?.(sql, params, {
        data,
        policy,
        durable,
        heads,
        operations,
        phase,
        kind,
        id,
        backend,
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
      joinAccepted(completion) {
        assert.equal(active, true);
        pending.add(completion);
        events.push("joined");
        traces.push({ kind, id, event: "joined", completion });
        void completion.then(
          () => pending.delete(completion),
          () => pending.delete(completion),
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
          if (kind === "work") {
            assert.equal(custodyCaptured(), true);
            assert.deepEqual(parents, ["installation", "namespace", "agent"]);
          }
          traces.push({ kind, id, event: "iam-authorize" });
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
      inventory() {
        const unexpected = async () => {
          throw new Error("Read-only Work transfer must not enter inventory");
        };
        return {
          commitRef: phase.commitRef,
          assertActive() {
            assert.equal(active, true);
          },
          findLease: unexpected,
          insertLease: unexpected,
          findRecord: unexpected,
          findOperation: unexpected,
          listLeaseRecords: unexpected,
          capacity: unexpected,
          insertRecord: unexpected,
          replaceRecord: unexpected,
          appendOperation: unexpected,
          findMintClaim: unexpected,
          insertMintClaim: unexpected,
          findRevocationClaim: unexpected,
          appendRevocationClaim: unexpected,
        };
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
        traces.push({ kind: transactionKind, id, event: "audit" });
        await hooks.audit?.();
      },
    };
    return {
      id,
      kind,
      backend,
      heads,
      operations,
      pending,
      close() {
        active = false;
        traces.push({ kind, id, event: "sql-retired" });
      },
    };
  };
  const enter = async (scopeInput, bounds, phase, body) => {
    assert.ok(bounds.timeoutMs > 0 && bounds.timeoutMs <= 3000);
    assert.equal(openTransactions, 0, "one original State transaction at a time");
    openTransactions++;
    currentPhase = phase;
    events.push("begin");
    const transaction = transactionBackend(scopeInput, phase);
    const { backend, heads, operations } = transaction;
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
      transaction.close();
      openTransactions--;
      phase.phase.close();
      events.push("outer-retired");
    }
  };

  // These entered SQL peers register only their backend. In particular, Work
  // context enrollment is exclusively the original WorkBinding constructor's job.
  const selectorEnter = async (scopeInput, bounds, execution, body) => {
    assert.ok(bounds.timeoutMs > 0 && bounds.timeoutMs <= 3000);
    assert.equal(openTransactions, 1);
    const transaction = transactionBackend(scopeInput, execution, new Set(), "selector");
    const outer = {
      ...transaction,
      execution,
      selectedBorrows: 0,
      releasedBorrows: 0,
      sqlRetired: false,
    };
    actualSelectorTransactions.push(outer);
    openTransactions++;
    traces.push({ kind: "selector", id: outer.id, event: "begin" });
    const dispose = registry.registerBackend(
      transaction.backend,
      scopeInput,
      execution,
      (driver) => {
        assert.equal(driver, selectedDriver);
        outer.selectedBorrows++;
        return {
          backend: transaction.backend,
          async release() {
            assert.equal(outer.sqlRetired, true);
            outer.releasedBorrows++;
            traces.push({ kind: "selector", id: outer.id, event: "backend-released" });
          },
        };
      },
    );
    try {
      await body(transaction.backend);
      assert.fail("Selector readhold must retire by rollback");
    } catch (error) {
      while (transaction.pending.size) await Promise.allSettled([...transaction.pending]);
      assert.equal(execution.disposition, "not-sent");
      execution.establishedNoCommit = true;
      outer.terminal = "ROLLBACK";
      traces.push({ kind: "selector", id: outer.id, event: "ROLLBACK" });
      throw error;
    } finally {
      transaction.close();
      outer.sqlRetired = true;
      openTransactions--;
      execution.phase.close();
      dispose();
    }
  };
  const workEnter = async (scopeInput, bounds, execution, body) => {
    assert.ok(bounds.timeoutMs > 0 && bounds.timeoutMs <= 3000);
    assert.equal(
      openTransactions,
      hooks.ordinarySourceEntry === true ? 1 : 0,
      "only the explicit ordinary no-transfer probe enters before original selector retirement",
    );
    const transaction = transactionBackend(scopeInput, execution, new Set(), "work");
    const outer = {
      ...transaction,
      execution,
      selectedBorrows: 0,
      releasedBorrows: 0,
      sqlRetired: false,
    };
    workTransactions.push(outer);
    openTransactions++;
    traces.push({ kind: "work", id: outer.id, event: "begin" });
    const dispose = registry.registerBackend(
      transaction.backend,
      scopeInput,
      execution,
      (driver) => {
        assert.equal(driver, selectedDriver);
        outer.selectedBorrows++;
        traces.push({
          kind: "work",
          id: outer.id,
          event: "backend-borrowed",
          backend: transaction.backend,
        });
        return {
          backend: transaction.backend,
          async release() {
            assert.equal(
              outer.sqlRetired,
              true,
              "borrow release follows the exact Work SQL terminal",
            );
            outer.releasedBorrows++;
            traces.push({ kind: "work", id: outer.id, event: "backend-released" });
          },
        };
      },
    );
    const cancelled = () => execution.phase.poison(new Error("original Work call cancelled"));
    bounds.signal.addEventListener("abort", cancelled, { once: true });
    try {
      const value = await body(transaction.backend);
      await execution.phase.drainAccepted();
      await execution.phase.runFinalization(() => execution.prepareCommit());
      await execution.phase.drainAccepted();
      execution.assertCommitReady();
      execution.phase.assertCommitReady();
      execution.disposition = "sent";
      outer.terminal = "COMMIT";
      traces.push({ kind: "work", id: outer.id, event: "COMMIT" });
      durable.heads = transaction.heads;
      durable.operations = transaction.operations;
      // Controlled outer protocol may lose the ACK after COMMIT is sent. This
      // does not establish rollback or permit the owner to claim no commit.
      await hooks.workCommit?.(execution);
      execution.disposition = "acknowledged";
      execution.observeAcknowledgment();
      return value;
    } catch (error) {
      while (transaction.pending.size) await Promise.allSettled([...transaction.pending]);
      outer.failure = error;
      if (execution.disposition === "not-sent") {
        execution.establishedNoCommit = true;
        outer.terminal = "ROLLBACK";
        traces.push({ kind: "work", id: outer.id, event: "ROLLBACK" });
      } else {
        outer.terminal = "COMMIT-UNKNOWN";
        traces.push({ kind: "work", id: outer.id, event: "COMMIT-UNKNOWN" });
      }
      throw error;
    } finally {
      bounds.signal.removeEventListener("abort", cancelled);
      transaction.close();
      outer.sqlRetired = true;
      openTransactions--;
      execution.close();
      execution.phase.close();
      dispose();
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
    registry.forSelection(selectedDriver),
  );
  workBinding =
    hooks.sharedWorkBinding ??
    createPostgresRepositoryWorkBindingV2(
      workEnter,
      () => new CredentialInventoryOwnerPhaseV1(),
      registry,
    );
  const unused = () => {
    throw new Error("This transfer suite does not enter observation, inventory or origin use");
  };
  const selected = {
    ...state,
    async acquire(...operands) {
      admission = await state.acquire(...operands);
      admissions.push(admission);
      return admission;
    },
    retainObservation: unused,
    observationCall: unused,
    acquireInventory: unused,
  };
  binding = createPostgresRepositoryWorkSelectionBindingV2(
    selectorEnter,
    () => new CredentialInventoryOwnerPhaseV1(),
    workBinding.participant,
    { protocolVersion: version, maximumAssignments: 4, native, selected },
    registry,
  );
  binding.assignments.bindOrigins({
    recognize(value, c) {
      assert.equal(value, origin);
      assert.equal(c, call);
      return assignment;
    },
  });
  const makeLease = (kind, context, operation, exactCall) => {
    const lease = {
      kind,
      context,
      operation,
      call: exactCall,
      prepares: 0,
      releases: 0,
      assertCurrent() {
        assert.equal(exactCall.signal.aborted, false);
        assert.equal(lease.releases, 0);
        return hooks.workCurrent?.(kind);
      },
      async prepareCommit() {
        lease.prepares++;
        await hooks.workPrepare?.(kind);
      },
      async release() {
        lease.releases++;
        await hooks.workRelease?.(kind);
      },
    };
    return lease;
  };
  const workSource = {
    async acquire(context, operation, c) {
      workBinding.participant.assertOriginal(context, operation, c);
      const outer = workTransactions.at(-1);
      traces.push({
        kind: "work",
        id: outer.id,
        event: "work-source-acquire",
        context,
        operation,
        call: c,
      });
      await hooks.workAcquire?.({
        context,
        operation,
        call: c,
        state,
        admission,
        session,
        workBinding,
        binding,
      });
      const lease = makeLease("work", context, operation, c);
      workSources.push(lease);
      return {
        ...lease,
        actorId: data.requesterPrincipalId,
        async prepareUse() {
          traces.push({ kind: "work", id: outer.id, event: "policy-stage", context });
          await hooks.policyStage?.({
            context,
            operation,
            call: c,
            state,
            admission,
            session,
            workBinding,
            binding,
          });
          await binding.selection.retainPolicy(context, selection, operation, c);
          traces.push({ kind: "work", id: outer.id, event: "policy-qualified", context });
        },
        async qualifyReadset(readset) {
          assert.ok(readset.lineage.length > 0);
        },
        async qualifyAdmission() {
          throw new Error("transfer cannot readmit Work");
        },
        async qualifyClosure() {
          throw new Error("transfer cannot close Work");
        },
        async qualifyObservation() {
          throw new Error("transfer cannot observe dispatch");
        },
      };
    },
  };
  const custody = {
    async acquire(context, operation, c) {
      workBinding.participant.assertOriginal(context, operation, c);
      const outer = workTransactions.at(-1);
      traces.push({
        kind: "work",
        id: outer.id,
        event: "custody-acquire",
        context,
        operation,
        call: c,
      });
      await hooks.custodyAcquire?.({
        context,
        operation,
        call: c,
        state,
        admission,
        session,
        workBinding,
        binding,
      });
      const lease = makeLease("custody", context, operation, c);
      custodySources.push(lease);
      let captures = 0;
      traces.push({ kind: "work", id: outer.id, event: "custody-returned" });
      return {
        ...lease,
        receiver: Object.freeze({}),
        session,
        receiverRef: "receiver/original",
        sessionRef: "native/session",
        get release() {
          assert.equal(
            ++captures,
            1,
            "the original Work constructor captures custody release once",
          );
          traces.push({ kind: "work", id: outer.id, event: "custody-cleanup-captured", lease });
          return lease.release;
        },
        async stageRelease() {
          throw new Error("read-only transfer cannot stage physical release");
        },
      };
    },
  };
  // A secondary selector may share the original constructor/participant without
  // binding its original source pair again or manufacturing any Work context.
  const workStore = hooks.sharedWorkBinding
    ? undefined
    : workBinding.bindOriginalSources(workSource, custody);
  const api = {
    state,
    binding,
    workBinding,
    workStore,
    registry,
    native,
    seed,
    request,
    call,
    session,
    origin,
    originalE,
    data,
    attempt,
    policy,
    events,
    statements,
    traces,
    durable,
    abort,
    lifetime,
    admissions,
    acquiredExecutions,
    actualSelectorTransactions,
    workTransactions,
    retainedSourceLeases,
    workSources,
    custodySources,
    get admission() {
      return admission;
    },
    get assignment() {
      return assignment;
    },
    get selection() {
      return selection;
    },
    get selectedData() {
      return selectedData;
    },
    get currentContext() {
      return currentContext;
    },
    get commits() {
      return commits;
    },
    get releases() {
      return releases;
    },
    get openTransactions() {
      return openTransactions;
    },
    async select() {
      assignment = await binding.assignments.acquire(request, session, call);
      assert.ok(assignment);
      selection = await binding.selection.acquire(origin, request, call);
      assert.ok(selection);
      selectedData = await binding.selection.inspect(selection, origin, call);
      assert.ok(selectedData.preparation);
      return selectedData;
    },
    async handoff() {
      await binding.selection.prepareStateUse(selection, origin, call);
    },
    run(
      operation = selectedData.preparation,
      exactCall = call,
      body = (unit) => unit.readExactOperation(),
    ) {
      assert.ok(workStore, "a secondary selector does not own another Work store");
      return workStore.run(
        operation,
        exactCall,
        { signal: exactCall.signal, timeoutMs: 2000 },
        (unit) => {
          const outer = workTransactions.at(-1);
          traces.push({ kind: "work", id: outer.id, event: "body-enter" });
          return body(unit);
        },
      );
    },
    async close() {
      const pending = [];
      if (selection) {
        const value = selection;
        selection = undefined;
        pending.push(binding.selection.release(value));
      }
      if (assignment) {
        const value = assignment;
        assignment = undefined;
        pending.push(binding.assignments.release(value));
      }
      await Promise.all(pending);
      await binding.close();
    },
  };
  return api;
}

function assertSingleAdmission(f) {
  assert.equal(f.admissions.length, 1);
  assert.ok(f.admission);
  assert.equal(f.acquiredExecutions.length, 1);
  assert.equal(f.acquiredExecutions[0], f.originalE);
  assert.equal(f.commits, 1);
  assert.equal(f.durable.heads.size, 1);
  assert.equal(f.durable.operations.size, 1);
  assert.equal(f.events.filter((event) => event === "audit").length, 1);
}
function assertWorkPrefix(f, outer) {
  const local = f.traces.filter((event) => event.kind === "work" && event.id === outer.id);
  const native = local.findIndex((event) => event.event === "native-current");
  const retained = local.findIndex((event) => event.event === "retain-source");
  const source = local.findIndex((event) => event.event === "work-source-acquire");
  const firstSql = local.findIndex((event) => event.event === "query");
  assert.ok(
    native >= 0 && retained >= 0 && firstSql > native && firstSql > retained,
    "native currentness and retained original source both precede the first Work SQL",
  );
  assert.ok(
    source > retained,
    "only the retained native/source prefix precedes ordinary Work source acquisition",
  );
  const reads = local.filter((event) => event.event === "query");
  assert.ok(reads.length > 0);
  assert.ok(reads.every((event) => event.backend === outer.backend));
  assert.ok(reads.every((event) => /^\s*SELECT\b/.test(event.sql)));
  const installation = reads.findIndex(
    (event) =>
      event.sql.includes("FROM occ.installation") && event.sql.includes("FOR NO KEY UPDATE"),
  );
  const namespace = reads.findIndex(
    (event) => event.sql.includes("FROM occ.namespaces") && event.sql.includes("FOR NO KEY UPDATE"),
  );
  const agent = reads.findIndex(
    (event) => event.sql.includes("FROM occ.agents") && event.sql.includes("FOR NO KEY UPDATE"),
  );
  const journal = reads.findIndex((event) => event.sql.includes("FROM occ.turn_journal_attempts"));
  assert.ok(installation >= 0 && installation < namespace && namespace < agent && agent < journal);
  const custody = local.findIndex((event) => event.event === "custody-acquire");
  const captured = local.findIndex((event) => event.event === "custody-cleanup-captured");
  const parentEvents = local
    .map((event, index) => (event.event === "query" && workParentName(event.sql) ? index : -1))
    .filter((index) => index >= 0);
  const qualification = local.findIndex(
    (event) => event.event === "query" && workQualificationSql(event.sql),
  );
  const ordinaryPolicy = local.findIndex((event) => event.event === "policy-stage");
  const qualified = local.findIndex((event) => event.event === "policy-qualified");
  const body = local.findIndex((event) => event.event === "body-enter");
  assert.equal(parentEvents.length, 3);
  assert.ok(source < custody && custody < captured && captured < parentEvents[0]);
  assert.ok(
    parentEvents[2] < qualification &&
      qualification < ordinaryPolicy &&
      ordinaryPolicy < qualified &&
      qualified < body,
  );
  const policyAndWork = local
    .map((event, index) =>
      event.event === "query" && workQualificationSql(event.sql) ? index : -1,
    )
    .filter((index) => index >= 0);
  assert.ok(policyAndWork.every((index) => parentEvents[2] < index));
  const beforeBody = local.slice(0, body).filter((event) => event.event === "query");
  for (const fragment of [
    "FROM occ.turn_journal_attempts",
    "SELECT v.canonical_document",
    "repository_work_operations_v2",
    "repository_work_heads_v2",
  ])
    assert.ok(
      beforeBody.some((event) => event.sql.includes(fragment)),
      `complete qualification before body: ${fragment}`,
    );
  // The unit may legitimately issue another exact-operation read in its body.
  // Such a read must still follow the captured custody and original parents.
  for (const fragment of [
    "runtime_preparation_operations",
    "SELECT v.canonical_document",
    "repository_work_operations_v2",
    "repository_work_heads_v2",
  ])
    assert.ok(
      reads.some((event) => event.sql.includes(fragment)),
      fragment,
    );
  assert.equal(outer.selectedBorrows, 1);
  assert.equal(outer.releasedBorrows, 1);
}

for (const version of [2, 3])
  test(`Work transfer V${version} carries the original A through the actual selector into one entered Work backend`, async () => {
    const f = await fixture({}, version);
    try {
      const selected = await f.select(),
        a = f.admission;
      const second = await f.binding.selection.inspect(f.selection, f.origin, f.call);
      assert.equal(second.preparation, selected.preparation);
      assert.equal(second.current.original, selected.current.original);
      await f.handoff();
      assert.throws(() => f.binding.assignments.assertCurrent(f.assignment));
      assert.throws(() => f.state.assertCurrent(a, f.session, f.call));
      const result = await f.run();
      assert.equal(result.kind, "committed");
      assert.equal(f.admission, a);
      assert.equal(f.workTransactions.length, 1);
      assertWorkPrefix(f, f.workTransactions[0]);
      assertSingleAdmission(f);
      const originalUse = f.retainedSourceLeases.filter(
        (lease) => lease.workId === f.workTransactions[0].id,
      );
      assert.equal(originalUse.length, 1);
      assert.equal(originalUse[0].execution, f.originalE);
      assert.equal(originalUse[0].session, f.session);
      assert.equal(originalUse[0].call, f.call);
      assert.equal(originalUse[0].prepares, 1);
      assert.equal(originalUse[0].releaseStarts, 1);
      assert.equal(originalUse[0].releaseCompletions, 1);
      assert.equal(f.workSources[0].operation, selected.preparation);
      assert.equal(f.workSources[0].prepares, 1);
      assert.equal(f.custodySources[0].prepares, 1);
      assert.equal(f.workSources[0].releases, 1);
      assert.equal(f.custodySources[0].releases, 1);
    } finally {
      await f.close();
    }
    assert.equal(f.releases, 1);
    assert.equal(f.openTransactions, 0);
  });

for (const operand of [
  "copied-operation",
  "foreign-operation",
  "copied-call",
  "changed-request",
  "changed-recipient",
  "changed-context",
  "changed-signal",
  "changed-deadline",
]) {
  test(`Work transfer denies ${operand} with no second admission`, async () => {
    const f = await fixture();
    try {
      await f.select();
      await f.handoff();
      let operation = f.selectedData.preparation,
        call = f.call;
      if (operand === "copied-operation") operation = { ...operation };
      if (operand === "foreign-operation")
        operation = { ...operation, operationRef: "foreign/operation" };
      if (operand === "copied-call") call = { ...call };
      if (operand === "changed-request") call = { ...call, requestRef: "changed/request" };
      if (operand === "changed-recipient") call = { ...call, recipientRef: "changed/recipient" };
      if (operand === "changed-context") call = { ...call, context: Object.freeze({}) };
      if (operand === "changed-signal") call = { ...call, signal: new AbortController().signal };
      if (operand === "changed-deadline")
        call = { ...call, deadline: new Date(Date.now() + 1000).toISOString() };
      assert.equal((await f.run(operation, call)).kind, "not-committed");
      assertSingleAdmission(f);
      assert.equal(f.workTransactions.at(-1).terminal, "ROLLBACK");
    } finally {
      await f.close();
    }
    assert.equal(f.openTransactions, 0);
    assert.equal(f.releases, 1);
  });
}

for (const operand of [
  "copied-context",
  "foreign-context",
  "copied-A",
  "foreign-A",
  "foreign-session",
]) {
  test(`Work source-stage rejects duplicate or forged ${operand} without a second retainUse borrow`, async () => {
    let tested = false;
    const f = await fixture({
      async workAcquire({ context, state, admission, session, call }) {
        tested = true;
        await assert.rejects(async () =>
          state.retainUse(
            operand === "copied-context"
              ? { ...context }
              : operand === "foreign-context"
                ? Object.freeze({})
                : context,
            operand === "copied-A"
              ? { ...admission }
              : operand === "foreign-A"
                ? Object.freeze({})
                : admission,
            operand === "foreign-session" ? Object.freeze({}) : session,
            call,
          ),
        );
        throw new Error("End the denied-operand probe before executing the Work body");
      },
    });
    try {
      await f.select();
      await f.handoff();
      const outcome = await f.run();
      assert.equal(tested, true);
      assert.equal(outcome.kind, "not-committed");
      assertSingleAdmission(f);
      assert.equal(
        f.workTransactions.at(-1).selectedBorrows,
        1,
        "invalid operands cannot acquire a second borrow",
      );
    } finally {
      await f.close();
    }
    assert.equal(f.openTransactions, 0);
  });
}

for (const changed of ["policy", "assignment", "journal", "operation", "native-session"]) {
  test(`Work transfer rereads and refuses changed ${changed} after selector retirement`, async () => {
    let armed = false;
    const f = await fixture({
      allocation(value) {
        return armed && changed === "assignment"
          ? { ...value, revisionId: "foreign/revision" }
          : value;
      },
      journal(rows) {
        if (armed && changed === "journal")
          return rows.filter((row) => row.operation_kind !== "execution-start");
        return rows;
      },
    });
    try {
      await f.select();
      await f.handoff();
      armed = true;
      if (changed === "policy") f.policy.version++;
      if (changed === "operation") f.data.admission.original = { ...f.data.admission.original };
      if (changed === "native-session") f.data.start.nativeSessionRef = "changed/native/session";
      assert.equal((await f.run()).kind, "not-committed");
      assertSingleAdmission(f);
      assert.equal(f.workTransactions.at(-1).terminal, "ROLLBACK");
    } finally {
      await f.close();
    }
    assert.equal(f.openTransactions, 0);
  });
}

for (const version of [2, 3])
  test(`Work transfer V${version} awaits selector cleanup while outward currentness is absent`, async () => {
    const gate = deferred();
    let armed = false,
      entered = false;
    const f = await fixture(
      {
        async heldRelease(lease) {
          if (armed && lease.selectorId !== undefined) {
            entered = true;
            await gate.promise;
          }
        },
      },
      version,
    );
    try {
      await f.select();
      armed = true;
      let done = false;
      const handoff = f.handoff().then(() => {
        done = true;
      });
      await until(() => entered);
      assert.equal(done, false);
      assert.equal(f.workTransactions.length, 0);
      assert.throws(() => f.binding.assignments.assertCurrent(f.assignment));
      assert.throws(() => f.state.assertCurrent(f.admission, f.session, f.call));
      gate.resolve();
      await handoff;
      assert.equal((await f.run()).kind, "committed");
      assertSingleAdmission(f);
    } finally {
      gate.resolve();
      await f.close();
    }
    assert.equal(f.openTransactions, 0);
  });

for (const rejection of [false, true])
  test(`Work transfer joins late native retention ${rejection ? "rejection" : "completion"} before rollback`, async () => {
    const gate = deferred();
    let armed = false,
      entered = false;
    const f = await fixture({
      async retain() {
        if (armed) {
          entered = true;
          await gate.promise;
        }
      },
    });
    try {
      await f.select();
      await f.handoff();
      armed = true;
      let done = false;
      const running = f.run().then((value) => {
        done = true;
        return value;
      });
      await until(() => entered);
      f.abort.abort();
      await settle();
      assert.equal(done, false);
      assert.equal(f.workTransactions.at(-1).terminal, undefined);
      assert.equal(f.workTransactions.at(-1).releasedBorrows, 0);
      assert.equal(f.releases, 0);
      if (rejection) gate.reject(new Error("late-native-retain-refusal"));
      else gate.resolve();
      assert.equal((await running).kind, "not-committed");
      assert.equal(f.workTransactions.at(-1).terminal, "ROLLBACK");
      assert.equal(f.workTransactions.at(-1).releasedBorrows, 1);
      assertSingleAdmission(f);
    } finally {
      gate.resolve();
      await f.close();
    }
    assert.equal(f.openTransactions, 0);
    assert.equal(f.releases, 1);
  });

for (const rejection of [false, true])
  test(`Work transfer joins asynchronous retained assertion ${rejection ? "rejection" : "completion"}`, async () => {
    const gate = deferred();
    let armed = false,
      entered = false;
    const f = await fixture({
      heldCurrent() {
        if (armed) {
          armed = false;
          entered = true;
          return gate.promise;
        }
      },
      workAcquire() {
        armed = true;
      },
    });
    try {
      await f.select();
      await f.handoff();
      let done = false;
      const running = f.run().then((value) => {
        done = true;
        return value;
      });
      await until(() => entered);
      await settle();
      assert.equal(done, false);
      assert.equal(f.workTransactions.at(-1).terminal, undefined);
      assert.equal(f.workTransactions.at(-1).releasedBorrows, 0);
      if (rejection) gate.reject(new Error("late-native-assertion-refusal"));
      else gate.resolve();
      assert.equal((await running).kind, "not-committed");
      assert.equal(f.workTransactions.at(-1).terminal, "ROLLBACK");
      assertSingleAdmission(f);
    } finally {
      gate.resolve();
      await f.close();
    }
    assert.equal(f.openTransactions, 0);
  });

test(
  "Work transfer final cleanup joins source release without a retired-promise ownership cycle",
  { timeout: 10000 },
  async () => {
    const gate = deferred();
    let armed = false,
      entered = false;
    const f = await fixture({
      prepare(_context, _call, lease) {
        if (lease.workId !== undefined)
          assert.equal(lease.prepares, 1, "one retained native prepare per Work transaction");
      },
      async heldRelease(lease) {
        if (armed && lease.workId !== undefined) {
          entered = true;
          await gate.promise;
        }
      },
    });
    try {
      await f.select();
      await f.handoff();
      armed = true;
      let done = false;
      const running = f.run().then((value) => {
        done = true;
        return value;
      });
      await until(() => entered);
      await settle();
      const outer = f.workTransactions.at(-1);
      assert.equal(outer.terminal, "COMMIT");
      assert.equal(outer.sqlRetired, true);
      assert.equal(done, false, "the original Work result waits for retained cleanup");
      gate.resolve();
      assert.equal((await running).kind, "committed");
      assert.equal(outer.releasedBorrows, 1);
      assertSingleAdmission(f);
    } finally {
      gate.resolve();
      await f.close();
    }
    assert.equal(f.openTransactions, 0);
    assert.equal(f.releases, 1);
  },
);

test(
  "Work transfer concurrent selection and assignment shutdown joins the original Work cleanup",
  { timeout: 10000 },
  async () => {
    const gate = deferred();
    let armed = false,
      entered = false;
    const f = await fixture({
      async heldRelease(lease) {
        if (armed && lease.workId !== undefined) {
          entered = true;
          await gate.promise;
        }
      },
    });
    let closing;
    try {
      await f.select();
      await f.handoff();
      armed = true;
      let workDone = false;
      const running = f.run().then((value) => {
        workDone = true;
        return value;
      });
      await until(() => entered);
      const outer = f.workTransactions.at(-1);
      assert.equal(outer.sqlRetired, true);
      assert.equal(outer.terminal, "COMMIT");
      let closeDone = false;
      closing = f.close().then(() => {
        closeDone = true;
      });
      await settle();
      assert.equal(workDone, false);
      assert.equal(closeDone, false);
      assert.equal(
        f.releases,
        0,
        "original native ownership stays until accepted Work cleanup finishes",
      );
      gate.resolve();
      await Promise.all([running, closing]);
      assert.equal(workDone, true);
      assert.equal(closeDone, true);
      assert.equal(outer.releasedBorrows, 1);
      assertSingleAdmission(f);
    } finally {
      gate.resolve();
      if (closing) await closing;
      else await f.close();
    }
    assert.equal(f.openTransactions, 0);
    assert.equal(f.releases, 1);
  },
);

test("Work transfer cancellation in the retired-selector gap refuses before Work entry", async () => {
  const f = await fixture();
  try {
    await f.select();
    await f.handoff();
    assert.equal(f.openTransactions, 0);
    f.abort.abort();
    assert.equal((await f.run()).kind, "not-committed");
    assert.equal(f.workTransactions.length, 0);
    assert.equal(f.workSources.length, 0);
    assertSingleAdmission(f);
  } finally {
    await f.close();
  }
  assert.equal(f.openTransactions, 0);
  assert.equal(f.releases, 1);
});

test("Work transfer refuses a second prepareStateUse on the same original selection", async () => {
  const f = await fixture();
  try {
    await f.select();
    await f.handoff();
    const first = f.actualSelectorTransactions[0];
    assert.equal(first.sqlRetired, true);
    await assert.rejects(f.handoff());
    assert.equal(f.actualSelectorTransactions.length, 1);
    assert.equal(first.selectedBorrows, 1);
    assert.equal(first.releasedBorrows, 1);
    assert.equal(f.workTransactions.length, 0);
    assertSingleAdmission(f);
  } finally {
    await f.close();
  }
  assert.equal(f.openTransactions, 0);
  assert.equal(f.releases, 1);
});

for (const changed of ["missing-head", "disabled-policy", "withdrawn-work"]) {
  test(`Work transfer refuses fresh ${changed} rows after the original selector has retired`, async () => {
    const f = await fixture();
    try {
      await f.select();
      await f.handoff();
      assert.equal(f.openTransactions, 0);
      const operationBefore = [...f.durable.operations.values()];
      if (changed === "disabled-policy") f.policy.status = "disabled";
      else {
        const [workRef, document] = [...f.durable.heads][0];
        if (changed === "missing-head") f.durable.heads.delete(workRef);
        else {
          // A valid newer closed/withdrawn row from the controlled SQL peer;
          // actual repository codecs and core decide its admissibility.
          const head = JSON.parse(document);
          f.durable.heads.set(
            workRef,
            canonical({
              ...head,
              revision: head.revision + 1,
              withdrawalRevision: head.withdrawalRevision + 1,
              state: "closed",
            }),
          );
        }
      }
      assert.equal((await f.run()).kind, "not-committed");
      const outer = f.workTransactions.at(-1);
      assert.equal(outer.terminal, "ROLLBACK");
      assert.equal(outer.selectedBorrows, 1);
      assert.equal(outer.releasedBorrows, 1);
      assert.equal(
        f.workSources.length,
        1,
        "ordinary Work source is retained before late fresh-row refusal",
      );
      assert.equal(f.custodySources.length, 1, "custody is retained before late fresh-row refusal");
      assert.equal(f.workSources[0].releases, 1);
      assert.equal(f.custodySources[0].releases, 1);
      const local = f.traces.filter((event) => event.kind === "work" && event.id === outer.id);
      assert.equal(
        local.filter((event) => event.event === "query" && workParentName(event.sql)).length,
        3,
      );
      assert.equal(
        local.some((event) => event.event === "body-enter"),
        false,
      );
      assert.equal(f.admissions.length, 1);
      assert.equal(f.commits, 1);
      assert.deepEqual([...f.durable.operations.values()], operationBefore);
      assert.equal(f.events.filter((event) => event === "audit").length, 1);
    } finally {
      await f.close();
    }
    assert.equal(f.openTransactions, 0);
    assert.equal(f.releases, 1);
  });
}

test(
  "Work transfer lost COMMIT ACK preserves unknown disposition and joins native cleanup",
  { timeout: 10000 },
  async () => {
    const gate = deferred(),
      ackFault = new Error("original-Work-COMMIT-ACK-lost");
    let armed = false,
      cleanupEntered = false;
    const f = await fixture({
      workCommit(execution) {
        assert.equal(execution.disposition, "sent");
        assert.equal(execution.establishedNoCommit, false);
        throw ackFault;
      },
      async heldRelease(lease) {
        if (armed && lease.workId !== undefined) {
          cleanupEntered = true;
          await gate.promise;
        }
      },
    });
    try {
      await f.select();
      await f.handoff();
      armed = true;
      let done = false;
      const running = f.run().then((value) => {
        done = true;
        return value;
      });
      await until(() => cleanupEntered);
      await settle();
      const outer = f.workTransactions.at(-1);
      assert.equal(outer.failure, ackFault);
      assert.equal(outer.terminal, "COMMIT-UNKNOWN");
      assert.equal(outer.execution.disposition, "sent");
      assert.equal(outer.execution.establishedNoCommit, false);
      assert.equal(outer.sqlRetired, true);
      assert.equal(done, false);
      const terminalEvents = f.traces.filter(
        (event) => event.kind === "work" && event.id === outer.id,
      );
      assert.equal(terminalEvents.filter((event) => event.event === "COMMIT").length, 1);
      assert.equal(
        terminalEvents.some((event) => event.event === "ROLLBACK"),
        false,
      );
      assert.equal(outer.releasedBorrows, 0);
      gate.resolve();
      const result = await running;
      assert.equal(result.kind, "unknown");
      assert.equal(result.operationRef, f.selectedData.preparation.operationRef);
      assert.equal(outer.releasedBorrows, 1);
      assertSingleAdmission(f);
    } finally {
      gate.resolve();
      await f.close();
    }
    assert.equal(f.openTransactions, 0);
    assert.equal(f.releases, 1);
  },
);

test("Work handoff gap rejects forged original operands before any transfer borrow and preserves the lawful transfer", async () => {
  const f = await fixture();
  try {
    await f.select();
    const priorContext = f.currentContext,
      admission = f.admission;
    await f.handoff();
    assert.equal(f.openTransactions, 0);
    assert.equal(f.workTransactions.length, 0);
    let fakeContextCalls = 0;
    const deny = () => {
      fakeContextCalls++;
      throw new Error("unrecognized context methods must not execute");
    };
    const copiedContext = Object.freeze({
      ...priorContext,
      assertActive: deny,
      retain: deny,
      joinAccepted: deny,
    });
    const foreignContext = Object.freeze({
      installationId: "foreign/installation",
      assertActive: deny,
      retain: deny,
      joinAccepted: deny,
    });
    // The original selector has retired, its explicit handoff marker exists,
    // and the first Work use has not been acquired. These probes therefore
    // cannot pass merely because an already-active e.use denies a duplicate.
    for (const [name, context, candidateA, session] of [
      ["copied-context", copiedContext, admission, f.session],
      ["foreign-context", foreignContext, admission, f.session],
      ["copied-A", copiedContext, { ...admission }, f.session],
      ["foreign-A", copiedContext, Object.freeze({}), f.session],
      ["foreign-session", copiedContext, admission, Object.freeze({})],
    ]) {
      await assert.rejects(
        async () => f.state.retainUse(context, candidateA, session, f.call),
        name,
      );
      assert.equal(fakeContextCalls, 0, name);
      assert.equal(f.workTransactions.length, 0, name);
    }
    assert.equal((await f.run()).kind, "committed");
    assert.equal(f.admission, admission);
    assert.equal(f.workTransactions.length, 1);
    const outer = f.workTransactions[0];
    assertWorkPrefix(f, outer);
    const nativeUses = f.retainedSourceLeases.filter((lease) => lease.workId === outer.id);
    assert.equal(nativeUses.length, 1);
    assert.equal(nativeUses[0].execution, f.originalE);
    assert.equal(nativeUses[0].session, f.session);
    assert.equal(nativeUses[0].prepares, 1);
    assert.equal(nativeUses[0].releaseCompletions, 1);
    assert.equal(fakeContextCalls, 0);
    assertSingleAdmission(f);
  } finally {
    await f.close();
  }
  assert.equal(f.openTransactions, 0);
  assert.equal(f.releases, 1);
});

function assertCustodyBoundaryPending(f, outer) {
  const local = f.traces.filter((event) => event.kind === "work" && event.id === outer.id);
  assert.equal(local.filter((event) => event.event === "work-source-acquire").length, 1);
  assert.equal(local.filter((event) => event.event === "custody-acquire").length, 1);
  assert.equal(
    local.some((event) => event.event === "custody-cleanup-captured"),
    false,
  );
  assert.equal(
    local.some(
      (event) =>
        event.event === "query" && (workParentName(event.sql) || workQualificationSql(event.sql)),
    ),
    false,
  );
  assert.equal(
    local.some((event) =>
      ["iam-authorize", "policy-stage", "policy-qualified", "body-enter"].includes(event.event),
    ),
    false,
  );
  assert.equal(outer.terminal, undefined);
  assert.equal(outer.releasedBorrows, 0);
  const native = f.retainedSourceLeases.filter((lease) => lease.workId === outer.id);
  assert.equal(native.length, 1);
  assert.equal(native[0].prepares, 0);
  assert.equal(native[0].releaseStarts, 0);
  assert.equal(f.workSources[0].releases, 0);
}

for (const version of [2, 3])
  test(`ORDER-01 V${version} custody gate blocks parents and all live qualification while A remains unavailable`, async () => {
    const gate = deferred();
    let entered = false;
    const f = await fixture(
      {
        async custodyAcquire() {
          entered = true;
          await gate.promise;
        },
      },
      version,
    );
    try {
      const selected = await f.select(),
        admission = f.admission;
      await f.handoff();
      let done = false;
      const running = f
        .run(undefined, undefined, (unit) => {
          assert.equal(f.admission, admission);
          f.state.assertCurrent(admission, f.session, f.call);
          f.binding.assignments.assertCurrent(f.assignment);
          return unit.readExactOperation();
        })
        .then((value) => {
          done = true;
          return value;
        });
      await until(() => entered);
      await settle();
      const outer = f.workTransactions.at(-1);
      assert.equal(done, false);
      assertCustodyBoundaryPending(f, outer);
      assert.throws(() => f.state.assertCurrent(admission, f.session, f.call));
      assert.throws(() => f.binding.assignments.assertCurrent(f.assignment));
      assert.equal(f.workSources[0].operation, selected.preparation);
      gate.resolve();
      assert.equal((await running).kind, "committed");
      assert.equal(f.admission, admission);
      assertWorkPrefix(f, outer);
      assertSingleAdmission(f);
      const native = f.retainedSourceLeases.filter((lease) => lease.workId === outer.id);
      assert.equal(native[0].prepares, 1);
      assert.equal(native[0].releaseCompletions, 1);
      assert.equal(f.workSources[0].prepares, 1);
      assert.equal(f.custodySources[0].prepares, 1);
      assert.equal(f.custodySources[0].releases, 1);
    } finally {
      gate.resolve();
      await f.close();
    }
    assert.equal(f.openTransactions, 0);
    assert.equal(f.releases, 1);
  });

for (const version of [2, 3])
  for (const outcome of ["rejection", "abort"]) {
    test(`ORDER-01 V${version} custody ${outcome} joins accepted acquisition and retained cleanup without parent or policy entry`, async () => {
      const gate = deferred();
      let entered = false;
      const f = await fixture(
        {
          async custodyAcquire() {
            entered = true;
            await gate.promise;
          },
        },
        version,
      );
      try {
        await f.select();
        await f.handoff();
        let done = false;
        const running = f.run().then((value) => {
          done = true;
          return value;
        });
        await until(() => entered);
        const outer = f.workTransactions.at(-1);
        assertCustodyBoundaryPending(f, outer);
        if (outcome === "abort") {
          f.abort.abort();
          await settle();
          assertCustodyBoundaryPending(f, outer);
        }
        assert.equal(done, false);
        if (outcome === "rejection") gate.reject(new Error("original-custody-acquisition-refused"));
        else gate.resolve();
        assert.equal((await running).kind, "not-committed");
        const local = f.traces.filter((event) => event.kind === "work" && event.id === outer.id);
        assert.equal(
          local.some(
            (event) =>
              event.event === "query" &&
              (workParentName(event.sql) || workQualificationSql(event.sql)),
          ),
          false,
        );
        assert.equal(
          local.some((event) =>
            ["iam-authorize", "policy-stage", "body-enter"].includes(event.event),
          ),
          false,
        );
        assert.equal(outer.terminal, "ROLLBACK");
        assert.equal(outer.releasedBorrows, 1);
        const native = f.retainedSourceLeases.filter((lease) => lease.workId === outer.id);
        assert.equal(native.length, 1);
        assert.equal(native[0].prepares, 0);
        assert.equal(native[0].releaseCompletions, 1);
        assert.equal(f.workSources[0].releases, 1);
        if (outcome === "abort") {
          assert.equal(
            local.filter((event) => event.event === "custody-cleanup-captured").length,
            1,
          );
          assert.equal(
            f.custodySources[0].releases,
            1,
            "late returned custody cleanup belongs to the original Work owner",
          );
        } else assert.equal(f.custodySources.length, 0);
        assertSingleAdmission(f);
      } finally {
        gate.resolve();
        await f.close();
      }
      assert.equal(f.openTransactions, 0);
      assert.equal(f.releases, 1);
    });
  }

for (const version of [2, 3])
  for (const outcome of ["completion", "rejection"]) {
    test(`ORDER-01 V${version} late journal ${outcome} after cancellation joins the original Work completion before cleanup`, async () => {
      const gate = deferred();
      let armed = false,
        entered = false;
      const f = await fixture(
        {
          async query(sql, _params, transaction) {
            if (
              armed &&
              transaction.kind === "work" &&
              sql.includes("FROM occ.turn_journal_attempts")
            ) {
              entered = true;
              await gate.promise;
            }
          },
        },
        version,
      );
      try {
        await f.select();
        await f.handoff();
        armed = true;
        let done = false;
        const running = f.run().then((value) => {
          done = true;
          return value;
        });
        await until(() => entered);
        const outer = f.workTransactions.at(-1);
        const local = () =>
          f.traces.filter((event) => event.kind === "work" && event.id === outer.id);
        assert.equal(
          local().filter((event) => event.event === "custody-cleanup-captured").length,
          1,
        );
        assert.equal(
          local().filter((event) => event.event === "query" && workParentName(event.sql)).length,
          3,
        );
        assert.equal(
          local().some((event) => event.event === "policy-stage" || event.event === "body-enter"),
          false,
        );
        assert.throws(() => f.state.assertCurrent(f.admission, f.session, f.call));
        assert.throws(() => f.binding.assignments.assertCurrent(f.assignment));
        f.abort.abort();
        await settle();
        assert.equal(done, false);
        assert.equal(outer.terminal, undefined);
        assert.equal(outer.releasedBorrows, 0);
        assert.equal(f.workSources[0].releases, 0);
        assert.equal(f.custodySources[0].releases, 0);
        if (outcome === "rejection") gate.reject(new Error("late-original-journal-query-refused"));
        else gate.resolve();
        assert.equal((await running).kind, "not-committed");
        assert.equal(outer.terminal, "ROLLBACK");
        assert.equal(outer.releasedBorrows, 1);
        assert.equal(
          local().some((event) => event.event === "policy-stage" || event.event === "body-enter"),
          false,
        );
        const native = f.retainedSourceLeases.filter((lease) => lease.workId === outer.id);
        assert.equal(native.length, 1);
        assert.equal(native[0].prepares, 0);
        assert.equal(native[0].releaseCompletions, 1);
        assert.equal(f.workSources[0].releases, 1);
        assert.equal(f.custodySources[0].releases, 1);
        assertSingleAdmission(f);
      } finally {
        gate.resolve();
        await f.close();
      }
      assert.equal(f.openTransactions, 0);
      assert.equal(f.releases, 1);
    });
  }

for (const version of [2, 3])
  test(`SOURCE-ENTRY V${version} original fourth operand skips retired preparation without restoring A`, async () => {
    let f,
      prepared = 0;
    f = await fixture(
      {
        async workAcquire({ context, operation, call }) {
          const outer = f.workTransactions.at(-1);
          const retired = f.actualSelectorTransactions[0];
          assert.equal(retired.sqlRetired, true);
          assert.equal(retired.releasedBorrows, 1);
          assert.equal(outer.selectedBorrows, 1);
          assert.throws(() => f.state.assertCurrent(f.admission, f.session, call));
          assert.throws(() => f.binding.assignments.assertCurrent(f.assignment));
          const traceStart = f.traces.length;
          // Original caller native checks surround the new entered-source identity.
          f.native.assertCurrent(f.session, call);
          await f.binding.selection.prepareStateUse(f.selection, f.origin, call, {
            context,
            original: operation,
          });
          f.native.assertCurrent(f.session, call);
          prepared++;
          assert.throws(() => f.state.assertCurrent(f.admission, f.session, call));
          assert.throws(() => f.binding.assignments.assertCurrent(f.assignment));
          const during = f.traces.slice(traceStart);
          assert.equal(
            during.some((event) => event.event === "query" || event.event === "retain-source"),
            false,
            "entered-source recognition cannot reacquire SQL, native ownership or prepare a new handoff",
          );
          assert.equal(during.filter((event) => event.event === "native-current").length, 2);
          assert.equal(f.actualSelectorTransactions.length, 1);
          assert.equal(outer.selectedBorrows, 1);
        },
      },
      version,
    );
    try {
      const selected = await f.select(),
        admission = f.admission;
      await f.handoff();
      const result = await f.run();
      assert.equal(result.kind, "committed");
      assert.equal(prepared, 1);
      assert.equal(f.admission, admission);
      assert.equal(f.workSources[0].operation, selected.preparation);
      const outer = f.workTransactions[0];
      assertWorkPrefix(f, outer);
      assertSingleAdmission(f);
      const native = f.retainedSourceLeases.filter((lease) => lease.workId === outer.id);
      assert.equal(native.length, 1);
      assert.equal(native[0].prepares, 1);
      assert.equal(native[0].releaseCompletions, 1);
    } finally {
      await f.close();
    }
    assert.equal(f.openTransactions, 0);
    assert.equal(f.releases, 1);
  });

for (const version of [2, 3])
  test(`SOURCE-ENTRY V${version} genuine no-transfer context follows ordinary preparation then stops before policy`, async () => {
    const stopped = new Error("ordinary-no-transfer-preparation-probe-complete");
    let f,
      prepared = false;
    f = await fixture(
      {
        ordinarySourceEntry: true,
        async workAcquire({ context, operation, call }) {
          const selector = f.actualSelectorTransactions[0],
            outer = f.workTransactions.at(-1);
          assert.equal(selector.sqlRetired, false);
          assert.equal(outer.selectedBorrows, 0);
          f.native.assertCurrent(f.session, call);
          await f.binding.selection.prepareStateUse(f.selection, f.origin, call, {
            context,
            original: operation,
          });
          f.native.assertCurrent(f.session, call);
          prepared = true;
          assert.equal(selector.sqlRetired, true);
          assert.equal(selector.releasedBorrows, 1);
          assert.equal(
            outer.selectedBorrows,
            0,
            "this entry cannot consume a handoff registered after its early transfer check",
          );
          assert.throws(() => f.state.assertCurrent(f.admission, f.session, call));
          assert.throws(() => f.binding.assignments.assertCurrent(f.assignment));
          throw stopped;
        },
      },
      version,
    );
    try {
      await f.select(); // Deliberately no prior prepareStateUse/handoff.
      assert.equal((await f.run()).kind, "not-committed");
      assert.equal(prepared, true);
      const outer = f.workTransactions[0];
      assert.equal(outer.failure, stopped);
      assert.equal(outer.terminal, "ROLLBACK");
      assert.equal(outer.selectedBorrows, 0);
      const local = f.traces.filter((event) => event.kind === "work" && event.id === outer.id);
      assert.equal(
        local.some(
          (event) =>
            event.event === "query" ||
            event.event === "custody-acquire" ||
            event.event === "policy-stage" ||
            event.event === "body-enter",
        ),
        false,
      );
      assertSingleAdmission(f);
    } finally {
      await f.close();
    }
    assert.equal(f.openTransactions, 0);
    assert.equal(f.releases, 1);
  });

for (const operand of [
  "copied-context",
  "foreign-context",
  "copied-original",
  "foreign-original",
  "copied-call",
  "changed-call",
]) {
  test(`SOURCE-ENTRY refuses ${operand} before entered-source recognition can prepare or restore authority`, async () => {
    let f,
      denied = false,
      fakeCalls = 0;
    const fake = () => {
      fakeCalls++;
      throw new Error("foreign context method must not execute");
    };
    f = await fixture({
      async workAcquire({ context, operation, call }) {
        const candidateContext =
          operand === "copied-context"
            ? { ...context, assertActive: fake, retain: fake, joinAccepted: fake }
            : operand === "foreign-context"
              ? {
                  installationId: "foreign/installation",
                  assertActive: fake,
                  retain: fake,
                  joinAccepted: fake,
                }
              : context;
        const candidateOriginal =
          operand === "copied-original"
            ? { ...operation }
            : operand === "foreign-original"
              ? { ...operation, operationRef: "foreign/source-operation" }
              : operation;
        const candidateCall =
          operand === "copied-call"
            ? { ...call }
            : operand === "changed-call"
              ? { ...call, requestRef: "changed/source-call" }
              : call;
        await assert.rejects(
          f.binding.selection.prepareStateUse(f.selection, f.origin, candidateCall, {
            context: candidateContext,
            original: candidateOriginal,
          }),
        );
        denied = true;
        assert.equal(fakeCalls, 0);
        assert.throws(() => f.state.assertCurrent(f.admission, f.session, call));
        assert.equal(f.workTransactions.at(-1).selectedBorrows, 1);
        throw new Error("stop after denied original-source identity probe");
      },
    });
    try {
      await f.select();
      await f.handoff();
      assert.equal((await f.run()).kind, "not-committed");
      assert.equal(denied, true);
      const outer = f.workTransactions[0];
      assert.equal(outer.terminal, "ROLLBACK");
      assert.equal(outer.releasedBorrows, 1);
      assert.equal(
        f.traces.some(
          (event) => event.kind === "work" && event.id === outer.id && event.event === "body-enter",
        ),
        false,
      );
      assert.equal(fakeCalls, 0);
      assertSingleAdmission(f);
    } finally {
      await f.close();
    }
    assert.equal(f.openTransactions, 0);
    assert.equal(f.releases, 1);
  });
}

test("SOURCE-ENTRY original context and operation cannot invoke source preparation in the later policy phase", async () => {
  let f,
    sourceChecked = false,
    policyDenied = false;
  f = await fixture({
    async workAcquire({ context, operation, call }) {
      await f.binding.selection.prepareStateUse(f.selection, f.origin, call, {
        context,
        original: operation,
      });
      sourceChecked = true;
    },
    async policyStage({ context, operation, call }) {
      await assert.rejects(
        f.binding.selection.prepareStateUse(f.selection, f.origin, call, {
          context,
          original: operation,
        }),
      );
      policyDenied = true;
      throw new Error("stop after denied later-phase source preparation");
    },
  });
  try {
    await f.select();
    await f.handoff();
    assert.equal((await f.run()).kind, "not-committed");
    assert.equal(sourceChecked, true);
    assert.equal(policyDenied, true);
    const outer = f.workTransactions[0];
    const local = f.traces.filter((event) => event.kind === "work" && event.id === outer.id);
    assert.equal(
      local.filter((event) => event.event === "query" && workParentName(event.sql)).length,
      3,
    );
    assert.equal(local.filter((event) => event.event === "policy-stage").length, 1);
    assert.equal(
      local.some((event) => event.event === "body-enter"),
      false,
    );
    assert.equal(outer.releasedBorrows, 1);
    assertSingleAdmission(f);
  } finally {
    await f.close();
  }
  assert.equal(f.openTransactions, 0);
  assert.equal(f.releases, 1);
});

test("SOURCE-ENTRY a retired original Work context cannot regain its earlier transfer-source membership", async () => {
  let f, entered;
  f = await fixture({
    async workAcquire({ context, operation, call }) {
      entered = { context, original: operation };
      await f.binding.selection.prepareStateUse(f.selection, f.origin, call, entered);
    },
  });
  try {
    await f.select();
    await f.handoff();
    assert.equal((await f.run()).kind, "committed");
    const outer = f.workTransactions[0];
    assert.equal(outer.sqlRetired, true);
    assert.equal(outer.releasedBorrows, 1);
    const before = f.traces.length;
    await assert.rejects(
      f.binding.selection.prepareStateUse(f.selection, f.origin, f.call, entered),
    );
    assert.equal(
      f.traces.length,
      before,
      "stale original identity does not enter a source, SQL or second borrow",
    );
    assert.equal(f.workTransactions.length, 1);
    assertSingleAdmission(f);
  } finally {
    await f.close();
  }
  assert.equal(f.openTransactions, 0);
  assert.equal(f.releases, 1);
});

test("SOURCE-ENTRY an independent actual selector owner refuses another owner's genuine entered Work context", async () => {
  let first,
    second,
    refused = false;
  second = await fixture();
  first = await fixture({
    async workAcquire({ context, operation, call }) {
      // Both owners are actual core/selector/Work constructions. This proves
      // cross-owner registry refusal, not a same-registry marker cross-product.
      await assert.rejects(
        second.binding.selection.prepareStateUse(second.selection, second.origin, second.call, {
          context,
          original: operation,
        }),
      );
      refused = true;
      assert.throws(() => first.state.assertCurrent(first.admission, first.session, call));
      await first.binding.selection.prepareStateUse(first.selection, first.origin, call, {
        context,
        original: operation,
      });
    },
  });
  try {
    await second.select();
    await second.handoff();
    await first.select();
    await first.handoff();
    assert.equal((await first.run()).kind, "committed");
    assert.equal(refused, true);
    assert.equal(
      (await second.run()).kind,
      "not-committed",
      "caught cross-owner refusal poisons that selector",
    );
    assertWorkPrefix(first, first.workTransactions[0]);
    assert.equal(second.workTransactions[0].terminal, "ROLLBACK");
    assert.equal(
      second.traces.some((event) => event.kind === "work" && event.event === "body-enter"),
      false,
    );
    assertSingleAdmission(first);
    assertSingleAdmission(second);
  } finally {
    await first.close();
    await second.close();
  }
  assert.equal(first.openTransactions, 0);
  assert.equal(second.openTransactions, 0);
  assert.equal(first.releases, 1);
  assert.equal(second.releases, 1);
});

test("SOURCE-ENTRY a different original selector in the same registry cannot claim the entered transfer marker", async () => {
  let first,
    second,
    refused = false;
  first = await fixture({
    async workAcquire({ context, operation, call }) {
      assert.equal(first.registry, second.registry);
      assert.equal(first.workBinding, second.workBinding);
      assert.equal(first.call, second.call);
      // The original Work participant recognizes this context independently of
      // either selector. Registry and participant mismatch cannot explain denial.
      first.workBinding.participant.assertOriginal(context, operation, call);
      second.workBinding.participant.assertOriginal(context, operation, call);
      assert.notEqual(
        first.actualSelectorTransactions[0].backend,
        second.actualSelectorTransactions[0].backend,
      );
      const before = second.traces.length;
      await assert.rejects(
        second.binding.selection.prepareStateUse(second.selection, second.origin, call, {
          context,
          original: operation,
        }),
      );
      refused = true;
      assert.equal(
        second.traces.length,
        before,
        "foreign marker recognition cannot fall through to ordinary source preparation",
      );
      // The selected original retains its own marker and can finish this Work.
      await first.binding.selection.prepareStateUse(first.selection, first.origin, call, {
        context,
        original: operation,
      });
      assert.throws(() => first.state.assertCurrent(first.admission, first.session, call));
    },
  });
  second = await fixture({
    sharedRegistry: first.registry,
    sharedCall: first.call,
    sharedWorkBinding: first.workBinding,
  });
  try {
    await second.select();
    await second.handoff();
    await first.select();
    await first.handoff();
    assert.equal((await first.run()).kind, "committed");
    assert.equal(refused, true);
    assertWorkPrefix(first, first.workTransactions[0]);
    assert.equal(second.workTransactions.length, 0);
    assert.equal(second.actualSelectorTransactions.length, 1);
    assert.equal(second.actualSelectorTransactions[0].releasedBorrows, 1);
    assertSingleAdmission(first);
    assertSingleAdmission(second);
  } finally {
    await first.close();
    await second.close();
  }
  assert.equal(first.openTransactions, 0);
  assert.equal(second.openTransactions, 0);
  assert.equal(first.releases, 1);
  assert.equal(second.releases, 1);
});

for (const failure of ["operand-getter", "registry-identity"]) {
  test(`SOURCE-ENTRY caught ${failure} failure poisons later legitimate preparation and original Work joins cleanup`, async () => {
    let f,
      firstFailure,
      retried = false,
      getterCalls = 0;
    const getterFailure = new Error("entered-source-context-getter-refused");
    f = await fixture({
      async workAcquire({ context, operation, call }) {
        const entered =
          failure === "operand-getter"
            ? {
                get context() {
                  getterCalls++;
                  throw getterFailure;
                },
                original: operation,
              }
            : { context, original: { ...operation } };
        try {
          await f.binding.selection.prepareStateUse(f.selection, f.origin, call, entered);
        } catch (error) {
          firstFailure = error;
        }
        assert.ok(firstFailure, "the entered getter or registry predicate must refuse");
        if (failure === "operand-getter") assert.equal(firstFailure, getterFailure);
        // This is the same correct original context/operation accepted by the
        // positive source-entry control. Catching the first refusal cannot reset it.
        await assert.rejects(
          f.binding.selection.prepareStateUse(f.selection, f.origin, call, {
            context,
            original: operation,
          }),
          (error) => error === firstFailure,
        );
        retried = true;
        // Return normally: the original Work owner's retained selector lease must
        // propagate the poisoned state and own every acquired cleanup itself.
      },
    });
    try {
      await f.select();
      await f.handoff();
      assert.equal((await f.run()).kind, "not-committed");
      assert.equal(retried, true);
      assert.equal(getterCalls, failure === "operand-getter" ? 1 : 0);
      const outer = f.workTransactions[0];
      assert.equal(outer.failure, firstFailure);
      assert.equal(outer.terminal, "ROLLBACK");
      assert.equal(outer.selectedBorrows, 1);
      assert.equal(outer.releasedBorrows, 1);
      const local = f.traces.filter((event) => event.kind === "work" && event.id === outer.id);
      assert.equal(
        local.some((event) => event.event === "body-enter" || event.event === "policy-stage"),
        false,
      );
      assert.equal(
        local.some((event) => event.event === "query" && workParentName(event.sql)),
        false,
      );
      assert.equal(f.workSources.length, 1);
      assert.equal(f.workSources[0].releases, 1);
      const native = f.retainedSourceLeases.filter((lease) => lease.workId === outer.id);
      assert.equal(native.length, 1);
      assert.equal(native[0].prepares, 0);
      assert.equal(native[0].releaseCompletions, 1);
      assertSingleAdmission(f);
    } finally {
      await f.close();
    }
    assert.equal(f.openTransactions, 0);
    assert.equal(f.releases, 1);
  });
}
