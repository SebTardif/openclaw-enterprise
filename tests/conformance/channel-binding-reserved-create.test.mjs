import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { InMemoryAuditSink } from "../../packages/audit/src/index.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { ChannelBindingService } from "../../packages/occ/src/channel-bindings.ts";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  ScopeViolationError,
} from "../../packages/occ/src/errors.ts";
import { LifecycleAdmissionUnitPhase } from "../../packages/occ/src/lifecycle/protective-admission-unit.ts";
import { InMemoryPlatformState, OpenClawController } from "../../packages/occ/src/index.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import { createDevelopmentIAMState } from "../helpers/development-iam-state.mjs";
import {
  createTestAuthPrincipal,
  createAuthenticatedControllerRequest,
} from "../helpers/auth-session.mjs";

// Real Fastify admission, Better Auth session, Native IAM and memory state. The
// explicit collaborator invokes the actual complete repository command; it does
// not manufacture a positive owner or reservation result.
for (const selected of [false, true]) {
  test(`authenticated memory channel creation with reserved selection ${selected}`, async (t) => {
    const installation = {
      id: `ins_${randomUUID()}`,
      name: "reserved channel test",
      createdAt: new Date().toISOString(),
    };
    const { auth, seed, email, password } = await createTestAuthPrincipal({
      installationId: installation.id,
    });
    const auditSink = new InMemoryAuditSink();
    const state = new InMemoryPlatformState({ auditSink });
    await state.transact((unit) => unit.installations.createInstallation(installation));
    const iam = new NativeIAMDriver({
      loadNativeIAMState: async () => createDevelopmentIAMState(seed),
    });
    let calls = 0;
    let prepared;
    const collaborator = {
      state,
      async create(input, currentness) {
        calls++;
        prepared = input;
        assert.ok(Object.isFrozen(input));
        assert.ok(Object.isFrozen(input.record));
        assert.ok(Object.isFrozen(input.audit.details));
        return state.transact((unit) =>
          unit.channelBindings.createReservedChannelInstallation(input, currentness),
        );
      },
    };
    const controller = new OpenClawController(installation, {
      state,
      recordOperations: false,
      ...(selected ? { reservedChannelInstallationCreate: collaborator } : {}),
    });
    controller.registerDriver(iam);
    controller.selectDriver("iam", iam.id);
    // Configuration mutation after construction cannot switch the captured path.
    collaborator.create = () => {
      throw new Error("mutated constructor collaborator was used");
    };
    const app = createFastifyApp({
      controller,
      auth,
      iamDriver: iam,
      auditSink,
      publicOrigin: "http://127.0.0.1",
      development: { enabled: true, installationId: installation.id },
    });
    t.after(() => app.close());
    await app.ready();
    const request = await createAuthenticatedControllerRequest(app, { email, password });
    const body = {
      platform: "slack",
      providerTenantRef: `tenant-${randomUUID()}`,
      recipientAppRef: "exact-app",
    };
    // Principal identifiers alone do not carry the sealed request invocation.
    await assert.rejects(
      controller.channelBindings.createInstallation(
        { actorId: seed.principal.id, requestId: `req_${randomUUID()}` },
        body,
      ),
      AuthorizationDeniedError,
    );
    assert.equal(calls, 0);
    const result = await request("POST", "/api/channel-installations", body);
    assert.equal(result.status, selected ? 503 : 201, JSON.stringify(result));
    assert.equal(calls, selected ? 1 : 0);
    const records = await state.read((view) =>
      view.channelBindings.listChannelInstallations({ limit: 100 }),
    );
    if (selected) {
      assert.equal(result.error.code, "DEPENDENCY_UNAVAILABLE");
      assert.deepEqual(
        records,
        [],
        "selected unavailable must never fall back to ordinary insertion",
      );
      assert.notEqual(prepared.creationOperationRef, prepared.reservationRef);
      assert.equal(prepared.audit.actorId, seed.principal.id);
      assert.equal(auditSink.events.filter((event) => event.outcome === "success").length, 0);
    } else {
      assert.deepEqual(records, [result.data]);
      assert.equal(result.data.createdBy, seed.principal.id);
      assert.equal(auditSink.events.filter((event) => event.outcome === "success").length, 1);
    }
  });
}

test("reserved constructor rejects a collaborator bound to another store", () => {
  const state = new InMemoryPlatformState();
  assert.throws(
    () =>
      new ChannelBindingService({
        installationId: `ins_${randomUUID()}`,
        state,
        iam: () => {
          throw new Error("constructor must not request IAM");
        },
        reservedChannelInstallationCreate: {
          state: new InMemoryPlatformState(),
          create() {
            throw new Error("constructor must not execute creation");
          },
        },
      }),
    TypeError,
  );
});

