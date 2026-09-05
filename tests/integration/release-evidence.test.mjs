import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, watch } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { registry, validateRegistry } from "../../scripts/release-evidence/registry.mjs";
import {
  assertionCounts,
  digest,
  resultOutcome,
  summarize,
  validateAttempt,
} from "../../scripts/release-evidence/evidence.mjs";
import {
  collect,
  exportCandidate,
  loadAttempt,
  readBounded,
} from "../../scripts/release-evidence/collector.mjs";
import { fixture, inputs } from "../fixtures/release-evidence/fixture.mjs";

const cli = fileURLToPath(new URL("../../scripts/release-evidence/cli.mjs", import.meta.url));
async function setup(t, options) {
  const root = await mkdtemp(join(tmpdir(), "release-evidence-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source");
  await mkdir(sourceRoot);
  const data = fixture(options);
  await writeFile(join(sourceRoot, "observations.json"), JSON.stringify(data.observations));
  return {
    root,
    data,
    request: {
      sourceRoot,
      outputDirectory: join(root, "bundle"),
      metadata: data.metadata,
      sources: [{ id: "observations", path: "observations.json", kind: "release-observations/v1" }],
      retention: { access: "owner-only", expiresAt: new Date(Date.now() + 86400000).toISOString() },
    },
  };
}
async function collected(t, options) {
  const context = await setup(t, options);
  const result = await collect(context.request);
  assert.equal(result.status, "complete", JSON.stringify(result));
  return { ...context, attempt: await loadAttempt(context.request.outputDirectory, inputs) };
}
function recompute(attempt) {
  attempt.counts = assertionCounts(attempt.metadata.assertions);
  attempt.outcome = resultOutcome(attempt.metadata.assertions, attempt.collection);
}
async function filesText(directory) {
  const files = await readdir(directory);
  return (await Promise.all(files.map((name) => readFile(join(directory, name), "utf8")))).join(
    "\n",
  );
}

test("registry covers sixteen gates, both channels and required standalone/adapter profiles; all fresh cases are unrun", () => {
  const value = registry();
  assert.equal(validateRegistry(value), true);
  assert.deepEqual(
    [...new Set(value.cases.map((item) => item.requirement))],
    Array.from({ length: 16 }, (_, i) => `R${i + 1}`),
  );
  for (const requirement of ["R3", "R10", "R16"])
    assert.deepEqual(
      value.cases.filter((item) => item.requirement === requirement).map((item) => item.channel),
      ["slack", "teams"],
    );
  for (const requirement of ["R13", "R14", "R15"])
    assert.ok(
      value.cases.some(
        (item) =>
          item.requirement === requirement &&
          item.required &&
          item.profile.includes("kata-standalone-spire"),
      ),
    );
  assert.equal(value.cases.find((item) => !item.required).id, "r15-operator-managed-provider");
  for (const item of value.cases) {
    assert.deepEqual(
      item.assertions.map((assertion) => assertion.kind),
      ["positive", "denial", "failure"],
    );
    assert.equal(item.fixture.status, "to-build");
    assert.ok(item.prerequisites.includes("accepted-assertions"));
  }
  const report = summarize([], inputs);
  assert.equal(report.gateCounts.unrun, 16);
  assert.equal(report.counts.unrun, 20);
  assert.equal(report.requiredLiveCounts.unrun, 19);
  assert.equal(report.releaseAcceptance, "not-established");
  value.cases.splice(
    value.cases.findIndex((item) => item.id === "r3-collaboration-teams"),
    1,
  );
  assert.throws(() => validateRegistry(value), /registry-mismatch/);
  const duplicate = registry();
  duplicate.cases.push(duplicate.cases[0]);
  assert.throws(() => validateRegistry(duplicate));
});

test("complete synthetic collection validates checksums, classes, private permissions and preserves every unrun live gate", async (t) => {
  const { request, attempt } = await collected(t);
  assert.equal(attempt.outcome, "pass");
  assert.deepEqual(attempt.counts, {
    pass: 3,
    fail: 0,
    blocked: 0,
    skipped: 0,
    unrun: 0,
    unknown: 0,
  });
  assert.equal((await lstat(request.outputDirectory)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(request.outputDirectory, "manifest.json"))).mode & 0o777, 0o600);
  const report = summarize([attempt], inputs);
  assert.equal(report.byClass.unit.pass, 1);
  assert.equal(report.requiredLiveCounts.unrun, 19);
  assert.equal(report.releaseAcceptance, "not-established");
});

