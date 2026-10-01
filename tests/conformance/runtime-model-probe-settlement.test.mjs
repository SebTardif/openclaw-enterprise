import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { inflateRawSync } from "node:zlib";
import { nodeProgramArguments } from "../../apps/controller/src/drivers/compute/node-program.ts";
import test from "node:test";
import vm from "node:vm";
import {
  modelProbeSettled,
  trackProbeCpuHog,
  modelProbeLoadGate,
  waitForProbeCpuLoad,
} from "../helpers/runtime-model-probe-observation.mjs";
import reporter from "../../scripts/ci/reporter.mjs";
import { GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";

const execute = promisify(execFile);
const ready = {
  events: [
    { event: "observe", key: "ready", value: true },
    { event: "observe", key: "plugin", value: "ready" },
  ],
};

test("probe settlement accepts ready and failed outcomes without accepting partial readiness", () => {
  assert.equal(modelProbeSettled(ready), true);
  assert.equal(
    modelProbeSettled({
      events: [{ event: "observe", key: "runtimeFailure", value: "MODEL_PROBE_CPU_STARVED" }],
    }),
    true,
  );
  assert.equal(modelProbeSettled({ events: ready.events.slice(0, 1) }), false);
  assert.equal(
    modelProbeSettled({ events: [{ event: "observe", key: "runtimeFailure", value: null }] }),
    false,
  );
  assert.equal(modelProbeSettled({ events: [{ event: "observe", key: "runtimeFailure" }] }), false);
});

test("actual starved-case callback accepts READY; guard-removal control does not", async () => {
  const source = await readFile(
    new URL("../integration/runtime-image-model-probe.test.mjs", import.meta.url),
    "utf8",
  );
  const body = source.slice(
    source.indexOf('"runtime image embedded Gateway reports a CPU-starved model probe at its cap"'),
  );
  const start = body.indexOf("until: ") + 7;
  const end = body.indexOf("\n      },", start) + 8;
  const callback = body.slice(start, end);
  const evaluate = (code) =>
    vm.runInNewContext(`(${code})`, {
      modelProbeSettled,
      failed: ({ events }) =>
        events.some((event) => event.key === "runtimeFailure" && event.value != null),
    });
  assert.equal(evaluate(callback)(ready, "owned"), true);
  const negative = callback.replace(
    "return modelProbeSettled(snapshot);",
    "return failed(snapshot);",
  );
  assert.notEqual(negative, callback);
  assert.equal(evaluate(negative)(ready, "owned"), false);
  const program = /'([^']*openclaw-cpu-hog-started[^']*)'/u.exec(body)?.[1];
  assert.ok(program);
  const actualArgument = vm.runInNewContext(`'${program}'`);
  assert.doesNotThrow(() => new vm.Script(actualArgument));
});

test(
  "owned inert Node child proves marker observation and terminal settlement",
  { timeout: 10_000 },
  async () => {
    const stress = { requested: 0, started: 0, settled: 0, rejected: 0 };
    const operation = execute(
      process.execPath,
      ["-e", 'process.stdout.write("openclaw-cpu-hog-started\\n")'],
      { timeout: 2_000 },
    );
    const tracked = trackProbeCpuHog(operation, stress);
    assert.equal(await tracked.admitted, true);
    await tracked.settled;
    assert.deepEqual(stress, { requested: 1, started: 1, settled: 1, rejected: 0 });
  },
);

test("a rejected owned inert child is not counted as started", { timeout: 10_000 }, async () => {
  const stress = { requested: 0, started: 0, settled: 0, rejected: 0 };
  const tracked = trackProbeCpuHog(
    execute(process.execPath, ["-e", "process.exit(3)"], { timeout: 2_000 }),
    stress,
  );
  assert.equal(await tracked.admitted, false);
  await tracked.settled;
  assert.deepEqual(stress, { requested: 1, started: 0, settled: 1, rejected: 1 });
});

test(
  "real Node reporter retains only closed probe failure observations",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pr687-probe-report-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const fixture = join(directory, "failure.test.mjs");
    await writeFile(
      fixture,
      `import test from 'node:test'; import assert from 'node:assert/strict';
    test('owned failure',()=>{ const error=new assert.AssertionError({message:'must-not-be-retained'});
    error.openclawCiDiagnostic={kind:'runtime-model-probe',reason:'outer-timeout',
    readyObserved:true,pluginReadyObserved:true,running:true,probeStage:'cleanup',probe:'READY',modelPhase:'ok',nativeSpawnPhaseObserved:true,failureObserved:false,
    capMs:110000,elapsedMs:120000,cpuWaitMs:null,loadClientsSubmitted:8,loadClientsStarted:7,loadClientsSettled:1,loadClientsRejected:1,
    raw:'must-not-be-retained',url:'https://must-not-be-retained.invalid',environment:'must-not-be-retained'};
    throw error;});`,
    );
    const reporterPath = fileURLToPath(new URL("../../scripts/ci/reporter.mjs", import.meta.url));
    let result;
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.NODE_TEST_WORKER_ID;
    try {
      await execute(process.execPath, ["--test", "--test-reporter", reporterPath, fixture], {
        timeout: 5_000,
        env: childEnv,
      });
    } catch (error) {
      result = error;
    }
    assert.equal(result?.code, 1);
    assert.doesNotMatch(result.stdout, /must-not-be-retained/u);
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const diagnostic = events.find(
      (event) => event.type === "test:fail" && event.data.name === "owned failure",
    )?.data.error.diagnostic;
    assert.deepEqual(diagnostic, {
      kind: "runtime-model-probe",
      reason: "outer-timeout",
      running: true,
      readyObserved: true,
      pluginReadyObserved: true,
      capMs: 110000,
      elapsedMs: 120000,
      cpuWaitMs: null,
      loadClientsSubmitted: 8,
      loadClientsStarted: 7,
      loadClientsSettled: 1,
      loadClientsRejected: 1,
      probeStage: "cleanup",
      probe: "READY",
      modelPhase: "ok",
      nativeSpawnPhaseObserved: true,
      failureObserved: false,
    });
  },
);

