import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCOUNT_CURRENTNESS_PROFILE_V1,
  accountIAMChecksV1,
  accountSemanticRequirementsV1,
  decodeResolveAccountRequestV1,
  decodeExactAccountActionRequestV1,
  decodeCurrentAccountDiagnosticV1,
  decodeExactAccountActionDiagnosticV1,
  decodeAccountInvalidationObservationV1,
} from "../../packages/contracts/src/index.ts";

const uuid = "12345678-1234-4234-8234-123456789abc";
const installationId = `ins_${uuid}`;
const namespaceId = `ns_${uuid}`;
const agentId = `agt_${uuid}`;
const configurationId = `cfg_${uuid}`;
const serviceAccountId = `sa_${uuid}`;
const secretId = `sec_${uuid}`;
const request = {
  schemaVersion: 1,
  installationId,
  requestId: `req_${uuid}`,
  currentnessProfile: ACCOUNT_CURRENTNESS_PROFILE_V1,
  createdAt: "2026-01-01T00:00:00.000Z",
  deadline: "2026-01-01T00:00:05.000Z",
};
const versions = {
  installation: 1,
  account: 1,
  credential: 2,
  grants: 3,
  iamPolicy: 4,
  semanticMapping: 5,
  driverSelection: 6,
};
const sessionSubject = {
  principalId: "prn_human-a",
  principalKind: "principal",
  accountState: "active",
  credentialMode: "session",
  accountId: "account-a",
  selectedIAM: { driverId: "selected-iam", revision: 3 },
  session: {
    sessionId: "session-a",
    version: 2,
    expiresAt: "2026-01-01T00:01:00.000Z",
  },
};
const keySubject = {
  principalId: "spn_service-a",
  principalKind: "service_principal",
  accountState: "active",
  credentialMode: "service-key",
  serviceClass: "independent",
  namespaceId,
  selectedIAM: { driverId: "selected-iam", revision: 3 },
  key: { keyId: "key-a", version: 2, expiresAt: "2026-01-01T00:01:00.000Z" },
};
function current(subject = sessionSubject) {
  return {
    kind: "current",
    observation: {
      schemaVersion: 1,
      requestId: request.requestId,
      installationId,
      currentnessProfile: ACCOUNT_CURRENTNESS_PROFILE_V1,
      scope: "account-and-selected-iam-only",
      evaluatedAt: request.createdAt,
      validUntil: request.deadline,
      subject: structuredClone(subject),
      versions: { ...versions },
    },
  };
}
function allowed(operation, subject = sessionSubject) {
  return {
    kind: "allowed",
    observation: {
      ...current(subject).observation,
      operation,
      decisionRef: "decision-a",
      evidence: {
        evidenceRef: "evidence-a",
        roleIds: ["role-a"],
        bindingIds: ["binding-a"],
        semanticGrantRef: "semantic-a",
      },
    },
  };
}
const agent = { namespaceId, agentId };
const conversation = {
  ...agent,
  conversationRef: "conversation-a",
  commonGrantRef: "common-a",
};

// These exercise exported representation/composition code, not an auth provider.
test("closed request codecs accept exact server-selected profile and bounded time interval", () => {
  assert.equal(decodeResolveAccountRequestV1(request).kind, "valid");
  assert.equal(
    decodeExactAccountActionRequestV1({
      ...request,
      operation: { kind: "agent.status", target: agent },
      expectedVersions: versions,
    }).kind,
    "valid",
  );
  for (const patch of [
    { schemaVersion: 2 },
    { currentnessProfile: "latest" },
    { deadline: request.createdAt },
    { deadline: "2026-01-01T00:00:05.001Z" },
    { deadline: "2026-02-30T00:00:00.000Z" },
    { principalId: "prn_other" },
    { driverId: "native-fallback" },
    { verified: true },
    { key: "not-accepted-here" },
  ]) {
    assert.equal(decodeResolveAccountRequestV1({ ...request, ...patch }).kind, "invalid");
  }
});

