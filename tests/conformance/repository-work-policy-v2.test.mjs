import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRepositoryWorkPolicyV2,
  repositoryWorkPolicyDigestV2,
  evaluateRepositoryWorkPolicyV2,
  evaluateRepositoryWorkProtocolPolicyV2,
  repositoryWorkPolicyArmMatchesV2,
} from "../../packages/occ/src/lifecycle/repository-work-policy-v2.ts";

// Policy representation/comparison cases, not an authenticated management or
// execution-admission fixture. Actual IAM/State producers own those operations.
const copy = (value) => structuredClone(value);
function fixture() {
  const policy = {
    schemaVersion: 2,
    policyRef: "policy/one",
    version: 1,
    status: "enabled",
    scope: { installationId: "i", namespaceId: "n", agentId: "a" },
    servicePrincipalId: "service/one",
    repository: {
      target: {
        installationId: "i",
        githubHost: "github.com",
        appId: "123",
        githubInstallationId: "456",
        repositoryId: "789",
      },
      owner: "example",
      name: "project",
      profile: { ref: "repository-profile/one", revision: "1" },
    },
    executionProfile: { ref: "execution-profile/one", revision: "1" },
    operations: ["metadata:read"],
    bounds: {
      notBefore: "2026-09-10T00:00:00.000Z",
      notAfter: "2026-09-11T00:00:00.000Z",
      maximumWorkMilliseconds: 600000,
    },
  };
  const execution = {
    attempt: {
      installationRef: "i",
      namespaceRef: "n",
      agentRef: "a",
      conversationRef: "c",
      turnRef: "t",
      attemptRef: "attempt",
      reservationRef: "reservation",
    },
    assignmentRef: "assignment/one",
    assignmentVersion: "1",
    executionIncarnationRef: "incarnation/one",
    executionGeneration: "1",
    receiverRef: "receiver/one",
    protectedOriginRef: "origin/one",
    executionProfile: copy(policy.executionProfile),
    predecessor: { kind: "none" },
  };
  const use = {
    scope: { installationRef: "i", namespaceRef: "n", agentRef: "a", revisionRef: "revision/one" },
    service: { kind: "service_principal", id: "service/one", namespaceId: "n", agentId: "a" },
    execution,
    admitted: {
      policyRef: policy.policyRef,
      policyVersion: 1,
      policyDigest: repositoryWorkPolicyDigestV2(policy),
      execution: copy(execution),
      originalHorizon: "2026-09-10T01:10:00.000Z",
    },
    repository: copy(policy.repository),
    operation: "metadata:read",
    workBeganAt: "2026-09-10T01:00:00.000Z",
    originalHorizon: "2026-09-10T01:10:00.000Z",
    now: "2026-09-10T01:01:00.000Z",
  };
  return { policy, use };
}
test("metadata comparison returns only exact read permissions and original finite horizon", () => {
  const { policy, use } = fixture();
  const parsed = parseRepositoryWorkPolicyV2(policy);
  assert.ok(parsed);
  assert.notEqual(parsed, policy);
  assert.ok(Object.isFrozen(parsed.repository.target));
  const result = evaluateRepositoryWorkPolicyV2(policy, use);
  assert.equal(result.kind, "matches");
  assert.deepEqual(result.requiredPermissions, ["metadata:read"]);
  assert.equal(result.originalHorizon, use.originalHorizon);
});
test("explicit Git read requires metadata and contents while metadata never gains contents", () => {
  const { policy, use } = fixture();
  use.operation = "git:read";
  assert.equal(evaluateRepositoryWorkPolicyV2(policy, use).reason, "operation");
  policy.operations.push("git:read");
  use.admitted.policyDigest = repositoryWorkPolicyDigestV2(policy);
  assert.deepEqual(evaluateRepositoryWorkPolicyV2(policy, use).requiredPermissions, [
    "contents:read",
    "metadata:read",
  ]);
  use.operation = "metadata:read";
  assert.deepEqual(evaluateRepositoryWorkPolicyV2(policy, use).requiredPermissions, [
    "metadata:read",
  ]);
});
for (const operation of [
  "repository.token.issue",
  "authority.renew",
  "contents:write",
  "publish",
  "git:write",
])
  test(`unselected operation ${operation} is not repository use`, () => {
    const { policy, use } = fixture();
    use.operation = operation;
    assert.equal(evaluateRepositoryWorkPolicyV2(policy, use).kind, "refused");
    policy.operations = ["metadata:read", operation];
    assert.equal(parseRepositoryWorkPolicyV2(policy), undefined);
  });
