import { createHash } from "node:crypto";
import { types } from "node:util";
import { Check } from "typebox/value";
import type { Static, TSchema } from "typebox";
import {
  NATIVE_MEASUREMENT_LIMITS_V1 as limits,
  NATIVE_MEASUREMENT_CASES_V1 as caseIds,
  NativeMeasurementProfileSchemaV1,
  NativeMeasurementResultsSchemaV1,
  type NativeMeasurementProfileV1,
  type NativeMeasurementResultsV1,
  type NativeMeasurementCaseIdV1,
  type NativeMeasurementCaseResultV1,
  type NativeMeasurementEvaluationV1,
  type NativeMeasurementDecodeV1,
} from "./native-measurement-v1.ts";

function invalid(): never {
  throw new Error("invalid-input");
}
function scalar(value: string): void {
  if (value.length > limits.maxBytes) invalid();
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(++i);
      if (!(n >= 0xdc00 && n <= 0xdfff)) invalid();
    } else if (c >= 0xdc00 && c <= 0xdfff) invalid();
  }
}
/** Copies JSON data through descriptors; getters, proxies, cycles and class instances fail. */
function snapshot(input: unknown): unknown {
  let nodes = 0,
    bytes = 0;
  const seen = new Set<object>();
  const charge = (n: number): void => {
    if ((bytes += n) > limits.maxBytes) invalid();
  };
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) invalid();
    if (value === null || typeof value === "boolean") {
      charge(5);
      return value;
    }
    if (typeof value === "string") {
      scalar(value);
      charge(Buffer.byteLength(JSON.stringify(value)));
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) invalid();
      charge(String(value).length);
      return value;
    }
    if (typeof value !== "object" || types.isProxy(value) || seen.has(value)) invalid();
    seen.add(value);
    const array = Array.isArray(value),
      proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length > limits.maxEntries + (array ? 1 : 0)) invalid();
    if (array && keys.length !== value.length + 1) invalid();
    charge(2 + keys.length);
    const out: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string") invalid();
      if (array && key === "length") continue;
      scalar(key);
      if (!array) charge(Buffer.byteLength(JSON.stringify(key)) + 1);
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) invalid();
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !d.enumerable || !("value" in d)) invalid();
      Object.defineProperty(out, key, { value: copy(d.value, depth + 1), enumerable: true });
    }
    return Object.freeze(out);
  };
  return copy(input, 0);
}
/** Bounded JSON grammar with duplicate-key detection BEFORE object construction. */
function json(input: unknown): unknown {
  if (
    typeof input !== "string" ||
    input.length > limits.maxBytes ||
    Buffer.byteLength(input) > limits.maxBytes
  )
    invalid();
  scalar(input);
  let i = 0,
    nodes = 0;
  const ws = (): void => {
    while (i < input.length && /[\x20\t\r\n]/.test(input[i]!)) i++;
  };
  const string = (): string => {
    if (input[i++] !== '"') invalid();
    const start = i - 1;
    while (i < input.length) {
      const c = input[i++];
      if (c === '"') {
        const s: unknown = JSON.parse(input.slice(start, i));
        if (typeof s !== "string") invalid();
        scalar(s);
        return s;
      }
      if (c === "\\") i++;
    }
    return invalid();
  };
  const value = (depth: number): unknown => {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) invalid();
    ws();
    const c = input[i];
    if (c === '"') return string();
    if (c === "{" || c === "[") {
      i++;
      ws();
      const array = c === "[",
        end = array ? "]" : "}";
      const out: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
      const keys = new Set<string>();
      let count = 0;
      if (input[i] === end) {
        i++;
        return out;
      }
      for (;;) {
        if (++count > limits.maxEntries) invalid();
        ws();
        const key = array ? String(count - 1) : string();
        if (keys.has(key)) invalid();
        keys.add(key);
        if (!array) {
          ws();
          if (input[i++] !== ":") invalid();
        }
        Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true });
        ws();
        const next = input[i++];
        if (next === end) return out;
        if (next !== ",") invalid();
      }
    }
    for (const [token, decoded] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (input.startsWith(token, i)) {
        i += token.length;
        return decoded;
      }
    }
    const m = /^(?:0|[1-9][0-9]*)/.exec(input.slice(i, i + 64));
    if (!m) invalid();
    i += m[0].length;
    const n = Number(m[0]);
    if (!Number.isSafeInteger(n) || n < 0) invalid();
    return n;
  };
  const result = value(0);
  ws();
  if (i !== input.length) invalid();
  return result;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}
