import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { checkSelectedRequirements } from "../../scripts/development-setup-requirements.mjs";

const owner = "fixture setup owner";
const action =
  "Prepare the already allocated fixture endpoint separately, then rerun this requirement.";
const select = (...requirements) => ({
  schema: "oce.development-setup-requirements/v1",
  requirements,
});
const requirement = (id, fields) => ({ id, owner, action, ...fields });
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), "oce-selected-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function snapshot(root, prefix = "") {
  return readdirSync(join(root, prefix))
    .sort()
    .flatMap((name) => {
      const path = join(prefix, name),
        stat = lstatSync(join(root, path), { bigint: true });
      const entry = {
        path,
        mode: String(stat.mode),
        mtimeNs: String(stat.mtimeNs),
        size: String(stat.size),
      };
      if (stat.isSymbolicLink()) entry.link = readlinkSync(join(root, path));
      else if (stat.isFile())
        entry.sha256 = createHash("sha256")
          .update(readFileSync(join(root, path)))
          .digest("hex");
      return stat.isDirectory() ? [entry, ...snapshot(root, path)] : [entry];
    });
}
async function server(t, handler) {
  const requests = [];
  const instance = createServer((request, response) => {
    requests.push(request.url);
    handler(request, response);
  });
  await new Promise((resolve, reject) => {
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise((resolve) => instance.close(resolve));
  });
  return { url: `http://127.0.0.1:${instance.address().port}`, requests, instance };
}

