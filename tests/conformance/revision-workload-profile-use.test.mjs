import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { ResourceConflictError, ScopeViolationError } from "../../packages/occ/src/errors.ts";
import { decodeWorkloadProfileUseV2 } from "../../packages/contracts/src/workload-profile-v1.ts";
import { workloadProfileAdmissionFixture } from "../fixtures/workload-profile-admission-v2.mjs";
import { exampleCredentialWorkloadSelectionV1 } from "../fixtures/credential-workload-selection-v1/producer.ts";
import {
  revisionResources,
  revisionRecord,
  seedRevisionOwner,
} from "./revision-repository.contract.mjs";

// Retained data fixtures exercise persistence, not accepting account/profile authority.
async function fixture() {
  const state = new InMemoryPlatformState();
  const resources = await seedRevisionOwner(state, revisionResources());
  const revision = revisionRecord(resources);
  const installation = await state.read((view) => view.installations.getInstallation());
  const credential = exampleCredentialWorkloadSelectionV1();
  const scope = {
    installationId: installation.id,
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
  };
  const replace = (value) => {
    if (value && typeof value === "object") {
      if (Object.hasOwn(value, "scope")) value.scope = { ...scope };
      for (const child of Object.values(value)) replace(child);
    }
  };
  replace(credential);
  credential.revisionId = revision.id;
  const admission = workloadProfileAdmissionFixture(scope);
  const { selection } = admission.head;
  const profileRefs = structuredClone(admission.head.profileRefs);
  credential.association.selection = structuredClone(selection);
  credential.association.profileRefs = structuredClone(profileRefs);
  const { admittedConfigurationDigest } = credential.association;
  // Explicit retained-data seeding, not the authenticated management entrypoint.
  state.snapshot.workloadProfileAdmissions.set(
    JSON.stringify([scope.installationId, selection.admissionRef]),
    admission.head,
  );
  const use = {
    schemaVersion: 2,
    installationId: installation.id,
    namespaceId: revision.namespaceId,
    component: "gateway-harness-pair",
    ...selection,
    canonicalFormat: "oce.workload-profile.canonical-json.v1",
    profileRefs,
    admittedConfigurationDigest,
  };
  assert.equal(decodeWorkloadProfileUseV2(use).kind, "valid");
  return {
    state,
    resources,
    revision: { ...revision, workloadProfileUse: use },
    credential,
    selection,
    scope,
    admission,
  };
}

test("first revision insertion retains public Use and the separate private credential", async () => {
  const f = await fixture();
  const expected = structuredClone(f.revision);
  const privateExpected = structuredClone(f.credential);
  let saved;
  await f.state.transact(async (unit) => {
    saved = unit.revisions.createRevision(f.revision, f.credential);
    f.revision.workloadProfileUse.profileRefs.provider.version = 99;
    f.credential.materialSelection.recordVersion = 99;
  });
  assert.deepEqual(await saved, expected);
  const retained = [...f.state.snapshot.revisions.values()].flat()[0];
  assert.deepEqual(retained.credential_workload_selection, privateExpected);
  assert.deepEqual(retained.workloadProfileUse, expected.workloadProfileUse);
  await f.state.transact(async (unit) => {
    await unit.agents.updateConfiguration(
      f.scope.namespaceId,
      f.scope.agentId,
      expected.configurationId,
      undefined,
      undefined,
      undefined,
      { ...f.selection, admissionVersion: 2 },
    );
    await unit.revisions.createRevision(revisionRecord(f.resources, 2));
  });
  await f.state.read(async (view) => {
    const rows = await view.revisions.listRevisions(f.scope.namespaceId, f.scope.agentId);
    assert.deepEqual(rows[0], expected);
    assert.equal(Object.hasOwn(rows[0], "credential_workload_selection"), false);
    assert.equal(Object.hasOwn(rows[1], "workloadProfileUse"), false);
    assert.ok(Object.isFrozen(rows[0].workloadProfileUse.profileRefs.provider));
  });
});

