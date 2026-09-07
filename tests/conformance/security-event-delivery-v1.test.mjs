import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createPostgresSecurityEventDeliveryV1,
  securityEventExpiredAtDatabaseTimeV1,
} from "../../packages/occ/src/state/postgres/security-event-delivery-v1.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";
import { serializeSecurityEvent } from "../../packages/contracts/src/security-events.ts";
import {
  createSecurityEventDeliveryV1,
  securityEventRecoveryDecisionV1,
} from "../../packages/audit/src/security-event-delivery-v1.ts";
import {
  decodeSecurityEventAppendV1,
  encodeSecurityEventAppendV1,
  decodeSecurityEventAppendResultV1,
  decodeSecurityEventLookupResultV1,
  securityEventDigestV1,
  SecurityDeliveryContractErrorV1,
  SECURITY_DELIVERY_REFUSALS_V1,
  SECURITY_DELIVERY_UNKNOWNS_V1,
} from "../../packages/audit/src/security-event-delivery-codec-v1.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/security-event-delivery-v1/cases.json", import.meta.url),
    "utf8",
  ),
);
const copy = (value) => structuredClone(value);
const uuid = (number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
function request(number = 1) {
  const event = { ...fixture.event, id: uuid(number) };
  const canonicalEventUtf8 = serializeSecurityEvent(event);
  return {
    version: 1,
    key: { installationId: event.installationId, eventId: event.id },
    producerInstanceRef: fixture.producerInstanceRef,
    producerSequence: number,
    obligationRef: fixture.obligationRef,
    canonicalEventUtf8,
    eventDigest: securityEventDigestV1(canonicalEventUtf8),
  };
}
function staged(input) {
  return {
    kind: "Staged",
    key: input.key,
    eventDigest: input.eventDigest,
    commitReceiptRef: fixture.commitReceiptRef,
  };
}
function committed(input) {
  return { ...staged(input), kind: "Committed" };
}
function rejected(frame) {
  assert.throws(
    () => decodeSecurityEventAppendV1(frame),
    (error) =>
      error instanceof SecurityDeliveryContractErrorV1 &&
      error.message === "Security event delivery record rejected." &&
      error.cause === undefined,
  );
}
const signal = () => new AbortController().signal;
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("closed append roundtrip preserves original times and immutable equality", () => {
  const input = request();
  const result = decodeSecurityEventAppendV1(encodeSecurityEventAppendV1(input));
  assert.deepEqual(result, input);
  assert.ok(Object.isFrozen(result.key));
  assert.equal(JSON.parse(result.canonicalEventUtf8).receivedAt, fixture.event.receivedAt);
});
for (const [name, change] of [
  [
    "unknown member",
    (input) => {
      input.credential = "synthetic-secret-marker";
    },
  ],
  [
    "wrong version",
    (input) => {
      input.version = 2;
    },
  ],
  [
    "unsafe sequence",
    (input) => {
      input.producerSequence = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    "zero sequence",
    (input) => {
      input.producerSequence = 0;
    },
  ],
  [
    "fractional sequence",
    (input) => {
      input.producerSequence = 1.5;
    },
  ],
  [
    "foreign event key",
    (input) => {
      input.key.eventId = uuid(99);
    },
  ],
  [
    "foreign installation key",
    (input) => {
      input.key.installationId = uuid(99);
    },
  ],
  [
    "wrong digest",
    (input) => {
      input.eventDigest = `sha256:${"0".repeat(64)}`;
    },
  ],
  [
    "invalid reference",
    (input) => {
      input.obligationRef = "untrusted-label";
    },
  ],
  [
    "noncanonical event",
    (input) => {
      input.canonicalEventUtf8 += " ";
      input.eventDigest = securityEventDigestV1(input.canonicalEventUtf8);
    },
  ],
  [
    "unknown event member",
    (input) => {
      const event = JSON.parse(input.canonicalEventUtf8);
      event.payload = "synthetic-secret-marker";
      input.canonicalEventUtf8 = JSON.stringify(event);
      input.eventDigest = securityEventDigestV1(input.canonicalEventUtf8);
    },
  ],
])
  test(`append rejects ${name}`, () => {
    const input = request();
    change(input);
    rejected(JSON.stringify(input));
  });

test("duplicate and escaped duplicate members are rejected before parsing", () => {
  const frame = JSON.stringify(request());
  rejected(frame.replace('"version":1', '"version":1,"version":1'));
  rejected(frame.replace('"version":1', '"version":1,"\\u0076ersion":1'));
  rejected(frame.replace('"eventId":', '"eventId":"' + uuid(99) + '","eventId":'));
  const input = request();
  input.canonicalEventUtf8 = input.canonicalEventUtf8.replace(
    '"schemaVersion":1',
    '"schemaVersion":1,"schemaVersion":1',
  );
  input.eventDigest = securityEventDigestV1(input.canonicalEventUtf8);
  rejected(JSON.stringify(input));
});
test("UTF-8 frame bounds and malformed/deep JSON fail with fixed errors", () => {
  rejected(" ".repeat(16385));
  rejected('"' + "界".repeat(6000) + '"');
  rejected('{"value":' + "[".repeat(20) + "0" + "]".repeat(20) + "}");
  for (const text of ["", "null", "[]", '{"a":}', '{"a":1,}', '{"a":"\\x"}']) rejected(text);
});
test("all closed response codes decode and unknown or widened results fail", () => {
  const input = request();
  assert.deepEqual(
    decodeSecurityEventAppendResultV1(JSON.stringify(committed(input))),
    committed(input),
  );
  for (const code of SECURITY_DELIVERY_REFUSALS_V1)
    assert.equal(
      decodeSecurityEventAppendResultV1(
        JSON.stringify({ kind: "RefusedBeforeCommit", key: input.key, code }),
      ).code,
      code,
    );
  for (const code of SECURITY_DELIVERY_UNKNOWNS_V1) {
    assert.equal(
      decodeSecurityEventAppendResultV1(
        JSON.stringify({ kind: "CommitUnknown", key: input.key, code }),
      ).code,
      code,
    );
    assert.equal(
      decodeSecurityEventLookupResultV1(JSON.stringify({ kind: "Unknown", key: input.key, code }))
        .code,
      code,
    );
  }
  assert.equal(
    decodeSecurityEventLookupResultV1(
      JSON.stringify({ kind: "AbsentFenced", key: input.key, fencedAttemptRef: uuid(110) }),
    ).kind,
    "AbsentFenced",
  );
  assert.throws(() => decodeSecurityEventAppendResultV1(JSON.stringify(staged(input))));
  assert.throws(() =>
    decodeSecurityEventLookupResultV1(JSON.stringify({ kind: "Absent", key: input.key })),
  );
  assert.throws(() =>
    decodeSecurityEventAppendResultV1(
      JSON.stringify({ ...committed(input), rawError: "synthetic-secret-marker" }),
    ),
  );
});

// These exercise the actual adapter's promise, admission and decision behavior.
// Controlled transaction boundaries provide no PostgreSQL or authentication proof.
test("receipt remains pending until the owner boundary settles", async () => {
  let finish;
  let entered = false;
  const adapter = createSecurityEventDeliveryV1({
    transact: async (input) => {
      entered = true;
      await new Promise((resolve) => {
        finish = resolve;
      });
      return staged(input);
    },
    read: async (input) => committed(input),
  });
  let settled = false;
  const result = adapter
    .append(encodeSecurityEventAppendV1(request()), uuid(44), signal())
    .then((value) => {
      settled = true;
      return value;
    });
  await tick();
  assert.ok(entered);
  assert.equal(settled, false);
  assert.equal(adapter.health().active, 1);
  finish();
  assert.equal((await result).kind, "Committed");
  assert.equal(adapter.health().active, 0);
});
test("uncertain or malformed owner completion never becomes success or definite refusal", async () => {
  for (const transact of [
    async () => {
      throw new Error("synthetic-secret-marker");
    },
    async (input) => ({ ...staged(input), eventDigest: "sha256:" + "0".repeat(64) }),
    async (input) => ({ ...staged(input), kind: "Committed" }),
  ]) {
    const adapter = createSecurityEventDeliveryV1({
      transact,
      read: async (input) => committed(input),
    });
    const result = await adapter.append(encodeSecurityEventAppendV1(request()), uuid(44), signal());
    assert.equal(result.kind, "CommitUnknown");
    assert.equal(JSON.stringify(result).includes("synthetic-secret-marker"), false);
  }
});
test("cancellation reports unknown and retains occupied work until it settles", async () => {
  let finish;
  let ownerSignal;
  const adapter = createSecurityEventDeliveryV1({
    transact: async (input, currentSignal) => {
      ownerSignal = currentSignal;
      await new Promise((resolve) => {
        finish = resolve;
      });
      return staged(input);
    },
    read: async (input) => committed(input),
  });
  const abort = new AbortController();
  const frame = encodeSecurityEventAppendV1(request());
  const result = adapter.append(frame, uuid(44), abort.signal);
  abort.abort();
  assert.equal((await result).kind, "CommitUnknown");
  assert.ok(ownerSignal.aborted);
  assert.equal(adapter.health().active, 1);
  assert.equal((await adapter.append(frame, uuid(44), signal())).kind, "CommitUnknown");
  finish();
  await tick();
  assert.equal(adapter.health().active, 0);
  assert.equal(adapter.health().outcomes.committed, 0);
});
test("two-second deadline is unknown, not evidence the original work stopped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  const adapter = createSecurityEventDeliveryV1({
    transact: async (input) => {
      await new Promise((resolve) => {
        finish = resolve;
      });
      return staged(input);
    },
    read: async (input) => committed(input),
  });
  const pending = adapter.append(encodeSecurityEventAppendV1(request()), uuid(44), signal());
  t.mock.timers.tick(2000);
  const result = await pending;
  assert.equal(result.kind, "CommitUnknown");
  assert.equal(result.code, "Deadline");
  assert.equal(adapter.health().active, 1);
  finish();
  await tick();
  assert.equal(adapter.health().active, 0);
});
test("per-owner and global capacity refuse without queuing additional operations", async () => {
  const releases = [];
  let calls = 0;
  const adapter = createSecurityEventDeliveryV1({
    transact: async (input) => {
      calls++;
      await new Promise((resolve) => releases.push(resolve));
      return staged(input);
    },
    read: async (input) => committed(input),
  });
  const pending = Array.from({ length: 64 }, (_, index) =>
    adapter.append(
      encodeSecurityEventAppendV1(request(index + 1)),
      uuid(200 + Math.floor(index / 8)),
      signal(),
    ),
  );
  assert.equal(calls, 64);
  assert.equal(adapter.health().active, 64);
  assert.equal(
    (await adapter.append(encodeSecurityEventAppendV1(request(100)), uuid(200), signal())).code,
    "Capacity",
  );
  assert.equal(
    (await adapter.append(encodeSecurityEventAppendV1(request(101)), uuid(999), signal())).code,
    "Capacity",
  );
  for (const release of releases) release();
  await Promise.all(pending);
  assert.equal(adapter.health().encodedBytes, 0);
});
test("readback preserves unknown and rejects foreign receipt binding", async () => {
  const adapter = createSecurityEventDeliveryV1({
    transact: async (input) => staged(input),
    read: async (input) => ({ ...committed(input), key: { ...input.key, eventId: uuid(99) } }),
  });
  assert.equal(
    (await adapter.lookup(encodeSecurityEventAppendV1(request()), uuid(44), signal())).kind,
    "Unknown",
  );
});
test("recovery never turns ordinary absence/unknown into a new append or effect", () => {
  const input = request();
  const unknown = { kind: "Unknown", key: input.key, code: "StorageUnknown" };
  for (let round = 0; round < 5; round++)
    assert.equal(securityEventRecoveryDecisionV1(round, unknown).action, "ReserveExactReadback");
  assert.deepEqual(securityEventRecoveryDecisionV1(5, unknown), { action: "RetainForRepair" });
  assert.equal(
    securityEventRecoveryDecisionV1(1, {
      kind: "AbsentFenced",
      key: input.key,
      fencedAttemptRef: uuid(5),
    }).action,
    "ReserveIdenticalAttempt",
  );
  assert.equal(securityEventRecoveryDecisionV1(5, committed(input)).action, "RecordTransfer");
  assert.throws(() => securityEventRecoveryDecisionV1(6, unknown));
});

