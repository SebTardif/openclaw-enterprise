import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  NATIVE_PERMISSIONS,
  SELECTED_NATIVE_TOOLS,
  NativeClientError,
  gitConfiguration,
  nativeEnvironment,
  parseCredentialInput,
  permissionProfile,
  planNativeCommand,
  scrubNativeOutput,
  validateGitConfig,
  validateRelease,
} from "../../packages/github-sts/src/client-mechanics.ts";
import { createNativeClient, runNativeStep } from "../../packages/github-sts/src/client.ts";
import {
  fixtureRepository,
  prepareSelectedNativeCase,
  selectedNativeConfiguration,
  runNativeSetupCommand,
  startNativeEndpoint,
  syntheticAttempt,
  syntheticDelivery,
  syntheticRelease,
} from "../fixtures/github-sts-client/native-endpoint.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = join(root, "tests/fixtures/github-sts-client/native-endpoint.mjs");
const tools = {
  node: process.execPath,
  git: process.execPath,
  gh: process.execPath,
  helper: join(root, "packages/github-sts/bin/git-credential-github-sts.mjs"),
  ghWrapper: join(root, "packages/github-sts/bin/gh.mjs"),
};
const ids = Array.from({ length: 15 }, (_, index) => `G${String(index + 1).padStart(2, "0")}`);
const input = (id) => ({
  id,
  operationRef: `operation/${id}`,
  checkout: "/fixture/checkout",
  files: ["README.md"],
  message: "Synthetic change",
  title: "Synthetic draft",
  bodyFile: "/fixture/body.md",
  bodySha256: `sha256:${"a".repeat(64)}`,
  intendedHeadCommit: "2".repeat(40),
});
const request = (original, id = "G12") => ({
  original,
  repository: fixtureRepository,
  command: id,
  operationRef: `operation/${id}`,
  permissionProfile: permissionProfile(id),
  intendedHeadCommit: "2".repeat(40),
});
async function setup(t, original, delivery, overrides = {}) {
  const directory = await mkdtemp(join(root, "native-client-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    home: directory,
    options: {
      original,
      repository: fixtureRepository,
      delivery,
      tools,
      scratchParent: directory,
      exclusiveCheckout: true,
      signal: new AbortController().signal,
      timeoutMs: 1500,
      ...overrides,
    },
  };
}
const probe = (mode, args = [], mutation = false) => ({
  tool: "gh",
  args: [fixture, "probe", mode, ...args],
  repositoryConfig: false,
  mutation,
});

test("selected G01–G15 planning uses explicit profiles, token-free URLs and bounded ordinary commands", () => {
  assert.equal(SELECTED_NATIVE_TOOLS.git.version, "2.55.0");
  assert.equal(SELECTED_NATIVE_TOOLS.gh.version, "2.93.0");
  for (const id of ids) {
    const steps = planNativeCommand(input(id), fixtureRepository);
    assert.ok(steps.length > 0 && steps.length <= 4);
    assert.ok(steps.every((step) => Object.isFrozen(step) && Object.isFrozen(step.args)));
    assert.ok(
      steps.flatMap((step) => step.args).every((value) => !value.includes("x-access-token:")),
    );
  }
  assert.equal(NATIVE_PERMISSIONS[permissionProfile("G08")].issues, "read");
  assert.equal(NATIVE_PERMISSIONS[permissionProfile("G11")].issues, "read");
  assert.equal(NATIVE_PERMISSIONS[permissionProfile("G11")].pull_requests, "write");
  assert.equal("administration" in NATIVE_PERMISSIONS[permissionProfile("G11")], false);
  assert.deepEqual(planNativeCommand(input("G06"), fixtureRepository)[0].args.slice(-3), [
    "push",
    "origin",
    `${"2".repeat(40)}:refs/heads/oce-demo/fixture-change`,
  ]);
  assert.ok(
    planNativeCommand(input("G11"), fixtureRepository)[0].args.includes("--no-maintainer-edit"),
  );
  assert.ok(
    planNativeCommand(input("G02"), fixtureRepository)[0].args.includes("--no-recurse-submodules"),
  );
  assert.throws(
    () => planNativeCommand({ ...input("G06"), intendedHeadCommit: undefined }, fixtureRepository),
    NativeClientError,
  );
  for (const bad of [
    { ...input("G05"), files: ["../outside"] },
    { ...input("G11"), title: "a\nb" },
    { ...input("G12"), id: "G99" },
  ])
    assert.throws(() => planNativeCommand(bad, fixtureRepository), NativeClientError);
});

test("managed environment and config reject executable and alternate credential paths", () => {
  const env = nativeEnvironment("/fixture/home", tools, fixtureRepository);
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_DEBUG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_TRACE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "GIT_EXEC_PATH",
  ])
    assert.equal(env[key], undefined);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GH_PROMPT_DISABLED, "1");
  const settings = gitConfiguration(tools.helper, tools.node);
  for (const setting of [
    "credential.helper=",
    "credential.useHttpPath=true",
    "http.followRedirects=false",
    "protocol.allow=never",
    "http.sslVerify=true",
  ])
    assert.ok(settings.includes(setting));
  assert.ok(settings.includes("user.name=OCE Native Client"));
  assert.ok(settings.includes("user.email=native-client@local.invalid"));
  const good =
    "core.repositoryformatversion\n0\0core.bare\nfalse\0remote.origin.url\nhttps://github.com/fixture/mirror.git\0";
  assert.doesNotThrow(() => validateGitConfig(good, "https://github.com/fixture/mirror.git"));
  for (const key of [
    "include.path",
    "hook.pre-commit.command",
    "filter.lfs.smudge",
    "diff.external",
    "credential.helper",
    "http.extraheader",
    "url.http://other/.insteadof",
    "extensions.partialclone",
    "core.sshcommand",
  ])
    assert.throws(() =>
      validateGitConfig(`${good}${key}\nunsafe\0`, "https://github.com/fixture/mirror.git"),
    );
  assert.throws(() =>
    validateGitConfig(`${good}core.bare\nfalse\0`, "https://github.com/fixture/mirror.git"),
  );
});

