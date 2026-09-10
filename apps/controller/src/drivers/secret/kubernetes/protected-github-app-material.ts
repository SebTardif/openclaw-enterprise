import { createHash, createPrivateKey, type KeyObject } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { CoreV1Api, V1Namespace, V1Secret } from "@kubernetes/client-node";
import { ProtectedGitHubCryptoV1 } from "@openclaw-enterprise/occ/credential-custody-v1/protected-github-crypto";
import {
  createGitHubAppMaterialV1,
  GitHubAppProviderErrorV1,
  assertGitHubAppBoundsV1,
  snapshotGitHubAppKeyIdentityV1,
  type GitHubAppCallBoundsV1,
  type GitHubAppKeyIdentityV1,
  type GitHubAppMaterialV1,
} from "@openclaw-enterprise/occ/github-app-provider-v1/material";
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
  throw new GitHubAppProviderErrorV1();
}
const annotation = "openclaw.dev/";
const maximumEnvelopeBytes = 32768 + 34;
const maximumEnvelopeChars = 4 * Math.ceil(maximumEnvelopeBytes / 3);

function locator(
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
function context(source: ProtectedKubernetesGitHubAppLocatorV1): readonly string[] {
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
function rsa(bytes: Uint8Array): KeyObject {
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
    const selected = locator(input);
    rsa(privateKeyBytes);
    return crypto.seal("github-app-key-v1", context(selected), privateKeyBytes);
  } catch {
    return unavailable();
  }
}

function namespaceMatches(value: V1Namespace, source: ProtectedKubernetesGitHubAppSourceV1): void {
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
function envelope(value: V1Secret, source: ProtectedKubernetesGitHubAppSourceV1): Buffer {
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
    ...locator(options.source),
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
  const readNamespace = options.client.readNamespace.bind(options.client);
  const readSecret = options.client.readNamespacedSecret.bind(options.client);
  const openEnvelope = options.crypto.open.bind(options.crypto);
  const assertMasterAvailable = options.crypto.assertAvailable.bind(options.crypto);
  const clock = options.clock;
  let closed = false;
  let busy = false;
  let active: GitHubAppMaterialV1 | undefined;
  return Object.freeze({
    async withJwt<T>(
      expected: GitHubAppKeyIdentityV1,
      rawBounds: GitHubAppCallBoundsV1,
      consume: (jwt: string, assertMaterialCurrent: () => void) => Promise<T>,
    ): Promise<T> {
      if (closed || busy) unavailable();
      const identity = snapshotGitHubAppKeyIdentityV1(expected);
      if (JSON.stringify(identity) !== JSON.stringify(source.keyIdentity)) unavailable();
      const requested = Object.freeze({ signal: rawBounds.signal, deadline: rawBounds.deadline });
      const now = clock();
      assertGitHubAppBoundsV1(requested, now);
      const bounds = Object.freeze({
        signal: requested.signal,
        deadline: Math.min(requested.deadline, now + PROTECTED_KUBERNETES_GITHUB_APP_LEASE_MS_V1),
      });
      const horizon = performance.now() + PROTECTED_KUBERNETES_GITHUB_APP_LEASE_MS_V1;
      const timeout = AbortSignal.timeout(
        Math.max(
          1,
          Math.min(PROTECTED_KUBERNETES_GITHUB_APP_LEASE_MS_V1, bounds.deadline - clock()),
        ),
      );
      const signal = AbortSignal.any([bounds.signal, timeout]);
      const current = () => {
        if (closed || signal.aborted || performance.now() >= horizon) unavailable();
        assertGitHubAppBoundsV1(bounds, clock());
        assertMasterAvailable();
      };
      const read = async (): Promise<Buffer> => {
        current();
        const namespace = await withComputeAbortSignal(signal, () =>
          readNamespace({ name: source.namespaceName }),
        );
        current();
        namespaceMatches(namespace, source);
        const secret = await withComputeAbortSignal(signal, () =>
          readSecret({ namespace: source.namespaceName, name: source.name }),
        );
        current();
        return envelope(secret, source);
      };
      busy = true;
      let plain: Buffer | undefined;
      try {
        const encoded = await read();
        current();
        try {
          plain = openEnvelope("github-app-key-v1", context(source), encoded);
        } finally {
          encoded.fill(0);
        }
        current();
        active = createGitHubAppMaterialV1({
          privateKey: rsa(plain),
          identity: source.keyIdentity,
          assertCurrent: current,
          clock,
        });
        plain.fill(0);
        plain = undefined;
        const result = await active.withJwt(identity, bounds, consume);
        current();
        const checked = await read();
        checked.fill(0);
        current();
        return result;
      } catch {
        return unavailable();
      } finally {
        plain?.fill(0);
        active?.close();
        active = undefined;
        busy = false;
      }
    },
    close() {
      closed = true;
      active?.close();
    },
  });
}
