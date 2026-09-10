import { types } from "node:util";

/** The parent owns and recognizes each original and all State authority used by
 * these methods. This owner only retains and accounts for that responsibility. */
export interface RepositoryWorkObservationSourceV2<O extends object> {
  reconcile(original: O): Promise<"recorded" | "unavailable">;
  retire(original: O): Promise<void>;
}

/** Nonsecret comparison references only. These values never admit an operation
 * or permit lookup, reconciliation, or retirement of another original. */
export interface RepositoryWorkObservationInfoV2 {
  readonly operationRef: string;
  readonly observationRef: string;
  readonly workRef: string;
}

export interface RepositoryWorkObservationSummaryV2 extends RepositoryWorkObservationInfoV2 {
  readonly status: "reserved" | "pending" | "reconciling" | "recorded";
  readonly retirement: "not-started" | "retiring" | "failed" | "retired";
  readonly retained: boolean;
  readonly retention: "process";
  readonly durable: false;
}

export interface RepositoryWorkObservationOptionsV2 {
  readonly maximumResponsibilities: number;
}

type ObservationResult = "recorded" | "unavailable";
type Entry<O extends object> = {
  readonly original: O;
  readonly info: RepositoryWorkObservationInfoV2;
  status: RepositoryWorkObservationSummaryV2["status"];
  retirement: RepositoryWorkObservationSummaryV2["retirement"];
  task: Promise<ObservationResult> | undefined;
};

const infoKeys = ["operationRef", "observationRef", "workRef"] as const;

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** Descriptors avoid invoking getters, and rejecting proxies precedes all
 * reflective operations. Bounded, own data prevents mutable metadata aliases. */
