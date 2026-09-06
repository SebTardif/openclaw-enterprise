import assert from "node:assert/strict";
import test from "node:test";
import {
  LIFECYCLE_ADMISSION_LIMITS_V1,
  LifecycleAdmissionErrorV1,
  LifecycleAdmissionSchemasV1,
  decodeLifecycleAdmissionV1,
  parseLifecycleAdmissionV1,
  parseLifecycleMutationResultForRequestV1,
  projectLifecycleAcceptedReceiptV1,
  projectLifecycleIntentHeadV1,
  projectLifecycleOperationReadV1,
} from "../../packages/contracts/src/lifecycle-admission-v1.ts";

// These vectors exercise the actual inert parser and projection functions. They
// create no persisted admission, transaction, authority, queue claim or runtime.
const uuid = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const ns = `ns_${uuid}`;
const agent = `agt_${uuid}`;
const revision = `rev_${uuid}`;
const time = "2026-09-06T12:00:00.000Z";
const plain = (value) => JSON.parse(JSON.stringify(value));
const request = (
  kind = "deploy",
  expectedLifecycleGeneration = null,
  revisionSource = "retained",
) => ({
  schemaVersion: 1,
  kind,
  namespaceId: ns,
  agentId: agent,
  expectedLifecycleGeneration,
  ...(kind === "resume" ? { revisionSource } : {}),
});
function association(kind = "deploy", expected = null, source = "retained") {
  return {
    schemaVersion: 1,
    request: request(kind, expected, source),
    intent: {
      installationId: `ins_${uuid}`,
      namespaceId: ns,
      agentId: agent,
      transitionRef: uuid,
      generation: (expected ?? 0) + 1,
      desiredMode: kind === "disable" ? "disabled" : kind === "stop" ? "stopped" : "running",
      revisionId: expected === null && (kind === "disable" || kind === "stop") ? null : revision,
      actorId: "principal:operator-example",
      requestId: `req_${uuid}`,
      createdAt: time,
    },
    auditEventId: `aud_${uuid}`,
    workId: "opaque:original-work:example",
  };
}
const work = () => ({
  schemaVersion: 1,
  handler: "ReconcileAgentLifecycleV1",
  namespaceId: ns,
  agentId: agent,
  operationRef: uuid,
  lifecycleGeneration: 1,
  workId: "opaque:original-work:example",
});
function invalid(kind, value) {
  assert.throws(() => parseLifecycleAdmissionV1(kind, value), {
    name: "LifecycleAdmissionErrorV1",
    code: "INVALID_REQUEST",
    message: "Invalid lifecycle admission data.",
  });
  assert.deepEqual(decodeLifecycleAdmissionV1(kind, value), { kind: "invalid" });
}
function modify(value, change) {
  const copy = structuredClone(value);
  change(copy);
  return copy;
}
function objects(value, path = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return [
    [path, value],
    ...Object.entries(value).flatMap(([key, child]) => objects(child, [...path, key])),
  ];
}
function at(value, path) {
  return path.reduce((parent, key) => parent[key], value);
}

test("registry exposes the agreed in-process schemas with recursively immutable definitions", () => {
  assert.deepEqual(
    Object.keys(LifecycleAdmissionSchemasV1).sort(),
    [
      "scope",
      "generationBody",
      "resumeBody",
      "mutationRequest",
      "intent",
      "intentHeadProjection",
      "association",
      "mutationReceipt",
      "mutationResult",
      "operationReadRequest",
      "operationReadProjection",
      "workInput",
    ].sort(),
  );
  const visit = (value) => {
    if (value === null || typeof value !== "object") return;
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) visit(child);
  };
  visit(LifecycleAdmissionSchemasV1);
  assert.throws(() => {
    LifecycleAdmissionSchemasV1.generationBody.additionalProperties = true;
  }, TypeError);
  invalid("generationBody", { expectedLifecycleGeneration: null, authority: true });
});

