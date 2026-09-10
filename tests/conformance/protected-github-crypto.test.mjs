import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ProtectedGitHubCryptoV1,
  ProtectedGitHubCustodyErrorV1,
} from "../../packages/occ/src/credential-custody-v1/protected-github-crypto.ts";

// These cases exercise actual cryptography and filesystem protection. They do
// not create Work authority, a committed release, or an installed durable mount.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "oce-github-crypto-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = join(directory, "key");
  const key = randomBytes(32);
  await writeFile(keyFile, key, { mode: 0o600 });
  const selection = { keyFile, keySHA256: createHash("sha256").update(key).digest("hex") };
  key.fill(0);
  return { directory, keyFile, selection, crypto: new ProtectedGitHubCryptoV1(selection) };
}

test("protected GitHub envelope survives a new owner and binds every context field", async (t) => {
  const f = await fixture(t);
  const context = ["installation-1", "github.com", "app-1", "lease-1", "attempt-1", "token-1"];
  const plain = Buffer.from("synthetic-provider-token-canary");
  const encoded = f.crypto.seal("github-installation-token-v1", context, plain);
  assert.equal(encoded.includes(plain), false);
  f.crypto.close();
  const reopened = new ProtectedGitHubCryptoV1(f.selection);
  const recovered = reopened.open("github-installation-token-v1", context, encoded);
  assert.deepEqual(recovered, plain);
  recovered.fill(0);
  for (let index = 0; index < context.length; index++) {
    const changed = [...context];
    changed[index] += "-other";
    assert.throws(
      () => reopened.open("github-installation-token-v1", changed, encoded),
      ProtectedGitHubCustodyErrorV1,
    );
  }
  assert.throws(
    () => reopened.open("github-app-key-v1", context, encoded),
    ProtectedGitHubCustodyErrorV1,
  );
  for (const index of [0, 6, 18, encoded.length - 1]) {
    const changed = Buffer.from(encoded);
    changed[index] ^= 1;
    assert.throws(
      () => reopened.open("github-installation-token-v1", context, changed),
      ProtectedGitHubCustodyErrorV1,
    );
  }
  plain.fill(0);
});

test("protected GitHub key authentication rejects replacement, permissions and alias paths", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from("canary");
  const seal = () => f.crypto.seal("github-app-key-v1", ["app-key"], bytes);
  const originalKey = await readFile(f.keyFile);
  await writeFile(f.keyFile, randomBytes(32));
  assert.throws(seal, ProtectedGitHubCustodyErrorV1);
  await writeFile(f.keyFile, originalKey);
  originalKey.fill(0);
  await chmod(f.keyFile, 0o644);
  assert.throws(seal, ProtectedGitHubCustodyErrorV1);
  await chmod(f.keyFile, 0o600);
  await chmod(f.directory, 0o755);
  assert.throws(seal, ProtectedGitHubCustodyErrorV1);
  await chmod(f.directory, 0o700);
  const hard = join(f.directory, "hardlink");
  await link(f.keyFile, hard);
  assert.throws(seal, ProtectedGitHubCustodyErrorV1);
  await rm(hard);
  const alias = join(f.directory, "alias");
  await symlink(f.keyFile, alias);
  const symlinkOwner = new ProtectedGitHubCryptoV1({ ...f.selection, keyFile: alias });
  assert.throws(() => symlinkOwner.assertAvailable(), ProtectedGitHubCustodyErrorV1);
  f.crypto.close();
  assert.throws(seal, ProtectedGitHubCustodyErrorV1);
});

test("protected GitHub envelopes have bounded inputs and generic failures", async (t) => {
  const f = await fixture(t);
  for (const input of [Buffer.alloc(0), Buffer.alloc(32769)]) {
    assert.throws(
      () => f.crypto.seal("github-app-key-v1", ["key"], input),
      ProtectedGitHubCustodyErrorV1,
    );
  }
  const wrong = new ProtectedGitHubCryptoV1({ ...f.selection, keySHA256: "0".repeat(64) });
  assert.throws(
    () => wrong.assertAvailable(),
    (error) => {
      assert.equal(error.message, "Protected GitHub custody is unavailable.");
      assert.equal(String(error).includes(f.directory), false);
      return true;
    },
  );
  assert.throws(
    () => new ProtectedGitHubCryptoV1({ ...f.selection, keyFile: "relative" }),
    ProtectedGitHubCustodyErrorV1,
  );
});
