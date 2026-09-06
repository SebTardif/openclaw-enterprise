import { createHash } from "node:crypto";
import {
  CREDENTIAL_STORAGE_LIMITS_V1 as limits,
  parseCredentialStorageV1,
  type CredentialCachePartitionV1,
  type CredentialSecretBindingV1,
  type CredentialStorageCallBoundsV1,
  type CredentialMaterialHandleV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import {
  CredentialCustodyErrorV1,
  custodyFailureFromErrorV1,
  type CustodyClockV1,
  type ProtectedMaterialLeaseV1,
} from "./ports.ts";

export function custodyEqualV1(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
type Sample = ReturnType<CustodyClockV1["read"]>;
type Entry = {
  partition: CredentialCachePartitionV1;
  start: Sample;
  material?: ProtectedMaterialLeaseV1;
  busy: boolean;
  invalid: boolean;
};
export interface BoundedCredentialMaterialCacheV1 {
  withMaterial<T>(
    partition: CredentialCachePartitionV1,
    load: () => Promise<ProtectedMaterialLeaseV1>,
    consume: (handle: CredentialMaterialHandleV1, assertCurrent: () => void) => Promise<T>,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<T>;
  /** Shared facade/cache clock guard; clock failure closes and flushes idle material. */
  readClock(): Sample;
  invalidate(binding: CredentialSecretBindingV1): void;
  close(): void;
  /** Counts only; no partition names, handles, material or permission. */
  inspect(): Readonly<{ entries: number; reservedBytes: number; busy: number; closed: boolean }>;
}

/** No authority enters this cache. Every pending load reserves a full maximum
 * material slot. Busy/invalid entries remain charged until their callback settles.
 * No eviction, hidden queue, background renewal or refresh-state cache. */
export function createBoundedCredentialMaterialCacheV1(
  clock: CustodyClockV1,
): BoundedCredentialMaterialCacheV1 {
  const entries = new Map<string, Entry>();
  let closed = false;
  let last: Sample | undefined;
  const unavailable = () => new CredentialCustodyErrorV1();
  function dispose(key: string, entry: Entry): void {
    if (entry.busy) return;
    try {
      entry.material?.release();
      entries.delete(key);
    } catch {
      // Retain the charge if the adapter fails erasure/release. No new work.
      closed = true;
      entry.invalid = true;
    }
  }
  function invalidateAll(): void {
    for (const [key, entry] of entries) {
      entry.invalid = true;
      dispose(key, entry);
    }
  }
  function sample(): Sample {
    let now: Sample;
    try {
      const observed = clock.read();
      now = {
        wallMs: observed.wallMs,
        monotonicMs: observed.monotonicMs,
        uncertaintyMs: observed.uncertaintyMs,
      };
    } catch {
      closed = true;
      invalidateAll();
      throw unavailable();
    }
    if (
      ![now.wallMs, now.monotonicMs, now.uncertaintyMs].every(Number.isSafeInteger) ||
      now.wallMs < 0 ||
      now.monotonicMs < 0 ||
      now.uncertaintyMs < 0 ||
      now.uncertaintyMs > limits.maxClockUncertaintyMs ||
      (last !== undefined &&
        (now.wallMs < last.wallMs ||
          now.monotonicMs < last.monotonicMs ||
          Math.abs(now.wallMs - last.wallMs - (now.monotonicMs - last.monotonicMs)) >
            now.uncertaintyMs + last.uncertaintyMs))
    ) {
      closed = true;
      invalidateAll();
      throw unavailable();
    }
    last = Object.freeze({ ...now });
    return last;
  }
  function fresh(entry: Entry, now: Sample): boolean {
    return (
      !entry.invalid &&
      now.monotonicMs - entry.start.monotonicMs + now.uncertaintyMs + entry.start.uncertaintyMs <
        limits.materialCacheMaxAgeMs &&
      (entry.material === undefined ||
        now.wallMs + now.uncertaintyMs + limits.expirySafetyMarginMs < entry.material.expiresAtMs)
    );
  }
  function sweep(now: Sample): void {
    for (const [key, entry] of entries) {
      if (!fresh(entry, now)) {
        entry.invalid = true;
        dispose(key, entry);
      }
    }
  }
  return Object.freeze({
    async withMaterial<T>(
      input: CredentialCachePartitionV1,
      load: () => Promise<ProtectedMaterialLeaseV1>,
      consume: (handle: CredentialMaterialHandleV1, assertCurrent: () => void) => Promise<T>,
      bounds: CredentialStorageCallBoundsV1,
    ): Promise<T> {
      if (closed || bounds.signal.aborted) throw unavailable();
      const partition = parseCredentialStorageV1("cachePartition", input);
      const now = sample();
      sweep(now);
      if (closed || bounds.signal.aborted) throw unavailable();
      const key = createHash("sha256").update(canonical(partition)).digest("hex");
      let entry = entries.get(key);
      if (entry?.busy)
        throw new CredentialCustodyErrorV1({
          kind: "capacity-exhausted",
          reason: "capacity-exhausted",
        });
      if (entry === undefined) {
        if (
          entries.size >= limits.maxMaterialCacheEntries ||
          (entries.size + 1) * limits.maxMaterialBytes > limits.maxMaterialCacheBytes
        )
          throw new CredentialCustodyErrorV1({
            kind: "capacity-exhausted",
            reason: "capacity-exhausted",
          });
        entry = { partition, start: now, busy: true, invalid: false };
        entries.set(key, entry);
      } else entry.busy = true;
      const held = entry;
      try {
        if (held.material === undefined) {
          const material = await load();
          held.material = material;
          if (
            !Number.isSafeInteger(material.byteLength) ||
            material.byteLength < 1 ||
            material.byteLength > limits.maxMaterialBytes ||
            !Number.isSafeInteger(material.expiresAtMs) ||
            !custodyEqualV1(
              partition,
              parseCredentialStorageV1("cachePartition", material.partition),
            )
          )
            throw unavailable();
        }
        if (closed || bounds.signal.aborted || !fresh(held, sample())) throw unavailable();
        const assertCurrent = () => {
          if (closed || bounds.signal.aborted || !held.busy || !fresh(held, sample()))
            throw unavailable();
        };
        return await consume(held.material.handle, assertCurrent);
      } catch (error) {
        held.invalid = true;
        throw new CredentialCustodyErrorV1(custodyFailureFromErrorV1(error));
      } finally {
        held.busy = false;
        if (held.invalid || closed || bounds.signal.aborted) {
          held.invalid = true;
          dispose(key, held);
        }
      }
    },
    readClock(): Sample {
      if (closed) throw unavailable();
      return sample();
    },
    invalidate(binding: CredentialSecretBindingV1): void {
      for (const [key, entry] of entries)
        if (
          custodyEqualV1(entry.partition.scope, binding.scope) &&
          entry.partition.binding.bindingRef === binding.bindingRef
        ) {
          entry.invalid = true;
          dispose(key, entry);
        }
    },
    close(): void {
      closed = true;
      invalidateAll();
    },
    inspect() {
      return Object.freeze({
        entries: entries.size,
        reservedBytes: entries.size * limits.maxMaterialBytes,
        busy: [...entries.values()].filter((entry) => entry.busy).length,
        closed,
      });
    },
  });
}
