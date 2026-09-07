import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createControllerWorker } from "../../apps/controller/src/worker.ts";
import { NativeIAMDriver } from "../../packages/iam/src/index.ts";
import { createDevelopmentComputeDriver } from "../helpers/development.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import { createTestConfigurationDriver } from "../helpers/configuration-driver.mjs";
import { createTestSecretDriver } from "../helpers/secret-driver.mjs";

function gate() {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  return {
    entered: entered.promise,
    release: release.resolve,
    reject: release.reject,
    async wait() {
      entered.resolve();
      await release.promise;
    },
  };
}

// This read-only query capability supplies a fixed, valid startup snapshot.
// It exercises the actual state decoder and worker lifecycle; it neither models
// queue persistence nor claims PostgreSQL readiness or Driver runtime proof.
function controlledPool({ read, connect, close, polling } = {}) {
  const calls = { connections: 0, released: 0, closes: 0, polls: 0, reads: [] };
  const rows = {
    installation: [{ id: "ins_lifetime", name: "Worker lifetime", created_at: new Date(0) }],
    iam_identities: [
      {
        id: "principal/lifetime",
        kind: "principal",
        issuer: "https://issuer.example",
        subject: "lifetime",
      },
    ],
    iam_roles: [
      { id: "role/lifetime", permissions: [{ action: "read", resourceKind: "namespace" }] },
    ],
    iam_access_bindings: [
      {
        id: "binding/lifetime",
        identity_subject_id: "principal/lifetime",
        role_id: "role/lifetime",
      },
    ],
    iam_groups: [],
    iam_group_memberships: [],
    iam_restrictions: [],
  };
  const pool = {
    async connect() {
      calls.connections += 1;
      await connect?.();
      return {
        release() {
          calls.released += 1;
        },
        async query(sql) {
          if (
            ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT", "ROLLBACK"].includes(sql)
          )
            return { rows: [], rowCount: 0, command: sql.split(" ")[0] };
          const table = /\bFROM occ\.(\w+)/.exec(sql)?.[1];
          if (!Object.hasOwn(rows, table)) throw new Error(`Unexpected startup query: ${sql}`);
          calls.reads.push(table);
          await read?.(table);
          return { rows: rows[table], rowCount: rows[table].length };
        },
      };
    },
    async query() {
      calls.polls += 1;
      if (polling === undefined) throw new Error("Unexpected queue polling");
      await polling();
      throw new Error("Controlled queue boundary unavailable");
    },
    async end() {
      calls.closes += 1;
      await close?.();
    },
  };
  return { pool, calls };
}

function fixture(options = {}) {
  const database = controlledPool(options);
  const events = [];
  let driverCloses = 0;
  let preflights = 0;
  const compute = {
    ...createDevelopmentComputeDriver(),
    async preflight() {
      preflights += 1;
      await options.preflight?.();
    },
    async close() {
      driverCloses += 1;
    },
  };
  const installation = createInstallationDriverConfiguration();
  installation.drivers.compute.id = compute.id;
  const worker = createControllerWorker({
    pool: database.pool,
    mode: "production",
    drivers: {
      installation,
      computeDriver: compute,
      configurationDriver: createTestConfigurationDriver({
        id: installation.drivers.configuration.id,
      }),
      secretDriver: createTestSecretDriver({ id: installation.drivers.secret.id }),
      createIAMDriver(state) {
        return new NativeIAMDriver(state, {
          id: installation.drivers.iam.id,
          implementation: "native",
        });
      },
    },
    emit(event) {
      events.push(event);
    },
  });
  return {
    ...database,
    worker,
    events,
    driverCloses: () => driverCloses,
    preflights: () => preflights,
  };
}

for (const stage of ["installation", "iam", "preflight"]) {
  test(
    `stop during ${stage} joins startup, suppresses dispatch and closes once`,
    { timeout: 2000 },
    async (context) => {
      const startup = gate();
      const closing = gate();
      const options = { close: closing.wait };
      if (stage === "preflight") options.preflight = startup.wait;
      else
        options.read = (table) => {
          if (table === (stage === "installation" ? "installation" : "iam_identities"))
            return startup.wait();
        };
      const f = fixture(options);
      context.after(async () => {
        startup.release();
        closing.release();
        await f.worker.stop();
      });
      const starting = f.worker.start();
      await startup.entered;
      await assert.rejects(f.worker.start(), /already been started/);
      const firstStop = f.worker.stop();
      const secondStop = f.worker.stop();
      assert.equal(firstStop, secondStop, "all callers join the same full shutdown promise");
      let stopped = false;
      firstStop.then(() => {
        stopped = true;
      });
      await setImmediate();
      assert.equal(stopped, false);
      assert.equal(f.calls.closes, 0, "state cannot close while startup owns a pending operation");
      await assert.rejects(f.worker.start(), /stopping or stopped/);
      startup.release();
      await starting;
      await closing.entered;
      assert.equal(stopped, false, "shutdown also joins the state close capability");
      assert.equal(f.calls.closes, 1);
      assert.equal(f.calls.polls, 0);
      assert.equal(
        f.events.some(({ event }) => event === "worker.started"),
        false,
      );
      assert.equal(f.calls.connections, stage === "installation" ? 1 : 2);
      assert.equal(f.calls.released, f.calls.connections);
      assert.equal(f.preflights(), stage === "preflight" ? 1 : 0);
      closing.release();
      await Promise.all([firstStop, secondStop]);
      assert.equal(f.worker.stop(), firstStop);
      assert.equal(f.calls.closes, 1);
      assert.equal(f.driverCloses(), 0, "selected Driver lifetime remains with its caller");
      assert.deepEqual(f.events, [{ event: "worker.stopped" }]);
      await assert.rejects(f.worker.start(), /stopping or stopped/);
    },
  );
}

