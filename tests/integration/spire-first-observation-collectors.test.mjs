import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIMITS,
  parseFrame,
  parseSelectors,
  projectDenial,
  createReceiverParser,
  collectOwnedChild,
  parseArgs,
  runAgent,
  validateLoggingConfig,
} from "../fixtures/spire-first-observation-v1/receiver-collector.mjs";
import {
  validateProfile,
  buildAgentConfig,
  buildHarnessPod,
  buildRegistration,
  buildManagementManifests,
  buildServerBootstrap,
  assertServerBootstrapMatches,
  validatePodSecurity,
  validateObservedLifetime,
  normalizeObservedPod,
  matchesObservedResource,
} from "../fixtures/spire-first-observation-v1/profile.mjs";
import {
  projectNodeObservation,
  waitForOwnedCommand,
  establishFilesystemOwner,
  validateDockerConfiguration,
  dockerArguments,
  observeNode,
  createLocalResourceCustody,
} from "../fixtures/spire-first-observation-v1/node-observer.mjs";

// Source-machinery tests only. These synthetic log frames are never actual
// attestation, SPIRE issuance, gVisor mapping or identity acceptance evidence.
const selectors =
  "k8s:container-name:observer,k8s:node-name:node-a,k8s:ns:harnesses,k8s:pod-uid:12345678-1234-1234-1234-123456789abc,k8s:sa:observer,unix:gid:1000,unix:uid:1000";
const denial = (extra = {}) => ({
  level: "error",
  msg: "No identity issued",
  service: "WorkloadAPI",
  method: "FetchX509SVID",
  pid: 123,
  registered: false,
  selectors,
  time: "2026-09-08T10:00:00Z",
  ...extra,
});
const line = (value) => Buffer.from(JSON.stringify(value) + "\n");
const secret = "DO-NOT-RETAIN-raw-key-or-error";

test("projection is closed and retains provenance without invented socket credentials", () => {
  const result = projectDenial(denial({ error: secret, unrelated: { privateKey: secret } }));
  assert.equal(result.receiverPID, 123);
  assert.equal(result.selectors.namespace, "harnesses");
  assert.equal(result.selectors.uid, 1000);
  assert.equal(result.selectors.provenance, "spire-workload-attestor");
  for (const key of ["acceptedSocketUID", "acceptedSocketGID", "acceptedSocketStartIdentity"])
    assert.equal(result[key], null);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(projectDenial(denial({ time: secret })).agentTime, null);
  assert.equal(projectDenial({ level: "error", msg: secret, error: secret }), null);
});

test("all seven selectors are required, single-valued and grammar checked", () => {
  for (const bad of [
    selectors.replace(",unix:uid:1000", ""),
    selectors + ",unix:uid:1000",
    selectors + ",unix:gid:1001",
    selectors + ",unix:supplementary_gid:1000",
    selectors + ",k8s:container-id:unexpected",
    selectors + ",",
    selectors.replace("unix:uid:1000", "unix:uid:4294967296"),
    selectors.replace("unix:uid:1000", "unix:uid:01"),
    selectors.replace("k8s:sa:observer", "k8s:sa:a:b"),
    selectors.replace("harnesses", "secret value"),
  ]) {
    assert.throws(() => parseSelectors(bad));
  }
  assert.throws(() => parseSelectors(Array(17).fill("unix:uid:1").join(",")), /selector-limit/);
});

test("selected event metadata fails closed; unexpected ERROR fields never become records", () => {
  for (const extra of [
    { pid: "123" },
    { pid: 0 },
    { registered: true },
    { service: "Other" },
    { method: "FetchJWTBundles" },
    { selectors: null },
  ]) {
    assert.throws(() => projectDenial(denial(extra)));
  }
  assert.throws(() => projectDenial(denial({ level: "debug" })), /unexpected-log-format/);
});