test("generation is mandatory null-or-positive and never coerced, defaulted or rounded", () => {
  for (const expected of [null, 1, 2, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(
      plain(parseLifecycleAdmissionV1("generationBody", { expectedLifecycleGeneration: expected })),
      {
        expectedLifecycleGeneration: expected,
      },
    );
  }
  invalid("generationBody", {});
  for (const bad of [
    undefined,
    0,
    -0,
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
    "null",
    true,
    [],
    {},
    1n,
  ]) {
    invalid("generationBody", { expectedLifecycleGeneration: bad });
  }
});

test("all four request variants are closed and resume has an explicit source", () => {
  for (const kind of ["deploy", "disable", "stop", "resume"]) {
    for (const expected of [null, 1, Number.MAX_SAFE_INTEGER]) {
      const input = request(kind, expected);
      assert.deepEqual(plain(parseLifecycleAdmissionV1("mutationRequest", input)), input);
    }
  }
  assert.equal(
    parseLifecycleAdmissionV1("resumeBody", {
      expectedLifecycleGeneration: 1,
      revisionSource: "saved-draft",
    }).revisionSource,
    "saved-draft",
  );
  invalid("resumeBody", { expectedLifecycleGeneration: 1 });
  for (const source of [undefined, null, "draft", "current", "retained ", true]) {
    invalid("mutationRequest", { ...request("resume", 1), revisionSource: source });
  }
  for (const kind of ["deploy", "disable", "stop"]) {
    invalid("mutationRequest", { ...request(kind), revisionSource: "saved-draft" });
  }
  for (const kind of ["delete", "reconcile", "restart", "running", null])
    invalid("mutationRequest", { ...request(), kind });
});

test("scope and request reject every caller-supplied authority or correlation field", () => {
  const extras = {
    installationId: `ins_${uuid}`,
    actorId: "principal:operator-example",
    requestId: `req_${uuid}`,
    operationRef: uuid,
    transitionRef: uuid,
    workId: "work",
    desiredMode: "running",
    revisionId: revision,
    assignmentRef: uuid,
    authority: true,
    authenticated: true,
    providerUrl: "https://example.invalid",
  };
  for (const [key, value] of Object.entries(extras)) {
    invalid("mutationRequest", { ...request(), [key]: value });
    invalid("scope", { namespaceId: ns, agentId: agent, [key]: value });
  }
  for (const schemaVersion of [undefined, 0, 2, "1", null])
    invalid("mutationRequest", { ...request(), schemaVersion });
});

test("accepted API identifiers and original attribution use their distinct formats", () => {
  for (const key of ["namespaceId", "agentId"]) {
    for (const value of [
      uuid,
      "",
      "foreign",
      request()[key].toUpperCase(),
      `${request()[key]}\n`,
      `${request()[key]} `,
    ]) {
      invalid("mutationRequest", { ...request(), [key]: value });
    }
  }
  const input = association();
  for (const key of [
    "installationId",
    "namespaceId",
    "agentId",
    "revisionId",
    "transitionRef",
    "requestId",
  ]) {
    invalid(
      "association",
      modify(input, (v) => {
        v.intent[key] = `aud_${uuid}`;
      }),
    );
  }
  for (const requestId of ["trace-id", uuid, `req_${other}\n`]) {
    invalid(
      "association",
      modify(input, (v) => {
        v.intent.requestId = requestId;
      }),
    );
  }
  invalid("association", { ...input, auditEventId: uuid });
  for (const actorId of ["", "principal\n", " principal", "雪", "a".repeat(201)]) {
    invalid(
      "association",
      modify(input, (v) => {
        v.intent.actorId = actorId;
      }),
    );
  }
});

test("nullable protective intent does not widen running or installed intent assumptions", () => {
  for (const desiredMode of ["disabled", "stopped"]) {
    for (const revisionId of [null, revision]) {
      const input = { ...association().intent, generation: 2, desiredMode, revisionId };
      assert.deepEqual(plain(parseLifecycleAdmissionV1("intent", input)), input);
    }
  }
  invalid("intent", { ...association().intent, revisionId: null });
  for (const desiredMode of ["disabled", "stopped"]) {
    invalid("intent", { ...association().intent, desiredMode, revisionId: revision });
    assert.equal(
      parseLifecycleAdmissionV1("intent", {
        ...association().intent,
        desiredMode,
        revisionId: null,
      }).revisionId,
      null,
    );
  }
  invalid("intent", { ...association().intent, desiredMode: "deleted" });
  invalid("intent", { ...association().intent, schemaVersion: 1 });
});

test("material associations require exact scope, next generation and kind-mode correspondence", () => {
  for (const kind of ["deploy", "disable", "stop"]) {
    for (const expected of [null, 1, Number.MAX_SAFE_INTEGER - 1]) {
      const input = association(kind, expected);
      assert.deepEqual(plain(parseLifecycleAdmissionV1("association", input)), input);
    }
  }
  for (const source of ["retained", "saved-draft"]) {
    const input = association("resume", 9, source);
    assert.deepEqual(plain(parseLifecycleAdmissionV1("association", input)), input);
  }
  const base = association("deploy", 4);
  for (const key of ["namespaceId", "agentId"]) {
    invalid(
      "association",
      modify(base, (v) => {
        v.intent[key] = key === "namespaceId" ? `ns_${other}` : `agt_${other}`;
      }),
    );
  }
  for (const generation of [1, 4, 6])
    invalid(
      "association",
      modify(base, (v) => {
        v.intent.generation = generation;
      }),
    );
  for (const kind of ["deploy", "disable", "stop", "resume"]) {
    const input = association(kind, 4);
    for (const mode of ["running", "disabled", "stopped"]) {
      if (mode !== input.intent.desiredMode)
        invalid(
          "association",
          modify(input, (v) => {
            v.intent.desiredMode = mode;
          }),
        );
    }
  }
  invalid("association", association("stop", Number.MAX_SAFE_INTEGER));
});

test("initial protective associations require null revision while later null remains representable", () => {
  for (const kind of ["disable", "stop"]) {
    invalid(
      "association",
      modify(association(kind), (v) => {
        v.intent.revisionId = revision;
      }),
    );
    const later = modify(association(kind, 2), (v) => {
      v.intent.revisionId = null;
    });
    assert.equal(parseLifecycleAdmissionV1("association", later).intent.revisionId, null);
  }
  // A no-head resume is syntactically a command; it cannot describe an accepted transition.
  assert.equal(
    parseLifecycleAdmissionV1("mutationRequest", request("resume")).expectedLifecycleGeneration,
    null,
  );
  invalid("association", association("resume"));
});

test("every object family rejects partial associations and unknown fields", () => {
  const a = association("resume", 4);
  const receipt = projectLifecycleAcceptedReceiptV1(a);
  const values = {
    scope: { namespaceId: ns, agentId: agent },
    generationBody: { expectedLifecycleGeneration: null },
    resumeBody: { expectedLifecycleGeneration: 1, revisionSource: "retained" },
    mutationRequest: request("resume", 4),
    intent: a.intent,
    intentHeadProjection: projectLifecycleIntentHeadV1(a.intent),
    association: a,
    mutationReceipt: receipt,
    mutationResult: { kind: "accepted", receipt },
    operationReadRequest: { schemaVersion: 1, namespaceId: ns, agentId: agent, operationRef: uuid },
    operationReadProjection: projectLifecycleOperationReadV1(a),
    workInput: work(),
  };
  for (const [kind, value] of Object.entries(values)) {
    for (const [path, original] of objects(value)) {
      invalid(
        kind,
        modify(value, (v) => {
          at(v, path).unexpectedAuthority = true;
        }),
      );
      for (const key of Object.keys(original)) {
        invalid(
          kind,
          modify(value, (v) => {
            delete at(v, path)[key];
          }),
        );
      }
    }
  }
});

test("accepted receipts disclose exactly the six newly accepted operation fields", () => {
  for (const [kind, expected, source] of [
    ["deploy", null, "saved-draft"],
    ["disable", null, null],
    ["stop", 2, null],
    ["resume", 3, "retained"],
    ["resume", 3, "saved-draft"],
  ]) {
    const a = association(kind, expected, source ?? "retained");
    const receipt = projectLifecycleAcceptedReceiptV1(a);
    assert.deepEqual(plain(receipt), {
      disposition: "accepted",
      operation: {
        operationRef: uuid,
        kind,
        revisionSource: source,
        lifecycleGeneration: (expected ?? 0) + 1,
        desiredMode: a.intent.desiredMode,
        acceptedAt: time,
      },
    });
    for (const key of [
      "requestedRevisionId",
      "actorId",
      "requestId",
      "auditEventId",
      "workId",
      "installationId",
      "namespaceId",
      "agentId",
    ]) {
      invalid(
        "mutationReceipt",
        modify(receipt, (v) => {
          v.operation[key] = "hidden";
        }),
      );
    }
  }
});

test("receipt operation discriminants preserve mode and source without defaults", () => {
  for (const kind of ["deploy", "disable", "stop", "resume"]) {
    const receipt = projectLifecycleAcceptedReceiptV1(association(kind, 4));
    for (const mode of ["running", "disabled", "stopped"]) {
      if (mode !== receipt.operation.desiredMode)
        invalid(
          "mutationReceipt",
          modify(receipt, (v) => {
            v.operation.desiredMode = mode;
          }),
        );
    }
    const invalidSource = kind === "deploy" ? "retained" : kind === "resume" ? null : "saved-draft";
    invalid(
      "mutationReceipt",
      modify(receipt, (v) => {
        v.operation.revisionSource = invalidSource;
      }),
    );
  }
});

test("unchanged receipts carry no operation, revision, attribution or observed status", () => {
  for (const desiredMode of ["disabled", "stopped"]) {
    const receipt = {
      disposition: "unchanged",
      lifecycleGeneration: Number.MAX_SAFE_INTEGER,
      desiredMode,
    };
    assert.deepEqual(plain(parseLifecycleAdmissionV1("mutationReceipt", receipt)), receipt);
    for (const key of [
      "operation",
      "requestedRevisionId",
      "actorId",
      "head",
      "serving",
      "stopComplete",
      "auditEventId",
    ]) {
      invalid("mutationReceipt", { ...receipt, [key]: null });
    }
  }
  invalid("mutationReceipt", {
    disposition: "unchanged",
    lifecycleGeneration: 1,
    desiredMode: "running",
  });
  invalid("mutationReceipt", {
    disposition: "unchanged",
    lifecycleGeneration: null,
    desiredMode: "stopped",
  });
});

test("request-result correspondence rejects stale no-op and permits matching no-op at maximum", () => {
  for (const kind of ["disable", "stop"]) {
    const input = request(kind, Number.MAX_SAFE_INTEGER);
    const result = {
      kind: "unchanged",
      receipt: {
        disposition: "unchanged",
        lifecycleGeneration: Number.MAX_SAFE_INTEGER,
        desiredMode: kind === "disable" ? "disabled" : "stopped",
      },
    };
    assert.deepEqual(plain(parseLifecycleMutationResultForRequestV1(input, result)), result);
    assert.throws(
      () =>
        parseLifecycleMutationResultForRequestV1(
          request(kind, Number.MAX_SAFE_INTEGER - 1),
          result,
        ),
      LifecycleAdmissionErrorV1,
    );
    assert.throws(
      () => parseLifecycleMutationResultForRequestV1(request(kind), result),
      LifecycleAdmissionErrorV1,
    );
    const wrongMode = modify(result, (v) => {
      v.receipt.desiredMode = kind === "disable" ? "stopped" : "disabled";
    });
    assert.throws(
      () => parseLifecycleMutationResultForRequestV1(input, wrongMode),
      LifecycleAdmissionErrorV1,
    );
  }
  const result = {
    kind: "unchanged",
    receipt: { disposition: "unchanged", lifecycleGeneration: 1, desiredMode: "stopped" },
  };
  for (const kind of ["deploy", "resume"])
    assert.throws(
      () => parseLifecycleMutationResultForRequestV1(request(kind, 1), result),
      LifecycleAdmissionErrorV1,
    );
});

test("accepted request-result correspondence preserves source and exact next generation", () => {
  for (const kind of ["deploy", "disable", "stop", "resume"]) {
    const a = association(kind, 5);
    const result = { kind: "accepted", receipt: projectLifecycleAcceptedReceiptV1(a) };
    assert.deepEqual(
      plain(parseLifecycleMutationResultForRequestV1(a.request, result)),
      plain(result),
    );
    assert.throws(
      () => parseLifecycleMutationResultForRequestV1(request(kind, 4), result),
      LifecycleAdmissionErrorV1,
    );
    assert.throws(
      () =>
        parseLifecycleMutationResultForRequestV1(request(kind, Number.MAX_SAFE_INTEGER), result),
      LifecycleAdmissionErrorV1,
    );
  }
  const resumed = {
    kind: "accepted",
    receipt: projectLifecycleAcceptedReceiptV1(association("resume", 1)),
  };
  assert.throws(
    () => parseLifecycleMutationResultForRequestV1(request("resume", 1, "saved-draft"), resumed),
    LifecycleAdmissionErrorV1,
  );
  assert.throws(
    () => parseLifecycleMutationResultForRequestV1(request("resume"), resumed),
    LifecycleAdmissionErrorV1,
  );
  assert.throws(
    () => parseLifecycleMutationResultForRequestV1(request("deploy", 1), resumed),
    LifecycleAdmissionErrorV1,
  );
});

test("failure outcomes remain closed and cannot claim committed or current state", () => {
  for (const kind of ["conflict", "unavailable", "commit-unknown"]) {
    assert.deepEqual(plain(parseLifecycleAdmissionV1("mutationResult", { kind })), { kind });
    assert.deepEqual(plain(parseLifecycleMutationResultForRequestV1(request(), { kind })), {
      kind,
    });
    for (const key of [
      "currentGeneration",
      "head",
      "operationRef",
      "association",
      "revisionId",
      "actorId",
      "retryable",
      "message",
    ]) {
      invalid("mutationResult", { kind, [key]: "private" });
    }
  }
  for (const code of [
    "INVALID_REQUEST",
    "UNAUTHENTICATED",
    "FORBIDDEN",
    "NOT_FOUND",
    "NAMESPACE_NOT_READY",
    "INTERNAL_ERROR",
  ]) {
    assert.equal(
      parseLifecycleAdmissionV1("mutationResult", { kind: "rejected", code }).code,
      code,
    );
  }
  invalid("mutationResult", { kind: "rejected", code: "SQL_ERROR_SECRET" });
  invalid("mutationResult", { kind: "committed" });
  invalid("mutationResult", { kind: "accepted" });
  invalid("mutationResult", {
    kind: "accepted",
    receipt: { disposition: "unchanged", lifecycleGeneration: 1, desiredMode: "stopped" },
  });
});

test("authorized-read operation adds only the exact retained revision field", () => {
  for (const kind of ["deploy", "disable", "stop", "resume"]) {
    const a = association(kind, kind === "resume" ? 1 : null);
    const receipt = projectLifecycleAcceptedReceiptV1(a);
    const read = projectLifecycleOperationReadV1(a);
    assert.deepEqual(plain(read), {
      ...plain(receipt.operation),
      requestedRevisionId: a.intent.revisionId,
    });
    invalid("operationReadProjection", { ...read, actorId: a.intent.actorId });
    invalid("operationReadProjection", { ...read, observation: { serving: true } });
  }
  const running = projectLifecycleOperationReadV1(association());
  invalid("operationReadProjection", { ...running, requestedRevisionId: null });
  for (const kind of ["disable", "stop"]) {
    const initial = projectLifecycleOperationReadV1(association(kind));
    invalid("operationReadProjection", { ...initial, requestedRevisionId: revision });
  }
  const resumed = projectLifecycleAcceptedReceiptV1(association("resume", 1));
  invalid(
    "mutationReceipt",
    modify(resumed, (value) => {
      value.operation.lifecycleGeneration = 1;
    }),
  );
  invalid("operationReadProjection", {
    ...resumed.operation,
    lifecycleGeneration: 1,
    requestedRevisionId: revision,
  });
});

test("historical read request is a scoped locator and rejects mutation or authority fields", () => {
  const input = { schemaVersion: 1, namespaceId: ns, agentId: agent, operationRef: uuid };
  assert.deepEqual(plain(parseLifecycleAdmissionV1("operationReadRequest", input)), input);
  for (const key of [
    "expectedLifecycleGeneration",
    "kind",
    "actorId",
    "installationId",
    "requestId",
    "authority",
    "retry",
  ]) {
    invalid("operationReadRequest", { ...input, [key]: true });
  }
});

test("timestamps retain exact valid UTC millisecond spelling and original time", () => {
  const a = association();
  for (const bad of [
    "2026-02-30T12:00:00.000Z",
    "2026-09-06T12:00:00Z",
    "2026-09-06T12:00:00.000+00:00",
    "2026-09-06T24:00:00.000Z",
    `${time}\n`,
    "not a time",
  ]) {
    invalid(
      "association",
      modify(a, (v) => {
        v.intent.createdAt = bad;
      }),
    );
  }
  for (const createdAt of [
    "2024-02-29T00:00:00.000Z",
    "2000-01-01T00:00:00.001Z",
    "2099-12-31T23:59:59.999Z",
  ]) {
    const input = modify(a, (v) => {
      v.intent.createdAt = createdAt;
    });
    assert.equal(projectLifecycleAcceptedReceiptV1(input).operation.acceptedAt, createdAt);
  }
});

test("work payload is closed locator data with opaque bounded work identity", () => {
  const input = work();
  assert.deepEqual(plain(parseLifecycleAdmissionV1("workInput", input)), input);
  assert.notEqual(input.operationRef, input.workId);
  for (const workId of ["opaque work key", "work:雪😀", "x".repeat(512)]) {
    assert.equal(parseLifecycleAdmissionV1("workInput", { ...input, workId }).workId, workId);
    assert.equal(
      parseLifecycleAdmissionV1("association", { ...association(), workId }).workId,
      workId,
    );
  }
  for (const workId of [
    "",
    " ",
    " leading",
    "trailing ",
    "x".repeat(513),
    "work\0key",
    "work\nkey",
    "work\u0085key",
  ]) {
    invalid("workInput", { ...input, workId });
    invalid("association", { ...association(), workId });
  }
  for (const key of [
    "actorId",
    "requestId",
    "auditEventId",
    "installationId",
    "revisionId",
    "authority",
    "claimToken",
  ]) {
    invalid("workInput", { ...input, [key]: "not-authority" });
  }
  invalid("workInput", { ...input, handler: "agent_revision" });
});

test("decoded results are detached, deeply frozen data without accessors", () => {
  const original = association();
  const decoded = decodeLifecycleAdmissionV1("association", original);
  assert.equal(decoded.kind, "valid");
  assert.ok(Object.isFrozen(decoded));
  for (const [, object] of objects(decoded.value)) assert.ok(Object.isFrozen(object));
  original.intent.actorId = "changed";
  original.request.namespaceId = `ns_${other}`;
  assert.equal(decoded.value.intent.actorId, "principal:operator-example");
  assert.equal(decoded.value.request.namespaceId, ns);
  assert.throws(() => {
    decoded.value.intent.generation = 99;
  }, TypeError);
  assert.throws(() => {
    decoded.value.request.expectedLifecycleGeneration = 5;
  }, TypeError);
  const twice = parseLifecycleAdmissionV1("association", decoded.value);
  assert.notEqual(twice, decoded.value);
  assert.notEqual(twice.intent, decoded.value.intent);
  assert.deepEqual(plain(twice), plain(decoded.value));
});

test("accessors, proxies and coercion hooks reject without invoking user code", () => {
  let calls = 0;
  const accessor = request();
  Object.defineProperty(accessor, "expectedLifecycleGeneration", {
    enumerable: true,
    get() {
      calls++;
      return null;
    },
  });
  invalid("mutationRequest", accessor);
  const proxy = new Proxy(request(), {
    ownKeys() {
      calls++;
      throw Error("private");
    },
    getPrototypeOf() {
      calls++;
      throw Error("private");
    },
  });
  invalid("mutationRequest", proxy);
  const nestedProxy = association();
  nestedProxy.intent = new Proxy(nestedProxy.intent, {
    get() {
      calls++;
      throw Error("private");
    },
  });
  invalid("association", nestedProxy);
  const coercion = {
    ...request(),
    expectedLifecycleGeneration: {
      valueOf() {
        calls++;
        return 1;
      },
      toJSON() {
        calls++;
        return 1;
      },
    },
  };
  invalid("mutationRequest", coercion);
  invalid("mutationRequest", {
    ...request(),
    toJSON() {
      calls++;
      return request();
    },
  });
  assert.equal(calls, 0);
});

test("exotic prototypes, aliases, cycles, symbols and nonenumerable fields reject", () => {
  invalid("mutationRequest", Object.assign(Object.create({ authority: true }), request()));
  invalid("mutationRequest", new Date(time));
  invalid("mutationRequest", new Map(Object.entries(request())));
  const hidden = request();
  Object.defineProperty(hidden, "expectedLifecycleGeneration", { enumerable: false, value: null });
  invalid("mutationRequest", hidden);
  const symbol = request();
  symbol[Symbol("authority")] = true;
  invalid("mutationRequest", symbol);
  const cycle = request();
  cycle.extra = cycle;
  invalid("mutationRequest", cycle);
  invalid("mutationRequest", JSON.parse('{"__proto__":{"authority":true}}'));
  const nullPrototype = Object.assign(Object.create(null), request());
  assert.deepEqual(plain(parseLifecycleAdmissionV1("mutationRequest", nullPrototype)), request());
});

test("in-process parser rejects raw text or bytes and malformed Unicode data", () => {
  invalid("mutationRequest", JSON.stringify(request()));
  invalid("mutationRequest", new TextEncoder().encode(JSON.stringify(request())));
  for (const workId of ["bad\ud800", "bad\udfff", "bad\ud800x", "bad\udfff\ud800"])
    invalid("workInput", { ...work(), workId });
  assert.equal(
    parseLifecycleAdmissionV1("workInput", { ...work(), workId: "literal-�" }).workId,
    "literal-�",
  );
});

test("finite parser bounds reject oversized, deep and wide data with static errors", () => {
  invalid("workInput", {
    ...work(),
    workId: "x".repeat(LIFECYCLE_ADMISSION_LIMITS_V1.maxJsonBytes + 1),
  });
  let deep = null;
  for (let index = 0; index < LIFECYCLE_ADMISSION_LIMITS_V1.maxDepth + 2; index++)
    deep = { next: deep };
  invalid("mutationRequest", deep);
  const wide = Object.fromEntries(
    Array.from({ length: LIFECYCLE_ADMISSION_LIMITS_V1.maxContainerEntries + 1 }, (_, i) => [
      `field${i}`,
      null,
    ]),
  );
  invalid("mutationRequest", wide);
  invalid("mutationRequest", Array(129).fill(null));
  for (const kind of ["constructor", "__proto__", "unknown", null, undefined])
    invalid(kind, request());
});

test("partial or contradictory association data cannot be projected as a receipt or readback", () => {
  const base = association("resume", 4);
  for (const key of Object.keys(base)) {
    const partial = modify(base, (v) => {
      delete v[key];
    });
    assert.throws(() => projectLifecycleAcceptedReceiptV1(partial), LifecycleAdmissionErrorV1);
    assert.throws(() => projectLifecycleOperationReadV1(partial), LifecycleAdmissionErrorV1);
  }
  const mismatch = modify(base, (v) => {
    v.intent.generation = 8;
  });
  assert.throws(() => projectLifecycleAcceptedReceiptV1(mismatch), LifecycleAdmissionErrorV1);
  assert.throws(() => projectLifecycleOperationReadV1(mismatch), LifecycleAdmissionErrorV1);
});

test("canonical intent-head projection preserves running revision correlation and protective lineage", () => {
  for (const kind of ["deploy", "disable", "stop", "resume"]) {
    const intent = association(kind, kind === "resume" ? 1 : null).intent;
    const head = projectLifecycleIntentHeadV1(intent);
    assert.deepEqual(plain(head), {
      operationRef: intent.transitionRef,
      lifecycleGeneration: intent.generation,
      desiredMode: intent.desiredMode,
      requestedRevisionId: intent.revisionId,
    });
    assert.ok(Object.isFrozen(head));
    invalid("intentHeadProjection", { ...head, actorId: intent.actorId });
  }
  const running = projectLifecycleIntentHeadV1(association().intent);
  invalid("intentHeadProjection", { ...running, requestedRevisionId: null });
  for (const desiredMode of ["disabled", "stopped"]) {
    invalid("intentHeadProjection", { ...running, desiredMode });
    for (const requestedRevisionId of [null, revision]) {
      const later = { ...running, lifecycleGeneration: 2, desiredMode, requestedRevisionId };
      assert.deepEqual(plain(parseLifecycleAdmissionV1("intentHeadProjection", later)), later);
    }
  }
  invalid("intentHeadProjection", null);
  invalid("intentHeadProjection", { ...running, lifecycleGeneration: 0 });
  invalid("intentHeadProjection", { ...running, desiredMode: "deleted" });
});
