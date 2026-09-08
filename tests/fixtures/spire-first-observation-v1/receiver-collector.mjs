#!/usr/bin/env node
// Fixture metadata only. This process must run outside the observed workloads.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LIMITS = Object.freeze({
  lineBytes: 16384,
  totalBytes: 1048576,
  frames: 128,
  records: 32,
  outputBytes: 65536,
});
const fail = (code) => {
  throw new Error(code);
};
const positive = (n, max) => Number.isSafeInteger(n) && n > 0 && n <= max;
const dnsLabel = (value) =>
  typeof value === "string" &&
  value.length <= 63 &&
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);
const dnsName = (value) =>
  typeof value === "string" && value.length <= 253 && value.split(".").every(dnsLabel);

// Duplicate JSON keys must not silently change which value is projected. Never
// return parser exception text: even native JSON syntax errors can quote input.
export function parseFrame(bytes) {
  if (bytes.length > LIMITS.lineBytes) fail("frame-limit");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid-json");
  }
  let i = 0;
  const ws = () => {
    while (" \t\r\n".includes(text[i]) && i < text.length) i++;
  };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    fail("invalid-json");
  };
  function value(depth) {
    if (depth > 16) fail("invalid-json");
    ws();
    if (text[i] === '"') return string();
    if (text[i] === "{") {
      i++;
      ws();
      const result = Object.create(null);
      const seen = new Set();
      if (text[i] === "}") {
        i++;
        return result;
      }
      while (i < text.length) {
        ws();
        if (text[i] !== '"') fail("invalid-json");
        const key = string();
        if (seen.has(key)) fail("invalid-json");
        seen.add(key);
        ws();
        if (text[i++] !== ":") fail("invalid-json");
        result[key] = value(depth + 1);
        ws();
        if (text[i] === "}") {
          i++;
          return result;
        }
        if (text[i++] !== ",") fail("invalid-json");
      }
      fail("invalid-json");
    }
    if (text[i] === "[") {
      i++;
      ws();
      const result = [];
      if (text[i] === "]") {
        i++;
        return result;
      }
      while (i < text.length) {
        result.push(value(depth + 1));
        ws();
        if (text[i] === "]") {
          i++;
          return result;
        }
        if (text[i++] !== ",") fail("invalid-json");
      }
      fail("invalid-json");
    }
    const start = i;
    while (i < text.length && !" \t\r\n,]}".includes(text[i])) i++;
    return JSON.parse(text.slice(start, i));
  }
  try {
    const result = value(0);
    ws();
    if (i !== text.length || !result || Array.isArray(result) || typeof result !== "object")
      fail("invalid-json");
    return result;
  } catch {
    fail("invalid-json");
  }
}

export function parseSelectors(text) {
  if (typeof text !== "string") fail("invalid-selectors");
  const parts = text.split(",");
  if (parts.length > 16) fail("selector-limit");
  const fields = Object.create(null);
  const names = {
    "k8s:ns": "namespace",
    "k8s:sa": "serviceAccount",
    "k8s:pod-uid": "podUID",
    "k8s:node-name": "nodeName",
    "k8s:container-name": "containerName",
    "unix:uid": "uid",
    "unix:gid": "gid",
  };
  for (const part of parts) {
    const match = /^(k8s:[a-z-]+|unix:[a-z]+):([^:,\s]+)$/.exec(part);
    if (!match || !Object.hasOwn(names, match[1])) fail("invalid-selectors");
    const name = names[match[1]],
      v = match[2];
    if (Object.hasOwn(fields, name)) fail("duplicate-selector");
    if (name === "uid" || name === "gid") {
      if (!/^(0|[1-9][0-9]{0,9})$/.test(v) || Number(v) > 4294967295) fail("invalid-selectors");
      fields[name] = Number(v);
    } else {
      const valid =
        name === "podUID"
          ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
          : name === "namespace" || name === "containerName"
            ? dnsLabel(v)
            : dnsName(v);
      if (!valid) fail("invalid-selectors");
      fields[name] = v;
    }
  }
  if (Object.keys(fields).length !== 7) fail("missing-selector");
  return { ...fields, provenance: "spire-workload-attestor" };
}

function agentTime(value) {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return null;
  return value;
}

// Unknown ERROR fields are discarded even for selected events; only this closed
// projection crosses the private pipes. No raw text or arbitrary errors escape.
export function projectDenial(frame) {
  if (frame.level !== "error" || typeof frame.msg !== "string") fail("unexpected-log-format");
  if (frame.msg !== "No identity issued") return null;
  if (
    frame.service !== "WorkloadAPI" ||
    frame.method !== "FetchX509SVID" ||
    frame.registered !== false ||
    !positive(frame.pid, 2147483647)
  )
    fail("invalid-denial");
  return {
    event: "receiver-denial",
    receiverPID: frame.pid,
    service: "WorkloadAPI",
    method: "FetchX509SVID",
    registered: false,
    selectors: parseSelectors(frame.selectors),
    acceptedSocketUID: null,
    acceptedSocketGID: null,
    acceptedSocketStartIdentity: null,
    agentTime: agentTime(frame.time),
  };
}

