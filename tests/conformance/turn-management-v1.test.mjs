import test from "node:test";
import { CancellationProtocolModel } from "../fixtures/turn-management-v1/protocol-model.mjs";
import assert from "node:assert/strict";
import {
  parseTurnManagementV1 as parse,
  parseTurnManagementJsonV1 as parseJson,
  turnCancellationDigestV1,
  turnManagementAccountRequestV1,
  turnManagementRecordMatchesV1,
  turnManagementCancellationOperationMatchesV1,
  projectTurnStatusV1,
  projectTurnCancellationCommitV1,
  projectTurnCancellationReadV1,
  turnManagementResultMatchesRequestV1,
  TURN_MANAGEMENT_LIMITS_V1,
} from "../../packages/contracts/src/turn-management-v1.ts";
import {
  locator,
  invocation,
  cancellation,
  statusRequest,
  cancellationRequest,
  readRequest,
  attemptRecord,
  commonRecord,
  observedAt,
  copy,
  redigest,
} from "../fixtures/turn-management-v1/values.mjs";
import {
  cancelExample,
  findCancellationExample,
  presentationExample,
  readStatusExample,
} from "../fixtures/turn-management-v1/consumers.ts";

const values = {
  locator,
  invocation,
  cancellationIdentity: cancellation,
  statusRequest,
  cancellationRequest,
  cancellationReadRequest: readRequest,
};
for (const [kind, input] of Object.entries(values)) {
  test(`${kind}: exact closed object and JSON roundtrip`, () => {
    assert.deepEqual(parseJson(kind, JSON.stringify(input)), parse(kind, input));
    assert.ok(Object.isFrozen(parse(kind, input)));
  });
  test(`${kind}: rejects unknown fields`, () =>
    assert.throws(() => parse(kind, { ...input, unknown: true })));
}
for (const [label, transform] of [
  [
    "caller",
    (x) => {
      x.locator.callerPrincipalRef = "foreign";
    },
  ],
  [
    "initiator",
    (x) => {
      x.locator.originalPrincipalRef = "foreign";
    },
  ],
  [
    "receipt",
    (x) => {
      x.locator.receiptRef = "other";
    },
  ],
  [
    "grant",
    (x) => {
      x.locator.commonGrantRef = "other";
    },
  ],
  [
    "transaction",
    (x) => {
      x.transactionRef = "other";
    },
  ],
  [
    "start",
    (x) => {
      x.startedAt = "2026-09-06T12:00:00.001Z";
    },
  ],
  [
    "deadline",
    (x) => {
      x.deadline = "2026-09-06T12:00:04.000Z";
    },
  ],
  [
    "version",
    (x) => {
      x.expectedVersions.grants++;
    },
  ],
  [
    "attempt version",
    (x) => {
      x.operation.expectedAttemptVersion++;
    },
  ],
  [
    "mode",
    (x) => {
      x.mode = "shared";
    },
  ],
])
  test(`immutable cancellation digest binds ${label}`, () => {
    const x = copy(cancellation);
    transform(x);
    assert.throws(() => parse("cancellationIdentity", x));
  });
test("key order is not operation identity", () => {
  const x = Object.fromEntries(Object.entries(copy(cancellation)).reverse());
  assert.equal(turnCancellationDigestV1(x), cancellation.operation.requestDigest);
  assert.equal(
    turnManagementCancellationOperationMatchesV1(
      cancellation,
      Object.fromEntries(Object.entries(cancellation.operation).reverse()),
    ),
    true,
  );
});
for (const [name, value] of [
  [
    "accessor",
    Object.defineProperty({}, "attempt", {
      get() {
        throw new Error("getter ran");
      },
      enumerable: true,
    }),
  ],
  ["class instance", new Date()],
  ["symbol", { ...locator, [Symbol()]: true }],
  ["hidden property", Object.defineProperty(copy(locator), "hidden", { value: true })],
  ["custom prototype", Object.assign(Object.create({ inherited: true }), locator)],
  [
    "cycle",
    (() => {
      const x = {};
      x.self = x;
      return x;
    })(),
  ],
])
  test(`reject ${name} with sanitized failure`, () =>
    assert.throws(() => parse("locator", value), { message: "Invalid turn management value." }));
for (const value of [NaN, Infinity, -0, Number.MAX_SAFE_INTEGER + 1, -1, 0])
  test(`reject invalid version ${String(value)}`, () => {
    const x = copy(invocation);
    x.expectedCurrentVersions.account = value;
    assert.throws(() => parse("invocation", x));
  });
