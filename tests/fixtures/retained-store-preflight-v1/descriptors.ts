import type { StoreBindingV1 } from "@openclaw-enterprise/contracts/completed-state-v1";
import type {
  RetainedStoreDescriptorsV1,
  RetainedStoreMountDescriptorV1,
} from "@openclaw-enterprise/occ/persistence/retained-store-preflight-v1";

type Volume = Extract<StoreBindingV1, { kind: "kubernetes-volume" }>;
const digest = `sha256:${"a".repeat(64)}`;
const scope = {
  installationId: "ins_00000000-0000-4000-8000-000000000001",
  namespaceId: "ns_00000000-0000-4000-8000-000000000002",
  agentId: "agt_00000000-0000-4000-8000-000000000003",
};

function volume(role: Volume["role"], approvedSubpaths: Volume["approvedSubpaths"]): Volume {
  return {
    schemaVersion: 1,
    kind: "kubernetes-volume",
    ref: {
      schemaVersion: 1,
      scope: { ...scope },
      logicalStoreRef: role,
      bindingRef: `binding-${role}`,
      bindingVersion: 7,
    },
    role,
    clusterRef: "cluster-one",
    namespaceName: "tenant-one",
    namespaceUid: "namespace-uid",
    claimName: `claim-${role}`,
    claimUid: `claim-uid-${role}`,
    volumeName: `pv-${role}`,
    volumeUid: `pv-uid-${role}`,
    storageProfileRef: "local-storage-profile",
    storageProfileDigest: digest,
    filesystem: "ext4",
    accessMode: "ReadWriteOnce",
    volumeMode: "Filesystem",
    nodeIdentity: { nodeRef: "node-one", nodeUid: "node-uid", affinityProfileDigest: digest },
    mountPolicyDigest: digest,
    approvedSubpaths,
    ownership: { uid: 1000, gid: 1000, fsGroup: 1000 },
  };
}

function mounts(store: Volume): RetainedStoreMountDescriptorV1[] {
  return [...new Set(store.approvedSubpaths.map((path) => path.component))].map((component) => ({
    store: structuredClone(store.ref),
    component,
    mount: {
      mountIdentityRef: `${store.role}-${component}-mount`,
      filesystemIdentityRef: `${store.role}-filesystem`,
      namespaceUid: store.namespaceUid,
      claimUid: store.claimUid,
      volumeUid: store.volumeUid,
      nodeUid: store.nodeIdentity.nodeUid,
      effectiveMountPolicyDigest: store.mountPolicyDigest,
      effectiveFilesystem: "ext4",
      effectiveAccessMode: "ReadWriteOnce",
      effectiveUid: 1000,
      effectiveGid: 1000,
      effectiveFsGroup: 1000,
      subpaths: store.approvedSubpaths
        .filter((path) => path.component === component)
        .map(({ component: _component, ...path }) => ({
          ...path,
          mountIdentityRef: `${store.role}-${component}-${path.category}-mount`,
        })),
    },
  }));
}

/** Deterministic descriptor vectors only. No fixture observes a provider or
 * creates a filesystem, mount, transient home, database, or writer barrier. */
export function descriptors(): RetainedStoreDescriptorsV1 {
  const privateStore = volume(
    "gateway-private",
    ["state", "agent", "media"].map((category) => ({
      category: category as "state" | "agent" | "media",
      relativePath: category,
      readOnly: false,
      component: "gateway",
    })),
  );
  const workspace = volume("workspace", [
    { category: "workspace", relativePath: "workspace", readOnly: false, component: "gateway" },
    { category: "workspace", relativePath: "workspace", readOnly: false, component: "harness" },
    { category: "sessions", relativePath: "sessions", readOnly: false, component: "gateway" },
    { category: "sessions", relativePath: "sessions", readOnly: true, component: "harness" },
    {
      category: "generated-images",
      relativePath: "generated-images",
      readOnly: true,
      component: "gateway",
    },
    {
      category: "generated-images",
      relativePath: "generated-images",
      readOnly: false,
      component: "harness",
    },
    {
      category: "bundled-skills",
      relativePath: "bundled-skills",
      readOnly: true,
      component: "gateway",
    },
    {
      category: "bundled-skills",
      relativePath: "bundled-skills",
      readOnly: true,
      component: "harness",
    },
    {
      category: "plugin-skills",
      relativePath: "plugin-skills",
      readOnly: false,
      component: "gateway",
    },
    {
      category: "plugin-skills",
      relativePath: "plugin-skills",
      readOnly: true,
      component: "harness",
    },
  ]);
  const configuration: StoreBindingV1 = {
    schemaVersion: 1,
    kind: "configuration-object",
    ref: {
      schemaVersion: 1,
      scope: { ...scope },
      logicalStoreRef: "config",
      bindingRef: "binding-config",
      bindingVersion: 4,
    },
    role: "configuration",
    backendRef: "configuration-backend",
    objectRef: "configuration-object",
    objectVersion: "immutable-version-4",
    contentDigest: digest,
    storageProfileRef: "configuration-storage-profile",
    storageProfileDigest: digest,
  };
  return {
    stores: [privateStore, workspace, configuration],
    mounts: [...mounts(privateStore), ...mounts(workspace)],
  };
}