test("strict envelope rejects malformed fields, counts, identities and unsupported versions", async (t) => {
  const { attempt } = await collected(t);
  const changes = [
    (item) => {
      delete item.metadata.steps;
    },
    (item) => {
      item.metadata.steps = [];
    },
    (item) => {
      item.metadata.startedAt = "yesterday";
    },
    (item) => {
      item.metadata.endedAt = "2025-01-01T00:00:00.000Z";
    },
    (item) => {
      item.metadata.version = "release-evidence/v2";
    },
    (item) => {
      item.metadata.inputs.harness = "latest";
    },
    (item) => {
      item.metadata.inputs.registry = digest("old-registry");
    },
    (item) => {
      item.metadata.inputs.images.push(item.metadata.inputs.images[0]);
    },
    (item) => {
      item.metadata.assertions.pop();
    },
    (item) => {
      item.metadata.assertions[1].id = item.metadata.assertions[0].id;
    },
    (item) => {
      item.metadata.assertions[0].outcome = "success";
    },
    (item) => {
      item.metadata.assertions[0].observed = false;
    },
    (item) => {
      item.metadata.channel = "teams";
    },
    (item) => {
      item.metadata.profile = "gvisor";
    },
    (item) => {
      item.metadata.fixture.id = "other-fixture";
    },
    (item) => {
      item.counts.pass = 100;
    },
    (item) => {
      item.outcome = "fail";
    },
    (item) => {
      item.provenance = "trusted";
    },
    (item) => {
      item.metadata.providerError = "not-allowed";
    },
    (item) => {
      item.artifacts.push(item.artifacts[0]);
    },
    (item) => {
      item.collection.retention.access = "public";
    },
  ];
  for (const change of changes) {
    const changed = structuredClone(attempt);
    change(changed);
    assert.throws(() => validateAttempt(changed, inputs));
  }
});

test("current inputs invalidate source/image/config/tuple/harness changes without hiding historical failures", async (t) => {
  const { attempt } = await collected(t, { outcome: "fail" });
  for (const field of ["source", "images", "configuration", "tuple", "harness"]) {
    const current = structuredClone(inputs);
    current[field] =
      field === "source"
        ? "c".repeat(40)
        : field === "images"
          ? [{ name: "synthetic", digest: digest("new-image") }]
          : digest(`new-${field}`);
    assert.throws(() => validateAttempt(attempt, current), /stale-inputs/);
    const report = summarize([attempt], current);
    assert.equal(report.cases.find((item) => item.id === "r9-stop").outcome, "blocked");
    assert.equal(report.historicalFailures.length, 1);
    assert.equal(report.history[0].stale, true);
  }
});

test("reruns preserve failed attempts and exact supersession; duplicates cannot inflate coverage", async (t) => {
  const { attempt } = await collected(t, { outcome: "fail" });
  const rerun = structuredClone(attempt);
  rerun.metadata.runId = "run-two";
  rerun.metadata.supersedes = "run-one";
  rerun.metadata.startedAt = "2026-01-02T00:00:00.000Z";
  rerun.metadata.endedAt = "2026-01-02T00:00:01.000Z";
  for (const assertion of rerun.metadata.assertions) assertion.outcome = "pass";
  recompute(rerun);
  const report = summarize([attempt, rerun, rerun], inputs);
  assert.equal(report.history.length, 2);
  assert.equal(report.historicalFailures.length, 1);
  assert.equal(report.counts.pass, 1);
  assert.equal(report.releaseAcceptance, "not-established");
  const conflict = structuredClone(attempt);
  conflict.metadata.executor = "different-executor";
  assert.throws(() => summarize([attempt, conflict], inputs), /conflicting-import/);
  rerun.metadata.supersedes = null;
  assert.throws(() => summarize([attempt, rerun], inputs), /broken-rerun-chain/);
});