for (const value of ["\ud800", "\udc00", "\n", "x".repeat(201)])
  test(`reject malformed or oversized reference ${JSON.stringify(value).slice(0, 20)}`, () => {
    assert.throws(() => parse("locator", { ...locator, receiptRef: value }));
  });
test("getter never executes", () => {
  let n = 0;
  const x = copy(locator);
  Object.defineProperty(x, "receiptRef", {
    get() {
      n++;
      return "receipt";
    },
  });
  assert.throws(() => parse("locator", x));
  assert.equal(n, 0);
});
test("strict JSON rejects duplicate escaped keys", () =>
  assert.throws(() =>
    parseJson("statusResult", '{"kind":"unavailable","\\u006bind":"not-visible"}'),
  ));
test("request byte bound includes whitespace", () =>
  assert.throws(() =>
    parseJson(
      "statusRequest",
      " ".repeat(TURN_MANAGEMENT_LIMITS_V1.maxRequestBytes) + JSON.stringify(statusRequest),
    ),
  ));
test("JSON malformed syntax is sanitized", () =>
  assert.throws(() => parseJson("statusRequest", "{"), {
    message: "Invalid turn management value.",
  }));
for (const deadline of [
  "2026-02-30T12:00:00.000Z",
  "2026-09-06T12:00:05.001Z",
  "2026-09-06T12:00:00.000Z",
])
  test(`invalid invocation deadline ${deadline}`, () => {
    const x = copy(invocation);
    x.account.deadline = deadline;
    assert.throws(() => parse("invocation", x));
  });
test("readback can use fresh current authority after original mutation expires", () => {
  const x = copy(readRequest);
  x.invocation.account.createdAt = "2026-09-07T12:00:00.000Z";
  x.invocation.account.deadline = "2026-09-07T12:00:05.000Z";
  x.invocation.expectedCurrentVersions = {
    ...x.invocation.expectedCurrentVersions,
    grants: x.invocation.expectedCurrentVersions.grants + 1,
  };
  assert.equal(parse("cancellationReadRequest", x).cancellation.deadline, cancellation.deadline);
  x.kind = "request-cancellation";
  assert.throws(() => parse("cancellationRequest", x));
});
test("same transaction/operation identifier forbidden", () => {
  const x = copy(cancellation);
  x.transactionRef = x.operation.operationRef;
  assert.throws(() => turnCancellationDigestV1(x));
});
test("own cancel cannot target somebody else's original turn", () => {
  const x = copy(cancellation);
  x.locator.callerPrincipalRef = x.operation.requesterPrincipalRef = "other";
  assert.throws(() => redigest(x));
});
test("shared cancel keeps requester separate and composes actual shared operand", () => {
  const x = copy(cancellationRequest);
  x.cancellation.mode = "shared";
  x.cancellation.locator.callerPrincipalRef = x.cancellation.operation.requesterPrincipalRef =
    "other";
  redigest(x.cancellation);
  assert.equal(turnManagementAccountRequestV1(x).operation.kind, "turn.cancel.shared");
  assert.equal(x.cancellation.operation.originalPrincipalRef, locator.originalPrincipalRef);
});
test("status uses exact conversation read, cancellation read uses original purpose", () => {
  assert.equal(turnManagementAccountRequestV1(statusRequest).operation.kind, "conversation.read");
  assert.equal(turnManagementAccountRequestV1(readRequest).operation.kind, "turn.cancel.own");
});
for (const field of ["receiptRef", "originalPrincipalRef", "commonGrantRef"])
  test(`status rejects foreign ${field}`, () => {
    assert.equal(
      turnManagementRecordMatchesV1({ ...locator, [field]: "foreign" }, attemptRecord),
      false,
    );
  });
