import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Check } from "typebox/value";
import { lifecycleApiRoutes } from "../../packages/contracts/src/api/agent/lifecycle-routes.ts";
import {
  AgentParams,
  EmptyQuery,
  Meta,
  ErrorResponse,
} from "../../packages/contracts/src/api/common.ts";
import {
  LifecycleOperationReadRequestSchemaV1,
  parseLifecycleAdmissionV1,
} from "../../packages/contracts/src/lifecycle-admission-v1.ts";
import {
  LifecycleCapabilitySchemaV1,
  LifecycleOperationPageRequestSchemaV1,
  LifecycleOperationPageSchemaV1,
  LifecycleOperationStatusSchemaV1,
  LifecycleStatusSchemaV1,
  parseLifecycleObservationResponseV1,
} from "../../packages/contracts/src/lifecycle-observation-v1.ts";

// These tests execute the actual HTTP schema declarations with TypeBox. They do
// not register a server, authenticate a caller, invoke a producer or prove runtime
// state. Canonical semantic validation and HTTP normalization stay in the handler.
const fixtures = JSON.parse(
  readFileSync(
    new URL("../fixtures/lifecycle-status-projector-v1/sanitized.json", import.meta.url),
    "utf8",
  ),
);
const uuid = "11111111-1111-4111-8111-111111111111";
const scope = { namespaceId: `ns_${uuid}`, agentId: `agt_${uuid}` };
const meta = { requestId: `req_${uuid}` };
const routes = Object.fromEntries(lifecycleApiRoutes.map((route) => [route.operationId, route]));
const methodIds = {
  readStatus: "getAgentLifecycleStatus",
  listOperations: "listAgentLifecycleOperations",
  readOperation: "getAgentLifecycleOperation",
  readCapability: "getAgentLifecycleCapability",
};
const expectedRoutes = [
  [
    "getAgentLifecycleStatus",
    "/namespaces/:namespaceId/agents/:agentId/lifecycle",
    "openclaw.agents.lifecycle.read",
    LifecycleStatusSchemaV1,
  ],
  [
    "listAgentLifecycleOperations",
    "/namespaces/:namespaceId/agents/:agentId/lifecycle/operations",
    "openclaw.agents.lifecycle.operations.list",
    LifecycleOperationPageSchemaV1,
  ],
  [
    "getAgentLifecycleOperation",
    "/namespaces/:namespaceId/agents/:agentId/lifecycle/operations/:operationRef",
    "openclaw.agents.lifecycle.operations.read",
    LifecycleOperationStatusSchemaV1,
  ],
  [
    "getAgentLifecycleCapability",
    "/namespaces/:namespaceId/agents/:agentId/lifecycle/capability",
    "openclaw.agents.lifecycle.capability.read",
    LifecycleCapabilitySchemaV1,
  ],
];
const plain = (value) => JSON.parse(JSON.stringify(value));
function readCase(method) {
  const value = fixtures.readCases.find(
    (entry) => entry.method === method && entry.result.kind === "read",
  );
  assert.ok(value);
  return value;
}
function objects(value, path = []) {
  if (value === null || typeof value !== "object") return [];
  return [
    [path, value],
    ...Object.entries(value).flatMap(([key, child]) => objects(child, [...path, key])),
  ];
}
function at(value, path) {
  return path.reduce((parent, key) => parent[key], value);
}
function mutate(value, change) {
  const copy = structuredClone(value);
  change(copy);
  return copy;
}

test("exactly four GET definitions retain the existing exact Agent read target", () => {
  assert.equal(lifecycleApiRoutes.length, 4);
  assert.equal(new Set(lifecycleApiRoutes.map((route) => route.operationId)).size, 4);
  assert.equal(new Set(lifecycleApiRoutes.map((route) => route.path)).size, 4);
  for (const [operationId, path, action] of expectedRoutes) {
    const route = routes[operationId];
    assert.equal(route.method, "GET");
    assert.equal(route.path, path);
    assert.equal(route.action, action);
    assert.equal(route.iamAction, "read");
    assert.equal(route.resourceKind, "agent");
    assert.equal(route.authorizationTarget, "agent");
    assert.equal(Object.hasOwn(route.schema, "body"), false);
    assert.deepEqual(Object.keys(route.schema).sort(), ["params", "querystring", "response"]);
    assert.ok(route.summary.length > 0);
  }
});

