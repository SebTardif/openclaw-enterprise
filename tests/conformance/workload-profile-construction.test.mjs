import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { OpenClawController } from "../../packages/occ/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { InMemoryPlatformState } from "../../packages/occ/src/state/platform-state.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import { createWorkloadProfileUseResolverV2 } from "../../packages/occ/src/workload-profiles/admitted-use.ts";
import { workloadProfileAdmissionFixture } from "../fixtures/workload-profile-admission-v2.mjs";

const installation = () => ({
  id: `ins_${randomUUID()}`,
  name: "Controlled",
  createdAt: new Date().toISOString(),
});
const closed = () => {
  throw new Error("No controlled authority supplied");
};
const rejectedGroup = () => ({
  enrollment: { withDraft: closed, withDeployment: closed, withRecovery: closed },
  use: { validateSelectionLocked: closed, prepareUseLocked: closed },
});

test("actual controller assembles once with its original state and private DriverSelection", () => {
  const i = installation();
  let connects = 0,
    calls = 0,
    captured,
    installed;
  const state = new PostgresPlatformState({
    async connect() {
      connects++;
      throw new Error("No SQL construction");
    },
    async end() {},
  });
  const invocations = Object.freeze({ forCurrentInvocation: closed });
  const controller = new OpenClawController(i, {
    state,
    workloadProfiles: {
      invocations,
      create(context) {
        calls++;
        captured = context;
        assert.strictEqual(context.state, state);
        assert.deepEqual(context.installation, i);
        assert.equal(Object.isFrozen(context), true);
        assert.equal(Object.isFrozen(context.installation), true);
        assert.strictEqual(Object.getPrototypeOf(context.selection), DriverSelection.prototype);
        const profile = state.workloadProfileMutationEnrollmentV2(context.selection);
        installed = {
          enrollment: profile.enrollment,
          use: createWorkloadProfileUseResolverV2(profile.activeReader),
        };
        return installed;
      },
    },
  });
  const driver = new NativeIAMDriver(state);
  controller.registerDriver(driver);
  controller.selectDriver("iam", driver.id);
  assert.strictEqual(captured.selection.selectedDriver("iam"), driver);
  assert.strictEqual(controller.selectedDriver("iam"), driver);
  assert.equal(calls, 1);
  assert.equal(connects, 0);
  assert.ok(installed);
});

test("both real service paths capture the same stable original invocation source once", async () => {
  const f = workloadProfileAdmissionFixture();
  let invocations = 0,
    creates = 0;
  const refusal = new Error("original stable invocation refusal");
  const factory = {
    invocations: {
      forCurrentInvocation() {
        invocations++;
        throw refusal;
      },
    },
    create() {
      creates++;
      return rejectedGroup();
    },
  };
  const controller = new OpenClawController(
    { id: f.installationId, name: "Controlled", createdAt: new Date().toISOString() },
    { state: new InMemoryPlatformState(), workloadProfiles: factory },
  );
  factory.invocations = {
    forCurrentInvocation() {
      throw new Error("mutated source was captured");
    },
  };
  factory.create = () => {
    throw new Error("factory reran");
  };
  await assert.rejects(
    controller.agent.updateAgent("principal", {
      namespaceId: f.namespaceId,
      agentId: `agt_${randomUUID()}`,
      configurationId: `cfg_${randomUUID()}`,
      workloadProfileSelection: f.head.selection,
    }),
    (error) => error === refusal,
  );
  await assert.rejects(
    controller.deployment.recoverDeployAgentCommand("principal", {
      namespaceId: f.namespaceId,
      agentId: `agt_${randomUUID()}`,
      command: {
        schemaVersion: 2,
        operationRef: randomUUID(),
        expectedLifecycleGeneration: null,
        revisionSource: "saved-draft",
        expectedDraft: {
          configurationId: `cfg_${randomUUID()}`,
          configurationGeneration: 1,
          providerId: "provider/controlled",
          executionMode: "dedicated",
          maximumExecutionMs: null,
          serviceAccountId: null,
          workloadProfileSelection: f.head.selection,
        },
      },
    }),
    (error) => error === refusal,
  );
  assert.equal(invocations, 2);
  assert.equal(creates, 1);
});

for (const [name, value] of [
  ["undefined", undefined],
  ["null", null],
  ["empty", {}],
  ["thenable", { then() {} }],
  ["promise", Promise.resolve(rejectedGroup())],
  ["incomplete enrollment", { ...rejectedGroup(), enrollment: { withDraft: closed } }],
  ["incomplete use", { ...rejectedGroup(), use: { validateSelectionLocked: closed } }],
])
  test(`installed factory refuses ${name} collaborators during construction`, () => {
    let calls = 0;
    assert.throws(
      () =>
        new OpenClawController(installation(), {
          workloadProfiles: {
            invocations: { forCurrentInvocation: closed },
            create() {
              calls++;
              return value;
            },
          },
        }),
      /profile|Profile/,
    );
    assert.equal(calls, 1);
  });

test("factory failure is preserved and cannot leave a late mutable controller", () => {
  const original = new Error("controlled factory failure");
  assert.throws(
    () =>
      new OpenClawController(installation(), {
        workloadProfiles: {
          invocations: { forCurrentInvocation: closed },
          create() {
            throw original;
          },
        },
      }),
    (error) => error === original,
  );
});

test("no installed factory preserves ordinary controller construction without positive profile authority", () => {
  const controller = new OpenClawController(installation());
  assert.ok(controller.agent);
  assert.ok(controller.deployment);
});

test("a rejected asynchronous factory cannot publish a controller or escape as an unhandled promise", async () => {
  assert.throws(
    () =>
      new OpenClawController(installation(), {
        workloadProfiles: {
          invocations: { forCurrentInvocation: closed },
          create() {
            return Promise.reject(new Error("invalid asynchronous setup"));
          },
        },
      }),
    /synchronous/,
  );
  await new Promise((resolve) => setImmediate(resolve));
});
