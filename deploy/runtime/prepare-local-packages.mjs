#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const LOCAL_PACKAGES = [
  "openclaw",
  "@openclaw/ai",
  "@openclaw/slack",
  "@openclaw/msteams",
  "@openclaw/codex",
];
const SCHEMA = "oce.runtime-packages/v1";
const NATIVE_VERSION = "0.153.0";
const hash = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

function safePath(value) {
  assert.equal(typeof value, "string", "A relative package path is required.");
  assert.ok(value && !value.includes("\\") && !value.includes("\0") && !isAbsolute(value));
  assert.ok(
    value.split("/").every((part) => part && part !== "." && part !== ".."),
    "Unsafe package path.",
  );
  return value;
}

async function regularFile(root, name) {
  safePath(name);
  const target = join(root, name);
  const stat = await lstat(target);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Expected a regular file.");
  assert.equal(await realpath(target), target, "Package inputs must not traverse symlinks.");
  return target;
}

async function verifiedInput(record) {
  assert.ok(record && isAbsolute(record.path) && /^[a-f0-9]{64}$/.test(record.sha256));
  const stat = await lstat(record.path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Expected an immutable regular input file.");
  const bytes = await readFile(record.path);
  assert.equal(hash(bytes), record.sha256, `Input digest mismatch: ${record.path}`);
  return bytes;
}

async function inventory(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), "Prepared payloads must not contain symlinks.");
      if (entry.isDirectory()) await walk(path);
      else {
        assert.ok(entry.isFile(), "Unsupported prepared file type.");
        const bytes = await readFile(path);
        files.push({
          path: relative(root, path).split(sep).join("/"),
          bytes: bytes.length,
          sha256: hash(bytes),
          mode: (await lstat(path)).mode & 0o777,
        });
      }
    }
  }
  await walk(root);
  return files;
}

export function assertLocalGraph(
  manifest,
  lock,
  packages,
  registry = "https://registry.npmjs.org/",
) {
  const registryUrl = new URL(registry);
  assert.ok(
    registryUrl.protocol === "https:" &&
      !registryUrl.username &&
      !registryUrl.password &&
      !registryUrl.search &&
      !registryUrl.hash &&
      registryUrl.pathname.endsWith("/"),
    "A configured HTTPS registry is required.",
  );
  assert.deepEqual(
    packages.map((entry) => entry.name).sort(),
    [...LOCAL_PACKAGES].sort(),
    "Exactly five local SDK packages are required.",
  );
  assert.equal(manifest.dependencies?.["@openai/codex"], NATIVE_VERSION);
  assert.equal(lock.packages?.["node_modules/@openai/codex"]?.version, NATIVE_VERSION);
  for (const entry of packages) {
    safePath(entry.archive);
    assert.ok(entry.archive.startsWith("artifacts/") && entry.archive.endsWith(".tgz"));
    assert.equal(manifest.dependencies?.[entry.name], `file:./${entry.archive}`);
    const local = lock.packages?.[`node_modules/${entry.name}`];
    assert.ok(local && local.link !== true, "Local package must be installed from its archive.");
    assert.equal(local.name ?? entry.name, entry.name);
    assert.equal(local.version, entry.version);
    assert.equal(local.resolved, `file:${entry.archive}`);
    assert.equal(local.integrity, entry.integrity);
  }
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path) continue;
    safePath(path);
    assert.ok(path.startsWith("node_modules/"), "Unexpected installed package path.");
    assert.ok(entry.link !== true, "Source/workspace links are forbidden in the image lock.");
    const pathName = path.split("node_modules/").at(-1);
    const local = packages.find((item) => item.name === pathName || item.name === entry.name);
    if (local)
      assert.equal(
        path,
        `node_modules/${local.name}`,
        "Nested or registry SDK substitutions are forbidden.",
      );
    else
      assert.ok(
        typeof entry.resolved === "string" &&
          new URL(entry.resolved).href.startsWith(registryUrl.href),
        "Only the configured registry's locked tarballs and the five local artifacts are allowed.",
      );
  }
}

