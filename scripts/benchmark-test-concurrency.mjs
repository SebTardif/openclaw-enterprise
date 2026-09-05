#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const files = [
  "contracts",
  "occ-read",
  "kubernetes-compute",
  "configuration-occ",
  "secret-occ",
  "iam",
  "workspace-files",
  "occ-api-security",
]
  .map((name) => `tests/conformance/${name}.test.mjs`)
  .sort();
const ownedSource = [
  "scripts/benchmark-test-concurrency.mjs",
  "tests/conformance/benchmark-test-concurrency.test.mjs",
  "docs/testing/test-concurrency.md",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path, data) =>
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });

function host() {
  const memory = readFileSync("/proc/meminfo", "utf8");
  const cpu = readFileSync("/proc/stat", "utf8")
    .split("\n")[0]
    .trim()
    .split(/\s+/)
    .slice(1, 9)
    .map(Number);
  return {
    at: new Date().toISOString(),
    load: loadavg(),
    memAvailableBytes: Number(/^MemAvailable:\s+(\d+)/m.exec(memory)?.[1]) * 1024,
    cpuTicks: { total: cpu.reduce((a, b) => a + b, 0), idle: cpu[3] + cpu[4] },
  };
}

function members(groups) {
  const found = [];
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const group = Number(fields[2]);
      if (!groups.includes(group) || fields[0] === "Z") continue;
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      found.push({
        pid: Number(pid),
        startTimeTicks: fields[19],
        group,
        rssBytes: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024,
      });
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
    }
  }
  return found;
}

function sourceIdentity() {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const names = [
    ...new Set([...tracked, ...ownedSource.filter((path) => existsSync(resolve(root, path)))]),
  ].sort();
  const content = createHash("sha256");
  for (const name of names)
    content.update(`${name}\0${digest(readFileSync(resolve(root, name)))}\0`);
  const dependencies = {};
  for (const path of [
    "pnpm-lock.yaml",
    "node_modules/.pnpm/lock.yaml",
    ".build/upstream-sdk/preparation.json",
  ])
    dependencies[path] = existsSync(resolve(root, path))
      ? digest(readFileSync(resolve(root, path)))
      : null;
  return {
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    trackedAndToolContentSha256: content.digest("hex"),
    dependencies,
    manifest: files.map((path) => ({ path, sha256: digest(readFileSync(resolve(root, path))) })),
  };
}