for (const outcome of ["fail", "blocked", "skipped", "unrun", "unknown"]) {
  test(`preserves ${outcome} outcomes and cannot report live acceptance`, async (t) => {
    const { attempt } = await collected(t, { outcome });
    assert.equal(attempt.counts[outcome], 3);
    assert.equal(attempt.outcome, outcome === "unknown" ? "blocked" : outcome);
    assert.equal(summarize([attempt], inputs).releaseAcceptance, "not-established");
  });
}

test("self-reported live pass, missing security events and partial platform coverage cannot become release acceptance", async (t) => {
  const { attempt } = await collected(t, {
    caseId: "r3-collaboration-slack",
    executionClass: "live",
  });
  const report = summarize([attempt], inputs);
  assert.equal(report.byClass.live.pass, 1);
  assert.equal(report.requiredLiveCounts.pass, 0);
  assert.equal(report.requiredLiveCounts.blocked, 1);
  assert.equal(report.cases.find((item) => item.id === "r3-collaboration-teams").outcome, "unrun");
  assert.equal(report.cases.find((item) => !item.required).outcome, "unrun");
  const missing = structuredClone(attempt);
  missing.metadata.securityEvents = {
    adapterVersion: "pending",
    status: "missing",
    required: 2,
    observed: 1,
  };
  assert.throws(() => validateAttempt(missing, inputs), /missing-security-events/);
  missing.metadata.securityEvents.status = "reported";
  assert.throws(() => validateAttempt(missing, inputs), /missing-security-events/);
});

test("missing and tampered artifact bytes, false checksums and unrelated observations fail validation", async (t) => {
  const { request, attempt } = await collected(t);
  const path = join(request.outputDirectory, attempt.artifacts[0].path);
  await writeFile(path, "{}");
  await assert.rejects(loadAttempt(request.outputDirectory, inputs), /artifact-checksum-mismatch/);
  await rm(path);
  await assert.rejects(loadAttempt(request.outputDirectory, inputs));
  const bad = await setup(t);
  bad.data.observations.observations[0].outcome = "fail";
  await writeFile(
    join(bad.request.sourceRoot, "observations.json"),
    JSON.stringify(bad.data.observations),
  );
  assert.equal((await collect(bad.request)).status, "failure");
  assert.ok((await readdir(bad.request.outputDirectory)).includes("collection-failure.json"));
  assert.ok(!(await readdir(bad.request.outputDirectory)).includes("manifest.json"));
});

test("collector drops raw errors, transcripts, commands, workspace bodies and nested secret fields before storage", async (t) => {
  const { data, request } = await setup(t);
  const canary = "SECRET-CANARY-12345678";
  data.observations.providerError = { message: canary, authorization: `Bearer ${canary}` };
  data.observations.transcript = canary;
  data.observations.workspace = canary;
  data.observations.command = canary;
  data.observations.observations[0].nested = { prompt: canary };
  request.canaries = [canary];
  await writeFile(join(request.sourceRoot, "observations.json"), JSON.stringify(data.observations));
  const result = await collect(request);
  assert.equal(result.status, "partial");
  assert.equal(result.outcome, "blocked");
  const persisted = await filesText(request.outputDirectory);
  for (const forbidden of [canary, "providerError", "transcript", '"workspace"', '"nested"'])
    assert.ok(!persisted.includes(forbidden));
  assert.ok(!JSON.stringify(result).includes(canary));
  assert.equal(
    (await loadAttempt(request.outputDirectory, inputs)).collection.omissions[0].reasonCode,
    "fields-omitted",
  );
});

