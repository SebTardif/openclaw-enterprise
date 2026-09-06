import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const maxBody = 16384;
const totalLimit = 10000;
const fields = {
  tool: ["tool", "minimumVersion", "module"],
  docker: ["endpoint"],
  http: ["url", "expectedBody"],
  tcp: ["host", "port"],
};
const tools = {
  docker: { args: ["--version"], pattern: /^Docker version (\d+\.\d+\.\d+)/ },
  kubectl: { args: ["version", "--client=true", "-o", "json"], json: true },
  helm: { args: ["version", "--short"], pattern: /^v(\d+\.\d+\.\d+)/ },
  k3d: { args: ["version"], pattern: /^k3d version v(\d+\.\d+\.\d+)/ },
  psql: { args: ["--version"], pattern: /^psql \(PostgreSQL\) (\d+\.\d+(?:\.\d+)?)/ },
};
const common = ["id", "kind", "owner", "action", "timeoutMs"];
const text = (value) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 300 &&
  !/[\x00-\x1f\x7f]/.test(value);
const version = (value) => typeof value === "string" && /^\d+\.\d+(?:\.\d+)?$/.test(value);
const atLeast = (actual, minimum) => {
  const a = actual.split(".").map(Number),
    b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
};
const localHost = (host) => ["127.0.0.1", "::1", "[::1]"].includes(host);
function localUrl(value) {
  if (typeof value !== "string" || value.length > 4096) throw new Error("selection");
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !localHost(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("selection");
  return url;
}
function endpoint(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1
  )
    throw new Error("selection");
  if (
    typeof value.socketPath === "string" &&
    isAbsolute(value.socketPath) &&
    !value.socketPath.includes("\0")
  )
    return { socketPath: value.socketPath };
  const url = localUrl(value.url);
  if (url.pathname !== "/") throw new Error("selection");
  return { hostname: url.hostname.replace(/^\[|\]$/g, ""), port: url.port || 80 };
}
function validate(selection) {
  if (
    !selection ||
    selection.schema !== "oce.development-setup-requirements/v1" ||
    Object.keys(selection).some((key) => !["schema", "requirements", "timeoutMs"].includes(key)) ||
    !Array.isArray(selection.requirements) ||
    !selection.requirements.length ||
    selection.requirements.length > 16
  )
    throw new Error("selection");
  if (
    selection.timeoutMs !== undefined &&
    (!Number.isInteger(selection.timeoutMs) ||
      selection.timeoutMs < 50 ||
      selection.timeoutMs > totalLimit)
  )
    throw new Error("selection");
  const ids = new Set();
  for (const req of selection.requirements) {
    if (
      !req ||
      typeof req.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(req.id) ||
      ids.has(req.id) ||
      !text(req.kind) ||
      !text(req.owner) ||
      !text(req.action) ||
      (req.timeoutMs !== undefined &&
        (!Number.isInteger(req.timeoutMs) || req.timeoutMs < 50 || req.timeoutMs > 2000))
    )
      throw new Error("selection");
    ids.add(req.id);
    if (
      Object.keys(req).some(
        (key) =>
          ![...common, ...(Object.hasOwn(fields, req.kind) ? fields[req.kind] : [])].includes(key),
      )
    )
      throw new Error("selection");
    if (req.kind === "tool") {
      if (req.tool !== "go" && !Object.hasOwn(tools, req.tool)) throw new Error("selection");
      if (req.tool === "go") {
        if (!text(req.module) || isAbsolute(req.module) || req.minimumVersion !== undefined)
          throw new Error("selection");
      } else if (!version(req.minimumVersion) || req.module !== undefined)
        throw new Error("selection");
    }
    if (req.kind === "docker") endpoint(req.endpoint);
    if (req.kind === "http") {
      localUrl(req.url);
      if (
        typeof req.expectedBody !== "string" ||
        !req.expectedBody.length ||
        Buffer.byteLength(req.expectedBody) > maxBody
      )
        throw new Error("selection");
    }
    if (
      req.kind === "tcp" &&
      (!localHost(req.host) || !Number.isInteger(req.port) || req.port < 1 || req.port > 65535)
    )
      throw new Error("selection");
  }
}
function failure(error) {
  const reasons = {
    ENOENT: "missing-path-or-tool",
    EACCES: "permission-denied",
    EPERM: "socket-or-process-permission-denied",
    ECONNREFUSED: "connection-refused",
    ENOTSOCK: "not-a-socket",
    ENOTDIR: "invalid-path",
    ETIMEDOUT: "timeout",
    ECONNRESET: "connection-reset",
    ERR_CHILD_PROCESS_STDIO_MAXBUFFER: "response-too-large",
  };
  return reasons[error.code] ?? (error.killed ? "timeout" : "probe-failed");
}
function httpGet(options, deadline) {
  return new Promise((resolve, reject) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      reject(Object.assign(new Error(), { code: "ETIMEDOUT" }));
      return;
    }
    const req = request(
      {
        ...options,
        method: "GET",
        agent: false,
        headers: { Accept: "application/json, text/plain" },
      },
      (response) => {
        const chunks = [];
        let length = 0;
        response.on("data", (chunk) => {
          length += chunk.length;
          if (length > maxBody) {
            const error = Object.assign(new Error(), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
            reject(error);
            req.destroy(error);
          } else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks) }),
        );
      },
    );
    const timer = setTimeout(
      () => req.destroy(Object.assign(new Error(), { code: "ETIMEDOUT" })),
      remaining,
    );
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end();
  });
}
function transport(req, deadline) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: req.host.replace(/^\[|\]$/g, ""), port: req.port });
    const timer = setTimeout(
      () => socket.destroy(Object.assign(new Error(), { code: "ETIMEDOUT" })),
      Math.max(1, deadline - performance.now()),
    );
    socket.on("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.on("error", reject);
    socket.on("close", () => clearTimeout(timer));
  });
}
function goMetadata(root, req, env) {
  const module = realpathSync(resolve(root, req.module));
  if (relative(root, module).startsWith("..")) throw new Error("selection");
  const modulePath = join(module, "go.mod");
  if (
    relative(root, realpathSync(modulePath)).startsWith("..") ||
    statSync(modulePath).size > 65536
  )
    throw new Error("metadata");
  const moduleBytes = readFileSync(modulePath);
  let minimum = /^go (\d+\.\d+(?:\.\d+)?)\s*$/m.exec(moduleBytes.toString())?.[1];
  if (!minimum) throw new Error("metadata");
  const toolchain = /^toolchain go(\d+\.\d+(?:\.\d+)?)\s*$/m.exec(moduleBytes.toString())?.[1];
  if (
    /^toolchain /m.test(moduleBytes.toString()) &&
    !toolchain &&
    !/^toolchain default\s*$/m.test(moduleBytes.toString())
  )
    throw new Error("unsupported-toolchain-version");
  if (toolchain && !atLeast(minimum, toolchain)) minimum = toolchain;
  let executable;
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, process.platform === "win32" ? "go.exe" : "go");
    try {
      accessSync(candidate, constants.X_OK);
      executable = realpathSync(candidate);
      break;
    } catch {
      /* Keep PATH order without executing a shim. */
    }
  }
  if (!executable) throw Object.assign(new Error(), { code: "ENOENT" });
  const versionPath = join(dirname(dirname(executable)), "VERSION");
  if (statSync(versionPath).size > 1024) throw new Error("metadata");
  const versionBytes = readFileSync(versionPath);
  const observed = /^go(\d+\.\d+(?:\.\d+)?)(?:\r?\n|$)/.exec(versionBytes.toString())?.[1];
  if (!observed || !statSync(executable).isFile() || statSync(executable).size > 134217728)
    throw new Error("metadata");
  const executableBytes = readFileSync(executable);
  const magic = executableBytes.subarray(0, 4).toString("hex");
  if (
    !["7f454c46", "feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(magic) &&
    !magic.startsWith("4d5a")
  )
    throw new Error("unsupported-go-layout");
  // Go commands open telemetry counters before processing even `go version`.
  // Read distribution metadata instead; this is not an executed usability probe.
  return {
    status: atLeast(observed, minimum) ? "ok" : "stale",
    reason: "go-distribution-metadata",
    evidence: {
      level: "installed-toolchain-metadata",
      observedVersion: observed,
      minimumVersion: minimum,
      executableSha256: hash(executableBytes),
      versionFileSha256: hash(versionBytes),
      moduleSha256: hash(moduleBytes),
      usability: "not-executed",
    },
  };
}
async function diagnose(root, req, env, deadline) {
  if (!Object.hasOwn(fields, req.kind))
    return {
      status: "unsupported",
      reason: "selected-readiness-not-implemented",
      evidence: { level: "none", readiness: "unverified" },
    };
  if (req.kind === "tool") {
    if (req.tool === "go") return goMetadata(root, req, env);
    const spec = tools[req.tool];
    const { stdout } = await execute(req.tool, spec.args, {
      cwd: root,
      env,
      timeout: Math.max(1, Math.floor(deadline - performance.now())),
      killSignal: "SIGKILL",
      maxBuffer: maxBody,
    });
    const observed = spec.json
      ? /^v(\d+\.\d+\.\d+)$/.exec(JSON.parse(stdout).clientVersion?.gitVersion)?.[1]
      : spec.pattern.exec(stdout.trim())?.[1];
    if (!observed)
      return {
        status: "incomplete",
        reason: "unrecognized-client-version",
        evidence: { level: "none" },
      };
    return {
      status: atLeast(observed, req.minimumVersion) ? "ok" : "stale",
      reason: "client-version",
      evidence: {
        level: "client-version-only",
        observedVersion: observed,
        minimumVersion: req.minimumVersion,
        serverReadiness: "unverified",
      },
    };
  }
  if (req.kind === "tcp") {
    await transport(req, deadline);
    return {
      status: "incomplete",
      reason: "transport-does-not-establish-readiness",
      evidence: {
        level: "tcp-connection-only",
        service: "unverified",
        authentication: "unverified",
        schema: "unverified",
      },
    };
  }
  const url = req.kind === "http" ? localUrl(req.url) : undefined;
  const options = url
    ? { hostname: url.hostname.replace(/^\[|\]$/g, ""), port: url.port || 80, path: url.pathname }
    : { ...endpoint(req.endpoint), path: "/_ping" };
  const response = await httpGet(options, deadline);
  if (response.status === 401 || response.status === 403)
    return {
      status: "unavailable",
      reason: "authentication-or-authorization-required",
      evidence: { level: "http-status", statusCode: response.status, readiness: "unverified" },
    };
  if (
    response.status !== 200 ||
    !response.body.equals(Buffer.from(req.kind === "http" ? req.expectedBody : "OK"))
  )
    return {
      status: "unavailable",
      reason: "unexpected-http-response",
      evidence: { level: "http-status", statusCode: response.status, readiness: "unverified" },
    };
  if (req.kind === "http")
    return {
      status: "ok",
      reason: "declared-http-contract-matched",
      evidence: {
        level: "exact-http-response-contract",
        statusCode: 200,
        responseSha256: hash(response.body),
        authentication: "unverified",
        schema: "unverified",
        workloads: "unverified",
      },
    };
  const info = await httpGet({ ...endpoint(req.endpoint), path: "/version" }, deadline);
  if (info.status !== 200)
    return {
      status: "unavailable",
      reason: "docker-version-unavailable",
      evidence: { level: "docker-ping-only", statusCode: info.status, workloads: "unverified" },
    };
  let data;
  try {
    data = JSON.parse(info.body);
  } catch {
    return {
      status: "incomplete",
      reason: "invalid-docker-version-response",
      evidence: { level: "docker-ping-only" },
    };
  }
  if (!version(data.Version) || !version(data.ApiVersion))
    return {
      status: "incomplete",
      reason: "invalid-docker-version-response",
      evidence: { level: "docker-ping-only" },
    };
  return {
    status: "ok",
    reason: "docker-api-responses-matched",
    evidence: {
      level: "docker-api-ping-and-version",
      version: data.Version,
      apiVersion: data.ApiVersion,
      authorization: "not-tested",
      workloads: "unverified",
    },
  };
}

