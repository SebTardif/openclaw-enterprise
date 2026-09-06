import {
  parseCredentialStorageV1,
  type CredentialCachePartitionV1,
  type CredentialStorageCallBoundsV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import { custodyEqualV1 } from "./cache.ts";
import {
  CredentialCustodyErrorV1,
  type NamedCredentialCustodyDependenciesV1,
  type NamedCustodyProjectionV1,
  type NamedCredentialMetadataDependenciesV1,
  type NamedCredentialMetadataSelectionV1,
  type NamedCredentialMetadataResultV1,
} from "./ports.ts";

/** Fresh authoritative projection + existing exact named resolution + existing
 * account-link lookup. No material access, authority acceptance or new registry. */
export async function resolveNamedCustodyProjectionV1(
  dependencies: NamedCredentialCustodyDependenciesV1,
  partition: CredentialCachePartitionV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<NamedCustodyProjectionV1> {
  try {
    const binding = partition.binding;
    const profile = dependencies.profile;
    const projection = await dependencies.projections.readCurrent(binding, bounds);
    if (!projection || bounds.signal.aborted) throw new CredentialCustodyErrorV1();
    const actual = parseCredentialStorageV1("cachePartition", projection.partition);
    const named = projection.namedSecret;
    if (
      !custodyEqualV1(partition, actual) ||
      !custodyEqualV1(binding.scope, profile.namedSecret.binding.scope) ||
      binding.providerId !== profile.namedSecret.binding.providerId ||
      binding.driverId !== dependencies.secretDriver.id ||
      binding.driverId !== profile.namedSecret.binding.driverId ||
      !custodyEqualV1(named.binding, binding) ||
      !custodyEqualV1(named.adapter, profile.namedSecret.adapter) ||
      named.clusterBindingRef !== profile.namedSecret.clusterBindingRef ||
      named.namespaceName !== profile.namedSecret.namespaceName ||
      named.versionPolicy !== "immutable-protected-version" ||
      named.rotation !== "stage-version-then-binding-cas-invalidation-scan" ||
      named.immutableVersionRecord.version !== binding.secretVersion ||
      typeof named.resourceVersion !== "string" ||
      named.resourceVersion.length < 1 ||
      named.resourceVersion.length > 200 ||
      projection.secret.id !== binding.secretId ||
      projection.secret.namespaceId !== binding.scope.namespaceId ||
      projection.secret.driverId !== binding.driverId ||
      !custodyEqualV1(projection.secret.backendRef, {
        namespaceName: named.namespaceName,
        name: named.name,
        key: named.key,
        uid: named.uid,
      }) ||
      projection.accountKey.namespaceId !== binding.scope.namespaceId ||
      projection.accountKey.providerId !== binding.providerId ||
      projection.accountLink.providerId !== projection.accountKey.providerId ||
      projection.accountLink.driverId !== projection.accountKey.driverId ||
      projection.accountLink.workspaceId !== projection.accountKey.workspaceId
    )
      throw new CredentialCustodyErrorV1();
    const resolved = await dependencies.secretDriver.resolve(projection.secret);
    if (bounds.signal.aborted || !custodyEqualV1(resolved, projection.secret.backendRef))
      throw new CredentialCustodyErrorV1();
    const linked = await dependencies.accountLinks.run((links) =>
      links.find(projection.accountKey),
    );
    if (bounds.signal.aborted || !linked || !custodyEqualV1(linked, projection.accountLink))
      throw new CredentialCustodyErrorV1();
    // Re-read after external awaits. An old immutable material version alone
    // never proves that this is still the current logical/account binding.
    const current = await dependencies.projections.readCurrent(binding, bounds);
    if (bounds.signal.aborted || !current || !custodyEqualV1(projection, current))
      throw new CredentialCustodyErrorV1();
    return projection;
  } catch {
    throw new CredentialCustodyErrorV1();
  }
}

/** Read existing metadata through canonical repository ports. The caller owns
 * the authoritative exact selection and ambient Installation/read lifetime.
 * No name join, immutable-version invention, permission check or material read. */
export async function readNamedCredentialMetadataV1(
  dependencies: NamedCredentialMetadataDependenciesV1,
  selection: NamedCredentialMetadataSelectionV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<NamedCredentialMetadataResultV1> {
  try {
    const text = (value: string): string => {
      if (typeof value !== "string" || value.length === 0 || value.length > 1024)
        throw new CredentialCustodyErrorV1();
      return value;
    };
    const active = () => {
      if (bounds.signal.aborted) throw new CredentialCustodyErrorV1();
    };
    // Copy only explicit scalars before awaits; request mutation cannot redirect
    // the subsequent reads. These values still do not authenticate their caller.
    const key = Object.freeze({
      namespaceId: text(selection.accountKey.namespaceId),
      serviceAccountId: text(selection.accountKey.serviceAccountId),
      providerId: text(selection.accountKey.providerId),
      driverId: text(selection.accountKey.driverId),
      workspaceId: text(selection.accountKey.workspaceId),
    });
    const selected = Object.freeze({
      secretId: text(selection.secretId),
      secretDriverId: text(selection.secretDriverId),
      accountKey: key,
    });
    active();
    if (dependencies.secretDriver.id !== selected.secretDriverId)
      throw new CredentialCustodyErrorV1();
    const secret = await dependencies.secrets.findSecret(key.namespaceId, selected.secretId);
    active();
    if (
      !secret ||
      secret.id !== selected.secretId ||
      secret.namespaceId !== key.namespaceId ||
      secret.driverId !== selected.secretDriverId
    )
      throw new CredentialCustodyErrorV1();
    // Pass only canonical safe Secret fields to metadata-only driver resolution.
    const exactSecret = Object.freeze({
      id: selected.secretId,
      namespaceId: key.namespaceId,
      driverId: selected.secretDriverId,
      name: text(secret.name),
      createdAt: text(secret.createdAt),
      backendRef: Object.freeze({
        namespaceName: text(secret.backendRef.namespaceName),
        name: text(secret.backendRef.name),
        key: text(secret.backendRef.key),
        uid: text(secret.backendRef.uid),
      }),
    });
    const account = await dependencies.accounts.findServiceAccount(
      key.namespaceId,
      key.serviceAccountId,
    );
    active();
    if (!account || account.id !== key.serviceAccountId || account.namespaceId !== key.namespaceId)
      throw new CredentialCustodyErrorV1();
    // account.credential.secretRef is a name/key hint, not an OCC Secret FK.
    // It is deliberately neither joined nor copied into the observation.
    const binding = await dependencies.accounts.findServiceAccountProviderBinding(
      key.namespaceId,
      key.serviceAccountId,
    );
    active();
    if (
      !binding ||
      binding.providerId !== key.providerId ||
      binding.driverId !== key.driverId ||
      binding.workspaceId !== key.workspaceId ||
      typeof binding.credentialIssued !== "boolean"
    )
      throw new CredentialCustodyErrorV1();
    const credentialIssued = binding.credentialIssued;
    const resolved = await dependencies.secretDriver.resolve(exactSecret);
    active();
    if (!custodyEqualV1(resolved, exactSecret.backendRef)) throw new CredentialCustodyErrorV1();
    const linked = await dependencies.accountLinks.run((links) => links.find(key));
    active();
    if (
      !linked ||
      linked.providerId !== key.providerId ||
      linked.driverId !== key.driverId ||
      linked.workspaceId !== key.workspaceId
    )
      throw new CredentialCustodyErrorV1();
    const accountLink = Object.freeze({
      providerId: key.providerId,
      driverId: key.driverId,
      workspaceId: key.workspaceId,
      externalAccountId: text(linked.externalAccountId),
      externalCredentialId:
        linked.externalCredentialId === null ? null : text(linked.externalCredentialId),
    });
    const unsupported = Object.freeze({
      status: "unsupported",
      reason: "capability-unimplemented",
    } as const);
    return Object.freeze({
      kind: "metadata-observed",
      selection: selected,
      backendRef: exactSecret.backendRef,
      credentialIssued,
      accountLink,
      namedCapabilities: Object.freeze({
        authenticatedExactNamedAccess: unsupported,
        versionedReadAndRotation: unsupported,
      }),
      custody: Object.freeze({ kind: "unprovided" }),
      externalCustody: Object.freeze({ status: "unsupported", reason: "adapter-unprovided" }),
    });
  } catch {
    return Object.freeze({ kind: "unavailable", reason: "secret-unavailable" });
  }
}
