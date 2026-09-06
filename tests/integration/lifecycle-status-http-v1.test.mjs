import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import { ErrorResponse } from "@openclaw-enterprise/contracts/api/common";
import { lifecycleApiRoutes } from "@openclaw-enterprise/contracts/api/agent/lifecycle-routes";
import { createLifecycleStatusServiceV1 } from "@openclaw-enterprise/occ/lifecycle/status-service-v1";
import { createLifecycleStatusOperationHandlersV1 } from "../../apps/controller/src/routes/lifecycle-status.ts";
import { createControlledLifecycleStatusSourceV1 } from "../fixtures/lifecycle-status-http-v1/source.ts";

const portable = JSON.parse(
  readFileSync(
    new URL("../fixtures/lifecycle-status-projector-v1/sanitized.json", import.meta.url),
    "utf8",
  ),
);
const methods = ["readStatus", "readOperation", "listOperations", "readCapability"];
const routeByMethod = {
  readStatus: lifecycleApiRoutes[0],
  listOperations: lifecycleApiRoutes[1],
  readOperation: lifecycleApiRoutes[2],
  readCapability: lifecycleApiRoutes[3],
};
const sample = (method) =>
  structuredClone(
    portable.readCases.find((entry) => entry.method === method && entry.result.kind === "read"),
  );
const scope = sample("readStatus").request;
const installationId = "ins_88888888-8888-4888-8888-888888888888";
function urlFor(method, request = sample(method).request) {
  let url = routeByMethod[method].path
    .replace(":namespaceId", request.namespaceId)
    .replace(":agentId", request.agentId);
  if (method === "readOperation") url = url.replace(":operationRef", request.operationRef);
  if (method === "listOperations") {
    const query = new URLSearchParams({ limit: String(request.limit) });
    if (request.afterGeneration !== null)
      query.set("afterGeneration", String(request.afterGeneration));
    url += `?${query}`;
  }
  return url;
}
function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

// Actual Fastify schema/handler/service execution with controlled hooks. This
// deliberately does not load the production register/index/auth graph, qualify
// private handles, or provide an authoritative repository/observation producer.
async function setup(t, responder = (method) => sample(method).result) {
  const fixture = createControlledLifecycleStatusSourceV1(
    Object.fromEntries(
      methods.map((method) => [method, (request, call) => responder(method, request, call)]),
    ),
  );
  const state = {
    source: fixture.source,
    installationId,
    calls: [],
    missingCall: false,
    visibility: "visible",
    resolveError: false,
  };
  const service = createLifecycleStatusServiceV1({
    resolveInstallationId: () => state.installationId,
    resolveSource: () => state.source,
  });
  state.service = service;
  const privateCalls = new WeakMap();
  const controllers = [];
  const handlers = createLifecycleStatusOperationHandlersV1({
    resolveService: () => state.service,
    resolveReadCall: async (request) => {
      state.calls.push(request);
      if (state.resolveError) throw new Error("PRIVATE-AUTH-ERROR");
      if (state.beforeResolve) await state.beforeResolve();
      return state.missingCall ? undefined : privateCalls.get(request);
    },
  });
  const app = Fastify({
    logger: false,
    requestIdHeader: false,
    genReqId: () => `req_${randomUUID()}`,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });
  t.after(() => app.close());
  app.addSchema(ErrorResponse);
  app.setErrorHandler((error, request, reply) =>
    reply.status(400).send({
      error: {
        code: "INVALID_REQUEST",
        message: "The request does not match the operation contract.",
      },
      meta: { requestId: request.id },
    }),
  );
  for (const operation of lifecycleApiRoutes) {
    app.route({
      method: operation.method,
      url: operation.path,
      schema: operation.schema,
      preHandler: async (request, reply) => {
        // Controlled admission/identity outcomes, not the actual protected
        // registry. Production registration must execute its existing hooks.
        if (request.headers["x-test-identity"] === "deny") {
          return reply.status(401).send({
            error: { code: "UNAUTHENTICATED", message: "Authentication is required." },
            meta: { requestId: request.id },
          });
        }
        const controller = new AbortController();
        controllers.push(controller);
        const call = fixture.createCall(scope, controller.signal);
        fixture.setVisibility(call, state.visibility);
        privateCalls.set(request, call);
        if (state.preAbort) controller.abort();
      },
      handler: handlers[operation.operationId],
    });
  }
  await app.ready();
  return { app, state, fixture, controllers };
}
function closedError(response, status, code) {
  assert.equal(response.statusCode, status);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ["error", "meta"]);
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message"]);
  assert.deepEqual(Object.keys(body.meta), ["requestId"]);
  assert.equal(body.error.code, code);
  assert.match(body.meta.requestId, /^req_/);
  assert.doesNotMatch(response.body, /PRIVATE|password|secret-value/);
}

