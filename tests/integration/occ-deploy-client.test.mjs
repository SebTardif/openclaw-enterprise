import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  lstat,
  chmod,
  mkdir,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import http from "node:http";
import test from "node:test";
import {
  parseLifecycleDeployJsonV2,
  canonicalLifecycleDeployCommandV2,
} from "../../packages/contracts/src/lifecycle-deploy-v2.ts";
import { parseLifecycleAdmissionV1 } from "../../packages/contracts/src/lifecycle-admission-v1.ts";
import { parseLifecycleObservationResponseV1 } from "../../packages/contracts/src/lifecycle-observation-v1.ts";

// Actual CLI children and local filesystem/HTTP transport only. Synthetic codec
// values below establish no controller authentication, COMMIT, provider effect,
// deployment qualification, serving observation, or termination guarantee.
const cli = fileURLToPath(new URL("../../scripts/occ-deploy.mjs", import.meta.url));
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const secret = "synthetic-credential-canary-do-not-retain";
const payloadSecret = "synthetic-backend-canary-do-not-retain";
const binding = () => ({
  action: "agent.deploy",
  scope: {
    installationId: `ins_${uuid(1)}`,
    namespaceId: `ns_${uuid(2)}`,
    agentId: `agt_${uuid(3)}`,
  },
  command: {
    schemaVersion: 2,
    operationRef: uuid(4),
    expectedLifecycleGeneration: 2,
    revisionSource: "saved-draft",
    expectedDraft: {
      configurationId: `cfg_${uuid(5)}`,
      configurationGeneration: 7,
      providerId: null,
      executionMode: "embedded",
      serviceAccountId: null,
      workloadProfileSelection: {
        manifestRef: uuid(6),
        manifestDigest: `sha256:${"a".repeat(64)}`,
        admissionRef: uuid(7),
        admissionVersion: 9,
      },
    },
  },
});
const operation = () => ({
  operationRef: uuid(4),
  lifecycleGeneration: 3,
  acceptedAt: "2026-09-08T00:00:00.000Z",
  kind: "deploy",
  revisionSource: "saved-draft",
  desiredMode: "running",
});
const receipt = () =>
  parseLifecycleAdmissionV1("mutationReceipt", { disposition: "accepted", operation: operation() });
const readback = () =>
  parseLifecycleObservationResponseV1(
    "readOperation",
    {
      schemaVersion: 1,
      namespaceId: binding().scope.namespaceId,
      agentId: binding().scope.agentId,
      operationRef: uuid(4),
    },
    {
      operation: { ...operation(), requestedRevisionId: `rev_${uuid(8)}` },
      observation: {
        phase: "pending",
        attempt: 0,
        step: "observe",
        reasonCode: "NOT_OBSERVED",
        observedAt: null,
        recordedAt: null,
        retryAt: null,
      },
    },
  );