function outcomes(log) {
  const counts = {};
  for (const name of ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"]) {
    const values = [...log.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gm"))];
    counts[name] = values.length === 1 ? Number(values[0][1]) : null;
  }
  // Retain full TAP privately; compare every reported case name/outcome, not
  // only counts. Sorting accommodates file scheduling without dropping names.
  const cases = log
    .split("\n")
    .filter((line) => /^\s*(?:not )?ok \d+ - /.test(line))
    .map((line) => line.trim().replace(/^(not )?ok \d+ - /, "$1ok - "))
    .sort();
  return {
    counts,
    cases,
    caseOutcomesSha256: digest(JSON.stringify(cases)),
    completeSummary: Object.values(counts).every((value) => value !== null),
  };
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function drainGroups(children) {
  const groups = children.map((child) => child.pid).filter(Number.isInteger);
  // GNU time can close before its descendants. Wait for only our owned groups.
  const deadline = performance.now() + 5000;
  while (members(groups).length && performance.now() < deadline) await delay(25);
  const cleanupEscalated = members(groups).length > 0;
  if (cleanupEscalated) {
    for (const group of groups) signalGroup(group, "SIGKILL");
    const killedDeadline = performance.now() + 1000;
    while (members(groups).length && performance.now() < killedDeadline) await delay(25);
  }
  return { cleanupEscalated, remainingOwnedProcesses: members(groups) };
}

function finalizeRun(run, output) {
  let resources = null;
  try {
    const line = readFileSync(resolve(output, run.resourceLog), "utf8")
      .split("\n")
      .find((item) => item.startsWith("{"));
    resources = JSON.parse(line);
  } catch {}
  try {
    // Snapshot after owned writers have drained. Escaped writers may still
    // change the live log, but never hold this new snapshot's descriptor.
    const bytes = readFileSync(resolve(output, run.liveLog));
    writeFileSync(resolve(output, run.log), bytes, { flag: "wx", mode: 0o400 });
    return {
      ...run,
      resources,
      logSha256: digest(bytes),
      ...outcomes(bytes.toString("utf8")),
      evidenceError: null,
    };
  } catch (error) {
    return { ...run, resources, logSha256: null, ...outcomes(""), evidenceError: error.message };
  }
}

async function configuration({ output, index, concurrency, groups, signal }) {
  const before = host();
  if (!Number.isFinite(before.memAvailableBytes) || before.memAvailableBytes < 8 * 1024 ** 3)
    throw new Error(
      "Capacity pause: MemAvailable must be at least 8 GiB before a configuration. No new tests started.",
    );
  const start = performance.now();
  const children = [];
  const records = [];
  const samples = [];
  const stop = () => {
    for (const child of children)
      if (Number.isInteger(child.pid)) signalGroup(child.pid, "SIGTERM");
  };
  signal.addEventListener("abort", stop, { once: true });
  let sampler, samplingError, configurationError, cleanupError, closed, cleanup;
  const sample = () => {
    const processes = members(children.map((child) => child.pid));
    samples.push({
      elapsedSeconds: (performance.now() - start) / 1000,
      ...host(),
      processes,
      sumRssBytes: processes.reduce((sum, item) => sum + item.rssBytes, 0),
    });
  };
  try {
    for (let group = 0; group < groups && !signal.aborted; group++) {
      const prefix = `${index}-g${group}`;
      const liveLog = `${prefix}.live.tap`;
      const resourceLog = `${prefix}.resource.json`;
      const fd = openSync(resolve(output, liveLog), "wx", 0o600);
      const argv = [
        "scripts/test-files.mjs",
        `--test-concurrency=${concurrency}`,
        "--test-reporter=tap",
        "--",
        ...files,
      ];
      const launched = performance.now();
      // GNU time reports reaped child CPU and process high-water RSS, not the
      // sum of all processes' simultaneous memory use.
      let child;
      try {
        child = spawn(
          "/usr/bin/time",
          [
            "-f",
            '{"userSeconds":%U,"systemSeconds":%S,"maxProcessRssKiB":%M}',
            "-o",
            resolve(output, resourceLog),
            process.execPath,
            ...argv,
          ],
          { cwd: root, detached: true, stdio: ["ignore", fd, fd] },
        );
      } finally {
        closeSync(fd);
      }
      children.push(child);
      records.push(
        new Promise((resolveRecord) => {
          let spawnError;
          child.once("error", (error) => {
            spawnError = error.message;
          });
          // Do no filesystem work in event callbacks: close is timing/status,
          // while evidence finalization follows bounded group cleanup below.
          child.once("close", (exitCode, childSignal) =>
            resolveRecord({
              group,
              pid: child.pid,
              argv: [process.execPath, ...argv],
              launchedAfterSeconds: (launched - start) / 1000,
              wallSeconds: (performance.now() - launched) / 1000,
              exitCode,
              signal: childSignal,
              spawnError: spawnError ?? null,
              liveLog,
              log: `${prefix}.tap`,
              resourceLog,
            }),
          );
        }),
      );
    }
    sample();
    sampler = setInterval(() => {
      try {
        sample();
      } catch (error) {
        samplingError = error.message;
        clearInterval(sampler);
        stop();
      }
    }, 100);
    await Promise.all(records);
  } catch (error) {
    configurationError = error.message;
    stop();
  } finally {
    clearInterval(sampler);
    if (configurationError || signal.aborted) stop();
    closed = await Promise.all(records);
    try {
      cleanup = await drainGroups(children);
    } catch (error) {
      // Preserve the original failure as well as unavailable cleanup evidence.
      cleanupError = error.message;
      for (const child of children)
        if (Number.isInteger(child.pid)) signalGroup(child.pid, "SIGKILL");
      cleanup = { cleanupEscalated: true, remainingOwnedProcesses: null };
    }
    signal.removeEventListener("abort", stop);
  }
  const runs = closed.map((run) => finalizeRun(run, output));
  try {
    sample();
  } catch (error) {
    samplingError ??= error.message;
  }
  const wallSeconds = (performance.now() - start) / 1000;
  const after = host();
  const successful = runs.filter(
    (run) =>
      run.exitCode === 0 &&
      run.completeSummary &&
      run.counts.fail === 0 &&
      run.counts.cancelled === 0 &&
      !run.evidenceError,
  );
  const result = {
    index,
    concurrency,
    groups,
    before,
    after,
    wallSeconds,
    runs,
    samples,
    samplingError: samplingError ?? null,
    configurationError: configurationError ?? null,
    cleanupError: cleanupError ?? null,
    ...cleanup,
    sampledPeakSumRssBytes: Math.max(0, ...samples.map((entry) => entry.sumRssBytes)),
    hostBusyFraction:
      1 -
      (after.cpuTicks.idle - before.cpuTicks.idle) / (after.cpuTicks.total - before.cpuTicks.total),
    successfulInvocationsPerSecond: successful.length / wallSeconds,
    passedTestsPerSecond: successful.reduce((sum, run) => sum + run.counts.pass, 0) / wallSeconds,
  };
  json(resolve(output, `configuration-${index}.json`), result);
  return result;
}

async function main(args) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Usage: node scripts/benchmark-test-concurrency.mjs --output=/new/private/directory [--repeats=1|2|3]\nFixed eight local suites; concurrency 1/2/4, one/two groups; default two balanced repeats. Linux /proc and GNU time required. Coordinate host capacity before running.",
    );
    return;
  }
  let output,
    repeats = 2;
  const seen = new Set();
  for (const arg of args) {
    const match = /^--(output|repeats)=(.+)$/.exec(arg);
    if (!match || seen.has(match[1])) throw new Error(`Unsupported or repeated option: ${arg}`);
    seen.add(match[1]);
    if (match[1] === "output") output = resolve(match[2]);
    else {
      if (!/^[123]$/.test(match[2])) throw new Error("Repeats must be 1, 2 or 3.");
      repeats = Number(match[2]);
    }
  }
  if (!output || process.platform !== "linux")
    throw new Error("A new --output directory and Linux are required.");
  const physicalOutput = resolve(realpathSync(dirname(output)), output.split("/").at(-1));
  const relativeOutput = relative(realpathSync(root), physicalOutput);
  if (!relativeOutput.startsWith("../"))
    throw new Error("Store benchmark evidence outside the product repository.");
  if (existsSync(output))
    throw new Error("Output directory already exists; preserve prior evidence.");
  for (const file of files)
    if (!readFileSync(resolve(root, file)).length)
      throw new Error(`Empty selected test file: ${file}`);
  execFileSync("/usr/bin/time", ["--version"], { stdio: "ignore" });
  const identity = sourceIdentity();
  const controller = new AbortController();
  let interrupted;
  const interrupt = (signal) => {
    interrupted ??= signal;
    controller.abort();
  };
  const handlers = ["SIGINT", "SIGTERM"].map((signal) => [signal, () => interrupt(signal)]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  mkdirSync(output, { mode: 0o700 });
  const configurations = [1, 2].flatMap((groups) =>
    [1, 2, 4].map((concurrency) => ({ groups, concurrency })),
  );
  const order = Array.from({ length: repeats }, (_, repeat) =>
    (repeat % 2 ? [...configurations].reverse() : configurations).map((entry) => ({
      ...entry,
      repeat,
    })),
  ).flat();
  const report = {
    schema: "test-concurrency/v1",
    node: process.version,
    logicalCpuCapacity: availableParallelism(),
    identity,
    order,
    results: [],
    status: "running",
    limitations: [
      "Two or three repeats are descriptive, not statistical significance.",
      "Dependency receipts and installed lock are identities, not a hash of every installed dependency byte.",
      "RSS samples can miss short peaks and double-count shared pages; GNU time max RSS is a process high-water mark.",
      "GNU time CPU covers its waited process hierarchy; detached descendants that escape it are not measured.",
      "Other host workloads remain uncontrolled; this benchmark does not change caps or provide fair admission.",
    ],
  };
  json(resolve(output, "report.json"), report);
  try {
    for (const [index, entry] of order.entries()) {
      if (controller.signal.aborted) break;
      if (JSON.stringify(sourceIdentity()) !== JSON.stringify(identity))
        throw new Error("Source/dependency identities changed; matrix stopped.");
      console.error(
        `Configuration ${index + 1}/${order.length}: ${entry.groups} group(s), file concurrency ${entry.concurrency}`,
      );
      const result = await configuration({ output, index, ...entry, signal: controller.signal });
      report.results.push(result);
      json(resolve(output, "report.json"), report);
      if (
        result.samplingError ||
        result.configurationError ||
        result.cleanupError ||
        result.cleanupEscalated ||
        result.runs.length !== entry.groups ||
        result.remainingOwnedProcesses.length ||
        result.runs.some(
          (run) =>
            run.exitCode !== 0 ||
            !run.resources ||
            run.evidenceError ||
            !run.completeSummary ||
            run.counts.fail ||
            run.counts.cancelled,
        )
      )
        throw new Error(
          "A test invocation failed, was interrupted, or left an owned process; retain partial evidence.",
        );
      const reference = report.results[0].runs[0];
      if (
        result.runs.some(
          (run) =>
            JSON.stringify(run.counts) !== JSON.stringify(reference.counts) ||
            run.caseOutcomesSha256 !== reference.caseOutcomesSha256,
        )
      )
        throw new Error(
          "Discovered test names/outcomes changed between invocations; comparison is invalid.",
        );
    }
    if (JSON.stringify(sourceIdentity()) !== JSON.stringify(identity))
      throw new Error("Source/dependency identities changed during measurement.");
    report.status = controller.signal.aborted ? "interrupted" : "complete";
  } catch (error) {
    report.status = interrupted ? "interrupted" : "failed";
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    json(resolve(output, "report.json"), report);
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    if (interrupted) process.once("beforeExit", () => process.kill(process.pid, interrupted));
  }
  console.error(`Benchmark ${report.status}; evidence: ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
