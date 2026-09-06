import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { Check } from "typebox/value";
import {
  RuntimeObservationResultSchemaV1,
  RUNTIME_EFFECT_LIMITS_V1,
  parseRuntimeEffectsV1,
  type RuntimeObservationResultV1,
} from "./runtime-effects-v1.ts";
import { RUNTIME_AUTHORITY_LIMITS_V1 } from "./runtime-authority-v1.ts";

/** In-process value accounting only. Supplied numbers never establish admission,
 * effective allocation, current identity, enforcement, or measured capacity. */
export const RUNTIME_RESOURCE_ACCOUNTING_VERSION_V1 = "runtime-resource-accounting-v1";
export const RUNTIME_RESOURCE_ACCOUNTING_BOUNDS_V1 = Object.freeze({
  maxInputUnits: 262_144,
  maxDepth: 32,
  maxContributions: 32,
  maxPhases: 64,
  maxStores: 32,
});

type Immutable<T> = T extends readonly (infer V)[]
  ? readonly Immutable<V>[]
  : T extends object
    ? { readonly [K in keyof T]: Immutable<T[K]> }
    : T;

const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const ref = Type.String({ minLength: 1, maxLength: 120, pattern: "^[A-Za-z0-9._:/-]+$" });
const accountingId = Type.String({
  minLength: 1,
  maxLength: 120,
  pattern: "^(?!pod$)[A-Za-z0-9._:/-]+$",
});
const quantity = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const input = <T extends TSchema>(schema: T) =>
  Type.Union([
    object({ status: Type.Literal("supplied"), ownerRef: ref, value: schema }),
    object({ status: Type.Literal("required"), ownerRef: ref }),
    object({
      status: Type.Literal("unavailable"),
      ownerRef: ref,
      reason: Type.Enum([
        "owner-input-missing",
        "producer-port-unavailable",
        "evidence-unavailable",
      ]),
    }),
    object({
      status: Type.Literal("unsupported"),
      ownerRef: ref,
      reason: Type.Enum(["profile-unsupported", "accounting-unsupported"]),
    }),
  ]);

export const RuntimeResourcePairSchemaV1 = object({ request: quantity, limit: quantity });
export const RuntimeResourceVectorSchemaV1 = object({
  cpuMilli: RuntimeResourcePairSchemaV1,
  memoryBytes: RuntimeResourcePairSchemaV1,
  ephemeralStorageBytes: RuntimeResourcePairSchemaV1,
});
export type RuntimeResourceVectorV1 = Immutable<Static<typeof RuntimeResourceVectorSchemaV1>>;
const resourceInputs = object({
  cpuMilli: input(RuntimeResourcePairSchemaV1),
  memoryBytes: input(RuntimeResourcePairSchemaV1),
  ephemeralStorageBytes: input(RuntimeResourcePairSchemaV1),
});
const contribution = object({
  accountingId,
  kind: Type.Enum(["application", "init", "restartable-init", "helper"]),
  resources: resourceInputs,
});
const overhead = object({
  accountingId,
  kind: Type.Enum(["runsc", "host-helper"]),
  // A single cost is charged here or through a node reservation, never both.
  chargedTo: Type.Enum(["pod", "node"]),
  resources: resourceInputs,
});
const phase = object({
  phaseRef: ref,
  kind: Type.Enum(["initialization", "steady"]),
  active: Type.Array(ref, { minItems: 1, maxItems: 32 }),
});
const processBudget = object({
  guestProcessLimit: positive,
  guestProcessBudget: quantity,
  podHostTaskLimit: positive,
  podHostTaskBudget: quantity,
  hostCoverage: Type.Literal("all-workload-runsc-helper-tasks"),
});
const logBudget = object({
  storageId: ref,
  maxBytes: positive,
  maxFileBytes: positive,
  maxFiles: positive,
  maxBytesPerSecond: positive,
  retentionSeconds: positive,
});
const store = object({
  accountingId,
  kind: Type.Enum([
    "runtime-home",
    "temporary",
    "writable-layer",
    "logs",
    "repository-staging",
    "workspace",
    "gateway-private",
    "other",
  ]),
  medium: Type.Enum(["disk-ephemeral", "memory", "retained"]),
  capacityBytes: positive,
  reservedBytes: quantity,
});
export const RuntimeWorkloadAccountingSchemaV1 = object({
  contributions: Type.Array(contribution, { minItems: 1, maxItems: 32 }),
  // All possible concurrent sets must be supplied by the original producer.
  // This contract does not discover or authorize an execution topology.
  phases: input(Type.Array(phase, { minItems: 1, maxItems: 64 })),
  overhead: input(Type.Array(overhead, { maxItems: 32 })),
  podBudget: input(RuntimeResourceVectorSchemaV1),
  execution: input(
    object({
      maxConcurrentInstances: Type.Integer({ minimum: 1, maximum: 32 }),
      maxAttempts: positive,
      totalPreparationMs: Type.Integer({
        minimum: 1,
        maximum: RUNTIME_AUTHORITY_LIMITS_V1.preparationMaxMs,
      }),
    }),
  ),
  processes: input(processBudget),
  logs: input(logBudget),
  storage: input(Type.Array(store, { minItems: 1, maxItems: 32 })),
  alternatives: input(
    Type.Array(
      object({
        source: Type.Enum(["explicit-override", "limitrange-default", "runtimeclass-default"]),
        accountingId: ref,
        resources: RuntimeResourceVectorSchemaV1,
      }),
      { maxItems: 32 },
    ),
  ),
});
export type RuntimeWorkloadAccountingV1 = Immutable<
  Static<typeof RuntimeWorkloadAccountingSchemaV1>