export async function checkSelectedRequirements(root, selection, { env = process.env } = {}) {
  const start = performance.now();
  let checks;
  let validSelection = false;
  try {
    validate(selection);
    root = realpathSync(root);
    validSelection = true;
  } catch {
    checks = [
      {
        id: "requirements-selection",
        status: "incomplete",
        reason: "invalid-selection",
        owner: "selection owner",
        action:
          "Provide a valid explicit requirement list with unique IDs, owner, setup action and supported target fields; no probes were run.",
        evidence: { level: "none" },
      },
    ];
  }
  if (!checks) {
    checks = [];
    for (const req of selection.requirements) {
      const before = performance.now();
      let result;
      if (before - start >= (selection.timeoutMs ?? totalLimit))
        result = {
          status: "unavailable",
          reason: "total-deadline-exhausted",
          evidence: { level: "none" },
        };
      else {
        try {
          result = await diagnose(
            root,
            req,
            env,
            Math.min(start + (selection.timeoutMs ?? totalLimit), before + (req.timeoutMs ?? 1500)),
          );
        } catch (error) {
          result = {
            status: "unavailable",
            reason: failure(error),
            evidence: { level: "none", readiness: "unverified" },
          };
        }
      }
      checks.push({
        id: req.id,
        kind: req.kind,
        owner: req.owner,
        action: req.action,
        ...result,
        durationMs: Math.round(performance.now() - before),
      });
    }
  }
  return {
    schema: "oce.development-setup-requirements-result/v1",
    ...(validSelection ? { selectionSha256: hash(JSON.stringify(selection)) } : {}),
    status: checks.every((check) => check.status === "ok") ? "prepared" : "unprepared",
    durationMs: Math.round(performance.now() - start),
    checks,
    scope:
      "Only explicitly selected metadata, client versions and protocol contracts; no database authentication/schema, cluster or workload acceptance.",
  };
}
