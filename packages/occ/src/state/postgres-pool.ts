import pg from "pg";
import { EventEmitter } from "node:events";
import { parseIntoClientConfig } from "pg-connection-string";

type PoolLimits = Pick<
  pg.PoolConfig,
  "max" | "connectionTimeoutMillis" | "statement_timeout" | "query_timeout" | "options"
> & { readonly authMode?: string };

type OwnedPool = {
  readonly listener: (error: Error) => void;
  faulted: boolean;
  ending: boolean;
};
type OwnedClient = {
  readonly pool: pg.Pool;
  readonly listener: (error: Error) => void;
  faulted: boolean;
};
const ownedPools = new WeakMap<pg.Pool, OwnedPool>();
const ownedClients = new WeakMap<pg.Client, OwnedClient>();
type ReservationWaiter = {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
};
type ReservationGate = {
  active: boolean;
  activeClient: pg.Client | undefined;
  faulted: boolean;
  failure?: Error;
  ending: boolean;
  readonly maxWaiters: number;
  readonly waiters: Set<ReservationWaiter>;
  readonly drains: Set<{ resolve: () => void; reject: (error: Error) => void }>;
};
// Only this module can find the reservation pool belonging to a selected
// State/auth pool. It is never handed to application pool event listeners.
const reservationPools = new WeakMap<pg.Pool, pg.Pool>();
const reservationGates = new WeakMap<pg.Pool, ReservationGate>();
// Capture the real implementation, rather than dispatching through a supplied
// pool's virtual connect method. This protects only this in-process boundary.
const checkout = pg.Pool.prototype.connect as (this: pg.Pool) => Promise<pg.PoolClient>;
const endPool = pg.Pool.prototype.end as (this: pg.Pool) => Promise<void>;
const endClient = pg.Client.prototype.end;
const abortSignalGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

function beginNativePoolEnd(pool: pg.Pool): Promise<void> {
  try {
    return Promise.resolve(endPool.call(pool));
  } catch (error) {
    return Promise.reject(error);
  }
}

function isAborted(signal?: AbortSignal): boolean {
  if (signal === undefined) {
    return false;
  }
  if (abortSignalGetter === undefined) {
    throw new Error("Abort signal unavailable.");
  }
  return abortSignalGetter.call(signal) === true;
}

// Protect the owner's listener against normal removeListener/off and
// removeAllListeners calls, while leaving all other listeners under the
// caller's ordinary control. Same-process code that directly mutates emitter
// internals is outside this local composition contract.
function retainOwnerListener(emitter: EventEmitter, ownerListener: (error: Error) => void): void {
  const remove = (event: string | symbol, listener: (...args: unknown[]) => void) => {
    if (event !== "error" || listener !== ownerListener) {
      EventEmitter.prototype.removeListener.call(emitter, event, listener);
    }
    return emitter;
  };
  const removeAll = (event?: string | symbol) => {
    const events = event === undefined ? EventEmitter.prototype.eventNames.call(emitter) : [event];
    for (const name of events) {
      for (const listener of EventEmitter.prototype.rawListeners.call(emitter, name)) {
        if (name !== "error" || listener !== ownerListener) {
          EventEmitter.prototype.removeListener.call(emitter, name, listener);
        }
      }
    }
    return emitter;
  };
  Object.defineProperties(emitter, {
    removeListener: { value: remove, writable: false, configurable: false },
    off: { value: remove, writable: false, configurable: false },
    removeAllListeners: { value: removeAll, writable: false, configurable: false },
  });
}

