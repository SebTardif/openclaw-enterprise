import assert from "node:assert/strict";
import nodeTest from "node:test";
import {
  LifecycleEffectGuard,
  lifecycleEffectAfterClaimLoss,
} from "../../apps/controller/src/worker/lifecycle-effect-guard.ts";
import { WorkClaimLostError } from "../../packages/occ/src/state/postgres-work-queue.ts";
import { parseRuntimeEffectsV1 } from "../../packages/contracts/src/runtime-effects-v1.ts";
import {
  association,
  call,
  cleanupAuthority,
  deferred,
  gateObservation,
  setup,
} from "../fixtures/lifecycle-worker-guard/peers.mjs";
import {
  copy,
  createRequest,
  digest,
  routeRequest,
  signRequest,
  stopRequest,
  unknownResult,
  uuid,
} from "../fixtures/lifecycle-worker-guard/vectors.mjs";

// These tests execute the actual guard with controlled peers and real signals.
// They establish no database lease, authenticated authority or provider outcome.
const test = (name, run) => nodeTest(name, { timeout: 10_000 }, run);
const count = (s, kind) => s.events.filter(([name]) => name === kind).length;
const noSubmission = (s) =>
  assert.equal(count(s, "create") + count(s, "route") + count(s, "cleanup"), 0);
const sameEffect = (result, request) => assert.deepEqual(result.effect, request.effect);

test("pre-aborted work preserves the canonical claim-loss class without renewal", async () => {
  const s = setup();
  s.abort.abort();
  await assert.rejects(s.guard.run(s.context, s.request), WorkClaimLostError);
  assert.equal(s.events.length, 0);
});

test("abort during renewal cannot proceed when the pending renewal later returns", async () => {
  const pending = deferred();
  const entered = deferred();
  const s = setup(undefined, {
    heartbeat: () => {
      entered.resolve();
      return pending.promise;
    },
  });
  const running = s.guard.run(s.context, s.request);
  const rejected = assert.rejects(running, WorkClaimLostError);
  await entered.promise;
  s.abort.abort();
  pending.resolve(copy(s.context.work));
  await rejected;
  noSubmission(s);
});

for (const boundary of ["read", "gate"]) {
  test(`abort during ${boundary} discards the awaited observation`, async () => {
    const s = setup();
    const entered = deferred();
    const pending = deferred();
    if (boundary === "read")
      s.options.lifecycle.readAdmittedWork = () => {
        entered.resolve();
        return pending.promise;
      };
    else
      s.options.admission.readGate = () => {
        entered.resolve();
        return pending.promise;
      };
    const rejected = assert.rejects(s.guard.run(s.context, s.request), WorkClaimLostError);
    await entered.promise;
    s.abort.abort();
    pending.resolve(
      boundary === "read"
        ? { kind: "read", association: s.context.original, currentIntent: s.state.head }
        : gateObservation(s.request),
    );
    await rejected;
    noSubmission(s);
  });
}

for (const change of ["stopped", "disabled", "generation", "same-generation-content", "absent"]) {
  test(`${change} head during gate wait prevents running submission`, async () => {
    const s = setup();
    const entered = deferred();
    const pending = deferred();
    s.options.admission.readGate = () => {
      entered.resolve();
      return pending.promise;
    };
    const running = s.guard.run(s.context, s.request);
    await entered.promise;
    if (change === "stopped" || change === "disabled") s.state.head.desiredMode = change;
    else if (change === "generation") s.state.head.generation += 1;
    else if (change === "absent") s.state.head = null;
    else s.state.head.requestId = `req_${uuid(93)}`;
    pending.resolve(gateObservation(s.request));
    const result = await running;
    assert.equal(result.kind, "blocked");
    assert.equal(result.reason, "head-mismatch");
    noSubmission(s);
  });
}

