import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CLASSES, OUTCOMES, REGISTRY_DIGEST, emptyCounts, registry } from "./registry.mjs";

export const VERSION = "release-evidence/v1";
export const POLICY = "synthetic-projection/v1";
export const LIMITS = Object.freeze({
  fileBytes: 262144,
  bundleBytes: 1048576,
  artifacts: 16,
  attempts: 256,
  steps: 32,
  text: 2048,
  observations: 128,
});
const assertionOutcomes = [...OUTCOMES, "unknown"];
export function reject(code) {
  throw new Error(code);
}
export function check(condition, code) {
  if (!condition) reject(code);
}
export function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
export function exact(value, keys, code = "invalid-fields") {
  check(value !== null && typeof value === "object" && !Array.isArray(value), code);
  check(isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()), code);
}
export function token(value) {
  check(typeof value === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(value), "invalid-token");
}
export function sha(value) {
  check(typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value), "invalid-digest");
}
export function timestamp(value) {
  check(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    "invalid-timestamp",
  );
}
export function unique(values) {
  check(new Set(values).size === values.length, "duplicate-identity");
}

// Detection is defense in depth, not a general secret classifier. Production
// producers and public release policy must be reviewed separately.
export function safeText(value, canaries = []) {
  check(
    typeof value === "string" && value.length > 0 && value.length <= LIMITS.text,
    "invalid-text",
  );
  check(
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value),
    "unsafe-text",
  );
  check(
    !/(?:authorization|proxy-authorization|set-cookie|cookie)\s*[:=]|\bbearer\s|-----BEGIN|\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[=:]|\b(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-)[a-z0-9_-]{6,}|[a-z][a-z0-9+.-]*:\/\/[^\s/]*@|https?:\/\/[^\s]*[?#]|\/(?:home|Users|private|tmp)\//i.test(
      value,
    ),
    "unsafe-text",
  );
  check(!canaries.some((canary) => value.includes(canary)), "canary-detected");
  return value;
}
export function screen(value, canaries = [], depth = 0) {
  check(depth <= 12, "excessive-depth");
  if (typeof value === "string") safeText(value, canaries);
  else if (Array.isArray(value)) {
    check(value.length <= 512, "oversized-array");
    for (const item of value) screen(item, canaries, depth + 1);
  } else if (value && typeof value === "object") {
    check(Object.keys(value).length <= 64, "oversized-object");
    for (const [key, item] of Object.entries(value)) {
      safeText(key, canaries);
      screen(item, canaries, depth + 1);
    }
  } else
    check(
      value === null ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)),
      "invalid-value",
    );
}
export function validateInputs(inputs) {
  exact(inputs, ["source", "images", "configuration", "tuple", "harness", "registry"]);
  check(
    typeof inputs.source === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(inputs.source),
    "invalid-source",
  );
  for (const key of ["configuration", "tuple", "harness", "registry"]) sha(inputs[key]);
  check(inputs.registry === REGISTRY_DIGEST, "stale-registry");
  check(
    Array.isArray(inputs.images) && inputs.images.length > 0 && inputs.images.length <= 16,
    "invalid-images",
  );
  for (const image of inputs.images) {
    exact(image, ["name", "digest"]);
    token(image.name);
    sha(image.digest);
  }
  unique(inputs.images.map((image) => image.name));
  check(
    isDeepStrictEqual(
      inputs.images.map((image) => image.name),
      inputs.images.map((image) => image.name).sort(),
    ),
    "unsorted-images",
  );
}
export function findCase(id) {
  const item = registry().cases.find((entry) => entry.id === id);
  check(item, "unknown-case");
  return item;
}
export function assertionCounts(assertions) {
  const counts = { ...emptyCounts(), unknown: 0 };
  for (const item of assertions) counts[item.outcome]++;
  return counts;
}
export function resultOutcome(assertions, collection) {
  const counts = assertionCounts(assertions);
  if (counts.fail) return "fail";
  if (collection.status !== "complete" || counts.unknown || counts.blocked) return "blocked";
  if (counts.skipped) return "skipped";
  if (counts.unrun) return "unrun";
  return "pass";
}
export function validateMetadata(value) {
  exact(value, [
    "version",
    "runId",
    "supersedes",
    "caseId",
    "requirement",
    "fixture",
    "executor",
    "channel",
    "profile",
    "executionClass",
    "steps",
    "startedAt",
    "endedAt",
    "inputs",
    "assertions",
    "securityEvents",
  ]);
  screen(value);
  check(value.version === VERSION, "unsupported-version");
  token(value.runId);
  if (value.supersedes !== null) token(value.supersedes);
  check(value.supersedes !== value.runId, "invalid-supersedes");
  const fixture = findCase(value.caseId);
  for (const key of ["requirement", "channel", "profile"])
    check(value[key] === fixture[key], "case-identity-mismatch");
  exact(value.fixture, ["id", "version"]);
  check(value.fixture.id === fixture.fixture.id, "fixture-mismatch");
  token(value.fixture.version);
  token(value.executor);
  check(CLASSES.includes(value.executionClass), "invalid-execution-class");
  check(
    Array.isArray(value.steps) && value.steps.length > 0 && value.steps.length <= LIMITS.steps,
    "invalid-steps",
  );
  for (const step of value.steps) {
    exact(step, ["kind", "value"]);
    check(["command", "manual"].includes(step.kind), "invalid-step-kind");
    safeText(step.value);
  }
  timestamp(value.startedAt);
  timestamp(value.endedAt);
  check(value.startedAt <= value.endedAt, "reversed-time");
  validateInputs(value.inputs);
  check(
    Array.isArray(value.assertions) && value.assertions.length === fixture.assertions.length,
    "missing-assertions",
  );
  unique(value.assertions.map((item) => item.id));
  for (const assertion of value.assertions) {
    exact(assertion, ["id", "outcome", "observed", "reasonCode", "artifacts"]);
    check(
      fixture.assertions.some((item) => item.id === assertion.id),
      "unknown-assertion",
    );
    check(assertionOutcomes.includes(assertion.outcome), "invalid-assertion-outcome");
    check(typeof assertion.observed === "boolean", "invalid-observation");
    token(assertion.reasonCode);
    check(
      Array.isArray(assertion.artifacts) && assertion.artifacts.length <= LIMITS.artifacts,
      "invalid-assertion-artifacts",
    );
    assertion.artifacts.forEach(token);
    unique(assertion.artifacts);
    if (assertion.outcome === "pass")
      check(assertion.observed && assertion.artifacts.length > 0, "unsupported-assertion-pass");
    if (assertion.outcome === "unrun")
      check(!assertion.observed && assertion.artifacts.length === 0, "invalid-unrun");
  }
  // TODO: Reconcile the accepted security-event producer and run adapter checks
  // before supporting evidence from that producer. Counts here are declarations.
  exact(value.securityEvents, ["adapterVersion", "status", "required", "observed"]);
  check(value.securityEvents.adapterVersion === "pending", "unsupported-event-adapter");
  check(
    ["pending", "missing", "reported"].includes(value.securityEvents.status),
    "invalid-event-status",
  );
  for (const field of ["required", "observed"])
    check(
      Number.isSafeInteger(value.securityEvents[field]) &&
        value.securityEvents[field] >= 0 &&
        value.securityEvents[field] <= 10000,
      "invalid-event-count",
    );
  check(value.securityEvents.observed <= value.securityEvents.required, "invalid-event-count");
  if (value.securityEvents.status === "reported")
    check(
      value.securityEvents.observed === value.securityEvents.required,
      "missing-security-events",
    );
  return fixture;
}
export function validateAttempt(attempt, expectedInputs, now = new Date().toISOString()) {
  timestamp(now);
  exact(attempt, ["metadata", "artifacts", "collection", "counts", "outcome", "provenance"]);
  screen(attempt);
  const fixture = validateMetadata(attempt.metadata);
  validateInputs(expectedInputs);
  check(isDeepStrictEqual(attempt.metadata.inputs, expectedInputs), "stale-inputs");
  check(attempt.provenance === "unverified-import", "unsupported-provenance");
  exact(attempt.collection, ["policy", "status", "omissions", "retention", "collectedAt"]);
  check(attempt.collection.policy === POLICY, "unsupported-policy");
  exact(attempt.collection.retention, ["access", "expiresAt"]);
  timestamp(attempt.collection.retention.expiresAt);
  check(attempt.collection.retention.access === "owner-only", "invalid-access-policy");
  timestamp(attempt.collection.collectedAt);
  check(attempt.collection.collectedAt <= now, "future-collection");
  check(attempt.metadata.endedAt <= attempt.collection.collectedAt, "collection-before-execution");
  check(
    attempt.collection.collectedAt < attempt.collection.retention.expiresAt &&
      Date.parse(attempt.collection.retention.expiresAt) -
        Date.parse(attempt.collection.collectedAt) <=
        7 * 86400000,
    "invalid-retention",
  );
  check(
    ["complete", "partial", "failure"].includes(attempt.collection.status),
    "invalid-collection",
  );
  check(
    Array.isArray(attempt.collection.omissions) &&
      attempt.collection.omissions.length <= LIMITS.artifacts,
    "invalid-omissions",
  );
  for (const item of attempt.collection.omissions) {
    exact(item, ["index", "reasonCode"]);
    check(
      Number.isInteger(item.index) && item.index >= 0 && item.index < LIMITS.artifacts,
      "invalid-omission-index",
    );
    token(item.reasonCode);
  }
  check(
    (attempt.collection.status === "complete") === (attempt.collection.omissions.length === 0),
    "inconsistent-collection",
  );
  check(
    Array.isArray(attempt.artifacts) && attempt.artifacts.length <= LIMITS.artifacts,
    "invalid-artifacts",
  );
  unique(attempt.artifacts.map((item) => item.id));
  unique(attempt.artifacts.map((item) => item.path));
  for (const artifact of attempt.artifacts) {
    exact(artifact, ["id", "path", "sha256", "bytes"]);
    token(artifact.id);
    sha(artifact.sha256);
    check(/^artifact-[0-9]{2}\.json$/.test(artifact.path), "invalid-artifact-path");
    check(
      Number.isInteger(artifact.bytes) && artifact.bytes > 0 && artifact.bytes <= LIMITS.fileBytes,
      "invalid-artifact-size",
    );
  }
  for (const assertion of attempt.metadata.assertions)
    for (const id of assertion.artifacts)
      check(
        attempt.artifacts.some((artifact) => artifact.id === id),
        "missing-artifact-reference",
      );
  check(
    isDeepStrictEqual(attempt.counts, assertionCounts(attempt.metadata.assertions)),
    "incorrect-counts",
  );
  check(
    attempt.outcome === resultOutcome(attempt.metadata.assertions, attempt.collection),
    "incorrect-outcome",
  );
  if (attempt.metadata.securityEvents.status === "missing")
    check(attempt.outcome !== "pass", "missing-security-events");
  return fixture;
}