>;
const reservation = input(
  object({
    accountingId,
    resources: RuntimeResourceVectorSchemaV1,
    hostTasks: quantity,
    logBytes: quantity,
    retainedStorageBytes: quantity,
  }),
);
const workloadNames = ["gateway", "harness", "repositoryPreparation"] as const;
type WorkloadName = (typeof workloadNames)[number];
const externalNames = [
  "nodeSystem",
  "spire",
  "credentialMediator",
  "database",
  "ingress",
  "networkService",
] as const;

export const RuntimeResourceAccountingSchemaV1 = object({
  schemaVersion: Type.Literal(1),
  kind: Type.Literal(RUNTIME_RESOURCE_ACCOUNTING_VERSION_V1),
  envelopeRef: ref,
  envelopeVersion: positive,
  gateway: input(RuntimeWorkloadAccountingSchemaV1),
  harness: input(RuntimeWorkloadAccountingSchemaV1),
  // Separate owned input. No Harness fallback or Deployment observation coercion.
  repositoryPreparation: input(RuntimeWorkloadAccountingSchemaV1),
  workloadConcurrency: input(
    Type.Array(Type.Array(Type.Enum(workloadNames), { minItems: 1, maxItems: 3 }), {
      minItems: 1,
      maxItems: 8,
    }),
  ),
  externalReservations: object({
    nodeSystem: reservation,
    spire: reservation,
    credentialMediator: reservation,
    database: reservation,
    ingress: reservation,
    networkService: reservation,
  }),
  retainedStores: input(Type.Array(store, { minItems: 1, maxItems: 32 })),
  nodeBudget: input(RuntimeResourceVectorSchemaV1),
  nodeHostTaskLimit: input(positive),
  observations: object({
    gateway: input(RuntimeObservationResultSchemaV1),
    harness: input(RuntimeObservationResultSchemaV1),
  }),
  // TODO(resource producer port): replace only through an accepted resource
  // metering declaration from the existing Compute/containment producer owners.
  effectiveResources: object({
    status: Type.Literal("unavailable"),
    reason: Type.Literal("producer-port-unavailable"),
  }),
});
export type RuntimeResourceAccountingEnvelopeV1 = Immutable<
  Static<typeof RuntimeResourceAccountingSchemaV1>
