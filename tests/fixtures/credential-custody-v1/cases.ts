import {
  parseCredentialStorageV1,
  CREDENTIAL_STORAGE_LIMITS_V1 as limits,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import {
  parseCredentialBackendProfileV1,
  CREDENTIAL_BACKEND_CAPABILITY_OWNERS_V1 as owners,
} from "@openclaw-enterprise/contracts/credential-backend-profile-v1";
export const epoch = Date.parse("2026-01-01T00:00:00.000Z");
export const at = (ms: number) => new Date(epoch + ms).toISOString();
export const id = (n: number) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
export const digest = "sha256:" + "a".repeat(64);
export const ref = (name: string) => ({ ref: name + "/example", version: 1, digest });
export function partition(
  credentialClass: "api-key" | "trusted-login" | "workload-federation" = "api-key",
  slot = 0,
) {
  const scope = {
    installationId: "ins_" + id(1),
    namespaceId: "ns_" + id(2),
    agentId: "agt_" + id(3),
  };
  const profile = {
    schemaVersion: 1,
    scope,
    profile: ref("profile-" + slot),
    providerId: "provider/example",
    account: ref("account"),
    transport: ref("transport"),
    kind: "model",
    mode: "mediated",
    modelProfile: ref("model"),
    credentialClass,
  };
  const binding = {
    schemaVersion: 1,
    scope,
    bindingRef: "binding/example",
    bindingVersion: 1,
    secretId: "sec_" + id(6),
    secretVersion: 1,
    providerId: profile.providerId,
    account: profile.account,
    driverId: "secret-driver/example",
    backendBindingRef: "backend/example",
  };
  return parseCredentialStorageV1("cachePartition", {
    schemaVersion: 1,
    purpose: "model-use",
    scope,
    profile,
    binding,
    modelBinding: {
      schemaVersion: 1,
      scope,
      profile,
      binding,
      accountLink: ref("account-link"),
      upstreamWorkspaceRef: "workspace/example",
      invocationProfile: ref("invocation"),
      custody: "external-protected-owner",
      setup:
        credentialClass === "api-key"
          ? {
              kind: "api-key-import",
              invocationMaterial: "api-key",
              rotationOwnerRef: "rotation/example",
              lifecycleProfile: ref("lifecycle"),
            }
          : {
              kind: credentialClass,
              invocationMaterial: "access-token-and-account-context",
              refreshOwnerRef: "refresh/example",
              lifecycleProfile: ref("lifecycle"),
            },
    },
  });
}
export function request(
  credentialClass: "api-key" | "trusted-login" | "workload-federation" = "api-key",
  invocation = 0,
) {
  const p = partition(credentialClass);
  if (p.purpose !== "model-use") throw new Error("Synthetic model fixture required.");
  return parseCredentialStorageV1("namedUse", {
    ...p,
    method: "withNamedCredential",
    operationRef: "use/example-" + invocation,
    requestId: "req_" + id(7 + invocation * 2),
    callerServiceRef: "service/example",
    originalAuditRef: "aud_" + id(8 + invocation * 2),
    createdAt: at(0),
    deadline: at(5000),
    original: {
      schemaVersion: 1,
      scope: p.scope,
      assignmentRef: { schemaVersion: 1, id: id(4) },
      revisionId: "rev_" + id(5),
      lifecycleGeneration: 1,
      runtimeGeneration: 1,
      turnRef: "turn/example",
      attemptRef: "attempt/example",
      reservationRef: "reservation/example",
      intentDigest: digest,
      conversationRef: "conversation/example",
      workspaceRef: "workspace/example",
      originalPrincipalRef: "principal/example",
      externalIdentity: ref("identity"),
      receiptRef: "receipt/example",
      logicalMessageRef: "message/example",
      messageContentDigest: digest,
      commonGrant: ref("grant"),
      route: ref("route"),
      audience: ref("audience"),
      policy: ref("policy"),
      canonicalBindingDigest: digest,
      committedDispatchAt: at(0),
      turnNotAfter: at(900000),
    },
  });
}
export function configuration(
  complete = true,
  credentialClass: "api-key" | "trusted-login" = "api-key",
) {
  const p = partition(credentialClass);
  const value = {
    schemaVersion: 1,
    kind: "credential-backend-profile-v1",
    profile: ref("backend-profile"),
    requirements: {
      schemaVersion: 1,
      ...Object.fromEntries(
        Object.keys(owners).map((key) => [
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
      binding: p.binding,
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
      installationId: p.scope.installationId,
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
          materialBindingRef: "material/example",
          tokenBindingRef: "token/example",
          revocationBindingRef: "revocation/example",
          encryptionAndKeyCustodyProfile: ref("encryption"),
        }
      : { kind: "unprovided" },
    cachePartition: p,
    bounds: limits,
    capabilities: {} as Record<string, unknown>,
  };
  for (const [name, owner] of Object.entries(owners))
    value.capabilities[name] = complete
      ? { status: "supported", adapter: value[owner].adapter, evidenceRef: "synthetic/example" }
      : { status: "unsupported", reason: "adapter-unprovided" };
  return parseCredentialBackendProfileV1(value);
}
export function rotation() {
  const use = request();
  const {
    original: _o,
    binding,
    modelBinding: _m,
    purpose: _p,
    ...base
  } = use as Extract<ReturnType<typeof request>, { purpose: "model-use" }>;
  return parseCredentialStorageV1("rotate", {
    ...base,
    method: "rotateBinding",
    operationRef: "rotate/example",
    expectedBinding: binding,
    replacement: { ...binding, bindingVersion: 2, secretVersion: 2 },
    expectedInvalidationVersion: 1,
    invalidationOperationRef: "invalidate/example",
  });
}
