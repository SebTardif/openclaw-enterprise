import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProtectedGitHubCryptoV1 } from "../../packages/occ/src/credential-custody-v1/protected-github-crypto.ts";
import { ProtectedGitHubTokenStoreV1 } from "../../packages/occ/src/credential-custody-v1/protected-github-token-store.ts";
import { canonicalRepositoryInventoryV2 } from "../../packages/occ/src/credential-inventory-v1/repository-lease-v2.ts";
import { ProtectedGitHubTokenCustodyV1 } from "../../packages/occ/src/credential-custody-v1/protected-github-token-custody.ts";
import {
  createProtectedKubernetesGitHubAppMaterialV1,
  sealProtectedKubernetesGitHubAppKeyV1,
  PROTECTED_KUBERNETES_GITHUB_APP_FORMAT_V1,
} from "../../apps/controller/src/drivers/secret/kubernetes/protected-github-app-material.ts";

// Actual provider, protected Kubernetes material, RSA, crypto and token custody
// run unchanged. Only the external Kubernetes API and GitHub TLS endpoint are
// substituted. This inert lease supplies material provenance, never State/Work
// admission or a committed runtime release.
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const keyIdentity = {
  clientId: "Iv1.settlement",
  bindingRef: "key/settlement",
  immutableVersion: "version/1",
};
function provenance() {
  const scope = {
    installationRef: "ins_00000000-0000-4000-8000-000000000001",
    namespaceRef: "ns_00000000-0000-4000-8000-000000000001",
    agentRef: "agt_00000000-0000-4000-8000-000000000001",
    revisionRef: "rev_00000000-0000-4000-8000-000000000001",
  };
  return {
    lease: {
      schemaVersion: 2,
      accessLeaseRef: "lease/settlement",
      target: {
        installationId: scope.installationRef,
        githubHost: "github.com",
        appId: "100",
        githubInstallationId: "200",
        repositoryId: "300",
      },
      original: {
        operationRef: "original/settlement",
        requestDigest: `sha256:${"a".repeat(64)}`,
        invocationRef: "invocation/settlement",
        scope,
      },
      work: { workRef: "work/settlement", revision: 1 },
      execution: {
        attempt: {
          installationRef: scope.installationRef,
          namespaceRef: scope.namespaceRef,
          agentRef: scope.agentRef,
          conversationRef: "conversation/1",
          turnRef: "turn/1",
          attemptRef: "attempt/1",
          reservationRef: "reservation/1",
        },
        assignmentRef: "assignment/1",
        assignmentVersion: "1",
        executionIncarnationRef: "incarnation/1",
        executionGeneration: "1",
        receiverRef: "receiver/1",
        protectedOriginRef: "origin/1",
        executionProfile: { ref: "execution/profile", revision: "1" },
        predecessor: { kind: "none" },
      },
      createdAt: new Date().toISOString(),
      notAfter: new Date(Date.now() + 60000).toISOString(),
    },
    key: keyIdentity,
    providerAttemptRef: "mint/settlement",
    tokenRef: "token/settlement",
    protectedRevocationRef: "revoke/settlement",
  };
}

