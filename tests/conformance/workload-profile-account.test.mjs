import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createWorkloadProfilePurposeAccountParticipantV1 } from "../../packages/occ/src/account-authority/workload-profile.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";

// Controlled original-request and owner/security ports exercise the actual
// consumer. These fixtures authenticate no browser session and run no SQL,
// PostgreSQL, policy provider, deployment or active-profile acquisition.
const unavailable = (error) =>
  error instanceof DependencyUnavailableError &&
  error.message === "The current workload profile account is unavailable.";
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(
  t,
  purpose = "workload-profile-deployment",
  custody = { invocation: Object.freeze({}), used: false },
) {
  const events = [],
    hooks = {};
  const abort = new AbortController();
  let ownerActive = true,
    ioActive = true,
    sealed = false,
    done = false;
  let terminalCleanup,
    requestHeld = false,
    securityHeld = false;
  const accepted = new Set();
  const invocation = custody.invocation;
  const installationId = "ins-purpose-fixture";
  const binding = [
    "principal-a",
    purpose === "workload-profile-draft-selection"
      ? { namespaceId: "namespace-a", agentId: "agent-a", configurationId: "configuration-a" }
      : {
          namespaceId: "namespace-a",
          agentId: "agent-a",
          command: { operationRef: "operation-a", expectedLifecycleGeneration: 7 },
        },
  ];
  const request = { purpose, binding };
  const expected = structuredClone(request);
  const facts = {
    installationId,
    principalId: "principal-a",
    accountRef: "account-a",
    sessionRef: "session-a",
    requestId: "request-a",
    admissionDecisionId: "decision-a",
    expiresAt: new Date(Date.now() + 30000).toISOString(),
  };
  const securityFacts = {
    principal: {
      id: "principal-a",
      kind: "principal",
      issuer: "issuer-a",
      subject: "subject-a",
    },
    accountRef: "account-a",
    sessionRef: "session-a",
    expiresAt: facts.expiresAt,
  };
  const checkOwner = () => {
    assert.ok(ownerActive, "original owner inactive");
  };
  const checkAcquiring = () => {
    checkOwner();
    assert.ok(ioActive && !sealed, "bound IO unavailable");
  };
  const unit = Object.freeze({
    installationId,
    signal: abort.signal,
    retainSecurityCleanup(release) {
      checkAcquiring();
      assert.equal(terminalCleanup, undefined);
      events.push("cleanup.register");
      terminalCleanup = release;
    },
    async query(statement, parameters) {
      checkAcquiring();
      events.push("account.query");
      assert.equal(statement, "controlled account/session read");
      assert.deepEqual(parameters, [installationId, facts.accountRef, facts.sessionRef]);
      await hooks.query?.();
      checkAcquiring();
      return { rows: [], rowCount: 0 };
    },
  });
  const ownerLease = {
    assertAcquiring() {
      checkAcquiring();
      return hooks.acquiring?.();
    },
    assertCurrent() {
      checkOwner();
      return hooks.ownerCurrent?.();
    },
    retainAccepted(task) {
      assert.equal(done, false);
      events.push("work.retain");
      accepted.add(task);
      void task.then(
        () => accepted.delete(task),
        () => accepted.delete(task),
      );
    },
  };
  const owner = {
    bind(received, cleanup) {
      assert.equal(received, unit);
      checkAcquiring();
      events.push("owner.bind");
      unit.retainSecurityCleanup(cleanup);
      return ownerLease;
    },
  };
  const requestLease = {
    get facts() {
      hooks.requestFacts?.();
      return facts;
    },
    assertCurrent() {
      assert.ok(requestHeld);
      return hooks.requestCurrent?.();
    },
  };
  const securityLease = {
    get principal() {
      hooks.principal?.();
      return securityFacts.principal;
    },
    get accountRef() {
      return securityFacts.accountRef;
    },
    get sessionRef() {
      return securityFacts.sessionRef;
    },
    get expiresAt() {
      return securityFacts.expiresAt;
    },
    assertCurrent() {
      assert.ok(securityHeld);
      return hooks.securityCurrent?.();
    },
  };
  const requests = {
    async consume(handle, selected, received, retain) {
      assert.equal(received, unit);
      assert.equal(handle, invocation);
      assert.equal(custody.used, false);
      assert.deepEqual(selected, expected);
      custody.used = true;
      assert.ok(
        Object.isFrozen(selected) &&
          Object.isFrozen(selected.binding) &&
          Object.isFrozen(selected.binding[1]),
      );
      events.push("request.acquire");
      requestHeld = true;
      hooks.saveRequestRetainer?.(retain);
      hooks.beforeRequestRegister?.();
      retain(() => {
        events.push("request.release");
        requestHeld = false;
        return hooks.requestRelease?.();
      });
      await hooks.requestAcquire?.();
      return requestLease;
    },
  };
  const security = {
    async lock(received, authenticated, retain) {
      assert.equal(received, unit);
      assert.equal(authenticated, requestLease);
      events.push("security.acquire");
      securityHeld = true;
      hooks.beforeSecurityRegister?.();
      if (!hooks.omitSecurityCleanup)
        retain(() => {
          events.push("security.release");
          securityHeld = false;
          return hooks.securityRelease?.();
        });
      await unit.query("controlled account/session read", [
        installationId,
        facts.accountRef,
        facts.sessionRef,
      ]);
      await hooks.securityAcquire?.();
      return securityLease;
    },
  };
  const options = { owner, requests, security };
  const participant = createWorkloadProfilePurposeAccountParticipantV1(options);
  const drain = async () => {
    while (accepted.size) await Promise.allSettled([...accepted]);
  };
  async function finish(outcome = "rolled-back") {
    if (done) return;
    ioActive = false;
    await drain();
    events.push("db." + outcome);
    events.push("db.cleanup");
    ownerActive = false;
    let failed;
    try {
      terminalCleanup?.();
    } catch (error) {
      failed = error;
    }
    await drain();
    done = true;
    if (failed) throw failed;
  }
  t.after(async () => {
    await finish().catch(() => {});
  });
  return {
    events,
    hooks,
    abort,
    unit,
    facts,
    securityFacts,
    request,
    invocation,
    options,
    participant,
    custody,
    get requestHeld() {
      return requestHeld;
    },
    get securityHeld() {
      return securityHeld;
    },
    setOwnerActive(value) {
      ownerActive = value;
    },
    setIO(value) {
      ioActive = value;
    },
    seal() {
      sealed = true;
      events.push("policy.seal");
    },
    finish,
    async consume(
      selected = request,
      handle = invocation,
      selectedUnit = unit,
      source = participant,
    ) {
      try {
        return await source.consume(handle, selected, selectedUnit);
      } finally {
        ioActive = false;
      }
    },
  };
}

