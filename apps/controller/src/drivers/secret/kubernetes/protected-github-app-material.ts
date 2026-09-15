import type { TokenIssuerCallBoundsV1 } from "@openclaw-enterprise/contracts";
import { createHash, createPrivateKey, type KeyObject } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { CoreV1Api, V1Namespace, V1Secret } from "@kubernetes/client-node";
import {
  createGitHubAppMaterialV1,
  GitHubAppTokenIssuerErrorV1,
  ProtectedGitHubCryptoV1,
  assertGitHubAppBoundsV1,
  snapshotGitHubAppKeyIdentityV1,
  type GitHubAppKeyIdentityV1,
  type GitHubAppMaterialV1,
} from "@openclaw-enterprise/occ";
import { withComputeAbortSignal } from "../../compute/operation-context.ts";

export const PROTECTED_KUBERNETES_GITHUB_APP_FORMAT_V1 = "github-app-key-aes256gcm-v1";
/** Maximum age of an immutable source observation within one invocation. This
 * is bounded time-of-read evidence, not a linearizable external deletion check. */
export const PROTECTED_KUBERNETES_GITHUB_APP_LEASE_MS_V1 = 5000;

export interface ProtectedKubernetesGitHubAppLocatorV1 {
  readonly driverId: string;
  readonly namespaceId: string;
  readonly secretId: string;
  readonly namespaceName: string;
  readonly namespaceUid: string;
  readonly name: string;
  readonly key: string;
  readonly keyIdentity: GitHubAppKeyIdentityV1;
}
export interface ProtectedKubernetesGitHubAppSourceV1 extends ProtectedKubernetesGitHubAppLocatorV1 {
  readonly uid: string;
  readonly resourceVersion: string;
  readonly envelopeSHA256: string;
}
function unavailable(): never {
  throw new GitHubAppTokenIssuerErrorV1();
}
const annotation = "openclaw.dev/";
const maximumEnvelopeBytes = 32768 + 34;
const maximumEnvelopeChars = 4 * Math.ceil(maximumEnvelopeBytes / 3);

function snapshotLocator(
  input: ProtectedKubernetesGitHubAppLocatorV1,
): ProtectedKubernetesGitHubAppLocatorV1 {
  const keyIdentity = snapshotGitHubAppKeyIdentityV1(input.keyIdentity);
  const selected = {
    driverId: input.driverId,
    namespaceId: input.namespaceId,
    secretId: input.secretId,
    namespaceName: input.namespaceName,
    namespaceUid: input.namespaceUid,
    name: input.name,
    key: input.key,
    keyIdentity,
  };
  if (
    Object.entries(selected).some(
      ([field, value]) =>
        field !== "keyIdentity" &&
        (typeof value !== "string" || !/^[A-Za-z0-9._:/-]{1,253}$/.test(value)),
    ) ||
    !selected.namespaceId.startsWith("ns_") ||
    !selected.secretId.startsWith("sec_") ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(selected.namespaceName) ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(selected.name) ||
    !/^[A-Za-z0-9._-]{1,253}$/.test(selected.key)
  )
    unavailable();
  return Object.freeze(selected);
}
function envelopeContext(source: ProtectedKubernetesGitHubAppLocatorV1): readonly string[] {
  return [
    source.driverId,
    source.namespaceId,
    source.secretId,
    source.namespaceName,
    source.namespaceUid,
    source.name,
    source.key,
    source.keyIdentity.clientId,
    source.keyIdentity.bindingRef,
    source.keyIdentity.immutableVersion,
  ];
}
function parseRsaPrivateKey(bytes: Uint8Array): KeyObject {
  const encoded = Buffer.from(bytes);
  try {
    const key = createPrivateKey({ key: encoded, format: "pem" });
    if (
      key.type !== "private" ||
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) > 8192
    )
      unavailable();
    return key;
  } finally {
    encoded.fill(0);
  }
}

/** Operator import preparation only. The caller owns its input bytes. Store the
 * returned envelope in an immutable Secret with the exact locator annotations,
 * then retain the server-assigned UID/resourceVersion and envelope SHA256 in the
 * trusted selection. No plaintext, KeyObject or material capability is returned. */
export function sealProtectedKubernetesGitHubAppKeyV1(
  crypto: ProtectedGitHubCryptoV1,
  input: ProtectedKubernetesGitHubAppLocatorV1,
  privateKeyBytes: Uint8Array,
): Buffer {
  try {
    if (
      !(privateKeyBytes instanceof Uint8Array) ||
      privateKeyBytes.length < 1 ||
      privateKeyBytes.length > 32768
    )
      unavailable();
    const selected = snapshotLocator(input);
    parseRsaPrivateKey(privateKeyBytes);
    return crypto.seal("github-app-key-v1", envelopeContext(selected), privateKeyBytes);
  } catch {
    return unavailable();
  }
}

