import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, verify } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ProtectedGitHubCryptoV1 } from "../../packages/occ/src/credential-custody-v1/protected-github-crypto.ts";
import {
  createProtectedKubernetesGitHubAppMaterialV1,
  sealProtectedKubernetesGitHubAppKeyV1,
  PROTECTED_KUBERNETES_GITHUB_APP_FORMAT_V1,
} from "../../apps/controller/src/drivers/secret/kubernetes/protected-github-app-material.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const appKeyIdentity = {
  clientId: "Iv1.fixture",
  bindingRef: "binding/github",
  immutableVersion: "version/1",
};
export const jwtCallBounds = () => ({
  signal: new AbortController().signal,
  deadline: Date.now() + 30000,
});
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function createProtectedMasterKey(t) {
  const directory = await mkdtemp(join(tmpdir(), "protected-github-source-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyFile = join(directory, "master.key");
  const master = randomBytes(32);
  try {
    await writeFile(keyFile, master, { mode: 0o600 });
    const masterKey = { keyFile, keySHA256: digest(master) };
    const crypto = new ProtectedGitHubCryptoV1(masterKey);
    t.after(() => crypto.close());
    return { crypto, keyFile, masterKey };
  } finally {
    master.fill(0);
  }
}

function createAppLocator(overrides) {
  return {
    driverId: "secret-kubernetes",
    namespaceId: "ns_fixture",
    secretId: "sec_fixture",
    namespaceName: "fixture",
    namespaceUid: "namespace-uid",
    name: "github-app-key",
    key: "key",
    keyIdentity: { ...appKeyIdentity },
    ...overrides,
  };
}

function sealAppKey(crypto, locator) {
  const input = Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }));
  try {
    return sealProtectedKubernetesGitHubAppKeyV1(crypto, locator, input);
  } finally {
    input.fill(0);
  }
}

function createNamespace(locator) {
  return {
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
}

function createImmutableAppSecret(source, envelope) {
  return {
    type: "Opaque",
    immutable: true,
    metadata: {
      name: source.name,
      namespace: source.namespaceName,
      uid: source.uid,
      resourceVersion: source.resourceVersion,
      labels: {
        "app.kubernetes.io/managed-by": "openclaw-enterprise",
        "openclaw.dev/namespace": source.namespaceId,
        "openclaw.dev/secret": source.secretId,
      },
      annotations: {
        "openclaw.dev/namespace-id": source.namespaceId,
        "openclaw.dev/secret-id": source.secretId,
        "openclaw.dev/secret-driver-id": source.driverId,
        "openclaw.dev/protected-material": PROTECTED_KUBERNETES_GITHUB_APP_FORMAT_V1,
        "openclaw.dev/github-client-id": source.keyIdentity.clientId,
        "openclaw.dev/github-binding-ref": source.keyIdentity.bindingRef,
        "openclaw.dev/github-immutable-version": source.keyIdentity.immutableVersion,
      },
    },
    data: { [source.key]: envelope.toString("base64") },
  };
}

function createKubernetesReadFixture(namespace, secret) {
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
  return { client, reads };
}

export async function protectedGitHubAppMaterialFixture(t, locatorOverrides = {}) {
  const key = await createProtectedMasterKey(t);
  const locator = createAppLocator(locatorOverrides);
  const envelope = sealAppKey(key.crypto, locator);
  const source = {
    ...locator,
    uid: "secret-uid",
    resourceVersion: "73",
    envelopeSHA256: digest(envelope),
  };
  const namespace = createNamespace(locator);
  let secret;
  try {
    secret = createImmutableAppSecret(source, envelope);
  } finally {
    envelope.fill(0);
  }
  const { client, reads } = createKubernetesReadFixture(namespace, secret);
  const createMaterial = (changes = {}) => {
    const material = createProtectedKubernetesGitHubAppMaterialV1({
      client,
      source,
      crypto: key.crypto,
      clock: Date.now,
      ...changes,
    });
    t.after(() => material.close());
    return material;
  };
  return { ...key, source, locator, namespace, secret, client, reads, publicKey, createMaterial };
}

export function verifyJwtSignature(jwt, key) {
  const [header, payload, signature] = jwt.split(".");
  assert.ok(
    verify("sha256", Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, "base64url")),
  );
  return {
    header: JSON.parse(Buffer.from(header, "base64url")),
    claims: JSON.parse(Buffer.from(payload, "base64url")),
  };
}

export async function admittedGitHubCredentialsFixture(t) {
  const { InMemoryPlatformState } = await import("../../packages/occ/src/index.ts");
  const { prepareProtectedGitHubCredentials } =
    await import("../../apps/controller/src/composition/protected-github-credentials.ts");
  const namespaceId = `ns_${randomUUID()}`;
  const secretId = `sec_${randomUUID()}`;
  const bindingId = `rb_${randomUUID()}`;
  const keyIdentity = { ...appKeyIdentity, bindingRef: bindingId };
  const materialFixture = await protectedGitHubAppMaterialFixture(t, {
    namespaceId,
    secretId,
    keyIdentity,
  });
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
      driverId: materialFixture.source.driverId,
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
    source: materialFixture.source,
    masterKey: materialFixture.masterKey,
    tokenStore: { kind: "persistent-posix", directory: storeDirectory, writerMode: "single" },
  };
  const prepareCredentials = async (patch = {}) => {
    const owner = await prepareProtectedGitHubCredentials({
      state,
      client: materialFixture.client,
      selection: { ...selection, ...patch },
      clock: Date.now,
    });
    t.after(owner.close);
    return owner;
  };
  return { materialFixture, state, binding, keyIdentity, selection, prepareCredentials };
}
