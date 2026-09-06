import { isDeepStrictEqual } from "node:util";
import {
  storeBindingPolicyConsistentV1,
  type StoreBindingRefV1,
  type StoreBindingV1,
} from "@openclaw-enterprise/contracts/completed-state-v1";
import type { StoreBindingResultV1 } from "@openclaw-enterprise/contracts/runtime-effects-v1";

type Volume = Extract<StoreBindingV1, { kind: "kubernetes-volume" }>;
type Component = Volume["approvedSubpaths"][number]["component"];
type Mount = Extract<StoreBindingResultV1, { status: "verified" }>["mount"];

/** A comparison projection of already decoded Runtime values. This wrapper is
 * neither a provider observation protocol nor a replacement for its provenance. */
export interface RetainedStoreMountDescriptorV1 {
  readonly store: StoreBindingRefV1;
  readonly component: Component;
  readonly mount: Mount;
}

export interface RetainedStoreDescriptorsV1 {
  readonly stores: readonly StoreBindingV1[];
  /** Null means missing evidence, never an empty set of verified mounts. */
  readonly mounts: readonly RetainedStoreMountDescriptorV1[] | null;
}

export type RetainedStoreCandidateV1 =
  | { readonly status: "present"; readonly descriptors: RetainedStoreDescriptorsV1 }
  | { readonly status: "missing" | "terminating" | "unknown" | "unavailable" };

export type RetainedStorePreflightReasonV1 =
  | "descriptors-match"
  | "store-missing"
  | "store-terminating"
  | "observation-unknown"
  | "observation-unavailable"
  | "inventory-unavailable"
  | "inventory-limit"
  | "inventory-ambiguous"
  | "inventory-mismatch"
  | "owner-mismatch"
  | "binding-mismatch"
  | "store-kind-mismatch"
  | "namespace-mismatch"
  | "claim-replaced"
  | "volume-replaced"
  | "storage-profile-mismatch"
  | "mount-policy-mismatch"
  | "configuration-mismatch"
  | "store-layout-mismatch"
  | "credential-home-subpath"
  | "mount-evidence-missing"
  | "mount-evidence-ambiguous"
  | "mount-binding-mismatch"
  | "mount-identity-mismatch"
  | "mount-subpaths-mismatch";

export interface RetainedStorePreflightResultV1 {
  readonly schemaVersion: 1;
  readonly status: "match" | "mismatch" | "unavailable";
  readonly reasonCode: RetainedStorePreflightReasonV1;
  readonly guarantee: "descriptor-comparison-only";
  /** Existing descriptors contain no transient credential-home overlay fact. */
  readonly credentialHomeExclusion: "not-established";
}

export const RETAINED_STORE_PREFLIGHT_LIMITS_V1 = Object.freeze({
  maxStores: 16,
  maxMounts: 32,
});

const result = (
  status: RetainedStorePreflightResultV1["status"],
  reasonCode: RetainedStorePreflightReasonV1,
): RetainedStorePreflightResultV1 => ({
  schemaVersion: 1,
  status,
  reasonCode,
  guarantee: "descriptor-comparison-only",
  credentialHomeExclusion: "not-established",
});

const sorted = <T>(values: readonly T[], key: (value: T) => string): T[] =>
  [...values].sort((a, b) => (key(a) < key(b) ? -1 : Number(key(a) > key(b))));
const subpathKey = (path: Volume["approvedSubpaths"][number]) =>
  `${path.component}:${path.category}`;
const mountKey = (mount: RetainedStoreMountDescriptorV1) =>
  `${mount.store.logicalStoreRef}:${mount.component}`;
const privateCategories = new Set(["state", "agent", "media"]);
const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

