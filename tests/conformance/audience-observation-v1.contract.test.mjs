import test from "node:test";
import assert from "node:assert/strict";
import {
  AUDIENCE_OBSERVATION_LIMITS_V1,
  audienceObservationMatchesRequestV1,
  audienceObservationTimingV1,
  audienceReaderOperationV1,
  decodeAudienceDiagnosticV1,
  decodeAudienceObservationRequestV1,
  decodeAudienceReaderAccountsDiagnosticV1,
  audienceReaderAccountsMatchObservationV1,
} from "@openclaw-enterprise/contracts/audience-observation-v1";
import {
  accountIAMChecksV1,
  accountSemanticRequirementsV1,
} from "@openclaw-enterprise/contracts/account-authority-v1";
import { syntheticSlackDiagnostic } from "../fixtures/audience-observation-v1/native-producer.ts";
import { syntheticReaderAccountsDiagnostic } from "../fixtures/audience-observation-v1/account-consumer.ts";

const copy = () => structuredClone(syntheticSlackDiagnostic);
function teams() {
  const data = copy();
  data.observation.request.scope = {
    ...data.observation.request.scope,
    profile: "teams-standard-mentioned-v1",
    cloud: "microsoft-public",
    teamRef: "synthetic-team",
  };
  const { channelMembers, channelAccessPolicyVersion, ...common } = data.observation.completeness;
  data.observation.completeness = {
    ...common,
    profile: "teams-standard-mentioned-v1",
    teamReaders: channelMembers,
    channelReaders: structuredClone(channelMembers),
    tenantAccessPolicyVersion: channelAccessPolicyVersion,
    tenantReaders: { kind: "included", enumeration: structuredClone(channelMembers) },
  };
  data.observation.readers[1].accessPaths = ["team", "tenant"];
  return data;
}
const observation = () => copy().observation;

test("actual public leaf export decodes synthetic Slack and Teams diagnostics without authority", () => {
  for (const data of [copy(), teams()]) {
    const result = decodeAudienceDiagnosticV1(data);
    assert.equal(result.kind, "valid");
    assert.equal("custody" in result.value, false);
    assert.equal("authority" in result.value, false);
    assert.ok(Object.isFrozen(result.value.observation.readers));
    data.observation.readers[0].readerRef = "changed-after-decode";
    assert.equal(result.value.observation.readers[0].readerRef, "synthetic-reader-a");
  }
});

test("all selected stages require an exact fresh request, including individual output kinds", () => {
  const stages = [
    { kind: "ingress-admission" },
    { kind: "dispatch" },
    { kind: "native-consumption" },
    ...["result", "status", "cancel-ack"].map((outputKind) => ({
      kind: "protected-create",
      outputKind,
    })),
    ...["result", "status", "cancel-ack"].map((outputKind) => ({
      kind: "no-effect-retry",
      outputKind,
      previousObservationRef: "old-observation",
    })),
    { kind: "known-id-update", outputKind: "status", nativeMessageRef: "known-native-id" },
  ];
  for (const stage of stages) {
    const data = copy();
    data.observation.request.stage = stage;
    assert.equal(decodeAudienceDiagnosticV1(data).kind, "valid");
    assert.equal(
      audienceObservationMatchesRequestV1(data.observation, data.observation.request),
      true,
    );
  }
});