function assertNamespaceOwnership(
  value: V1Namespace,
  source: ProtectedKubernetesGitHubAppSourceV1,
): void {
  const meta = value.metadata;
  if (
    meta?.name !== source.namespaceName ||
    meta.uid !== source.namespaceUid ||
    meta.deletionTimestamp !== undefined ||
    value.status?.phase !== "Active" ||
    meta.labels?.["app.kubernetes.io/managed-by"] !== "openclaw-enterprise" ||
    meta.labels?.[`${annotation}namespace`] !== source.namespaceId ||
    meta.annotations?.[`${annotation}namespace-id`] !== source.namespaceId
  )
    unavailable();
}
function decodeSecretEnvelope(
  value: V1Secret,
  source: ProtectedKubernetesGitHubAppSourceV1,
): Buffer {
  const meta = value.metadata;
  const tags = meta?.annotations;
  if (
    value.type !== "Opaque" ||
    value.immutable !== true ||
    meta?.name !== source.name ||
    meta.namespace !== source.namespaceName ||
    meta.uid !== source.uid ||
    meta.resourceVersion !== source.resourceVersion ||
    meta.deletionTimestamp !== undefined ||
    meta.labels?.["app.kubernetes.io/managed-by"] !== "openclaw-enterprise" ||
    meta.labels?.[`${annotation}namespace`] !== source.namespaceId ||
    meta.labels?.[`${annotation}secret`] !== source.secretId ||
    tags?.[`${annotation}namespace-id`] !== source.namespaceId ||
    tags?.[`${annotation}secret-id`] !== source.secretId ||
    tags?.[`${annotation}secret-driver-id`] !== source.driverId ||
    tags?.[`${annotation}protected-material`] !== PROTECTED_KUBERNETES_GITHUB_APP_FORMAT_V1 ||
    tags?.[`${annotation}github-client-id`] !== source.keyIdentity.clientId ||
    tags?.[`${annotation}github-binding-ref`] !== source.keyIdentity.bindingRef ||
    tags?.[`${annotation}github-immutable-version`] !== source.keyIdentity.immutableVersion ||
    !value.data ||
    Object.keys(value.data).length !== 1 ||
    !Object.hasOwn(value.data, source.key)
  )
    unavailable();
  const encoded = value.data[source.key];
  if (
    typeof encoded !== "string" ||
    encoded.length > maximumEnvelopeChars ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  )
    unavailable();
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length <= 34 ||
    bytes.length > maximumEnvelopeBytes ||
    bytes.toString("base64") !== encoded ||
    createHash("sha256").update(bytes).digest("hex") !== source.envelopeSHA256
  )
    unavailable();
  return bytes;
}

interface ProtectedMaterialOwner {
  readonly source: ProtectedKubernetesGitHubAppSourceV1;
  readonly readNamespace: CoreV1Api["readNamespace"];
  readonly readSecret: CoreV1Api["readNamespacedSecret"];
  readonly openEnvelope: ProtectedGitHubCryptoV1["open"];
  readonly assertMasterAvailable: ProtectedGitHubCryptoV1["assertAvailable"];
  readonly clock: () => number;
  closed: boolean;
  busy: boolean;
  active: GitHubAppMaterialV1 | undefined;
}

function createInvocation(owner: ProtectedMaterialOwner, rawBounds: TokenIssuerCallBoundsV1) {
  const { clock } = owner;
  const requested = Object.freeze({
    signal: rawBounds.signal,
    deadline: rawBounds.deadline,
  });
  const now = clock();
  assertGitHubAppBoundsV1(requested, now);
  const bounds = Object.freeze({
    signal: requested.signal,
    deadline: Math.min(requested.deadline, now + PROTECTED_KUBERNETES_GITHUB_APP_LEASE_MS_V1),
  });
  const horizon = performance.now() + PROTECTED_KUBERNETES_GITHUB_APP_LEASE_MS_V1;
  const timeout = AbortSignal.timeout(
    Math.max(1, Math.min(PROTECTED_KUBERNETES_GITHUB_APP_LEASE_MS_V1, bounds.deadline - clock())),
  );
  const signal = AbortSignal.any([bounds.signal, timeout]);
  const current = () => {
    if (owner.closed || signal.aborted || performance.now() >= horizon) unavailable();
    assertGitHubAppBoundsV1(bounds, clock());
    owner.assertMasterAvailable();
  };
  const read = async (): Promise<Buffer> => {
    current();
    const namespace = await withComputeAbortSignal(signal, () =>
      owner.readNamespace({ name: owner.source.namespaceName }),
    );
    current();
    assertNamespaceOwnership(namespace, owner.source);
    const secret = await withComputeAbortSignal(signal, () =>
      owner.readSecret({ namespace: owner.source.namespaceName, name: owner.source.name }),
    );
    current();
    return decodeSecretEnvelope(secret, owner.source);
  };
  return { bounds, current, read };
}

