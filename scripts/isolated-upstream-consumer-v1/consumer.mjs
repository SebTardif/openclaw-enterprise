import assert from "node:assert/strict";
import { constants } from "node:fs";
import { lstat, open, realpath, opendir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { verifyContext } from "../../deploy/runtime/prepare-local-packages.mjs";
import {
  LIMITS,
  PLAN_SCHEMA,
  canonical,
  closed,
  digest,
  hex,
  parseJson,
  preparationBlockers,
  relativePath,
  text,
  uint,
  validateManifest,
} from "./manifest.mjs";

/** Inspect only explicitly selected regular files. No link traversal or executable loading. */
export async function readArtifact(root, path, maximum = LIMITS.jsonBytes, capture = true) {
  assert.ok(
    isAbsolute(root) && (await realpath(root)) === root,
    "physical absolute artifact root required",
  );
  relativePath(path);
  let physical = root;
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    physical = join(physical, parts[i]);
    const info = await lstat(physical);
    assert.ok(!info.isSymbolicLink(), "artifact symlink forbidden");
    assert.ok(
      i === parts.length - 1 ? info.isFile() : info.isDirectory(),
      "unsupported artifact type",
    );
  }
  const handle = await open(
    physical,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    assert.ok(before.isFile() && before.size <= maximum, "artifact byte limit");
    const hash = createHash("sha256");
    const chunks = [];
    let count = 0;
    const buffer = Buffer.alloc(65536);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      count += bytesRead;
      assert.ok(count <= maximum, "artifact grew beyond limit");
      hash.update(buffer.subarray(0, bytesRead));
      if (capture) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat();
    assert.ok(
      before.ino === after.ino &&
        before.dev === after.dev &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        count === before.size,
      "artifact changed during read",
    );
    const name = await lstat(physical);
    assert.ok(
      name.isFile() &&
        name.ino === after.ino &&
        name.dev === after.dev &&
        name.size === after.size &&
        name.mtimeMs === after.mtimeMs &&
        name.ctimeMs === after.ctimeMs,
      "artifact name changed during read",
    );
    return {
      bytes: count,
      sha256: hash.digest("hex"),
      content: capture ? Buffer.concat(chunks) : null,
    };
  } finally {
    await handle.close();
  }
}

export async function loadManifest(root, path, expectedDigest) {
  const input = await readArtifact(root, path);
  return validateManifest(input.content, expectedDigest);
}

export function validateCanonicalContext(input, expected) {
  const context = parseJson(input);
  closed(context, [
    "installationRef",
    "namespaceRef",
    "agentRef",
    "conversationRef",
    "format",
    "items",
    "parentCheckpointId",
    "canonicalGeneration",
    "canonicalThroughSequence",
    "transcriptRootDigest",
    "attachmentRefs",
  ]);
  assert.equal(context.format, "completed-context-text-v1");
  for (const field of [
    "installationRef",
    "namespaceRef",
    "agentRef",
    "conversationRef",
    "canonicalGeneration",
  ])
    text(context[field], 1024);
  if (context.parentCheckpointId !== null) text(context.parentCheckpointId, 1024);
  uint(context.canonicalThroughSequence);
  hex(context.transcriptRootDigest);
  assert.ok(Array.isArray(context.attachmentRefs) && context.attachmentRefs.length === 0);
  assert.equal(
    Buffer.from(canonical(context)).equals(Buffer.from(input)),
    true,
    "context is not RFC8785 canonical UTF-8",
  );
  assert.equal(digest(input), expected.sha256, "canonical digest mismatch");
  assert.ok(Array.isArray(context.items) && context.items.length <= 16384);
  for (const item of context.items) {
    closed(item, [
      "ordinal",
      "sourceEventRef",
      "turnRef",
      "attemptRef",
      "kind",
      "actorRef",
      "text",
    ]);
    uint(item.ordinal);
    assert.ok(["user-text", "assistant-text", "tool-observation"].includes(item.kind));
    for (const field of ["sourceEventRef", "turnRef", "attemptRef", "actorRef"])
      text(item[field], 1024);
    assert.ok(
      typeof item.text === "string" &&
        item.text.isWellFormed() &&
        Buffer.byteLength(item.text) <= LIMITS.jsonBytes,
    );
  }
  assert.equal(context.items.length, expected.itemCount, "context item count mismatch");
  // Domain-schema correspondence is an independent owner-supplied input.
  return {
    sha256: expected.sha256,
    itemCount: context.items.length,
    canonical: true,
    domainSchemaQualified: false,
  };
}

async function boundedContextTree(root, directory) {
  let count = 0;
  async function visit(path, depth) {
    assert.ok(depth <= LIMITS.depth, "context depth limit");
    for await (const entry of await opendir(path)) {
      assert.ok(++count <= LIMITS.artifacts * 4, "context entry limit");
      assert.ok(entry.isDirectory() || entry.isFile(), "unsupported context entry");
      if (entry.isDirectory()) await visit(join(path, entry.name), depth + 1);
    }
  }
  await visit(join(root, directory), 0);
}