test("exact action codecs reject unsupported actions, foreign shape and incomplete comparisons", () => {
  const base = { ...request, operation: { kind: "agent.status", target: agent } };
  for (const operation of [
    { kind: "operate", target: agent },
    { kind: "attachment.read", target: conversation },
    { kind: "agent.status", target: { ...agent, principalId: "prn_other" } },
    { kind: "agent.status", target: { ...agent, installationId } },
    { kind: "agent.status", target: { agentId } },
    { kind: "agent.status", target: { ...agent, agentId: namespaceId } },
  ]) {
    assert.equal(decodeExactAccountActionRequestV1({ ...base, operation }).kind, "invalid");
  }
  for (const n of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      decodeExactAccountActionRequestV1({ ...base, expectedVersions: { ...versions, grants: n } })
        .kind,
      "invalid",
    );
  }
  assert.equal(
    decodeExactAccountActionRequestV1({ ...base, expectedVersions: { account: 1 } }).kind,
    "invalid",
  );
});

test("session and independent key diagnostics retain distinct principal and credential modes", () => {
  assert.equal(decodeCurrentAccountDiagnosticV1(current()).kind, "valid");
  assert.equal(decodeCurrentAccountDiagnosticV1(current(keySubject)).kind, "valid");
  for (const subject of [
    { ...sessionSubject, principalKind: "service_principal" },
    { ...sessionSubject, key: keySubject.key },
    { ...keySubject, session: sessionSubject.session },
    { ...keySubject, serviceClass: "agent-owned" },
    { ...keySubject, credentialMode: "session" },
    { ...sessionSubject, accountState: "disabled" },
    { ...sessionSubject, session: undefined },
    { ...keySubject, key: { ...keySubject.key, version: 1 } },
  ]) {
    assert.equal(decodeCurrentAccountDiagnosticV1(current(subject)).kind, "invalid");
  }
});

test("expired, changed-profile and overlong positive observations are rejected", () => {
  for (const patch of [
    { validUntil: request.createdAt },
    { validUntil: "2026-01-01T00:00:05.001Z" },
    { currentnessProfile: "cached-allow" },
    { scope: "all-runtime-authority" },
    { versions: { ...versions, credential: 9 } },
    {
      subject: {
        ...sessionSubject,
        session: { ...sessionSubject.session, expiresAt: request.createdAt },
      },
    },
  ]) {
    const value = current();
    Object.assign(value.observation, patch);
    assert.equal(decodeCurrentAccountDiagnosticV1(value).kind, "invalid");
  }
});

test("negative public shapes reveal no foreign account, version or provider failure", () => {
  for (const kind of ["denied", "not-visible", "unavailable"]) {
    assert.deepEqual(decodeCurrentAccountDiagnosticV1({ kind }), {
      kind: "valid",
      value: { kind },
    });
    assert.deepEqual(decodeExactAccountActionDiagnosticV1({ kind }), {
      kind: "valid",
      value: { kind },
    });
    for (const extra of [
      { principalId: "prn_other" },
      { reason: "account-disabled" },
      { currentVersion: 9 },
      { error: "provider-text" },
    ]) {
      assert.equal(decodeCurrentAccountDiagnosticV1({ kind, ...extra }).kind, "invalid");
    }
  }
  assert.equal(decodeCurrentAccountDiagnosticV1({ kind: "expired" }).kind, "invalid");
});

test("diagnostic decoding supplies immutable data, never a trusted handle", () => {
  const source = current();
  const result = decodeCurrentAccountDiagnosticV1(source);
  assert.equal(result.kind, "valid");
  assert.equal(Object.hasOwn(result.value, "authority"), false);
  source.observation.subject.principalId = "prn_changed";
  assert.equal(result.value.observation.subject.principalId, "prn_human-a");
  assert.throws(() => {
    result.value.observation.subject.principalId = "prn_changed";
  }, TypeError);
  assert.equal(decodeCurrentAccountDiagnosticV1({ ...current(), authority: {} }).kind, "invalid");
});

test("decoder rejects getter, prototype, cycles and oversized collections without invoking accessors", () => {
  let reads = 0;
  const getter = { ...request };
  Object.defineProperty(getter, "deadline", {
    enumerable: true,
    get() {
      reads++;
      return request.deadline;
    },
  });
  assert.equal(decodeResolveAccountRequestV1(getter).kind, "invalid");
  assert.equal(reads, 0);
  assert.equal(decodeResolveAccountRequestV1(Object.create(request)).kind, "invalid");
  const cycle = { ...request };
  cycle.self = cycle;
  assert.equal(decodeResolveAccountRequestV1(cycle).kind, "invalid");
  assert.equal(
    decodeResolveAccountRequestV1({ ...request, requestId: "x".repeat(65536) }).kind,
    "invalid",
  );
});