>;
export type RuntimeResourceObservationV1 = Immutable<RuntimeObservationResultV1>;
type Input<T> =
  | { readonly status: "supplied"; readonly ownerRef: string; readonly value: T }
  | { readonly status: "required" | "unavailable" | "unsupported"; readonly ownerRef: string };
export type RuntimeResourceIssueCodeV1 =
  | "invalid-input"
  | "missing-budget"
  | "unavailable-budget"
  | "unsupported-budget"
  | "request-exceeds-limit"
  | "quantity-overflow"
  | "double-counting"
  | "invalid-concurrency"
  | "budget-exceeded"
  | "default-conflict"
  | "invalid-storage"
  | "missing-runsc-overhead";
export interface RuntimeResourceIssueV1 {
  readonly code: RuntimeResourceIssueCodeV1;
  readonly path: string;
}
export interface RuntimeResourceAccountingResultV1 {
  readonly status: "accounted" | "incomplete" | "invalid";
  readonly issues: readonly RuntimeResourceIssueV1[];
  readonly totals: Readonly<Record<WorkloadName, RuntimeResourceVectorV1 | null>> & {
    readonly node: RuntimeResourceVectorV1 | null;
    readonly retainedBytes: number | null;
    readonly nodeHostTasks: number | null;
  };
  readonly evidence: "supplied-accounting-only";
  readonly effectiveResources: "unavailable";
}

function invalid(): never {
  throw new Error("Invalid runtime resource accounting V1 value.");
}
function freeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}
function snapshot(value: unknown, depth = 0, budget = { left: 262_144 }): unknown {
  if (depth > 32 || --budget.left < 0) invalid();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) invalid();
    return value;
  }
  if (typeof value === "string") {
    budget.left -= value.length;
    if (budget.left < 0 || /[\ud800-\udfff]/u.test(value)) invalid();
    return value;
  }
  if (typeof value !== "object") invalid();
  const array = Array.isArray(value);
  if (array && (Object.getPrototypeOf(value) !== Array.prototype || value.length > 1024)) invalid();
  if (
    !array &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    invalid();
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) invalid();
  const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key))
      invalid();
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) invalid();
    budget.left -= key.length;
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !("value" in field) || !field.enumerable) invalid();
    (result as Record<string, unknown>)[key] = snapshot(field.value, depth + 1, budget);
  }
  return result;
}

/** Strict bounded snapshot; existing observation semantics stay with IFC-04. */
export function parseRuntimeResourceAccountingV1(
  value: unknown,
): RuntimeResourceAccountingEnvelopeV1 {
  try {
    const copy = snapshot(value);
    if (!Check(RuntimeResourceAccountingSchemaV1, copy)) invalid();
    const envelope = copy as Static<typeof RuntimeResourceAccountingSchemaV1>;
    for (const component of ["gateway", "harness"] as const) {
      const field = envelope.observations[component];
      if (field.status === "supplied") {
        const observation = parseRuntimeEffectsV1("observationResult", field.value);
        const target =
          observation.input.kind === "bound-instance"
            ? observation.input.target
            : observation.input.createEffect.effect.target;
        if (target.component !== component) invalid();
      }
    }
    return freeze(envelope);
  } catch {
    return invalid();
  }
}

const dimensions = ["cpuMilli", "memoryBytes", "ephemeralStorageBytes"] as const;
type MutableVector = { [K in (typeof dimensions)[number]]: { request: number; limit: number } };
const zero = (): MutableVector => ({
  cpuMilli: { request: 0, limit: 0 },
  memoryBytes: { request: 0, limit: 0 },
  ephemeralStorageBytes: { request: 0, limit: 0 },
});

/** Compare finite declared demands and budgets. This function performs no I/O,
 * fallback/default application, profile admission or observed-capacity check. */
