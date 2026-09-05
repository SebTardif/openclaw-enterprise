import assert from "node:assert/strict";
import test from "node:test";
import {
  SECURITY_EVENT_POLICY,
  SECURITY_EVENT_SCHEMA,
  SecurityEventContractError,
  canReadSecurityEvent,
  canDeleteExpiredSecurityEvent,
  isSecurityEventExpired,
  parseSecurityEvent,
  parseSecurityEventJson,
  projectSecurityEvent,
  serializeSecurityEvent,
} from "../../packages/contracts/src/security-events.ts";
import {
  fixture,
  ids,
  scenarios,
  canaries,
  hostileAudit,
} from "../fixtures/security-events/cases.mjs";
import { SyntheticSecurityEventDelivery } from "../fixtures/security-events/delivery-model.mjs";

function project(overrides) {
  const { audit, context } = fixture(overrides);
  return projectSecurityEvent(audit, context);
}
function rejected(callback) {
  assert.throws(
    callback,
    (error) =>
      error instanceof SecurityEventContractError &&
      error.code === "SECURITY_EVENT_REJECTED" &&
      error.message === "Security event rejected by contract." &&
      error.cause === undefined,
  );
}
function containsNoCanaries(value) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  assert.ok(
    canaries.every((canary) => !serialized.includes(canary)),
    "Canary must not reach a collected output surface",
  );
}
function reader({
  namespaceId = ids.namespace,
  contextIds = [ids.conversation],
  role = "audit_reader",
  installationId = ids.installation,
} = {}) {
  return { principalId: ids.human, installationId, grants: [{ role, namespaceId, contextIds }] };
}

for (const scenario of scenarios) {
  test(`security contract: ${scenario.id}`, () => {
    const { audit, context } = fixture(scenario.context);
    if (context.decision === "denied") {
      audit.kind = "authorization_denial";
      audit.outcome = "denied";
    }
    const event = projectSecurityEvent(audit, context);
    assert.equal(event.schema, SECURITY_EVENT_SCHEMA);
    assert.equal(event.schemaVersion, 1);
    assert.equal(event.human.principalId, ids.human);
    assert.equal(event.resource.namespaceId, ids.namespace);
    assert.equal(event.resource.id, ids.agent);
    assert.equal(event.correlation.conversationId, ids.conversation);
    assert.equal(event.correlation.channelEventId, ids.channel_event);
    assert.equal(event.correlation.turnId, ids.turn);
    if (context.workload.state === "verified") {
      assert.equal(event.workload.principalId, ids.workload);
      assert.notEqual(event.human.principalId, event.workload.principalId);
      assert.equal(event.workload.generation, 7);
      assert.equal(event.workload.assignmentId, ids.assignment);
    }
    assert.equal(event.phase, context.phase);
    assert.equal(event.result, context.result);
    assert.deepEqual(parseSecurityEventJson(serializeSecurityEvent(event)), event);
    assert.ok(
      Object.isFrozen(event) &&
        Object.isFrozen(event.resource) &&
        Object.isFrozen(event.workload) &&
        Object.isFrozen(event.correlation),
    );
  });
}

test("projection excludes all payload fields before simulated persistence/export/artifacts", () => {
  const { audit, context } = fixture();
  const hostile = hostileAudit(audit);
  Object.defineProperty(hostile, "rawException", {
    get() {
      throw new Error(canaries[9]);
    },
  });
  const event = projectSecurityEvent(hostile, context);
  assert.deepEqual(event, projectSecurityEvent(audit, context));
  const sink = new SyntheticSecurityEventDelivery();
  assert.equal(sink.append(event).committed, true);
  sink.exportBatch();
  containsNoCanaries(event);
  containsNoCanaries([...sink.disk]);
  containsNoCanaries([...sink.exported]);
  containsNoCanaries(sink.evidence());
  // This is the collector surface exercised here; it is deliberately structured.
  containsNoCanaries(
    JSON.stringify({ schema: "synthetic-security-evidence/v1", event, delivery: sink.evidence() }),
  );
});

test("trusted reference resolution never exports arbitrary labels, URLs or credential-shaped IDs", () => {
  for (const value of [
    ...canaries,
    "https://user:pass@example.invalid/path?token=value",
    "00000000-0000-4000-8000-ffffffffffff",
    "x".repeat(257),
  ]) {
    const { audit, context } = fixture();
    audit.requestId = value;
    rejected(() => projectSecurityEvent(audit, context));
  }
});