for (const purpose of [
  "workload-profile-deployment",
  "workload-profile-draft-selection",
  "workload-profile-deployment-recovery",
]) {
  test(purpose + ": exact binding, same borrowed unit and terminal-owned cleanup", async (t) => {
    const f = fixture(t, purpose);
    const lease = await f.consume();
    assert.equal(lease.principal.id, "principal-a");
    assert.equal(lease.accountRef, "account-a");
    assert.equal(lease.requestId, "request-a");
    assert.equal(lease.admissionDecisionId, "decision-a");
    assert.equal(lease.assertCurrent(), undefined);
    assert.ok(Object.isFrozen(lease.principal));
    assert.ok(f.events.indexOf("cleanup.register") < f.events.indexOf("request.acquire"));
    assert.ok(f.events.indexOf("request.acquire") < f.events.indexOf("account.query"));
    f.seal();
    assert.equal(lease.assertCurrent(), undefined);
    assert.equal(f.events.filter((x) => x === "account.query").length, 1);
    await f.finish("committed");
    lease.release();
    assert.ok(f.events.indexOf("db.cleanup") < f.events.indexOf("security.release"));
    assert.ok(f.events.indexOf("security.release") < f.events.indexOf("request.release"));
    assert.throws(lease.assertCurrent, unavailable);
    assert.equal(f.requestHeld || f.securityHeld, false);
    assert.equal(
      f.events.some((x) => x.includes("profile.acquire")),
      false,
    );
  });
}
for (const missing of ["owner", "requests", "security"]) {
  test("missing genuine " + missing + " source stays unavailable", async (t) => {
    const f = fixture(t);
    const source = createWorkloadProfilePurposeAccountParticipantV1({
      ...f.options,
      [missing]: undefined,
    });
    await assert.rejects(f.consume(f.request, f.invocation, f.unit, source), unavailable);
    assert.deepEqual(f.events, []);
  });
}
for (const purpose of ["native-channel", "turn-command", "workload-profile-definition"]) {
  test("unaccepted purpose " + purpose + " fails before acquisition", async (t) => {
    const f = fixture(t);
    await assert.rejects(f.consume({ ...f.request, purpose }), unavailable);
    assert.deepEqual(f.events, []);
  });
}
test("structurally copied opaque request is rejected by original custody", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.consume(f.request, structuredClone(f.invocation)), unavailable);
  assert.equal(f.requestHeld, false);
  assert.equal(f.events.includes("security.acquire"), false);
});
test("structurally copied unit is rejected by original owner", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.consume(f.request, f.invocation, { ...f.unit }), unavailable);
  assert.deepEqual(f.events, []);
});
test("replayed request is rejected by original custody across a fresh owner and adapter", async (t) => {
  const first = fixture(t);
  const lease = await first.consume();
  await first.finish();
  lease.release();
  const second = fixture(t, "workload-profile-deployment", first.custody);
  await assert.rejects(second.consume(), unavailable);
  assert.equal(second.events.includes("request.acquire"), false);
  assert.equal(second.events.includes("security.acquire"), false);
});
test("caller mutation after entry cannot change the captured purpose/command", async (t) => {
  const f = fixture(t);
  const gate = deferred();
  f.hooks.requestAcquire = () => gate.promise;
  const running = f.consume();
  await nextTurn();
  f.request.binding[0] = "forged-principal";
  f.request.binding[1].agentId = "changed-agent";
  gate.resolve();
  const lease = await running;
  assert.equal(lease.principal.id, "principal-a");
});
test("caller principal and authentic principal mismatch denies", async (t) => {
  const f = fixture(t);
  f.facts.principalId = "another-principal";
  await assert.rejects(f.consume(), unavailable);
  assert.equal(f.events.includes("security.acquire"), false);
  assert.equal(f.requestHeld, true);
  await f.finish();
  assert.equal(f.requestHeld, false);
});
test("foreign Installation facts deny while retaining original cleanup", async (t) => {
  const f = fixture(t);
  f.facts.installationId = "foreign-installation";
  await assert.rejects(f.consume(), unavailable);
  assert.equal(f.requestHeld, true);
  await f.finish();
});
test("throwing acquired request facts getter cannot orphan its cleanup or expose cause", async (t) => {
  const f = fixture(t);
  f.hooks.requestFacts = () => {
    throw new Error("synthetic private credential cause");
  };
  await assert.rejects(f.consume(), unavailable);
  assert.equal(f.requestHeld, true);
  await f.finish();
});
test("throwing acquired principal getter retains both acquired cleanups", async (t) => {
  const f = fixture(t);
  f.hooks.principal = () => {
    throw new Error("synthetic private cause");
  };
  await assert.rejects(f.consume(), unavailable);
  assert.ok(f.requestHeld && f.securityHeld);
  await f.finish();
  assert.equal(f.requestHeld || f.securityHeld, false);
});
for (const point of ["Request", "Security"]) {
  test(
    "abort immediately before " + point + " cleanup registration retains that guard",
    async (t) => {
      const f = fixture(t);
      f.hooks["before" + point + "Register"] = () => f.abort.abort();
      await assert.rejects(f.consume(), unavailable);
      assert.equal(f.requestHeld, true);
      if (point === "Security") assert.equal(f.securityHeld, true);
      assert.equal(
        f.events.some((x) => x.endsWith(".release")),
        false,
      );
      await f.finish();
      assert.equal(f.requestHeld || f.securityHeld, false);
    },
  );
}
for (const point of ["request", "security"]) {
  test("late " + point + " acquisition rejection keeps guards until joined terminal", async (t) => {
    const f = fixture(t);
    f.hooks[point + "Acquire"] = async () => {
      await nextTurn();
      throw new Error("private cause");
    };
    await assert.rejects(f.consume(), unavailable);
    assert.equal(f.requestHeld, true);
    await f.finish("unknown");
    assert.equal(f.requestHeld || f.securityHeld, false);
    assert.ok(f.events.indexOf("db.cleanup") < f.events.indexOf("request.release"));
  });
}
for (const point of ["request", "security"]) {
  test("throwing " + point + " cleanup still attempts every other cleanup once", async (t) => {
    const f = fixture(t);
    await f.consume();
    f.hooks[point + "Release"] = () => {
      throw new Error("private cause");
    };
    await assert.rejects(f.finish(), unavailable);
    assert.equal(f.events.filter((x) => x === "request.release").length, 1);
    assert.equal(f.events.filter((x) => x === "security.release").length, 1);
  });
}
for (const point of ["owner", "request", "security"]) {
  test(point + " invalidation remains effective after acquisition IO closes", async (t) => {
    const f = fixture(t);
    const lease = await f.consume();
    f.hooks[point + "Current"] = () => {
      throw new Error("revoked");
    };
    assert.throws(lease.assertCurrent, unavailable);
    delete f.hooks[point + "Current"];
    assert.throws(lease.assertCurrent, unavailable);
    assert.equal(f.securityHeld, true);
    await f.finish();
  });
}
for (const field of ["accountRef", "sessionRef"]) {
  test("security " + field + " mismatch cannot replace request authority", async (t) => {
    const f = fixture(t);
    f.securityFacts[field] = "foreign";
    await assert.rejects(f.consume(), unavailable);
    assert.equal(f.securityHeld, true);
    await f.finish();
  });
}
for (const source of ["request", "security"]) {
  test("expired " + source + " source is unavailable without refreshed lifetime", async (t) => {
    const f = fixture(t);
    (source === "request" ? f.facts : f.securityFacts).expiresAt = "2000-01-01T00:00:00.000Z";
    await assert.rejects(f.consume(), unavailable);
    await f.finish();
  });
}
test("policy seal during awaited account read refuses later authority", async (t) => {
  const f = fixture(t);
  f.hooks.query = () => f.seal();
  await assert.rejects(f.consume(), unavailable);
  assert.equal(f.securityHeld, true);
  await f.finish();
});
test("recovery recognizes its fresh owner and rejects a prior deployment unit", async (t) => {
  const old = fixture(t);
  await old.consume();
  await old.finish("unknown");
  const recovery = fixture(t, "workload-profile-deployment-recovery");
  await assert.rejects(
    recovery.consume(recovery.request, recovery.invocation, old.unit),
    unavailable,
  );
  assert.deepEqual(recovery.events, []);
});
for (const rejects of [false, true]) {
  test(
    "malformed async final guard " +
      (rejects ? "rejection" : "fulfillment") +
      " drains before terminal cleanup",
    async (t) => {
      const f = fixture(t);
      const lease = await f.consume();
      const gate = deferred();
      f.hooks.securityCurrent = () => gate.promise;
      assert.throws(lease.assertCurrent, unavailable);
      const finishing = f.finish();
      await nextTurn();
      assert.equal(f.securityHeld, true);
      assert.equal(f.events.includes("db.cleanup"), false);
      if (rejects) gate.reject(new Error("private late rejection"));
      else gate.resolve();
      await finishing;
      assert.equal(f.securityHeld, false);
    },
  );
}
test("malformed async acquiring fence refuses and joins its accepted work", async (t) => {
  const f = fixture(t);
  const gate = deferred();
  f.hooks.acquiring = () => gate.promise;
  let settled = false;
  const running = assert.rejects(f.consume(), unavailable).then(() => {
    settled = true;
  });
  await nextTurn();
  assert.equal(settled, false);
  assert.equal(f.events.includes("request.acquire"), false);
  gate.reject(new Error("late private rejection"));
  await running;
  await f.finish();
});
test("local observation release cannot invoke transferred security cleanup", async (t) => {
  const f = fixture(t);
  const lease = await f.consume();
  lease.release();
  lease.release();
  assert.throws(lease.assertCurrent, unavailable);
  assert.ok(f.requestHeld && f.securityHeld);
  assert.equal(
    f.events.some((x) => x.endsWith(".release")),
    false,
  );
  await f.finish();
  assert.equal(f.requestHeld || f.securityHeld, false);
});
test("abort raised by final security fence is rechecked synchronously", async (t) => {
  const f = fixture(t);
  const lease = await f.consume();
  f.hooks.securityCurrent = () => f.abort.abort();
  assert.throws(lease.assertCurrent, unavailable);
  await f.finish();
});