export function validateRuntimeResourceAccountingV1(
  value: unknown,
): RuntimeResourceAccountingResultV1 {
  const totals: {
    gateway: RuntimeResourceVectorV1 | null;
    harness: RuntimeResourceVectorV1 | null;
    repositoryPreparation: RuntimeResourceVectorV1 | null;
    node: RuntimeResourceVectorV1 | null;
    retainedBytes: number | null;
    nodeHostTasks: number | null;
  } = {
    gateway: null,
    harness: null,
    repositoryPreparation: null,
    node: null,
    retainedBytes: null,
    nodeHostTasks: null,
  };
  const issues: RuntimeResourceIssueV1[] = [];
  let malformed = false;
  const report = (code: RuntimeResourceIssueCodeV1, path: string) => {
    if (!["missing-budget", "unavailable-budget", "unsupported-budget"].includes(code))
      malformed = true;
    issues.push({ code, path });
  };
  const result = (): RuntimeResourceAccountingResultV1 => {
    let status: RuntimeResourceAccountingResultV1["status"] = "accounted";
    if (issues.length) status = "incomplete";
    if (malformed) status = "invalid";
    return freeze({
      status,
      issues,
      totals,
      evidence: "supplied-accounting-only",
      effectiveResources: "unavailable",
    });
  };
  let envelope: RuntimeResourceAccountingEnvelopeV1;
  try {
    envelope = parseRuntimeResourceAccountingV1(value);
  } catch {
    report("invalid-input", "$root");
    return result();
  }
  function supplied<T>(field: Input<T>, path: string): T | undefined {
    if (field.status === "supplied") return field.value;
    if (field.status === "required") report("missing-budget", path);
    else if (field.status === "unavailable") report("unavailable-budget", path);
    else report("unsupported-budget", path);
    return undefined;
  }
  const identities = new Set<string>();
  function identify(id: string, path: string): void {
    if (identities.has(id)) report("double-counting", path);
    identities.add(id);
  }
  function add(a: number, b: number, path: string): number {
    if (!Number.isSafeInteger(a + b)) {
      report("quantity-overflow", path);
      return 0;
    }
    return a + b;
  }
  function vector(v: RuntimeResourceVectorV1, path: string): RuntimeResourceVectorV1 {
    for (const d of dimensions)
      if (v[d].request > v[d].limit) report("request-exceeds-limit", `${path}.${d}`);
    return v;
  }
  function resources(
    v: Static<typeof resourceInputs> | Immutable<Static<typeof resourceInputs>>,
    path: string,
  ): RuntimeResourceVectorV1 | undefined {
    const result = zero();
    let complete = true;
    for (const d of dimensions) {
      const pair = supplied(v[d], `${path}.${d}`);
      if (pair) result[d] = { ...pair };
      else complete = false;
    }
    vector(result, path);
    return complete ? result : undefined;
  }
  function sum(
    a: RuntimeResourceVectorV1,
    b: RuntimeResourceVectorV1,
    path: string,
  ): MutableVector {
    const result = zero();
    for (const d of dimensions)
      for (const k of ["request", "limit"] as const)
        result[d][k] = add(a[d][k], b[d][k], `${path}.${d}.${k}`);
    return result;
  }
  function peak(a: RuntimeResourceVectorV1, b: RuntimeResourceVectorV1): MutableVector {
    const result = zero();
    for (const d of dimensions)
      for (const k of ["request", "limit"] as const) result[d][k] = Math.max(a[d][k], b[d][k]);
    return result;
  }
  function fits(a: RuntimeResourceVectorV1, b: RuntimeResourceVectorV1, path: string): void {
    for (const d of dimensions)
      for (const k of ["request", "limit"] as const)
        if (a[d][k] > b[d][k]) report("budget-exceeded", `${path}.${d}.${k}`);
  }
  const nodes = new Map<WorkloadName, RuntimeResourceVectorV1>();
  const hostTasks = new Map<WorkloadName, number>();
  for (const name of workloadNames) {
    const workload = supplied(envelope[name], name);
    if (!workload) continue;
    const costs = new Map<string, RuntimeResourceVectorV1>();
    for (const [i, c] of workload.contributions.entries()) {
      const path = `${name}.contributions[${i}]`;
      identify(c.accountingId, path);
      const v = resources(c.resources, path);
      if (v) costs.set(c.accountingId, v);
    }
    const phases = supplied(workload.phases, `${name}.phases`);
    let complete = costs.size === workload.contributions.length && phases !== undefined;
    let pod = zero();
    if (workload.contributions.filter((c) => c.kind === "application").length !== 1)
      report("invalid-concurrency", `${name}.contributions`);
    if (phases) {
      const visited = new Set<string>();
      const phaseRefs = new Set<string>();
      const steady = workload.contributions
        .filter((c) => c.kind !== "init")
        .map((c) => c.accountingId);
      let steadyCount = 0;
      for (const [i, p] of phases.entries()) {
        const path = `${name}.phases[${i}]`;
        let current = zero();
        if (phaseRefs.has(p.phaseRef)) report("invalid-concurrency", path);
        phaseRefs.add(p.phaseRef);
        if (new Set(p.active).size !== p.active.length) report("double-counting", path);
        if (p.kind === "steady") {
          steadyCount++;
          if (p.active.length !== steady.length || steady.some((id) => !p.active.includes(id)))
            report("invalid-concurrency", path);
        }
        for (const id of p.active) {
          visited.add(id);
          if (!workload.contributions.some((c) => c.accountingId === id))
            report("invalid-concurrency", path);
          const cost = costs.get(id);
          if (cost) current = sum(current, cost, path);
        }
        pod = peak(pod, current);
      }
      if (steadyCount !== 1 || workload.contributions.some((c) => !visited.has(c.accountingId)))
        report("invalid-concurrency", `${name}.phases`);
    }
    let nodeExtra = zero();
    const overheads = supplied(workload.overhead, `${name}.overhead`);
    if (!overheads) complete = false;
    else {
      if (name !== "gateway" && overheads.filter((c) => c.kind === "runsc").length !== 1)
        report("missing-runsc-overhead", `${name}.overhead`);
      for (const [i, c] of overheads.entries()) {
        const path = `${name}.overhead[${i}]`;
        identify(c.accountingId, path);
        const v = resources(c.resources, path);
        if (!v) {
          complete = false;
          continue;
        }
        costs.set(c.accountingId, v);
        if (c.chargedTo === "pod") pod = sum(pod, v, path);
        else nodeExtra = sum(nodeExtra, v, path);
      }
    }
    const budget = supplied(workload.podBudget, `${name}.podBudget`);
    if (budget) {
      vector(budget, `${name}.podBudget`);
      if (complete) fits(pod, budget, `${name}.podBudget`);
    }
    const execution = supplied(workload.execution, `${name}.execution`);
    const processes = supplied(workload.processes, `${name}.processes`);
    if (
      processes &&
      (processes.guestProcessBudget > processes.guestProcessLimit ||
        processes.podHostTaskBudget > processes.podHostTaskLimit)
    )
      report("budget-exceeded", `${name}.processes`);
    if (execution && processes) {
      const count = execution.maxConcurrentInstances * processes.podHostTaskBudget;
      if (!Number.isSafeInteger(count)) report("quantity-overflow", `${name}.processes`);
      else hostTasks.set(name, count);
    }
    const stores = supplied(workload.storage, `${name}.storage`);
    if (stores) {
      let disk = 0;
      let memory = 0;
      for (const [i, s] of stores.entries()) {
        const path = `${name}.storage[${i}]`;
        identify(s.accountingId, path);
        if (s.medium === "retained" || ["workspace", "gateway-private"].includes(s.kind))
          report("invalid-storage", path);
        if (s.reservedBytes > s.capacityBytes) report("budget-exceeded", path);
        if (s.medium === "disk-ephemeral") disk = add(disk, s.reservedBytes, path);
        if (s.medium === "memory") memory = add(memory, s.reservedBytes, path);
      }
      // Storage and log reservations are subsets of the Pod budget, not a second
      // addition of emptyDir/log bytes to container resource limits.
      if (
        budget &&
        (disk > budget.ephemeralStorageBytes.limit || memory > budget.memoryBytes.limit)
      )
        report("budget-exceeded", `${name}.storage`);
    }
    const logs = supplied(workload.logs, `${name}.logs`);
    if (logs) {
      const bytes = logs.maxFileBytes * logs.maxFiles;
      if (!Number.isSafeInteger(bytes)) report("quantity-overflow", `${name}.logs`);
      else if (bytes > logs.maxBytes) report("budget-exceeded", `${name}.logs`);
      if (stores) {
        const bucket = stores.find((s) => s.accountingId === logs.storageId);
        if (!bucket || logs.maxBytes > bucket.reservedBytes)
          report("invalid-storage", `${name}.logs`);
      }
    }
    const alternatives = supplied(workload.alternatives, `${name}.alternatives`);
    if (alternatives)
      for (const [i, alternative] of alternatives.entries()) {
        const path = `${name}.alternatives[${i}]`;
        vector(alternative.resources, path);
        const selected =
          alternative.accountingId === "pod" ? budget : costs.get(alternative.accountingId);
        if (
          !selected ||
          dimensions.some((d) =>
            ["request", "limit"].some(
              (k) =>
                selected[d][k as "request" | "limit"] !==
                alternative.resources[d][k as "request" | "limit"],
            ),
          )
        )
          report("default-conflict", path);
      }
    if (complete && budget && execution) {
      totals[name] = pod;
      // Node reservation uses the declared Pod envelope, even if its limits are
      // larger than the phase peak. Unused declared reservation is not reclaimed.
      let concurrent = zero();
      const single = sum(budget, nodeExtra, `${name}.node`);
      for (let i = 0; i < execution.maxConcurrentInstances; i++)
        concurrent = sum(concurrent, single, `${name}.node`);
      nodes.set(name, concurrent);
    }
  }
  const concurrency = supplied(envelope.workloadConcurrency, "workloadConcurrency");
  let node = zero();
  let nodeComplete = nodes.size === 3 && concurrency !== undefined;
  let nodeTasks = 0;
  let tasksComplete = hostTasks.size === 3 && concurrency !== undefined;
  if (concurrency) {
    const covered = new Set<WorkloadName>();
    const groups = new Set<string>();
    for (const [i, group] of concurrency.entries()) {
      const path = `workloadConcurrency[${i}]`;
      const key = [...group].sort().join(",");
      if (new Set(group).size !== group.length || groups.has(key)) report("double-counting", path);
      groups.add(key);
      let current = zero();
      let currentTasks = 0;
      for (const name of group) {
        covered.add(name);
        const v = nodes.get(name);
        if (v) current = sum(current, v, path);
        const tasks = hostTasks.get(name);
        if (tasks !== undefined) currentTasks = add(currentTasks, tasks, path);
      }
      node = peak(node, current);
      nodeTasks = Math.max(nodeTasks, currentTasks);
    }
    if (
      covered.size !== 3 ||
      !concurrency.some((g) => g.includes("gateway") && g.includes("harness"))
    )
      report("invalid-concurrency", "workloadConcurrency");
  }
  let externalRetainedBytes = 0;
  let retainedComplete = true;
  for (const name of externalNames) {
    const path = `externalReservations.${name}`;
    const reservation = supplied(envelope.externalReservations[name], path);
    if (!reservation) {
      nodeComplete = false;
      tasksComplete = false;
      retainedComplete = false;
      continue;
    }
    identify(reservation.accountingId, path);
    vector(reservation.resources, path);
    if (reservation.logBytes > reservation.resources.ephemeralStorageBytes.limit)
      report("budget-exceeded", path);
    node = sum(node, reservation.resources, path);
    nodeTasks = add(nodeTasks, reservation.hostTasks, path);
    externalRetainedBytes = add(externalRetainedBytes, reservation.retainedStorageBytes, path);
  }
  const nodeBudget = supplied(envelope.nodeBudget, "nodeBudget");
  if (nodeBudget) {
    vector(nodeBudget, "nodeBudget");
    if (nodeComplete) fits(node, nodeBudget, "nodeBudget");
  }
  if (nodeComplete && nodeBudget) totals.node = node;
  const hostLimit = supplied(envelope.nodeHostTaskLimit, "nodeHostTaskLimit");
  if (hostLimit !== undefined && tasksComplete) {
    if (nodeTasks > hostLimit) report("budget-exceeded", "nodeHostTaskLimit");
    totals.nodeHostTasks = nodeTasks;
  }
  const stores = supplied(envelope.retainedStores, "retainedStores");
  if (stores) {
    let bytes = externalRetainedBytes;
    for (const [i, s] of stores.entries()) {
      const path = `retainedStores[${i}]`;
      identify(s.accountingId, path);
      if (s.medium !== "retained" || !["workspace", "gateway-private"].includes(s.kind))
        report("invalid-storage", path);
      if (s.reservedBytes > s.capacityBytes) report("budget-exceeded", path);
      bytes = add(bytes, s.reservedBytes, path);
    }
    if (
      stores.filter((s) => s.kind === "workspace").length !== 1 ||
      stores.filter((s) => s.kind === "gateway-private").length !== 1
    )
      report("invalid-storage", "retainedStores");
    if (retainedComplete) totals.retainedBytes = bytes;
  }
  // Partial or invalid arithmetic is never exposed as a usable aggregate.
  if (malformed)
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] = null;
  return result();
}