function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isObject(value) || types.isProxy(value)) {
    throw new TypeError("repository-work-observation-invalid-data");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) {
    throw new TypeError("repository-work-observation-invalid-data");
  }
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => !keys.includes(key as string))
  ) {
    throw new TypeError("repository-work-observation-invalid-data");
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("repository-work-observation-invalid-data");
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function captureInfo(value: RepositoryWorkObservationInfoV2): RepositoryWorkObservationInfoV2 {
  const data = ownData(value, infoKeys);
  for (const key of infoKeys) {
    const reference = data[key];
    // The responsibility count and each reference have explicit finite bounds.
    if (typeof reference !== "string" || reference.length === 0 || reference.length > 4096) {
      throw new TypeError("repository-work-observation-invalid-reference");
    }
  }
  return Object.freeze({
    operationRef: data.operationRef as string,
    observationRef: data.observationRef as string,
    workRef: data.workRef as string,
  });
}

/** Accept ordinary object or class methods while capturing their fixed function
 * and original receiver once. Neither accessors nor proxy traps are invoked. */
function captureMethod<O extends object, R>(
  source: RepositoryWorkObservationSourceV2<O>,
  name: "reconcile" | "retire",
): (original: O) => Promise<R> {
  let current: object | null = source;
  for (let depth = 0; current !== null && depth < 32; depth += 1) {
    if (!isObject(current) || types.isProxy(current)) {
      throw new TypeError("repository-work-observation-invalid-source");
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      if (
        !("value" in descriptor) ||
        typeof descriptor.value !== "function" ||
        types.isProxy(descriptor.value)
      ) {
        throw new TypeError("repository-work-observation-invalid-source");
      }
      const method = descriptor.value;
      return (original: O) => Reflect.apply(method, source, [original]) as Promise<R>;
    }
    current = Object.getPrototypeOf(current);
  }
  throw new TypeError("repository-work-observation-invalid-source");
}

/** Finite process retention, not a durable State acknowledgement or restart
 * reconciler. The parent must reserve before State/provider work and activate
 * when historical responsibility begins. There is no eviction or active drop.
 * Every explicit attempt still runs through the parent's original recognizers. */
export class RepositoryWorkObservationOwnerV2<O extends object> {
  readonly #maximumResponsibilities: number;
  readonly #reconcileOriginal: (original: O) => Promise<ObservationResult>;
  readonly #retireOriginal: (original: O) => Promise<void>;
  readonly #entries = new WeakMap<O, Entry<O>>();
  readonly #registered = new WeakSet<O>();
  readonly #pending = new Set<Entry<O>>();
  readonly #recorded = Promise.resolve<ObservationResult>("recorded");

  constructor(
    source: RepositoryWorkObservationSourceV2<O>,
    options: RepositoryWorkObservationOptionsV2,
  ) {
    const maximum = ownData(options, ["maximumResponsibilities"]).maximumResponsibilities;
    if (
      typeof maximum !== "number" ||
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > 4096
    ) {
      throw new TypeError("repository-work-observation-invalid-capacity");
    }
    this.#maximumResponsibilities = maximum;
    this.#reconcileOriginal = captureMethod<O, ObservationResult>(source, "reconcile");
    this.#retireOriginal = captureMethod<O, void>(source, "retire");
  }

  register(original: O, info: RepositoryWorkObservationInfoV2): void {
    if (!isObject(original)) {
      throw new TypeError("repository-work-observation-invalid-original");
    }
    if (this.#registered.has(original)) {
      throw new Error("repository-work-observation-already-registered");
    }
    if (this.#pending.size >= this.#maximumResponsibilities) {
      throw new Error("repository-work-observation-capacity-exhausted");
    }
    const entry: Entry<O> = {
      original,
      info: captureInfo(info),
      status: "reserved",
      retirement: "not-started",
      task: undefined,
    };
    this.#registered.add(original);
    this.#entries.set(original, entry);
    this.#pending.add(entry);
  }

  activate(original: O): void {
    const entry = this.#entry(original);
    if (entry.status !== "reserved") {
      throw new Error("repository-work-observation-not-reserved");
    }
    entry.status = "pending";
  }

  /** Only failed preparation with no activated responsibility can free a
   * reservation. The discarded original cannot subsequently be registered. */
  discard(original: O): void {
    const entry = this.#entry(original);
    if (entry.status !== "reserved") {
      throw new Error("repository-work-observation-not-reserved");
    }
    this.#pending.delete(entry);
    this.#entries.delete(original);
  }

  inspect(original: O): RepositoryWorkObservationSummaryV2 {
    return this.#summary(this.#entry(original));
  }

  inspectPending(): readonly RepositoryWorkObservationSummaryV2[] {
    return Object.freeze(Array.from(this.#pending, (entry) => this.#summary(entry)));
  }

  /** A trusted process runner can advance one retained original without taking
   * custody of its handle. Selection is bounded and round-robin; this method
   * never enrolls from references, constructs authority, or starts a loop. */
  reconcileNext(): Promise<RepositoryWorkObservationSummaryV2 | null> {
    for (const entry of this.#pending) {
      if (entry.status === "reserved") continue;
      const original = entry.original;
      // Rotate before any source callback. Concurrent selections remain fair,
      // and an already in-flight selected original uses its installed task.
      this.#pending.delete(entry);
      this.#pending.add(entry);
      return this.reconcile(original).then(() => this.#summary(entry));
    }
    return Promise.resolve(null);
  }

  /** Intentionally not async: concurrent and synchronous reentrant callers
   * receive the exact same installed Promise. No callback runs before install. */
  reconcile(original: O): Promise<ObservationResult> {
    const entry = this.#entry(original);
    if (entry.status === "reserved") {
      throw new Error("repository-work-observation-not-active");
    }
    if (entry.task) return entry.task;
    if (entry.retirement === "retired") return this.#recorded;
    if (entry.status !== "recorded") entry.status = "reconciling";
    const task = Promise.resolve().then(() => this.#attempt(entry));
    entry.task = task;
    // Keep the exact task installed through async-result adoption. Clearing in
    // the attempt's finally would leave a gap before this Promise settles.
    const clear = () => {
      if (entry.task === task) entry.task = undefined;
    };
    void task.then(clear, clear);
    return task;
  }

  /** Join only the attempt already in flight at invocation. An idle pending or
   * failed responsibility stays idle until an explicit reconcile call. */
  join(original: O): Promise<RepositoryWorkObservationSummaryV2> {
    const entry = this.#entry(original);
    const task = entry.task;
    if (!task) return Promise.resolve(this.#summary(entry));
    return task.then(() => this.#summary(entry));
  }

  #entry(original: O): Entry<O> {
    const entry = this.#entries.get(original);
    if (!entry) throw new Error("repository-work-observation-unrecognized-original");
    return entry;
  }

  #summary(entry: Entry<O>): RepositoryWorkObservationSummaryV2 {
    return Object.freeze({
      operationRef: entry.info.operationRef,
      observationRef: entry.info.observationRef,
      workRef: entry.info.workRef,
      status: entry.status,
      retirement: entry.retirement,
      retained: this.#pending.has(entry),
      retention: "process",
      durable: false,
    });
  }

  async #attempt(entry: Entry<O>): Promise<ObservationResult> {
    if (entry.status !== "recorded") {
      try {
        const observation = this.#reconcileOriginal(entry.original);
        if (!types.isPromise(observation) || observation === entry.task) {
          entry.status = "pending";
          return "unavailable";
        }
        const result = await observation;
        if (result !== "recorded") {
          entry.status = "pending";
          return "unavailable";
        }
        entry.status = "recorded";
      } catch {
        // Original errors can carry secrets or dynamic properties. Retain
        // responsibility and report only the fixed unavailable outcome.
        entry.status = "pending";
        return "unavailable";
      }
    }
    // Recording latches permanently. A later explicit attempt can retry only
    // retirement, so a failed release cannot append the observation again.
    entry.retirement = "retiring";
    try {
      const retirement = this.#retireOriginal(entry.original);
      if (!types.isPromise(retirement) || Object.is(retirement, entry.task)) {
        entry.retirement = "failed";
        return "recorded";
      }
      await retirement;
      entry.retirement = "retired";
      this.#pending.delete(entry);
    } catch {
      entry.retirement = "failed";
    }
    return "recorded";
  }
}