function createObservedPool(config: pg.PoolConfig, protectDisposal = false): pg.Pool {
  class ObservedClient extends pg.Client {
    constructor(options?: pg.ClientConfig) {
      super(options);
      const observation: OwnedClient = {
        pool: owner,
        listener: () => {
          observation.faulted = true;
        },
        faulted: false,
      };
      // Install before pg-pool can connect or hand out the client. Keep the
      // observer even if an ordinary release/disposal attempt throws.
      EventEmitter.prototype.on.call(this, "error", observation.listener);
      if (!EventEmitter.prototype.listeners.call(this, "error").includes(observation.listener)) {
        throw new Error("PostgreSQL client observation unavailable.");
      }
      retainOwnerListener(this, observation.listener);
      if (protectDisposal) {
        // Do not accept a borrower's replacement that can pretend disposal
        // finished without invoking the captured native client operation.
        Object.defineProperty(this, "end", {
          value: endClient,
          writable: false,
          configurable: false,
        });
      }
      ownedClients.set(this, observation);
    }
  }
  Object.freeze(ObservedClient.prototype);
  const owner: pg.Pool = new pg.Pool({ ...config, Client: ObservedClient });
  // pg-pool uses this.Client for each checkout, independent of options.Client.
  // Freeze that selection before exposing the pool to composition.
  Object.defineProperty(owner, "Client", {
    value: ObservedClient,
    writable: false,
    configurable: false,
  });
  Object.freeze(owner.options);
  Object.defineProperty(owner, "options", {
    value: owner.options,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(owner, "newClient", {
    value: Reflect.get(Object.getPrototypeOf(owner), "newClient"),
    writable: false,
    configurable: false,
  });
  const observation: OwnedPool = {
    listener: () => {
      observation.faulted = true;
    },
    faulted: false,
    ending: false,
  };
  EventEmitter.prototype.on.call(owner, "error", observation.listener);
  if (!EventEmitter.prototype.listeners.call(owner, "error").includes(observation.listener)) {
    throw new Error("PostgreSQL pool observation unavailable.");
  }
  retainOwnerListener(owner, observation.listener);
  ownedPools.set(owner, observation);
  return owner;
}

function createOwnedPool(config: pg.PoolConfig): pg.Pool {
  const selected = createObservedPool(config);
  // Reservations use a private pool on the same owner-selected connection
  // configuration. It adds at most one connection per selected pool and
  // serializes that pool's reservations. Single-use clients ensure no prior
  // borrower can retain a reference to a later reservation's client.
  const reservation = createObservedPool({ ...config, max: 1, maxUses: 1 }, true);
  const gate: ReservationGate = {
    active: false,
    activeClient: undefined,
    faulted: false,
    ending: false,
    // Bound the private queue by the already-selected public pool capacity.
    maxWaiters: selected.options.max,
    waiters: new Set(),
    drains: new Set(),
  };
  const nativeRelease = Reflect.get(Object.getPrototypeOf(reservation), "_release");
  if (typeof nativeRelease !== "function") {
    throw new Error("PostgreSQL reservation pool release unavailable.");
  }
  // pg-pool's normal maxUses counter is mutable on the client. Enforce
  // discard at the private pool owner independently of that counter.
  Object.defineProperty(reservation, "_release", {
    configurable: false,
    writable: false,
    value: (client: unknown, idleListener: unknown) => {
      try {
        return Reflect.apply(nativeRelease, reservation, [client, idleListener, true]);
      } catch (error) {
        failReservationGate(gate);
        throw error;
      }
    },
  });
  // pg-pool emits remove only after the client's end callback. Retaining the
  // gate until then prevents a new socket while the prior one is still ending.
  reservation.on("remove", (client: pg.Client) => releaseReservationGate(gate, client));
  reservationPools.set(selected, reservation);
  reservationGates.set(selected, gate);
  let endStarted = false;
  const observationFailure = () =>
    !isPoolObserverIntact(selected) || !isPoolObserverIntact(reservation)
      ? new Error("PostgreSQL pool observation unavailable.")
      : undefined;
  Object.defineProperty(selected, "end", {
    configurable: false,
    writable: false,
    value: (callback?: (error?: Error) => void) => {
      const operation = endStarted
        ? Promise.reject(new Error("The PostgreSQL pool is already ending."))
        : (() => {
            endStarted = true;
            gate.ending = true;
            rejectReservationWaiters(gate);
            const selectedObservation = ownedPools.get(selected);
            const reservationObservation = ownedPools.get(reservation);
            if (selectedObservation !== undefined) {
              selectedObservation.ending = true;
            }
            if (reservationObservation !== undefined) {
              reservationObservation.ending = true;
            }
            return Promise.allSettled([
              beginNativePoolEnd(selected),
              beginNativePoolEnd(reservation),
              waitForReservationDrain(gate),
            ]).then((results) => {
              const failed = results.find((result) => result.status === "rejected");
              if (failed?.status === "rejected") {
                throw failed.reason;
              }
              // Both native pool ends and any identified private disposal have
              // settled. A pool fault observed during that wait still fails
              // shutdown even if the reservation gate itself stayed healthy.
              const fault = observationFailure();
              if (fault !== undefined) {
                throw fault;
              }
            });
          })();
      if (callback) {
        void operation.then(
          () => {
            // A pool error can arrive after the operation resolves but before
            // the callback is invoked. Preserve that already-observed fault.
            const fault = observationFailure();
            if (fault !== undefined) {
              callback(fault);
            } else {
              callback();
            }
          },
          (error: unknown) =>
            callback(error instanceof Error ? error : new Error("PostgreSQL pool end failed.")),
        );
        return;
      }
      return operation;
    },
  });
  return selected;
}

function rejectReservationWaiters(gate: ReservationGate): void {
  for (const waiter of gate.waiters) {
    cleanReservationWaiter(waiter);
    waiter.reject(new Error("PostgreSQL reservation pool unavailable."));
  }
  gate.waiters.clear();
}

function failReservationGate(gate: ReservationGate): void {
  gate.faulted = true;
  gate.failure ??= new Error("PostgreSQL reservation disposal is uncertain.");
  rejectReservationWaiters(gate);
  // When an identified client is still active, its exact remove callback is
  // the only local disposal observation. Keep drains pending for that event;
  // a caller must bound shutdown externally if the callback never arrives.
  if (gate.activeClient === undefined) {
    for (const drain of gate.drains) {
      drain.reject(gate.failure);
    }
    gate.drains.clear();
  }
}

function waitForReservationDrain(gate: ReservationGate): Promise<void> {
  if (gate.faulted && gate.activeClient === undefined) {
    return Promise.reject(
      gate.failure ?? new Error("PostgreSQL reservation disposal is uncertain."),
    );
  }
  if (!gate.active) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    gate.drains.add({ resolve, reject });
  });
}