test("reporter rejects unknown categories and strips unbounded or arbitrary fields", async () => {
  const render = async (diagnostic) => {
    const source = [
      {
        type: "test:fail",
        data: { name: "owned", details: { error: { openclawCiDiagnostic: diagnostic } } },
      },
    ];
    let text = "";
    for await (const chunk of reporter(source)) {
      text += chunk;
    }
    return JSON.parse(text).data.error.diagnostic;
  };
  assert.equal(await render({ kind: "runtime-model-probe", reason: "arbitrary" }), undefined);
  const result = await render({
    kind: "runtime-model-probe",
    reason: "classification",
    probeStage: "must-not-be-retained",
    probeCode: "must-not-be-retained",
    running: "must-not-be-retained",
    capMs: Infinity,
    hogsStarted: 9,
    elapsedMs: -1,
    raw: "must-not-be-retained",
  });
  assert.equal(result, undefined);
  const valid = {
    kind: "runtime-model-probe",
    reason: "classification",
    probe: "READY",
    modelPhase: "ok",
    running: true,
    readyObserved: true,
    pluginReadyObserved: true,
    nativeSpawnPhaseObserved: true,
    failureObserved: false,
    loadClientsSubmitted: 8,
    loadClientsStarted: 8,
    loadClientsSettled: 1,
    loadClientsRejected: 1,
    capMs: 110000,
    elapsedMs: 120000,
    cpuWaitMs: null,
    probeStage: "complete",
  };
  assert.equal((await render(valid)).probe, "READY");
  for (const [key, value] of [
    ["running", "arbitrary"],
    ["probe", "arbitrary"],
    ["modelPhase", "arbitrary"],
    ["loadClientsSubmitted", 9],
    ["loadClientsStarted", -1],
    ["loadClientsRejected", 2],
    ["capMs", Infinity],
    ["elapsedMs", -1],
    ["cpuWaitMs", "arbitrary"],
  ]) {
    assert.equal(await render({ ...valid, [key]: value }), undefined);
  }
  const stripped = await render({
    ...valid,
    probeStage: "must-not-be-retained",
    extra: "must-not-be-retained",
  });
  assert.equal(stripped.probeStage, "not-observed");
  assert.doesNotMatch(JSON.stringify(stripped), /must-not-be-retained/u);
});

