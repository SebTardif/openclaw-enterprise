import assert from "node:assert/strict";
import test from "node:test";
import {
  createGitHubAppTokenIssuerV1,
  createGitHubAppWriteTokenIssuerV1,
  createGitHubAppTokenRevokerV1,
} from "../../packages/occ/src/index.ts";
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
    { metadata: "read", contents: "write", pull_requests: "write" },
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

const writeSelection = () => ({
  ...selection,
  key: { ...keyIdentity },
  repositories: selection.repositories.map((repository) => ({ ...repository })),
  permissions: { metadata: "read", contents: "write", pull_requests: "write" },
});

test("write issuer refuses malformed selection without evaluating caller code or dispatching", async (t) => {
  const f = await providerFixture(t);
  const construct = (selected) =>
    createGitHubAppWriteTokenIssuerV1({ ...f.options, selection: selected });
  for (const permissions of [
    {},
    { metadata: "read" },
    { metadata: "read", contents: "write" },
    { metadata: "read", contents: "read", pull_requests: "write" },
    { metadata: "write", contents: "write", pull_requests: "write" },
    { metadata: "read", contents: "write", pull_requests: "admin" },
    { ...writeSelection().permissions, issues: "read" },
  ])
    assert.throws(() => construct({ ...writeSelection(), permissions }));
  for (const id of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "41"])
    for (const field of ["installationId", "repositoryId"]) {
      const selected = writeSelection();
      if (field === "installationId") selected.installationId = id;
      else selected.repositories[0].id = id;
      assert.throws(() => construct(selected));
    }
  for (const fullName of [
    "fixture/repository\n",
    "fixture/repository\r",
    "fixture/repository/other",
    "fixture /repository",
    "",
  ])
    assert.throws(() => construct({ ...writeSelection(), repositories: [{ id: 73, fullName }] }));
  for (const repositories of [[], [...selection.repositories, ...selection.repositories]])
    assert.throws(() => construct({ ...writeSelection(), repositories }));
  let evaluated = 0;
  const accessor = (value, field) => {
    Object.defineProperty(value, field, {
      get() {
        evaluated++;
        throw new Error("must not evaluate accessor");
      },
    });
    return value;
  };
  const proxy = (value) =>
    new Proxy(value, {
      ownKeys() {
        evaluated++;
        throw new Error("must not evaluate proxy");
      },
    });
  const malformed = [
    undefined,
    null,
    proxy(writeSelection()),
    accessor(writeSelection(), "key"),
    { ...writeSelection(), key: accessor({ ...keyIdentity }, "clientId") },
    { ...writeSelection(), key: proxy({ ...keyIdentity }) },
    { ...writeSelection(), repositories: proxy([...selection.repositories]) },
    { ...writeSelection(), repositories: accessor([...selection.repositories], "0") },
    { ...writeSelection(), repositories: [accessor({ ...selection.repositories[0] }, "id")] },
    { ...writeSelection(), repositories: [proxy({ ...selection.repositories[0] })] },
    { ...writeSelection(), permissions: accessor(writeSelection().permissions, "contents") },
    { ...writeSelection(), permissions: proxy(writeSelection().permissions) },
    Object.assign(Object.create({ inherited: true }), writeSelection()),
    {
      ...writeSelection(),
      permissions: Object.assign(Object.create({ issues: "write" }), writeSelection().permissions),
    },
    { ...writeSelection(), extra: true },
    { ...writeSelection(), [Symbol("extra")]: true },
    { ...writeSelection(), key: { ...keyIdentity, extra: true } },
    { ...writeSelection(), key: { ...keyIdentity, clientId: "Iv1.fixture\n" } },
    { ...writeSelection(), repositories: [{ ...selection.repositories[0], extra: true }] },
    {
      ...writeSelection(),
      repositories: Object.assign([...selection.repositories], { extra: true }),
    },
    {
      ...writeSelection(),
      permissions: { ...writeSelection().permissions, [Symbol("extra")]: true },
    },
  ];
  for (const selected of malformed) assert.throws(() => construct(selected));
  assert.equal(evaluated, 0);
  assert.equal(f.requests.length, 0);
});

test("write selection is fixed before mint and exact retained cleanup survives signing-key closure", async (t) => {
  const f = await providerFixture(t);
  const selected = writeSelection();
  const expected = writeSelection();
  const issuer = createGitHubAppWriteTokenIssuerV1({ ...f.options, selection: selected });
  // Later caller mutation cannot alter the already selected repository or profile.
  selected.key.clientId = "Iv1.other";
  selected.installationId = 42;
  selected.repositories[0].id = 74;
  selected.repositories[0].fullName = "fixture/other";
  selected.permissions.contents = "read";
  f.respond((_request, reply) => {
    reply.writeHead(201);
    reply.end(JSON.stringify({ ...f.packet(), permissions: expected.permissions }));
  });
  const result = await issuer.mint(call());
  assert.equal(result.kind, "minted");
  await issuer.settleAttempt(result);
  assert.equal(f.requests[0].path, "/app/installations/41/access_tokens");
  assert.deepEqual(JSON.parse(f.requests[0].body), {
    repository_ids: [73],
    permissions: expected.permissions,
  });
  assert.equal(f.captured.get(result.material).observation.scopeAccepted, true);
  f.material.close();
  const revoker = createGitHubAppTokenRevokerV1(f.options);
  f.respond((request, reply) => {
    assert.equal(request.path, "/installation/token");
    assert.equal(request.method, "DELETE");
    assert.equal(request.headers.authorization, `Bearer ${f.token}`);
    reply.writeHead(204);
    reply.end();
  });
  const revoked = await revoker.revoke(call(), result.material);
  assert.equal(revoked.kind, "confirmed");
  await revoker.settleAttempt(revoked);
  assert.equal(f.requests.length, 2);
});
