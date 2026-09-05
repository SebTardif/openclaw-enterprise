#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPlan,
  connectionURL,
  OwnedDatabases,
  readConfiguration,
  redact,
  suites,
} from "../tests/helpers/postgres-isolated-databases.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage =
  "node scripts/test-postgres-isolated.mjs --config FILE --output NEW_DIRECTORY [--mode serial|parallel] [--suite runtime|channels|both]";

export function childEnvironment(databaseKey, databaseURL) {
  const env = {};
  for (const key of ["PATH", "HOME", "USER", "TMPDIR", "LANG", "LC_ALL", "TZ", "SYSTEMROOT"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  if (databaseKey) env[databaseKey] = databaseURL;
  return env;
}

export function leaseAvailable(config) {
  if (Date.now() >= Date.parse(config.expiresAt) - 60000)
    throw new Error("Resource lease lacks a one-minute cleanup margin.");
}

async function groupMembers(pid) {
  if (!pid) return { live: [], zombies: [] };
  if (process.platform !== "linux") {
    try {
      process.kill(-pid, 0);
      return { live: [pid], zombies: [] };
    } catch (error) {
      if (error.code === "ESRCH") return { live: [], zombies: [] };
      throw error;
    }
  }
  const result = { live: [], zombies: [] };
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const value = await readFile(`/proc/${name}/stat`, "utf8");
      const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pid)
        result[fields[0] === "Z" ? "zombies" : "live"].push(Number(name));
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
    }
  }
  return result;
}

export async function runChild({
  args,
  cwd = root,
  env,
  signal,
  record = () => {},
  label,
  timeoutMs = 120000,
  leaseExpiresAt,
}) {
  signal?.throwIfAborted();
  if (process.platform === "win32")
    throw new Error("The isolated runner requires POSIX process groups.");
  const started = performance.now();
  if (leaseExpiresAt)
    timeoutMs = Math.min(timeoutMs, Date.parse(leaseExpiresAt) - Date.now() - 60000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("No child runtime budget remains before the cleanup reserve.");
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  let length = 0,
    failure,
    escalation;
  const kill = (value) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, value);
    } catch (error) {
      if (error.code !== "ESRCH") failure ??= error;
    }
  };
  const stop = (error) => {
    failure ??= error;
    kill("SIGTERM");
    escalation ??= setTimeout(() => kill("SIGKILL"), 2000);
  };
  const abort = () => stop(new Error("Owned child interrupted."));
  const collect = (chunk) => {
    length += chunk.length;
    if (length > 16 * 1024 * 1024) stop(new Error("Owned child exceeded its output bound."));
    else output.push(chunk);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const timeout = setTimeout(
    () => stop(new Error("Owned child exceeded its deadline.")),
    timeoutMs,
  );
  const result = await new Promise((done) => {
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("spawn", () => {
      try {
        record({ event: "child-start", label, pid: child.pid, args, at: new Date().toISOString() });
      } catch (error) {
        stop(error);
      }
    });
    child.once("exit", () => {
      // A successful wrapper must not leave a test worker or proxy behind.
      try {
        process.kill(-child.pid, 0);
        stop(new Error("Owned process group outlived its leader."));
      } catch (error) {
        if (error.code !== "ESRCH") failure ??= error;
      }
    });
    child.once("close", (code, exitSignal) => done({ code, signal: exitSignal }));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  clearTimeout(timeout);
  clearTimeout(escalation);
  signal?.removeEventListener("abort", abort);
  if (failure) kill("SIGKILL");
  let group = { live: child.pid ? [child.pid] : [], zombies: [] };
  try {
    const until = performance.now() + 5000;
    do {
      group = await groupMembers(child.pid);
      if (!group.live.length) break;
      kill("SIGKILL");
      await delay(25);
    } while (performance.now() < until);
    if (group.live.length)
      failure ??= new Error(
        "Owned process group did not become quiescent; retain resource custody.",
      );
  } catch (error) {
    failure ??= error;
  }
  const outcome = {
    event: "child-exit",
    label,
    pid: child.pid,
    ...result,
    elapsedMs: performance.now() - started,
    at: new Date().toISOString(),
    error: failure?.message,
    quiescent: group.live.length === 0,
    unreapedZombies: group.zombies,
  };
  record(outcome);
  return {
    ...outcome,
    output: Buffer.concat(output).toString("utf8"),
    ok: !failure && result.code === 0 && result.signal === null,
  };
}

export async function runChildren(commands, { concurrency, signal, record, onResult }) {
  if (![1, 2].includes(concurrency)) throw new Error("At most two suite processes are supported.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let next = 0;
  const results = [];
  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, commands.length) }, async () => {
        while (next < commands.length && !controller.signal.aborted) {
          const command = commands[next++];
          try {
            command.beforeStart?.();
            const result = await runChild({ ...command, record, signal: controller.signal });
            results.push(result);
            await onResult?.(result);
            if (!result.ok) controller.abort();
          } catch (error) {
            results.push({ label: command.label, ok: false, error: error.message });
            controller.abort();
          }
        }
      }),
    );
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  if (results.length !== commands.length || results.some((r) => !r.ok))
    throw new AggregateError(
      results
        .filter((r) => !r.ok)
        .map((r) => new Error(`${r.label}: ${r.error ?? `exit ${r.code}, signal ${r.signal}`}`)),
      "Selected child execution failed or was interrupted.",
    );
  return results;
}

