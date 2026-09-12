import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { GitObjectStore } from "../../packages/occ/src/git-object-store/store.ts";
import { GitObjectStoreError } from "../../packages/occ/src/git-object-store/contract.ts";

// Real Git creates the fixture objects and imports the resulting pack.
// Tests use local repositories and never check out or execute project files.
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const selectionKeys = [
  "OCE_GIT_STORE_TEST_GIT_PATH",
  "OCE_GIT_STORE_TEST_GIT_SHA256",
  "OCE_GIT_STORE_TEST_GIT_OWNER_UID",
];
function selectedFixture() {
  const values = selectionKeys.map((key) => process.env[key]);
  if (values.every((value) => value === undefined)) return undefined;
  assert.ok(
    values.every((value) => typeof value === "string" && value.length > 0),
    "Partial Git store fixture selection is unavailable; select all three settings",
  );
  const [path, sha256, owner] = values;
  assert.ok(isAbsolute(path), "The selected Git executable must have an absolute path");
  assert.match(sha256, /^[0-9a-f]{64}(?![\s\S])/);
  assert.match(owner, /^(?:0|[1-9][0-9]*)(?![\s\S])/);
  const ownerUid = Number(owner);
  assert.ok(Number.isSafeInteger(ownerUid) && ownerUid <= 0xffffffff);
  return Object.freeze({ path, sha256, ownerUid });
}
const selected = selectedFixture();
const gitTest = (name, options, body) =>
  test(
    name,
    {
      ...options,
      concurrency: false,
      skip:
        selected === undefined
          ? `Git interoperability unavailable: explicitly select ${selectionKeys.join(", ")}`
          : false,
    },
    body,
  );
