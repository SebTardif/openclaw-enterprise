import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import pg from "pg";

// Real pg-pool and the real owner-selected Client constructor, with the native
// Client's network methods replaced in this test process. No socket is opened.
// This is protocol/source evidence, not a PostgreSQL or composition test.
const original = {
  connect: pg.Client.prototype.connect,
  query: pg.Client.prototype.query,
  end: pg.Client.prototype.end,
  acquire: pg.Pool.prototype._acquireClient,
  release: pg.Pool.prototype._release,
};
const scenarios = new Map();
let nextDatabase = 0;
pg.Client.prototype.connect = function (callback) {
  const scenario = scenarios.get(this.database);
  if (!scenario) {
    throw new Error("Unexpected synthetic client");
  }
  scenario.client = this;
  scenario.observedBeforeConnect = this.listenerCount("error") > 0;
  scenario.connects += 1;
  this._txStatus = "I";
  this.readyForQuery = true;
  if (scenario.stallCheckout) {
    scenario.completeCheckout = () => callback(null);
  } else {
    queueMicrotask(() => callback(null));
  }
};
pg.Client.prototype.query = async function (sql, args) {
  const scenario = scenarios.get(this.database);
  if (!scenario) {
    throw new Error("Unexpected synthetic query");
  }
  scenario.calls.push({ sql, args, client: this });
  if (scenario.step) {
    const result = await scenario.step(sql, () =>
      this.emit("error", new Error("synthetic transport")),
    );
    if (result !== undefined) {
      return result;
    }
  }
  if (sql.startsWith("BEGIN")) {
    return { command: "BEGIN", rowCount: null, rows: [] };
  }
  if (sql === "COMMIT") {
    return { command: "COMMIT", rowCount: null, rows: [] };
  }
  return { rowCount: 1, rows: [scenario.row ?? { status: "allowed", retry_after_seconds: null }] };
};
pg.Client.prototype.end = function (callback) {
  this._ending = true;
  const scenario = scenarios.get(this.database);
  if (scenario?.endThrows && scenario.privateClients.includes(this)) {
    if (callback && scenario.retainEndBeforeThrow) {
      scenario.pendingEnds.push(callback);
    }
    throw new Error("synthetic native end failure");
  }
  if (callback && scenario?.holdEnd && scenario.privateClients.includes(this)) {
    scenario.pendingEnds.push(callback);
  } else if (callback) {
    queueMicrotask(callback);
  }
  return Promise.resolve();
};
pg.Pool.prototype._acquireClient = function (client, ...args) {
  const scenario = scenarios.get(client.database);
  if (!scenario) {
    throw new Error("Unexpected synthetic pool acquisition");
  }
  scenario.pools.add(this);
  if (this !== scenario.publicPool) {
    scenario.privateClients.push(client);
    scenario.privatePeak = Math.max(scenario.privatePeak, this.totalCount);
  }
  const result = original.acquire.call(this, client, ...args);
  if (scenario.onThrows) {
    const on = client.on;
    client.on = function (event, listener) {
      if (event === "error") {
        scenario.errorRegistrationAttempts = (scenario.errorRegistrationAttempts ?? 0) + 1;
        throw new Error("synthetic observer registration failure");
      }
      return on.call(this, event, listener);
    };
  }
  return result;
};
pg.Pool.prototype._release = function (client, idleListener, error) {
  const scenario = scenarios.get(client.database);
  if (!scenario) {
    throw new Error("Unexpected synthetic pool release");
  }
  scenario.releases.push(error === true);
  if (scenario.releaseEvent) {
    client.emit("error", new Error("synthetic release event"));
  }
  if (scenario.releaseThrows) {
    throw new Error("synthetic failed release");
  }
  return original.release.call(this, client, idleListener, error);
};
// Import after installing the no-socket transport so the owner's captured
// native disposal operation is the instrumented method in this test process.
const { createPostgresStateWithPasswordBudget, matchesPostgresPasswordBudgetPair } =
  await import("../../packages/occ/src/state/postgres-password-attempt-budget.ts");
const {
  beginPasswordBudgetCheckout,
  checkoutPasswordBudgetClient,
  createPostgresPasswordBudgetPool,
  createPostgresPool,
  freezePasswordBudgetTls,
  preparePasswordBudgetWorkloadOptions,
} = await import("../../packages/occ/src/state/postgres-pool.ts");
const { PostgresPlatformState } = await import("../../packages/occ/src/state/postgres-state.ts");
test.after(() => {
  pg.Client.prototype.connect = original.connect;
  pg.Client.prototype.query = original.query;
  pg.Client.prototype.end = original.end;
  pg.Pool.prototype._acquireClient = original.acquire;
  pg.Pool.prototype._release = original.release;
});

async function harness(t, options = {}) {
  const database = `synthetic_budget_${++nextDatabase}`;
  const scenario = {
    ...options,
    calls: [],
    releases: [],
    connects: 0,
    pools: new Set(),
    privateClients: [],
    privatePeak: 0,
    pendingEnds: [],
  };
  scenarios.set(database, scenario);
  const pool = await createPostgresPasswordBudgetPool(`postgresql://localhost/${database}`, {
    authMode: "password",
    max: 1,
  });
  scenario.publicPool = pool;
  scenario.pools.add(pool);
  t.after(async () => {
    // A throwing synthetic release deliberately leaves a pool client behind.
    // The test owns this no-socket pool and settles it explicitly.
    for (const ownedPool of scenario.pools) {
      for (const client of [...ownedPool._clients]) {
        ownedPool._remove(client);
      }
    }
    if (!pool.ending) {
      if (options.onThrows || options.releaseThrows || options.endThrows) {
        await assert.rejects(pool.end(), /disposal is uncertain/);
      } else {
        await pool.end();
      }
    }
    scenarios.delete(database);
  });
  const confirmation = new Uint8Array(32).fill(7);
  const binding = {
    installationId: "ins_synthetic",
    epoch: "1",
    keyConfirmation: confirmation,
    transactionTimeoutMs: options.timeout ?? 200,
  };
  const pair = createPostgresStateWithPasswordBudget(pool, {}, binding);
  return { ...pair, pair, pool, scenario, confirmation, binding };
}

