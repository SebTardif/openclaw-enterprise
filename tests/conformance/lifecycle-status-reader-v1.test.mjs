import assert from "node:assert/strict";
import test from "node:test";
import { createSanitizedLifecycleStatusReaderV1 } from "../../packages/occ/src/lifecycle/status-reader-v1.ts";

const ref = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const scope = () => ({ namespaceId: `ns_${ref(1)}`, agentId: `agt_${ref(2)}` });
const requests = {
  readStatus: scope,
  readOperation: () => ({ schemaVersion: 1, ...scope(), operationRef: ref(3) }),
  listOperations: () => ({ schemaVersion: 1, ...scope(), afterGeneration: null, limit: 2 }),
  readCapability: scope,
};
const unavailable = { kind: "unavailable" };
const denied = { kind: "rejected", code: "FORBIDDEN" };
const notFound = { kind: "rejected", code: "NOT_FOUND" };
const plain = (value) => structuredClone(value);

// These untrusted JS values exercise forwarding only. No authenticated handle,
// allowed account observation or real authorizing reader is created by a test.
function call(controller = new AbortController()) {
  return {
    authenticated: Object.freeze({ untrustedTestCorrelation: "opaque" }),
    signal: controller.signal,
  };
}
function denyingSource(calls, respond = () => denied) {
  const source = Object.fromEntries(
    Object.keys(requests).map((method) => [
      method,
      async function (request, invocation) {
        assert.equal(this, source);
        calls.push({ method, request, call: invocation });
        return respond(method, request, invocation);
      },
    ]),
  );
  return source;
}

test("an absent reader returns closed unavailable for every existing read method", async () => {
  const reader = createSanitizedLifecycleStatusReaderV1(undefined);
  assert.equal(Object.isFrozen(reader), true);
  for (const [method, request] of Object.entries(requests)) {
    const result = await reader[method](request(), call());
    assert.deepEqual(result, unavailable);
    assert.equal(Object.isFrozen(result), true);
  }
});

test("each read forwards the original call and a detached canonical request to its corresponding source", async () => {
  const calls = [];
  const reader = createSanitizedLifecycleStatusReaderV1(denyingSource(calls));
  for (const [method, requestFactory] of Object.entries(requests)) {
    const request = requestFactory();
    const invocation = call();
    const result = await reader[method](request, invocation);
    assert.deepEqual(plain(result), denied);
    const forwarded = calls.at(-1);
    assert.equal(forwarded.method, method);
    assert.equal(forwarded.call, invocation);
    assert.equal(forwarded.call.authenticated, invocation.authenticated);
    assert.equal(forwarded.call.signal, invocation.signal);
    assert.notEqual(forwarded.request, request);
    assert.deepEqual(structuredClone(forwarded.request), request);
    assert.equal(Object.isFrozen(forwarded.request), true);
  }
  assert.equal(calls.length, 4);
});

test("successive discovery pages and repeated reads each invoke the source without permission or result caching", async () => {
  const calls = [];
  const responses = [denied, notFound, unavailable, denied];
  const reader = createSanitizedLifecycleStatusReaderV1(
    denyingSource(calls, () => responses[calls.length - 1]),
  );
  const invocation = call();
  const first = requests.listOperations();
  const later = { ...first, afterGeneration: 8 };
  for (const [index, request] of [first, later, later, first].entries())
    assert.deepEqual(plain(await reader.listOperations(request, invocation)), responses[index]);
  assert.equal(calls.length, 4);
  assert.deepEqual(
    calls.map(({ request }) => request.afterGeneration),
    [null, 8, 8, null],
  );
  assert.ok(calls.every(({ call: forwarded }) => forwarded === invocation));
});

test("hidden and foreign failures have identical public bytes despite incidental backend details", async () => {
  const results = [];
  for (const details of [
    { owner: "foreign-owner", count: 8, protectedPath: "/private/foreign" },
    { owner: "hidden-owner", count: 0, conversation: { content: "private" } },
  ]) {
    const calls = [];
    const reader = createSanitizedLifecycleStatusReaderV1(
      denyingSource(calls, () => ({ ...notFound, ...details })),
    );
    results.push(await reader.readOperation(requests.readOperation(), call()));
    assert.equal(calls.length, 1);
  }
  assert.deepEqual(plain(results[0]), notFound);
  assert.equal(JSON.stringify(results[0]), JSON.stringify(results[1]));
});

test("malformed requests never reach the source or disclose request contents", async () => {
  const calls = [];
  const reader = createSanitizedLifecycleStatusReaderV1(denyingSource(calls));
  for (const method of Object.keys(requests)) {
    for (const request of [
      null,
      {},
      { ...requests[method](), installationId: "caller-selected-private" },
    ])
      assert.deepEqual(await reader[method](request, call()), unavailable);
  }
  assert.equal(calls.length, 0);
});

test("aborted calls do not invoke any source method", async () => {
  const calls = [];
  const reader = createSanitizedLifecycleStatusReaderV1(denyingSource(calls));
  const controller = new AbortController();
  controller.abort(new Error("private abort detail"));
  for (const [method, request] of Object.entries(requests))
    assert.deepEqual(await reader[method](request(), call(controller)), unavailable);
  assert.equal(calls.length, 0);
});

test("cancellation during a source wait suppresses the eventual result on every surface", async () => {
  for (const [method, request] of Object.entries(requests)) {
    const calls = [];
    const controller = new AbortController();
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const reader = createSanitizedLifecycleStatusReaderV1(denyingSource(calls, () => pending));
    const result = reader[method](request(), call(controller));
    assert.equal(calls.length, 1);
    controller.abort();
    release({ ...notFound, privateBackend: "late private body" });
    assert.deepEqual(await result, unavailable);
    assert.equal(calls.length, 1);
  }
});

test("source errors and malformed or mutation responses return unavailable without error-body leakage", async () => {
  for (const response of [
    () => {
      throw new Error("private backend body /protected/path");
    },
    () => Promise.reject({ credential: "private" }),
    () => ({ kind: "rejected", code: "PRIVATE_BACKEND_ERROR" }),
    () => ({ kind: "read", value: { secret: "private" } }),
    () => ({ kind: "commit-unknown" }),
    () => ({ kind: "accepted", lifecycleGeneration: 7 }),
    () => null,
  ]) {
    const calls = [];
    const reader = createSanitizedLifecycleStatusReaderV1(denyingSource(calls, response));
    assert.deepEqual(await reader.readStatus(scope(), call()), unavailable);
    assert.equal(calls.length, 1);
  }
});

test("replacing a JavaScript call's signal during a read cannot discard original cancellation", async () => {
  const calls = [];
  const controller = new AbortController();
  const invocation = call(controller);
  const reader = createSanitizedLifecycleStatusReaderV1(
    denyingSource(calls, () => {
      controller.abort();
      invocation.signal = new AbortController().signal;
      return notFound;
    }),
  );
  assert.deepEqual(await reader.readStatus(scope(), invocation), unavailable);
  assert.equal(calls.length, 1);
});

test("a failed earlier invocation does not prevent the next independent source read", async () => {
  const calls = [];
  const reader = createSanitizedLifecycleStatusReaderV1(
    denyingSource(calls, () => {
      if (calls.length === 1) throw new Error("first source unavailable");
      return notFound;
    }),
  );
  assert.deepEqual(await reader.readStatus(scope(), call()), unavailable);
  assert.deepEqual(plain(await reader.readStatus(scope(), call())), notFound);
  assert.equal(calls.length, 2);
});