function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function unique(items: readonly unknown[]): void {
  if (new Set(items).size !== items.length) invalid();
}
const retention = (id: NativeMeasurementCaseIdV1): boolean =>
  id === "cancel-retention" || id === "reconnect-retention";
function checkSubject(subject: NativeMeasurementProfileV1["subject"]): void {
  if (subject.generatedClients.state === "selected")
    unique(subject.generatedClients.clients.map((c) => c.language));
}
function checkProfile(p: NativeMeasurementProfileV1): void {
  unique(p.cases.map((c) => c.id));
  checkSubject(p.subject);
  for (const selected of [p.resourceProfile.expectation, p.resourceProfile.observed]) {
    if (selected.state === "unselected" || selected.state === "unknown") continue;
    for (const role of Object.values(selected.roles)) {
      const pairs = [role.cpuMillicores, role.memoryBytes];
      if (role.ephemeralStorageBytes.state === "selected")
        pairs.push(role.ephemeralStorageBytes.values);
      if (pairs.some((pair) => pair.request > pair.limit)) invalid();
    }
  }
  if (
    p.resourceProfile.expectation.state === "selected" &&
    p.resourceProfile.observed.state === "observed"
  ) {
    if (
      canonical(p.resourceProfile.expectation.roles) !== canonical(p.resourceProfile.observed.roles)
    )
      invalid();
    const config = p.subject.artifacts.effectiveConfiguration;
    if (
      config.state !== "known" ||
      config.digest !== p.resourceProfile.observed.effectiveConfigurationDigest
    )
      invalid();
  }
  if (p.workload.model === "actual-provider" && p.evidenceKind !== "actual-provider") invalid();
  if (p.evidenceKind === "actual-provider" && p.workload.model !== "actual-provider") invalid();
  if (p.workload.outputCaptureBytes < p.workload.resultUtf8Bytes) invalid();
  const totalSlots = p.cases.reduce(
    (total, c) => total + c.cycles * (c.warmupPerCycle + c.samplesPerCycle),
    0,
  );
  if (totalSlots > limits.maxTotalSamples) invalid();
  for (const c of p.cases) {
    if (c.cycles * (c.warmupPerCycle + c.samplesPerCycle) > limits.maxSamplesPerCase) invalid();
    if (
      c.applicability === "not-applicable" &&
      (c.id !== "model-service" || p.workload.model !== "none")
    )
      invalid();
    if (
      c.id === "model-service" &&
      p.workload.model === "none" &&
      c.applicability !== "not-applicable"
    )
      invalid();
    if (retention(c.id)) {
      if (c.latencyBudget.state !== "unselected") invalid();
    } else if (c.resourceTolerance.state !== "unselected") invalid();
    if (
      c.latencyBudget.state === "selected" &&
      (c.latencyBudget.p95Us > c.latencyBudget.maxUs ||
        p.clock.resolutionUs > c.latencyBudget.p95Us)
    )
      invalid();
  }
}
function checkResults(r: NativeMeasurementResultsV1): void {
  checkSubject(r.subject);
  unique(r.discovered);
  unique(r.selected);
  unique(r.records.map((c) => c.id));
  if (r.selected.some((id) => !r.discovered.includes(id))) invalid();
  for (const c of r.records) {
    if (!r.selected.includes(c.id)) invalid();
    if (c.state !== "samples") continue;
    unique(c.samples.map((s) => `${s.cycle}:${s.phase}:${s.index}`));
    unique(
      c.samples
        .filter((s) => s.state === "latency" || s.state === "resources")
        .map((s) => s.evidenceRef),
    );
    for (const s of c.samples) {
      if (s.state === "missing" || s.state === "unknown") {
        if ((s.state === "missing") !== (s.reason === "not-recorded")) invalid();
        continue;
      }
      if (s.endUs < s.startUs || (s.state === "resources") !== retention(c.id)) invalid();
      if (s.state === "latency" && s.domainOutcome === "unknown" && c.id !== "reconnect-ready")
        invalid();
      if (s.state === "resources" && (s.settledAtUs < s.startUs || s.settledAtUs > s.endUs))
        invalid();
    }
  }
}
function decode<S extends TSchema>(
  schema: S,
  input: unknown,
  validate: (value: Static<S>) => void,
): NativeMeasurementDecodeV1<Static<S>> {
  try {
    const value = snapshot(input);
    if (!Check(schema, value)) invalid();
    validate(value as Static<S>);
    return Object.freeze({ kind: "valid", value: value as Static<S> });
  } catch {
    return Object.freeze({ kind: "invalid", reason: "invalid-input" });
  }
}
export function decodeNativeMeasurementProfileV1(
  input: unknown,
): NativeMeasurementDecodeV1<NativeMeasurementProfileV1> {
  return decode(NativeMeasurementProfileSchemaV1, input, checkProfile);
}
export function decodeNativeMeasurementResultsV1(
  input: unknown,
): NativeMeasurementDecodeV1<NativeMeasurementResultsV1> {
  return decode(NativeMeasurementResultsSchemaV1, input, checkResults);
}
export function decodeNativeMeasurementProfileJsonV1(
  input: unknown,
): NativeMeasurementDecodeV1<NativeMeasurementProfileV1> {
  try {
    return decodeNativeMeasurementProfileV1(json(input));
  } catch {
    return Object.freeze({ kind: "invalid", reason: "invalid-input" });
  }
}
export function decodeNativeMeasurementResultsJsonV1(
  input: unknown,
): NativeMeasurementDecodeV1<NativeMeasurementResultsV1> {
  try {
    return decodeNativeMeasurementResultsV1(json(input));
  } catch {
    return Object.freeze({ kind: "invalid", reason: "invalid-input" });
  }
}
export function nativeMeasurementProfileDigestV1(
  input: unknown,
): NativeMeasurementDecodeV1<string> {
  const decoded = decodeNativeMeasurementProfileV1(input);
  return decoded.kind === "invalid"
    ? decoded
    : Object.freeze({ kind: "valid", value: digest(decoded.value) });
}

