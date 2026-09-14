import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, verify } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProtectedGitHubCryptoV1 } from "../../packages/occ/src/credential-custody-v1/protected-github-crypto.ts";
import {
  createProtectedKubernetesGitHubAppMaterialV1,
  sealProtectedKubernetesGitHubAppKeyV1,
  PROTECTED_KUBERNETES_GITHUB_APP_FORMAT_V1,
} from "../../apps/controller/src/drivers/secret/kubernetes/protected-github-app-material.ts";

// Only CoreV1Api's external read boundary is substituted. Production envelope
// crypto, protected key-file checks, source validation and RSA JWT signing run.
// This proves neither live Kubernetes access nor OCE authority/admission.
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const identity = {
  clientId: "Iv1.fixture",
  bindingRef: "binding/github",
  immutableVersion: "version/1",
};
const bounds = () => ({ signal: new AbortController().signal, deadline: Date.now() + 30000 });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, locatorOverrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "protected-github-source-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = join(directory, "master.key");
  const master = randomBytes(32);
  await writeFile(keyFile, master, { mode: 0o600 });
  const masterKey = { keyFile, keySHA256: digest(master) };
  const crypto = new ProtectedGitHubCryptoV1(masterKey);
  master.fill(0);
  t.after(() => crypto.close());
  const locator = {
    driverId: "secret-kubernetes",
    namespaceId: "ns_fixture",
    secretId: "sec_fixture",
    namespaceName: "fixture",
    namespaceUid: "namespace-uid",
    name: "github-app-key",
    key: "key",
    keyIdentity: identity,
    ...locatorOverrides,
  };
  const input = Buffer.from(pem);
  const sealed = sealProtectedKubernetesGitHubAppKeyV1(crypto, locator, input);
  input.fill(0);
  const source = {
    ...locator,
    uid: "secret-uid",
    resourceVersion: "73",
    envelopeSHA256: digest(sealed),
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
        "openclaw.dev/github-client-id": locator.keyIdentity.clientId,
        "openclaw.dev/github-binding-ref": locator.keyIdentity.bindingRef,
        "openclaw.dev/github-immutable-version": locator.keyIdentity.immutableVersion,
      },
    },
    data: { key: sealed.toString("base64") },
  };
  sealed.fill(0);
  const reads = [];
  const client = {
    async readNamespace(request) {
      reads.push(["namespace", request]);
      return structuredClone(namespace);
    },
    async readNamespacedSecret(request) {
      reads.push(["secret", request]);
      return structuredClone(secret);
    },
  };
  const create = (changes = {}) => {
    const material = createProtectedKubernetesGitHubAppMaterialV1({
      client,
      source,
      crypto,
      clock: Date.now,
      ...changes,
    });
    t.after(() => material.close());
    return material;
  };
  return { source, locator, namespace, secret, client, reads, create, crypto, keyFile, masterKey };
}

test("immutable Kubernetes source decrypts actual protected RSA envelope and rereads on every use", async (t) => {
  const f = await fixture(t);
  const material = f.create();
  for (let call = 0; call < 2; call++) {
    const result = await material.withJwt(identity, bounds(), async (jwt, current) => {
      current();
      const [header, payload, signature] = jwt.split(".");
      assert.equal(
        verify(
          "sha256",
          Buffer.from(`${header}.${payload}`),
          pair.publicKey,
          Buffer.from(signature, "base64url"),
        ),
        true,
      );
      assert.equal(JSON.parse(Buffer.from(payload, "base64url")).iss, identity.clientId);
      assert.ok(JSON.parse(Buffer.from(payload, "base64url")).exp * 1000 <= Date.now() + 5000);
      assert.equal(JSON.parse(Buffer.from(header, "base64url")).alg, "RS256");
      return "consumed";
    });
    assert.equal(result, "consumed");
  }
  assert.equal(f.reads.length, 8);
  assert.deepEqual(f.reads[1], ["secret", { namespace: "fixture", name: "github-app-key" }]);
  assert.ok(!JSON.stringify(f.secret).includes("PRIVATE KEY"));
});

