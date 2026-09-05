import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";

const CODEX_SHA256 = "fce635028842bfe9257140e8b7d53162732945e2f356fc35225be0702b4974be";
const CODEX_VERSION = "0.153.0";
const BINARY = "/usr/local/bin/codex";
const NATIVE_PORT = 18790;
const STARTUP_MS = 30_000;
const EXCHANGE_MS = 5_000;
const LOG_BYTES = 65_536;
const FRAME_BYTES = 65_536;
const MAX_LIFETIME_MS = 6 * 60 * 60 * 1_000;
// Exact pinned Codex sandboxing/src/bwrap.rs warning. Recognizing this advisory
// does not qualify sandboxed tool execution; this fixture never requests tools.
const MISSING_SYSTEM_BWRAP_WARNING =
  "Codex could not find bubblewrap on PATH. " +
  "Install bubblewrap with your OS package manager. " +
  "See the sandbox prerequisites: " +
  "https://developers.openai.com/codex/concepts/sandboxing#prerequisites. " +
  "Codex will use the bundled bubblewrap in the meantime.";
const FAILURE_CODES = new Set([
  "process_start_time",
  "uid",
  "capabilities",
  "no_new_privileges",
  "fd_limit",
  "core_limit",
  "fd_count",
  "native_zombie",
  "outgoing_frame_size",
  "exchange_timeout",
  "unexpected_http_status",
  "premature_close",
  "incomplete_frame",
  "frame_after_close",
  "invalid_close_frame",
  "unexpected_upgrade",
  "response_bytes",
  "unsupported_frame",
  "frame_length",
  "unexpected_message",
  "invalid_json",
  "initialize_result",
  "duplicate_initialize",
  "native_version",
  "native_home",
  "notification_order",
  "notification_envelope_keys",
  "notification_envelope_params",
  "notification_envelope_timestamp",
  "notification_limit",
  "unexpected_notification",
  "remote_control_status",
  "unexpected_config_warning",
  "platform",
  "expiry_format",
  "expiry_range",
  "ambient_system_configuration",
  "ambient_ancestor_configuration",
  "binary_hash",
  "native_not_live",
  "initialize_and_liveness",
]);
const expiresAt = process.env.OCE_RUN11_EXPIRES_AT;
const deadline = Date.parse(expiresAt ?? "");
const startedAt = new Date().toISOString();
const executionId = randomUUID();

// This is an allowlist, not a filtered copy of the operator's environment.
for (const key of Object.keys(process.env)) delete process.env[key];
process.umask(0o077);

let child;
let nativeClosed = false;
let stopping = false;
let stopCode = 0;
let initialized = false;
let stage = "preflight";
let failureCode;
const initializeNotifications = [];
const initializeNotificationMetadata = [];
let outputBytes = 0;
let initializeCount = 0;
let unauthenticatedStatus;
let wrongTokenStatus;
let responseVersion;
let initializeClosureKind;
let nativeStartTime;
let stateRoot;
let expiryTimer;
let startupTimer;
let monitorTimer;
const sockets = new Set();

function requireCondition(condition, code) {
  if (!condition) throw new Error(code);
}

function procSnapshot(pid) {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  requireCondition(/^\d+$/.test(fields[19] ?? ""), "process_start_time");
  const selectedStatus = {};
  for (const key of [
    "State",
    "Uid",
    "Gid",
    "Threads",
    "CapPrm",
    "CapEff",
    "CapBnd",
    "NoNewPrivs",
  ]) {
    selectedStatus[key] = status.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim();
  }
  return {
    pid,
    startTimeTicks: fields[19],
    status: selectedStatus,
    descriptorCount: readdirSync(`/proc/${pid}/fd`).length,
    limits: readFileSync(`/proc/${pid}/limits`, "utf8"),
  };
}

function requireProcessBounds(snapshot) {
  requireCondition(/^1000\s+1000\s+1000\s+1000$/.test(snapshot.status.Uid ?? ""), "uid");
  for (const key of ["CapPrm", "CapEff", "CapBnd"]) {
    requireCondition(/^0+$/.test(snapshot.status[key] ?? ""), "capabilities");
  }
  requireCondition(snapshot.status.NoNewPrivs === "1", "no_new_privileges");
  requireCondition(/^Max open files\s+256\s+256\s+files\s*$/m.test(snapshot.limits), "fd_limit");
  requireCondition(/^Max core file size\s+0\s+0\s+bytes\s*$/m.test(snapshot.limits), "core_limit");
  requireCondition(snapshot.descriptorCount <= 256, "fd_count");
  requireCondition(!snapshot.status.State?.startsWith("Z"), "native_zombie");
}

