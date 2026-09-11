import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeInstalledRendererBehaviorBinding } from "../../deploy/runtime/write-installed-renderer-behavior.mjs";

// Real filesystem/byte provenance cases. These payload bytes are never run and
// do not substitute a supported Gateway, Harness, native or model implementation.
const sha = (b) => `sha256:${createHash("sha256").update(b).digest("hex")}`;
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "oce-renderer-binding-"));
  const roots = { gateway: join(home, "gateway"), harness: join(home, "harness") };
  const files = [];
  for (const component of ["gateway", "harness"]) {
    await mkdir(roots[component]);
    await mkdir(join(roots[component], "payload"));
    for (const role of [
      "interpreter",
      "entrypoint",
      "readiness",
      "environment",
      "resource-accounting",
      "module",
      "helper",
    ]) {
      const path = `/payload/${role}`;
      const bytes = Buffer.from(`unexecuted ${component} ${role} fixture bytes\n`);
      await writeFile(`${roots[component]}${path}`, bytes, {
        mode: role === "interpreter" ? 0o555 : 0o444,
      });
      files.push({ id: `${component}-${role}`, component, role, path });
    }
  }
  const selected = {
    schemaVersion: 1,
    kind: "openclaw.renderer-payload-input.v1",
    implementation: "component-provenance-fixture",
    platform: { os: "linux", architecture: "amd64" },
    files,
  };
  const output = join(home, "binding");
  return {
    home,
    roots,
    selected,
    output,
    run: (overrides = {}) =>
      writeInstalledRendererBehaviorBinding({
        roots,
        selectionBytes: Buffer.from(JSON.stringify(selected)),
        output,
        ...overrides,
      }),
    close: () => rm(home, { recursive: true, force: true }),
  };
}
async function definition(f, result) {
  const bytes = await readFile(join(f.output, "blobs/sha256", result.definition.digest.slice(7)));
  assert.equal(sha(bytes), result.definition.digest);
  assert.equal(bytes.length, result.definition.size);
  return JSON.parse(bytes);
}

test("real copied bytes produce deterministic source blobs and explicitly unqualified definition", async () => {
  const a = await fixture(),
    b = await fixture();
  try {
    b.selected.files.reverse();
    const first = await a.run(),
      second = await b.run();
    assert.deepEqual(first, second);
    assert.equal(first.qualification, "unqualified-byte-provenance");
    const value = await definition(a, first);
    assert.equal(value.qualification, "unqualified-byte-provenance");
    assert.equal(value.files.length, 14);
    assert.equal(value.sourceBlobs.length, 14);
    assert.equal(
      Object.hasOwn(value, "artifactSet"),
      false,
      "final image identity is supplied after image construction",
    );
    assert.equal(Object.hasOwn(value, "supported"), false);
    for (const file of value.files) {
      const actual = await readFile(`${a.roots[file.component]}${file.path}`);
      const retained = await readFile(
        join(a.output, "blobs/sha256", file.descriptor.digest.slice(7)),
      );
      assert.deepEqual(retained, actual);
      assert.equal(file.descriptor.digest, sha(actual));
      assert.equal(file.descriptor.size, actual.length);
      assert.equal(
        file.descriptor.mediaType,
        "application/vnd.openclaw.installed-source.v1+octet-stream",
      );
      assert.equal(file.mode, file.role === "interpreter" ? 0o555 : 0o444);
    }
  } finally {
    await a.close();
    await b.close();
  }
});

test("changed actual module bytes change source and definition identities", async () => {
  const a = await fixture(),
    b = await fixture();
  try {
    const path = `${b.roots.harness}/payload/module`;
    await chmod(path, 0o644);
    await writeFile(path, "different actual copied module bytes\n");
    await chmod(path, 0o444);
    const first = await a.run(),
      second = await b.run();
    assert.notEqual(first.definition.digest, second.definition.digest);
    const va = await definition(a, first),
      vb = await definition(b, second);
    assert.notEqual(
      va.files.find((f) => f.id === "harness-module").descriptor.digest,
      vb.files.find((f) => f.id === "harness-module").descriptor.digest,
    );
  } finally {
    await a.close();
    await b.close();
  }
});

for (const changed of [
  "missing-readiness",
  "duplicate-id",
  "claimed-digest",
  "parent-traversal",
  "duplicate-json-key",
])
  test(`closed build selection refuses ${changed} before producing output`, async () => {
    const f = await fixture();
    try {
      if (changed === "missing-readiness")
        f.selected.files = f.selected.files.filter((v) => v.id !== "gateway-readiness");
      if (changed === "duplicate-id") f.selected.files[1].id = f.selected.files[0].id;
      if (changed === "claimed-digest")
        f.selected.files[0].contentDigest = `sha256:${"0".repeat(64)}`;
      if (changed === "parent-traversal") f.selected.files[0].path = "/payload/../outside";
      let selectionBytes = Buffer.from(JSON.stringify(f.selected));
      if (changed === "duplicate-json-key")
        selectionBytes = Buffer.from(
          selectionBytes
            .toString()
            .replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
        );
      await assert.rejects(f.run({ selectionBytes }));
      await assert.rejects(readdir(f.output), { code: "ENOENT" });
    } finally {
      await f.close();
    }
  });