export async function verifyContext(directory) {
  assert.ok(isAbsolute(directory), "Prepared context must be an absolute path.");
  const root = await realpath(directory);
  assert.equal(root, directory, "Prepared context must not be a symlink.");
  const receipt = await json(await regularFile(root, "preparation.json"));
  assert.equal(receipt.schema, SCHEMA);
  assert.equal(receipt.status, "prepared");
  assert.equal(receipt.platform, "linux/amd64");
  assert.equal(receipt.nativeCodexVersion, NATIVE_VERSION);
  assert.ok(Array.isArray(receipt.files) && Array.isArray(receipt.packages));
  const names = new Set();
  for (const entry of receipt.files) {
    assert.ok(!names.has(entry.path), "Duplicate prepared file.");
    names.add(entry.path);
    const bytes = await readFile(await regularFile(root, entry.path));
    assert.equal(bytes.length, entry.bytes, `Prepared file length mismatch: ${entry.path}`);
    assert.equal(hash(bytes), entry.sha256, `Prepared file digest mismatch: ${entry.path}`);
  }
  for (const name of [
    "package.json",
    "package-lock.json",
    ...receipt.packages.map((entry) => entry.archive),
  ])
    assert.ok(names.has(name), `Missing prepared file: ${name}`);
  async function checkUnlisted(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join("/");
      if (
        directory === root &&
        (entry.name === ".work" ||
          entry.name === "node_modules" ||
          entry.name.endsWith(".log") ||
          entry.name === "preparation.json")
      )
        continue;
      assert.ok(!entry.isSymbolicLink(), "Unexpected context symlink.");
      if (entry.isDirectory()) await checkUnlisted(path);
      else assert.ok(entry.isFile() && names.has(name), `Unlisted context file: ${name}`);
    }
  }
  await checkUnlisted(root);
  for (const entry of receipt.packages) {
    assert.equal(
      `sha512-${hash(await readFile(join(root, entry.archive)), "sha512", "base64")}`,
      entry.integrity,
    );
  }
  assertLocalGraph(
    await json(join(root, "package.json")),
    await json(join(root, "package-lock.json")),
    receipt.packages,
    receipt.registry,
  );
  return receipt;
}

export function normalizeRuntimeManifest(original, localVersions) {
  const manifest = structuredClone(original);
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    const prefix = "node scripts/crabbox-wrapper.mjs";
    if (command === prefix || command.startsWith(`${prefix} `))
      manifest.scripts[name] = `node dist/crabbox-wrapper.js${command.slice(prefix.length)}`;
  }
  // Match upstream prepack sanitation without invoking source lifecycle scripts.
  if (manifest.devDependencies)
    manifest.devDependencies = Object.fromEntries(
      Object.entries(manifest.devDependencies).filter(([, spec]) => !spec.startsWith("workspace:")),
    );
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      if (spec.startsWith("workspace:") && localVersions[name])
        manifest[field][name] = localVersions[name];
      else
        assert.ok(
          !/^(?:workspace:|file:|link:|git|https?:|\.\/|\.\.\/|\/)/.test(spec),
          `Unsupported package dependency: ${name}`,
        );
    }
  }
  return manifest;
}

async function materializePackage(tools, input, output, versions) {
  const bytes = await verifiedInput(input);
  const expected = JSON.parse(await verifiedInput(input.inventory));
  const label = input.name.replace(/^@/, "").replaceAll("/", "-");
  const destination = join(output, ".work", label);
  await mkdir(destination, { recursive: true });
  const seen = new Set();
  await tools.tar.t({
    file: input.path,
    strict: true,
    onReadEntry(entry) {
      const path = entry.path.replace(/^\.\//, "").replace(/\/$/, "");
      if (!path && entry.type === "Directory") return;
      safePath(path);
      assert.ok(
        entry.type === "File" || entry.type === "Directory",
        "Archive links and special entries are forbidden.",
      );
      assert.ok(!seen.has(path), "Duplicate archive member.");
      seen.add(path);
    },
  });
  await tools.tar.x({ file: input.path, cwd: destination, strict: true, preservePaths: false });
  const before = await inventory(destination);
  const stripped = (items) =>
    items
      .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
      .sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(
    stripped(before),
    stripped(expected),
    `Archive inventory mismatch: ${input.name}`,
  );
  const original = await json(join(destination, "package.json"));
  assert.equal(original.name, input.name);
  assert.equal(original.version, input.version);
  const manifest = normalizeRuntimeManifest(original, versions);
  await writeFile(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const entry of before)
    await chmod(join(destination, entry.path), entry.mode & 0o111 ? 0o755 : 0o644);
  const after = await inventory(destination);
  assert.deepEqual(
    before.map((entry) => entry.path),
    after.map((entry) => entry.path),
  );
  for (let i = 0; i < before.length; i++)
    if (before[i].path !== "package.json") assert.equal(before[i].sha256, after[i].sha256);
  const archive = `artifacts/${label}.tgz`;
  await tools.tar.c(
    {
      file: join(output, archive),
      cwd: destination,
      prefix: "package",
      gzip: true,
      portable: true,
      noMtime: true,
    },
    ["."],
  );
  const packed = await readFile(join(output, archive));
  return {
    name: input.name,
    version: input.version,
    archive,
    integrity: `sha512-${hash(packed, "sha512", "base64")}`,
    sourceArchiveSha256: hash(bytes),
    preparedArchiveSha256: hash(packed),
    before,
    after,
    originalManifest: original,
    preparedManifest: manifest,
  };
}

function npmEnvironment() {
  // Keep the existing package registry and transport configuration. Provider
  // credentials are not forwarded, and no host npm configuration is copied.
  const names = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "NODE_USE_ENV_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NPM_CONFIG_REGISTRY",
    "npm_config_registry",
    "NPM_CONFIG_PROXY",
    "npm_config_proxy",
    "NPM_CONFIG_HTTP_PROXY",
    "npm_config_http_proxy",
    "NPM_CONFIG_HTTPS_PROXY",
    "npm_config_https_proxy",
    "NPM_CONFIG_NOPROXY",
    "npm_config_noproxy",
    "NPM_CONFIG_USERCONFIG",
    "npm_config_userconfig",
  ];
  return {
    ...Object.fromEntries(
      names
        .filter((name) => process.env[name] !== undefined)
        .map((name) => [name, process.env[name]]),
    ),
    PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
    LANG: "C.UTF-8",
    NODE_ENV: "production",
    npm_config_update_notifier: "false",
  };
}

