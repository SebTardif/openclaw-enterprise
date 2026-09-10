import assert from "node:assert/strict";
import test, { mock } from "node:test";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";

// Only the external file descriptor boundary is controlled. Every successful
// open/read/stat/close still uses an actual temporary file and real FileHandle.
// Run in this file's isolated test process with --experimental-test-module-mocks.
let intercept;
let interceptOpen;
let opened = 0;
let closed = 0;
const anchorPaths = new Map();
const pathOnly = 0x200000;
mock.module("node:fs/promises", {
  namedExports: {
    ...fs,
    open: async (...args) => {
      const fdReference = /^\/proc\/self\/fd\/([0-9]+)$/.exec(String(args[0]));
      const logicalPath = fdReference
        ? (anchorPaths.get(Number(fdReference[1])) ?? args[0])
        : args[0];
      const isAnchor = (args[1] & pathOnly) !== 0;
      await interceptOpen?.("before", args[0], args[1], undefined, logicalPath);
      const handle = await fs.open(...args);
      opened++;
      if (isAnchor) anchorPaths.set(handle.fd, logicalPath);
      try {
        await interceptOpen?.("after", args[0], args[1], handle, logicalPath);
      } catch (error) {
        anchorPaths.delete(handle.fd);
        await handle.close();
        closed++;
        throw error;
      }
      return new Proxy(handle, {
        get(target, name) {
          if (name === "read")
            return async (...readArgs) => {
              await intercept?.("read", logicalPath, target);
              return target.read(...readArgs);
            };
          if (name === "close")
            return async () => {
              await intercept?.(isAnchor ? "anchor-close" : "close", logicalPath, target);
              const fd = target.fd;
              await target.close();
              if (isAnchor) anchorPaths.delete(fd);
              closed++;
            };
          const value = Reflect.get(target, name, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  },
});
const { ProtectedInstalledArtifactStore } =
  await import("../../apps/controller/src/drivers/compute/kubernetes/installed-artifact-store.ts");
const { InstalledImageFiles } =
  await import("../../apps/controller/src/drivers/compute/kubernetes/installed-artifact-layers.ts");
const media = "application/vnd.oci.image.layer.v1.tar";
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const json = (value) => Buffer.from(JSON.stringify(value));
function tar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    const h = Buffer.alloc(512);
    const put = (offset, size, value) => {
      const bytes = Buffer.from(value);
      assert.ok(bytes.length <= size);
      bytes.copy(h, offset);
    };
    const oct = (offset, size, value) =>
      put(offset, size, value.toString(8).padStart(size - 1, "0") + "\0");
    put(0, 100, entry.name);
    oct(100, 8, entry.mode ?? 0o644);
    oct(108, 8, 0);
    oct(116, 8, 0);
    oct(124, 12, body.length);
    oct(136, 12, 0);
    h.fill(32, 148, 156);
    put(156, 1, entry.type ?? "0");
    put(157, 100, entry.link ?? "");
    put(257, 6, "ustar\0");
    put(263, 2, "00");
    const checksum = h.reduce((sum, byte) => sum + byte, 0);
    put(148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
const layerLimits = { uncompressedBytes: 1048576, entries: 100, pathBytes: 1024, linkDepth: 8 };
const layer = (bytes, gzip = false) => ({
  mediaType: gzip ? `${media}+gzip` : media,
  bytes: gzip ? gzipSync(bytes) : bytes,
  diffId: digest(bytes),
});
async function fixture() {
  // /tmp is deliberately excluded: its writable ancestor violates acquisition.
  const root = await fs.mkdtemp(join(homedir(), ".oci-component-"));
  await fs.mkdir(join(root, "blobs"), { mode: 0o700 });
  await fs.mkdir(join(root, "blobs", "sha256"), { mode: 0o700 });
  const put = async (bytes, mediaType) => {
    const d = { mediaType, digest: digest(bytes), size: bytes.length };
    await fs.writeFile(join(root, "blobs", "sha256", d.digest.slice(7)), bytes, { mode: 0o600 });
    return d;
  };
  const images = {};
  const layers = {};
  for (const role of ["gateway", "harness"]) {
    const bytes = tar([{ name: "app/" + role, body: role + "-verified", mode: 0o555 }]);
    const l = await put(gzipSync(bytes), `${media}+gzip`);
    layers[role] = l;
    const config = await put(
      json({
        architecture: "amd64",
        os: "linux",
        config: { Entrypoint: ["/app/" + role], Env: ["ROLE=" + role] },
        rootfs: { type: "layers", diff_ids: [digest(bytes)] },
      }),
      "application/vnd.oci.image.config.v1+json",
    );
    const manifest = await put(
      json({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config,
        layers: [l],
      }),
      "application/vnd.oci.image.manifest.v1+json",
    );
    images[role] = {
      reference: `example.invalid/${role}@${manifest.digest}`,
      descriptor: manifest,
    };
  }
  const definition = await put(
    json({ schemaVersion: 1, sourceBlobs: [] }),
    "application/vnd.openclaw.installed-renderer-definition.v1+json",
  );
  await fs.writeFile(join(root, "oci-layout"), json({ imageLayoutVersion: "1.0.0" }), {
    mode: 0o600,
  });
  await fs.writeFile(
    join(root, "index.json"),
    json({ schemaVersion: 2, manifests: Object.values(images).map((image) => image.descriptor) }),
    { mode: 0o600 },
  );
  const selection = {
    root,
    ownerUid: process.getuid(),
    platform: { os: "linux", architecture: "amd64" },
    images,
    definition,
    limits: {
      blobBytes: 1048576,
      compressedBytes: 4194304,
      uncompressedBytes: 4194304,
      jsonBytes: 65536,
      layers: 8,
      entries: 100,
      pathBytes: 1024,
      linkDepth: 8,
    },
  };
  return {
    root,
    selection,
    put,
    layers,
    remove: () => fs.rm(root, { recursive: true, force: true }),
  };
}
function barrier() {
  let enter, release;
  return {
    entered: new Promise((resolve) => {
      enter = resolve;
    }),
    held: new Promise((resolve) => {
      release = resolve;
    }),
    enter: () => enter(),
    release: () => release(),
  };
}
async function turn() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("actual pinned images retain immutable copies and independent borrowed lifetimes", async () => {
  const f = await fixture();
  const store = new ProtectedInstalledArtifactStore(f.selection);
  try {
    f.selection.images.gateway.reference = "caller-change";
    const held = await store.acquire(new AbortController().signal);
    const first = held.images.gateway.readFile("/app/gateway");
    assert.equal(Buffer.from(first.bytes).toString(), "gateway-verified");
    assert.equal(first.mode, 0o555);
    first.bytes.fill(0);
    assert.equal(
      Buffer.from(held.images.gateway.readFile("/app/gateway").bytes).toString(),
      "gateway-verified",
    );
    await fs.rename(f.root, f.root + "-old");
    await fs.mkdir(f.root, { mode: 0o700 });
    const borrowed = held.borrow();
    const release = held.release();
    assert.equal(held.release(), release);
    await release;
    assert.throws(() => held.assertCurrent());
    assert.equal(borrowed.assertCurrent(), undefined);
    assert.equal(
      Buffer.from(borrowed.images.harness.readFile("/app/harness").bytes).toString(),
      "harness-verified",
    );
    await assert.rejects(store.acquire(new AbortController().signal));
    await borrowed.release();
    assert.throws(() => borrowed.readDefinition());
  } finally {
    await store.close();
    await f.remove();
    await fs.rm(f.root + "-old", { recursive: true, force: true });
  }
});

for (const damage of [
  "digest",
  "size",
  "missing",
  "platform",
  "writable",
  "symlink",
  "aggregate",
]) {
  test(`real artifact acquisition refuses ${damage} corruption or selection`, async () => {
    const f = await fixture();
    const path = join(f.root, "blobs", "sha256", f.layers.gateway.digest.slice(7));
    if (damage === "digest") {
      const bytes = await fs.readFile(path);
      bytes[bytes.length - 1] ^= 1;
      await fs.writeFile(path, bytes);
    }
    if (damage === "size") await fs.appendFile(path, "x");
    if (damage === "missing") await fs.unlink(path);
    if (damage === "platform") f.selection.platform.architecture = "arm64";
    if (damage === "writable") await fs.chmod(path, 0o622);
    if (damage === "symlink") {
      await fs.rename(path, path + "-old");
      await fs.symlink(path + "-old", path);
    }
    if (damage === "aggregate") f.selection.limits.uncompressedBytes = 3072;
    const store = new ProtectedInstalledArtifactStore(f.selection);
    const before = opened - closed;
    try {
      await assert.rejects(store.acquire(new AbortController().signal));
      assert.equal(opened - closed, before);
    } finally {
      await store.close();
      await f.remove();
    }
  });
}

test("selection accessors cannot select a root or run during capture", () => {
  let calls = 0;
  const value = {};
  Object.defineProperty(value, "root", {
    enumerable: true,
    get() {
      calls++;
      return homedir();
    },
  });
  assert.throws(() => new ProtectedInstalledArtifactStore(value));
  assert.equal(calls, 0);
});

test("whiteouts affect only lower layers and opaque ordering preserves same-layer files", async () => {
  const old = tar([
    { name: "d/", type: "5" },
    { name: "d/old", body: "old" },
    { name: "gone", body: "old" },
  ]);
  const next = tar([
    { name: "d/new", body: "new" },
    { name: "d/.wh..wh..opq" },
    { name: ".wh.gone" },
    { name: "gone", body: "replacement" },
    { name: "link", type: "2", link: "/d/new" },
    { name: "hard", type: "1", link: "d/new" },
  ]);
  const files = await InstalledImageFiles.acquire(
    [layer(old), layer(next, true)],
    layerLimits,
    new AbortController().signal,
  );
  try {
    assert.throws(() => files.read("/d/old"));
    assert.equal(Buffer.from(files.read("/d/new").bytes).toString(), "new");
    assert.equal(Buffer.from(files.read("/gone").bytes).toString(), "replacement");
    assert.equal(Buffer.from(files.read("/link").bytes).toString(), "new");
    assert.equal(Buffer.from(files.read("/hard").bytes).toString(), "new");
  } finally {
    files.close();
  }
});

for (const entries of [
  [{ name: "../escape", body: "bad" }],
  [{ name: "a", type: "2", link: "../../escape" }],
  [
    { name: "a", body: "one" },
    { name: "a", body: "two" },
  ],
  [
    { name: "a/child", body: "child" },
    { name: "a", body: "conflict" },
  ],
  [{ name: "a", type: "3" }],
  [
    { name: "a", type: "1", link: "future" },
    { name: "future", body: "later" },
  ],
])
  test(`virtual archive refuses unsafe/conflicting entry ${JSON.stringify(entries)}`, async () => {
    await assert.rejects(
      InstalledImageFiles.acquire([layer(tar(entries))], layerLimits, new AbortController().signal),
    );
  });

test("DiffID, checksum, truncated archive, unsupported compression and decompression bounds are enforced", async () => {
  const bytes = tar([{ name: "a", body: "x".repeat(8192) }]);
  const wrongDigest = { ...layer(bytes), diffId: digest(Buffer.from("other")) };
  const corrupt = Buffer.from(bytes);
  corrupt[0] ^= 1;
  for (const supplied of [
    wrongDigest,
    layer(corrupt),
    layer(bytes.subarray(0, bytes.length - 512)),
    { ...layer(bytes), mediaType: media + "+zstd" },
  ]) {
    await assert.rejects(
      InstalledImageFiles.acquire([supplied], layerLimits, new AbortController().signal),
    );
  }
  await assert.rejects(
    InstalledImageFiles.acquire(
      [layer(bytes, true)],
      { ...layerLimits, uncompressedBytes: 2048 },
      new AbortController().signal,
    ),
  );
});

for (const late of ["success", "rejection"])
  test(`cancellation joins actual entered file read and late ${late}`, async () => {
    const f = await fixture();
    const store = new ProtectedInstalledArtifactStore(f.selection);
    const gate = barrier();
    let entered = 0,
      settled = false;
    const marker = new Error("actual selected read rejected after barrier");
    intercept = async (operation, path) => {
      if (operation === "read" && String(path).endsWith("/oci-layout")) {
        entered++;
        gate.enter();
        await gate.held;
        if (late === "rejection") throw marker;
      }
    };
    const abort = new AbortController();
    const before = opened - closed;
    const pending = store.acquire(abort.signal);
    const refused = assert.rejects(pending);
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await gate.entered;
      abort.abort();
      const closing = store.close();
      assert.equal(store.close(), closing);
      await turn();
      assert.equal(entered, 1);
      assert.equal(settled, false);
      gate.release();
      await refused;
      await closing;
      assert.equal(settled, true);
      assert.equal(opened - closed, before);
    } finally {
      gate.release();
      intercept = undefined;
      await store.close();
      await f.remove();
    }
  });

test("mutation during actual acquisition refuses the changed inode contents", async () => {
  const f = await fixture();
  const store = new ProtectedInstalledArtifactStore(f.selection);
  let changed = 0;
  intercept = async (operation, path) => {
    if (operation === "read" && String(path).endsWith(f.layers.gateway.digest.slice(7))) {
      intercept = undefined;
      const actual = join(f.root, "blobs", "sha256", f.layers.gateway.digest.slice(7));
      const bytes = await fs.readFile(actual);
      bytes[bytes.length - 1] ^= 1;
      await fs.writeFile(actual, bytes);
      changed++;
    }
  };
  try {
    await assert.rejects(store.acquire(new AbortController().signal));
    assert.equal(changed, 1);
  } finally {
    intercept = undefined;
    await store.close();
    await f.remove();
  }
});

test("failed original descriptor closure is retained and close cannot report successful retirement", async () => {
  const f = await fixture();
  const store = new ProtectedInstalledArtifactStore(f.selection);
  const marker = new Error("original close failure");
  let retained,
    attempts = 0;
  intercept = async (operation, path, handle) => {
    if (operation === "close" && String(path).endsWith("/oci-layout")) {
      retained = handle;
      attempts++;
      throw marker;
    }
  };
  try {
    await assert.rejects(store.acquire(new AbortController().signal));
    const closing = store.close();
    assert.equal(store.close(), closing);
    await assert.rejects(closing, (error) => error === marker);
    assert.equal(attempts, 1);
    assert.ok(retained);
  } finally {
    intercept = undefined;
    // Test resource cleanup is explicit; the product did not claim this close.
    if (retained) {
      await retained.close();
      closed++;
    }
    await f.remove();
  }
});

test("cancellation also joins an entered original close before publishing refusal", async () => {
  const f = await fixture();
  const store = new ProtectedInstalledArtifactStore(f.selection);
  const gate = barrier();
  let entered = 0,
    settled = false;
  intercept = async (operation, path) => {
    if (operation === "close" && String(path).endsWith("/oci-layout")) {
      entered++;
      gate.enter();
      await gate.held;
    }
  };
  const abort = new AbortController();
  const before = opened - closed;
  const pending = store.acquire(abort.signal);
  const refused = assert.rejects(pending);
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await gate.entered;
    abort.abort();
    await turn();
    assert.equal(entered, 1);
    assert.equal(settled, false);
    gate.release();
    await refused;
    assert.equal(opened - closed, before);
  } finally {
    gate.release();
    intercept = undefined;
    await store.close();
    await f.remove();
  }
});

test("selected implementation source blobs are verified and retained as original bytes", async () => {
  const f = await fixture();
  const expected = Buffer.from("retained original source bytes\n");
  const source = await f.put(expected, "application/vnd.openclaw.installed-source.v1+octet-stream");
  f.selection.definition = await f.put(
    json({ schemaVersion: 1, sourceBlobs: [{ id: "launch-source", descriptor: source }] }),
    "application/vnd.openclaw.installed-renderer-definition.v1+json",
  );
  const store = new ProtectedInstalledArtifactStore(f.selection);
  try {
    const held = await store.acquire(new AbortController().signal);
    const supplied = held.readBlob(source.digest);
    assert.deepEqual(Buffer.from(supplied), expected);
    supplied.fill(0);
    assert.deepEqual(Buffer.from(held.readBlob(source.digest)), expected);
    assert.throws(() => held.readBlob(digest(Buffer.from("not selected"))));
    await held.release();
  } finally {
    await store.close();
    await f.remove();
  }
});

function paxItem(key, value) {
  const tail = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(tail) + 1;
  while (String(length).length + Buffer.byteLength(tail) !== length)
    length = String(length).length + Buffer.byteLength(tail);
  return String(length) + tail;
}

test("PAX path bytes are applied and PAX entries count across layer boundaries", async () => {
  const first = tar([
    { name: "PaxHeader", type: "x", body: paxItem("path", "long/selected") },
    { name: "short", body: "original" },
  ]);
  const second = tar([{ name: "another", body: "second" }]);
  const files = await InstalledImageFiles.acquire(
    [layer(first)],
    layerLimits,
    new AbortController().signal,
  );
  try {
    assert.equal(Buffer.from(files.read("/long/selected").bytes).toString(), "original");
    assert.equal(files.usage.entries, 2);
  } finally {
    files.close();
  }
  await assert.rejects(
    InstalledImageFiles.acquire(
      [layer(first), layer(second)],
      { ...layerLimits, entries: 2 },
      new AbortController().signal,
    ),
  );
  const unsupported = tar([
    { name: "PaxHeader", type: "x", body: paxItem("SCHILY.xattr.user.test", "unqualified") },
    { name: "file", body: "x" },
  ]);
  await assert.rejects(
    InstalledImageFiles.acquire([layer(unsupported)], layerLimits, new AbortController().signal),
  );
});

test("virtual links cannot form an unbounded resolution chain or receive child writes", async () => {
  const cyclic = tar([
    { name: "a", type: "2", link: "b" },
    { name: "b", type: "2", link: "a" },
  ]);
  const files = await InstalledImageFiles.acquire(
    [layer(cyclic)],
    layerLimits,
    new AbortController().signal,
  );
  try {
    assert.throws(() => files.read("/a"));
  } finally {
    files.close();
  }
  const lower = tar([{ name: "a", type: "2", link: "destination" }]);
  const upper = tar([{ name: "a/file", body: "unsafe" }]);
  await assert.rejects(
    InstalledImageFiles.acquire(
      [layer(lower), layer(upper)],
      layerLimits,
      new AbortController().signal,
    ),
  );
});

test("aborted and closed stores acquire no new file descriptors", async () => {
  const f = await fixture();
  const store = new ProtectedInstalledArtifactStore(f.selection);
  const abort = new AbortController();
  abort.abort();
  const before = opened;
  try {
    await assert.rejects(store.acquire(abort.signal));
    await store.close();
    await assert.rejects(store.acquire(new AbortController().signal));
    assert.equal(opened, before);
  } finally {
    await f.remove();
  }
});

test("ordinary whiteout of a file literally named opaque preserves unrelated siblings", async () => {
  const before = tar([
    { name: "d/opaque", body: "remove only this" },
    { name: "d/sibling", body: "retained sibling" },
  ]);
  const after = tar([{ name: "d/.wh.opaque" }]);
  const files = await InstalledImageFiles.acquire(
    [layer(before), layer(after)],
    layerLimits,
    new AbortController().signal,
  );
  try {
    assert.throws(() => files.read("/d/opaque"));
    assert.equal(Buffer.from(files.read("/d/sibling").bytes).toString(), "retained sibling");
  } finally {
    files.close();
  }
});

for (const laterLayer of [false, true])
  test(`explicit directory metadata preserves implicit children; later layer=${laterLayer}`, async () => {
    const child = { name: "d/child", body: "retain exact original child" };
    const directory = { name: "d/", type: "5", mode: 0o755 };
    const supplied = laterLayer
      ? [layer(tar([child])), layer(tar([directory]))]
      : [layer(tar([child, directory]))];
    const files = await InstalledImageFiles.acquire(
      supplied,
      layerLimits,
      new AbortController().signal,
    );
    try {
      assert.equal(
        Buffer.from(files.read("/d/child").bytes).toString(),
        "retain exact original child",
      );
    } finally {
      files.close();
    }
  });

test("virtual traversal follows an intermediate symlink before dot-dot, with distinct target bytes", async () => {
  const bytes = tar([
    { name: "a/", type: "5" },
    { name: "real/", type: "5" },
    { name: "real/deep/", type: "5" },
    { name: "a/x", body: "wrong lexical answer" },
    { name: "real/x", body: "correct physical traversal" },
    { name: "a/alias", type: "2", link: "/real/deep" },
    { name: "a/result", type: "2", link: "alias/../x" },
    { name: "a/relative", type: "2", link: "../real/x" },
    { name: "absolute", type: "2", link: "/real/x" },
  ]);
  const files = await InstalledImageFiles.acquire(
    [layer(bytes)],
    layerLimits,
    new AbortController().signal,
  );
  try {
    assert.equal(Buffer.from(files.read("/a/x").bytes).toString(), "wrong lexical answer");
    for (const path of ["/a/result", "/a/relative", "/absolute"])
      assert.equal(Buffer.from(files.read(path).bytes).toString(), "correct physical traversal");
  } finally {
    files.close();
  }
});

test("component-wise link traversal retains the depth bound and rejects a file before dot-dot", async () => {
  const bytes = tar([
    { name: "target", body: "original" },
    { name: "one", type: "2", link: "target" },
    { name: "two", type: "2", link: "one" },
    { name: "d/", type: "5" },
    { name: "d/result", type: "2", link: "../target/../target" },
  ]);
  const files = await InstalledImageFiles.acquire(
    [layer(bytes)],
    { ...layerLimits, linkDepth: 1 },
    new AbortController().signal,
  );
  try {
    assert.equal(Buffer.from(files.read("/one").bytes).toString(), "original");
    assert.throws(() => files.read("/two"));
    assert.throws(() => files.read("/d/result"));
  } finally {
    files.close();
  }
});

for (const kind of ["fifo", "directory", "symlink"])
  test(`nonregular ${kind} is anchored and refused without a content open`, async () => {
    const f = await fixture();
    const selected = join(f.root, "oci-layout");
    await fs.unlink(selected);
    if (kind === "fifo") execFileSync("mkfifo", ["--mode=600", selected]);
    if (kind === "directory") await fs.mkdir(selected, { mode: 0o700 });
    if (kind === "symlink") await fs.symlink("index.json", selected);
    let anchors = 0,
      endpointOpens = 0,
      observedKind;
    const before = opened - closed;
    interceptOpen = async (phase, _path, flags, handle, logicalPath) => {
      if (!String(logicalPath).endsWith("/oci-layout")) return;
      if (phase === "before" && !(flags & pathOnly)) {
        endpointOpens++;
        // A broken implementation must fail the counter assertion without
        // blocking the test worker in a FIFO open or requiring a FIFO writer.
        throw new Error("unexpected nonregular endpoint open");
      }
      if (phase === "after" && flags & pathOnly) {
        anchors++;
        const actual = await handle.stat();
        observedKind = {
          file: actual.isFile(),
          expected:
            kind === "fifo"
              ? actual.isFIFO()
              : kind === "directory"
                ? actual.isDirectory()
                : actual.isSymbolicLink(),
        };
      }
    };
    const store = new ProtectedInstalledArtifactStore(f.selection);
    try {
      await assert.rejects(store.acquire(new AbortController().signal));
      await store.close();
      assert.equal(anchors, 1);
      assert.equal(endpointOpens, 0);
      assert.deepEqual(observedKind, { file: false, expected: true });
      assert.equal(opened - closed, before);
    } finally {
      interceptOpen = undefined;
      await store.close();
      await f.remove();
    }
  });

test("replacement with a FIFO after regular-inode anchoring cannot retarget content open", async () => {
  const f = await fixture();
  const selected = join(f.root, "oci-layout");
  const before = opened - closed;
  let anchoredIdentity,
    originalContents,
    observedLinks,
    replacements = 0,
    contentOpens = 0,
    invalidContentPaths = 0;
  interceptOpen = async (phase, path, flags, handle, logicalPath) => {
    if (!String(logicalPath).endsWith("/oci-layout")) return;
    if (phase === "after" && flags & pathOnly) anchoredIdentity = await handle.stat();
    if (phase === "before" && !(flags & pathOnly)) {
      if (!/^\/proc\/self\/fd\/[0-9]+$/.test(String(path)) || !anchoredIdentity?.isFile()) {
        invalidContentPaths++;
        throw new Error("content open is not bound to the actual regular inode anchor");
      }
      await fs.unlink(selected);
      execFileSync("mkfifo", ["--mode=600", selected]);
      replacements++;
    }
    if (phase === "after" && !(flags & pathOnly)) {
      contentOpens++;
      const actual = await handle.stat();
      originalContents =
        actual.isFile() &&
        actual.ino === anchoredIdentity.ino &&
        actual.dev === anchoredIdentity.dev;
      observedLinks = actual.nlink;
    }
  };
  const store = new ProtectedInstalledArtifactStore(f.selection);
  try {
    await assert.rejects(store.acquire(new AbortController().signal));
    assert.equal(replacements, 1);
    assert.equal(invalidContentPaths, 0);
    assert.equal(contentOpens, 1);
    assert.equal(originalContents, true);
    assert.equal(observedLinks, 0);
    assert.equal((await fs.lstat(selected)).isFIFO(), true);
    assert.equal(opened - closed, before);
  } finally {
    interceptOpen = undefined;
    await store.close();
    await f.remove();
  }
});

for (const late of ["success", "rejection"])
  test(`cancellation joins an actual late inode-anchor open ${late}`, async () => {
    const f = await fixture();
    const gate = barrier();
    const abort = new AbortController();
    const before = opened - closed;
    let entries = 0,
      settled = false;
    const marker = new Error("late original anchor open rejection");
    interceptOpen = async (phase, _path, flags, _handle, logicalPath) => {
      if (phase === "after" && flags & pathOnly && String(logicalPath).endsWith("/oci-layout")) {
        entries++;
        gate.enter();
        await gate.held;
        if (late === "rejection") throw marker;
      }
    };
    const store = new ProtectedInstalledArtifactStore(f.selection);
    const pending = store.acquire(abort.signal);
    const refused = assert.rejects(pending);
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await gate.entered;
      abort.abort();
      const closing = store.close();
      await turn();
      assert.equal(entries, 1);
      assert.equal(settled, false);
      gate.release();
      await refused;
      await closing;
      assert.equal(opened - closed, before);
    } finally {
      gate.release();
      interceptOpen = undefined;
      await store.close();
      await f.remove();
    }
  });

test("failed original anchor close remains retained after content and other descriptors close", async () => {
  const f = await fixture();
  const store = new ProtectedInstalledArtifactStore(f.selection);
  const marker = new Error("original inode anchor close failure");
  let retained,
    attempts = 0;
  const before = opened - closed;
  intercept = async (operation, path, handle) => {
    if (operation === "anchor-close" && String(path).endsWith("/oci-layout")) {
      retained = handle;
      attempts++;
      throw marker;
    }
  };
  try {
    await assert.rejects(store.acquire(new AbortController().signal));
    const closing = store.close();
    assert.equal(store.close(), closing);
    await assert.rejects(closing, (error) => error === marker);
    assert.equal(attempts, 1);
    assert.ok(retained);
    assert.equal(opened - closed, before + 1);
  } finally {
    intercept = undefined;
    if (retained) {
      anchorPaths.delete(retained.fd);
      await retained.close();
      closed++;
    }
    await f.remove();
  }
});