test("credential input rejects ambiguity, controls, trailing records and unsupported destinations", () => {
  const good = "protocol=https\nhost=github.com\npath=fixture/mirror.git\n\n";
  assert.equal(parseCredentialInput(good).path, "fixture/mirror.git");
  assert.equal(parseCredentialInput(good.slice(0, -1)).path, "fixture/mirror.git");
  assert.equal(
    parseCredentialInput("capability[]=authtype\ncapability[]=state\n" + good).path,
    "fixture/mirror.git",
  );
  for (const value of [
    good + "password=trailing\n",
    good.replace("\n\n", ""),
    good.replace("https", "http"),
    good.replace("github.com", "elsewhere.invalid"),
    good.replace("path=", "host=github.com\npath="),
    good.replace("fixture/", "fixture/\t"),
    good.replace("path=fixture/mirror.git\n", ""),
  ])
    assert.throws(() => parseCredentialInput(value), NativeClientError);
});

test("release rejects expired, malformed, cancelled or successor-attempt delivery", () => {
  const original = syntheticAttempt();
  const current = request(original);
  const release = syntheticRelease(original);
  const controller = new AbortController();
  assert.equal(
    validateRelease(release, current, Date.now(), controller.signal),
    Date.parse(release.expiresAt),
  );
  for (const bad of [
    { ...release, expiresAt: "invalid" },
    { ...release, expiresAt: new Date(0).toISOString() },
    { ...release, attemptRef: "attempt/B" },
    { ...release, canonicalBindingDigest: `sha256:${"0".repeat(64)}` },
  ])
    assert.throws(
      () => validateRelease(bad, current, Date.now(), controller.signal),
      NativeClientError,
    );
  assert.throws(() =>
    validateRelease(
      release,
      { ...current, original: { ...original, turnNotAfter: "invalid" } },
      Date.now(),
      controller.signal,
    ),
  );
  controller.abort();
  assert.throws(() => validateRelease(release, current, Date.now(), controller.signal));
});

async function helper(action, input, frameReply) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tools.helper, action], {
      env: { OCE_NATIVE_CREDENTIAL_FD: "3" },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let pipeInput = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdio[3].on("data", (chunk) => {
      pipeInput += chunk;
      if (pipeInput.includes("\n")) child.stdio[3].write(`${JSON.stringify(frameReply)}\n`);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr, pipeInput }));
    child.stdin.end(input);
  });
}

test("real helper subprocess uses private pipe expiry and quit=true without credential persistence", async () => {
  const release = syntheticRelease(syntheticAttempt());
  const input = "protocol=https\nhost=github.com\npath=fixture/mirror.git\n\n";
  const result = await helper("get", input, {
    kind: "token",
    token: release.token,
    expiresAt: release.expiresAt,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.stdout.includes(`password=${release.token}\n`));
  assert.ok(
    result.stdout.includes(
      `password_expiry_utc=${Math.floor(Date.parse(release.expiresAt) / 1000)}\n`,
    ),
  );
  assert.equal(JSON.parse(result.pipeInput).kind, "get");
  for (const reply of [
    { kind: "denied" },
    { kind: "token", token: release.token, expiresAt: new Date(0).toISOString() },
  ]) {
    const failed = await helper("get", input, reply);
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout, "quit=true\n\n");
  }
  const stored = await helper("store", input, undefined);
  assert.equal(stored.stdout, "");
  assert.equal(stored.pipeInput, "");
  const erased = await helper("erase", input, { kind: "erased" });
  assert.equal(JSON.parse(erased.pipeInput).kind, "erase");
  assert.equal(erased.stdout, "");
});

test("new wrapper children acquire fresh A tokens while B cannot replace a retained A invocation", async (t) => {
  const original = syntheticAttempt("A");
  const first = syntheticRelease(original, "one");
  const second = syntheticRelease(original, "two");
  const delivery = syntheticDelivery(() => (delivery.requests.length === 1 ? first : second));
  const { home, options } = await setup(t, original, delivery);
  const endpoint = await startNativeEndpoint({ releases: [first, second] });
  t.after(() => endpoint.close());
  const result1 = await runNativeStep(
    probe("http", [`${endpoint.url}/repos/fixture/mirror`]),
    request(original),
    options,
    home,
  );
  const result2 = await runNativeStep(
    probe("http", [`${endpoint.url}/repos/fixture/mirror`]),
    request(original),
    options,
    home,
  );
  assert.equal(result1.status, "completed", result1.stderr);
  assert.equal(result2.status, "completed", result2.stderr);
  assert.deepEqual(
    endpoint.observations.map((item) => item.tokenOrdinal),
    [0, 1],
  );
  assert.deepEqual(
    delivery.requests.map((item) => item.original.attemptRef),
    ["attempt/A", "attempt/A"],
  );
  // Deliver B maliciously to an A-bound invocation: the real client rejects before child release.
  const wrong = syntheticDelivery(() => syntheticRelease(syntheticAttempt("B")));
  const failed = await runNativeStep(
    probe("environment"),
    request(original),
    { ...options, delivery: wrong },
    home,
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.stdout, "");
  assert.equal(endpoint.observations.length, 2);
});