test("projection bounds resolvers and replaces thrown errors with constant diagnostics", () => {
  const { audit, context } = fixture();
  for (const resolveReference of [
    () => canaries[0],
    () => {
      throw new Error(canaries[9]);
    },
  ]) {
    try {
      projectSecurityEvent(audit, { ...context, resolveReference });
      assert.fail("Expected rejection");
    } catch (error) {
      containsNoCanaries({
        message: error.message,
        code: error.code,
        stack: error.stack,
        cause: error.cause,
      });
    }
  }
  let oversizedCalls = 0;
  rejected(() =>
    projectSecurityEvent(
      { ...audit, id: "é".repeat(129) },
      {
        ...context,
        resolveReference(kind, value) {
          if (Buffer.byteLength(value) > 256) oversizedCalls++;
          return ids.event;
        },
      },
    ),
  );
  assert.equal(oversizedCalls, 0);
});

test("untrusted labels cannot become a verified human or overwrite verified workload", () => {
  const { audit, context } = fixture({
    human: { state: "unresolved" },
    decision: "denied",
    result: "denied",
    reasonCode: "IdentityUnresolved",
  });
  audit.actor = { kind: "principal", principalId: "claimed-administrator" };
  const event = projectSecurityEvent(audit, context);
  assert.deepEqual(event.human, { state: "unresolved" });
  assert.equal(event.workload.principalId, ids.workload);
  rejected(() =>
    projectSecurityEvent(audit, { ...context, decision: "allowed", result: "completed" }),
  );
  rejected(() => projectSecurityEvent({ ...audit, actorId: "other-human" }, fixture().context));
});

test("workload-only activity is explicitly inapplicable to humans, not human authorization", () => {
  const { audit, context } = fixture({ human: { state: "not_applicable" } });
  audit.actorId = "workload";
  assert.deepEqual(projectSecurityEvent(audit, context).human, { state: "not_applicable" });
  rejected(() =>
    projectSecurityEvent(audit, { ...context, category: "dispatch", action: "admit" }),
  );
});

test("projection rejects scope mismatches and cannot upgrade an audit denial", () => {
  const { audit, context } = fixture();
  for (const bad of [
    { ...audit, installationId: "other-installation" },
    { ...audit, namespaceId: "other-namespace" },
    { ...audit, resource: { ...audit.resource, namespaceId: "other-namespace" } },
    { ...audit, resource: { ...audit.resource, id: "other-agent" } },
    { ...audit, outcome: "denied" },
    { ...audit, kind: "unknown" },
    { ...audit, outcome: "unrecognized" },
    { ...audit, schemaVersion: 2 },
    { ...audit, schemaVersion: undefined },
  ])
    rejected(() => projectSecurityEvent(bad, context));
});