test("common phase retains status without invented dispatch fields", () => {
  const status = projectTurnStatusV1(locator, commonRecord(), observedAt);
  assert.equal(status.dispatchEvidence, "none");
  assert.equal(status.outcome.kind, "accepted-undispatched");
  assert.ok(!JSON.stringify(status).includes("authorityDecisionRef"));
  assert.ok(!JSON.stringify(status).includes("workspaceCompletionRef"));
});
test("dispatch uncertainty preserves already-consumed evidence when canonical record has it", () => {
  const record = copy(attemptRecord);
  record.outcome = {
    kind: "outcome-unknown",
    stage: "dispatch",
    evidenceRef: "uncertain-dispatch",
  };
  const status = projectTurnStatusV1(locator, record, observedAt);
  assert.equal(status.dispatchEvidence, "consumed");
});
for (const kind of ["failed", "interrupted", "outcome-unknown", "cancelled"])
  test(`common ${kind} keeps before-dispatch uncertainty`, () => {
    const record = commonRecord();
    record.outcome = { kind, stage: "before-dispatch", evidenceRef: "evidence" };
    const s = projectTurnStatusV1(locator, record, observedAt);
    assert.equal(s.dispatchEvidence, "none");
    assert.equal(s.outcome.stage, "before-dispatch");
    assert.ok(!("terminated" in s));
  });
for (const kind of ["running", "consumed", "completed"])
  test(`${kind} cannot claim no consumption in status`, () => {
    const s = projectTurnStatusV1(locator, commonRecord(), observedAt);
    const x = copy(s);
    x.outcome = kind === "completed" ? { kind, completion: "journal-published" } : { kind };
    assert.throws(() => parse("statusResult", x));
  });
test("unknown outer commit never exposes provisional success", () => {
  assert.deepEqual(
    projectTurnCancellationCommitV1(
      cancellation,
      { kind: "commit-unknown", transactionRef: cancellation.transactionRef },
      observedAt,
    ),
    { kind: "commit-unknown" },
  );
});
test("known outer commit projects exact intent only", () => {
  const result = projectTurnCancellationCommitV1(
    cancellation,
    {
      kind: "committed",
      value: { kind: "recorded", operation: cancellation.operation, outcome: "requested" },
    },
    observedAt,
  );
  assert.equal(result.kind, "intent");
  assert.equal(turnManagementResultMatchesRequestV1(cancellationRequest, result), true);
  assert.equal("terminated" in result, false);
});
test("changed exact readback operation cannot pass", () => {
  assert.throws(() =>
    projectTurnCancellationReadV1(
      cancellation,
      {
        kind: "found",
        operation: { ...cancellation.operation, operationRef: "foreign" },
        outcome: "requested",
      },
      observedAt,
    ),
  );
});
for (const kind of ["absent", "denied"])
  test(`readback ${kind} is nondisclosing`, () =>
    assert.deepEqual(projectTurnCancellationReadV1(cancellation, { kind }, observedAt), {
      kind: "not-visible",
    }));
test("result outside invocation deadline cannot be presented", () => {
  const s = projectTurnStatusV1(locator, commonRecord(), "2026-09-06T12:00:06.000Z");
  assert.equal(turnManagementResultMatchesRequestV1(statusRequest, s), false);
});