test("all original portable read values survive real Fastify serialization and one exact source invocation", async (t) => {
  let current;
  const { app, state, fixture } = await setup(t, () => current.result);
  for (const entry of portable.readCases.filter((entry) => entry.result.kind === "read")) {
    current = structuredClone(entry);
    const before = fixture.invocations().length;
    const response = await app.inject({ method: "GET", url: urlFor(entry.method, entry.request) });
    assert.equal(response.statusCode, 200, `${entry.label}: ${response.body}`);
    assert.deepEqual(response.json().data, entry.result.value, entry.label);
    assert.deepEqual(Object.keys(response.json()).sort(), ["data", "meta"]);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["x-request-id"], response.json().meta.requestId);
    assert.equal(fixture.invocations().length, before + 1);
    assert.equal(state.calls.length, before + 1);
    assert.equal(fixture.invocations().at(-1).method, entry.method);
    assert.deepEqual(structuredClone(fixture.invocations().at(-1).request), entry.request);
  }
});

test("URL omission supplies only the canonical page default and null cursor", async (t) => {
  const entry = portable.readCases.find(
    (value) => value.label === "ambiguous-discovery-without-accepted-locator",
  );
  const { app, fixture } = await setup(t, () => entry.result);
  const response = await app.inject({ method: "GET", url: urlFor("listOperations").split("?")[0] });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(structuredClone(fixture.invocations()[0].request), {
    schemaVersion: 1,
    ...scope,
    limit: 20,
    afterGeneration: null,
  });
  assert.equal(fixture.invocations().length, 1);
});

test("invalid query strings and unsafe cursors fail before private-call or source access", async (t) => {
  const { app, state, fixture } = await setup(t);
  const base = urlFor("listOperations").split("?")[0];
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=01",
    "limit=1e1",
    "limit=-1",
    "limit=1.0",
    "limit=1%0A",
    "limit=1&limit=2",
    "afterGeneration=0",
    "afterGeneration=01",
    "afterGeneration=9007199254740992",
    "afterGeneration=1%0A",
    "actorId=PRIVATE",
    "installationId=PRIVATE",
    "cursor=PRIVATE",
  ]) {
    closedError(
      await app.inject({ method: "GET", url: `${base}?${query}` }),
      400,
      "INVALID_REQUEST",
    );
  }
  assert.equal(state.calls.length, 0);
  assert.equal(fixture.invocations().length, 0);
});

test("invalid exact identities, operation locators, extra queries and request bodies are rejected", async (t) => {
  const { app, state, fixture } = await setup(t);
  const badUrls = [
    urlFor("readStatus").replace(scope.agentId, "bad"),
    urlFor("readOperation").replace(sample("readOperation").request.operationRef, "bad"),
    `${urlFor("readStatus")}?authority=PRIVATE`,
    `${urlFor("readCapability")}?limit=1`,
  ];
  for (const url of badUrls)
    closedError(await app.inject({ method: "GET", url }), 400, "INVALID_REQUEST");
  closedError(
    await app.inject({
      method: "GET",
      url: urlFor("readStatus"),
      payload: { authenticated: "PRIVATE" },
    }),
    400,
    "INVALID_REQUEST",
  );
  assert.equal(state.calls.length, 0);
  assert.equal(fixture.invocations().length, 0);
});

