import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  childEnvironment,
  parseOptions,
  runChild,
  runChildren,
} from "../../scripts/test-postgres-isolated.mjs";
import { createPlan, suites } from "../helpers/postgres-isolated-databases.mjs";

test("isolated selection preserves the exact two complete suites and rejects extra options", () => {
  assert.deepEqual(Object.values(suites), [
    "tests/integration/postgres-runtime-assignment-state.test.mjs",
    "tests/integration/postgres-channel-bindings.test.mjs",
  ]);
  assert.deepEqual(parseOptions(["--config", "private.json", "--output", "new"]), {
    config: "private.json",
    output: "new",
    mode: "serial",
    suite: "both",
  });
  for (const extra of [
    ["--test-name-pattern", "subset"],
    ["--mode", "parallel", "--mode", "serial"],
    ["--suite", "other"],
    ["--mode", "4"],
  ])
    assert.throws(() => parseOptions(["--config", "private.json", "--output", "new", ...extra]));
  const plan = createPlan({
    host: "127.0.0.1",
    port: 12345,
    systemIdentifier: "123",
    namePrefix: "oce_test",
  });
  assert.equal(new Set(plan.databases.map((entry) => entry.name)).size, 2);
  assert.ok(Object.isFrozen(plan.databases[0]));
});

test("actual application child receives only its own selected database credential", async () => {
  const result = await runChild({
    label: "environment",
    args: ["--input-type=module", "--eval", "console.log(JSON.stringify(process.env))"],
    env: childEnvironment("OCC_TEST_DATABASE_URL", "postgresql://application-only@127.0.0.1/owned"),
  });
  assert.equal(result.ok, true);
  const env = JSON.parse(result.output);
  assert.equal(env.OCC_TEST_DATABASE_URL, "postgresql://application-only@127.0.0.1/owned");
  assert.deepEqual(
    Object.keys(env).filter((key) => /^(?:PG|OCC_|NODE_OPTIONS|DATABASE_URL)/.test(key)),
    ["OCC_TEST_DATABASE_URL"],
  );
});

test("real failed child cancels its overlapping peer and does not launch queued work", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "postgres-isolated-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ready = join(directory, "ready");
  const events = [];
  const peer = [
    "--input-type=module",
    "--eval",
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`,
  ];
  const fail = [
    "--input-type=module",
    "--eval",
    `import {existsSync} from 'node:fs';const timer=setInterval(()=>{if(existsSync(${JSON.stringify(ready)})){clearInterval(timer);process.exit(7);}},10);`,
  ];
  await assert.rejects(
    runChildren(
      [
        { label: "peer", args: peer, env: childEnvironment() },
        { label: "failure", args: fail, env: childEnvironment() },
        { label: "never", args: ["--eval", "process.exit(0)"], env: childEnvironment() },
      ],
      { concurrency: 2, record: (event) => events.push(event) },
    ),
  );
  assert.equal(await readFile(ready, "utf8"), "ready");
  assert.equal(
    events.some((event) => event.label === "never"),
    false,
  );
  assert.equal(
    events.find((event) => event.event === "child-exit" && event.label === "failure").code,
    7,
  );
  for (const event of events.filter((event) => event.event === "child-start"))
    assert.throws(() => process.kill(event.pid, 0), { code: "ESRCH" });
});

test("interruption reaps a real Node test worker and its owned child group", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "postgres-isolated-interrupt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workerPath = join(directory, "worker.pid");
  const controller = new AbortController();
  let childPid;
  const code = `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=spawn(process.execPath,['--eval','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(workerPath)},String(child.pid));process.on('SIGTERM',()=>{child.once('exit',()=>process.exit(0));child.kill('SIGTERM');});setInterval(()=>{},1000);`;
  const testPath = join(directory, "owned.test.mjs");
  await writeFile(testPath, code);
  const promise = runChild({
    label: "owned-tree",
    args: ["--test", testPath],
    env: childEnvironment(),
    signal: controller.signal,
    record: (event) => {
      if (event.event === "child-start") childPid = event.pid;
    },
  });
  let descendant, result;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        descendant = Number(await readFile(workerPath, "utf8"));
        break;
      } catch {
        await delay(20);
      }
    }
    assert.ok(descendant, "real descendant did not start");
  } finally {
    controller.abort();
    result = await promise;
  }
  assert.equal(result.ok, false);
  for (const pid of [childPid, descendant])
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("a real custody journal write failure cancels the started process", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "postgres-isolated-journal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let pid;
  await assert.rejects(
    runChild({
      label: "journal-failure",
      args: ["--eval", "setInterval(()=>{},1000)"],
      env: childEnvironment(),
      record: (event) => {
        pid ??= event.pid;
        appendFileSync(directory, "cannot write a file over a directory");
      },
    }),
    { code: "EISDIR" },
  );
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("lease runtime cap stops a real child before the cleanup reserve", async () => {
  const started = performance.now();
  const result = await runChild({
    label: "lease",
    args: ["--eval", "setInterval(()=>{},1000)"],
    env: childEnvironment(),
    leaseExpiresAt: new Date(Date.now() + 60300).toISOString(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.quiescent, true);
  assert.match(result.error, /deadline/);
  assert.ok(performance.now() - started < 5000);
});
