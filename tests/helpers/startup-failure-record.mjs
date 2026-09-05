import assert from "node:assert/strict";

export function assertStartupFailureRecord(
  stderr,
  component,
  expected = {
    code: "STARTUP_FAILED",
    error: "Controller startup failed. Check the configured startup prerequisites.",
  },
) {
  assert.ok(component === "api" || component === "worker");
  // Validate the whole stream so an extra parser dump or cleanup error cannot pass.
  const lines = stderr.split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[1], "");
  const { time, ...record } = JSON.parse(lines[0]);
  assert.equal(typeof time, "string");
  assert.equal(new Date(time).toISOString(), time);
  assert.deepEqual(record, {
    severity: "ERROR",
    service: component === "api" ? "occ-api" : "occ-worker",
    event: component === "api" ? "startup-error" : "worker.startup-error",
    ...expected,
  });
}