test("wrapper child environment and split-chunk collector suppress managed token disclosure", async (t) => {
  const original = syntheticAttempt();
  const token = syntheticRelease(original);
  const { home, options } = await setup(
    t,
    original,
    syntheticDelivery(() => token),
  );
  const environment = await runNativeStep(
    probe("environment", ["reviewed-argument"]),
    request(original),
    options,
    home,
  );
  assert.deepEqual(JSON.parse(environment.stdout), {
    hasToken: true,
    hasPipe: false,
    hasAlternate: false,
    hasDebug: false,
    args: ["reviewed-argument"],
  });
  const canary = await runNativeStep(probe("canary"), request(original), options, home);
  assert.equal(canary.stdout, "[credential]");
  assert.equal(canary.stderr, "[credential]");
  assert.equal(
    scrubNativeOutput(Buffer.from(token.token).toString("base64"), [token.token]),
    "[credential]",
  );
  assert.deepEqual(
    await readdir(home),
    [],
    "Client probe must not create a persistent gh login/config file.",
  );
});

test("late acquisition observes cancellation and keeps original operation after request mutation", async (t) => {
  const original = syntheticAttempt("A");
  const controller = new AbortController();
  const reached = Promise.withResolvers();
  const delayed = Promise.withResolvers();
  const delivery = syntheticDelivery(async () => {
    reached.resolve();
    return delayed.promise;
  });
  const { home, options } = await setup(t, original, delivery, { signal: controller.signal });
  const descriptor = request(original, "G11");
  const step = probe("environment", [], true);
  const running = runNativeStep(step, descriptor, options, home);
  await reached.promise;
  step.mutation = false;
  descriptor.original.attemptRef = "attempt/B";
  descriptor.intendedHeadCommit = "3".repeat(40);
  controller.abort();
  delayed.resolve(syntheticRelease(syntheticAttempt("A")));
  const result = await running;
  assert.equal(result.status, "unknown");
  assert.equal(result.nextAction, "exact-readback-only");
  assert.equal(result.operation.attemptRef, "attempt/A");
  assert.equal(result.operation.intendedCommit, "2".repeat(40));
  assert.equal(result.stdout, "");
});

test("ambiguous mutation performs one attempt and retains exact readback binding", async (t) => {
  const original = syntheticAttempt();
  const token = syntheticRelease(original);
  const delivery = syntheticDelivery(() => token);
  const { home, options } = await setup(t, original, delivery);
  const endpoint = await startNativeEndpoint({ releases: [token] });
  t.after(() => endpoint.close());
  const result = await runNativeStep(
    probe("ambiguous", [`${endpoint.url}/graphql`], true),
    request(original, "G11"),
    options,
    home,
  );
  assert.equal(result.status, "unknown");
  assert.equal(result.nextAction, "exact-readback-only");
  assert.equal(endpoint.creates, 1);
  assert.equal(delivery.requests.length, 1);
  assert.equal(result.operation.operationRef, "operation/G11");
  assert.equal(result.operation.intendedRef, "refs/heads/oce-demo/fixture-change");
  assert.equal(result.operation.intendedCommit, "2".repeat(40));
});

test("client construction snapshots options and original input without providing authority", async (t) => {
  const original = syntheticAttempt("A");
  const token = syntheticRelease(original);
  const delivery = syntheticDelivery(() => token);
  const { options } = await setup(t, original, delivery);
  const client = createNativeClient(options);
  original.attemptRef = "attempt/B";
  options.delivery = syntheticDelivery(() => {
    throw new Error("replacement callback must not run");
  });
  // G07 invokes a Node probe executable with native gh arguments, which fails. It
  // still exercises the real wrapper's acquisition against the captured A callback.
  const result = await client.run(input("G07"));
  assert.equal(result[0].status, "failed");
  assert.equal(delivery.requests[0].original.attemptRef, "attempt/A");
});

test("public setup rejects unexpected authentication without invoking delivery authority", async (t) => {
  const original = syntheticAttempt();
  const delivery = syntheticDelivery(() => syntheticRelease(original));
  const { home, options } = await setup(t, original, delivery);
  const result = await runNativeStep(probe("environment"), request(original, "G01"), options, home);
  assert.equal(result.status, "failed");
  assert.equal(delivery.requests.length, 0);
  assert.equal(result.stdout, "");
});