const envelope = (data) => ({ data, meta: { requestId: `req_${uuid(9)}` } });
const wire = (data) => JSON.stringify(envelope(data));
const clone = (value) => JSON.parse(JSON.stringify(value));
const safeOutput = (result) => {
  assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
  assert.ok(!result.stdout.includes(payloadSecret) && !result.stderr.includes(payloadSecret));
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "occ-deploy-client-"));
  await chmod(root, 0o700);
  const state = join(root, "retained");
  const input = join(root, "input.json");
  const key = join(root, "key.json");
  await writeFile(input, JSON.stringify(binding(), null, 2), { mode: 0o600 });
  await writeFile(key, JSON.stringify({ data: { key: secret } }), { mode: 0o600 });
  const requests = [],
    sockets = new Set(),
    children = new Set(),
    failures = [];
  let connections = 0;
  let handle = async (req, res) => {
    res.writeHead(req.method === "POST" ? 202 : 200, { "content-type": "application/json" });
    res.end(wire(req.method === "POST" ? receipt() : readback()));
  };
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const entry = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      requests.push(entry);
      await handle(req, res, entry);
    } catch (error) {
      failures.push(error);
      res.destroy();
    }
  });
  server.on("connection", (socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((yes) => server.listen(0, "127.0.0.1", yes));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { PATH: process.env.PATH, OCC_URL: origin, OCC_SERVICE_KEY_FILE: key };
  const start = (args, overrides = {}) => {
    const selected = { ...env, ...overrides };
    for (const [name, value] of Object.entries(selected))
      if (value === undefined) delete selected[name];
    // No credential bytes are process arguments; only private file selectors.
    const child = spawn(process.execPath, [cli, ...args], {
      env: selected,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.ok(
      child.spawnargs.every((arg) => !arg.includes(secret) && !arg.includes(payloadSecret)),
    );
    children.add(child);
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const done = new Promise((yes, no) => {
      child.once("error", no);
      child.once("close", (code, signal) => {
        children.delete(child);
        yes({ code, signal, stdout, stderr });
      });
    });
    return { child, done };
  };
  const run = async (args, overrides) => {
    const { child, done } = start(args, overrides);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 40_000);
    try {
      const result = await done;
      safeOutput(result);
      return result;
    } finally {
      clearTimeout(timeout);
    }
  };
  t.after(async () => {
    const unsettled = children.size;
    const settlements = [...children].map(
      (child) =>
        new Promise((yes) => {
          child.once("close", yes);
          child.kill("SIGKILL");
        }),
    );
    await Promise.all(settlements);
    const closed = new Promise((yes) => server.close(yes));
    for (const socket of sockets) socket.destroy();
    await closed;
    // Assert actual listener/child settlement, including on failed test cleanup.
    assert.equal(server.listening, false);
    assert.equal(children.size, 0);
    assert.equal(unsettled, 0, "CLI children must settle before cleanup");
    assert.deepEqual(failures, []);
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    state,
    input,
    key,
    origin,
    requests,
    start,
    run,
    get connections() {
      return connections;
    },
    set handler(value) {
      handle = value;
    },
    prepare: () => run(["prepare", state, input]),
  };
}

async function retainedContents(path) {
  const files = await readdir(path);
  return Promise.all(
    files.map(async (name) => {
      assert.equal((await lstat(join(path, name))).mode & 0o077, 0);
      const content = await readFile(join(path, name), "utf8");
      assert.ok(!content.includes(secret) && !content.includes(payloadSecret));
      return { name, content };
    }),
  );
}

test(
  "prepare publishes private canonical bytes before the first POST, across independent processes",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await f.prepare()).code, 0);
    assert.equal(f.connections, 0);
    assert.equal((await lstat(f.state)).mode & 0o777, 0o700);
    const canonical = canonicalLifecycleDeployCommandV2(binding().scope, binding().command);
    const command = JSON.stringify(JSON.parse(canonical).command);
    assert.equal(await readFile(join(f.state, "binding.json"), "utf8"), canonical);
    assert.equal(await readFile(join(f.state, "command.json"), "utf8"), command);
    // A changed source draft cannot rebuild a prepared operation on process restart.
    const changed = binding();
    changed.command.operationRef = uuid(20);
    changed.command.expectedDraft.configurationGeneration++;
    await writeFile(f.input, JSON.stringify(changed));
    f.handler = async (req, res, entry) => {
      if (req.method === "POST") {
        // Independent reader proves complete original retained bytes and marker are
        // visible at receipt of the first network request. Fsync durability itself
        // relies on the local filesystem contract, not a simulated power failure.
        const reader = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            "import{readFileSync}from'node:fs';import{join}from'node:path';const p=process.argv[1];process.stdout.write(JSON.stringify(['binding.json','command.json','target.json','prepared','may-have-sent'].map(n=>readFileSync(join(p,n),'utf8'))));",
            f.state,
          ],
          { encoding: "utf8", timeout: 3000 },
        );
        assert.equal(reader.status, 0);
        const visible = JSON.parse(reader.stdout);
        assert.equal(visible[0], canonical);
        assert.equal(visible[1], entry.body);
        assert.equal(visible[3], JSON.stringify({ origin: f.origin, authOrigin: f.origin }));
        assert.equal(visible[4], "may-have-sent\n");
        assert.equal(entry.body, command);
        assert.equal(entry.headers["x-api-key"], secret);
        assert.deepEqual(
          JSON.parse(entry.body),
          JSON.parse(JSON.stringify(parseLifecycleDeployJsonV2("command", command))),
        );
      }
      res.writeHead(req.method === "POST" ? 202 : 200, { "content-type": "application/json" });
      res.end(wire(req.method === "POST" ? receipt() : readback()));
    };
    const sent = await f.run(["send", f.state]);
    assert.equal(sent.code, 0);
    assert.match(sent.stdout, /"kind":"admission"/);
    assert.equal((await f.run(["send", f.state])).code, 1);
    const read = await f.run(["read", f.state]);
    assert.equal(read.code, 0);
    assert.match(read.stdout, /"kind":"operation-history"/);
    assert.ok(!read.stdout.includes('"serving":true'));
    assert.deepEqual(
      f.requests.map((r) => r.method),
      ["POST", "GET"],
    );
    assert.equal(
      f.requests[1].url,
      `/namespaces/${binding().scope.namespaceId}/agents/${binding().scope.agentId}/lifecycle/operations/${uuid(4)}`,
    );
    const files = await retainedContents(f.state);
    assert.equal(
      files.find((x) => x.name === "acknowledgement.json").content,
      JSON.stringify({ kind: "admission", operation: receipt().operation }),
    );
    assert.equal(files.filter((x) => x.name.startsWith("readback-")).length, 1);
  },
);