export function createReceiverParser({
  onRecord = () => {},
  clock = () => new Date().toISOString(),
  monotonic = () => performance.now(),
} = {}) {
  const start = monotonic(),
    buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) },
    pids = new Set();
  const counts = { inputBytes: 0, frames: 0, discardedEvents: 0, records: 0, outputBytes: 0 };
  let failure = null;
  function reject(code) {
    failure ??= code;
    buffers.stdout = Buffer.alloc(0);
    buffers.stderr = Buffer.alloc(0);
    fail(failure);
  }
  function frame(bytes) {
    if (++counts.frames > LIMITS.frames) reject("frame-count-limit");
    let record;
    try {
      record = projectDenial(parseFrame(bytes));
    } catch (error) {
      reject(error.message);
    }
    if (!record) {
      counts.discardedEvents++;
      return;
    }
    if (pids.has(record.receiverPID)) reject("duplicate-denial");
    if (counts.records === LIMITS.records) reject("record-limit");
    record = {
      ...record,
      sequence: counts.records + 1,
      collectorTime: clock(),
      collectorMonotonicMs: Math.max(0, monotonic() - start),
    };
    const size = Buffer.byteLength(JSON.stringify(record) + "\n");
    // Reserve space for the fixed-size terminal record; overflow invalidates the
    // observation rather than truncating previously emitted evidence into a pass.
    if (counts.outputBytes + size > LIMITS.outputBytes - 2048) reject("output-limit");
    counts.records++;
    counts.outputBytes += size;
    pids.add(record.receiverPID);
    try {
      onRecord(record);
    } catch {
      reject("output-failed");
    }
  }
  return {
    push(channel, bytes) {
      if (failure) fail(failure);
      if (!Object.hasOwn(buffers, channel) || !Buffer.isBuffer(bytes))
        reject("invalid-input-channel");
      counts.inputBytes += bytes.length;
      if (counts.inputBytes > LIMITS.totalBytes) reject("input-limit");
      let offset = 0;
      while (offset < bytes.length) {
        const newline = bytes.indexOf(10, offset),
          end = newline < 0 ? bytes.length : newline;
        if (buffers[channel].length + end - offset > LIMITS.lineBytes) reject("frame-limit");
        // Copy only the bounded partial frame, not a view retaining a raw chunk.
        buffers[channel] = Buffer.concat([buffers[channel], bytes.subarray(offset, end)]);
        if (newline < 0) break;
        const complete = buffers[channel];
        buffers[channel] = Buffer.alloc(0);
        frame(complete);
        offset = newline + 1;
      }
    },
    finish() {
      if (failure) fail(failure);
      if (buffers.stdout.length || buffers.stderr.length) reject("incomplete-frame");
    },
    snapshot: () => ({ ...counts, failure }),
  };
}

// Exported to test actual process ownership and settlement with the installed
// Node runtime. The SPIRE entry point below fixes argv and verifies both inputs.
export async function collectOwnedChild({
  command,
  args,
  lifetimeMs,
  settleMs = 5000,
  signal,
  onRecord = () => {},
}) {
  if (!positive(lifetimeMs, 1800000) || !positive(settleMs, 10000)) fail("invalid-limits");
  if (signal && !(signal instanceof AbortSignal)) fail("invalid-signal");
  const started = performance.now();
  const parser = createReceiverParser({ onRecord });
  let child,
    closed = false,
    exited = false,
    exitCode = null,
    exitSignal = null,
    spawnFailed = false,
    reason = null;
  let settleTimer, killTimer, lifetimeTimer, resolveDone;
  const done = new Promise((resolveDone_) => {
    resolveDone = resolveDone_;
  });
  function stop(code) {
    reason ??= code;
    if (closed || settleTimer) return;
    try {
      child.kill("SIGTERM");
    } catch {
      /* Outcome comes from close, never kill's return. */
    }
    killTimer = setTimeout(
      () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* Still owned until close. */
        }
      },
      Math.max(1, Math.floor(settleMs / 2)),
    );
    settleTimer = setTimeout(() => resolveDone(), settleMs);
  }
  const abort = () => stop("cancelled");
  try {
    if (signal?.aborted) {
      reason = "cancelled";
      closed = true;
    } else {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
      for (const channel of ["stdout", "stderr"]) {
        child[channel].on("data", (bytes) => {
          if (parser.snapshot().failure) return;
          try {
            parser.push(channel, bytes);
          } catch {
            // Stop consuming raw input immediately on failure; settlement never
            // needs another Agent log frame. TERM/KILL do not rely on pipe drain.
            child.stdout.pause();
            child.stderr.pause();
            stop(parser.snapshot().failure ?? "input-failed");
          }
        });
        child[channel].on("error", () => stop("pipe-failed"));
      }
      child.on("error", () => {
        spawnFailed = true;
        stop("child-error");
      });
      child.on("exit", (code, sig) => {
        exited = true;
        exitCode = code;
        exitSignal = sig;
      });
      child.on("close", (code, sig) => {
        closed = true;
        exitCode = code;
        exitSignal = sig;
        try {
          parser.finish();
        } catch {
          reason = parser.snapshot().failure;
        }
        reason ??= "early-child-exit";
        resolveDone();
      });
      signal?.addEventListener("abort", abort, { once: true });
      lifetimeTimer = setTimeout(() => stop("deadline"), lifetimeMs);
      if (signal?.aborted) abort();
      await done;
    }
  } catch {
    reason ??= "child-error";
    spawnFailed = true;
  } finally {
    clearTimeout(lifetimeTimer);
    clearTimeout(killTimer);
    clearTimeout(settleTimer);
    signal?.removeEventListener("abort", abort);
    // A deadline without close remains custody held. Releasing local handles is
    // not proof that the child or any runtime resource physically terminated.
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    if (!closed) child?.unref();
  }
  return {
    event: "receiver-collector-exit",
    reason,
    failed: reason !== "cancelled" || !closed || spawnFailed,
    childPID: child?.pid ?? null,
    childExitCode: exitCode,
    childSignal: exitSignal,
    childExited: exited,
    pipesClosed: closed,
    settled: closed,
    custodyHeld: !closed && Boolean(child?.pid),
    collectorTime: new Date().toISOString(),
    collectorMonotonicMs: Math.max(0, performance.now() - started),
    ...parser.snapshot(),
  };
}