test("inherited pipe routes erase and caps total deliveries for a child lifetime", async (t) => {
  const original = syntheticAttempt();
  const delivery = syntheticDelivery(() => syntheticRelease(original));
  const { home, options } = await setup(t, original, delivery);
  const direct = { ...options, tools: { ...tools, ghWrapper: fixture } };
  const erase = await runNativeStep(
    { tool: "gh", args: ["pipe-probe", "erase"], repositoryConfig: false, mutation: false },
    request(original),
    direct,
    home,
  );
  assert.equal(erase.status, "completed");
  assert.deepEqual(JSON.parse(erase.stdout), { received: 1, kind: "erased" });
  assert.equal(delivery.erased.length, 1);
  assert.equal(delivery.erased[0].original.attemptRef, original.attemptRef);
  assert.equal(delivery.requests.length, 0);
  const capped = await runNativeStep(
    { tool: "gh", args: ["pipe-probe", "get", "9"], repositoryConfig: false, mutation: false },
    request(original),
    direct,
    home,
  );
  assert.equal(capped.status, "failed");
  assert.equal(
    delivery.requests.length,
    8,
    "Nine sequential requests must hit the lifetime bound even with one frame in flight.",
  );
});

test("child completion waits for delivery settlement and fails after a post-release rejection", async (t) => {
  const original = syntheticAttempt();
  const token = syntheticRelease(original);
  const released = Promise.withResolvers();
  const settlement = Promise.withResolvers();
  const delivery = {
    async withCurrentToken(_request, release) {
      release(token);
      released.resolve();
      await settlement.promise;
    },
    async invalidateRuntimeReuse() {},
  };
  const { home, options } = await setup(t, original, delivery);
  const running = runNativeStep(
    probe("environment", [], true),
    request(original, "G11"),
    options,
    home,
  );
  await released.promise;
  const observed = await Promise.race([
    running.then(() => "premature"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 100)),
  ]);
  assert.equal(observed, "pending");
  settlement.reject(new Error("Synthetic owner rejects after release."));
  const result = await running;
  assert.equal(result.status, "unknown");
  assert.equal(result.stdout, "");
  assert.equal(result.nextAction, "exact-readback-only");
});

test("unsettled delivery expires locally without reporting child success", async (t) => {
  const original = syntheticAttempt();
  const token = syntheticRelease(original);
  const settlement = Promise.withResolvers();
  let calls = 0;
  const delivery = {
    async withCurrentToken(_request, release) {
      calls += 1;
      release(token);
      await settlement.promise;
    },
    async invalidateRuntimeReuse() {},
  };
  const { home, options } = await setup(t, original, delivery, { timeoutMs: 500 });
  const result = await runNativeStep(
    probe("environment", [], true),
    request(original, "G11"),
    options,
    home,
  );
  settlement.resolve();
  assert.equal(result.status, "unknown");
  assert.equal(calls, 1);
  assert.equal(result.stdout, "");
});

test("PR planning copies a bounded reviewed body before awaits and retains its full reconciliation tuple", async (t) => {
  const original = syntheticAttempt();
  const delivery = syntheticDelivery(() => {
    throw new Error("Planner probe must not request a token.");
  });
  const { home, options } = await setup(t, original, delivery);
  const bodyFile = join(home, "reviewed.md");
  const body = "Reviewed synthetic body.\n";
  const bodySha256 = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  await writeFile(bodyFile, body);
  const command = { ...input("G11"), bodyFile, bodySha256 };
  // Deliberately substitute a Node planner probe for the wrapper. This asserts
  // snapshot/argument mechanics only, not gh execution or remote PR acceptance.
  const client = createNativeClient({ ...options, tools: { ...tools, ghWrapper: fixture } });
  const running = client.run(command);
  command.title = "Changed caller title";
  command.intendedHeadCommit = "3".repeat(40);
  await writeFile(bodyFile, "Changed caller body.\n");
  const [result] = await running;
  assert.equal(result.status, "completed", result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    bodyDigest: bodySha256,
    title: "Synthetic draft",
    base: "main",
    head: fixtureRepository.branch,
  });
  assert.equal(result.operation.bodyDigest, bodySha256);
  assert.equal(
    result.operation.titleDigest,
    `sha256:${createHash("sha256").update("Synthetic draft").digest("hex")}`,
  );
  assert.equal(result.operation.baseRef, "main");
  assert.equal(result.operation.intendedCommit, "2".repeat(40));
  assert.equal(result.operation.operationRef, "operation/G11");
  assert.equal(delivery.requests.length, 0);
  assert.deepEqual(
    await readdir(home),
    ["reviewed.md"],
    "Owned per-invocation PR snapshot is removed after process settlement.",
  );
  await writeFile(bodyFile, "x".repeat(16_385));
  await assert.rejects(client.run({ ...input("G11"), bodyFile, bodySha256 }), NativeClientError);
  // Invalid command syntax must be rejected before touching even a missing body.
  await assert.rejects(
    client.run({ ...input("G11"), title: "invalid\ntitle", bodyFile: join(home, "absent.md") }),
    NativeClientError,
  );
  await assert.rejects(
    client.run({ ...input("G11"), bodyFile: home, bodySha256 }),
    NativeClientError,
  );
});

test("native qualification selection rejects partial opt-in without starting native setup", async () => {
  assert.equal(await selectedNativeConfiguration({}), undefined);
  await assert.rejects(selectedNativeConfiguration({ OCE_NATIVE_QUALIFICATION: "1" }));
  await assert.rejects(
    selectedNativeConfiguration({ OCE_NATIVE_QUALIFICATION_FILE: "/not-selected.json" }),
  );
});