for (const [name, change, reason] of [
  [
    "disabled policy",
    (p) => {
      p.policy.status = "disabled";
    },
    "disabled",
  ],
  [
    "new policy version",
    (p) => {
      p.policy.version = 2;
    },
    "fresh-context-required",
  ],
  [
    "same-version changed body",
    (p) => {
      p.policy.bounds.maximumWorkMilliseconds++;
    },
    "fresh-context-required",
  ],
  [
    "another execution generation",
    (p) => {
      p.use.execution.executionGeneration = "2";
    },
    "fresh-context-required",
  ],
  [
    "another policy reference",
    (p) => {
      p.use.admitted.policyRef = "policy/other";
    },
    "fresh-context-required",
  ],
  [
    "another namespace",
    (p) => {
      p.use.scope.namespaceRef = "other";
    },
    "scope",
  ],
  [
    "another service",
    (p) => {
      p.use.service.id = "other";
    },
    "service",
  ],
  [
    "human operator in service position",
    (p) => {
      p.use.service = { kind: "user", id: "user/one" };
    },
    "service",
  ],
  [
    "another GitHub installation",
    (p) => {
      p.use.repository.target.githubInstallationId = "999";
    },
    "repository",
  ],
  [
    "renamed repository",
    (p) => {
      p.use.repository.name = "other";
    },
    "repository",
  ],
  [
    "another repository profile",
    (p) => {
      p.use.repository.profile.revision = "2";
    },
    "repository",
  ],
  [
    "another execution profile",
    (p) => {
      p.use.execution.executionProfile.revision = "2";
      p.use.admitted.execution = copy(p.use.execution);
    },
    "profile",
  ],
  [
    "expired Work",
    (p) => {
      p.use.now = p.use.originalHorizon;
    },
    "horizon",
  ],
  [
    "extended original horizon",
    (p) => {
      p.use.originalHorizon = "2026-09-10T01:11:00.000Z";
    },
    "horizon",
  ],
  [
    "Work exceeding configured maximum",
    (p) => {
      p.use.workBeganAt = "2026-09-10T00:59:59.000Z";
    },
    "horizon",
  ],
  [
    "time before Work began",
    (p) => {
      p.use.now = "2026-09-10T00:59:00.000Z";
    },
    "horizon",
  ],
])
  test(`${name} refuses without selecting replacement authority`, () => {
    const f = fixture();
    change(f);
    assert.equal(evaluateRepositoryWorkPolicyV2(f.policy, f.use).reason, reason);
  });
for (const [name, change] of [
  [
    "infinite maximum",
    (p) => {
      p.bounds.maximumWorkMilliseconds = Infinity;
    },
  ],
  [
    "zero maximum",
    (p) => {
      p.bounds.maximumWorkMilliseconds = 0;
    },
  ],
  [
    "noncanonical timestamp",
    (p) => {
      p.bounds.notAfter = "2026-09-11";
    },
  ],
  [
    "unknown policy field",
    (p) => {
      p.allow = true;
    },
  ],
  [
    "another host",
    (p) => {
      p.repository.target.githubHost = "example.com";
    },
  ],
  [
    "noncanonical repository id",
    (p) => {
      p.repository.target.repositoryId = "0789";
    },
  ],
  [
    "duplicate operation",
    (p) => {
      p.operations.push("metadata:read");
    },
  ],
  [
    "Git without metadata",
    (p) => {
      p.operations = ["git:read"];
    },
  ],
  [
    "scope-target mismatch",
    (p) => {
      p.repository.target.installationId = "other";
    },
  ],
])
  test(`closed policy parsing rejects ${name}`, () => {
    const { policy } = fixture();
    change(policy);
    assert.equal(parseRepositoryWorkPolicyV2(policy), undefined);
  });
