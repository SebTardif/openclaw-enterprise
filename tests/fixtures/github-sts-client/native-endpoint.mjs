/** Test-only constructors, controlled loopback transport, and Node process probes.
 * None of these objects is production authority or evidence of GitHub permissions.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { Socket, connect } from "node:net";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createReadStream, fstatSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SELECTED_NATIVE_TOOLS,
  nativeEnvironment,
} from "../../../packages/github-sts/src/client-mechanics.ts";

export const fixtureRepository = Object.freeze({
  id: 1234,
  owner: "fixture",
  name: "mirror",
  commit: "1".repeat(40),
  base: "main",
  branch: "oce-demo/fixture-change",
  issue: 7,
  pull: 9,
});
export function syntheticAttempt(label = "A", now = Date.now()) {
  return {
    schemaVersion: 1,
    scope: {
      installationId: "ins_00000000-0000-4000-8000-000000000001",
      namespaceId: "ns_00000000-0000-4000-8000-000000000002",
      agentId: "agt_00000000-0000-4000-8000-000000000003",
    },
    assignmentRef: { schemaVersion: 1, id: "00000000-0000-4000-8000-000000000004" },
    revisionId: "rev_00000000-0000-4000-8000-000000000005",
    lifecycleGeneration: 1,
    runtimeGeneration: 1,
    reservationRef: "reservation/fixture",
    intentDigest: `sha256:${"a".repeat(64)}`,
    conversationRef: "conversation/fixture",
    workspaceRef: "workspace/fixture",
    originalPrincipalRef: "principal/fixture",
    externalIdentity: { ref: "identity/fixture", version: 1, digest: `sha256:${"a".repeat(64)}` },
    receiptRef: "receipt/fixture",
    logicalMessageRef: "message/fixture",
    messageContentDigest: `sha256:${"a".repeat(64)}`,
    commonGrant: { ref: "grant/fixture", version: 1, digest: `sha256:${"a".repeat(64)}` },
    route: { ref: "route/fixture", version: 1, digest: `sha256:${"a".repeat(64)}` },
    audience: { ref: "audience/fixture", version: 1, digest: `sha256:${"a".repeat(64)}` },
    policy: { ref: "policy/fixture", version: 1, digest: `sha256:${"a".repeat(64)}` },
    attemptRef: `attempt/${label}`,
    turnRef: `turn/${label}`,
    canonicalBindingDigest: `sha256:${createHash("sha256").update(label).digest("hex")}`,
    committedDispatchAt: new Date(now).toISOString(),
    turnNotAfter: new Date(now + 600_000).toISOString(),
  };
}
export function syntheticRelease(original, suffix = "", expiry = Date.now() + 60_000) {
  return Object.freeze({
    attemptRef: original.attemptRef,
    canonicalBindingDigest: original.canonicalBindingDigest,
    token: `synthetic.${randomBytes(32).toString("base64url")}.${suffix}`,
    expiresAt: new Date(expiry).toISOString(),
  });
}
export function syntheticDelivery(next) {
  const requests = [];
  const erased = [];
  return {
    requests,
    erased,
    async withCurrentToken(request, release, signal) {
      requests.push(request);
      const token = await next(request, signal);
      if (token === undefined) throw new Error("Synthetic fixture denies delivery.");
      release(token);
    },
    async invalidateRuntimeReuse(request) {
      erased.push(request);
    },
  };
}

/** Local fixtures deliberately support only bounded repository/issue/PR protocol
 * shapes. Git smart HTTP additionally needs an explicitly selected binary + bare
 * fixture directory; those inputs are absent in the pure mechanics suite.
 */