test("canaries in every persisted metadata string are refused without raw diagnostics", async (t) => {
  const base = fixture().metadata;
  const stringPaths = [];
  function visit(value, path = []) {
    if (typeof value === "string") stringPaths.push(path);
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) visit(item, [...path, key]);
  }
  visit(base);
  for (const [index, path] of stringPaths.entries()) {
    const { request } = await setup(t);
    const canary = "canary-sensitive-123456";
    let parent = request.metadata;
    for (const key of path.slice(0, -1)) parent = parent[key];
    parent[path.at(-1)] = canary;
    request.canaries = [canary];
    const result = await collect(request);
    assert.equal(result.status, "failure", `${index}`);
    assert.ok(!JSON.stringify(result).includes(canary));
    await assert.rejects(lstat(request.outputDirectory));
  }
});

test("hostile free text, URL credentials, control characters and canary projections never reach artifacts", async (t) => {
  for (const text of [
    "Authorization: Bearer testcanary",
    "Cookie: session=testcanary",
    "https://name:testcanary@example.invalid",
    "https://example.invalid?key=testcanary",
    "-----BEGIN PRIVATE KEY-----",
    "api_key=testcanary",
    "safe\nforged pass",
    "safe\u202eforged",
    "ghp_testcanary123",
    "xoxb-testcanary123",
  ]) {
    const { request } = await setup(t);
    request.metadata.steps[0].value = text;
    assert.equal((await collect(request)).status, "failure");
    await assert.rejects(lstat(request.outputDirectory));
  }
  for (const field of ["assertionId", "outcome", "observedAt", "correlation", "reasonCode"]) {
    const { request, data } = await setup(t);
    const canary = field === "correlation" ? "c".repeat(32) : "sensitive-canary-1234";
    data.observations.observations[0][field] = canary;
    request.canaries = [canary];
    await writeFile(
      join(request.sourceRoot, "observations.json"),
      JSON.stringify(data.observations),
    );
    const result = await collect(request);
    assert.notEqual(result.status, "complete");
    assert.ok(!(await filesText(request.outputDirectory)).includes(canary));
  }
});

test("source allowlist rejects traversal, absolute paths, symlink parents/files and hardlinks; outputs never overwrite", async (t) => {
  for (const path of [
    "../outside.json",
    "/etc/passwd",
    "nested/../../outside.json",
    "a\\b.json",
    "name\n.json",
    "observations.txt",
  ]) {
    const { request } = await setup(t);
    request.sources[0].path = path;
    assert.equal((await collect(request)).status, "failure");
    await assert.rejects(lstat(request.outputDirectory));
  }
  for (const kind of ["file", "parent", "hardlink"]) {
    const { request, root } = await setup(t);
    const outside = join(root, "outside.json");
    await writeFile(outside, "outside-secret-canary");
    if (kind === "parent") {
      await symlink(root, join(request.sourceRoot, "alias"));
      request.sources[0].path = "alias/outside.json";
    } else {
      await rm(join(request.sourceRoot, "observations.json"));
      await (kind === "file" ? symlink : link)(
        outside,
        join(request.sourceRoot, "observations.json"),
      );
    }
    assert.notEqual((await collect(request)).status, "complete");
    assert.ok(!(await filesText(request.outputDirectory)).includes("outside-secret-canary"));
  }
  const { request } = await collected(t);
  const original = await filesText(request.outputDirectory);
  assert.equal((await collect(request)).status, "failure");
  assert.equal(await filesText(request.outputDirectory), original);
  const alias = `${request.outputDirectory}-alias`;
  await symlink(request.outputDirectory, alias);
  await assert.rejects(readBounded(alias, "manifest.json"), /unsafe-directory/);
});

test("missing, oversized, malformed, unavailable and nonregular sources preserve bounded failure/partial evidence", async (t) => {
  for (const content of [
    "{",
    "x".repeat(262145),
    JSON.stringify({ version: "unsupported", observations: [] }),
  ]) {
    const { request } = await setup(t);
    await writeFile(join(request.sourceRoot, "observations.json"), content);
    const result = await collect(request);
    assert.equal(result.status, "failure");
    const attempt = await loadAttempt(request.outputDirectory, inputs);
    assert.equal(attempt.outcome, "blocked");
    assert.equal(attempt.counts.blocked, 3);
  }
  const { request } = await setup(t);
  await rm(join(request.sourceRoot, "observations.json"));
  assert.equal((await collect(request)).status, "failure");
  const dir = await setup(t);
  await rm(join(dir.request.sourceRoot, "observations.json"));
  await mkdir(join(dir.request.sourceRoot, "observations.json"));
  assert.equal((await collect(dir.request)).status, "failure");
  const denied = await setup(t);
  await chmod(join(denied.request.sourceRoot, "observations.json"), 0);
  assert.equal((await collect(denied.request)).status, "failure");
});

