import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { PostgresClient, PostgresPool } from "@openclaw-enterprise/occ";

// Fixed slots make storage independent of attacker-controlled source/account cardinality.
// Collisions share a budget conservatively; neither email nor address is stored.
const SOURCE_SLOTS = 4096;
const ACCOUNT_SLOTS = 16384;
const SOURCE_INTERVAL_MS = 2000;
const ACCOUNT_INTERVAL_MS = 12000;
const SOURCE_CAPACITY = 30;
const ACCOUNT_CAPACITY = 5;
const DEADLINE_MS = 1000;
const MAX_PENDING = 32;
export const SIGN_IN_RETRY_SECONDS = 12;

export class SignInQuotaFailure extends Error {
  readonly status: 429 | 503;
  readonly code: "RATE_LIMITED" | "DEPENDENCY_UNAVAILABLE";
  readonly retryAfter: number;

  constructor(exhausted: boolean) {
    super("Sign-in admission is unavailable.");
    this.status = exhausted ? 429 : 503;
    this.code = exhausted ? "RATE_LIMITED" : "DEPENDENCY_UNAVAILABLE";
    this.retryAfter = exhausted ? SIGN_IN_RETRY_SECONDS : 1;
  }
}

export interface SignInQuotaStore {
  reserve(sourceSlot: number, accountSlot: number): Promise<boolean>;
}

function nextReservation(now: number, current: number, interval: number, capacity: number) {
  const start = Math.max(now, current);
  return start <= now + (capacity - 1) * interval ? start + interval : undefined;
}

/** A bounded process-local store for the explicit in-memory authentication fixture. */
export class MemorySignInQuotaStore implements SignInQuotaStore {
  readonly #slots = new Float64Array(SOURCE_SLOTS + ACCOUNT_SLOTS);

  async reserve(sourceSlot: number, accountSlot: number): Promise<boolean> {
    const now = Date.now();
    const source = nextReservation(
      now,
      this.#slots[sourceSlot]!,
      SOURCE_INTERVAL_MS,
      SOURCE_CAPACITY,
    );
    const account = nextReservation(
      now,
      this.#slots[accountSlot]!,
      ACCOUNT_INTERVAL_MS,
      ACCOUNT_CAPACITY,
    );
    if (source === undefined || account === undefined) return false;
    // No await between reading and reserving both slots.
    this.#slots[sourceSlot] = source;
    this.#slots[accountSlot] = account;
    return true;
  }
}

/** Shared accounting uses database time and one atomic reservation of both dimensions. */
export class PostgresSignInQuotaStore implements SignInQuotaStore {
  readonly #pool: PostgresPool;
  #pending = 0;

  constructor(pool: PostgresPool) {
    this.#pool = pool;
  }

  async reserve(sourceSlot: number, accountSlot: number): Promise<boolean> {
    if (this.#pending >= MAX_PENDING) throw new SignInQuotaFailure(false);
    this.#pending += 1;
    const started = performance.now();
    let expired = false;
    let transportFailed = false;
    let client: PostgresClient | undefined;
    let released = false;
    const onTransportError = () => {
      transportFailed = true;
    };
    const checkDeadline = () => {
      if (expired || transportFailed || performance.now() - started >= DEADLINE_MS)
        throw new SignInQuotaFailure(false);
    };
    const release = (destroy: boolean) => {
      if (client && !released) {
        released = true;
        client.release(destroy);
        if (!destroy) client.removeListener?.("error", onTransportError);
      }
    };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        expired = true;
        release(true);
        reject(new SignInQuotaFailure(false));
      }, DEADLINE_MS);
    });
    const operation = (async () => {
      try {
        client = await this.#pool.connect();
        client.on?.("error", onTransportError);
        // A timed-out queued acquisition must never start account or quota work later.
        checkDeadline();
        const query = async (text: string, values?: readonly unknown[]) => {
          checkDeadline();
          const result = await client!.query(text, values);
          checkDeadline();
          return result;
        };
        await query("BEGIN");
        await query("SET LOCAL statement_timeout = '750ms'");
        await query(
          "INSERT INTO occ.sign_in_quota_slots (slot, next_at_ms) VALUES ($1, 0), ($2, 0) ON CONFLICT DO NOTHING",
          [sourceSlot, accountSlot],
        );
        const locked = await query(
          "SELECT slot, next_at_ms FROM occ.sign_in_quota_slots WHERE slot = ANY($1::integer[]) ORDER BY slot FOR UPDATE",
          [[sourceSlot, accountSlot]],
        );
        // Read the clock after contention, not the timestamp at transaction start.
        const clock = await query(
          "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms",
        );
        const now = Number((clock.rows[0] as { now_ms: string }).now_ms);
        const rows = locked.rows as { slot: number; next_at_ms: string }[];
        if (rows.length !== 2) throw new SignInQuotaFailure(false);
        const source = nextReservation(
          now,
          Number(rows[0]!.next_at_ms),
          SOURCE_INTERVAL_MS,
          SOURCE_CAPACITY,
        );
        const account = nextReservation(
          now,
          Number(rows[1]!.next_at_ms),
          ACCOUNT_INTERVAL_MS,
          ACCOUNT_CAPACITY,
        );
        const admitted = source !== undefined && account !== undefined;
        if (admitted) {
          await query(
            "UPDATE occ.sign_in_quota_slots SET next_at_ms = CASE slot WHEN $1 THEN $3::bigint ELSE $4::bigint END WHERE slot = ANY($2::integer[])",
            [sourceSlot, [sourceSlot, accountSlot], source, account],
          );
        }
        const acknowledgement = await query("COMMIT");
        if (!("command" in acknowledgement) || acknowledgement.command !== "COMMIT")
          throw new SignInQuotaFailure(false);
        return admitted;
      } catch {
        // Destroy on any uncertain transaction outcome. Never fall back to local admission.
        release(true);
        throw new SignInQuotaFailure(false);
      } finally {
        release(expired || transportFailed);
        // Retain this slot until a late pool acquisition settles, bounding its waiting queue.
        this.#pending -= 1;
      }
    })();
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createSignInQuota(store: SignInQuotaStore, secret: string, installationId: string) {
  const slot = (parts: readonly string[], count: number) =>
    createHmac("sha256", secret)
      .update(JSON.stringify(["sign-in-v1", installationId, ...parts]))
      .digest()
      .readUInt32BE(0) % count;

  return async (remoteAddress: string | undefined, email: unknown): Promise<void> => {
    if (!remoteAddress || remoteAddress.length > 64 || isIP(remoteAddress) === 0)
      throw new SignInQuotaFailure(false);
    let source = remoteAddress.toLowerCase();
    if (source.startsWith("::ffff:") && isIP(source.slice(7)) === 4) source = source.slice(7);
    else if (isIP(source) === 6) source = new URL(`http://[${source}]/`).hostname;
    // Shape-invalid input shares a constant account component. No account lookup selects a key.
    const account =
      typeof email === "string" && email.length <= 320 ? email.trim().toLowerCase() : "";
    const admitted = await store.reserve(
      slot(["source", source], SOURCE_SLOTS),
      SOURCE_SLOTS + slot(["source-account", source, account], ACCOUNT_SLOTS),
    );
    if (!admitted) throw new SignInQuotaFailure(true);
  };
}
