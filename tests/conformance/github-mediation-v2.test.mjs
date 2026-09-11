import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeGitHubMediationRequest as decode,
  encodeGitHubMediationMetadata as encode,
  githubMetadataDigest,
  githubGitReadDigest,
  GITHUB_GIT_READ_ALPN,
  GITHUB_GIT_REQUEST_LIMIT,
  EMPTY_BODY_SHA256,
  GITHUB_MEDIATION_ALPN,
  METADATA_LIMIT,
  TOKEN_LIMIT,
} from "../../packages/occ/src/github-mediation-v2/wire.ts";
import { GitHubMediationService } from "../../packages/occ/src/github-mediation-v2/service.ts";
import {
  githubMediationClockContinuous,
  githubMediationMonotonicDeadline,
  sampleGitHubMediationClock,
} from "../../packages/occ/src/github-mediation-v2/clock.ts";
import { trust } from "../fixtures/runtime-authority-v1/vectors.mjs";

const utf8 = (text) => new TextEncoder().encode(text);
const json = (value) => utf8(JSON.stringify(value));
const requestDigest = "sha256:012ace5cf16209d0f8f15d41e1e3b37efcc8fdcefe926047e09e8c9e7719fb34";
const open = Object.freeze({
  version: 2,
  sequence: 1,
  request_ref: "0123456789abcdef0123456789abcdef",
  method: "open-read",
  attachment_ref: "attachment/example",
  repository_owner: "example",
  repository_name: "project",
  request_sha256: requestDigest,
});
const binding = Object.freeze({
  version: 2,
  sequence: 2,
  request_ref: open.request_ref,
  session_ref: "a".repeat(32),
  effect_ref: "effect/example",
  work_binding_sha256: `sha256:${"b".repeat(64)}`,
  request_sha256: requestDigest,
});
const dispatch = Object.freeze({
  ...binding,
  method: "dispatch-read",
  dns_binding_ref: "dns/example",
  upstream_ipv4: "140.82.114.5",
  peer_certificate_sha256: `sha256:${"c".repeat(64)}`,
});
const current = Object.freeze({
  ...binding,
  sequence: 3,
  server_time_ms: 0,
  valid_until_ms: 100,
  operation_until_ms: 200,
  ok: true,
  phase: "current",
  release_ref: "release/example",
});
const gitDiscovery = Object.freeze({
  ...open,
  version: 3,
  git_operation: "discovery",
  git_protocol: "version=2",
  body_bytes: 0,
  body_sha256: EMPTY_BODY_SHA256,
  request_sha256: "sha256:1d558dc32779e5b4aca0c37defcdf0a5018f1517ff7716f42419a2e531cc069a",
});
const gitUpload = Object.freeze({
  ...gitDiscovery,
  git_operation: "upload-pack",
  body_bytes: 72,
  body_sha256: "sha256:30f5149ff5f5a60ddababe9b0932fd61736653a3e2e310b7ae2d9f2138ebdb9d",
  request_sha256: "sha256:792994a0d426f5dd513a227dfb83ac91381eba7d8e40c1e47916f3bde4435f62",
});