test("success envelopes retain the exact original canonical schemas and Meta", () => {
  for (const [operationId, , , schema] of expectedRoutes) {
    const response = routes[operationId].schema.response[200];
    assert.equal(response.properties.data, schema);
    assert.equal(response.properties.meta, Meta);
    assert.equal(response.additionalProperties, false);
    assert.deepEqual(response.required.slice().sort(), ["data", "meta"]);
    assert.deepEqual(Object.keys(response.properties).sort(), ["data", "meta"]);
  }
  for (const operationId of [
    "getAgentLifecycleStatus",
    "listAgentLifecycleOperations",
    "getAgentLifecycleCapability",
  ])
    assert.equal(routes[operationId].schema.params, AgentParams);
  for (const operationId of [
    "getAgentLifecycleStatus",
    "getAgentLifecycleOperation",
    "getAgentLifecycleCapability",
  ])
    assert.equal(routes[operationId].schema.querystring, EmptyQuery);
  assert.equal(
    routes.getAgentLifecycleOperation.schema.params.properties.operationRef,
    LifecycleOperationReadRequestSchemaV1.properties.operationRef,
  );
});

test("all Agent path parameters are required closed and prefix-qualified UUIDv4 values", () => {
  for (const route of lifecycleApiRoutes) {
    const params =
      route.operationId === "getAgentLifecycleOperation" ? { ...scope, operationRef: uuid } : scope;
    assert.equal(Check(route.schema.params, params), true);
    for (const key of Object.keys(params)) {
      assert.equal(
        Check(
          route.schema.params,
          mutate(params, (v) => {
            delete v[key];
          }),
        ),
        false,
      );
      for (const bad of [null, "", 1, {}, [], "undefined", "../other-owner"])
        assert.equal(Check(route.schema.params, { ...params, [key]: bad }), false);
    }
    for (const extra of [
      { installationId: `ins_${uuid}` },
      { actorId: "caller" },
      { requestId: meta.requestId },
      { expectedLifecycleGeneration: 1 },
      { authority: true },
    ])
      assert.equal(Check(route.schema.params, { ...params, ...extra }), false);
    assert.equal(Check(route.schema.params, { ...params, namespaceId: `agt_${uuid}` }), false);
    assert.equal(Check(route.schema.params, { ...params, agentId: `ns_${uuid}` }), false);
  }
});

test("exact operation parameter reuses the original noncoercing UUIDv4 schema", () => {
  const schema = routes.getAgentLifecycleOperation.schema.params;
  for (const operationRef of [uuid, "abcdef01-abcd-4abc-9abc-abcdef012345"])
    assert.equal(Check(schema, { ...scope, operationRef }), true);
  for (const operationRef of [
    "11111111-1111-3111-8111-111111111111",
    "11111111-1111-4111-7111-111111111111",
    "ABCDEF01-ABCD-4ABC-9ABC-ABCDEF012345",
    `op_${uuid}`,
    ` ${uuid}`,
    `${uuid}\n`,
    `${uuid}/tail`,
    null,
    0,
  ])
    assert.equal(Check(schema, { ...scope, operationRef }), false);
  assert.equal(Check(schema, { ...scope, operationRef: uuid, revisionId: `rev_${uuid}` }), false);
});

test("status exact-operation and capability queries are empty without authority or cursor inputs", () => {
  for (const operationId of [
    "getAgentLifecycleStatus",
    "getAgentLifecycleOperation",
    "getAgentLifecycleCapability",
  ]) {
    const query = routes[operationId].schema.querystring;
    assert.equal(Check(query, {}), true);
    for (const input of [
      null,
      [],
      "",
      { limit: 20 },
      { afterGeneration: 1 },
      { afterGeneration: null },
      { operationRef: uuid },
      { installationId: `ins_${uuid}` },
      { actorId: "caller" },
      { includeSecrets: false },
      { expectedLifecycleGeneration: null },
    ])
      assert.equal(Check(query, input), false);
  }
});

test("operation list query accepts bounded decimal text with only HTTP default metadata", () => {
  const query = routes.listAgentLifecycleOperations.schema.querystring;
  assert.equal(query.additionalProperties, false);
  assert.deepEqual(Object.keys(query.properties).sort(), ["afterGeneration", "limit"]);
  assert.equal(query.properties.limit.default, "20");
  const empty = {};
  assert.equal(Check(query, empty), true);
  assert.deepEqual(empty, {}); // Check is a predicate, not the handler's normalizer.
  for (const limit of ["1", "20", "100"]) assert.equal(Check(query, { limit }), true);
  for (const limit of [
    null,
    0,
    20,
    -1,
    100,
    "0",
    "101",
    "01",
    "+1",
    "-1",
    "1.0",
    "1e1",
    " 1",
    "1 ",
    "1\n",
    "1\r",
    "1\t",
    "",
    Infinity,
    NaN,
    true,
    [],
    {},
  ])
    assert.equal(Check(query, { limit }), false);
  assert.equal(
    Object.hasOwn(LifecycleOperationPageRequestSchemaV1.properties.limit, "default"),
    false,
  );
  assert.equal(LifecycleOperationPageRequestSchemaV1.properties.limit.type, "integer");
});