export async function startNativeEndpoint({ releases, gitExecutable, bareRepositoryRoot } = {}) {
  if (
    !Array.isArray(releases) ||
    releases.length < 1 ||
    releases.length > 8 ||
    releases.some((value) => !value.token.startsWith("synthetic."))
  )
    throw new Error("Synthetic fixture input required.");
  if (
    (gitExecutable === undefined) !== (bareRepositoryRoot === undefined) ||
    (gitExecutable !== undefined && (!isAbsolute(gitExecutable) || !isAbsolute(bareRepositoryRoot)))
  )
    throw new Error("Explicit local Git fixture required.");
  const observations = [];
  let creates = 0;
  const name = `${fixtureRepository.owner}/${fixtureRepository.name}`;
  const issue = {
    number: 7,
    title: "Synthetic issue",
    state: "OPEN",
    url: `https://github.com/${name}/issues/7`,
    body: "Fixture body",
    __typename: "Issue",
  };
  const pull = {
    number: 9,
    title: "Synthetic draft",
    state: "OPEN",
    url: `https://github.com/${name}/pull/9`,
    isDraft: true,
    baseRefName: "main",
    headRefName: fixtureRepository.branch,
    __typename: "PullRequest",
  };
  const repo = {
    id: "R_fixture",
    name: "mirror",
    nameWithOwner: name,
    owner: { login: "fixture" },
    isPrivate: true,
    url: `https://github.com/${name}`,
    defaultBranchRef: { name: "main" },
    hasIssuesEnabled: true,
    viewerPermission: "WRITE",
  };
  const server = createServer(async (request, response) => {
    const auth = request.headers.authorization ?? "";
    let token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (auth.startsWith("Basic ")) {
      const decoded = Buffer.from(auth.slice(6), "base64").toString();
      if (decoded.startsWith("x-access-token:")) token = decoded.slice(15);
    }
    const index = releases.findIndex(
      (entry) => entry.token === token && Date.parse(entry.expiresAt) > Date.now(),
    );
    const path = new URL(request.url, "http://127.0.0.1");
    observations.push({
      method: request.method,
      path: path.pathname,
      tokenOrdinal: index,
      apiVersion: request.headers["x-github-api-version"] ?? null,
    });
    function json(status, data) {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(data));
    }
    if (observations.length > 100) {
      json(429, { message: "Fixture request bound exceeded" });
      return;
    }
    if (index < 0) {
      response.setHeader("WWW-Authenticate", "Basic realm=fixture");
      json(401, { message: "Synthetic credential rejected" });
      return;
    }
    const bodyChunks = [];
    let bodyBytes = 0;
    for await (const chunk of request) {
      bodyChunks.push(chunk);
      bodyBytes += chunk.length;
      if (bodyBytes > 64 * 1024) {
        json(413, { message: "Fixture request bound exceeded" });
        return;
      }
    }
    const body = Buffer.concat(bodyChunks);
    if (path.pathname.startsWith(`/${name}.git/`)) {
      if (gitExecutable === undefined) {
        json(503, { message: "Selected Git backend unrun" });
        return;
      }
      const child = spawn(gitExecutable, ["http-backend"], {
        env: {
          PATH: "/usr/bin:/bin",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_PROJECT_ROOT: bareRepositoryRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          REMOTE_USER: "synthetic",
          REQUEST_METHOD: request.method,
          PATH_INFO: path.pathname,
          QUERY_STRING: path.search.slice(1),
          CONTENT_TYPE: request.headers["content-type"] ?? "",
        },
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 3000,
      });
      const chunks = [];
      let bytes = 0;
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) child.kill("SIGKILL");
        else chunks.push(chunk);
      });
      child.on("error", () => json(503, { message: "Selected Git backend unavailable" }));
      child.on("close", (code) => {
        if (response.writableEnded) return;
        const result = Buffer.concat(chunks);
        const boundary = result.indexOf("\r\n\r\n");
        if (code !== 0 || boundary < 0 || bytes > 1024 * 1024) {
          json(503, { message: "Git fixture incomplete" });
          return;
        }
        for (const line of result.subarray(0, boundary).toString().split("\r\n")) {
          const colon = line.indexOf(":");
          if (colon < 1) continue;
          if (line.slice(0, colon).toLowerCase() === "status")
            response.statusCode = Number(
              line
                .slice(colon + 1)
                .trim()
                .split(" ")[0],
            );
          else response.setHeader(line.slice(0, colon), line.slice(colon + 1).trim());
        }
        response.end(result.subarray(boundary + 4));
      });
      child.stdin.end(body);
      return;
    }
    if (request.method === "GET" && path.pathname === `/repos/${name}`) {
      json(200, { id: 1234, full_name: name, private: true, default_branch: "main" });
      return;
    }
    if (
      request.method === "GET" &&
      path.pathname === `/repos/${name}/commits/${fixtureRepository.commit}`
    ) {
      json(200, { sha: fixtureRepository.commit });
      return;
    }
    if (request.method === "GET" && path.pathname === `/repos/${name}/issues`) {
      json(200, [{ ...issue, state: "open" }]);
      return;
    }
    if (request.method === "GET" && path.pathname === `/repos/${name}/pulls`) {
      json(200, [{ ...pull, state: "open", draft: true }]);
      return;
    }
    if (request.method === "POST" && path.pathname === "/graphql") {
      let query;
      try {
        query = JSON.parse(body.toString("utf8")).query;
      } catch {
        json(400, { message: "Invalid fixture JSON" });
        return;
      }
      if (typeof query !== "string") {
        json(400, { message: "Missing fixture query" });
        return;
      }
      if (/createPullRequest/.test(query)) {
        creates += 1;
        if (request.headers["x-fixture-drop-ack"] === "1") {
          request.socket.destroy();
          return;
        }
        json(200, { data: { createPullRequest: { pullRequest: pull } } });
        return;
      }
      json(200, {
        data: {
          repository: {
            ...repo,
            issue,
            pullRequest: pull,
            issues: {
              totalCount: 1,
              nodes: [issue],
              edges: [{ node: issue }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            pullRequests: {
              totalCount: 1,
              nodes: [pull],
              edges: [{ node: pull }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
          viewer: { login: "fixture" },
        },
      });
      return;
    }
    json(404, { message: "Outside bounded fixture protocol" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    observations,
    get creates() {
      return creates;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Explicit native selection. Reading this module never prepares tools or runs a
 * native executable. A partial opt-in fails rather than silently skipping. */
export async function selectedNativeConfiguration(environment = process.env) {
  const enabled = environment.OCE_NATIVE_QUALIFICATION;
  const manifest = environment.OCE_NATIVE_QUALIFICATION_FILE;
  if (enabled === undefined && manifest === undefined) return undefined;
  if (enabled !== "1" || typeof manifest !== "string" || !isAbsolute(manifest))
    throw new Error("Native qualification requires explicit opt-in and an absolute manifest.");
  const metadata = await lstat(manifest);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384)
    throw new Error("Invalid selected native manifest.");
  const config = JSON.parse(await readFile(manifest, "utf8"));
  if (
    config.schemaVersion !== 1 ||
    config.execution !== "local-synthetic-only" ||
    config.platform !== process.platform ||
    config.arch !== process.arch ||
    process.platform !== "linux" ||
    !isAbsolute(config.scratchParent ?? "") ||
    !isAbsolute(config.gitExecPath ?? "") ||
    config.git?.version !== SELECTED_NATIVE_TOOLS.git.version ||
    config.git?.commit !== SELECTED_NATIVE_TOOLS.git.commit ||
    config.gh?.version !== SELECTED_NATIVE_TOOLS.gh.version ||
    config.gh?.commit !== SELECTED_NATIVE_TOOLS.gh.commit
  )
    throw new Error("Selected native manifest does not match the compatibility candidates.");
  for (const artifact of [
    config.git,
    config.gh,
    config.openssl,
    config.gitRemoteHttp,
    config.gitRemoteHttps,
    config.gitHttpBackend,
  ]) {
    if (
      !artifact ||
      !isAbsolute(artifact.path ?? "") ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? "")
    )
      throw new Error("Every selected native artifact needs an absolute path and SHA-256.");
  }
  return Object.freeze(config);
}

async function digestFile(path, signal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest("hex");
}
const digest = (value) => createHash("sha256").update(value).digest("hex");

/** A bounded local setup command. It has no inherited credentials or remote URL. */
export async function runNativeSetupCommand(file, args, cwd, environment, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    let bytes = 0;
    let failed = false;
    const stop = () => {
      failed = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") child.kill("SIGKILL");
        }
      }
    };
    const timer = setTimeout(stop, 10_000);
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) stop();
      else output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) stop();
    });
    child.on("error", () => {
      failed = true;
    });
    // Settlement follows pipe closure, including failed spawn and cancellation.
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (!failed && code === 0 && bytes <= 256 * 1024) resolve(output);
      else reject(new Error("Selected local tool failed."));
    });
  });
}

