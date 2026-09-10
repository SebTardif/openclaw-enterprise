import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import {
  createWorkloadProfileCandidateBindingsSourceV2,
  createWorkloadProfileCandidateSourceV2,
  createWorkloadProfileCapabilityAggregatorV2,
  createWorkloadProfileUseResolverV2,
} from "../../packages/occ/src/workload-profiles/admitted-use.ts";
import { createAdmittedWorkloadProfileSelectorV2 } from "../../packages/occ/src/workload-profiles/selection.ts";
import { decodeWorkloadProfileUseV2 } from "../../packages/contracts/src/workload-profile-v1.ts";
import { deriveAdmittedConfigurationV1 } from "../../packages/occ/src/workload-profiles/admitted-configuration.ts";
import {
  workloadProfileAdmissionFixture,
  profileAcceptedAt,
} from "../fixtures/workload-profile-admission-v2.mjs";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";

// Composes actual Controller/Deployment normalization, private Central enrollment,
// active reader, CandidateSource, new bindings factory, full fixed aggregator,
// Use resolver, original selector/storage, first revision INSERT and replay.
// The actual Central records reader supplies its captured observations over
// scripted SQL. Account/Drivers/native/credential/storage/role/capability suppliers
// remain controlled; this does not qualify PostgreSQL locking, native support,
// credential issuance or provider execution.
// This selected command does not request the separate credential sidecar.
const copy = structuredClone;
const noop = async () => {};
function scenario(options = {}) {
  const profile = workloadProfileAdmissionFixture();
  const agentId = `agt_${randomUUID()}`,
    configurationId = `cfg_${randomUUID()}`,
    accountId = `sa_${randomUUID()}`;
  const actor = {
    id: profile.actor.principalRef,
    kind: "principal",
    issuer: "controlled",
    subject: "account",
  };
  const credential = { kind: "api_key", secretRef: { name: "model-source", key: "value" } };
  const accountRow = {
    id: accountId,
    namespace_id: profile.namespaceId,
    name: "controlled",
    credential,
  };
  const agentRow = {
    id: agentId,
    namespace_id: profile.namespaceId,
    name: "controlled-agent",
    configuration_id: configurationId,
    provider_id: null,
    execution_mode: "dedicated",
    service_principal_id: "controlled/service-principal",
    service_account_id: accountId,
    workload_profile_selection: profile.head.selection,
    created_at: profileAcceptedAt,
  };
  const configuration = {
    id: configurationId,
    namespaceId: profile.namespaceId,
    kind: "agent",
    generation: 1,
    createdAt: profileAcceptedAt,
    values: createHarnessConfiguration("codex", "gpt-test"),
  };
  const command = {
    schemaVersion: 2,
    operationRef: randomUUID(),
    expectedLifecycleGeneration: null,
    revisionSource: "saved-draft",
    expectedDraft: {
      configurationId,
      configurationGeneration: 1,
      providerId: null,
      executionMode: "dedicated",
      maximumExecutionMs: null,
      serviceAccountId: accountId,
      workloadProfileSelection: profile.head.selection,
    },
  };
  const input = { namespaceId: profile.namespaceId, agentId, command };
  const invocation = Object.freeze({ controlledInvocation: randomUUID() });
  const trace = [],
    sql = [],
    issued = [],
    transactions = [],
    observations = new WeakSet();
  let committed = {},
    replayOnly = false,
    revoked = false,
    originalProjection,
    selectedUnit;
  const response = (rows = [], command = "SELECT") => ({ rows, rowCount: rows.length, command });
  function connect() {
    // Native IAM uses separate read checkouts while the deployment client is
    // retained. These scripted rows track each checkout's writes; they do not
    // model PostgreSQL isolation, locking, or concurrent writer visibility.
    const transaction = { id: transactions.length, events: [] };
    transactions.push(transaction);
    let saved,
      active = false,
      released = false,
      readOnly = false;
    const record = (event) => {
      transaction.events.push({ name: event, position: trace.length });
      trace.push(event);
    };
    return {
      on() {},
      removeListener() {},
      release() {
        assert.equal(released, false, "a checkout must release exactly once");
        assert.equal(active, false, "the checkout must settle its transaction before release");
        released = true;
        record("release-client");
      },
      async query(statement, parameters = []) {
        assert.equal(released, false, "a released checkout cannot issue SQL");
        sql.push({ transactionId: transaction.id, statement, parameters: copy(parameters) });
        if (statement.startsWith("BEGIN")) {
          assert.equal(active, false, "each transaction needs its own checkout");
          active = true;
          readOnly = statement.includes("READ ONLY");
          saved = copy(committed);
          record("BEGIN");
          return response();
        }
        assert.equal(active, true, "SQL must use its own active transaction");
        if (statement === "COMMIT") {
          if (!readOnly) committed = copy(saved);
          active = false;
          record("COMMIT");
          return response([], "COMMIT");
        }
        if (statement === "ROLLBACK") {
          active = false;
          record("ROLLBACK");
          return response([], "ROLLBACK");
        }
        if (statement.startsWith("INSERT"))
          assert.equal(readOnly, false, "IAM read checkouts cannot publish mutation rows");
        if (statement.startsWith("SET ") || statement.startsWith("SELECT set_config"))
          return response();
        if (statement.includes("FROM occ.installation "))
          return response([
            { id: profile.installationId, name: "Controlled", created_at: profileAcceptedAt },
          ]);
        if (statement.includes("lock_workload_profile_iam")) {
          trace.push("policy");
          return response();
        }
        if (statement.includes("FROM occ.iam_identities ")) return response([actor]);
        if (statement.includes("FROM occ.iam_roles "))
          return response([
            {
              id: "controlled-role",
              permissions: ["agent", "configuration", "service_account", "secret"].flatMap(
                (resourceKind) =>
                  ["read", "deploy", "operate"].map((action) => ({ action, resourceKind })),
              ),
            },
          ]);
        if (statement.includes("FROM occ.iam_access_bindings "))
          return response([
            { id: "binding", identity_subject_id: actor.id, role_id: "controlled-role" },
          ]);
        if (statement.includes("FROM occ.iam_")) return response();
        if (statement.includes("lifecycle-deploy-command:")) {
          record("command-lock");
          return response();
        }
        if (statement.includes("SELECT intent.actor_id AS intent_actor_id")) {
          trace.push("replay-lookup");
          return response(
            saved.admission
              ? [
                  {
                    intent_actor_id: saved.intent.actor_id,
                    request_id: saved.intent.request_id,
                    deploy_actor_id: saved.admission.deploy_actor_id,
                    deploy_command: saved.admission.deploy_command,
                    deploy_canonical: saved.admission.deploy_canonical,
                  },
                ]
              : [],
          );
        }
        if (statement.includes("SELECT to_jsonb(intent) AS intent")) {
          assert.ok(
            saved.work && saved.audit && saved.admission,
            "replay needs actual stored work/audit/admission",
          );
          return response([{ intent: saved.intent, revision: saved.revision, audit: saved.audit }]);
        }
        if (statement.includes("FROM occ.namespaces")) {
          trace.push(statement.includes("FOR UPDATE") ? "lock-namespace" : "namespace");
          return response([
            {
              id: profile.namespaceId,
              name: "controlled",
              status: "ready",
              created_at: profileAcceptedAt,
            },
          ]);
        }
        if (statement.includes("FROM occ.agents")) {
          if (replayOnly && statement.includes("FOR UPDATE"))
            assert.fail("replay locked today's draft");
          trace.push(statement.includes("FOR UPDATE") ? "lock-agent" : "agent");
          return response([agentRow]);
        }
        if (statement.includes("FROM occ.service_accounts")) {
          assert.equal(replayOnly, false);
          trace.push("lock-account");
          return response([accountRow]);
        }
        if (statement.includes("FROM occ.configurations")) {
          assert.equal(replayOnly, false);
          trace.push("lock-configuration");
          return response([
            {
              id: configurationId,
              namespace_id: profile.namespaceId,
              kind: "agent",
              generation: 1,
              created_at: profileAcceptedAt,
              secret_bindings: null,
            },
          ]);
        }
        if (statement.includes("FROM occ.agent_runtime_intents"))
          return response(saved.intent ? [saved.intent] : []);
        if (statement.includes("pg_advisory_xact_lock_shared")) {
          assert.equal(replayOnly, false);
          trace.push("head-gate");
          return response();
        }
        if (statement.includes("SELECT admission_ref FROM occ.workload_profile_admissions")) {
          assert.equal(replayOnly, false);
          trace.push("head-share");
          return response([{ admission_ref: profile.head.selection.admissionRef }]);
        }
        if (statement.includes("SELECT record FROM occ.workload_profile_admissions"))
          return response([{ record: profile.head }]);
        if (statement.includes("INSERT INTO occ.agent_revisions")) {
          assert.equal(saved.revision, undefined, "exactly one initial revision insert");
          record("INSERT-revision");
          saved.revision = {
            id: parameters[0],
            namespace_id: parameters[1],
            agent_id: parameters[2],
            revision_number: parameters[3],
            provider_id: parameters[4],
            admitted_spec: JSON.parse(parameters[5]),
            admitted_at: parameters[6],
            service_principal_id: agentRow.service_principal_id,
          };
          assert.equal(
            decodeWorkloadProfileUseV2(saved.revision.admitted_spec.workload_profile_use).kind,
            "valid",
            "the FIRST insert must carry actual prepared Use",
          );
          return response([], "INSERT");
        }
        if (statement.includes("FROM occ.agent_revisions")) {
          if (statement.includes("FOR SHARE")) {
            record("selector-own-row");
            assert.ok(saved.revision);
            if (options.corruptInsert) {
              const changed = copy(saved.revision);
              changed.admitted_spec.workload_profile_use.admittedConfigurationDigest = "f".repeat(
                64,
              );
              return response([changed]);
            }
          }
          return response(saved.revision ? [saved.revision] : []);
        }
        if (statement.includes("INSERT INTO occ.agent_runtime_intents")) {
          record("INSERT-intent");
          saved.intent = {
            transition_ref: parameters[0],
            installation_id: parameters[1],
            namespace_id: parameters[2],
            agent_id: parameters[3],
            generation: parameters[4],
            desired_mode: parameters[5],
            revision_id: parameters[6],
            actor_id: parameters[7],
            request_id: parameters[8],
            created_at: profileAcceptedAt,
          };
          return response([saved.intent], "INSERT");
        }
        if (statement.includes("INSERT INTO occ.agent_runtime_intent_heads")) {
          record("INSERT-intent-head");
          return response([], "INSERT");
        }
        if (statement.includes("INSERT INTO occ.audit_events")) {
          record("INSERT-audit");
          saved.audit = {
            id: parameters[0],
            occurred_at: parameters[1],
            kind: parameters[2],
            actor_id: parameters[3],
            action: parameters[4],
            namespace_id: parameters[5],
            resource_kind: parameters[6],
            resource_id: parameters[7],
            outcome: parameters[8],
            details: parameters[9] === null ? null : JSON.parse(parameters[9]),
          };
          return response([], "INSERT");
        }
        if (statement.includes("INSERT INTO occ.agent_revision_runtime_admissions")) {
          record("INSERT-admission");
          saved.admission = {
            namespace_id: parameters[0],
            agent_id: parameters[1],
            revision_id: parameters[2],
            runtime_transition_ref: parameters[3],
            lifecycle_generation: parameters[4],
            audit_event_id: parameters[5],
            deploy_actor_id: parameters[6],
            deploy_command: JSON.parse(parameters[7]),
            deploy_canonical: parameters[8],
          };
          return response([], "INSERT");
        }
        if (statement.includes("INSERT INTO occ.controller_work")) {
          record("INSERT-work");
          saved.work = {
            idempotency_key: parameters[0],
            namespace_id: parameters[1],
            agent_id: parameters[2],
            revision_id: parameters[3],
            actor_id: parameters[4],
            namespace_target: parameters[5],
            runtime_transition_ref: parameters[7],
            lifecycle_generation: parameters[8],
            work_schema_version: 0,
            state: "queued",
            available_at: profileAcceptedAt,
            attempt_count: 0,
            claim_token: null,
            lease_expires_at: null,
            completed_at: null,
            created_at: profileAcceptedAt,
            updated_at: profileAcceptedAt,
          };
          return response([saved.work], "INSERT");
        }
        throw new Error(`Unexpected controlled SQL: ${statement}`);
      },
    };
  }
  const state = new PostgresPlatformState({
    options: { connectionTimeoutMillis: 100 },
    async connect() {
      return connect();
    },
    async end() {},
  });
  function lease(name, borrowed) {
    let released = false;
    const value = {
      assertCurrent() {
        assert.equal(released, false, `${name} closed`);
        if (revoked) throw new Error("controlled-source-revoked");
        borrowed?.assertCurrent();
      },
      async release() {
        assert.equal(released, false, `${name} twice`);
        released = true;
        trace.push(`release:${name}`);
      },
    };
    issued.push({ name, value, released: () => released });
    return value;
  }
  const account = {
    async consume(original, retained, unit) {
      assert.strictEqual(original, invocation);
      assert.equal(retained.purpose, "workload-profile-deployment");
      trace.push("account");
      unit.retainSecurityCleanup(() => {
        trace.push("release-security");
      });
      return {
        principal: actor,
        accountRef: profile.actor.accountRef,
        requestId: "controlled/request",
        admissionDecisionId: "controlled/decision",
        assertCurrent() {},
        release() {
          trace.push("release-account");
        },
      };
    },
  };
  const controller = new OpenClawController(
    { id: profile.installationId, name: "Controlled", createdAt: profileAcceptedAt },
    {
      state,
      loggingLevel: "info",
      workloadProfiles: {
        invocations: { forCurrentInvocation: () => invocation },
        create(context) {
          assert.strictEqual(context.state, state);
          const owner = state.workloadProfileMutationEnrollmentV2(context.selection, account);
          const captured = state.workloadProfileCandidateContextV2(
            context.selection,
            context.candidateNormalizer,
            context.candidateOperations,
          );
          const records = {
            async readLocked(request, candidate, unit, io) {
              assert.equal(replayOnly, false);
              trace.push("records");
              selectedUnit = unit;
              const before = sql.length;
              const original = await captured.records.readLocked(request, candidate, unit, io);
              try {
                assert.equal(
                  sql.length,
                  before,
                  "captured record observation must not relock parents after head",
                );
                observations.add(original.sourceIdentity);
                // Forward the original lease unchanged; the factory owns it from here.
                return original;
              } catch (error) {
                // A failed observation still belongs to this wrapper until handoff.
                try {
                  io.poison(error);
                } catch {}
                try {
                  await original.release();
                } catch {}
                throw error;
              }
            },
          };
          function qualify(name, output) {
            return async (value, original, unit, io) => {
              assert.equal(replayOnly, false);
              assert.equal(observations.has(original.sourceIdentity), true);
              assert.strictEqual(unit, selectedUnit);
              io.assertActive();
              original.assertCurrent();
              trace.push(`qualify:${name}`);
              if (options.refuse === name) throw new Error(`controlled-${name}-refusal`);
              return { ...lease(`qualifier:${name}`, original), ...output(value) };
            };
          }
          const qualifiers = {
            native: { qualifyLocked: qualify("native", () => ({})) },
            credentials: {
              resolveLocked: qualify("credentials", (value) => ({
                association: {
                  servicePrincipalId: agentRow.service_principal_id,
                  serviceAccount: { id: accountRow.id, credential: copy(accountRow.credential) },
                },
              })),
            },
            storage: {
              resolveLocked: qualify("storage", (value) => ({
                bindings: ["gateway", "harness"].flatMap((component) =>
                  value.manifest.launchConfiguration[component].mounts.map((mount) => ({
                    component,
                    ...mount,
                  })),
                ),
              })),
            },
            roles: {
              resolveLocked: qualify("roles", () => ({ bindings: profile.head.profileRefs })),
            },
          };
          if (options.missing) delete qualifiers[options.missing];
          const bindings = createWorkloadProfileCandidateBindingsSourceV2(records, qualifiers);
          const candidateSource = createWorkloadProfileCandidateSourceV2(
            captured.contexts,
            bindings,
          );
          function contribution(name) {
            return {
              async acquire(request, manifest, use, unit, io) {
                assert.equal(replayOnly, false);
                assert.strictEqual(unit, selectedUnit);
                io.assertActive();
                trace.push(`capability:${name}`);
                assert.equal(request.configurationRef, configurationId);
                if (originalProjection)
                  assert.equal(
                    use.admittedConfigurationDigest,
                    deriveAdmittedConfigurationV1(originalProjection).admittedConfigurationDigest,
                  );
                return lease(`capability:${name}`);
              },
              async verifyDefinitionLocked() {
                assert.fail("no definition-admission phase in revision test");
              },
            };
          }
          const renderer = contribution("renderer");
          const capabilities = createWorkloadProfileCapabilityAggregatorV2({
            renderer: {
              verifyRevisionRendererLocked: renderer.acquire,
              verifyRendererDefinitionLocked: renderer.verifyDefinitionLocked,
            },
            runtime: contribution("runtime"),
            identity: contribution("identity"),
            credentials: contribution("credentials"),
            storage: contribution("storage"),
          });
          const selector = createAdmittedWorkloadProfileSelectorV2(
            state.workloadProfileSelectionStorageV2(),
            capabilities,
          );
          // Observes the actual CandidateSource result without replacing it or Use.
          const observedCandidate = {
            async resolveLocked(...args) {
              const result = await candidateSource.resolveLocked(...args);
              originalProjection = result.projection;
              return result;
            },
          };
          return {
            enrollment: owner.enrollment,
            candidates: captured.candidates,
            use: createWorkloadProfileUseResolverV2(
              owner.activeReader,
              observedCandidate,
              capabilities,
              selector,
            ),
          };
        },
      },
    },
  );
  const configDriver = {
    id: "controlled-config",
    capability: "configuration",
    implementation: "controlled-config-v1",
    create: noop,
    update: noop,
    delete: noop,
    async read() {
      assert.equal(replayOnly, false);
      trace.push("configuration-read");
      return copy(configuration);
    },
    async validate(document) {
      trace.push("configuration-validate");
      assert.equal(document.values.logging.level, "info");
    },
  };
  const compute = {
    id: "controlled-compute",
    capability: "compute",
    implementation: "controlled-compute-v1",
    ensureNamespace: noop,
    deleteNamespace: noop,
    prepareRevision: noop,
    retireRevision: noop,
  };
  for (const driver of [new NativeIAMDriver(state), configDriver, compute]) {
    controller.registerDriver(driver);
    controller.selectDriver(driver.capability, driver.id);
  }
  const admission = {
    transitionRef: command.operationRef,
    requestId: "controlled/request",
    createAuditEvent(revision) {
      if (options.revokeAtAudit) revoked = true;
      return {
        id: `aud_${randomUUID()}`,
        installationId: profile.installationId,
        namespaceId: profile.namespaceId,
        occurredAt: profileAcceptedAt,
        kind: "mutation",
        actorId: actor.id,
        requestId: "controlled/request",
        action: "openclaw.agents.deploy",
        resource: { kind: "agent_revision", id: revision.id, namespaceId: profile.namespaceId },
        outcome: "success",
      };
    },
  };
  const harness = () => {
    assert.equal(replayOnly, false);
    trace.push("harness");
    return { id: "codex", version: "controlled" };
  };
  return {
    trace,
    sql,
    issued,
    command,
    transactions,
    get saved() {
      return committed;
    },
    get projection() {
      return originalProjection;
    },
    run() {
      return controller.deployment.deployAgentCommand(actor.id, input, harness, admission);
    },
    replay() {
      replayOnly = true;
      return controller.deployment.deployAgentCommand(actor.id, input, harness, admission);
    },
  };
}

