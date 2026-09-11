import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, realpathSync, statSync } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const nativeRoot = join(repositoryRoot, "dataplane");
const outputRoot = join(repositoryRoot, ".build/mvp");
const nativeManifestPath = join(outputRoot, "native-manifest.json");
const builtNativeProducts = [];
const stagedNativeIdentities = [];
const nativeMembers = [
  "ds-contracts",
  "policy-core",
  "ds-policy-snapshot",
  "ds-telemetry",
  "ds-admission-shm",
  "ds-nft",
  "ds-dnsgate",
  "ds-tlsproxy",
  "oce-native-egress",
  "oce-network-fence",
];
const nativePackagePaths = nativeMembers.map((name) =>
  join(
    "dataplane",
    ["ds-dnsgate", "ds-tlsproxy", "oce-native-egress", "oce-network-fence"].includes(name)
      ? "services"
      : "crates",
    name,
  ),
);
const nativeProducts = [
  { package: "ds-dnsgate", binary: "oce-dnsgate" },
  { package: "ds-tlsproxy", binary: "oce-egress" },
];

export class CommandFailure extends Error {
  constructor(message, exitCode = 1, signal = null) {
    super(message);
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

// All commands use argv directly. Forward cancellation to the process group so
// Cargo's compiler children cannot keep building after the caller interrupts.
export function runCommand(
  command,
  args,
  { cwd = repositoryRoot, env = process.env, capture = false } = {},
) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    let output = "";
    let interrupted = null;
    let outputTooLarge = false;
    let killTimer;
    const kill = (signal) => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") reject(error);
      }
    };
    const interrupt = (signal) => {
      interrupted ??= signal;
      kill(signal);
      killTimer ??= setTimeout(() => kill("SIGKILL"), 5_000).unref();
    };
    const onInterrupt = () => interrupt("SIGINT");
    const onTerminate = () => interrupt("SIGTERM");
    const cleanup = () => {
      clearTimeout(killTimer);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    child.stdout?.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
      if (output.length > 4 * 1024 * 1024) {
        outputTooLarge = true;
        kill("SIGKILL");
      }
    });
    child.once("error", (error) => {
      cleanup();
      reject(new CommandFailure(`Cannot run ${command}: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      // The tool can exit before a compiler/helper descendant. Once the tool
      // has stopped after cancellation, do not leave that group running.
      if (interrupted !== null) kill("SIGKILL");
      cleanup();
      const failedSignal = interrupted ?? signal;
      if (outputTooLarge) reject(new CommandFailure(`${command} exceeded its output limit.`));
      else if (failedSignal !== null) {
        reject(new CommandFailure(`${command} stopped by ${failedSignal}.`, 1, failedSignal));
      } else if (code !== 0)
        reject(new CommandFailure(`${command} exited with status ${code}.`, code ?? 1));
      else resolveCommand(output);
    });
  });
}

export async function verifyFile(path, { executable = false } = {}) {
  const info = await lstat(path).catch(() => {
    throw new Error(`Required build file is missing: ${path}`);
  });
  if (!info.isFile() || info.size === 0)
    throw new Error(`Expected a nonempty regular file: ${path}`);
  if (executable) await access(path, fsConstants.X_OK);
}

const maxNativeBytes = 128 * 1024 * 1024;
const identityFields = ["dev", "ino", "size", "mode", "uid", "gid", "nlink", "mtimeNs", "ctimeNs"];
const sameFile = (before, after) => identityFields.every((key) => before[key] === after[key]);
const fileMode = (info) => (info.mode & 0o7777n).toString(8).padStart(4, "0");

async function unchangedFile(path, file, before) {
  if (
    (await realpath(path)) !== path ||
    !sameFile(before, await file.stat({ bigint: true })) ||
    !sameFile(before, await lstat(path, { bigint: true }))
  )
    throw new Error(`Build input changed during capture: ${path}`);
}

async function openBuildInput(path, maxBytes, executable = false) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > maxNativeBytes)
    throw new Error("Invalid build input byte limit.");
  if (!isAbsolute(path) || (await realpath(path)) !== path)
    throw new Error(`Build input must be canonical and must not traverse links: ${path}`);
  // NONBLOCK prevents a replaced FIFO from hanging before its type is checked.
  const file = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || (executable && before.size === 0n))
      throw new Error(`Expected a ${executable ? "nonempty " : ""}regular build input: ${path}`);
    if (before.size > BigInt(maxBytes))
      throw new Error(`Build input exceeds its byte limit: ${path}`);
    if (executable) {
      if (before.uid !== 0n && before.uid !== BigInt(process.getuid()))
        throw new Error(`Native artifact must be owned by root or the current user: ${path}`);
      if ((before.mode & 0o7022n) !== 0n)
        throw new Error(`Native artifact has unsafe write or special mode bits: ${path}`);
      // Linux procfs resolves this access check to the open file, even if its
      // original pathname is replaced. No artifact is executed by this check.
      await access(`/proc/self/fd/${file.fd}`, fsConstants.X_OK);
    }
    await unchangedFile(path, file, before);
    return { file, before };
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function hashFileBytes(file, size, destination) {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  while (position < size) {
    const { bytesRead } = await file.read(
      buffer,
      0,
      Math.min(buffer.length, size - position),
      position,
    );
    if (bytesRead === 0) throw new Error("Build input was truncated during capture.");
    hash.update(buffer.subarray(0, bytesRead));
    if (destination) {
      let offset = 0;
      while (offset < bytesRead) {
        const { bytesWritten } = await destination.write(
          buffer,
          offset,
          bytesRead - offset,
          position + offset,
        );
        if (bytesWritten === 0) throw new Error("Native artifact staging made no progress.");
        offset += bytesWritten;
      }
    }
    position += bytesRead;
  }
  if ((await file.read(buffer, 0, 1, position)).bytesRead !== 0)
    throw new Error("Build input grew during capture.");
  return hash.digest("hex");
}

async function captureBuildFile(path, maxBytes) {
  const { file, before } = await openBuildInput(path, maxBytes);
  try {
    const sha256 = await hashFileBytes(file, Number(before.size));
    await unchangedFile(path, file, before);
    return {
      sha256,
      size: Number(before.size),
      identity: identityFields.map((key) => String(before[key])),
    };
  } finally {
    await file.close();
  }
}

export async function stageNativeArtifact(source, output, { maxBytes = maxNativeBytes } = {}) {
  if (process.platform !== "linux") throw new Error("Native artifact staging requires Linux.");
  if (
    !isAbsolute(output) ||
    join(await realpath(dirname(output)), relative(dirname(output), output)) !== output
  )
    throw new Error("Native staging output must have a canonical parent directory.");
  const { file, before } = await openBuildInput(source, maxBytes, true);
  let staged;
  let created;
  let complete = false;
  try {
    // Exclusive creation never follows or replaces an existing destination.
    staged = await open(
      output,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR,
      0o600,
    );
    created = await staged.stat({ bigint: true });
    const sha256 = await hashFileBytes(file, Number(before.size), staged);
    await staged.chmod(0o555);
    await staged.sync();
    const observed = await staged.stat({ bigint: true });
    if (
      observed.size !== before.size ||
      fileMode(observed) !== "0555" ||
      (await hashFileBytes(staged, Number(observed.size))) !== sha256
    )
      throw new Error("Staged native artifact does not match the captured bytes and mode.");
    await unchangedFile(source, file, before);
    await unchangedFile(output, staged, observed);
    complete = true;
    return {
      observation: {
        sha256,
        size: Number(observed.size),
        uid: Number(observed.uid),
        gid: Number(observed.gid),
        mode: fileMode(observed),
      },
      identity: identityFields.map((key) => String(observed[key])),
    };
  } finally {
    try {
      await staged?.close();
    } finally {
      await file.close();
      if (!complete && created) {
        const current = await lstat(output, { bigint: true }).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        if (current?.dev === created.dev && current?.ino === created.ino) await rm(output);
      }
    }
  }
}

// Inventory the selected files themselves, independent of Git tracking state.
// Keep identity observations private to the in-process before/after comparison.
export async function captureBuildInputs(root, paths) {
  root = await realpath(root);
  const files = [];
  const identities = [];
  let bytes = 0;
  let entries = 0;
  const visit = async (path, depth) => {
    if (++entries > 8192 || depth > 32)
      throw new Error("Build source inventory exceeds its entry/depth limit.");
    const absolute = join(root, path);
    const before = await lstat(absolute, { bigint: true });
    if (before.isDirectory()) {
      if ((await realpath(absolute)) !== absolute)
        throw new Error(`Noncanonical build source directory: ${path}`);
      const names = [];
      for await (const entry of await opendir(absolute)) {
        if (names.length + entries >= 8192)
          throw new Error("Build source inventory exceeds its entry limit.");
        names.push(entry.name);
      }
      for (const name of names.sort()) await visit(join(path, name), depth + 1);
      if (!sameFile(before, await lstat(absolute, { bigint: true })))
        throw new Error(`Build source directory changed: ${path}`);
      identities.push([path, identityFields.map((key) => String(before[key]))]);
    } else {
      if (!before.isFile()) throw new Error(`Expected a regular build source: ${path}`);
      if (bytes + Number(before.size) > 64 * 1024 * 1024)
        throw new Error("Build source inventory exceeds its 64 MiB limit.");
      const captured = await captureBuildFile(absolute, 8 * 1024 * 1024);
      bytes += captured.size;
      if (bytes > 64 * 1024 * 1024)
        throw new Error("Build source inventory exceeds its 64 MiB limit.");
      files.push({ path: path.split(sep).join("/"), size: captured.size, sha256: captured.sha256 });
      identities.push([path, captured.identity]);
    }
  };
  for (const path of [...new Set(paths)].sort()) {
    if (
      !path ||
      isAbsolute(path) ||
      path === ".." ||
      path.startsWith(`..${sep}`) ||
      relative(root, join(root, path)) !== path
    )
      throw new Error("Build source selections must be canonical relative paths.");
    await visit(path, 0);
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    manifest: { sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files },
    identities,
  };
}

export function assertBuildInputsUnchanged(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error(
      "Selected native build inputs changed; discard the outputs and rebuild from stable inputs.",
    );
}

export async function writeNativeManifest(path, manifest) {
  let temporary;
  try {
    await rm(path, { force: true });
    temporary = await mkdtemp(join(dirname(path), ".native-manifest-"));
    const content = `${JSON.stringify(manifest, null, 2)}\n`;
    if (Buffer.byteLength(content) > 4 * 1024 * 1024)
      throw new Error("Native manifest exceeds its byte limit.");
    const file = join(temporary, "manifest.json");
    await writeFile(file, content, { flag: "wx", mode: 0o644 });
    await rename(file, path);
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

function requiredEnvironment(name, pattern, description) {
  const value = process.env[name];
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${name} must be ${description}.`);
  }
  return value;
}

const digestPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const tagPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*:[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
function imageTag(name) {
  const value = requiredEnvironment(name, tagPattern, "an explicit output image tag");
  if (value.endsWith(":latest")) throw new Error(`${name} must select a tag other than latest.`);
  return value;
}

function hostPlatform() {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
    throw new Error(
      "Native builds require Linux amd64 or arm64; cross-compilation is not selected.",
    );
  }
  return process.arch === "x64"
    ? { image: "linux/amd64", rust: "x86_64-unknown-linux-gnu" }
    : { image: "linux/arm64", rust: "aarch64-unknown-linux-gnu" };
}

let nativeEnvironment;
let nativeCargo;
let nativeInputs;
let nativeTools;
let nativeToolVersions;

async function captureNativeInputs() {
  const paths = [
    "scripts/build-mvp.mjs",
    "dataplane/Cargo.toml",
    "dataplane/Cargo.lock",
    "dataplane/rust-toolchain.toml",
    ...nativePackagePaths,
  ];
  for (const path of [
    ".cargo/config",
    ".cargo/config.toml",
    "dataplane/.cargo/config",
    "dataplane/.cargo/config.toml",
  ]) {
    if (
      await lstat(join(repositoryRoot, path)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      })
    )
      paths.push(path);
  }
  return captureBuildInputs(repositoryRoot, paths);
}