for (const kind of [
  "directory",
  "leaf-symlink",
  "parent-symlink",
  "writable",
  "nonexecutable-interpreter",
])
  test(`actual ${kind} payload refuses without opening an alternate endpoint`, async () => {
    const f = await fixture();
    try {
      const path = `${f.roots.gateway}/payload/interpreter`;
      if (kind === "writable") await chmod(path, 0o755);
      else if (kind === "nonexecutable-interpreter") await chmod(path, 0o444);
      else if (kind === "parent-symlink") {
        await symlink(`${f.roots.harness}/payload`, `${f.roots.gateway}/link`);
        f.selected.files[0].path = "/link/interpreter";
      } else {
        await rm(path);
        if (kind === "directory") await mkdir(path);
        else await symlink(`${f.roots.harness}/payload/interpreter`, path);
      }
      await assert.rejects(f.run());
      await assert.rejects(readdir(f.output), { code: "ENOENT" });
    } finally {
      await f.close();
    }
  });

test("an existing binding is never overwritten or adopted", async () => {
  const f = await fixture();
  try {
    await mkdir(f.output);
    await writeFile(join(f.output, "sentinel"), "original bytes");
    await assert.rejects(f.run(), { code: "EEXIST" });
    assert.equal(await readFile(join(f.output, "sentinel"), "utf8"), "original bytes");
    assert.deepEqual(await readdir(f.output), ["sentinel"]);
  } finally {
    await f.close();
  }
});

