import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  exportLane,
  exportWorkflow,
  validateExportRequest,
  validateHostedContext,
  validateLaneIdentity,
  validateOciLayout,
  validateServiceConfiguration,
  validateServiceRecipe,
  validateStagedServiceContext,
} from "../../scripts/ci/service-image-export.mjs";
import { prepareRepositoryCredentials } from "../../scripts/ci/repository-credentials.mjs";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const script = join(root, "scripts/ci/service-image-export.mjs");
const source = "a".repeat(40);
const sourceTree = "b".repeat(40);
const imageId = (character) => `sha256:${character.repeat(64)}`;

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function laneFixture() {
  const prefix = "openclaw-ci-123-1-service-export";
  const images = Object.fromEntries(
    [
      ["service", "c"],
      ["client", "d"],
      ["qualification", "e"],
    ].map(([role, character]) => [
      role,
      {
        tag: `localhost/openclaw-ci-image-123-1-service-export/${role}:local`,
        id: imageId(character),
      },
    ]),
  );
  return {
    env: { SOURCE_SHA: source, SOURCE_TREE: sourceTree },
    receipt: {
      version: 1,
      lane: exportLane,
      sourceCommit: source,
      sourceTree,
      ghVersion: "2.100.0",
      images,
    },
    state: {
      version: 1,
      repositoryRoot: root,
      lane: exportLane,
      prefix,
      resources: Object.entries(images).map(([role, image], index) => ({
        id: `image-tag-${String(index + 1).repeat(12)}`,
        kind: "image-tag",
        owner: prefix,
        status: "ready",
        name: image.tag,
        imageId: image.id,
        role,
      })),
    },
  };
}

test("service export is exactly opt-in and rejects every wrong-lane request", () => {
  assert.equal(validateExportRequest("checks-baseline", "false"), false);
  assert.equal(validateExportRequest(exportLane, "true"), true);
  for (const [lane, requested] of [
    ["images-packaging", "true"],
    ["repository-credentials-platform", "true"],
    [exportLane, "TRUE"],
    [exportLane, "1"],
    [exportLane, ""],
  ]) {
    assert.throws(() => validateExportRequest(lane, requested));
  }
});