async function captureNativeTools() {
  return {
    rustc: await captureBuildFile(nativeEnvironment.RUSTC, maxNativeBytes),
    cargo: await captureBuildFile(nativeCargo, maxNativeBytes),
  };
}

async function verifyNativeInputs() {
  assertBuildInputsUnchanged(nativeInputs, await captureNativeInputs());
  assertBuildInputsUnchanged(nativeTools, await captureNativeTools());
}

async function checkNative() {
  hostPlatform();
  for (const name of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"]) {
    await verifyFile(join(nativeRoot, name));
  }
  nativeInputs = await captureNativeInputs();
  const pin = await readFile(join(nativeRoot, "rust-toolchain.toml"), "utf8");
  const channel = /^channel\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m.exec(pin)?.[1];
  if (channel === undefined)
    throw new Error("dataplane/rust-toolchain.toml must pin one exact Rust version.");
  nativeEnvironment = {
    ...process.env,
    RUSTUP_TOOLCHAIN: channel,
    RUSTUP_AUTO_INSTALL: "0",
    CARGO_NET_OFFLINE: "true",
    CARGO_TARGET_DIR: join(nativeRoot, "target"),
    RUSTC_WRAPPER: "",
    RUSTC_WORKSPACE_WRAPPER: "",
  };
  const options = { cwd: nativeRoot, env: nativeEnvironment, capture: true };
  const rustc = (
    await runCommand("rustup", ["which", "--toolchain", channel, "rustc"], options)
  ).trim();
  nativeCargo = (
    await runCommand("rustup", ["which", "--toolchain", channel, "cargo"], options)
  ).trim();
  await verifyFile(rustc, { executable: true });
  await verifyFile(nativeCargo, { executable: true });
  nativeEnvironment.RUSTC = rustc;
  nativeTools = await captureNativeTools();
  const compiler = await runCommand(rustc, ["--version", "--verbose"], options);
  if (!compiler.startsWith(`rustc ${channel} `))
    throw new Error(`Install the pinned Rust ${channel} toolchain before building.`);
  nativeToolVersions = {
    rustc: compiler.trim(),
    cargo: (await runCommand(nativeCargo, ["--version"], options)).trim(),
  };
  const metadata = JSON.parse(
    await runCommand(
      nativeCargo,
      [
        "metadata",
        "--format-version",
        "1",
        "--filter-platform",
        hostPlatform().rust,
        "--locked",
        "--offline",
      ],
      options,
    ),
  );
  const members = metadata.packages.filter(({ id }) => metadata.workspace_members.includes(id));
  if (
    members
      .map(({ name }) => name)
      .sort()
      .join(",") !== [...nativeMembers].sort().join(",")
  ) {
    throw new Error("The dataplane Cargo workspace must contain exactly the selected packages.");
  }
  const nativeDirectory = await realpath(nativeRoot);
  if ((await realpath(metadata.workspace_root)) !== nativeDirectory)
    throw new Error("Cargo selected a different workspace root.");
  const memberDirectories = nativePackagePaths.map((path) => join(repositoryRoot, path));
  // Inspect the resolved graph as well as declared path edges: a Cargo patch
  // can replace a registry dependency with local source outside the workspace.
  for (const dependency of metadata.packages.filter(({ source }) => source === null)) {
    if (!memberDirectories.includes(dirname(await realpath(dependency.manifest_path)))) {
      throw new Error("Cargo resolved local source outside the selected dataplane packages.");
    }
  }
  for (const member of members) {
    const expected = memberDirectories[nativeMembers.indexOf(member.name)];
    if ((await realpath(member.manifest_path)) !== join(expected, "Cargo.toml"))
      throw new Error(
        `The ${member.name} manifest must reside in its selected dataplane directory.`,
      );
    for (const target of member.targets) {
      if (!(await realpath(target.src_path)).startsWith(`${expected}${sep}`)) {
        throw new Error(
          `The ${member.name} package has an entrypoint outside its selected directory.`,
        );
      }
    }
    for (const dependency of member.dependencies) {
      if (
        dependency.path !== undefined &&
        !memberDirectories.includes(await realpath(dependency.path))
      ) {
        throw new Error(
          `The ${member.name} package has a path dependency outside the selected dataplane workspace.`,
        );
      }
    }
  }
  for (const product of nativeProducts) {
    if (
      !members
        .find((member) => member.name === product.package)
        ?.targets.some((target) => target.name === product.binary && target.kind.includes("bin"))
    ) {
      throw new Error(
        `The selected ${product.package} package lacks the qualified ${product.binary} OCE adapter; prepare its reviewed source before building. Stock service entrypoints are not a fallback.`,
      );
    }
  }
  await verifyNativeInputs();
}

