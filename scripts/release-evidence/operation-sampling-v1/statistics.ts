import { SAMPLING_LIMITS_V1, type SamplingClockV1 } from "./schema.ts";

export type DurationV1 =
  | { state: "unavailable"; reason: string }
  | {
      state: "available";
      clockDomain: string;
      method: "monotonic" | "same-domain-wall";
      milliseconds: number;
      lowerMs: number;
      upperMs: number;
    };
/** Unknown clock relations never become cross-domain wall-clock subtraction. */
export function measureDurationV1(start: SamplingClockV1, end: SamplingClockV1): DurationV1 {
  if (start.state === "missing" || end.state === "missing")
    return { state: "unavailable", reason: "missing-endpoint" };
  let delta: number;
  let clockDomain: string;
  let method: "monotonic" | "same-domain-wall";
  if (
    start.monotonic.state === "available" &&
    end.monotonic.state === "available" &&
    start.monotonic.clockRef === end.monotonic.clockRef
  ) {
    delta = end.monotonic.ticksMs - start.monotonic.ticksMs;
    clockDomain = start.monotonic.clockRef;
    method = "monotonic";
  } else if (start.clockRef === end.clockRef) {
    delta = Date.parse(end.observedAt) - Date.parse(start.observedAt);
    clockDomain = start.clockRef;
    method = "same-domain-wall";
  } else return { state: "unavailable", reason: "incompatible-clocks" };
  const uncertainty = start.uncertaintyMs + end.uncertaintyMs;
  if (
    !Number.isSafeInteger(delta) ||
    delta < 0 ||
    delta > SAMPLING_LIMITS_V1.maxClockMs ||
    !Number.isSafeInteger(uncertainty)
  )
    return { state: "unavailable", reason: "invalid-or-overflow-duration" };
  return {
    state: "available",
    clockDomain,
    method,
    milliseconds: delta,
    lowerMs: Math.max(0, delta - uncertainty),
    upperMs: delta + uncertainty,
  };
}
export type DurationRowV1 = Readonly<{
  attemptId: string;
  requirementId: string;
  operationId: string;
  conditionId: string | null;
  variantId: string;
  channel: "none" | "slack" | "teams";
  purpose: "none" | "cold-install" | "replacement";
  boundaryId: string;
  metric: string;
  duration: DurationV1;
  eligibility: { state: "eligible" } | { state: "omitted"; reason: string };
  hardBoundMs: number | null;
}>;
export function describeDurationsV1(rows: readonly DurationRowV1[]) {
  if (rows.length > 16_384) throw new Error("statistics-overflow");
  const groups = new Map<string, DurationRowV1[]>();
  const omissions: { attemptId: string; metric: string; boundaryId: string; reason: string }[] = [];
  const violations: {
    attemptId: string;
    metric: string;
    boundaryId: string;
    boundMs: number;
    lowerMs: number;
    upperMs: number;
  }[] = [];
  const indeterminate: { attemptId: string; metric: string; boundaryId: string; reason: string }[] =
    [];
  for (const row of rows) {
    if (
      row.hardBoundMs !== null &&
      (!Number.isSafeInteger(row.hardBoundMs) ||
        row.hardBoundMs < 0 ||
        row.hardBoundMs > SAMPLING_LIMITS_V1.maxClockMs)
    )
      throw new Error("invalid-statistic-bound");
    const duration = row.duration;
    if (
      duration.state === "available" &&
      (![duration.milliseconds, duration.lowerMs, duration.upperMs].every(
        (value) =>
          Number.isSafeInteger(value) &&
          value >= 0 &&
          value <= SAMPLING_LIMITS_V1.maxClockMs + 172_800_000,
      ) ||
        duration.lowerMs > duration.milliseconds ||
        duration.upperMs < duration.milliseconds)
    )
      throw new Error("invalid-statistic-value");
    const key = JSON.stringify([
      row.requirementId,
      row.operationId,
      row.conditionId,
      row.variantId,
      row.channel,
      row.purpose,
      row.boundaryId,
      row.metric,
      duration.state === "available" ? duration.clockDomain : "unavailable",
      duration.state === "available" ? duration.method : "unavailable",
      row.hardBoundMs,
    ]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
    if (duration.state === "unavailable" || row.eligibility.state === "omitted")
      omissions.push({
        attemptId: row.attemptId,
        metric: row.metric,
        boundaryId: row.boundaryId,
        reason:
          duration.state === "unavailable"
            ? duration.reason
            : row.eligibility.state === "omitted"
              ? row.eligibility.reason
              : "unavailable",
      });
    if (row.hardBoundMs === null) continue;
    if (duration.state === "unavailable")
      indeterminate.push({
        attemptId: row.attemptId,
        metric: row.metric,
        boundaryId: row.boundaryId,
        reason: duration.reason,
      });
    else if (duration.lowerMs > row.hardBoundMs)
      violations.push({
        attemptId: row.attemptId,
        metric: row.metric,
        boundaryId: row.boundaryId,
        boundMs: row.hardBoundMs,
        lowerMs: duration.lowerMs,
        upperMs: duration.upperMs,
      });
    else if (duration.upperMs > row.hardBoundMs)
      indeterminate.push({
        attemptId: row.attemptId,
        metric: row.metric,
        boundaryId: row.boundaryId,
        reason: "uncertainty-straddles-bound",
      });
  }
  const summaries = [...groups].map(([key, group]) => {
    const eligible = group
      .flatMap((row) =>
        row.duration.state === "available" && row.eligibility.state === "eligible"
          ? [row.duration.milliseconds]
          : [],
      )
      .sort((a, b) => a - b);
    const size = eligible.length;
    const middle = Math.floor(size / 2);
    return {
      key: JSON.parse(key) as (string | number | null)[],
      rows: group,
      denominator: group.length,
      eligibleObservations: size,
      omittedObservations: group.length - size,
      units: "milliseconds" as const,
      percentileMethod: "nearest-rank-ceil-p-times-n" as const,
      statistics:
        size === 0
          ? null
          : {
              min: eligible[0]!,
              median:
                size % 2 === 0
                  ? eligible[middle - 1]! / 2 + eligible[middle]! / 2
                  : eligible[middle]!,
              max: eligible[size - 1]!,
              descriptiveP95: eligible[Math.ceil(0.95 * size) - 1]!,
            },
    };
  });
  return {
    rows,
    summaries,
    omissions,
    violations,
    indeterminate,
    boundDisposition: violations.length
      ? ("fail" as const)
      : indeterminate.length
        ? ("indeterminate" as const)
        : ("no-observed-violation" as const),
    tailReliabilityEstablished: false as const,
  };
}