for (const renewed of ["absent", "foreign-token", "foreign-work", "expired", "reject"]) {
  test(`${renewed} renewal remains closed with the correct error classification`, async () => {
    const s = setup();
    s.options.heartbeat = async () => {
      if (renewed === "absent") return undefined;
      if (renewed === "reject") throw new Error("controlled renewal outage");
      const value = copy(s.context.work);
      if (renewed === "foreign-token") value.claimToken = uuid(94);
      if (renewed === "foreign-work") value.idempotencyKey = "foreign/work";
      if (renewed === "expired") value.leaseExpiresAt = new Date(s.state.time);
      return value;
    };
    if (renewed === "reject")
      assert.equal((await s.guard.run(s.context, s.request)).reason, "dependency-unavailable");
    else await assert.rejects(s.guard.run(s.context, s.request), WorkClaimLostError);
    noSubmission(s);
  });
}

test("an already expired claim never renews or submits", async () => {
  const s = setup();
  s.context.work.leaseExpiresAt = new Date(s.state.time);
  await assert.rejects(s.guard.run(s.context, s.request), WorkClaimLostError);
  assert.equal(count(s, "renew"), 0);
  noSubmission(s);
});

for (const field of ["installationId", "namespaceId", "agentId", "actorId"]) {
  test(`foreign ${field} is rejected before effects`, async () => {
    const s = setup();
    if (field === "installationId") s.context.installationId = `ins_${uuid(95)}`;
    else if (field === "actorId") s.context.work.actorId = "principal/foreign";
    else s.context.work[field] = `${field === "namespaceId" ? "ns" : "agt"}_${uuid(95)}`;
    assert.equal((await s.guard.run(s.context, s.request)).kind, "blocked");
    noSubmission(s);
  });
}

for (const capability of ["admission", "effects"]) {
  test(`missing ${capability} capability never falls back`, async () => {
    const s = setup(undefined, { [capability]: undefined });
    const result = await s.guard.run(s.context, s.request);
    assert.equal(result.reason, "capability-unavailable");
    noSubmission(s);
  });
}

for (const mode of ["closed", "unknown", "stale"]) {
  test(`${mode} gate cannot enable a submission`, async () => {
    const s = setup();
    s.options.admission.readGate = async () => {
      const value = copy(gateObservation(s.request));
      if (mode === "closed") value.ordinaryAdmission = "closed";
      else if (mode === "stale") value.evidence.clock.validUntil = "2026-01-01T00:00:00.500Z";
      else {
        value.authority = "unknown";
        value.ordinaryAdmission = "closed";
      }
      return parseRuntimeEffectsV1("gateState", value);
    };
    assert.equal((await s.guard.run(s.context, s.request)).reason, "gate-unavailable");
    noSubmission(s);
  });
}

for (const requestFactory of [createRequest, routeRequest]) {
  test(`${requestFactory.name}: unknown effect stays unresolved and repeat requires original read`, async () => {
    const s = setup(requestFactory());
    const result = await s.guard.run(s.context, s.request);
    assert.equal(result.kind, "unresolved");
    assert.equal(result.observation.status, "unknown");
    sameEffect(result, s.request);
    assert.equal(count(s, "renew"), 2);
    const retry = await s.guard.run(s.context, s.request);
    assert.equal(retry.reason, "read-original");
    sameEffect(retry, s.request);
    assert.equal(count(s, "create") + count(s, "route"), 1);
  });
}

