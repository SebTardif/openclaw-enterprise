import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { decodeNativeMeasurementProfileV1 } from "../../packages/contracts/src/native-measurement-codec-v1.ts";
import {
  NATIVE_MEASUREMENT_CASES_V1,
  NATIVE_MEASUREMENT_ENDPOINTS_V1,
} from "../../packages/contracts/src/native-measurement-v1.ts";

/** Preparation format only; no native execution or artifact authenticity follows. */
export const MANIFEST_SCHEMA = "oce.isolated-upstream-consumer/v1";
export const RESULT_SCHEMA = "oce.isolated-upstream-result/v1";
export const PLAN_SCHEMA = "oce.isolated-upstream-plan/v1";
export const LIMITS = Object.freeze({
  jsonBytes: 1048576,
  artifactBytes: 1073741824,
  totalArtifactBytes: 2147483648,
  artifacts: 128,
  cases: 256,
  depth: 32,
});

export const SUPPORTED_IMPORTS = Object.freeze([
  "openclaw/plugin-sdk/gateway-host",
  "openclaw/plugin-sdk/channel-inbound",
  "openclaw/plugin-sdk/slack-hosted",
  "openclaw/plugin-sdk/msteams-hosted",
  "openclaw/plugin-sdk/codex-hosted-harness",
]);

export function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function relativePath(value) {
  assert.equal(typeof value, "string", "artifact path must be a string");
  assert.ok(
    value.length > 0 &&
      value.length <= 256 &&
      value
        .split("/")
        .every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== ".."),
    "artifact path must be a bounded relative path",
  );
  return value;
}

export function absolutePath(value) {
  text(value, 1024);
  assert.ok(
    posix.isAbsolute(value) && posix.normalize(value) === value && !value.includes("\\"),
    "normalized absolute path required",
  );
  return value;
}

export function mandatoryInputs(manifest, caseId) {
  const groups = {
    "preparation.artifacts": [
      manifest.preparedContext.artifactId,
      ...manifest.artifacts
        .filter(
          (a) =>
            ["archive", "lock"].includes(a.role) ||
            (a.role === "configuration" &&
              a.path?.startsWith(`${manifest.preparedContext.directory}/`)),
        )
        .map((a) => a.id),
    ],
    "preparation.declarations": [
      ...manifest.declarations,
      manifest.completedStateDeclaration,
    ].flatMap((d) => [d.artifactId, d.exportsArtifactId, ...d.dependencyArtifactIds]),
    "preparation.context": [manifest.canonicalContext.artifactId],
    "preparation.quiet": [
      manifest.quiet.capabilityArtifactId,
      manifest.quiet.receiptArtifactId,
      manifest.canonicalContext.artifactId,
    ],
  };
  return [...new Set(groups[caseId] ?? [])];
}

export function preparationBlockers(manifest, c) {
  const reasons = [];
  if (c.id === "preparation.quiet" && manifest.quiet.state === "unavailable")
    reasons.push("public-quiet-receiver-schema-unavailable");
  for (const id of new Set([...c.inputIds, ...mandatoryInputs(manifest, c.id)])) {
    if (!c.inputIds.includes(id)) reasons.push(`mandatory-input-unselected:${id}`);
    if (manifest.artifacts.find((a) => a.id === id)?.state !== "supplied")
      reasons.push(`missing-input:${id}`);
  }
  return reasons;
}

export function closed(value, keys) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "expected object");
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), "unknown or missing fields");
  return value;
}

export function text(value, maximum = 256) {
  assert.ok(
    typeof value === "string" && value.length > 0 && value.length <= maximum,
    "invalid text",
  );
  assert.ok(!/[\u0000-\u001f\u007f]/u.test(value), "control character");
  // JSON permits lone surrogates; Unicode scalar values do not.
  assert.equal(value.isWellFormed(), true, "invalid Unicode");
  return value;
}

export function hex(value) {
  assert.ok(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "invalid digest");
  return value;
}

export function uint(value, maximum = Number.MAX_SAFE_INTEGER) {
  assert.ok(
    Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0 && value <= maximum,
    "unsafe counter",
  );
  return value;
}

export function unique(values, maximum = LIMITS.cases) {
  assert.ok(Array.isArray(values) && values.length <= maximum, "invalid array");
  assert.equal(new Set(values).size, values.length, "duplicate entry");
  return values;
}