function openSecretEnvelope(owner: ProtectedMaterialOwner, encoded: Buffer): Buffer {
  try {
    return owner.openEnvelope("github-app-key-v1", envelopeContext(owner.source), encoded);
  } finally {
    encoded.fill(0);
  }
}

function createInvocationMaterial(
  owner: ProtectedMaterialOwner,
  encoded: Buffer,
  current: () => void,
): GitHubAppMaterialV1 {
  const plain = openSecretEnvelope(owner, encoded);
  try {
    current();
    return createGitHubAppMaterialV1({
      privateKey: parseRsaPrivateKey(plain),
      identity: owner.source.keyIdentity,
      assertCurrent: current,
      clock: owner.clock,
    });
  } finally {
    plain.fill(0);
  }
}

async function withProtectedJwt<T>(
  owner: ProtectedMaterialOwner,
  expected: GitHubAppKeyIdentityV1,
  rawBounds: TokenIssuerCallBoundsV1,
  consume: (jwt: string, assertMaterialCurrent: () => void) => Promise<T>,
): Promise<T> {
  if (owner.closed || owner.busy) unavailable();
  const identity = snapshotGitHubAppKeyIdentityV1(expected);
  if (JSON.stringify(identity) !== JSON.stringify(owner.source.keyIdentity)) unavailable();
  const { bounds, current, read } = createInvocation(owner, rawBounds);
  owner.busy = true;
  try {
    const encoded = await read();
    current();
    owner.active = createInvocationMaterial(owner, encoded, current);
    const result = await owner.active.withJwt(identity, bounds, consume);
    current();
    const checked = await read();
    checked.fill(0);
    current();
    return result;
  } catch {
    return unavailable();
  } finally {
    owner.active?.close();
    owner.active = undefined;
    owner.busy = false;
  }
}

/** Actual CoreV1Api source boundary. Trusted startup selects the authenticated
 * Kubernetes client, exact immutable source and separate protected master key.
 * This owner grants no State/Work dispatch authority, installation membership,
 * or ordinary mutable Secret support. Provider dispatch must still authenticate
 * the selected current binding through its original authority owner. */
export function createProtectedKubernetesGitHubAppMaterialV1(options: {
  readonly client: Pick<CoreV1Api, "readNamespace" | "readNamespacedSecret">;
  readonly source: ProtectedKubernetesGitHubAppSourceV1;
  readonly crypto: ProtectedGitHubCryptoV1;
  readonly clock: () => number;
}): GitHubAppMaterialV1 {
  const source = Object.freeze({
    ...snapshotLocator(options.source),
    uid: options.source.uid,
    resourceVersion: options.source.resourceVersion,
    envelopeSHA256: options.source.envelopeSHA256,
  });
  if (
    !/^[A-Za-z0-9._:/-]{1,253}$/.test(source.uid) ||
    !/^[A-Za-z0-9._:/-]{1,253}$/.test(source.resourceVersion) ||
    !/^[a-f0-9]{64}$/.test(source.envelopeSHA256)
  )
    unavailable();
  const owner: ProtectedMaterialOwner = {
    source,
    readNamespace: options.client.readNamespace.bind(options.client),
    readSecret: options.client.readNamespacedSecret.bind(options.client),
    openEnvelope: options.crypto.open.bind(options.crypto),
    assertMasterAvailable: options.crypto.assertAvailable.bind(options.crypto),
    clock: options.clock,
    closed: false,
    busy: false,
    active: undefined,
  };
  return Object.freeze({
    withJwt<T>(
      expected: GitHubAppKeyIdentityV1,
      rawBounds: TokenIssuerCallBoundsV1,
      consume: (jwt: string, assertMaterialCurrent: () => void) => Promise<T>,
    ): Promise<T> {
      return withProtectedJwt(owner, expected, rawBounds, consume);
    },
    close() {
      owner.closed = true;
      owner.active?.close();
    },
  });
}
