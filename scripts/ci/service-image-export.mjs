#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { github, githubPages, repository, validateCi } from "./container-release.mjs";

export const exportWorkflow = ".github/workflows/repository-service-export.yml";
export const exportLane = "repository-credentials-container";
export const exportRoles = ["service", "client", "qualification"];
export const exporterVersion = "skopeo version 1.13.3";
const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const shaPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const integerPattern = /^[1-9][0-9]*$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalHash(value) {
  return sha256(`${JSON.stringify(value)}\n`);
}

function contained(root, path) {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !options.allowFailure) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new Error(`${commandName} ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonAtomic(path, value, { exclusive = false } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (exclusive) {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return;
  }
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export function validateExportRequest(lane, requested) {
  assert.ok(requested === "true" || requested === "false", "Service export must be true or false.");
  if (requested === "true") {
    assert.equal(
      lane,
      exportLane,
      "Service export is restricted to repository-credentials-container.",
    );
  }
  return requested === "true";
}

export function validateHostedContext(env, repo) {
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(repo.full_name, repository);
  assert.equal(repo.default_branch, "main");
  assert.equal(typeof repo.private, "boolean");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.equal(env.GITHUB_WORKFLOW_REF, `${repository}/${exportWorkflow}@refs/heads/main`);
  for (const name of ["GITHUB_WORKFLOW_SHA", "GITHUB_SHA", "SOURCE_SHA"]) {
    assert.match(env[name] ?? "", shaPattern, `${name} must be a full commit SHA.`);
  }
  assert.equal(env.GITHUB_SHA, env.GITHUB_WORKFLOW_SHA);
  assert.equal(env.SOURCE_SHA, env.GITHUB_WORKFLOW_SHA);
  assert.match(env.CI_RUN_ID ?? "", integerPattern);
  assert.match(env.CI_ATTEMPT ?? "", integerPattern);
}

export function validateLaneIdentity(state, receipt, env) {
  assert.equal(state.version, 1);
  assert.equal(state.repositoryRoot, repositoryRoot);
  assert.equal(state.lane, exportLane);
  assert.match(state.prefix ?? "", /^openclaw-ci-[a-z0-9-]+$/);
  assert.ok(Array.isArray(state.resources));
  assert.equal(receipt.version, 1);
  assert.equal(receipt.lane, exportLane);
  assert.equal(receipt.sourceCommit, env.SOURCE_SHA);
  assert.equal(receipt.sourceTree, env.SOURCE_TREE);
  assert.equal(receipt.ghVersion, "2.100.0");
  assert.deepEqual(Object.keys(receipt.images ?? {}).sort(), [...exportRoles].sort());
  assert.equal(state.resources.length, exportRoles.length);
  const resources = new Map();
  for (const resource of state.resources) {
    assert.equal(resource.kind, "image-tag");
    assert.equal(resource.owner, state.prefix);
    assert.equal(resource.status, "ready");
    assert.match(resource.id ?? "", /^image-tag-[a-f0-9]{12}$/);
    assert.match(resource.imageId ?? "", digestPattern);
    assert.match(
      resource.name ?? "",
      /^localhost\/openclaw-ci-image-[a-z0-9-]+\/(service|client|qualification):local$/,
    );
    const role = /\/(service|client|qualification):local$/.exec(resource.name)?.[1];
    assert.ok(role && !resources.has(role), "Each owned image role must be unique.");
    resources.set(role, resource);
  }
  for (const role of exportRoles) {
    const image = receipt.images[role];
    const resource = resources.get(role);
    assert.ok(resource, `Missing ${role} cleanup resource.`);
    assert.deepEqual(image, { tag: resource.name, id: resource.imageId });
  }
  return resources;
}

export function validateServiceRecipe(source, baseReference) {
  const instructions = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.deepEqual(instructions, [
    `FROM ${baseReference}`,
    "WORKDIR /app",
    "COPY package.json ./package.json",
    "COPY dist ./dist",
    "RUN chmod -R a=rX /app",
    "USER node",
    'ENTRYPOINT ["node", "/app/dist/repository-credentials.js"]',
  ]);
}

export function validateStagedServiceContext(records, dockerignoreSha256) {
  assert.ok(records.some(({ path }) => path === "dist/"));
  assert.ok(records.some(({ path, type }) => path.startsWith("dist/") && type === "file"));
  assert.ok(records.some(({ path }) => path === "package.json"));
  const ignore = records.find(({ path }) => path === ".dockerignore");
  assert.equal(ignore?.sha256, dockerignoreSha256);
  for (const record of records) {
    assert.ok(
      record.path === ".dockerignore" ||
        record.path === "package.json" ||
        record.path === "dist/" ||
        record.path.startsWith("dist/"),
      `Unexpected staged service context path: ${record.path}`,
    );
  }
}

async function inventory(root, { normalizeModes = false, omit = new Set() } = {}) {
  const records = [];
  async function visit(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (omit.has(relativePath)) {
        continue;
      }
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      assert.ok(!metadata.isSymbolicLink(), `Artifact closure contains a symlink: ${relativePath}`);
      if (metadata.isDirectory()) {
        records.push({
          path: `${relativePath}/`,
          type: "directory",
          mode: normalizeModes ? "0555" : (metadata.mode & 0o7777).toString(8).padStart(4, "0"),
        });
        await visit(path, relativePath);
      } else {
        assert.ok(metadata.isFile(), `Artifact closure contains a special file: ${relativePath}`);
        const bytes = await readFile(path);
        const executable = (metadata.mode & 0o111) !== 0;
        records.push({
          path: relativePath,
          type: "file",
          mode: normalizeModes
            ? executable
              ? "0555"
              : "0444"
            : (metadata.mode & 0o7777).toString(8).padStart(4, "0"),
          size: bytes.length,
          sha256: sha256(bytes),
        });
      }
    }
  }
  await visit(root);
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

export function validateServiceConfiguration(service, base, serviceHistory, baseHistory) {
  assert.equal(service.Config?.User, "node");
  assert.equal(service.Config?.WorkingDir, "/app");
  assert.deepEqual(service.Config?.Entrypoint, ["node", "/app/dist/repository-credentials.js"]);
  assert.deepEqual(
    service.Config?.Cmd,
    base.Config?.Cmd,
    "The service image must retain the pinned base command.",
  );
  assert.deepEqual(
    service.Config?.Env,
    base.Config?.Env,
    "The service image must not add environment values.",
  );
  const baseLayers = base.RootFS?.Layers;
  const serviceLayers = service.RootFS?.Layers;
  assert.ok(Array.isArray(baseLayers) && baseLayers.length > 0);
  assert.ok(Array.isArray(serviceLayers) && serviceLayers.length > baseLayers.length);
  assert.deepEqual(serviceLayers.slice(0, baseLayers.length), baseLayers);
  assert.ok(Array.isArray(baseHistory) && baseHistory.length > 0);
  assert.ok(serviceHistory.length > baseHistory.length);
  assert.deepEqual(serviceHistory.slice(-baseHistory.length), baseHistory);
  const serviceOwnedHistory = serviceHistory.slice(0, -baseHistory.length);
  assert.doesNotMatch(
    serviceOwnedHistory.join("\n"),
    /(?:authorization|bearer|password|private[ _-]?key|secret|token)[=:][^ ,]+/i,
    "Service-owned image history must not carry credential values.",
  );
  return { baseLayers, serviceLayers, serviceOwnedHistory };
}

async function verifyBlob(layout, digest) {
  assert.match(digest ?? "", digestPattern);
  const path = join(layout, "blobs", "sha256", digest.slice("sha256:".length));
  const bytes = await readFile(path);
  assert.equal(`sha256:${sha256(bytes)}`, digest);
  return bytes;
}

export async function validateOciLayout(layout, service) {
  assert.deepEqual((await readdir(layout)).sort(), ["blobs", "index.json", "oci-layout"]);
  assert.deepEqual(await readdir(join(layout, "blobs")), ["sha256"]);
  assert.deepEqual(await readJson(join(layout, "oci-layout")), { imageLayoutVersion: "1.0.0" });
  const indexBytes = await readFile(join(layout, "index.json"));
  const index = JSON.parse(indexBytes);
  assert.equal(index.schemaVersion, 2);
  assert.equal(index.manifests?.length, 1);
  const descriptor = index.manifests[0];
  assert.equal(descriptor.mediaType, "application/vnd.oci.image.manifest.v1+json");
  assert.equal(descriptor.annotations?.["org.opencontainers.image.ref.name"], "service");
  const manifestBytes = await verifyBlob(layout, descriptor.digest);
  assert.equal(descriptor.size, manifestBytes.length);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.mediaType, "application/vnd.oci.image.manifest.v1+json");
  assert.equal(manifest.config?.mediaType, "application/vnd.oci.image.config.v1+json");
  assert.equal(
    manifest.config?.digest,
    service.Id,
    "OCI config identity must equal the tested Docker config ID.",
  );
  const configBytes = await verifyBlob(layout, manifest.config.digest);
  assert.equal(manifest.config.size, configBytes.length);
  const config = JSON.parse(configBytes);
  assert.deepEqual(config.rootfs?.diff_ids, service.RootFS.Layers);
  assert.equal(config.config?.User, service.Config.User);
  assert.equal(config.config?.WorkingDir, service.Config.WorkingDir);
  assert.deepEqual(config.config?.Entrypoint, service.Config.Entrypoint);
  assert.deepEqual(config.config?.Cmd ?? null, service.Config.Cmd ?? null);
  assert.deepEqual(config.config?.Env, service.Config.Env);
  assert.ok(Array.isArray(manifest.layers) && manifest.layers.length > 0);
  for (const layer of manifest.layers) {
    assert.ok(
      [
        "application/vnd.oci.image.layer.v1.tar+gzip",
        "application/vnd.oci.image.layer.v1.tar+zstd",
        "application/vnd.oci.image.layer.v1.tar",
      ].includes(layer.mediaType),
    );
    const bytes = await verifyBlob(layout, layer.digest);
    assert.equal(layer.size, bytes.length);
  }
  const expectedBlobs = [
    descriptor.digest,
    manifest.config.digest,
    ...manifest.layers.map(({ digest }) => digest),
  ]
    .map((digest) => digest.slice("sha256:".length))
    .sort();
  assert.deepEqual((await readdir(join(layout, "blobs", "sha256"))).sort(), expectedBlobs);
  return {
    indexSha256: sha256(indexBytes),
    manifestDigest: descriptor.digest,
    configDigest: manifest.config.digest,
    layerDigests: manifest.layers.map(({ digest }) => digest),
  };
}

async function inspectImage(reference) {
  const result = command(process.env.OCC_DOCKER_BIN ?? "docker", ["image", "inspect", reference]);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.length, 1);
  return parsed[0];
}

function imageHistory(reference) {
  return command(process.env.OCC_DOCKER_BIN ?? "docker", [
    "history",
    "--no-trunc",
    "--format",
    "{{json .CreatedBy}}",
    reference,
  ])
    .stdout.split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function requireCheckout(env) {
  const head = command("git", ["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim();
  const tree = command("git", ["rev-parse", "--verify", "HEAD^{tree}"]).stdout.trim();
  assert.equal(head, env.SOURCE_SHA);
  assert.equal(tree, env.SOURCE_TREE);
  assert.equal(env.GITHUB_WORKFLOW_SHA, env.SOURCE_SHA);
  return { head, tree };
}

async function exportImage(statePath, receiptPath, outputArgument, env = process.env) {
  validateExportRequest(exportLane, env.OPENCLAW_EXPORT_SERVICE_IMAGE ?? "");
  for (const name of ["SOURCE_SHA", "SOURCE_TREE", "GITHUB_WORKFLOW_SHA"]) {
    assert.match(env[name] ?? "", shaPattern, `${name} must be a full commit SHA.`);
  }
  for (const name of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "CI_RUN_ID", "CI_ATTEMPT"]) {
    assert.match(env[name] ?? "", integerPattern, `${name} must be a positive integer.`);
  }
  const output = resolve(outputArgument);
  const runnerTemp = resolve(env.RUNNER_TEMP ?? "");
  assert.ok(runnerTemp !== repositoryRoot && contained(runnerTemp, output));
  await mkdir(output, { recursive: false, mode: 0o700 });
  const stateBytes = await readFile(resolve(statePath));
  const receiptBytes = await readFile(resolve(receiptPath));
  const state = JSON.parse(stateBytes);
  const receipt = JSON.parse(receiptBytes);
  validateLaneIdentity(state, receipt, env);
  const checkout = await requireCheckout(env);
  const dockerfilePath = join(repositoryRoot, "deploy/runtime/repository-credentials/Dockerfile");
  const dockerfile = await readFile(dockerfilePath, "utf8");
  const baseReference = /^FROM ([^\s]+@sha256:[a-f0-9]{64})$/m.exec(dockerfile)?.[1];
  assert.ok(baseReference, "The service Dockerfile must pin its base by digest.");
  validateServiceRecipe(dockerfile, baseReference);
  const stagedRoot = join(repositoryRoot, ".build/repository-credentials/service");
  const stagedContext = await inventory(stagedRoot);
  const dockerignore = await readFile(
    join(repositoryRoot, "deploy/runtime/repository-credentials/.dockerignore"),
  );
  validateStagedServiceContext(stagedContext, sha256(dockerignore));
  assert.deepEqual(await readJson(join(stagedRoot, "package.json")), {
    name: "repository-credentials-service",
    type: "module",
  });
  const expectedClosure = await inventory(stagedRoot, {
    normalizeModes: true,
    omit: new Set([".dockerignore"]),
  });
  const inspected = {};
  for (const role of exportRoles) {
    inspected[role] = await inspectImage(receipt.images[role].tag);
    assert.equal(inspected[role].Id, receipt.images[role].id);
  }
  const work = await mkdtemp(join(env.RUNNER_TEMP ?? tmpdir(), "repository-service-export-"));
  const container = `openclaw-service-export-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  try {
    const observedExporter = command(process.env.OCC_SKOPEO_BIN ?? "skopeo", [
      "--version",
    ]).stdout.trim();
    assert.equal(observedExporter, exporterVersion);
    const baseConfigOutput = command(process.env.OCC_SKOPEO_BIN ?? "skopeo", [
      "inspect",
      "--config",
      `docker://${baseReference}`,
    ]).stdout;
    const baseConfig = JSON.parse(baseConfigOutput);
    assert.equal(baseConfig.os, inspected.service.Os);
    assert.equal(baseConfig.architecture, inspected.service.Architecture);
    const base = {
      Config: baseConfig.config,
      RootFS: { Layers: baseConfig.rootfs?.diff_ids },
    };
    const serviceHistory = imageHistory(receipt.images.service.tag);
    const baseHistory = (baseConfig.history ?? []).map((entry) => entry.created_by ?? "").reverse();
    const configuration = validateServiceConfiguration(
      inspected.service,
      base,
      serviceHistory,
      baseHistory,
    );
    command(process.env.OCC_DOCKER_BIN ?? "docker", [
      "create",
      "--name",
      container,
      inspected.service.Id,
    ]);
    const app = join(work, "app");
    command(process.env.OCC_DOCKER_BIN ?? "docker", ["cp", `${container}:/app`, app]);
    const actualClosure = await inventory(app);
    assert.deepEqual(
      actualClosure,
      expectedClosure,
      "Final /app bytes and normalized modes must match the staged service closure.",
    );
    command(process.env.OCC_DOCKER_BIN ?? "docker", ["rm", "-f", container]);
    const removed = command(
      process.env.OCC_DOCKER_BIN ?? "docker",
      ["container", "inspect", container],
      { allowFailure: true },
    );
    assert.notEqual(removed.status, 0, "The export inspection container must be absent.");
    assert.match(`${removed.stderr}\n${removed.stdout}`, /No such container|No such object/i);
    const oci = join(work, "oci");
    command(process.env.OCC_SKOPEO_BIN ?? "skopeo", [
      "copy",
      "--format",
      "oci",
      `docker-daemon:${receipt.images.service.tag}`,
      `oci:${oci}:service`,
    ]);
    const ociIdentity = await validateOciLayout(oci, inspected.service);
    const archive = join(output, "repository-credentials-service.oci.tar");
    command("tar", [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-cf",
      archive,
      "-C",
      oci,
      "blobs",
      "index.json",
      "oci-layout",
    ]);
    const archiveBytes = await readFile(archive);
    const metadata = {
      version: 1,
      kind: "repository-credentials-service-oci-preparation",
      audience: {
        access: "repository-readers",
        retentionDays: 1,
        warning:
          "Preparation artifact only; it is not an installed-lane or registry image reference.",
      },
      source: {
        commit: checkout.head,
        tree: checkout.tree,
        workflowSha: env.GITHUB_WORKFLOW_SHA,
        workflowRun: { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT },
        ciRun: { id: env.CI_RUN_ID, attempt: env.CI_ATTEMPT },
      },
      lane: {
        name: exportLane,
        receiptSha256: sha256(receiptBytes),
        stateSha256: sha256(stateBytes),
      },
      recipe: { path: relative(repositoryRoot, dockerfilePath), sha256: sha256(dockerfile) },
      closure: {
        contextSha256: canonicalHash(stagedContext),
        imageAppSha256: canonicalHash(expectedClosure),
        files: expectedClosure,
      },
      base: {
        pinnedReference: baseReference,
        observedConfigSha256: sha256(baseConfigOutput),
        platform: `${baseConfig.os}/${baseConfig.architecture}`,
      },
      tested: {
        configId: inspected.service.Id,
        tag: receipt.images.service.tag,
        platform: `${inspected.service.Os}/${inspected.service.Architecture}`,
      },
      configuration: {
        user: inspected.service.Config.User,
        workingDir: inspected.service.Config.WorkingDir,
        entrypoint: inspected.service.Config.Entrypoint,
        command: inspected.service.Config.Cmd,
        environmentSha256: canonicalHash(inspected.service.Config.Env),
        serviceOwnedHistorySha256: canonicalHash(configuration.serviceOwnedHistory),
      },
      oci: ociIdentity,
      archive: {
        path: basename(archive),
        sha256: sha256(archiveBytes),
        bytes: archiveBytes.length,
      },
      exporter: {
        name: "skopeo",
        version: observedExporter,
        conversion: "docker-daemon to OCI layout",
      },
      cleanup: {
        status: "pending",
        ownedTags: exportRoles.map((role) => receipt.images[role].tag),
        container,
      },
    };
    await writeJsonAtomic(join(output, "export.json"), metadata, { exclusive: true });
  } finally {
    command(process.env.OCC_DOCKER_BIN ?? "docker", ["rm", "-f", container], {
      allowFailure: true,
    });
    await rm(work, { recursive: true, force: true });
  }
}

