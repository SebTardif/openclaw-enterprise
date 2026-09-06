import { createHash } from "node:crypto";
import {
  canonicalCredentialStorageRequestV1,
  type CredentialCachePartitionV1,
  type CredentialMaterialHandleV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import type {
  CurrentCredentialAuthorityV1,
  CredentialManagementHandleV1,
} from "@openclaw-enterprise/contracts/credential-authority-v1";
import type {
  NamedCredentialCustodyDependenciesV1,
  NamedCustodyProjectionV1,
  ProtectedMaterialLeaseV1,
} from "@openclaw-enterprise/occ/credential-custody-v1/ports";
import { custodyEqualV1 } from "@openclaw-enterprise/occ/credential-custody-v1/cache";
import { configuration, partition, epoch, at, id } from "./cases.ts";

/** Disconnected test double only. Identity-equal fixture sentinels have no real
 * current authority. No network, encryption, persistence, provider or login. */
export function syntheticBackend(credentialClass: "api-key" | "trusted-login" = "api-key") {
  const profile = configuration(true, credentialClass);
  const p = partition(credentialClass);
  const clock = { wallMs: epoch, monotonicMs: 0, uncertaintyMs: 0 };
  const authority = Object.freeze({}) as CurrentCredentialAuthorityV1;
  const management = Object.freeze({}) as CredentialManagementHandleV1;
  const material = new WeakMap<object, Uint8Array>();
  const released: Uint8Array[] = [];
  // Test-only stand-in for the EXISTING owner journal, retained across new
  // facade instances. Production custody never adds an operation ledger.
  const modelHistory = new Map<
    string,
    { canonical: string; state: "entered" | "used" | "unknown" }
  >();
  const state = {
    reads: 0,
    resolves: 0,
    accountReads: 0,
    authorityChecks: 0,
    effects: 0,
    rotations: 0,
    managementChecks: 0,
    stagedChecks: 0,
    allow: true,
    deniedStore: false,
    unknownCommit: false,
    throwConsumer: false,
    byteLength: 32,
    expiresAtMs: epoch + 120000,
  };
  const hooks: {
    read?: () => Promise<void>;
    authority?: () => Promise<void>;
    consume?: () => Promise<void>;
    commit?: () => Promise<void>;
  } = {};
  let projection: NamedCustodyProjectionV1 = {
    partition: p,
    secret: {
      id: p.binding.secretId,
      namespaceId: p.scope.namespaceId,
      name: "logical-example",
      driverId: p.binding.driverId,
      createdAt: at(0),
      backendRef: {
        namespaceName: "example",
        name: "credential-example",
        key: "credential",
        uid: "uid/example",
      },
    },
    accountKey: {
      namespaceId: p.scope.namespaceId,
      serviceAccountId: "account/example",
      providerId: p.binding.providerId,
      driverId: "provider-driver/example",
      workspaceId: "workspace/example",
    },
    accountLink: {
      providerId: p.binding.providerId,
      driverId: "provider-driver/example",
      externalAccountId: "external-account/example",
      externalCredentialId: "external-credential/example",
      workspaceId: "workspace/example",
    },
    namedSecret: profile.namedSecret,
  };
  function lease(selected: CredentialCachePartitionV1): ProtectedMaterialLeaseV1 {
    const bytes = new Uint8Array(state.byteLength).fill(77);
    const handle = Object.freeze({}) as CredentialMaterialHandleV1;
    material.set(handle, bytes);
    return {
      handle,
      partition: selected,
      byteLength: state.byteLength,
      expiresAtMs: state.expiresAtMs,
      release() {
        bytes.fill(0);
        material.delete(handle);
        released.push(bytes);
      },
    };
  }
  const consume = async (handle: CredentialMaterialHandleV1): Promise<string> => {
    if (!material.has(handle)) throw new Error("Synthetic material ownership denied.");
    state.effects++;
    await hooks.consume?.();
    if (state.throwConsumer) throw new Error("SYNTHETIC-CREDENTIAL-CANARY");
    return "synthetic-consumed";
  };
  const dependencies: NamedCredentialCustodyDependenciesV1 = {
    profile,
    clock: { read: () => ({ ...clock }) },
    consumers: [consume],
    secretDriver: {
      id: p.binding.driverId,
      capability: "secret",
      implementation: "synthetic-metadata-only",
      create: async () => {
        throw new Error("Unused synthetic lifecycle.");
      },
      update: async () => {
        throw new Error("Unused synthetic lifecycle.");
      },
      delete: async () => {
        throw new Error("Unused synthetic lifecycle.");
      },
      resolve: async (secret) => {
        state.resolves++;
        if (state.deniedStore) throw new Error("SYNTHETIC-CREDENTIAL-CANARY");
        return { ...secret.backendRef };
      },
    },
    accountLinks: {
      run: async (work) =>
        work({
          create: async () => {
            throw new Error("Unused synthetic account write.");
          },
          recordCredential: async () => {
            throw new Error("Unused synthetic account write.");
          },
          find: async (key) => {
            state.accountReads++;
            return custodyEqualV1(key, projection.accountKey) ? projection.accountLink : undefined;
          },
        }),
    },
    projections: {
      readCurrent: async (binding) =>
        custodyEqualV1(binding, projection.partition.binding)
          ? structuredClone(projection)
          : undefined,
    },
    custody: {
      kind: "protected-immutable-custody",
      adapter: { ref: "custody-adapter/example", version: 1, digest: profile.profile.digest },
      readMinimumInvocation: async (selected) => {
        state.reads++;
        await hooks.read?.();
        if (state.deniedStore) throw new Error("SYNTHETIC-CREDENTIAL-CANARY");
        return lease(selected.partition);
      },
      confirmStagedVersion: async () => {
        state.stagedChecks++;
        return true;
      },
    },
    useOwner: {
      withCurrentModelUse: async (request, supplied, effect) => {
        state.authorityChecks++;
        await hooks.authority?.();
        if (
          !state.allow ||
          supplied !== authority ||
          !custodyEqualV1(request.binding, projection.partition.binding)
        )
          return { kind: "denied", reason: "authority-denied" };
        const canonical = canonicalCredentialStorageRequestV1("namedUse", request);
        const prior = modelHistory.get(request.operationRef);
        if (prior) {
          if (prior.canonical !== canonical || prior.state === "used")
            return { kind: "conflict", reason: "operation-conflict" };
          return {
            kind: "effect-unknown",
            reason: "provider-outcome-unknown",
            operationRef: request.operationRef,
            nextAction: "exact-readback-only",
          };
        }
        const history = { canonical, state: "entered" as "entered" | "used" | "unknown" };
        modelHistory.set(request.operationRef, history);
        let value;
        try {
          value = await effect();
          history.state = "used";
        } catch (error) {
          history.state = "unknown";
          throw error;
        }
        return {
          kind: "used",
          operationRef: request.operationRef,
          value,
          audit: {
            state: "accepted",
            eventRef: request.originalAuditRef,
            commitRef: "audit-commit/example",
            source: "credential",
            category: "credential",
          },
        };
      },
    },
    rotationOwner: {
      checkManagement: async (_request, supplied) => {
        state.managementChecks++;
        return supplied === management && state.allow;
      },
      commitStagedRotation: async (request, supplied, bounds) => {
        state.rotations++;
        await hooks.commit?.();
        if (supplied !== management || !state.allow)
          return { kind: "denied", reason: "authority-denied" };
        if (bounds.signal.aborted) return { kind: "denied", reason: "expired" };
        if (!custodyEqualV1(projection.partition.binding, request.expectedBinding))
          return { kind: "conflict", reason: "version-conflict" };
        const next = structuredClone(projection.partition);
        const nextPartition = {
          ...next,
          binding: request.replacement,
          ...(next.purpose === "model-use"
            ? { modelBinding: { ...next.modelBinding, binding: request.replacement } }
            : {}),
        };
        projection = {
          ...projection,
          partition: nextPartition,
          namedSecret: {
            ...projection.namedSecret,
            binding: request.replacement,
            resourceVersion: "opaque-revision/replacement",
            immutableVersionRecord: {
              ...projection.namedSecret.immutableVersionRecord,
              version: request.replacement.secretVersion,
            },
          },
        };
        if (state.unknownCommit) throw new Error("SYNTHETIC-CREDENTIAL-CANARY");
        return {
          kind: "rotated",
          binding: request.replacement,
          invalidationVersion: request.expectedInvalidationVersion + 1,
          affectedScanRef: "scan/example",
          receipt: {
            schemaVersion: 1,
            operationRef: request.operationRef,
            intentDigest:
              "sha256:" +
              createHash("sha256")
                .update(canonicalCredentialStorageRequestV1("rotate", request))
                .digest("hex"),
            commitRef: "rotation-commit/example",
            inventoryVersion: 2,
            committedAt: at(0),
          },
          audit: {
            state: "accepted",
            eventRef: "aud_" + id(8),
            commitRef: "rotation-commit/example",
            source: "credential",
            category: "credential",
          },
        };
      },
    },
  };
  return {
    dependencies,
    clock,
    state,
    hooks,
    authority,
    management,
    consume,
    lease,
    released,
    projection: () => projection,
    replaceProjection: (value: NamedCustodyProjectionV1) => {
      projection = value;
    },
  };
}