test("allowed result requires BEGIN, fixed reservation SQL and acknowledged COMMIT", async (t) => {
  const h = await harness(t);
  assert.ok(h.state instanceof PostgresPlatformState);
  h.confirmation.fill(9);
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32).fill(3)), {
    status: "allowed",
  });
  assert.deepEqual(
    h.scenario.calls.map(({ sql }) => sql),
    [
      "BEGIN ISOLATION LEVEL READ COMMITTED",
      "SELECT status, retry_after_seconds FROM occ.reserve_password_attempt($1, $2, $3, $4)",
      "COMMIT",
    ],
  );
  assert.equal(h.scenario.calls[1].args[0], "ins_synthetic");
  assert.equal(h.scenario.calls[1].args[1], "1");
  assert.deepEqual(h.scenario.calls[1].args[2], Buffer.alloc(32, 7));
  assert.deepEqual(h.scenario.calls[1].args[3], Buffer.alloc(32, 3));
  assert.deepEqual(h.scenario.releases, [true]);
});

test("limited and cleanup-unavailable results require acknowledged COMMIT", async (t) => {
  const limited = await harness(t, { row: { status: "limited", retry_after_seconds: 23 } });
  assert.deepEqual(await limited.passwordBudget.reserve(new Uint8Array(32)), {
    status: "limited",
    retryAfterSeconds: 23,
  });
  const clean = await harness(t, { row: { status: "unavailable", retry_after_seconds: null } });
  assert.deepEqual(await clean.passwordBudget.reserve(new Uint8Array(32)), {
    status: "unavailable",
  });
  assert.equal(clean.scenario.calls.at(-1).sql, "COMMIT");
  const lost = await harness(t, {
    row: { status: "unavailable", retry_after_seconds: null },
    step(sql) {
      if (sql === "COMMIT") {
        throw new Error("synthetic lost COMMIT");
      }
    },
  });
  assert.deepEqual(await lost.passwordBudget.reserve(new Uint8Array(32)), { status: "unknown" });
  assert.equal(lost.scenario.calls.at(-1).sql, "COMMIT");
});

test("invalid input and malformed responses never authorize work or COMMIT", async (t) => {
  const h = await harness(t);
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(31)), { status: "unavailable" });
  assert.equal(h.scenario.calls.length, 0);
  for (const row of [
    { status: "allowed", retry_after_seconds: 1 },
    { status: "limited", retry_after_seconds: 0 },
    { status: "limited", retry_after_seconds: 1.5 },
    { status: "allowed" },
    { status: "unavailable", retry_after_seconds: 1 },
    { status: "unavailable" },
    { status: "other", retry_after_seconds: null },
    { status: "allowed", retry_after_seconds: null, unexpected: true },
    {
      get status() {
        return "allowed";
      },
      retry_after_seconds: null,
    },
    Object.assign(Object.create({ status: "allowed" }), { retry_after_seconds: null }),
  ]) {
    const bad = await harness(t, { row });
    assert.deepEqual(await bad.passwordBudget.reserve(new Uint8Array(32)), {
      status: "unavailable",
    });
    assert.equal(
      bad.scenario.calls.some(({ sql }) => sql === "COMMIT"),
      false,
    );
    assert.deepEqual(bad.scenario.releases, [true]);
  }
});

test("registration failure with throwing release retains the preinstalled owner listener", async (t) => {
  const h = await harness(t, { onThrows: true });
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "unavailable" });
  assert.deepEqual(h.scenario.calls, []);
  // The first throw is the budget listener registration; the second is
  // pg-pool's attempted idle-listener registration during release.
  assert.equal(h.scenario.errorRegistrationAttempts, 2);
  assert.equal(h.scenario.client.listenerCount("error") >= 1, true);
  assert.doesNotThrow(() => h.scenario.client.emit("error", new Error("late error")));
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "unavailable" });
  assert.equal(h.scenario.connects, 1);
});

test("an error during BEGIN or reservation prevents later SQL", async (t) => {
  for (const stage of ["BEGIN", "SELECT"]) {
    const h = await harness(t, {
      step(sql, emit) {
        if (sql.startsWith(stage)) {
          emit();
        }
      },
    });
    assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "unavailable" });
    assert.equal(h.scenario.calls.at(-1).sql.startsWith(stage), true);
    assert.equal(
      h.scenario.calls.some(({ sql }) => sql === "COMMIT"),
      false,
    );
  }
});

test("query rejection without an event discards without further SQL", async (t) => {
  const h = await harness(t, {
    step(sql) {
      if (sql.startsWith("SELECT")) {
        throw new Error("query rejected");
      }
    },
  });
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "unavailable" });
  assert.equal(h.scenario.calls.length, 2);
  assert.equal(h.scenario.calls.at(-1).sql.startsWith("SELECT"), true);
  assert.deepEqual(h.scenario.releases, [true]);
});

test("failed or malformed COMMIT and release-time event are unknown without replay", async (t) => {
  for (const options of [
    {
      step(sql) {
        if (sql === "COMMIT") {
          throw new Error("lost COMMIT");
        }
      },
    },
    {
      step(sql) {
        if (sql === "COMMIT") {
          return { command: "ROLLBACK", rowCount: null, rows: [] };
        }
      },
    },
    {
      step(sql) {
        if (sql === "COMMIT") {
          return { rowCount: null, rows: [] };
        }
      },
    },
    { releaseEvent: true },
    { releaseThrows: true },
  ]) {
    const h = await harness(t, options);
    assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "unknown" });
    assert.equal(h.scenario.calls.at(-1).sql, "COMMIT");
    assert.equal(
      h.scenario.calls.some(({ sql }) => sql === "ROLLBACK"),
      false,
    );
    assert.deepEqual(h.scenario.releases, [true]);
  }
});

test("stalled COMMIT is unknown and never sends ROLLBACK", async (t) => {
  const h = await harness(t, {
    timeout: 25,
    step(sql) {
      if (sql === "COMMIT") {
        return new Promise(() => {});
      }
    },
  });
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "unknown" });
  assert.equal(h.scenario.calls.at(-1).sql, "COMMIT");
  assert.deepEqual(h.scenario.releases, [true]);
});