test(
  "invalid, unsafe and failed preparations open zero connections and cannot send",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    for (const bytes of [
      "{}",
      '{"action":"agent.deploy","action":"agent.deploy"}',
      " ".repeat(65_537),
      Buffer.from([0xff]),
      JSON.stringify(binding()).replace('"schemaVersion":2', '"schemaVersion":2e0'),
    ]) {
      await writeFile(f.input, bytes);
      assert.equal((await f.prepare()).code, 1);
      assert.equal((await f.run(["send", f.state])).code, 1);
    }
    await writeFile(f.input, JSON.stringify(binding()));
    await chmod(f.input, 0o644);
    assert.equal((await f.prepare()).code, 1);
    await chmod(f.input, 0o600);
    assert.equal((await f.run(["prepare", join(f.root, "absent", "retained"), f.input])).code, 1);
    const unsafe = join(f.root, "unsafe");
    await mkdir(unsafe, { mode: 0o755 });
    assert.equal((await f.run(["prepare", join(unsafe, "retained"), f.input])).code, 1);
    await symlink(unsafe, f.state);
    assert.equal((await f.prepare()).code, 1);
    await rm(f.state);
    assert.equal((await f.prepare()).code, 0);
    const before = await readFile(join(f.state, "binding.json"));
    assert.equal((await f.prepare()).code, 1);
    assert.deepEqual(await readFile(join(f.state, "binding.json")), before);
    assert.equal(f.connections, 0);
  },
);

test(
  "retained target, command and origin alterations refuse before connecting",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await f.prepare()).code, 0);
    for (const name of ["binding.json", "command.json", "target.json"]) {
      const path = join(f.state, name),
        original = await readFile(path, "utf8");
      await writeFile(path, original.replace(uuid(name === "target.json" ? 3 : 4), uuid(29)));
      assert.equal((await f.run(["send", f.state])).code, 1);
      await writeFile(path, original);
    }
    for (const selected of [
      "https://controller.example",
      `${f.origin}/`,
      `${f.origin}?key=${secret}`,
      `http://user:${secret}@127.0.0.1`,
    ]) {
      assert.equal((await f.run(["send", f.state], { OCC_URL: selected })).code, 1);
    }
    const targetPath = join(f.state, "target.json"),
      originalTarget = await readFile(targetPath, "utf8");
    for (const field of ["origin", "authOrigin"]) {
      const changedTarget = JSON.parse(originalTarget);
      changedTarget[field] = "https://controller.example";
      await writeFile(targetPath, JSON.stringify(changedTarget));
      assert.equal((await f.run(["send", f.state], { OCC_URL: undefined })).code, 1);
      await writeFile(targetPath, originalTarget);
    }
    assert.equal(f.connections, 0);
    await retainedContents(f.state);
  },
);

for (const failure of ["dropped", "interrupted", "deadline"]) {
  test(
    `received POST with ${failure} response stays uncertain across process restart; only exact GET follows`,
    { timeout: 45_000 },
    async (t) => {
      const f = await fixture(t);
      assert.equal((await f.prepare()).code, 0);
      let seen;
      const received = new Promise((yes) => {
        seen = yes;
      });
      f.handler = async (req, res) => {
        if (req.method === "POST") {
          seen();
          if (failure === "dropped") res.destroy();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(wire(readback()));
      };
      const started = f.start(["send", f.state]);
      await received;
      if (failure === "interrupted") started.child.kill("SIGKILL");
      const sent = await started.done;
      safeOutput(sent);
      assert.notEqual(sent.code, 0);
      assert.equal((await f.run(["send", f.state])).code, 1);
      assert.equal((await f.run(["read", f.state])).code, 0);
      assert.deepEqual(
        f.requests.map((r) => r.method),
        ["POST", "GET"],
      );
      assert.ok(!(await readdir(f.state)).includes("acknowledgement.json"));
      await retainedContents(f.state);
    },
  );
}

test(
  "interrupted empty or partial dispatch markers permit readback and permanently refuse another send",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await f.prepare()).code, 0);
    // Model the observable empty/partial file left by an interrupted exclusive
    // write; this is client recovery, not a server accepted operation claim.
    for (const marker of ["", "may-have-"]) {
      await writeFile(join(f.state, "may-have-sent"), marker, { mode: 0o600 });
      assert.equal((await f.run(["send", f.state])).code, 1);
      assert.equal((await f.run(["read", f.state])).code, 0);
    }
    assert.deepEqual(
      f.requests.map((r) => r.method),
      ["GET", "GET"],
    );
  },
);