/** JSON data only. Preserve duplicate-key and numeric-token failures before conversion. */
export function parseJson(input, { integersOnly = true } = {}) {
  const bytes = typeof input === "string" ? Buffer.from(input) : input;
  assert.ok(bytes instanceof Uint8Array && bytes.byteLength <= LIMITS.jsonBytes, "JSON size limit");
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  let cursor = 0;
  let nodes = 0;
  const ws = () => {
    while (/^[\t\n\r ]$/.test(source[cursor] ?? "")) cursor++;
  };
  const string = () => {
    const start = cursor++;
    for (;;) {
      assert.ok(cursor < source.length, "unterminated string");
      const c = source[cursor++];
      if (c === "\\") {
        cursor++;
        continue;
      }
      if (c === '"') break;
    }
    const result = JSON.parse(source.slice(start, cursor));
    assert.equal(result.isWellFormed(), true, "invalid Unicode");
    return result;
  };
  const integerFields = new Set([
    "exit_code",
    "return_code",
    "tests",
    "suites",
    "pass",
    "fail",
    "cancelled",
    "skipped",
    "todo",
    "bytes",
    "pid",
    "pgid",
  ]);
  const value = (depth, field = "") => {
    assert.ok(depth <= LIMITS.depth && ++nodes <= 100000, "JSON complexity limit");
    ws();
    const c = source[cursor];
    if (c === '"') return string();
    if (c === "{" || c === "[") {
      cursor++;
      const object = c === "{";
      const result = object ? Object.create(null) : [];
      const keys = new Set();
      ws();
      const end = object ? "}" : "]";
      if (source[cursor] === end) {
        cursor++;
        return result;
      }
      for (;;) {
        ws();
        let key = String(result.length);
        if (object) {
          assert.equal(source[cursor], '"', "expected object key");
          key = string();
          assert.ok(!keys.has(key), "duplicate key");
          keys.add(key);
          ws();
          assert.equal(source[cursor++], ":", "expected colon");
        }
        result[key] = value(depth + 1, key);
        ws();
        if (source[cursor] === end) {
          cursor++;
          break;
        }
        assert.equal(source[cursor++], ",", "expected comma");
      }
      return result;
    }
    for (const [token, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ]) {
      if (source.startsWith(token, cursor)) {
        cursor += token.length;
        return result;
      }
    }
    const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      source.slice(cursor),
    )?.[0];
    assert.ok(token, "invalid JSON token");
    const integerToken = /^-?(?:0|[1-9][0-9]*)$/.test(token);
    if (integersOnly || integerFields.has(field)) assert.ok(integerToken, "integer token required");
    const result = Number(token);
    assert.ok(
      Number.isFinite(result) && Math.abs(result) <= Number.MAX_SAFE_INTEGER,
      "unsafe number",
    );
    if (integerToken) assert.ok(Number.isSafeInteger(result), "unsafe integer");
    cursor += token.length;
    return result;
  };
  const result = value(0);
  ws();
  assert.equal(cursor, source.length, "trailing JSON content");
  return result;
}