// This peer implements transaction control and rejects every data query. It
// supplies no persisted rows, authorization decision, or positive reservation.
function protocol(options = {}) {
  const statements = [];
  const failure = Object.hasOwn(options, "failure")
    ? options.failure
    : new Error("controlled first data-query failure");
  const dataStarted = Promise.withResolvers();
  let released = 0;
  const client = {
    on() {},
    removeListener() {},
    release() {
      released++;
    },
    async query(sql) {
      statements.push(sql);
      if (["BEGIN", "ROLLBACK", "COMMIT"].includes(sql))
        return { command: sql, rows: [], rowCount: 0 };
      if (sql.startsWith("SET LOCAL ") || sql.startsWith("SELECT set_config("))
        return { rows: [], rowCount: 0 };
      dataStarted.resolve();
      if (options.pendingData) return options.pendingData;
      throw failure;
    },
  };
  const state = new PostgresPlatformState({
    options: { connectionTimeoutMillis: 100 },
    async connect() {
      return client;
    },
  });
  return { state, statements, failure, dataStarted: dataStarted.promise, released: () => released };
}
const unavailable = { kind: "recovery-required", reason: "original-association-unavailable" };

// Every recognized input below comes from the actual service during a real
// authenticated request. Native IAM evaluates explicitly provisioned memory
// policy; the SQL peer cannot authorize anything and returns no successful rows.
async function authenticatedAttempt(t, p, work) {
  const installation = {
    id: `ins_${randomUUID()}`,
    name: "custody test",
    createdAt: new Date().toISOString(),
  };
  const { auth, seed, email, password } = await createTestAuthPrincipal({
    installationId: installation.id,
  });
  const policy = createDevelopmentIAMState(seed);
  const policyStore = {
    async loadNativeIAMState() {
      return policy;
    },
  };
  const primary = new NativeIAMDriver(policyStore, { id: "custody-primary" });
  const alternate = new NativeIAMDriver(policyStore, { id: "custody-alternate" });
  let calls = 0,
    callbackFailed = false,
    callbackFailure;
  const controller = new OpenClawController(installation, {
    state: p.state,
    recordOperations: false,
    reservedChannelInstallationCreate: {
      state: p.state,
      async create(prepared, currentness) {
        calls++;
        assert.ok(Object.isFrozen(prepared));
        assert.ok(Object.isFrozen(prepared.record));
        assert.ok(Object.isFrozen(prepared.audit.details));
        assert.ok(Object.isFrozen(currentness));
        try {
          await work({ prepared, currentness, controller, alternate });
        } catch (error) {
          callbackFailed = true;
          callbackFailure = error;
          throw error;
        }
        return unavailable;
      },
    },
  });
  controller.registerDriver(primary);
  controller.registerDriver(alternate);
  controller.selectDriver("iam", primary.id);
  const app = createFastifyApp({
    controller,
    auth,
    iamDriver: primary,
    auditSink: new InMemoryAuditSink(),
    publicOrigin: "http://127.0.0.1",
    development: { enabled: true, installationId: installation.id },
  });
  t.after(() => app.close());
  await app.ready();
  const request = await createAuthenticatedControllerRequest(app, { email, password });
  const result = await request("POST", "/api/channel-installations", {
    platform: "slack",
    providerTenantRef: `tenant-${randomUUID()}`,
    recipientAppRef: "custody-app",
  });
  if (callbackFailed) throw callbackFailure;
  assert.equal(calls, 1, JSON.stringify(result));
  assert.equal(result.status, 503, JSON.stringify(result));
}
function assertNoData(p) {
  assert.ok(
    p.statements.every((sql) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)),
    JSON.stringify(p.statements),
  );
}
async function rejectUnrecognized(p, prepared, currentness) {
  const result = await p.state.transact((unit) =>
    unit.channelBindings.createReservedChannelInstallation(prepared, currentness),
  );
  assert.deepEqual(result, unavailable);
  assert.equal(p.state.channelFirstCreateFailureLocatorV1(result), undefined);
  assert.equal(p.state.channelFirstCreateFailureLocatorV1(prepared), undefined);
  assertNoData(p);
}