test("draft selection omission preserves the saved value and null cannot clear it", async () => {
  const f = await fixture();
  await f.state.transact(async (unit) => {
    await unit.agents.updateConfiguration(
      f.scope.namespaceId,
      f.scope.agentId,
      f.revision.configurationId,
      undefined,
      undefined,
      undefined,
      f.selection,
    );
    const after = await unit.agents.updateConfiguration(
      f.scope.namespaceId,
      f.scope.agentId,
      f.revision.configurationId,
    );
    assert.deepEqual(after.workloadProfileSelection, f.selection);
  });
  await assert.rejects(
    f.state.transact((unit) =>
      unit.agents.updateConfiguration(
        f.scope.namespaceId,
        f.scope.agentId,
        f.revision.configurationId,
        undefined,
        undefined,
        undefined,
        null,
      ),
    ),
    ScopeViolationError,
  );
  assert.deepEqual(
    (await f.state.read((view) => view.agents.findAgent(f.scope.namespaceId, f.scope.agentId)))
      .workloadProfileSelection,
    f.selection,
  );
});

for (const change of [
  "legacy-version",
  "foreign-installation",
  "foreign-namespace",
  "duplicate-role",
  "unknown-field",
]) {
  test(`revision insertion rejects ${change} Use without publishing a row`, async () => {
    const f = await fixture();
    const use = f.revision.workloadProfileUse;
    if (change === "legacy-version") use.schemaVersion = 1;
    if (change === "foreign-installation") use.installationId = `ins_${randomUUID()}`;
    if (change === "foreign-namespace") use.namespaceId = `ns_${randomUUID()}`;
    if (change === "duplicate-role") use.profileRefs.runtime.ref = use.profileRefs.provider.ref;
    if (change === "unknown-field") use.extra = true;
    await assert.rejects(
      f.state.transact((unit) => unit.revisions.createRevision(f.revision)),
      ScopeViolationError,
    );
    assert.deepEqual(
      await f.state.read((view) =>
        view.revisions.listRevisions(f.scope.namespaceId, f.scope.agentId),
      ),
      [],
    );
  });
}

test("rollback cannot publish Use and duplicate insertion cannot backfill historical absence", async () => {
  const f = await fixture();
  const stop = new Error("rollback");
  await assert.rejects(
    f.state.transact(async (unit) => {
      await unit.revisions.createRevision(f.revision);
      throw stop;
    }),
    (error) => error === stop,
  );
  const { workloadProfileUse, ...legacy } = f.revision;
  await f.state.transact((unit) => unit.revisions.createRevision(legacy));
  await assert.rejects(
    f.state.transact((unit) => unit.revisions.createRevision(f.revision)),
    ResourceConflictError,
  );
  const actual = await f.state.read((view) =>
    view.revisions.findRevision(f.scope.namespaceId, f.scope.agentId, legacy.id),
  );
  assert.equal(Object.hasOwn(actual, "workloadProfileUse"), false);
});

async function accept(f, altered = {}) {
  const command = {
    schemaVersion: 2,
    operationRef: randomUUID(),
    expectedLifecycleGeneration: null,
    revisionSource: "saved-draft",
    expectedDraft: {
      configurationId: f.revision.configurationId,
      configurationGeneration: f.revision.configurationGeneration,
      providerId: f.revision.providerId,
      executionMode: f.revision.harness.mode,
      serviceAccountId: f.revision.serviceAccount?.id ?? null,
      workloadProfileSelection: f.selection,
    },
  };
  const actorId = "principal/deploy-test",
    requestId = `req_${randomUUID()}`;
  await f.state.transact(async (unit) => {
    await unit.runtimeAdmissions.lockDeployCommand(f.scope, command.operationRef);
    assert.equal(
      await unit.runtimeAdmissions.findCommittedDeployCommand(f.scope, command, actorId),
      undefined,
    );
    await unit.revisions.createRevision(f.revision);
    const intent = await unit.runtimeAssignments.initializeRuntimeIntent(
      f.scope,
      f.revision.id,
      command.operationRef,
      { actorId, requestId },
    );
    const audit = {
      id: `aud_${randomUUID()}`,
      installationId: f.scope.installationId,
      namespaceId: f.scope.namespaceId,
      occurredAt: intent.createdAt,
      kind: "mutation",
      outcome: "success",
      action: "openclaw.agents.deploy",
      actorId,
      requestId,
      resource: { kind: "agent_revision", id: f.revision.id, namespaceId: f.scope.namespaceId },
    };
    await unit.audit.append(audit);
    await unit.runtimeAdmissions.recordAdmission(
      {
        namespaceId: f.scope.namespaceId,
        agentId: f.scope.agentId,
        revisionId: f.revision.id,
        runtimeTransitionRef: command.operationRef,
        lifecycleGeneration: intent.generation,
        auditEventId: audit.id,
      },
      { command: { ...command, ...altered }, actorId },
    );
    await unit.operations.append({
      kind: "agent_revision",
      action: "reconcile",
      namespaceId: f.scope.namespaceId,
      resourceId: f.revision.id,
      actorId,
      runtimeTransitionRef: command.operationRef,
      lifecycleGeneration: intent.generation,
    });
  });
  return { command, actorId, requestId };
}