test("exact immutable source and namespace ownership failures never reach JWT consumer", async (t) => {
  const mutations = [
    [
      "namespace UID",
      (f) => {
        f.namespace.metadata.uid = "recreated";
      },
    ],
    [
      "namespace ownership",
      (f) => {
        f.namespace.metadata.labels["openclaw.dev/namespace"] = "ns_other";
      },
    ],
    [
      "namespace deletion",
      (f) => {
        f.namespace.metadata.deletionTimestamp = "2026-01-01T00:00:00Z";
      },
    ],
    [
      "mutable Secret",
      (f) => {
        f.secret.immutable = false;
      },
    ],
    [
      "Secret UID",
      (f) => {
        f.secret.metadata.uid = "recreated";
      },
    ],
    [
      "resourceVersion",
      (f) => {
        f.secret.metadata.resourceVersion = "74";
      },
    ],
    [
      "driver",
      (f) => {
        f.secret.metadata.annotations["openclaw.dev/secret-driver-id"] = "other";
      },
    ],
    [
      "binding",
      (f) => {
        f.secret.metadata.annotations["openclaw.dev/github-binding-ref"] = "other";
      },
    ],
    [
      "immutable identity",
      (f) => {
        f.secret.metadata.annotations["openclaw.dev/github-immutable-version"] = "version/2";
      },
    ],
    [
      "model envelope marker",
      (f) => {
        f.secret.metadata.annotations["openclaw.dev/protected-material"] =
          "model-api-key-aes256gcm-v1";
      },
    ],
    [
      "additional key",
      (f) => {
        f.secret.data.extra = f.secret.data.key;
      },
    ],
    [
      "ciphertext digest",
      (f) => {
        const data = Buffer.from(f.secret.data.key, "base64");
        data[data.length - 1] ^= 1;
        f.secret.data.key = data.toString("base64");
      },
    ],
  ];
  for (const [name, change] of mutations)
    await t.test(name, async (t) => {
      const f = await fixture(t);
      change(f);
      let called = false;
      await assert.rejects(
        f.create().withJwt(identity, bounds(), async () => {
          called = true;
        }),
        /GitHub App token issuer unavailable/,
      );
      assert.equal(called, false);
    });
});

test("authenticated ciphertext cannot move to another locator even with a matching digest", async (t) => {
  const f = await fixture(t);
  f.secret.metadata.name = "other-key";
  await assert.rejects(
    f
      .create({ source: { ...f.source, name: "other-key" } })
      .withJwt(identity, bounds(), async () => assert.fail("must not sign")),
    /GitHub App token issuer unavailable/,
  );
});

test("startup source and concrete method selection cannot change through caller mutation", async (t) => {
  const f = await fixture(t);
  const source = structuredClone(f.source);
  const material = f.create({ source });
  source.uid = "replacement";
  source.keyIdentity.bindingRef = "other-binding";
  f.client.readNamespacedSecret = async () => {
    throw new Error("replaced client method");
  };
  f.crypto.open = () => {
    throw new Error("replaced crypto method");
  };
  f.crypto.assertAvailable = () => {
    throw new Error("replaced crypto method");
  };
  assert.equal(
    await material.withJwt(identity, bounds(), async () => "fixed selection"),
    "fixed selection",
  );
});

test("protected master key is checked after API awaits and at consumer continuations", async (t) => {
  await t.test("master removed during read", async (t) => {
    const f = await fixture(t);
    const client = {
      ...f.client,
      async readNamespacedSecret(request) {
        const result = await f.client.readNamespacedSecret(request);
        await rm(f.keyFile);
        return result;
      },
    };
    await assert.rejects(
      f.create({ client }).withJwt(identity, bounds(), async () => assert.fail("must not sign")),
    );
  });
  await t.test("master permissions change during consumer", async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.create().withJwt(identity, bounds(), async (_jwt, current) => {
        await chmod(f.keyFile, 0o644);
        assert.throws(current);
        return "must not transfer";
      }),
    );
  });
});

test("source replacement after JWT consumption rejects the returned result on source recheck", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.create().withJwt(identity, bounds(), async () => {
      f.secret.metadata.uid = "replacement";
      return "must not transfer";
    }),
  );
  assert.equal(f.reads.length, 4);
});

test("cancellation, closure, busy ownership and expired bounds fail closed", async (t) => {
  const f = await fixture(t);
  const material = f.create();
  let release;
  let entered;
  const entering = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const pending = material.withJwt(
    identity,
    { ...bounds(), signal: controller.signal },
    async (_jwt, current) => {
      entered();
      await gate;
      assert.throws(current);
    },
  );
  await entering;
  await assert.rejects(material.withJwt(identity, bounds(), async () => {}));
  controller.abort();
  material.close();
  release();
  await assert.rejects(pending);
  await assert.rejects(material.withJwt(identity, bounds(), async () => {}));
  await assert.rejects(f.create().withJwt(identity, { ...bounds(), deadline: 1 }, async () => {}));
});