test("importing fixture helpers with gh PR arguments has no command-line probe side effects", async () => {
  const source = `process.argv[2] = "pr"; await import(${JSON.stringify(new URL("../fixtures/github-sts-client/native-endpoint.mjs", import.meta.url).href)});`;
  const output = await runNativeSetupCommand(
    process.execPath,
    ["--input-type=module", "-e", source],
    root,
    { PATH: "/usr/bin:/bin" },
  );
  assert.equal(output, "");
});

test("native setup cancellation stops and settles the actual subprocess", async (t) => {
  const home = await mkdtemp(join(root, "native-setup-cancel-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const marker = join(home, "unexpected.txt");
  const controller = new AbortController();
  const source = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"), 500);`;
  const running = runNativeSetupCommand(
    process.execPath,
    ["-e", source],
    home,
    { PATH: "/usr/bin:/bin" },
    controller.signal,
  );
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(running, /Selected local tool failed/);
  assert.deepEqual(await readdir(home), []);
  await assert.rejects(runNativeSetupCommand("/absent", [], home, {}, controller.signal), {
    name: "AbortError",
  });
});

// Source for all15 native cases is present. Execution is separately selected:
// missing opt-in skips; malformed opt-in or any prerequisite mismatch fails.
const nativeSelection = await selectedNativeConfiguration();
const nativeSkip =
  nativeSelection === undefined
    ? "Unrun: native fixture execution requires separate explicit opt-in and a verified selected-tool manifest."
    : false;
function nativeCase(id, body) {
  test(
    `${id} selected Git 2.55.0 / gh 2.93.0 subprocess qualification`,
    { skip: nativeSkip, timeout: 65_000 },
    async (t) => {
      const fixture = await prepareSelectedNativeCase(t, nativeSelection, id, root);
      const recorded = [];
      fixture.run = async (commandId, extra = {}, options = fixture.options) => {
        const command = {
          id: commandId,
          operationRef: `native/${id}/${commandId}`,
          checkout: fixture.checkout,
          intendedHeadCommit: fixture.repository.commit,
          ...extra,
        };
        const result = await createNativeClient(options).run(command);
        recorded.push(...result);
        return result;
      };
      try {
        await body(fixture, t);
      } finally {
        await fixture.verifyNoManagedToken(recorded);
        t.diagnostic(
          JSON.stringify({
            requests: fixture.endpoint.observations,
            children: await fixture.childObservations(),
            deliveryRequests: fixture.delivery.requests.length,
          }),
        );
      }
      // Bound native artifact identities independently from the GENERATED launcher
      // identities. A receipt's source commit is provenance supplied by preparation.
      t.diagnostic(
        JSON.stringify({
          selectedArtifacts: fixture.toolchain,
          generatedLaunchers: fixture.launchers,
        }),
      );
    },
  );
}
function allCompleted(results) {
  assert.ok(results.length > 0);
  for (const result of results) assert.equal(result.status, "completed", result.stderr);
  return results;
}
async function completeCheckout(fixture) {
  allCompleted(await fixture.run("G02"));
  allCompleted(await fixture.run("G03"));
}
async function createChange(fixture) {
  await completeCheckout(fixture);
  await writeFile(join(fixture.checkout, "README.md"), "Reviewed native fixture change.\n");
  allCompleted(
    await fixture.run("G05", { files: ["README.md"], message: "Reviewed native change" }),
  );
  return (await fixture.git(["-C", fixture.checkout, "rev-parse", "HEAD"])).trim();
}
const successful = (fixture, suffix) =>
  fixture.endpoint.observations.filter(
    (entry) => entry.path.endsWith(suffix) && entry.status === 200,
  );

nativeCase("G01", async (fixture) => {
  allCompleted(await fixture.run("G01"));
  assert.equal(
    (await fixture.git(["-C", fixture.checkout, "rev-parse", "HEAD"])).trim(),
    fixture.repository.commit,
  );
  for (const [path, expected] of Object.entries(fixture.expectedFiles))
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(fixture.checkout, path)))
        .digest("hex"),
      expected,
    );
  assert.equal(fixture.delivery.requests.length, 0);
  assert.ok(successful(fixture, "/git-upload-pack").length > 0);
  assert.ok(
    fixture.endpoint.observations.every(
      (entry) => !entry.hasAuthorization && entry.tokenOrdinal === -1,
    ),
  );
  assert.equal(
    (await fixture.git(["-C", fixture.checkout, "config", "--get", "remote.origin.url"])).trim(),
    "https://github.com/fixture/mirror.git",
  );
});