async function fixture(t, returnedPermissions) {
  const directory = await mkdtemp(join(homedir(), ".github-observation-"));
  await chmod(directory, 0o700);
  for (const name of ["keys", "tokens"]) await mkdir(join(directory, name), { mode: 0o700 });
  const master = randomBytes(32);
  const keyFile = join(directory, "keys", "master");
  await writeFile(keyFile, master, { mode: 0o600 });
  const keySelection = { keyFile, keySHA256: sha256(master) };
  const crypto = new ProtectedGitHubCryptoV1(keySelection);
  master.fill(0);
  const storeSelection = {
    kind: "persistent-posix",
    directory: join(directory, "tokens"),
    writerMode: "single",
  };
  const store = new ProtectedGitHubTokenStoreV1(storeSelection);
  const tokenIdentity = provenance();
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const locator = {
    driverId: "secret-kubernetes",
    namespaceId: "ns_settlement",
    secretId: "sec_settlement",
    namespaceName: "settlement",
    namespaceUid: "namespace-uid",
    name: "github-app-key",
    key: "key",
    keyIdentity,
  };
  const pem = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  let encoded;
  try {
    encoded = sealProtectedKubernetesGitHubAppKeyV1(crypto, locator, pem);
  } finally {
    pem.fill(0);
  }
  const source = {
    ...locator,
    uid: "secret-uid",
    resourceVersion: "73",
    envelopeSHA256: sha256(encoded),
  };
  const namespace = {
    metadata: {
      name: locator.namespaceName,
      uid: locator.namespaceUid,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": locator.namespaceId,
      },
      annotations: { "openclaw.dev/namespace-id": locator.namespaceId },
    },
    status: { phase: "Active" },
  };
  const secret = {
    type: "Opaque",
    immutable: true,
    metadata: {
      name: locator.name,
      namespace: locator.namespaceName,
      uid: source.uid,
      resourceVersion: source.resourceVersion,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": locator.namespaceId,
        "openclaw.dev/secret": locator.secretId,
      },
      annotations: {
        "openclaw.dev/namespace-id": locator.namespaceId,
        "openclaw.dev/secret-id": locator.secretId,
        "openclaw.dev/secret-driver-id": locator.driverId,
        "openclaw.dev/protected-material": PROTECTED_KUBERNETES_GITHUB_APP_FORMAT_V1,
        "openclaw.dev/github-client-id": keyIdentity.clientId,
        "openclaw.dev/github-binding-ref": keyIdentity.bindingRef,
        "openclaw.dev/github-immutable-version": keyIdentity.immutableVersion,
      },
    },
    data: { key: encoded.toString("base64") },
  };
  encoded.fill(0);
  const client = {
    async readNamespace(request) {
      assert.deepEqual(request, { name: locator.namespaceName });
      return structuredClone(namespace);
    },
    async readNamespacedSecret(request) {
      assert.deepEqual(request, { namespace: locator.namespaceName, name: locator.name });
      return structuredClone(secret);
    },
  };
  const material = createProtectedKubernetesGitHubAppMaterialV1({
    client,
    source,
    crypto,
    clock: Date.now,
  });
  execFileSync(
    "/usr/bin/openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "tls.key"),
      "-out",
      join(directory, "tls.crt"),
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore", timeout: 10000 },
  );
  const ca = await readFile(join(directory, "tls.crt"), "utf8");
  const tlsKey = await readFile(join(directory, "tls.key"));
  const requests = [];
  const sockets = new Set();
  const server = createServer({ key: tlsKey, cert: ca }, async (request, reply) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/app/installations/200/access_tokens");
      const [header, payload, signature] = request.headers.authorization
        .slice("Bearer ".length)
        .split(".");
      assert.equal(
        verify(
          "sha256",
          Buffer.from(`${header}.${payload}`),
          pair.publicKey,
          Buffer.from(signature, "base64url"),
        ),
        true,
      );
      assert.equal(JSON.parse(Buffer.from(payload, "base64url")).iss, keyIdentity.clientId);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks)), {
        repository_ids: [300],
        permissions: { metadata: "read" },
      });
      requests.push({ method: request.method, path: request.url });
      reply.writeHead(201, { "Content-Type": "application/json" });
      reply.end(
        JSON.stringify({
          token: "disposable-provider-observation-token",
          expires_at: new Date(Date.now() + 60000).toISOString(),
          permissions: returnedPermissions,
          repositories: [{ id: 300, full_name: "fixture/repository" }],
        }),
      );
    } catch {
      reply.destroy();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = {
    kind: "local-protocol-test",
    origin: `https://127.0.0.1:${server.address().port}`,
    ca,
  };
  const createProvider = () => {
    const custody = new ProtectedGitHubTokenCustodyV1({
      identity: tokenIdentity,
      crypto,
      store,
      clock: Date.now,
    });
    const provider = custody.createProvider({
      material,
      repositoryFullName: "fixture/repository",
      permissions: { metadata: "read" },
      endpoint,
      // This asserts protocol-call liveness only. No State/Work capability is
      // constructed or asserted by this isolated provider lifecycle test.
      assertDispatchCurrent(attempt) {
        assert.equal(attempt.providerAttemptRef, tokenIdentity.providerAttemptRef);
        attempt.bounds.signal.throwIfAborted();
      },
    });
    return { provider, custody };
  };
  const owned = createProvider();
  t.after(async () => {
    material.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    crypto.close();
    tlsKey.fill(0);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    ...owned,
    createProvider,
    material,
    requests,
    crypto,
    store,
    keySelection,
    storeSelection,
    tokenIdentity,
  };
}

async function mint(f) {
  const result = await f.provider.mint({
    providerAttemptRef: f.tokenIdentity.providerAttemptRef,
    bounds: { signal: new AbortController().signal, deadline: Date.now() + 5000 },
  });
  await f.provider.settleAttempt(result);
  assert.equal(f.requests.length, 1);
  assert.ok(result.material, "the actual returned token must remain available for retention");
  return { result, retained: f.custody.retain(result.material) };
}

function recoverWithNewOwners(t, f) {
  // Close the original owners before reopening the same actual protected files.
  // Recovery must read authenticated ciphertext, rather than the first owner's
  // in-process handle or a test-supplied decoded observation.
  f.material.close();
  f.store.close();
  f.crypto.close();
  const crypto = new ProtectedGitHubCryptoV1(f.keySelection);
  const store = new ProtectedGitHubTokenStoreV1(f.storeSelection);
  t.after(() => {
    store.close();
    crypto.close();
  });
  const custody = new ProtectedGitHubTokenCustodyV1({
    identity: f.tokenIdentity,
    crypto,
    store,
    clock: Date.now,
  });
  const handle = custody.recover();
  assert.ok(handle);
  return custody.retain(handle);
}

test(
  "metadata-only selection sends exact POST scope and retains the actual accepted response map",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, { metadata: "read" });
    const { result, retained } = await mint(f);
    assert.equal(result.kind, "minted");
    assert.equal(retained.observation.scopeAccepted, true);
    assert.deepEqual(retained.observation.returnedPermissions, { metadata: "read" });
    assert.equal(Object.isFrozen(retained.observation.returnedPermissions), true);
    const context = canonicalRepositoryInventoryV2(f.custody.identity);
    const encoded = f.store.read(context);
    assert.ok(encoded);
    try {
      const packet = JSON.parse(encoded);
      assert.equal(packet.schemaVersion, 2);
      assert.deepEqual(packet.observation.returnedPermissions, { metadata: "read" });
      assert.equal(encoded.includes(Buffer.from("disposable-provider-observation-token")), false);
    } finally {
      encoded.fill(0);
    }
    const recovered = recoverWithNewOwners(t, f);
    assert.deepEqual(recovered, retained);
  },
);