export type RuntimeResourceDeadlineKindV1 =
  | "preparationMaxMs"
  | "providerRequestMaxMs"
  | "lookupMaxMs"
  | "observationMaxAgeMs"
  | "clockUncertaintyMaxMs"
  | "activeRecheckMaxMs"
  | "gracefulStopMaxMs"
  | "terminationObservationMaxMs";
/** Caller-supplied remaining time is arithmetic input, not a trusted clock. */
export function runtimeResourceDeadlineBudgetV1(
  kind: RuntimeResourceDeadlineKindV1,
  remainingMs: number,
  purposeMaxMs: number,
): number {
  if (
    ![
      "preparationMaxMs",
      "providerRequestMaxMs",
      "lookupMaxMs",
      "observationMaxAgeMs",
      "clockUncertaintyMaxMs",
      "activeRecheckMaxMs",
      "gracefulStopMaxMs",
      "terminationObservationMaxMs",
    ].includes(kind) ||
    !Number.isSafeInteger(remainingMs) ||
    remainingMs < 0 ||
    Object.is(remainingMs, -0) ||
    !Number.isSafeInteger(purposeMaxMs) ||
    purposeMaxMs <= 0
  )
    invalid();
  return Math.min(RUNTIME_AUTHORITY_LIMITS_V1[kind], remainingMs, purposeMaxMs);
}
/** Reuse canonical ceilings/backoff and the explicitly unmeasured denial target. */
export { RUNTIME_AUTHORITY_LIMITS_V1, RUNTIME_EFFECT_LIMITS_V1 };
export interface RuntimeResourceAccountingV1 {
  parse(input: unknown): RuntimeResourceAccountingEnvelopeV1;
  validate(input: unknown): RuntimeResourceAccountingResultV1;
  deadlineBudget(
    kind: RuntimeResourceDeadlineKindV1,
    remainingMs: number,
    purposeMaxMs: number,
  ): number;
}
export const runtimeResourceAccountingV1: RuntimeResourceAccountingV1 = Object.freeze({
  parse: parseRuntimeResourceAccountingV1,
  validate: validateRuntimeResourceAccountingV1,
  deadlineBudget: runtimeResourceDeadlineBudgetV1,
});
