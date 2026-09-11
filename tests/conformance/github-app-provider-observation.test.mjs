import assert from "node:assert/strict";
import test from "node:test";
import { call, providerFixture, selection } from "../helpers/github-app-provider.mjs";

for (const [name, permissions, accepted, observed, requestedPermissions] of [
  ["metadata-only", { metadata: "read" }, true, { metadata: "read" }, { metadata: "read" }],
  ["exact", { metadata: "read", contents: "read" }, true, { metadata: "read", contents: "read" }],
  [
    "broader",
    { metadata: "read", contents: "write", administration: "admin" },
    false,
    { metadata: "read", contents: "write", administration: "admin" },
  ],
  ["missing", undefined, false, { kind: "unavailable" }],
  ["invalid", { metadata: "bogus" }, false, { kind: "unavailable" }],
  ["array", [], false, { kind: "unavailable" }],
  [
    "too many",
    Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, "read"])),
    false,
    { kind: "unavailable" },
  ],
]) {
  test(`provider retains exact ${name} permission observation and wipes temporary token`, async (t) => {
    const f = await providerFixture(
      t,
      requestedPermissions === undefined
        ? {}
        : {
            selection: { ...selection, permissions: requestedPermissions },
          },
    );
    f.respond((_request, reply) => {
      reply.writeHead(201);
      reply.end(JSON.stringify({ ...f.packet(), permissions }));
    });
    const result = await f.provider.mint(call());
    await f.provider.settleAttempt(result);
    assert.equal(result.kind, accepted ? "minted" : "unknown");
    assert.equal(f.requests.length, 1);
    const retained = f.captured.get(result.material);
    assert.ok(retained, "scope-invalid live tokens still need exact mitigation");
    assert.equal(retained.bytes.toString(), f.token);
    assert.equal(retained.observation.scopeAccepted, accepted);
    assert.deepEqual(retained.observation.returnedPermissions, observed);
    assert.ok(Object.isFrozen(retained.observation.returnedPermissions));
    assert.ok(f.captureBuffers.every((bytes) => bytes.every((byte) => byte === 0)));
    assert.ok(!JSON.stringify(result).includes(f.token));
  });
}
