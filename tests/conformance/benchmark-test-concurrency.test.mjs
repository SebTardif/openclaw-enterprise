import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { files } from "../../scripts/benchmark-test-concurrency.mjs";

const source = fileURLToPath(new URL("../../", import.meta.url));
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
function fixture(
  t,
  body = "test('passes', () => {}); test('explicit skip', {skip: true}, () => {});",
) {
  const dir = mkdtempSync(join(tmpdir(), "oce-concurrency-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "repo");
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const script of ["test-files.mjs", "benchmark-test-concurrency.mjs"])
    copyFileSync(join(source, "scripts", script), join(root, "scripts", script));
  for (const path of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `import test from 'node:test';\n${body}\n`);
  }
  for (const args of [
    ["init", "--quiet"],
    ["add", "."],
    [
      "-c",
      "user.name=Test Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Fixture",
    ],
  ]) {
    const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return {
    dir,
    root,
    output: join(dir, "evidence"),
    runner: join(root, "scripts/benchmark-test-concurrency.mjs"),
  };
}

test(
  "two interrupted groups finalize late owned log writes before hashing evidence",
  { timeout: 20000 },
  async (t) => {
    if (!capacity(t)) return;
    const f = fixture(
      t,
      `
    import {mkdirSync, readFileSync, readdirSync, writeFileSync, openSync, writeSync} from 'node:fs';
    const stat = readFileSync('/proc/self/stat', 'utf8');
    const group = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
    mkdirSync('started-groups', {recursive: true});
    writeFileSync('started-groups/' + group, String(process.pid));
    if (readdirSync('started-groups').length >= 4) {
      // Hold a real descriptor for the measurement log, as a late descendant
      // can do after the GNU time parent has already closed.
      const fd = openSync('/proc/' + group + '/fd/1', 'a');
      let finishing = false;
      process.on('SIGTERM', () => {
        if (finishing) return;
        finishing = true;
        setTimeout(() => { writeSync(fd, '# late owned writer ' + group + '\\n'); process.exit(0); }, 150);
      });
      test('live after first three configurations', async () => { await new Promise(() => setInterval(() => {}, 1000)); });
    } else test('passes', () => {});
  `,
    );
    const child = spawn(process.execPath, [f.runner, `--output=${f.output}`, "--repeats=1"], {
      cwd: f.root,
      env,
      stdio: "pipe",
    });
    child.stdout.resume();
    child.stderr.resume();
    const closed = once(child, "close");
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    const started = join(f.root, "started-groups");
    const deadline = Date.now() + 10000;
    while ((!existsSync(started) || readdirSync(started).length < 5) && Date.now() < deadline)
      await setTimeout(20);
    assert.equal(readdirSync(started).length, 5, "both groups of fourth configuration started");
    await setTimeout(100);
    child.kill("SIGTERM");
    const [code, observedSignal] = await closed;
    assert.equal(code, null);
    assert.equal(observedSignal, "SIGTERM");
    const report = JSON.parse(readFileSync(join(f.output, "report.json")));
    assert.equal(report.status, "interrupted");
    const last = report.results.at(-1);
    assert.equal(last.groups, 2);
    assert.equal(last.runs.length, 2);
    assert.deepEqual(last.remainingOwnedProcesses, []);
    for (const run of last.runs) {
      const bytes = readFileSync(join(f.output, run.log));
      assert.match(bytes.toString(), new RegExp(`# late owned writer ${run.pid}`));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), run.logSha256);
      // Even an out-of-contract writer changing the live descriptor afterward
      // cannot mutate the retained snapshot named by the evidence receipt.
      writeFileSync(join(f.output, run.liveLog), "later live-log bytes");
      assert.deepEqual(readFileSync(join(f.output, run.log)), bytes);
    }
  },
);
function invoke(f, extra = []) {
  return spawnSync(process.execPath, [f.runner, `--output=${f.output}`, "--repeats=1", ...extra], {
    cwd: f.root,
    env,
    encoding: "utf8",
    timeout: 30000,
  });
}
function capacity(t) {
  if (process.platform !== "linux" || !existsSync("/usr/bin/time")) {
    t.skip("Linux /proc and GNU time required");
    return false;
  }
  const bytes =
    Number(/^MemAvailable:\s+(\d+)/m.exec(readFileSync("/proc/meminfo", "utf8"))?.[1]) * 1024;
  if (bytes < 8 * 1024 ** 3) {
    t.skip("Benchmark requires 8 GiB available before launching");
    return false;
  }
  return true;
}