test("Namespace and child-resource creation use existing IAM parent sentinels", () => {
  assert.deepEqual(accountIAMChecksV1(installationId, { kind: "namespace.create", target: {} }), [
    { action: "create", resource: { kind: "namespace", id: installationId } },
    { action: "administer", resource: { kind: "installation", id: installationId } },
  ]);
  for (const [kind, resourceKind] of [
    ["secret.create", "secret"],
    ["service-account.create", "service_account"],
  ]) {
    assert.deepEqual(accountIAMChecksV1(installationId, { kind, target: { namespaceId } }), [
      { action: "create", resource: { kind: resourceKind, id: namespaceId, namespaceId } },
    ]);
  }
  const create = accountIAMChecksV1(installationId, {
    kind: "agent.create",
    target: { namespaceId, configurationId, secretIds: [] },
  });
  assert.deepEqual(create[0], {
    action: "create",
    resource: { kind: "agent", id: namespaceId, namespaceId },
  });
  assert.equal(create[1].resource.id, configurationId);
});

test("closed arrays reject extra properties, holes, noncanonical indices and changed prototypes", () => {
  const operation = {
    kind: "runtime.cleanup",
    target: { ...agent, responsibilityRef: "cleanup-a" },
  };
  for (const modify of [
    (array) => {
      array.extra = "synthetic-array-extra-field";
    },
    (array) => {
      array["01"] = "role-b";
    },
    (array) => {
      array.length = 2;
    },
    (array) => {
      delete array[0];
    },
    (array) => {
      Object.setPrototypeOf(array, null);
    },
    (array) => {
      Object.defineProperty(array, "extra", { value: "role-b" });
    },
  ]) {
    const diagnostic = allowed(operation, keySubject);
    modify(diagnostic.observation.evidence.roleIds);
    assert.equal(decodeExactAccountActionDiagnosticV1(diagnostic).kind, "invalid");
  }
});

test("deploy and both explicit resume sources retain all exact IAM operands", () => {
  const target = { ...agent, configurationId, serviceAccountId, secretIds: [secretId] };
  const deploy = accountIAMChecksV1(installationId, { kind: "agent.deploy", target });
  assert.deepEqual(deploy, [
    { action: "deploy", resource: { kind: "agent", id: agentId, namespaceId } },
    { action: "read", resource: { kind: "configuration", id: configurationId, namespaceId } },
    { action: "read", resource: { kind: "service_account", id: serviceAccountId, namespaceId } },
    { action: "operate", resource: { kind: "secret", id: secretId, namespaceId } },
  ]);
  for (const revision of [
    { revisionSource: "retained", revisionId: `rev_${uuid}` },
    { revisionSource: "saved-draft" },
  ]) {
    const operation = { kind: "agent.resume", target: { ...target, ...revision } };
    assert.deepEqual(accountIAMChecksV1(installationId, operation), [
      { action: "operate", resource: { kind: "agent", id: agentId, namespaceId } },
      ...deploy,
    ]);
    assert.ok(accountSemanticRequirementsV1(operation).includes("agent-executor-secret-use"));
  }
  assert.throws(
    () =>
      accountIAMChecksV1(installationId, {
        kind: "agent.resume",
        target: { ...target, revisionSource: "retained" },
      }),
    TypeError,
  );
});

test("Agent update retains the previous ServiceAccount check when replacing it", () => {
  const previousServiceAccountId = "sa_87654321-4321-4321-8321-cba987654321";
  const checks = accountIAMChecksV1(installationId, {
    kind: "agent.update",
    target: {
      ...agent,
      configurationId,
      serviceAccountId,
      previousServiceAccountId,
      secretIds: [],
    },
  });
  assert.deepEqual(
    checks.filter((c) => c.resource.kind === "service_account").map((c) => c.resource.id),
    [serviceAccountId, previousServiceAccountId],
  );
});