for (const outcome of ["timeout", "malformed", "wrong-effect", "reject", "abort"]) {
  test(`${outcome} after submission retains original digest and forbids replay`, async () => {
    const s = setup(undefined, { maxWaitMs: outcome === "timeout" ? 100 : 1_000 });
    const entered = deferred();
    const pending = deferred();
    let submissions = 0;
    let providerCall;
    s.options.effects.create = (input, bounded) => {
      submissions += 1;
      providerCall = bounded;
      entered.resolve();
      return pending.promise;
    };
    const running = s.guard.run(s.context, s.request);
    const settled =
      outcome === "abort"
        ? assert.rejects(running, (error) => {
            assert.ok(error instanceof WorkClaimLostError);
            const retained = lifecycleEffectAfterClaimLoss(error);
            assert.equal(retained.kind, "unresolved");
            sameEffect(retained, s.request);
            return true;
          })
        : running;
    await entered.promise;
    if (outcome === "malformed") pending.resolve({ status: "applied" });
    else if (outcome === "wrong-effect") {
      const value = copy(unknownResult(s.request));
      value.effect.effectRef = uuid(97);
      pending.resolve(value);
    } else if (outcome === "reject") pending.reject(new Error("response lost"));
    else if (outcome === "abort") s.abort.abort();
    const result = await settled;
    if (outcome !== "abort") {
      assert.equal(result.kind, "unresolved");
      sameEffect(result, s.request);
    }
    if (outcome === "timeout" || outcome === "abort") {
      assert.ok(providerCall.signal.aborted);
      // Late completion does not join/cancel the provider or turn uncertainty into success.
      pending.resolve(unknownResult(s.request));
      await Promise.resolve();
    }
    const retryContext = { ...s.context, signal: new AbortController().signal };
    const retry = await s.guard.run(retryContext, s.request);
    assert.equal(retry.reason, "read-original");
    sameEffect(retry, s.request);
    assert.equal(submissions, 1);
  });
}

test("head change after possible submission retains historical effect without current publication", async () => {
  const s = setup();
  s.options.effects.create = async () => {
    s.state.head.generation += 1;
    return unknownResult(s.request);
  };
  const result = await s.guard.run(s.context, s.request);
  assert.equal(result.kind, "unresolved");
  assert.equal(result.reason, "head-mismatch");
  sameEffect(result, s.request);
});

for (const boundary of ["read", "effect"]) {
  test(`${boundary} cannot outlive the tighter local deadline even before its timer fires`, async () => {
    const s = setup(undefined, { maxWaitMs: 1_000 });
    if (boundary === "read")
      s.options.lifecycle.readAdmittedWork = async () => {
        s.state.time = new Date(s.state.time.getTime() + 1_001);
        return { kind: "read", association: s.context.original, currentIntent: s.state.head };
      };
    else
      s.options.effects.create = async () => {
        s.state.time = new Date(s.state.time.getTime() + 1_001);
        return unknownResult(s.request);
      };
    const result = await s.guard.run(s.context, s.request);
    assert.equal(result.kind, boundary === "read" ? "blocked" : "unresolved");
    assert.equal(result.reason, "deadline-exceeded");
    sameEffect(result, s.request);
    if (boundary === "read") noSubmission(s);
  });
}

test("changed canonical bytes under a retained effect ref cannot silently rebase", async () => {
  const s = setup();
  await s.guard.run(s.context, s.request);
  const changed = copy(s.request);
  changed.preparation.preparationVersion += 1;
  signRequest(changed);
  const result = await s.guard.run(s.context, changed);
  assert.equal(result.reason, "identity-conflict");
  assert.equal(count(s, "create"), 1);
});

test("readOriginal sends only the exact retained locator and performs no renewal or create", async () => {
  const s = setup();
  s.abort.abort();
  s.state.head = null;
  const result = await s.guard.readOriginal(s.request.effect, call());
  sameEffect(result, s.request);
  assert.equal(result.kind, "unresolved");
  assert.deepEqual(
    s.events.map(([kind]) => kind),
    ["readEffect"],
  );
  assert.deepEqual(s.events[0][1], s.request.effect);
  assert.equal(Object.hasOwn(s.events[0][1], "gate"), false);
});

test("same revision successor generation cannot reuse the old admitted association", async () => {
  const s = setup();
  const next = copy(s.request);
  next.effect.target.lifecycleGeneration += 1;
  next.gate.lifecycleGeneration += 1;
  signRequest(next);
  assert.equal((await s.guard.run(s.context, next)).reason, "association-mismatch");
  noSubmission(s);
});

