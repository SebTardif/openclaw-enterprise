import { spawn } from "node:child_process";
import { createHash, randomBytes, verify } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

// External GitHub only: these observations are provider-side evidence, never
// Work admission, credential custody, State persistence, or native authorization.
// Requires installed Git with git-http-backend and OpenSSL; never uses the network
// except a TLS listener bound to 127.0.0.1. No substitute pack implementation.
const operations = ["mint", "revoke", "metadata", "discovery", "upload-pack", "unsupported"];
const faultKinds = ["hold-after-entry", "hold-after-effect", "disconnect-after-effect"];
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const snapshot = (value) => structuredClone(value);
const sameKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const faultDeferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/**
 * Start the controlled external service. The caller supplies the public half of
 * its test App key; this module never creates or substitutes internal authority.
 *
 * faultNext(operation, kind) arms one accepted request. Its entered promise
 * resolves when the requested hold/disconnect phase is reached, or to null when
 * failure/close prevents entry. release()/disconnect() settle a hold. Aborting the client
 * cancels an outstanding Git process and drains the request handler.
 *
 * observations(), counters(), and providerTokens() are detached, redacted
 * provider snapshots. providerTokens() exposes issuance/expiry/revocation facts,
 * but never returns the minted bearer or App JWT. Tokens leave only over HTTPS.
 */
