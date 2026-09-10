import { randomUUID } from "node:crypto";

// Persistence observations only. These references do not create Work authority,
// admitted revisions, authenticated receivers, provider evidence or custody.
export const ref = (prefix) => `${prefix}/${randomUUID()}`;
export const iso = (time = Date.now()) => new Date(time).toISOString();

export function reserve(owner, { target, lease, now = Date.now() } = {}) {
  const scope = { installationId: owner.installation.id, ...owner.scope };
  const originalScope = {
    installationRef: scope.installationId,
    namespaceRef: scope.namespaceId,
    agentRef: scope.agentId,
    revisionRef: owner.revision.id,
  };
  return {
    schemaVersion: 2,
    method: "reserveRepositoryToken",
    operationRef: ref("reserve"),
    scope,
    createdAt: iso(now),
    lease: lease ?? {
      schemaVersion: 2,
      accessLeaseRef: ref("lease"),
      target: target ?? {
        installationId: scope.installationId,
        githubHost: "github.com",
        appId: "100",
        githubInstallationId: "200",
        repositoryId: String(BigInt(`0x${randomUUID().replaceAll("-", "").slice(0, 12)}`) + 1n),
      },
      original: {
        operationRef: ref("original"),
        requestDigest: `sha256:${"a".repeat(64)}`,
        invocationRef: ref("invocation"),
        scope: originalScope,
      },
      work: { workRef: ref("work"), revision: 1 },
      execution: {
        attempt: {
          installationRef: scope.installationId,
          namespaceRef: scope.namespaceId,
          agentRef: scope.agentId,
          conversationRef: ref("conversation"),
          turnRef: ref("turn"),
          attemptRef: ref("attempt"),
          reservationRef: ref("reservation"),
        },
        assignmentRef: ref("assignment"),
        assignmentVersion: "1",
        executionIncarnationRef: ref("incarnation"),
        executionGeneration: "1",
        receiverRef: ref("receiver"),
        protectedOriginRef: ref("origin"),
        executionProfile: { ref: "execution/profile", revision: "1" },
        predecessor: { kind: "none" },
      },
      createdAt: iso(now),
      notAfter: iso(now + 300_000),
    },
    bindingRef: ref("binding"),
    permissionProfile: { ref: "repository/profile", revision: "1" },
    requestedPermissions: { metadata: "read", contents: "read" },
    deadline: iso(now + 60_000),
  };
}

export function existing(record, method, fields = {}) {
  return {
    schemaVersion: 2,
    method,
    operationRef: ref(method),
    scope: record.issuance.scope,
    target: record.target,
    expectedInventoryVersion: record.inventoryVersion,
    createdAt: iso(),
    ...fields,
  };
}

export function claim(record) {
  const providerAttemptRef = ref("provider-attempt");
  return existing(record, "claimRepositoryMint", {
    providerAttemptRef,
    custodyIdentity: {
      lease: record.issuance.lease,
      key: {
        clientId: "test-app-client",
        bindingRef: record.issuance.bindingRef,
        immutableVersion: "key/1",
      },
      providerAttemptRef,
      tokenRef: `token/${record.target.recordRef}`,
      protectedRevocationRef: `revocation/${record.target.recordRef}`,
    },
  });
}

export function expiry(expiresAt = Date.now() + 120_000) {
  return {
    kind: "provider-expiry",
    expiresAt: iso(expiresAt),
    observedAt: iso(),
    evidenceRef: ref("expiry"),
  };
}

export function accepted(record, fields = {}) {
  return existing(record, "recordRepositoryMint", {
    providerAttemptRef: record.providerAttemptRef,
    evidenceRef: ref("provider-observation"),
    outcome: "accepted",
    tokenRef: `token/${record.target.recordRef}`,
    protectedRevocationRef: `revocation/${record.target.recordRef}`,
    expiry: expiry(),
    returnedPermissions: record.issuance.requestedPermissions,
    scopeAccepted: true,
    ...fields,
  });
}

export function resolve(record, fields = {}) {
  return existing(record, "resolveRepositoryToken", {
    evidenceRef: ref("resolution-observation"),
    outcome: "provider-revoked",
    ...fields,
  });
}

export function claimRevocation(record, fields = {}) {
  const prior = record.revocation;
  return existing(record, "claimRepositoryRevocation", {
    tokenRef: record.tokenRef,
    protectedRevocationRef: record.protectedRevocationRef,
    revocationOperationRef: prior?.revocationOperationRef ?? ref("revocation-operation"),
    expectedRevocationVersion: prior?.version ?? 0,
    previousAttempt: prior
      ? {
          kind: "reconcile",
          providerAttemptRef: prior.providerAttemptRef,
          providerOutcome: prior.state === "not-dispatched" ? "not-dispatched" : "unknown",
        }
      : { kind: "none" },
    ...fields,
  });
}

export function recordRevocation(record, outcome = "confirmed", fields = {}) {
  return existing(record, "recordRepositoryRevocation", {
    tokenRef: record.tokenRef,
    protectedRevocationRef: record.protectedRevocationRef,
    revocationOperationRef: record.revocation.revocationOperationRef,
    claimRef: record.revocation.claimRef,
    claimVersion: record.revocation.claimVersion,
    providerAttemptRef: record.revocation.providerAttemptRef,
    outcome,
    evidenceRef: ref("revocation-observation"),
    observedAt: iso(),
    ...fields,
  });
}