async function verifyInput(path, expected, maxBytes, capture = false) {
  if (!isAbsolute(path) || !/^[0-9a-f]{64}$/.test(expected)) fail("invalid-input-identity");
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) fail("invalid-input-file");
  const hash = createHash("sha256");
  let bytes = 0;
  const chunks = [];
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > maxBytes) fail("invalid-input-file");
    hash.update(chunk);
    if (capture) chunks.push(chunk);
  }
  if (hash.digest("hex") !== expected) fail("input-hash-mismatch");
  return capture ? Buffer.concat(chunks) : null;
}

export function validateLoggingConfig(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid-log-config");
  }
  // The selected generated HCL profile uses literal fields and paths. Reject
  // escaped identifiers/strings, comments and alternate sinks rather than
  // attempt to infer arbitrary HCL semantics. Its complete bytes are reviewed
  // and pinned separately; this guard is not a general HCL/config validator.
  if (text.includes("\\") || /log_file|logFile|\/\*|\/\/|#/i.test(text)) fail("invalid-log-config");
  if (
    [...text.matchAll(/\blog_level\b/g)].length !== 1 ||
    !/\blog_level\s*=\s*"ERROR"/.test(text) ||
    [...text.matchAll(/\blog_format\b/g)].length !== 1 ||
    !/\blog_format\s*=\s*"JSON"/i.test(text)
  )
    fail("invalid-log-config");
}

export async function runAgent(options) {
  const { binary, binarySHA256, config, configSHA256, lifetimeMs, settleMs, signal, onRecord } =
    options;
  await verifyInput(binary, binarySHA256, 256 * 1024 * 1024);
  validateLoggingConfig(await verifyInput(config, configSHA256, 65536, true));
  // The immutable reviewed HCL config selects ERROR/JSON and omits log_file.
  // Default logger output and stdout are private pipes; no file, shell or tee.
  return collectOwnedChild({
    command: binary,
    args: ["run", "-config", config, "-logLevel", "ERROR", "-logFormat", "JSON"],
    lifetimeMs,
    settleMs,
    signal,
    onRecord,
  });
}

export function parseArgs(argv) {
  const allowed = new Set([
    "--binary",
    "--binary-sha256",
    "--config",
    "--config-sha256",
    "--lifetime-ms",
    "--settle-ms",
  ]);
  const values = Object.create(null);
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || Object.hasOwn(values, argv[i]) || !argv[i + 1])
      fail("invalid-arguments");
    values[argv[i]] = argv[i + 1];
  }
  for (const name of [
    "--binary",
    "--binary-sha256",
    "--config",
    "--config-sha256",
    "--lifetime-ms",
  ])
    if (!values[name]) fail("invalid-arguments");
  const lifetimeMs = Number(values["--lifetime-ms"]),
    settleMs = Number(values["--settle-ms"] ?? 5000);
  if (!positive(lifetimeMs, 1800000) || !positive(settleMs, 10000)) fail("invalid-limits");
  return {
    binary: values["--binary"],
    binarySHA256: values["--binary-sha256"],
    config: values["--config"],
    configSHA256: values["--config-sha256"],
    lifetimeMs,
    settleMs,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGTERM", abort);
  process.on("SIGINT", abort);
  process.stdout.on("error", abort);
  try {
    const result = await runAgent({
      ...parseArgs(process.argv.slice(2)),
      signal: controller.signal,
      onRecord(record) {
        if (!process.stdout.write(JSON.stringify(record) + "\n")) fail("output-failed");
      },
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode = result.failed ? 1 : 0;
  } catch {
    process.stdout.write(
      JSON.stringify({
        event: "receiver-collector-exit",
        reason: "launch-rejected",
        failed: true,
        childPID: null,
        childExitCode: null,
        childSignal: null,
        settled: true,
        custodyHeld: false,
      }) + "\n",
    );
    process.exitCode = 2;
  } finally {
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
  }
}
