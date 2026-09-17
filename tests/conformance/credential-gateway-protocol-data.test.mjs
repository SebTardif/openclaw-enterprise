import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";

const entry = process.env.OCC_TEST_PROTOCOL_DATA_ENTRY
  ? pathToFileURL(process.env.OCC_TEST_PROTOCOL_DATA_ENTRY)
  : new URL("../../packages/occ/src/index.ts", import.meta.url);
const publicApi = await import(entry.href);
const {
  createGitHubFetchOperationV1: fetchData,
  createGitHubPrCreateOperationV1: prData,
  createGitHubMetadataOperationV1: metadataData,
} = publicApi;
const requestId = "11111111-1111-4111-8111-111111111111";
const clientId = "22222222-2222-4222-8222-222222222222";
const changedId = "33333333-3333-4333-8333-333333333333";
const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const fourHash = "9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0";

function repository() {
  return {
    repository: {
      upstreamInstanceId: "github.com",
      resourceSchema: {
        namespace: "github",
        name: "repository",
        version: 1,
        digest: "a".repeat(64),
      },
      canonicalResourceId: "42",
      canonicalPathSegments: ["openclaw", "example"],
    },
    appId: "7",
    installationId: "9",
    repositoryId: "42",
    canonicalOwner: "openclaw",
    canonicalName: "example",
    bindingGeneration: "1",
  };
}
function fetchInput(overrides = {}) {
  return {
    kind: "fetch",
    decodedBody: new Uint8Array(Buffer.from("0000")),
    encodedBodyBytes: 4,
    contentEncoding: "identity",
    framing: { kind: "content-length", bytes: 4 },
    expectContinue: false,
    ...overrides,
  };
}
function discovery(overrides = {}) {
  return fetchInput({
    kind: "fetch-discovery",
    decodedBody: new Uint8Array(),
    encodedBodyBytes: 0,
    framing: { kind: "none" },
    ...overrides,
  });
}
function prInput(overrides = {}) {
  return {
    title: 'Fix café "branch"',
    head: "topic/été",
    base: "main",
    body: 'Line one\nQuoted "text" and 雪',
    draft: false,
    maintainer_can_modify: false,
    ...overrides,
  };
}
function makeFetch(r = repository(), input = fetchInput(), id = requestId) {
  return fetchData(r, id, input);
}
function makePr(r = repository(), input = prInput(), id = requestId, client = clientId) {
  return prData(r, id, client, input);
}

test("curated public root exposes DATA constructors without a push authority factory", () => {
  assert.equal(typeof fetchData, "function");
  assert.equal(typeof prData, "function");
  assert.equal(Object.hasOwn(publicApi, "createGitHubPushOperationV1"), false);
});

test("independent fixed discovery, identity fetch and gzip-observation vectors", () => {
  // Fixed hashes were computed independently using Python hashlib and ordered UTF-8 arrays.
  const d = makeFetch(repository(), discovery());
  assert.ok(d);
  assert.equal(d.kind, "fetch-discovery");
  assert.equal(d.target.host, "github.com");
  assert.equal(d.target.method, "GET");
  assert.equal(d.target.pathAndQuery, "/openclaw/example.git/info/refs?service=git-upload-pack");
  assert.equal(d.bodyDigest, emptyHash);
  assert.equal(d.factsDigest, "2f5ea301a9631164873d67bb9c56dce4ef7761a448a51da29882b2127ccc6fcb");
  const f = makeFetch();
  assert.ok(f);
  assert.equal(f.kind, "fetch");
  assert.equal(f.target.method, "POST");
  assert.equal(f.target.pathAndQuery, "/openclaw/example.git/git-upload-pack");
  assert.equal(f.bodyDigest, fourHash);
  assert.equal(f.factsDigest, "69aacf96b8ff485248d7cbfe3001eac922c0d46aad534db6239b25b9bd7d03a3");
  const gzip = makeFetch(
    repository(),
    fetchInput({
      encodedBodyBytes: 24,
      contentEncoding: "gzip",
      framing: { kind: "chunked" },
      expectContinue: true,
    }),
  );
  assert.ok(gzip);
  assert.equal(gzip.bodyDigest, fourHash);
  assert.equal(
    gzip.factsDigest,
    "86b1cf42056e4b14bae894067e93af90d55175c14af4c29fd929b63a20d3ed45",
  );
  assert.deepEqual(Object.keys(f).sort(), [
    "bodyDigest",
    "factsDigest",
    "kind",
    "requestId",
    "target",
  ]);
  // DATA deliberately accepts these bytes; it cannot attest gzip or Git packet grammar.
  assert.ok(makeFetch(repository(), fetchInput({ decodedBody: new Uint8Array([1, 2, 3, 4]) })));
});