test("real generated probe marks spawn return and cleanup without changing CAP", () => {
  const begin = GATEWAY_RUNTIME_ENTRYPOINT.indexOf(
    "function runOpenClawAuthenticationProbe(fs, capMs) {",
  );
  const end = GATEWAY_RUNTIME_ENTRYPOINT.indexOf("\n}\n", begin) + 2;
  const helper = GATEWAY_RUNTIME_ENTRYPOINT.slice(begin, end);
  assert.ok(begin >= 0 && end > begin);
  const events = [];
  let removed = false;
  const fs = {
    mkdtempSync: () => "/owned",
    mkdirSync() {},
    writeFileSync() {},
    rmSync() {
      removed = true;
    },
  };
  const code = vm.runInNewContext(helper + "\nrunOpenClawAuthenticationProbe(fs,110000)", {
    fs,
    Date,
    JSON,
    require: () => ({ spawnSync: () => ({ error: { code: "ETIMEDOUT" } }) }),
    process: {
      env: {
        OPENCLAW_HARNESS_MODEL: "fixture/model",
        OPENCLAW_HARNESS_PROVIDER: "fixture",
        OPENCLAW_HARNESS_CREDENTIAL_ENV: "FIXTURE_VALUE",
        FIXTURE_VALUE: "synthetic",
        OPENCLAW_HARNESS_PROBE_CONFIG: JSON.stringify({
          agents: { defaults: { model: "fixture/model" } },
        }),
      },
    },
    console: {
      error(line) {
        events.push(JSON.parse(line));
      },
    },
  });
  assert.equal(code, "CAP");
  assert.equal(removed, true);
  assert.deepEqual(
    events.map((event) => event.stage),
    ["prepare", "spawn", "returned", "cleanup", "complete"],
  );
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ["capMs", "elapsedMs", "event", "stage"]);
    assert.equal(event.capMs, 110000);
  }
});

// Exercise the image fixture's actual admission callback, substituting only
// its Docker transport with owned, inert Node processes controlled through stdin.
async function loadAdmissionFixture(t, behaviors = {}) {
  const source = await readFile(
    new URL("../integration/runtime-image-model-probe.test.mjs", import.meta.url),
    "utf8",
  );
  const body = source.slice(
    source.indexOf('"runtime image embedded Gateway reports a CPU-starved model probe at its cap"'),
  );
  const begin = body.indexOf("beforeProbe: ") + "beforeProbe: ".length;
  const end = body.indexOf("\n      },", begin) + 8;
  assert.ok(begin >= "beforeProbe: ".length && end > begin);
  const callback = body.slice(begin, end);
  const operations = [];
  const stress = { requested: 0, started: 0, settled: 0, rejected: 0 };
  const context = {
    Promise,
    Date,
    trackProbeCpuHog,
    waitForProbeCpuLoad,
    stress,
    docker: "not-executed",
    execute(_engine, args, options) {
      assert.equal(args[0], "exec");
      assert.equal(options.timeout, 600_000);
      assert.match(args[4], /openclaw-cpu-hog-started/);
      const behavior = behaviors[operations.length] ?? "hold";
      const program =
        behavior === "refuse"
          ? "process.exit(3)"
          : `process.stdin.once("data", () => {
          process.stdout.write("openclaw-cpu-hog-started\\n");
          ${behavior === "exit" ? "process.exit(0);" : "setInterval(() => {}, 1000);"}
        });`;
      const operation = execute(process.execPath, ["-e", program], {
        timeout: 2_000,
        maxBuffer: 1024,
      });
      operations.push(operation);
      return operation;
    },
  };
  const fixture = vm.runInNewContext(
    `let hogs; const start = (${callback}); ({start, settled: () => hogs})`,
    context,
  );
  const admissions = [];
  t.after(async () => {
    for (const operation of operations) {
      if (operation.child.exitCode === null && operation.child.signalCode === null) {
        operation.child.kill("SIGTERM");
      }
    }
    await fixture.settled();
    await Promise.all(admissions);
    assert.equal(stress.settled, operations.length);
  });
  return {
    ...fixture,
    operations,
    stress,
    start(...args) {
      const admission = fixture.start(...args);
      // A failing assertion must still observe the pending admission's outcome
      // when cleanup stops its children. Callers retain the original rejection.
      admissions.push(admission.catch(() => {}));
      return admission;
    },
  };
}

