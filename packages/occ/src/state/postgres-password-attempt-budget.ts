import { timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";

import type {
  PasswordAttemptBudget,
  PasswordAttemptReservation,
} from "../ports/password-attempt-budget.ts";
import {
  beginPasswordBudgetCheckout,
  isPasswordBudgetClient,
  isPasswordBudgetClientIdle,
  isPasswordBudgetPool,
} from "./postgres-pool.ts";
import {
  PostgresPlatformState,
  type PostgresClient,
  type PostgresPlatformStateOptions,
  type PostgresPool,
} from "./postgres-state.ts";

/**
 * Values come from trusted server composition. The confirmation is derived
 * from the same high-entropy key as the account digest, in a separate domain.
 * The key itself never reaches this module or PostgreSQL.
 */
export interface PasswordBudgetBinding {
  readonly installationId: string;
  readonly epoch: string;
  readonly keyConfirmation: Uint8Array;
  readonly transactionTimeoutMs: number;
}

export interface PasswordBudgetExpectedBinding {
  readonly installationId: string;
  readonly epoch: string;
  readonly keyConfirmation: Uint8Array;
}

export interface PostgresPasswordBudgetPair {
  readonly state: PostgresPlatformState;
  readonly passwordBudget: PasswordAttemptBudget;
}

// The pair's provenance is held by this module, not by a public boolean,
// overridable method, caller-supplied pool, or structural receipt.
const pairs = new WeakMap<
  PostgresPasswordBudgetPair,
  Readonly<{ installationId: string; epoch: string; confirmation: Buffer; pool: PostgresPool }>
>();

interface PoolObservation {
  faulted: boolean;
  readonly listener: (error: Error) => void;
}

// A pool can back more than one pair. Attach one observer for that pool's
// lifetime; removing it at client release would miss pg-pool's late errors.
const poolObservations = new WeakMap<PostgresPool, PoolObservation>();

function observePool(pool: PostgresPool): PoolObservation {
  if (
    !isPasswordBudgetPool(pool) ||
    pool === null ||
    typeof pool !== "object" ||
    !(pool instanceof EventEmitter) ||
    typeof pool.connect !== "function" ||
    typeof pool.end !== "function"
  ) {
    throw new TypeError("The password budget requires an observable PostgreSQL pool.");
  }
  const existing = poolObservations.get(pool);
  if (existing !== undefined) {
    return existing;
  }
  const observation: PoolObservation = {
    faulted: false,
    listener: () => {
      observation.faulted = true;
    },
  };
  try {
    EventEmitter.prototype.on.call(pool, "error", observation.listener);
    if (!EventEmitter.prototype.listeners.call(pool, "error").includes(observation.listener)) {
      throw new Error("Pool observer was not installed.");
    }
  } catch {
    throw new TypeError("The password budget requires an observable PostgreSQL pool.");
  }
  poolObservations.set(pool, observation);
  return observation;
}

function poolIsObserved(pool: PostgresPool, observation: PoolObservation): boolean {
  if (observation.faulted || !isPasswordBudgetPool(pool)) {
    return false;
  }
  try {
    if (EventEmitter.prototype.listeners.call(pool, "error").includes(observation.listener)) {
      return true;
    }
  } catch {
    // A missing or unreadable observer cannot authorize password work.
  }
  observation.faulted = true;
  return false;
}

function retainEmitterListener(client: PostgresClient, listener: (error: Error) => void): boolean {
  try {
    if (!(client instanceof EventEmitter)) {
      return false;
    }
    if (!EventEmitter.prototype.listeners.call(client, "error").includes(listener)) {
      EventEmitter.prototype.on.call(client, "error", listener);
    }
    return EventEmitter.prototype.listeners.call(client, "error").includes(listener);
  } catch {
    // If registration and discard both fail, cleanup remains unproved.
    return false;
  }
}

/**
 * Check an actual factory-created pair against the selected State and the
 * actual auth pool and independently prepared key/policy inputs before
 * enabling password login.
 * An unrecognized, copied, or proxied pair fails closed.
 */
export function matchesPostgresPasswordBudgetPair(
  pair: unknown,
  selectedState: unknown,
  expected: PasswordBudgetExpectedBinding,
  selectedAuthPool: unknown,
): boolean {
  try {
    if (pair === null || typeof pair !== "object") {
      return false;
    }
    const actual = pairs.get(pair as PostgresPasswordBudgetPair);
    const observation = actual === undefined ? undefined : poolObservations.get(actual.pool);
    if (
      actual === undefined ||
      observation === undefined ||
      !poolIsObserved(actual.pool, observation) ||
      (pair as PostgresPasswordBudgetPair).state !== selectedState ||
      selectedAuthPool === undefined ||
      selectedAuthPool === null ||
      actual.pool !== selectedAuthPool ||
      expected.installationId !== actual.installationId ||
      expected.epoch !== actual.epoch ||
      !(expected.keyConfirmation instanceof Uint8Array) ||
      expected.keyConfirmation.byteLength !== 32
    ) {
      return false;
    }
    return timingSafeEqual(actual.confirmation, Buffer.from(expected.keyConfirmation));
  } catch {
    return false;
  }
}

const unavailable = Object.freeze({ status: "unavailable" } as const);
const unknown = Object.freeze({ status: "unknown" } as const);
const allowed = Object.freeze({ status: "allowed" } as const);

function command(result: unknown, expected: string): boolean {
  return (
    result !== null &&
    typeof result === "object" &&
    "command" in result &&
    result.command === expected
  );
}

function reservation(result: {
  rows: unknown[];
  rowCount: number | null;
}): PasswordAttemptReservation | undefined {
  if (result.rowCount !== 1 || result.rows.length !== 1) {
    return undefined;
  }
  const row = result.rows[0];
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  const keys = Reflect.ownKeys(row);
  if (keys.length !== 2 || !keys.includes("status") || !keys.includes("retry_after_seconds")) {
    return undefined;
  }
  const status = Object.getOwnPropertyDescriptor(row, "status");
  const delay = Object.getOwnPropertyDescriptor(row, "retry_after_seconds");
  if (status === undefined || !("value" in status) || delay === undefined || !("value" in delay)) {
    return undefined;
  }
  if (status.value === "allowed" && delay.value === null) {
    return allowed;
  }
  if (status.value === "unavailable" && delay.value === null) {
    return unavailable;
  }
  if (
    status.value === "limited" &&
    typeof delay.value === "number" &&
    Number.isSafeInteger(delay.value) &&
    delay.value > 0
  ) {
    return Object.freeze({ status: "limited", retryAfterSeconds: delay.value });
  }
  return undefined;
}

/**
 * Construct the selected native State and its budget together. Composition
 * must select this returned State as the serving State; constructing a
 * separate State or wrapping it is not evidence that this pair is selected.
 * Only trusted server composition may supply the pool and binding.
 */
export function createPostgresStateWithPasswordBudget(
  pool: PostgresPool,
  stateOptions: PostgresPlatformStateOptions,
  binding: PasswordBudgetBinding,
): PostgresPasswordBudgetPair {
  if (
    typeof binding.installationId !== "string" ||
    binding.installationId.length === 0 ||
    typeof binding.epoch !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(binding.epoch) ||
    BigInt(binding.epoch) > 9_223_372_036_854_775_807n ||
    !(binding.keyConfirmation instanceof Uint8Array) ||
    binding.keyConfirmation.byteLength !== 32 ||
    !Number.isSafeInteger(binding.transactionTimeoutMs) ||
    binding.transactionTimeoutMs <= 0 ||
    binding.transactionTimeoutMs > 2_147_483_647
  ) {
    throw new TypeError("Invalid password budget binding.");
  }

  const installationId = binding.installationId;
  const epoch = binding.epoch;
  const confirmation = Buffer.from(binding.keyConfirmation);
  const timeoutMs = binding.transactionTimeoutMs;
  const poolObservation = observePool(pool);
  const state = new PostgresPlatformState(pool, stateOptions);
  // A timed-out checkout may still complete later. Disable this budget for
  // its remaining lifetime until the composition owner replaces the instance;
  // the late client is discarded and never used for SQL.
  let checkoutUncertain = false;
  const discardUnusedClient = (connected: PostgresClient): void => {
    // Keep an error listener installed if release fails. This path never
    // queries or reuses the connection.
    const onLateError = (): void => {};
    let listening = false;
    try {
      if (typeof connected.on === "function") {
        listening = true;
        connected.on("error", onLateError);
      } else {
        listening = retainEmitterListener(connected, onLateError);
      }
    } catch {
      checkoutUncertain = true;
      listening = retainEmitterListener(connected, onLateError) || listening;
    }
    try {
      connected.release(true);
      if (listening) {
        connected.removeListener?.("error", onLateError);
      }
    } catch {
      checkoutUncertain = true;
    }
  };

  const passwordBudget: PasswordAttemptBudget = Object.freeze({
    async reserve(subjectDigest: Uint8Array): Promise<PasswordAttemptReservation> {
      if (
        checkoutUncertain ||
        !poolIsObserved(pool, poolObservation) ||
        !(subjectDigest instanceof Uint8Array) ||
        subjectDigest.byteLength !== 32
      ) {
        return unavailable;
      }
      const digest = Buffer.from(subjectDigest);
      const deadline = performance.now() + timeoutMs;
      let abandoned = false;
      const checkoutAttempt = beginPasswordBudgetCheckout(pool as import("pg").Pool, timeoutMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let client: PostgresClient | undefined;
      try {
        const pending = checkoutAttempt.client.then(
          (connected) => {
            if (!abandoned) {
              return connected;
            }
            discardUnusedClient(connected);
            return undefined;
          },
          () => undefined,
        );
        const timeout = new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            abandoned = true;
            if (!checkoutAttempt.cancel()) {
              checkoutUncertain = true;
            }
            resolve(undefined);
          }, timeoutMs);
        });
        client = await Promise.race([pending, timeout]);
      } catch {
        return unavailable;
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
      if (client === undefined) {
        return unavailable;
      }
      if (checkoutUncertain) {
        discardUnusedClient(client);
        return unavailable;
      }
      // A pool can return a client whose earlier BEGIN timed out locally but
      // is still executing. Never send budget SQL until the owner's pinned
      // pg protocol state shows idle with every pending queue drained.
      if (!isPasswordBudgetClientIdle(pool as import("pg").Pool, client)) {
        discardUnusedClient(client);
        return unavailable;
      }
      const acquiredClient = client;
      let observedError = false;
      let committed = false;
      let commitStarted = false;
      let released = false;
      let releaseSucceeded = false;
      let listenerAttempted = false;
      let result: PasswordAttemptReservation;
      const onError = (): void => {
        observedError = true;
      };
      const query = async (statement: string, parameters?: readonly unknown[]) => {
        if (
          observedError ||
          !poolIsObserved(pool, poolObservation) ||
          !isPasswordBudgetClient(pool as import("pg").Pool, acquiredClient)
        ) {
          throw new Error("PostgreSQL client unavailable.");
        }
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining <= 0) {
          throw new Error("PostgreSQL operation timed out.");
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const pending = acquiredClient.query(statement, parameters);
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("PostgreSQL operation timed out.")),
              remaining,
            );
          });
          const response = await Promise.race([pending, timeout]);
          if (
            observedError ||
            !poolIsObserved(pool, poolObservation) ||
            !isPasswordBudgetClient(pool as import("pg").Pool, acquiredClient)
          ) {
            throw new Error("PostgreSQL client unavailable.");
          }
          return response;
        } finally {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
        }
      };
      try {
        listenerAttempted = true;
        if (
          typeof acquiredClient.on !== "function" ||
          typeof acquiredClient.removeListener !== "function"
        ) {
          retainEmitterListener(acquiredClient, onError);
          throw new Error("PostgreSQL error observation unavailable.");
        }
        try {
          acquiredClient.on("error", onError);
        } catch (error) {
          // Real pg clients are Node EventEmitters. If an overridden listener
          // method throws, retain our own observer when the native emitter
          // can establish it, but never start SQL on this failed checkout.
          retainEmitterListener(acquiredClient, onError);
          throw error;
        }
        if (
          !isPasswordBudgetClient(pool as import("pg").Pool, acquiredClient) ||
          !EventEmitter.prototype.listeners.call(acquiredClient, "error").includes(onError)
        ) {
          throw new Error("PostgreSQL client observation unavailable.");
        }
        if (
          observedError ||
          !command(await query("BEGIN ISOLATION LEVEL READ COMMITTED"), "BEGIN")
        ) {
          throw new Error("PostgreSQL transaction unavailable.");
        }
        const row = await query(
          "SELECT status, retry_after_seconds FROM occ.reserve_password_attempt($1, $2, $3, $4)",
          [installationId, epoch, confirmation, digest],
        );
        const parsed = reservation(row);
        if (parsed === undefined) {
          throw new Error("Invalid password budget response.");
        }
        result = parsed;
        commitStarted = true;
        if (!command(await query("COMMIT"), "COMMIT")) {
          throw new Error("PostgreSQL commit was not acknowledged.");
        }
        committed = true;
      } catch {
        // Discard without further queries, including ROLLBACK. After a COMMIT
        // was sent its result is unknown, even if an error resembles a SQL error.
        result = commitStarted ? unknown : unavailable;
      } finally {
        try {
          if (!released) {
            released = true;
            // A release-time error may fire during the release call. Discard
            // the client on every path so that such a client cannot re-enter
            // the pool before our listener observes the event.
            acquiredClient.release(true);
            releaseSucceeded = true;
          }
        } catch {
          // Failed release does not establish disposal. Retain our observer
          // and close this instance to further admissions.
          checkoutUncertain = true;
          result = committed || commitStarted ? unknown : unavailable;
        }
        if (listenerAttempted && releaseSucceeded) {
          try {
            acquiredClient.removeListener?.("error", onError);
          } catch {
            result = committed || commitStarted ? unknown : unavailable;
          }
        }
        if (observedError || !poolIsObserved(pool, poolObservation)) {
          result = committed || commitStarted ? unknown : unavailable;
        }
      }
      return result;
    },
  });
  const pair: PostgresPasswordBudgetPair = Object.freeze({ state, passwordBudget });
  pairs.set(pair, Object.freeze({ installationId, epoch, confirmation, pool }));
  return pair;
}