// Behavioral model only: authentic owner ports, SQL atomicity and physical stop
// are deliberately absent. The actual compiling consumer is exercised with
// synthetic dependencies to verify invocation order and unknown-result behavior.
function harness(options = {}) {
  const trace = [];
  const authenticated = Object.freeze({});
  const controller = new AbortController();
  const call = {
    requestRef: invocation.account.requestId,
    recipientRef: "journal",
    deadline: invocation.account.deadline,
    signal: controller.signal,
    context: Object.freeze({}),
  };
  const verified = Object.freeze({});
  let saved;
  const view = {
    now: () => observedAt,
    resolveExactView: async () => {
      trace.push("view");
    },
    assertCurrent: async () => {
      trace.push("guard");
      if (options.onGuard) await options.onGuard(trace);
      if (options.revoked) throw new Error("Revoked");
    },
  };
  const deps = {
    authority: {
      authorizeExactV1: async () => ({
        kind: "allowed",
        observation: { subject: { principalId: locator.callerPrincipalRef } },
        authority: Object.freeze({}),
      }),
    },
    cancellation: {
      authorizeCancellation: async () => {
        trace.push("authorize");
        return verified;
      },
      inspectCancellation: async (h) => {
        assert.equal(h, verified);
        trace.push("inspect");
        if (options.afterInspect) await options.afterInspect();
        return cancellation.operation;
      },
    },
    journal: {
      transact: async (ref, work) => {
        trace.push("transaction");
        assert.equal(ref, cancellation.transactionRef);
        const value = await work({
          commitCancellation: async (h) => {
            assert.equal(h, verified);
            trace.push("local-intent");
            saved = { kind: "found", operation: cancellation.operation, outcome: "requested" };
            return { kind: "recorded", operation: cancellation.operation, outcome: "requested" };
          },
        });
        if (options.afterLocal) await options.afterLocal();
        trace.push("commit");
        return options.unknown
          ? { kind: "commit-unknown", transactionRef: ref }
          : { kind: "committed", value };
      },
      read: async (work) => {
        trace.push("read");
        return work({
          findCancellation: async () => saved ?? { kind: "absent" },
          findAttempt: async () => ({ kind: "found", record: commonRecord() }),
        });
      },
    },
  };
  return { trace, authenticated, controller, call, view, deps };
}
test("consumer waits for actual outer commit before intent", async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const h = harness({ afterLocal: () => gate });
  let settled = false;
  const promise = cancelExample(h.deps, h.view, h.authenticated, cancellationRequest, h.call).then(
    (x) => {
      settled = true;
      return x;
    },
  );
  await new Promise((r) => setImmediate(r));
  assert.ok(h.trace.includes("local-intent"));
  assert.equal(settled, false);
  release();
  assert.equal((await promise).kind, "intent");
});
test("lost commit acknowledgment permits exact readback with no second transaction", async () => {
  const h = harness({ unknown: true });
  assert.equal(
    (await cancelExample(h.deps, h.view, h.authenticated, cancellationRequest, h.call)).kind,
    "commit-unknown",
  );
  assert.equal(
    (await findCancellationExample(h.deps, h.view, h.authenticated, readRequest, h.call)).kind,
    "found",
  );
  assert.equal(h.trace.filter((x) => x === "transaction").length, 1);
});
test("abort after local success cannot claim no effect or release", async () => {
  const h = harness({ afterLocal: async () => h.controller.abort() });
  assert.equal(
    (await cancelExample(h.deps, h.view, h.authenticated, cancellationRequest, h.call)).kind,
    "commit-unknown",
  );
  assert.ok(!h.trace.includes("release"));
});
test("revocation after local intent suppresses success without retry", async () => {
  const options = {};
  const h = harness(options);
  options.afterLocal = async () => {
    options.revoked = true;
  };
  assert.equal(
    (await cancelExample(h.deps, h.view, h.authenticated, cancellationRequest, h.call)).kind,
    "commit-unknown",
  );
  assert.equal(h.trace.filter((x) => x === "transaction").length, 1);
});
test("presentation never turns cancellation into termination", async () => {
  const result = projectTurnCancellationCommitV1(
    cancellation,
    {
      kind: "committed",
      value: {
        kind: "recorded",
        operation: cancellation.operation,
        outcome: "cancelled-before-dispatch",
      },
    },
    observedAt,
  );
  let calls = 0;
  const app = {
    requestCancellation: async () => {
      calls++;
      return result;
    },
  };
  assert.match(
    await presentationExample(app, {}, cancellationRequest, new AbortController().signal),
    /termination is not established/,
  );
  assert.equal(calls, 1);
});

function protocolModel() {
  const model = new CancellationProtocolModel();
  model.version = cancellation.operation.expectedAttemptVersion;
  return model;
}
for (const failure of ["revoke", "abort"])
  test(`${failure} during provenance inspection prevents local intent`, async () => {
    const options = {};
    const h = harness(options);
    options.afterInspect = async () => {
      if (failure === "revoke") options.revoked = true;
      else h.controller.abort();
    };
    const result = await cancelExample(
      h.deps,
      h.view,
      h.authenticated,
      cancellationRequest,
      h.call,
    );
    assert.equal(result.kind, "commit-unknown");
    assert.equal(h.trace.includes("local-intent"), false);
  });
test("abort during final postcommit view guard suppresses protected intent", async () => {
  const options = {};
  const h = harness(options);
  options.onGuard = async (trace) => {
    if (trace.includes("commit")) h.controller.abort();
  };
  assert.equal(
    (await cancelExample(h.deps, h.view, h.authenticated, cancellationRequest, h.call)).kind,
    "commit-unknown",
  );
});
for (const kind of ["status", "readback"])
  test(`abort during final ${kind} view guard suppresses projection`, async () => {
    const options = {};
    const h = harness(options);
    if (kind === "readback")
      await cancelExample(h.deps, h.view, h.authenticated, cancellationRequest, h.call);
    options.onGuard = async (trace) => {
      if (trace.includes("read")) h.controller.abort();
    };
    const promise =
      kind === "status"
        ? readStatusExample(h.deps, h.view, h.authenticated, statusRequest, h.call)
        : findCancellationExample(h.deps, h.view, h.authenticated, readRequest, h.call);
    await assert.rejects(promise, { message: "Invocation unavailable." });
  });
