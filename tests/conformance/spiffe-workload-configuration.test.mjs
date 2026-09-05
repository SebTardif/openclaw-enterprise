import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createSpiffeWorkloadIdentitySource,
  SpiffeWorkloadIdentityError,
} from "../../apps/controller/src/identity/index.ts";

const valid = {
  socketPath: "/run/spire/agent.sock",
  expectedSpiffeId: "spiffe://example.org/worker",
};

for (const socketPath of [
  "agent.sock",
  "unix:/run/agent.sock",
  "http://localhost",
  "/run/../agent.sock",
  "/run/a\0b",
  "/run/a?b",
  `/run/${"a".repeat(104)}`,
]) {
  test(`rejects unsupported socket configuration ${JSON.stringify(socketPath)}`, () => {
    assert.throws(() => createSpiffeWorkloadIdentitySource({ ...valid, socketPath }), {
      code: "INVALID_CONFIGURATION",
    });
  });
}

for (const expectedSpiffeId of [
  "spiffe://example.org",
  "spiffe://example.org/",
  "spiffe://EXAMPLE.org/worker",
  "spiffe://example.org/../worker",
  "spiffe://example.org/a//b",
  "spiffe://example.org/worker?query",
  "spiffe://example.org:443/worker",
  "spiffe://example.org/%77orker",
  "https://example.org/worker",
]) {
  test(`rejects unsupported workload identity ${expectedSpiffeId}`, () => {
    assert.throws(() => createSpiffeWorkloadIdentitySource({ ...valid, expectedSpiffeId }), {
      code: "INVALID_CONFIGURATION",
    });
  });
}

test("timeouts are bounded and credentials are unavailable before source startup or after close", async () => {
  for (const timeoutMs of [0, 999, 60_001, Infinity, NaN, 1000.5]) {
    assert.throws(() => createSpiffeWorkloadIdentitySource({ ...valid, timeoutMs }), {
      code: "INVALID_CONFIGURATION",
    });
  }
  const source = createSpiffeWorkloadIdentitySource(valid);
  assert.throws(() => source.getX509IdentityMetadata(), { code: "UNAVAILABLE" });
  assert.throws(() => source.getX509Identity(), { code: "UNAVAILABLE" });
  await assert.rejects(source.fetchJwtSvid({ audience: "controller" }), { code: "UNAVAILABLE" });
  source.close();
  source.close();
  await assert.rejects(source.start(), { code: "CLOSED" });
  assert.throws(() => source.getX509IdentityMetadata(), { code: "CLOSED" });
});

test("pre-aborted startup reports a fixed safe error without the abort reason", async () => {
  const source = createSpiffeWorkloadIdentitySource(valid);
  try {
    await assert.rejects(
      source.start({ signal: AbortSignal.abort(new Error("sensitive abort payload")) }),
      (error) => {
        assert.ok(error instanceof SpiffeWorkloadIdentityError);
        assert.equal(error.code, "ABORTED");
        assert.equal(error.message.includes("sensitive"), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  } finally {
    source.close();
  }
});

test("vendored public Workload API protocol retains the reviewed upstream bytes", async () => {
  const proto = await readFile(
    new URL("../../apps/controller/src/identity/proto/workload.proto", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(proto).digest("hex"),
    "159d2146f9b16bee2737f3f22e1e21c956fa272d03bedc96d4cb3b1b44829fe6",
  );
});