export function summarize(attempts, expectedInputs, now = new Date().toISOString()) {
  timestamp(now);
  validateInputs(expectedInputs);
  check(Array.isArray(attempts) && attempts.length <= LIMITS.attempts, "too-many-attempts");
  const seen = new Map();
  const latest = new Map();
  const history = [];
  for (const attempt of attempts) {
    // A changed candidate invalidates old attempts, but does not delete them.
    validateAttempt(attempt, attempt.metadata.inputs, now);
    const { runId, caseId, supersedes, executionClass } = attempt.metadata;
    if (seen.has(runId)) {
      check(isDeepStrictEqual(seen.get(runId), attempt), "conflicting-import");
      continue;
    }
    const previous = latest.get(caseId);
    check(supersedes === (previous?.metadata.runId ?? null), "broken-rerun-chain");
    if (previous)
      check(previous.metadata.endedAt <= attempt.metadata.startedAt, "overlapping-rerun");
    seen.set(runId, attempt);
    latest.set(caseId, attempt);
    history.push({
      runId,
      caseId,
      supersedes,
      executionClass,
      outcome: attempt.outcome,
      stale: !isDeepStrictEqual(attempt.metadata.inputs, expectedInputs),
      counts: attempt.counts,
    });
  }
  const counts = emptyCounts();
  const requiredCounts = emptyCounts();
  const requiredLiveCounts = emptyCounts();
  const byClass = Object.fromEntries(CLASSES.map((kind) => [kind, emptyCounts()]));
  const cases = registry().cases.map((fixture) => {
    const attempt = latest.get(fixture.id);
    const stale = Boolean(attempt && !isDeepStrictEqual(attempt.metadata.inputs, expectedInputs));
    const expired = Boolean(attempt && now >= attempt.collection.retention.expiresAt);
    const outcome = !attempt ? "unrun" : stale || expired ? "blocked" : attempt.outcome;
    counts[outcome]++;
    if (fixture.required) requiredCounts[outcome]++;
    if (attempt) byClass[attempt.metadata.executionClass][outcome]++;
    // All adapters are pending. Live claims remain visible but cannot pass this
    // required-live coverage column until provenance and semantics are accepted.
    const liveOutcome =
      !attempt || attempt.metadata.executionClass !== "live"
        ? "unrun"
        : outcome === "pass"
          ? "blocked"
          : outcome;
    if (fixture.required) requiredLiveCounts[liveOutcome]++;
    return {
      id: fixture.id,
      requirement: fixture.requirement,
      channel: fixture.channel,
      profile: fixture.profile,
      required: fixture.required,
      runId: attempt?.metadata.runId ?? null,
      executionClass: attempt?.metadata.executionClass ?? null,
      outcome,
      liveOutcome,
      stale,
      expired,
      securityEvents: attempt?.metadata.securityEvents ?? {
        adapterVersion: "pending",
        status: "pending",
        required: 0,
        observed: 0,
      },
    };
  });
  const gateCounts = emptyCounts();
  const gateResults = Array.from({ length: 16 }, (_, index) => {
    const id = `R${index + 1}`;
    const required = cases.filter((item) => item.requirement === id && item.required);
    const outcomes = required.map((item) => item.liveOutcome);
    const outcome = ["fail", "blocked", "skipped", "unrun", "pass"].find((item) =>
      outcomes.includes(item),
    );
    gateCounts[outcome]++;
    return { id, requiredCases: required.map((item) => item.id), outcome };
  });
  return {
    version: "release-summary/v1",
    evaluatedAt: now,
    gateResults,
    gateCounts,
    registryDigest: REGISTRY_DIGEST,
    gates: 16,
    cases,
    counts,
    requiredCounts,
    requiredLiveCounts,
    byClass,
    history,
    historicalFailures: history.filter((item) => item.outcome === "fail"),
    releaseAcceptance: "not-established",
    provenance: "unverified-import",
    pendingAdapters: ["release-lock", "component-fixtures", "security-events"],
    publicExport: "disabled-pending-policy-and-review",
  };
}