test(
  "start records ownership before any injected startup capability runs",
  { timeout: 2000 },
  async (context) => {
    const acquisition = gate();
    const f = fixture({ connect: acquisition.wait });
    context.after(async () => {
      acquisition.release();
      await f.worker.stop();
    });
    const starting = f.worker.start();
    const duplicate = assert.rejects(f.worker.start(), /already been started/);
    await acquisition.entered;
    await duplicate;
    assert.equal(f.calls.connections, 1);
    const stopping = f.worker.stop();
    acquisition.release();
    await Promise.all([starting, stopping]);
    assert.equal(f.calls.polls, 0);
    assert.equal(f.calls.closes, 1);
  },
);

test("immediate stop after start prevents even the first startup acquisition", async () => {
  const f = fixture();
  const starting = f.worker.start();
  const stopping = f.worker.stop();
  await Promise.all([starting, stopping]);
  assert.equal(f.calls.connections, 0);
  assert.equal(f.calls.polls, 0);
  assert.equal(f.calls.closes, 1);
  assert.deepEqual(f.events, [{ event: "worker.stopped" }]);
});

test("stop before start closes once and permanently rejects startup", async () => {
  const f = fixture();
  const stopping = f.worker.stop();
  assert.equal(f.worker.stop(), stopping);
  await stopping;
  await assert.rejects(f.worker.start(), /stopping or stopped/);
  assert.equal(f.calls.connections, 0);
  assert.equal(f.calls.closes, 1);
  assert.equal(f.worker.stop(), stopping);
});

test(
  "running shutdown joins the real runner's pending queue boundary",
  { timeout: 2000 },
  async (context) => {
    const polling = gate();
    const f = fixture({ polling: polling.wait });
    context.after(async () => {
      polling.release();
      await f.worker.stop();
    });
    await f.worker.start();
    await polling.entered;
    await assert.rejects(f.worker.start(), /already been started/);
    const first = f.worker.stop();
    const second = f.worker.stop();
    assert.equal(first, second);
    await setImmediate();
    assert.equal(f.calls.closes, 0);
    polling.release();
    await Promise.all([first, second]);
    assert.equal(f.calls.polls, 1, "the existing runner stops after its pending operation drains");
    assert.equal(f.calls.closes, 1);
    assert.equal(f.events.filter(({ event }) => event === "worker.started").length, 1);
    assert.equal(f.events.filter(({ event }) => event === "worker.stopped").length, 1);
  },
);

for (const stage of ["installation", "iam", "preflight"]) {
  test(`${stage} startup failure retains its error and stop still closes once`, async () => {
    const failure = new Error(`Controlled ${stage} startup failure`);
    const options = {};
    if (stage === "preflight")
      options.preflight = () => {
        throw failure;
      };
    else
      options.read = (table) => {
        if (table === (stage === "installation" ? "installation" : "iam_identities")) throw failure;
      };
    const f = fixture(options);
    await assert.rejects(f.worker.start(), (error) => error === failure);
    await assert.rejects(f.worker.start(), /already been started/);
    const first = f.worker.stop();
    assert.equal(f.worker.stop(), first);
    await first;
    assert.equal(f.calls.closes, 1);
    assert.equal(f.calls.polls, 0);
    assert.deepEqual(f.events, [{ event: "worker.stopped" }]);
  });
}

test(
  "startup and concurrent close failures retain their separate identities",
  { timeout: 2000 },
  async () => {
    const startup = gate();
    const initial = new Error("Controlled startup failure");
    const cleanup = new Error("Controlled close failure");
    const f = fixture({
      preflight: startup.wait,
      close() {
        throw cleanup;
      },
    });
    const starting = f.worker.start();
    const rejectedStart = assert.rejects(starting, (error) => error === initial);
    await startup.entered;
    const stopping = f.worker.stop();
    assert.equal(f.worker.stop(), stopping);
    const rejectedStop = assert.rejects(stopping, (error) => error === cleanup);
    startup.reject(initial);
    await Promise.all([rejectedStart, rejectedStop]);
    assert.equal(f.worker.stop(), stopping);
    await assert.rejects(f.worker.stop(), (error) => error === cleanup);
    await assert.rejects(f.worker.start(), /stopping or stopped/);
    assert.equal(f.calls.closes, 1);
    assert.equal(f.events.length, 0);
  },
);
