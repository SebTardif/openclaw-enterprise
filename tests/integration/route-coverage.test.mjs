import assert from "node:assert/strict";
import test from "node:test";

import { createFastifyApp } from "../../apps/controller/src/index.ts";
import { occApiRoutes } from "../../packages/contracts/src/api/routes.ts";
import { workloadProfileApiRoutes } from "../../packages/contracts/src/api/workload-profile/routes.ts";
import {
  createOperationRegistry,
  ordinaryOperations,
  requiredPermissions,
} from "../../apps/controller/src/http/operation-registry.ts";
import { createHttpTransport } from "../../apps/controller/src/http/transport.ts";
import { registerProtectedOperations } from "../../apps/controller/src/http/register.ts";

const documentationOptions = {
  development: {
    enabled: true,
    installationId: "ins_6054d30d-0f89-4cd0-aa56-2b76e3c5fb52",
  },
};

const separateProfiles = [
  ...workloadProfileApiRoutes,
  { method: "POST", path: "/api/auth/service-keys", operationId: "createServiceKey" },
  { method: "DELETE", path: "/api/auth/service-keys/:keyId", operationId: "revokeServiceKey" },
  { method: "POST", path: "/api/auth/sign-in/email", operationId: "signInEmail" },
  { method: "POST", path: "/api/auth/sign-out", operationId: "signOut" },
  { method: "GET", path: "/api/auth/session", operationId: "getAuthSession" },
  { method: "POST", path: "/api/auth/accounts", operationId: "createAuthAccount" },
  {
    method: "POST",
    path: "/v1/runtime-service-trust/operations",
    operationId: "mutateRuntimeServiceTrust",
  },
  {
    method: "GET",
    path: "/v1/runtime-service-trust/operations/:operationRef",
    operationId: "recoverRuntimeServiceTrust",
  },
];

function documentedPath(path) {
  return path.replace(/:([^/]+)/g, "{$1}");
}

test("actual Fastify registrations cover every catalog operation, schema, permission and OpenAPI entry", async (t) => {
  // This is the actual application used by the OpenAPI generator. No request is
  // authenticated here; real admission execution belongs to http-admission.
  const app = createFastifyApp(documentationOptions);
  t.after(() => app.close());
  const registered = [];
  app.addHook("onRoute", (route) => registered.push(route));
  await app.ready();
  const document = app.swagger();
  const catalogIds = new Set(occApiRoutes.map(({ operationId }) => operationId));
  for (const route of registered) {
    if (route.method === "HEAD") continue;
    const declared = [...occApiRoutes, ...separateProfiles].find(
      (operation) => operation.method === route.method && operation.path === route.url,
    );
    assert.ok(declared, `Unclassified registered route ${route.method} ${route.url}`);
    assert.equal(route.schema?.operationId, declared.operationId);
  }
  const documentedIds = Object.values(document.paths).flatMap((path) =>
    Object.values(path).map((operation) => operation.operationId),
  );
  assert.deepEqual(
    documentedIds.sort(),
    [...occApiRoutes, ...separateProfiles].map(({ operationId }) => operationId).sort(),
  );

  // Compare the complete real Fastify route tree, including synchronous static
  // routes that were installed before this observer. Reference handlers never
  // execute; this comparison verifies registration inventory, not their behavior.
  const expected = createHttpTransport({ bodyLimit: 64 * 1024, developmentEnabled: true });
  t.after(() => expected.close());
  for (const url of ["/console", "/console/*"]) {
    expected.route({ method: ["GET", "HEAD"], url, handler: async () => {} });
  }
  // Keep Fastify's insertion order after each observed route has been checked
  // against the exact catalog and explicit special profiles above.
  for (const { method, url } of registered.filter((route) => route.method !== "HEAD")) {
    expected.route({ method, url, handler: async () => {} });
  }
  await expected.ready();
  for (const method of app.supportedMethods) {
    assert.equal(
      app.printRoutes({ commonPrefix: false, method }),
      expected.printRoutes({ commonPrefix: false, method }),
      `Complete ${method} registration inventory`,
    );
  }
  const actual = registered.filter(
    (route) => route.method !== "HEAD" && catalogIds.has(route.schema?.operationId),
  );
  assert.ok(Object.isFrozen(ordinaryOperations));
  assert.equal(actual.length, occApiRoutes.length);
  assert.equal(new Set(actual.map(({ schema }) => schema.operationId)).size, occApiRoutes.length);

  for (const operation of occApiRoutes) {
    const route = actual.find(({ schema }) => schema.operationId === operation.operationId);
    assert.equal(route.url, operation.path);
    assert.equal(route.method, operation.method);
    assert.equal(typeof route.handler, "function");
    assert.equal(typeof route.onRequest, "function");
    assert.equal(typeof route.preValidation, "function");
    assert.equal(typeof route.preHandler, "function");
    for (const [part, schema] of Object.entries(operation.schema)) {
      assert.deepEqual(route.schema[part], schema, `${operation.operationId} ${part}`);
    }
    assert.deepEqual(route.schema["x-openclaw-permissions"], requiredPermissions(operation));
    const documented =
      document.paths[documentedPath(operation.path)][operation.method.toLowerCase()];
    assert.equal(documented.operationId, operation.operationId);
    assert.equal(documented.summary, operation.summary);
    assert.deepEqual(documented["x-openclaw-permissions"], route.schema["x-openclaw-permissions"]);
    assert.deepEqual(
      Object.keys(documented.responses).sort(),
      Object.keys(operation.schema.response).sort(),
    );
    if (operation.operationId === "bootstrapInstallation") {
      assert.deepEqual(documented.security, [{ sessionCookie: [] }]);
    }
  }
  assert.deepEqual(document.security, [{ sessionCookie: [] }, { serviceApiKey: [] }]);
  assert.deepEqual(document.paths["/api/auth/accounts"].post.security, [{ sessionCookie: [] }]);

  // Workload-profile reads retain the operator's administer requirement as well
  // as read authority. Check actual registration output, not a second mapper.
  for (const operation of workloadProfileApiRoutes) {
    const documented =
      document.paths[documentedPath(operation.path)][operation.method.toLowerCase()];
    assert.deepEqual(
      documented["x-openclaw-permissions"],
      [
        { action: "administer", resourceKind: "installation", scope: "requested" },
        ...(operation.method === "GET"
          ? [{ action: "read", resourceKind: "installation", scope: "requested" }]
          : []),
      ],
      operation.operationId,
    );
    assert.deepEqual(documented.security, [{ sessionCookie: [] }]);
  }
});