test("literal Git profile types cannot receive a metadata owner through union widening", (t) => {
  // Compile-only declarations test the real public types. No authority owner or
  // positive preparation is instantiated or executed by this virtual source.
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const directory = mkdtempSync(join(root, "tests/.github-profile-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = `
import { GitHubMediationService } from "../../packages/occ/src/github-mediation-v2/service.ts";
import type { GitHubMediationLimits, GitHubMediationOperationOwner, GitHubMediationTransportOwner } from "../../packages/occ/src/github-mediation-v2/ports.ts";
declare const transport: GitHubMediationTransportOwner;
declare const limits: GitHubMediationLimits;
declare const metadataOwner: GitHubMediationOperationOwner<object, object>;
declare const gitOwner: GitHubMediationOperationOwner<object, object, 3>;
new GitHubMediationService({ transport, limits, operations: metadataOwner });
new GitHubMediationService({ transport, limits, protocolVersion: 3, operations: gitOwner });
// @ts-expect-error Git owner requires explicit successor selection.
new GitHubMediationService({ transport, limits, operations: gitOwner });
// @ts-expect-error Metadata owner cannot become the Git successor owner.
new GitHubMediationService({ transport, limits, protocolVersion: 3, operations: metadataOwner });
// @ts-expect-error Explicit generic cannot omit the required successor selection.
new GitHubMediationService<object, object, 3>({ transport, limits, operations: gitOwner });
// @ts-expect-error A union cannot stand in for one selected profile.
new GitHubMediationService<object, object, 2 | 3>({ transport, limits, protocolVersion: 3, operations: metadataOwner });
// @ts-expect-error Intermediate union widening cannot erase the metadata-only input boundary.
const widenedOwner: GitHubMediationOperationOwner<object, object, 2 | 3> = metadataOwner;
`;
  const options = {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: "ES2022",
    module: "NodeNext",
    allowImportingTsExtensions: true,
  };
  writeFileSync(join(directory, "consumer.ts"), source);
  const project = join(directory, "tsconfig.json");
  writeFileSync(project, JSON.stringify({ compilerOptions: options, files: ["consumer.ts"] }));
  const result = spawnSync(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "--project", project, "--pretty", "false"],
    { cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024 },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("Git discovery and upload-pack match independent exact-body digest vectors", () => {
  assert.equal(GITHUB_GIT_READ_ALPN, "oce-github-git-read-v3");
  assert.equal(GITHUB_GIT_REQUEST_LIMIT, 4194304);
  const body = "0014command=ls-refs\n0017object-format=sha1\n00010009peel\n000csymrefs\n0000";
  assert.equal(Buffer.byteLength(body), gitUpload.body_bytes);
  assert.equal(`sha256:${createHash("sha256").update(body).digest("hex")}`, gitUpload.body_sha256);
  for (const request of [gitDiscovery, gitUpload]) {
    assert.equal(
      githubGitReadDigest(
        request.repository_owner,
        request.repository_name,
        request.git_operation,
        request.body_bytes,
        request.body_sha256,
      ),
      request.request_sha256,
    );
    assert.deepEqual({ ...decode(json(request), 3) }, request);
    assert.equal(decode(json(request)), undefined);
    assert.equal(decode(json(request), 2), undefined);
  }
  assert.equal(decode(json(open), 3), undefined);
});

test("Git metadata binds exact operation, protocol, body size and digest without route overrides", () => {
  for (const patch of [
    { git_operation: "receive-pack" },
    { git_operation: "metadata" },
    { git_protocol: "version=1" },
    { git_protocol: "version=2:server-option=x" },
    { body_bytes: 0 },
    { body_bytes: 71 },
    { body_bytes: 73 },
    { body_bytes: -1 },
    { body_bytes: 4194305 },
    { body_bytes: 1.5 },
    { body_sha256: EMPTY_BODY_SHA256 },
    { body_sha256: `sha256:${"A".repeat(64)}` },
    { repository_name: "other" },
    { repository_owner: "Example" },
    { path: "/example/project.git/git-receive-pack" },
    { host: "api.github.com" },
    { authorization: "public-canary" },
    { body_ref: "/mutable/body" },
    { response_bytes: Infinity },
    { version: 2 },
  ])
    assert.equal(decode(json({ ...gitUpload, ...patch }), 3), undefined);
  for (const patch of [
    { body_bytes: 1 },
    { body_sha256: gitUpload.body_sha256 },
    { git_operation: "upload-pack" },
    { git_protocol: null },
  ])
    assert.equal(decode(json({ ...gitDiscovery, ...patch }), 3), undefined);
  for (const key of Object.keys(gitDiscovery)) {
    const missing = { ...gitDiscovery };
    delete missing[key];
    assert.equal(decode(json(missing), 3), undefined);
  }
  assert.equal(decode(json(gitDiscovery), 4), undefined);
});

test("Git subsequent frames and replies retain exact version-3 closed grammar", () => {
  for (const request of [
    dispatch,
    { ...binding, sequence: 3, method: "check-read", release_ref: "release/example" },
    { ...binding, sequence: 3, method: "complete-read", release_ref: null, outcome: "unknown" },
  ]) {
    const git = { ...request, version: 3, request_sha256: gitUpload.request_sha256 };
    assert.deepEqual({ ...decode(json(git), 3) }, git);
    assert.equal(decode(json(git)), undefined);
    assert.equal(decode(json({ ...git, git_operation: "discovery" }), 3), undefined);
  }
  const reply = { ...current, version: 3, request_sha256: gitUpload.request_sha256 };
  assert.deepEqual(JSON.parse(new TextDecoder().decode(encode(reply))), reply);
  assert.throws(() => encode({ ...reply, version: 4 }), /Invalid GitHub mediation metadata/);
  assert.throws(
    () => encode({ ...reply, token: "public-canary" }),
    /Invalid GitHub mediation metadata/,
  );
});

test("Git digest enforces bounded bodies and distinct metadata/discovery/upload domains", () => {
  assert.equal(
    githubGitReadDigest("example", "project", "upload-pack", 0, EMPTY_BODY_SHA256),
    undefined,
  );
  assert.equal(
    githubGitReadDigest("example", "project", "discovery", 1, EMPTY_BODY_SHA256),
    undefined,
  );
  assert.equal(
    githubGitReadDigest("example", "project", "upload-pack", Infinity, EMPTY_BODY_SHA256),
    undefined,
  );
  assert.equal(
    githubGitReadDigest("../example", "project", "discovery", 0, EMPTY_BODY_SHA256),
    undefined,
  );
  assert.equal(
    githubGitReadDigest("example", "project", "receive-pack", 72, gitUpload.body_sha256),
    undefined,
  );
  assert.notEqual(githubMetadataDigest("example", "project"), gitDiscovery.request_sha256);
  assert.notEqual(
    githubGitReadDigest("example", "project", "upload-pack", 4194304, gitUpload.body_sha256),
    undefined,
  );
  assert.equal(
    githubGitReadDigest("example", "project", "upload-pack", 4194305, gitUpload.body_sha256),
    undefined,
  );
});

test("metadata digest matches an independently computed fixed request vector", () => {
  assert.equal(githubMetadataDigest("example", "project"), requestDigest);
  assert.equal(GITHUB_MEDIATION_ALPN, "oce-github-mediation-v2");
  assert.equal(METADATA_LIMIT, 16384);
  assert.equal(TOKEN_LIMIT, 16384);
  for (const [owner, name] of [
    ["example\n", "project"],
    ["../example", "project"],
    ["example", "project?x=1"],
    ["x".repeat(256), "project"],
  ]) {
    assert.equal(githubMetadataDigest(owner, name), undefined);
  }
  assert.notEqual(githubMetadataDigest("Example", "project"), requestDigest);
});

test("all closed request shapes decode as frozen detached records", () => {
  for (const request of [
    open,
    dispatch,
    { ...binding, sequence: 3, method: "check-read", release_ref: "release/example" },
    { ...binding, sequence: 3, method: "complete-read", release_ref: null, outcome: "unknown" },
  ]) {
    const bytes = json(request);
    const value = decode(bytes);
    assert.deepEqual({ ...value }, request);
    assert.ok(Object.isFrozen(value));
    bytes.fill(0);
    assert.deepEqual({ ...value }, request);
  }
});

test("metadata parser rejects duplicate decoded keys, invalid UTF-8 and unsupported JSON", () => {
  for (const bytes of [
    utf8('{"version":2,"version":2}'),
    utf8('{"version":2,"\\u0076ersion":2}'),
    utf8(JSON.stringify(open).replace('"version":2', '"version":2.0')),
    utf8(JSON.stringify(open).replace('"version":2', '"version":2e0')),
    utf8(JSON.stringify(open) + "{}"),
    utf8("\ufeff" + JSON.stringify(open)),
    utf8('{"version":{"nested":[[[1]]]}}'),
    utf8("[]"),
    utf8('{"a":1,}'),
    Uint8Array.of(0xff),
    Uint8Array.of(0xc0, 0xaf),
    new Uint8Array(0),
    new Uint8Array(METADATA_LIMIT + 1),
  ])
    assert.equal(decode(bytes), undefined);
});

test("open request rejects extra fields, credentials, wrong digest and route ambiguity", () => {
  for (const patch of [
    { extra: 1 },
    { sequence: 0 },
    { sequence: 2 },
    { request_ref: open.request_ref + "\n" },
    { attachment_ref: "attachment\n" },
    { repository_owner: "example/" },
    { request_sha256: `sha256:${"0".repeat(64)}` },
    { repository_name: "project\n" },
    { secret: "canary" },
  ])
    assert.equal(decode(json({ ...open, ...patch })), undefined);
});

test("dispatch only describes a canonical public IPv4 endpoint", () => {
  for (const ip of [
    "0.0.0.0",
    "127.0.0.1",
    "192.168.1.1",
    "192.88.99.1",
    "100.64.0.1",
    "198.18.0.1",
    "203.0.113.1",
    "224.0.0.1",
    "140.082.114.5",
    "256.0.0.1",
    "140.82.114.5\n",
  ]) {
    assert.equal(decode(json({ ...dispatch, upstream_ipv4: ip })), undefined);
  }
  assert.equal(decode(json({ ...dispatch, sequence: 3 })), undefined);
});

test("reply encoder emits only closed primitive nonsecret metadata", () => {
  for (const reply of [
    current,
    { ...binding, sequence: 2, ok: true, phase: "recorded", release_ref: null },
    { version: 2, sequence: 1, request_ref: open.request_ref, ok: false, code: "denied" },
  ])
    assert.deepEqual(JSON.parse(new TextDecoder().decode(encode(reply))), reply);
  for (const patch of [
    { token: "canary" },
    { valid_until_ms: 201 },
    { server_time_ms: 100 },
    { server_time_ms: -0 },
    { operation_until_ms: 253402300800000 },
    { release_ref: "release/example\n" },
    { sequence: 1 },
  ])
    assert.throws(
      () => encode({ ...current, ...patch }),
      /^Error: Invalid GitHub mediation metadata$/,
    );
});

test("wire conversion never invokes caller getters, proxies or toJSON", () => {
  let calls = 0;
  const getter = { ...current };
  Object.defineProperty(getter, "release_ref", {
    enumerable: true,
    get() {
      calls++;
      return "release/example";
    },
  });
  assert.throws(() => encode(getter));
  assert.throws(() =>
    encode({
      ...current,
      toJSON() {
        calls++;
        return current;
      },
    }),
  );
  assert.throws(() =>
    encode(
      new Proxy(current, {
        ownKeys() {
          calls++;
          return [];
        },
      }),
    ),
  );
  const bytes = json(open);
  Object.defineProperty(bytes, "byteLength", {
    get() {
      calls++;
      throw new Error("getter");
    },
  });
  assert.ok(decode(bytes));
  assert.equal(calls, 0);
});

const limits = Object.freeze({
  maximumSessions: 2,
  maximumCallMilliseconds: 1000,
  maximumOperationMilliseconds: 5000,
  maximumLeaseMilliseconds: 1000,
  clockAllowanceMilliseconds: 0,
});
function call(context = Object.freeze({}), controller = new AbortController()) {
  return {
    context,
    requestRef: open.request_ref,
    recipientRef: "recipient/occ",
    deadline: new Date(Date.now() + 4000).toISOString(),
    signal: controller.signal,
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function rejectingTransport(overrides = {}) {
  const events = [];
  const transport = {
    async inspect() {
      events.push("inspect");
      return undefined;
    },
    async writeMetadata(bytes) {
      events.push(JSON.parse(new TextDecoder().decode(bytes)));
    },
    async close() {
      events.push("close");
    },
    ...overrides,
  };
  return { transport, events };
}
// This is a controlled transport observation for refusal/cancellation tests only.
// It supplies no protected origin, admitted Work, preparation, release or token.
function observed(call) {
  const configuration = { ...trust(), permittedRecipientRef: call.recipientRef };
  return {
    configuration,
    authenticatedAt: new Date(Date.now() - 100).toISOString(),
    expiresAt: new Date(Date.now() + 5000).toISOString(),
    peerEvidenceRef: "evidence/controlled",
    transportBinding: Object.freeze({}),
  };
}
function refusingOperations(prepare) {
  const unreachable = () => {
    throw new Error("Unexpected effectful owner call");
  };
  return {
    prepare,
    dispatch: unreachable,
    check: unreachable,
    writeRelease: unreachable,
    settle: unreachable,
  };
}

test("invalid metadata closes before transport inspection or operation use", async () => {
  const { transport, events } = rejectingTransport();
  const service = new GitHubMediationService({ transport, limits });
  await service.handle(json({ ...open, token: "canary" }), call());
  await service.join();
  assert.deepEqual(events, ["close"]);
});

test("each broker instance refuses the other protocol before any transport or Work lookup", async () => {
  for (const [protocolVersion, wrongRequest] of [
    [2, gitDiscovery],
    [3, open],
  ]) {
    const { transport, events } = rejectingTransport();
    const service = new GitHubMediationService({ transport, limits, protocolVersion });
    await service.handle(json(wrongRequest), call());
    await service.join();
    assert.deepEqual(events, ["close"]);
  }
});

test("Git service observation cannot replace the missing original Git Work and custody owner", async () => {
  const originalCall = call();
  const observation = observed(originalCall);
  const { transport, events } = rejectingTransport({
    async inspect(_call, hash) {
      assert.equal(hash, `sha256:${createHash("sha256").update(json(gitDiscovery)).digest("hex")}`);
      return observation;
    },
  });
  const service = new GitHubMediationService({ transport, limits, protocolVersion: 3 });
  await service.handle(json(gitDiscovery), originalCall);
  await service.join();
  assert.deepEqual(events, [
    { version: 3, sequence: 1, request_ref: open.request_ref, ok: false, code: "unavailable" },
    "close",
  ]);
});

test("Git request cancellation joins the original rejecting preparation and retires its context", async () => {
  const started = deferred();
  const originalCall = call();
  const observation = observed(originalCall);
  let preparations = 0;
  let aborted = false;
  const { transport } = rejectingTransport({
    async inspect() {
      return observation;
    },
  });
  const service = new GitHubMediationService({
    transport,
    limits,
    protocolVersion: 3,
    operations: refusingOperations(async (request, input) => {
      assert.equal(request.git_operation, "upload-pack");
      assert.equal(request.body_sha256, gitUpload.body_sha256);
      preparations++;
      started.resolve();
      await new Promise((resolve) =>
        input.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      return { kind: "refused", code: "unavailable" };
    }),
  });
  const handling = service.handle(json(gitUpload), originalCall);
  await started.promise;
  await service.close(originalCall);
  await handling;
  await service.join();
  await service.handle(json(gitUpload), originalCall);
  assert.equal(aborted, true);
  assert.equal(preparations, 1);
});

test("unrecognized transport context cannot reach any original operation", async () => {
  let prepared = 0;
  const { transport, events } = rejectingTransport();
  const service = new GitHubMediationService({
    transport,
    limits,
    operations: refusingOperations(async () => {
      prepared++;
      return { kind: "refused", code: "denied" };
    }),
  });
  await service.handle(json(open), call());
  await service.join();
  assert.equal(prepared, 0);
  assert.deepEqual(events, ["inspect", "close"]);
});

test("a service observation cannot replace the absent original Work/custody owner", async () => {
  const originalCall = call();
  const observation = observed(originalCall);
  const { transport, events } = rejectingTransport({
    async inspect(_call, hash) {
      assert.equal(hash, `sha256:${createHash("sha256").update(json(open)).digest("hex")}`);
      return observation;
    },
  });
  const service = new GitHubMediationService({ transport, limits });
  await service.handle(json(open), originalCall);
  await service.join();
  assert.deepEqual(events, [
    { version: 2, sequence: 1, request_ref: open.request_ref, ok: false, code: "unavailable" },
    "close",
  ]);
});

test("pending inspections consume finite capacity before any owner lookup", async () => {
  const started = deferred(),
    inspected = deferred();
  let calls = 0;
  const { transport, events } = rejectingTransport({
    async inspect() {
      calls++;
      started.resolve();
      return inspected.promise;
    },
  });
  const service = new GitHubMediationService({
    transport,
    limits: { ...limits, maximumSessions: 1 },
  });
  const first = service.handle(json(open), call());
  await started.promise;
  await service.handle(json(open), call());
  assert.equal(calls, 1);
  assert.deepEqual(events, ["close"]);
  inspected.resolve(undefined);
  await first;
  await service.join();
});

test("closing during original inspection propagates cancellation and joins it", async () => {
  const started = deferred();
  let aborted = false;
  const { transport } = rejectingTransport({
    async inspect(input) {
      started.resolve();
      await new Promise((resolve) =>
        input.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      return undefined;
    },
  });
  const service = new GitHubMediationService({ transport, limits });
  const originalCall = call();
  const handling = service.handle(json(open), originalCall);
  await started.promise;
  await service.close(originalCall);
  await handling;
  await service.join();
  assert.equal(aborted, true);
});

test("duplicate pending context aborts its original inspection without a second one", async () => {
  const started = deferred();
  let inspections = 0;
  const { transport } = rejectingTransport({
    async inspect(input) {
      inspections++;
      started.resolve();
      await new Promise((resolve) =>
        input.signal.addEventListener("abort", resolve, { once: true }),
      );
      return undefined;
    },
  });
  const service = new GitHubMediationService({ transport, limits });
  const originalCall = call();
  const first = service.handle(json(open), originalCall);
  await started.promise;
  await service.handle(json(open), originalCall);
  await first;
  await service.join();
  assert.equal(inspections, 1);
});

test("native closure reaches an in-flight rejecting preparation owner", async () => {
  const originalCall = call();
  const observation = observed(originalCall),
    started = deferred();
  let aborted = false;
  const { transport } = rejectingTransport({
    async inspect() {
      return observation;
    },
  });
  const operations = refusingOperations(async (_request, input) => {
    started.resolve();
    await new Promise((resolve) =>
      input.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      ),
    );
    return { kind: "refused", code: "unavailable" };
  });
  const service = new GitHubMediationService({ transport, operations, limits });
  const first = service.handle(json(open), originalCall);
  await started.promise;
  await service.close(originalCall);
  await first;
  await service.join();
  assert.equal(aborted, true);
});

test("synchronous cleanup failure stays constant-safe and cannot reject handling", async () => {
  const { transport } = rejectingTransport({
    close() {
      throw new Error("sensitive-canary");
    },
  });
  const service = new GitHubMediationService({ transport, limits });
  await service.handle(json(open), call());
  await service.join();
});

test("expired or malformed calls never inspect a peer", async () => {
  const { transport, events } = rejectingTransport();
  const service = new GitHubMediationService({ transport, limits });
  for (const input of [
    { ...call(), deadline: "2000-01-01T00:00:00.000Z" },
    { ...call(), recipientRef: "recipient/occ\n" },
    { ...call(), requestRef: open.request_ref + "\n" },
  ]) {
    await service.handle(json(open), input);
  }
  assert.deepEqual(events, ["close", "close", "close"]);
});

test("service requires finite positive configured operation and concurrency limits", () => {
  const { transport } = rejectingTransport();
  for (const patch of [
    { maximumSessions: 0 },
    { maximumCallMilliseconds: Infinity },
    { maximumLeaseMilliseconds: 6000 },
    { clockAllowanceMilliseconds: -1 },
    { maximumOperationMilliseconds: 0x80000000 },
  ]) {
    assert.throws(
      () => new GitHubMediationService({ transport, limits: { ...limits, ...patch } }),
      /^Error: GitHub mediation unavailable\.$/,
    );
  }
  assert.throws(
    () => new GitHubMediationService({ transport, limits, protocolVersion: 4 }),
    /^Error: GitHub mediation unavailable\.$/,
  );
});

test("an original refused context cannot reopen with a replacement transport binding", async () => {
  const originalCall = call();
  let preparations = 0;
  const { transport } = rejectingTransport({
    async inspect() {
      return observed(originalCall);
    },
  });
  const service = new GitHubMediationService({
    transport,
    limits,
    operations: refusingOperations(async () => {
      preparations++;
      return { kind: "refused", code: "denied" };
    }),
  });
  await service.handle(json(open), originalCall);
  await service.handle(json(open), originalCall);
  await service.join();
  assert.equal(preparations, 1);
});

test("clock continuity rejects rollback that remains later than the original wall instant", () => {
  // Pure clock samples exercise the actual arithmetic; no Work or release exists.
  const original = { wall: 10000, before: 100, after: 100.2 };
  assert.equal(
    githubMediationClockContinuous(original, { wall: 14000, before: 4100, after: 4100.2 }, 0),
    true,
  );
  assert.equal(
    githubMediationClockContinuous(original, { wall: 11000, before: 4100, after: 4100.2 }, 0),
    false,
  );
  assert.equal(
    githubMediationClockContinuous(original, { wall: 17000, before: 4100, after: 4100.2 }, 0),
    false,
  );
  assert.equal(
    githubMediationClockContinuous(original, { wall: 10000, before: 99, after: 99.2 }, 0),
    false,
  );
});

test("original monotonic horizon cannot move with delayed receipt or renewed wall timestamps", () => {
  const original = { wall: 10000, before: 100, after: 100.2 };
  const operation = githubMediationMonotonicDeadline(original, 15000, 0);
  assert.equal(operation, 5099);
  // At elapsed 5.2 seconds the wall clock has moved backwards by 3 seconds.
  // A new lease alone would be later; the original monotonic cap still expires.
  const later = { wall: 12200, before: 5300, after: 5300.2 };
  assert.equal(later.after >= operation, true);
  assert.equal(githubMediationClockContinuous(original, later, 0), false);
  assert.equal(githubMediationMonotonicDeadline(original, 15000, 0), operation);
  assert.equal(githubMediationMonotonicDeadline(original, 15000, 50), 5049);
});

test("clock correspondence accounts for bracketed sampling and millisecond quantization", () => {
  const original = { wall: 10000, before: 100, after: 100.6 };
  assert.equal(
    githubMediationClockContinuous(original, { wall: 10001, before: 100.9, after: 101.1 }, 0),
    true,
  );
  assert.equal(
    githubMediationClockContinuous(original, { wall: 10000, before: 100.7, after: 100.9 }, 0),
    true,
  );
  assert.equal(
    githubMediationClockContinuous(original, { wall: 10010, before: 105, after: 105.1 }, 5),
    true,
  );
  assert.equal(
    githubMediationClockContinuous(original, { wall: 10010, before: 105, after: 105.1 }, 0),
    false,
  );
  assert.equal(
    githubMediationClockContinuous(original, { wall: NaN, before: 105, after: 105.1 }, 0),
    false,
  );
  assert.equal(githubMediationMonotonicDeadline(original, 10000, 0), undefined);
  assert.equal(githubMediationMonotonicDeadline(original, Infinity, 0), undefined);
  for (let i = 0; i < 50; i++) {
    const first = sampleGitHubMediationClock();
    const second = sampleGitHubMediationClock();
    assert.equal(githubMediationClockContinuous(first, second, 0), true);
  }
});
