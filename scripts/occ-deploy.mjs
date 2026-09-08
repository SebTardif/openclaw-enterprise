#!/usr/bin/env node
import { constants } from "node:fs";
import { open, mkdir, lstat, link, unlink } from "node:fs/promises";
import { dirname, join, resolve, parse as parsePath } from "node:path";
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import {
  LIFECYCLE_DEPLOY_LIMITS_V2,
  parseLifecycleDeployJsonV2,
  canonicalLifecycleDeployCommandV2,
} from "../packages/contracts/src/lifecycle-deploy-v2.ts";
import { parseLifecycleAdmissionV1 } from "../packages/contracts/src/lifecycle-admission-v1.ts";
import { parseLifecycleObservationResponseV1 } from "../packages/contracts/src/lifecycle-observation-v1.ts";

const LIMIT = LIFECYCLE_DEPLOY_LIMITS_V2.maxJsonBytes;
const fail = () => {
  throw new Error("unavailable");
};
const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

// Retention assumes an operator-controlled local filesystem with working fsync.
// It does not defend against a hostile process running as the same OS user.
async function directory(path) {
  let current = parsePath(path).root;
  // User namespaces may map the filesystem's root owner to a nonzero UID.
  const rootOwner = (await lstat(current)).uid;
  for (const part of path.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (
      !stat.isDirectory() ||
      ![rootOwner, process.getuid()].includes(stat.uid) ||
      (stat.mode & 0o022 && !(stat.mode & 0o1000))
    )
      fail();
  }
  const stat = await lstat(path);
  if (stat.uid !== process.getuid() || stat.mode & 0o077) fail();
}

async function syncDirectory(path) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function privateFile(path, limit = LIMIT) {
  const handle = await open(path, flags);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      stat.mode & 0o077 ||
      stat.nlink !== 1 ||
      stat.size > limit
    )
      fail();
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) fail();
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

