import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createLifecycleStatusServiceV1 } from "../../packages/occ/src/lifecycle/status-service-v1.ts";
import { createControlledLifecycleStatusSourceV1 } from "../fixtures/lifecycle-status-http-v1/source.ts";

const portable = JSON.parse(
  readFileSync(
    new URL("../fixtures/lifecycle-status-projector-v1/sanitized.json", import.meta.url),
    "utf8",
  ),
);
const methods = ["readStatus", "readOperation", "listOperations", "readCapability"];
const installationId = "ins_88888888-8888-4888-8888-888888888888";
const laterInstallationId = "ins_99999999-9999-4999-8999-999999999999";
const unavailable = { kind: "unavailable" };
const notFound = { kind: "rejected", code: "NOT_FOUND" };
const forbidden = { kind: "rejected", code: "FORBIDDEN" };
const plain = (value) => structuredClone(value);
const scopeOf = ({ namespaceId, agentId }) => ({ namespaceId, agentId });

function readCase(method, label) {
  const entry = portable.readCases.find((candidate) =>
    label
      ? candidate.label === label
      : candidate.method === method && candidate.result.kind === "read",
  );
  assert.ok(entry, "The existing portable artifact must contain the requested case.");
  return structuredClone(entry);
}

function setup(respond = (method) => readCase(method).result) {
  const fixture = createControlledLifecycleStatusSourceV1(
    Object.fromEntries(
      methods.map((method) => [method, (request, call) => respond(method, request, call)]),
    ),
  );
  const composition = { installationId, source: fixture.source };
  const service = createLifecycleStatusServiceV1({
    resolveInstallationId: () => composition.installationId,
    resolveSource: () => composition.source,
  });
  const call = (request, controller = new AbortController()) =>
    fixture.createCall(scopeOf(request), controller.signal);
  return { fixture, composition, service, call };
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

// Controlled fixture handles and supplied JSON establish test correlation only.
// These cases exercise the real service; they do not qualify an authorized source.
test("the service preserves all existing portable read cases through one corresponding source call", async () => {
  for (const entry of portable.readCases) {
    const input = structuredClone(entry);
    const { fixture, service, call } = setup(() => input.result);
    const invocation = call(input.request);
    const result = await service[input.method](input.request, invocation);
    assert.deepEqual(plain(result), input.result, input.label);
    assert.equal(Object.isFrozen(service), true);
    assert.equal(Object.isFrozen(result), true);
    const calls = fixture.invocations();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, input.method);
    assert.equal(calls[0].call, invocation);
    assert.equal(calls[0].call.authenticated, invocation.authenticated);
    assert.equal(calls[0].call.signal, invocation.signal);
    assert.notEqual(calls[0].request, input.request);
    assert.deepEqual(plain(calls[0].request), input.request);
    assert.equal(Object.isFrozen(calls[0].request), true);
  }
});

test("missing or invalid owning Installation prevents every source invocation", async () => {
  for (const value of [
    undefined,
    null,
    "",
    "invalid",
    7,
    "ns_88888888-8888-4888-8888-888888888888",
  ]) {
    const { fixture, composition, service, call } = setup();
    composition.installationId = value;
    for (const method of methods) {
      const { request } = readCase(method);
      assert.deepEqual(await service[method](request, call(request)), unavailable);
    }
    assert.equal(fixture.invocations().length, 0);
  }
});

test("a missing source fails closed and the next independent call can resolve a configured source", async () => {
  const { fixture, composition, service, call } = setup();
  const { request, result } = readCase("readStatus");
  const invocation = call(request);
  composition.source = undefined;
  assert.deepEqual(await service.readStatus(request, invocation), unavailable);
  assert.equal(fixture.invocations().length, 0);
  composition.source = fixture.source;
  assert.deepEqual(plain(await service.readStatus(request, invocation)), result);
  assert.equal(fixture.invocations().length, 1);
});

test("resolver exceptions disclose no private error or result", async () => {
  for (const failingResolver of ["installation", "source"]) {
    const { fixture, call } = setup();
    const fail = () => {
      throw new Error("synthetic private dependency detail");
    };
    const service = createLifecycleStatusServiceV1({
      resolveInstallationId: failingResolver === "installation" ? fail : () => installationId,
      resolveSource: failingResolver === "source" ? fail : () => fixture.source,
    });
    for (const method of methods) {
      const { request } = readCase(method);
      assert.deepEqual(await service[method](request, call(request)), unavailable);
    }
    assert.equal(fixture.invocations().length, 0);
  }
});

test("caller-selected Installation and malformed requests never reach the source", async () => {
  const { fixture, service, call } = setup();
  for (const method of methods) {
    const { request } = readCase(method);
    const invocation = call(request);
    for (const malformed of [null, {}, { ...request, installationId }])
      assert.deepEqual(await service[method](malformed, invocation), unavailable);
  }
  assert.equal(fixture.invocations().length, 0);
});

test("each explicit discovery page obtains a new source decision without a permission or result cache", async () => {
  const entry = readCase("listOperations", "bounded-partial-page-with-cursor");
  const { fixture, service, call } = setup(() => entry.result);
  const invocation = call(entry.request);
  assert.deepEqual(plain(await service.listOperations(entry.request, invocation)), entry.result);
  const continuation = {
    ...entry.request,
    afterGeneration: entry.result.value.nextAfterGeneration,
  };
  fixture.setVisibility(invocation, "denied");
  assert.deepEqual(plain(await service.listOperations(continuation, invocation)), forbidden);
  fixture.setVisibility(invocation, "hidden");
  assert.deepEqual(plain(await service.listOperations(continuation, invocation)), notFound);
  assert.equal(fixture.invocations().length, 3);
  assert.deepEqual(
    fixture.invocations().map(({ request }) => request.afterGeneration),
    [2, 3, 3],
  );
  assert.ok(fixture.invocations().every(({ call: actual }) => actual === invocation));
});