test("operational status, transcript, own/shared cancel and lifecycle remain distinct", () => {
  assert.deepEqual(accountSemanticRequirementsV1({ kind: "agent.status", target: agent }), []);
  assert.ok(
    accountSemanticRequirementsV1({ kind: "conversation.read", target: conversation }).includes(
      "conversation-read",
    ),
  );
  assert.deepEqual(accountSemanticRequirementsV1({ kind: "agent.stop", target: agent }), [
    "lifecycle-manager",
  ]);
  const own = { kind: "turn.cancel.own", target: { ...conversation, turnRef: "turn-a" } };
  const shared = { ...own, kind: "turn.cancel.shared" };
  assert.ok(accountSemanticRequirementsV1(own).includes("own-turn-actor"));
  assert.ok(accountSemanticRequirementsV1(own).includes("explicit-own-cancel"));
  assert.ok(!accountSemanticRequirementsV1(own).includes("explicit-shared-cancel"));
  assert.ok(accountSemanticRequirementsV1(shared).includes("explicit-shared-cancel"));
  assert.ok(!accountSemanticRequirementsV1(shared).includes("explicit-own-cancel"));
  assert.ok(!accountSemanticRequirementsV1(shared).includes("lifecycle-manager"));
  assert.deepEqual(
    accountIAMChecksV1(installationId, own).map((c) => c.action),
    ["operate", "read"],
  );
});

test("model/token check exact Secret and common grant, while cleanup keeps separate responsibility", () => {
  for (const kind of ["model.generate", "repository.token.issue"]) {
    const operation = {
      kind,
      target: {
        ...conversation,
        credentialSecretId: secretId,
        resourceProfileRef: "profile-a",
        operationResourceRef: "resource-a",
        turnRef: "turn-a",
        attemptRef: "attempt-a",
      },
    };
    assert.equal(accountIAMChecksV1(installationId, operation).at(-1).resource.id, secretId);
    assert.ok(accountSemanticRequirementsV1(operation).includes("common-grant-use"));
    assert.equal(
      decodeExactAccountActionDiagnosticV1(allowed(operation, keySubject)).kind,
      "invalid",
    );
  }
  const cleanup = { kind: "runtime.cleanup", target: { ...agent, responsibilityRef: "cleanup-a" } };
  assert.equal(decodeExactAccountActionDiagnosticV1(allowed(cleanup, keySubject)).kind, "valid");
  assert.equal(decodeExactAccountActionDiagnosticV1(allowed(cleanup)).kind, "invalid");
  assert.deepEqual(accountSemanticRequirementsV1(cleanup), ["cleanup-service-responsibility"]);
});

test("scoped service diagnostic cannot project authorization into another Namespace", () => {
  const operation = {
    kind: "agent.status",
    target: { ...agent, namespaceId: "ns_87654321-4321-4321-8321-cba987654321" },
  };
  assert.equal(
    decodeExactAccountActionDiagnosticV1(allowed(operation, keySubject)).kind,
    "invalid",
  );
  assert.equal(
    decodeExactAccountActionDiagnosticV1(
      allowed({ kind: "agent.status", target: agent }, keySubject),
    ).kind,
    "valid",
  );
});

test("invalidation diagnostics require monotonic relevant changes and session/key separation", () => {
  const event = {
    schemaVersion: 1,
    installationId,
    principalId: "prn_human-a",
    principalKind: "principal",
    currentnessProfile: ACCOUNT_CURRENTNESS_PROFILE_V1,
    eventRef: "invalidation-a",
    observedAt: request.createdAt,
    change: "account-disabled",
    previousVersions: versions,
    currentVersions: { ...versions, account: 2, credential: 3 },
  };
  assert.equal(decodeAccountInvalidationObservationV1(event).kind, "valid");
  for (const currentVersions of [
    versions,
    { ...versions, account: 2 },
    { ...versions, account: 2, credential: 3, grants: 1 },
  ]) {
    assert.equal(
      decodeAccountInvalidationObservationV1({ ...event, currentVersions }).kind,
      "invalid",
    );
  }
  assert.equal(
    decodeAccountInvalidationObservationV1({
      ...event,
      change: "session-revoked",
      principalKind: "service_principal",
    }).kind,
    "invalid",
  );
  assert.equal(
    decodeAccountInvalidationObservationV1({ ...event, change: "key-revoked" }).kind,
    "invalid",
  );
});
