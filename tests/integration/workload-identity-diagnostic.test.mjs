import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const command = new URL("../../scripts/check-workload-identity.mjs", import.meta.url);

function run(args) {
  return spawnSync(process.execPath, [command.pathname, ...args], {
    encoding: "utf8",
    timeout: 5000,
  });
}

test("workload identity diagnostic explains the supported local verification scope", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /operator-trusted/);
  assert.match(result.stdout, /does not verify guest/);
  assert.equal(result.stderr, "");
});

test("workload identity diagnostic rejects malformed arguments without echoing input", () => {
  const canary = "do-not-disclose-this-argument";
  for (const args of [
    [],
    [canary],
    ["--socket-path", canary],
    ["--help", canary],
    [
      "--socket-path",
      canary,
      "--spiffe-id",
      "spiffe://example.org/diagnostic",
      "--timeout-ms",
      "Infinity",
    ],
    [
      "--socket-path",
      canary,
      "--spiffe-id",
      "spiffe://example.org/diagnostic",
      "--spiffe-id",
      canary,
    ],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, new RegExp(canary));
    assert.match(result.stderr, /Invalid workload identity arguments/);
  }
});

test("workload identity diagnostic fails safely when the actual local endpoint is unavailable", async () => {
  // Missing packaged code must fail the test instead of resembling an unavailable provider.
  const { createSpiffeWorkloadIdentitySource } =
    await import("../../apps/controller/src/identity/index.ts");
  assert.equal(typeof createSpiffeWorkloadIdentitySource, "function");
  const result = run([
    "--socket-path",
    "/nonexistent/workload-api-diagnostic-canary.sock",
    "--spiffe-id",
    "spiffe://example.org/diagnostic",
    "--timeout-ms",
    "1000",
  ]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const output = JSON.parse(result.stderr);
  assert.equal(output.status, "unavailable");
  assert.equal(output.scope, "local-workload-api");
  assert.doesNotMatch(result.stderr, /diagnostic-canary|ENOTFOUND|stack|certificate|PRIVATE KEY/);
});
