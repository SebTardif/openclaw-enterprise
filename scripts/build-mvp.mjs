import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const nativeRoot = join(repositoryRoot, "dataplane");
const outputRoot = join(repositoryRoot, ".build/mvp");
const nativeManifestPath = join(outputRoot, "native-manifest.json");
const builtNativeProducts = [];
const nativeMembers = [
  "ds-contracts",
  "policy-core",
  "ds-policy-snapshot",
  "ds-telemetry",
  "ds-admission-shm",
  "ds-nft",
  "ds-dnsgate",
  "ds-tlsproxy",
];
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
async function checkNative() {
  hostPlatform();
  for (const name of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"]) {
    await verifyFile(join(nativeRoot, name));
  }
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
  const compiler = await runCommand(rustc, ["--version"], options);
  if (!compiler.startsWith(`rustc ${channel} `))
    throw new Error(`Install the pinned Rust ${channel} toolchain before building.`);
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
    throw new Error(
      "The dataplane Cargo workspace must contain exactly the eight selected packages.",
    );
  }
  const nativeDirectory = await realpath(nativeRoot);
  if ((await realpath(metadata.workspace_root)) !== nativeDirectory)
    throw new Error("Cargo selected a different workspace root.");
  const memberDirectories = nativeMembers.map((name) =>
    join(
      nativeDirectory,
      name === "ds-dnsgate" || name === "ds-tlsproxy" ? "services" : "crates",
      name,
    ),
  );
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
}

async function buildNative(product) {
  const output = join(outputRoot, "native", product.binary);
  await mkdir(dirname(output), { recursive: true });
  await rm(output, { force: true });
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
  const artifact = join(nativeRoot, "target", hostPlatform().rust, "release", product.binary);
  await verifyFile(artifact, { executable: true });
  await copyFile(artifact, output);
  await verifyFile(output, { executable: true });
  builtNativeProducts.push({
    ...product,
    path: `.build/mvp/native/${product.binary}`,
    sha256: createHash("sha256")
      .update(await readFile(output))
      .digest("hex"),
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
  return { controller, tag, base, goBase };
}

export function imageBuildArguments(kind, idFile) {
  const { controller, tag, base, goBase } = imageInputs(kind);
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
  if (controller) args.push("--build-arg", `GO_BASE_IMAGE=${goBase}`, "--target", "runtime");
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
  if (order.includes("native-dns") || order.includes("native-tls")) {
    await rm(nativeManifestPath, { force: true });
  }
  for (const name of order) {
    process.stdout.write(`[build-mvp] ${name}\n`);
    await targets[name].run?.();
  }
  if (builtNativeProducts.length !== 0) {
    await writeFile(
      nativeManifestPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          rustToolchain: nativeEnvironment.RUSTUP_TOOLCHAIN,
          rustTarget: hostPlatform().rust,
          imagePlatform: hostPlatform().image,
          // Host provenance is not the binary's minimum libc requirement. The
          // selected image must execute the real binary to qualify that ABI.
          hostGlibcVersion: process.report.getReport().header.glibcVersionRuntime ?? null,
          products: builtNativeProducts,
        },
        null,
        2,
      )}\n`,
    );
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