test("missing service, source, Installation or private call never becomes a positive read", async (t) => {
  for (const mutate of [
    (state) => {
      state.service = undefined;
    },
    (state) => {
      state.source = undefined;
    },
    (state) => {
      state.installationId = undefined;
    },
    (state) => {
      state.missingCall = true;
    },
    (state) => {
      state.resolveError = true;
    },
  ]) {
    const { app, state, fixture } = await setup(t);
    mutate(state);
    for (const method of methods)
      closedError(
        await app.inject({ method: "GET", url: urlFor(method) }),
        503,
        "DEPENDENCY_UNAVAILABLE",
      );
    assert.equal(fixture.invocations().length, 0);
  }
});

test("explicit canonical rejection codes retain fixed HTTP mappings without private error details", async (t) => {
  let result;
  const { app } = await setup(t, () => result);
  for (const [code, status] of Object.entries({
    INVALID_REQUEST: 400,
    UNAUTHENTICATED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    NAMESPACE_NOT_READY: 409,
    INTERNAL_ERROR: 500,
  })) {
    result = {
      kind: "rejected",
      code,
      message: "PRIVATE-ERROR",
      details: { password: "secret-value" },
    };
    closedError(await app.inject({ method: "GET", url: urlFor("readStatus") }), status, code);
  }
  result = { kind: "unavailable", error: "PRIVATE" };
  closedError(
    await app.inject({ method: "GET", url: urlFor("readStatus") }),
    503,
    "DEPENDENCY_UNAVAILABLE",
  );
});

test("foreign Namespace or Agent scope receives the source's non-disclosing not-found", async (t) => {
  const { app } = await setup(t);
  for (const request of [
    { ...scope, namespaceId: "ns_99999999-9999-4999-8999-999999999999" },
    { ...scope, agentId: "agt_99999999-9999-4999-8999-999999999999" },
  ])
    closedError(
      await app.inject({ method: "GET", url: urlFor("readStatus", request) }),
      404,
      "NOT_FOUND",
    );
});

test("denied, hidden and unauthenticated controlled reads expose no retained body", async (t) => {
  const { app, state, fixture } = await setup(t);
  state.visibility = "denied";
  closedError(await app.inject({ method: "GET", url: urlFor("readStatus") }), 403, "FORBIDDEN");
  state.visibility = "hidden";
  closedError(await app.inject({ method: "GET", url: urlFor("readStatus") }), 404, "NOT_FOUND");
  const before = fixture.invocations().length;
  closedError(
    await app.inject({
      method: "GET",
      url: urlFor("readStatus"),
      headers: { "x-test-identity": "deny" },
    }),
    401,
    "UNAUTHENTICATED",
  );
  assert.equal(fixture.invocations().length, before);
});

test("private fields are removed before serialization while original uncertainty and times survive", async (t) => {
  const entry = portable.readCases.find(
    (value) => value.label === "retained-state-termination-unknown",
  );
  const result = structuredClone(entry.result);
  result.value.actorId = "PRIVATE";
  result.value.account = { password: "secret-value" };
  result.value.conditions.executionTerminated.debug = "PRIVATE";
  const { app } = await setup(t, () => result);
  const response = await app.inject({ method: "GET", url: urlFor("readStatus") });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data, entry.result.value);
  assert.doesNotMatch(response.body, /PRIVATE|password|secret-value/);
});