async function buildNative(product) {
  const output = join(outputRoot, "native", product.binary);
  await mkdir(dirname(output), { recursive: true });
  await rm(output, { force: true });
  await verifyNativeInputs();
  await runCommand(
    nativeCargo,
    [
      "build",
      "--locked",
      "--offline",
      "--release",
      "--target",
      hostPlatform().rust,
      "--package",
      product.package,
      "--bin",
      product.binary,
    ],
    {
      cwd: nativeRoot,
      env: nativeEnvironment,
    },
  );
  await verifyNativeInputs();
  const artifact = join(nativeRoot, "target", hostPlatform().rust, "release", product.binary);
  const staged = await stageNativeArtifact(artifact, output);
  stagedNativeIdentities.push(staged.identity);
  builtNativeProducts.push({
    ...product,
    path: `.build/mvp/native/${product.binary}`,
    staged: staged.observation,
    installationRequirements: {
      path: `/usr/local/bin/${product.binary}`,
      uid: 0,
      gid: 0,
      mode: "0555",
    },
  });
}

async function checkTypes() {
  if (Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("The controller build requires Node.js 24.");
  const compiler = join(repositoryRoot, "node_modules/typescript/bin/tsc");
  await verifyFile(compiler);
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const installed = JSON.parse(
    await readFile(join(repositoryRoot, "node_modules/typescript/package.json"), "utf8"),
  );
  if (installed.version !== manifest.devDependencies.typescript)
    throw new Error(
      "The installed TypeScript compiler does not match package.json; prepare dependencies separately.",
    );
  await runCommand(process.execPath, [
    join(repositoryRoot, "scripts/verify-workspace-boundary.mjs"),
  ]);
  await runCommand(process.execPath, [compiler, "--build", "tsconfig.json", "--pretty", "false"]);
  for (const project of [
    "packages/utils",
    "packages/contracts",
    "packages/occ",
    "packages/iam",
    "packages/audit",
    "apps/controller",
  ]) {
    await verifyFile(join(repositoryRoot, project, "dist/index.d.ts"));
  }
}

function imageInputs(kind) {
  const controller = kind === "controller";
  const tag = imageTag(controller ? "OCC_BUILD_CONTROLLER_TAG" : "OCC_BUILD_EGRESS_TAG");
  const base = requiredEnvironment(
    controller ? "OCC_BUILD_NODE_BASE_IMAGE" : "OCC_BUILD_EGRESS_BASE_IMAGE",
    digestPattern,
    "a digest-pinned image reference",
  );
  const goBase = controller
    ? requiredEnvironment(
        "OCC_BUILD_GO_BASE_IMAGE",
        digestPattern,
        "a digest-pinned Go build image reference",
      )
    : null;
  const upstreamSdkContext = controller
    ? requiredEnvironment(
        "OCC_BUILD_UPSTREAM_SDK_CONTEXT",
        /^\/[^\0\r\n]+$/,
        "an absolute frozen upstream package-input context directory",
      )
    : null;
  if (upstreamSdkContext !== null && realpathSync(upstreamSdkContext) !== upstreamSdkContext)
    throw new Error(
      "OCC_BUILD_UPSTREAM_SDK_CONTEXT must be canonical and must not traverse links.",
    );
  if (upstreamSdkContext !== null && !statSync(upstreamSdkContext).isDirectory())
    throw new Error("OCC_BUILD_UPSTREAM_SDK_CONTEXT must be a directory.");
  const upstreamSdkManifestSha256 = controller
    ? requiredEnvironment(
        "OCC_BUILD_UPSTREAM_SDK_MANIFEST_SHA256",
        /^[a-f0-9]{64}$/,
        "the reviewed upstream package layout SHA-256",
      )
    : null;
  return { controller, tag, base, goBase, upstreamSdkContext, upstreamSdkManifestSha256 };
}

export function goBuildCacheScope(root = repositoryRoot) {
  // Aliases of one checkout reuse its cache without exposing the host path.
  return createHash("sha256").update(realpathSync(root)).digest("hex");
}

export function imageBuildArguments(kind, idFile) {
  const { controller, tag, base, goBase, upstreamSdkContext, upstreamSdkManifestSha256 } =
    imageInputs(kind);
  const dockerfile = controller ? "Dockerfile" : "deploy/egress/Dockerfile";
  const args = [
    "build",
    "--pull=false",
    "--platform",
    hostPlatform().image,
    "--file",
    dockerfile,
    "--tag",
    tag,
    "--iidfile",
    idFile,
    "--build-arg",
    `${controller ? "NODE_BASE_IMAGE" : "EGRESS_BASE_IMAGE"}=${base}`,
  ];
  if (controller)
    args.push(
      "--build-arg",
      `GO_BASE_IMAGE=${goBase}`,
      "--build-arg",
      `GO_BUILD_CACHE_SCOPE=${goBuildCacheScope()}`,
      "--build-context",
      `oce-upstream-inputs=${upstreamSdkContext}`,
      "--build-arg",
      `OCE_UPSTREAM_SDK_MANIFEST_SHA256=${upstreamSdkManifestSha256}`,
      "--target",
      "runtime",
    );
  else args.push("--network=none");
  args.push(".");
  return args;
}

async function buildImage(kind) {
  const { controller, tag } = imageInputs(kind);
  const dockerfile = controller ? "Dockerfile" : "deploy/egress/Dockerfile";
  await verifyFile(join(repositoryRoot, dockerfile));
  await mkdir(outputRoot, { recursive: true });
  const idFile = join(outputRoot, `${kind}.image-id`);
  await rm(idFile, { force: true });
  const args = imageBuildArguments(kind, idFile);
  await runCommand("docker", args);
  await verifyFile(idFile);
  const id = (await readFile(idFile, "utf8")).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(id))
    throw new Error(`Docker produced an invalid ${kind} image ID.`);
  const observed = (
    await runCommand(
      "docker",
      ["image", "inspect", "--format", "{{.Id}} {{.Os}}/{{.Architecture}}", tag],
      { capture: true },
    )
  ).trim();
  if (observed !== `${id} ${hostPlatform().image}`)
    throw new Error(`The ${kind} output tag does not identify the image and platform just built.`);
  process.stdout.write(
    `[build-mvp] ${kind} image ID ${id} (local image ID, not a registry manifest digest)\n`,
  );
}

