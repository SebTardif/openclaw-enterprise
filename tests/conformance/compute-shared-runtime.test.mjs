import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Script } from "node:vm";
import test from "node:test";
import * as runtime from "../../apps/controller/src/drivers/compute/runtime/runtime-entrypoints.ts";

// These digests capture the actual exported scripts before relocation.
// A module move must preserve every runtime byte, including embedded escaping.
const originalDigests = {
  AGENT_READINESS_ENTRYPOINT: "2aa6c2019d293c29ac233cd233ba5f23a1e5e4c21b986abcecfeb4915d82b4e0",
  AGENT_RUNTIME_ENTRYPOINT: "0329c35490435041c66412805fe4e7f3e74b2f04d9700241cff30a96d87dbe93",
  GATEWAY_READINESS_ENTRYPOINT: "58e79f20773403b9207bd9495a7913b8527305ee0ec05c01a764a8aae4f68d4f",
  GATEWAY_RUNTIME_ENTRYPOINT: "4a658cf0cd05e032d281903c2843763785a4755e76357206198f18d3730add99",
};

test("neutral runtime exports preserve the original executable scripts exactly", () => {
  assert.deepEqual(Object.keys(runtime).sort(), Object.keys(originalDigests).sort());
  for (const [name, digest] of Object.entries(originalDigests)) {
    assert.equal(typeof runtime[name], "string");
    assert.equal(createHash("sha256").update(runtime[name]).digest("hex"), digest, name);
    assert.doesNotThrow(() => new Script(runtime[name], { filename: name }));
  }
});

test("Docker and Kubernetes fixed renderer consume the neutral runtime module", async () => {
  const computeRoot = new URL("../../apps/controller/src/drivers/compute/", import.meta.url);
  for (const [path, runtimePath] of [
    ["docker/index.ts", "../runtime/runtime-entrypoints.ts"],
    ["kubernetes/resources/fixed-workload-renderer.ts", "../../runtime/runtime-entrypoints.ts"],
  ]) {
    const source = await readFile(new URL(path, computeRoot), "utf8");
    assert.ok(source.includes('from "' + runtimePath + '";'), path);
    assert.doesNotMatch(source, /from "(?:\.\/|\.\.\/kubernetes\/)runtime-entrypoints\.ts";/);
  }
  // The harness facade delegates to the fixed renderer, which owns the shared scripts.
  const harness = await readFile(new URL("kubernetes/resources/harness.ts", computeRoot), "utf8");
  assert.match(harness, /export\s*\{[^}]*\}\s*from "\.\/fixed-workload-renderer\.ts";/);
  assert.doesNotMatch(harness, /runtime-entrypoints\.ts/);
  const kubernetesIndex = await readFile(new URL("kubernetes/index.ts", computeRoot), "utf8");
  assert.doesNotMatch(kubernetesIndex, /runtime-entrypoints\.ts/);
});

for (const [statusCode, expectedExit] of [
  [200, 0],
  [204, 1],
  [503, 1],
]) {
  test(`gateway readiness script exits ${expectedExit} for HTTP ${statusCode}`, async () => {
    const observedRequests = [];
    // A real loopback HTTP endpoint exercises the unchanged script's request and
    // process-exit behavior; this does not claim gateway or cluster integration.
    const server = createServer((request, response) => {
      observedRequests.push({ method: request.method, url: request.url });
      response.writeHead(statusCode);
      response.end();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const result = await runReadiness(server.address().port);
      assert.equal(result.code, expectedExit, result.stderr);
      assert.equal(result.signal, null);
      assert.deepEqual(observedRequests, [{ method: "GET", url: "/readyz" }]);
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}

function runReadiness(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", runtime.GATEWAY_READINESS_ENTRYPOINT], {
      env: { ...process.env, OPENCLAW_GATEWAY_PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 5_000,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr }));
  });
}