test("154-byte canonical PR vector and stable creation identity across request/client changes", () => {
  const result = makePr();
  assert.ok(result);
  const expected =
    '{"title":"Fix café \\"branch\\"","head":"topic/été","base":"main","body":"Line one\\nQuoted \\"text\\" and 雪","draft":false,"maintainer_can_modify":false}';
  assert.equal(result.canonicalJson, expected);
  assert.equal(Buffer.byteLength(result.canonicalJson, "utf8"), 154);
  assert.equal(
    result.operation.bodyDigest,
    "2f64b6b34e5f34c38923f45f04ca619492238faa819e85789481c8df5c291fb8",
  );
  assert.equal(
    result.operation.creationDigest,
    "c4a81f6050f2effc205f6f8fe0ae1e72ea7c852835d6df2d4f423c59a6f89f24",
  );
  assert.equal(
    result.operation.factsDigest,
    "e49d9915acda3c9a0a972eb51b0b3649a812e18b5de6eb1953a9eacaa95642f7",
  );
  const changedRequest = makePr(repository(), prInput(), changedId);
  assert.equal(
    changedRequest.operation.factsDigest,
    "1a36554c2cc43bb4220afc35f83e4cb447fbfbb8a91b081fb3fe67bcc36df439",
  );
  const changedClient = makePr(repository(), prInput(), requestId, changedId);
  for (const candidate of [changedRequest, changedClient]) {
    assert.equal(candidate.canonicalJson, expected);
    assert.equal(candidate.operation.bodyDigest, result.operation.bodyDigest);
    assert.equal(candidate.operation.creationDigest, result.operation.creationDigest);
    assert.notEqual(candidate.operation.factsDigest, result.operation.factsDigest);
  }
  assert.equal(result.operation.target.host, "api.github.com");
  assert.equal(result.operation.target.method, "POST");
  assert.equal(result.operation.target.pathAndQuery, "/repos/openclaw/example/pulls");
  assert.equal(result.operation.apiVersion, "2026-03-10");
  const reversed = Object.fromEntries(Object.entries(prInput()).reverse());
  assert.deepEqual(makePr(repository(), reversed), result);
});

const repositoryChanges = [
  { appId: "8" },
  { installationId: "10" },
  { repositoryId: "43" },
  { canonicalOwner: "Other", "repository.canonicalPathSegments.0": "Other" },
  { canonicalName: "Other", "repository.canonicalPathSegments.1": "Other" },
  { bindingGeneration: "2" },
  { "repository.upstreamInstanceId": "github-2" },
  { "repository.canonicalResourceId": "opaque-other" },
  { "repository.resourceSchema.namespace": "other" },
  { "repository.resourceSchema.name": "other" },
  { "repository.resourceSchema.version": 2 },
  { "repository.resourceSchema.digest": "b".repeat(64) },
];