/** External retained expectation is mandatory: report data cannot select its own budgets.
 * A numerical pass still proves neither the truth of its observations nor runtime qualification. */
export function evaluateNativeMeasurementsV1(
  expected: unknown,
  input: unknown,
): NativeMeasurementDecodeV1<NativeMeasurementEvaluationV1> {
  const pd = decodeNativeMeasurementProfileV1(expected),
    rd = decodeNativeMeasurementResultsV1(input);
  if (pd.kind === "invalid" || rd.kind === "invalid")
    return Object.freeze({ kind: "invalid", reason: "invalid-input" });
  try {
    const p = pd.value,
      r = rd.value;
    if (
      r.profileDigest !== digest(p) ||
      canonical(r.subject) !== canonical(p.subject) ||
      r.evidenceKind !== p.evidenceKind
    )
      invalid();
    const selectedPolicy =
      p.decision.state === "selected" &&
      p.resourceProfile.expectation.state === "selected" &&
      p.resourceProfile.observed.state === "observed" &&
      Object.values(p.resourceProfile.observed.roles).every(
        (role) => role.ephemeralStorageBytes.state === "selected",
      );
    const knownArtifacts = Object.values(p.subject.artifacts).every((v) => v.state === "known");
    const counts = {
      expected: caseIds.length,
      discovered: r.discovered.length,
      selected: r.selected.length,
      pass: 0,
      fail: 0,
      skip: 0,
      unselected: 0,
      blocked: 0,
      missing: 0,
      unknown: 0,
    };
    const cases: NativeMeasurementCaseResultV1[] = [];
    let requiredSkip = false;
    for (const id of caseIds) {
      const c = p.cases.find((v) => v.id === id)!;
      const expectedSamples = c.cycles * c.samplesPerCycle;
      const allSlots = c.cycles * (c.samplesPerCycle + c.warmupPerCycle);
      const row = {
        id,
        outcome: "missing" as NativeMeasurementCaseResultV1["outcome"],
        expectedSamples,
        observedSamples: 0,
        missingSamples: 0,
        unknownSamples: 0,
        warmupSamples: 0,
        domainUnknownSamples: 0,
        distributionUs: null as NativeMeasurementCaseResultV1["distributionUs"],
      };
      const record = r.records.find((v) => v.id === id);
      if (!r.selected.includes(id)) row.outcome = "unselected";
      else if (!record) {
        row.outcome = "missing";
        row.missingSamples = allSlots;
      } else if (record.state !== "samples") {
        if (
          record.reason === "not-applicable" &&
          (record.state !== "skip" || c.applicability !== "not-applicable")
        )
          invalid();
        if (
          record.state === "skip" &&
          c.applicability === "not-applicable" &&
          record.reason !== "not-applicable"
        )
          invalid();
        row.outcome = record.state;
        if (record.state === "skip" && c.applicability === "required") requiredSkip = true;
      } else {
        if (c.applicability !== "required") invalid();
        const values: number[] = [];
        let exceeds = false;
        let resourceBaseline: string | undefined;
        row.missingSamples = allSlots - record.samples.length;
        for (const s of record.samples) {
          if (
            s.cycle >= c.cycles ||
            s.index >= (s.phase === "warmup" ? c.warmupPerCycle : c.samplesPerCycle)
          )
            invalid();
          if (s.state === "missing") {
            row.missingSamples++;
            continue;
          }
          if (s.state === "unknown") {
            row.unknownSamples++;
            continue;
          }
          if (s.clockOriginRef !== p.clock.originRef) invalid();
          if (
            s.workload.overflow ||
            s.workload.inputUtf8Bytes !== p.workload.inputUtf8Bytes ||
            s.workload.resultUtf8Bytes !== p.workload.resultUtf8Bytes ||
            s.workload.outputCaptureBytes > p.workload.outputCaptureBytes
          )
            exceeds = true;
          if (s.state === "latency" && s.domainOutcome === "unknown") row.domainUnknownSamples++;
          if (s.phase === "warmup") {
            row.warmupSamples++;
            continue;
          }
          if (s.state === "resources") {
            const baseline = canonical(s.before);
            if (resourceBaseline !== undefined && baseline !== resourceBaseline) invalid();
            resourceBaseline = baseline;
          }
          row.observedSamples++;
          if (s.state === "latency") values.push(s.endUs - s.startUs);
          else if (c.resourceTolerance.state === "selected") {
            const t = c.resourceTolerance;
            if (s.endUs - s.settledAtUs > t.settleWindowUs) exceeds = true;
            for (const key of Object.keys(s.before) as (keyof typeof s.before)[]) {
              if (
                s.after[key] > s.before[key] &&
                s.after[key] - s.before[key] > t.maximumGrowth[key]
              )
                exceeds = true;
            }
          }
        }
        if (values.length) {
          values.sort((a, b) => a - b);
          const percentile = (n: number): number =>
            values[Math.ceil((values.length * n) / 100) - 1]!;
          row.distributionUs = Object.freeze({
            p50: percentile(50),
            p95: percentile(95),
            p99: percentile(99),
            max: values[values.length - 1]!,
          });
          if (
            c.latencyBudget.state === "selected" &&
            (row.distributionUs.p95 > c.latencyBudget.p95Us ||
              row.distributionUs.max > c.latencyBudget.maxUs)
          )
            exceeds = true;
        }
        const budgetSelected = retention(id)
          ? c.resourceTolerance.state === "selected"
          : c.latencyBudget.state === "selected";
        if (exceeds) row.outcome = "fail";
        else if (row.unknownSamples) row.outcome = "unknown";
        else if (row.missingSamples) row.outcome = "missing";
        else if (!selectedPolicy || !budgetSelected || !knownArtifacts) row.outcome = "blocked";
        else row.outcome = "pass";
      }
      counts[row.outcome]++;
      cases.push(Object.freeze(row));
    }
    const incomplete =
      requiredSkip || counts.unselected + counts.blocked + counts.missing + counts.unknown > 0;
    const verdict = counts.fail ? "fail" : incomplete ? "incomplete" : "pass";
    return Object.freeze({
      kind: "valid",
      value: Object.freeze({
        format: "native-measurement-evaluation-v1",
        evidenceKind: r.evidenceKind,
        verdict,
        counts: Object.freeze(counts),
        cases: Object.freeze(cases),
        evidenceAuthenticated: false,
        runtimeQualified: false,
      }),
    });
  } catch {
    return Object.freeze({ kind: "invalid", reason: "invalid-input" });
  }
}