async function waitForObserved(predicate) {
  const deadline = Date.now() + 1_500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "the owned process observation must settle");
    await delay(5);
  }
}

async function inertGatedGateway(t) {
  const directory = await mkdtemp(join(tmpdir(), "model-probe-gate-"));
  const gate = modelProbeLoadGate(
    'process.stdout.write("owned-gateway-started\\n")',
    join(directory, "release"),
  );
  const operation = execute(process.execPath, ["-e", gate.program], {
    timeout: 2_000,
    maxBuffer: 4096,
  });
  // Observe the terminal outcome immediately as well as on cleanup, so a stopped
  // gate never creates an unhandled rejection or an unobserved process handle.
  const settled = operation.then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  let output = "";
  operation.child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  t.after(async () => {
    if (operation.child.exitCode === null && operation.child.signalCode === null) {
      operation.child.kill("SIGTERM");
    }
    await settled;
    await rm(directory, { recursive: true, force: true });
  });
  await waitForObserved(() => output.includes("openclaw-probe-load-waiting\n"));
  return { gate, operation, settled, output: () => output };
}

test(
  "load admission gates the actual callback and generated program until all eight markers",
  { timeout: 10_000 },
  async (t) => {
    const gateway = await inertGatedGateway(t);
    const load = await loadAdmissionFixture(t);
    let admitted = false;
    const admission = load.start("owned", Date.now() + 1_500).then(() => {
      admitted = true;
    });
    for (const operation of load.operations.slice(0, 7)) {
      operation.child.stdin.end("admit\n");
    }
    await waitForObserved(() => load.stress.started === 7);
    assert.equal(admitted, false, "seven starts cannot admit the Gateway");
    assert.doesNotMatch(
      gateway.output(),
      /owned-gateway-started/,
      "Gateway must remain gated before all eight admissions",
    );
    load.operations[7].child.stdin.end("admit\n");
    await admission;
    assert.equal(load.stress.settled, 0);
    assert.doesNotMatch(
      gateway.output(),
      /owned-gateway-started/,
      "admission alone does not synthesize gate release",
    );
    await execute(process.execPath, ["-e", gateway.gate.release], { timeout: 1_000 });
    const outcome = await gateway.settled;
    assert.equal(outcome.error, undefined);
    assert.match(outcome.result.stdout, /owned-gateway-started/);
  },
);

test(
  "refused admission keeps the generated gate closed and settles owned children",
  { timeout: 10_000 },
  async (t) => {
    const gateway = await inertGatedGateway(t);
    const load = await loadAdmissionFixture(t, { 0: "refuse" });
    const admission = load.start("owned", Date.now() + 1_500);
    for (const operation of load.operations.slice(1)) {
      operation.child.stdin.end("admit\n");
    }
    await assert.rejects(admission, /All eight CPU load clients must be running/);
    assert.equal(load.stress.rejected, 1);
    assert.doesNotMatch(gateway.output(), /owned-gateway-started/);
  },
);