test("command replay retains original Use, request, work and audit after head/draft changes", async () => {
  const f = await fixture();
  const accepted = await accept(f);
  await f.state.transact(async (unit) => {
    await unit.agents.updateConfiguration(
      f.scope.namespaceId,
      f.scope.agentId,
      f.revision.configurationId,
      undefined,
      undefined,
      undefined,
      { ...f.selection, admissionVersion: 2 },
    );
    await unit.runtimeAssignments.advanceRuntimeIntent(
      f.scope,
      1,
      { desiredMode: "stopped", revisionId: f.revision.id },
      randomUUID(),
      { actorId: accepted.actorId, requestId: `req_${randomUUID()}` },
    );
  });
  const before = await f.state.read(async (view) => ({
    audit: await view.audit.list(),
    work: await view.operations.list(),
  }));
  await f.state.transact(async (unit) => {
    await unit.runtimeAdmissions.lockDeployCommand(f.scope, accepted.command.operationRef);
    assert.deepEqual(
      await unit.runtimeAdmissions.findCommittedDeployCommand(
        f.scope,
        accepted.command,
        accepted.actorId,
      ),
      f.revision,
    );
    assert.equal(
      (await unit.runtimeAssignments.findRuntimeIntent(f.scope, accepted.command.operationRef))
        .requestId,
      accepted.requestId,
    );
  });
  const after = await f.state.read(async (view) => ({
    audit: await view.audit.list(),
    work: await view.operations.list(),
  }));
  assert.deepEqual(after, before);
  for (const [scope, command, actor] of [
    [f.scope, accepted.command, "principal/other"],
    [f.scope, { ...accepted.command, expectedLifecycleGeneration: 2 }, accepted.actorId],
    [{ ...f.scope, agentId: `agt_${randomUUID()}` }, accepted.command, accepted.actorId],
  ])
    await assert.rejects(
      f.state.read((view) =>
        view.runtimeAdmissions.findCommittedDeployCommand(scope, command, actor),
      ),
      ResourceConflictError,
    );
});

test("a changed command cannot bind an already-created revision and intent", async () => {
  const f = await fixture();
  await assert.rejects(accept(f, { expectedLifecycleGeneration: 5 }), ScopeViolationError);
  assert.deepEqual(
    await f.state.read((view) =>
      view.revisions.listRevisions(f.scope.namespaceId, f.scope.agentId),
    ),
    [],
  );
  assert.deepEqual(await f.state.read((view) => view.audit.list()), []);
});

for (const change of ["missing", "version", "manifest", "roles"]) {
  test(`first insertion refuses a ${change} retained admission correspondence`, async () => {
    const f = await fixture();
    const key = JSON.stringify([f.scope.installationId, f.selection.admissionRef]);
    if (change === "missing") f.state.snapshot.workloadProfileAdmissions.delete(key);
    if (change === "version") f.revision.workloadProfileUse.admissionVersion = 2;
    if (change === "manifest")
      f.revision.workloadProfileUse.manifestDigest = `sha256:${"f".repeat(64)}`;
    if (change === "roles")
      f.revision.workloadProfileUse.profileRefs.runtime.contentDigest = `sha256:${"f".repeat(64)}`;
    await assert.rejects(
      f.state.transact((unit) => unit.revisions.createRevision(f.revision)),
      ScopeViolationError,
    );
    assert.deepEqual(
      await f.state.read((view) =>
        view.revisions.listRevisions(f.scope.namespaceId, f.scope.agentId),
      ),
      [],
    );
  });
}