test("failed discard retains the owner observer and closes further admission", async (t) => {
  for (const mode of ["before", "unknown", "after"]) {
    const h = await harness(t, {
      releaseThrows: true,
      step(sql) {
        if (mode === "before" && sql.startsWith("SELECT")) {
          throw new Error("query failure");
        }
        if (mode === "unknown" && sql === "COMMIT") {
          throw new Error("lost COMMIT");
        }
      },
    });
    assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), {
      status: mode === "before" ? "unavailable" : "unknown",
    });
    assert.ok(h.scenario.client.listenerCount("error") >= 1);
    // The pool's idle forwarding may run too; both owner observers remain.
    assert.doesNotThrow(() => h.scenario.client.emit("error", new Error("late event")));
    assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "unavailable" });
    assert.equal(h.scenario.connects, 1);
  }
});

test("failed private disposal closes admission for every pair sharing the owner", async (t) => {
  const h = await harness(t, { releaseThrows: true });
  const other = createPostgresStateWithPasswordBudget(h.pool, {}, h.binding);
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "unknown" });
  assert.deepEqual(await other.passwordBudget.reserve(new Uint8Array(32)), {
    status: "unavailable",
  });
  assert.equal(h.scenario.privateClients.length, 1);
  assert.ok(h.scenario.client.listenerCount("error") >= 1);
});

test("unowned pools, proxies, caller Client overrides and forged pairs cannot establish trust", async (t) => {
  const binding = {
    installationId: "ins_synthetic",
    epoch: "1",
    keyConfirmation: new Uint8Array(32),
    transactionTimeoutMs: 100,
  };
  let fakeCheckout = 0;
  const fake = Object.assign(new EventEmitter(), {
    connect() {
      fakeCheckout++;
    },
    async end() {},
  });
  for (const pool of [undefined, null, {}, fake, new pg.Pool({})]) {
    assert.throws(() => createPostgresStateWithPasswordBudget(pool, {}, binding), TypeError);
  }
  assert.equal(fakeCheckout, 0);
  const h = await harness(t);
  assert.throws(
    () => createPostgresStateWithPasswordBudget(new Proxy(h.pool, {}), {}, h.binding),
    TypeError,
  );
  assert.throws(() => {
    h.pool.Client = class {};
  }, TypeError);
  assert.equal(matchesPostgresPasswordBudgetPair({ ...h.pair }, h.state, h.binding, h.pool), false);
  assert.equal(
    matchesPostgresPasswordBudgetPair(h.pair, h.state, h.binding, new Proxy(h.pool, {})),
    false,
  );
  assert.equal(matchesPostgresPasswordBudgetPair(h.pair, h.state, h.binding, h.pool), true);
  assert.equal(matchesPostgresPasswordBudgetPair(h.pair, {}, h.binding, h.pool), false);
  assert.equal(
    matchesPostgresPasswordBudgetPair(
      h.pair,
      h.state,
      { ...h.binding, installationId: "other" },
      h.pool,
    ),
    false,
  );
  assert.equal(
    matchesPostgresPasswordBudgetPair(h.pair, h.state, { ...h.binding, epoch: "2" }, h.pool),
    false,
  );
  assert.equal(
    matchesPostgresPasswordBudgetPair(
      h.pair,
      h.state,
      { ...h.binding, keyConfirmation: new Uint8Array(32) },
      h.pool,
    ),
    false,
  );
  assert.equal(matchesPostgresPasswordBudgetPair(h.pair, h.state, h.binding, null), false);
});

test("owner observer exists before native connection and survives normal removal APIs", async (t) => {
  const h = await harness(t);
  await h.passwordBudget.reserve(new Uint8Array(32));
  const client = h.scenario.client;
  assert.equal(h.scenario.observedBeforeConnect, true);
  const listeners = EventEmitter.prototype.listeners.call(client, "error");
  assert.ok(listeners.length >= 1);
  client.removeAllListeners("error");
  for (const listener of listeners) {
    client.removeListener("error", listener);
  }
  assert.ok(client.listenerCount("error") >= 1);
  h.pool.removeAllListeners("error");
  assert.ok(h.pool.listenerCount("error") >= 1);
  assert.doesNotThrow(() => client.emit("error", new Error("late error")));
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "unavailable" });
});

test("timed-out checkout closes admission and late client is discarded without SQL", async (t) => {
  const h = await harness(t, { stallCheckout: true, timeout: 25 });
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "unavailable" });
  h.scenario.completeCheckout();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.scenario.calls, []);
  assert.deepEqual(h.scenario.releases, [true]);
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "unavailable" });
  assert.equal(h.scenario.connects, 1);
});

test("the supported constructor ignores unadvertised Client and callback options", async (t) => {
  let invoked = false;
  class Intruder {
    constructor() {
      invoked = true;
    }
  }
  const pool = await createPostgresPasswordBudgetPool("postgresql://localhost/synthetic_factory", {
    authMode: "password",
    Client: Intruder,
    onConnect() {
      invoked = true;
    },
  });
  t.after(() => pool.end());
  assert.notEqual(pool.Client, Intruder);
  assert.equal(pool.options.onConnect, undefined);
  assert.equal(invoked, false);
  assert.throws(() => {
    pool.Client = Intruder;
  }, TypeError);
  assert.throws(() => {
    pool.newClient = () => {};
  }, TypeError);
  assert.throws(() => {
    pool.options.onConnect = () => {};
  }, TypeError);
  assert.throws(() => {
    pool.options = {};
  }, TypeError);
});

test("workload URLs reject injected hooks before provider setup", async () => {
  for (const key of ["verify", "onConnect", "Promise", "Client", "stream", "connection", "log"]) {
    const url = new URL("postgresql://occ_app@localhost/synthetic?sslmode=verify-full");
    url.searchParams.set(key, "synthetic");
    await assert.rejects(
      createPostgresPasswordBudgetPool(url.toString(), { authMode: "azure-workload-identity" }),
      { message: "Unsupported password budget database URL option." },
    );
  }
});

