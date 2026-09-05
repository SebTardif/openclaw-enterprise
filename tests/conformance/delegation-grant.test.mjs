import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRootGrantV1 } from "../../packages/occ/src/delegation/grant-contract.ts";
import { evaluateRootGrantConstraints } from "../../packages/occ/src/delegation/evaluate-grant.ts";
import { matchesCredentialBinding } from "../../packages/occ/src/delegation/credential-binding.ts";

const now = Date.parse("2026-01-01T00:00:30.000Z");
const operation = (providerBindingRef = "provider-a", modelId = "model-a") => ({
  kind: "model.generate",
  providerBindingRef,
  modelId,
  transportProfileRef: "codex-responses-http-v1",
});
function fixture() {
  const operations = [operation(), operation("provider-b", "model-b")];
  const grant = {
    schemaVersion: 1,
    grantRef: "grant-a",
    mediationContextRef: "context-a",
    holder: {
      installationId: "installation-a",
      namespaceId: "namespace-a",
      agentId: "agent-a",
      agentRevisionId: "revision-a",
      servicePrincipalId: "service-a",
      assignmentRef: { schemaVersion: 1, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      component: "harness",
      lifecycleGeneration: 1,
      runtimeGeneration: 1,
      providerProfileRef: "provider/v1",
      runtimeProfileRef: "runtime/v1",
      identityProfileRef: "identity/v1",
    },
    turn: {
      principalId: "principal-a",
      conversationRef: "conversation-a",
      turnRef: "turn-a",
      attemptRef: "attempt-a",
      commonGrantRef: "common-a",
    },
    audienceRef: "mediator-a",
    operations,
    issuedAt: "2026-01-01T00:00:00.000Z",
    notBefore: "2026-01-01T00:00:10.000Z",
    expiresAt: "2026-01-01T00:01:00.000Z",
    maxRequests: 3,
    maxConcurrentRequests: 2,
    status: "active",
  };
  return {
    grant,
    request: {
      holder: structuredClone(grant.holder),
      turn: structuredClone(grant.turn),
      audienceRef: grant.audienceRef,
      mediationContextRef: grant.mediationContextRef,
      operation: operation(),
    },
    current: {
      actorOperations: operations,
      commonOperations: operations,
      agentOperations: operations,
      operatorOperations: operations,
      operatorPolicyVersion: 1,
      usedRequests: 0,
      activeRequests: 0,
    },
  };
}
const evaluate = ({ grant, request, current }, time = now) =>
  evaluateRootGrantConstraints(grant, request, current, time);
const denied = (input, reason) => assert.deepEqual(evaluate(input), { result: "denied", reason });

test("fixed custody metadata must match the exact server-selected provider/account/profile binding", () => {
  const { grant, request } = fixture();
  const binding = {
    providerBindingRef: request.operation.providerBindingRef,
    serviceAccountId: "account-1",
    credentialProfileRef: "credential-profile-1",
    providerProfileRef: grant.holder.providerProfileRef,
    audienceRef: grant.audienceRef,
    transportProfileRef: "codex-responses-http-v1",
    upstreamOrigin: "https://api.openai.com",
  };
  assert.equal(matchesCredentialBinding(grant, request.operation, binding, binding), true);
  for (const field of Object.keys(binding))
    assert.equal(
      matchesCredentialBinding(grant, request.operation, binding, { ...binding, [field]: "other" }),
      false,
    );
  const other = { ...binding, providerBindingRef: "provider-b" };
  assert.equal(matchesCredentialBinding(grant, request.operation, other, other), false);
  assert.equal(
    matchesCredentialBinding(grant, operation("ungranted", "model-a"), binding, binding),
    false,
  );
  assert.equal(
    matchesCredentialBinding(grant, request.operation, binding, {
      ...binding,
      apiKey: "forbidden",
    }),
    false,
  );
  // Equality of supplied metadata establishes no custody or authorization; no secret is loaded here.
});

test("root constraints intersect paired provider/model grants without constructing a cross product", () => {
  const input = fixture();
  assert.deepEqual(evaluate(input), {
    result: "constraints-satisfied",
    grantRef: "grant-a",
    operatorPolicyVersion: 1,
  });
  input.request.operation = operation("provider-b", "model-b");
  assert.equal(evaluate(input).result, "constraints-satisfied");
  for (const pair of [
    ["provider-a", "model-b"],
    ["provider-b", "model-a"],
    ["Provider-a", "model-a"],
  ]) {
    input.request.operation = operation(...pair);
    denied(input, "operation-denied");
  }
});

test("each current ceiling independently narrows authority; later broadening cannot extend a stored grant", () => {
  for (const field of [
    "actorOperations",
    "commonOperations",
    "agentOperations",
    "operatorOperations",
  ]) {
    const input = fixture();
    input.current[field] = [];
    denied(input, "operation-denied");
    delete input.current[field];
    denied(input, "invalid-input");
  }
  const input = fixture();
  const broader = operation("provider-c", "model-c");
  for (const field of [
    "actorOperations",
    "commonOperations",
    "agentOperations",
    "operatorOperations",
  ])
    input.current[field] = [...input.current[field], broader];
  input.request.operation = broader;
  denied(input, "operation-denied");
});

test("exact holder, turn and accepting audience cannot be selected by a different request", () => {
  for (const section of ["holder", "turn"]) {
    for (const field of Object.keys(fixture().request[section])) {
      const input = fixture();
      const original = input.request[section][field];
      if (field === "assignmentRef")
        input.request[section][field] = {
          schemaVersion: 1,
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        };
      else if (field === "component") continue;
      else
        input.request[section][field] =
          typeof original === "number" ? original + 1 : `${original}-other`;
      denied(input, "binding-mismatch");
    }
  }
  for (const field of ["audienceRef", "mediationContextRef"]) {
    const input = fixture();
    input.request[field] += "-other";
    denied(input, "binding-mismatch");
  }
});

test("validity boundaries, terminal status and finite shared counters refuse use", () => {
  const input = fixture();
  assert.equal(evaluate(input, Date.parse(input.grant.notBefore)).result, "constraints-satisfied");
  for (const time of [Date.parse(input.grant.notBefore) - 1, Date.parse(input.grant.expiresAt)])
    assert.deepEqual(evaluate(input, time), { result: "denied", reason: "outside-validity" });
  for (const time of [NaN, Infinity, -1, 1.5])
    assert.deepEqual(evaluate(input, time), { result: "denied", reason: "invalid-input" });
  for (const status of ["revoked", "closed"]) {
    input.grant.status = status;
    denied(input, "inactive");
  }
  input.grant.status = "active";
  input.current.usedRequests = 3;
  denied(input, "budget-exhausted");
  input.current.usedRequests = 2;
  input.current.activeRequests = 2;
  denied(input, "budget-exhausted");
  input.current.activeRequests = 3;
  denied(input, "invalid-input");
});

test("root-only parsing refuses unsupported authority fields and invalid representations", () => {
  for (const change of [
    { parentRef: "parent" },
    { delegable: true },
    { schemaVersion: 2 },
    { operations: [] },
    { maxRequests: Infinity },
    { maxConcurrentRequests: 4 },
    { issuedAt: "2026-02-30T00:00:00.000Z" },
    { expiresAt: "2026-01-01T00:00:10.000Z" },
    { expiresAt: "2026-01-01T01:00:00+01:00" },
    { status: "pending" },
  ])
    assert.equal(parseRootGrantV1({ ...fixture().grant, ...change }), undefined);
  for (const suffix of ["\n", "\r", "\u2028", "\u2029", " "])
    assert.equal(
      parseRootGrantV1({ ...fixture().grant, mediationContextRef: `context${suffix}` }),
      undefined,
    );
  const input = fixture();
  input.grant.operations.push(input.grant.operations[0]);
  assert.equal(parseRootGrantV1(input.grant), undefined);
});

test("validation snapshots immutable data without invoking caller getters or proxy traps", () => {
  const input = fixture();
  const parsed = parseRootGrantV1(input.grant);
  input.grant.operations[0].modelId = "changed";
  input.grant.holder.assignmentRef.id = "changed";
  assert.equal(parsed.operations[0].modelId, "model-a");
  assert.equal(parsed.holder.assignmentRef.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.throws(() => {
    parsed.turn.principalId = "changed";
  }, TypeError);
  let accessed = false;
  const hostile = fixture().grant;
  Object.defineProperty(hostile, "operations", {
    enumerable: true,
    get() {
      accessed = true;
      throw new Error();
    },
  });
  assert.equal(parseRootGrantV1(hostile), undefined);
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        accessed = true;
        throw new Error();
      },
    },
  );
  assert.equal(parseRootGrantV1(proxy), undefined);
  assert.equal(accessed, false);
});