for (const use of ["awaited", "caught", "unawaited"]) {
  test(`service-issued custody rolls back ${use} complete-command SQL failure`, async (t) => {
    const p = protocol();
    await authenticatedAttempt(t, p, async ({ prepared, currentness }) => {
      let operation;
      await assert.rejects(
        p.state.transact(async (unit) => {
          operation = unit.channelBindings.createReservedChannelInstallation(prepared, currentness);
          if (use === "awaited") return operation;
          if (use === "caught") await operation.catch(() => {});
          else void operation.catch(() => {});
        }),
        (error) => error === p.failure,
      );
      await operation.catch(() => {});
    });
    assert.equal(p.statements.includes("COMMIT"), false);
    assert.equal(p.statements.at(-1), "ROLLBACK");
    assert.equal(p.released(), 1);
  });
}

for (const [name, outward] of [
  ["Installation read", (unit) => unit.installations.getInstallation()],
  ["channel list", (unit) => unit.channelBindings.listChannelInstallations({ limit: 1 })],
  [
    "second complete command",
    (unit, prepared, currentness) =>
      unit.channelBindings.createReservedChannelInstallation(prepared, currentness),
  ],
]) {
  test(`service-issued command claims final unit synchronously before ${name}`, async (t) => {
    const p = protocol();
    await authenticatedAttempt(t, p, async ({ prepared, currentness }) => {
      let first;
      await assert.rejects(
        p.state.transact(async (unit) => {
          const command = unit.channelBindings.createReservedChannelInstallation(
            prepared,
            currentness,
          );
          void command.catch(() => {});
          try {
            await outward(unit, prepared, currentness);
          } catch (error) {
            first = error;
          }
        }),
        (error) => error === first && error instanceof ScopeViolationError,
      );
    });
    assert.equal(p.statements.length, 3, "only the accepted command's initial data query runs");
    assert.equal(p.statements.at(-1), "ROLLBACK");
  });
}

test("real selected IAM change is retained ahead of a later callback error", async (t) => {
  const p = protocol();
  await authenticatedAttempt(t, p, async ({ prepared, currentness, controller, alternate }) => {
    controller.selectDriver("iam", alternate.id);
    let first;
    await assert.rejects(
      p.state.transact(async (unit) => {
        try {
          await unit.channelBindings.createReservedChannelInstallation(prepared, currentness);
        } catch (error) {
          first = error;
        }
        assert.ok(first instanceof Error);
        throw new Error("later outer callback error");
      }),
      (error) => error === first,
    );
  });
  assert.deepEqual(p.statements, ["BEGIN", "ROLLBACK"]);
});

test("first outward rejection survives later pending SQL rejection with exact identity", async (t) => {
  const pending = Promise.withResolvers();
  const p = protocol({ pendingData: pending.promise });
  await authenticatedAttempt(t, p, async ({ prepared, currentness }) => {
    let first, inner;
    await assert.rejects(
      p.state.transact(async (unit) => {
        const operation = unit.channelBindings.createReservedChannelInstallation(
          prepared,
          currentness,
        );
        void operation.catch(() => {});
        await p.dataStarted;
        try {
          await unit.installations.getInstallation();
        } catch (error) {
          first = error;
        }
        pending.reject(p.failure);
        try {
          await operation;
        } catch (error) {
          inner = error;
        }
      }),
      (error) => error === first,
    );
    assert.ok(first instanceof ScopeViolationError);
    assert.equal(inner, first);
  });
  assert.equal(p.statements.length, 3);
  assert.equal(p.statements.at(-1), "ROLLBACK");
});

test("undefined first SQL failure remains latched after a caught service-issued command", async (t) => {
  const p = protocol({ failure: undefined });
  await authenticatedAttempt(t, p, async ({ prepared, currentness }) => {
    let handled = false,
      inner = new Error("not reached");
    await assert.rejects(
      p.state.transact(async (unit) => {
        try {
          await unit.channelBindings.createReservedChannelInstallation(prepared, currentness);
        } catch (error) {
          handled = true;
          inner = error;
        }
        throw new Error("later callback error");
      }),
      DependencyUnavailableError,
    );
    assert.equal(handled, true);
    assert.equal(inner, undefined);
  });
  assert.equal(p.statements.at(-1), "ROLLBACK");
  assert.equal(p.statements.includes("COMMIT"), false);
});

for (const name of ["plain", "clone", "foreign state"]) {
  test(`active service attempt rejects ${name} association without data SQL`, async (t) => {
    const p = protocol();
    await authenticatedAttempt(t, p, async ({ prepared, currentness }) => {
      if (name === "foreign state") {
        const foreign = protocol();
        await rejectUnrecognized(foreign, prepared, currentness);
        assert.equal(foreign.released(), 1);
      } else {
        await rejectUnrecognized(p, name === "plain" ? {} : structuredClone(prepared), currentness);
      }
    });
    assertNoData(p);
  });
}

