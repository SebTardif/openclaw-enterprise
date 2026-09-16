import assert from "node:assert/strict";
import test from "node:test";
import {
  createGitHubAppTokenIssuerV1,
  createGitHubAppTokenRevokerV1,
} from "../../apps/controller/src/providers/token/github/index.ts";
import { call, keyIdentity, providerFixture, selection } from "../helpers/github-app-provider.mjs";

test("read issuer rejects broader selection before dispatch and retains keyless cleanup", async (t) => {
  const f = await providerFixture(t);
  for (const repositories of [
    [],
    [...selection.repositories, { id: 74, fullName: "fixture/other" }],
  ]) {
    assert.throws(() =>
      createGitHubAppTokenIssuerV1({
        ...f.options,
        selection: { ...selection, repositories },
      }),
    );
  }
  for (const permissions of [
    {},
    { metadata: "write" },
    { metadata: "read", contents: "write" },
    { metadata: "read", contents: "read", issues: "read" },
    { metadata: "read", pull_requests: "read" },
    { metadata: "read", pull_requests: "write" },
    { metadata: "read", administration: "read" },
  ]) {
    assert.throws(() =>
      createGitHubAppTokenIssuerV1({
        ...f.options,
        selection: { ...selection, permissions },
      }),
    );
  }
  assert.equal(f.requests.length, 0);
  const selected = createGitHubAppTokenIssuerV1(f.options);
  const result = await selected.mint(call());
  assert.equal(result.kind, "minted");
  assert.deepEqual(JSON.parse(f.requests[0].body).repository_ids, [73]);
  // A cleanup-only owner can revoke after the signing key is closed.
  f.material.close();
  const revoker = createGitHubAppTokenRevokerV1(f.options);
  assert.equal(revoker.mint, undefined);
  f.respond((request, reply) => {
    assert.equal(request.method, "DELETE");
    assert.equal(request.path, "/installation/token");
    assert.equal(request.headers.authorization, `Bearer ${f.token}`);
    reply.writeHead(204);
    reply.end();
  });
  assert.equal((await revoker.revoke(call(), result.material)).kind, "confirmed");
  assert.equal((await revoker.revoke(call(), {})).kind, "not-dispatched");
  assert.equal(f.requests.length, 2);
});

test("key and attempt identities reject coercible non-string values", async (t) => {
  const f = await providerFixture(t);
  for (const clientId of [
    undefined,
    19,
    {
      toString() {
        return "Iv1.fixture";
      },
    },
  ]) {
    assert.throws(() =>
      createGitHubAppTokenIssuerV1({
        ...f.options,
        selection: { ...selection, key: { ...keyIdentity, clientId } },
      }),
    );
  }
  for (const providerAttemptRef of [
    undefined,
    19,
    {
      toString() {
        return "attempt/fixture";
      },
    },
  ]) {
    assert.equal((await f.provider.mint({ ...call(), providerAttemptRef })).kind, "not-dispatched");
  }
  assert.equal(f.requests.length, 0);
});