test(
  "broader returned permissions survive ciphertext recovery without being replaced by requested scope",
  { timeout: 15000 },
  async (t) => {
    const returned = { metadata: "read", contents: "write", administration: "admin" };
    const f = await fixture(t, returned);
    const { result, retained } = await mint(f);
    assert.equal(result.kind, "unknown");
    assert.equal(result.nextAction, "reconcile-only");
    assert.equal(retained.observation.scopeAccepted, false);
    assert.deepEqual(retained.observation.returnedPermissions, returned);
    assert.equal(Object.isFrozen(retained.observation.returnedPermissions), true);
    assert.throws(() => {
      retained.observation.returnedPermissions.contents = "read";
    }, TypeError);
    const recovered = recoverWithNewOwners(t, f);
    assert.deepEqual(recovered.observation.returnedPermissions, returned);
    assert.equal(recovered.observation.scopeAccepted, false);
    assert.equal(recovered.envelopeSHA256, retained.envelopeSHA256);
  },
);

for (const [description, returned] of [
  ["malformed permission value", { metadata: "read", contents: "superuser" }],
  ["permission name rejected by the inventory codec", { metadata: "read", "contents\n": "read" }],
]) {
  test(
    `${description} retains an unavailable observation and the live token for recovery`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t, returned);
      const { result, retained } = await mint(f);
      assert.equal(result.kind, "unknown");
      assert.equal(result.nextAction, "reconcile-only");
      assert.equal(retained.observation.scopeAccepted, false);
      assert.deepEqual(retained.observation.returnedPermissions, { kind: "unavailable" });
      assert.equal(Object.isFrozen(retained.observation.returnedPermissions), true);
      const recovered = recoverWithNewOwners(t, f);
      assert.equal(recovered.observation.scopeAccepted, false);
      assert.deepEqual(recovered.observation.returnedPermissions, { kind: "unavailable" });
      assert.equal(recovered.envelopeSHA256, retained.envelopeSHA256);
    },
  );
}

test(
  "legacy authenticated ciphertext remains readable with returned permissions absent",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, { metadata: "read" });
    const context = canonicalRepositoryInventoryV2(f.custody.identity);
    // Historical schemaVersion 1 authenticated exactly these three observation
    // fields. Use actual crypto and the actual store to reproduce that persisted
    // format; no current capture API or invented decoded-owner result is used.
    const observation = {
      providerAttemptRef: f.tokenIdentity.providerAttemptRef,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      scopeAccepted: true,
    };
    const plain = Buffer.from("disposable-legacy-observation-token");
    const envelope = f.crypto.seal(
      "github-installation-token-v1",
      [context, canonicalRepositoryInventoryV2(observation)],
      plain,
    );
    const encoded = Buffer.from(
      JSON.stringify({ schemaVersion: 1, observation, envelope: envelope.toString("base64") }),
    );
    try {
      f.store.retain(context, encoded);
    } finally {
      plain.fill(0);
      envelope.fill(0);
      encoded.fill(0);
    }
    const recovered = recoverWithNewOwners(t, f);
    assert.equal(recovered.observation.scopeAccepted, true);
    assert.equal(recovered.observation.returnedPermissions, undefined);
    assert.equal(Object.hasOwn(recovered.observation, "returnedPermissions"), false);
    assert.deepEqual(recovered.observation, observation);
    assert.equal(
      f.requests.length,
      0,
      "legacy recovery cannot reconstruct observations by reminting",
    );
  },
);
