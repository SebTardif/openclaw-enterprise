import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const executableNames = ["runsc", "containerd-shim-runsc-v1"];
// The current upstream distribution requires these companions beside runsc.
// Updating this inventory requires reviewing the corresponding release layout.
const sidecarNames = [
  "gvisor-bin/checkpointgofer",
  "gvisor-bin/gvisor-sentry-prewarmer",
  "gvisor-bin/gvisor_sentry",
  "gvisor-bin/runsc-metric-server",
];
const artifactNames = [...executableNames, ...sidecarNames];
const versionFlags = ["--version", "-version", "-v"];
const runtimeName = "oce-gvisor-systrap";
const manifestLimit = 64 * 1024;
const artifactLimit = 256 * 1024 * 1024;
const distributionLimit = 512 * 1024 * 1024;

function exactKeys(value, expected, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...expected].sort().join(",")
  ) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}.`);
  }
}

function absolutePath(value, label) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    /[\x00-\x1f\x7f]/u.test(value) ||
    value.split("/").includes("..")
  ) {
    throw new Error(
      `${label} must be a normalized absolute local path without control characters.`,
    );
  }
  return value;
}

export function validateManifest(manifest) {
  exactKeys(manifest, ["schemaVersion", "releaseVersion", "artifacts"], "Manifest");
  if (manifest.schemaVersion !== 2) throw new Error("Manifest schemaVersion must be 2.");
  exactKeys(manifest.artifacts, artifactNames, "Manifest artifacts");
  for (const name of artifactNames) {
    const artifact = manifest.artifacts[name];
    exactKeys(
      artifact,
      executableNames.includes(name)
        ? ["path", "sha256", "version", "versionFlag", "versionOutput"]
        : ["path", "sha256"],
      name,
    );
    absolutePath(artifact.path, `${name} path`);
    if (!/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
      throw new Error(`${name} sha256 must be an explicit lowercase 64-character SHA256.`);
    }
    if (!executableNames.includes(name)) continue;
    if (
      typeof artifact.version !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(artifact.version) ||
      !/\d/u.test(artifact.version) ||
      /(?:^|[._+-])(?:latest|nightly|main|master|head|stable)(?:$|[._+-])/iu.test(artifact.version)
    ) {
      throw new Error(`${name} version must be an explicit immutable version, not a moving alias.`);
    }
    if (!versionFlags.includes(artifact.versionFlag)) {
      throw new Error(`${name} versionFlag must be --version, -version, or -v.`);
    }
    if (
      typeof artifact.versionOutput !== "string" ||
      artifact.versionOutput.length > 4096 ||
      /[^\x20-\x7e\n]/u.test(artifact.versionOutput) ||
      !artifact.versionOutput.split(/\s+/u).includes(artifact.version)
    ) {
      throw new Error(`${name} versionOutput must include the exact pinned version as a token.`);
    }
  }
  if (manifest.releaseVersion !== manifest.artifacts.runsc.version) {
    throw new Error("Manifest releaseVersion must equal the probed runsc version.");
  }
  if (
    new Set(artifactNames.map((name) => manifest.artifacts[name].path)).size !==
    artifactNames.length
  ) {
    throw new Error("All distribution members must be distinct local artifacts.");
  }
  return manifest;
}

async function rejectSymlinkComponents(path, { requireTraversable = false } = {}) {
  let current = parse(path).root;
  for (const component of path.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, component);
    const information = await lstat(current);
    if (information.isSymbolicLink()) {
      throw new Error(`Symbolic links are not accepted in local setup paths: ${current}`);
    }
    if (requireTraversable && (!information.isDirectory() || (information.mode & 0o001) === 0)) {
      throw new Error(
        `Prefix ancestors must be traversable by dropped runtime identities: ${current}`,
      );
    }
  }
}

async function readRegularFile(path, limit, consume) {
  await rejectSymlinkComponents(path);
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > BigInt(limit)) {
      throw new Error(
        `Local input must be a nonempty regular file of at most ${limit} bytes: ${path}`,
      );
    }
    const buffer = Buffer.alloc(1024 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) throw new Error(`Local input exceeded its size limit: ${path}`);
      await consume(buffer.subarray(0, bytesRead));
    }
    const after = await source.stat({ bigint: true });
    if (
      BigInt(total) !== before.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error(`Local input changed during verification: ${path}`);
    }
    return total;
  } finally {
    await source.close();
  }
}

async function copyVerifiedArtifact(artifact, destination, name) {
  const output = await open(destination, "wx", 0o400);
  const hash = createHash("sha256");
  try {
    const size = await readRegularFile(artifact.path, artifactLimit, async (chunk) => {
      hash.update(chunk);
      await output.writeFile(chunk);
    });
    if (hash.digest("hex") !== artifact.sha256) throw new Error(`${name} SHA256 mismatch.`);
    return size;
  } finally {
    await output.close();
  }
}

async function verifyVersion(artifact, path, name, cwd) {
  let result;
  try {
    result = await executeFile(path, [artifact.versionFlag], {
      cwd,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      timeout: 5000,
      killSignal: "SIGKILL",
      maxBuffer: 8192,
      encoding: "utf8",
    });
  } catch {
    throw new Error(`${name} version probe failed, timed out, or exceeded its output limit.`);
  }
  if (result.stderr !== "" || result.stdout.trimEnd() !== artifact.versionOutput.trimEnd()) {
    throw new Error(`${name} version output does not match its explicit manifest pin.`);
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderConfiguration(prefix) {
  absolutePath(prefix, "Prefix");
  const binary = shellQuote(join(prefix, "bin", "runsc"));
  return {
    "runsc-systrap": `#!/bin/sh