// Link publishes a complete fsynced file without replacing an existing name.
// Failed publication leaves evidence in place, including any incomplete marker.
async function publish(path, bytes) {
  const temporary = join(dirname(path), `.pending-${randomUUID()}`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await link(temporary, path);
  await unlink(temporary);
  await syncDirectory(dirname(path));
}

async function markSent(path) {
  const handle = await open(
    join(path, "may-have-sent"),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile("may-have-sent\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path);
}

function origin(input, connection = true) {
  if (typeof input !== "string") fail();
  const url = new URL(input);
  if (
    input !== url.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && (!connection || ["127.0.0.1", "[::1]"].includes(url.hostname))))
  )
    fail();
  return url.origin;
}

function retained(bindingBytes, selectedOrigin, authOrigin) {
  const binding = parseLifecycleDeployJsonV2("binding", bindingBytes);
  const canonical = canonicalLifecycleDeployCommandV2(binding.scope, binding.command);
  // The serializer orders every subtree. Only command is an HTTP body operand.
  const command = JSON.stringify(JSON.parse(canonical).command);
  const { namespaceId, agentId } = binding.scope;
  const base = `/namespaces/${namespaceId}/agents/${agentId}`;
  const target = JSON.stringify({
    origin: selectedOrigin,
    authOrigin,
    deployPath: `${base}/deploy`,
    operationPath: `${base}/lifecycle/operations/${binding.command.operationRef}`,
    binding: canonical,
  });
  return { binding, canonical, command, target };
}

async function prepare(path, input) {
  const selectedOrigin = origin(process.env.OCC_URL);
  const authOrigin = origin(process.env.OCC_AUTH_BASE_URL ?? selectedOrigin, false);
  const value = retained(await privateFile(input), selectedOrigin, authOrigin);
  await directory(dirname(path));
  await mkdir(path, { mode: 0o700 });
  await syncDirectory(dirname(path));
  await publish(join(path, "binding.json"), value.canonical);
  await publish(join(path, "command.json"), value.command);
  await publish(join(path, "target.json"), value.target);
  await publish(join(path, "prepared"), JSON.stringify({ origin: selectedOrigin, authOrigin }));
  return "prepared; no request sent";
}

async function load(path) {
  await directory(path);
  const original = await privateFile(join(path, "binding.json"));
  const targetBytes = await privateFile(join(path, "target.json"), LIMIT * 2);
  const target = JSON.parse(targetBytes.toString("utf8"));
  const value = retained(original, origin(target.origin), origin(target.authOrigin, false));
  if (
    !original.equals(Buffer.from(value.canonical)) ||
    !targetBytes.equals(Buffer.from(value.target)) ||
    !(await privateFile(join(path, "command.json"))).equals(Buffer.from(value.command)) ||
    (await privateFile(join(path, "prepared"))).toString() !==
      JSON.stringify({ origin: target.origin, authOrigin: target.authOrigin }) ||
    (process.env.OCC_URL !== undefined && origin(process.env.OCC_URL) !== target.origin) ||
    (process.env.OCC_AUTH_BASE_URL !== undefined &&
      origin(process.env.OCC_AUTH_BASE_URL, false) !== target.authOrigin)
  )
    fail();
  // Recheck durability before a possible first dispatch, including after restart.
  for (const name of ["binding.json", "command.json", "target.json", "prepared"]) {
    const handle = await open(join(path, name), flags);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await syncDirectory(path);
  await syncDirectory(dirname(path));
  return { ...value, target };
}

async function credentials(target, method) {
  const keyFile = process.env.OCC_SERVICE_KEY_FILE;
  const cookieFile = process.env.OCC_SESSION_COOKIE_JAR;
  if (Boolean(keyFile) === Boolean(cookieFile)) fail();
  if (keyFile) {
    const key = JSON.parse((await privateFile(keyFile)).toString("utf8"))?.data?.key;
    if (typeof key !== "string" || !/^[\x21-\x7e]+$/.test(key)) fail();
    return { "x-api-key": key };
  }
  const url = new URL(target.origin);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const cookies = [];
  // Consume the documented curl Netscape cookie jar without storing or rotating it.
  for (let line of (await privateFile(cookieFile)).toString("utf8").split(/\r?\n/)) {
    if (line.startsWith("#HttpOnly_")) line = line.slice(10);
    else if (!line || line.startsWith("#")) continue;
    const [domain, subdomains, cookiePath, secure, expires, name, value, ...extra] =
      line.split("\t");
    if (
      extra.length ||
      !["TRUE", "FALSE"].includes(subdomains) ||
      !["TRUE", "FALSE"].includes(secure) ||
      !/^\d+$/.test(expires ?? "") ||
      !Number.isSafeInteger(Number(expires))
    )
      fail();
    // The supported session cookie covers '/' and is exact-host; never widen scope.
    if (
      domain !== hostname ||
      subdomains !== "FALSE" ||
      cookiePath !== "/" ||
      (secure === "TRUE" && url.protocol !== "https:") ||
      (Number(expires) !== 0 && Number(expires) * 1000 <= Date.now())
    )
      continue;
    if (!["openclaw_occ.session_token", "__Secure-openclaw_occ.session_token"].includes(name))
      continue;
    if (name.startsWith("__Secure-") && (secure !== "TRUE" || url.protocol !== "https:")) fail();
    if (!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(value ?? "")) fail();
    cookies.push(`${name}=${value}`);
  }
  if (cookies.length !== 1) fail();
  return { cookie: cookies[0], ...(method === "POST" ? { origin: target.authOrigin } : {}) };
}

// Preserve duplicate-key and integer-lexeme rejection before object codecs run.
// JSON.parse alone discards duplicates. The bounded scanner retains object keys;
// JSON.parse remains responsible for the complete JSON grammar.
function responseJson(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  let at = 0,
    nodes = 0;
  const ws = () => {
    while (/[\x20\x09\x0a\x0d]/.test(text[at] ?? "!")) at++;
  };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      const ch = text[at++];
      if (ch === "\\") at++;
      else if (ch === '"') return JSON.parse(text.slice(start, at));
    }
    fail();
  };
  const value = (depth) => {
    if (depth > 20 || ++nodes > 4096) fail();
    ws();
    if (text[at] === '"') return void string();
    if (text[at] === "{" || text[at] === "[") {
      const object = text[at++] === "{";
      const close = object ? "}" : "]";
      const keys = new Set();
      let count = 0;
      ws();
      if (text[at] === close) {
        at++;
        return;
      }
      for (;;) {
        if (++count > 128) fail();
        ws();
        if (object) {
          if (text[at] !== '"') fail();
          const key = string();
          if (keys.has(key)) fail();
          keys.add(key);
          ws();
          if (text[at++] !== ":") fail();
        }
        value(depth + 1);
        ws();
        if (text[at] === close) {
          at++;
          return;
        }
        if (text[at++] !== ",") fail();
      }
    }
    const token = /^(?:true|false|null|0|[1-9][0-9]*)/.exec(text.slice(at));
    if (!token) fail();
    at += token[0].length;
  };
  value(0);
  ws();
  if (at !== text.length) fail();
  return JSON.parse(text);
}