/** RFC 8785 serialization for already validated JSON values and Unicode scalar strings. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export const BROWSER_CASES = Object.freeze({
  B1: ["effective-configuration", "missing-assets", "conflicting-override"],
  B2: [
    "inventory",
    "unauthenticated",
    "management",
    "expired-revoked",
    "foreign",
    "forwarded",
    "control-positive",
  ],
  B3: ["inventory", "same-origin", "untrusted-origin", "saved-state", "service-allowlist"],
  B4: ["assets", "network-storage", "safe-logs"],
  B5: ["restart", "new-host", "image-route-config"],
  B6: [
    "local-login",
    "scoped-browse",
    "revisions-channel-edits",
    "foreign-stale",
    "native-slack",
    "native-teams",
  ],
});
export const REQUIRED_CASES = Object.freeze([
  "preparation.artifacts",
  "preparation.declarations",
  "preparation.quiet",
  "preparation.context",
  ...Object.entries(BROWSER_CASES).flatMap(([group, names]) =>
    names.map((name) => `${group}.${name}`),
  ),
  ...BROWSER_CASES.B5.flatMap((replacement) =>
    Object.entries(BROWSER_CASES)
      .filter(([group]) => ["B1", "B2", "B3", "B4"].includes(group))
      .flatMap(([group, names]) => names.map((name) => `B5.${replacement}.${group}.${name}`)),
  ),
  ...["slack", "teams"].flatMap((channel) =>
    NATIVE_MEASUREMENT_CASES_V1.map((id) => `${channel}.${id}`),
  ),
]);
export const OPTIONAL_CASES = Object.freeze([
  "optional.browser-chat",
  "optional.attachments",
  "optional.token-streaming",
]);
export const ARTIFACT_ROLES = Object.freeze([
  "preparation",
  "archive",
  "canonical-context",
  "quiet-capability",
  "quiet-receipt",
  "declarations",
  "exports",
  "dependency-closure",
  "configuration",
  "native-executable",
  "gateway-image",
  "producer-receipt",
  "toolchain",
  "schema",
  "lock",
  "log",
  "receipt",
]);

function command(value, artifactIds, environmentNames) {
  if (value.state === "missing") {
    closed(value, ["state", "owner", "reason"]);
    text(value.owner);
    text(value.reason, 1024);
    return;
  }
  closed(value, [
    "state",
    "argv",
    "cwdRef",
    "artifactRootRef",
    "executableDigest",
    "inputIds",
    "environmentNames",
    "expectedExit",
  ]);
  assert.equal(value.state, "supplied");
  assert.ok(Array.isArray(value.argv) && value.argv.length > 0 && value.argv.length <= 32);
  value.argv.forEach((arg) => text(arg, 1024));
  absolutePath(value.cwdRef);
  absolutePath(value.artifactRootRef);
  hex(value.executableDigest);
  unique(value.inputIds, LIMITS.artifacts).forEach((id) => assert.ok(artifactIds.has(id)));
  unique(value.environmentNames, 32).forEach((name) => assert.ok(environmentNames.has(name)));
  uint(value.expectedExit, 255);
}

export function validateManifest(input, expectedDigest) {
  hex(expectedDigest);
  const bytes = typeof input === "string" ? Buffer.from(input) : input;
  assert.equal(digest(bytes), expectedDigest, "manifest does not match independent selection");
  const m = parseJson(bytes);
  closed(m, [
    "schema",
    "evidenceKind",
    "producer",
    "nativeDistribution",
    "artifacts",
    "declarations",
    "completedStateDeclaration",
    "canonicalContext",
    "quiet",
    "preparedContext",
    "environment",
    "profiles",
    "cases",
    "browser",
  ]);
  assert.equal(m.schema, MANIFEST_SCHEMA);
  assert.ok(["fixture", "source", "installed", "actual-provider"].includes(m.evidenceKind));
  assert.ok(["official", "changed"].includes(m.nativeDistribution));
  closed(m.browser, ["managementOnly", "browserChatExposed"]);
  assert.deepEqual(
    m.browser,
    Object.assign(Object.create(null), { managementOnly: true, browserChatExposed: false }),
  );
  assert.ok(
    Array.isArray(m.artifacts) && m.artifacts.length > 0 && m.artifacts.length <= LIMITS.artifacts,
  );
  const ids = new Set();
  const paths = new Set();
  let total = 0;
  for (const a of m.artifacts) {
    closed(a, ["id", "role", "state", "path", "bytes", "sha256", "reason"]);
    text(a.id);
    assert.ok(!ids.has(a.id));
    ids.add(a.id);
    assert.ok(ARTIFACT_ROLES.includes(a.role));
    if (a.state === "missing") {
      assert.equal(a.path, null);
      assert.equal(a.bytes, null);
      assert.equal(a.sha256, null);
      text(a.reason, 1024);
    } else {
      assert.equal(a.state, "supplied");
      relativePath(a.path);
      uint(a.bytes, LIMITS.artifactBytes);
      hex(a.sha256);
      assert.equal(a.reason, null);
      assert.ok(!paths.has(a.path), "duplicate artifact path");
      paths.add(a.path);
      total += a.bytes;
    }
  }
  assert.ok(total <= LIMITS.totalArtifactBytes, "aggregate artifact limit");
  const role = (id, expectedRole) => {
    const a = m.artifacts.find((entry) => entry.id === id);
    assert.equal(a?.role, expectedRole, "artifact role mismatch");
    return a;
  };
  closed(m.preparedContext, ["directory", "artifactId"]);
  relativePath(m.preparedContext.directory);
  role(m.preparedContext.artifactId, "preparation");
  closed(m.canonicalContext, ["artifactId", "sha256", "itemCount"]);
  role(m.canonicalContext.artifactId, "canonical-context");
  hex(m.canonicalContext.sha256);
  uint(m.canonicalContext.itemCount, 4096);
  closed(m.quiet, [
    "state",
    "capabilityArtifactId",
    "receiptArtifactId",
    "purpose",
    "expectedReceipt",
  ]);
  assert.equal(
    m.quiet.state,
    "unavailable",
    "the selected public boundary has no quiet receiver schema",
  );
  role(m.quiet.capabilityArtifactId, "quiet-capability");
  role(m.quiet.receiptArtifactId, "quiet-receipt");
  assert.equal(m.quiet.purpose, "completed-context-restore", "unsupported purpose");
  assert.equal(m.quiet.expectedReceipt, null, "no invented quiet receipt schema");
  assert.ok(Array.isArray(m.declarations) && m.declarations.length === SUPPORTED_IMPORTS.length);
  unique(m.declarations.map((d) => d.import));
  for (const d of [...m.declarations, m.completedStateDeclaration]) {
    closed(d, ["import", "artifactId", "exportsArtifactId", "dependencyArtifactIds"]);
    assert.ok(
      d === m.completedStateDeclaration
        ? d.import === "openclaw/plugin-sdk/completed-state"
        : SUPPORTED_IMPORTS.includes(d.import),
    );
    role(d.artifactId, "declarations");
    role(d.exportsArtifactId, "exports");
    unique(d.dependencyArtifactIds, LIMITS.artifacts).forEach((id) =>
      role(id, "dependency-closure"),
    );
    assert.ok(d.dependencyArtifactIds.length > 0, "selected declaration closure required");
  }
  assert.ok(Array.isArray(m.environment) && m.environment.length <= 32);
  const names = new Set();
  for (const e of m.environment) {
    closed(e, ["name", "sha256"]);
    assert.ok(/^[A-Z][A-Z0-9_]{0,63}$/.test(e.name));
    hex(e.sha256);
    assert.ok(!names.has(e.name));
    names.add(e.name);
  }
  closed(m.profiles, ["slack", "teams"]);
  for (const [channel, profile] of Object.entries(m.profiles)) {
    const decoded = decodeNativeMeasurementProfileV1(profile);
    assert.equal(decoded.kind, "valid", "invalid measurement profile");
    assert.equal(profile.workload.channel, channel);
    assert.equal(profile.evidenceKind, m.evidenceKind);
    assert.equal(canonical(profile.subject.producer), canonical(m.producer), "producer mismatch");
    const roles = {
      declarations: "declarations",
      exports: "exports",
      package: "archive",
      dependencyClosure: "dependency-closure",
      nativeExecutable: "native-executable",
      gatewayImage: "gateway-image",
      effectiveConfiguration: "configuration",
      capabilities: "quiet-capability",
      toolchain: "toolchain",
      producerReceipt: "producer-receipt",
    };
    for (const [key, pin] of Object.entries(profile.subject.artifacts)) {
      if (pin.state === "known")
        assert.ok(
          m.artifacts.some((a) => a.role === roles[key] && a.sha256 === pin.digest),
          "unbound subject artifact",
        );
    }
  }
  assert.ok(Array.isArray(m.cases) && m.cases.length <= LIMITS.cases);
  unique(m.cases.map((c) => c.id));
  for (const id of REQUIRED_CASES)
    assert.ok(
      m.cases.some((c) => c.id === id),
      `missing required case ${id}`,
    );
  for (const c of m.cases) {
    closed(c, [
      "id",
      "required",
      "selected",
      "reason",
      "inputIds",
      "command",
      "substitutes",
      "measurement",
    ]);
    assert.equal(c.required, REQUIRED_CASES.includes(c.id));
    assert.ok(c.required || OPTIONAL_CASES.includes(c.id));
    assert.equal(typeof c.selected, "boolean");
    if (!c.selected) text(c.reason, 1024);
    else assert.equal(c.reason, null);
    unique(c.inputIds, LIMITS.artifacts).forEach((id) => assert.ok(ids.has(id)));
    assert.ok(c.inputIds.length > 0, "case inputs required");
    assert.ok(
      mandatoryInputs(m, c.id).every((id) => c.inputIds.includes(id)),
      "mandatory preparation inputs must remain selected, including missing inputs",
    );
    unique(c.substitutes, 16).forEach((name) => text(name));
    command(c.command, ids, names);
    if (c.command.state === "supplied")
      assert.equal(
        canonical([...c.command.inputIds].sort()),
        canonical([...c.inputIds].sort()),
        "command must bind every case input",
      );
    const [channel, measurementId] = c.id.split(".");
    if (["slack", "teams"].includes(channel)) {
      closed(c.measurement, ["channel", "caseId", "endpoints"]);
      assert.equal(c.measurement.channel, channel);
      assert.equal(c.measurement.caseId, measurementId);
      assert.deepEqual(c.measurement.endpoints, [
        ...NATIVE_MEASUREMENT_ENDPOINTS_V1[measurementId],
      ]);
    } else assert.equal(c.measurement, null);
  }
  const freeze = (value) => {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  return freeze(m);
}