const mutations = [
  [
    "unknown version",
    (e) => {
      e.schemaVersion = 2;
    },
  ],
  [
    "unknown schema",
    (e) => {
      e.schema = "other/v1";
    },
  ],
  [
    "unknown source",
    (e) => {
      e.source = "untrusted";
    },
  ],
  [
    "unknown action",
    (e) => {
      e.action = "arbitrary";
    },
  ],
  [
    "unknown reason",
    (e) => {
      e.reasonCode = canaries[15];
    },
  ],
  [
    "unknown nested property",
    (e) => {
      e.resource.secret = canaries[0];
    },
  ],
  [
    "unknown envelope property",
    (e) => {
      e.details = { secret: canaries[0] };
    },
  ],
  [
    "unknown attribution",
    (e) => {
      e.human = { state: "verified", principalId: ids.human, issuer: canaries[0] };
    },
  ],
  [
    "negative generation",
    (e) => {
      e.workload.generation = -1;
    },
  ],
  [
    "inexact generation",
    (e) => {
      e.workload.generation = 1.5;
    },
  ],
  [
    "overflow generation",
    (e) => {
      e.workload.generation = 2 ** 53;
    },
  ],
  [
    "cross namespace",
    (e) => {
      e.resource.namespaceId = ids.other_namespace;
    },
  ],
  [
    "wrong workload Agent",
    (e) => {
      e.workload.agentId = ids.revision;
    },
  ],
  [
    "wrong workload revision",
    (e) => {
      e.workload.revisionId = ids.agent;
    },
  ],
  [
    "conversation without namespace",
    (e) => {
      delete e.namespaceId;
      delete e.resource.namespaceId;
    },
  ],
  [
    "turn without conversation",
    (e) => {
      delete e.correlation.conversationId;
    },
  ],
  [
    "unknown truth upgraded to success",
    (e) => {
      e.phase = "unknown";
      e.result = "completed";
      delete e.observation;
    },
  ],
  [
    "acceptance upgraded to success",
    (e) => {
      e.phase = "accepted";
      delete e.observation;
    },
  ],
  [
    "observation without evidence",
    (e) => {
      delete e.observation;
    },
  ],
  [
    "requested with evidence",
    (e) => {
      e.phase = "requested";
      e.result = "pending";
    },
  ],
  [
    "denial marked allowed",
    (e) => {
      e.result = "denied";
    },
  ],
  [
    "impossible receipt time",
    (e) => {
      e.receivedAt = "2025-12-31T23:59:59.000Z";
    },
  ],
  [
    "noncanonical timestamp",
    (e) => {
      e.receivedAt = "2026-02-30T00:00:00.000Z";
    },
  ],
  [
    "future observation",
    (e) => {
      e.observation.observedAt = "2026-01-02T00:00:00.000Z";
    },
  ],
  ["primitive input", () => "string"],
];
for (const [label, mutate] of mutations) {
  test(`strict imported-event validation: ${label}`, () => {
    const event = structuredClone(project());
    const replacement = mutate(event);
    rejected(() => parseSecurityEvent(replacement ?? event));
  });
}

test("JSON decoding bounds bytes, rejects deep/unknown structures and never copies raw diagnostics", () => {
  for (const value of [
    "{",
    "x".repeat(SECURITY_EVENT_POLICY.maxEventBytes + 1),
    "é".repeat(5000),
    JSON.stringify({ nested: { nested: { nested: canaries[5] } } }),
  ]) {
    rejected(() => parseSecurityEventJson(value));
  }
  const event = structuredClone(project());
  Object.defineProperty(event, "reasonCode", {
    get() {
      throw new Error(canaries[9]);
    },
  });
  rejected(() => parseSecurityEvent(event));
});

test("revocation is provider-confirmed, unknown, or observed expiry; stop requires runtime observation", () => {
  const confirmation = structuredClone(
    project(scenarios.find((s) => s.id === "revoke-confirmed").context),
  );
  confirmation.observation.source = "gateway";
  rejected(() => parseSecurityEvent(confirmation));
  const expiry = structuredClone(project(scenarios.find((s) => s.id === "revoke-expiry").context));
  expiry.credential.expiresAt = "2026-01-01T00:00:02.000Z";
  rejected(() => parseSecurityEvent(expiry));
  const stop = structuredClone(project(scenarios.find((s) => s.id === "stop-observed").context));
  stop.observation.source = "controller";
  rejected(() => parseSecurityEvent(stop));
  stop.phase = "accepted";
  stop.result = "pending";
  delete stop.observation;
  rejected(() => parseSecurityEvent(stop));
});

test("credential allowances require verified assignment plus scoped grant and policy", () => {
  const { audit, context } = fixture(scenarios.find((s) => s.id === "credential-allowed").context);
  rejected(() => projectSecurityEvent(audit, { ...context, workload: { state: "unresolved" } }));
  const correlation = { ...context.correlation };
  delete correlation.grantId;
  rejected(() => projectSecurityEvent(audit, { ...context, correlation }));
  rejected(() =>
    projectSecurityEvent(audit, {
      ...context,
      credential: { destination: "model", mode: "native" },
    }),
  );
});

test("audit access requires exact installation, Namespace, context and reader role", () => {
  const event = project();
  assert.equal(canReadSecurityEvent(event, reader()), true);
  for (const access of [
    reader({ installationId: ids.other_namespace }),
    reader({ namespaceId: ids.other_namespace }),
    reader({ contextIds: [ids.other_conversation] }),
    reader({ role: "audit_retention_admin" }),
    reader({ role: "operator" }),
    { ...reader(), grants: [] },
    { ...reader(), principalId: canaries[0] },
    { ...reader(), grants: [...reader().grants, { role: "wrong", contextIds: [] }] },
    { ...reader(), grants: Array(65).fill(reader().grants[0]) },
    reader({ contextIds: Array(129).fill(ids.conversation) }),
  ])
    assert.equal(canReadSecurityEvent(event, access), false);
  const bad = reader();
  Object.defineProperty(bad, "grants", {
    get() {
      throw new Error(canaries[9]);
    },
  });
  assert.equal(canReadSecurityEvent(event, bad), false);
});