test("operation list cursor is bounded decimal text with exact integer validation left to the handler", () => {
  const query = routes.listAgentLifecycleOperations.schema.querystring;
  for (const afterGeneration of ["1", "20", String(Number.MAX_SAFE_INTEGER)]) {
    assert.equal(Check(query, { afterGeneration }), true);
    assert.equal(Check(query, { limit: "100", afterGeneration }), true);
  }
  for (const afterGeneration of [
    null,
    0,
    1,
    -1,
    "0",
    "00",
    "01",
    "+1",
    "-1",
    "1.5",
    "1e2",
    " 1",
    "1 ",
    "1\n",
    "1\r",
    "1\t",
    "10000000000000000",
    "null",
    "",
    Infinity,
    NaN,
    [],
    {},
  ])
    assert.equal(Check(query, { afterGeneration }), false);
  assert.equal(Object.hasOwn(query.properties.afterGeneration, "default"), false);
  // A 16-digit value can exceed the safe-integer ceiling. This HTTP text check
  // does not replace the handler's original numeric request validation.
  const tooLarge = String(Number.MAX_SAFE_INTEGER + 1);
  assert.equal(Check(query, { afterGeneration: tooLarge }), true);
  assert.equal(
    Check(LifecycleOperationPageRequestSchemaV1, {
      schemaVersion: 1,
      ...scope,
      limit: 20,
      afterGeneration: Number(tooLarge),
    }),
    false,
  );
  assert.equal(
    Check(LifecycleOperationPageRequestSchemaV1, {
      schemaVersion: 1,
      ...scope,
      limit: 20,
      afterGeneration: null,
    }),
    true,
  );
  assert.equal(
    Check(LifecycleOperationPageRequestSchemaV1, {
      schemaVersion: 1,
      ...scope,
      limit: "20",
      afterGeneration: "1",
    }),
    false,
  );
  for (const extra of [
    { cursor: uuid },
    { offset: 1 },
    { page: 2 },
    { namespaceId: scope.namespaceId },
    { agentId: scope.agentId },
    { authority: true },
    { expectedLifecycleGeneration: 1 },
  ])
    assert.equal(Check(query, { limit: "20", afterGeneration: "1", ...extra }), false);
});

test("all portable canonical read values fit the corresponding HTTP data envelope", () => {
  let count = 0;
  for (const entry of fixtures.readCases) {
    if (entry.result.kind !== "read") continue;
    const route = routes[methodIds[entry.method]];
    assert.equal(
      Check(route.schema.response[200], { data: entry.result.value, meta }),
      true,
      entry.label,
    );
    assert.deepEqual(
      plain(parseLifecycleObservationResponseV1(entry.method, entry.request, entry.result.value)),
      entry.result.value,
    );
    count++;
  }
  assert.equal(count, 16);
});

test("envelopes and metadata are closed and do not accept internal read-result wrappers", () => {
  for (const [method, operationId] of Object.entries(methodIds)) {
    const data = readCase(method).result.value;
    const schema = routes[operationId].schema.response[200];
    for (const input of [
      { data },
      { meta },
      { data, meta: {} },
      { data, meta: { requestId: uuid } },
      { data, meta: { ...meta, actorId: "private" } },
      { data, meta, kind: "read" },
      { data, meta, authority: true },
      { kind: "read", value: data },
      { data, meta, requestId: meta.requestId },
    ])
      assert.equal(Check(schema, input), false);
  }
});

test("every required public value field remains required and private nested fields reject", () => {
  for (const [method, operationId] of Object.entries(methodIds)) {
    const value = { data: readCase(method).result.value, meta };
    const schema = routes[operationId].schema.response[200];
    for (const [path, node] of objects(value)) {
      if (Array.isArray(node)) continue;
      for (const key of Object.keys(node))
        assert.equal(
          Check(
            schema,
            mutate(value, (v) => {
              delete at(v, path)[key];
            }),
          ),
          false,
          `${method}:${path.join(".")}.${key}`,
        );
      for (const key of [
        "actorId",
        "auditEventId",
        "conversationId",
        "credential",
        "protectedPath",
        "backend",
        "installationId",
      ])
        assert.equal(
          Check(
            schema,
            mutate(value, (v) => {
              at(v, path)[key] = "private";
            }),
          ),
          false,
          `${method}:${path.join(".")}.${key}`,
        );
    }
  }
});