test("every adopted repository and schema field participates in original request facts", () => {
  const initialFetch = makeFetch();
  const initialPr = makePr();
  for (const changes of repositoryChanges) {
    const r = repository();
    for (const [path, value] of Object.entries(changes)) setPath(r, path.split("."), value);
    const f = makeFetch(r);
    const p = makePr(r);
    assert.ok(f);
    assert.ok(p);
    assert.notEqual(f.factsDigest, initialFetch.factsDigest);
    assert.notEqual(p.operation.factsDigest, initialPr.operation.factsDigest);
    assert.equal(f.bodyDigest, initialFetch.bodyDigest);
    assert.equal(p.operation.bodyDigest, initialPr.operation.bodyDigest);
  }
  assert.notEqual(
    makeFetch(repository(), fetchInput(), changedId).factsDigest,
    initialFetch.factsDigest,
  );
  for (const changes of [
    { framing: { kind: "chunked" } },
    { expectContinue: true },
    { contentEncoding: "gzip" },
    { contentEncoding: "gzip", encodedBodyBytes: 5, framing: { kind: "content-length", bytes: 5 } },
    { decodedBody: new Uint8Array([1, 2, 3, 4]) },
    { decodedBody: new Uint8Array([1, 2, 3]), contentEncoding: "gzip" },
  ]) {
    const candidate = makeFetch(repository(), fetchInput(changes));
    assert.ok(candidate);
    assert.notEqual(candidate.factsDigest, initialFetch.factsDigest);
  }
  for (const changes of [
    { title: "Other" },
    { head: "topic/other" },
    { base: "trunk" },
    { body: "Other" },
    { draft: true },
  ]) {
    const p = makePr(repository(), prInput(changes));
    assert.ok(p);
    assert.notEqual(p.operation.bodyDigest, initialPr.operation.bodyDigest);
    assert.notEqual(p.operation.creationDigest, initialPr.operation.creationDigest);
    assert.notEqual(p.operation.factsDigest, initialPr.operation.factsDigest);
  }
});

function bothRefuse(r) {
  assert.equal(fetchData(r, requestId, fetchInput()), null);
  assert.equal(prData(r, requestId, clientId, prInput()), null);
}
function setPath(value, path, replacement) {
  const parent = path.slice(0, -1).reduce((current, name) => current[name], value);
  parent[path.at(-1)] = replacement;
}
const resourcePaths = [
  ["bindingGeneration"],
  ["repository", "upstreamInstanceId"],
  ["repository", "canonicalResourceId"],
  ...["namespace", "name", "digest"].map((k) => ["repository", "resourceSchema", k]),
];