test("strict framing rejects duplicate keys, invalid UTF-8, partial and deep JSON without raw exception text", () => {
  for (const bytes of [
    Buffer.from('{"msg":"' + secret + '","msg":"other"}'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('{"raw":"' + secret + '"'),
    Buffer.from("[".repeat(18) + "0" + "]".repeat(18)),
    Buffer.from("{}{}"),
  ]) {
    assert.throws(
      () => parseFrame(bytes),
      (error) => error.message === "invalid-json" && !String(error).includes(secret),
    );
  }
  const parser = createReceiverParser();
  parser.push("stdout", Buffer.from("{"));
  assert.throws(() => parser.finish(), /incomplete-frame/);
});

test("separate private channels handle arbitrary chunk boundaries and discard unknown metadata", () => {
  const records = [],
    parser = createReceiverParser({ onRecord: (r) => records.push(r) });
  const bytes = line(denial({ error: secret }));
  for (const byte of bytes) parser.push("stderr", Buffer.from([byte]));
  parser.push("stdout", line({ level: "error", msg: "other", error: secret }));
  parser.finish();
  assert.equal(records.length, 1);
  assert.equal(records[0].sequence, 1);
  assert.equal(parser.snapshot().discardedEvents, 1);
  assert.equal(JSON.stringify({ records, state: parser.snapshot() }).includes(secret), false);
});

test("duplicate relevant PID invalidates prior emitted evidence rather than deduplicating", () => {
  const parser = createReceiverParser();
  parser.push("stdout", line(denial()));
  assert.throws(() => parser.push("stderr", line(denial())), /duplicate-denial/);
  assert.throws(() => parser.finish(), /duplicate-denial/);
  assert.equal(parser.snapshot().failure, "duplicate-denial");
});

test("line, aggregate input and frame-count overflow cannot truncate into success", () => {
  const oversized = createReceiverParser();
  assert.throws(
    () => oversized.push("stderr", Buffer.alloc(LIMITS.lineBytes + 1, 65)),
    /frame-limit/,
  );
  const total = createReceiverParser();
  const large = line({ level: "error", msg: "other", error: "x".repeat(16000) });
  assert.throws(() => {
    for (let i = 0; i < 70; i++) total.push("stderr", large);
  }, /input-limit/);
  const frames = createReceiverParser();
  assert.throws(() => {
    for (let i = 0; i <= LIMITS.frames; i++)
      frames.push("stderr", line({ level: "error", msg: "other" }));
  }, /frame-count-limit/);
});

test("record and serialized-output budgets reject whole observations", () => {
  const parser = createReceiverParser();
  assert.throws(() => {
    for (let i = 1; i <= LIMITS.records + 1; i++) parser.push("stdout", line(denial({ pid: i })));
  }, /record-limit/);
  // Exercise the actual byte guard independently of record count. Production
  // clocks are fixed-size; dependency injection here only targets output bounds.
  const output = createReceiverParser({ clock: () => "x".repeat(LIMITS.outputBytes) });
  assert.throws(() => output.push("stdout", line(denial())), /output-limit/);
  assert.equal(output.snapshot().records, 0);
});

test("CLI binds explicit config/binary hashes, finite lifetime and private logging profile", async () => {
  const argv = [
    "--binary",
    process.execPath,
    "--binary-sha256",
    "a".repeat(64),
    "--config",
    "/fixture/agent.conf",
    "--config-sha256",
    "b".repeat(64),
    "--lifetime-ms",
    "300000",
  ];
  assert.equal(parseArgs(argv).lifetimeMs, 300000);
  assert.throws(() => parseArgs([...argv, "--binary", "/other"]), /invalid-arguments/);
  assert.throws(() => parseArgs(argv.slice(0, -2)), /invalid-arguments/);
  assert.throws(() => parseArgs([...argv.slice(0, -1), "1800001"]), /invalid-limits/);
  validateLoggingConfig(Buffer.from('agent { log_level = "ERROR" log_format = "JSON" }'));
  for (const config of [
    'agent { log_file = "/raw" log_level = "ERROR" log_format = "JSON" }',
    'agent { log_level = "DEBUG" log_format = "JSON" }',
    'agent { log_level = "ERROR" }',
  ])
    assert.throws(() => validateLoggingConfig(Buffer.from(config)));
  await assert.rejects(runAgent({ ...parseArgs(argv), lifetimeMs: 50 }), /input-hash-mismatch/);
  // A matching installed binary is still not launched when config identity is
  // wrong. This exercises the real pre-spawn checks without executing SPIRE.
  const file = fileURLToPath(import.meta.url),
    binarySHA256 = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");
  await assert.rejects(
    runAgent({
      binary: process.execPath,
      binarySHA256,
      config: file,
      configSHA256: "0".repeat(64),
      lifetimeMs: 50,
    }),
    /input-hash-mismatch/,
  );
});

test("owned child raw stderr and malformed output fail closed and actually settle", async () => {
  const records = [];
  const result = await collectOwnedChild({
    command: process.execPath,
    args: ["-e", `process.stderr.write(${JSON.stringify(secret + "\n")});setInterval(()=>{},1000)`],
    lifetimeMs: 3000,
    settleMs: 1000,
    onRecord: (record) => records.push(record),
  });
  assert.equal(result.reason, "invalid-json");
  assert.equal(result.failed, true);
  assert.equal(result.settled, true);
  assert.equal(result.custodyHeld, false);
  assert.equal(records.length, 0);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.throws(
    () => process.kill(result.childPID, 0),
    (error) => error.code === "ESRCH",
  );
});

test("owned child cancellation escalates, awaits actual close, and never claims identity success", async () => {
  const controller = new AbortController();
  const records = [];
  // The helper ignores TERM so the collector must execute its owned-child KILL
  // path. Its synthetic denial is merely a synchronization point for this test.
  const script = `process.on('SIGTERM',()=>{});process.stdout.write(${JSON.stringify(line(denial()).toString())});setInterval(()=>{},1000)`;
  const result = await collectOwnedChild({
    command: process.execPath,
    args: ["-e", script],
    lifetimeMs: 3000,
    settleMs: 500,
    signal: controller.signal,
    onRecord(record) {
      records.push(record);
      controller.abort();
    },
  });
  assert.equal(records.length, 1);
  assert.equal(result.reason, "cancelled");
  assert.equal(result.childSignal, "SIGKILL");
  assert.equal(result.settled, true);
  assert.equal(result.custodyHeld, false);
  assert.equal("identityPass" in result, false);
  assert.throws(
    () => process.kill(result.childPID, 0),
    (error) => error.code === "ESRCH",
  );
});

test("early exits, deadline, spawn failure and output callback failure are explicit failed outcomes", async () => {
  const common = { command: process.execPath, lifetimeMs: 1000, settleMs: 300 };
  const early = await collectOwnedChild({ ...common, args: ["-e", "process.exit(7)"] });
  assert.equal(early.reason, "early-child-exit");
  assert.equal(early.childExitCode, 7);
  assert.equal(early.failed, true);
  const deadline = await collectOwnedChild({
    ...common,
    lifetimeMs: 50,
    args: ["-e", "setInterval(()=>{},1000)"],
  });
  assert.equal(deadline.reason, "deadline");
  assert.equal(deadline.settled, true);
  assert.equal(deadline.failed, true);
  const missing = await collectOwnedChild({
    ...common,
    command: "/nonexistent-spire-fixture-helper",
    args: [],
  });
  assert.equal(missing.reason, "child-error");
  assert.equal(missing.custodyHeld, false);
  assert.equal(missing.failed, true);
  const output = await collectOwnedChild({
    ...common,
    args: [
      "-e",
      `process.stdout.write(${JSON.stringify(line(denial()).toString())});setInterval(()=>{},1000)`,
    ],
    onRecord() {
      throw new Error(secret);
    },
  });
  assert.equal(output.reason, "output-failed");
  assert.equal(output.settled, true);
  assert.equal(JSON.stringify(output).includes(secret), false);
  const cancelled = new AbortController();
  cancelled.abort();
  const beforeLaunch = await collectOwnedChild({
    ...common,
    args: ["-e", "process.exit(9)"],
    signal: cancelled.signal,
  });
  assert.equal(beforeLaunch.childPID, null);
  assert.equal(beforeLaunch.reason, "cancelled");
  assert.equal(beforeLaunch.settled, true);
});

// These are synthetic admission/build and protected-metadata projection units.
// No fixture hash, registration plan, or constructed proc/CRI record is actual
// artifact, workload identity, node observation, or effective privilege proof.
const podAUID = "12345678-1234-1234-1234-123456789abc";
const podBUID = "abcdef01-1234-1234-1234-123456789abc";
const syntheticHash = (character) => character.repeat(64);
const emptyDockerConfig = "{}\n";
const emptyDockerConfigSHA256 = createHash("sha256").update(emptyDockerConfig).digest("hex");
function profileFixture() {
  return {
    schemaVersion: 1,
    sourceCommit: "a".repeat(40),
    deadlineEpochMs: Date.now() + 600000,
    artifacts: {
      nodeBaseImage: `registry.example/unit-node@sha256:${syntheticHash("1")}`,
      observerImage: `registry.example/unit-observer@sha256:${syntheticHash("2")}`,
      managementImage: `registry.example/unit-management@sha256:${syntheticHash("3")}`,
      observerSHA256: syntheticHash("4"),
      spireAgentSHA256: syntheticHash("5"),
      spireServerSHA256: syntheticHash("6"),
      runscSHA256: syntheticHash("7"),
      sentrySHA256: syntheticHash("8"),
      spireCommit: "b".repeat(40),
      runscRelease: "unit-release",
      runtimeMembers: [
        { name: "runsc", sha256: syntheticHash("7") },
        { name: "containerd-shim-runsc-v1", sha256: syntheticHash("a") },
        { name: "gvisor-bin/checkpointgofer", sha256: syntheticHash("b") },
        { name: "gvisor-bin/gvisor-sentry-prewarmer", sha256: syntheticHash("c") },
        { name: "gvisor-bin/gvisor_sentry", sha256: syntheticHash("8") },
        { name: "gvisor-bin/runsc-metric-server", sha256: syntheticHash("d") },
      ],
      k3dSHA256: syntheticHash("9"),
      kubectlSHA256: syntheticHash("a"),
      dockerSHA256: syntheticHash("b"),
    },
    cluster: {
      name: "unit-observation",
      context: "k3d-unit-observation",
      nodeName: "k3d-unit-observation-server-0",
      nodeIPv4: "192.0.2.10",
      apiURL: "https://127.0.0.1:6458",
      apiIPv4: "192.0.2.10",
      apiPort: 6443,
      kubeconfigPath: "/unit/runtime/kubeconfig",
      kubeconfigSHA256: syntheticHash("c"),
      kubectlPath: "/unit/bin/kubectl",
      k3dPath: "/unit/bin/k3d",
      dockerPath: "/unit/bin/docker",
      dockerConfigDirectory: "/unit/runtime/docker-config",
      dockerConfigSHA256: emptyDockerConfigSHA256,
    },
    paths: {
      evidenceDir: "/unit/evidence",
      socketDirectory: "/unit/workload-api",
      socketPath: "/unit/workload-api/api.sock",
      serverAdminSocket: "/var/lib/spire-server/api.sock",
      observerBinary: "/opt/fixture/observer",
      spireAgentBinary: "/opt/fixture/spire-agent",
      spireServerBinary: "/opt/fixture/spire-server",
      receiverCollector: "/opt/fixture/receiver-collector.mjs",
    },
    management: {
      namespace: "unit-management",
      agentPod: "unit-agent",
      serverPod: "unit-server",
      agentContainer: "agent",
      serverContainer: "server",
      agentServiceAccount: "unit-agent",
      serverServiceAccount: "unit-server",
      serverIPv4: "192.0.2.20",
      serverPort: 8081,
      trustDomain: "unit.example",
      clusterID: "unit-cluster",
      kubeletAudience: "kubernetes-api",
      trustBundleConfigMap: "unit-spire-bundle",
      kubeletCAConfigMap: "unit-kubelet-ca",
      trustBundleSHA256: syntheticHash("d"),
      kubeletCASHA256: syntheticHash("e"),
    },
    runtime: {
      runtimeClassName: "unit-gvisor",
      handler: "unit-gvisor",
      flags: [
        "--platform=systrap",
        "--sidecar-usage-policy=STRICT",
        "--host-uds=open",
        "--network=none",
      ],
    },
    workloads: {
      namespace: "unit-harnesses",
      a: {
        podName: "unit-a",
        containerName: "observer",
        spiffeID: "spiffe://unit.example/harness/a",
      },
      b: {
        podName: "unit-b",
        containerName: "observer",
        spiffeID: "spiffe://unit.example/harness/b",
      },
    },
  };
}

test("profile admission freezes explicit identities and rejects ambient or unbound configuration", () => {
  const source = profileFixture(),
    admitted = validateProfile(source);
  assert.equal(Object.isFrozen(admitted.artifacts.runtimeMembers), true);
  source.management.namespace = "changed";
  assert.equal(admitted.management.namespace, "unit-management");
  for (const mutate of [
    (p) => {
      p.management.skipVerification = true;
    },
    (p) => {
      p.artifacts.observerImage = "registry.example/unit-observer:latest";
    },
    (p) => {
      p.cluster.kubeconfigPath = "/home/user/.kube/config";
    },
    (p) => {
      p.paths.socketPath = "/unit/workload-api/../foreign/api.sock";
    },
    (p) => {
      p.management.trustBundleSHA256 = "";
    },
    (p) => {
      p.management.kubeletCASHA256 = "unverified";
    },
    (p) => {
      delete p.management.kubeletCASHA256;
    },
    (p) => {
      p.artifacts.runtimeMembers[0].sha256 = syntheticHash("f");
    },
    (p) => {
      p.artifacts.runtimeMembers[1].name = "runsc";
    },
    (p) => {
      p.artifacts.runtimeMembers.pop();
    },
  ]) {
    const invalid = profileFixture();
    mutate(invalid);
    assert.throws(() => validateProfile(invalid), /Invalid explicit SPIRE observation profile/);
  }
});

test("profile requires explicit canonical Docker configuration and its digest", () => {
  const admitted = validateProfile(profileFixture());
  assert.equal(admitted.cluster.dockerConfigSHA256, emptyDockerConfigSHA256);
  for (const mutate of [
    (p) => {
      delete p.cluster.dockerConfigDirectory;
    },
    (p) => {
      delete p.cluster.dockerConfigSHA256;
    },
    (p) => {
      p.cluster.dockerConfigDirectory = "relative/config";
    },
    (p) => {
      p.cluster.dockerConfigDirectory = "/unit/../ambient";
    },
    (p) => {
      p.cluster.dockerConfigSHA256 = "not-a-digest";
    },
  ]) {
    const invalid = profileFixture();
    mutate(invalid);
    assert.throws(() => validateProfile(invalid), /Invalid explicit SPIRE observation profile/);
  }
});

async function withDockerConfiguration(check) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "spire-docker-config-unit-")));
  const directory = join(root, "selected-config");
  try {
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "config.json"), emptyDockerConfig, {
      mode: 0o600,
      flag: "wx",
    });
    const options = {
      dockerConfigDirectory: directory,
      dockerConfigSHA256: emptyDockerConfigSHA256,
      filesystemOwnerUID: (await lstat(directory)).uid,
    };
    await check(options, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Docker configuration validates actual ownership, exact bytes and protected filesystem shape", async () => {
  await withDockerConfiguration(async (options, root) => {
    const directory = options.dockerConfigDirectory;
    const config = join(directory, "config.json");
    const result = validateDockerConfiguration(options);
    assert.deepEqual(result, {
      directory,
      sha256: emptyDockerConfigSHA256,
      filesystemOwnerUID: options.filesystemOwnerUID,
    });
    assert.equal(Object.isFrozen(result), true);
    const rejects = (input = options) =>
      assert.throws(
        () => validateDockerConfiguration(input),
        (error) =>
          ["DOCKER_CONFIG_INVALID", "DOCKER_CONFIG_INPUT_INVALID"].includes(error.code) &&
          error.message === error.code &&
          !String(error).includes(root),
      );
    rejects({ ...options, dockerConfigSHA256: "0".repeat(64) });
    rejects({ ...options, filesystemOwnerUID: options.filesystemOwnerUID + 1 });
    rejects({ ...options, dockerConfigDirectory: join(root, ".docker") });
    rejects({ ...options, dockerConfigDirectory: join(root, "absent") });
    rejects({ ...options, dockerConfigDirectory: join(root, "absent-parent", "selected-config") });
    rejects({ ...options, dockerConfigDirectory: `${root}/./selected-config` });
    await chmod(root, 0o755);
    rejects();
    assert.equal((await lstat(root)).mode & 0o7777, 0o755);
    await chmod(root, 0o700);
    const parentAlias = join(root, "parent-alias");
    await symlink(root, parentAlias);
    rejects({ ...options, dockerConfigDirectory: join(parentAlias, "selected-config") });
    await rm(parentAlias);
    await rm(config);
    rejects();
    await writeFile(config, emptyDockerConfig, { mode: 0o600, flag: "wx" });
    await chmod(directory, 0o755);
    rejects();
    await chmod(directory, 0o700);
    await chmod(config, 0o644);
    rejects();
    await chmod(config, 0o600);
    await writeFile(config, '{"credsStore":"unexpected"}\n');
    rejects({
      ...options,
      dockerConfigSHA256: createHash("sha256")
        .update(await readFile(config))
        .digest("hex"),
    });
    await writeFile(config, emptyDockerConfig);
    const extra = join(directory, "unexpected-entry");
    await writeFile(extra, "", { mode: 0o600, flag: "wx" });
    rejects();
    await rm(extra);
    const alias = join(root, "config-alias");
    await symlink(directory, alias);
    rejects({ ...options, dockerConfigDirectory: alias });
    const target = join(root, "owned-config-target");
    await writeFile(target, emptyDockerConfig, { mode: 0o600, flag: "wx" });
    await rm(config);
    await symlink(target, config);
    rejects();
    await rm(config);
    await link(target, config);
    rejects();
    assert.equal(await readFile(target, "utf8"), emptyDockerConfig);
  });
});

