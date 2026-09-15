import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
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

test("protected GitHub envelopes interoperate with the documented AES-GCM format", async (t) => {
  const f = await fixture(t);
  const key = await readFile(f.keyFile);
  const plaintext = Buffer.from("synthetic-envelope-format-canary");
  const context = ["installation-1", "repository-1"];
  const authenticatedContext = Buffer.from(
    JSON.stringify(["github-installation-token-v1", f.selection.keySHA256, ...context]),
  );
  const recovered = [];
  try {
    // Independent wire offsets catch a paired seal/open format change that a
    // round trip through the owner alone would accept.
    const envelope = f.crypto.seal("github-installation-token-v1", context, plaintext);
    assert.equal(envelope.subarray(0, 6).toString("ascii"), "OCEGH1");
    assert.equal(envelope.length, 34 + plaintext.length);
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.subarray(6, 18), {
      authTagLength: 16,
    });
    decipher.setAAD(authenticatedContext);
    decipher.setAuthTag(envelope.subarray(18, 34));
    recovered.push(decipher.update(envelope.subarray(34)), decipher.final());
    assert.deepEqual(recovered[0], plaintext);
    assert.equal(recovered[1].length, 0);

    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    cipher.setAAD(authenticatedContext);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const externalEnvelope = Buffer.concat([
      Buffer.from("OCEGH1", "ascii"),
      nonce,
      cipher.getAuthTag(),
      ciphertext,
    ]);
    recovered.push(f.crypto.open("github-installation-token-v1", context, externalEnvelope));
    assert.deepEqual(recovered[2], plaintext);
  } finally {
    key.fill(0);
    plaintext.fill(0);
    for (const bytes of recovered) bytes.fill(0);
    f.crypto.close();
  }
});

test("protected GitHub custody cannot be redirected or reopened through public properties", async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const originalSelection = { ...f.selection };
  const plaintext = Buffer.from("synthetic-private-custody-canary");
  const context = ["app-key"];
  const envelope = f.crypto.seal("github-app-key-v1", context, plaintext);

  // The public surface must not expose a key-use callback or the selected key
  // state, even to JavaScript callers that can inspect property descriptors.
  assert.deepEqual(Reflect.ownKeys(f.crypto), []);
  const publicMethods = ["seal", "open", "assertSeparateStorage", "assertAvailable", "close"];
  assert.deepEqual(
    Reflect.ownKeys(ProtectedGitHubCryptoV1.prototype).sort(),
    ["constructor", ...publicMethods].sort(),
  );
  const unregistered = Object.create(ProtectedGitHubCryptoV1.prototype);
  for (const [method, args] of [
    ["seal", ["github-app-key-v1", context, plaintext]],
    ["open", ["github-app-key-v1", context, envelope]],
    ["assertSeparateStorage", [other.directory]],
    ["assertAvailable", []],
    ["close", []],
  ]) {
    assert.throws(() => unregistered[method](...args), Error);
  }

  Object.assign(f.selection, other.selection);
  const rejectPublicCallback = () => {
    throw new Error("public property was used for protected custody");
  };
  Object.assign(f.crypto, {
    selection: other.selection,
    closed: true,
    withKey: rejectPublicCallback,
    aad: rejectPublicCallback,
  });
  const originalOwner = new ProtectedGitHubCryptoV1(originalSelection);
  const recovered = [];
  try {
    f.crypto.assertAvailable();
    recovered.push(f.crypto.open("github-app-key-v1", context, envelope));
    assert.deepEqual(recovered[0], plaintext);
    const sealedAfterTampering = f.crypto.seal("github-app-key-v1", context, plaintext);
    recovered.push(originalOwner.open("github-app-key-v1", context, sealedAfterTampering));
    assert.deepEqual(recovered[1], plaintext);

    f.crypto.close();
    Object.assign(f.crypto, { closed: false, selection: originalSelection });
    f.crypto.close();
    assert.throws(() => f.crypto.assertAvailable(), ProtectedGitHubCustodyErrorV1);
    assert.throws(
      () => f.crypto.seal("github-app-key-v1", context, plaintext),
      ProtectedGitHubCustodyErrorV1,
    );
    assert.throws(
      () => f.crypto.open("github-app-key-v1", context, envelope),
      ProtectedGitHubCustodyErrorV1,
    );
  } finally {
    plaintext.fill(0);
    for (const bytes of recovered) bytes.fill(0);
    originalOwner.close();
    f.crypto.close();
    other.crypto.close();
  }
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