test("two Agents overlap without shared cancellation or a global wait lock", async () => {
  const first = setup();
  const request = copy(createRequest());
  const oldAgent = request.effect.target.agentId;
  const newAgent = `agt_${uuid(98)}`;
  const replace = (value) =>
    JSON.parse(
      JSON.stringify(value)
        .replaceAll(oldAgent, newAgent)
        .replaceAll(request.effect.target.revisionId, `rev_${uuid(102)}`),
    );
  const second = setup(signRequest(replace(request)));
  const pending = deferred();
  const entered = deferred();
  first.options.effects.create = () => {
    entered.resolve();
    return pending.promise;
  };
  const rejected = assert.rejects(
    first.guard.run(first.context, first.request),
    WorkClaimLostError,
  );
  await entered.promise;
  const result = await second.guard.run(second.context, second.request);
  assert.equal(result.kind, "unresolved");
  first.abort.abort();
  pending.resolve(unknownResult(first.request));
  await rejected;
  assert.equal(second.context.signal.aborted, false);
  assert.equal(count(second, "create"), 1);
});

function cleanupSetup() {
  const request = parseRuntimeEffectsV1("effectRequest", stopRequest());
  const s = setup();
  const authority = cleanupAuthority(request);
  s.options.admission.readGate = async () => gateObservation(request);
  s.options.assignments = {
    async resolve() {
      return authority.value;
    },
  };
  return { ...s, cleanupRequest: request, original: association(request), authority };
}

test("separate cleanup call survives old running abort and unknown cleanup is never terminal", async () => {
  const s = cleanupSetup();
  s.abort.abort();
  const result = await s.guard.cleanup(s.original, s.cleanupRequest, s.authority.input, call());
  assert.equal(result.kind, "unresolved");
  assert.equal(result.observation.status, "unknown");
  sameEffect(result, s.cleanupRequest);
  assert.equal(count(s, "cleanup"), 1);
  assert.equal(count(s, "renew"), 0);
  const retry = await s.guard.cleanup(s.original, s.cleanupRequest, s.authority.input, call());
  assert.equal(retry.reason, "read-original");
  assert.equal(count(s, "cleanup"), 1);
});

for (const mismatch of ["successor", "scope", "uid", "responsibility", "unavailable"]) {
  test(`cleanup rejects ${mismatch} authority without submitting`, async () => {
    const s = cleanupSetup();
    const value = copy(s.authority.value);
    if (mismatch === "successor") value.snapshot.target.lifecycleGeneration += 1;
    else if (mismatch === "scope") value.snapshot.target.agentId = `agt_${uuid(99)}`;
    else if (mismatch === "uid") value.snapshot.binding.deploymentUid = "successor-deployment";
    else if (mismatch === "responsibility") value.responsibilityVersion += 1;
    else s.options.assignments = undefined;
    if (mismatch !== "unavailable") s.options.assignments.resolve = async () => value;
    const result = await s.guard.cleanup(s.original, s.cleanupRequest, s.authority.input, call());
    assert.equal(result.kind, "blocked");
    assert.equal(
      result.reason,
      mismatch === "unavailable" ? "capability-unavailable" : "authority-unavailable",
    );
    assert.equal(count(s, "cleanup"), 0);
  });
}

test("cleanup with altered digest is rejected before authority or provider use", async () => {
  const s = cleanupSetup();
  const request = copy(s.cleanupRequest);
  request.effect.requestDigest = digest(99);
  await assert.rejects(s.guard.cleanup(s.original, request, s.authority.input, call()));
  assert.equal(count(s, "cleanup"), 0);
});

test("cleanup cannot substitute a successor UID under the original execution binding", async () => {
  const s = cleanupSetup();
  const request = copy(s.cleanupRequest);
  request.predicate.uid = "successor-deployment";
  await assert.rejects(s.guard.cleanup(s.original, request, s.authority.input, call()));
  assert.equal(count(s, "cleanup"), 0);
});

