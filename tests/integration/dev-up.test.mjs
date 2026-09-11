import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  composeInvocations,
  composeOptions,
  createFixture,
  customRuntimeOverride,
  defaultRuntimeImage,
  matchingInstallationId,
  mismatchedInstallationId,
  perImageOverride,
  publicControllerOverride,
  readJsonLines,
  runDevUp,
  serviceKey,
} from "../helpers/dev-up.mjs";

async function createPreparedContext(fixture) {
  const context = join(fixture.directory, "prepared runtime context");
  await mkdir(join(context, "artifacts"), { recursive: true });
  const dependencies = { "@openai/codex": "0.153.0" };
  const packages = [];
  const lockPackages = {
    "node_modules/@openai/codex": {
      version: "0.153.0",
      resolved: "https://registry.npmjs.org/@openai/codex/-/codex-0.153.0.tgz",
    },
  };
  const files = [];
  const writeContextFile = async (path, content) => {
    await writeFile(join(context, path), content);
    files.push({
      path,
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  };
  // This suite exercises real receipt verification and dev-up's build boundary;
  // archive installation is covered by the package-preparation and image suites.
  for (const [name, filename] of [
    ["openclaw", "openclaw.tgz"],
    ["@openclaw/ai", "openclaw-ai.tgz"],
    ["@openclaw/slack", "slack.tgz"],
    ["@openclaw/msteams", "msteams.tgz"],
    ["@openclaw/codex", "codex.tgz"],
  ]) {
    const archive = `artifacts/${filename}`;
    const content = `dev-up receipt fixture for ${name}\n`;
    const integrity = `sha512-${createHash("sha512").update(content).digest("base64")}`;
    const version = "2026.8.1";
    await writeContextFile(archive, content);
    dependencies[name] = `file:./${archive}`;
    packages.push({ name, version, archive, integrity });
    lockPackages[`node_modules/${name}`] = { version, integrity, resolved: `file:${archive}` };
  }
  const manifest = {
    name: "dev-up-runtime-fixture",
    version: "0.0.0",
    private: true,
    dependencies,
  };
  await writeContextFile("package.json", `${JSON.stringify(manifest)}\n`);
  await writeContextFile(
    "package-lock.json",
    `${JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages: { "": manifest, ...lockPackages },
    })}\n`,
  );
  await writeFile(
    join(context, "preparation.json"),
    `${JSON.stringify({
      schema: "oce.runtime-packages/v1",
      status: "prepared",
      platform: "linux/amd64",
      nativeCodexVersion: "0.153.0",
      files,
      packages,
    })}\n`,
  );
  return context;
}

test("dev-up builds the missing default runtime from its verified prepared context", async (t) => {
  const fixture = await createFixture(t, { defaultRuntimeAvailable: false });
  fixture.env.OCC_RUNTIME_BUILD_CONTEXT = await createPreparedContext(fixture);
  const keyDirectory = join(fixture.directory, "private key directory");
  await mkdir(keyDirectory, { mode: 0o700 });
  const keyOutput = join(keyDirectory, "service-key.json");
  const options = composeOptions(fixture);

  const result = runDevUp(["--key-output", keyOutput, "--", ...options], fixture.env);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OpenClaw Enterprise development stack is ready/);
  assert.ok(result.stdout.includes("API URL: http://127.0.0.1:3000"));
  assert.ok(result.stdout.includes(`Installation ID: ${matchingInstallationId}`));
  assert.ok(result.stdout.includes(`Service key file: ${keyOutput}`));
  assert.ok(result.stdout.includes(`OCC_SERVICE_KEY_FILE=${keyOutput.replaceAll(" ", "\\ ")}`));
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));

  const outputMode = (await stat(keyOutput)).mode & 0o777;
  assert.equal(outputMode & 0o077, 0);

  const dockerLogs = await readJsonLines(fixture.dockerLog);
  assert.ok(
    dockerLogs.some((entry) => entry.args.join(" ") === `image inspect ${defaultRuntimeImage}`),
  );
  assert.deepEqual(
    dockerLogs.filter((entry) => entry.args[0] === "build").map((entry) => entry.args),
    [
      [
        "build",
        "-f",
        "deploy/runtime/Dockerfile",
        "--tag",
        defaultRuntimeImage,
        fixture.env.OCC_RUNTIME_BUILD_CONTEXT,
      ],
    ],
  );
  assert.ok(
    dockerLogs.some(
      (entry) =>
        entry.args[0] === "compose" &&
        entry.args.includes("config") &&
        entry.args.includes("--format") &&
        entry.args.includes("json"),
    ),
  );
  assert.ok(
    dockerLogs.some(
      (entry) =>
        entry.args[0] === "compose" &&
        entry.args.includes("up") &&
        entry.args.includes("--build") &&
        entry.args.includes("-d") &&
        entry.env.OCC_DOCKER_RUNTIME_IMAGE === defaultRuntimeImage,
    ),
  );
  assert.ok(
    dockerLogs.some(
      (entry) =>
        entry.args[0] === "compose" &&
        entry.args.includes("exec") &&
        entry.args.includes("worker") &&
        entry.args.includes("scripts/production-healthcheck.mjs") &&
        entry.args.at(-1) === "ready",
    ),
  );
  for (const invocation of composeInvocations(dockerLogs)) {
    assert.deepEqual(invocation.args.slice(1, 1 + options.length), options);
  }

  const curlLogs = await readJsonLines(fixture.curlLog);
  assert.equal(curlLogs.length, 1);
  assert.ok(curlLogs[0].args.includes("http://127.0.0.1:3000/installation"));
  assert.doesNotMatch(JSON.stringify(curlLogs), new RegExp(serviceKey));
});