# OCI entrypoint for the verified local runsc. This does not install a runtime.
for argument do
  case "$argument" in
    --platform|--platform=*|-platform|-platform=*)
      printf '%s\\n' 'The development wrapper fixes --platform=systrap; platform overrides are rejected.' >&2
      exit 64
      ;;
    --sidecar-usage-policy|--sidecar-usage-policy=*|-sidecar-usage-policy|-sidecar-usage-policy=*)
      printf '%s\\n' 'The development wrapper fixes --sidecar-usage-policy=STRICT; sidecar policy overrides are rejected.' >&2
      exit 64
      ;;
  esac
done
exec ${binary} --platform=systrap --sidecar-usage-policy=STRICT "$@"
`,
    "runtimeclass.yaml": `# Apply only after the operator configures this handler in a disposable cluster.
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: ${runtimeName}
handler: ${runtimeName}
`,
  };
}

export async function prepareDevelopmentRuntime({ manifestPath, prefix }) {
  if (process.platform !== "linux")
    throw new Error("This offline development helper requires Linux.");
  absolutePath(manifestPath, "Manifest path");
  absolutePath(prefix, "Prefix");
  const parent = dirname(prefix);
  if (prefix === parent) throw new Error("Prefix must name a new isolated directory, not a root.");
  await rejectSymlinkComponents(parent, { requireTraversable: true });
  if ((await realpath(parent)) !== parent) throw new Error("Prefix parent must be canonical.");
  try {
    await lstat(prefix);
    throw new Error("Prefix already exists; refusing to overwrite any existing path.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const chunks = [];
  await readRegularFile(manifestPath, manifestLimit, async (chunk) =>
    chunks.push(Buffer.from(chunk)),
  );
  let manifest;
  try {
    manifest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Manifest must be valid JSON.");
  }
  validateManifest(manifest);
  const staging = await mkdtemp(join(parent, ".oce-gvisor-prepare-"));
  await chmod(staging, 0o700);
  try {
    await mkdir(join(staging, "gvisor-bin"), { mode: 0o700 });
    // A probe can load companion programs. Check the complete distribution first.
    let totalSize = 0;
    for (const name of artifactNames) {
      totalSize += await copyVerifiedArtifact(manifest.artifacts[name], join(staging, name), name);
      if (totalSize > distributionLimit)
        throw new Error("Distribution exceeds its 512 MiB size limit.");
    }
    for (const name of artifactNames) await chmod(join(staging, name), 0o500);
    for (const name of executableNames) {
      await verifyVersion(manifest.artifacts[name], join(staging, name), name, staging);
      // Do not execute the next probe if this one changed any distribution member.
      for (const member of artifactNames) {
        const hash = createHash("sha256");
        await readRegularFile(join(staging, member), artifactLimit, async (chunk) =>
          hash.update(chunk),
        );
        if (hash.digest("hex") !== manifest.artifacts[member].sha256) {
          throw new Error(`${member} changed during distribution version probes.`);
        }
      }
    }
    const configuration = renderConfiguration(prefix);
    const verification = {
      schemaVersion: 2,
      releaseVersion: manifest.releaseVersion,
      status: "prepared-only",
      runtimeVerified: false,
      runtimeHandlerConfigured: false,
      runtimeClassName: runtimeName,
      platform: "systrap",
      sidecarUsagePolicy: "STRICT",
      checksumTrust:
        "Operator-provided SHA256 pins; upstream provenance must be verified separately.",
      requiredOperatorStep:
        "Verify handler registration against the installed containerd and distribution versions in an isolated cluster; register oce-gvisor-systrap using the staged runsc with explicit systrap and STRICT sidecar usage while preserving the existing runc default. No containerd configuration is generated or applied.",
      artifacts: Object.fromEntries(
        artifactNames.map((name) => [
          name,
          {
            sha256: manifest.artifacts[name].sha256,
            version: manifest.artifacts[name].version,
            versionFlag: manifest.artifacts[name].versionFlag,
            versionOutput: manifest.artifacts[name].versionOutput,
          },
        ]),
      ),
    };
    // mkdir is exclusive. A concurrent creator cannot make us replace an existing prefix.
    await mkdir(prefix, { mode: 0o700 });
    await mkdir(join(prefix, "bin"), { mode: 0o700 });
    await mkdir(join(prefix, "config"), { mode: 0o700 });
    await mkdir(join(prefix, "bin", "gvisor-bin"), { mode: 0o700 });
    for (const name of artifactNames) {
      // Reverify the exact bytes copied into each exclusive final destination.
      await copyVerifiedArtifact(
        { ...manifest.artifacts[name], path: join(staging, name) },
        join(prefix, "bin", name),
        name,
      );
      await chmod(join(prefix, "bin", name), 0o555);
    }
    for (const [name, content] of Object.entries(configuration)) {
      const path = join(prefix, name === "runsc-systrap" ? "bin" : "config", name);
      const mode = name === "runsc-systrap" ? 0o555 : 0o444;
      await writeFile(path, content, { flag: "wx", mode });
      await chmod(path, mode);
    }
    await writeFile(
      join(prefix, "verification.json"),
      `${JSON.stringify(verification, null, 2)}\n`,
      {
        flag: "wx",
        mode: 0o444,
      },
    );
    await chmod(join(prefix, "verification.json"), 0o444);
    // Publish access last. Dropped identities can traverse/read/execute, but cannot write.
    for (const directory of [
      join(prefix, "bin", "gvisor-bin"),
      join(prefix, "bin"),
      join(prefix, "config"),
      prefix,
    ]) {
      await chmod(directory, 0o755);
    }
    return { prefix, ...verification };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

const help = `Prepare verified, operator-supplied local gVisor artifacts (Alpha support).
Usage: node scripts/gvisor-development-setup.mjs --manifest /absolute/manifest.json --prefix /absolute/new-prefix