function cleanReservationWaiter(waiter: ReservationWaiter): void {
  clearTimeout(waiter.timer);
  if (waiter.signal && waiter.onAbort) {
    EventTarget.prototype.removeEventListener.call(waiter.signal, "abort", waiter.onAbort);
  }
}

function releaseReservationGate(gate: ReservationGate, client: pg.Client | undefined): void {
  // A delayed duplicate remove for an older client cannot free a newer
  // checkout's permit.
  if (!gate.active || gate.activeClient !== client) {
    return;
  }
  gate.activeClient = undefined;
  if (gate.faulted || gate.ending) {
    gate.active = false;
    for (const drain of gate.drains) {
      if (gate.faulted) {
        drain.reject(gate.failure ?? new Error("PostgreSQL reservation disposal is uncertain."));
      } else {
        drain.resolve();
      }
    }
    gate.drains.clear();
    return;
  }
  const waiter = gate.waiters.values().next().value as ReservationWaiter | undefined;
  if (waiter === undefined) {
    gate.active = false;
    return;
  }
  gate.waiters.delete(waiter);
  cleanReservationWaiter(waiter);
  // Ownership passes directly to the next waiter; no unreserved interval.
  waiter.resolve();
}

async function acquireReservationGate(
  gate: ReservationGate,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (
    gate.faulted ||
    gate.ending ||
    isAborted(signal) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new Error("PostgreSQL reservation pool unavailable.");
  }
  if (!gate.active) {
    gate.active = true;
    return;
  }
  if (gate.waiters.size >= gate.maxWaiters) {
    throw new Error("PostgreSQL reservation queue is full.");
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      gate.waiters.delete(waiter);
      cleanReservationWaiter(waiter);
      reject(new Error("PostgreSQL reservation checkout cancelled."));
    };
    const waiter: ReservationWaiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        gate.waiters.delete(waiter);
        cleanReservationWaiter(waiter);
        reject(new Error("PostgreSQL reservation checkout timed out."));
      }, timeoutMs),
      ...(signal ? { signal, onAbort } : {}),
    };
    gate.waiters.add(waiter);
    if (signal) {
      EventTarget.prototype.addEventListener.call(signal, "abort", onAbort, { once: true });
    }
    if (isAborted(signal)) {
      onAbort();
    }
  });
}

function isPoolObserverIntact(pool: pg.Pool): boolean {
  try {
    const observation = ownedPools.get(pool);
    return (
      observation !== undefined &&
      !observation.faulted &&
      EventEmitter.prototype.listeners.call(pool, "error").includes(observation.listener)
    );
  } catch {
    return false;
  }
}

