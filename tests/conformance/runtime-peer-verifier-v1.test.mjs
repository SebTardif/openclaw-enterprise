import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeWorkloadVerifierV1,
  getRuntimeWorkloadVerifierSettlementV1,
  getRuntimeWorkloadVerifierRegistrationV1,
} from "../../packages/occ/src/runtime-identity/peer-verifier-v1.ts";
import {
  callFixture,
  expectationFixture,
  registrationFixture,
} from "../fixtures/runtime-identity-peer/fixture.mjs";

function setup() {
  let time = Date.parse("2026-09-07T00:00:00.000Z"),
    mono = 100;
  const connection = Object.freeze({}),
    incarnation = Object.freeze({});
  const observation = registrationFixture(time),
    expected = expectationFixture(observation);
  const calls = [];
  let nativeHook = () => {},
    registrationHook = () => {};
  const nativeObservation = {
    connection,
    incarnation,
    connectionRef: "fixture/connection",
    peerSPIFFEId: observation.spiffeId,
    recipientRef: expected.recipientRef,
    identityProfileRef: expected.identityProfileRef,
    bundleSetVersion: 1,
    peerEvidenceRef: "fixture/native-evidence",
    authenticatedAt: new Date(time - 10).toISOString(),
    expiresAt: new Date(time + 5000).toISOString(),
  };
  const native = {
    async inspect(actual, call) {
      calls.push("native");
      assert.equal(actual, connection);
      await nativeHook(call);
      return {
        kind: "inspected",
        observation: { ...nativeObservation, inspectedAt: new Date(time).toISOString() },
      };
    },
  };
  const registration = {
    async resolve(actual, actualExpected, call) {
      calls.push("registration");
      assert.equal(actual, connection);
      assert.deepEqual(actualExpected.target, expected.target);
      await registrationHook(call);
      return { kind: "observed", observation: structuredClone(observation) };
    },
  };
  const verifier = createRuntimeWorkloadVerifierV1({
    native,
    registration,
    clock: { now: () => time, monotonicNow: () => mono },
  });
  return {
    connection,
    observation,
    nativeObservation,
    expected,
    calls,
    native,
    registration,
    verifier,
    call: (overrides = {}) => callFixture(time, overrides),
    advance: (ms) => {
      time += ms;
      mono += ms;
    },
    advanceMono: (ms) => {
      mono += ms;
    },
    nativeHook: (hook) => {
      nativeHook = hook;
    },
    registrationHook: (hook) => {
      registrationHook = hook;
    },
    fresh: () => {
      observation.observedAt = new Date(time).toISOString();
      observation.validUntil = new Date(time + 1000).toISOString();
    },
  };
}
async function verified(f) {
  const result = await f.verifier.verify(f.connection, f.expected, f.call());
  assert.equal(result.kind, "verified", JSON.stringify(result));
  return result.proof;
}
function denied(result, reason) {
  assert.notEqual(result.kind, "verified");
  if (reason) assert.equal(result.reasonCode, reason);
}
const defer = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("actual verifier brackets registration with fresh native calls and preserves original immutable proof", async () => {
  const f = setup(),
    proof = await verified(f);
  assert.deepEqual(f.calls, ["native", "registration", "native"]);
  assert.equal(proof.verifiedAt, f.nativeObservation.authenticatedAt);
  assert.equal(proof.expiresAt, f.observation.validUntil);
  assert.ok(
    Object.isFrozen(proof) &&
      Object.isFrozen(proof.assignmentRef) &&
      Object.isFrozen(proof.transportBinding),
  );
  const registration = getRuntimeWorkloadVerifierRegistrationV1(f.verifier, proof);
  assert.ok(Object.isFrozen(registration) && Object.isFrozen(registration.assignment.binding));
  assert.deepEqual(JSON.parse(JSON.stringify(registration)), f.observation);
  assert.equal(getRuntimeWorkloadVerifierRegistrationV1(f.verifier, { ...proof }), undefined);
  const original = JSON.stringify(proof);
  f.advance(25);
  f.fresh();
  const result = await f.verifier.inspect(proof, f.call());
  assert.equal(result.kind, "verified");
  assert.equal(result.proof, proof);
  assert.equal(JSON.stringify(proof), original);
  const another = await verified(f);
  assert.equal(another.transportBinding, proof.transportBinding);
});

test("diagnostic/copy/prototype/foreign proof replays cannot mint or inspect proof", async () => {
  const f = setup(),
    proof = await verified(f),
    other = setup();
  for (const replay of [
    { ...proof },
    JSON.parse(JSON.stringify(proof)),
    Object.create(proof),
    {},
    null,
  ]) {
    denied(await f.verifier.inspect(replay, f.call()), "binding-mismatch");
  }
  denied(await other.verifier.inspect(proof, other.call()), "binding-mismatch");
  denied(await f.verifier.verify({}, f.expected, f.call()));
});