test("explicit HTTP and Docker protocol contracts report their limited evidence and preserve files", async (t) => {
  const root = directory(t);
  mkdirSync(join(root, ".docker"));
  writeFileSync(join(root, ".docker/config.json"), '{"currentContext":"preserved"}');
  writeFileSync(join(root, "kubeconfig"), "current-context: preserved\n");
  // This is an HTTP protocol fixture, not a Docker daemon or workload proof.
  const fixture = await server(t, (req, res) => {
    if (req.url === "/_ping") res.end("OK");
    else if (req.url === "/version")
      res.end(JSON.stringify({ Version: "28.0.1", ApiVersion: "1.48" }));
    else if (req.url === "/health") res.end("ready\n");
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  const before = snapshot(root);
  const report = await checkSelectedRequirements(
    root,
    select(
      requirement("fixture-health", {
        kind: "http",
        url: `${fixture.url}/health`,
        expectedBody: "ready\n",
      }),
      requirement("fixture-docker", { kind: "docker", endpoint: { url: fixture.url } }),
    ),
  );
  assert.equal(report.status, "prepared");
  assert.match(report.selectionSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(fixture.requests, ["/health", "/_ping", "/version"]);
  assert.equal(report.checks[0].evidence.level, "exact-http-response-contract");
  assert.equal(report.checks[0].evidence.authentication, "unverified");
  assert.equal(report.checks[1].evidence.workloads, "unverified");
  assert.deepEqual(snapshot(root), before);
});

test("required protocol failures stay unprepared, bounded and do not disclose bodies", async (t) => {
  const root = directory(t);
  const secret = "fixture-sensitive-response-not-for-report";
  const fixture = await server(t, (req, res) => {
    if (req.url === "/auth") {
      res.statusCode = 401;
      res.end(secret);
    } else if (req.url === "/redirect") {
      res.statusCode = 302;
      res.setHeader("Location", "/should-not-follow");
      res.end();
    } else if (req.url === "/large") res.end("x".repeat(20000));
    else if (req.url === "/slow") {
      /* Deliberately incomplete HTTP fixture exercises the deadline. */
    } else res.end(secret);
  });
  const report = await checkSelectedRequirements(
    root,
    select(
      ...["auth", "redirect", "large", "slow", "wrong"].map((id) =>
        requirement(id, {
          kind: "http",
          url: `${fixture.url}/${id}`,
          expectedBody: "ready",
          timeoutMs: 100,
        }),
      ),
    ),
  );
  assert.equal(report.status, "unprepared");
  assert.deepEqual(
    report.checks.map((check) => check.reason),
    [
      "authentication-or-authorization-required",
      "unexpected-http-response",
      "response-too-large",
      "timeout",
      "unexpected-http-response",
    ],
  );
  assert.equal(fixture.requests.includes("/should-not-follow"), false);
  assert.equal(JSON.stringify(report).includes(secret), false);
  for (const check of report.checks) {
    assert.equal(check.owner, owner);
    assert.equal(check.action, action);
  }
  assert.ok(report.durationMs < 2500, "The timed-out fixture must not stall the doctor.");
});

test("TCP acceptance cannot satisfy service, authentication or schema readiness", async (t) => {
  const root = directory(t);
  const fixture = await server(t, (_req, res) => res.end("not PostgreSQL"));
  const report = await checkSelectedRequirements(
    root,
    select(
      requirement("transport", {
        kind: "tcp",
        host: "127.0.0.1",
        port: Number(new URL(fixture.url).port),
      }),
      requirement("database", { kind: "postgres" }),
      requirement("cluster", { kind: "kubernetes" }),
    ),
  );
  assert.equal(report.status, "unprepared");
  assert.equal(report.checks[0].reason, "transport-does-not-establish-readiness");
  assert.equal(report.checks[0].evidence.schema, "unverified");
  assert.deepEqual(
    report.checks.slice(1).map((check) => check.status),
    ["unsupported", "unsupported"],
  );
  assert.deepEqual(fixture.requests, []);
});

test("one total deadline bounds multiple selected slow endpoints", async (t) => {
  const root = directory(t);
  const fixture = await server(t, () => {});
  const selection = select(
    ...Array.from({ length: 8 }, (_, index) =>
      requirement(`slow-${index}`, {
        kind: "http",
        url: `${fixture.url}/slow`,
        expectedBody: "ready",
        timeoutMs: 80,
      }),
    ),
  );
  selection.timeoutMs = 100;
  const report = await checkSelectedRequirements(root, selection);
  assert.equal(report.status, "unprepared");
  assert.ok(report.checks.some((check) => check.reason === "total-deadline-exhausted"));
  assert.ok(fixture.requests.length <= 2);
  assert.ok(report.durationMs < 1500);
});

test("missing selection, unknown fields, duplicate IDs and implicit targets never start probes", async (t) => {
  const root = directory(t);
  const fixture = await server(t, (_req, res) => res.end("ready"));
  const valid = requirement("health", {
    kind: "http",
    url: `${fixture.url}/health`,
    expectedBody: "ready",
  });
  for (const selection of [
    undefined,
    select(),
    select(valid, valid),
    select(valid, { ...valid, id: "other", owner: "" }),
    select({ ...valid, action: "" }),
    select({ ...valid, url: "http://localhost:8080/health" }),
    select({ ...valid, url: "http://user:password@127.0.0.1:8080/health?secret=yes" }),
    select({ ...valid, headers: { Authorization: "must-not-send" } }),
    select(requirement("docker", { kind: "docker" })),
  ]) {
    const report = await checkSelectedRequirements(root, selection);
    assert.equal(report.status, "unprepared");
    assert.equal(report.checks[0].reason, "invalid-selection");
  }
  assert.deepEqual(fixture.requests, []);
});

test("unavailable selected endpoints and tools identify the selected owner's action", async (t) => {
  const root = directory(t);
  const report = await checkSelectedRequirements(
    root,
    select(
      requirement("missing-tool", { kind: "tool", tool: "docker", minimumVersion: "1.0.0" }),
      requirement("missing-socket", {
        kind: "docker",
        endpoint: { socketPath: join(root, "absent.sock") },
      }),
    ),
    { env: { PATH: root } },
  );
  assert.equal(report.status, "unprepared");
  for (const check of report.checks) {
    assert.equal(check.status, "unavailable");
    assert.equal(check.owner, owner);
    assert.equal(check.action, action);
  }
});

test("Go distribution metadata and selected module requirements are checked without executing Go", async (t) => {
  const root = directory(t);
  writeFileSync(join(root, "go.mod"), "module example.test/doctor-fixture\n\ngo 1.0.0\n");
  const req = requirement("go", { kind: "tool", tool: "go", module: "." });
  const before = snapshot(root);
  const prepared = await checkSelectedRequirements(root, select(req));
  if (prepared.checks[0].status !== "ok") {
    t.skip("An installed standard Go distribution is required for metadata success evidence.");
    return;
  }
  assert.equal(prepared.checks[0].evidence.usability, "not-executed");
  assert.match(prepared.checks[0].evidence.executableSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot(root), before);
  writeFileSync(join(root, "go.mod"), "module example.test/doctor-fixture\n\ngo 999.0.0\n");
  assert.equal((await checkSelectedRequirements(root, select(req))).checks[0].status, "stale");
  assert.equal(
    (await checkSelectedRequirements(root, select(req), { env: { PATH: root } })).checks[0].status,
    "unavailable",
  );
  writeFileSync(
    join(root, "go.mod"),
    "module example.test/doctor-fixture\n\ngo 1.0.0\ntoolchain go1.99rc1\n",
  );
  assert.equal((await checkSelectedRequirements(root, select(req))).status, "unprepared");
});

test("Go shims are never executed to obtain version evidence", async (t) => {
  const root = directory(t);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "go.mod"), "module example.test/shim\n\ngo 1.0.0\n");
  writeFileSync(join(root, "VERSION"), "go1.27.0\n");
  writeFileSync(join(root, "bin/go"), "#!/bin/sh\ntouch shim-executed\n");
  chmodSync(join(root, "bin/go"), 0o755);
  const before = snapshot(root);
  const report = await checkSelectedRequirements(
    root,
    select(requirement("go", { kind: "tool", tool: "go", module: "." })),
    { env: { PATH: join(root, "bin") } },
  );
  assert.equal(report.status, "unprepared");
  assert.deepEqual(snapshot(root), before);
});

test("actual psql client version is distinct from database readiness", async (t) => {
  const root = directory(t);
  const req = requirement("psql", { kind: "tool", tool: "psql", minimumVersion: "1.0" });
  const report = await checkSelectedRequirements(root, select(req));
  if (report.checks[0].reason === "missing-path-or-tool") {
    t.skip("The real psql client is unavailable; no server substitute is used.");
    return;
  }
  assert.equal(report.status, "prepared", JSON.stringify(report));
  assert.equal(report.checks[0].evidence.serverReadiness, "unverified");
  const stale = await checkSelectedRequirements(root, select({ ...req, minimumVersion: "999.0" }));
  assert.equal(stale.checks[0].status, "stale");
});

test("CLI root and selected requirement failure remain visible when base metadata is unavailable", async (t) => {
  const root = directory(t);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "source-export",
      engines: { node: ">=24" },
      packageManager: "pnpm@11.15.1",
    }),
  );
  writeFileSync(
    join(root, "requirements.json"),
    JSON.stringify(select(requirement("database", { kind: "postgres" }))),
  );
  const child = spawn(process.execPath, [
    new URL("../../scripts/check-development-setup.mjs", import.meta.url).pathname,
    "--root",
    root,
    "--requirements",
    join(root, "requirements.json"),
    "--json",
  ]);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 1, stderr);
  const report = JSON.parse(stdout);
  assert.equal(report.checkout, "source-export");
  assert.equal(report.status, "unprepared");
  assert.equal(report.selectedRequirements.checks[0].status, "unsupported");
});