async function request(target, method, headers, body) {
  const url = new URL(method === "POST" ? target.deployPath : target.operationPath, target.origin);
  return new Promise((resolveRequest, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    let response;
    const req = transport.request(url, {
      method,
      agent: false,
      headers: {
        ...headers,
        accept: "application/json",
        ...(method === "POST"
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
          : {}),
      },
    });
    const stop = () => {
      cleanup();
      response?.destroy();
      req.destroy();
      reject(new Error("unavailable"));
    };
    const timer = setTimeout(stop, 30_000);
    const cleanup = () => {
      clearTimeout(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    req.on("error", stop);
    req.on("response", (res) => {
      response = res;
      // Never follow redirects or retain denial/error payloads.
      if (
        res.statusCode !== (method === "POST" ? 202 : 200) ||
        !/^application\/json(?:\s*;|$)/i.test(res.headers["content-type"] ?? "")
      ) {
        stop();
        return;
      }
      let length = 0;
      const chunks = [];
      res.on("data", (chunk) => {
        length += chunk.length;
        if (length > LIMIT) stop();
        else chunks.push(chunk);
      });
      res.on("error", stop);
      res.on("end", () => {
        cleanup();
        if (!res.complete || length > LIMIT) {
          reject(new Error("unavailable"));
          return;
        }
        resolveRequest(Buffer.concat(chunks));
      });
    });
    req.end(method === "POST" ? body : undefined);
  });
}

function result(value, method, bytes) {
  const envelope = responseJson(bytes);
  if (
    !envelope ||
    Object.keys(envelope).sort().join() !== "data,meta" ||
    !envelope.meta ||
    Object.keys(envelope.meta).join() !== "requestId" ||
    typeof envelope.meta.requestId !== "string" ||
    !/^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      envelope.meta.requestId,
    )
  )
    fail();
  let operation;
  if (method === "POST") {
    const receipt = parseLifecycleAdmissionV1("mutationReceipt", envelope.data);
    if (receipt.disposition !== "accepted") fail();
    operation = receipt.operation;
  } else {
    const { namespaceId, agentId } = value.binding.scope;
    operation = parseLifecycleObservationResponseV1(
      "readOperation",
      {
        schemaVersion: 1,
        namespaceId,
        agentId,
        operationRef: value.binding.command.operationRef,
      },
      envelope.data,
    ).operation;
  }
  if (
    operation.kind !== "deploy" ||
    operation.operationRef !== value.binding.command.operationRef ||
    operation.lifecycleGeneration !== (value.binding.command.expectedLifecycleGeneration ?? 0) + 1
  )
    fail();
  // Keep only contract-validated admission/history; observations never imply serving.
  return JSON.stringify({ kind: method === "POST" ? "admission" : "operation-history", operation });
}

async function run() {
  const [action, pathInput, input, ...extra] = process.argv.slice(2);
  if (
    !pathInput ||
    extra.length ||
    !["prepare", "send", "read"].includes(action) ||
    (action === "prepare" ? !input : input !== undefined)
  )
    fail();
  const path = resolve(pathInput);
  if (action === "prepare") return prepare(path, resolve(input));
  const value = await load(path);
  const method = action === "send" ? "POST" : "GET";
  const headers = await credentials(value.target, method);
  if (action === "send") {
    // Never remove this marker: even a pre-connect crash leaves uncertain intent.
    await markSent(path);
  } else {
    // A crash during marker creation may leave it empty. Presence still consumes
    // send permission and permits only an independently authorized read.
    const marker = (await privateFile(join(path, "may-have-sent"))).toString();
    if (!"may-have-sent\n".startsWith(marker)) fail();
  }
  const safe = result(value, method, await request(value.target, method, headers, value.command));
  await publish(
    join(path, `${action === "send" ? "acknowledgement" : `readback-${randomUUID()}`}.json`),
    safe,
  );
  return `${safe}\nAdmission/history only; serving and termination are not established.`;
}

process.umask(0o077);
try {
  console.log(await run());
} catch {
  console.error(
    "Deploy client unavailable or unresolved. Preserve the retained directory; use an authorized exact-operation read. Never resend uncertain intent.",
  );
  process.exitCode = 1;
}