for (const [label, mutate, code] of [
  [
    "peer",
    (f) => {
      f.nativeObservation.peerSPIFFEId += "/foreign";
    },
    "peer-mismatch",
  ],
  [
    "recipient",
    (f) => {
      f.nativeObservation.recipientRef = "recipient/foreign";
    },
    "peer-mismatch",
  ],
  [
    "connection",
    (f) => {
      f.nativeObservation.connection = {};
    },
    "binding-mismatch",
  ],
  [
    "profile",
    (f) => {
      f.nativeObservation.identityProfileRef = "profile/foreign";
    },
    "profile-reference-invalid",
  ],
  [
    "bundle",
    (f) => {
      f.observation.bundleSetVersion = 2;
    },
    "bundle-invalid",
  ],
  [
    "assignment",
    (f) => {
      f.observation.assignment.allocation.assignmentRef = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    },
    "binding-mismatch",
  ],
  [
    "foreign scope",
    (f) => {
      f.observation.assignment.allocation.namespaceId = "ns_99999999-9999-4999-8999-999999999999";
    },
    "binding-mismatch",
  ],
  [
    "unbound",
    (f) => {
      f.observation.assignment.binding = { status: "unbound" };
      f.observation.assignment.authority.state = "allocated";
    },
    "binding-mismatch",
  ],
  [
    "component",
    (f) => {
      f.observation.assignment.allocation.component = "gateway";
    },
    "observation-invalid",
  ],
  [
    "registration",
    (f) => {
      f.observation.registrationVersion = 0;
    },
    "observation-invalid",
  ],
  [
    "stale resolver",
    (f) => {
      f.observation.observedAt = "2026-09-06T23:59:50.000Z";
    },
    "evidence-stale",
  ],
  [
    "future resolver",
    (f) => {
      f.observation.observedAt = "2026-09-07T00:00:01.000Z";
    },
    "evidence-stale",
  ],
  [
    "expired",
    (f) => {
      f.nativeObservation.expiresAt = f.nativeObservation.authenticatedAt;
    },
    "peer-expired",
  ],
])
  test(`denies ${label} mismatch in actual verifier`, async () => {
    const f = setup();
    mutate(f);
    denied(await f.verifier.verify(f.connection, f.expected, f.call()), code);
  });

test("native changes during authenticated registration await cannot mint proof", async () => {
  const f = setup();
  f.registrationHook(() => {
    f.nativeObservation.incarnation = {};
  });
  denied(await f.verifier.verify(f.connection, f.expected, f.call()), "binding-mismatch");
});

test("inspection detects bound instance changes and remains terminal after restoration", async () => {
  const f = setup(),
    proof = await verified(f);
  const original = f.observation.assignment.binding.instance.protectedRestartDiscriminator;
  f.observation.assignment.binding.instance.protectedRestartDiscriminator = "fixture/restarted";
  denied(await f.verifier.inspect(proof, f.call()), "binding-mismatch");
  f.observation.assignment.binding.instance.protectedRestartDiscriminator = original;
  denied(await f.verifier.inspect(proof, f.call()), "binding-mismatch");
});

test("changed registration version, bundle, or reconnect incarnation denies original proof", async () => {
  for (const mutate of [
    (f) => {
      f.observation.registrationVersion++;
    },
    (f) => {
      f.observation.bundleSetVersion++;
      f.nativeObservation.bundleSetVersion++;
    },
    (f) => {
      f.nativeObservation.incarnation = {};
    },
  ]) {
    const f = setup(),
      proof = await verified(f);
    mutate(f);
    denied(await f.verifier.inspect(proof, f.call()));
  }
});

test("retired peer still authenticates, but immutable state and record version cannot roll back", async () => {
  const f = setup(),
    proof = await verified(f);
  f.observation.assignment.authority = { state: "retired", assignmentRecordVersion: 3 };
  assert.equal((await f.verifier.inspect(proof, f.call())).kind, "verified");
  f.observation.assignment.authority = { state: "active", assignmentRecordVersion: 2 };
  denied(await f.verifier.inspect(proof, f.call()), "binding-mismatch");
});

test("proof's original expiry cannot be renewed by fresh registration or wall-clock rollback", async () => {
  const f = setup(),
    proof = await verified(f);
  f.advanceMono(1001);
  f.fresh();
  denied(await f.verifier.inspect(proof, f.call()), "deadline-exceeded");
});

test("method replacement cannot replace captured native or registration participants", async () => {
  const f = setup();
  f.native.inspect = () => {
    throw new Error("replacement native");
  };
  f.registration.resolve = () => {
    throw new Error("replacement registration");
  };
  await verified(f);
});