test("canonical decimal, locator and schema domains enforce exact adopted boundaries", () => {
  for (const key of ["appId", "installationId", "repositoryId"]) {
    for (const value of [
      null,
      1,
      "",
      "0",
      "01",
      "+1",
      "-1",
      "1e2",
      "1.0",
      " 1",
      "1 ",
      "1\n",
      "9".repeat(33),
    ])
      bothRefuse({ ...repository(), [key]: value });
    for (const value of ["1", "9007199254740992", "9".repeat(32)]) {
      const r = { ...repository(), [key]: value };
      assert.equal(makeFetch(r).target.repository[key], value);
      assert.equal(makePr(r).operation.target.repository[key], value);
    }
  }
  for (const [key, limit] of [
    ["canonicalOwner", 39],
    ["canonicalName", 100],
  ]) {
    for (const value of [
      "",
      ".",
      "..",
      "a/b",
      "a b",
      "a?b",
      "a%b",
      "é",
      "x".repeat(limit + 1),
      "name\n",
      null,
    ]) {
      const r = repository();
      r[key] = value;
      r.repository.canonicalPathSegments[key === "canonicalOwner" ? 0 : 1] = value;
      bothRefuse(r);
    }
    const r = repository();
    r[key] = "x".repeat(limit);
    r.repository.canonicalPathSegments[key === "canonicalOwner" ? 0 : 1] = r[key];
    assert.ok(makeFetch(r));
    assert.ok(makePr(r));
  }
  bothRefuse({ ...repository(), canonicalOwner: "with_dot" });
  for (const path of resourcePaths) {
    for (const value of ["", "x".repeat(1025), "x\u0000", "x\u001f", "x\u007f", 1, null]) {
      const r = repository();
      setPath(r, path, value);
      bothRefuse(r);
    }
    const r = repository();
    setPath(r, path, "x".repeat(1024));
    assert.ok(makePr(r));
    if (path.at(-1) !== "digest") assert.ok(makeFetch(r));
  }
  for (const digest of ["schema-digest", "A".repeat(64), "a".repeat(63), "a".repeat(65)]) {
    const r = repository();
    r.repository.resourceSchema.digest = digest;
    assert.equal(makeFetch(r), null);
    assert.ok(makePr(r));
  }
  for (const version of [0, -1, 1.5, NaN, Infinity, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
    const r = repository();
    r.repository.resourceSchema.version = version;
    bothRefuse(r);
  }
  const r = repository();
  r.repository.resourceSchema.version = Number.MAX_SAFE_INTEGER;
  assert.ok(makeFetch(r));
  assert.ok(makePr(r));
  for (const segments of [
    [],
    ["openclaw"],
    ["openclaw", "example", "third"],
    ["Other", "example"],
    ["openclaw", "Other"],
    null,
    "openclaw/example",
  ]) {
    const r = repository();
    r.repository.canonicalPathSegments = segments;
    bothRefuse(r);
  }
  for (const value of [null, undefined, 1, "x", {}, []]) bothRefuse(value);
  for (const value of [null, undefined, 1, "x", {}]) {
    bothRefuse({ ...repository(), repository: value });
    const r = repository();
    r.repository.resourceSchema = value;
    bothRefuse(r);
  }
  // Metadata remains safe-integer based, rather than inheriting the new DATA domain.
  const metadata = repository();
  metadata.repositoryId = "9007199254740992";
  assert.equal(metadataData(metadata, requestId), null);
  assert.ok(makeFetch(metadata));
  assert.ok(makePr(metadata));
});

test("raw identities reject noncanonical UUID versions, variants, case and suffixes", () => {
  assert.equal(fetchData(repository(), undefined, fetchInput()), null);
  assert.equal(prData(repository(), undefined, clientId, prInput()), null);
  assert.equal(prData(repository(), requestId, undefined, prInput()), null);
  for (const value of [
    null,
    1,
    {},
    "",
    "candidate",
    requestId + "\n",
    requestId.replace("4111", "3111"),
    requestId.replace("8111", "7111"),
  ]) {
    assert.equal(makeFetch(repository(), fetchInput(), value), null);
    assert.equal(makePr(repository(), prInput(), value), null);
    assert.equal(makePr(repository(), prInput(), requestId, value), null);
  }
  // Decimal-only UUID text has no letters to uppercase; use a canonical letter-bearing vector.
  const letterId = "0d2e45d2-b6cc-41e9-b5fa-14fc0767dac9";
  assert.equal(makeFetch(repository(), fetchInput(), letterId.toUpperCase()), null);
  assert.equal(makePr(repository(), prInput(), requestId, letterId.toUpperCase()), null);
});

test("fetch counts, identity correspondence, framing and discovery restrictions are bounded", () => {
  for (const value of [-1, 1.5, NaN, Infinity, "4", null, 1048577, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(makeFetch(repository(), fetchInput({ encodedBodyBytes: value })), null);
  for (const framing of [
    null,
    {},
    { kind: "none" },
    { kind: "other" },
    { kind: "content-length", bytes: 3 },
    { kind: "content-length", bytes: 4.5 },
  ])
    assert.equal(makeFetch(repository(), fetchInput({ framing })), null);
  for (const changes of [
    { kind: "metadata" },
    { contentEncoding: "br" },
    { expectContinue: 1 },
    { decodedBody: new Uint8Array() },
    { encodedBodyBytes: 3, framing: { kind: "chunked" } },
  ])
    assert.equal(makeFetch(repository(), fetchInput(changes)), null);
  for (const changes of [
    { decodedBody: new Uint8Array([1]) },
    { encodedBodyBytes: 1 },
    { contentEncoding: "gzip" },
    { expectContinue: true },
    { framing: { kind: "chunked" } },
    { framing: { kind: "content-length", bytes: 1 } },
  ])
    assert.equal(makeFetch(repository(), discovery(changes)), null);
  assert.ok(makeFetch(repository(), discovery({ framing: { kind: "content-length", bytes: 0 } })));
  const maximum = new Uint8Array(1048576);
  assert.ok(
    makeFetch(
      repository(),
      fetchInput({
        decodedBody: maximum,
        encodedBodyBytes: maximum.byteLength,
        framing: { kind: "content-length", bytes: maximum.byteLength },
      }),
    ),
  );
  assert.equal(
    makeFetch(
      repository(),
      fetchInput({
        decodedBody: new Uint8Array(1048577),
        encodedBodyBytes: 1,
        contentEncoding: "gzip",
        framing: { kind: "chunked" },
      }),
    ),
    null,
  );
  assert.ok(
    makeFetch(
      repository(),
      fetchInput({
        encodedBodyBytes: 1048576,
        contentEncoding: "gzip",
        framing: { kind: "chunked" },
      }),
    ),
  );
  assert.ok(
    makeFetch(
      repository(),
      fetchInput({ encodedBodyBytes: 0, contentEncoding: "gzip", framing: { kind: "chunked" } }),
    ),
  );
});

test("byte capture invokes native storage accessors and owns bytes before repository getters", () => {
  const bytes = new Uint8Array(Buffer.from("0000"));
  for (const name of ["buffer", "byteOffset", "byteLength", "slice", "subarray", "set"])
    Object.defineProperty(bytes, name, {
      get() {
        throw new Error("caller byte hook");
      },
    });
  Object.defineProperty(bytes, Symbol.iterator, {
    get() {
      throw new Error("caller iteration");
    },
  });
  const r = repository();
  Object.defineProperty(r, "appId", {
    get() {
      bytes[0] = 65;
      return "7";
    },
  });
  const result = makeFetch(r, fetchInput({ decodedBody: bytes }));
  assert.ok(result);
  assert.equal(result.bodyDigest, fourHash);
  bytes.fill(66);
  assert.equal(result.bodyDigest, fourHash);
  assert.ok(makeFetch(repository(), fetchInput({ decodedBody: Buffer.from("0000") })));
  const offset = new Uint8Array([9, 48, 48, 48, 48, 9]).subarray(1, 5);
  assert.equal(makeFetch(repository(), fetchInput({ decodedBody: offset })).bodyDigest, fourHash);
  const foreign = runInNewContext("new Uint8Array([48,48,48,48])");
  assert.equal(makeFetch(repository(), fetchInput({ decodedBody: foreign })).bodyDigest, fourHash);
});

test("non-native, proxy, shared, resizable and detached byte storage fails closed", () => {
  const detached = new Uint8Array(4);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  const revocable = Proxy.revocable(new Uint8Array(4), {});
  revocable.revoke();
  for (const value of [
    null,
    [],
    { byteLength: 4 },
    new Uint16Array(2),
    new DataView(new ArrayBuffer(4)),
    Object.create(Uint8Array.prototype),
    new Proxy(new Uint8Array(4), {}),
    revocable.proxy,
    new Uint8Array(new SharedArrayBuffer(4)),
    new Uint8Array(new ArrayBuffer(4, { maxByteLength: 8 })),
    detached,
  ])
    assert.equal(makeFetch(repository(), fetchInput({ decodedBody: value })), null);
  const zeroDetached = new Uint8Array();
  structuredClone(zeroDetached.buffer, { transfer: [zeroDetached.buffer] });
  assert.equal(makeFetch(repository(), discovery({ decodedBody: zeroDetached })), null);
});

test("PR normalized fields preserve scalar Unicode and exact syntax/UTF-8 limits", () => {
  for (const field of ["title", "head", "base", "body"]) {
    for (const value of [null, 1, {}, "\ud800", "\udc00", "x\ud800x"])
      assert.equal(makePr(repository(), prInput({ [field]: value })), null);
    assert.ok(makePr(repository(), prInput({ [field]: field === "body" ? "😀" : "topic😀" })));
  }
  for (const title of ["", "a\r", "a\n", "a\0", "a".repeat(257), "é".repeat(129)])
    assert.equal(makePr(repository(), prInput({ title })), null);
  for (const title of ["a".repeat(256), "é".repeat(128)])
    assert.ok(makePr(repository(), prInput({ title })));
  for (const value of [
    "",
    "@",
    "-topic",
    "refs/heads/topic",
    "owner:topic",
    "https://github.com/o/r",
    "x..y",
    "x@{y",
    "topic.",
    ".topic",
    "a/.hidden",
    "topic.lock",
    "a/topic.lock",
    "a//b",
    "/topic",
    "topic/",
    "topic~1",
    "topic^",
    "topic?",
    "topic*",
    "topic[",
    "topic\\x",
    "topic name",
    "topic\t",
    "topic\u007f",
    "a".repeat(40),
    "b".repeat(64),
    "x".repeat(1025),
  ]) {
    assert.equal(makePr(repository(), prInput({ head: value })), null, value);
    assert.equal(makePr(repository(), prInput({ base: value })), null, value);
  }
  assert.equal(makePr(repository(), prInput({ head: "main" })), null);
  for (const field of ["head", "base"]) {
    assert.ok(makePr(repository(), prInput({ [field]: "x".repeat(1024) })));
    assert.ok(makePr(repository(), prInput({ [field]: "é".repeat(512) })));
    assert.equal(makePr(repository(), prInput({ [field]: "é".repeat(513) })), null);
  }
  assert.ok(makePr(repository(), prInput({ body: "x".repeat(61440) })));
  assert.equal(makePr(repository(), prInput({ body: "x".repeat(61441) })), null);
  for (const value of [undefined, null, 0, "false"])
    assert.equal(makePr(repository(), prInput({ draft: value })), null);
  for (const value of [undefined, null, true, 0])
    assert.equal(makePr(repository(), prInput({ maintainer_can_modify: value })), null);
  const missingBody = prInput();
  delete missingBody.body;
  assert.equal(makePr(repository(), missingBody), null);
  const composed = makePr(repository(), prInput({ title: "café" }));
  const decomposed = makePr(repository(), prInput({ title: "cafe\u0301" }));
  assert.notEqual(composed.operation.bodyDigest, decomposed.operation.bodyDigest);
  assert.equal(composed.operation.input.title, "café");
  assert.equal(decomposed.operation.input.title, "cafe\u0301");
});

test("PR escaping enforces the adjacent 64 KiB canonical JSON boundary", () => {
  const input = prInput({ title: "t", head: "h", base: "b", body: "" });
  const overhead = Buffer.byteLength(makePr(repository(), input).canonicalJson);
  const slack = 65536 - overhead;
  const body = "\u0001".repeat(Math.floor(slack / 6)) + "x".repeat(slack % 6);
  const maximum = makePr(repository(), { ...input, body });
  assert.ok(maximum);
  assert.equal(Buffer.byteLength(maximum.canonicalJson), 65536);
  assert.equal(makePr(repository(), { ...input, body: body + "x" }), null);
});

function counted(value, counts, prefix = "") {
  if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) return value;
  const target = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) {
    const child = counted(value[key], counts, prefix + key + ".");
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get() {
        const path = prefix + key;
        counts.set(path, (counts.get(path) ?? 0) + 1);
        assert.equal(counts.get(path), 1, "repeated read: " + path);
        return child;
      },
    });
  }
  if (!Array.isArray(value)) return target;
  return new Proxy(target, {
    get(array, key, receiver) {
      if (key === "length") {
        const path = prefix + "length";
        counts.set(path, (counts.get(path) ?? 0) + 1);
        assert.equal(counts.get(path), 1);
      }
      return Reflect.get(array, key, receiver);
    },
  });
}

