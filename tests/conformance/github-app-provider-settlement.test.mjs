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
import { ProtectedGitHubTokenCustodyV1 } from "../../packages/occ/src/credential-custody-v1/protected-github-token-custody.ts";
import {
  createProtectedKubernetesGitHubAppMaterialV1,
  sealProtectedKubernetesGitHubAppKeyV1,
  PROTECTED_KUBERNETES_GITHUB_APP_FORMAT_V1,
} from "../../apps/controller/src/drivers/secret/kubernetes/protected-github-app-material.ts";

// Actual provider, protected Kubernetes material, RSA signer, crypto and token
// custody/store run unchanged. Only external Kubernetes reads and the GitHub TLS
// endpoint are substituted. The inert lease below is material provenance, never
// an admitted Work, a State submitted-use lease or a committed release grant.
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

async function within(promise, description, milliseconds = 3000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(description)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(t) {
  const directory = await mkdtemp(join(homedir(), ".github-settlement-"));
  await chmod(directory, 0o700);
  for (const name of ["keys", "tokens"]) await mkdir(join(directory, name), { mode: 0o700 });
  const master = randomBytes(32);
  const keyFile = join(directory, "keys", "master");
  await writeFile(keyFile, master, { mode: 0o600 });
  const crypto = new ProtectedGitHubCryptoV1({ keyFile, keySHA256: sha256(master) });
  master.fill(0);
  const store = new ProtectedGitHubTokenStoreV1({
    kind: "persistent-posix",
    directory: join(directory, "tokens"),
    writerMode: "single",
  });
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
  const postReadEntered = Promise.withResolvers();
  const postReadRelease = Promise.withResolvers();
  let namespaceReads = 0;
  const client = {
    async readNamespace(request) {
      assert.deepEqual(request, { name: locator.namespaceName });
      if (++namespaceReads === 2) {
        // The actual material owner has completed its JWT consumer and is
        // awaiting a real source refresh. Model an external API that has not
        // settled yet despite caller cancellation; do not replace withJwt.
        postReadEntered.resolve();
        await postReadRelease.promise;
      }
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
        permissions: { metadata: "read", contents: "read" },
      });
      requests.push({ method: request.method, path: request.url });
      reply.writeHead(201, { "Content-Type": "application/json" });
      reply.end(
        JSON.stringify({
          token: "disposable-provider-settlement-token",
          expires_at: new Date(Date.now() + 60000).toISOString(),
          permissions: { metadata: "read", contents: "read" },
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
      permissions: { metadata: "read", contents: "read" },
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
    postReadRelease.resolve();
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
    postReadEntered: postReadEntered.promise,
    releasePostRead: () => postReadRelease.resolve(),
    requests,
  };
}

for (const cancellation of ["deadline", "abort"]) {
  test(
    `provider settlement retains actual immutable-source cleanup after outward ${cancellation}`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t);
      const abort = new AbortController();
      const originalAttempt = {
        providerAttemptRef: "mint/settlement",
        bounds: {
          signal: abort.signal,
          deadline: Date.now() + (cancellation === "deadline" ? 1800 : 10000),
        },
      };
      const outward = f.provider.mint(originalAttempt);
      let drained;
      try {
        await within(
          f.postReadEntered,
          "actual provider response and source postread were not reached",
        );
        assert.equal(f.requests.length, 1);
        // The same caller input is a rejected second invocation; its result must
        // not inherit or replace the original accepted invocation's drain.
        const busy = await f.provider.mint(originalAttempt);
        assert.equal(busy.kind, "not-dispatched");
        assert.equal(
          await within(f.provider.settleAttempt(busy), "busy result took over active drain", 500),
          undefined,
        );
        originalAttempt.providerAttemptRef = "changed-after-invocation";
        if (cancellation === "abort") abort.abort();
        const result = await within(outward, "outward result failed to respect its bounds");
        assert.equal(result.kind, "unknown");
        assert.equal(result.providerAttemptRef, "mint/settlement");
        assert.equal(result.nextAction, "reconcile-only");
        assert.ok(result.material);
        assert.equal(f.custody.recover(), result.material);
        const retained = f.custody.retain(result.material);
        assert.equal(retained.observation.scopeAccepted, true);
        assert.equal(retained.observation.providerAttemptRef, "mint/settlement");
        const originalSnapshot = { ...result };
        await assert.rejects(Promise.resolve().then(() => f.provider.settleAttempt({ ...result })));
        const other = f.createProvider();
        await assert.rejects(Promise.resolve().then(() => other.provider.settleAttempt(result)));
        let settled = false;
        drained = f.provider.settleAttempt(result).then((value) => {
          settled = true;
          return value;
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false, "deadline/cancellation is not source-owner settlement");
        await assert.rejects(
          f.material.withJwt(
            keyIdentity,
            { signal: new AbortController().signal, deadline: Date.now() + 3000 },
            async () => assert.fail("original material is still busy"),
          ),
        );
        f.releasePostRead();
        assert.equal(
          await within(drained, "settlement failed to join released source read"),
          undefined,
        );
        assert.equal(await f.provider.settleAttempt(result), undefined);
        assert.deepEqual(
          result,
          originalSnapshot,
          "settlement must not upgrade the prior unknown outcome",
        );
        // A fresh real material invocation succeeds only after the original owner
        // has run its finally cleanup. This performs no second provider request.
        assert.equal(
          await f.material.withJwt(
            keyIdentity,
            { signal: new AbortController().signal, deadline: Date.now() + 3000 },
            async () => "material available",
          ),
          "material available",
        );
        assert.equal(f.requests.length, 1, "settlement must issue no second network action");
      } finally {
        f.releasePostRead();
        // An assertion can fail before drained is assigned. Join the actual
        // invocation even then, before the fixture closes its crypto and store.
        const originalResult = await outward.catch(() => undefined);
        if (originalResult !== undefined)
          await f.provider.settleAttempt(originalResult).catch(() => {});
        await drained?.catch(() => {});
      }
    },
  );
}