test("aborted/deadline calls never start dependencies; fixed failures contain no provider detail", async () => {
  const f = setup(),
    controller = new AbortController();
  controller.abort();
  denied(
    await f.verifier.verify(f.connection, f.expected, f.call({ signal: controller.signal })),
    "cancelled",
  );
  denied(
    await f.verifier.verify(
      f.connection,
      f.expected,
      f.call({ deadline: "2020-01-01T00:00:00.000Z" }),
    ),
    "deadline-exceeded",
  );
  assert.equal(f.calls.length, 0);
  f.registrationHook(() => {
    throw new Error("SECRET_PROVIDER_TEXT");
  });
  const result = await f.verifier.verify(f.connection, f.expected, f.call());
  denied(result);
  assert.equal(JSON.stringify(result).includes("SECRET_PROVIDER_TEXT"), false);
  assert.deepEqual(Object.keys(result).sort(), [
    "kind",
    "reasonCode",
    "requestRef",
    "schemaVersion",
  ]);
});

test("late resolver positive cannot cross the original finite monotonic deadline", async () => {
  const f = setup();
  f.registrationHook(() => {
    f.advanceMono(1001);
  });
  denied(await f.verifier.verify(f.connection, f.expected, f.call()), "deadline-exceeded");
  assert.deepEqual(f.calls, ["native", "registration"]);
});

test("cancelled raw dependency remains owned until actual settlement and capacity is retained", async () => {
  const f = setup(),
    gate = defer(),
    entered = defer(),
    controller = new AbortController();
  f.expected.limits.maxPendingChecks = 1;
  f.registrationHook(() => {
    entered.resolve();
    return gate.promise;
  });
  const operation = f.verifier.verify(
    f.connection,
    f.expected,
    f.call({ signal: controller.signal }),
  );
  await entered.promise;
  let settled = false;
  const settlement = getRuntimeWorkloadVerifierSettlementV1(f.verifier, controller.signal).then(
    () => {
      settled = true;
    },
  );
  controller.abort();
  denied(await operation, "cancelled");
  assert.equal(settled, false);
  denied(await f.verifier.verify(f.connection, f.expected, f.call()), "buffer-exhausted");
  gate.resolve();
  await settlement;
  assert.equal(settled, true);
  f.registrationHook(() => {});
  await verified(f);
});

test("real timer bounds an unresolved callable without fabricating its settlement", async () => {
  const f = setup(),
    gate = defer();
  f.expected.limits.assignmentDeadlineMs = 15;
  f.nativeHook(() => gate.promise);
  const call = f.call();
  denied(await f.verifier.verify(f.connection, f.expected, call), "deadline-exceeded");
  let settled = false;
  const settlement = getRuntimeWorkloadVerifierSettlementV1(f.verifier, call.signal).then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  gate.resolve();
  await settlement;
  assert.deepEqual(f.calls, ["native"]);
});

test("concurrent initial verifies retain the highest accepted connection record version", async () => {
  const f = setup();
  const bothResolving = defer(),
    lowerGate = defer(),
    higherGate = defer();
  let resolving = 0;
  f.registrationHook(async (call) => {
    resolving++;
    if (resolving === 2) bothResolving.resolve();
    if (call.requestRef === "request/lower-initial") {
      await lowerGate.promise;
      f.observation.assignment.authority.assignmentRecordVersion = 2;
    } else {
      assert.equal(call.requestRef, "request/higher-initial");
      await higherGate.promise;
      f.observation.assignment.authority.assignmentRecordVersion = 3;
    }
  });
  // Both original checks reach the authenticated reader before any connection
  // state is installed. Complete version 2 first, then accept version 3 into
  // that newly installed state using the actual verifier's final branch.
  const lower = f.verifier.verify(
    f.connection,
    f.expected,
    f.call({ requestRef: "request/lower-initial" }),
  );
  const higher = f.verifier.verify(
    f.connection,
    f.expected,
    f.call({ requestRef: "request/higher-initial" }),
  );
  await bothResolving.promise;
  lowerGate.resolve();
  const lowerResult = await lower;
  assert.equal(lowerResult.kind, "verified");
  higherGate.resolve();
  const higherResult = await higher;
  assert.equal(higherResult.kind, "verified");
  assert.equal(lowerResult.proof.transportBinding, higherResult.proof.transportBinding);
  assert.equal(
    getRuntimeWorkloadVerifierRegistrationV1(f.verifier, higherResult.proof).assignment.authority
      .assignmentRecordVersion,
    3,
  );

  f.registrationHook(() => {});
  f.observation.assignment.authority.assignmentRecordVersion = 2;
  denied(await f.verifier.verify(f.connection, f.expected, f.call()), "binding-mismatch");
  denied(await f.verifier.inspect(lowerResult.proof, f.call()), "binding-mismatch");
});