test("the ninth local owner operation is refused while global capacity remains", async () => {
  const releases = [];
  const adapter = createSecurityEventDeliveryV1({
    transact: async (input) => {
      await new Promise((resolve) => releases.push(resolve));
      return staged(input);
    },
    read: async (input) => committed(input),
  });
  const pending = Array.from({ length: 8 }, (_, i) =>
    adapter.append(encodeSecurityEventAppendV1(request(i + 1)), uuid(900), signal()),
  );
  assert.equal(adapter.health().active, 8);
  assert.equal(
    (await adapter.append(encodeSecurityEventAppendV1(request(20)), uuid(900), signal())).code,
    "Capacity",
  );
  releases.forEach((resolve) => resolve());
  await Promise.all(pending);
});

test("storage constructor snapshots scope and rejects mismatches without touching SQL", async () => {
  const lifetime = new RepositoryTransactionLifetime();
  const securityScope = { installationId: uuid(901), namespaceId: fixture.event.namespaceId };
  let queried = false;
  const repository = createPostgresSecurityEventDeliveryV1({
    scope: { installationId: "actual-occ-installation", namespaceId: "actual-occ-namespace" },
    securityScope,
    transaction: lifetime,
    query: {
      query: async () => {
        queried = true;
        throw new Error("No database is provided by this scope-rejection test.");
      },
    },
  });
  securityScope.installationId = fixture.event.installationId;
  const result = await repository.stage({
    event: fixture.event,
    producerInstanceRef: fixture.producerInstanceRef,
    producerSequence: 1,
    obligationRef: fixture.obligationRef,
    origin: {
      auditEventId: "aud_legacy-record",
      originalOperationRef: fixture.originalOperationRef,
    },
  });
  assert.equal(result.code, "WrongProducerScope");
  assert.equal(queried, false);
  lifetime.close();
  assert.throws(() =>
    createPostgresSecurityEventDeliveryV1({
      scope: {},
      securityScope,
      transaction: lifetime,
      query: {
        query: async () => {
          throw new Error("Unreachable");
        },
      },
    }),
  );
});