function isObservedPool(pool: pg.Pool): boolean {
  const observation = ownedPools.get(pool);
  return observation !== undefined && !observation.ending && isPoolObserverIntact(pool);
}

function releaseClientlessPermit(
  gate: ReservationGate,
  selected: pg.Pool,
  reservation: pg.Pool,
): void {
  if (!gate.faulted && (!isPoolObserverIntact(selected) || !isPoolObserverIntact(reservation))) {
    // Preserve a pool fault independently from client-disposal uncertainty:
    // this admitted permit has not reached native checkout.
    gate.faulted = true;
    gate.failure = new Error("PostgreSQL pool observation unavailable.");
    rejectReservationWaiters(gate);
  }
  releaseReservationGate(gate, undefined);
}

/** Exact State-owned pool identity and its continuously installed observer. */
export function isPasswordBudgetPool(pool: unknown): pool is pg.Pool {
  try {
    if (pool === null || typeof pool !== "object") {
      return false;
    }
    const selected = pool as pg.Pool;
    const reservation = reservationPools.get(selected);
    const gate = reservationGates.get(selected);
    return (
      reservation !== undefined &&
      gate !== undefined &&
      !gate.faulted &&
      !gate.ending &&
      isObservedPool(selected) &&
      isObservedPool(reservation)
    );
  } catch {
    return false;
  }
}

/** Use only the owner's captured checkout operation on its exact pool. */
async function checkoutOwnedPasswordBudgetClient(
  pool: pg.Pool,
  timeoutMs: number,
  signal?: AbortSignal,
  state?: { nativeStarted: boolean },
): Promise<pg.PoolClient> {
  if (!isPasswordBudgetPool(pool)) {
    throw new Error("PostgreSQL pool unavailable.");
  }
  const reservation = reservationPools.get(pool);
  const gate = reservationGates.get(pool);
  if (reservation === undefined || gate === undefined) {
    throw new Error("PostgreSQL pool unavailable.");
  }
  await acquireReservationGate(gate, timeoutMs, signal);
  if (isAborted(signal)) {
    releaseClientlessPermit(gate, pool, reservation);
    throw new Error("PostgreSQL reservation checkout cancelled.");
  }
  if (!isPasswordBudgetPool(pool)) {
    // The continuation owns this exact clientless permit, and the native
    // checkout below has not started. An owner shutdown can release it cleanly.
    // Other faults retain their original conservative disposition.
    if (gate.ending && !gate.faulted && gate.active && gate.activeClient === undefined) {
      releaseClientlessPermit(gate, pool, reservation);
    } else {
      failReservationGate(gate);
    }
    throw new Error("PostgreSQL pool unavailable.");
  }
  try {
    if (state !== undefined) {
      state.nativeStarted = true;
    }
    const client = await checkout.call(reservation);
    gate.activeClient = client;
    return client;
  } catch (error) {
    // pg-pool does not always emit remove on connect failure. Without proof
    // that the attempted connection ended, do not allocate another client.
    failReservationGate(gate);
    throw error;
  }
}