test(
  "a client stopping after its marker cannot qualify sustained load admission",
  { timeout: 10_000 },
  async (t) => {
    const gateway = await inertGatedGateway(t);
    const load = await loadAdmissionFixture(t, { 0: "exit" });
    const admission = load.start("owned", Date.now() + 1_500);
    load.operations[0].child.stdin.end("admit\n");
    await waitForObserved(() => load.stress.settled === 1);
    for (const operation of load.operations.slice(1)) {
      operation.child.stdin.end("admit\n");
    }
    await assert.rejects(admission, /All eight CPU load clients must be running/);
    assert.equal(load.stress.started, 8);
    assert.doesNotMatch(gateway.output(), /owned-gateway-started/);
  },
);

test(
  "late markers cannot reopen an exhausted admission budget or launch the Gateway",
  { timeout: 10_000 },
  async (t) => {
    const gateway = await inertGatedGateway(t);
    const load = await loadAdmissionFixture(t);
    await assert.rejects(load.start("owned", Date.now() + 30), /admission exceeded its budget/);
    for (const operation of load.operations) {
      operation.child.stdin.end("late\n");
    }
    await waitForObserved(() => load.stress.started === 8);
    assert.doesNotMatch(gateway.output(), /owned-gateway-started/);
  },
);

test(
  "an already exhausted shared deadline admits no load command",
  { timeout: 10_000 },
  async (t) => {
    const load = await loadAdmissionFixture(t);
    await assert.rejects(load.start("owned", Date.now() - 1), /admission exceeded its budget/);
    assert.equal(load.operations.length, 0);
    assert.deepEqual(load.stress, { requested: 0, started: 0, settled: 0, rejected: 0 });
  },
);

test(
  "a never-open generated gate stops within its owned process bound",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "model-probe-never-open-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const gate = modelProbeLoadGate(
      'process.stdout.write("must-not-start")',
      join(directory, "absent"),
    );
    await assert.rejects(
      execute(process.execPath, ["-e", gate.program], { timeout: 300, maxBuffer: 4096 }),
      (error) => {
        assert.equal(error.killed, true);
        assert.equal(error.signal, "SIGTERM");
        assert.match(error.stdout, /openclaw-probe-load-waiting/);
        assert.doesNotMatch(error.stdout, /must-not-start/);
        return true;
      },
    );
  },
);

test("the gated Gateway keeps real generated bytes and bounded launch arguments", () => {
  const gate = modelProbeLoadGate(GATEWAY_RUNTIME_ENTRYPOINT);
  const args = nodeProgramArguments(gate.program);
  assert.ok(args.every((argument) => Buffer.byteLength(argument) <= 32_768));
  const decoded = inflateRawSync(Buffer.from(args.slice(1).join(""), "base64")).toString("utf8");
  assert.equal(decoded, gate.program);
  assert.doesNotThrow(() => new vm.Script(decoded));
  let tick;
  let opened = false;
  let suppliedProgram;
  let cleared = false;
  const fs = {
    existsSync: () => opened,
    writeFileSync() {
      opened = true;
    },
  };
  const context = {
    process: { stdout: { write() {} } },
    setInterval(callback) {
      tick = callback;
      return 1;
    },
    clearInterval(id) {
      assert.equal(id, 1);
      cleared = true;
    },
    require(specifier) {
      if (specifier === "node:fs") {
        return fs;
      }
      assert.equal(specifier, "node:vm");
      return {
        runInThisContext(program) {
          suppliedProgram = program;
        },
      };
    },
  };
  vm.runInNewContext(decoded, context);
  tick();
  assert.equal(suppliedProgram, undefined);
  vm.runInNewContext(gate.release, context);
  tick();
  assert.equal(cleared, true);
  assert.equal(suppliedProgram, GATEWAY_RUNTIME_ENTRYPOINT);
});