test("a dependency's canonical claim-loss error retains its exact instance", async () => {
  const originalError = new WorkClaimLostError();
  const s = setup(undefined, {
    heartbeat: async () => {
      throw originalError;
    },
  });
  await assert.rejects(s.guard.run(s.context, s.request), (error) => error === originalError);
  assert.equal(lifecycleEffectAfterClaimLoss(originalError), undefined);
  noSubmission(s);
});

test("cleanup authority revoked after submission remains unresolved", async () => {
  const s = cleanupSetup();
  let resolves = 0;
  s.options.assignments.resolve = async () => {
    resolves += 1;
    if (resolves > 1) throw new Error("authority revoked");
    return s.authority.value;
  };
  const result = await s.guard.cleanup(s.original, s.cleanupRequest, s.authority.input, call());
  assert.equal(result.kind, "unresolved");
  sameEffect(result, s.cleanupRequest);
  assert.equal(count(s, "cleanup"), 1);
});

for (const phase of ["before-submit", "before-return"]) {
  test(`cleanup authority expiry ${phase} cannot be extended by a fresh gate`, async () => {
    const s = cleanupSetup();
    const value = copy(s.authority.value);
    value.validUntil = "2026-01-01T00:00:01.500Z";
    s.options.assignments.resolve = async () => value;
    let gates = 0;
    s.options.admission.readGate = async () => {
      gates += 1;
      if (gates === (phase === "before-submit" ? 2 : 3))
        s.state.time = new Date("2026-01-01T00:00:01.600Z");
      return gateObservation(s.cleanupRequest);
    };
    const result = await s.guard.cleanup(s.original, s.cleanupRequest, s.authority.input, call());
    assert.equal(result.kind, phase === "before-submit" ? "blocked" : "unresolved");
    assert.equal(result.reason, "authority-unavailable");
    assert.equal(count(s, "cleanup"), phase === "before-submit" ? 0 : 1);
    sameEffect(result, s.cleanupRequest);
  });
}

for (const phase of ["before-submit", "before-return"]) {
  test(`running gate expiry ${phase} survives a later valid lifecycle read`, async () => {
    const s = setup();
    let gates = 0;
    s.options.admission.readGate = async () => {
      gates += 1;
      const value = copy(gateObservation(s.request));
      value.evidence.clock.validUntil = "2026-01-01T00:00:01.500Z";
      return value;
    };
    s.options.lifecycle.readAdmittedWork = async () => {
      if (gates === (phase === "before-submit" ? 1 : 2))
        s.state.time = new Date("2026-01-01T00:00:01.600Z");
      return { kind: "read", association: s.context.original, currentIntent: s.state.head };
    };
    const result = await s.guard.run(s.context, s.request);
    assert.equal(result.kind, phase === "before-submit" ? "blocked" : "unresolved");
    assert.equal(result.reason, "gate-unavailable");
    assert.equal(count(s, "create"), phase === "before-submit" ? 0 : 1);
    sameEffect(result, s.request);
  });
}

test("bounded peer calls preserve caller context and correlation while tightening their deadline", async () => {
  const s = setup(undefined, { maxWaitMs: 400 });
  await s.guard.run(s.context, s.request);
  for (const [kind, , bounded] of s.events) {
    if (kind === "renew") continue;
    assert.equal(bounded.context, s.context.call.context);
    assert.equal(bounded.requestRef, s.context.call.requestRef);
    assert.equal(bounded.recipientRef, s.context.call.recipientRef);
    assert.ok(bounded.signal instanceof AbortSignal);
    assert.notEqual(bounded.signal, s.context.call.signal);
    assert.equal(bounded.deadline, "2026-01-01T00:00:01.400Z");
  }
});