test("installation-only and Namespace-only audit grants are distinct", () => {
  const event = structuredClone(project());
  event.resource = { kind: "installation", id: ids.installation };
  delete event.namespaceId;
  event.workload = { state: "not_applicable" };
  event.correlation = {};
  assert.equal(canReadSecurityEvent(event, reader()), false);
  assert.equal(
    canReadSecurityEvent(event, {
      principalId: ids.human,
      installationId: ids.installation,
      grants: [{ role: "audit_reader", contextIds: [] }],
    }),
    true,
  );
});

test("retention starts at receipt and expires at exactly thirty days", () => {
  const event = project();
  assert.equal(SECURITY_EVENT_POLICY.retentionDays, 30);
  assert.equal(SECURITY_EVENT_POLICY.deletionSweepHours, 24);
  assert.equal(isSecurityEventExpired(event, "2026-01-31T00:00:00.999Z"), false);
  assert.equal(isSecurityEventExpired(event, "2026-01-31T00:00:01.000Z"), true);
  assert.equal(isSecurityEventExpired(event, canaries[9]), false);
  assert.equal(
    isSecurityEventExpired({ ...event, details: canaries[0] }, "2026-02-01T00:00:00.000Z"),
    false,
  );
});

test("synthetic delivery: responsibility transfers at commit; duplicate retry is one action", () => {
  const sink = new SyntheticSecurityEventDelivery();
  const event = project();
  assert.deepEqual(sink.append(event), { committed: true, duplicate: false, owner: "sink" });
  assert.deepEqual(sink.append(event), { committed: true, duplicate: true, owner: "sink" });
  assert.equal(sink.disk.size, 1);
  const conflict = { ...event, reasonCode: "Unknown" };
  assert.equal(sink.append(conflict).committed, false);
  assert.equal(sink.disk.get(`${event.installationId}:${event.id}`), serializeSecurityEvent(event));
});

test("synthetic delivery: partial write, acknowledgement loss and reopen preserve ownership", () => {
  const sink = new SyntheticSecurityEventDelivery();
  const event = project();
  assert.equal(sink.append(event, { fault: "before_commit" }).owner, "producer");
  assert.equal(sink.reopen().disk.size, 0);
  assert.equal(sink.append(event, { fault: "after_commit_before_ack" }).owner, "producer");
  const reopened = sink.reopen();
  assert.equal(reopened.disk.size, 1);
  assert.deepEqual(reopened.append(event), { committed: true, duplicate: true, owner: "sink" });
  assert.equal(reopened.exportBatch().state, "delivered");
  const again = reopened.reopen();
  assert.equal(again.exportBatch().state, "delivered");
  // Losing exporter receipts causes redelivery with the same event identity.
  assert.deepEqual([...again.exported], [...reopened.exported]);
});

test("synthetic delivery: full/unavailable sink denies new authority but permits restrictions", () => {
  const event = project();
  for (const sink of [
    new SyntheticSecurityEventDelivery({ maxEvents: 0 }),
    new SyntheticSecurityEventDelivery({
      maxBytes: Buffer.byteLength(serializeSecurityEvent(event)) - 1,
    }),
    new SyntheticSecurityEventDelivery(),
  ]) {
    sink.available = false;
    assert.equal(sink.append(event).authority, "deny_new_authority");
    const restriction = sink.append(event, { operation: "restrict" });
    assert.equal(restriction.authority, "continue_restriction");
    assert.equal(restriction.requiredEvidence, "missing");
    assert.equal(restriction.owner, "producer");
    assert.equal(sink.disk.size, 0);
  }
  const eventBound = new SyntheticSecurityEventDelivery({ maxEvents: 1 });
  eventBound.append(event);
  assert.equal(eventBound.append({ ...event, id: ids.request }).authority, "deny_new_authority");
  const byteBound = new SyntheticSecurityEventDelivery({
    maxBytes: Buffer.byteLength(serializeSecurityEvent(event)) - 1,
  });
  assert.equal(byteBound.append(event).authority, "deny_new_authority");
});

