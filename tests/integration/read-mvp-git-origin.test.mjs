import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:https";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createGitOrigin } from "../fixtures/read-mvp/git-origin.mjs";

// These cases exercise the lifecycle adapter and its actual external provider.
// The canonical external-service suite owns real clone/fetch/fsck/push coverage.
// No case here supplies platform authority or proves the product proxy path.
const selected = process.env.OCC_READ_MVP_GIT_ORIGIN_TEST === "1";
const options = {
  timeout: 15000,
  skip: selected ? false : "Select OCC_READ_MVP_GIT_ORIGIN_TEST=1 and OCC_READ_MVP_TEST_ROOT.",
};

async function setup(t) {
  const parent = process.env.OCC_READ_MVP_TEST_ROOT;
  assert.ok(parent && isAbsolute(parent), "Select an existing absolute disposable root under home");
  assert.ok((await stat(parent)).isDirectory());
  const root = await mkdtemp(join(parent, "read-origin-adapter-"));
  const origins = [];
  t.after(async () => {
    // Stop listeners and Git children before removing the caller-owned parent.
    await Promise.all(origins.map((origin) => origin.close()));
    await rm(root, { recursive: true, force: true });
  });
  // Only this direct external-service test client owns this key. No App key,
  // JWT or synthetic installation token is injected into a product component.
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const app = { clientId: "Iv1.read-origin-adapter", publicKey: keyPair.publicKey };
  const start = async (changes = {}) => {
    const origin = await createGitOrigin({ root, app, signal: t.signal, ...changes });
    origins.push(origin);
    return origin;
  };
  return { root, app, keyPair, start };
}

function exchange(origin, path, { method = "GET", headers = {}, body = "", signal } = {}) {
  const pending = new Promise((resolve, reject) => {
    const call = request(
      new URL(path, origin.endpoint.origin),
      {
        method,
        ca: origin.ca,
        agent: false,
        signal,
        headers: { connection: "close", "content-length": Buffer.byteLength(body), ...headers },
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 64 * 1024) return call.destroy(new Error("Adapter test response limit"));
          chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("aborted", () => reject(new Error("External response aborted")));
        response.once("end", () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks) }),
        );
      },
    );
    call.setTimeout(2500, () => call.destroy(new Error("Adapter test request deadline")));
    call.once("error", reject);
    call.end(body);
  });
  void pending.catch(() => {});
  return pending;
}

async function mint(origin, fixture) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({ iss: fixture.app.clientId, iat: now - 30, exp: now + 300 }),
  ).toString("base64url");
  const unsigned = `${header}.${claims}`;
  const jwt = `${unsigned}.${sign("sha256", Buffer.from(unsigned), fixture.keyPair.privateKey).toString("base64url")}`;
  const response = await exchange(origin, "/app/installations/41/access_tokens", {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "openclaw-enterprise-github-app",
      "x-github-api-version": "2026-03-10",
    },
    body: JSON.stringify({
      repository_ids: [origin.repository.id],
      permissions: { metadata: "read", contents: "read" },
    }),
  });
  assert.equal(response.status, 201);
  const packet = JSON.parse(response.body);
  assert.deepEqual(packet.repositories, [
    { id: origin.repository.id, full_name: origin.repository.fullName },
  ]);
  assert.deepEqual(packet.permissions, { metadata: "read", contents: "read" });
  return packet.token;
}

const gitHeaders = (token) => ({
  authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  "git-protocol": "version=2",
});
const discoveryPath = (origin) =>
  `/${origin.repository.fullName}.git/info/refs?service=git-upload-pack`;
async function drained(origin) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const { activeRequests, sockets, children } = origin.state;
    if (activeRequests === 0 && sockets === 0 && children === 0) return;
    await delay(5);
  }
  assert.deepEqual(origin.external.resources(), { activeRequests: 0, sockets: 0, children: 0 });
}

test(
  "origin adapter rejects implicit App authority and unsupported setup before creating state",
  options,
  async (t) => {
    const fixture = await setup(t);
    const before = await readdir(fixture.root);
    for (const change of [
      { host: "0.0.0.0" },
      { port: 8080 },
      { app: undefined },
      { token: "unsupported-injected-value" },
      { limits: { unknown: 1 } },
      { limits: { maxResponseBytes: 1023 } },
      { limits: { maxRequests: 65 } },
      { signal: AbortSignal.abort() },
    ]) {
      await assert.rejects(createGitOrigin({ root: fixture.root, app: fixture.app, ...change }));
    }
    assert.deepEqual(await readdir(fixture.root), before);
  },
);