function listenLoopback(server, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.removeListener("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    const aborted = () => {
      cleanup();
      reject(new Error("Native fixture setup aborted."));
    };
    server.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    server.listen({ port: 0, host: "127.0.0.1", signal }, () => {
      cleanup();
      resolve();
    });
  });
}

async function verifyNativeTools(config, signal) {
  signal.throwIfAborted();
  const evidence = {};
  for (const name of [
    "git",
    "gh",
    "openssl",
    "gitRemoteHttp",
    "gitRemoteHttps",
    "gitHttpBackend",
  ]) {
    const artifact = config[name];
    const path = await realpath(artifact.path);
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.size > 128 * 1024 * 1024 ||
      (metadata.mode & 0o111) === 0 ||
      (await digestFile(path, signal)) !== artifact.sha256
    )
      throw new Error("Selected native artifact identity mismatch.");
    evidence[name] = { path, sha256: artifact.sha256 };
  }
  if (
    (await realpath(config.scratchParent)) !== config.scratchParent ||
    !(await lstat(config.scratchParent)).isDirectory()
  )
    throw new Error("Selected native scratch parent must be an existing real directory.");
  const execPath = await realpath(config.gitExecPath);
  for (const [field, leaf] of [
    ["gitRemoteHttp", "git-remote-http"],
    ["gitRemoteHttps", "git-remote-https"],
    ["gitHttpBackend", "git-http-backend"],
  ]) {
    if ((await realpath(join(execPath, leaf))) !== evidence[field].path)
      throw new Error("Selected Git exec-path must contain the bound transport tools.");
  }
  const environment = {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GH_NO_UPDATE_NOTIFIER: "1",
  };
  const gitVersion = (
    await runNativeSetupCommand(
      evidence.git.path,
      ["--version"],
      config.scratchParent,
      environment,
      signal,
    )
  ).trim();
  const ghVersion = (
    await runNativeSetupCommand(
      evidence.gh.path,
      ["--version"],
      config.scratchParent,
      environment,
      signal,
    )
  ).split("\n")[0];
  if (
    gitVersion !== `git version ${SELECTED_NATIVE_TOOLS.git.version}` ||
    !ghVersion.startsWith(`gh version ${SELECTED_NATIVE_TOOLS.gh.version} (`)
  )
    throw new Error("Selected Git/gh version mismatch; no PATH fallback is allowed.");
  return Object.freeze({ ...evidence, gitVersion, ghVersion, gitExecPath: execPath });
}

/** Entry point for GENERATED fixture launchers only. It records argument digests,
 * then executes the bound native binary. No credential relay is introduced: FD3
 * is inherited unchanged by actual Git and must survive its real helper path.
 * Proxy/CA overrides are test-only and intentionally override the production
 * empty http.proxy setting without disabling TLS or changing repository URLs.
 */