test(
  "records a complete actual six-configuration matrix with matched files, outcomes and resources",
  { timeout: 30000 },
  (t) => {
    if (!capacity(t)) return;
    const f = fixture(t);
    const result = invoke(f);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(readFileSync(join(f.output, "report.json")));
    assert.equal(report.status, "complete");
    assert.equal(report.results.length, 6);
    assert.deepEqual(
      report.order.map(({ groups, concurrency }) => [groups, concurrency]),
      [
        [1, 1],
        [1, 2],
        [1, 4],
        [2, 1],
        [2, 2],
        [2, 4],
      ],
    );
    assert.deepEqual(
      report.identity.manifest.map((entry) => entry.path),
      files,
    );
    const hashes = new Set();
    for (const configuration of report.results) {
      assert.equal(configuration.runs.length, configuration.groups);
      assert.ok(configuration.sampledPeakSumRssBytes > 0);
      assert.equal(configuration.remainingOwnedProcesses.length, 0);
      assert.equal(configuration.cleanupEscalated, false);
      assert.ok(configuration.successfulInvocationsPerSecond > 0);
      for (const run of configuration.runs) {
        assert.equal(run.exitCode, 0);
        assert.equal(run.counts.tests, 16);
        assert.equal(run.counts.pass, 8);
        assert.equal(run.counts.skipped, 8);
        assert.equal(run.counts.fail, 0);
        assert.ok(run.resources.userSeconds > 0);
        assert.ok(run.resources.maxProcessRssKiB > 0);
        hashes.add(run.caseOutcomesSha256);
      }
    }
    assert.equal(hashes.size, 1);
  },
);

test("rejects missing selection, invalid options and reused output without executing tests", (t) => {
  const f = fixture(t, `throw Error('must not execute');`);
  rmSync(join(f.root, files.at(-1)));
  assert.equal(invoke(f).status, 1);
  assert.equal(existsSync(f.output), false);
  assert.equal(invoke(f, ["--repeats=2"]).status, 1);
  assert.equal(invoke(f, ["--concurrency=16"]).status, 1);
  mkdirSync(f.output);
  writeFileSync(join(f.output, "retained"), "untouched");
  assert.equal(invoke(f).status, 1);
  assert.equal(readFileSync(join(f.output, "retained"), "utf8"), "untouched");
});

test("retains failed actual tests and refuses to present them as completed matrix results", (t) => {
  if (!capacity(t)) return;
  const f = fixture(t, "test('fails', () => { throw Error('actual failure'); });");
  const result = invoke(f);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(readFileSync(join(f.output, "report.json")));
  assert.equal(report.status, "failed");
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].runs[0].counts.fail, 8);
  assert.equal(report.results[0].successfulInvocationsPerSecond, 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(
    `interruption ${signal} preserves partial evidence and terminates owned test processes`,
    { timeout: 15000 },
    async (t) => {
      if (!capacity(t)) return;
      const f = fixture(
        t,
        "import {writeFileSync} from 'node:fs'; writeFileSync('child-pid', String(process.pid)); test('live', async () => { await new Promise(() => setInterval(() => {},1000)); });",
      );
      const child = spawn(process.execPath, [f.runner, `--output=${f.output}`, "--repeats=1"], {
        cwd: f.root,
        env,
        stdio: "pipe",
      });
      child.stdout.resume();
      child.stderr.resume();
      const closed = once(child, "close");
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      });
      const deadline = Date.now() + 5000;
      while (!existsSync(join(f.root, "child-pid")) && Date.now() < deadline) await setTimeout(20);
      assert.ok(existsSync(join(f.root, "child-pid")));
      const pid = Number(readFileSync(join(f.root, "child-pid"), "utf8"));
      child.kill(signal);
      const [code, observedSignal] = await closed;
      assert.equal(code, null);
      assert.equal(observedSignal, signal);
      const report = JSON.parse(readFileSync(join(f.output, "report.json")));
      assert.equal(report.status, "interrupted");
      assert.equal(report.results[0].remainingOwnedProcesses.length, 0);
      if (existsSync(`/proc/${pid}/stat`)) {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        assert.equal(
          stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0],
          "Z",
          "only an exited child awaiting its external reaper may remain",
        );
      }
    },
  );
}