test("workload URL timeouts and options survive unless explicitly overridden", () => {
  const url =
    "postgresql://occ_app@localhost/synthetic?sslmode=verify-full&statement_timeout=5000&query_timeout=3000&options=-c%20lock_timeout%3D1000";
  const inherited = preparePasswordBudgetWorkloadOptions(url);
  assert.equal(inherited.statement_timeout, "5000");
  assert.equal(inherited.query_timeout, "3000");
  assert.equal(inherited.options, "-c lock_timeout=1000");
  assert.ok(inherited.ssl);
  assert.equal(Object.isFrozen(inherited.ssl), true);
  const overridden = preparePasswordBudgetWorkloadOptions(url, {
    statement_timeout: 8000,
    query_timeout: 2000,
    options: "-c lock_timeout=2000",
  });
  assert.equal(overridden.statement_timeout, 8000);
  assert.equal(overridden.query_timeout, 2000);
  assert.equal(overridden.options, "-c lock_timeout=2000");
});

test("workload TLS cannot be weakened after preparation and supports key and certificate", () => {
  const ssl = freezePasswordBudgetTls({
    rejectUnauthorized: true,
    ca: "synthetic-ca",
    cert: "synthetic-cert",
    key: "synthetic-key",
  });
  assert.equal(ssl.ca, "synthetic-ca");
  assert.equal(ssl.cert, "synthetic-cert");
  assert.equal(ssl.key, "synthetic-key");
  assert.throws(() => {
    ssl.rejectUnauthorized = false;
  }, TypeError);
  assert.throws(() => {
    ssl.checkServerIdentity = () => undefined;
  }, TypeError);
  assert.throws(() => {
    ssl.ca = "changed";
  }, TypeError);
  // Real constructors exercise their key-hiding logic; no connect occurs.
  assert.doesNotThrow(() => new pg.Client({ ssl }));
  assert.doesNotThrow(() => new pg.Pool({ ssl }));
});

test("a public pooled pending BEGIN or prior transaction is isolated from budget SQL", async (t) => {
  for (const mode of ["pending", "open", "unknown-shape"]) {
    const h = await harness(t);
    const oldClient = await h.pool.connect();
    if (mode === "pending") {
      oldClient._activeQuery = {};
      oldClient.readyForQuery = false;
    } else if (mode === "open") {
      oldClient._txStatus = "T";
    } else {
      oldClient._sentQueryQueue = undefined;
    }
    oldClient.release(false);
    assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "allowed" });
    assert.notEqual(h.scenario.privateClients[0], oldClient);
    assert.deepEqual(h.scenario.releases, [false, true]);
    const budgetCalls = h.scenario.calls.length;
    // A later completion from the public client's synthetic operation cannot
    // become a query on the separately owned budget client.
    oldClient._activeQuery = null;
    oldClient._txStatus = "T";
    oldClient.readyForQuery = true;
    assert.equal(h.scenario.calls.length, budgetCalls);
  }
});

test("the real pg timeout leaves a sent BEGIN pending and the budget does not reuse it", async (t) => {
  const h = await harness(t);
  const oldClient = await h.pool.connect();
  const sent = [];
  // Exercise pg's real non-pipeline query timeout against a synthetic
  // transport; no backend, socket or provider is involved.
  oldClient.connection.query = (text) => sent.push(text);
  const priorBegin = original.query.call(oldClient, { text: "BEGIN", query_timeout: 20 });
  await assert.rejects(priorBegin, { message: "Query read timeout" });
  assert.deepEqual(sent, ["BEGIN"]);
  assert.notEqual(oldClient._activeQuery, null);
  oldClient.release(false);
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "allowed" });
  assert.notEqual(h.scenario.privateClients[0], oldClient);
  assert.deepEqual(h.scenario.releases, [false, true]);
  const budgetCalls = h.scenario.calls.length;
  // Simulate the late ReadyForQuery from that previous BEGIN.
  oldClient._handleReadyForQuery({ status: "T" });
  assert.equal(h.scenario.calls.length, budgetCalls);
});

test("a fully settled public pooled client remains reusable for ordinary work", async (t) => {
  const h = await harness(t);
  const previous = await h.pool.connect();
  previous.release(false);
  const reused = await h.pool.connect();
  assert.equal(reused, previous);
  reused.release(false);
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "allowed" });
  assert.notEqual(h.scenario.privateClients[0], previous);
  assert.deepEqual(h.scenario.releases, [false, false, true]);
});

test("a former borrower and public pool listeners cannot reach the budget client", async (t) => {
  let entered;
  let resume;
  const enteredReservation = new Promise((resolve) => {
    entered = resolve;
  });
  const resumeReservation = new Promise((resolve) => {
    resume = resolve;
  });
  const h = await harness(t, {
    async step(sql) {
      if (sql.startsWith("SELECT")) {
        entered();
        await resumeReservation;
      }
    },
  });
  const observed = [];
  h.pool.on("connect", (client) => observed.push(client));
  h.pool.on("acquire", (client) => observed.push(client));
  h.pool.on("release", (_error, client) => observed.push(client));
  const previous = await h.pool.connect();
  previous.release(false);
  const pending = h.passwordBudget.reserve(new Uint8Array(32));
  await enteredReservation;
  const budgetClient = h.scenario.privateClients.at(-1);
  assert.notEqual(budgetClient, previous);
  assert.ok(observed.length > 0);
  assert.equal(observed.includes(budgetClient), false);
  await previous.query("UNRELATED TEST OPERATION");
  resume();
  assert.deepEqual(await pending, { status: "allowed" });
  const extra = h.scenario.calls.find(({ sql }) => sql === "UNRELATED TEST OPERATION");
  const protectedCalls = h.scenario.calls.filter(({ sql }) => sql !== "UNRELATED TEST OPERATION");
  assert.equal(extra.client, previous);
  assert.ok(protectedCalls.every(({ client }) => client === budgetClient));
  assert.deepEqual(
    protectedCalls.map(({ sql }) => (sql.startsWith("SELECT") ? "SELECT" : sql)),
    ["BEGIN ISOLATION LEVEL READ COMMITTED", "SELECT", "COMMIT"],
  );
});