nativeCase("G02", async (fixture) => {
  allCompleted(await fixture.run("G02"));
  assert.ok(
    successful(fixture, "/info/refs").some((entry) => entry.query === "?service=git-upload-pack"),
  );
  assert.ok(successful(fixture, "/git-upload-pack").length > 0);
  assert.ok(
    fixture.delivery.requests.length > 0,
    "The real Git→transport→helper FD path must obtain a credential.",
  );
  assert.ok(fixture.endpoint.observations.some((entry) => entry.tokenOrdinal === 0));
  assert.equal(
    (await fixture.git(["-C", fixture.checkout, "rev-parse", "HEAD"])).trim(),
    fixture.repository.commit,
  );
  assert.deepEqual(
    (await readdir(fixture.checkout)).filter((name) => name !== ".git"),
    [],
    "Clone must not check out worktree files.",
  );
  const plan = planNativeCommand(
    { id: "G02", operationRef: "native/G02/G02", checkout: fixture.checkout },
    fixture.repository,
  )[0];
  const originalArgs = [
    ...gitConfiguration(fixture.options.tools.helper, fixture.options.tools.node).flatMap(
      (setting) => ["-c", setting],
    ),
    ...plan.args,
  ];
  assert.ok(
    (await fixture.childObservations()).some(
      (entry) =>
        entry.tool === "git" &&
        entry.hasCredentialFd &&
        entry.argvSha256 ===
          createHash("sha256").update(JSON.stringify(originalArgs)).digest("hex"),
    ),
  );
  const denied = syntheticDelivery(() => undefined);
  const before = fixture.endpoint.observations.length;
  const failed = await fixture.run(
    "G02",
    { checkout: join(fixture.home, "denied-checkout") },
    { ...fixture.options, delivery: denied },
  );
  assert.equal(failed.at(-1).status, "failed");
  assert.ok(denied.requests.length > 0);
  assert.ok(
    fixture.endpoint.observations.slice(before).every((entry) => !entry.hasAuthorization),
    "Failed helper acquisition must not fall back to another credential.",
  );
});

nativeCase("G03", async (fixture) => {
  await completeCheckout(fixture);
  assert.equal(
    (await fixture.git(["-C", fixture.checkout, "rev-parse", "HEAD"])).trim(),
    fixture.repository.commit,
  );
  const before = fixture.endpoint.observations.length;
  const missing = { ...fixture.repository, commit: "0".repeat(40) };
  const failed = await fixture.run("G03", {}, { ...fixture.options, repository: missing });
  assert.equal(failed.at(-1).status, "failed");
  assert.ok(fixture.endpoint.observations.length > before);
  assert.equal(
    (await fixture.git(["-C", fixture.checkout, "rev-parse", "HEAD"])).trim(),
    fixture.repository.commit,
    "Missing exact object cannot fall back to an arbitrary branch.",
  );
});

nativeCase("G04", async (fixture) => {
  await completeCheckout(fixture);
  await writeFile(join(fixture.checkout, "README.md"), "Local native diff canary.\n");
  const before = fixture.endpoint.observations.length;
  const acquisitions = fixture.delivery.requests.length;
  const results = allCompleted(await fixture.run("G04"));
  assert.match(results[0].stdout, / M README\.md/);
  assert.match(results[1].stdout, /Local native diff canary/);
  assert.match(results[2].stdout, /Synthetic native base/);
  assert.match(results[3].stdout, /HEAD detached/);
  assert.equal(fixture.endpoint.observations.length, before);
  assert.equal(fixture.delivery.requests.length, acquisitions);
});

nativeCase("G05", async (fixture) => {
  const oid = await createChange(fixture);
  assert.match(oid, /^[0-9a-f]{40}$/);
  assert.notEqual(oid, fixture.repository.commit);
  assert.equal(
    (await fixture.git(["-C", fixture.checkout, "branch", "--show-current"])).trim(),
    fixture.repository.branch,
  );
  assert.equal(
    (await fixture.git(["-C", fixture.checkout, "show", "-s", "--format=%an <%ae>", oid])).trim(),
    "OCE Native Client <native-client@local.invalid>",
  );
  assert.equal(
    (
      await fixture.git([
        "-C",
        fixture.checkout,
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        oid,
      ])
    ).trim(),
    "README.md",
  );
  assert.equal(
    await fixture.git(["-C", fixture.checkout, "show", `${oid}:README.md`]),
    "Reviewed native fixture change.\n",
  );
});

nativeCase("G06", async (fixture) => {
  const oid = await createChange(fixture);
  const before = successful(fixture, "/git-receive-pack").length;
  const result = allCompleted(await fixture.run("G06", { intendedHeadCommit: oid }))[0];
  assert.equal(result.nextAction, "exact-readback-only");
  assert.equal(successful(fixture, "/git-receive-pack").length - before, 1);
  assert.equal(
    (
      await fixture.git([
        "--git-dir",
        fixture.bare,
        "rev-parse",
        `refs/heads/${fixture.repository.branch}`,
      ])
    ).trim(),
    oid,
  );
  // A controlled lost response follows a real local receive-pack mutation. This
  // proves client ambiguity/no-replay, not GitHub branch-policy enforcement.
  await writeFile(join(fixture.checkout, "README.md"), "Second reviewed native change.\n");
  await fixture.git(["-C", fixture.checkout, "add", "README.md"]);
  await fixture.git([
    "-C",
    fixture.checkout,
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    "Second native change",
  ]);
  const nextOid = (await fixture.git(["-C", fixture.checkout, "rev-parse", "HEAD"])).trim();
  fixture.endpoint.model.dropPushAck = true;
  const postCount = () =>
    fixture.endpoint.observations.filter(
      (entry) => entry.method === "POST" && entry.path.endsWith("/git-receive-pack"),
    ).length;
  const prior = postCount();
  const unknown = (
    await fixture.run("G06", {
      intendedHeadCommit: nextOid,
      operationRef: "native/G06/lost-response",
    })
  )[0];
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.operation.intendedCommit, nextOid);
  assert.equal(unknown.operation.operationRef, "native/G06/lost-response");
  assert.equal(postCount() - prior, 1);
  assert.equal(
    (
      await fixture.git([
        "--git-dir",
        fixture.bare,
        "rev-parse",
        `refs/heads/${fixture.repository.branch}`,
      ])
    ).trim(),
    nextOid,
  );
});