test("unavailable output and interrupted collection never fabricate a completed manifest", async (t) => {
  const missing = await setup(t);
  missing.request.outputDirectory = join(missing.root, "absent", "bundle");
  assert.equal((await collect(missing.request)).status, "failure");
  const denied = await setup(t);
  const parent = join(denied.root, "readonly");
  await mkdir(parent, { mode: 0o500 });
  denied.request.outputDirectory = join(parent, "bundle");
  assert.equal((await collect(denied.request)).status, "failure");
  await chmod(parent, 0o700);
  const interrupted = await setup(t);
  const controller = new AbortController();
  interrupted.request.signal = controller.signal;
  // Abort on a real output-directory filesystem notification while collection
  // awaits IO. No reader or collector method is mocked.
  const watcher = watch(interrupted.root, (_type, name) => {
    if (name === "bundle") controller.abort();
  });
  try {
    assert.equal((await collect(interrupted.request)).status, "failure");
  } finally {
    watcher.close();
  }
  assert.ok(!(await readdir(interrupted.request.outputDirectory)).includes("manifest.json"));
});

test("explicit retention is required and candidate review is exact, bounded and synthetic only", async (t) => {
  for (const retention of [
    undefined,
    { access: "public", expiresAt: new Date(Date.now() + 86400000).toISOString() },
    { access: "owner-only", expiresAt: "2020-01-01T00:00:00.000Z" },
    { access: "owner-only", expiresAt: new Date(Date.now() + 8 * 86400000).toISOString() },
  ]) {
    const { request } = await setup(t);
    request.retention = retention;
    assert.equal((await collect(request)).status, "failure");
  }
  const { request, root } = await collected(t);
  const now = new Date().toISOString();
  const review = {
    version: "release-candidate-review/v1",
    manifestDigest: digest(await readFile(join(request.outputDirectory, "manifest.json"))),
    policy: "synthetic-projection/v1",
    scope: "synthetic-only",
    decision: "approved",
    reviewer: "synthetic-reviewer",
    reviewedAt: now,
    expiresAt: request.retention.expiresAt,
  };
  const options = {
    directory: request.outputDirectory,
    outputDirectory: join(root, "candidate"),
    expectedInputs: inputs,
    review,
    now,
  };
  assert.equal(
    (await exportCandidate({ ...options, review: { ...review, manifestDigest: digest("stale") } }))
      .status,
    "failure",
  );
  assert.equal(
    (await exportCandidate({ ...options, review: { ...review, expiresAt: now } })).status,
    "failure",
  );
  assert.equal((await exportCandidate(options)).status, "complete");
  const candidate = JSON.parse(
    await readFile(join(options.outputDirectory, "candidate.json"), "utf8"),
  );
  assert.equal(candidate.releaseAcceptance, "not-established");
  assert.equal(candidate.files.length, 2);
  for (const file of candidate.files)
    assert.equal(digest(await readFile(join(options.outputDirectory, file.path))), file.sha256);
  assert.equal((await exportCandidate(options)).status, "failure");
  const live = await collected(t, { executionClass: "live" });
  assert.equal(
    (
      await exportCandidate({
        ...options,
        directory: live.request.outputDirectory,
        outputDirectory: join(live.root, "candidate"),
      })
    ).status,
    "failure",
  );
});