test("even a previous private checkout cannot reuse its physical client", async (t) => {
  const h = await harness(t);
  const previous = await checkoutPasswordBudgetClient(h.pool, 100);
  assert.throws(() => {
    previous.end = (callback) => callback();
  }, TypeError);
  // A mutable pg-pool use counter is not the owner's custody authority.
  previous._poolUseCount = -100;
  previous.release(false);
  assert.equal(previous._ending, true);
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "allowed" });
  const current = h.scenario.privateClients.at(-1);
  assert.notEqual(current, previous);
  assert.equal(h.scenario.privatePeak, 1);
  assert.ok(h.scenario.calls.every(({ client }) => client === current));
});

test("concurrent reservations use at most one private client and never reuse it", async (t) => {
  let entered;
  let resume;
  let selections = 0;
  const enteredFirst = new Promise((resolve) => {
    entered = resolve;
  });
  const resumeFirst = new Promise((resolve) => {
    resume = resolve;
  });
  const h = await harness(t, {
    async step(sql) {
      if (sql.startsWith("SELECT") && ++selections === 1) {
        entered();
        await resumeFirst;
      }
    },
  });
  const first = h.passwordBudget.reserve(new Uint8Array(32));
  await enteredFirst;
  const second = h.passwordBudget.reserve(new Uint8Array(32).fill(1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.scenario.privateClients.length, 1);
  resume();
  assert.deepEqual(await Promise.all([first, second]), [
    { status: "allowed" },
    { status: "allowed" },
  ]);
  assert.equal(h.scenario.privateClients.length, 2);
  assert.notEqual(h.scenario.privateClients[0], h.scenario.privateClients[1]);
  assert.equal(h.scenario.privatePeak, 1);
});

test("a replacement waits for the prior private client's actual end callback", async (t) => {
  const h = await harness(t, { holdEnd: true, timeout: 500 });
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "allowed" });
  assert.equal(h.scenario.pendingEnds.length, 1);
  const second = h.passwordBudget.reserve(new Uint8Array(32).fill(1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.scenario.privateClients.length, 1);
  h.scenario.holdEnd = false;
  h.scenario.pendingEnds.shift()();
  assert.deepEqual(await second, { status: "allowed" });
  assert.equal(h.scenario.privateClients.length, 2);
  assert.notEqual(h.scenario.privateClients[0], h.scenario.privateClients[1]);
});

test("a delayed duplicate removal cannot release another client's permit", async (t) => {
  let selections = 0;
  let entered;
  let resume;
  const secondEntered = new Promise((resolve) => {
    entered = resolve;
  });
  const resumeSecond = new Promise((resolve) => {
    resume = resolve;
  });
  const h = await harness(t, {
    timeout: 500,
    async step(sql) {
      if (sql.startsWith("SELECT") && ++selections === 2) {
        entered();
        await resumeSecond;
      }
    },
  });
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "allowed" });
  const prior = h.scenario.privateClients[0];
  const second = h.passwordBudget.reserve(new Uint8Array(32).fill(1));
  await secondEntered;
  const privatePool = [...h.scenario.pools].find((pool) => pool !== h.pool);
  // Models a delayed second remove callback for the old native client.
  privatePool.emit("remove", prior);
  const third = h.passwordBudget.reserve(new Uint8Array(32).fill(2));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.scenario.privateClients.length, 2);
  resume();
  assert.deepEqual(await Promise.all([second, third]), [
    { status: "allowed" },
    { status: "allowed" },
  ]);
  assert.equal(h.scenario.privateClients.length, 3);
});

test("a queued reservation times out without acquiring another private client", async (t) => {
  let entered;
  let resume;
  const enteredFirst = new Promise((resolve) => {
    entered = resolve;
  });
  const resumeFirst = new Promise((resolve) => {
    resume = resolve;
  });
  const h = await harness(t, {
    timeout: 500,
    async step(sql) {
      if (sql.startsWith("SELECT")) {
        entered();
        await resumeFirst;
      }
    },
  });
  const second = createPostgresStateWithPasswordBudget(
    h.pool,
    {},
    {
      ...h.binding,
      transactionTimeoutMs: 25,
    },
  );
  const first = h.passwordBudget.reserve(new Uint8Array(32));
  await enteredFirst;
  assert.deepEqual(await second.passwordBudget.reserve(new Uint8Array(32).fill(1)), {
    status: "unavailable",
  });
  resume();
  assert.deepEqual(await first, { status: "allowed" });
  // The bounded owner gate removes the waiter without submitting another
  // pg-pool checkout.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.scenario.privateClients.length, 1);
  assert.deepEqual(await second.passwordBudget.reserve(new Uint8Array(32)), { status: "allowed" });
  assert.equal(h.scenario.privateClients.length, 2);
});

test("cancellation before native checkout proves no client was acquired", async (t) => {
  const h = await harness(t);
  const attempt = beginPasswordBudgetCheckout(h.pool, 100);
  assert.equal(attempt.cancel(), true);
  await assert.rejects(attempt.client);
  assert.equal(h.scenario.privateClients.length, 0);
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "allowed" });
});

test("the private wait queue is bounded by selected pool capacity", async (t) => {
  let entered;
  let resume;
  let selections = 0;
  const enteredFirst = new Promise((resolve) => {
    entered = resolve;
  });
  const resumeFirst = new Promise((resolve) => {
    resume = resolve;
  });
  const h = await harness(t, {
    timeout: 500,
    async step(sql) {
      if (sql.startsWith("SELECT") && ++selections === 1) {
        entered();
        await resumeFirst;
      }
    },
  });
  const first = h.passwordBudget.reserve(new Uint8Array(32));
  await enteredFirst;
  const second = h.passwordBudget.reserve(new Uint8Array(32).fill(1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32).fill(2)), {
    status: "unavailable",
  });
  assert.equal(h.scenario.privateClients.length, 1);
  resume();
  assert.deepEqual(await Promise.all([first, second]), [
    { status: "allowed" },
    { status: "allowed" },
  ]);
});

test("pool end closes both pools and refuses later reservation admissions", async (t) => {
  const h = await harness(t);
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "allowed" });
  const privatePool = [...h.scenario.pools].find((pool) => pool !== h.pool);
  assert.ok(privatePool);
  await h.pool.end();
  assert.equal(h.pool.ended, true);
  assert.equal(privatePool.ended, true);
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "unavailable" });
});

