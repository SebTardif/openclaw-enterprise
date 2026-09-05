import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  LIMITS,
  POLICY,
  assertionCounts,
  check,
  digest,
  exact,
  findCase,
  resultOutcome,
  screen,
  sha,
  timestamp,
  token,
  validateAttempt,
  validateMetadata,
} from "./evidence.mjs";

const OBSERVATIONS_VERSION = "release-observations/v1";
export async function safeDirectory(path) {
  check(isAbsolute(path), "absolute-directory-required");
  const normalized = resolve(path);
  check(path === normalized, "canonical-directory-required");
  let cursor = parse(normalized).root;
  for (const part of normalized.slice(cursor.length).split("/").filter(Boolean)) {
    cursor = join(cursor, part);
    const stat = await lstat(cursor);
    check(stat.isDirectory() && !stat.isSymbolicLink(), "unsafe-directory");
  }
  check((await realpath(normalized)) === normalized, "unsafe-directory");
  return normalized;
}
export function relativeSource(path) {
  check(
    typeof path === "string" &&
      path.length <= 160 &&
      /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.json$/.test(path),
    "unsafe-source-path",
  );
  return path;
}
export async function readBounded(root, relative, limit = LIMITS.fileBytes) {
  relativeSource(relative);
  const directory = await safeDirectory(root);
  const path = join(directory, relative);
  await safeDirectory(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    check(stat.isFile() && stat.nlink === 1 && stat.size <= limit, "unsafe-input-file");
    // One fixed-size read bound also catches a growing file without readFile's
    // unbounded growth behavior. Nonregular files are rejected before reading.
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    check(used <= limit, "oversized-input");
    return buffer.subarray(0, used);
  } finally {
    await handle.close();
  }
}
export async function readJson(root, path, limit) {
  const bytes = await readBounded(root, path, limit);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    check(false, "invalid-json");
  }
}
async function createOutput(path) {
  check(isAbsolute(path), "absolute-directory-required");
  const normalized = resolve(path);
  check(path === normalized, "canonical-directory-required");
  await safeDirectory(dirname(normalized));
  await mkdir(normalized, { mode: 0o700 });
  return safeDirectory(normalized);
}
async function writeExclusive(root, name, bytes) {
  relativeSource(name);
  check(bytes.length <= LIMITS.bundleBytes, "oversized-output");
  const handle = await open(
    join(root, name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function encode(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

export function projectObservations(value, fixture, canaries = []) {
  check(value && typeof value === "object" && !Array.isArray(value), "invalid-observations");
  check(value.version === OBSERVATIONS_VERSION, "unsupported-observations");
  check(
    Array.isArray(value.observations) &&
      value.observations.length > 0 &&
      value.observations.length <= LIMITS.observations,
    "invalid-observations",
  );
  let omitted = Object.keys(value).some((key) => !["version", "observations"].includes(key));
  const observations = value.observations.map((item) => {
    check(item && typeof item === "object" && !Array.isArray(item), "invalid-observation");
    const keys = ["assertionId", "outcome", "observedAt", "correlation", "reasonCode"];
    omitted ||= Object.keys(item).some((key) => !keys.includes(key));
    const projected = Object.fromEntries(keys.map((key) => [key, item[key]]));
    check(
      fixture.assertions.some((entry) => entry.id === projected.assertionId),
      "unknown-assertion",
    );
    check(
      ["pass", "fail", "blocked", "skipped", "unrun", "unknown"].includes(projected.outcome),
      "invalid-observation-outcome",
    );
    timestamp(projected.observedAt);
    token(projected.reasonCode);
    check(
      typeof projected.correlation === "string" && /^[a-f0-9]{32,64}$/.test(projected.correlation),
      "invalid-correlation",
    );
    screen(projected, canaries);
    return projected;
  });
  const result = { version: OBSERVATIONS_VERSION, observations };
  screen(result, canaries);
  return { value: result, omitted };
}

function checkObservationLinks(attempt, projectedArtifacts) {
  for (const assertion of attempt.metadata.assertions) {
    const observations = [...projectedArtifacts.values()].flatMap((artifact) =>
      artifact.observations.filter((item) => item.assertionId === assertion.id),
    );
    // A contradictory failure or uncertainty cannot hide behind a matching pass.
    // A changed outcome belongs to a separate explicitly superseding attempt.
    check(
      observations.every((item) => item.outcome === assertion.outcome),
      "contradictory-observations",
    );
    if (!assertion.observed) continue;
    check(
      assertion.artifacts.some((id) =>
        projectedArtifacts
          .get(id)
          ?.observations.some(
            (observation) =>
              observation.assertionId === assertion.id &&
              observation.outcome === assertion.outcome &&
              observation.observedAt >= attempt.metadata.startedAt &&
              observation.observedAt <= attempt.metadata.endedAt,
          ),
      ),
      "missing-observation-evidence",
    );
  }
}

// Explicit files under one caller-selected root, no discovery, commands, logs or
// network access. The caller retains raw evidence under its own access policy.
export async function collect({
  sourceRoot,
  outputDirectory,
  metadata,
  sources,
  canaries = [],
  retention,
  signal,
}) {
  let output;
  const omissions = [];
  const artifacts = [];
  const projectedArtifacts = new Map();
  try {
    check(
      Array.isArray(canaries) &&
        canaries.length <= 32 &&
        canaries.every(
          (value) => typeof value === "string" && value.length >= 8 && value.length <= 256,
        ),
      "invalid-canaries",
    );
    validateMetadata(metadata);
    screen(metadata, canaries);
    exact(retention, ["access", "expiresAt"]);
    timestamp(retention.expiresAt);
    check(
      retention.access === "owner-only" &&
        Date.parse(retention.expiresAt) > Date.now() &&
        Date.parse(retention.expiresAt) <= Date.now() + 7 * 86400000,
      "invalid-retention",
    );
    check(Array.isArray(sources) && sources.length <= LIMITS.artifacts, "invalid-sources");
    const ids = new Set();
    const paths = new Set();
    for (const source of sources) {
      exact(source, ["id", "path", "kind"]);
      token(source.id);
      relativeSource(source.path);
      check(source.kind === OBSERVATIONS_VERSION, "unsupported-source");
      check(!ids.has(source.id) && !paths.has(source.path), "duplicate-source");
      ids.add(source.id);
      paths.add(source.path);
    }
    for (const assertion of metadata.assertions)
      for (const id of assertion.artifacts) check(ids.has(id), "undeclared-source");
    check(!signal?.aborted, "collection-interrupted");
    await safeDirectory(sourceRoot);
    output = await createOutput(outputDirectory);
    for (const [index, source] of sources.entries()) {
      check(!signal?.aborted, "collection-interrupted");
      try {
        const raw = await readJson(sourceRoot, source.path);
        const projected = projectObservations(raw, findCase(metadata.caseId), canaries);
        const bytes = encode(projected.value);
        check(bytes.length <= LIMITS.fileBytes, "oversized-projection");
        const path = `artifact-${String(index).padStart(2, "0")}.json`;
        await writeExclusive(output, path, bytes);
        artifacts.push({ id: source.id, path, sha256: digest(bytes), bytes: bytes.length });
        projectedArtifacts.set(source.id, projected.value);
        if (projected.omitted) omissions.push({ index, reasonCode: "fields-omitted" });
      } catch {
        omissions.push({ index, reasonCode: "source-unavailable-or-unsafe" });
      }
    }
    const adjusted = structuredClone(metadata);
    for (const assertion of adjusted.assertions) {
      const original = assertion.artifacts.length;
      assertion.artifacts = assertion.artifacts.filter((id) =>
        artifacts.some((item) => item.id === id),
      );
      if (assertion.artifacts.length !== original) {
        assertion.observed = false;
        if (assertion.outcome === "pass") assertion.outcome = "blocked";
        assertion.reasonCode = "collection-incomplete";
      }
    }
    check(!signal?.aborted, "collection-interrupted");
    const collection = {
      policy: POLICY,
      retention,
      collectedAt: new Date().toISOString(),
      status: omissions.length ? (artifacts.length ? "partial" : "failure") : "complete",
      omissions,
    };
    const attempt = {
      metadata: adjusted,
      artifacts,
      collection,
      counts: assertionCounts(adjusted.assertions),
      outcome: resultOutcome(adjusted.assertions, collection),
      provenance: "unverified-import",
    };
    validateAttempt(attempt, adjusted.inputs);
    checkObservationLinks(attempt, projectedArtifacts);
    screen(attempt, canaries);
    await writeExclusive(output, "manifest.json", encode(attempt));
    return { status: collection.status, outcome: attempt.outcome, manifest: "manifest.json" };
  } catch {
    // Never print input, paths, provider errors or OS error strings. If storage
    // failed, this bounded return remains the only available failure evidence.
    const failure = {
      version: "release-collection-failure/v1",
      status: "failure",
      reasonCode: "collection-rejected-or-storage-unavailable",
    };
    if (output) {
      try {
        await writeExclusive(output, "collection-failure.json", encode(failure));
      } catch {
        /* Storage can be unavailable. */
      }
    }
    return failure;
  }
}

export async function loadAttempt(directory, expectedInputs) {
  const attempt = await readJson(directory, "manifest.json", LIMITS.bundleBytes);
  validateAttempt(attempt, expectedInputs);
  const projectedArtifacts = new Map();
  for (const artifact of attempt.artifacts) {
    const bytes = await readBounded(directory, artifact.path);
    check(
      bytes.length === artifact.bytes && digest(bytes) === artifact.sha256,
      "artifact-checksum-mismatch",
    );
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const projected = projectObservations(value, findCase(attempt.metadata.caseId));
    check(
      !projected.omitted && isDeepStrictEqual(projected.value, value),
      "unsafe-artifact-fields",
    );
    projectedArtifacts.set(artifact.id, value);
  }
  checkObservationLinks(attempt, projectedArtifacts);
  return attempt;
}

// Only a local screened candidate is produced. The receipt is a declaration from
// the caller, not authenticated reviewer identity, publication or acceptance.
export async function exportCandidate({
  directory,
  outputDirectory,
  expectedInputs,
  review,
  now = new Date().toISOString(),
}) {
  let output;
  try {
    const attempt = await loadAttempt(directory, expectedInputs);
    check(
      attempt.metadata.executionClass !== "live" && attempt.collection.status === "complete",
      "synthetic-candidate-only",
    );
    check(now < attempt.collection.retention.expiresAt, "expired-collection");
    const manifest = await readBounded(directory, "manifest.json", LIMITS.bundleBytes);
    exact(review, [
      "version",
      "manifestDigest",
      "policy",
      "scope",
      "decision",
      "reviewer",
      "reviewedAt",
      "expiresAt",
    ]);
    screen(review);
    timestamp(now);
    timestamp(review.reviewedAt);
    timestamp(review.expiresAt);
    token(review.reviewer);
    sha(review.manifestDigest);
    check(
      review.version === "release-candidate-review/v1" &&
        review.policy === POLICY &&
        review.scope === "synthetic-only" &&
        review.decision === "approved",
      "unapproved-candidate",
    );
    check(review.manifestDigest === digest(manifest), "stale-review");
    check(
      review.reviewedAt <= now &&
        now < review.expiresAt &&
        review.expiresAt <= attempt.collection.retention.expiresAt &&
        Date.parse(review.expiresAt) - Date.parse(review.reviewedAt) <= 7 * 86400000,
      "invalid-retention",
    );
    output = await createOutput(outputDirectory);
    // Reuse the bytes checked above and verify every artifact again immediately
    // before writing, so a file change cannot silently reuse its prior checksum.
    const files = [{ path: "manifest.json", bytes: manifest, sha256: digest(manifest) }];
    check(isDeepStrictEqual(JSON.parse(manifest), attempt), "changed-manifest");
    for (const artifact of attempt.artifacts) {
      const bytes = await readBounded(directory, artifact.path);
      check(
        digest(bytes) === artifact.sha256 && bytes.length === artifact.bytes,
        "changed-artifact",
      );
      files.push({ path: artifact.path, bytes, sha256: artifact.sha256 });
    }
    for (const file of files) await writeExclusive(output, file.path, file.bytes);
    await writeExclusive(
      output,
      "candidate.json",
      encode({
        version: "release-candidate/v1",
        disposition: "screened-local-candidate",
        releaseAcceptance: "not-established",
        review,
        files: files.map(({ path, bytes, sha256 }) => ({ path, bytes: bytes.length, sha256 })),
      }),
    );
    return {
      status: "complete",
      disposition: "screened-local-candidate",
      publicApproval: "not-established",
    };
  } catch {
    const failure = {
      version: "release-collection-failure/v1",
      status: "failure",
      reasonCode: "candidate-rejected-or-storage-unavailable",
    };
    if (output) {
      try {
        await writeExclusive(output, "collection-failure.json", encode(failure));
      } catch {
        /* Storage can be unavailable. */
      }
    }
    return failure;
  }
}