test("generation revision nullability and closed status enums use existing schemas", () => {
  const entry = fixtures.readCases.find((v) => v.label === "distinct-requested-selected-serving");
  const schema = routes.getAgentLifecycleStatus.schema.response[200];
  for (const generation of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "4", null])
    assert.equal(
      Check(schema, {
        data: mutate(entry.result.value, (v) => {
          v.head.lifecycleGeneration = generation;
        }),
        meta,
      }),
      false,
    );
  assert.equal(
    Check(schema, {
      data: mutate(entry.result.value, (v) => {
        v.head.requestedRevisionId = null;
      }),
      meta,
    }),
    false,
  );
  for (const patch of [
    { phase: "finished" },
    { reasonCode: "RAW_PROVIDER_ERROR" },
    { serving: "true" },
    { stopComplete: 1 },
    { retention: "purged" },
  ])
    assert.equal(Check(schema, { data: { ...entry.result.value, ...patch }, meta }), false);
  assert.equal(
    Check(schema, {
      data: mutate(entry.result.value, (v) => {
        v.conditions.executionTerminated.status = "absent";
      }),
      meta,
    }),
    false,
  );
});

test("page items are minimal immutable operations and never detailed revision reads", () => {
  const entry = readCase("listOperations");
  assert.ok(entry.result.value.operations.length > 0);
  const schema = routes.listAgentLifecycleOperations.schema.response[200];
  const data = entry.result.value;
  assert.equal(Check(schema, { data, meta }), true);
  assert.equal(
    Check(schema, {
      data: mutate(data, (v) => {
        v.operations[0].requestedRevisionId = `rev_${uuid}`;
      }),
      meta,
    }),
    false,
  );
  assert.equal(
    Check(schema, {
      data: { ...data, operations: Array.from({ length: 101 }, () => data.operations[0]) },
      meta,
    }),
    false,
  );
  for (const cursor of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3"])
    assert.equal(Check(schema, { data: { ...data, nextAfterGeneration: cursor }, meta }), false);
  const operation = readCase("readOperation").result.value;
  assert.equal(
    Check(routes.getAgentLifecycleOperation.schema.response[200], { data: operation, meta }),
    true,
  );
  assert.equal(
    Check(routes.getAgentLifecycleOperation.schema.response[200], {
      data: mutate(operation, (v) => {
        delete v.operation.requestedRevisionId;
      }),
      meta,
    }),
    false,
  );
});

test("minimal mutation receipts and outcomes cannot expand into any read success envelope", () => {
  assert.equal(fixtures.mutationResults.length, 4);
  for (const entry of fixtures.mutationResults) {
    const mutation = parseLifecycleAdmissionV1("mutationResult", entry.value);
    for (const route of lifecycleApiRoutes) {
      const schema = route.schema.response[200];
      assert.equal(Check(schema, { data: entry.value, meta }), false);
      if (mutation.kind === "accepted" || mutation.kind === "unchanged")
        assert.equal(Check(schema, { data: mutation.receipt, meta }), false);
    }
    if (mutation.kind === "accepted") {
      assert.equal(Object.hasOwn(mutation.receipt.operation, "requestedRevisionId"), false);
      assert.equal(
        Check(routes.getAgentLifecycleOperation.schema.response[200], {
          data: {
            operation: mutation.receipt.operation,
            observation: readCase("readOperation").result.value.observation,
          },
          meta,
        }),
        false,
      );
    }
  }
});

test("all failures reference the original bounded ErrorResponse without new error DTOs", () => {
  for (const route of lifecycleApiRoutes) {
    assert.deepEqual(
      Object.keys(route.schema.response)
        .map(Number)
        .sort((a, b) => a - b),
      [200, 400, 401, 403, 404, 409, 500, 503],
    );
    for (const status of [400, 401, 403, 404, 409, 500, 503])
      assert.equal(route.schema.response[status].$ref, ErrorResponse.$id);
  }
  const notReady = { kind: "rejected", code: "NAMESPACE_NOT_READY" };
  assert.deepEqual(plain(parseLifecycleAdmissionV1("mutationResult", notReady)), notReady);
  assert.equal(
    Check(ErrorResponse, {
      error: { code: notReady.code, message: "Namespace is not ready." },
      meta,
    }),
    true,
  );
  const hidden = { error: { code: "NOT_FOUND", message: "Resource not found." }, meta };
  assert.equal(Check(ErrorResponse, hidden), true);
  assert.equal(Check(ErrorResponse, { ...hidden, owner: "foreign" }), false);
  assert.equal(Check(ErrorResponse, { error: { ...hidden.error, exists: true }, meta }), false);
  for (const route of lifecycleApiRoutes)
    assert.equal(Check(route.schema.response[200], hidden), false);
});