test("shutdown before native checkout settles without a false disposal fault", async (t) => {
  for (const form of ["promise", "callback"]) {
    const h = await harness(t);
    const admission = beginPasswordBudgetCheckout(h.pool, 100);
    const rejected = assert.rejects(admission.client, /pool unavailable/);
    const ending =
      form === "promise"
        ? h.pool.end()
        : new Promise((resolve, reject) => {
            h.pool.end((error) => (error ? reject(error) : resolve()));
          });
    await rejected;
    await ending;
    assert.equal(h.scenario.connects, 0);
    assert.deepEqual(h.scenario.calls, []);
  }
});

test("shutdown after queued handoff cancels the unused permit in both forms", async (t) => {
  for (const form of ["promise", "callback"]) {
    const h = await harness(t, { holdEnd: true });
    const first = await checkoutPasswordBudgetClient(h.pool, 100);
    const next = checkoutPasswordBudgetClient(h.pool, 100);
    const rejected = assert.rejects(next, /pool unavailable/);
    first.release();
    assert.equal(h.scenario.pendingEnds.length, 1);
    // Resolving the remove event hands over the permit synchronously; the
    // queued continuation has not yet started the native checkout.
    h.scenario.pendingEnds.shift()();
    const ending =
      form === "promise"
        ? h.pool.end()
        : new Promise((resolve, reject) => {
            h.pool.end((error) => (error ? reject(error) : resolve()));
          });
    await rejected;
    await ending;
    assert.equal(h.scenario.connects, 1);
    assert.deepEqual(h.scenario.calls, []);
  }
});

test("a prior selected pool error is retained on clientless shutdown", async (t) => {
  for (const form of ["promise", "callback"]) {
    const h = await harness(t);
    const admission = beginPasswordBudgetCheckout(h.pool, 100);
    const rejected = assert.rejects(admission.client, /pool unavailable/);
    h.pool.emit("error", new Error("synthetic selected pool fault"));
    const ending =
      form === "promise"
        ? h.pool.end()
        : new Promise((resolve, reject) => {
            h.pool.end((error) => (error ? reject(error) : resolve()));
          });
    await rejected;
    await assert.rejects(ending, /pool observation unavailable/);
    assert.equal(h.scenario.connects, 0);
    assert.deepEqual(h.scenario.calls, []);
  }
});

test("a prior private pool error is retained after queued handoff", async (t) => {
  for (const form of ["promise", "callback"]) {
    const h = await harness(t, { holdEnd: true });
    const first = await checkoutPasswordBudgetClient(h.pool, 100);
    const next = checkoutPasswordBudgetClient(h.pool, 100);
    const rejected = assert.rejects(next, /pool unavailable/);
    const privatePool = [...h.scenario.pools].find((pool) => pool !== h.pool);
    assert.ok(privatePool);
    first.release();
    h.scenario.pendingEnds.shift()();
    privatePool.emit("error", new Error("synthetic private pool fault"));
    const ending =
      form === "promise"
        ? h.pool.end()
        : new Promise((resolve, reject) => {
            h.pool.end((error) => (error ? reject(error) : resolve()));
          });
    await rejected;
    await assert.rejects(ending, /pool observation unavailable/);
    assert.equal(h.scenario.connects, 1);
    assert.deepEqual(h.scenario.calls, []);
  }
});

test("cancellation retains a prior selected pool error at clientless shutdown", async (t) => {
  for (const form of ["promise", "callback"]) {
    const h = await harness(t);
    const attempt = beginPasswordBudgetCheckout(h.pool, 100);
    const rejected = assert.rejects(attempt.client, /checkout cancelled/);
    h.pool.emit("error", new Error("synthetic selected pool fault"));
    assert.equal(attempt.cancel(), true);
    const ending =
      form === "promise"
        ? h.pool.end()
        : new Promise((resolve, reject) => {
            h.pool.end((error) => (error ? reject(error) : resolve()));
          });
    await rejected;
    await assert.rejects(ending, /pool observation unavailable/);
    assert.equal(h.scenario.connects, 0);
    assert.deepEqual(h.scenario.calls, []);
  }
});

test("cancellation retains a prior private pool error after queued handoff", async (t) => {
  for (const form of ["promise", "callback"]) {
    const h = await harness(t, { holdEnd: true });
    const first = await checkoutPasswordBudgetClient(h.pool, 100);
    const attempt = beginPasswordBudgetCheckout(h.pool, 100);
    const rejected = assert.rejects(attempt.client, /checkout cancelled/);
    const privatePool = [...h.scenario.pools].find((pool) => pool !== h.pool);
    assert.ok(privatePool);
    first.release();
    h.scenario.pendingEnds.shift()();
    privatePool.emit("error", new Error("synthetic private pool fault"));
    assert.equal(attempt.cancel(), true);
    const ending =
      form === "promise"
        ? h.pool.end()
        : new Promise((resolve, reject) => {
            h.pool.end((error) => (error ? reject(error) : resolve()));
          });
    await rejected;
    await assert.rejects(ending, /pool observation unavailable/);
    assert.equal(h.scenario.connects, 1);
    assert.deepEqual(h.scenario.calls, []);
  }
});

function endInForm(pool, form) {
  return form === "promise"
    ? pool.end()
    : new Promise((resolve, reject) => {
        pool.end((error) => (error ? reject(error) : resolve()));
      });
}

test("shutdown rejects idle selected and private pool faults before and during end", async (t) => {
  for (const form of ["promise", "callback"]) {
    for (const location of ["selected", "private"]) {
      for (const timing of ["before", "during"]) {
        const h = await harness(t);
        let privatePool;
        if (location === "private") {
          const client = await checkoutPasswordBudgetClient(h.pool, 100);
          privatePool = [...h.scenario.pools].find((pool) => pool !== h.pool);
          client.release(true);
          await new Promise((resolve) => setImmediate(resolve));
        }
        const fault = location === "selected" ? h.pool : privatePool;
        assert.ok(fault);
        if (timing === "before") {
          fault.emit("error", new Error("synthetic pool fault"));
        }
        const ending = endInForm(h.pool, form);
        if (timing === "during") {
          fault.emit("error", new Error("synthetic pool fault"));
        }
        await assert.rejects(ending, /pool observation unavailable/);
        assert.equal(h.pool.ended, true);
        if (privatePool) {
          assert.equal(privatePool.ended, true);
        }
        assert.deepEqual(h.scenario.calls, []);
      }
    }
  }
});

