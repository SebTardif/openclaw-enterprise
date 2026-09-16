import assert from "node:assert/strict";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";

// Observe the real IncomingMessage buffers at the external HTTPS boundary.
// Delegate transport unchanged; never replace a response or provider decision.
const actualRequest = https.request;
let observe;
https.request = (...args) => {
  const request = actualRequest(...args);
  request.prependListener("response", (response) => {
    response.prependListener("data", (chunk) => observe?.(chunk));
  });
  return request;
};
syncBuiltinESMExports();
const { call, providerFixture } = await import("../helpers/github-app-provider.mjs");

for (const mode of ["success", "abort", "overflow"]) {
  test(`provider wipes real response buffers on ${mode}`, { timeout: 15000 }, async (t) => {
    const f = await providerFixture(t);
    const abort = new AbortController();
    const chunks = [];
    const nonzero = [];
    observe = (chunk) => {
      chunks.push(chunk);
      nonzero.push(chunk.some((byte) => byte !== 0));
      if (mode === "abort" && chunks.length === 2) abort.abort();
    };
    t.after(() => {
      observe = undefined;
    });
    f.respond(async (_request, reply) => {
      reply.writeHead(201);
      const body = mode === "overflow" ? "x".repeat(270000) : JSON.stringify(f.packet());
      reply.write(body.slice(0, 20));
      await new Promise((resolve) => setTimeout(resolve, 20));
      reply.write(body.slice(20, 40));
      await new Promise((resolve) => setTimeout(resolve, 20));
      reply.end(body.slice(40));
    });
    const attempt = call();
    attempt.bounds.signal = abort.signal;
    const result = await f.provider.mint(attempt);
    await f.provider.settleAttempt(result);
    assert.equal(f.requests.length, 1);
    assert.ok(chunks.length >= 2);
    assert.ok(nonzero.every(Boolean));
    assert.ok(
      chunks.every((chunk) => chunk.every((byte) => byte === 0)),
      "all original chunks, including the cancelling chunk, are wiped",
    );
    assert.equal(result.kind, mode === "success" ? "minted" : "unknown");
    if (mode === "success") assert.equal(f.captured.get(result.material).bytes.toString(), f.token);
    else assert.equal(f.captured.size, 0);
  });
}

for (const mode of ["confirmed", "invalid", "oversize", "lost-response"]) {
  test(`revocation ${mode} wipes provider copies and preserves custody bytes`, async (t) => {
    const f = await providerFixture(t);
    const { createGitHubAppTokenRevokerV1 } =
      await import("../../apps/controller/src/providers/token/github/index.ts");
    let value = "synthetic_revocation_token";
    if (mode === "invalid") value += "\ninvalid";
    if (mode === "oversize") value = "x".repeat(16385);
    const owned = Buffer.from(value);
    const copies = [];
    const actualFrom = Buffer.from;
    // Observe allocations without changing their contents or the real transport.
    // The old intermediate copy survived both confirmation and invalid refusal.
    Buffer.from = function (input, ...rest) {
      const copy = actualFrom.call(this, input, ...rest);
      if (input === owned) copies.push(copy);
      return copy;
    };
    t.after(() => {
      Buffer.from = actualFrom;
      owned.fill(0);
      for (const copy of copies) copy.fill(0);
    });
    const handle = Object.freeze({});
    const provider = createGitHubAppTokenRevokerV1({
      ...f.options,
      custody: {
        async withRevocationToken(input, _bounds, consume) {
          assert.equal(input, handle);
          return consume(owned);
        },
      },
    });
    f.respond((request, reply) => {
      assert.equal(request.method, "DELETE");
      assert.equal(request.path, "/installation/token");
      assert.equal(request.headers.authorization, `Bearer ${value}`);
      if (mode === "lost-response") return reply.destroy();
      reply.writeHead(204);
      reply.end();
    });
    const result = await provider.revoke(call(), handle);
    await provider.settleAttempt(result);
    let expected = "not-dispatched";
    if (mode === "confirmed") expected = "confirmed";
    if (mode === "lost-response") expected = "unknown";
    assert.equal(result.kind, expected);
    assert.equal(f.requests.length, mode === "confirmed" || mode === "lost-response" ? 1 : 0);
    if (mode === "oversize") assert.equal(copies.length, 0);
    else assert.ok(copies.length > 0);
    assert.ok(copies.every((copy) => copy !== owned && copy.every((byte) => byte === 0)));
    assert.equal(
      owned.toString("utf8"),
      value,
      "provider cleanup must preserve custody's original bytes",
    );
  });
}