test("CLI consumes command strings as data; registry/report/validate preserve trust boundaries and diagnostics", async (t) => {
  const { request, root } = await setup(t);
  request.metadata.steps[0].value = "touch should-never-exist";
  const requestPath = join(root, "request.json");
  const inputPath = join(root, "inputs.json");
  await writeFile(requestPath, JSON.stringify(request));
  await writeFile(inputPath, JSON.stringify(inputs));
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8" });
  assert.equal(run("collect", requestPath).status, 0);
  await assert.rejects(lstat(join(root, "should-never-exist")));
  const validation = run("validate", request.outputDirectory, inputPath);
  assert.equal(validation.status, 0);
  assert.equal(JSON.parse(validation.stdout).releaseAcceptance, "not-established");
  const report = run("report", inputPath, request.outputDirectory);
  assert.equal(report.status, 0);
  assert.equal(JSON.parse(report.stdout).requiredLiveCounts.unrun, 19);
  assert.equal(JSON.parse(run("registry").stdout).cases.length, 20);
  assert.equal(run("report", inputPath).status, 0);
  const rejected = run("validate", "secret-canary-path", inputPath);
  assert.equal(rejected.status, 1);
  assert.ok(!rejected.stdout.includes("secret-canary-path"));
  assert.equal(rejected.stderr, "");
});

test("contradictory failed/unknown observations cannot hide behind a passing observation", async (t) => {
  for (const outcome of ["fail", "unknown"]) {
    const { request, data } = await setup(t);
    data.observations.observations.push({ ...data.observations.observations[0], outcome });
    await writeFile(
      join(request.sourceRoot, "observations.json"),
      JSON.stringify(data.observations),
    );
    const result = await collect(request);
    assert.equal(result.status, "failure");
    assert.ok(!(await readdir(request.outputDirectory)).includes("manifest.json"));
  }
});

test("expired retention blocks current coverage while preserving original failure history", async (t) => {
  const { attempt } = await collected(t, { outcome: "fail" });
  const report = summarize([attempt], inputs, attempt.collection.retention.expiresAt);
  assert.equal(report.cases.find((item) => item.id === "r9-stop").expired, true);
  assert.equal(report.cases.find((item) => item.id === "r9-stop").outcome, "blocked");
  assert.equal(report.historicalFailures[0].outcome, "fail");
  const future = structuredClone(attempt);
  future.metadata.endedAt = "2099-01-01T00:00:00.000Z";
  assert.throws(() => validateAttempt(future, inputs), /collection-before-execution/);
});

test("future-dated imported collection cannot bypass current age validation", async (t) => {
  const { attempt, request } = await collected(t);
  attempt.collection.collectedAt = "2099-01-01T00:00:00.000Z";
  attempt.collection.retention.expiresAt = "2099-01-02T00:00:00.000Z";
  assert.throws(() => validateAttempt(attempt, inputs), /future-collection/);
  assert.throws(() => summarize([attempt], inputs), /future-collection/);
  await writeFile(join(request.outputDirectory, "manifest.json"), JSON.stringify(attempt));
  await assert.rejects(loadAttempt(request.outputDirectory, inputs), /future-collection/);
});

test("noncanonical output through a symlink never creates a directory outside the selected parent", async (t) => {
  const { request, root } = await setup(t);
  const intended = join(root, "intended");
  const outside = join(root, "outside");
  await mkdir(intended);
  await mkdir(outside);
  await mkdir(join(outside, "nested"));
  await symlink(join(outside, "nested"), join(intended, "alias"));
  request.outputDirectory = `${intended}/alias/../escaped`;
  assert.equal((await collect(request)).status, "failure");
  await assert.rejects(lstat(join(outside, "escaped")));
  await assert.rejects(lstat(join(intended, "escaped")));
});

test("CLI handles real ENOSPC stdout with fixed diagnostics and no raw stack", (t) => {
  if (process.platform !== "linux") {
    t.skip("requires Linux /dev/full");
    return;
  }
  const descriptor = openSync("/dev/full", "w");
  try {
    const result = spawnSync(process.execPath, [cli, "registry"], {
      stdio: ["ignore", descriptor, "pipe"],
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '{"status":"failure","reasonCode":"output-unavailable"}\n');
    const bothFailed = spawnSync(process.execPath, [cli, "registry"], {
      stdio: ["ignore", descriptor, descriptor],
    });
    assert.equal(bothFailed.status, 1);
  } finally {
    closeSync(descriptor);
  }
});
