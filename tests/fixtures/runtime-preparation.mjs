import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  canonicalRuntimeAuthorityMutationV1,
  canonicalRuntimeEffectRequestV1,
  parseRuntimeEffectsV1,
} from "@openclaw-enterprise/contracts";
import {
  exactRuntimeAuthorityOperation,
  runtimeAllocationTarget,
} from "../../packages/occ/src/runtime-authority/repository.ts";
import { prepareRuntimeBindingCandidate } from "../../packages/occ/src/runtime-authority/binding-candidate.ts";
import { RuntimeAuthorityService } from "../../packages/occ/src/runtime-authority/service.ts";
import {
  canonicalRuntimePreparation,
  runtimePreparationDigest,
} from "../../packages/occ/src/runtime-preparation/types.ts";
import { seedRuntimeOwner, profiles } from "../conformance/runtime-assignment-store.contract.mjs";
import { createRuntimeAdmissionContext } from "./runtime-admission-context.mjs";
import { bindingCandidateFixture } from "./runtime-binding-candidate.mjs";
import { writer as authorityWriter } from "./runtime-authority-state/seed.mjs";
import { retireRequest } from "./runtime-authority-v1/vectors.mjs";
import { noWriterRef } from "./runtime-effects-v1/vectors.mjs";

export const copy = (value) => structuredClone(value);
export const preparationWriter = Object.freeze({
  writerRef: "test/runtime-preparation",
  recordedAt: "2026-09-06T00:00:00.000Z",
});

export function rebuildPreparationChild(child, providerWireUtf8) {
  const value = copy(child);
  const request = value.request;
  request.effect.requestDigest = runtimePreparationDigest(canonicalRuntimeEffectRequestV1(request));
  const canonicalRequestJson = canonicalRuntimeEffectRequestV1(request);
  return {
    ...value,
    effect: request.effect,
    guard: request.gate,
    providerTarget: request.providerTarget,
    predicate: request.predicate,
    canonicalRequestJson,
    requestBytesDigest: runtimePreparationDigest(canonicalRequestJson),
    providerWire: {
      ...value.providerWire,
      bytesDigest: runtimePreparationDigest(providerWireUtf8),
      byteLength: Buffer.byteLength(providerWireUtf8, "utf8"),
    },
  };
}

export function preparationChildAtLogicalLimit(fixture, bytes) {
  const template = copy(fixture.child.child);
  const request = template.request;
  const original = request.plan.targets.find(
    (entry) => entry.target.targetRef === request.providerTarget.targetRef,
  );
  request.plan.targets = Array.from({ length: 32 }, (_, index) => ({
    ...copy(original),
    target: {
      ...copy(original.target),
      targetRef: `t${String(index).padStart(2, "0")}${"x".repeat(37)}`,
      name: `deployment-${index}`,
      clusterRef: "c".repeat(200),
      kubernetesNamespaceUid: "n".repeat(200),
    },
  }));
  request.providerTarget = request.plan.targets[0].target;
  request.plan.producerDomains = Array.from({ length: 16 }, (_, index) => ({
    domainRef: `domain-${index}`,
    kind: index === 0 ? "node-start-restart" : "deployment-descendants",
    targetRefs: request.plan.targets.map((entry) => entry.target.targetRef),
    requiredProducerRef: "p".repeat(200),
    requiredCapabilityRef: "c".repeat(200),
  }));
  let remaining = bytes - Buffer.byteLength(canonicalRuntimeEffectRequestV1(request), "utf8");
  assert.ok(remaining >= 0);
  // The payload uses real bounded plan fields; no unknown padding field or raw
  // credential is introduced. The selected provider target remains unchanged.
  for (const entry of request.plan.targets.slice(1)) {
    const add = Math.min(remaining, 253 - entry.target.name.length);
    entry.target.name += "x".repeat(add);
    remaining -= add;
  }
  assert.equal(remaining, 0);
  const child = rebuildPreparationChild(template, fixture.providerWireUtf8);
  assert.equal(Buffer.byteLength(child.canonicalRequestJson, "utf8"), bytes);
  return child;
}

export function writablePreparationPlan(fixture) {
  const plan = copy(fixture.plan);
  const priorWriterEvidence = noWriterRef();
  priorWriterEvidence.reservation.scope = fixture.scope;
  priorWriterEvidence.workspaceStore.scope = fixture.scope;
  priorWriterEvidence.stores = [copy(priorWriterEvidence.workspaceStore)];
  priorWriterEvidence.closedPlanDigest = plan.plan.planDigest;
  priorWriterEvidence.admittedChildCutoff = plan.guard.admittedChildCutoff;
  plan.preparation = {
    kind: "writable",
    preparationRef: plan.preparationRef,
    preparationVersion: 1,
    admittedProfileDigest: plan.preparation.admittedProfileDigest,
    priorWriterEvidence,
  };
  return plan;
}