nativeCase("G07", async (fixture) => {
  const first = allCompleted(await fixture.run("G07"))[0];
  assert.deepEqual(JSON.parse(first.stdout), {
    nameWithOwner: "fixture/mirror",
    url: "https://github.com/fixture/mirror",
    isPrivate: true,
    defaultBranchRef: { name: "main" },
  });
  // Hold a real request from A's old-token child while a second child obtains
  // the replacement. Both native children overlap; the first retains token 0.
  const held = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  fixture.endpoint.model.holdNext = held;
  const oldChild = fixture.run("G07");
  await held.entered.promise;
  fixture.releases.push(syntheticRelease(fixture.original, "replacement"));
  try {
    allCompleted(await fixture.run("G07"));
  } finally {
    held.release.resolve();
  }
  allCompleted(await oldChild);
  assert.ok(fixture.endpoint.observations.some((entry) => entry.tokenOrdinal === 0));
  assert.ok(fixture.endpoint.observations.some((entry) => entry.tokenOrdinal === 1));
  // Replacement itself did not revoke the earlier synthetic lease.
  allCompleted(
    await fixture.run(
      "G07",
      {},
      { ...fixture.options, delivery: syntheticDelivery(() => fixture.releases[0]) },
    ),
  );
  assert.equal(fixture.endpoint.observations.at(-1).tokenOrdinal, 0);
  const retained = structuredClone(fixture.original);
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  const delayed = syntheticDelivery(async () => {
    reached.resolve();
    return release.promise;
  });
  const running = fixture.run(
    "G07",
    {},
    { ...fixture.options, original: retained, delivery: delayed },
  );
  await reached.promise;
  retained.attemptRef = "attempt/B";
  const previousRequests = fixture.endpoint.observations.length;
  release.resolve(syntheticRelease(syntheticAttempt("B")));
  const failed = await running;
  assert.equal(failed[0].status, "failed");
  assert.equal(failed[0].operation.attemptRef, fixture.original.attemptRef);
  assert.equal(fixture.endpoint.observations.length, previousRequests);
});

nativeCase("G08", async (fixture) => {
  const [result] = allCompleted(await fixture.run("G08"));
  const issues = JSON.parse(result.stdout);
  assert.equal(issues.length, 1);
  assert.ok(issues.length <= 20);
  assert.deepEqual(issues[0], {
    number: 7,
    title: "Native fixture issue",
    state: "OPEN",
    url: "https://github.com/fixture/mirror/issues/7",
  });
  assert.ok(
    fixture.endpoint.observations.some(
      (entry) => entry.graphql === "IssueList" && entry.limit === 20,
    ),
  );
  assert.equal(fixture.delivery.requests[0].permissionProfile, "native-collaboration-read-v1");
});

nativeCase("G09", async (fixture) => {
  const [result] = allCompleted(await fixture.run("G09"));
  assert.equal(JSON.parse(result.stdout).number, fixture.repository.issue);
  assert.equal(JSON.parse(result.stdout).body, "Selected native issue body");
  assert.ok(
    fixture.endpoint.observations.some(
      (entry) => entry.graphql === "issue" && entry.object === fixture.repository.issue,
    ),
  );
  const missing = await fixture.run(
    "G09",
    {},
    { ...fixture.options, repository: { ...fixture.repository, issue: 999 } },
  );
  assert.equal(missing[0].status, "failed");
});

nativeCase("G10", async (fixture) => {
  const [result] = allCompleted(await fixture.run("G10"));
  const pull = JSON.parse(result.stdout);
  assert.equal(pull.number, fixture.repository.pull);
  assert.equal(pull.isDraft, true);
  assert.equal(pull.baseRefName, fixture.repository.base);
  assert.equal(pull.headRefName, "oce-demo/existing");
  assert.ok(
    fixture.endpoint.observations.some(
      (entry) => entry.graphql === "pullRequest" && entry.object === fixture.repository.pull,
    ),
  );
  fixture.endpoint.model.deny = true;
  assert.equal((await fixture.run("G10"))[0].status, "failed");
});