function allReleased(f) {
  assert.equal(
    f.issued.every((x) => x.released()),
    true,
    "all returned controlled leases must close",
  );
}
function deploymentTransaction(f, after = 0) {
  const matches = f.transactions.filter((transaction) =>
    transaction.events.some((event) => event.name === "command-lock" && event.position >= after),
  );
  assert.equal(matches.length, 1, "one original command-lock transaction per invocation");
  return matches[0];
}
function position(transaction, name) {
  const matches = transaction.events.filter((event) => event.name === name);
  assert.equal(matches.length, 1, `one ${name} event on the selected transaction`);
  return matches[0].position;
}
function rolledBack(transaction) {
  assert.equal(
    transaction.events.some((event) => event.name === "COMMIT"),
    false,
  );
  assert.ok(position(transaction, "ROLLBACK") < position(transaction, "release-client"));
}
test("composed real writer stores original prepared Use once, verifies same row, then replays without active sources", async () => {
  const f = scenario();
  const receipt = await f.run();
  const deployment = deploymentTransaction(f);
  const decoded = decodeWorkloadProfileUseV2(f.saved.revision.admitted_spec.workload_profile_use);
  assert.equal(decoded.kind, "valid");
  assert.equal(
    decoded.value.admittedConfigurationDigest,
    deriveAdmittedConfigurationV1(f.projection).admittedConfigurationDigest,
  );
  assert.ok(f.trace.indexOf("lock-configuration") < f.trace.indexOf("configuration-read"));
  assert.ok(f.trace.indexOf("configuration-validate") < f.trace.indexOf("head-share"));
  assert.ok(f.trace.indexOf("qualify:roles") < f.trace.indexOf("INSERT-revision"));
  assert.ok(f.trace.indexOf("INSERT-revision") < f.trace.indexOf("selector-own-row"));
  assert.ok(f.trace.indexOf("selector-own-row") < f.trace.indexOf("INSERT-intent"));
  assert.ok(position(deployment, "INSERT-work") < position(deployment, "COMMIT"));
  assert.ok(position(deployment, "COMMIT") < position(deployment, "release-client"));
  assert.ok(
    position(deployment, "release-client") <
      f.trace.findIndex((x) => x.startsWith("release:qualifier:")),
  );
  assert.equal(
    f.trace.filter((x) => x.startsWith("capability:")).length,
    10,
    "full contributors acquired before insert and on actual selected own-row read",
  );
  assert.equal(f.saved.admission.revision_id, f.saved.revision.id);
  assert.equal(f.saved.work.revision_id, f.saved.revision.id);
  assert.equal(f.saved.work.runtime_transition_ref, f.command.operationRef);
  allReleased(f);
  const before = f.trace.length;
  const replay = await f.replay();
  assert.deepEqual(replay, receipt);
  const replayTransaction = deploymentTransaction(f, before);
  assert.ok(position(replayTransaction, "COMMIT") < position(replayTransaction, "release-client"));
  assert.equal(
    f.trace
      .slice(before)
      .some(
        (x) =>
          x.startsWith("qualify:") ||
          x.startsWith("capability:") ||
          x === "records" ||
          x === "head-share" ||
          x.startsWith("INSERT-"),
      ),
    false,
  );
  assert.equal(f.trace.filter((x) => x === "INSERT-revision").length, 1);
  allReleased(f);
});
for (const missing of ["native", "credentials", "storage", "roles"])
  test(`composed writer refuses missing ${missing} before INSERT`, async () => {
    const f = scenario({ missing });
    await assert.rejects(f.run());
    assert.equal(f.trace.includes("records"), false);
    assert.equal(f.trace.includes("INSERT-revision"), false);
    rolledBack(deploymentTransaction(f));
    assert.deepEqual(f.saved, {});
    allReleased(f);
  });