test("Docker argv binds the selected config and Unix socket and revalidates before reuse", async () => {
  await withDockerConfiguration(async (options) => {
    const args = ["inspect", "k3d-unit-observation-server-0"];
    assert.deepEqual(dockerArguments(options, args), [
      "--config",
      options.dockerConfigDirectory,
      "--host",
      "unix:///var/run/docker.sock",
      ...args,
    ]);
    assert.deepEqual(args, ["inspect", "k3d-unit-observation-server-0"]);
    await writeFile(join(options.dockerConfigDirectory, "config.json"), "{}");
    assert.throws(() => dockerArguments(options, args), /DOCKER_CONFIG_INVALID/);
  });
});

test("observer passes explicit Docker configuration to an owned local helper and settles its failure", async (t) => {
  // This executes a Node argv recorder, never Docker or a runtime. Its deliberate
  // exit 1 must leave the real observer unqualified with settled local custody.
  await withDockerConfiguration(async (configuration, root) => {
    const capture = join(root, "captured-argv.json");
    const helper = join(root, "owned-argv-recorder");
    await writeFile(
      helper,
      `#!${process.execPath}\n` +
        `require("node:fs").writeFileSync(${JSON.stringify(capture)}, JSON.stringify({` +
        "argv:process.argv.slice(2),env:process.env,pid:process.pid}));process.exit(1);\n",
      { mode: 0o700, flag: "wx" },
    );
    const { options } = nodeFixture();
    const result = await observeNode({
      ...options,
      ...configuration,
      dockerPath: helper,
      timeoutMs: 3000,
    });
    assert.equal(result.status, "unqualified");
    assert.equal(result.reasonCode, "COMMAND_FAILED");
    assert.equal(result.identityQualified, false);
    assert.equal(result.custodyHeld, false);
    assert.equal(result.ownedChild, null);
    assert.equal(result.observation, null);
    const recorded = JSON.parse(await readFile(capture, "utf8"));
    assert.deepEqual(recorded.argv, [
      "--config",
      configuration.dockerConfigDirectory,
      "--host",
      "unix:///var/run/docker.sock",
      "inspect",
      options.nodeName,
      "--format",
      '{"id":{{json .Id}},"startedAt":{{json .State.StartedAt}},"running":{{json .State.Running}}}',
    ]);
    assert.deepEqual(recorded.env, { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" });
    assert(Number.isSafeInteger(recorded.pid) && recorded.pid > 0);
    for (const pid of [recorded.pid, -recorded.pid]) {
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error.code === "ESRCH",
      );
    }
    t.diagnostic(
      `owned-argv-helper-settled pid=${recorded.pid} exitCode=1 processGroupAbsent=true`,
    );
  });
});

test("observed Pods admit only omitted false value booleans from the Kubernetes schema", () => {
  const p = profileFixture();
  const pods = [
    ...buildManagementManifests(p).filter((object) => object.kind === "Pod"),
    buildHarnessPod(p, "a"),
    buildHarnessPod(p, "b"),
  ];
  for (const expected of pods) {
    // core/v1 omitempty drops false value booleans; explicit pointer false stays.
    const observed = structuredClone(expected);
    for (const field of ["hostNetwork", "hostPID", "hostIPC"])
      if (observed.spec[field] === false) delete observed.spec[field];
    const original = structuredClone(observed);
    assert.equal(matchesObservedResource(observed, expected), true);
    assert.deepEqual(normalizeObservedPod(observed, expected).spec, expected.spec);
    assert.deepEqual(observed, original);
    for (const field of ["hostNetwork", "hostPID", "hostIPC"]) {
      for (const value of [null, 0, "false", !expected.spec[field]]) {
        const changed = structuredClone(observed);
        changed.spec[field] = value;
        assert.equal(matchesObservedResource(changed, expected), false, field);
      }
      if (expected.spec[field] === true) {
        const changed = structuredClone(observed);
        delete changed.spec[field];
        assert.equal(
          matchesObservedResource(changed, expected),
          false,
          "required true remains present",
        );
      }
    }
    for (const field of [
      "shareProcessNamespace",
      "enableServiceLinks",
      "automountServiceAccountToken",
    ]) {
      const changed = structuredClone(observed);
      delete changed.spec[field];
      assert.equal(matchesObservedResource(changed, expected), false, field);
    }
    for (const field of ["privileged", "allowPrivilegeEscalation", "runAsNonRoot"]) {
      const changed = structuredClone(observed);
      delete changed.spec.containers[0].securityContext[field];
      assert.equal(matchesObservedResource(changed, expected), false, field);
    }
  }
});

test("Pod normalization stays at the exact resource and schema fields", () => {
  const pod = buildHarnessPod(profileFixture(), "a");
  for (const field of ["hostUsers", "unknown"]) {
    const expected = structuredClone(pod),
      observed = structuredClone(pod);
    expected.spec[field] = false;
    assert.equal(matchesObservedResource(observed, expected), false);
  }
  for (const change of [
    (object) => {
      object.kind = "ConfigMap";
    },
    (object) => {
      object.apiVersion = "other/v1";
    },
    (object) => {
      object.spec = { nested: object.spec };
    },
  ]) {
    const expected = structuredClone(pod),
      observed = structuredClone(pod);
    delete observed.spec.hostPID;
    change(expected);
    change(observed);
    assert.equal(matchesObservedResource(observed, expected), false);
  }
  const observed = structuredClone(pod);
  observed.spec = null;
  assert.equal(matchesObservedResource(observed, pod), false);
  assert.equal(
    matchesObservedResource(
      { kind: "ServiceAccount" },
      {
        kind: "ServiceAccount",
        automountServiceAccountToken: false,
      },
    ),
    false,
  );
});

test("observed NetworkPolicies admit empty direction omission and retain exact isolation", () => {
  const policies = buildManagementManifests(profileFixture()).filter(
    (object) => object.kind === "NetworkPolicy",
  );
  for (const expected of policies) {
    const observed = structuredClone(expected);
    for (const field of ["ingress", "egress"])
      if (observed.spec[field].length === 0) delete observed.spec[field];
    const original = structuredClone(observed);
    assert.equal(matchesObservedResource(observed, expected), true);
    assert.deepEqual(observed, original);
    for (const mutate of [
      (spec) => {
        spec.podSelector.matchLabels = { ...spec.podSelector.matchLabels, extra: "other" };
      },
      (spec) => {
        spec.policyTypes.reverse();
      },
      (spec) => {
        delete spec.policyTypes;
      },
      (spec) => {
        spec.policyTypes = ["Ingress"];
      },
      (spec) => {
        spec.egress = null;
      },
      (spec) => {
        spec.ingress = [{}];
      },
      (spec) => {
        spec.egress = [...(spec.egress ?? []), {}];
      },
      (spec) => {
        spec.extra = false;
      },
    ]) {
      const changed = structuredClone(observed);
      mutate(changed.spec);
      assert.equal(matchesObservedResource(changed, expected), false);
    }
    for (const field of ["ingress", "egress"]) {
      if (expected.spec[field].length) {
        const changed = structuredClone(observed);
        delete changed.spec[field];
        assert.equal(matchesObservedResource(changed, expected), false);
        const extraPort = structuredClone(observed);
        extraPort.spec[field][0].ports.push({ protocol: "TCP", port: 65535 });
        assert.equal(matchesObservedResource(extraPort, expected), false);
      }
    }
  }
});

test("observed resource comparison preserves generic authored fields and traversal bounds", () => {
  assert.equal(
    matchesObservedResource(
      { metadata: { name: "x", uid: "generated" } },
      {
        metadata: { name: "x" },
      },
    ),
    true,
  );
  for (const actual of [null, 0, "false", undefined])
    assert.equal(matchesObservedResource({ data: actual }, { data: false }), false);
  assert.equal(matchesObservedResource({ data: {} }, { data: { required: [] } }), false);
  const wide = { data: Array(513).fill(0) };
  assert.equal(matchesObservedResource(wide, wide), false);
  let deep = 0;
  for (let i = 0; i < 34; i++) deep = { data: deep };
  assert.equal(matchesObservedResource(deep, deep), false);
});

test("profile rejects expired allocation, cross-identity collapse and runtime weakening", () => {
  const now = Date.now(),
    expired = profileFixture();
  expired.deadlineEpochMs = now;
  assert.throws(() => validateProfile(expired, { nowMs: now }));
  const excessive = profileFixture();
  excessive.deadlineEpochMs = now + 1800001;
  assert.throws(() => validateProfile(excessive, { nowMs: now }));
  for (const mutate of [
    (p) => {
      p.workloads.b.spiffeID = p.workloads.a.spiffeID;
    },
    (p) => {
      p.workloads.b.podName = p.workloads.a.podName;
    },
    (p) => {
      p.workloads.b.spiffeID = "spiffe://foreign.example/harness/b";
    },
    (p) => {
      p.workloads.namespace = p.management.namespace;
    },
    (p) => {
      p.workloads.a.automountServiceAccountToken = true;
    },
    (p) => {
      p.management.kubeletAudience = "spire-server";
    },
    (p) => {
      p.runtime.flags[1] = "--sidecar-usage-policy=PERMISSIVE";
    },
    (p) => {
      p.runtime.flags[2] = "--host-uds=create";
    },
    (p) => {
      p.runtime.flags = p.runtime.flags.filter((flag) => flag !== "--network=none");
    },
    (p) => {
      p.runtime.flags[3] = "--network=host";
    },
    (p) => {
      p.runtime.flags = ["--platform=systrap"];
    },
  ]) {
    const invalid = profileFixture();
    mutate(invalid);
    assert.throws(() => validateProfile(invalid));
  }
});

test("registration plan binds one chosen case and actual supplied Pod UID to the selected Agent parent", () => {
  const p = profileFixture(),
    agentID = `spiffe://${p.management.trustDomain}/spire/agent/k8s_psat/${p.management.clusterID}/${podAUID}`;
  const a = buildRegistration(p, "a", podAUID, agentID),
    b = buildRegistration(p, "b", podBUID, agentID);
  assert.equal(a.spiffeID, p.workloads.a.spiffeID);
  assert.equal(b.spiffeID, p.workloads.b.spiffeID);
  assert.equal(a.parentID, agentID);
  assert.equal(a.hint, "");
  assert.equal(b.hint, "");
  assert(a.selectors.some((s) => s.type === "k8s" && s.value === `pod-uid:${podAUID}`));
  assert(b.selectors.some((s) => s.type === "k8s" && s.value === `pod-uid:${podBUID}`));
  assert.equal(JSON.stringify(a).includes(podBUID), false);
  assert.throws(() => buildRegistration(p, "c", podAUID, agentID));
  assert.throws(() => buildRegistration(p, "a", "assumed-pod", agentID));
  assert.throws(() =>
    buildRegistration(p, "a", podAUID, agentID.replace("/unit-cluster/", "/foreign-cluster/")),
  );
});

test("management and Harness build outputs preserve credential, capability and logging boundaries", () => {
  const p = profileFixture(),
    manifests = buildManagementManifests(p);
  const agent = manifests.find(
    (x) => x.kind === "Pod" && x.metadata.name === p.management.agentPod,
  );
  const config = manifests.find((x) => x.kind === "ConfigMap" && x.data?.["agent.conf"]);
  const configBytes = Buffer.from(config.data["agent.conf"]);
  assert.equal(config.data["agent.conf"], buildAgentConfig(p));
  validateLoggingConfig(configBytes);
  assert.equal(config.immutable, true);
  assert.equal(config.data["agent.conf"].includes("log_file"), false);
  const args = parseArgs(agent.spec.containers[0].args);
  assert.equal(args.configSHA256, createHash("sha256").update(configBytes).digest("hex"));
  assert.equal(args.binarySHA256, p.artifacts.spireAgentSHA256);
  assert.equal(agent.spec.hostPID, true);
  assert.equal(agent.spec.automountServiceAccountToken, false);
  assert.equal(agent.spec.containers[0].securityContext.runAsUser, 0);
  assert.equal(agent.spec.containers[0].securityContext.privileged, false);
  assert.equal(agent.spec.containers[0].securityContext.procMount, "Default");
  assert.equal(agent.spec.shareProcessNamespace, false);
  assert.equal(agent.spec.enableServiceLinks, false);
  const agentSocketMount = agent.spec.containers[0].volumeMounts.find(
    (mount) => mount.name === "workload-api",
  );
  assert.equal(agentSocketMount.mountPropagation, "None");
  assert.deepEqual(agent.spec.containers[0].securityContext.capabilities.drop, ["ALL"]);
  assert.equal(agent.spec.containers[0].securityContext.allowPrivilegeEscalation, false);
  const tokens = agent.spec.volumes
    .flatMap((v) => v.projected?.sources ?? [])
    .map((s) => s.serviceAccountToken);
  assert.deepEqual(tokens.map((t) => t.audience).sort(), ["kubernetes-api", "spire-server"]);
  assert(tokens.every((t) => t.expirationSeconds === 600));
  const kubeletRole = manifests.find(
    (x) => x.kind === "ClusterRole" && x.rules.some((r) => r.resources.includes("nodes/pods")),
  );
  assert.deepEqual(kubeletRole.rules, [
    {
      apiGroups: [""],
      resources: ["nodes/pods"],
      resourceNames: [p.cluster.nodeName],
      verbs: ["get"],
    },
  ]);
  assert.equal(
    manifests
      .filter((x) => x.rules)
      .some((x) => x.rules.some((r) => r.resources.includes("nodes/proxy"))),
    false,
  );
  for (const caseName of ["a", "b"]) {
    const harness = buildHarnessPod(p, caseName);
    assert.equal(harness.spec.automountServiceAccountToken, false);
    assert.equal(harness.spec.hostPID, false);
    assert.equal(harness.spec.serviceAccountName, "default");
    assert.equal(harness.spec.shareProcessNamespace, false);
    assert.equal(harness.spec.enableServiceLinks, false);
    assert.equal(harness.spec.hostNetwork, false);
    assert.equal(harness.spec.runtimeClassName, p.runtime.runtimeClassName);
    assert.equal(harness.spec.containers[0].securityContext.runAsUser, 1000);
    assert.equal(harness.spec.containers[0].securityContext.privileged, false);
    assert.equal(harness.spec.containers[0].securityContext.procMount, "Default");
    assert.deepEqual(harness.spec.containers[0].securityContext.capabilities.drop, ["ALL"]);
    assert.equal(harness.spec.containers[0].securityContext.readOnlyRootFilesystem, true);
    assert.equal(
      harness.spec.volumes.some((v) => v.projected || v.secret),
      false,
    );
    assert.equal(harness.spec.volumes.length, 1);
    assert.equal(harness.spec.volumes[0].hostPath.path, p.paths.socketDirectory);
    assert.equal(harness.spec.containers[0].volumeMounts[0].readOnly, true);
    assert.equal(harness.spec.containers[0].volumeMounts[0].mountPropagation, "None");
    assert.equal("subPath" in harness.spec.containers[0].volumeMounts[0], false);
    assert.equal("subPathExpr" in harness.spec.containers[0].volumeMounts[0], false);
  }
});

function procStat(pid, ticks = "900") {
  // Field 22 is process start ticks; the comm field deliberately has spaces.
  return `${pid} (unit runsc process) S ${Array(18).fill("0").join(" ")} ${ticks}`;
}
function nodeFixture() {
  const p = profileFixture(),
    sandboxID = syntheticHash("1"),
    containerID = syntheticHash("2");
  const options = {
    nodeName: p.cluster.nodeName,
    podUID: podAUID,
    receiverPID: 441,
    expectedSentrySHA256: p.artifacts.sentrySHA256,
    expectedRuntimeHandler: p.runtime.handler,
    expectedRuntimeFlags: p.runtime.flags,
    dockerPath: p.cluster.dockerPath,
    dockerConfigDirectory: p.cluster.dockerConfigDirectory,
    dockerConfigSHA256: p.cluster.dockerConfigSHA256,
    filesystemOwnerUID: 1000,
  };
  const raw = {
    pid: 441,
    statBefore: procStat(441),
    statAfter: procStat(441),
    status: `Name:\t${secret}\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\t1000\t1000\t1000\n`,
    cgroup: `0::/kubepods/pod${podAUID}/${sandboxID}\n`,
    cmdline:
      ["/unit/runsc-sandbox", ...p.runtime.flags, sandboxID, `--unit-private=${secret}`].join(
        "\0",
      ) + "\0",
    pidNamespace: "pid:[1234]",
    executableSHA256: p.artifacts.sentrySHA256,
  };
  const node = { id: syntheticHash("3"), running: true, startedAt: "2026-09-08T09:00:00Z" };
  const sandboxes = [
    {
      id: sandboxID,
      metadata: { uid: podAUID, namespace: p.workloads.namespace, name: p.workloads.a.podName },
      labels: { "io.kubernetes.pod.uid": podAUID, unrelated: secret },
      state: "SANDBOX_READY",
      runtimeHandler: p.runtime.handler,
    },
  ];
  const containers = [
    {
      id: containerID,
      podSandboxId: sandboxID,
      metadata: { name: "observer" },
      labels: { "io.kubernetes.pod.uid": podAUID },
      state: "CONTAINER_RUNNING",
    },
  ];
  return {
    options,
    snapshot: {
      nodeBefore: node,
      nodeAfter: structuredClone(node),
      sandboxesBefore: sandboxes,
      sandboxesAfter: structuredClone(sandboxes),
      containersBefore: containers,
      containersAfter: structuredClone(containers),
      sentriesBefore: [raw],
      sentriesAfter: [structuredClone(raw)],
      receiverBefore: structuredClone(raw),
      receiverAfter: structuredClone(raw),
    },
  };
}

test("node metadata projection maps a singleton runtime peer and retains only closed provenance", () => {
  const { options, snapshot } = nodeFixture(),
    projected = projectNodeObservation(options, snapshot);
  assert.equal(projected.status, "observed");
  assert.equal(projected.reasonCode, "OBSERVED");
  assert.equal(projected.evidenceAuthenticated, false);
  assert.equal(projected.identityQualified, false);
  assert.equal(projected.observation.receiver.pid, options.receiverPID);
  assert.equal(projected.observation.receiver.component, "sentry");
  assert.equal(projected.observation.receiver.provenance, "protected-node-read");
  assert.equal(projected.observation.mapping.podUID, options.podUID);
  assert.equal(projected.observation.mapping.containerId, snapshot.containersBefore[0].id);
  assert.equal(projected.observation.sandbox.runtimeHandler, options.expectedRuntimeHandler);
  assert.equal(JSON.stringify(projected).includes(secret), false);
  for (const rawField of ["statBefore", "status", "cmdline", "cgroup", "args"])
    assert.equal(rawField in projected.observation.receiver, false);
});

test("node projection rejects wrong Pod, changed process start, wrong binary or runtime handler", () => {
  for (const [expected, change] of [
    [
      "SANDBOX_AMBIGUOUS",
      (o, s) => {
        o.podUID = podBUID;
      },
    ],
    [
      "PROCESS_CHANGED",
      (o, s) => {
        s.receiverAfter.statBefore = procStat(o.receiverPID, "901");
        s.receiverAfter.statAfter = procStat(o.receiverPID, "901");
      },
    ],
    [
      "SENTRY_INVALID",
      (o, s) => {
        o.expectedSentrySHA256 = syntheticHash("f");
      },
    ],
    [
      "SANDBOX_INVALID",
      (o, s) => {
        o.expectedRuntimeHandler = "foreign-handler";
      },
    ],
    [
      "RUNTIME_FLAGS_INVALID",
      (o, s) => {
        for (const raw of [
          ...s.sentriesBefore,
          ...s.sentriesAfter,
          s.receiverBefore,
          s.receiverAfter,
        ])
          raw.cmdline = raw.cmdline.replace("--network=none\0", "--network=host\0");
      },
    ],
  ]) {
    const { options, snapshot } = nodeFixture();
    change(options, snapshot);
    const result = projectNodeObservation(options, snapshot);
    assert.equal(result.reasonCode, expected);
    assert.equal(result.status, "unqualified");
    assert.equal(result.observation, null);
    assert.equal(result.identityQualified, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("node projection refuses multiple sentries and a sentry shared by multiple containers", () => {
  const multiple = nodeFixture();
  multiple.snapshot.sentriesBefore.push(structuredClone(multiple.snapshot.sentriesBefore[0]));
  assert.equal(
    projectNodeObservation(multiple.options, multiple.snapshot).reasonCode,
    "SENTRY_AMBIGUOUS",
  );
  const shared = nodeFixture();
  const another = {
    ...structuredClone(shared.snapshot.containersBefore[0]),
    id: syntheticHash("4"),
    metadata: { name: "second-container" },
  };
  shared.snapshot.containersBefore.push(another);
  shared.snapshot.containersAfter.push(structuredClone(another));
  const result = projectNodeObservation(shared.options, shared.snapshot);
  assert.equal(result.reasonCode, "PEER_AMBIGUOUS");
  assert.equal(result.observation, null);
});

test("actual receiver metadata must independently bind its container, not borrow the sentry mapping", () => {
  const { options, snapshot } = nodeFixture();
  options.receiverPID = 442;
  // This gofer has a valid known executable and mentions the container in argv,
  // but its proc cgroup only binds the sandbox. That is insufficient evidence.
  const receiver = {
    ...snapshot.receiverBefore,
    pid: 442,
    statBefore: procStat(442),
    statAfter: procStat(442),
    cmdline: `/unit/runsc-gofer\0${snapshot.containersBefore[0].id}\0`,
  };
  snapshot.receiverBefore = receiver;
  snapshot.receiverAfter = structuredClone(receiver);
  const result = projectNodeObservation(options, snapshot);
  assert.equal(result.reasonCode, "PEER_NOT_MAPPED");
  assert.equal(result.status, "unqualified");
  assert.equal(result.observation, null);
});

test("node command wait returns finite held custody without close, then the owned helper is actually settled", async (t) => {
  // Exercise the real Node process and pipe lifecycle. Only signal delivery is
  // fault-injected: unsuccessful cancellation must not turn into a forever wait
  // or an assertion that the still-running process physically terminated.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  let cleanupTimer, held;
  try {
    assert(Number.isSafeInteger(child.pid));
    const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
    const startTicks = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[19];
    const identity = { pid: child.pid, startTicks, processGroupID: child.pid };
    const started = performance.now();
    const result = (held = await waitForOwnedCommand(child, {
      timeoutMs: 25,
      settlementMs: 35,
      identity,
      signalGroup() {
        throw new Error("synthetic signal delivery failure");
      },
    }));
    assert(
      performance.now() - started < 2000,
      "missing close must have a finite observation bound",
    );
    assert.equal(result.reasonCode, "COMMAND_SETTLEMENT_UNKNOWN");
    assert.equal(result.custodyHeld, true);
    assert.equal(result.output, null);
    assert.equal(result.ownedChild.pid, identity.pid);
    assert.equal(result.ownedChild.startTicks, startTicks);
    assert.equal(result.ownedChild.processGroupID, identity.processGroupID);
    assert.equal(result.ownedChild.exitObserved, false);
    assert.doesNotThrow(
      () => process.kill(child.pid, 0),
      "unknown custody still refers to the actual live helper",
    );
  } finally {
    // This cleanup uses only the exact process group created above. Await its
    // real close even if an earlier assertion failed; no runtime process exists.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    const outcome = await Promise.race([
      closed,
      new Promise((_, reject) => {
        cleanupTimer = setTimeout(
          () => reject(new Error("owned unit helper failed to close")),
          2000,
        );
      }),
    ]).finally(() => clearTimeout(cleanupTimer));
    assert.equal(outcome.signal, "SIGKILL");
    assert.throws(
      () => process.kill(child.pid, 0),
      (error) => error.code === "ESRCH",
    );
    if (held) {
      assert.equal(held.custodyHeld, true);
      assert.equal(held.ownedChild.exitObserved, false);
    }
    t.diagnostic(
      `owned-helper-settled pid=${child.pid} exitCode=${outcome.code} signal=${outcome.signal} closeObserved=true`,
    );
  }
});

test("Server bootstrap continues into the final profile without replacing prior inputs or extending its deadline", () => {
  const p = profileFixture();
  const pick = (object, fields) =>
    Object.fromEntries(fields.map((field) => [field, object[field]]));
  // Bootstrap contains only inputs known before a genuine Server bundle exists.
  // Synthetic final CA hashes here test declaration continuity, not CA trust.
  const bootstrap = {
    schemaVersion: 1,
    stage: "server-bootstrap",
    sourceCommit: p.sourceCommit,
    deadlineEpochMs: p.deadlineEpochMs,
    artifacts: pick(p.artifacts, ["managementImage", "spireServerSHA256"]),
    cluster: pick(p.cluster, ["nodeName", "apiIPv4", "apiPort"]),
    paths: pick(p.paths, ["spireServerBinary", "serverAdminSocket"]),
    management: pick(p.management, [
      "namespace",
      "serverPod",
      "serverContainer",
      "serverServiceAccount",
      "agentPod",
      "agentServiceAccount",
      "serverPort",
      "trustDomain",
      "clusterID",
    ]),
  };
  const initial = buildServerBootstrap(bootstrap);
  assert.equal(assertServerBootstrapMatches(bootstrap, p), initial.serverConfigSHA256);
  assert.equal(initial.manifests.filter((item) => item.kind === "Pod").length, 1);
  assert.equal(
    initial.manifests.find((item) => item.kind === "Pod").metadata.name,
    p.management.serverPod,
  );
  assert.throws(
    () => validateProfile(bootstrap),
    "bootstrap cannot stand in for a final observation profile",
  );
  const changed = structuredClone(p);
  changed.management.serverPort++;
  assert.throws(() => assertServerBootstrapMatches(bootstrap, changed));
  const extended = structuredClone(p);
  extended.deadlineEpochMs++;
  assert.throws(() => assertServerBootstrapMatches(bootstrap, extended));
});

test("filesystem owner comes from a fresh protected file and its exact probe is removed", async () => {
  // This is an actual local-filesystem machinery check. The creation UID may
  // differ from process.getuid() on mapped filesystems; do not assume equality.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "spire-owner-unit-")));
  try {
    const sentinel = join(directory, "existing-unit-file");
    await writeFile(sentinel, "preserve this independently owned unit file", {
      mode: 0o600,
      flag: "wx",
    });
    const before = await lstat(directory),
      entries = await readdir(directory);
    assert.equal(before.mode & 0o7777, 0o700);
    const principal = await establishFilesystemOwner(directory);
    assert.deepEqual(principal, {
      filesystemOwnerUID: before.uid,
      processUID: process.getuid(),
      provenance: "fresh-protected-file-observation",
      probeSettled: true,
    });
    assert.deepEqual(
      await readdir(directory),
      entries,
      "no probe may remain after successful observation",
    );
    const after = await lstat(directory);
    assert.equal(after.ino, before.ino);
    assert.equal(after.dev, before.dev);
    assert.equal(after.uid, before.uid);
    assert.equal(after.mode & 0o7777, 0o700);
    assert.equal(await readFile(sentinel, "utf8"), "preserve this independently owned unit file");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("filesystem owner preflight rejects unsafe parents without changing modes, following links or leaving probes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "spire-owner-invalid-unit-")));
  try {
    const protectedParent = join(root, "protected"),
      permissiveParent = join(root, "permissive");
    await mkdir(protectedParent, { mode: 0o700 });
    await mkdir(permissiveParent, { mode: 0o700 });
    // Change only this test's new directory, to exercise actual mode rejection.
    await chmod(permissiveParent, 0o755);
    const alias = join(root, "alias"),
      regularFile = join(root, "regular-file");
    await symlink(protectedParent, alias);
    await writeFile(regularFile, "unit sentinel", { mode: 0o600, flag: "wx" });
    const rootEntries = (await readdir(root)).sort();
    for (const candidate of [
      permissiveParent,
      alias,
      `${protectedParent}/.`,
      regularFile,
      "relative-parent",
      join(root, "absent"),
    ]) {
      await assert.rejects(establishFilesystemOwner(candidate), (error) => {
        assert.equal(error.probeSettled, true);
        assert.equal(error.custodyHeld, false);
        assert(
          ["FILESYSTEM_PARENT_INVALID", "FILESYSTEM_PREFLIGHT_FAILED"].includes(error.message),
        );
        assert.equal(
          error.message.includes(root),
          false,
          "errors expose fixed codes, not local paths",
        );
        return true;
      });
    }
    assert.deepEqual((await readdir(root)).sort(), rootEntries);
    assert.deepEqual(await readdir(protectedParent), []);
    assert.deepEqual(await readdir(permissiveParent), []);
    assert.equal(
      (await lstat(permissiveParent)).mode & 0o7777,
      0o755,
      "preflight must not repair an unsafe parent",
    );
    assert.equal((await lstat(alias)).isSymbolicLink(), true);
    assert.equal(await readFile(regularFile, "utf8"), "unit sentinel");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("declared local close failure remains held after an independently owned Node command settles", async (t) => {
  const custody = createLocalResourceCustody();
  assert.equal(Object.isFrozen(custody), true);
  for (const error of [null, new Error("ordinary failure"), { custodyHeld: "true" }]) {
    custody.recordFailure(error);
  }
  assert.deepEqual(custody.disposition(true), {
    localResourceCustodyHeld: false,
    custodyHeld: false,
  });
  assert.deepEqual(custody.disposition(false), {
    localResourceCustodyHeld: false,
    custodyHeld: true,
  });
  for (const value of [undefined, null, 0, 1, "true"]) {
    assert.throws(() => custody.disposition(value));
  }
  // This is a declared close-failure input to the real latch, not an injected
  // OS close syscall. The separate Node command below really exits and settles.
  custody.recordFailure(
    Object.assign(new Error("declared unit close failure"), {
      custodyHeld: true,
    }),
  );
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30)"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  let cleanupTimer;
  try {
    assert(Number.isSafeInteger(child.pid) && child.pid > 0);
    const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
    const startTicks = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[19];
    const result = await waitForOwnedCommand(child, {
      timeoutMs: 2000,
      identity: { pid: child.pid, startTicks, processGroupID: child.pid },
    });
    assert.equal(result.reasonCode, "COMMAND_OK");
    assert.equal(result.custodyHeld, false);
    assert.equal(result.ownedChild, null);
    for (const pid of [child.pid, -child.pid]) {
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error.code === "ESRCH",
      );
    }
    const held = custody.disposition(true);
    assert.equal(Object.isFrozen(held), true);
    assert.deepEqual(held, { localResourceCustodyHeld: true, custodyHeld: true });
    custody.recordFailure(new Error("later ordinary failure"));
    custody.recordFailure({ custodyHeld: false });
    assert.deepEqual(custody.disposition(true), held);
    t.diagnostic(
      `local-close-failure=declared owned-helper-settled pid=${child.pid} processGroupAbsent=true localResourceCustodyHeld=true`,
    );
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        cleanupTimer = setTimeout(
          () => reject(new Error("owned custody-unit helper failed to close")),
          2000,
        );
      }),
    ]).finally(() => clearTimeout(cleanupTimer));
  }
});

test("pure Pod security validation accepts ordinary defaults and rejects added privilege or executable configuration", () => {
  const expected = buildHarnessPod(profileFixture(), "a").spec;
  const actual = structuredClone(expected);
  actual.dnsPolicy = "ClusterFirst";
  actual.schedulerName = "default-scheduler";
  actual.securityContext = {};
  actual.containers[0].securityContext.capabilities.add = [];
  actual.containers[0].stdin = false;
  actual.containers[0].tty = false;
  actual.containers[0].stdinOnce = false;
  assert.equal(validatePodSecurity(actual, expected), true);
  for (const [code, mutate] of [
    [
      "UNREVIEWED_CONTAINER_PRIVILEGE",
      (pod) => {
        pod.containers[0].securityContext.privileged = true;
      },
    ],
    [
      "UNREVIEWED_CONTAINER_PRIVILEGE",
      (pod) => {
        pod.containers[0].securityContext.procMount = "Unmasked";
      },
    ],
    [
      "UNREVIEWED_ADDED_CAPABILITY",
      (pod) => {
        pod.containers[0].securityContext.capabilities.add = ["NET_ADMIN"];
      },
    ],
    [
      "UNREVIEWED_SECCOMP_PROFILE",
      (pod) => {
        pod.containers[0].securityContext.seccompProfile = { type: "Unconfined" };
      },
    ],
    [
      "UNREVIEWED_CONTAINER_FIELD",
      (pod) => {
        pod.containers[0].env = [{ name: "UNREVIEWED_CONFIG", value: "unit-value" }];
      },
    ],
    [
      "UNREVIEWED_CONTAINER_FIELD",
      (pod) => {
        pod.containers[0].lifecycle = { postStart: { exec: { command: ["unit-command"] } } };
      },
    ],
    [
      "UNREVIEWED_MOUNT_MODE",
      (pod) => {
        pod.containers[0].volumeMounts[0].mountPropagation = "Bidirectional";
      },
    ],
    [
      "UNREVIEWED_MOUNT_MODE",
      (pod) => {
        pod.containers[0].volumeMounts[0].subPath = "other-path";
      },
    ],
    [
      "UNREVIEWED_EXTRA_CONTAINER",
      (pod) => {
        pod.initContainers = [structuredClone(pod.containers[0])];
      },
    ],
    [
      "UNREVIEWED_EXTRA_CONTAINER",
      (pod) => {
        pod.ephemeralContainers = [structuredClone(pod.containers[0])];
      },
    ],
    [
      "UNREVIEWED_POD_SECURITY_CONTEXT",
      (pod) => {
        pod.securityContext = { supplementalGroups: [0] };
      },
    ],
  ]) {
    const rejected = structuredClone(actual);
    mutate(rejected);
    assert.throws(
      () => validatePodSecurity(rejected, expected),
      (error) => error.code === code && error.message === code,
    );
  }
});

test("direct command close cannot certify an observed live group; association is injected and both real children settle", async (t) => {
  // Both children are direct children of this test and have independent process
  // groups. The command emits a genuine close. Only the group association is
  // injected: its observation queries the separately owned surviving group.
  // This proves live-group rejection, not real descendant discovery or the
  // production binding of a command PID to its original process-group ID.
  const survivor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const survivorClosed = new Promise((resolve) =>
    survivor.once("close", (code, signal) => resolve({ code, signal })),
  );
  const command = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 40)"], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const commandClosed = new Promise((resolve) =>
    command.once("close", (code, signal) => resolve({ code, signal })),
  );
  let held, cleanupTimer;
  try {
    const stat = readFileSync(`/proc/${command.pid}/stat`, "utf8");
    const startTicks = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[19];
    const queried = [];
    const started = performance.now();
    held = await waitForOwnedCommand(command, {
      timeoutMs: 2000,
      settlementMs: 100,
      identity: { pid: command.pid, startTicks, processGroupID: command.pid },
      groupObservation(expectedProcessGroupID) {
        queried.push(expectedProcessGroupID);
        try {
          process.kill(-survivor.pid, 0);
          return false;
        } catch (error) {
          return error.code === "ESRCH" ? true : null;
        }
      },
    });
    assert(performance.now() - started < 2500);
    assert(queried.length > 0 && queried.every((id) => id === command.pid));
    assert.equal(held.reasonCode, "COMMAND_SETTLEMENT_UNKNOWN");
    assert.equal(held.output, null);
    assert.equal(held.custodyHeld, true);
    assert.equal(held.ownedChild.pid, command.pid);
    assert.equal(held.ownedChild.startTicks, startTicks);
    assert.equal(held.ownedChild.processGroupID, command.pid);
    assert.equal(held.ownedChild.directCloseObserved, true);
    assert.equal(held.ownedChild.exitObserved, true);
    assert.equal(held.ownedChild.processGroupAbsent, false);
    assert.equal(held.ownedChild.killRequested, false);
    assert.equal(Object.isFrozen(held), true);
    assert.equal(Object.isFrozen(held.ownedChild), true);
    assert.equal((await commandClosed).code, 0);
    assert.doesNotThrow(() => process.kill(-survivor.pid, 0));
  } finally {
    for (const child of [command, survivor]) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    }
    const [commandExit, survivorExit] = await Promise.race([
      Promise.all([commandClosed, survivorClosed]),
      new Promise((_, reject) => {
        cleanupTimer = setTimeout(
          () => reject(new Error("owned group unit helpers failed to close")),
          2000,
        );
      }),
    ]).finally(() => clearTimeout(cleanupTimer));
    for (const child of [command, survivor]) {
      assert.throws(
        () => process.kill(child.pid, 0),
        (error) => error.code === "ESRCH",
      );
      assert.throws(
        () => process.kill(-child.pid, 0),
        (error) => error.code === "ESRCH",
      );
    }
    assert.equal(survivorExit.signal, "SIGKILL");
    if (held) {
      assert.equal(held.custodyHeld, true);
      assert.equal(held.ownedChild.processGroupAbsent, false);
    }
    t.diagnostic(
      `owned-group-helpers-settled commandPID=${command.pid} commandExit=${commandExit.code} survivorPID=${survivor.pid} survivorSignal=${survivorExit.signal} bothCloseObserved=true bothGroupsAbsent=true association=injected`,
    );
  }
});