export function parseOptions(args) {
  const options = { mode: "serial", suite: "both" };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    if (
      !args[i]?.startsWith("--") ||
      !["config", "output", "mode", "suite"].includes(key) ||
      seen.has(key) ||
      !args[i + 1]
    )
      throw new Error(usage);
    seen.add(key);
    options[key] = args[i + 1];
  }
  if (
    !options.config ||
    !options.output ||
    !["serial", "parallel"].includes(options.mode) ||
    !["runtime", "channels", "both"].includes(options.suite)
  )
    throw new Error(usage);
  return options;
}

export async function runPilot(options, signal) {
  const config = await readConfiguration(options.config);
  leaseAvailable(config);
  const selected = options.suite === "both" ? Object.keys(suites) : [options.suite];
  const plan = createPlan(config, selected);
  const output = resolve(options.output);
  await mkdir(output, { mode: 0o700 });
  // The immutable exact-name manifest is durable before any SQL is issued.
  const manifest = openSync(resolve(output, "manifest.json"), "wx", 0o400);
  try {
    writeSync(manifest, JSON.stringify(plan, null, 2) + "\n");
    fsyncSync(manifest);
  } finally {
    closeSync(manifest);
  }
  const record = (event) => {
    if (event.event === "child-exit" && event.quiescent === false) unquiesced.add(event.pid);
    const path = resolve(output, "events.jsonl");
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", {
      mode: 0o600,
    });
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const unquiesced = new Set();
  const owner = new OwnedDatabases(config, plan, record);
  const summary = {
    schemaVersion: 1,
    mode: options.mode,
    plan,
    startedAt: new Date().toISOString(),
    phases: [],
    suites: [],
    failures: [],
  };
  const phase = async (name, fn) => {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      summary.phases.push({ name, elapsedMs: performance.now() - start });
    }
  };
  try {
    await owner.inspect();
    for (const entry of plan.databases) {
      signal?.throwIfAborted();
      await phase(`setup:${entry.suite}`, () => owner.create(entry));
      signal?.throwIfAborted();
      leaseAvailable(config);
      await phase(`migration:${entry.suite}`, async () => {
        const result = await runChild({
          label: `migration:${entry.suite}`,
          args: ["node_modules/drizzle-kit/bin.cjs", "migrate"],
          env: childEnvironment(
            "OCC_MIGRATION_DATABASE_URL",
            connectionURL(config, "migrator", entry.name),
          ),
          signal,
          record,
          leaseExpiresAt: config.expiresAt,
        });
        await writeFile(
          resolve(output, `${entry.suite}-migration.log`),
          redact(config, result.output),
          { mode: 0o600 },
        );
        if (!result.ok)
          throw new Error(`Migration failed for ${entry.name}: ${result.error ?? result.code}`);
      });
      await owner.seedProbe(entry);
      await owner.verifyProbe(entry);
    }
    await phase("execution", () =>
      runChildren(
        plan.databases.map((entry) => ({
          label: entry.suite,
          args: ["--test", "--test-reporter=tap", suites[entry.suite]],
          env: childEnvironment(
            "OCC_TEST_DATABASE_URL",
            connectionURL(config, "application", entry.name),
          ),
          beforeStart: () => leaseAvailable(config),
          leaseExpiresAt: config.expiresAt,
        })),
        {
          concurrency: options.mode === "parallel" ? 2 : 1,
          signal,
          record,
          onResult: async (result) => {
            await writeFile(resolve(output, `${result.label}.tap`), redact(config, result.output), {
              mode: 0o600,
            });
            const counts = Object.fromEntries(
              ["tests", "pass", "fail", "cancelled", "skipped", "todo"].map((key) => [
                key,
                Number(new RegExp(`^# ${key} (\\d+)$`, "m").exec(result.output)?.[1] ?? NaN),
              ]),
            );
            summary.suites.push({
              suite: result.label,
              sha256: createHash("sha256")
                .update(await readFile(resolve(root, suites[result.label])))
                .digest("hex"),
              elapsedMs: result.elapsedMs,
              code: result.code,
              signal: result.signal,
              counts,
            });
            if (
              !Number.isFinite(counts.tests) ||
              counts.tests < 1 ||
              counts.pass !== counts.tests ||
              counts.fail ||
              counts.cancelled ||
              counts.skipped ||
              counts.todo
            )
              throw new Error(`${result.label} did not complete its full suite without skips.`);
          },
        },
      ),
    );
    const checks = await Promise.all(
      plan.databases.map((entry) => owner.verifyProbe(entry, { requireInstallation: true })),
    );
    if (new Set(checks.flatMap((check) => check.installations)).size !== checks.length)
      throw new Error("Separate databases unexpectedly shared an Installation identity.");
    summary.isolation = checks;
  } catch (error) {
    summary.failures.push(redact(config, error.message));
    for (const nested of error.errors ?? []) summary.failures.push(redact(config, nested.message));
  } finally {
    try {
      if (unquiesced.size)
        throw new Error(
          "Owned child groups remain uncertain; database cleanup retained for custodian.",
        );
      await phase("cleanup", () => owner.cleanup());
      summary.cleanupVerified = true;
    } catch (error) {
      summary.cleanupVerified = false;
      summary.failures.push(redact(config, error.message));
    }
    summary.finishedAt = new Date().toISOString();
    await writeFile(resolve(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  if (summary.failures.length)
    throw new Error(`Isolated PostgreSQL run failed; inspect ${resolve(output, "summary.json")}.`);
  return summary;
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--help") {
    console.log(usage);
    return;
  }
  const options = parseOptions(process.argv.slice(2));
  const controller = new AbortController();
  let interrupted;
  const handlers = ["SIGINT", "SIGTERM"].map((signal) => [
    signal,
    () => {
      interrupted ??= signal;
      controller.abort();
    },
  ]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    const summary = await runPilot(options, controller.signal);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode ||= 1;
  });