function configuredRegistry(cwd) {
  const result = spawnSync("npm", ["config", "get", "registry"], {
    cwd,
    env: npmEnvironment(),
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, 0, "Unable to read the existing npm registry setting.");
  const registry = new URL(result.stdout.trim());
  assert.ok(
    registry.protocol === "https:" &&
      !registry.username &&
      !registry.password &&
      !registry.search &&
      !registry.hash,
    "Configured registry must use HTTPS without embedded credentials.",
  );
  return registry.href.endsWith("/") ? registry.href : `${registry.href}/`;
}

function runNpm(args, cwd, cache, logPath) {
  const result = spawnSync("npm", [...args, "--cache", cache], {
    cwd,
    env: npmEnvironment(),
    encoding: "utf8",
    timeout: 10 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return writeFile(
    logPath,
    `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\nProcess error: ${result.error.code ?? "unknown"}\n` : ""}`,
  ).then(() => {
    assert.equal(result.status, 0, `npm ${args[0]} failed; inspect ${logPath}.`);
  });
}

export async function preparePackages(inputPath, directory) {
  assert.ok(isAbsolute(directory), "Output must be an absolute new directory.");
  const input = await json(inputPath);
  assert.equal(input.schema, "oce.runtime-package-inputs/v1");
  assert.equal(input.platform, "linux/amd64");
  assert.equal(input.nativeCodexVersion, NATIVE_VERSION);
  assert.deepEqual(input.packages.map((entry) => entry.name).sort(), [...LOCAL_PACKAGES].sort());
  // Verify every caller-selected immutable input before creating any preparation state.
  for (const item of [
    input.tooling,
    input.policy.lockfile,
    input.policy.workspace,
    ...input.packages,
    ...input.packages.map((entry) => entry.inventory),
  ])
    await verifiedInput(item);
  await mkdir(directory, { recursive: false });
  assert.equal(await realpath(directory), directory);
  for (const child of ["artifacts", "policy", ".work", "cache"])
    await mkdir(join(directory, child));
  await writeFile(
    join(directory, "policy", "pnpm-lock.yaml"),
    await verifiedInput(input.policy.lockfile),
  );
  await writeFile(
    join(directory, "policy", "pnpm-workspace.yaml"),
    await verifiedInput(input.policy.workspace),
  );
  await writeFile(
    join(directory, ".work", "package-tools.mjs"),
    await verifiedInput(input.tooling),
  );
  process.env.OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT = join(directory, "policy");
  const tools = await import(pathToFileURL(join(directory, ".work", "package-tools.mjs")).href);
  const workspace = tools.parseYaml(
    await readFile(join(directory, "policy", "pnpm-workspace.yaml"), "utf8"),
  );
  const versions = Object.fromEntries(input.packages.map((entry) => [entry.name, entry.version]));
  const packages = [];
  for (const entry of input.packages)
    packages.push(await materializePackage(tools, entry, directory, versions));
  const artifacts = packages.map(({ name, version, archive, integrity }) => ({
    name,
    version,
    spec: `file:./${archive}`,
    integrity,
  }));
  const wrapper = {
    name: "oce-local-runtime",
    version: "0.0.0",
    private: true,
    dependencies: {
      ...Object.fromEntries(artifacts.map((entry) => [entry.name, entry.spec])),
      "@openai/codex": NATIVE_VERSION,
    },
  };
  const overrides = tools.readNpmLockOverrides();
  const manifest = tools.packageJsonForNpmLock(wrapper, overrides, artifacts);
  await save(join(directory, "package.json"), manifest);
  await writeFile(join(directory, "empty.npmrc"), "");
  await writeFile(join(directory, "empty-global.npmrc"), "");
  const registry = configuredRegistry(directory);
  await runNpm(
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    directory,
    join(directory, "cache"),
    join(directory, "lock-generation.log"),
  );
  const lock = tools.normalizeNpmVersionDrift(
    tools.applyPackageExtensionPeerMetadata(await json(join(directory, "package-lock.json"))),
  );
  assertLocalGraph(manifest, lock, packages, registry);
  // Local workspace packages are absent from pnpm's registry keys. Validate their
  // exact archive bindings above, then retain upstream validation for every registry entry.
  const registryLock = {
    ...lock,
    packages: Object.fromEntries(
      Object.entries(lock.packages).filter(
        ([path]) => !LOCAL_PACKAGES.some((name) => path === `node_modules/${name}`),
      ),
    ),
  };
  const violations = tools.collectPnpmLockViolations(registryLock);
  assert.deepEqual(
    violations,
    [],
    `Resolved registry dependencies violate frozen pnpm policy: ${JSON.stringify(violations.slice(0, 5))}`,
  );
  await writeFile(join(directory, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  const patchMatches = Object.entries(workspace.patchedDependencies ?? {}).filter(([key]) =>
    Object.entries(lock.packages).some(
      ([path, entry]) =>
        `${entry.name ?? path.split("node_modules/").at(-1)}@${entry.version}` === key,
    ),
  );
  assert.deepEqual(
    patchMatches,
    [],
    "This closure requires a frozen patch; supply an explicit supported patch preparation before building.",
  );
  await runNpm(
    ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    directory,
    join(directory, "cache"),
    join(directory, "cache-population.log"),
  );
  const lifecycle = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    let packageJson;
    try {
      packageJson = await json(join(directory, path, "package.json"));
    } catch (error) {
      if (error.code === "ENOENT" && entry.optional) continue;
      throw error;
    }
    const scripts = Object.fromEntries(
      Object.entries(packageJson.scripts ?? {}).filter(([name]) =>
        ["preinstall", "install", "postinstall"].includes(name),
      ),
    );
    if (Object.keys(scripts).length)
      lifecycle.push({
        path,
        name: packageJson.name,
        version: packageJson.version,
        scripts,
        approved: workspace.allowBuilds?.[packageJson.name] === true,
      });
  }
  await save(join(directory, "lifecycle.json"), {
    policy: input.policy.workspace,
    packages: lifecycle,
    execution:
      "Installation uses --ignore-scripts. Required approved lifecycle actions must be selected explicitly in the image recipe.",
  });
  await save(join(directory, "package-inventories.json"), packages);
  await save(join(directory, "inputs.json"), input);
  await copyFile(fileURLToPath(import.meta.url), join(directory, "verify-context.mjs"));
  await writeFile(join(directory, ".dockerignore"), ".work\nnode_modules\n*.log\n");
  const files = [];
  for (const name of [
    "package.json",
    "package-lock.json",
    "lifecycle.json",
    "package-inventories.json",
    "inputs.json",
    "verify-context.mjs",
    ".dockerignore",
    "empty.npmrc",
    "empty-global.npmrc",
    ...packages.map((entry) => entry.archive),
  ]) {
    const bytes = await readFile(join(directory, name));
    files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
  }
  for (const prefix of ["cache", "policy"])
    for (const entry of await inventory(join(directory, prefix)))
      files.push({ ...entry, path: `${prefix}/${entry.path}` });
  const receipt = {
    schema: SCHEMA,
    status: "prepared",
    platform: input.platform,
    nativeCodexVersion: NATIVE_VERSION,
    registry,
    provenance: input.provenance,
    packages: packages.map(({ name, version, archive, integrity }) => ({
      name,
      version,
      archive,
      integrity,
    })),
    files,
    lifecycleActionsExecuted: [],
    registryPolicyViolations: [],
    applicablePatches: [],
  };
  await save(join(directory, "preparation.json"), receipt);
  for (const entry of input.packages) await verifiedInput(entry);
  await verifyContext(directory);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 2 && args[0] === "--verify-context") await verifyContext(args[1]);
    else if (args.length === 4 && args[0] === "--inputs" && args[2] === "--output")
      await preparePackages(resolve(args[1]), args[3]);
    else
      throw new Error(
        "Usage: node deploy/runtime/prepare-local-packages.mjs --inputs <inputs.json> --output <new-absolute-directory> | --verify-context <absolute-directory>",
      );
    console.log("Runtime package context verified.");
  } catch (error) {
    console.error(`Runtime package preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