test("synthetic delivery: exporter outage retains committed frames and caps retries", () => {
  const sink = new SyntheticSecurityEventDelivery();
  sink.append(project());
  sink.exportAvailable = false;
  assert.deepEqual(SECURITY_EVENT_POLICY.exportRetryDelaysMs, [1000, 2000, 4000, 8000]);
  for (let index = 0; index < SECURITY_EVENT_POLICY.exportMaxAttempts; index++)
    assert.equal(sink.exportBatch().state, "retry");
  assert.equal(sink.exportBatch().state, "quarantined");
  assert.equal(sink.attempts, 5);
  assert.equal(sink.pending().length, 1);
  assert.equal(sink.disk.size, 1);
  assert.equal(sink.exported.size, 0);
});

test("synthetic delivery: export batch is bounded independently of spool capacity", () => {
  const sink = new SyntheticSecurityEventDelivery();
  const event = project();
  for (let index = 0; index < 101; index++)
    sink.append({
      ...event,
      id: `00000000-0000-4000-8000-${(index + 100).toString(16).padStart(12, "0")}`,
    });
  assert.equal(sink.exportBatch().pending, 1);
  assert.equal(sink.exported.size, 100);
  assert.equal(sink.exportBatch().pending, 0);
});

test("identity replacement retains exact predecessor assignment and generation", () => {
  const event = structuredClone(
    project(scenarios.find((s) => s.id === "identity-replace").context),
  );
  assert.equal(event.previousRuntime.assignmentId, ids.previous_assignment);
  assert.equal(event.previousRuntime.generation, 6);
  event.previousRuntime.generation = 7;
  rejected(() => parseSecurityEvent(event));
  delete event.previousRuntime;
  rejected(() => parseSecurityEvent(event));
});

test("synthetic delivery: retry ceiling survives reopen", () => {
  let sink = new SyntheticSecurityEventDelivery();
  sink.append(project());
  for (let index = 0; index < 5; index++) {
    sink.exportAvailable = false;
    sink.exportBatch();
    sink = sink.reopen();
  }
  assert.equal(sink.exportBatch().state, "quarantined");
  assert.equal(sink.attempts, 5);
  assert.equal(sink.pending().length, 1);
});

test("synthetic retention: only exact scoped retention administrators purge expired events", () => {
  const event = project();
  const admin = reader({ role: "audit_retention_admin" });
  const now = "2026-01-31T00:00:01.000Z";
  assert.equal(canDeleteExpiredSecurityEvent(event, admin, now), true);
  assert.equal(canReadSecurityEvent(event, admin), false);
  assert.equal(canDeleteExpiredSecurityEvent(event, reader(), now), false);
  assert.equal(
    canDeleteExpiredSecurityEvent(
      event,
      reader({ role: "audit_retention_admin", contextIds: [] }),
      now,
    ),
    false,
  );
  assert.equal(
    canDeleteExpiredSecurityEvent(
      event,
      reader({ role: "audit_retention_admin", namespaceId: ids.other_namespace }),
      now,
    ),
    false,
  );
  const sink = new SyntheticSecurityEventDelivery();
  sink.append(event);
  assert.deepEqual(sink.purgeExpired(reader(), now), { purged: 0, missing: 0 });
  assert.deepEqual(sink.purgeExpired(admin, "2026-01-31T00:00:00.999Z"), { purged: 0, missing: 0 });
  assert.deepEqual(sink.purgeExpired(admin, now), { purged: 1, missing: 1 });
  assert.equal(sink.evidence().diagnostics.at(-1).code, "MandatoryEvidenceExpired");
  assert.equal(sink.disk.size, 0);
});

test("synthetic delivery: duplicate identity is scoped to its Installation", () => {
  const sink = new SyntheticSecurityEventDelivery();
  const event = project();
  const other = { ...event, installationId: ids.other_namespace };
  assert.equal(sink.append(event).duplicate, false);
  assert.equal(sink.append(other).duplicate, false);
  assert.equal(sink.append(other).duplicate, true);
  assert.equal(sink.disk.size, 2);
  sink.exportBatch();
  assert.equal(sink.exported.size, 2);
});