test(
  "origin adapter serializes real external advances and rejects invented file-update arguments",
  options,
  async (t) => {
    const fixture = await setup(t);
    const origin = await fixture.start();
    assert.match(origin.url, /^https:\/\/127\.0\.0\.1:\d+\/fixture\/repo\.git$/);
    assert.equal(origin.url, origin.external.gitUrl);
    assert.deepEqual(origin.gitConfig, {
      "protocol.version": "2",
      "http.sslCAInfo": origin.caPath,
    });
    assert.deepEqual(origin.gitEnvironment, { GIT_SSL_CAINFO: origin.caPath });
    assert.equal(await readFile(origin.caPath, "utf8"), origin.ca);
    await assert.rejects(
      origin.addCommit({ files: { "fake.txt": "unsupported" } }),
      /no arguments/,
    );
    const [second, third] = await Promise.all([origin.addCommit(), origin.addCommit()]);
    assert.match(second.oid, /^[a-f0-9]{40}$/);
    assert.match(third.oid, /^[a-f0-9]{40}$/);
    assert.equal(second.parent, origin.initialCommit);
    assert.equal(third.parent, second.oid);
    assert.notEqual(second.oid, third.oid);
    assert.match(second.files["data.txt"], /revision=2\n/);
    assert.match(third.files["data.txt"], /revision=3\n/);
    assert.equal(origin.external.currentSnapshot().commit, third.oid);
    // Snapshot mutation cannot change the actual canonical provider repository.
    third.files["data.txt"] = "caller edit";
    assert.match(origin.external.currentSnapshot().files["data.txt"], /revision=3\n/);
  },
);

for (const phase of ["hold-after-entry", "hold-after-effect"]) {
  test(`origin parent cancellation drains actual Git discovery at ${phase}`, options, async (t) => {
    const fixture = await setup(t);
    const sentinel = join(fixture.root, "caller-owned.txt");
    await writeFile(sentinel, "retain caller state\n");
    const controller = new AbortController();
    const origin = await fixture.start({ signal: controller.signal });
    const token = await mint(origin, fixture);
    const fault = origin.external.faultNext("discovery", phase);
    const response = exchange(origin, discoveryPath(origin), { headers: gitHeaders(token) });
    const rejected = assert.rejects(response);
    const entered = await fault.entered;
    const afterEffect = phase === "hold-after-effect";
    assert.equal(entered.accepted, true);
    assert.equal(entered.effectCompleted, afterEffect);
    if (afterEffect) {
      // Actual git-http-backend completed before the withheld response. A
      // caller cancellation must not erase that external effect observation.
      assert.equal(entered.status, 200);
      assert.ok(entered.responseBytes > 0);
    }
    controller.abort();
    assert.equal(origin.state.closed, true);
    const closing = origin.close();
    assert.equal(origin.close(), closing);
    await closing;
    await rejected;
    assert.deepEqual(origin.state, { closed: true, activeRequests: 0, sockets: 0, children: 0 });
    await assert.rejects(stat(origin.directory), { code: "ENOENT" });
    assert.equal(await readFile(sentinel, "utf8"), "retain caller state\n");
    assert.equal(origin.external.counters().discovery.effects, afterEffect ? 1 : 0);
    assert.equal(origin.external.counters().discovery.finished, 0);
    await assert.rejects(origin.addCommit(), /closed/);
    const evidence = JSON.stringify(origin.requests);
    assert.ok(!evidence.includes(token));
    assert.ok(!evidence.includes("Bearer ") && !evidence.includes("Basic "));
  });
}

test(
  "origin forwards request/body bounds to the canonical provider and detaches evidence",
  options,
  async (t) => {
    const fixture = await setup(t);
    const origin = await fixture.start({ limits: { maxRequests: 3, maxRequestBytes: 256 } });
    const token = await mint(origin, fixture);
    await assert.rejects(
      exchange(origin, `/${origin.repository.fullName}.git/git-upload-pack`, {
        method: "POST",
        headers: { ...gitHeaders(token), "content-type": "application/x-git-upload-pack-request" },
        body: "x".repeat(257),
      }),
    );
    await drained(origin);
    assert.equal((await exchange(origin, "/unselected?opaque=redaction-marker")).status, 404);
    assert.equal(
      (await exchange(origin, discoveryPath(origin), { headers: gitHeaders(token) })).status,
      429,
    );
    await drained(origin);
    assert.equal(origin.requests.length, 3);
    assert.equal(origin.external.rejectedOverLimit(), 1);
    assert.equal(origin.requests[1].bodyBytes, 257);
    assert.equal(origin.requests[1].accepted, false);
    assert.equal(origin.requests[1].effectCompleted, false);
    assert.equal(origin.requests[2].path, "<unsupported>");
    const snapshot = origin.requests;
    snapshot[0].accepted = false;
    assert.equal(origin.requests[0].accepted, true);
    const evidence = JSON.stringify(origin.requests);
    assert.ok(!evidence.includes("redaction-marker") && !evidence.includes(token));
  },
);

test(
  "origin lifetime expiry settles an unentered fault and preserves sibling directories",
  options,
  async (t) => {
    const fixture = await setup(t);
    const sibling = join(fixture.root, "sibling");
    await mkdir(sibling);
    const origin = await fixture.start({ limits: { lifetimeMilliseconds: 300 } });
    const unused = origin.external.faultNext("discovery", "hold-after-entry");
    // An armed operation that never arrives settles as null when the adapter's
    // own lifetime closes the canonical service; it does not invent an entry.
    assert.equal(await unused.entered, null);
    await origin.close();
    assert.deepEqual(origin.state, { closed: true, activeRequests: 0, sockets: 0, children: 0 });
    assert.ok((await stat(sibling)).isDirectory());
    await assert.rejects(stat(origin.directory), { code: "ENOENT" });
  },
);