function nativeIsLive() {
  if (!child?.pid || nativeClosed || stopping || Date.now() >= deadline) return false;
  try {
    const snapshot = procSnapshot(child.pid);
    requireProcessBounds(snapshot);
    return snapshot.startTimeTicks === nativeStartTime;
  } catch {
    return false;
  }
}

function log(event) {
  // Native payloads, errors, headers and stderr never reach container logs.
  process.stdout.write(`${JSON.stringify({ event, executionId, stage, failureCode })}\n`);
}

function signalNative(signal) {
  if (!child?.pid || nativeClosed) return;
  try {
    // The native child owns a fresh process group. No unrelated process is targeted.
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") stopCode = 1;
  }
}

function stop(code, reason) {
  if (stopping) return;
  stopping = true;
  initialized = false;
  stopCode = code;
  clearTimeout(expiryTimer);
  clearTimeout(startupTimer);
  clearInterval(monitorTimer);
  log(reason);
  server.close();
  for (const socket of sockets) socket.destroy();
  signalNative("SIGTERM");
  if (!child || nativeClosed) process.exit(stopCode);
  setTimeout(() => signalNative("SIGKILL"), 3_000).unref();
  // Missing observed child closure is a failure, including after SIGKILL.
  setTimeout(() => process.exit(1), 5_000).unref();
}

function evidence() {
  return {
    scope: "RUN11 experimental native initialize only",
    executionId,
    startedAt,
    expiresAt,
    binary: { path: BINARY, sha256: CODEX_SHA256, version: CODEX_VERSION },
    initializeCount,
    initializeNotifications,
    initializeNotificationMetadata,
    responseVersion,
    initializeClosureKind,
    unauthenticatedStatus,
    wrongTokenStatus,
    nativeLive: nativeIsLive(),
    launcher: procSnapshot(process.pid),
    native: child?.pid && !nativeClosed ? procSnapshot(child.pid) : null,
    kernel: readFileSync("/proc/version", "utf8").trim(),
    stateRoot,
    childOutputBytes: outputBytes,
    modelCredentials: false,
    threadRequests: 0,
    turnRequests: 0,
    toolRequests: 0,
    // PID/start time/UUID are diagnostics, never a protected identity assertion.
    protectedIdentityProved: false,
  };
}

const server = createServer({ maxHeaderSize: 4_096 }, (req, res) => {
  res.setHeader("Connection", "close");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" || req.headers["transfer-encoding"] || req.headers["content-length"]) {
    res.writeHead(400).end('{"error":"unsupported_request"}\n');
    return;
  }
  if (req.url === "/readyz") {
    const ready = initialized && nativeIsLive();
    res.writeHead(ready ? 200 : 503).end(`${JSON.stringify({ ready })}\n`);
    return;
  }
  if (req.url === "/evidence" && req.socket.remoteAddress === "127.0.0.1") {
    try {
      res.writeHead(200).end(`${JSON.stringify(evidence())}\n`);
    } catch {
      res.writeHead(503).end('{"error":"evidence_unavailable"}\n');
    }
    return;
  }
  res.writeHead(404).end('{"error":"not_found"}\n');
});
server.maxConnections = 8;
server.maxRequestsPerSocket = 1;
server.headersTimeout = 2_000;
server.requestTimeout = 2_000;
server.keepAliveTimeout = 1;
server.setTimeout(2_000, (socket) => socket.destroy());
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
server.on("upgrade", (_req, socket) => socket.destroy());
server.on("clientError", (_error, socket) => socket.destroy());
server.on("error", () => stop(1, "http_failure"));
process.on("SIGTERM", () => stop(0, "termination"));
process.on("SIGINT", () => stop(0, "termination"));
process.on("uncaughtException", () => stop(1, "uncaught_failure"));
process.on("unhandledRejection", () => stop(1, "unhandled_failure"));

function maskedFrame(opcode, payload) {
  requireCondition(payload.length <= 125, "outgoing_frame_size");
  const mask = randomBytes(4);
  const frame = Buffer.alloc(6 + payload.length);
  frame[0] = 0x80 | opcode;
  frame[1] = 0x80 | payload.length;
  mask.copy(frame, 2);
  for (let index = 0; index < payload.length; index++)
    frame[6 + index] = payload[index] ^ mask[index % 4];
  return frame;
}