for (const name of ["boolean-returning", "thenable-returning", "throwing getter"]) {
  test(`wrong ${name} currentness identity is rejected without inspecting it`, async (t) => {
    const p = protocol();
    let accessCount = 0;
    const wrong =
      name === "throwing getter"
        ? Object.defineProperty({}, "assertSelectedIAM", {
            get() {
              accessCount++;
              throw new Error("getter inspected");
            },
          })
        : {
            assertSelectedIAM() {
              accessCount++;
              return name === "boolean-returning"
                ? true
                : {
                    then() {
                      accessCount++;
                    },
                  };
            },
          };
    await authenticatedAttempt(t, p, ({ prepared }) => rejectUnrecognized(p, prepared, wrong));
    assert.equal(accessCount, 0);
  });
}

for (const name of ["throwing payload getter", "payload Proxy get trap"]) {
  test(`unrecognized ${name} is not inspected and acquires no locator`, async () => {
    const p = protocol();
    let accessCount = 0;
    const prepared =
      name === "throwing payload getter"
        ? Object.defineProperty({}, "record", {
            enumerable: true,
            get() {
              accessCount++;
              throw new Error("payload inspected");
            },
          })
        : new Proxy(
            {},
            {
              get() {
                accessCount++;
                throw new Error("proxy inspected");
              },
            },
          );
    const wrong = Object.defineProperty({}, "assertSelectedIAM", {
      get() {
        accessCount++;
        throw new Error("currentness inspected");
      },
    });
    await rejectUnrecognized(p, prepared, wrong);
    assert.equal(accessCount, 0);
    assert.equal(p.released(), 1);
  });
}

test("consumed service custody cannot retry after rollback while service call remains active", async (t) => {
  const p = protocol();
  await authenticatedAttempt(t, p, async ({ prepared, currentness }) => {
    await assert.rejects(
      p.state.transact((unit) =>
        unit.channelBindings.createReservedChannelInstallation(prepared, currentness),
      ),
      (error) => error === p.failure,
    );
    const before = p.statements.length;
    const result = await p.state.transact((unit) =>
      unit.channelBindings.createReservedChannelInstallation(prepared, currentness),
    );
    assert.deepEqual(result, unavailable);
    assert.equal(p.state.channelFirstCreateFailureLocatorV1(result), undefined);
    assert.deepEqual(p.statements.slice(before), ["BEGIN", "COMMIT"]);
  });
  assert.equal(p.released(), 2);
});

test("unused service custody closes when its original collaborator returns", async (t) => {
  const p = protocol();
  let captured;
  await authenticatedAttempt(t, p, async (original) => {
    captured = original;
  });
  await rejectUnrecognized(p, captured.prepared, captured.currentness);
  assert.equal(p.released(), 1);
});

// The actual phase is tested separately from storage: these callbacks are only
// scheduling inputs, never a replacement reservation or owner qualification.
test("phase only: channel phase retains its late-reentry latch after its own finish", async () => {
  const phase = new LifecycleAdmissionUnitPhase();
  await phase.runChannelFirstCreate(async () => undefined);
  await phase.finish();
  // Another real owner guard may still be draining at this point. Finishing
  // this phase cannot make a rejected late outward operation harmless.
  await assert.rejects(
    phase.legacyQuery(async () => assert.fail("late query ran")),
    ScopeViolationError,
  );
  assert.throws(() => phase.assertChannelCommitReady(), ScopeViolationError);
  phase.closeChannelFirstCreate();
});

test("phase only: channel phase drains accepted work before permitting commit dispatch", async () => {
  const phase = new LifecycleAdmissionUnitPhase();
  const resume = Promise.withResolvers();
  let completed = false,
    finished = false;
  const accepted = phase.runChannelFirstCreate(async () => {
    await resume.promise;
    phase.assertChannelFirstCreateActive();
    completed = true;
  });
  const draining = phase.finish().then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.throws(() => phase.assertChannelCommitReady(), ScopeViolationError);
  resume.resolve();
  await accepted;
  await draining;
  assert.equal(completed, true);
  phase.assertChannelCommitReady();
  phase.markChannelCommitDispatched();
  assert.throws(() => phase.assertChannelFirstCreateActive(), ScopeViolationError);
  phase.closeChannelFirstCreate();
});