test("shutdown waits for active private disposal before reporting observed pool faults", async (t) => {
  for (const form of ["promise", "callback"]) {
    for (const location of ["selected", "private"]) {
      for (const timing of ["before", "during"]) {
        const h = await harness(t, { holdEnd: true });
        const client = await checkoutPasswordBudgetClient(h.pool, 100);
        const privatePool = [...h.scenario.pools].find((pool) => pool !== h.pool);
        assert.ok(privatePool);
        const fault = location === "selected" ? h.pool : privatePool;
        if (timing === "before") {
          fault.emit("error", new Error("synthetic pool fault"));
        }
        let settled = false;
        const ending = endInForm(h.pool, form).then(
          () => {
            settled = true;
            return undefined;
          },
          (error) => {
            settled = true;
            return error;
          },
        );
        if (timing === "during") {
          fault.emit("error", new Error("synthetic pool fault"));
        }
        client.release(true);
        assert.equal(h.scenario.pendingEnds.length, 1);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false);
        h.scenario.pendingEnds.shift()();
        const error = await ending;
        assert.match(error?.message ?? "", /pool observation unavailable/);
        assert.equal(h.pool.ended, true);
        assert.equal(privatePool.ended, true);
        assert.deepEqual(h.scenario.calls, []);
      }
    }
  }
});