async function checkRuntimeImage() {
  const reference = requiredEnvironment(
    "OCC_BUILD_RUNTIME_IMAGE",
    digestPattern,
    "a digest-pinned OpenClaw/Codex runtime image reference",
  );
  const platform = (
    await runCommand(
      "docker",
      ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", reference],
      { capture: true },
    )
  ).trim();
  if (platform !== hostPlatform().image)
    throw new Error("The prepared runtime image must match this build's Linux platform.");
}

async function prepareEgressPackages() {
  const script = join(repositoryRoot, "deploy/egress/download-packages.mjs");
  await verifyFile(script);
  await verifyFile(join(repositoryRoot, "deploy/egress/runtime-packages.lock.json"));
  await runCommand(process.execPath, [script]);
  await verifyFile(join(outputRoot, "egress-debs/SHA256SUMS"));
}

const targets = {
  "check-types": {
    deps: [],
    description: "Check the six TypeScript projects; runtime images continue to execute source.",
    run: checkTypes,
  },
  "check-native": {
    deps: [],
    description: "Verify the installed pinned Rust toolchain and exact Cargo workspace.",
    run: checkNative,
  },
  "native-dns": {
    deps: ["check-native"],
    description: "Build only the oce-dnsgate adapter binary, offline, for this Linux host.",
    run: () => buildNative(nativeProducts[0]),
  },
  "native-tls": {
    deps: ["check-native"],
    description: "Build only the oce-egress adapter binary, offline, for this Linux host.",
    run: () => buildNative(nativeProducts[1]),
  },
  native: {
    deps: ["native-dns", "native-tls"],
    description: "Build both native product binaries.",
  },
  build: {
    deps: ["check-types", "native"],
    description:
      "Check TypeScript and compile native products; no installs, images, or live tests.",
  },
  "image-controller": {
    deps: ["check-types"],
    description:
      "Build the controller image with explicit pinned Node and Go bases and an output tag.",
    run: () => buildImage("controller"),
  },
  "egress-packages": {
    deps: [],
    description:
      "Prepare the locked Debian package inputs with the reviewed downloader; network may be used.",
    run: prepareEgressPackages,
  },
  "image-egress": {
    deps: ["native", "egress-packages"],
    description: "Build the egress image from native outputs with an explicit pinned base and tag.",
    run: () => buildImage("egress"),
  },
  "runtime-image": {
    deps: [],
    description:
      "Verify the separately prepared, digest-pinned local OpenClaw/Codex runtime input.",
    run: checkRuntimeImage,
  },
  images: {
    deps: ["runtime-image", "image-controller", "image-egress"],
    description:
      "Assemble controller and egress images with the explicit runtime input; network may be used.",
  },
};

