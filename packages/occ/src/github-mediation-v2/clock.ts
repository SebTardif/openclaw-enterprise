/** Clock arithmetic only. Samples and successful comparisons confer no authority. */
export interface GitHubMediationClockSample {
  readonly wall: number;
  readonly before: number;
  readonly after: number;
}
const MAX_TIME = 253_402_300_799_999;
function valid(sample: GitHubMediationClockSample): boolean {
  return (
    Number.isSafeInteger(sample.wall) &&
    sample.wall >= 0 &&
    sample.wall <= MAX_TIME &&
    Number.isFinite(sample.before) &&
    Number.isFinite(sample.after) &&
    sample.before >= 0 &&
    sample.before <= sample.after
  );
}

/** Bracket Date.now with monotonic observations. This records actual sampling
 * uncertainty instead of assuming wall and monotonic reads happen together. */
export function sampleGitHubMediationClock(): GitHubMediationClockSample {
  const before = performance.now();
  const wall = Date.now();
  const after = performance.now();
  const sample = Object.freeze({ wall, before, after });
  if (!valid(sample)) throw new Error("GitHub mediation unavailable.");
  return sample;
}

/** Date.now has integer-millisecond resolution: its corresponding wall instant
 * lies in [wall, wall + 1). Compare the two bracketed offset intervals, allowing
 * only the configured clock allowance plus this explicit sampling uncertainty. */
export function githubMediationClockContinuous(
  original: GitHubMediationClockSample,
  current: GitHubMediationClockSample,
  allowance: number,
): boolean {
  if (
    !valid(original) ||
    !valid(current) ||
    !Number.isSafeInteger(allowance) ||
    allowance < 0 ||
    current.before < original.after
  )
    return false;
  const leastWall = original.wall + current.before - original.after;
  const greatestWall = original.wall + 1 + current.after - original.before;
  return current.wall + 1 + allowance > leastWall && current.wall - allowance < greatestWall;
}

/** Conservative conversion anchored to the ORIGINAL sample, never renewal or
 * reply receipt. The earliest monotonic reading and the upper wall quantization
 * bound avoid adding time through sampling uncertainty. */
export function githubMediationMonotonicDeadline(
  original: GitHubMediationClockSample,
  absoluteDeadline: number,
  allowance: number,
): number | undefined {
  if (
    !valid(original) ||
    !Number.isSafeInteger(absoluteDeadline) ||
    absoluteDeadline < 0 ||
    absoluteDeadline > MAX_TIME ||
    !Number.isSafeInteger(allowance) ||
    allowance < 0
  )
    return undefined;
  const remaining = absoluteDeadline - original.wall - 1 - allowance;
  const deadline = original.before + remaining;
  return remaining > 0 && Number.isFinite(deadline) ? deadline : undefined;
}
