import assert from "node:assert/strict";
import { link, lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  ProtectedGitHubCustodyErrorV1,
  ProtectedGitHubTokenStoreV1,
} from "../../packages/occ/src/index.ts";
import { admittedGitHubCredentialsFixture } from "../helpers/protected-github-app-material.mjs";

// Real prepared owners, envelope crypto and ordinary files execute here. Manually
// staged publication states prove local recovery, not crash or volume durability.
const originalContext = "original-attempt/installation-token";
const envelopeContext = [
  "installation-1",
  "github.com",
  "app-1",
  "lease-1",
  "attempt-1",
  "token-1",
];
function sealToken(crypto, value = "synthetic-store-token") {
  const plaintext = Buffer.from(value);
  try {
    return crypto.seal("github-installation-token-v1", envelopeContext, plaintext);
  } finally {
    plaintext.fill(0);
  }
}

test("prepared token store retains exact envelopes without exposing or reopening custody", async (t) => {
  const fixture = await admittedGitHubCredentialsFixture(t);
  const owner = await fixture.prepareCredentials();
  const { store, crypto } = owner;
  const directory = fixture.selection.tokenStore.directory;
  const otherDirectory = join(dirname(directory), "other-tokens");
  await mkdir(otherDirectory, { mode: 0o700 });
  const envelope = sealToken(crypto);
  const conflictingEnvelope = sealToken(crypto, "different-synthetic-store-token");

  // TypeScript-private properties would expose state at runtime. Public property
  // assignments must not redirect the fixed directory or invoke internal helpers.
  assert.deepEqual(Reflect.ownKeys(store), []);
  assert.deepEqual(
    Reflect.ownKeys(ProtectedGitHubTokenStoreV1.prototype).sort(),
    ["constructor", "read", "retain", "assertSeparateKeySource", "close"].sort(),
  );
  const rejectPublicHelper = () => assert.fail("public helper used for custody");
  Object.assign(store, {
    directory: otherDirectory,
    identity: await lstat(otherDirectory, { bigint: true }),
    closed: true,
    assertDirectory: rejectPublicHelper,
    name: rejectPublicHelper,
    envelopeName: rejectPublicHelper,
    readEnvelope: rejectPublicHelper,
    syncDirectory: rejectPublicHelper,
  });
  store.assertSeparateKeySource(crypto);
  assert.equal(store.read(originalContext), undefined);
  store.retain(originalContext, envelope);
  store.retain(originalContext, envelope);
  assert.throws(
    () => store.retain(originalContext, conflictingEnvelope),
    ProtectedGitHubCustodyErrorV1,
  );
  assert.deepEqual(store.read(originalContext), envelope);
  assert.equal(store.read("other-original-attempt"), undefined);
  const [name, ...extraFiles] = await readdir(directory);
  assert.equal(extraFiles.length, 0);
  assert.deepEqual(await readFile(join(directory, name)), envelope);
  assert.deepEqual(await readdir(otherDirectory), []);

  // Closing the composed owner also closes its store; public assignments cannot
  // reopen it. A fresh admitted owner still reads the original persisted envelope.
  owner.close();
  store.closed = false;
  assert.throws(() => store.read(originalContext), ProtectedGitHubCustodyErrorV1);
  assert.throws(() => store.retain(originalContext, envelope), ProtectedGitHubCustodyErrorV1);
  assert.throws(() => store.assertSeparateKeySource(crypto), ProtectedGitHubCustodyErrorV1);
  store.close();
  const reopened = await fixture.prepareCredentials();
  const recoveredEnvelope = reopened.store.read(originalContext);
  assert.deepEqual(recoveredEnvelope, envelope);
  const recovered = reopened.crypto.open(
    "github-installation-token-v1",
    envelopeContext,
    recoveredEnvelope,
  );
  try {
    assert.equal(recovered.toString(), "synthetic-store-token");
  } finally {
    recovered.fill(0);
  }

  const unregistered = Object.create(ProtectedGitHubTokenStoreV1.prototype);
  assert.throws(() => unregistered.read(originalContext), ProtectedGitHubCustodyErrorV1);
  assert.throws(
    () => unregistered.retain(originalContext, envelope),
    ProtectedGitHubCustodyErrorV1,
  );
  assert.throws(() => unregistered.assertSeparateKeySource(reopened.crypto), TypeError);
  assert.throws(() => unregistered.close(), TypeError);
});

test("token store recovers pending publication and refuses conflicting files", async (t) => {
  for (const publication of ["before link", "after link", "conflicting destination"])
    await t.test(publication, async (t) => {
      const fixture = await admittedGitHubCredentialsFixture(t);
      const owner = await fixture.prepareCredentials();
      const envelope = sealToken(owner.crypto);
      owner.store.retain(originalContext, envelope);
      owner.close();
      const directory = fixture.selection.tokenStore.directory;
      const [name] = await readdir(directory);
      const destination = join(directory, name);
      const pending = join(directory, ".pending-" + name);
      // Reconstruct the two interruption points with real files and hard links.
      // The conflicting case retains both files for custody reconciliation.
      if (publication === "before link") await rename(destination, pending);
      else if (publication === "after link") await link(destination, pending);
      else await writeFile(pending, envelope, { mode: 0o600, flag: "wx" });

      const reopened = await fixture.prepareCredentials();
      if (publication === "conflicting destination") {
        assert.throws(() => reopened.store.read(originalContext), ProtectedGitHubCustodyErrorV1);
        assert.deepEqual((await readdir(directory)).sort(), [name, ".pending-" + name].sort());
        assert.deepEqual(await readFile(destination), envelope);
        assert.deepEqual(await readFile(pending), envelope);
      } else {
        assert.deepEqual(reopened.store.read(originalContext), envelope);
        assert.deepEqual(await readdir(directory), [name]);
        assert.equal((await lstat(destination)).nlink, 1);
        assert.deepEqual(reopened.store.read(originalContext), envelope);
      }
    });
});