// Exact HTTP status is observed for denial. The small WebSocket client accepts
// only the pinned server's unfragmented initialize result, its two known
// initialization notifications and bounded ping frames. Unknown work fails closed.
function exchange(token, initialize) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let upgraded;
    let buffer = Buffer.alloc(0);
    let receivedBytes = 0;
    let result;
    let receivedCloseFrame = false;
    let clientCloseRequested = false;
    let transportEofObserved = false;
    let transportErrorObserved = false;
    let remoteControlDisabled = false;
    let missingSystemBwrapObserved = false;
    const key = randomBytes(16).toString("base64");
    const headers = {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": key,
    };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    const req = request({
      hostname: "127.0.0.1",
      port: NATIVE_PORT,
      path: "/",
      method: "GET",
      headers,
      agent: false,
      maxHeaderSize: 4_096,
    });
    const timer = setTimeout(() => finish(new Error("exchange_timeout")), EXCHANGE_MS);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      upgraded?.destroy();
      if (error) reject(error);
      else resolve(value);
    }
    req.once("error", (error) => {
      transportErrorObserved = true;
      finish(error);
    });
    req.once("response", (res) => {
      const status = res.statusCode;
      res.destroy();
      if (initialize || status !== 401) finish(new Error("unexpected_http_status"));
      else finish(undefined, status);
    });
    req.once("upgrade", (res, socket, head) => {
      upgraded = socket;
      sockets.add(socket);
      socket.once("end", () => {
        transportEofObserved = true;
      });
      socket.once("close", () => {
        sockets.delete(socket);
        if (buffer.length !== 0) finish(new Error("incomplete_frame"));
        else if (
          result &&
          remoteControlDisabled &&
          clientCloseRequested &&
          !transportErrorObserved &&
          (receivedCloseFrame || transportEofObserved) &&
          nativeIsLive()
        ) {
          // Pinned native transport can end TCP without flushing a Close reply.
          // EOF establishes only this exchange's closure, not a graceful handshake
          // or termination of the still-live native process.
          finish(undefined, {
            ...result,
            closureKind: receivedCloseFrame ? "peer-close" : "transport-eof",
          });
        } else finish(new Error("premature_close"));
      });
      socket.once("error", (error) => {
        transportErrorObserved = true;
        finish(error);
      });
      const accept = createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      if (
        !initialize ||
        res.statusCode !== 101 ||
        res.headers["sec-websocket-accept"] !== accept ||
        res.headers["sec-websocket-extensions"]
      ) {
        finish(new Error("unexpected_upgrade"));
        return;
      }
      const initializeRequest = Buffer.from(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: { clientInfo: { name: "run11", version: "1" } },
        }),
      );
      initializeCount++;
      socket.write(maskedFrame(1, initializeRequest));
      function consume(data) {
        if (settled) return;
        try {
          requireCondition(!receivedCloseFrame, "frame_after_close");
          receivedBytes += data.length;
          requireCondition(receivedBytes <= FRAME_BYTES, "response_bytes");
          buffer = Buffer.concat([buffer, data]);
          while (buffer.length >= 2) {
            const opcode = buffer[0] & 0x0f;
            requireCondition(
              (buffer[0] & 0xf0) === 0x80 && (buffer[1] & 0x80) === 0,
              "unsupported_frame",
            );
            let length = buffer[1] & 0x7f;
            let offset = 2;
            requireCondition(length !== 127, "frame_length");
            if (opcode >= 8) requireCondition(length <= 125, "frame_length");
            if (length === 126) {
              if (buffer.length < 4) return;
              length = buffer.readUInt16BE(2);
              offset = 4;
            }
            if (buffer.length < offset + length) return;
            const payload = buffer.subarray(offset, offset + length);
            buffer = buffer.subarray(offset + length);
            if (opcode === 9) {
              socket.write(maskedFrame(10, payload));
              continue;
            }
            if (opcode === 8) {
              requireCondition(result && remoteControlDisabled, "premature_close");
              requireCondition(payload.length !== 1, "invalid_close_frame");
              if (payload.length >= 2) {
                // This initialize-only exchange accepts an empty close or normal
                // closure (1000), never an abnormal/reserved status or invalid UTF-8.
                requireCondition(payload.readUInt16BE(0) === 1000, "invalid_close_frame");
                try {
                  new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2));
                } catch {
                  throw new Error("invalid_close_frame");
                }
              }
              requireCondition(buffer.length === 0, "frame_after_close");
              receivedCloseFrame = true;
              // Our close was already sent after disabled remote-control status.
              // The peer acknowledgement completes that handshake; do not send twice.
              socket.end();
              return;
            }
            requireCondition(opcode === 1, "unexpected_message");
            let message;
            try {
              message = JSON.parse(payload.toString("utf8"));
            } catch {
              throw new Error("invalid_json");
            }
            const isRecord = (value) =>
              value !== null && typeof value === "object" && !Array.isArray(value);
            requireCondition(isRecord(message), "unexpected_message");
            if ("method" in message) {
              // Pinned lib.rs queues config warnings and remote-control status
              // after the response. These are notifications, never tool requests.
              requireCondition(result, "notification_order");
              // Native outgoing messages use ServerNotificationEnvelope, whose
              // flattened method/params always include emittedAtMs in this build.
              requireCondition(
                Object.keys(message).length === 3 &&
                  Object.hasOwn(message, "method") &&
                  Object.hasOwn(message, "params") &&
                  Object.hasOwn(message, "emittedAtMs"),
                "notification_envelope_keys",
              );
              requireCondition(isRecord(message.params), "notification_envelope_params");
              requireCondition(
                Number.isSafeInteger(message.emittedAtMs) && message.emittedAtMs >= 0,
                "notification_envelope_timestamp",
              );
              requireCondition(initializeNotifications.length < 2, "notification_limit");
              const params = message.params;
              if (message.method === "remoteControl/status/changed") {
                requireCondition(
                  !remoteControlDisabled &&
                    Object.keys(params).length === 4 &&
                    params.status === "disabled" &&
                    params.environmentId === null &&
                    typeof params.serverName === "string" &&
                    /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(params.serverName) &&
                    typeof params.installationId === "string" &&
                    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
                      params.installationId,
                    ),
                  "remote_control_status",
                );
                remoteControlDisabled = true;
                initializeNotifications.push("remote-control-disabled");
                initializeNotificationMetadata.push({
                  code: "remote-control-disabled",
                  emittedAtMs: message.emittedAtMs,
                });
                // Wait for the native initialization notifications before closing
                // so success cannot depend on TCP chunking or a premature close.
                socket.write(maskedFrame(8, Buffer.alloc(0)));
                clientCloseRequested = true;
                continue;
              }
              if (message.method === "configWarning") {
                requireCondition(
                  !missingSystemBwrapObserved &&
                    Object.keys(params).length === 2 &&
                    params.summary === MISSING_SYSTEM_BWRAP_WARNING &&
                    params.details === null,
                  "unexpected_config_warning",
                );
                missingSystemBwrapObserved = true;
                initializeNotifications.push("codex-system-bwrap-missing");
                initializeNotificationMetadata.push({
                  code: "codex-system-bwrap-missing",
                  emittedAtMs: message.emittedAtMs,
                });
                continue;
              }
              throw new Error("unexpected_notification");
            }
            requireCondition(!result, "duplicate_initialize");
            requireCondition(
              message.id === 1 && !Object.hasOwn(message, "error") && isRecord(message.result),
              "initialize_result",
            );
            requireCondition(
              /^run11\/0\.153\.0 /.test(message.result.userAgent ?? ""),
              "native_version",
            );
            requireCondition(
              message.result.platformOs === "linux" &&
                message.result.codexHome === join(stateRoot, "codex"),
              "native_home",
            );
            result = { userAgent: message.result.userAgent };
            socket.write(maskedFrame(1, Buffer.from('{"method":"initialized"}')));
          }
        } catch (error) {
          finish(error);
        }
      }
      socket.on("data", consume);
      if (head.length) consume(head);
    });
    req.end();
  });
}