test(
  "concurrent send processes consume exactly one durable dispatch opportunity",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await f.prepare()).code, 0);
    const results = await Promise.all([f.run(["send", f.state]), f.run(["send", f.state])]);
    assert.deepEqual(results.map((r) => r.code).sort(), [0, 1]);
    assert.deepEqual(
      f.requests.map((r) => r.method),
      ["POST"],
    );
    assert.equal((await f.run(["read", f.state])).code, 0);
    await retainedContents(f.state);
  },
);

test(
  "wrong, malformed, truncated, foreign and denied responses never create acknowledgements or allow resend",
  { timeout: 35_000 },
  async (t) => {
    const f = await fixture(t);
    const badRef = clone(receipt());
    badRef.operation.operationRef = uuid(30);
    const badGeneration = clone(receipt());
    badGeneration.operation.lifecycleGeneration++;
    const wrongKind = {
      disposition: "accepted",
      operation: { ...operation(), kind: "stop", revisionSource: null, desiredMode: "stopped" },
    };
    parseLifecycleAdmissionV1("mutationReceipt", wrongKind);
    const cases = [
      { body: wire(badRef) },
      { body: wire(badGeneration) },
      { body: wire(wrongKind) },
      { body: JSON.stringify({ data: receipt(), meta: { requestId: [`req_${uuid(9)}`] } }) },
      { body: wire({ id: `rev_${uuid(8)}`, secret: payloadSecret }) },
      { body: '{"data":' },
      { body: Buffer.from([0xff]) },
      {
        body: wire(receipt()).replace(
          '"disposition":"accepted"',
          '"disposition":"accepted","disposition":"accepted"',
        ),
      },
      { body: wire(receipt()).replace('"lifecycleGeneration":3', '"lifecycleGeneration":3e0') },
      { body: "x".repeat(65_537) },
      { body: wire(receipt()).slice(0, -1), truncated: true },
      { status: 403, body: wire({ message: payloadSecret }) },
      { status: 503, body: wire({ message: payloadSecret }) },
      { status: 302, body: wire(receipt()) },
    ];
    for (const [i, entry] of cases.entries()) {
      const state = join(f.root, `bad-${i}`);
      assert.equal((await f.run(["prepare", state, f.input])).code, 0);
      f.handler = async (_req, res) => {
        res.writeHead(entry.status ?? 202, {
          "content-type": "application/json",
          ...(entry.truncated ? { "content-length": Buffer.byteLength(entry.body) + 10 } : {}),
          ...(entry.status === 302 ? { location: `${f.origin}/redirect-target` } : {}),
        });
        res.end(entry.body);
      };
      assert.equal((await f.run(["send", state])).code, 1);
      assert.equal((await f.run(["send", state])).code, 1);
      assert.ok(!(await readdir(state)).includes("acknowledgement.json"));
      await retainedContents(state);
    }
    assert.equal(f.requests.length, cases.length);
    assert.ok(f.requests.every((r) => r.method === "POST" && r.url.endsWith("/deploy")));
  },
);