function layoutReason(stores: readonly StoreBindingV1[]): RetainedStorePreflightReasonV1 | null {
  const volumes = sorted(
    stores.filter((store): store is Volume => store.kind === "kubernetes-volume"),
    (store) => store.ref.logicalStoreRef,
  );
  for (const volume of volumes) {
    if (!storeBindingPolicyConsistentV1(volume)) return "store-layout-mismatch";
    for (const path of sorted(volume.approvedSubpaths, subpathKey)) {
      if (path.relativePath.split("/").some((part) => part === "codex-home" || part === ".codex"))
        return "credential-home-subpath";
      if (privateCategories.has(path.category) !== (volume.role === "gateway-private"))
        return "store-layout-mismatch";
    }
    if (
      volume.role === "gateway-private" &&
      [...privateCategories].some(
        (category) => !volume.approvedSubpaths.some((path) => path.category === category),
      )
    )
      return "store-layout-mismatch";
    // Categories may share one claim, but cannot alias or expose each other's parent.
    for (const a of volume.approvedSubpaths)
      for (const b of volume.approvedSubpaths)
        if (a.category !== b.category && overlaps(a.relativePath, b.relativePath))
          return "store-layout-mismatch";
  }
  for (const a of volumes)
    for (const b of volumes)
      if (
        a !== b &&
        a.clusterRef === b.clusterRef &&
        (a.volumeUid === b.volumeUid ||
          a.volumeName === b.volumeName ||
          (a.namespaceUid === b.namespaceUid &&
            (a.claimUid === b.claimUid || a.claimName === b.claimName)))
      )
        return "store-layout-mismatch";
  return null;
}

function bindingReason(
  a: StoreBindingV1,
  b: StoreBindingV1,
): RetainedStorePreflightReasonV1 | null {
  if (!isDeepStrictEqual(a.ref.scope, b.ref.scope)) return "owner-mismatch";
  if (!isDeepStrictEqual(a.ref, b.ref)) return "binding-mismatch";
  if (a.kind !== b.kind || a.role !== b.role) return "store-kind-mismatch";
  if (
    a.storageProfileRef !== b.storageProfileRef ||
    a.storageProfileDigest !== b.storageProfileDigest
  )
    return "storage-profile-mismatch";
  if (a.kind === "configuration-object" && b.kind === "configuration-object")
    return isDeepStrictEqual(a, b) ? null : "configuration-mismatch";
  if (a.kind !== "kubernetes-volume" || b.kind !== "kubernetes-volume")
    return "store-kind-mismatch";
  if (
    a.clusterRef !== b.clusterRef ||
    a.namespaceName !== b.namespaceName ||
    a.namespaceUid !== b.namespaceUid
  )
    return "namespace-mismatch";
  if (a.claimName !== b.claimName || a.claimUid !== b.claimUid) return "claim-replaced";
  if (a.volumeName !== b.volumeName || a.volumeUid !== b.volumeUid) return "volume-replaced";
  const normalize = (value: Volume) => ({
    ...value,
    approvedSubpaths: sorted(value.approvedSubpaths, subpathKey),
  });
  return isDeepStrictEqual(normalize(a), normalize(b)) ? null : "mount-policy-mismatch";
}

function mountReason(
  stores: readonly StoreBindingV1[],
  mounts: readonly RetainedStoreMountDescriptorV1[],
): RetainedStorePreflightReasonV1 | null {
  const expectedCount = stores.reduce(
    (count, store) =>
      count +
      (store.kind === "kubernetes-volume"
        ? new Set(store.approvedSubpaths.map((path) => path.component)).size
        : 0),
    0,
  );
  if (mounts.length < expectedCount) return "mount-evidence-missing";
  if (mounts.length > expectedCount || new Set(mounts.map(mountKey)).size !== mounts.length)
    return "mount-evidence-ambiguous";
  if (new Set(mounts.map((entry) => entry.mount.mountIdentityRef)).size !== mounts.length)
    return "mount-evidence-ambiguous";
  for (const entry of sorted(mounts, mountKey)) {
    const store = stores.find((value) => isDeepStrictEqual(value.ref, entry.store));
    if (!store || store.kind !== "kubernetes-volume") return "mount-binding-mismatch";
    const mount = entry.mount;
    if (
      mount.namespaceUid !== store.namespaceUid ||
      mount.claimUid !== store.claimUid ||
      mount.volumeUid !== store.volumeUid ||
      mount.nodeUid !== store.nodeIdentity.nodeUid ||
      mount.effectiveMountPolicyDigest !== store.mountPolicyDigest ||
      mount.effectiveFilesystem !== store.filesystem ||
      mount.effectiveAccessMode !== store.accessMode ||
      mount.effectiveUid !== store.ownership.uid ||
      mount.effectiveGid !== store.ownership.gid ||
      mount.effectiveFsGroup !== store.ownership.fsGroup
    )
      return "mount-binding-mismatch";
    const admitted = store.approvedSubpaths
      .filter((path) => path.component === entry.component)
      .map(({ component: _component, ...path }) => path);
    if (
      admitted.length === 0 ||
      new Set(mount.subpaths.map((path) => path.category)).size !== mount.subpaths.length ||
      new Set(mount.subpaths.map((path) => path.mountIdentityRef)).size !== mount.subpaths.length ||
      !isDeepStrictEqual(
        sorted(admitted, (path) => path.category),
        sorted(
          mount.subpaths.map(({ mountIdentityRef: _identity, ...path }) => path),
          (path) => path.category,
        ),
      )
    )
      return "mount-subpaths-mismatch";
  }
  return null;
}

