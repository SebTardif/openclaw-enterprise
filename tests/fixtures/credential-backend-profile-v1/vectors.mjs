import { CREDENTIAL_STORAGE_LIMITS_V1 } from "@openclaw-enterprise/contracts/credential-storage-v1";
import { CREDENTIAL_BACKEND_CAPABILITY_OWNERS_V1 } from "@openclaw-enterprise/contracts/credential-backend-profile-v1";

// Synthetic configuration-only examples. No reference resolves a real backend,
// credential or authority; supported means a test declaration, not an attestation.
export const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const digest = `sha256:${"a".repeat(64)}`;
export const ref = (name) => ({ ref: `${name}/example`, version: 1, digest });
export const scope = () => ({
  installationId: `ins_${id(1)}`,
  namespaceId: `ns_${id(2)}`,
  agentId: `agt_${id(3)}`,
});
export const binding = () => ({
  schemaVersion: 1,
  scope: scope(),
  bindingRef: "binding/example",
  bindingVersion: 1,
  secretId: `sec_${id(4)}`,
  secretVersion: 1,
  providerId: "provider/example",
  account: ref("account"),
  driverId: "driver/example",
  backendBindingRef: "backend/example",
});
export const profile = (model = false) => ({
  schemaVersion: 1,
  scope: scope(),
  profile: ref("profile"),
  providerId: "provider/example",
  account: ref("account"),
  transport: ref("transport"),
  ...(model
    ? { kind: "model", mode: "mediated", modelProfile: ref("model"), credentialClass: "api-key" }
    : {
        kind: "repository",
        mode: "native",
        providerInstallationRef: "provider-installation/example",
        permissionProfile: ref("permission"),
        credentialClass: "installation-token",
      }),
});
export const grant = () => ({
  providerInstallationRef: "provider-installation/example",
  repositoryIds: ["1001"],
  permissions: [{ name: "contents", access: "read" }],
  permissionProfile: ref("permission"),
});
export function modelBinding() {
  return {
    schemaVersion: 1,
    scope: scope(),
    profile: profile(true),
    binding: binding(),
    accountLink: ref("account-link"),
    upstreamWorkspaceRef: "workspace/example",
    invocationProfile: ref("invocation"),
    custody: "external-protected-owner",
    setup: {
      kind: "api-key-import",
      invocationMaterial: "api-key",
      rotationOwnerRef: "rotation/example",
      lifecycleProfile: ref("lifecycle"),
    },
  };
}
export function declaration({ complete = false, model = false } = {}) {
  const value = {
    schemaVersion: 1,
    kind: "credential-backend-profile-v1",
    profile: ref("backend-profile"),
    requirements: {
      schemaVersion: 1,
      ...Object.fromEntries(
        Object.keys(CREDENTIAL_BACKEND_CAPABILITY_OWNERS_V1).map((key) => [
          key,
          key === "auditCoupling" ? "same-transaction" : true,
        ]),
      ),
    },
    placement: {
      kind: "local-typescript",
      trustedServiceRef: "service/example",
      serviceIdentity: "spiffe://example.test/credential-owner",
      materialBoundary: "outside-agent-execution",
      handleTransport: "in-process-only",
    },
    namedSecret: {
      kind: "kubernetes-secret-driver",
      adapter: ref("named-adapter"),
      binding: binding(),
      clusterBindingRef: "cluster/example",
      namespaceName: "example",
      name: "credential-example",
      key: "credential",
      uid: "uid/example",
      resourceVersion: "opaque-revision/example",
      immutableVersionRecord: ref("secret-version"),
      versionPolicy: "immutable-protected-version",
      rotation: "stage-version-then-binding-cas-invalidation-scan",
    },
    inventory: {
      kind: "postgresql-ambient-owner",
      adapter: ref("inventory-adapter"),
      installationId: scope().installationId,
      databaseBindingRef: "database/example",
      journalBindingRef: "journal/example",
      unitOfWorkBindingRef: "uow/example",
      auditBindingRef: "audit/example",
      transaction: "same-borrowed-client-lifetime-and-poisoning",
      auditCoupling: "same-transaction",
      callbackGate: "owner-known-outer-commit-before-callback",
      uncertainty: "exact-original-readback-no-blind-retry",
      capacity: "deny-new-work-retain-unresolved",
      terminalRetention: "minimum-separate-from-audit-copy",
    },
    custody: complete
      ? {
          kind: "external-protected-adapter",
          adapter: ref("custody-adapter"),
          materialBindingRef: "material-store/example",
          tokenBindingRef: "token-store/example",
          revocationBindingRef: "revoke-store/example",
          encryptionAndKeyCustodyProfile: ref("encryption"),
        }
      : { kind: "unprovided" },
    cachePartition: {
      schemaVersion: 1,
      purpose: model ? "model-use" : "repository-mint",
      scope: scope(),
      profile: profile(model),
      binding: binding(),
      ...(model ? { modelBinding: modelBinding() } : { grant: grant() }),
    },
    bounds: structuredClone(CREDENTIAL_STORAGE_LIMITS_V1),
    capabilities: {},
  };
  for (const [name, owner] of Object.entries(CREDENTIAL_BACKEND_CAPABILITY_OWNERS_V1)) {
    value.capabilities[name] = complete
      ? {
          status: "supported",
          adapter: structuredClone(value[owner].adapter),
          evidenceRef: "synthetic-declaration/example",
        }
      : {
          status: owner === "custody" ? "unsupported" : "unproved",
          reason: owner === "custody" ? "adapter-unprovided" : "owner-integration-unproved",
        };
  }
  return value;
}