test("protected registration rejects missing handlers and infrastructure before adding routes", async (t) => {
  const app = createFastifyApp(documentationOptions);
  t.after(() => app.close());
  // Handler bodies never execute: these cases exercise the production registry's
  // composition checks, including omissions that JavaScript callers can express.
  const handler = async () => {};
  const handlers = Object.fromEntries(
    ordinaryOperations.map(({ operationId }) => [operationId, handler]),
  );
  const infrastructure = { admit: handler, resolveIdentity: handler };
  for (const operation of ordinaryOperations) {
    const partial = { ...handlers };
    delete partial[operation.operationId];
    assert.throws(
      () => registerProtectedOperations(app, partial, infrastructure),
      /Missing HTTP handler/,
    );
  }
  assert.throws(
    () => registerProtectedOperations(app, handlers, { resolveIdentity: handler }),
    /requires admission/,
  );
  assert.throws(
    () => registerProtectedOperations(app, handlers, { admit: handler }),
    /requires admission/,
  );
  assert.throws(
    () =>
      registerProtectedOperations(
        app,
        { ...handlers, unsupportedOperation: handler },
        infrastructure,
      ),
    /match the operation catalog exactly/,
  );
});

test("registry rejects duplicate operations and missing schema or permission coverage", () => {
  const operation = ordinaryOperations[0];
  const handler = async () => {};
  const handlers = { [operation.operationId]: handler };
  assert.throws(() => createOperationRegistry([operation, operation], handlers), /must be unique/);
  for (const field of ["iamAction", "resourceKind", "action", "summary"]) {
    assert.throws(
      () => createOperationRegistry([{ ...operation, [field]: undefined }], handlers),
      /permission or documentation metadata/,
    );
  }
  for (const field of ["querystring", "response"]) {
    const schema = { ...operation.schema };
    delete schema[field];
    assert.throws(
      () => createOperationRegistry([{ ...operation, schema }], handlers),
      /request or response schema/,
    );
  }
  const parameterized = ordinaryOperations.find((candidate) => candidate.path.includes(":"));
  const { params: _params, ...missingParams } = parameterized.schema;
  assert.throws(
    () =>
      createOperationRegistry([{ ...parameterized, schema: missingParams }], {
        [parameterized.operationId]: handler,
      }),
    /request or response schema/,
  );
  const acceptingBody = ordinaryOperations.find((candidate) =>
    Object.hasOwn(candidate.schema, "body"),
  );
  const { body: _body, ...missingBody } = acceptingBody.schema;
  assert.throws(
    () =>
      createOperationRegistry([{ ...acceptingBody, schema: missingBody }], {
        [acceptingBody.operationId]: handler,
      }),
    /request or response schema/,
  );
  const optionalParams = {
    ...parameterized.schema,
    params: { ...parameterized.schema.params, required: [] },
  };
  assert.throws(
    () =>
      createOperationRegistry([{ ...parameterized, schema: optionalParams }], {
        [parameterized.operationId]: handler,
      }),
    /request or response schema/,
  );
  const missingSuccess = { ...operation.schema, response: { 400: operation.schema.response[400] } };
  assert.throws(
    () => createOperationRegistry([{ ...operation, schema: missingSuccess }], handlers),
    /request or response schema/,
  );
});