test("input getters and proxies are rejected without invocation and output is detached", () => {
  const { policy } = fixture();
  let calls = 0;
  const evil = { ...policy };
  Object.defineProperty(evil, "bounds", {
    enumerable: true,
    get() {
      calls++;
      return policy.bounds;
    },
  });
  assert.equal(parseRepositoryWorkPolicyV2(evil), undefined);
  assert.equal(
    parseRepositoryWorkPolicyV2(
      new Proxy(policy, {
        ownKeys() {
          calls++;
          return [];
        },
      }),
    ),
    undefined,
  );
  assert.equal(calls, 0);
  const parsed = parseRepositoryWorkPolicyV2(policy);
  policy.repository.target.repositoryId = "999";
  assert.equal(parsed.repository.target.repositoryId, "789");
});
test("full original execution and terminated predecessor are retained and required", () => {
  const { policy, use } = fixture();
  delete use.execution.assignmentVersion;
  use.admitted.execution = copy(use.execution);
  assert.equal(evaluateRepositoryWorkPolicyV2(policy, use).reason, "invalid");
  const f = fixture();
  f.use.execution.predecessor = {
    kind: "terminated-original",
    attempt: copy(f.use.execution.attempt),
    assignmentRef: "old/assignment",
    executionIncarnationRef: "old/incarnation",
    terminationEvidenceRef: "evidence/termination",
  };
  f.use.admitted.execution = copy(f.use.execution);
  assert.equal(evaluateRepositoryWorkPolicyV2(f.policy, f.use).kind, "matches");
});
test("canonical digest ignores property insertion order without normalizing values", () => {
  const { policy } = fixture();
  const reversed = Object.fromEntries(Object.entries(policy).reverse());
  assert.equal(repositoryWorkPolicyDigestV2(policy), repositoryWorkPolicyDigestV2(reversed));
  reversed.repository = { ...policy.repository, owner: "Example" };
  assert.notEqual(repositoryWorkPolicyDigestV2(policy), repositoryWorkPolicyDigestV2(reversed));
});

const gitArm = {
  repositoryOperation: "git:read",
  requiredPermissions: ["contents:read", "metadata:read"],
};
for (const version of [2, 3])
  test(`constructor-selected protocol ${version} retains its exact permission set`, () => {
    const { policy, use } = fixture();
    policy.operations.push("git:read");
    use.admitted.policyDigest = repositoryWorkPolicyDigestV2(policy);
    use.operation = version === 3 ? "git:read" : "metadata:read";
    const result = evaluateRepositoryWorkProtocolPolicyV2(
      policy,
      use,
      version,
      version === 3 ? gitArm : { permission: "metadata:read" },
    );
    assert.equal(result.kind, "matches");
    assert.deepEqual(
      result.requiredPermissions,
      version === 3 ? ["contents:read", "metadata:read"] : ["metadata:read"],
    );
  });
for (const [name, arm] of [
  ["metadata arm", { permission: "metadata:read" }],
  ["missing contents", { ...gitArm, requiredPermissions: ["metadata:read"] }],
  ["missing metadata", { ...gitArm, requiredPermissions: ["contents:read"] }],
  ["reversed", { ...gitArm, requiredPermissions: ["metadata:read", "contents:read"] }],
  [
    "duplicate",
    { ...gitArm, requiredPermissions: ["contents:read", "metadata:read", "metadata:read"] },
  ],
  [
    "extra permission",
    { ...gitArm, requiredPermissions: ["contents:read", "metadata:read", "issues:read"] },
  ],
  ["write permission", { ...gitArm, requiredPermissions: ["contents:write", "metadata:read"] }],
  ["crossed extra arm", { ...gitArm, permission: "metadata:read" }],
])
  test(`Git protocol policy refuses ${name}`, () => {
    const { policy, use } = fixture();
    policy.operations.push("git:read");
    use.admitted.policyDigest = repositoryWorkPolicyDigestV2(policy);
    use.operation = "git:read";
    assert.equal(repositoryWorkPolicyArmMatchesV2(3, arm), false);
    assert.equal(evaluateRepositoryWorkProtocolPolicyV2(policy, use, 3, arm).kind, "refused");
  });
for (const version of [2, 3])
  test(`protocol ${version} rejects the other operation even under a policy allowing both`, () => {
    const { policy, use } = fixture();
    policy.operations.push("git:read");
    use.admitted.policyDigest = repositoryWorkPolicyDigestV2(policy);
    use.operation = version === 3 ? "metadata:read" : "git:read";
    assert.equal(
      evaluateRepositoryWorkProtocolPolicyV2(
        policy,
        use,
        version,
        version === 3 ? gitArm : { permission: "metadata:read" },
      ).kind,
      "refused",
    );
  });
test("Git permission tuple accessors cannot execute during policy comparison", () => {
  let reads = 0;
  const arm = {
    repositoryOperation: "git:read",
    get requiredPermissions() {
      reads++;
      return ["contents:read", "metadata:read"];
    },
  };
  assert.equal(repositoryWorkPolicyArmMatchesV2(3, arm), false);
  assert.equal(reads, 0);
});