test("dev-up reuses the default runtime without requiring or inspecting a build context", async (t) => {
  const fixture = await createFixture(t);
  const keyOutput = join(fixture.directory, "reused-service-key.json");

  // An existing image must remain usable even when an unrelated build context is invalid.
  const result = runDevUp(["--key-output", keyOutput, "--", ...composeOptions(fixture)], {
    ...fixture.env,
    OCC_RUNTIME_BUILD_CONTEXT: "not-an-absolute-context",
  });

  assert.equal(result.status, 0, result.stderr);
  const dockerLogs = await readJsonLines(fixture.dockerLog);
  assert.ok(
    dockerLogs.some((entry) => entry.args.join(" ") === `image inspect ${defaultRuntimeImage}`),
  );
  assert.equal(
    dockerLogs.some((entry) => entry.args[0] === "build"),
    false,
  );
  assert.ok(dockerLogs.some((entry) => entry.args[0] === "compose" && entry.args.includes("up")));
});

for (const { name, context, message } of [
  { name: "missing", context: "", message: /OCC_RUNTIME_BUILD_CONTEXT is required/ },
  {
    name: "relative",
    context: "relative-context",
    message: /OCC_RUNTIME_BUILD_CONTEXT must be an absolute prepared directory/,
  },
]) {
  test(`dev-up rejects a ${name} build context before building or starting services`, async (t) => {
    const fixture = await createFixture(t, { defaultRuntimeAvailable: false });
    const keyOutput = join(fixture.directory, "unprepared-service-key.json");

    const result = runDevUp(["--key-output", keyOutput, "--", ...composeOptions(fixture)], {
      ...fixture.env,
      OCC_RUNTIME_BUILD_CONTEXT: context,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.match(result.stderr, /deploy\/runtime\/README\.md/);
    const dockerLogs = await readJsonLines(fixture.dockerLog);
    assert.equal(
      dockerLogs.some(
        (entry) =>
          entry.args[0] === "build" || (entry.args[0] === "compose" && entry.args.includes("up")),
      ),
      false,
    );
    assert.equal((await readJsonLines(fixture.curlLog)).length, 0);
  });
}

test("dev-up rejects changed prepared artifacts before building or starting services", async (t) => {
  const fixture = await createFixture(t, { defaultRuntimeAvailable: false });
  const context = await createPreparedContext(fixture);
  // A receipt that no longer identifies its artifact bytes must stop the build.
  await writeFile(join(context, "artifacts", "slack.tgz"), "changed after preparation\n");
  const keyOutput = join(fixture.directory, "changed-context-service-key.json");

  const result = runDevUp(["--key-output", keyOutput, "--", ...composeOptions(fixture)], {
    ...fixture.env,
    OCC_RUNTIME_BUILD_CONTEXT: context,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime image failed: prepared context verification failed/);
  const dockerLogs = await readJsonLines(fixture.dockerLog);
  assert.equal(
    dockerLogs.some(
      (entry) =>
        entry.args[0] === "build" || (entry.args[0] === "compose" && entry.args.includes("up")),
    ),
    false,
  );
  assert.equal((await readJsonLines(fixture.curlLog)).length, 0);
});

test("dev-up preserves a selected custom runtime image and skips the quickstart build", async (t) => {
  const fixture = await createFixture(t);
  const keyOutput = join(fixture.directory, "custom-service-key.json");
  const env = {
    ...fixture.env,
    OPENCLAW_DEV_PORT: "4137",
    OCC_RUNTIME_BUILD_CONTEXT: "not-an-absolute-context",
  };
  const override = await customRuntimeOverride(fixture);
  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture, override)],
    env,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /API URL: http:\/\/127\.0\.0\.1:4137/);
  const dockerLogs = await readJsonLines(fixture.dockerLog);
  assert.ok(
    dockerLogs.some((entry) => entry.args.join(" ") === "image inspect custom-runtime:local"),
  );
  assert.equal(
    dockerLogs.some((entry) => entry.args[0] === "build"),
    false,
  );
  assert.equal(
    dockerLogs.some(
      (entry) =>
        entry.args[0] === "compose" &&
        entry.args.includes("up") &&
        entry.env.OCC_DOCKER_RUNTIME_IMAGE === defaultRuntimeImage,
    ),
    false,
  );
});