async function gitFixture(t) {
  assert.ok(selected);
  const executableStat = lstatSync(selected.path);
  assert.equal(executableStat.uid, selected.ownerUid);
  assert.equal(executableStat.isFile(), true);
  assert.equal(sha256(await readFile(selected.path)), selected.sha256);
  const directory = await mkdtemp(join(homedir(), ".git-object-store-"));
  const owners = [];
  t.after(async () => {
    try {
      for (const store of owners) await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  const empty = join(directory, "empty");
  const repository = join(directory, "objects.git");
  await mkdir(empty, { mode: 0o700 });
  // Deliberately omit inherited environment, Git configuration, identities and
  // object paths. These fixed test identities carry no service authority.
  const env = {
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_COUNT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Object fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Object fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  const run = (args, input) => {
    return execFileSync(
      selected.path,
      ["-c", `core.hooksPath=${empty}`, "-c", "gc.auto=0", ...args],
      {
        cwd: directory,
        env,
        input,
        timeout: 5000,
        maxBuffer: 512 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  };
  run(["init", "--bare", "--object-format=sha1", `--template=${empty}`, repository]);
  const git = (args, input) => run([`--git-dir=${repository}`, ...args], input);
  const records = new Map();
  const retain = (type, oid) => {
    const bytes = git(["cat-file", type, oid]);
    const record = { oid, type, bytes };
    records.set(oid, record);
    return record;
  };
  const blob = (bytes) =>
    retain(
      "blob",
      git(["hash-object", "-w", "--no-filters", "-t", "blob", "--stdin"], bytes).toString().trim(),
    );
  const tree = (entries = []) => {
    const input = Buffer.concat(
      entries.map(({ mode, name, object }) =>
        Buffer.from(`${mode} ${object.type} ${object.oid}\t${name}\0`),
      ),
    );
    return retain("tree", git(["mktree", "-z"], input).toString().trim());
  };
  const commit = (root, parents = []) =>
    retain(
      "commit",
      git(
        ["commit-tree", root.oid, ...parents.flatMap((parent) => ["-p", parent.oid])],
        Buffer.from("Object fixture\n"),
      )
        .toString()
        .trim(),
    );
  return { directory, repository, empty, owners, run, git, records, blob, tree, commit };
}

const limits = {
  maxObjects: 256,
  maxObjectBytes: 131072,
  maxRawBytes: 262144,
  maxPackBytes: 524288,
  maxTreeDepth: 16,
  maxPathBytes: 256,
  maxExpandedPaths: 4096,
  captureTimeoutMs: 5000,
};
const signal = () => new AbortController().signal;
function request(proposed, base = proposed, expected = { kind: "create" }) {
  return {
    baseOid: base.oid,
    expectedTarget: expected,
    proposedOid: proposed.oid,
  };
}
function rawObject(type, bytes) {
  const copy = Buffer.from(bytes);
  return {
    type,
    bytes: copy,
    oid: createHash("sha1").update(`${type} ${copy.length}\0`).update(copy).digest("hex"),
  };
}
function rawTree(entries) {
  return rawObject(
    "tree",
    Buffer.concat(
      entries.map(({ mode = "100644", name, object }) =>
        Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(object.oid, "hex")]),
      ),
    ),
  );
}
function rawCommit(tree, parents = [], suffix = "fixture\n") {
  return rawObject(
    "commit",
    Buffer.from(
      `tree ${tree.oid}\n${parents.map((p) => `parent ${p.oid}\n`).join("")}author Object fixture <fixture@example.invalid> 946684800 +0000\ncommitter Object fixture <fixture@example.invalid> 946684800 +0000\n\n${suffix}`,
    ),
  );
}
async function owner(t, fixture, overrides = {}, suffix = "store") {
  const directory = join(fixture.directory, suffix);
  await mkdir(directory, { mode: 0o700 });
  const options = {
    directory,
    ownerUid: process.getuid(),
    durability: "persistent-posix",
    gitExecutable: { path: selected.path, sha256: selected.sha256, ownerUid: selected.ownerUid },
    limits: { ...limits, ...overrides },
  };
  const store = await GitObjectStore.open(options);
  fixture.owners.push(store);
  return { store, options };
}
async function importPack(f, pack, root, records) {
  const destination = join(f.directory, "import.git");
  f.run(["init", "--bare", "--object-format=sha1", `--template=${f.empty}`, destination]);
  const git = (args, input) => f.run([`--git-dir=${destination}`, ...args], input);
  git(["index-pack", "--strict", "--stdin"], Buffer.from(pack));
  git(["fsck", "--strict", "--no-reflogs", root.oid]);
  const actualIds = git(["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
  assert.deepEqual(actualIds, records.map((record) => record.oid).sort());
  for (const record of records)
    assert.deepEqual(git(["cat-file", record.type, record.oid]), record.bytes);
}

gitTest(
  "real root commit and empty tree roundtrip through retained PACK and strict Git inspection",
  { timeout: 15000 },
  async (t) => {
    const f = await gitFixture(t),
      tree = f.tree(),
      root = f.commit(tree);
    const { store } = await owner(t, f),
      req = request(root),
      records = [...f.records.values()];
    const captured = await store.capture(req, records, signal());
    const graph = store.inspect(captured),
      pack = Buffer.from(await store.readPack(captured));
    assert.equal(graph.objectFormat, "sha1");
    assert.equal(graph.objectCount, records.length);
    assert.equal(
      graph.rawBytes,
      records.reduce((n, record) => n + record.bytes.length, 0),
    );
    assert.equal(graph.proposedOid, root.oid);
    assert.equal(graph.packSha256, `sha256:${sha256(pack)}`);
    assert.equal(graph.packBytes, pack.length);
    assert.equal(pack.subarray(0, 4).toString(), "PACK");
    assert.equal(pack.readUInt32BE(4), 2);
    assert.equal(pack.readUInt32BE(8), records.length);
    assert.deepEqual(pack.subarray(-20), createHash("sha1").update(pack.subarray(0, -20)).digest());
    await importPack(f, pack, root, records);
  },
);

gitTest(
  "merge ancestry, shared trees and executable files form one complete exact Git graph",
  { timeout: 15000 },
  async (t) => {
    const f = await gitFixture(t),
      content = f.blob(Buffer.from("binary\0content\n"));
    const child = f.tree([{ mode: "100755", name: "run", object: content }]);
    const rootTree = f.tree([
      { mode: "040000", name: "left", object: child },
      { mode: "040000", name: "right", object: child },
    ]);
    const base = f.commit(rootTree),
      left = f.commit(rootTree, [base]);
    const rightTree = f.tree([{ mode: "100644", name: "file", object: content }]);
    const right = f.commit(rightTree, [base]),
      merged = f.commit(rootTree, [left, right]);
    const req = request(merged, base, { kind: "existing", oid: base.oid });
    const { store } = await owner(t, f),
      records = [...f.records.values()];
    const captured = await store.capture(req, records, signal());
    await importPack(f, await store.readPack(captured), merged, records);
  },
);

gitTest(
  "binary blobs across PACK length boundaries preserve exact bytes and order-independent graph identity",
  { timeout: 15000 },
  async (t) => {
    const f = await gitFixture(t),
      blobs = [15, 16, 2047, 2048].map((length) =>
        f.blob(Buffer.from(Array.from({ length }, (_, i) => (i * 73 + length) % 256))),
      );
    const tree = f.tree(blobs.map((object, i) => ({ mode: "100644", name: `file-${i}`, object }))),
      root = f.commit(tree);
    const records = [...f.records.values()],
      req = request(root),
      { store } = await owner(t, f);
    const first = await store.capture(req, records, signal());
    const second = await store.capture(req, [...records].reverse(), signal());
    assert.equal(store.inspect(first).graphDigest, store.inspect(second).graphDigest);
    await importPack(f, await store.readPack(first), root, records);
  },
);

gitTest(
  "capture supports concurrent saves and reopens immutable bytes after interrupted writes",
  { timeout: 15000 },
  async (t) => {
    const f = await gitFixture(t),
      blob = f.blob(Buffer.from("approved bytes\n"));
    const tree = f.tree([{ mode: "100644", name: "file", object: blob }]),
      root = f.commit(tree);
    const records = [...f.records.values()],
      req = request(root),
      original = structuredClone(req);
    const { store, options } = await owner(t, f);
    // Independent requests can retain the same object graph concurrently.
    // Every caller must receive a readable capture, even during link publication.
    const simultaneous = await Promise.all(
      Array.from({ length: 16 }, () => store.capture(req, records, signal())),
    );
    const simultaneousPacks = await Promise.all(simultaneous.map((c) => store.readPack(c)));
    for (const pack of simultaneousPacks) assert.deepEqual(pack, simultaneousPacks[0]);
    const captured = await store.capture(req, records, signal()),
      graph = store.inspect(captured);
    const before = Buffer.from(await store.readPack(captured));
    for (const record of records) {
      record.bytes.fill(0);
      record.oid = "0".repeat(40);
    }
    records.length = 0;
    req.proposedOid = "a".repeat(40);
    const borrowed = await store.readPack(captured);
    borrowed.fill(0);
    assert.deepEqual(Buffer.from(await store.readPack(captured)), before);
    assert.equal(store.assertRequest(captured, original), undefined);
    assert.throws(() => store.assertRequest(captured, req), GitObjectStoreError);
    assert.throws(() => store.inspect({ ...captured }), GitObjectStoreError);
    await store.close();
    const reopened = await GitObjectStore.open(options);
    f.owners.push(reopened);
    assert.throws(() => reopened.inspect(captured), GitObjectStoreError);
    const restored = await reopened.restore(graph, original, signal());
    assert.deepEqual(Buffer.from(await reopened.readPack(restored)), before);
    assert.equal(reopened.inspect(restored).graphDigest, graph.graphDigest);
    await assert.rejects(async () => reopened.restore(graph, req, signal()), GitObjectStoreError);

    // Existing handles and restart recovery must both reject altered storage.
    // Each mutation targets only this fixture's retained content, never Git's
    // object database or any ambient file.
    const retained = join(options.directory, `${graph.graphDigest.slice(7)}.objects`);
    const originalBytes = await readFile(retained);
    const corrupted = Buffer.from(originalBytes);
    corrupted[corrupted.length - 1] ^= 1;
    await writeFile(retained, corrupted);
    await assert.rejects(() => reopened.readPack(restored), GitObjectStoreError);
    await assert.rejects(() => reopened.restore(graph, original, signal()), GitObjectStoreError);
    await writeFile(retained, originalBytes);

    // A crash after publishing the hard link can leave its pending alias.
    // Restart must recover the same bytes even when that alias survives.
    const alias = join(options.directory, ".pending-interrupted-capture");
    await link(retained, alias);
    await reopened.close();
    const recovered = await GitObjectStore.open(options);
    f.owners.push(recovered);
    const recoveredCapture = await recovered.restore(graph, original, signal());
    assert.deepEqual(Buffer.from(await recovered.readPack(recoveredCapture)), before);
    await recovered.close();
    await unlink(alias);
    // Continue checking the reader after alias cleanup.
    const reader = await GitObjectStore.open(options);
    f.owners.push(reader);
    const readerCapture = await reader.restore(graph, original, signal());
    await rename(retained, alias);
    await symlink(alias, retained);
    await assert.rejects(() => reader.readPack(readerCapture));
    await assert.rejects(() => reader.restore(graph, original, signal()));
    await unlink(retained);
    await rename(alias, retained);
    assert.deepEqual(Buffer.from(await reader.readPack(readerCapture)), before);

    // A still-open directory descriptor cannot authorize a replacement path.
    const moved = `${options.directory}-moved`;
    await rename(options.directory, moved);
    await mkdir(options.directory, { mode: 0o700 });
    await assert.rejects(() => reader.readPack(readerCapture), GitObjectStoreError);
    await rm(options.directory, { recursive: true });
    await rename(moved, options.directory);
    assert.deepEqual(Buffer.from(await reader.readPack(readerCapture)), before);
  },
);

gitTest(
  "wrong hashes, object types, duplicate records and executable input properties refuse capture",
  { timeout: 15000 },
  async (t) => {
    const f = await gitFixture(t),
      tree = f.tree(),
      root = f.commit(tree),
      { store } = await owner(t, f),
      req = request(root);
    const records = [...f.records.values()];
    for (const malformed of [
      [...records, records[0]],
      records.map((r, i) => (i ? r : { ...r, oid: "0".repeat(40) })),
      records.map((r, i) => (i ? r : { ...r, oid: r.oid.toUpperCase() })),
      records.map((r, i) => (i ? r : { ...r, bytes: Buffer.from("different") })),
      records.map((r, i) => (i ? r : { ...r, type: "tag" })),
    ])
      await assert.rejects(
        async () => store.capture(req, malformed, signal()),
        GitObjectStoreError,
      );
    let invoked = 0;
    const accessor = { ...records[0] };
    Object.defineProperty(accessor, "bytes", {
      enumerable: true,
      get() {
        invoked++;
        return records[0].bytes;
      },
    });
    await assert.rejects(
      async () => store.capture(req, [accessor, records[1]], signal()),
      GitObjectStoreError,
    );
    assert.equal(invoked, 0);
    const shadowed = new Uint8Array(records[0].bytes);
    Object.defineProperty(shadowed, "buffer", {
      get() {
        invoked++;
        throw new Error("typed-array getter must not execute");
      },
    });
    await assert.rejects(
      async () => store.capture(req, [{ ...records[0], bytes: shadowed }, records[1]], signal()),
      GitObjectStoreError,
    );
    assert.equal(invoked, 0);
    const shared = new Uint8Array(new SharedArrayBuffer(records[0].bytes.length));
    shared.set(records[0].bytes);
    await assert.rejects(
      async () => store.capture(req, [{ ...records[0], bytes: shared }, records[1]], signal()),
      GitObjectStoreError,
    );
  },
);

gitTest(
  "object validation ignores hostile local Git configuration without evaluating it",
  { timeout: 15000 },
  async (t) => {
    const f = await gitFixture(t),
      tree = f.tree(),
      root = f.commit(tree);
    const { store, options } = await owner(t, f);
    // The malformed local configuration demonstrably breaks ordinary repository
    // config parsing. The custodian must ignore both this process cwd and a .git
    // inside its object directory when invoking the fixed hash-only Git command.
    const malformed = Buffer.from("[unterminated section\n");
    await writeFile(join(f.repository, "config"), malformed, { mode: 0o600 });
    assert.throws(() => f.git(["config", "--local", "--list"]));
    await mkdir(join(options.directory, ".git"), { mode: 0o700 });
    await writeFile(join(options.directory, ".git", "config"), malformed, { mode: 0o600 });
    const previousDirectory = process.cwd();
    try {
      process.chdir(f.repository);
      const capture = await store.capture(request(root), [...f.records.values()], signal());
      assert.equal(store.inspect(capture).proposedOid, root.oid);
    } finally {
      process.chdir(previousDirectory);
    }
  },
);

gitTest(
  "every blob, tree and commit parent must be present and no unreachable extras are retained",
  { timeout: 15000 },
  async (t) => {
    const f = await gitFixture(t),
      blob = f.blob(Buffer.from("content"));
    const tree = f.tree([{ mode: "100644", name: "file", object: blob }]),
      base = f.commit(tree),
      root = f.commit(tree, [base]);
    const { store } = await owner(t, f),
      req = request(root, base),
      records = [...f.records.values()];
    for (const missing of [blob, tree, base])
      await assert.rejects(
        async () =>
          store.capture(
            req,
            records.filter((r) => r.oid !== missing.oid),
            signal(),
          ),
        GitObjectStoreError,
      );
    const unused = rawObject("blob", Buffer.from("not reachable"));
    await assert.rejects(
      async () => store.capture(req, [...records, unused], signal()),
      GitObjectStoreError,
    );
    await assert.rejects(
      async () => store.capture(request(blob), [blob], signal()),
      GitObjectStoreError,
    );
  },
);

gitTest(
  "tree framing and edge target types are validated even when declared object hashes match",
  { timeout: 15000 },
  async (t) => {
    const f = await gitFixture(t),
      blob = f.blob(Buffer.from("content")),
      { store } = await owner(t, f);
    const valid = rawTree([{ name: "file", object: blob }]);
    const cases = [
      rawObject("tree", valid.bytes.subarray(0, -1)),
      rawObject("tree", Buffer.concat([valid.bytes, Buffer.from("garbage")])),
      rawTree([{ mode: "40000", name: "directory", object: blob }]),
    ];
    for (const tree of cases) {
      const root = rawCommit(tree);
      await assert.rejects(
        async () => store.capture(request(root), [root, tree, blob], signal()),
        GitObjectStoreError,
      );
    }
  },
);

gitTest(
  "Git tree ordering treats directories as slash-terminated and refuses duplicate or unsupported entries",
  { timeout: 15000 },
  async (t) => {
    const f = await gitFixture(t),
      blob = f.blob(Buffer.from("x")),
      child = f.tree(),
      { store } = await owner(t, f);
    const ordered = f.tree([
      { mode: "040000", name: "foo", object: child },
      { mode: "100644", name: "foo.bar", object: blob },
    ]);
    const root = f.commit(ordered);
    await store.capture(request(root), [...f.records.values()], signal());
    for (const [entries, closure] of [
      [
        [
          { mode: "40000", name: "foo", object: child },
          { name: "foo.bar", object: blob },
        ],
        [child, blob],
      ],
      [
        [
          { name: "same", object: blob },
          { name: "same", object: blob },
        ],
        [blob],
      ],
      [[{ mode: "100664", name: "file", object: blob }], [blob]],
      [[{ mode: "120000", name: "link", object: blob }], [blob]],
      // Git itself permits an external gitlink OID. The selected object-only
      // publisher must refuse this mode, rather than accepting a closure escape.
      [[{ mode: "160000", name: "module", object: root }], []],
    ]) {
      const tree = rawTree(entries),
        candidate = rawCommit(tree);
      await assert.rejects(
        async () => store.capture(request(candidate), [candidate, tree, ...closure], signal()),
        GitObjectStoreError,
      );
    }
  },
);

gitTest(
  "unsafe tree paths refuse without checking out or executing the proposed content",
  { timeout: 15000 },
  async (t) => {
    const f = await gitFixture(t),
      blob = f.blob(Buffer.from("data")),
      { store } = await owner(t, f);
    for (const name of [
      ".git",
      ".GiT",
      "..",
      ".",
      "a/b",
      "a\\b",
      "line\nbreak",
      "file.",
      "file ",
    ]) {
      const tree = rawTree([{ name, object: blob }]),
        root = rawCommit(tree);
      await assert.rejects(
        async () => store.capture(request(root), [root, tree, blob], signal()),
        GitObjectStoreError,
      );
    }
  },
);

gitTest(
  "commit headers require one root tree and valid parents while message text remains inert",
  { timeout: 15000 },
  async (t) => {
    const f = await gitFixture(t),
      tree = f.tree(),
      { store } = await owner(t, f);
    const valid = rawCommit(tree, [], `parent ${"a".repeat(40)}\nmessage only\n`);
    await store.capture(request(valid), [valid, tree], signal());
    for (const bytes of [
      Buffer.from(`tree ${tree.oid}\n${valid.bytes.toString()}`),
      Buffer.from(valid.bytes.toString().replace(`tree ${tree.oid}`, `tree ${"z".repeat(40)}`)),
      Buffer.from(valid.bytes.toString().replace("author Object", "unknown Object")),
      Buffer.from(
        valid.bytes.toString().replace("\ncommitter", `\nparent ${"b".repeat(40)}\ncommitter`),
      ),
    ]) {
      const root = rawObject("commit", bytes);
      await assert.rejects(
        async () => store.capture(request(root), [root, tree], signal()),
        GitObjectStoreError,
      );
    }
  },
);

gitTest(
  "unique-object bounds are enforced before capture and an aborted call retains no usable handle",
  { timeout: 15000 },
  async (t) => {
    const f = await gitFixture(t),
      blob = f.blob(Buffer.alloc(4096, 17)),
      tree = f.tree([{ mode: "100644", name: "file", object: blob }]),
      root = f.commit(tree);
    const records = [...f.records.values()],
      req = request(root);
    const bounded = await owner(t, f, { maxObjectBytes: 4095 }, "small-object");
    await assert.rejects(
      async () => bounded.store.capture(req, records, signal()),
      GitObjectStoreError,
    );
    const exact = await owner(t, f, { maxObjects: records.length, maxObjectBytes: 4096 }, "exact");
    await exact.store.capture(req, records, signal());
    const fewer = await owner(t, f, { maxObjects: records.length - 1 }, "few-objects");
    await assert.rejects(
      async () => fewer.store.capture(req, records, signal()),
      GitObjectStoreError,
    );
    await assert.rejects(
      async () => exact.store.capture(req, records, AbortSignal.abort()),
      GitObjectStoreError,
    );
  },
);

gitTest(
  "shared-tree DAG traversal has independent expansion and full-path bounds",
  { timeout: 15000 },
  async (t) => {
    const f = await gitFixture(t),
      blob = f.blob(Buffer.from("leaf"));
    let tree = f.tree([{ mode: "100644", name: "leaf", object: blob }]);
    for (let i = 0; i < 6; i++)
      tree = f.tree([
        { mode: "040000", name: "left", object: tree },
        { mode: "040000", name: "right", object: tree },
      ]);
    const root = f.commit(tree),
      records = [...f.records.values()],
      req = request(root);
    assert.ok(records.length < 16);
    const expanded = await owner(t, f, { maxExpandedPaths: 64 }, "expanded");
    await assert.rejects(
      async () => expanded.store.capture(req, records, signal()),
      GitObjectStoreError,
    );
    const paths = await owner(t, f, { maxPathBytes: 12 }, "paths");
    await assert.rejects(
      async () => paths.store.capture(req, records, signal()),
      GitObjectStoreError,
    );
    const depth = await owner(t, f, { maxTreeDepth: 3 }, "depth");
    await assert.rejects(
      async () => depth.store.capture(req, records, signal()),
      GitObjectStoreError,
    );
    const allowed = await owner(t, f, {}, "allowed");
    await allowed.store.capture(req, records, signal());
  },
);

gitTest(
  "restore and recapture preserve a valid pack produced by another compressor",
  { timeout: 15000 },
  async (t) => {
    const f = await gitFixture(t);
    const blob = f.blob(Buffer.from("compressible content\n".repeat(128)));
    const tree = f.tree([{ mode: "100644", name: "file", object: blob }]);
    const root = f.commit(tree);
    const records = [...f.records.values()];
    const req = request(root);
    const { store, options } = await owner(t, f);
    const captured = await store.capture(req, records, signal());
    const originalDescriptor = store.inspect(captured);
    const originalPack = Buffer.from(await store.readPack(captured));
    // Git produces an independently encoded, non-delta pack for these same
    // objects. Compression level zero reliably differs from this store's six.
    const alternatePack = f.git(
      [
        "-c",
        "pack.compression=0",
        "pack-objects",
        "--stdout",
        "--window=0",
        "--no-reuse-object",
        "--no-reuse-delta",
      ],
      records.map((r) => r.oid).join("\n") + "\n",
    );
    assert.notDeepEqual(alternatePack, originalPack);
    await importPack(f, alternatePack, root, records);
    const retained = join(options.directory, `${originalDescriptor.graphDigest.slice(7)}.objects`);
    const originalFile = await readFile(retained);
    const metadataEnd = 12 + originalFile.readUInt32BE(8);
    const metadata = JSON.parse(originalFile.subarray(12, metadataEnd).toString());
    const rawObjects = originalFile.subarray(
      metadataEnd,
      originalFile.length - originalPack.length,
    );
    // Replace only this fixture's pack and its declared digest/length. This
    // models persisted output from another compressor, with unchanged objects.
    const savePack = async (packed) => {
      const graph = {
        ...originalDescriptor,
        packSha256: `sha256:${sha256(packed)}`,
        packBytes: packed.length,
      };
      const json = Buffer.from(JSON.stringify({ ...metadata, graph }));
      const header = Buffer.from(originalFile.subarray(0, 12));
      header.writeUInt32BE(json.length, 8);
      await writeFile(retained, Buffer.concat([header, json, rawObjects, packed]));
      return graph;
    };
    const alternateDescriptor = await savePack(alternatePack);
    const alternateFile = await readFile(retained);
    await store.close();
    const reopened = await GitObjectStore.open(options);
    f.owners.push(reopened);
    const restored = await reopened.restore(alternateDescriptor, req, signal());
    assert.deepEqual(Buffer.from(await reopened.readPack(restored)), alternatePack);
    const recaptured = await reopened.capture(req, records, signal());
    assert.deepEqual(reopened.inspect(recaptured), alternateDescriptor);
    assert.deepEqual(Buffer.from(await reopened.readPack(recaptured)), alternatePack);
    assert.deepEqual(await readFile(retained), alternateFile);

    // A caller-supplied digest is not proof of a valid pack. Even self-consistent
    // metadata cannot authorize arbitrary bytes or another graph's Git objects.
    const otherBlob = f.blob(Buffer.from("different content\n"));
    const otherTree = f.tree([{ mode: "100644", name: "file", object: otherBlob }]);
    const otherRoot = f.commit(otherTree);
    const wrongGraphPack = f.git(
      ["pack-objects", "--stdout", "--window=0"],
      [otherBlob, otherTree, otherRoot].map((r) => r.oid).join("\n") + "\n",
    );
    for (const invalidPack of [Buffer.alloc(alternatePack.length, 65), wrongGraphPack]) {
      const invalidDescriptor = await savePack(invalidPack);
      await assert.rejects(
        () => reopened.restore(invalidDescriptor, req, signal()),
        GitObjectStoreError,
      );
      await assert.rejects(() => reopened.capture(req, records, signal()), GitObjectStoreError);
    }
  },
);