test("observed lifetime binds actual start delay to the fixed deadline and rejects invalid timing", () => {
  const created = Date.parse("2026-09-08T12:00:00Z"),
    iso = (ms) => new Date(ms).toISOString();
  const deadline = created + 120000,
    now = created + 20000;
  for (const kind of ["pod", "agent"]) {
    const accepted = validateObservedLifetime(
      kind,
      iso(created),
      iso(created + 10000),
      110000,
      deadline,
      now,
    );
    assert.equal(accepted.computedExpiryEpochMs, deadline);
    assert.equal(accepted.deadlineEpochMs, deadline);
    assert.equal(accepted.clockToleranceMs, 5000);
    assert.equal(Object.isFrozen(accepted), true);
  }
  for (const args of [
    ["pod", iso(created), iso(created + 10000), 120000, deadline, now],
    ["agent", iso(created), iso(now + 5001), 1000, deadline, now],
    ["pod", iso(created), iso(created - 5001), 1000, deadline, now],
    ["pod", iso(created), iso(created), -1, deadline, now],
    ["agent", iso(created), iso(created), 1800001, deadline, now],
    ["pod", "2026-02-31T12:00:00Z", iso(created), 1000, deadline, now],
    ["agent", "invalid-time", iso(created), 1000, deadline, now],
  ])
    assert.throws(
      () => validateObservedLifetime(...args),
      (error) => error.code === "OBSERVED_LIFETIME_INVALID",
    );
});
