import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startGitHubReadMvpExternalService } from "../fixtures/github-read-mvp/external-service.mjs";

// These are executable tests of the controlled EXTERNAL service. They prove
// actual Git/TLS behavior and useful faults, not internal Work/State admission,
// native mediation, custody, provider currentness, or production composition.
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const app = { clientId: "Iv1.read-mvp-fixture", publicKey: keyPair.publicKey };
function jwt({ privateKey = keyPair.privateKey, iss = app.clientId, now = Date.now() } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({ iss, iat: Math.floor(now / 1000) - 60, exp: Math.floor(now / 1000) + 540 }),
  ).toString("base64url");
  const unsigned = `${header}.${claims}`;
  return `${unsigned}.${sign("sha256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
}

async function start(t, options = {}) {
  const fixture = await startGitHubReadMvpExternalService({ app, ...options });
  t.after(() => fixture.close());
  return fixture;
}
function exchange(fixture, path, { method = "GET", headers = {}, body = "", signal } = {}) {
  return new Promise((resolve, reject) => {
    const call = request(
      new URL(path, fixture.origin),
      {
        method,
        ca: fixture.ca,
        agent: false,
        signal,
        headers: { "content-length": Buffer.byteLength(body), connection: "close", ...headers },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("aborted", () => reject(new Error("External response aborted")));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    call.setTimeout(5000, () => call.destroy(new Error("Fixture client timeout")));
    call.on("error", reject);
    call.end(body);
  });
}
const providerHeaders = (authorization) => ({
  authorization: `Bearer ${authorization}`,
  accept: "application/vnd.github+json",
  "content-type": "application/json",
  "user-agent": "openclaw-enterprise-github-app",
  "x-github-api-version": "2026-03-10",
});
const metadataHeaders = (token) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
});
const gitHeaders = (token) => ({
  authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  "git-protocol": "version=2",
});
const scopeBody = (fixture) =>
  JSON.stringify({ repository_ids: [fixture.repository.id], permissions: fixture.permissions });
const mintRequest = (fixture, options = {}) =>
  exchange(fixture, "/app/installations/41/access_tokens", {
    method: "POST",
    headers: providerHeaders(jwt()),
    body: scopeBody(fixture),
    ...options,
  });
async function mint(fixture) {
  const response = await mintRequest(fixture);
  assert.equal(response.status, 201);
  const packet = JSON.parse(response.body);
  assert.deepEqual(packet.permissions, fixture.permissions);
  assert.deepEqual(packet.repositories, [
    { id: fixture.repository.id, full_name: fixture.repository.fullName },
  ]);
  return packet.token;
}
const metadata = (fixture, token, options = {}) =>
  exchange(fixture, `/repos/${fixture.repository.fullName}`, {
    headers: metadataHeaders(token),
    ...options,
  });
const discovery = (fixture, token) =>
  exchange(fixture, `/${fixture.repository.fullName}.git/info/refs?service=git-upload-pack`, {
    headers: gitHeaders(token),
  });
async function drain(fixture) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const resources = fixture.resources();
    if (resources.activeRequests === 0 && resources.children === 0 && resources.sockets === 0)
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(fixture.resources(), { activeRequests: 0, sockets: 0, children: 0 });
}
function gitClient(fixture, cwd, token, args) {
  return new Promise((resolve, reject) => {
    // The test's synthetic token is only in the child environment. Git argv,
    // remote URL and persistent repository configuration never contain it.
    const child = spawn("git", args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: cwd,
        XDG_CONFIG_HOME: cwd,
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_SSL_CAINFO: fixture.caPath,
        GIT_CONFIG_COUNT: "7",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: gitHeaders(token).authorization.replace(/^/, "Authorization: "),
        GIT_CONFIG_KEY_1: "http.sslCAInfo",
        GIT_CONFIG_VALUE_1: fixture.caPath,
        GIT_CONFIG_KEY_2: "protocol.version",
        GIT_CONFIG_VALUE_2: "2",
        GIT_CONFIG_KEY_3: "credential.helper",
        GIT_CONFIG_VALUE_3: "",
        GIT_CONFIG_KEY_4: "core.hooksPath",
        GIT_CONFIG_VALUE_4: "/dev/null",
        GIT_CONFIG_KEY_5: "protocol.allow",
        GIT_CONFIG_VALUE_5: "never",
        GIT_CONFIG_KEY_6: "protocol.https.allow",
        GIT_CONFIG_VALUE_6: "always",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      assert.ok(!output.includes(token), "Git diagnostics must not print the test credential");
      resolve({ code, output });
    });
  });
}

test(
  "external GitHub fixture: TLS, exact App scope, actual clone/fetch and read-only service",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await start(t);
    const clientHome = await mkdtemp(join(homedir(), "github-read-mvp-client-"));
    t.after(() => rm(clientHome, { recursive: true, force: true }));
    assert.equal((await stat(fixture.directory)).mode & 0o777, 0o700);
    await t.test(
      "unsigned/wrong App, broadened scope and unselected repositories refuse before mint",
      async () => {
        const wrongPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
        for (const authorization of [
          "unsigned",
          jwt({ iss: "wrong-app" }),
          jwt({ privateKey: wrongPair.privateKey }),
        ]) {
          assert.equal(
            (await mintRequest(fixture, { headers: providerHeaders(authorization) })).status,
            401,
          );
        }
        for (const body of [
          { repository_ids: [999], permissions: fixture.permissions },
          { repository_ids: [73, 999], permissions: fixture.permissions },
          { repository_ids: [73], permissions: { metadata: "read", contents: "write" } },
          { repository_ids: [73], permissions: fixture.permissions, repositories: ["unselected"] },
        ])
          assert.equal((await mintRequest(fixture, { body: JSON.stringify(body) })).status, 422);
        assert.equal(fixture.counters().mint.effects, 0);
        assert.deepEqual(fixture.providerTokens(), []);
      },
    );
    const token = await mint(fixture);
    await t.test(
      "metadata authenticates a minted token and selects the exact repository",
      async () => {
        const response = await metadata(fixture, token);
        assert.equal(response.status, 200);
        assert.equal(JSON.parse(response.body).full_name, fixture.repository.fullName);
        assert.equal(JSON.parse(response.body).id, fixture.repository.id);
        assert.equal((await metadata(fixture, "unknown-token")).status, 401);
        for (const path of [
          "/repos/other/repo",
          "/repos/fixture/repo?x=1",
          "/repos/fixture%2frepo",
        ]) {
          assert.equal(
            (await exchange(fixture, path, { headers: metadataHeaders(token) })).status,
            404,
          );
        }
        assert.equal(
          (
            await metadata(fixture, token, {
              headers: {
                ...metadataHeaders(token),
                authorization: [`Bearer ${token}`, `Bearer ${token}`],
              },
            })
          ).status,
          400,
        );
      },
    );
    const checkout = join(clientHome, "checkout");
    await t.test(
      "real Git clone and fetch verify commit identity, file bytes, ancestry and object integrity",
      async () => {
        const cloned = await gitClient(fixture, clientHome, token, [
          "clone",
          fixture.gitUrl,
          checkout,
        ]);
        assert.equal(cloned.code, 0, cloned.output);
        for (const [name, content] of Object.entries(fixture.expectedFiles))
          assert.equal(await readFile(join(checkout, name), "utf8"), content);
        const first = await gitClient(fixture, checkout, token, ["rev-parse", "HEAD"]);
        assert.equal(first.output.trim(), fixture.initialCommit);
        const next = await fixture.advance();
        assert.notEqual(next, fixture.initialCommit);
        const fetched = await gitClient(fixture, checkout, token, ["fetch", "origin"]);
        assert.equal(fetched.code, 0, fetched.output);
        const head = await gitClient(fixture, checkout, token, ["rev-parse", "origin/main"]);
        assert.equal(head.output.trim(), next);
        assert.equal(
          (
            await gitClient(fixture, checkout, token, [
              "merge-base",
              "--is-ancestor",
              fixture.initialCommit,
              "origin/main",
            ])
          ).code,
          0,
        );
        for (const [name, content] of Object.entries(fixture.currentSnapshot().files)) {
          assert.equal(
            (await gitClient(fixture, checkout, token, ["show", `origin/main:${name}`])).output,
            content,
          );
        }
        const fsck = await gitClient(fixture, checkout, token, ["fsck", "--strict", "--full"]);
        assert.equal(fsck.code, 0, fsck.output);
        const config = await readFile(join(checkout, ".git", "config"), "utf8");
        assert.ok(config.includes(fixture.gitUrl));
        assert.ok(!config.includes(token) && !config.toLowerCase().includes("authorization"));
        assert.ok(fixture.counters().discovery.effects >= 2);
        assert.ok(fixture.counters()["upload-pack"].effects >= 4);
      },
    );
    await t.test(
      "receive-pack and PR creation have no enabled route; real Git push fails",
      async () => {
        const before = fixture.currentSnapshot().commit;
        for (const [method, path] of [
          ["GET", "/fixture/repo.git/info/refs?service=git-receive-pack"],
          ["POST", "/fixture/repo.git/git-receive-pack"],
          ["POST", "/repos/fixture/repo/pulls"],
        ])
          assert.equal(
            (await exchange(fixture, path, { method, headers: metadataHeaders(token) })).status,
            404,
          );
        const pushed = await gitClient(fixture, checkout, token, ["push", "origin", "HEAD:main"]);
        assert.notEqual(pushed.code, 0);
        assert.equal(fixture.currentSnapshot().commit, before);
        assert.equal(fixture.counters().unsupported.effects, 0);
      },
    );
    await t.test(
      "revocation denies both metadata and actual Git fetch using the exact minted token",
      async () => {
        const response = await exchange(fixture, "/installation/token", {
          method: "DELETE",
          headers: providerHeaders(token),
        });
        assert.equal(response.status, 204);
        assert.equal((await metadata(fixture, token)).status, 401);
        assert.notEqual((await gitClient(fixture, checkout, token, ["fetch", "origin"])).code, 0);
        assert.ok(fixture.providerTokens()[0].revoked);
        const observations = JSON.stringify(fixture.observations());
        assert.ok(!observations.includes(token));
        assert.ok(!observations.includes("Bearer ") && !observations.includes("Basic "));
        const changed = fixture.observations();
        changed[0].accepted = true;
        assert.equal(fixture.observations()[0].accepted, false);
      },
    );
    await drain(fixture);
  },
);

test(
  "external GitHub fixture: deterministic entered/committed response faults and bounded cleanup",
  { timeout: 30_000 },
  async (t) => {
    const fixture = await start(t);
    const token = await mint(fixture);
    await t.test(
      "client abort during an entered hold drains without executing the external operation",
      async () => {
        const controller = new AbortController();
        const fault = fixture.faultNext("metadata", "hold-after-entry");
        const response = metadata(fixture, token, { signal: controller.signal });
        const rejected = assert.rejects(response);
        const entered = await fault.entered;
        assert.equal(entered.phase, "entered");
        assert.equal(entered.effectCompleted, false);
        assert.equal(fixture.counters().metadata.effects, 0);
        controller.abort();
        await rejected;
        await drain(fixture);
        assert.equal(fixture.counters().metadata.disconnected, 1);
        assert.equal(fixture.counters().metadata.effects, 0);
      },
    );
    await t.test(
      "held response is released once, with request/effect counters independent of replies",
      async () => {
        const fault = fixture.faultNext("metadata", "hold-after-effect");
        const response = metadata(fixture, token);
        assert.equal((await fault.entered).effectCompleted, true);
        assert.equal(fixture.counters().metadata.effects, 1);
        assert.equal(fixture.counters().metadata.finished, 0);
        fault.release();
        fault.release();
        assert.equal((await response).status, 200);
        await drain(fixture);
        assert.equal(fixture.counters().metadata.finished, 1);
      },
    );
    await t.test(
      "lost mint response keeps provider-issued token evidence without inventing a client result",
      async () => {
        const previous = fixture.counters().mint;
        const fault = fixture.faultNext("mint", "disconnect-after-effect");
        const response = assert.rejects(mintRequest(fixture));
        const entered = await fault.entered;
        assert.equal(entered.effectCompleted, true);
        await response;
        await drain(fixture);
        assert.equal(fixture.counters().mint.entered, previous.entered + 1);
        assert.equal(fixture.counters().mint.effects, previous.effects + 1);
        assert.equal(fixture.counters().mint.finished, previous.finished);
        assert.equal(fixture.providerTokens().length, 2);
        assert.ok(
          fixture.providerTokens().some((item) => item.ref === entered.tokenRef && !item.revoked),
        );
        assert.ok(!JSON.stringify(fixture.providerTokens()).includes("ghs_fixture_"));
      },
    );
    await t.test("lost revocation reply differs from external revocation state", async () => {
      const fault = fixture.faultNext("revoke", "hold-after-effect");
      const response = assert.rejects(
        exchange(fixture, "/installation/token", {
          method: "DELETE",
          headers: providerHeaders(token),
        }),
      );
      assert.equal((await fault.entered).status, 204);
      assert.equal((await metadata(fixture, token)).status, 401);
      fault.disconnect();
      await response;
      await drain(fixture);
      assert.equal(fixture.counters().revoke.effects, 1);
      assert.equal(fixture.counters().revoke.finished, 0);
    });
    await t.test(
      "lost real Git backend reply fails the Git client and exposes one provider entry",
      async () => {
        const clientHome = await mkdtemp(join(homedir(), "github-read-mvp-fault-client-"));
        t.after(() => rm(clientHome, { recursive: true, force: true }));
        const liveToken = await mint(fixture);
        const before = fixture.counters()["upload-pack"].entered;
        const fault = fixture.faultNext("upload-pack", "disconnect-after-effect");
        const cloned = gitClient(fixture, clientHome, liveToken, [
          "clone",
          fixture.gitUrl,
          join(clientHome, "failed-clone"),
        ]);
        const entered = await fault.entered;
        assert.equal(entered.status, 200);
        assert.ok(entered.responseBytes > 0);
        assert.notEqual((await cloned).code, 0);
        await drain(fixture);
        assert.equal(fixture.counters()["upload-pack"].entered, before + 1);
      },
    );
    await t.test(
      "close disconnects pending work, removes owned private temp state and is idempotent",
      async () => {
        const liveToken = await mint(fixture);
        const fault = fixture.faultNext("metadata", "hold-after-entry");
        const neverEntered = fixture.faultNext("discovery", "hold-after-entry");
        const response = assert.rejects(metadata(fixture, liveToken));
        await fault.entered;
        await fixture.close();
        await response;
        assert.equal(await neverEntered.entered, null);
        assert.deepEqual(fixture.resources(), { activeRequests: 0, sockets: 0, children: 0 });
        await assert.rejects(stat(fixture.directory), { code: "ENOENT" });
        await fixture.close();
      },
    );
  },
);

test(
  "external GitHub fixture: failed Git backend settles a consumed after-effect fault",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await start(t);
    const token = await mint(fixture);
    const faults = [];
    for (const kind of ["hold-after-effect", "disconnect-after-effect"]) {
      const fault = fixture.faultNext("upload-pack", kind);
      faults.push(fault);
      // Authentication consumes the armed fault before the real Git backend
      // rejects this malformed RPC. Its after-effect phase can never be reached.
      await assert.rejects(
        exchange(fixture, "/fixture/repo.git/git-upload-pack", {
          method: "POST",
          headers: {
            ...gitHeaders(token),
            "content-type": "application/x-git-upload-pack-request",
          },
          body: "garbage\n",
        }),
        { code: "ECONNRESET" },
      );
      let timer;
      try {
        const entered = await Promise.race([
          fault.entered,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Consumed fault did not settle after backend failure")),
              1000,
            );
          }),
        ]);
        assert.equal(entered, null);
      } finally {
        clearTimeout(timer);
      }
      fault.release();
      fault.disconnect();
      await drain(fixture);
    }
    const counts = fixture.counters()["upload-pack"];
    assert.equal(counts.entered, 2);
    assert.equal(counts.accepted, 2);
    assert.equal(counts.effects, 0);
    assert.equal(counts.finished, 0);
    const records = fixture.observations().filter((record) => record.operation === "upload-pack");
    assert.equal(records.length, 2);
    assert.ok(
      records.every((record) => record.effectCompleted === false && record.status === null),
    );
    await fixture.close();
    assert.deepEqual(await Promise.all(faults.map((fault) => fault.entered)), [null, null]);
    assert.deepEqual(fixture.resources(), { activeRequests: 0, sockets: 0, children: 0 });
    await assert.rejects(stat(fixture.directory), { code: "ENOENT" });
  },
);

test(
  "external GitHub fixture: metadata-only scope, expiry and exact native request headers",
  { timeout: 15_000 },
  async (t) => {
    let now = Date.now();
    const fixture = await start(t, {
      permissions: { metadata: "read" },
      clock: () => now,
      strictNativeHeaders: true,
    });
    const token = await mint(fixture);
    const headers = {
      ...metadataHeaders(token),
      host: "api.github.com",
      "accept-encoding": "identity",
      "user-agent": "oce-github-mediation",
    };
    assert.equal((await metadata(fixture, token, { headers })).status, 200);
    assert.equal((await metadata(fixture, token)).status, 400);
    assert.equal((await discovery(fixture, token)).status, 403);
    now += 120_001;
    assert.equal((await metadata(fixture, token, { headers })).status, 401);
    assert.equal(fixture.counters().metadata.effects, 1);
    assert.equal(fixture.counters().discovery.effects, 0);
  },
);

test("external GitHub fixture refuses unsafe temp locations and unsupported permission setup", async () => {
  await assert.rejects(
    startGitHubReadMvpExternalService({ app, tempParent: "/tmp" }),
    /under the current home/,
  );
  await assert.rejects(
    startGitHubReadMvpExternalService({ app, permissions: { contents: "write" } }),
    /read-only permissions/,
  );
  await assert.rejects(
    startGitHubReadMvpExternalService({ app: { ...app, publicKey: keyPair.privateKey } }),
    /public KeyObject/,
  );
});

test(
  "external GitHub fixture bounds retained requests and redacts unselected targets",
  { timeout: 10_000 },
  async (t) => {
    const fixture = await start(t, {
      maxRequests: 2,
      maxRequestBytes: 512,
      requestTimeoutMs: 1000,
    });
    const token = await mint(fixture);
    assert.equal((await exchange(fixture, `/unknown?token=${token}`)).status, 404);
    assert.equal((await metadata(fixture, token)).status, 429);
    assert.equal(fixture.observations().length, 2);
    assert.equal(fixture.rejectedOverLimit(), 1);
    assert.ok(!JSON.stringify(fixture.observations()).includes(token));
    assert.equal(fixture.observations()[1].path, "<unsupported>");
    await drain(fixture);
  },
);