test("original cancellation refuses without publishing a binding", async () => {
  const f = await fixture();
  const controller = new AbortController(),
    reason = new Error("original build cancelled");
  try {
    controller.abort(reason);
    await assert.rejects(f.run({ signal: controller.signal }), (error) => error === reason);
    await assert.rejects(readdir(f.output), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});

// CLI ingress regressions use the original CLI branch and real filesystem
// handles. A child-local observation wrapper schedules one precise real growth
// or read rejection; it does not replace payload/behavior authority.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

async function cliIngressProbe() {
  const actual = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  const { pathToFileURL } = await import("node:url");
  const { mock } = await import("node:test");
  const [helper, gateway, harness, selected, output, scenario] = process.argv.slice(1);
  const O_PATH = 0x200000;
  const proof = {
    refused: false,
    declared: null,
    contentOpenAttempts: 0,
    acquired: 0,
    closed: 0,
    growth: 0,
    readRejection: 0,
    requested: 0,
    returned: 0,
    maxBuffer: 0,
    readEnd: 0,
    sameReadError: false,
  };
  let anchorFd,
    active = true;
  const readError = new Error("controlled original selection read cancelled");
  readError.name = "AbortError";
  const initial = await actual.lstat(selected);
  if (initial.isFile()) proof.declared = initial.size;
  mock.module("node:fs/promises", {
    namedExports: {
      mkdir: actual.mkdir,
      open: async (path, flags, ...rest) => {
        const selectedName = active && path === selected;
        const selectedContent =
          active && anchorFd !== undefined && path === "/proc/self/fd/" + anchorFd;
        const tracked = selectedName || selectedContent;
        if (tracked && (flags & O_PATH) === 0) proof.contentOpenAttempts++;
        const handle = await actual.open(path, flags, ...rest);
        if (!tracked) return handle;
        if (selectedName && anchorFd === undefined && (flags & O_PATH) !== 0) anchorFd = handle.fd;
        proof.acquired++;
        return new Proxy(handle, {
          get(target, key) {
            if (key === "read")
              return async (...args) => {
                proof.requested += args[2];
                proof.maxBuffer = Math.max(proof.maxBuffer, args[0].length);
                proof.readEnd = Math.max(proof.readEnd, args[1] + args[2]);
                if (scenario === "growth" && proof.growth === 0) {
                  proof.growth++;
                  await actual.appendFile(selected, Buffer.alloc(131072, 0x78));
                }
                if (scenario === "read-rejection" && proof.readRejection === 0) {
                  proof.readRejection++;
                  throw readError;
                }
                const observed = await target.read(...args);
                proof.returned += observed.bytesRead;
                return observed;
              };
            if (key === "close")
              return async () => {
                try {
                  return await target.close();
                } finally {
                  proof.closed++;
                  if (proof.closed === proof.acquired) active = false;
                }
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    },
  });
  process.argv = [process.execPath, helper, gateway, harness, selected, output];
  try {
    await import(pathToFileURL(helper).href);
  } catch (error) {
    proof.refused = true;
    proof.sameReadError = error === readError;
    proof.errorName = error?.name;
    proof.errorMessage = error?.message;
  } finally {
    mock.restoreAll();
  }
  process.stdout.write("INGRESS_PROBE " + JSON.stringify(proof) + "\n");
}

async function runCliIngress(f, scenario) {
  const selected = join(f.home, "selection.json");
  await writeFile(selected, JSON.stringify(f.selected));
  if (scenario === "directory") {
    await rm(selected);
    await mkdir(selected);
  } else if (scenario === "symlink") {
    await rm(selected);
    await symlink(join(f.roots.gateway, "payload", "entrypoint"), selected);
  }
  const helper = fileURLToPath(
    new URL("../../deploy/runtime/write-installed-renderer-behavior.mjs", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--input-type=module",
      "--eval",
      "(" + cliIngressProbe.toString() + ")()",
      helper,
      f.roots.gateway,
      f.roots.harness,
      selected,
      f.output,
      scenario,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "",
    oversized = false,
    expired = false;
  const capture = (key, chunk) => {
    if (key === "stdout") stdout += chunk.toString();
    else stderr += chunk.toString();
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 16384) {
      oversized = true;
      child.kill("SIGKILL");
    }
  };
  child.stdout.on("data", (b) => capture("stdout", b));
  child.stderr.on("data", (b) => capture("stderr", b));
  const timer = setTimeout(() => {
    expired = true;
    child.kill("SIGKILL");
  }, 10000);
  const closed = await new Promise((resolve) => {
    let launchError;
    child.on("error", (error) => {
      launchError = error;
    });
    child.on("close", (code, signal) => resolve({ code, signal, launchError }));
  });
  clearTimeout(timer);
  assert.equal(closed.launchError, undefined);
  assert.equal(oversized, false, "bounded probe output");
  assert.equal(expired, false, "probe closed within its finite test deadline");
  assert.equal(closed.signal, null, stderr);
  assert.equal(closed.code, 0, stderr);
  const lines = stdout.split("\n").filter((line) => line.startsWith("INGRESS_PROBE "));
  assert.equal(lines.length, 1, stdout + stderr);
  return JSON.parse(lines[0].slice("INGRESS_PROBE ".length));
}

test("CLI regular selection reads bounded real bytes and joins selection handles", async () => {
  const f = await fixture();
  try {
    const observed = await runCliIngress(f, "regular");
    assert.equal(observed.refused, false);
    assert.equal(observed.contentOpenAttempts, 1);
    assert.equal(observed.acquired, 3);
    assert.equal(observed.closed, observed.acquired);
    assert.equal(observed.returned, observed.declared);
    assert.equal(observed.readEnd, observed.declared + 1);
    assert.equal(observed.maxBuffer, observed.declared + 1);
    assert.equal((await readdir(join(f.output, "blobs", "sha256"))).length, 15);
  } finally {
    await f.close();
  }
});

test("CLI real selection growth after stat refuses within the declared plus-one bound", async () => {
  const f = await fixture();
  try {
    const observed = await runCliIngress(f, "growth");
    assert.equal(
      observed.growth,
      1,
      "actual file append occurred before the first actual content read",
    );
    assert.equal(observed.refused, true);
    assert.equal(observed.contentOpenAttempts, 1);
    assert.equal(observed.returned, observed.declared + 1);
    assert.equal(observed.requested, observed.declared + 1);
    assert.equal(observed.maxBuffer, observed.declared + 1);
    assert.equal(observed.acquired, 2);
    assert.equal(observed.closed, observed.acquired);
    await assert.rejects(readdir(f.output), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});

for (const kind of ["directory", "symlink"])
  test("CLI " + kind + " selection refuses before any endpoint content-open", async () => {
    const f = await fixture();
    try {
      const observed = await runCliIngress(f, kind);
      assert.equal(observed.refused, true);
      assert.equal(observed.contentOpenAttempts, 0);
      assert.equal(observed.acquired, 1);
      assert.equal(observed.closed, observed.acquired);
      assert.equal(observed.requested, 0);
      await assert.rejects(readdir(f.output), { code: "ENOENT" });
    } finally {
      await f.close();
    }
  });

test("CLI original read rejection is preserved after both selection handles close", async () => {
  const f = await fixture();
  try {
    const observed = await runCliIngress(f, "read-rejection");
    assert.equal(observed.readRejection, 1);
    assert.equal(observed.refused, true);
    assert.equal(observed.sameReadError, true);
    assert.equal(observed.errorName, "AbortError");
    assert.equal(observed.acquired, 2);
    assert.equal(observed.closed, observed.acquired);
    await assert.rejects(readdir(f.output), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});
