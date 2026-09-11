import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

const names = [
  "openclaw",
  "@openclaw/ai",
  "@openclaw/slack",
  "@openclaw/msteams",
  "@openclaw/codex",
];
const version = "2026.8.1";
const digest = (content, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(content).digest(encoding);
const integrity = (content) => `sha512-${digest(content, "sha512", "base64")}`;
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "oce-package-preparation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// These are real small USTAR archives used as package-preparation inputs. They do
// not contain an OpenClaw runtime and do not establish image qualification.
function archiveBytes(members) {
  const blocks = [];
  for (const { path, content = "", type = "0", link = "" } of members) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    assert.ok(Buffer.byteLength(path) < 100 && Buffer.byteLength(link) < 100);
    header.write(path, 0, 100);
    header.write("0000644\0", 100, 8);
    header.write("0000000\0", 108, 8);
    header.write("0000000\0", 116, 8);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    header.write("00000000000\0", 136, 12);
    header.fill(32, 148, 156);
    header.write(type, 156, 1);
    header.write(link, 157, 100);
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function packageMembers(name) {
  return [
    { path: "package.json", content: jsonBytes({ name, version, type: "module" }) },
    { path: "index.js", content: "export const packagePreparationFixture = true;\n" },
  ];
}

function graphFixture(registry = "https://registry.npmjs.org/") {
  const manifest = {
    name: "oce-local-runtime",
    version: "0.0.0",
    private: true,
    dependencies: { "@openai/codex": "0.153.0" },
  };
  const lock = {
    lockfileVersion: 3,
    packages: {
      "node_modules/@openai/codex": {
        version: "0.153.0",
        resolved: new URL("@openai/codex/-/codex-0.153.0.tgz", registry).href,
        integrity: integrity("native lock metadata fixture"),
      },
    },
  };
  const archives = new Map();
  const packages = names.map((name) => {
    const archive = `artifacts/${name.replace(/^@/, "").replaceAll("/", "-")}.tgz`;
    const bytes = archiveBytes(packageMembers(name));
    archives.set(archive, bytes);
    const entry = { name, version, archive, integrity: integrity(bytes) };
    manifest.dependencies[name] = `file:./${archive}`;
    lock.packages[`node_modules/${name}`] = {
      name,
      version,
      resolved: `file:${archive}`,
      integrity: entry.integrity,
    };
    return entry;
  });
  lock.packages[""] = structuredClone(manifest);
  return { manifest, lock, packages, archives };
}

async function preparedFixture(t, registry) {
  const directory = await temporaryDirectory(t);
  const context = join(directory, "context");
  const graph = graphFixture(registry);
  const contents = new Map([
    ...graph.archives,
    ["package.json", jsonBytes(graph.manifest)],
    ["package-lock.json", jsonBytes(graph.lock)],
    [
      "lifecycle.json",
      jsonBytes({
        packages: [],
        execution: "No lifecycle scripts in this receipt-verification fixture.",
      }),
    ],
    ["package-inventories.json", jsonBytes([])],
    ["inputs.json", jsonBytes({ fixture: "receipt verification only" })],
    [".dockerignore", Buffer.from(".work\nnode_modules\n*.log\n")],
    ["empty.npmrc", Buffer.alloc(0)],
    ["empty-global.npmrc", Buffer.alloc(0)],
    ["policy/pnpm-lock.yaml", Buffer.from("lockfileVersion: '9.0'\n")],
    ["policy/pnpm-workspace.yaml", Buffer.from("{}\n")],
    ["cache/receipt-fixture", Buffer.from("Cache receipt verification fixture.\n")],
  ]);
  for (const [path, bytes] of contents) {
    await mkdir(dirname(join(context, path)), { recursive: true });
    await writeFile(join(context, path), bytes);
  }
  const receipt = {
    schema: "oce.runtime-packages/v1",
    status: "prepared",
    platform: "linux/amd64",
    nativeCodexVersion: "0.153.0",
    ...(registry === undefined ? {} : { registry }),
    packages: graph.packages,
    files: [...contents].map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: digest(bytes),
    })),
    lifecycleActionsExecuted: [],
    registryPolicyViolations: [],
    applicablePatches: [],
  };
  await writeFile(join(context, "preparation.json"), jsonBytes(receipt));
  return { directory, context, receipt, contents };
}

export {
  archiveBytes,
  digest,
  graphFixture,
  integrity,
  jsonBytes,
  names,
  packageMembers,
  preparedFixture,
  temporaryDirectory,
  version,
};