test("repository, framing and normalized caller fields are each read once", () => {
  const prCounts = new Map();
  const inputCounts = new Map();
  assert.ok(makePr(counted(repository(), prCounts), counted(prInput(), inputCounts)));
  assert.equal(prCounts.size, 18);
  assert.equal(inputCounts.size, 6);
  for (const n of [...prCounts.values(), ...inputCounts.values()]) assert.equal(n, 1);
  const counts = new Map();
  const r = counted(repository(), counts, "repository.");
  const input = counted(fetchInput(), counts, "input.");
  assert.ok(makeFetch(r, input));
  assert.equal(counts.size, 26);
  for (const n of counts.values()) assert.equal(n, 1);
});

const repositoryGetterPaths = [
  ...[
    "appId",
    "installationId",
    "repositoryId",
    "canonicalOwner",
    "canonicalName",
    "bindingGeneration",
    "repository",
  ].map((k) => [k]),
  ...["upstreamInstanceId", "canonicalResourceId", "resourceSchema", "canonicalPathSegments"].map(
    (k) => ["repository", k],
  ),
  ...["namespace", "name", "version", "digest"].map((k) => ["repository", "resourceSchema", k]),
  ...["0", "1"].map((k) => ["repository", "canonicalPathSegments", k]),
];
function throwing(value, path) {
  const parent = path.slice(0, -1).reduce((current, key) => current[key], value);
  Object.defineProperty(parent, path.at(-1), {
    get() {
      throw new Error("hostile operand");
    },
  });
}