test("synchronous selected native end failure still waits for private disposal", async (t) => {
  for (const form of ["promise", "callback"]) {
    const h = await harness(t, { holdEnd: true });
    const privateClient = await checkoutPasswordBudgetClient(h.pool, 100);
    const privatePool = [...h.scenario.pools].find((pool) => pool !== h.pool);
    assert.ok(privatePool);
    const publicClient = await h.pool.connect();
    publicClient.end = () => {
      throw new Error("synthetic selected native end failure");
    };
    publicClient.release();
    let settled = false;
    const ending = endInForm(h.pool, form).then(
      () => {
        settled = true;
        return undefined;
      },
      (error) => {
        settled = true;
        return error;
      },
    );
    privateClient.release(true);
    assert.equal(h.scenario.pendingEnds.length, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    h.scenario.pendingEnds.shift()();
    const error = await ending;
    assert.match(error?.message ?? "", /synthetic selected native end failure/);
    assert.equal(privatePool.ended, true);
    assert.deepEqual(h.scenario.calls, []);
  }
});

test("selected shutdown immediately refuses public checkout like native pg-pool", async (t) => {
  for (const form of ["promise", "callback"]) {
    for (const kind of ["ordinary", "selected"]) {
      const h = await harness(t);
      const pool =
        kind === "selected"
          ? h.pool
          : await createPostgresPool(`postgresql://localhost/${h.pool.options.database}`, {
              authMode: "password",
              max: 1,
            });
      const before = h.scenario.connects;
      const ending = endInForm(pool, form);
      const checkout = pool.connect().then(
        (client) => {
          client.release();
          return undefined;
        },
        (error) => error,
      );
      const error = await checkout;
      await ending;
      assert.match(error?.message ?? "", /Cannot use a pool after calling end/);
      assert.equal(h.scenario.connects, before);
      assert.deepEqual(h.scenario.calls, []);
    }
  }
});

test("selected and ordinary shutdown immediately refuse callback public checkout", async (t) => {
  for (const form of ["promise", "callback"]) {
    for (const kind of ["ordinary", "selected"]) {
      const h = await harness(t);
      const pool =
        kind === "selected"
          ? h.pool
          : await createPostgresPool(`postgresql://localhost/${h.pool.options.database}`, {
              authMode: "password",
              max: 1,
            });
      const before = h.scenario.connects;
      const ending = endInForm(pool, form);
      const error = await new Promise((resolve) => {
        pool.connect((error, client) => {
          if (client) {
            client.release();
          }
          resolve(error);
        });
      });
      await ending;
      assert.match(error?.message ?? "", /Cannot use a pool after calling end/);
      assert.equal(h.scenario.connects, before);
      assert.deepEqual(h.scenario.calls, []);
    }
  }
});

test("callback shutdown reports a pool fault observed before callback delivery", async (t) => {
  for (const location of ["selected", "private"]) {
    const h = await harness(t);
    const client = await checkoutPasswordBudgetClient(h.pool, 100);
    const privatePool = [...h.scenario.pools].find((pool) => pool !== h.pool);
    assert.ok(privatePool);
    client.release(true);
    await new Promise((resolve) => setImmediate(resolve));
    let observed = false;
    const originalAllSettled = Promise.allSettled;
    // Place an error after the native ends and drain settle, but before the
    // wrapper's callback delivery. The original allSettled still runs.
    Promise.allSettled = function (values) {
      const result = originalAllSettled.call(this, values);
      void result.then(() =>
        queueMicrotask(() => {
          observed = true;
          (location === "selected" ? h.pool : privatePool).emit(
            "error",
            new Error("synthetic pool fault"),
          );
        }),
      );
      return result;
    };
    let ending;
    try {
      ending = endInForm(h.pool, "callback");
    } finally {
      Promise.allSettled = originalAllSettled;
    }
    await assert.rejects(ending, /pool observation unavailable/);
    assert.equal(observed, true);
    assert.equal(h.pool.ended, true);
    assert.equal(privatePool.ended, true);
    assert.deepEqual(h.scenario.calls, []);
  }
});

test("shutdown awaits native selected pool end before reporting a pool fault", async (t) => {
  for (const form of ["promise", "callback"]) {
    for (const location of ["selected", "private"]) {
      const h = await harness(t);
      const privateClient = await checkoutPasswordBudgetClient(h.pool, 100);
      const privatePool = [...h.scenario.pools].find((pool) => pool !== h.pool);
      assert.ok(privatePool);
      privateClient.release(true);
      await new Promise((resolve) => setImmediate(resolve));
      const publicClient = await h.pool.connect();
      let settled = false;
      const ending = endInForm(h.pool, form).then(
        () => {
          settled = true;
          return undefined;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      (location === "selected" ? h.pool : privatePool).emit(
        "error",
        new Error("synthetic pool fault"),
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      publicClient.release();
      const error = await ending;
      assert.match(error?.message ?? "", /pool observation unavailable/);
      assert.equal(h.pool.ended, true);
      assert.equal(privatePool.ended, true);
      assert.deepEqual(h.scenario.calls, []);
    }
  }
});

test("shutdown preserves pool faults across in-flight native checkout and disposal", async (t) => {
  for (const form of ["promise", "callback"]) {
    for (const location of ["selected", "private"]) {
      const h = await harness(t);
      const first = await checkoutPasswordBudgetClient(h.pool, 100);
      const privatePool = [...h.scenario.pools].find((pool) => pool !== h.pool);
      assert.ok(privatePool);
      first.release(true);
      await new Promise((resolve) => setImmediate(resolve));
      h.scenario.stallCheckout = true;
      h.scenario.holdEnd = true;
      const attempt = beginPasswordBudgetCheckout(h.pool, 1000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(typeof h.scenario.completeCheckout, "function");
      let settled = false;
      const ending = endInForm(h.pool, form).then(
        () => {
          settled = true;
          return undefined;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      (location === "selected" ? h.pool : privatePool).emit(
        "error",
        new Error("synthetic pool fault"),
      );
      assert.equal(attempt.cancel(), false);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      h.scenario.completeCheckout();
      const client = await attempt.client;
      client.release(true);
      assert.equal(h.scenario.pendingEnds.length, 1);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      h.scenario.pendingEnds.shift()();
      const error = await ending;
      assert.match(error?.message ?? "", /pool observation unavailable/);
      assert.equal(h.pool.ended, true);
      assert.equal(privatePool.ended, true);
      assert.equal(h.scenario.connects, 2);
      assert.deepEqual(h.scenario.calls, []);
    }
  }
});

test("pool end with null follows native Promise compatibility", async (t) => {
  const h = await harness(t);
  const ending = h.pool.end(null);
  assert.equal(typeof ending?.then, "function");
  await ending;
  assert.equal(h.pool.ended, true);
});

test("pool shutdown waits for removed private client end in Promise and callback forms", async (t) => {
  for (const form of ["promise", "callback"]) {
    const h = await harness(t, { holdEnd: true });
    assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "allowed" });
    assert.equal(h.scenario.pendingEnds.length, 1);
    let settled = false;
    const ending =
      form === "promise"
        ? h.pool.end().then(() => {
            settled = true;
          })
        : new Promise((resolve, reject) => {
            h.pool.end((error) => {
              if (error) {
                reject(error);
              } else {
                settled = true;
                resolve();
              }
            });
          });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false);
    h.scenario.holdEnd = false;
    h.scenario.pendingEnds.shift()();
    await ending;
    assert.equal(settled, true);
  }
});

test("a callback retained before end throws keeps shutdown pending until local observation", async (t) => {
  const h = await harness(t, { endThrows: true, retainEndBeforeThrow: true });
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "unknown" });
  assert.equal(h.scenario.pendingEnds.length, 1);
  let settled = false;
  const ending = h.pool.end().then(
    () => {
      settled = true;
      throw new Error("unexpected clean shutdown");
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "unavailable" });
  h.scenario.pendingEnds.shift()();
  assert.match((await ending).message, /disposal is uncertain/);
  assert.equal(settled, true);
  // A local end callback is not evidence of PostgreSQL backend settlement.
});

test("pool shutdown rejects queued waiters and waits for the active client", async (t) => {
  let entered;
  let resume;
  const enteredFirst = new Promise((resolve) => {
    entered = resolve;
  });
  const resumeFirst = new Promise((resolve) => {
    resume = resolve;
  });
  const h = await harness(t, {
    timeout: 500,
    async step(sql) {
      if (sql.startsWith("SELECT")) {
        entered();
        await resumeFirst;
      }
    },
  });
  const first = h.passwordBudget.reserve(new Uint8Array(32));
  await enteredFirst;
  const queued = h.passwordBudget.reserve(new Uint8Array(32).fill(1));
  await new Promise((resolve) => setImmediate(resolve));
  const ending = h.pool.end();
  assert.deepEqual(await queued, { status: "unavailable" });
  assert.equal(h.scenario.privateClients.length, 1);
  resume();
  assert.deepEqual(await first, { status: "unavailable" });
  await ending;
  assert.equal(h.pool.ended, true);
});

test("pool end still settles the public pool if the private end fails", async (t) => {
  const h = await harness(t);
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "allowed" });
  const privatePool = [...h.scenario.pools].find((pool) => pool !== h.pool);
  await privatePool.end();
  await assert.rejects(h.pool.end());
  assert.equal(h.pool.ended, true);
  assert.equal(privatePool.ended, true);
  assert.deepEqual(await h.passwordBudget.reserve(new Uint8Array(32)), { status: "unavailable" });
});

test("ordinary pool factory remains separate from the trusted password pool", async (t) => {
  const ordinary = await createPostgresPool("postgresql://localhost/ordinary", {
    authMode: "password",
    max: 2,
  });
  t.after(() => ordinary.end());
  assert.equal(ordinary.options.max, 2);
  assert.throws(
    () =>
      createPostgresStateWithPasswordBudget(
        ordinary,
        {},
        {
          installationId: "ins_synthetic",
          epoch: "1",
          keyConfirmation: new Uint8Array(32),
          transactionTimeoutMs: 100,
        },
      ),
    TypeError,
  );
});

test("invalid epoch or confirmation cannot bind a pair", async (t) => {
  const h = await harness(t);
  for (const epoch of ["0", "01", "-1", "9223372036854775808", "bad"]) {
    assert.throws(
      () => createPostgresStateWithPasswordBudget(h.pool, {}, { ...h.binding, epoch }),
      TypeError,
    );
  }
  assert.throws(
    () =>
      createPostgresStateWithPasswordBudget(
        h.pool,
        {},
        { ...h.binding, keyConfirmation: new Uint8Array(31) },
      ),
    TypeError,
  );
});