export async function startGitHubReadMvpExternalService({
  tempParent = homedir(),
  app,
  installationId = 41,
  repository = { id: 73, fullName: "fixture/repo" },
  permissions = { metadata: "read", contents: "read" },
  strictNativeHeaders = false,
  clock = Date.now,
  tokenTtlMs = 120_000,
  requestTimeoutMs = 10_000,
  maxRequests = 256,
  maxRequestBytes = 2 * 1024 * 1024,
  maxResponseBytes = 16 * 1024 * 1024,
} = {}) {
  if (
    !app ||
    typeof app.clientId !== "string" ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(app.clientId) ||
    app.publicKey?.type !== "public" ||
    app.publicKey.asymmetricKeyType !== "rsa"
  ) {
    throw new Error("Fixture requires the caller's RSA public KeyObject and App clientId");
  }
  if (
    !Number.isSafeInteger(installationId) ||
    installationId <= 0 ||
    !Number.isSafeInteger(repository.id) ||
    repository.id <= 0 ||
    !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(repository.fullName) ||
    permissions.metadata !== "read" ||
    Object.keys(permissions).some((key) => !["metadata", "contents"].includes(key)) ||
    ("contents" in permissions && permissions.contents !== "read") ||
    typeof strictNativeHeaders !== "boolean" ||
    typeof clock !== "function"
  ) {
    throw new Error("Fixture supports one exact repository and read-only permissions");
  }
  for (const [name, value, low, high] of [
    ["tokenTtlMs", tokenTtlMs, 1000, 3_600_000],
    ["requestTimeoutMs", requestTimeoutMs, 100, 30_000],
    ["maxRequests", maxRequests, 1, 4096],
    ["maxRequestBytes", maxRequestBytes, 1, 8 * 1024 * 1024],
    ["maxResponseBytes", maxResponseBytes, 1024, 64 * 1024 * 1024],
  ]) {
    if (!Number.isSafeInteger(value) || value < low || value > high) {
      throw new Error(`Invalid fixture bound: ${name}`);
    }
  }
  if (!isAbsolute(tempParent))
    throw new Error("Fixture tempParent must be absolute and under home");
  const parent = await realpath(tempParent);
  const home = await realpath(homedir());
  const fromHome = relative(home, parent);
  if (fromHome === ".." || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) {
    throw new Error("Fixture tempParent must resolve under the current home directory");
  }
  const directory = await mkdtemp(join(parent, "github-read-mvp-external-"));
  await chmod(directory, 0o700);
  const repo = Object.freeze({ id: repository.id, fullName: repository.fullName });
  const scope = Object.freeze({ ...permissions });
  const clientId = app.clientId;
  const publicKey = app.publicKey;
  const projectRoot = join(directory, "repositories");
  const bare = join(projectRoot, `${repo.fullName}.git`);
  const children = new Set();
  const sockets = new Set();
  const pending = new Set();
  const records = [];
  const tokens = new Map();
  const faults = new Map();
  let stopped = false;
  let closePromise;
  let server;
  let revision = 0;
  let currentCommit;
  let rejectedOverLimit = 0;
  const childEnvironment = {
    PATH: process.env.PATH,
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    LC_ALL: "C",
    GIT_AUTHOR_NAME: "Read MVP fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Read MVP fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };

  function run(binary, args, { input, env = {}, signal } = {}) {
    if (stopped) return Promise.reject(new Error("External fixture is closed"));
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd: directory,
        env: { ...childEnvironment, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      const chunks = [];
      let length = 0;
      let failure;
      const fail = (message) => {
        failure ??= new Error(message);
        child.kill("SIGKILL");
      };
      const abort = () => fail("Fixture subprocess cancelled");
      const timer = setTimeout(() => fail("Fixture subprocess timed out"), requestTimeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on("data", (chunk) => {
        length += chunk.length;
        if (length > maxResponseBytes) fail("Fixture subprocess output exceeded its bound");
        else chunks.push(chunk);
      });
      // Never include subprocess diagnostics in credential-adjacent evidence.
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.once("error", () => {
        failure ??= new Error(`Required fixture executable unavailable: ${binary}`);
      });
      child.once("close", (code) => {
        children.delete(child);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code !== 0)
          reject(new Error(`Fixture executable failed: ${binary} (exit ${code})`));
        else resolve(Buffer.concat(chunks));
      });
      child.stdin.end(input);
    });
  }
  const git = (args, options) =>
    run(
      "git",
      [
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "protocol.allow=never",
        ...args,
      ],
      options,
    );
  const gitRepo = (args, options) => git(["--git-dir", bare, ...args], options);
  const filesFor = (version) =>
    Object.freeze({
      "README.md": `# Controlled GitHub read fixture\n\nRevision ${version}.\n`,
      "data.txt": `repository=${repo.fullName}\nrevision=${version}\n`,
    });

  async function advance() {
    if (stopped || revision >= 16)
      throw new Error("Fixture repository is closed or revision bound reached");
    // Compare-and-swap ref changes; concurrent advances cannot silently lose a commit.
    const previous = currentCommit;
    const version = revision + 1;
    const entries = [];
    for (const [name, bytes] of Object.entries(filesFor(version))) {
      const oid = (await gitRepo(["hash-object", "-w", "--stdin"], { input: bytes }))
        .toString()
        .trim();
      entries.push(`100644 blob ${oid}\t${name}\n`);
    }
    const tree = (await gitRepo(["mktree"], { input: entries.join("") })).toString().trim();
    const commit = (
      await gitRepo(["commit-tree", tree, ...(previous ? ["-p", previous] : [])], {
        input: `Fixture revision ${version}\n`,
      })
    )
      .toString()
      .trim();
    await gitRepo(["update-ref", "refs/heads/main", commit, previous ?? "0".repeat(40)]);
    revision = version;
    currentCommit = commit;
    return commit;
  }

  function publicRecord(record) {
    return snapshot(record);
  }
  function authToken(request, kind) {
    const authorization = request.headers.authorization;
    if (typeof authorization !== "string") return undefined;
    let value;
    if (kind === "Bearer" && authorization.startsWith("Bearer ")) value = authorization.slice(7);
    if (kind === "Basic" && authorization.startsWith("Basic ")) {
      const encoded = authorization.slice(6);
      const decoded = Buffer.from(encoded, "base64").toString();
      if (
        Buffer.from(decoded).toString("base64") === encoded &&
        decoded.startsWith("x-access-token:")
      ) {
        value = decoded.slice(15);
      }
    }
    const token = tokens.get(value);
    return token && !token.revoked && token.expiresAt > clock() ? token : undefined;
  }
  function validAppJwt(authorization) {
    try {
      if (!authorization?.startsWith("Bearer ") || authorization.length > 8192) return false;
      const parts = authorization.slice(7).split(".");
      if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
      const header = JSON.parse(Buffer.from(parts[0], "base64url"));
      const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
      const now = Math.floor(clock() / 1000);
      return (
        sameKeys(header, ["alg", "typ"]) &&
        header.alg === "RS256" &&
        header.typ === "JWT" &&
        sameKeys(claims, ["iat", "exp", "iss"]) &&
        claims.iss === clientId &&
        Number.isSafeInteger(claims.iat) &&
        Number.isSafeInteger(claims.exp) &&
        claims.iat <= now + 60 &&
        claims.exp > now &&
        claims.exp > claims.iat &&
        claims.exp - claims.iat <= 600 &&
        claims.exp <= now + 600 &&
        verify(
          "sha256",
          Buffer.from(parts.slice(0, 2).join(".")),
          publicKey,
          Buffer.from(parts[2], "base64url"),
        )
      );
    } catch {
      return false;
    }
  }
  function classify(request) {
    const key = `${request.method} ${request.url}`;
    if (key === `POST /app/installations/${installationId}/access_tokens`) return "mint";
    if (key === "DELETE /installation/token") return "revoke";
    if (key === `GET /repos/${repo.fullName}`) return "metadata";
    if (key === `GET /${repo.fullName}.git/info/refs?service=git-upload-pack`) return "discovery";
    if (key === `POST /${repo.fullName}.git/git-upload-pack`) return "upload-pack";
    return "unsupported";
  }
  function validate(request, body, record) {
    const op = record.operation;
    if (op === "unsupported") return 404;
    const authorizationCount = request.rawHeaders.filter(
      (_, i) => i % 2 === 0 && request.rawHeaders[i].toLowerCase() === "authorization",
    ).length;
    if (
      authorizationCount !== 1 ||
      request.headers.cookie ||
      request.headers["proxy-authorization"] ||
      request.headers["content-encoding"]
    )
      return 400;
    const isGit = op === "discovery" || op === "upload-pack";
    const localHost = `127.0.0.1:${server.address().port}`;
    const providerHost = isGit ? "github.com" : "api.github.com";
    if (![localHost, providerHost].includes(request.headers.host)) return 400;
    if (op === "mint" || op === "revoke") {
      if (
        request.headers.accept !== "application/vnd.github+json" ||
        request.headers["content-type"] !== "application/json" ||
        request.headers["user-agent"] !== "openclaw-enterprise-github-app" ||
        request.headers["x-github-api-version"] !== "2026-03-10"
      )
        return 400;
    }
    if (op === "mint") {
      record.authKind = "App JWT";
      if (!validAppJwt(request.headers.authorization)) return 401;
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        return 400;
      }
      if (
        !sameKeys(input, ["repository_ids", "permissions"]) ||
        !Array.isArray(input.repository_ids) ||
        input.repository_ids.length !== 1 ||
        input.repository_ids[0] !== repo.id ||
        !sameKeys(input.permissions, Object.keys(scope)) ||
        Object.entries(scope).some(([key, value]) => input.permissions[key] !== value)
      )
        return 422;
      record.requestedScope = { repositoryIds: [repo.id], permissions: { ...scope } };
      return 0;
    }
    const token = authToken(request, isGit ? "Basic" : "Bearer");
    record.authKind = isGit ? "Basic" : "Bearer";
    if (!token) return 401;
    record.tokenRef = token.ref;
    if (isGit && token.permissions.contents !== "read") return 403;
    if (op !== "upload-pack" && body.length) return 400;
    if (
      isGit &&
      (request.headers["git-protocol"] !== "version=2" ||
        (op === "upload-pack" &&
          request.headers["content-type"] !== "application/x-git-upload-pack-request"))
    )
      return 400;
    if (op === "metadata" && request.headers.accept !== "application/vnd.github+json") return 400;
    if (strictNativeHeaders && (isGit || op === "metadata")) {
      const accept =
        op === "discovery"
          ? "application/x-git-upload-pack-advertisement"
          : op === "upload-pack"
            ? "application/x-git-upload-pack-result"
            : "application/vnd.github+json";
      if (
        request.headers.host !== providerHost ||
        request.headers.accept !== accept ||
        request.headers["accept-encoding"] !== "identity" ||
        request.headers.connection !== "close" ||
        request.headers["user-agent"] !== (isGit ? "oce-github-git-read" : "oce-github-mediation")
      )
        return 400;
      if (isGit && body.includes(Buffer.from("thin-pack\n"))) return 400;
    }
    return 0;
  }
  const jsonResponse = (status, value) => ({
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(value)),
  });

  async function effect(request, body, record, signal) {
    const op = record.operation;
    if (op === "mint") {
      const value = `ghs_fixture_${randomBytes(24).toString("hex")}`;
      const token = {
        ref: `external-token-${tokens.size + 1}`,
        repositoryId: repo.id,
        permissions: { ...scope },
        expiresAt: clock() + tokenTtlMs,
        revoked: false,
      };
      tokens.set(value, token);
      record.tokenRef = token.ref;
      return jsonResponse(201, {
        token: value,
        expires_at: new Date(token.expiresAt).toISOString(),
        permissions: scope,
        repositories: [{ id: repo.id, full_name: repo.fullName }],
      });
    }
    if (op === "revoke") {
      const token = authToken(request, "Bearer");
      if (!token) return jsonResponse(401, { message: "Bad credentials" });
      token.revoked = true;
      return { status: 204, headers: {}, body: Buffer.alloc(0) };
    }
    if (op === "metadata") {
      const [owner, name] = repo.fullName.split("/");
      return jsonResponse(200, {
        id: repo.id,
        name,
        full_name: repo.fullName,
        private: true,
        owner: { login: owner },
        default_branch: "main",
        clone_url: `https://github.com/${repo.fullName}.git`,
        html_url: `https://github.com/${repo.fullName}`,
      });
    }
    const target = new URL(request.url, "https://github.com");
    const output = await git(["http-backend"], {
      input: body,
      signal,
      env: {
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: target.pathname,
        QUERY_STRING: target.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(body.length),
        HTTP_GIT_PROTOCOL: "version=2",
        REMOTE_ADDR: "127.0.0.1",
        REMOTE_USER: "x-access-token",
      },
    });
    const split = output.indexOf("\r\n\r\n");
    if (split < 0 || split > 16384) throw new Error("Invalid git-http-backend CGI response");
    const response = { status: 200, headers: {}, body: output.subarray(split + 4) };
    for (const line of output.subarray(0, split).toString().split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon < 1) throw new Error("Invalid git-http-backend header");
      const name = line.slice(0, colon).toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (name === "status") response.status = Number.parseInt(value, 10);
      else response.headers[name] = value;
    }
    return response;
  }

  async function pause(fault, record, signal) {
    fault.entered.resolve(publicRecord(record));
    const aborted = faultDeferred();
    const abort = () => aborted.resolve("disconnect");
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      return await Promise.race([fault.resume.promise, aborted.promise]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  async function handle(request, reply) {
    if (records.length >= maxRequests) {
      rejectedOverLimit++;
      reply.writeHead(429, { connection: "close", "content-length": "0" });
      reply.end();
      request.resume();
      return;
    }
    const operation = classify(request);
    const record = {
      sequence: records.length + 1,
      method: operation === "unsupported" ? "unsupported" : request.method,
      path: operation === "unsupported" ? "<unsupported>" : request.url,
      targetSha256: sha256(`${request.method} ${request.url}`),
      operation,
      accepted: false,
      effectCompleted: false,
      phase: "received",
      status: null,
      bodyBytes: 0,
      bodySha256: sha256(Buffer.alloc(0)),
    };
    records.push(record);
    const controller = new AbortController();
    let ownedFault;
    const timer = setTimeout(() => {
      controller.abort();
      reply.destroy();
    }, requestTimeoutMs);
    const disconnected = () => {
      if (!reply.writableFinished) {
        record.phase = "disconnected";
        controller.abort();
      }
    };
    reply.once("close", disconnected);
    request.once("aborted", disconnected);
    try {
      let response;
      if (pending.size >= 8) {
        response = jsonResponse(429, { message: "Fixture request bound reached" });
      } else {
        const chunks = [];
        for await (const chunk of request) {
          record.bodyBytes += chunk.length;
          if (record.bodyBytes > maxRequestBytes) {
            reply.destroy();
            return;
          }
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        record.bodySha256 = sha256(body);
        const refusal = validate(request, body, record);
        if (refusal)
          response = jsonResponse(refusal, { message: "External fixture request refused" });
        else {
          record.accepted = true;
          record.phase = "entered";
          const fault = faults.get(record.operation);
          if (fault) {
            ownedFault = fault;
            faults.delete(record.operation);
          }
          if (fault?.kind === "hold-after-entry") {
            if ((await pause(fault, record, controller.signal)) === "disconnect") {
              reply.destroy();
              return;
            }
          }
          if (controller.signal.aborted) return;
          response = await effect(request, body, record, controller.signal);
          record.effectCompleted = true;
          record.phase = "effect-completed";
          record.status = response.status;
          record.responseBytes = response.body.length;
          // Response hashes intentionally exclude mint responses, which contain tokens.
          if (record.operation !== "mint") record.responseSha256 = sha256(response.body);
          if (fault?.kind === "disconnect-after-effect") {
            fault.entered.resolve(publicRecord(record));
            reply.destroy();
            return;
          }
          if (fault?.kind === "hold-after-effect") {
            if ((await pause(fault, record, controller.signal)) === "disconnect") {
              reply.destroy();
              return;
            }
          }
        }
      }
      if (controller.signal.aborted) return;
      record.status = response.status;
      reply.writeHead(response.status, {
        ...response.headers,
        "content-length": response.body.length,
        connection: "close",
      });
      reply.end(response.body);
      await new Promise((resolve) => {
        if (reply.writableFinished || reply.destroyed) resolve();
        else {
          reply.once("finish", resolve);
          reply.once("close", resolve);
        }
      });
      if (reply.writableFinished) record.phase = "response-finished";
    } catch {
      record.phase = controller.signal.aborted ? "disconnected" : "external-error";
      reply.destroy();
    } finally {
      // Once consumed, the request owns settlement even if its external effect
      // fails before the requested fault phase. A reached phase stays resolved.
      ownedFault?.entered.resolve(null);
      clearTimeout(timer);
      controller.abort();
    }
  }

  async function close() {
    if (closePromise) return closePromise;
    stopped = true;
    closePromise = (async () => {
      for (const fault of faults.values()) {
        fault.entered.resolve(null);
        fault.resume.resolve("disconnect");
      }
      faults.clear();
      for (const socket of sockets) socket.destroy();
      const childExits = [...children].map(
        (child) => new Promise((resolve) => child.once("close", resolve)),
      );
      for (const child of children) child.kill("SIGKILL");
      if (server?.listening) await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled([...pending]);
      await Promise.allSettled(childExits);
      tokens.clear();
      await rm(directory, { recursive: true, force: true });
    })();
    return closePromise;
  }

  try {
    await mkdir(join(projectRoot, repo.fullName.split("/")[0]), { recursive: true, mode: 0o700 });
    await git(["init", "--bare", "--object-format=sha1", "--template=", bare]);
    await gitRepo(["config", "http.receivepack", "false"]);
    await gitRepo(["symbolic-ref", "HEAD", "refs/heads/main"]);
    const initialCommit = await advance();
    const initialFiles = filesFor(1);
    const caPath = join(directory, "external.crt");
    const tlsKeyPath = join(directory, "external.key");
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      tlsKeyPath,
      "-out",
      caPath,
      "-days",
      "1",
      "-subj",
      "/CN=Controlled GitHub read fixture",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:github.com,DNS:api.github.com",
    ]);
    await chmod(tlsKeyPath, 0o600);
    const ca = await readFile(caPath, "utf8");
    server = createServer({ key: await readFile(tlsKeyPath), cert: ca }, (request, reply) => {
      const promise = handle(request, reply);
      pending.add(promise);
      promise.finally(() => pending.delete(promise));
    });
    server.maxHeadersCount = 48;
    server.requestTimeout = requestTimeoutMs;
    server.headersTimeout = requestTimeoutMs;
    server.maxConnections = 16;
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.setTimeout(requestTimeoutMs, () => socket.destroy());
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `https://127.0.0.1:${server.address().port}`;
    return Object.freeze({
      origin,
      ca,
      caPath,
      directory,
      repository: repo,
      permissions: scope,
      endpoint: Object.freeze({ kind: "local-protocol-test", origin, ca }),
      gitUrl: `${origin}/${repo.fullName}.git`,
      initialCommit,
      expectedFiles: initialFiles,
      advance,
      currentSnapshot: () => ({ commit: currentCommit, files: { ...filesFor(revision) } }),
      observations: () => records.map(publicRecord),
      providerTokens: () => [...tokens.values()].map(snapshot),
      counters: () =>
        Object.fromEntries(
          operations.map((op) => {
            const selected = records.filter((record) => record.operation === op);
            return [
              op,
              {
                entered: selected.length,
                accepted: selected.filter((record) => record.accepted).length,
                effects: selected.filter((record) => record.effectCompleted).length,
                finished: selected.filter((record) => record.phase === "response-finished").length,
                disconnected: selected.filter((record) => record.phase === "disconnected").length,
              },
            ];
          }),
        ),
      resources: () => ({
        activeRequests: pending.size,
        sockets: sockets.size,
        children: children.size,
      }),
      rejectedOverLimit: () => rejectedOverLimit,
      faultNext(operation, kind) {
        if (
          stopped ||
          !operations.slice(0, -1).includes(operation) ||
          !faultKinds.includes(kind) ||
          faults.has(operation)
        ) {
          throw new Error("Invalid, duplicate, or closed external fixture fault");
        }
        const fault = { kind, entered: faultDeferred(), resume: faultDeferred() };
        faults.set(operation, fault);
        return Object.freeze({
          entered: fault.entered.promise,
          release: () => fault.resume.resolve("release"),
          disconnect: () => fault.resume.resolve("disconnect"),
        });
      },
      close,
    });
  } catch (error) {
    await close();
    throw error;
  }
}