nativeCase("G11", async (fixture, t) => {
  async function episode(current, dropAck) {
    const oid = await createChange(current);
    allCompleted(await current.run("G06", { intendedHeadCommit: oid }));
    const bodyFile = join(current.home, "reviewed-pr.md");
    const body = "Reviewed native draft body.\n";
    await writeFile(bodyFile, body);
    current.endpoint.model.dropCreateAck = dropAck;
    const [result] = await current.run("G11", {
      operationRef: `native/G11/${dropAck ? "lost" : "success"}`,
      intendedHeadCommit: oid,
      title: "Reviewed native draft",
      bodyFile,
      bodySha256: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    });
    assert.equal(result.status, dropAck ? "unknown" : "completed");
    assert.equal(result.nextAction, "exact-readback-only");
    assert.equal(
      current.endpoint.createAttempts.length,
      1,
      "No automatic create attempt replay after a lost acknowledgement.",
    );
    assert.equal(
      current.endpoint.mutations.length,
      1,
      "Exactly one provider fixture effect was accepted.",
    );
    const mutation = current.endpoint.mutations[0];
    assert.deepEqual(mutation.input, {
      repositoryId: "R_native_fixture",
      baseRefName: current.repository.base,
      headRefName: current.repository.branch,
      draft: true,
      maintainerCanModify: false,
      title: "Reviewed native draft",
      body,
    });
    assert.equal(mutation.pull.headRefOid, oid);
    assert.equal(mutation.pull.isDraft, true);
    assert.equal(result.operation.intendedCommit, oid);
    assert.equal(result.operation.baseRef, "main");
    if (!dropAck) assert.equal(result.stdout.trim(), mutation.pull.url);
    await current.verifyNoManagedToken([result]);
  }
  await episode(fixture, false);
  // Independent fresh object graph and provider state: the second case cannot
  // mistake an existing PR from the success case for an idempotent retry.
  const lost = await prepareSelectedNativeCase(t, nativeSelection, "G11-lost", root);
  lost.run = async (id, extra = {}) =>
    createNativeClient(lost.options).run({
      id,
      operationRef: `native/G11-lost/${id}`,
      checkout: lost.checkout,
      intendedHeadCommit: lost.repository.commit,
      ...extra,
    });
  await episode(lost, true);
});

nativeCase("G12", async (fixture) => {
  const [result] = allCompleted(await fixture.run("G12"));
  assert.deepEqual(JSON.parse(result.stdout), {
    id: fixture.repository.id,
    full_name: "fixture/mirror",
    private: true,
    default_branch: "main",
  });
  assert.ok(
    fixture.endpoint.observations.some(
      (entry) =>
        entry.method === "GET" &&
        entry.path === "/repos/fixture/mirror" &&
        entry.apiVersion === "2026-03-10",
    ),
  );
});

nativeCase("G13", async (fixture) => {
  const [result] = allCompleted(await fixture.run("G13"));
  assert.deepEqual(JSON.parse(result.stdout), { sha: fixture.repository.commit });
  assert.ok(
    fixture.endpoint.observations.some(
      (entry) =>
        entry.method === "GET" &&
        entry.path.endsWith(`/commits/${fixture.repository.commit}`) &&
        entry.apiVersion === "2026-03-10",
    ),
  );
  assert.equal(
    (
      await fixture.run(
        "G13",
        {},
        { ...fixture.options, repository: { ...fixture.repository, commit: "0".repeat(40) } },
      )
    )[0].status,
    "failed",
  );
});

nativeCase("G14", async (fixture) => {
  const [result] = allCompleted(await fixture.run("G14"));
  const entries = JSON.parse(result.stdout);
  assert.equal(entries.length, 2);
  assert.ok(entries.length <= 20);
  assert.deepEqual(
    entries.filter((entry) => !entry.pull_request).map((entry) => entry.number),
    [fixture.repository.issue],
  );
  assert.deepEqual(
    entries.filter((entry) => entry.pull_request).map((entry) => entry.number),
    [fixture.repository.pull],
  );
  assert.ok(
    fixture.endpoint.observations.some(
      (entry) =>
        entry.method === "GET" &&
        entry.path.endsWith("/issues") &&
        entry.query === "?state=open&per_page=20" &&
        entry.apiVersion === "2026-03-10",
    ),
  );
  const requests = fixture.endpoint.observations.length;
  const expired = syntheticDelivery(() => syntheticRelease(fixture.original, "expired", 0));
  assert.equal(
    (await fixture.run("G14", {}, { ...fixture.options, delivery: expired }))[0].status,
    "failed",
  );
  assert.equal(fixture.endpoint.observations.length, requests);
  fixture.endpoint.revoked.add(fixture.releases[0].token);
  assert.equal((await fixture.run("G14"))[0].status, "failed");
  assert.equal(fixture.endpoint.observations.at(-1).status, 401);
  // The request is already at the synthetic provider when this token expires.
  // This proves native failure/accounting at an in-flight denial, not GitHub's
  // production expiry behavior or any provider revocation guarantee.
  const expiring = syntheticRelease(fixture.original, "inflight-expiry", Date.now() + 1200);
  fixture.releases.push(expiring);
  const held = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  fixture.endpoint.model.holdNext = held;
  const running = fixture.run("G14");
  await held.entered.promise;
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, Date.parse(expiring.expiresAt) - Date.now()) + 20),
  );
  held.release.resolve();
  assert.equal((await running)[0].status, "failed");
  assert.equal(fixture.endpoint.observations.at(-1).status, 401);
});

nativeCase("G15", async (fixture) => {
  const [result] = allCompleted(await fixture.run("G15"));
  const pulls = JSON.parse(result.stdout);
  assert.equal(pulls.length, 1);
  assert.ok(pulls.length <= 20);
  assert.equal(pulls[0].number, fixture.repository.pull);
  assert.equal(pulls[0].draft, true);
  assert.equal(pulls[0].base.ref, fixture.repository.base);
  assert.equal(pulls[0].head.ref, "oce-demo/existing");
  assert.ok(
    fixture.endpoint.observations.some(
      (entry) =>
        entry.method === "GET" &&
        entry.path.endsWith("/pulls") &&
        entry.query === "?state=open&per_page=20" &&
        entry.apiVersion === "2026-03-10",
    ),
  );
});