test("dev-up applies per-image overrides on top of the shared runtime image", async (t) => {
  const fixture = await createFixture(t);
  const keyOutput = join(fixture.directory, "mixed-runtime-service-key.json");
  const override = await perImageOverride(fixture);

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture, override)],
    fixture.env,
  );

  assert.equal(result.status, 0, result.stderr);
  const dockerLogs = await readJsonLines(fixture.dockerLog);
  assert.ok(
    dockerLogs.some((entry) => entry.args.join(" ") === "image inspect custom-gateway:local"),
  );
  assert.ok(
    dockerLogs.some((entry) => entry.args.join(" ") === "image inspect shared-runtime:local"),
  );
  assert.equal(
    dockerLogs.some((entry) => entry.args[0] === "build"),
    false,
  );
});

test("dev-up rejects a public controller port rendered by real Compose", async (t) => {
  const fixture = await createFixture(t);
  const keyOutput = join(fixture.directory, "public-controller-key.json");
  const override = await publicControllerOverride(fixture);

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture, override)],
    fixture.env,
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /configuration failed: Compose controller port must publish only on loopback/,
  );
  const dockerLogs = await readJsonLines(fixture.dockerLog);
  assert.equal(
    dockerLogs.some((entry) => entry.args[0] === "compose" && entry.args.includes("up")),
    false,
  );
});

test("dev-up refuses an existing key destination before invoking Compose", async (t) => {
  const fixture = await createFixture(t);
  const keyOutput = join(fixture.directory, "existing-service-key.json");
  await writeFile(keyOutput, "keep-existing\n", { mode: 0o600 });

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture)],
    fixture.env,
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /key output failed: destination already exists/);
  assert.equal(await readFile(keyOutput, "utf8"), "keep-existing\n");
  assert.equal((await readJsonLines(fixture.dockerLog)).length, 0);
});

test("dev-up fails closed when bootstrap exits unsuccessfully", async (t) => {
  const fixture = await createFixture(t, { scenario: "bootstrap-failed" });
  const keyOutput = join(fixture.directory, "bootstrap-failure-key.json");

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture)],
    fixture.env,
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /startup failed: bootstrap exited with 1/);
  assert.match(result.stderr, /diagnostic: docker compose .* ps --all bootstrap/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));
  const dockerLogs = await readJsonLines(fixture.dockerLog);
  assert.equal(
    dockerLogs.some((entry) => entry.args[0] === "compose" && entry.args.includes("cp")),
    false,
  );
  assert.equal((await readJsonLines(fixture.curlLog)).length, 0);
});

test("dev-up fails closed when the worker exits before readiness", async (t) => {
  const fixture = await createFixture(t, { scenario: "worker-exited" });
  const keyOutput = join(fixture.directory, "readiness-failure-key.json");

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture)],
    fixture.env,
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /startup failed: worker exited with 1/);
  assert.match(result.stderr, /diagnostic: docker compose .* logs worker/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));
  const dockerLogs = await readJsonLines(fixture.dockerLog);
  assert.equal(
    dockerLogs.some((entry) => entry.args[0] === "compose" && entry.args.includes("cp")),
    false,
  );
});

test("dev-up preserves a copied key when the authenticated installation check is rejected", async (t) => {
  const fixture = await createFixture(t, { scenario: "api-unauthorized" });
  const keyOutput = join(fixture.directory, "unauthorized-key.json");

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture)],
    fixture.env,
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /authorization failed: scripts\/occ-api could not read \/installation/,
  );
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));
  assert.match(await readFile(keyOutput, "utf8"), new RegExp(serviceKey));
});

test("dev-up rejects an authenticated installation response for a different Installation", async (t) => {
  const fixture = await createFixture(t, { scenario: "api-mismatch" });
  const keyOutput = join(fixture.directory, "mismatch-key.json");

  const result = runDevUp(
    ["--key-output", keyOutput, "--", ...composeOptions(fixture)],
    fixture.env,
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`Installation ID mismatch.*${mismatchedInstallationId}`));
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(serviceKey));
  assert.match(await readFile(keyOutput, "utf8"), new RegExp(serviceKey));
});