test("a mismatched operation or Agent result and mutation outcomes cannot be serialized as reads", async (t) => {
  let result = structuredClone(sample("readOperation").result);
  result.value.operation.operationRef = "99999999-9999-4999-8999-999999999999";
  const { app } = await setup(t, () => result);
  closedError(
    await app.inject({ method: "GET", url: urlFor("readOperation") }),
    503,
    "DEPENDENCY_UNAVAILABLE",
  );
  result = structuredClone(sample("readStatus").result);
  result.value.agentId = "agt_99999999-9999-4999-8999-999999999999";
  closedError(
    await app.inject({ method: "GET", url: urlFor("readStatus") }),
    503,
    "DEPENDENCY_UNAVAILABLE",
  );
  for (const entry of portable.mutationResults) {
    result = entry.value;
    closedError(
      await app.inject({ method: "GET", url: urlFor("readStatus") }),
      503,
      "DEPENDENCY_UNAVAILABLE",
    );
  }
});

test("each explicitly requested page gets fresh call resolution and no implicit page walk", async (t) => {
  const { app, state, fixture } = await setup(t);
  const request = sample("listOperations").request;
  const first = await app.inject({ method: "GET", url: urlFor("listOperations", request) });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().data.nextAfterGeneration, 3);
  assert.equal(fixture.invocations().length, 1);
  state.visibility = "denied";
  closedError(
    await app.inject({
      method: "GET",
      url: urlFor("listOperations", { ...request, afterGeneration: 3 }),
    }),
    403,
    "FORBIDDEN",
  );
  assert.equal(state.calls.length, 2);
  assert.equal(fixture.invocations().length, 2);
  assert.notEqual(fixture.invocations()[0].call, fixture.invocations()[1].call);
});

test("already cancelled calls do not reach the source", async (t) => {
  const { app, state, fixture } = await setup(t);
  state.preAbort = true;
  closedError(
    await app.inject({ method: "GET", url: urlFor("readStatus") }),
    503,
    "DEPENDENCY_UNAVAILABLE",
  );
  assert.equal(fixture.invocations().length, 0);
});

test("cancellation while a source read is pending suppresses its later successful result", async (t) => {
  const entered = deferred();
  const result = deferred();
  const { app, fixture, controllers } = await setup(t, () => {
    entered.resolve();
    return result.promise;
  });
  const pending = app.inject({ method: "GET", url: urlFor("readStatus") });
  await entered.promise;
  controllers[0].abort();
  result.resolve(sample("readStatus").result);
  closedError(await pending, 503, "DEPENDENCY_UNAVAILABLE");
  assert.equal(fixture.invocations().length, 1);
});

test("service replacement while private-call resolution waits prevents source use", async (t) => {
  const entered = deferred();
  const gate = deferred();
  const { app, state, fixture } = await setup(t);
  state.beforeResolve = () => {
    entered.resolve();
    return gate.promise;
  };
  const pending = app.inject({ method: "GET", url: urlFor("readStatus") });
  await entered.promise;
  state.service = undefined;
  gate.resolve();
  closedError(await pending, 503, "DEPENDENCY_UNAVAILABLE");
  assert.equal(fixture.invocations().length, 0);
});

test("source replacement during a read suppresses prior data", async (t) => {
  const entered = deferred();
  const result = deferred();
  const { app, state } = await setup(t, () => {
    entered.resolve();
    return result.promise;
  });
  const pending = app.inject({ method: "GET", url: urlFor("readStatus") });
  await entered.promise;
  state.source = undefined;
  result.resolve(sample("readStatus").result);
  closedError(await pending, 503, "DEPENDENCY_UNAVAILABLE");
});

test("a lost or failing read response stays unavailable without another read or mutation attempt", async (t) => {
  const { app, state, fixture } = await setup(t, () => {
    throw new Error("PRIVATE-provider-error");
  });
  closedError(
    await app.inject({ method: "GET", url: urlFor("readOperation") }),
    503,
    "DEPENDENCY_UNAVAILABLE",
  );
  assert.equal(state.calls.length, 1);
  assert.equal(fixture.invocations().length, 1);
});