test("every retained operand's throwing getter returns null without escaping", () => {
  for (const path of repositoryGetterPaths) {
    const r = repository();
    throwing(r, path);
    bothRefuse(r);
  }
  for (const [createInput, invoke] of [
    [fetchInput, (i) => makeFetch(repository(), i)],
    [prInput, (i) => makePr(repository(), i)],
  ])
    for (const key of Object.keys(createInput())) {
      const input = createInput();
      throwing(input, [key]);
      assert.equal(invoke(input), null, key);
    }
  for (const key of ["kind", "bytes"]) {
    const i = fetchInput();
    throwing(i.framing, [key]);
    assert.equal(makeFetch(repository(), i), null);
  }
  const r = repository();
  r.repository.canonicalPathSegments = new Proxy(r.repository.canonicalPathSegments, {
    get(target, key, receiver) {
      if (key === "length") throw new Error("length");
      return Reflect.get(target, key, receiver);
    },
  });
  bothRefuse(r);
  const revoked = Proxy.revocable(repository(), {});
  revoked.revoke();
  bothRefuse(revoked.proxy);
});

function assertFrozenTree(value) {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const key of Object.keys(value)) {
    assert.throws(() => {
      value[key] = "changed";
    }, TypeError);
    assertFrozenTree(value[key]);
  }
  assert.throws(() => {
    value.extra = true;
  }, TypeError);
  assert.throws(() => Object.setPrototypeOf(value, {}), TypeError);
}