test(
  "owner lifetime expires independently of a frozen wall clock",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const now = Date.now();
    await assert.rejects(
      f
        .create({ clock: () => now })
        .withJwt(identity, { ...bounds(), deadline: now + 30000 }, async (_jwt, current) => {
          await new Promise((resolve) => setTimeout(resolve, 5050));
          assert.throws(current);
        }),
    );
  },
);

test("import rejects non-RSA material and use requires the exact fixed key identity", async (t) => {
  const f = await fixture(t);
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  assert.throws(() =>
    sealProtectedKubernetesGitHubAppKeyV1(
      f.crypto,
      f.locator,
      Buffer.from(ec.privateKey.export({ type: "pkcs8", format: "pem" })),
    ),
  );
  const material = f.create();
  await assert.rejects(
    material.withJwt({ ...identity, immutableVersion: "version/2" }, bounds(), async () => {}),
  );
  assert.equal(f.reads.length, 0);
});

test("admitted binding selects protected signing material and withdrawal stops later use", async (t) => {
  const { InMemoryPlatformState } = await import("../../packages/occ/src/index.ts");
  const { prepareProtectedGitHubCredentials } =
    await import("../../apps/controller/src/composition/protected-github-credentials.ts");
  const namespaceId = `ns_${randomUUID()}`;
  const secretId = `sec_${randomUUID()}`;
  const bindingId = `rb_${randomUUID()}`;
  const key = { ...identity, bindingRef: bindingId };
  const f = await fixture(t, { namespaceId, secretId, keyIdentity: key });
  const directory = await mkdtemp(join(homedir(), ".oce-protected-source-test-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storeDirectory = join(directory, "tokens");
  await mkdir(storeDirectory, { mode: 0o700 });
  const state = new InMemoryPlatformState();
  const createdAt = new Date().toISOString();
  const binding = {
    id: bindingId,
    namespaceId,
    appId: 1,
    installationId: 2,
    repositoryIds: [3],
    keySecretRef: { kind: "secret", namespaceId, id: secretId },
    generation: 1,
    state: "unverified",
    createdAt,
  };
  // Real State owns admitted references and generation; only Kubernetes reads
  // are substituted. These cases do not authenticate an Agent or mint a token.
  await state.transact(async (unit) => {
    await unit.installations.createInstallation({
      id: `ins_${randomUUID()}`,
      name: "Signing test",
      createdAt,
    });
    await unit.namespaces.createNamespace({
      id: namespaceId,
      name: "Signing test",
      status: "ready",
      createdAt,
    });
    await unit.secrets.createSecret({
      id: secretId,
      namespaceId,
      name: "Signing key",
      driverId: f.source.driverId,
      backendRef: {
        namespaceName: "fixture",
        name: "logical-key",
        key: "value",
        uid: randomUUID(),
      },
      createdAt,
    });
    await unit.repositoryBindings.createBinding(binding);
  });
  const selection = {
    bindingId,
    bindingGeneration: 1,
    appId: 1,
    installationId: 2,
    repositoryId: 3,
    source: f.source,
    masterKey: f.masterKey,
    tokenStore: { kind: "persistent-posix", directory: storeDirectory, writerMode: "single" },
  };
  const create = (patch = {}) =>
    prepareProtectedGitHubCredentials({
      state,
      client: f.client,
      selection: { ...selection, ...patch },
      clock: Date.now,
    });
  for (const patch of [
    { repositoryId: 4 },
    { appId: 2 },
    { installationId: 3 },
    { bindingGeneration: 2 },
  ])
    await assert.rejects(create(patch));
  assert.equal(f.reads.length, 0, "out-of-scope selections do not read protected material");
  const owner = await create();
  t.after(owner.close);
  await owner.material.withJwt(key, bounds(), async (jwt, current) => {
    current();
    const [header, payload, signature] = jwt.split(".");
    assert.ok(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        pair.publicKey,
        Buffer.from(signature, "base64url"),
      ),
    );
  });
  const reads = f.reads.length;
  await state.transact((unit) =>
    unit.repositoryBindings.updateBinding({ ...binding, generation: 2 }, 1),
  );
  await assert.rejects(
    owner.material.withJwt(key, bounds(), async () => assert.fail("withdrawn binding signed")),
  );
  assert.equal(f.reads.length, reads);
  owner.close();
  assert.throws(() => owner.crypto.assertAvailable());
  await assert.rejects(
    owner.material.withJwt(key, bounds(), async () => assert.fail("closed owner signed")),
  );
});