test("composed qualifier refusal rolls back and joins prior supplier cleanup", async () => {
  const f = scenario({ refuse: "storage" });
  await assert.rejects(f.run(), /controlled-storage-refusal/);
  assert.equal(f.trace.includes("INSERT-revision"), false);
  assert.equal(f.trace.includes("qualify:roles"), false);
  rolledBack(deploymentTransaction(f));
  assert.deepEqual(f.saved, {});
  allReleased(f);
});
test("actual selector refuses changed own INSERT Use and prevents intent/work commit", async () => {
  const f = scenario({ corruptInsert: true });
  await assert.rejects(f.run());
  assert.ok(f.trace.includes("INSERT-revision"));
  assert.ok(f.trace.includes("selector-own-row"));
  assert.equal(f.trace.includes("INSERT-intent"), false);
  rolledBack(deploymentTransaction(f));
  assert.deepEqual(f.saved, {});
  allReleased(f);
});
test("retained qualifier revocation after own-row verification prevents later commit and drains leases", async () => {
  const f = scenario({ revokeAtAudit: true });
  await assert.rejects(f.run(), /controlled-source-revoked/);
  assert.ok(f.trace.includes("selector-own-row"));
  rolledBack(deploymentTransaction(f));
  assert.deepEqual(f.saved, {});
  allReleased(f);
});