test(
  "each read uses current credentials; foreign, denied, absent or invalid history remains unresolved",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await f.prepare()).code, 0);
    assert.equal((await f.run(["read", f.state])).code, 1);
    assert.equal(f.connections, 0);
    assert.equal((await f.run(["send", f.state])).code, 0);
    const badRef = clone(readback());
    badRef.operation.operationRef = uuid(31);
    const wrongKind = clone(readback());
    Object.assign(wrongKind.operation, {
      kind: "stop",
      revisionSource: null,
      desiredMode: "stopped",
    });
    const invalid = clone(readback());
    invalid.observation.secret = payloadSecret;
    for (const [status, body] of [
      [401, wire({ message: payloadSecret })],
      [403, wire({ message: payloadSecret })],
      [404, wire({ message: payloadSecret })],
      [503, wire({ message: payloadSecret })],
      [200, wire(badRef)],
      [200, wire(wrongKind)],
      [200, wire(invalid)],
      [200, '{"data":'],
      [200, wire(receipt())],
    ]) {
      f.handler = async (_req, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body);
      };
      assert.equal((await f.run(["read", f.state])).code, 1);
    }
    assert.equal((await readdir(f.state)).filter((x) => x.startsWith("readback-")).length, 0);
    // A later head is not queried; read preserves the original historical operation.
    const historical = clone(readback());
    historical.observation = {
      ...historical.observation,
      phase: "superseded",
      reasonCode: "SUPERSEDED",
    };
    f.handler = async (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(wire(historical));
    };
    await writeFile(f.key, JSON.stringify({ data: { key: `${secret}-rotated` } }));
    const read = await f.run(["read", f.state]);
    assert.equal(read.code, 0);
    assert.match(read.stdout, new RegExp(uuid(4)));
    assert.equal(f.requests.at(-1).headers["x-api-key"], `${secret}-rotated`);
    assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
    await writeFile(f.key, JSON.stringify({ data: { key: "" } }));
    const before = f.requests.length;
    assert.equal((await f.run(["read", f.state])).code, 1);
    assert.equal(f.requests.length, before);
    await retainedContents(f.state);
  },
);

test(
  "local acknowledgement publication failure never releases the consumed send",
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await f.prepare()).code, 0);
    // An existing destination creates a real exclusive-publication failure after
    // receiving the valid response; the client must not convert it to permission.
    await mkdir(join(f.state, "acknowledgement.json"), { mode: 0o700 });
    assert.equal((await f.run(["send", f.state])).code, 1);
    assert.equal((await f.run(["send", f.state])).code, 1);
    assert.equal((await f.run(["read", f.state])).code, 0);
    assert.deepEqual(
      f.requests.map((r) => r.method),
      ["POST", "GET"],
    );
  },
);

test(
  "documented curl session jar sends one current cookie and exact mutation Origin without credential fallback",
  { timeout: 20_000 },
  async (t) => {
    const f = await fixture(t);
    const jar = join(f.root, "cookies");
    const cookie = `# Netscape HTTP Cookie File\n#HttpOnly_127.0.0.1\tFALSE\t/\tFALSE\t0\topenclaw_occ.session_token\t${secret}\n`;
    await writeFile(jar, cookie, { mode: 0o600 });
    const auth = { OCC_SERVICE_KEY_FILE: undefined, OCC_SESSION_COOKIE_JAR: jar };
    const authOrigin = "https://auth.example";
    assert.equal(
      (await f.run(["prepare", f.state, f.input], { OCC_AUTH_BASE_URL: authOrigin })).code,
      0,
    );
    assert.equal((await f.run(["send", f.state], { OCC_SESSION_COOKIE_JAR: jar })).code, 1);
    assert.equal(
      (await f.run(["send", f.state], { ...auth, OCC_AUTH_BASE_URL: f.origin })).code,
      1,
    );
    assert.equal(f.connections, 0);
    assert.equal((await f.run(["send", f.state], auth)).code, 0);
    assert.equal(f.requests[0].headers.cookie, `openclaw_occ.session_token=${secret}`);
    assert.equal(f.requests[0].headers.origin, authOrigin);
    assert.equal(f.requests[0].headers["x-api-key"], undefined);
    assert.equal((await f.run(["read", f.state], auth)).code, 0);
    assert.equal(f.requests[1].headers.origin, undefined);
    for (const bad of [
      cookie.replace("\t0\t", "\t1\t"),
      cookie.replace("127.0.0.1", "foreign.example"),
      cookie.replace("\t/\t", "\t/private\t"),
      cookie.replace("\tFALSE\t0", "\tTRUE\t0"),
    ]) {
      await writeFile(jar, bad);
      assert.equal((await f.run(["read", f.state], auth)).code, 1);
    }
    await writeFile(jar, cookie);
    await chmod(jar, 0o644);
    assert.equal((await f.run(["read", f.state], auth)).code, 1);
    assert.equal(f.requests.length, 2);
    await retainedContents(f.state);
  },
);