async function start() {
  requireCondition(process.platform === "linux" && process.arch === "x64", "platform");
  requireCondition(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(expiresAt ?? ""), "expiry_format");
  requireCondition(
    deadline > Date.now() && deadline - Date.now() <= MAX_LIFETIME_MS,
    "expiry_range",
  );
  requireProcessBounds(procSnapshot(process.pid));
  requireCondition(!existsSync("/etc/codex"), "ambient_system_configuration");
  for (const ancestor of ["/", "/home", "/home/node"]) {
    // Compute legitimately creates /home/node/.codex/generated_images. Reject
    // configuration files without mistaking that supported mount for config.
    for (const relative of [
      ".codex/config.toml",
      ".codex/requirements.toml",
      ".codex/managed_config.toml",
      ".codex/hooks.json",
      ".agents",
      "AGENTS.md",
    ]) {
      requireCondition(!existsSync(join(ancestor, relative)), "ambient_ancestor_configuration");
    }
  }
  expiryTimer = setTimeout(() => stop(0, "expired"), deadline - Date.now());
  startupTimer = setTimeout(() => stop(1, "startup_timeout"), STARTUP_MS);
  stage = "binary_hash";
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(BINARY)) hash.update(chunk);
  requireCondition(hash.digest("hex") === CODEX_SHA256, "binary_hash");
  if (stopping) return;
  stateRoot = mkdtempSync("/home/node/run11-");
  for (const name of ["home", "codex", "workspace", "config", "cache", "data", "runtime", "tmp"])
    mkdirSync(join(stateRoot, name), { mode: 0o700 });
  const configuration = [
    'cli_auth_credentials_store = "file"',
    'chatgpt_base_url = "http://127.0.0.1:9/"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    "allow_login_shell = false",
    "check_for_update_on_startup = false",
    "[analytics]",
    "enabled = false",
    "[feedback]",
    "enabled = false",
    "[otel]",
    'exporter = "none"',
    'trace_exporter = "none"',
    'metrics_exporter = "none"',
    "[skills.bundled]",
    "enabled = false",
    "[features]",
    "plugins = false",
    "recommended_plugins = false",
    "hooks = false",
    "apps = false",
    "enable_mcp_apps = false",
    "remote_control = false",
    "remote_plugin = false",
    "runtime_metrics = false",
    "memories = false",
    "shell_tool = false",
    "shell_snapshot = false",
    "skip_host_skill_discovery = true",
    "",
  ].join("\n");
  writeFileSync(join(stateRoot, "codex", "config.toml"), configuration, {
    flag: "wx",
    mode: 0o400,
  });
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const environment = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: join(stateRoot, "home"),
    CODEX_HOME: join(stateRoot, "codex"),
    XDG_CONFIG_HOME: join(stateRoot, "config"),
    XDG_CACHE_HOME: join(stateRoot, "cache"),
    XDG_DATA_HOME: join(stateRoot, "data"),
    XDG_RUNTIME_DIR: join(stateRoot, "runtime"),
    TMPDIR: join(stateRoot, "tmp"),
    LANG: "C.UTF-8",
    OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
    CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1",
    TOKIO_WORKER_THREADS: "2",
    RAYON_NUM_THREADS: "2",
    RUST_LOG: "error",
  };
  stage = "native_start";
  child = spawn(
    BINARY,
    [
      "app-server",
      "--strict-config",
      "--listen",
      `ws://127.0.0.1:${NATIVE_PORT}`,
      "--ws-auth",
      "capability-token",
      "--ws-token-sha256",
      tokenHash,
    ],
    {
      cwd: join(stateRoot, "workspace"),
      env: environment,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.once("error", () => stop(1, "native_spawn_failure"));
  child.once("exit", () => {
    initialized = false;
    if (!stopping) stop(1, "native_exit");
  });
  child.once("close", () => {
    nativeClosed = true;
    if (stopping) process.exit(stopCode);
    stop(1, "native_closed");
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data) => {
      outputBytes += data.length;
      if (outputBytes > LOG_BYTES) stop(1, "native_output_limit");
    });
  }
  const nativeSnapshot = procSnapshot(child.pid);
  requireProcessBounds(nativeSnapshot);
  nativeStartTime = nativeSnapshot.startTimeTicks;
  stage = "unauthenticated_denial";
  // Retry only ECONNREFUSED while the real listener starts. A timeout or any
  // status other than the server's 401 fails; connection errors are not denial.
  for (let attempt = 0; attempt < 100; attempt++) {
    requireCondition(nativeIsLive(), "native_not_live");
    try {
      unauthenticatedStatus = await exchange(undefined, false);
      break;
    } catch (error) {
      if (error.code !== "ECONNREFUSED" || attempt === 99) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  stage = "wrong_token_denial";
  wrongTokenStatus = await exchange(randomBytes(32).toString("hex"), false);
  stage = "authenticated_initialize";
  const initializeResult = await exchange(token, true);
  responseVersion = initializeResult.userAgent;
  initializeClosureKind = initializeResult.closureKind;
  requireCondition(initializeCount === 1 && nativeIsLive(), "initialize_and_liveness");
  initialized = true;
  clearTimeout(startupTimer);
  stage = "retained";
  monitorTimer = setInterval(() => {
    if (!nativeIsLive()) stop(1, "native_liveness_failure");
  }, 1_000);
  server.listen(8080, "0.0.0.0");
  log("native_initialized");
}

start().catch((error) => {
  failureCode = FAILURE_CODES.has(error?.message) ? error.message : "unclassified_failure";
  stop(1, "startup_failure");
});