export async function nativeFixtureToolMain(configPath, kind) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (config.kind !== "native-fixture-launcher-v1" || !["git", "gh"].includes(kind))
    throw new Error("Invalid fixture launcher.");
  const args = process.argv.slice(2);
  const forbidden = [
    "GITHUB_TOKEN",
    "GH_DEBUG",
    "GIT_TRACE",
    "GIT_CONFIG_PARAMETERS",
    "GIT_DIR",
    "GIT_WORK_TREE",
  ];
  await appendFile(
    config.observations,
    `${JSON.stringify({
      tool: kind,
      argvSha256: digest(JSON.stringify(args)),
      argc: args.length,
      hasCredentialFd: process.env.OCE_NATIVE_CREDENTIAL_FD === "3",
      hasGhToken: Boolean(process.env.GH_TOKEN),
      forbiddenEnvironment: forbidden.filter((key) => key in process.env),
    })}\n`,
    { mode: 0o600 },
  );
  const environment = {
    ...process.env,
    PATH: `${config.binDirectory}:/usr/bin:/bin`,
    GIT_EXEC_PATH: config.gitExecPath,
    HTTPS_PROXY: config.proxy,
    HTTP_PROXY: config.proxy,
    NO_PROXY: "",
    SSL_CERT_FILE: config.ca,
    GIT_SSL_CAINFO: config.ca,
  };
  const effective = [...args];
  if (kind === "git") {
    let offset = 0;
    while (effective[offset] === "-c" && typeof effective[offset + 1] === "string") offset += 2;
    effective.splice(
      offset,
      0,
      "-c",
      `http.proxy=${config.proxy}`,
      "-c",
      `http.sslCAInfo=${config.ca}`,
      "-c",
      "http.sslVerify=true",
    );
  }
  let inheritCredential = false;
  try {
    inheritCredential = process.env.OCE_NATIVE_CREDENTIAL_FD === "3" && fstatSync(3).isSocket();
  } catch {}
  // Inspecting an inherited descriptor must not consume or replace it.
  const child = spawn(config[kind], effective, {
    env: environment,
    stdio: ["inherit", "inherit", "pipe", inheritCredential ? 3 : "ignore"],
  });
  const stderrCodes = new Set();
  let diagnosticTail = "";
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    diagnosticTail = (diagnosticTail + chunk.toString()).slice(-4096);
    for (const code of [
      "quit",
      "Username",
      "Authentication failed",
      "credential",
      "Socket",
      "invalid",
      "not found",
      "could not read",
      "cannot run",
      "No such file",
      "Permission denied",
      "Unsupported",
      "GraphQL",
      "resource",
    ])
      if (diagnosticTail.toLowerCase().includes(code.toLowerCase())) stderrCodes.add(code);
  });
  child.on("error", () => {
    process.stderr.write("Selected native fixture tool unavailable.\n");
    process.exitCode = 1;
  });
  child.on("close", async (code, signal) => {
    await appendFile(
      config.observations,
      `${JSON.stringify({ tool: kind, phase: "exit", code, signal, forbiddenEnvironment: [], stderrCodes: [...stderrCodes] })}\n`,
    );
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

/** A strict finite GraphQL/REST/smart-HTTP fixture for the selected native cases.
 * Its denials and mutations are synthetic protocol outcomes, never GitHub scope
 * or branch-policy evidence. Unsupported queries fail instead of generic success.
 */
async function selectedProtocolServer({
  repository,
  releases,
  key,
  cert,
  toolchain,
  bareRoot,
  allowAnonymousGit,
  signal: callerSignal,
}) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([callerSignal, lifetime.signal]);
  const requests = new Set();
  let closing = false;
  const observations = [];
  const mutations = [];
  const createAttempts = [];
  const revoked = new Set();
  const sockets = new Set();
  const backends = new Map();
  const model = { deny: false, dropCreateAck: false, dropPushAck: false };
  const name = `${repository.owner}/${repository.name}`;
  const issue = {
    number: repository.issue,
    title: "Native fixture issue",
    state: "OPEN",
    url: `https://github.com/${name}/issues/${repository.issue}`,
    body: "Selected native issue body",
  };
  const pull = {
    number: repository.pull,
    title: "Existing native fixture PR",
    state: "OPEN",
    url: `https://github.com/${name}/pull/${repository.pull}`,
    isDraft: true,
    baseRefName: repository.base,
    headRefName: "oce-demo/existing",
    body: "Existing fixture draft",
  };
  const repo = {
    id: "R_native_fixture",
    name: repository.name,
    nameWithOwner: name,
    owner: { id: "O_native_fixture", login: repository.owner },
    url: `https://github.com/${name}`,
    isPrivate: true,
    isFork: false,
    isArchived: false,
    hasIssuesEnabled: true,
    viewerPermission: "WRITE",
    defaultBranchRef: { name: repository.base },
    parent: null,
  };
  const handleRequest = async (request, response) => {
    const path = new URL(request.url, "https://github.com");
    const record = {
      method: request.method,
      host: request.headers.host,
      path: path.pathname,
      query: path.search,
      tokenOrdinal: -1,
      hasAuthorization: Boolean(request.headers.authorization),
      status: 0,
      gitProtocol: request.headers["git-protocol"] ?? null,
      apiVersion: request.headers["x-github-api-version"] ?? null,
    };
    observations.push(record);
    const json = (status, value) => {
      record.status = status;
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(value));
    };
    if (
      observations.length > 80 ||
      !["github.com", "api.github.com"].includes(request.headers.host)
    ) {
      json(400, { message: "Outside selected fixture bounds" });
      return;
    }
    const auth = request.headers.authorization ?? "";
    let token = /^(?:Bearer|token) /i.test(auth) ? auth.slice(auth.indexOf(" ") + 1) : "";
    if (auth.startsWith("Basic ")) {
      const decoded = Buffer.from(auth.slice(6), "base64").toString();
      if (decoded.startsWith("x-access-token:")) token = decoded.slice(15);
    }
    const held = model.holdNext;
    if (held) {
      model.holdNext = undefined;
      held.entered.resolve();
      await new Promise((resolve) => {
        const done = () => {
          signal.removeEventListener("abort", done);
          resolve();
        };
        signal.addEventListener("abort", done, { once: true });
        held.release.promise.then(done, done);
        if (signal.aborted) done();
      });
      if (signal.aborted) {
        response.destroy();
        return;
      }
    }
    record.tokenOrdinal = releases.findIndex(
      (entry) =>
        entry.token === token &&
        Date.parse(entry.expiresAt) > Date.now() &&
        !revoked.has(entry.token),
    );
    const gitPath = path.pathname.startsWith(`/${name}.git/`);
    const anonymous =
      allowAnonymousGit &&
      gitPath &&
      !auth &&
      (path.pathname.endsWith("/git-upload-pack") ||
        path.searchParams.get("service") === "git-upload-pack");
    if (model.deny || (record.tokenOrdinal < 0 && !anonymous)) {
      response.setHeader("WWW-Authenticate", "Basic realm=native-fixture");
      json(401, { message: "Synthetic credential denied" });
      return;
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          json(413, { message: "Fixture input bound exceeded" });
          return;
        }
        chunks.push(chunk);
      }
    } catch {
      response.destroy();
      return;
    }
    const body = Buffer.concat(chunks);
    if (gitPath && request.headers.host === "github.com") {
      const service = path.searchParams.get("service");
      const supported =
        (request.method === "GET" &&
          path.pathname.endsWith("/info/refs") &&
          ["git-upload-pack", "git-receive-pack"].includes(service)) ||
        (request.method === "POST" && /\/(git-upload-pack|git-receive-pack)$/.test(path.pathname));
      if (!supported) {
        json(404, { message: "Unsupported Git fixture operation" });
        return;
      }
      const child = spawn(toolchain.gitHttpBackend.path, [], {
        env: {
          PATH: "/usr/bin:/bin",
          GIT_EXEC_PATH: toolchain.gitExecPath,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_PROJECT_ROOT: bareRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          REMOTE_USER: "synthetic",
          REQUEST_METHOD: request.method,
          PATH_INFO: path.pathname,
          QUERY_STRING: path.search.slice(1),
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(size),
          HTTP_GIT_PROTOCOL: request.headers["git-protocol"] ?? "",
        },
        stdio: ["pipe", "pipe", "ignore"],
        detached: true,
      });
      const stopBackend = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") child.kill("SIGKILL");
          }
        }
      };
      const backendTimer = setTimeout(stopBackend, 5000);
      signal.addEventListener("abort", stopBackend, { once: true });
      if (signal.aborted) stopBackend();
      const settled = new Promise((resolve) =>
        child.once("close", () => {
          clearTimeout(backendTimer);
          signal.removeEventListener("abort", stopBackend);
          backends.delete(child);
          resolve();
        }),
      );
      backends.set(child, { stop: stopBackend, settled });
      const output = [];
      let bytes = 0;
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) child.kill("SIGKILL");
        else output.push(chunk);
      });
      child.on("error", () => json(503, { message: "Selected Git backend unavailable" }));
      child.on("close", (code) => {
        if (response.writableEnded) return;
        const result = Buffer.concat(output);
        const boundary = result.indexOf("\r\n\r\n");
        if (code !== 0 || bytes > 2 * 1024 * 1024 || boundary < 0) {
          json(503, { message: "Selected Git backend failed" });
          return;
        }
        record.status = 200;
        if (
          request.method === "POST" &&
          path.pathname.endsWith("/git-receive-pack") &&
          model.dropPushAck
        ) {
          record.status = 0;
          request.socket.destroy();
          return;
        }
        for (const header of result.subarray(0, boundary).toString().split("\r\n")) {
          const colon = header.indexOf(":");
          if (colon < 1) continue;
          const field = header.slice(0, colon);
          const value = header.slice(colon + 1).trim();
          if (field.toLowerCase() === "status") {
            response.statusCode = Number(value.split(" ")[0]);
            record.status = response.statusCode;
          } else response.setHeader(field, value);
        }
        response.end(result.subarray(boundary + 4));
      });
      child.stdin.on("error", () => response.destroy());
      child.stdin.end(body);
      return;
    }
    if (request.headers.host !== "api.github.com") {
      json(404, { message: "Wrong fixture host" });
      return;
    }
    const restIssue = { ...issue, state: "open" };
    const restPull = {
      number: pull.number,
      title: pull.title,
      state: "open",
      url: `https://api.github.com/repos/${name}/pulls/${pull.number}`,
      html_url: pull.url,
      draft: true,
      head: { ref: pull.headRefName, sha: repository.commit },
      base: { ref: repository.base, sha: repository.commit },
    };
    if (request.method === "GET") {
      if (path.pathname === `/repos/${name}`) {
        json(200, {
          id: repository.id,
          full_name: name,
          private: true,
          default_branch: repository.base,
        });
        return;
      }
      if (path.pathname === `/repos/${name}/commits/${repository.commit}`) {
        json(200, { sha: repository.commit });
        return;
      }
      if (
        path.pathname === `/repos/${name}/issues` &&
        path.searchParams.get("state") === "open" &&
        path.searchParams.get("per_page") === "20"
      ) {
        json(200, [
          restIssue,
          {
            number: pull.number,
            title: pull.title,
            state: "open",
            pull_request: { url: restPull.url },
          },
        ]);
        return;
      }
      if (
        path.pathname === `/repos/${name}/pulls` &&
        path.searchParams.get("state") === "open" &&
        path.searchParams.get("per_page") === "20"
      ) {
        json(200, [restPull]);
        return;
      }
      json(404, { message: "Unknown selected fixture object" });
      return;
    }
    if (request.method !== "POST" || path.pathname !== "/graphql") {
      json(404, { message: "Unsupported fixture operation" });
      return;
    }
    let packet;
    try {
      packet = JSON.parse(body.toString());
    } catch {
      json(400, { message: "Invalid fixture request" });
      return;
    }
    const query = packet.query;
    const variables = packet.variables ?? {};
    record.graphqlQuery = query;
    record.variableKeys = Object.keys(variables);
    if (typeof query !== "string" || query.length > 32_768) {
      json(400, { message: "Invalid bounded GraphQL request" });
      return;
    }
    const error = () =>
      json(200, {
        errors: [{ type: "NOT_FOUND", message: "Unsupported selected fixture query or object" }],
      });
    if (/createPullRequest/.test(query)) {
      createAttempts.push(Object.freeze({ requestIndex: observations.length - 1 }));
      const input = variables.input;
      if (
        !input ||
        input.repositoryId !== repo.id ||
        input.baseRefName !== repository.base ||
        input.headRefName !== repository.branch ||
        input.draft !== true ||
        input.maintainerCanModify !== false ||
        typeof input.title !== "string" ||
        typeof input.body !== "string" ||
        mutations.length > 0
      ) {
        error();
        return;
      }
      let headRefOid;
      try {
        headRefOid = (
          await runNativeSetupCommand(
            toolchain.git.path,
            [
              "--git-dir",
              join(bareRoot, repository.owner, `${repository.name}.git`),
              "rev-parse",
              `refs/heads/${repository.branch}`,
            ],
            bareRoot,
            {
              PATH: "/usr/bin:/bin",
              GIT_EXEC_PATH: toolchain.gitExecPath,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
            },
            signal,
          )
        ).trim();
      } catch {
        error();
        return;
      }
      const created = {
        number: 10,
        url: `https://github.com/${name}/pull/10`,
        id: "PR_native_created",
        isDraft: true,
        baseRefName: input.baseRefName,
        headRefName: input.headRefName,
        title: input.title,
        body: input.body,
        headRefOid,
      };
      mutations.push(
        Object.freeze({ input: Object.freeze({ ...input }), pull: Object.freeze(created) }),
      );
      record.graphql = "createPullRequest";
      if (model.dropCreateAck) {
        request.socket.destroy();
        return;
      }
      json(200, { data: { createPullRequest: { pullRequest: created } } });
      return;
    }
    if (
      variables.owner !== repository.owner ||
      (variables.name ?? variables.repo) !== repository.name ||
      /\bmutation\b/.test(query)
    ) {
      error();
      return;
    }
    if (/\bIssueList\b/.test(query)) {
      if (
        variables.limit !== 20 ||
        !Array.isArray(variables.states) ||
        variables.states.join() !== "OPEN" ||
        !["number", "title", "state", "url"].every((field) =>
          new RegExp(`\\b${field}\\b`).test(query),
        )
      ) {
        error();
        return;
      }
      record.graphql = "IssueList";
      record.limit = variables.limit;
      json(200, {
        data: {
          repository: {
            hasIssuesEnabled: true,
            issues: {
              totalCount: 1,
              nodes: [issue],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
      return;
    }
    if (/\b(?:issue|issueOrPullRequest)\s*\(/.test(query)) {
      if ((variables.number ?? variables.issue) !== repository.issue) {
        error();
        return;
      }
      record.graphql = "issue";
      record.object = repository.issue;
      json(200, {
        data: {
          repository: {
            hasIssuesEnabled: true,
            issue: { ...issue, __typename: "Issue", id: "I_native_fixture" },
          },
        },
      });
      return;
    }
    if (/\bpullRequest\s*\(/.test(query)) {
      if ((variables.number ?? variables.pr ?? variables.pr_number) !== repository.pull) {
        error();
        return;
      }
      record.graphql = "pullRequest";
      record.object = repository.pull;
      json(200, { data: { repository: { pullRequest: pull } } });
      return;
    }
    if (/\bpullRequests\s*\(/.test(query)) {
      const head = variables.headRefName ?? variables.headBranch ?? variables.headRef;
      if (head !== repository.branch) {
        error();
        return;
      }
      record.graphql = "existingPullRequests";
      json(200, {
        data: {
          repository: {
            pullRequests: {
              totalCount: mutations.length,
              nodes: mutations.map((entry) => entry.pull),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
      return;
    }
    if (
      /\brepository\s*\(/.test(query) &&
      !/\b(?:search|viewer|object|ref|issues|issueOrPullRequest|pullRequests)\s*[({]/.test(query)
    ) {
      record.graphql = "repository";
      json(200, { data: { repository: repo } });
      return;
    }
    error();
  };
  const server = createTlsServer({ key, cert }, (request, response) => {
    if (closing) {
      request.destroy();
      return;
    }
    const pending = handleRequest(request, response).catch(() => response.destroy());
    requests.add(pending);
    void pending.then(() => requests.delete(pending));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.setTimeout(10_000, () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });

  const tunnelTargets = [];
  const proxy = createServer((_request, response) => {
    response.writeHead(405);
    response.end();
  });
  proxy.on("connect", (request, socket, head) => {
    if (
      closing ||
      !["github.com:443", "api.github.com:443"].includes(request.url) ||
      tunnelTargets.length >= 80
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    tunnelTargets.push(request.url);
    // Exact loopback destination only. No DNS lookup, caller-selected target or
    // outbound fallback exists in the fixture proxy.
    const upstream = connect({ host: "127.0.0.1", port: server.address().port });
    sockets.add(socket);
    sockets.add(upstream);
    for (const stream of [socket, upstream]) {
      stream.setTimeout(10_000, () => stream.destroy());
      stream.on("error", () => {
        socket.destroy();
        upstream.destroy();
      });
      stream.on("close", () => sockets.delete(stream));
    }
    upstream.on("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  });
  const close = async () => {
    closing = true;
    lifetime.abort();
    for (const socket of sockets) socket.destroy();
    const listeners = [server, proxy].map(
      (listener) => new Promise((resolve) => listener.close(resolve)),
    );
    // Handler settlement includes GraphQL readback subprocess close. Once all
    // handlers settle, no request can create another smart-HTTP backend.
    await Promise.all([...requests]);
    const pending = [...backends.values()];
    for (const backend of pending) backend.stop();
    await Promise.all([...pending.map((backend) => backend.settled), ...listeners]);
  };
  try {
    await listenLoopback(server, signal);
    await listenLoopback(proxy, signal);
    signal.throwIfAborted();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    observations,
    mutations,
    createAttempts,
    model,
    revoked,
    tunnelTargets,
    proxy: `http://127.0.0.1:${proxy.address().port}`,
    close,
  };
}

/** Called only inside an explicitly selected native test body. Creates a real
 * tiny synthetic Git object graph with the selected binary for protocol tests.
 */
export async function prepareSelectedNativeCase(t, config, id, root) {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, t.signal]);
  const deadline = setTimeout(() => controller.abort(), 60_000);
  let endpoint;
  let home;
  const cleanup = async () => {
    controller.abort();
    clearTimeout(deadline);
    if (endpoint) await endpoint.close();
    if (home) await rm(home, { recursive: true, force: true });
  };
  t.after(cleanup);
  try {
    const toolchain = await verifyNativeTools(config, signal);
    signal.throwIfAborted();
    home = await mkdtemp(join(config.scratchParent, `native-${id.toLowerCase()}-`));
    signal.throwIfAborted();
    const environment = {
      PATH: "/usr/bin:/bin",
      HOME: home,
      XDG_CONFIG_HOME: home,
      LANG: "C",
      LC_ALL: "C",
      GIT_EXEC_PATH: toolchain.gitExecPath,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Native fixture",
      GIT_AUTHOR_EMAIL: "fixture@local.invalid",
      GIT_COMMITTER_NAME: "Native fixture",
      GIT_COMMITTER_EMAIL: "fixture@local.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    };
    const git = (args) =>
      runNativeSetupCommand(
        toolchain.git.path,
        ["-c", "init.templateDir=", "-c", "core.hooksPath=/dev/null", ...args],
        home,
        environment,
        signal,
      );
    const seed = join(home, "seed");
    const bareRoot = join(home, "bare");
    const fileContents = {
      "README.md": "# Synthetic native fixture\n",
      "index.js": "export default 42;\n",
      "package.json": '{"name":"native-fixture","private":true}\n',
      LICENSE: "Synthetic test fixture.\n",
      ".gitignore": "ignored.tmp\n",
    };
    await git(["init", "--initial-branch=main", seed]);
    for (const [path, content] of Object.entries(fileContents))
      await writeFile(join(seed, path), content);
    await git(["-C", seed, "add", "--", ...Object.keys(fileContents)]);
    await git(["-C", seed, "-c", "commit.gpgSign=false", "commit", "-m", "Synthetic native base"]);
    const commit = (await git(["-C", seed, "rev-parse", "HEAD"])).trim();
    const repository = Object.freeze({
      ...fixtureRepository,
      commit,
      branch: `oce-demo/native-${id.toLowerCase()}`,
    });
    await mkdir(join(bareRoot, repository.owner), { recursive: true });
    const bare = join(bareRoot, repository.owner, `${repository.name}.git`);
    await git(["clone", "--bare", "--", seed, bare]);
    await git(["--git-dir", bare, "config", "http.receivepack", "true"]);
    const key = join(home, "tls.key");
    const ca = join(home, "tls.crt");
    await runNativeSetupCommand(
      toolchain.openssl.path,
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=Native fixture",
        "-addext",
        "subjectAltName=DNS:github.com,DNS:api.github.com",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-keyout",
        key,
        "-out",
        ca,
      ],
      home,
      { PATH: "/usr/bin:/bin", HOME: home },
      signal,
    );
    await chmod(key, 0o600);
    const original = syntheticAttempt(id);
    const releases = [syntheticRelease(original)];
    const delivery = syntheticDelivery(() => releases.at(-1));
    endpoint = await selectedProtocolServer({
      repository,
      releases,
      key: await readFile(key),
      cert: await readFile(ca),
      toolchain,
      bareRoot,
      allowAnonymousGit: id === "G01",
      signal,
    });
    const binDirectory = join(home, "bin");
    await mkdir(binDirectory);
    const observations = join(home, "native-launches.jsonl");
    await writeFile(observations, "", { mode: 0o600 });
    const launcherConfig = join(home, "launcher.json");
    await writeFile(
      launcherConfig,
      JSON.stringify({
        kind: "native-fixture-launcher-v1",
        git: toolchain.git.path,
        gh: toolchain.gh.path,
        gitExecPath: toolchain.gitExecPath,
        ca,
        proxy: endpoint.proxy,
        binDirectory,
        observations,
      }),
      { mode: 0o600 },
    );
    const moduleUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
    const launchers = {};
    for (const name of ["git", "gh"]) {
      const path = join(binDirectory, name);
      const source = `#!${process.execPath}\nimport(${JSON.stringify(moduleUrl)}).then(module => module.nativeFixtureToolMain(${JSON.stringify(launcherConfig)}, ${JSON.stringify(name)})).catch(() => { process.stderr.write("Native fixture launcher unavailable.\\n"); process.exitCode = 1; });\n`;
      await writeFile(path, source, { mode: 0o700 });
      launchers[name] = { path, sha256: digest(source) };
    }
    const tools = {
      node: process.execPath,
      git: launchers.git.path,
      gh: launchers.gh.path,
      helper: join(root, "packages/github-sts/bin/git-credential-github-sts.mjs"),
      ghWrapper: join(root, "packages/github-sts/bin/gh.mjs"),
    };
    const checkout = join(home, "checkout");
    const options = {
      original,
      repository,
      delivery,
      tools,
      scratchParent: home,
      exclusiveCheckout: true,
      signal,
      timeoutMs: 10_000,
    };
    return {
      home,
      bare,
      checkout,
      original,
      repository,
      options,
      releases,
      delivery,
      endpoint,
      git,
      toolchain,
      launchers,
      expectedFiles: Object.fromEntries(
        Object.entries(fileContents).map(([path, content]) => [path, digest(content)]),
      ),
      async childObservations() {
        return (await readFile(observations, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      },
      async verifyNoManagedToken(results = []) {
        const needles = releases.flatMap(({ token }) => [
          token,
          encodeURIComponent(token),
          Buffer.from(token).toString("base64"),
          Buffer.from(`x-access-token:${token}`).toString("base64"),
        ]);
        const assertClean = (content) => {
          if (needles.some((value) => content.includes(value)))
            throw new Error("Managed synthetic token disclosure detected.");
        };
        assertClean(
          JSON.stringify({
            results,
            requests: endpoint.observations,
            mutations: endpoint.mutations,
          }),
        );
        let bytes = 0;
        let count = 0;
        async function visit(directory) {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (++count > 500) throw new Error("Native fixture file-count bound exceeded.");
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await visit(path);
            else if (entry.isFile()) {
              const size = (await lstat(path)).size;
              bytes += size;
              if (bytes > 4 * 1024 * 1024)
                throw new Error("Native fixture scratch bound exceeded.");
              assertClean((await readFile(path)).toString("latin1"));
            } else throw new Error("Unsupported native fixture artifact type.");
          }
        }
        await visit(home);
        const children = (await readFile(observations, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse);
        if (
          children.some(
            (child) =>
              child.forbiddenEnvironment.length || (child.tool === "gh" && child.hasCredentialFd),
          )
        )
          throw new Error("Native child environment was not scrubbed.");
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

const directEntrypoint =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

// A Node probe verifies process/pipe/collector mechanics only. It is never labeled gh.
// A planner probe reads the owned PR snapshot; it does not create a pull request.
if (directEntrypoint && process.argv[2] === "pr") {
  const field = (name) => process.argv[process.argv.indexOf(name) + 1];
  const body = await readFile(field("--body-file"));
  process.stdout.write(
    JSON.stringify({
      bodyDigest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      title: field("--title"),
      base: field("--base"),
      head: field("--head"),
    }),
  );
}
if (directEntrypoint && process.argv[2] === "pipe-probe") {
  const socket = new Socket({ fd: 3, readable: true, writable: true });
  socket.on("error", () => {
    process.exitCode = 1;
  });
  const count = Number(process.argv[4] ?? "1");
  let received = 0;
  let buffer = "";
  const send = () =>
    socket.write(
      `${JSON.stringify({ kind: process.argv[3], protocol: "https", host: "github.com", path: "fixture/mirror.git" })}\n`,
    );
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const reply = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      received += 1;
      if (reply.kind === "denied") {
        process.exitCode = 1;
        socket.destroy();
        return;
      }
      if (received >= count) {
        process.stdout.write(JSON.stringify({ received, kind: reply.kind }));
        socket.destroy();
        return;
      }
      send();
    }
  });
  send();
}
if (directEntrypoint && process.argv[2] === "probe") {
  const mode = process.argv[3];
  if (mode === "environment") {
    process.stdout.write(
      JSON.stringify({
        hasToken: Boolean(process.env.GH_TOKEN),
        hasPipe: "OCE_NATIVE_CREDENTIAL_FD" in process.env,
        hasAlternate: "GITHUB_TOKEN" in process.env,
        hasDebug: "GH_DEBUG" in process.env,
        args: process.argv.slice(4),
      }),
    );
  } else if (mode === "canary") {
    const token = process.env.GH_TOKEN;
    process.stdout.write(token.slice(0, 7));
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.stdout.write(token.slice(7));
    process.stderr.write(Buffer.from(`x-access-token:${token}`).toString("base64"));
  } else if (mode === "http" || mode === "ambiguous") {
    try {
      const response = await fetch(process.argv[4], {
        method: mode === "http" ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${process.env.GH_TOKEN}`,
          "X-GitHub-Api-Version": "2026-03-10",
          ...(mode === "ambiguous"
            ? { "x-fixture-drop-ack": "1", "content-type": "application/json" }
            : {}),
        },
        ...(mode === "ambiguous"
          ? {
              body: JSON.stringify({
                query: "mutation { createPullRequest(input: {}) { pullRequest { url } } }",
              }),
            }
          : {}),
      });
      if (!response.ok) process.exitCode = 1;
      else process.stdout.write(await response.text());
    } catch {
      process.stderr.write("Controlled endpoint outcome unavailable.\n");
      process.exitCode = 1;
    }
  } else if (mode === "hold") {
    await new Promise((resolve) => setTimeout(resolve, 5000));
  } else process.exitCode = 1;
}