test("hosted export accepts only the selected main workflow and exact source", () => {
  const env = {
    GITHUB_REPOSITORY: "openclaw/openclaw-enterprise",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: `openclaw/openclaw-enterprise/${exportWorkflow}@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: source,
    GITHUB_SHA: source,
    SOURCE_SHA: source,
    CI_RUN_ID: "456",
    CI_ATTEMPT: "2",
  };
  const repository = {
    full_name: "openclaw/openclaw-enterprise",
    default_branch: "main",
    private: true,
  };
  validateHostedContext(env, repository);
  for (const patch of [
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/heads/topic" },
    { GITHUB_WORKFLOW_SHA: "f".repeat(40) },
    { GITHUB_SHA: "f".repeat(40) },
    { SOURCE_SHA: "f".repeat(40) },
    { CI_ATTEMPT: "latest" },
  ]) {
    assert.throws(() => validateHostedContext({ ...env, ...patch }, repository));
  }
});

test("lane receipt must equal all three owned ready cleanup resources", () => {
  const fixture = laneFixture();
  validateLaneIdentity(fixture.state, fixture.receipt, fixture.env);
  for (const mutate of [
    ({ state }) => state.resources.pop(),
    ({ state }) => (state.resources[0].status = "planned"),
    ({ state }) => (state.resources[0].owner = "openclaw-ci-foreign"),
    ({ receipt }) => (receipt.images.service.id = imageId("f")),
    ({ receipt }) => (receipt.sourceTree = "f".repeat(40)),
    ({ receipt }) => (receipt.images.extra = receipt.images.service),
  ]) {
    const changed = structuredClone(laneFixture());
    mutate(changed);
    assert.throws(() => validateLaneIdentity(changed.state, changed.receipt, changed.env));
  }
});

test("repository credential preparation records the exact source commit and tree", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "repository-credential-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receiptPath = join(directory, "receipt.json");
  const calls = [];
  const ids = {
    service: imageId("c"),
    client: imageId("d"),
    qualification: imageId("e"),
  };
  await prepareRepositoryCredentials({
    repositoryRoot: root,
    imagePrefix: "localhost/openclaw-ci-image-123-1-service-export",
    receiptPath,
    execFile: async (command, args) => {
      calls.push([command, ...args]);
      if (command === "git" && args.at(-1) === "HEAD") return { stdout: `${source}\n` };
      if (command === "git" && args.at(-1) === "HEAD^{tree}") {
        return { stdout: `${sourceTree}\n` };
      }
      if (args[0] === "image" && args[1] === "inspect") {
        const role = /\/(service|client|qualification):local$/.exec(args.at(-1))?.[1];
        return { stdout: `${ids[role]}\n` };
      }
      return { stdout: "" };
    },
    registerImage: async (tag) => ({ tag }),
    markImageReady: async () => {},
  });
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.sourceCommit, source);
  assert.equal(receipt.sourceTree, sourceTree);
  assert.ok(calls.some((call) => call.at(-1) === "HEAD^{tree}"));
  assert.deepEqual(
    Object.fromEntries(Object.entries(receipt.images).map(([role, image]) => [role, image.id])),
    ids,
  );
});

test("service recipe and staged context reject any file outside the emitted closure", async () => {
  const dockerfile = await readFile(
    join(root, "deploy/runtime/repository-credentials/Dockerfile"),
    "utf8",
  );
  const base = /^FROM ([^\s]+)$/m.exec(dockerfile)[1];
  validateServiceRecipe(dockerfile, base);
  assert.throws(() =>
    validateServiceRecipe(`${dockerfile}\nCOPY credentials /root/credentials\n`, base),
  );
  const ignoreSha = hash(Buffer.from("dist\n"));
  const records = [
    { path: ".dockerignore", type: "file", sha256: ignoreSha },
    { path: "package.json", type: "file", sha256: hash(Buffer.from("{}")) },
    { path: "dist/", type: "directory" },
    { path: "dist/service.js", type: "file", sha256: hash(Buffer.from("export {};")) },
  ];
  validateStagedServiceContext(records, ignoreSha);
  assert.throws(() =>
    validateStagedServiceContext(
      [...records, { path: "provider-token", type: "file", sha256: hash(Buffer.from("x")) }],
      ignoreSha,
    ),
  );
});

test("service configuration binds the pinned base and excludes added environment or history credentials", () => {
  const base = {
    Config: { Env: ["PATH=/usr/local/bin", "NODE_VERSION=24"], Cmd: ["node"] },
    RootFS: { Layers: [imageId("1")] },
  };
  const service = {
    Config: {
      User: "node",
      WorkingDir: "/app",
      Entrypoint: ["node", "/app/dist/repository-credentials.js"],
      Cmd: ["node"],
      Env: [...base.Config.Env],
    },
    RootFS: { Layers: [...base.RootFS.Layers, imageId("2"), imageId("3")] },
  };
  const baseHistory = ["FROM pinned node", "base setup"];
  const serviceHistory = ["ENTRYPOINT", "USER node", "COPY closure", ...baseHistory];
  validateServiceConfiguration(service, base, serviceHistory, baseHistory);
  assert.throws(() =>
    validateServiceConfiguration(
      { ...service, Config: { ...service.Config, Env: [...service.Config.Env, "TOKEN=value"] } },
      base,
      serviceHistory,
      baseHistory,
    ),
  );
  assert.throws(() =>
    validateServiceConfiguration(
      { ...service, Config: { ...service.Config, Cmd: ["unexpected"] } },
      base,
      serviceHistory,
      baseHistory,
    ),
  );
  assert.throws(() =>
    validateServiceConfiguration(service, base, ["TOKEN=value", ...serviceHistory], baseHistory),
  );
  assert.throws(() =>
    validateServiceConfiguration(
      { ...service, RootFS: { Layers: [imageId("9"), ...service.RootFS.Layers.slice(1)] } },
      base,
      serviceHistory,
      baseHistory,
    ),
  );
});

test("OCI descriptors and blobs must resolve to the tested Docker config identity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "service-oci-layout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const blobs = join(directory, "blobs/sha256");
  await mkdir(blobs, { recursive: true });
  const layers = [imageId("1"), imageId("2")];
  const config = Buffer.from(
    JSON.stringify({
      config: {
        User: "node",
        WorkingDir: "/app",
        Entrypoint: ["node", "/app/dist/repository-credentials.js"],
        Env: ["PATH=/usr/bin"],
      },
      rootfs: { type: "layers", diff_ids: layers },
    }),
  );
  const configDigest = `sha256:${hash(config)}`;
  await writeFile(join(blobs, hash(config)), config);
  const layer = Buffer.from("synthetic-layer");
  const layerDigest = `sha256:${hash(layer)}`;
  await writeFile(join(blobs, hash(layer)), layer);
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: configDigest,
        size: config.length,
      },
      layers: [
        {
          mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
          digest: layerDigest,
          size: layer.length,
        },
      ],
    }),
  );
  const manifestDigest = `sha256:${hash(manifest)}`;
  await writeFile(join(blobs, hash(manifest)), manifest);
  await writeFile(join(directory, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  await writeFile(
    join(directory, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: manifestDigest,
          size: manifest.length,
          annotations: { "org.opencontainers.image.ref.name": "service" },
        },
      ],
    }),
  );
  const service = {
    Id: configDigest,
    Config: {
      User: "node",
      WorkingDir: "/app",
      Entrypoint: ["node", "/app/dist/repository-credentials.js"],
      Env: ["PATH=/usr/bin"],
    },
    RootFS: { Layers: layers },
  };
  assert.equal((await validateOciLayout(directory, service)).configDigest, configDigest);
  await writeFile(join(blobs, hash(layer)), "changed");
  await assert.rejects(() => validateOciLayout(directory, service));
});

async function cleanupFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "service-export-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "output");
  await mkdir(output);
  const archive = Buffer.from("synthetic OCI archive");
  await writeFile(join(output, "repository-credentials-service.oci.tar"), archive);
  const receipt = laneFixture().receipt;
  const receiptPath = join(directory, "receipt.json");
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  await writeFile(receiptPath, receiptBytes);
  await writeFile(
    join(output, "export.json"),
    JSON.stringify({
      version: 1,
      kind: "repository-credentials-service-oci-preparation",
      lane: { receiptSha256: hash(receiptBytes) },
      archive: { path: "repository-credentials-service.oci.tar", sha256: hash(archive) },
      cleanup: {
        status: "pending",
        ownedTags: [
          receipt.images.service.tag,
          receipt.images.client.tag,
          receipt.images.qualification.tag,
        ],
        container: "openclaw-service-export-123-1",
      },
    }),
  );
  const docker = join(directory, "docker");
  await writeFile(
    docker,
    `#!${process.execPath}\n` +
      "const args = process.argv.slice(2);\n" +
      "const target = args.at(-1);\n" +
      'if (process.env.SURVIVE_TAG && target === process.env.SURVIVE_TAG) { console.log("[]"); process.exit(0); }\n' +
      'if (process.env.UNKNOWN_ABSENCE) { console.error("daemon unavailable"); process.exit(1); }\n' +
      'console.error(args[0] === "container" ? "No such container" : "No such image");\n' +
      "process.exit(1);\n",
  );
  await chmod(docker, 0o700);
  return { directory, docker, output, receiptPath, statePath: join(directory, "state.json") };
}

function reconcile(fixture, env = {}) {
  return spawnSync(
    process.execPath,
    [script, "reconcile", fixture.statePath, fixture.receiptPath, fixture.output],
    {
      cwd: root,
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", OCC_DOCKER_BIN: fixture.docker, ...env },
    },
  );
}

test("cleanup reconciliation accepts only absent state, tags and inspection container", async (t) => {
  const successful = await cleanupFixture(t);
  const result = reconcile(successful);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(await readFile(join(successful.output, "export.json"))).cleanup.status,
    "verified",
  );

  const stateRetained = await cleanupFixture(t);
  await writeFile(stateRetained.statePath, "{}");
  assert.notEqual(reconcile(stateRetained).status, 0);

  const tagRetained = await cleanupFixture(t);
  assert.notEqual(
    reconcile(tagRetained, { SURVIVE_TAG: laneFixture().receipt.images.client.tag }).status,
    0,
  );

  const unknown = await cleanupFixture(t);
  assert.notEqual(reconcile(unknown, { UNKNOWN_ABSENCE: "1" }).status, 0);

  const changedArchive = await cleanupFixture(t);
  await writeFile(join(changedArchive.output, "repository-credentials-service.oci.tar"), "changed");
  assert.notEqual(reconcile(changedArchive).status, 0);
});

test("workflow uploads only after the opt-in lane action completes cleanup verification", async () => {
  const action = await readFile(join(root, ".github/actions/run-ci-lane/action.yml"), "utf8");
  const workflow = await readFile(
    join(root, ".github/workflows/repository-service-export.yml"),
    "utf8",
  );
  assert.match(action, /export-service-image:\n[\s\S]*?default: "false"/);
  assert.ok(
    action.indexOf("service-image-export.mjs export") < action.indexOf("name: Cleanup lane"),
  );
  assert.ok(
    action.indexOf("name: Cleanup lane") < action.indexOf("service-image-export.mjs reconcile"),
  );
  assert.match(
    workflow,
    /lane: repository-credentials-container[\s\S]*?export-service-image: "true"/,
  );
  assert.ok(
    workflow.indexOf("uses: .\/.github\/actions\/run-ci-lane") <
      workflow.indexOf("name: Upload preparation-only OCI archive"),
  );
  assert.doesNotMatch(workflow, /packages:\s*write|docker push|skopeo copy[^\n]*docker:\/\//);
  assert.match(workflow, /retention-days: 1/g);
});