test("unowned fixture handles and hidden or foreign scopes preserve closed source failures", async () => {
  const { fixture, service, call } = setup();
  const { request } = readCase("readStatus");
  const invocation = call(request);
  const unowned = { authenticated: Object.freeze({}), signal: invocation.signal };
  assert.deepEqual(plain(await service.readStatus(request, unowned)), {
    kind: "rejected",
    code: "UNAUTHENTICATED",
  });
  fixture.setVisibility(invocation, "hidden");
  const hidden = await service.readStatus(request, invocation);
  fixture.setVisibility(invocation, "visible");
  const foreign = await service.readStatus(
    { ...request, agentId: "agt_99999999-9999-4999-8999-999999999999" },
    invocation,
  );
  assert.deepEqual(plain(hidden), notFound);
  assert.equal(JSON.stringify(hidden), JSON.stringify(foreign));
});

test("Installation replacement during a source wait suppresses every late result", async () => {
  for (const method of methods) {
    const pending = deferred();
    const { fixture, composition, service, call } = setup(() => pending.promise);
    const { request, result } = readCase(method);
    const returned = service[method](request, call(request));
    assert.equal(fixture.invocations().length, 1);
    composition.installationId = laterInstallationId;
    pending.resolve(result);
    assert.deepEqual(await returned, unavailable);
    assert.equal(fixture.invocations().length, 1);
  }
});

test("source replacement during a wait suppresses the old reply and never invokes the replacement implicitly", async () => {
  for (const method of methods) {
    const pending = deferred();
    const { fixture, composition, service, call } = setup(() => pending.promise);
    const replacement = setup();
    const { request, result } = readCase(method);
    const returned = service[method](request, call(request));
    composition.source = replacement.fixture.source;
    pending.resolve(result);
    assert.deepEqual(await returned, unavailable);
    assert.equal(fixture.invocations().length, 1);
    assert.equal(replacement.fixture.invocations().length, 0);
  }
});

test("a dependency that throws during the post-read comparison prevents disclosure", async () => {
  for (const failingResolver of ["installation", "source"]) {
    const pending = deferred();
    const { fixture, call } = setup(() => pending.promise);
    let settled = false;
    const service = createLifecycleStatusServiceV1({
      resolveInstallationId: () => {
        if (settled && failingResolver === "installation")
          throw new Error("private late installation failure");
        return installationId;
      },
      resolveSource: () => {
        if (settled && failingResolver === "source") throw new Error("private late source failure");
        return fixture.source;
      },
    });
    const { request, result } = readCase("readStatus");
    const returned = service.readStatus(request, call(request));
    assert.equal(fixture.invocations().length, 1);
    settled = true;
    pending.resolve(result);
    assert.deepEqual(await returned, unavailable);
  }
});

test("already aborted calls do not invoke a source", async () => {
  const { fixture, service, call } = setup();
  const controller = new AbortController();
  controller.abort(new Error("private abort detail"));
  for (const method of methods) {
    const { request } = readCase(method);
    assert.deepEqual(await service[method](request, call(request, controller)), unavailable);
  }
  assert.equal(fixture.invocations().length, 0);
});

test("cancellation or replacement of the original signal during a wait suppresses the result", async () => {
  for (const change of ["abort", "replace"]) {
    const pending = deferred();
    const { fixture, service, call } = setup(() => pending.promise);
    const controller = new AbortController();
    const { request, result } = readCase("readStatus");
    // Deliberately mutable JS input exercises an untrusted caller; the public type is readonly.
    const invocation = { ...call(request, controller) };
    const returned = service.readStatus(request, invocation);
    assert.equal(fixture.invocations().length, 1);
    if (change === "abort") controller.abort();
    else invocation.signal = new AbortController().signal;
    pending.resolve(result);
    assert.deepEqual(await returned, unavailable);
  }
});

test("source exceptions and mutation envelopes fail closed without automatic retry", async () => {
  for (const response of [
    () => {
      throw new Error("synthetic private source body");
    },
    () => ({ kind: "read", value: { privateDetail: "malformed" } }),
    ...portable.mutationResults.map(
      ({ value }) =>
        () =>
          structuredClone(value),
    ),
  ]) {
    const { fixture, service, call } = setup(response);
    const { request } = readCase("readStatus");
    assert.deepEqual(await service.readStatus(request, call(request)), unavailable);
    assert.equal(fixture.invocations().length, 1);
  }
});

test("the service uses the existing sanitizer for private extras and exact response correspondence", async () => {
  const entry = readCase("readStatus", "distinct-requested-selected-serving");
  const richer = structuredClone(entry.result);
  let privateReads = 0;
  Object.defineProperty(richer.value, "privateDetail", {
    enumerable: true,
    get() {
      privateReads++;
      throw new Error("private detail must not be read");
    },
  });
  const { fixture, service, call } = setup(() => richer);
  const invocation = call(entry.request);
  assert.deepEqual(plain(await service.readStatus(entry.request, invocation)), entry.result);
  assert.equal(privateReads, 0);
  richer.value.agentId = "agt_99999999-9999-4999-8999-999999999999";
  assert.deepEqual(await service.readStatus(entry.request, invocation), unavailable);
  assert.equal(fixture.invocations().length, 2);
  assert.equal(privateReads, 0);
});