export function executionOrder(target) {
  if (!Object.hasOwn(targets, target)) throw new Error(`Unknown build target: ${target}`);
  const order = [];
  const visit = (name) => {
    if (order.includes(name)) return;
    for (const dependency of targets[name].deps) visit(dependency);
    order.push(name);
  };
  visit(target);
  return order;
}

async function main(args) {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write("Usage: node scripts/build-mvp.mjs [--plan] <target>\n");
    for (const [name, target] of Object.entries(targets))
      process.stdout.write(`  ${name}: ${target.description}\n`);
    return;
  }
  const plan = args[0] === "--plan";
  const names = plan ? args.slice(1) : args;
  if (names.length !== 1) throw new Error("Select one target; use --help to list the build graph.");
  const order = executionOrder(names[0]);
  if (plan) {
    process.stdout.write(
      `${JSON.stringify(
        order.map((name) => ({
          target: name,
          dependencies: targets[name].deps,
          description: targets[name].description,
        })),
        null,
        2,
      )}\n`,
    );
    return;
  }
  const nativeBuild = order.includes("native-dns") || order.includes("native-tls");
  if (nativeBuild) await rm(nativeManifestPath, { force: true });
  try {
    // Validate explicit image inputs before any prerequisite tool runs. A typo
    // must not start a source build or replace a tag belonging to another image.
    if (order.includes("image-controller")) imageInputs("controller");
    if (order.includes("image-egress")) imageInputs("egress");
    if (
      order.includes("image-controller") &&
      order.includes("image-egress") &&
      process.env.OCC_BUILD_CONTROLLER_TAG === process.env.OCC_BUILD_EGRESS_TAG
    ) {
      throw new Error("Controller and egress output tags must be distinct.");
    }
    for (const name of order) {
      process.stdout.write(`[build-mvp] ${name}\n`);
      await targets[name].run?.();
    }
    if (builtNativeProducts.length !== 0) {
      await verifyNativeInputs();
      for (const [index, product] of builtNativeProducts.entries()) {
        const observed = await captureBuildFile(join(repositoryRoot, product.path), maxNativeBytes);
        if (observed.sha256 !== product.staged.sha256 || observed.size !== product.staged.size)
          throw new Error(
            `Staged native artifact changed before manifest publication: ${product.binary}`,
          );
        assertBuildInputsUnchanged(stagedNativeIdentities[index], observed.identity);
      }
      await writeNativeManifest(nativeManifestPath, {
        schemaVersion: 2,
        rustToolchain: nativeEnvironment.RUSTUP_TOOLCHAIN,
        rustTarget: hostPlatform().rust,
        imagePlatform: hostPlatform().image,
        // Host provenance is not the binary's minimum libc requirement. The
        // selected image must execute the real binary to qualify that ABI.
        hostGlibcVersion: process.report.getReport().header.glibcVersionRuntime ?? null,
        sourceInputs: nativeInputs.manifest,
        tools: Object.fromEntries(
          Object.entries(nativeTools).map(([name, { sha256, size }]) => [
            name,
            { sha256, size, version: nativeToolVersions[name] },
          ]),
        ),
        products: builtNativeProducts,
      });
    }
  } catch (error) {
    if (nativeBuild) await rm(nativeManifestPath, { force: true });
    throw error;
  }
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[build-mvp] ${error.message}\n`);
    if (error instanceof CommandFailure && error.signal !== null) {
      process.exitCode = 128 + (osConstants.signals[error.signal] ?? 1);
      process.kill(process.pid, error.signal);
    } else process.exitCode = error instanceof CommandFailure ? error.exitCode : 1;
  });
}