for (const kind of ["rolled-back", "recorded", "existing", "aborted", "found", "unknown"]) {
  test(`outer ${kind} cannot acknowledge durable intent`, () => {
    const value = { kind: "recorded", operation: cancellation.operation, outcome: "requested" };
    assert.throws(
      () => projectTurnCancellationCommitV1(cancellation, { kind, value }, observedAt),
      { message: "Invalid turn management value." },
    );
  });
}
test("method-local cancellation result cannot become outer committed result", () => {
  assert.throws(() =>
    projectTurnCancellationCommitV1(
      cancellation,
      { kind: "recorded", operation: cancellation.operation, outcome: "requested" },
      observedAt,
    ),
  );
});
test("closed outer carrier rejects extra authority or value fields", () => {
  const value = { kind: "recorded", operation: cancellation.operation, outcome: "requested" };
  for (const outer of [
    { kind: "committed", value, trusted: true },
    { kind: "unavailable", value },
    { kind: "commit-unknown", transactionRef: cancellation.transactionRef, value },
  ]) {
    assert.throws(() => projectTurnCancellationCommitV1(cancellation, outer, observedAt));
  }
});
test("unknown commit must identify the original transaction", () => {
  assert.throws(() =>
    projectTurnCancellationCommitV1(
      cancellation,
      { kind: "commit-unknown", transactionRef: "different-transaction" },
      observedAt,
    ),
  );
});
test("outer accessor never runs", () => {
  let calls = 0;
  const outer = { kind: "committed" };
  Object.defineProperty(outer, "value", {
    enumerable: true,
    get() {
      calls++;
      return {};
    },
  });
  assert.throws(() => projectTurnCancellationCommitV1(cancellation, outer, observedAt));
  assert.equal(calls, 0);
});
test("modeled simultaneous duplicate submissions retain one immutable responsibility", async () => {
  const model = protocolModel();
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const a = model.submit(cancellation, { wait });
  const b = model.submit(cancellation, { wait });
  release();
  const results = await Promise.all([a, b]);
  assert.deepEqual(results.map((x) => x.kind).sort(), ["existing", "recorded"]);
  assert.equal(model.publications, 1);
});
test("modeled altered same operation conflicts without replacing first owner", async () => {
  const model = protocolModel();
  await model.submit(cancellation);
  const changed = copy(cancellation);
  changed.locator.receiptRef = "different";
  redigest(changed);
  assert.equal((await model.submit(changed)).kind, "conflict");
  assert.equal(model.find(cancellation).kind, "found");
  assert.equal(model.find(changed).kind, "not-visible");
});
test("modeled concurrent progress invalidates a new stale intent", async () => {
  const model = protocolModel();
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const result = model.submit(cancellation, { wait });
  model.version++;
  release();
  assert.equal((await result).kind, "conflict");
  assert.equal(model.publications, 0);
});
test("modeled exact historical responsibility survives later progress", async () => {
  const model = protocolModel();
  await model.submit(cancellation);
  model.version++;
  assert.equal(model.find(cancellation).kind, "found");
  assert.equal((await model.submit(cancellation)).kind, "existing");
  assert.equal(model.publications, 1);
});
test("modeled losing work retains bounded admission slots until settlement", async () => {
  const model = protocolModel();
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const pending = Array.from({ length: 32 }, () => model.submit(cancellation, { wait }));
  assert.equal(model.inFlight, 32);
  assert.equal((await model.submit(cancellation)).kind, "overloaded");
  assert.equal(model.publications, 0);
  release();
  await Promise.all(pending);
  assert.equal(model.inFlight, 0);
  assert.equal(model.publications, 1);
});
test("modeled shared-cancel tolerates initiator revoke but never requester revoke", async () => {
  const identity = copy(cancellation);
  identity.mode = "shared";
  identity.locator.callerPrincipalRef = identity.operation.requesterPrincipalRef = "requester-two";
  redigest(identity);
  const model = protocolModel();
  model.initiatorCurrent = false;
  assert.equal((await model.submit(identity)).kind, "recorded");
  model.requesterCurrent = false;
  assert.equal(model.find(identity).kind, "not-visible");
});