export async function verifyArtifacts(root, manifest, observedEnvironment = []) {
  const checks = [];
  const contents = new Map();
  for (const a of manifest.artifacts) {
    if (a.state === "missing") {
      checks.push({ id: a.id, outcome: "missing", reason: a.reason });
      continue;
    }
    try {
      const capture = a.bytes <= LIMITS.jsonBytes && a.role !== "archive";
      const observed = await readArtifact(root, a.path, a.bytes, capture);
      assert.equal(observed.bytes, a.bytes);
      assert.equal(observed.sha256, a.sha256, "artifact digest mismatch");
      if (observed.content !== null) contents.set(a.id, observed.content);
      checks.push({ id: a.id, outcome: "pass", reason: null });
    } catch (error) {
      checks.push({
        id: a.id,
        outcome: error.code === "ENOENT" ? "missing" : "fail",
        reason: "selected artifact unavailable or changed",
      });
    }
  }
  const issues = [];
  if (canonical(observedEnvironment) !== canonical(manifest.environment))
    issues.push("environment-binding-mismatch");
  const run = async (name, action) => {
    try {
      return { name, outcome: "pass", detail: await action() };
    } catch {
      issues.push(name);
      return { name, outcome: "blocked", detail: null };
    }
  };
  const context = await run("canonical-context", () =>
    validateCanonicalContext(
      contents.get(manifest.canonicalContext.artifactId),
      manifest.canonicalContext,
    ),
  );
  const quiet = {
    name: "quiet-receipt",
    outcome: "blocked",
    detail: {
      reason: "public-quiet-receiver-schema-unavailable",
      receiptSchemaVerified: false,
      capabilityQualified: false,
      quietnessObserved: false,
    },
  };
  // Capability metadata alone cannot supply the missing native receiver or attest quietness.
  issues.push("quiet-capability-unqualified");
  const prepared = await run("prepared-context", async () => {
    const receipt = parseJson(contents.get(manifest.preparedContext.artifactId));
    assert.equal(receipt.schema, "oce.runtime-packages/v1");
    assert.ok(Array.isArray(receipt.files) && receipt.files.length <= LIMITS.artifacts);
    for (const file of receipt.files) {
      relativePath(file.path);
      uint(file.bytes, LIMITS.artifactBytes);
      hex(file.sha256);
      const selectedPath = `${manifest.preparedContext.directory}/${file.path}`;
      assert.ok(
        manifest.artifacts.some(
          (a) =>
            a.state === "supplied" &&
            a.path === selectedPath &&
            a.bytes === file.bytes &&
            a.sha256 === file.sha256,
        ),
        "unselected prepared input",
      );
    }
    const a = manifest.artifacts.find((entry) => entry.id === manifest.preparedContext.artifactId);
    assert.equal(a.path, `${manifest.preparedContext.directory}/preparation.json`);
    assert.ok(
      checks
        .filter((c) =>
          manifest.artifacts.some(
            (entry) =>
              entry.id === c.id && entry.path?.startsWith(`${manifest.preparedContext.directory}/`),
          ),
        )
        .every((c) => c.outcome === "pass"),
    );
    await boundedContextTree(root, manifest.preparedContext.directory);
    await verifyContext(join(root, manifest.preparedContext.directory));
    // Bind post-verification observations; no atomic snapshot or installed closure asserted.
    for (const entry of manifest.artifacts.filter(
      (item) =>
        item.state === "supplied" && item.path.startsWith(`${manifest.preparedContext.directory}/`),
    )) {
      const after = await readArtifact(root, entry.path, entry.bytes, false);
      assert.equal(after.sha256, entry.sha256);
      assert.equal(after.bytes, entry.bytes);
    }
    return {
      contextVerified: true,
      archiveMembersVerified: false,
      installedClosureVerified: false,
    };
  });
  const declarations = [...manifest.declarations, manifest.completedStateDeclaration].map((d) => ({
    import: d.import,
    inputsPresent: [d.artifactId, d.exportsArtifactId, ...d.dependencyArtifactIds].every(
      (id) => checks.find((c) => c.id === id)?.outcome === "pass",
    ),
    compiled: false,
  }));
  return {
    outcome: checks.some((c) => c.outcome === "fail") ? "fail" : "blocked",
    artifactChecks: checks,
    context,
    quiet,
    prepared,
    declarations,
    issues,
    evidenceKind: manifest.evidenceKind,
    evidenceAuthenticated: false,
    runtimeQualified: false,
  };
}

export function preparePlan(manifest, manifestDigest) {
  hex(manifestDigest);
  return {
    schema: PLAN_SCHEMA,
    manifestDigest,
    evidenceKind: manifest.evidenceKind,
    execution: "external-maintained-runner-only",
    automaticRetry: false,
    browser: manifest.browser,
    cases: manifest.cases.map((c) => ({
      ...c,
      blockers: preparationBlockers(manifest, c),
      initialOutcome: !c.selected
        ? "unselected"
        : c.command.state === "missing" || preparationBlockers(manifest, c).length > 0
          ? "blocked"
          : "unrun",
    })),
    evidenceAuthenticated: false,
    runtimeQualified: false,
  };
}