for (const phase of ["before-submit", "before-return"]) {
  test(`gate clock uncertainty ${phase} cannot be discarded after a lifecycle await`, async () => {
    const s = setup();
    let gates = 0;
    s.options.admission.readGate = async () => {
      gates += 1;
      const value = copy(gateObservation(s.request));
      value.evidence.clock.validUntil = "2026-01-01T00:00:02.000Z";
      value.evidence.clock.uncertaintyMs = 500;
      return value;
    };
    s.options.lifecycle.readAdmittedWork = async () => {
      if (gates === (phase === "before-submit" ? 1 : 2))
        s.state.time = new Date("2026-01-01T00:00:01.600Z");
      return { kind: "read", association: s.context.original, currentIntent: s.state.head };
    };
    const result = await s.guard.run(s.context, s.request);
    assert.equal(result.kind, phase === "before-submit" ? "blocked" : "unresolved");
    assert.equal(result.reason, "gate-unavailable");
    assert.equal(count(s, "create"), phase === "before-submit" ? 0 : 1);
    sameEffect(result, s.request);
  });
}

test("one guard isolates overlapping Agents even when their effect refs are identical", async () => {
  const first = setup();
  const oldAgent = first.request.effect.target.agentId;
  const nextRequest = JSON.parse(
    JSON.stringify(first.request)
      .replaceAll(oldAgent, `agt_${uuid(100)}`)
      .replaceAll(first.request.effect.target.revisionId, `rev_${uuid(103)}`),
  );
  const second = setup(signRequest(nextRequest));
  const pending = deferred();
  const entered = deferred();
  let submissions = 0;
  first.options.lifecycle.readAdmittedWork = async (input) => {
    const selected = input.agentId === oldAgent ? first : second;
    return {
      kind: "read",
      association: selected.context.original,
      currentIntent: selected.state.head,
    };
  };
  // Distinct original work ownership is needed even when two Agents use the
  // same representation effectRef; target scope must isolate attempt memory.
  second.context.work.claimToken = uuid(101);
  first.options.heartbeat = async (claim) =>
    copy(
      claim.claimToken === first.context.work.claimToken ? first.context.work : second.context.work,
    );
  first.options.admission.readGate = async (gate) =>
    gateObservation(gate.scope.agentId === oldAgent ? first.request : second.request);
  first.options.effects.create = (request) => {
    submissions += 1;
    if (request.effect.target.agentId === oldAgent) {
      entered.resolve();
      return pending.promise;
    }
    return Promise.resolve(unknownResult(request));
  };
  const rejected = assert.rejects(
    first.guard.run(first.context, first.request),
    WorkClaimLostError,
  );
  await entered.promise;
  const secondResult = await first.guard.run(second.context, second.request);
  assert.equal(secondResult.kind, "unresolved");
  sameEffect(secondResult, second.request);
  first.abort.abort();
  pending.resolve(unknownResult(first.request));
  await rejected;
  assert.equal(submissions, 2);
  assert.equal(second.context.signal.aborted, false);
});

test("unsupported effect response remains blocked and not-found readback remains uncertain", async () => {
  const s = setup();
  s.options.effects.create = async (request) =>
    parseRuntimeEffectsV1("effectResult", {
      schemaVersion: 1,
      effect: request.effect,
      status: "unsupported",
      capabilityRef: "controlled-unavailable",
      reasonCode: "capability-unsupported",
    });
  const result = await s.guard.run(s.context, s.request);
  assert.equal(result.kind, "blocked");
  assert.equal(result.observation.status, "unsupported");
  s.options.effects.readEffect = async (effect) => ({
    schemaVersion: 1,
    effect,
    status: "not-found",
    outcome: "unknown",
  });
  const readback = await s.guard.readOriginal(s.request.effect, call());
  assert.equal(readback.kind, "unresolved");
  assert.equal(readback.observation.status, "not-found");
  sameEffect(readback, s.request);
});