export async function checkoutPasswordBudgetClient(
  pool: pg.Pool,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<pg.PoolClient> {
  return checkoutOwnedPasswordBudgetClient(pool, timeoutMs, signal);
}

/** Owner-issued cancellation proof applies only before native checkout starts. */
export function beginPasswordBudgetCheckout(
  pool: pg.Pool,
  timeoutMs: number,
): Readonly<{ client: Promise<pg.PoolClient>; cancel: () => boolean }> {
  const controller = new AbortController();
  const state = { nativeStarted: false };
  const client = checkoutOwnedPasswordBudgetClient(pool, timeoutMs, controller.signal, state);
  return Object.freeze({
    client,
    cancel: () => {
      controller.abort();
      return !state.nativeStarted;
    },
  });
}

/** Verify the already-installed owner observer before the first SQL and after queries. */
export function isPasswordBudgetClient(pool: pg.Pool, client: unknown): boolean {
  try {
    if (client === null || typeof client !== "object" || !isPasswordBudgetPool(pool)) {
      return false;
    }
    const observation = ownedClients.get(client as pg.Client);
    const reservation = reservationPools.get(pool);
    return (
      observation !== undefined &&
      observation.pool === reservation &&
      !observation.faulted &&
      EventEmitter.prototype.listeners.call(client, "error").includes(observation.listener)
    );
  } catch {
    return false;
  }
}

// pg 8.23 tracks a sent timed-out query until ReadyForQuery. Checking only the
// last transaction status can therefore mistake a still-pending BEGIN for an
// idle connection. A client is admitted only when both protocol status and
// all native query queues are settled. Unknown shapes fail closed.
export function isPasswordBudgetClientIdle(pool: pg.Pool, client: unknown): boolean {
  if (!isPasswordBudgetClient(pool, client)) {
    return false;
  }
  try {
    const state = client as {
      _txStatus?: unknown;
      _activeQuery?: unknown;
      _sentQueryQueue?: unknown;
      _queryQueue?: unknown;
      readyForQuery?: unknown;
      _queryable?: unknown;
      _ending?: unknown;
      pipeline?: unknown;
    };
    return (
      state._txStatus === "I" &&
      state._activeQuery === null &&
      Array.isArray(state._sentQueryQueue) &&
      state._sentQueryQueue.length === 0 &&
      Array.isArray(state._queryQueue) &&
      state._queryQueue.length === 0 &&
      state.readyForQuery === true &&
      state._queryable === true &&
      state._ending === false &&
      state.pipeline === false
    );
  } catch {
    return false;
  }
}

/** Shared connection authentication for the API, worker, bootstrap, and migrator. */
export async function createPostgresPool(
  databaseUrl: string,
  options: PoolLimits = {},
): Promise<pg.Pool> {
  return createPool(databaseUrl, options, false);
}

/** Provisional composition seam: this exact pool must also be the auth pool. */
export async function createPostgresPasswordBudgetPool(
  databaseUrl: string,
  options: PoolLimits = {},
): Promise<pg.Pool> {
  return createPool(databaseUrl, options, true);
}

const passwordBudgetWorkloadUrlKeys = new Set([
  "user",
  "password",
  "host",
  "port",
  "database",
  "ssl",
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "uselibpqcompat",
  "sslnegotiation",
  "application_name",
  "fallback_application_name",
  "options",
  "statement_timeout",
  "query_timeout",
  "lock_timeout",
  "idle_in_transaction_session_timeout",
  "client_encoding",
  "replication",
]);

// Pure preparation is separately testable without creating an Azure
// credential. It never mints pool identity or a password-budget capability.
export function preparePasswordBudgetWorkloadOptions(
  databaseUrl: string,
  limits: PoolLimits = {},
): pg.PoolConfig {
  let parameters: URLSearchParams;
  try {
    parameters = new URL(databaseUrl).searchParams;
  } catch {
    throw new Error("Invalid password budget database URL.");
  }
  // Reject before parsing can read any SSL files or reach the provider.
  for (const key of parameters.keys()) {
    if (!passwordBudgetWorkloadUrlKeys.has(key)) {
      throw new Error("Unsupported password budget database URL option.");
    }
  }
  const connection = validatedWorkloadConnection(databaseUrl);
  for (const key of Object.keys(connection)) {
    if (!passwordBudgetWorkloadUrlKeys.has(key)) {
      throw new Error("Unsupported password budget database URL option.");
    }
  }
  const suppliedLimits: pg.PoolConfig = {};
  for (const name of [
    "max",
    "connectionTimeoutMillis",
    "statement_timeout",
    "query_timeout",
    "options",
  ] as const) {
    if (limits[name] !== undefined) {
      // The keys above share the same types as PoolConfig; assigning each via
      // Object.assign preserves only explicitly supplied overrides.
      Object.assign(suppliedLimits, { [name]: limits[name] });
    }
  }
  return {
    ...connection,
    ...suppliedLimits,
    ssl: freezePasswordBudgetTls(connection.ssl),
  };
}

/** Prepare immutable parser-produced TLS settings without connecting. */
export function freezePasswordBudgetTls(ssl: pg.ClientConfig["ssl"]): Readonly<{
  rejectUnauthorized: true;
  ca?: string;
  cert?: string;
  key?: string;
}> {
  if (!ssl) {
    throw new Error("PostgreSQL TLS unavailable.");
  }
  const source = typeof ssl === "object" ? ssl : {};
  if (
    source.rejectUnauthorized === false ||
    source.checkServerIdentity !== undefined ||
    (source.ca !== undefined && typeof source.ca !== "string") ||
    (source.cert !== undefined && typeof source.cert !== "string") ||
    (source.key !== undefined && typeof source.key !== "string")
  ) {
    throw new Error("Unsupported password budget TLS settings.");
  }
  const result: {
    rejectUnauthorized: true;
    ca?: string;
    cert?: string;
    key?: string;
  } = { rejectUnauthorized: true };
  if (typeof source.ca === "string") {
    result.ca = source.ca;
  }
  if (typeof source.cert === "string") {
    result.cert = source.cert;
  }
  if (typeof source.key === "string") {
    Object.defineProperty(result, "key", {
      value: source.key,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(result);
}

function validatedWorkloadConnection(databaseUrl: string): pg.ClientConfig {
  const connection = parseIntoClientConfig(databaseUrl);
  if (connection.connectionString !== undefined) {
    throw new Error("Azure workload identity does not allow nested connection strings.");
  }
  if (connection.password) {
    throw new Error("Azure workload identity requires a password-free database URL.");
  }
  if (
    !connection.ssl ||
    (typeof connection.ssl === "object" &&
      (connection.ssl.rejectUnauthorized === false ||
        connection.ssl.checkServerIdentity !== undefined))
  ) {
    throw new Error(
      "Azure workload identity requires certificate- and hostname-verified PostgreSQL TLS.",
    );
  }
  return connection;
}

async function createPool(
  databaseUrl: string,
  { authMode = process.env.OCC_DATABASE_AUTH ?? "password", ...limits }: PoolLimits,
  observed: boolean,
): Promise<pg.Pool> {
  const makePool = (config: pg.PoolConfig): pg.Pool =>
    observed ? createOwnedPool(config) : new pg.Pool(config);
  if (
    observed &&
    (typeof databaseUrl !== "string" ||
      (limits.options !== undefined && typeof limits.options !== "string") ||
      (limits.max !== undefined && (!Number.isSafeInteger(limits.max) || limits.max < 0)) ||
      (limits.connectionTimeoutMillis !== undefined &&
        (!Number.isSafeInteger(limits.connectionTimeoutMillis) ||
          limits.connectionTimeoutMillis < 0)) ||
      (limits.query_timeout !== undefined &&
        (!Number.isSafeInteger(limits.query_timeout) || limits.query_timeout < 0)) ||
      (limits.statement_timeout !== undefined &&
        limits.statement_timeout !== false &&
        (!Number.isSafeInteger(limits.statement_timeout) || limits.statement_timeout < 0)))
  ) {
    throw new TypeError("Invalid password budget pool options.");
  }
  // The observed pool accepts only the advertised scalar limits. Do not let a
  // JavaScript caller smuggle pg-pool hooks, a custom Client, or a Promise
  // implementation through the object rest operation.
  const selectedLimits = observed
    ? Object.fromEntries(
        (
          [
            "max",
            "connectionTimeoutMillis",
            "statement_timeout",
            "query_timeout",
            "options",
          ] as const
        )
          .filter((name) => limits[name] !== undefined)
          .map((name) => [name, limits[name]]),
      )
    : limits;
  if (authMode === "password") {
    return makePool({ connectionString: databaseUrl, ...selectedLimits });
  }
  if (authMode !== "azure-workload-identity") {
    throw new Error("Unsupported OCC_DATABASE_AUTH mode.");
  }

  // Passing connectionString alongside password would let pg's URL parser
  // replace the token callback with an empty password. Parse before overriding.
  const connection = observed
    ? preparePasswordBudgetWorkloadOptions(databaseUrl, limits)
    : validatedWorkloadConnection(databaseUrl);

  const { WorkloadIdentityCredential } = await import("@azure/identity");
  const credential = new WorkloadIdentityCredential();
  return makePool({
    ...connection,
    ...selectedLimits,
    ssl: observed
      ? connection.ssl
      : {
          ...(typeof connection.ssl === "object" ? connection.ssl : {}),
          rejectUnauthorized: true,
        },
    // pg calls this for each new connection; the SDK owns token caching and
    // renewal. Never fall back to an operator identity or a fixed access token.
    password: async () =>
      (await credential.getToken("https://ossrdbms-aad.database.windows.net/.default")).token,
  });
}