async function reconcileCleanup(statePath, receiptPath, outputArgument) {
  const output = resolve(outputArgument);
  const metadataPath = join(output, "export.json");
  const metadata = await readJson(metadataPath);
  assert.equal(metadata.version, 1);
  assert.equal(metadata.kind, "repository-credentials-service-oci-preparation");
  assert.equal(metadata.cleanup?.status, "pending");
  const receiptBytes = await readFile(resolve(receiptPath));
  assert.equal(sha256(receiptBytes), metadata.lane?.receiptSha256);
  const receipt = JSON.parse(receiptBytes);
  assert.deepEqual(
    metadata.cleanup.ownedTags,
    exportRoles.map((role) => receipt.images[role].tag),
  );
  await assert.rejects(stat(resolve(statePath)), { code: "ENOENT" });
  for (const tag of metadata.cleanup.ownedTags) {
    const result = command(process.env.OCC_DOCKER_BIN ?? "docker", ["image", "inspect", tag], {
      allowFailure: true,
    });
    assert.notEqual(result.status, 0, `Owned image tag remains after cleanup: ${tag}`);
    assert.match(`${result.stderr}\n${result.stdout}`, /No such image|No such object/i);
  }
  const container = command(
    process.env.OCC_DOCKER_BIN ?? "docker",
    ["container", "inspect", metadata.cleanup.container],
    { allowFailure: true },
  );
  assert.notEqual(container.status, 0, "The export inspection container remains after cleanup.");
  assert.match(`${container.stderr}\n${container.stdout}`, /No such container|No such object/i);
  const archive = await readFile(join(output, metadata.archive.path));
  assert.equal(sha256(archive), metadata.archive.sha256);
  assert.deepEqual((await readdir(output)).sort(), ["export.json", metadata.archive.path].sort());
  metadata.cleanup = {
    status: "verified",
    scope: "owned service, client and qualification tags plus the export inspection container",
    state: "absent",
    ownedTags: metadata.cleanup.ownedTags,
    container: metadata.cleanup.container,
  };
  await writeJsonAtomic(metadataPath, metadata);
}