test("owned snapshots ignore later mutation, arbitrary toJSON and reentrant construction", () => {
  for (const [invoke, createInput, isFetch] of [
    [makeFetch, fetchInput, true],
    [makePr, prInput, false],
  ]) {
    const r = repository();
    const input = createInput();
    for (const object of [
      r,
      r.repository,
      r.repository.resourceSchema,
      r.repository.canonicalPathSegments,
      input,
    ])
      Object.defineProperty(object, "toJSON", {
        get() {
          throw new Error("arbitrary serialization");
        },
      });
    const result = invoke(r, input);
    assert.ok(result);
    const encoded = JSON.stringify(result);
    r.repositoryId = "999";
    r.repository.canonicalPathSegments[0] = "changed";
    r.repository.resourceSchema.digest = "c".repeat(64);
    if (isFetch) input.decodedBody.fill(65);
    else input.title = "changed";
    assert.equal(JSON.stringify(result), encoded);
    assertFrozenTree(result);
  }
  const r = repository();
  const input = prInput();
  let nested;
  Object.defineProperty(input, "title", {
    get() {
      nested = makePr({ ...repository(), repositoryId: "43" }, prInput({ title: "Nested" }));
      return 'Fix café "branch"';
    },
  });
  const outer = makePr(r, input);
  assert.ok(outer);
  assert.ok(nested);
  assert.equal(outer.operation.target.repository.repositoryId, "42");
  assert.equal(nested.operation.target.repository.repositoryId, "43");
  assert.notEqual(outer.operation.factsDigest, nested.operation.factsDigest);
  const mutable = prInput();
  const resource = repository();
  Object.defineProperty(resource.repository.resourceSchema, "digest", {
    get() {
      mutable.title = "changed";
      resource.appId = "999";
      return "a".repeat(64);
    },
  });
  const captured = makePr(resource, mutable);
  assert.equal(captured.operation.input.title, 'Fix café "branch"');
  assert.equal(captured.operation.target.repository.appId, "7");
  const fetchRepository = repository();
  let nestedFetch;
  Object.defineProperty(fetchRepository, "appId", {
    get() {
      nestedFetch = makeFetch({ ...repository(), repositoryId: "43" });
      return "7";
    },
  });
  const outerFetch = makeFetch(fetchRepository);
  assert.ok(outerFetch);
  assert.ok(nestedFetch);
  assert.equal(outerFetch.target.repository.repositoryId, "42");
  assert.equal(nestedFetch.target.repository.repositoryId, "43");
  assert.notEqual(outerFetch.factsDigest, nestedFetch.factsDigest);
  assert.equal(makePr(resource, prInput()).operation.target.repository.appId, "999");
});

test("malformed top-level inputs fail closed for both constructors", () => {
  for (const input of [null, undefined, 1, "", {}, []]) {
    assert.equal(fetchData(repository(), requestId, input), null);
    assert.equal(prData(repository(), requestId, clientId, input), null);
  }
});