for (const [name, change] of [
  [
    "unknown version",
    (d) => {
      d.observation.schemaVersion = 2;
    },
  ],
  [
    "unknown request version",
    (d) => {
      d.observation.request.schemaVersion = 2;
    },
  ],
  [
    "extra alleged authority",
    (d) => {
      d.authority = "serialized-permit";
    },
  ],
  [
    "extra nested field",
    (d) => {
      d.observation.request.target.allow = true;
    },
  ],
  [
    "scope by ID prefix alone",
    (d) => {
      delete d.observation.completeness.scopeClassificationVersion;
    },
  ],
  [
    "page exhaustion alone",
    (d) => {
      delete d.observation.completeness.channelAccessPolicyVersion;
    },
  ],
  [
    "missing invalidation mechanism",
    (d) => {
      delete d.observation.completeness.changeDetectionVersion;
    },
  ],
  [
    "partial pagination",
    (d) => {
      d.observation.completeness.channelMembers.allPagesRead = false;
    },
  ],
  [
    "incomplete declared count",
    (d) => {
      d.observation.totalHumanReaders = 3;
    },
  ],
  [
    "duplicate reader identity",
    (d) => {
      d.observation.readers[1].readerRef = d.observation.readers[0].readerRef;
    },
  ],
  [
    "duplicate external human",
    (d) => {
      d.observation.readers[1].providerSubjectRef = d.observation.readers[0].providerSubjectRef;
    },
  ],
  [
    "unknown human classification",
    (d) => {
      d.observation.readers[1].kind = "unknown";
    },
  ],
  [
    "unreviewed extra bot",
    (d) => {
      d.observation.readers[1].kind = "bot";
    },
  ],
  [
    "delivery bot counted as human",
    (d) => {
      d.observation.readers[1].providerSubjectRef =
        d.observation.completeness.configuredDeliveryBotRef;
    },
  ],
  [
    "Slack shared scope",
    (d) => {
      d.observation.request.scope.profile = "slack-shared";
    },
  ],
  [
    "Slack team reader path",
    (d) => {
      d.observation.readers[1].accessPaths = ["team"];
    },
  ],
  [
    "missing reader source",
    (d) => {
      d.observation.readers[1].accessPaths = [];
    },
  ],
  [
    "duplicate reader source",
    (d) => {
      d.observation.readers[1].accessPaths = ["channel", "channel"];
    },
  ],
  [
    "empty audience",
    (d) => {
      d.observation.readers = [];
      d.observation.totalHumanReaders = 0;
    },
  ],
  [
    "invalid target ID",
    (d) => {
      d.observation.request.target.agentId = "agt_bad";
    },
  ],
  [
    "account-authority conversation reference overflow",
    (d) => {
      d.observation.request.target.conversationRef = "a".repeat(201);
    },
  ],
  [
    "account-authority common-grant reference mismatch",
    (d) => {
      d.observation.request.target.commonGrantRef = "not@an-account-ref";
    },
  ],
  [
    "native reference UTF-8 overflow",
    (d) => {
      d.observation.request.scope.channelRef = "界".repeat(342);
    },
  ],
  [
    "unpaired native reference surrogate",
    (d) => {
      d.observation.request.scope.channelRef = "native-\ud800";
    },
  ],
  [
    "unsafe target version",
    (d) => {
      d.observation.request.target.targetVersion = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "noncanonical digest",
    (d) => {
      d.observation.request.target.immutableMessageDigest = "B".repeat(64);
    },
  ],
  [
    "renewed request deadline",
    (d) => {
      d.observation.request.deadline = "2026-01-01T00:00:05.001Z";
    },
  ],
  [
    "zero request lifetime",
    (d) => {
      d.observation.request.deadline = d.observation.request.startedAt;
    },
  ],
  [
    "observation before request",
    (d) => {
      d.observation.observedAt = "2025-12-31T23:59:59.999Z";
    },
  ],
  [
    "observation beyond original deadline",
    (d) => {
      d.observation.validUntil = "2026-01-01T00:00:05.001Z";
    },
  ],
  [
    "uncertainty beyond consumed-age ceiling",
    (d) => {
      d.observation.clockUncertaintyMs = 201;
    },
  ],
  [
    "unknown uncertainty",
    (d) => {
      d.observation.clockUncertaintyMs = null;
    },
  ],
  [
    "impossible calendar timestamp",
    (d) => {
      d.observation.request.startedAt = "2026-02-30T00:00:00.000Z";
    },
  ],
  [
    "noncanonical timestamp",
    (d) => {
      d.observation.observedAt = "2026-01-01T00:00:00.1Z";
    },
  ],
  [
    "unknown stage",
    (d) => {
      d.observation.request.stage = { kind: "tool-call" };
    },
  ],
  [
    "retry without previous observation",
    (d) => {
      d.observation.request.stage = { kind: "no-effect-retry", outputKind: "result" };
    },
  ],
  [
    "update without known native ID",
    (d) => {
      d.observation.request.stage = { kind: "known-id-update", outputKind: "status" };
    },
  ],
  [
    "unselected result update",
    (d) => {
      d.observation.request.stage = {
        kind: "known-id-update",
        outputKind: "result",
        nativeMessageRef: "known",
      };
    },
  ],
  [
    "newline reference",
    (d) => {
      d.observation.request.scope.recipientAppRef += "\n";
    },
  ],
]) {
  test(`real decoder rejects ${name}`, () => {
    const data = copy();
    change(data);
    assert.equal(decodeAudienceDiagnosticV1(data).kind, "invalid");
  });
}

test("100 human representations fit and 101 overflow is rejected without truncation", () => {
  const data = copy();
  data.observation.readers = Array.from({ length: 100 }, (_, i) => ({
    readerRef: `reader-${i}`,
    providerSubjectRef: `user-${i}`,
    kind: "human",
    accessPaths: ["channel"],
  }));
  data.observation.totalHumanReaders = 100;
  assert.equal(decodeAudienceDiagnosticV1(data).kind, "valid");
  data.observation.readers.push({
    readerRef: "reader-100",
    providerSubjectRef: "user-100",
    kind: "human",
    accessPaths: ["channel"],
  });
  data.observation.totalHumanReaders = 101;
  assert.equal(decodeAudienceDiagnosticV1(data).kind, "invalid");
});

test("Teams includes actual team/channel and applicable tenant-reader coverage", () => {
  for (const key of [
    "teamReaders",
    "channelReaders",
    "tenantAccessPolicyVersion",
    "tenantReaders",
  ]) {
    const data = teams();
    delete data.observation.completeness[key];
    assert.equal(decodeAudienceDiagnosticV1(data).kind, "invalid");
  }
  const data = teams();
  data.observation.completeness.tenantReaders = {
    kind: "not-applicable",
    determinationVersion: "classified-policy-1",
  };
  assert.equal(decodeAudienceDiagnosticV1(data).kind, "invalid");
  data.observation.readers[1].accessPaths = ["team"];
  assert.equal(decodeAudienceDiagnosticV1(data).kind, "valid");
  data.observation.request.scope.cloud = "government";
  assert.equal(decodeAudienceDiagnosticV1(data).kind, "invalid");
});

test("cross-profile completeness claims cannot be substituted", () => {
  const data = copy();
  data.observation.completeness = teams().observation.completeness;
  assert.equal(decodeAudienceDiagnosticV1(data).kind, "invalid");
});

test("decoder rejects accessors without invoking them and rejects prototypes/cycles", () => {
  let invoked = false;
  const data = copy();
  Object.defineProperty(data.observation, "observationRef", {
    enumerable: true,
    get() {
      invoked = true;
      return "wrong";
    },
  });
  assert.equal(decodeAudienceDiagnosticV1(data).kind, "invalid");
  assert.equal(invoked, false);
  const cyclic = copy();
  cyclic.observation.readers[0].cycle = cyclic;
  assert.equal(decodeAudienceDiagnosticV1(cyclic).kind, "invalid");
  const inherited = copy();
  Object.setPrototypeOf(inherited.observation, { hidden: "extra" });
  assert.equal(decodeAudienceDiagnosticV1(inherited).kind, "invalid");
});

test("array extras, sparse/noncanonical arrays and hidden/symbol properties cannot escape byte checks", () => {
  for (const change of [
    (d) => {
      d.observation.readers.extra = "not-json-array-data";
    },
    (d) => {
      delete d.observation.readers[0];
    },
    (d) => {
      d.observation.readers["01"] = d.observation.readers[0];
    },
    (d) => {
      Object.defineProperty(d.observation, "hidden", { value: true });
    },
    (d) => {
      d.observation[Symbol("extra")] = true;
    },
  ]) {
    const data = copy();
    change(data);
    assert.equal(decodeAudienceDiagnosticV1(data).kind, "invalid");
  }
});

test("aggregate UTF-8 byte guard rejects valid-per-field escaped refs after a matching positive control", () => {
  const data = copy();
  data.observation.readers = Array.from({ length: 100 }, (_, i) => ({
    readerRef: `r${i}${"x".repeat(900)}`,
    providerSubjectRef: `u${i}${"y".repeat(900)}`,
    kind: "human",
    accessPaths: ["channel"],
  }));
  data.observation.totalHumanReaders = 100;
  assert.ok(
    Buffer.byteLength(JSON.stringify(data)) < AUDIENCE_OBSERVATION_LIMITS_V1.maxObservationBytes,
  );
  assert.equal(decodeAudienceDiagnosticV1(data).kind, "valid");
  for (const [i, reader] of data.observation.readers.entries()) {
    reader.readerRef = `r${i}${"\\".repeat(900)}`;
    reader.providerSubjectRef = `u${i}${"\\".repeat(900)}`;
    assert.ok(Buffer.byteLength(reader.readerRef) <= 1024);
    assert.ok(Buffer.byteLength(reader.providerSubjectRef) <= 1024);
  }
  assert.ok(
    Buffer.byteLength(JSON.stringify(data)) > AUDIENCE_OBSERVATION_LIMITS_V1.maxObservationBytes,
  );
  assert.equal(decodeAudienceDiagnosticV1(data).kind, "invalid");
});

const passive = () => {
  const native = observation();
  return syntheticReaderAccountsDiagnostic(native.request, native.observationRef);
};

test("passive-reader diagnostics require current account and binding evidence without a login", () => {
  const data = passive();
  const decoded = decodeAudienceReaderAccountsDiagnosticV1(data);
  assert.equal(decoded.kind, "valid");
  assert.equal(decoded.value.kind, "checked");
  assert.equal("custody" in decoded.value, false);
  for (const reader of decoded.value.observation.readers) {
    assert.equal("session" in reader, false);
    assert.equal("credential" in reader.versions, false);
    assert.ok(Object.isFrozen(reader.versions));
  }
  assert.equal(
    audienceReaderAccountsMatchObservationV1(decoded.value.observation, observation()),
    true,
  );
});

for (const [name, change] of [
  [
    "fabricated session",
    (d) => {
      d.observation.readers[0].session = { sessionId: "not-required" };
    },
  ],
  [
    "caller credential version",
    (d) => {
      d.observation.readers[0].versions.credential = 1;
    },
  ],
  [
    "disabled account",
    (d) => {
      d.observation.readers[0].accountState = "disabled";
    },
  ],
  [
    "unknown account version",
    (d) => {
      d.observation.readers[0].versions.account = 0;
    },
  ],
  [
    "missing grant version",
    (d) => {
      delete d.observation.readers[0].versions.grants;
    },
  ],
  [
    "missing authoritative human binding",
    (d) => {
      delete d.observation.readers[0].humanBindingId;
    },
  ],
  [
    "invalid human binding version",
    (d) => {
      d.observation.readers[0].humanBindingVersion = 0;
    },
  ],
  [
    "duplicate binding",
    (d) => {
      d.observation.readers[1].humanBindingId = d.observation.readers[0].humanBindingId;
    },
  ],
  [
    "duplicate reader",
    (d) => {
      d.observation.readers[1].readerRef = d.observation.readers[0].readerRef;
    },
  ],
  [
    "mixed selected-driver versions",
    (d) => {
      d.observation.readers[1].versions.driverSelection += 1;
    },
  ],
  [
    "mixed IAM policy versions",
    (d) => {
      d.observation.readers[1].versions.iamPolicy += 1;
    },
  ],
  [
    "missing role evidence",
    (d) => {
      d.observation.readers[0].roleIds = [];
    },
  ],
  [
    "missing access binding evidence",
    (d) => {
      d.observation.readers[0].accessBindingIds = [];
    },
  ],
  [
    "acting permission substituted for read",
    (d) => {
      d.observation.operation.kind = "turn.admit";
    },
  ],
  [
    "changed approved common boundary",
    (d) => {
      d.observation.operation.target.commonGrantRef = "foreign-grant";
    },
  ],
  [
    "deadline renewal",
    (d) => {
      d.observation.validUntil = "2026-01-01T00:00:05.001Z";
    },
  ],
  [
    "uncertainty outside original ceiling",
    (d) => {
      d.observation.clockUncertaintyMs = 401;
    },
  ],
  [
    "invalid evaluation time",
    (d) => {
      d.observation.request.startedAt = "2026-03-02T00:00:00.000Z";
      d.observation.request.deadline = "2026-03-02T00:00:05.000Z";
      d.observation.validUntil = "2026-03-02T00:00:04.800Z";
      d.observation.evaluatedAt = "2026-02-30T00:00:00.200Z";
      assert.equal(Date.parse(d.observation.evaluatedAt), Date.parse("2026-03-02T00:00:00.200Z"));
    },
  ],
  [
    "serialized observation custody",
    (d) => {
      d.custody = "not-a-handle";
    },
  ],
])
  test(`passive-reader decoder rejects ${name}`, () => {
    const data = passive();
    change(data);
    assert.equal(decodeAudienceReaderAccountsDiagnosticV1(data).kind, "invalid");
  });

test("passive-reader upper envelope supports 100 humans with 64 roles and access bindings each", () => {
  const data = passive();
  const template = data.observation.readers[0];
  data.observation.readers = Array.from({ length: 100 }, (_, i) => ({
    ...structuredClone(template),
    readerRef: `r${i}`,
    providerSubjectRef: `u${i}`,
    principalId: `p${i}`,
    accountId: `a${i}`,
    humanBindingId: `h${i}`,
    roleIds: Array.from({ length: 64 }, (_, j) => `role${j}`),
    accessBindingIds: Array.from({ length: 64 }, (_, j) => `bind${i}-${j}`),
  }));
  assert.ok(
    Buffer.byteLength(JSON.stringify(data)) < AUDIENCE_OBSERVATION_LIMITS_V1.maxObservationBytes,
  );
  assert.equal(decodeAudienceReaderAccountsDiagnosticV1(data).kind, "valid");
});

test("passive-reader full-set matcher rejects substitution without treating matching versions as current proof", () => {
  for (const change of [
    (d) => {
      d.observation.nativeObservationRef = "other-observation";
    },
    (d) => {
      d.observation.readers[0].readerRef = "another-reader";
    },
    (d) => {
      d.observation.readers[0].providerSubjectRef = "another-external-human";
    },
    (d) => {
      d.observation.request.scope.recipientAppRef = "foreign-app";
    },
    (d) => {
      d.observation.validUntil = "2026-01-01T00:00:04.950Z";
    },
    (d) => {
      d.observation.evaluatedAt = "2026-01-01T00:00:00.050Z";
    },
  ]) {
    const data = passive();
    change(data);
    assert.equal(decodeAudienceReaderAccountsDiagnosticV1(data).kind, "valid");
    assert.equal(audienceReaderAccountsMatchObservationV1(data.observation, observation()), false);
  }
  const data = passive();
  data.observation.readers[0].versions.account += 1;
  // Per-account versions can differ. Only the real current provider can prove their truth.
  assert.equal(decodeAudienceReaderAccountsDiagnosticV1(data).kind, "valid");
});

test("exact request matching rejects every foreign scope/target/message/stage and original deadline change", () => {
  for (const change of [
    (r) => {
      r.scope.installationId = "ins_22345678-1234-4234-8234-123456789abc";
    },
    ...[
      "channelInstallationRef",
      "providerTenantRef",
      "recipientAppRef",
      "channelRef",
      "rootThreadRef",
    ].map((key) => (r) => {
      r.scope[key] = "foreign";
    }),
    (r) => {
      r.target.namespaceId = "ns_22345678-1234-4234-8234-123456789abc";
    },
    (r) => {
      r.target.agentId = "agt_22345678-1234-4234-8234-123456789abc";
    },
    ...["conversationRef", "commonGrantRef", "sourceMessageRef"].map((key) => (r) => {
      r.target[key] = "different";
    }),
    (r) => {
      r.target.targetVersion = 2;
    },
    (r) => {
      r.target.approvedBoundaryDigest = "c".repeat(64);
    },
    (r) => {
      r.target.immutableMessageDigest = "d".repeat(64);
    },
    (r) => {
      r.stage = { kind: "dispatch" };
    },
    (r) => {
      r.deadline = "2026-01-01T00:00:04.000Z";
    },
    (r) => {
      r.requestId = "req_22345678-1234-4234-8234-123456789abc";
    },
  ]) {
    const o = observation();
    const expected = structuredClone(o.request);
    change(expected);
    assert.equal(decodeAudienceObservationRequestV1(expected).kind, "valid");
    assert.equal(audienceObservationMatchesRequestV1(o, expected), false);
  }
  const o = observation();
  assert.equal(
    audienceObservationMatchesRequestV1(o, {
      ...o.request,
      target: Object.fromEntries(Object.entries(o.request.target).reverse()),
    }),
    true,
  );
});

test("conservative clock checks enforce original elapsed budget and cannot grant provider authority", () => {
  const o = observation();
  const current = {
    now: "2026-01-01T00:00:01.000Z",
    uncertaintyMs: 20,
    elapsedSinceRequestMs: 1000,
  };
  assert.equal(audienceObservationTimingV1(o, current), "within-bounds");
  for (const change of [
    { now: "2026-01-01T00:00:05.000Z" },
    { now: "2026-01-01T00:00:00.100Z" },
    { now: "2025-12-31T23:59:59.000Z" },
    { elapsedSinceRequestMs: 5000 },
    { elapsedSinceRequestMs: -1 },
    { elapsedSinceRequestMs: Infinity },
    { uncertaintyMs: NaN },
    { uncertaintyMs: -1 },
    { uncertaintyMs: 4000 },
  ])
    assert.equal(audienceObservationTimingV1(o, { ...current, ...change }), "invalid-or-expired");
  // A backward wall clock cannot renew an exhausted monotonic request budget.
  assert.equal(
    audienceObservationTimingV1(o, { ...current, elapsedSinceRequestMs: 5001 }),
    "invalid-or-expired",
  );
});

test("closed incomplete, stale, missing-producer and unknown-effect diagnostics carry no permit", () => {
  for (const failure of [
    { kind: "denied" },
    { kind: "not-visible" },
    { kind: "reconciliation-required" },
    ...[
      "missing-native-producer",
      "missing-reader-account-producer",
      "missing-effect-composition",
      "incomplete-readers",
      "unsupported-reader",
      "clock-unknown",
      "deadline",
      "cancelled",
    ].map((reason) => ({ kind: "unavailable", reason })),
    ...["stale", "readers-changed", "account-changed", "superseded"].map((reason) => ({
      kind: "invalidated",
      reason,
    })),
  ]) {
    assert.equal(decodeAudienceDiagnosticV1(failure).kind, "valid");
    assert.equal(decodeAudienceDiagnosticV1({ ...failure, retryAllowed: true }).kind, "invalid");
  }
  assert.equal(decodeAudienceDiagnosticV1({ kind: "allowed" }).kind, "invalid");
});

test("passive readers request exact existing account-authority conversation read, without acting permissions", () => {
  const request = observation().request;
  const operation = audienceReaderOperationV1(request);
  assert.deepEqual(operation, {
    kind: "conversation.read",
    target: {
      namespaceId: request.target.namespaceId,
      agentId: request.target.agentId,
      conversationRef: request.target.conversationRef,
      commonGrantRef: request.target.commonGrantRef,
    },
  });
  assert.deepEqual(accountSemanticRequirementsV1(operation), [
    "human-collaborator",
    "conversation-read",
  ]);
  assert.deepEqual(
    accountIAMChecksV1(request.scope.installationId, operation).map((check) => check.action),
    ["read"],
  );
  assert.throws(() => audienceReaderOperationV1({ ...request, schemaVersion: 2 }), TypeError);
});

test("one complete human reader is accepted while two-human qualification examples remain", () => {
  for (const data of [copy(), teams()]) {
    assert.equal(data.observation.totalHumanReaders, 2);
    data.observation.readers = [data.observation.readers[0]];
    data.observation.totalHumanReaders = 1;
    assert.equal(decodeAudienceDiagnosticV1(data).kind, "valid");
    const accounts = syntheticReaderAccountsDiagnostic(
      data.observation.request,
      data.observation.observationRef,
    );
    accounts.observation.readers = [accounts.observation.readers[0]];
    assert.equal(decodeAudienceReaderAccountsDiagnosticV1(accounts).kind, "valid");
    assert.equal(
      audienceReaderAccountsMatchObservationV1(accounts.observation, data.observation),
      true,
    );
    accounts.observation.readers = [];
    assert.equal(decodeAudienceReaderAccountsDiagnosticV1(accounts).kind, "invalid");
  }
});