async function writeArtifactReceipt(outputArgument, artifactId, artifactDigest, artifactName) {
  assert.match(artifactId ?? "", integerPattern);
  assert.match(artifactDigest ?? "", /^(?:sha256:)?[a-f0-9]{64}$/);
  assert.match(artifactName ?? "", /^repository-service-oci-[1-9][0-9]*-[1-9][0-9]*$/);
  const output = resolve(outputArgument);
  await mkdir(output, { recursive: false, mode: 0o700 });
  await writeJsonAtomic(
    join(output, "artifact.json"),
    {
      version: 1,
      artifact: { id: artifactId, digest: artifactDigest, name: artifactName },
      audience: "repository-readers",
      retentionDays: 1,
      qualification: "preparation-only",
    },
    { exclusive: true },
  );
}

async function preflight(env = process.env) {
  const repo = await github(`repos/${repository}`);
  validateHostedContext(env, repo);
  const comparison = await github(`repos/${repository}/compare/${env.SOURCE_SHA}...main`);
  assert.equal(comparison.status, "identical", "The requested source must equal current main.");
  await requireCheckout(env);
  const workflow = await github(`repos/${repository}/actions/workflows/ci.yml`);
  const run = await github(`repos/${repository}/actions/runs/${env.CI_RUN_ID}`);
  const jobs = await githubPages(
    `repos/${repository}/actions/runs/${env.CI_RUN_ID}/attempts/${env.CI_ATTEMPT}/jobs`,
    "jobs",
  );
  validateCi(run, workflow, jobs, env.SOURCE_SHA, env.CI_RUN_ID, env.CI_ATTEMPT);
}

async function main(args) {
  const [operation, ...rest] = args;
  if (operation === "gate" && rest.length === 2) {
    validateExportRequest(rest[0], rest[1]);
  } else if (operation === "preflight" && rest.length === 0) {
    await preflight();
  } else if (operation === "export" && rest.length === 3) {
    await exportImage(...rest);
  } else if (operation === "reconcile" && rest.length === 3) {
    await reconcileCleanup(...rest);
  } else if (operation === "artifact-receipt" && rest.length === 4) {
    await writeArtifactReceipt(...rest);
  } else {
    throw new Error(
      "Usage: service-image-export.mjs gate|preflight|export|reconcile|artifact-receipt ...",
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Repository service export failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