No downloads, installation commands, daemon changes, container execution, or cluster mutations are performed.
The prefix must not exist; its ancestors must exist and allow traversal by dropped runtime identities.
Symlink paths are rejected. Output directories are 0755, programs 0555, and data files 0444.
The manifest is JSON with schemaVersion: 2, releaseVersion, and artifacts.
Artifacts must contain exactly runsc, containerd-shim-runsc-v1, and these four companions:
gvisor-bin/checkpointgofer, gvisor-bin/gvisor-sentry-prewarmer, gvisor-bin/gvisor_sentry,
and gvisor-bin/runsc-metric-server. Each companion requires only an absolute path and SHA256 pin.
Each main executable requires: path (absolute local file), sha256 (lowercase 64-character pin),
version (immutable version), versionFlag (--version, -version, or -v), and versionOutput
(exact expected stdout containing that version as a separate token).
releaseVersion must equal runsc's reported version. The shim reports its own containerd build version,
which need not equal the gVisor release; record the actual output (normally using -v).
Obtain pins and expected version output from your trusted release provenance; this helper supplies none.
All six hashes are checked before bounded version probes and rechecked afterward.
The complete gvisor-bin directory is preserved beside runsc; no legacy or embedded fallback is supplied.
Prepared files and version probes do not prove that gVisor can run a workload.
No containerd configuration is generated: its version-specific contract was not verified offline.
The operator must verify handler registration against the installed containerd/distribution versions
in an isolated cluster, register oce-gvisor-systrap with this prefix's runsc and explicit systrap,
and preserve the existing runc default. The RuntimeClass manifest is a nonapplied candidate only.
Use bin/runsc-systrap as the explicit OCI entrypoint; it fixes STRICT sidecar usage and rejects caller-supplied platform/sidecar-policy overrides.
If publishing fails after exclusive prefix creation, inspect the incomplete prefix; it is never overwritten or removed.
`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") {
      process.stdout.write(help);
    } else {
      if (args.length !== 4 || args[0] !== "--manifest" || args[2] !== "--prefix") {
        throw new Error(help);
      }
      const result = await prepareDevelopmentRuntime({ manifestPath: args[1], prefix: args[3] });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`Offline gVisor preparation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