/** Compare a complete trusted admitted inventory and candidate descriptors.
 * Callers decode/authenticate inputs, bind mount expectations to the selected
 * candidate, and retain Runtime provenance/currentness checks. No I/O, attachment,
 * writer permission, credential exclusion proof or observation is produced here. */
export function compareRetainedStorePreflightV1(
  expected: RetainedStoreDescriptorsV1,
  candidate: RetainedStoreCandidateV1,
): RetainedStorePreflightResultV1 {
  if (candidate.status !== "present") {
    const reasons = {
      missing: "store-missing",
      terminating: "store-terminating",
      unknown: "observation-unknown",
      unavailable: "observation-unavailable",
    } as const;
    return result("unavailable", reasons[candidate.status]);
  }
  const observed = candidate.descriptors;
  if (expected.stores.length === 0) return result("unavailable", "inventory-unavailable");
  if (
    [expected, observed].some(
      (value) =>
        value.stores.length > RETAINED_STORE_PREFLIGHT_LIMITS_V1.maxStores ||
        (value.mounts !== null &&
          value.mounts.length > RETAINED_STORE_PREFLIGHT_LIMITS_V1.maxMounts),
    )
  )
    return result("unavailable", "inventory-limit");
  for (const inventory of [expected.stores, observed.stores]) {
    if (
      new Set(inventory.map((store) => store.ref.logicalStoreRef)).size !== inventory.length ||
      new Set(inventory.map((store) => store.ref.bindingRef)).size !== inventory.length
    )
      return result("mismatch", "inventory-ambiguous");
    if (
      inventory.some((store) => !isDeepStrictEqual(store.ref.scope, expected.stores[0]!.ref.scope))
    )
      return result("mismatch", "owner-mismatch");
  }
  if (observed.stores.length < expected.stores.length)
    return result("unavailable", "store-missing");
  if (observed.stores.length > expected.stores.length)
    return result("mismatch", "inventory-mismatch");
  for (const store of sorted(expected.stores, (value) => value.ref.logicalStoreRef)) {
    const other = observed.stores.find(
      (value) => value.ref.logicalStoreRef === store.ref.logicalStoreRef,
    );
    if (!other) return result("mismatch", "inventory-mismatch");
    const reason = bindingReason(store, other);
    if (reason) return result("mismatch", reason);
  }
  for (const inventory of [expected.stores, observed.stores]) {
    const reason = layoutReason(inventory);
    if (reason) return result("mismatch", reason);
  }
  if (expected.mounts === null || observed.mounts === null)
    return result("unavailable", "mount-evidence-missing");
  for (const inventory of [expected, observed]) {
    const reason = mountReason(inventory.stores, inventory.mounts!);
    if (reason)
      return result(reason === "mount-evidence-missing" ? "unavailable" : "mismatch", reason);
  }
  const normalizeMount = (entry: RetainedStoreMountDescriptorV1) => ({
    ...entry,
    mount: { ...entry.mount, subpaths: sorted(entry.mount.subpaths, (path) => path.category) },
  });
  if (
    !isDeepStrictEqual(
      sorted(expected.mounts, mountKey).map(normalizeMount),
      sorted(observed.mounts, mountKey).map(normalizeMount),
    )
  )
    return result("mismatch", "mount-identity-mismatch");
  return result("match", "descriptors-match");
}