test("principal getters are captured once and cannot replace validated attribution", async (t) => {
  const f = fixture(t);
  const reads = { id: 0, issuer: 0, subject: 0 };
  const initial = { id: "principal-a", issuer: "issuer-a", subject: "subject-a" };
  for (const key of Object.keys(reads)) {
    Object.defineProperty(f.securityFacts.principal, key, {
      enumerable: true,
      get() {
        return ++reads[key] === 1 ? initial[key] : "unchecked-successor";
      },
    });
  }
  const lease = await f.consume();
  assert.equal(lease.principal.id, initial.id);
  assert.equal(lease.principal.issuer, initial.issuer);
  assert.equal(lease.principal.subject, initial.subject);
  assert.deepEqual(reads, { id: 1, issuer: 1, subject: 1 });
});

test("stale request retainer cannot satisfy a later security acquisition's cleanup", async (t) => {
  const f = fixture(t);
  let oldRetain;
  f.hooks.saveRequestRetainer = (retain) => {
    oldRetain = retain;
  };
  f.hooks.omitSecurityCleanup = true;
  f.hooks.beforeSecurityRegister = () => {
    assert.throws(() => oldRetain(() => f.events.push("stale.release")), unavailable);
  };
  await assert.rejects(f.consume(), unavailable);
  assert.equal(f.events.includes("stale.release"), false);
  assert.equal(f.requestHeld, true);
  await f.finish();
  assert.equal(f.requestHeld, false);
  // This deliberately nonconforming security producer supplied no release.
  // Refusal does not claim to recover custody it never transferred.
});

test("canonical Principal has no Installation property; original unit and request retain that scope", async (t) => {
  const f = fixture(t);
  assert.equal(Object.hasOwn(f.securityFacts.principal, "installationId"), false);
  const lease = await f.consume();
  assert.deepEqual(lease.principal, {
    id: "principal-a",
    kind: "principal",
    issuer: "issuer-a",
    subject: "subject-a",
  });
  assert.equal(f.unit.installationId, f.facts.installationId);
  lease.assertCurrent();
  await f.finish();
  assert.throws(() => lease.assertCurrent(), unavailable);
});