test("all canonical UUID versions survive delivery without replacement", async () => {
  for (let version = 1; version <= 8; version++) {
    const identity = uuid(400 + version).replace("-4000-", `-${version}000-`);
    const input = request();
    const event = {
      ...fixture.event,
      id: identity,
      installationId: identity,
      namespaceId: identity,
      resource: { ...fixture.event.resource, namespaceId: identity },
    };
    input.key = { installationId: identity, eventId: identity };
    input.canonicalEventUtf8 = serializeSecurityEvent(event);
    input.eventDigest = securityEventDigestV1(input.canonicalEventUtf8);
    input.producerInstanceRef = identity;
    input.obligationRef = identity;
    const frame = encodeSecurityEventAppendV1(input);
    assert.deepEqual(decodeSecurityEventAppendV1(frame), input);
    const adapter = createSecurityEventDeliveryV1({
      transact: async (request) => ({ ...staged(request), commitReceiptRef: identity }),
      read: async (request) => ({ ...committed(request), commitReceiptRef: identity }),
    });
    assert.deepEqual((await adapter.append(frame, identity, signal())).key, input.key);
    assert.equal((await adapter.lookup(frame, identity, signal())).commitReceiptRef, identity);
    assert.equal(
      decodeSecurityEventLookupResultV1(
        JSON.stringify({ kind: "AbsentFenced", key: input.key, fencedAttemptRef: identity }),
      ).fencedAttemptRef,
      identity,
    );
  }
  const input = request();
  for (const version of [0, 9]) {
    input.obligationRef = uuid(8).replace("-4000-", `-${version}000-`);
    rejected(JSON.stringify(input));
  }
});

test("database expiry preserves the exact millisecond boundary and immutable receipt time", () => {
  const event = { ...fixture.event, receivedAt: "2026-01-01T00:00:01.789Z" };
  const expires = Date.parse(event.receivedAt) + 30 * 86400000;
  assert.equal(securityEventExpiredAtDatabaseTimeV1(event, new Date(expires - 1)), false);
  assert.equal(securityEventExpiredAtDatabaseTimeV1(event, new Date(expires)), true);
  assert.equal(securityEventExpiredAtDatabaseTimeV1(event, new Date(expires + 1)), true);
  assert.equal(event.receivedAt, "2026-01-01T00:00:01.789Z");
  for (const invalid of [undefined, null, new Date(NaN), "2026-01-31T00:00:01.789Z"])
    assert.throws(() => securityEventExpiredAtDatabaseTimeV1(event, invalid), {
      message: "Security event storage is unavailable.",
    });
});
