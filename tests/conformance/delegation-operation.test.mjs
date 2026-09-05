import assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateOperationUse,
  parseGrantOperationV1,
} from "../../packages/occ/src/delegation/operation-contract.ts";

const acceptedAt = "2026-09-05T12:00:00.000Z";
const dispatchBefore = "2026-09-05T12:00:05.000Z";
const operation = {
  operationRef: "a".repeat(64),
  grantRef: "grant-1",
  operation: {
    kind: "model.generate",
    providerBindingRef: "provider-1",
    modelId: "gpt-5.1",
    transportProfileRef: "codex-responses-http-v1",
  },
  requestDigest: "b".repeat(64),
  decisionRef: "decision-1",
  acceptedAt,
  dispatchBefore,
  expiresAt: "2026-09-05T12:01:00.000Z",
  dispatchedAt: null,
  status: "accepted",
  outcome: null,
};
const request = {
  phase: "dispatch",
  operationRef: operation.operationRef,
  grantRef: operation.grantRef,
  requestDigest: operation.requestDigest,
};
const now = Date.parse(acceptedAt);
const result = (value, input = request, time = now) => evaluateOperationUse(value, input, time);

test("operation references preserve the frozen 32-byte lowercase-hex reservation spelling", () => {
  const operationRef = "0123456789abcdef".repeat(4);
  assert.equal(parseGrantOperationV1({ ...operation, operationRef }).operationRef, operationRef);
  for (const invalid of [
    "",
    "x",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    "g".repeat(64),
    `${operationRef}\n`,
  ]) {
    const changed = { ...operation, operationRef: invalid };
    assert.equal(parseGrantOperationV1(changed), undefined);
    assert.equal(result(changed, { ...request, operationRef: invalid }).reason, "invalid-input");
  }
  // Syntax does not prove randomness or authorize reuse; the accepting service owns generation.
});

test("dispatch constraints bind stable reservation/digest and immutable first-dispatch window", () => {
  assert.equal(result(operation).result, "constraints-satisfied");
  for (const field of ["operationRef", "grantRef", "requestDigest"])
    assert.equal(result(operation, { ...request, [field]: "other" }).reason, "binding-mismatch");
  assert.equal(result(operation, request, now - 1).reason, "outside-dispatch-window");
  assert.equal(
    result(operation, request, Date.parse(dispatchBefore) - 1).result,
    "constraints-satisfied",
  );
  assert.equal(
    result(operation, request, Date.parse(dispatchBefore)).reason,
    "outside-dispatch-window",
  );
  for (const status of ["dispatched", "completed", "unknown"])
    assert.equal(
      result({
        ...operation,
        status,
        dispatchedAt: acceptedAt,
        outcome: { dispatched: null, completed: "ended", unknown: "unknown" }[status],
      }).reason,
      "inactive",
    );
  assert.equal(
    result({ ...operation, status: "cancelled", outcome: "not-dispatched" }).reason,
    "inactive",
  );
  assert.equal(
    result({
      ...operation,
      status: "cancelled",
      dispatchedAt: acceptedAt,
      outcome: "not-dispatched",
    }).reason,
    "inactive",
  );
  // This pure guard grants no first-consumer permission. Only a real atomic transition can do so.
  assert.equal(result(operation).result, "constraints-satisfied");
});

test("continuation admits only supplied dispatched state and never rearms or extends dispatch", () => {
  const continuation = { ...request, phase: "continue" };
  const dispatched = { ...operation, status: "dispatched", dispatchedAt: acceptedAt };
  assert.equal(result(operation, continuation).reason, "inactive");
  assert.equal(result(dispatched, continuation).result, "constraints-satisfied");
  // Existing streams can outlast the dispatch window, subject to separate fresh owner/root checks.
  assert.equal(
    result(dispatched, continuation, Date.parse(dispatchBefore) + 1).result,
    "constraints-satisfied",
  );
  assert.equal(result(dispatched, request, Date.parse(dispatchBefore) + 1).reason, "inactive");
  for (const status of ["completed", "unknown"])
    assert.equal(
      result(
        { ...dispatched, status, outcome: status === "completed" ? "ended" : "unknown" },
        continuation,
      ).reason,
      "inactive",
    );
  assert.equal(
    result({ ...operation, status: "cancelled", outcome: "not-dispatched" }, continuation).reason,
    "inactive",
  );
  assert.equal(result(dispatched, continuation, now - 1).reason, "inactive");
  assert.equal(result(dispatched, continuation, Date.parse(operation.expiresAt)).reason, "expired");
});

test("nonconsuming inspection permits a live reservation but cannot restore an expired dispatch window", () => {
  const inspection = { ...request, phase: "inspect" };
  assert.equal(result(operation, inspection).result, "constraints-satisfied");
  assert.equal(
    result(operation, inspection, Date.parse(dispatchBefore)).reason,
    "outside-dispatch-window",
  );
  const dispatched = { ...operation, status: "dispatched", dispatchedAt: acceptedAt };
  assert.equal(
    result(dispatched, inspection, Date.parse(dispatchBefore) + 1).result,
    "constraints-satisfied",
  );
  assert.equal(result(dispatched, request, Date.parse(dispatchBefore) + 1).reason, "inactive");
  assert.equal(
    result({ ...dispatched, status: "unknown", outcome: "unknown" }, inspection).reason,
    "inactive",
  );
});

test("operation parsing refuses impossible markers, malformed digests and hidden code", () => {
  const parsed = parseGrantOperationV1(operation);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.operation), true);
  for (const changed of [
    { status: "accepted", dispatchedAt: acceptedAt },
    { status: "dispatched", dispatchedAt: null },
    { status: "completed", dispatchedAt: null, outcome: "ended" },
    { status: "dispatched", dispatchedAt: dispatchBefore },
    { status: "dispatched", dispatchedAt: "2026-09-05T11:59:59.999Z" },
    { requestDigest: "B".repeat(64) },
    { dispatchBefore: acceptedAt },
    { expiresAt: acceptedAt },
    { extra: true },
    { outcome: "ended" },
    { status: "unknown", outcome: null },
    { status: "completed", dispatchedAt: acceptedAt, outcome: "success" },
  ])
    assert.equal(parseGrantOperationV1({ ...operation, ...changed }), undefined);
  let invoked = false;
  const hidden = {
    toString() {
      invoked = true;
      return "accepted";
    },
  };
  assert.equal(parseGrantOperationV1({ ...operation, status: hidden }), undefined);
  assert.equal(invoked, false);
  // The marker stays consumed even if custody proves it sent zero provider application bytes.
  assert.equal(
    parseGrantOperationV1({
      ...operation,
      status: "cancelled",
      dispatchedAt: acceptedAt,
      outcome: "not-dispatched",
    }).dispatchedAt,
    acceptedAt,
  );
  assert.equal(
    result(operation, { ...request, phase: "readback-and-retry" }).reason,
    "invalid-input",
  );
});