// Actual store ownership, immutable revision, admission audit and original work are
// committed through the supported repositories. Synthetic profile/Compute values
// below are representation inputs only and never establish current authority.
export async function seedPreparation(store, { admitted = true } = {}) {
  const owner = await seedRuntimeOwner(store);
  const actorId = "test/runtime-preparation-owner";
  const admission = createRuntimeAdmissionContext(owner.installation.id, actorId);
  const attribution = { actorId, requestId: admission.requestId };
  const work = {
    kind: "agent_revision",
    action: "reconcile",
    namespaceId: owner.namespace.id,
    resourceId: owner.revision.id,
    actorId,
    runtimeTransitionRef: admission.transitionRef,
    lifecycleGeneration: 1,
  };
  const { intent, allocation } = await store.transact(async (unit) => {
    const intent = await unit.runtimeAssignments.initializeRuntimeIntent(
      owner.scope,
      owner.revision.id,
      admission.transitionRef,
      attribution,
    );
    if (admitted) {
      const audit = admission.createAuditEvent(owner.revision);
      await unit.audit.append(audit);
      await unit.runtimeAdmissions.recordAdmission({
        ...owner.scope,
        revisionId: owner.revision.id,
        runtimeTransitionRef: intent.transitionRef,
        lifecycleGeneration: intent.generation,
        auditEventId: audit.id,
      });
      await unit.operations.append(work);
    }
    const allocation = await unit.runtimeAssignments.allocateUnboundRuntime(
      owner.scope,
      1,
      "harness",
      0,
      randomUUID(),
      profiles,
    );
    return { intent, allocation };
  });
  const committed = await store.read((unit) =>
    unit.runtimeAdmissions.findCommittedAdmission(owner.scope, intent.transitionRef, attribution),
  );
  assert.deepEqual(committed, admitted ? owner.revision : undefined);
  const target = runtimeAllocationTarget(allocation);
  const scope = {
    installationId: target.installationId,
    namespaceId: target.namespaceId,
    agentId: target.agentId,
  };
  const representation = bindingCandidateFixture();
  const template = copy(representation.options.child);
  const request = template.request;
  const preparationRef = randomUUID();
  request.preparation.preparationRef = preparationRef;
  request.effect.effectRef = randomUUID();
  request.effect.target = target;
  request.gate.scope = scope;
  request.gate.intentRef = intent.transitionRef;
  request.gate.lifecycleGeneration = intent.generation;
  request.gate.admittedChildCutoff = 0;
  request.gate.responsibility.responsibilityRef = randomUUID();
  request.effect.responsibility = request.gate.responsibility;
  request.plan.scope = scope;
  for (const entry of request.plan.targets) {
    entry.target.ownerAssignmentRef = target.assignmentRef;
    entry.target.ownerCreateEffectRef = target.createEffectRef;
  }
  request.providerTarget.ownerAssignmentRef = target.assignmentRef;
  request.providerTarget.ownerCreateEffectRef = target.createEffectRef;
  request.predicate.ownerAssignmentRef = target.assignmentRef;
  request.predicate.ownerCreateEffectRef = target.createEffectRef;
  request.predicate.resourceVersion = "opaque.000009/etag";
  request.admittedRuntime.runtimeProfileRef = allocation.runtimeProfileRef;
  const providerWireUtf8 = '{"kind":"retained-test-wire","payload":"λ"}';
  const child = rebuildPreparationChild(template, providerWireUtf8);
  parseRuntimeEffectsV1("preparedChild", child);
  const currentIntent = {
    intentRef: intent.transitionRef,
    mode: intent.desiredMode,
    lifecycleGeneration: intent.generation,
  };
  const common = {
    schemaVersion: 1,
    preparationRef,
    target,
    currentIntent,
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
  const retainChild = {
    ...common,
    kind: "retain-child",
    operationRef: randomUUID(),
    expectedVersion: 1,
    child,
    providerWireUtf8,
  };
  const close = {
    ...common,
    kind: "close",
    operationRef: randomUUID(),
    expectedVersion: 2,
    reason: "closed",
  };
  const append = (input, writer = preparationWriter) =>
    store.transact((unit) => unit.runtimePreparation.retain(input, writer));
  const record = () =>
    store.read((unit) => unit.runtimePreparation.findPreparation(scope, preparationRef));
  const operation = (ref) =>
    store.read((unit) => unit.runtimePreparation.findOperation(scope, ref));
  const history = () =>
    store.read((unit) => unit.runtimePreparation.listHistory(scope, preparationRef));
  const assignment = () =>
    store.read((unit) => unit.runtimeAuthority.findAssignment(scope, allocation.assignmentRef));
  const head = () => store.read((unit) => unit.runtimeAssignments.findRuntimeIntentHead(scope));
  const advance = (mode = "stopped") =>
    store.transact((unit) =>
      unit.runtimeAssignments.advanceRuntimeIntent(
        owner.scope,
        1,
        { desiredMode: mode, revisionId: owner.revision.id },
        randomUUID(),
        attribution,
      ),
    );
  const nextPlan = (expectedVersion = 2) => {
    const next = copy(plan.plan);
    next.planVersion += 1;
    next.planDigest = runtimePreparationDigest("test/superseded-plan");
    return {
      ...common,
      kind: "supersede-plan",
      operationRef: randomUUID(),
      expectedVersion,
      preparation: plan.preparation,
      plan: next,
      nextGuard: {
        ...common.guard,
        gateVersion: common.guard.gateVersion + 1,
        requestedFenceEpoch: common.guard.requestedFenceEpoch + 1,
        responsibility: { ...common.guard.responsibility, responsibilityVersion: 2 },
        planVersion: next.planVersion,
        planDigest: next.planDigest,
      },
    };
  };
  const candidate = async () => {
    representation.options.assignment = await assignment();
    representation.options.child = child;
    representation.options.guard = child.guard;
    representation.options.operation.operationRef = randomUUID();
    Object.assign(representation.responses.state, {
      guard: child.guard,
      plan: child.request.plan,
      children: [child],
    });
    const object = {
      ...representation.responses.observation.object,
      target: child.providerTarget,
      uid: child.predicate.uid,
    };
    // Retarget the original fixture's synthetic discovery result. This is still a
    // representation-only Compute port; the production helper and repository are real.
    const discover = representation.options.effects.discover;
    representation.options.effects.discover = async (...args) => ({
      ...(await discover(...args)),
      object: copy(object),
    });
    representation.responses.observation.object = copy(object);
    for (const profile of Object.values(representation.responses.observation.profile))
      profile.profileRef = allocation.runtimeProfileRef;
    const proposal = await prepareRuntimeBindingCandidate(representation.options);
    const operation = exactRuntimeAuthorityOperation(proposal);
    return {
      ...common,
      kind: "retain-binding",
      operationRef: randomUUID(),
      expectedVersion: 2,
      proposal,
      operation,
    };
  };
  return {
    ...owner,
    store,
    intent,
    allocation,
    target,
    scope,
    attribution,
    admission,
    work,
    plan,
    child: retainChild,
    close,
    providerWireUtf8,
    representation,
    append,
    record,
    operation,
    history,
    assignment,
    head,
    advance,
    nextPlan,
    candidate,
  };
}

export async function verifyRuntimePreparation(t, store) {
  await t.test(
    "real admitted ownership retains a complete plan before exact child bytes",
    async () => {
      const f = await seedPreparation(store);
      assert.equal(await f.record(), undefined);
      await assert.rejects(f.append(f.child));
      assert.equal(await f.operation(f.child.operationRef), undefined);
      await assert.rejects(
        f.append(f.plan, {
          ...preparationWriter,
          recordedAt: "+010000-01-01T00:00:00.000Z",
        }),
      );
      assert.equal(await f.record(), undefined);
      const savedPlan = await f.append(f.plan);
      assert.equal(savedPlan.status, "retained");
      assert.equal(savedPlan.operation.localVersion, 1);
      assert.equal(savedPlan.operation.retainedChildSequence, 0);
      const saved = await f.append(f.child);
      assert.equal(saved.operation.localVersion, 2);
      assert.equal(saved.operation.retainedChildSequence, 1);
      const record = await f.record();
      assert.equal(record.status, "retained");
      assert.equal(record.guard.admittedChildCutoff, 0);
      assert.deepEqual(record.plan, f.plan.plan);
      assert.deepEqual(record.children, [
        { sequence: 1, child: f.child.child, providerWireUtf8: f.providerWireUtf8 },
      ]);
      assert.equal(saved.operation.canonicalRequest, canonicalRuntimePreparation(f.child));
      assert.equal(
        saved.operation.requestDigest,
        runtimePreparationDigest(saved.operation.canonicalRequest),
      );
      assert.notEqual(f.plan.preparationRef, f.plan.guard.responsibility.responsibilityRef);
      assert.equal(record.children[0].child.predicate.resourceVersion, "opaque.000009/etag");
      for (const key of ["authority", "evidence", "receipt", "admission", "providerFence"])
        assert.equal(Object.hasOwn(record, key), false);
      assert.equal((await f.assignment()).authority.state, "allocated");
      assert.equal((await f.assignment()).binding.status, "unbound");
      const work = await store.read((unit) => unit.operations.list());
      assert.deepEqual(
        work.filter((item) => item.runtimeTransitionRef === f.intent.transitionRef),
        [f.work],
      );
    },
  );

  await t.test(
    "an allocation without its committed revision admission cannot retain a plan",
    async () => {
      const f = await seedPreparation(store, { admitted: false });
      await assert.rejects(f.append(f.plan));
      assert.equal(await f.record(), undefined);
    },
  );

  await t.test(
    "canonical bound or retired assignment history rejects new preparation and binding retention",
    async () => {
      // These writes exercise the existing internal authority repository. They do
      // not manufacture an authenticated service call or a positive live grant.
      for (const authorityState of ["bound", "retired"]) {
        const f = await seedPreparation(store);
        const binding = await f.candidate();
        const mutation =
          authorityState === "bound"
            ? binding.proposal
            : {
                ...retireRequest(),
                operationRef: randomUUID(),
                target: f.target,
                expectedLifecycleGeneration: 1,
                expectedAssignmentRecordVersion: 1,
                bindingVersion: null,
                responsibilityRef: randomUUID(),
              };
        await store.transact((unit) =>
          unit.runtimeAuthority.appendMutation(mutation, authorityWriter),
        );
        assert.equal((await f.assignment()).authority.state, authorityState);
        assert.equal(f.allocation.bindingCondition, "unbound");
        await assert.rejects(f.append(f.plan));
        assert.equal(await f.record(), undefined);
      }
      const f = await seedPreparation(store);
      await f.append(f.plan);
      await f.append(f.child);
      const binding = await f.candidate();
      await store.transact((unit) =>
        unit.runtimeAuthority.appendMutation(binding.proposal, authorityWriter),
      );
      await assert.rejects(f.append(binding));
      assert.equal((await f.record()).bindingProposals.length, 0);
      assert.equal((await f.record()).localVersion, 2);
      await store.transact((unit) =>
        unit.runtimeAuthority.appendMutation(
          {
            ...retireRequest(),
            operationRef: randomUUID(),
            target: f.target,
            expectedLifecycleGeneration: 1,
            expectedAssignmentRecordVersion: 2,
            bindingVersion: 1,
            responsibilityRef: randomUUID(),
          },
          authorityWriter,
        ),
      );
      assert.equal((await f.assignment()).authority.state, "retired");
      await assert.rejects(f.append(binding));
      assert.equal((await f.record()).bindingProposals.length, 0);
    },
  );

  await t.test("every current intent and local guard dimension compares atomically", async () => {
    const f = await seedPreparation(store);
    await f.append(f.plan);
    const before = await f.history();
    const variants = [
      [
        "version",
        (m) => {
          m.expectedVersion = 2;
        },
      ],
      [
        "current intent",
        (m) => {
          m.currentIntent.intentRef = randomUUID();
        },
      ],
      [
        "current mode",
        (m) => {
          m.currentIntent.mode = "disabled";
        },
      ],
      [
        "current generation",
        (m) => {
          m.currentIntent.lifecycleGeneration += 1;
        },
      ],
      [
        "guard intent",
        (m) => {
          m.guard.intentRef = randomUUID();
        },
      ],
      [
        "guard mode",
        (m) => {
          m.guard.mode = "stopped";
        },
      ],
      [
        "guard generation",
        (m) => {
          m.guard.lifecycleGeneration += 1;
        },
      ],
      [
        "gate version",
        (m) => {
          m.guard.gateVersion += 1;
        },
      ],
      [
        "fence epoch",
        (m) => {
          m.guard.requestedFenceEpoch += 1;
        },
      ],
      [
        "responsibility identity",
        (m) => {
          m.guard.responsibility.responsibilityRef = randomUUID();
        },
      ],
      [
        "responsibility version",
        (m) => {
          m.guard.responsibility.responsibilityVersion += 1;
        },
      ],
      [
        "plan identity",
        (m) => {
          m.guard.planRef = "plan/other";
        },
      ],
      [
        "plan version",
        (m) => {
          m.guard.planVersion += 1;
        },
      ],
      [
        "plan digest",
        (m) => {
          m.guard.planDigest = runtimePreparationDigest("other");
        },
      ],
      [
        "admitted cutoff",
        (m) => {
          m.guard.admittedChildCutoff += 1;
        },
      ],
    ];
    for (const [label, change] of variants) {
      const mutation = copy({ ...f.close, expectedVersion: 1, operationRef: randomUUID() });
      change(mutation);
      await assert.rejects(f.append(mutation), undefined, label);
      assert.equal(await f.operation(mutation.operationRef), undefined, label);
      assert.deepEqual(await f.history(), before, label);
    }
    await f.append(f.child);
  });

  await t.test(
    "scope, revision, component, generations and create effect cannot be substituted",
    async () => {
      const f = await seedPreparation(store);
      await f.append(f.plan);
      for (const [field, value] of [
        ["installationId", `ins_${randomUUID()}`],
        ["namespaceId", `ns_${randomUUID()}`],
        ["agentId", `agt_${randomUUID()}`],
        ["revisionId", `rev_${randomUUID()}`],
        ["component", "gateway"],
        ["lifecycleGeneration", 2],
        ["runtimeGeneration", 2],
        ["createEffectRef", randomUUID()],
        ["assignmentRef", { schemaVersion: 1, id: randomUUID() }],
      ]) {
        const target = { ...f.target, [field]: value };
        await assert.rejects(
          f.append({ ...f.close, expectedVersion: 1, operationRef: randomUUID(), target }),
        );
        if (["installationId", "namespaceId", "agentId"].includes(field)) {
          assert.equal(
            await store.read((unit) =>
              unit.runtimePreparation.findPreparation(target, f.plan.preparationRef),
            ),
            undefined,
          );
          assert.equal(
            await store.read((unit) =>
              unit.runtimePreparation.findOperation(target, f.plan.operationRef),
            ),
            undefined,
          );
          assert.deepEqual(
            await store.read((unit) =>
              unit.runtimePreparation.listHistory(target, f.plan.preparationRef),
            ),
            [],
          );
        }
      }
      const foreign = await seedPreparation(store);
      const plan = copy(foreign.plan);
      plan.plan.targets[0].target.ownerAssignmentRef = f.target.assignmentRef;
      plan.plan.targets[0].target.ownerCreateEffectRef = f.target.createEffectRef;
      await assert.rejects(foreign.append(plan));
      assert.equal(await foreign.record(), undefined);
      assert.equal((await f.record()).localVersion, 1);
    },
  );

  await t.test(
    "original helper output and exact authority locator round-trip through the real repository",
    async () => {
      const f = await seedPreparation(store);
      await f.append(f.plan);
      await f.append(f.child);
      const binding = await f.candidate();
      const canonical = canonicalRuntimeAuthorityMutationV1(binding.proposal);
      const locator = copy(binding.operation);
      await f.append(binding);
      assert.deepEqual(f.representation.events, ["gate", "discover", "observe", "gate"]);
      const saved = (await f.record()).bindingProposals[0];
      assert.equal(saved.canonicalProposalJson, canonical);
      assert.equal(
        canonicalRuntimePreparation(saved.proposal),
        canonicalRuntimePreparation(binding.proposal),
      );
      assert.deepEqual(saved.operation, locator);
      assert.equal((await f.record()).children.length, 1);
      assert.equal((await f.record()).retainedChildSequence, 1);
      assert.equal((await f.record()).guard.admittedChildCutoff, 0);
      const service = new RuntimeAuthorityService({
        store,
        installationId: f.target.installationId,
        recipientRef: "recipient/occ",
        clock: f.representation.clock,
      });
      const result = await service.bind(binding.proposal, f.representation.options.authorityCall);
      assert.equal(result.result, "rejected-before-effect");
      assert.equal((await f.assignment()).binding.status, "unbound");
      assert.equal(
        await store.read((unit) =>
          unit.runtimeAuthority.findOperation(f.scope, locator.operationRef),
        ),
        undefined,
      );
      const resolved = await service.resolve(
        {
          schemaVersion: 1,
          ...f.scope,
          assignmentRef: f.target.assignmentRef,
          requestRef: binding.proposal.requestRef,
          purpose: "runtime-peer",
        },
        f.representation.options.authorityCall,
      );
      assert.equal(resolved.result, "not-visible");
    },
  );

  await t.test(
    "binding requires its corresponding retained child and exact original locator",
    async () => {
      const f = await seedPreparation(store);
      await f.append(f.plan);
      const binding = await f.candidate();
      await assert.rejects(f.append({ ...binding, expectedVersion: 1 }));
      await f.append(f.child);
      for (const change of [
        (m) => {
          m.operation.operationKind = "retire";
        },
        (m) => {
          m.operation.operationRef = randomUUID();
        },
        (m) => {
          m.proposal.responsibilityRef = m.preparationRef;
        },
        (m) => {
          m.proposal.expectedAssignmentRecordVersion = 2;
          m.operation = exactRuntimeAuthorityOperation(m.proposal);
        },
        (m) => {
          m.proposal.binding.deploymentUid = "deployment/other";
          m.operation = exactRuntimeAuthorityOperation(m.proposal);
        },
        (m) => {
          m.proposal.binding.admittedConfigurationDigest = runtimePreparationDigest("wrong");
          m.operation = exactRuntimeAuthorityOperation(m.proposal);
        },
      ]) {
        const mutation = copy(binding);
        change(mutation);
        await assert.rejects(f.append(mutation));
        assert.equal((await f.record()).bindingProposals.length, 0);
      }
      await f.append(binding);
    },
  );

  await t.test(
    "binding proposals obey authority bounds and retain globally unique original operation identities",
    async () => {
      const f = await seedPreparation(store);
      await f.append(f.plan);
      await f.append(f.child);
      f.representation.responses.observation.binding.imageDigests = Array.from(
        { length: 16 },
        (_, index) => ({
          name: `image-${String(index).padStart(2, "0")}`,
          digest: runtimePreparationDigest(`image-${index}`),
        }),
      );
      const binding = await f.candidate();
      for (const change of [
        (mutation) => {
          mutation.proposal.binding.imageDigests.push({
            name: "image-17",
            digest: runtimePreparationDigest("extra"),
          });
        },
        (mutation) => {
          mutation.proposal.requestRef = "x".repeat(65_537);
        },
      ]) {
        const mutation = copy(binding);
        change(mutation);
        await assert.rejects(f.append(mutation));
        assert.equal((await f.record()).bindingProposals.length, 0);
      }
      await f.append(binding);
      assert.equal((await f.record()).bindingProposals[0].proposal.binding.imageDigests.length, 16);
      assert.equal((await f.append(binding)).status, "exact-replay");
      const changed = copy(binding);
      changed.proposal.requestRef = "different/original-transport-request";
      await assert.rejects(f.append(changed));
      const other = await seedPreparation(store);
      await other.append(other.plan);
      await other.append(other.child);
      const reused = copy(await other.candidate());
      reused.proposal.operationRef = binding.proposal.operationRef;
      reused.operation = exactRuntimeAuthorityOperation(reused.proposal);
      await assert.rejects(other.append(reused));
      assert.equal((await other.record()).bindingProposals.length, 0);
      assert.equal((await f.record()).bindingProposals.length, 1);
    },
  );

  await t.test(
    "exact repeats are stable; changed bytes, renderer and attribution conflict",
    async () => {
      const f = await seedPreparation(store);
      const first = await f.append(f.plan);
      const child = await f.append(f.child);
      assert.deepEqual((await f.append(f.plan)).operation, first.operation);
      assert.equal((await f.append(f.child)).status, "exact-replay");
      const before = await f.history();
      for (const change of [
        (m) => {
          m.providerWireUtf8 += " ";
        },
        (m) => {
          m.child.providerWire.rendererProfileRef = "renderer/other";
        },
        (m) => {
          m.child.providerWire.rendererProfileDigest = runtimePreparationDigest("renderer");
        },
        (m) => {
          m.child.providerWire.requestRef = "wire/other";
        },
        (m) => {
          m.child.request.predicate.resourceVersion = "opaque.9";
          m.child = rebuildPreparationChild(m.child, m.providerWireUtf8);
        },
        (m) => {
          m.providerWireUtf8 += " ";
          m.child = rebuildPreparationChild(m.child, m.providerWireUtf8);
        },
      ]) {
        const mutation = copy(f.child);
        change(mutation);
        await assert.rejects(f.append(mutation));
      }
      for (const writer of [
        { ...preparationWriter, writerRef: "writer/other" },
        { ...preparationWriter, recordedAt: "2026-09-06T00:00:00.001Z" },
        { ...preparationWriter, extra: true },
      ])
        await assert.rejects(f.append(f.child, writer));
      await assert.rejects(
        f.append({ ...f.child, operationRef: randomUUID(), expectedVersion: 2 }),
      );
      assert.deepEqual(await f.history(), before);
      assert.deepEqual(await f.operation(f.child.operationRef), child.operation);
    },
  );

  await t.test("operation and child identities cannot be reused across Agents", async () => {
    const a = await seedPreparation(store);
    const b = await seedPreparation(store);
    await a.append(a.plan);
    await assert.rejects(b.append({ ...b.plan, operationRef: a.plan.operationRef }));
    assert.equal(await b.record(), undefined);
    await b.append(b.plan);
    await a.append(a.child);
    const reused = copy(b.child);
    reused.child.request.effect.effectRef = a.child.child.effect.effectRef;
    reused.child = rebuildPreparationChild(reused.child, reused.providerWireUtf8);
    await assert.rejects(b.append(reused));
    assert.equal((await b.record()).children.length, 0);
  });

  await t.test("returned records and caller input do not share mutable storage", async () => {
    const f = await seedPreparation(store);
    const originalPlan = copy(f.plan);
    await f.append(f.plan);
    await f.append(f.child);
    f.plan.plan.targets[0].desiredSpecDigest = runtimePreparationDigest("caller-mutated");
    const record = await f.record();
    assert.deepEqual(record.plan, originalPlan.plan);
    assert.ok(Object.isFrozen(record.children[0].child.request));
    assert.throws(() => {
      record.children[0].providerWireUtf8 = "changed";
    }, TypeError);
    assert.throws(() => {
      record.guard.gateVersion += 1;
    }, TypeError);
    assert.deepEqual(await f.record(), record);
    assert.notEqual(await f.record(), record);
  });

  await t.test(
    "same-generation supersession preserves unresolved history and closes old guards",
    async () => {
      const f = await seedPreparation(store);
      await f.append(f.plan);
      await f.append(f.child);
      const childOperation = await f.operation(f.child.operationRef);
      const supersede = f.nextPlan();
      await f.append(supersede);
      const current = await f.record();
      assert.equal(current.localVersion, 3);
      assert.equal(current.retainedChildSequence, 1);
      assert.equal(current.guard.lifecycleGeneration, f.intent.generation);
      assert.equal(current.guard.admittedChildCutoff, 0);
      assert.deepEqual(current.children[0].child, f.child.child);
      assert.deepEqual(current.plan, supersede.plan);
      await assert.rejects(f.append({ ...f.close, expectedVersion: 3 }));
      const closure = { ...f.close, guard: supersede.nextGuard, expectedVersion: 3 };
      const closed = await f.append(closure);
      assert.equal((await f.record()).localState, "closed");
      assert.equal((await f.append(closure)).status, "exact-replay");
      assert.deepEqual((await f.append(closure)).operation, closed.operation);
      await assert.rejects(
        f.append({ ...closure, operationRef: randomUUID(), expectedVersion: 4 }),
      );
      assert.deepEqual(await f.operation(f.child.operationRef), childOperation);
      assert.equal((await f.record()).children.length, 1);
      assert.equal((await f.assignment()).binding.status, "unbound");
    },
  );

  await t.test(
    "historical bytes survive intent advancement, local closure and successor allocation",
    async () => {
      const f = await seedPreparation(store);
      await f.append(f.plan);
      await f.append(f.child);
      const binding = await f.candidate();
      await f.append(binding);
      const original = await f.history();
      const next = await f.advance();
      await assert.rejects(f.append({ ...f.close, expectedVersion: 3 }));
      await f.append({
        ...f.close,
        expectedVersion: 3,
        reason: "superseded",
        currentIntent: {
          intentRef: next.transitionRef,
          mode: next.desiredMode,
          lifecycleGeneration: next.generation,
        },
      });
      const running = await store.transact((unit) =>
        unit.runtimeAssignments.advanceRuntimeIntent(
          f.scope,
          2,
          { desiredMode: "running", revisionId: f.revision.id },
          randomUUID(),
          f.attribution,
        ),
      );
      const successor = await store.transact((unit) =>
        unit.runtimeAssignments.allocateUnboundRuntime(
          f.scope,
          running.generation,
          "harness",
          1,
          randomUUID(),
          profiles,
        ),
      );
      assert.notEqual(successor.assignmentRef, f.allocation.assignmentRef);
      assert.deepEqual((await f.history()).slice(0, 3), original);
      assert.equal((await f.record()).localState, "superseded");
      assert.equal(
        (await f.record()).bindingProposals[0].canonicalProposalJson,
        canonicalRuntimeAuthorityMutationV1(binding.proposal),
      );
      for (const mutation of [f.plan, f.child, binding])
        assert.equal((await f.append(mutation)).status, "exact-replay");
      assert.equal((await f.record()).localVersion, 4);
      assert.equal((await f.assignment()).binding.status, "unbound");
    },
  );

  await t.test("caught inner failure poisons all coupled preparation and intent work", async () => {
    const f = await seedPreparation(store);
    await assert.rejects(
      store.transact(async (unit) => {
        await unit.runtimePreparation.retain(f.plan, preparationWriter);
        try {
          await unit.runtimePreparation.retain(
            { ...f.child, expectedVersion: 7 },
            preparationWriter,
          );
        } catch {}
        // Even a supported mutation after the caught rejection must not commit.
        await unit.runtimeAssignments.advanceRuntimeIntent(
          f.scope,
          1,
          { desiredMode: "stopped", revisionId: f.revision.id },
          randomUUID(),
          f.attribution,
        );
      }),
    );
    assert.equal(await f.record(), undefined);
    assert.equal((await f.head()).generation, 1);
    await assert.rejects(
      store.transact(async (unit) => {
        await unit.runtimePreparation.retain(f.plan, preparationWriter);
        await unit.runtimePreparation.retain(f.child, preparationWriter);
        throw new Error("crash before commit");
      }),
    );
    assert.equal(await f.operation(f.plan.operationRef), undefined);
    assert.equal(await f.operation(f.child.operationRef), undefined);
    await f.append(f.plan);
    await f.append(f.child);
  });

  await t.test(
    "completed, draining and delayed transaction promises cannot retain later work",
    async () => {
      const f = await seedPreparation(store);
      const escaped = await store.transact(async (unit) => unit.runtimePreparation);
      await assert.rejects(escaped.retain(f.plan, preparationWriter));
      assert.equal(await f.record(), undefined);
      let delayed;
      await store.transact((unit) => {
        const first = unit.runtimePreparation.retain(f.plan, preparationWriter);
        delayed = first.then(() => unit.runtimePreparation.retain(f.child, preparationWriter));
        delayed.catch(() => {});
        return Promise.resolve();
      });
      await assert.rejects(delayed);
      assert.equal((await f.record()).localVersion, 1);
      assert.equal(await f.operation(f.child.operationRef), undefined);
      await assert.rejects(escaped.findPreparation(f.scope, f.plan.preparationRef));
    },
  );

  await t.test(
    "independent transactions race one local version and same-unit failures poison commit",
    async () => {
      const f = await seedPreparation(store);
      const outcomes = await Promise.allSettled([
        f.append(f.plan),
        f.append({ ...f.plan, operationRef: randomUUID() }),
      ]);
      assert.equal(outcomes.filter((value) => value.status === "fulfilled").length, 1);
      assert.equal(outcomes.filter((value) => value.status === "rejected").length, 1);
      assert.equal((await f.history()).length, 1);
      await assert.rejects(
        store.transact(async (unit) => {
          const results = await Promise.allSettled([
            unit.runtimePreparation.retain(f.child, preparationWriter),
            unit.runtimePreparation.retain(
              { ...f.child, operationRef: randomUUID() },
              preparationWriter,
            ),
          ]);
          assert.equal(results.filter((value) => value.status === "fulfilled").length, 1);
          assert.equal(results.filter((value) => value.status === "rejected").length, 1);
        }),
      );
      assert.equal((await f.record()).children.length, 0);
    },
  );

  await t.test(
    "256 retained children remain unadmitted and child 257 cannot change history",
    async () => {
      const f = await seedPreparation(store);
      await f.append(f.plan);
      await store.transact(async (unit) => {
        for (let sequence = 1; sequence <= 256; sequence++) {
          const mutation = copy(f.child);
          mutation.operationRef = randomUUID();
          mutation.expectedVersion = sequence;
          mutation.child.request.effect.effectRef = randomUUID();
          mutation.child = rebuildPreparationChild(mutation.child, mutation.providerWireUtf8);
          const result = await unit.runtimePreparation.retain(mutation, preparationWriter);
          assert.equal(result.operation.retainedChildSequence, sequence);
        }
      });
      const before = await f.history();
      assert.equal(before.length, 257);
      assert.equal((await f.record()).retainedChildSequence, 256);
      assert.equal((await f.record()).guard.admittedChildCutoff, 0);
      const excess = copy(f.child);
      excess.expectedVersion = 257;
      await assert.rejects(f.append(excess));
      assert.deepEqual(await f.history(), before);
      assert.equal(await f.operation(excess.operationRef), undefined);
    },
  );

  await t.test(
    "wire limits measure UTF-8 bytes independently of the prepared-child record",
    async () => {
      const f = await seedPreparation(store);
      await f.append(f.plan);
      const wire = "λ".repeat(32_768);
      const child = rebuildPreparationChild(f.child.child, wire);
      const mutation = { ...f.child, child, providerWireUtf8: wire };
      assert.equal(Buffer.byteLength(wire, "utf8"), 65_536);
      assert.ok(Buffer.byteLength(canonicalRuntimePreparation(mutation), "utf8") > 65_536);
      await f.append(mutation);
      assert.equal((await f.record()).children[0].providerWireUtf8, wire);
      const other = await seedPreparation(store);
      await other.append(other.plan);
      for (const providerWireUtf8 of ["x".repeat(65_537), "λ".repeat(32_769)]) {
        const value = {
          ...other.child,
          providerWireUtf8,
          child: rebuildPreparationChild(other.child.child, providerWireUtf8),
        };
        await assert.rejects(other.append(value));
        assert.equal((await other.record()).children.length, 0);
      }
    },
  );

  await t.test(
    "the exact 65536-byte logical payload and maximum closed-plan collections retain intact",
    async () => {
      const f = await seedPreparation(store);
      const child = preparationChildAtLogicalLimit(f, 65_536);
      parseRuntimeEffectsV1("preparedChild", child);
      assert.equal(child.request.plan.targets.length, 32);
      assert.equal(child.request.plan.producerDomains.length, 16);
      assert.ok(Buffer.byteLength(JSON.stringify(child), "utf8") > 65_536);
      await f.append({ ...f.plan, plan: child.request.plan });
      await f.append({ ...f.child, child });
      assert.equal(
        (await f.record()).children[0].child.canonicalRequestJson,
        child.canonicalRequestJson,
      );
      const other = await seedPreparation(store);
      const tooLarge = preparationChildAtLogicalLimit(other, 65_537);
      await other.append({ ...other.plan, plan: tooLarge.request.plan });
      await assert.rejects(other.append({ ...other.child, child: tooLarge }));
      assert.equal((await other.record()).children.length, 0);
    },
  );

  await t.test(
    "effect aggregate, collection and nesting limits reject without partial retention",
    async () => {
      const f = await seedPreparation(store);
      const atLimit = preparationChildAtLogicalLimit(f, 65_536);
      for (const change of [
        (plan) => {
          plan.targets.push({
            ...copy(plan.targets[0]),
            target: {
              ...copy(plan.targets[0].target),
              targetRef: "one-too-many",
              name: "one-too-many",
            },
          });
        },
        (plan) => {
          plan.producerDomains.push({
            ...copy(plan.producerDomains[0]),
            domainRef: "one-too-many",
          });
        },
        (plan) => {
          plan.producerDomains[0].targetRefs = Array.from({ length: 1025 }, () => "too-many");
        },
        (plan) => {
          let value = {};
          for (let i = 0; i < 34; i++) value = { nested: value };
          plan.targets[0].target = value;
        },
        (plan) => {
          plan.targets[0].target.name = "λ".repeat(131_073);
        },
      ]) {
        const plan = copy(atLimit.request.plan);
        change(plan);
        await assert.rejects(f.append({ ...f.plan, plan }));
        assert.equal(await f.record(), undefined);
      }
      const customArray = copy(f.plan);
      let suppliedMapCalls = 0;
      Object.setPrototypeOf(
        customArray.plan.targets,
        Object.create(Array.prototype, {
          map: {
            value() {
              suppliedMapCalls += 1;
              return [];
            },
          },
        }),
      );
      // Reject executable array behavior before canonicalization can dispatch it.
      await assert.rejects(f.append(customArray));
      assert.equal(suppliedMapCalls, 0);
      assert.equal(await f.record(), undefined);
      assert.equal(await f.operation(customArray.operationRef), undefined);

      // The aggregate gate-state codec is an imported effects V1 boundary, not a
      // current-authority response from this repository. Four individually valid
      // children exceed its 262144-byte envelope and must be rejected by that codec.
      const state = copy(f.representation.responses.state);
      state.guard = atLimit.guard;
      state.plan = atLimit.request.plan;
      state.children = Array.from({ length: 4 }, () => {
        const child = copy(atLimit);
        child.request.effect.effectRef = randomUUID();
        return rebuildPreparationChild(child, f.providerWireUtf8);
      });
      assert.ok(Buffer.byteLength(JSON.stringify(state), "utf8") > 262_144);
      assert.throws(() => parseRuntimeEffectsV1("gateState", state));
    },
  );

  await t.test(
    "descriptor changes and invented supersession versions cannot replace retained responsibility",
    async () => {
      const f = await seedPreparation(store);
      await f.append(f.plan);
      const wrongDescriptor = copy(f.child);
      wrongDescriptor.child.request.preparation.preparationVersion += 1;
      wrongDescriptor.child = rebuildPreparationChild(
        wrongDescriptor.child,
        wrongDescriptor.providerWireUtf8,
      );
      await assert.rejects(f.append(wrongDescriptor));
      await f.append(f.child);
      for (const change of [
        (m) => {
          m.nextGuard.gateVersion += 1;
        },
        (m) => {
          m.nextGuard.requestedFenceEpoch = 1;
        },
        (m) => {
          m.nextGuard.responsibility.responsibilityRef = randomUUID();
        },
        (m) => {
          m.nextGuard.admittedChildCutoff += 1;
        },
        (m) => {
          m.plan.planRef = "replacement-plan";
          m.nextGuard.planRef = m.plan.planRef;
        },
        (m) => {
          m.preparation.preparationVersion += 2;
        },
        (m) => {
          m.preparation.preparationRef = randomUUID();
        },
      ]) {
        const mutation = copy(f.nextPlan());
        change(mutation);
        await assert.rejects(f.append(mutation));
        assert.equal((await f.record()).localVersion, 2);
      }
      const valid = copy(f.nextPlan());
      valid.preparation.preparationVersion += 1;
      await f.append(valid);
      assert.equal((await f.record()).preparation.preparationVersion, 2);
      assert.equal((await f.record()).children[0].child.request.preparation.preparationVersion, 1);
    },
  );

  await t.test(
    "writable descriptors retain exact references without granting a writer or clearing unresolved history",
    async () => {
      const f = await seedPreparation(store);
      const plan = writablePreparationPlan(f);
      // These are retained reference data, not a no-writer attestation or reservation
      // acquisition. The internal store must neither grant nor release write access.
      for (const change of [
        (prior) => {
          prior.stores.push({ ...copy(prior.workspaceStore), logicalStoreRef: "different-store" });
        },
        (prior) => {
          prior.stores = [{ ...copy(prior.workspaceStore), bindingRef: "different-binding" }];
        },
        (prior) => {
          prior.reservation.scope = { ...prior.reservation.scope, agentId: `agt_${randomUUID()}` };
        },
      ]) {
        const changed = copy(plan);
        change(changed.preparation.priorWriterEvidence);
        await assert.rejects(f.append(changed));
        assert.equal(await f.record(), undefined);
      }
      await f.append(plan);
      const child = copy(f.child);
      child.child.request.preparation = plan.preparation;
      child.child = rebuildPreparationChild(child.child, child.providerWireUtf8);
      await f.append(child);
      await f.append(f.close);
      const record = await f.record();
      assert.deepEqual(record.preparation, plan.preparation);
      assert.deepEqual(record.children[0].child.request.preparation, plan.preparation);
      assert.equal(record.localState, "closed");
      assert.equal(record.retainedChildSequence, 1);
      assert.equal(record.guard.admittedChildCutoff, 0);
      assert.equal((await f.assignment()).binding.status, "unbound");
      for (const key of [
        "writable",
        "writerGranted",
        "reservationReleased",
        "cleanupComplete",
        "authority",
      ])
        assert.equal(Object.hasOwn(record, key), false);
    },
  );

  await t.test(
    "complete plans can retain distinct real allocations only within the owning Agent",
    async () => {
      const f = await seedPreparation(store);
      const successor = await store.transact((unit) =>
        unit.runtimeAssignments.allocateUnboundRuntime(
          f.scope,
          1,
          "harness",
          1,
          randomUUID(),
          profiles,
        ),
      );
      const plan = copy(f.plan);
      plan.plan.targets[0].target.ownerAssignmentRef = {
        schemaVersion: 1,
        id: successor.assignmentRef,
      };
      plan.plan.targets[0].target.ownerCreateEffectRef = successor.createEffectRef;
      await f.append(plan);
      assert.deepEqual((await f.record()).plan, plan.plan);
      assert.equal((await f.record()).localVersion, 1);
      assert.equal((await f.assignment()).binding.status, "unbound");
    },
  );
}
