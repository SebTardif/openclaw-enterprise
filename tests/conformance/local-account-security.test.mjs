import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createLocalAccountSecuritySourceV1 } from "../../packages/occ/src/account-authority/local-account-security.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";

/** Controlled original-reader/other-domain ports exercise this real consumer.
 * No SQL, DML triggers, database privileges or native authentication run here. */
function fixture(t) {
  const events = [];
  const hooks = {};
  const abort = new AbortController();
  const identity = {
    installationId: "ins_12345678-1234-4234-8234-123456789abc",
    namespaceId: "ns_12345678-1234-4234-8234-123456789abc",
    agentId: "agt_12345678-1234-4234-8234-123456789abc",
    operationRef: "operation-a",
  };
  const issuer = "occ:installation:" + identity.installationId + ":better-auth";
  const location = {
    principalId: "principal-a",
    principalIssuer: issuer,
    principalSubject: "account-a",
    iamDriverId: "native-iam",
  };
  const now = Date.now();
  const bounds = { signal: abort.signal, deadline: new Date(now + 4000).toISOString() };
  const token = Object.freeze({ identity });
  const invocation = Object.freeze({});
  const source = {
    installationId: identity.installationId,
    sourceCredentialVersion: 11,
    expiresAt: new Date(now + 3500).toISOString(),
  };
  const record = {
    installationId: identity.installationId,
    accountId: "account-a",
    issuer,
    subject: "account-a",
    incarnation: "12345678-1234-4234-8234-123456789abc",
    state: "active",
    accountVersion: 7,
    currentUserId: "account-a",
    credentialAccountId: "credential-row-pk",
  };
  const domains = {
    versions: {
      installation: 2,
      credential: 11,
      grants: 13,
      iamPolicy: 17,
      semanticMapping: 19,
      driverSelection: 23,
    },
    selectedIAM: { driverId: "native-iam", revision: 23 },
    expiresAt: new Date(now + 3000).toISOString(),
  };
  let ioActive = false;
  let ownerActive = true;
  let recordHeld = false;
  let otherHeld = false;
  let cleanup;
  let lastUnit;
  let closeWork;
  const assertOwner = () => assert.ok(ownerActive, "owner closed");
  const assertIO = () => {
    assertOwner();
    assert.ok(ioActive, "callback closed");
  };
  async function withUnit(work, overrides = {}) {
    ioActive = true;
    const unit = {
      token,
      identity,
      bounds,
      assertActive: assertIO,
      retainSecurityCleanup(fn) {
        assertIO();
        assert.equal(cleanup, undefined);
        events.push("cleanup.register");
        cleanup = fn;
      },
      ...overrides,
    };
    lastUnit = unit;
    try {
      return await work(unit);
    } finally {
      ioActive = false;
    }
  }
  const local = {
    record,
    async prepareCommit() {
      assertIO();
      assert.ok(recordHeld);
      events.push("record.prepare");
      await hooks.recordPrepare?.();
    },
    assertCurrent() {
      assertOwner();
      assert.ok(recordHeld);
      return hooks.recordFence?.();
    },
    release() {
      events.push("record.release");
      recordHeld = false;
      return hooks.recordRelease?.();
    },
  };
  const reader = {
    async lock(lookup) {
      assertIO();
      assert.ok(cleanup);
      assert.deepEqual(lookup, {
        installationId: identity.installationId,
        accountId: "account-a",
        issuer,
        subject: "account-a",
      });
      events.push("record.lock");
      await hooks.recordLock?.();
      if (hooks.noRecord) return undefined;
      recordHeld = true;
      await hooks.afterRecord?.();
      return local;
    },
  };
  const other = {
    token,
    facts: domains,
    assertOwned(actual) {
      assert.equal(actual, token);
      assertOwner();
      assert.ok(otherHeld);
      return hooks.ownedFence?.();
    },
    assertCurrent() {
      assertOwner();
      assert.ok(otherHeld);
      return hooks.otherFence?.();
    },
    async prepareCommit(unit) {
      assertIO();
      assert.equal(unit.token, token);
      events.push("other.prepare");
      await hooks.otherPrepare?.();
    },
  };
  const otherDomains = {
    async acquire(unit, actualLocation, actualInvocation, actualSource, retainCleanup) {
      assertIO();
      assert.equal(unit.token, token);
      assert.equal(actualInvocation, invocation);
      assert.equal(actualLocation, location);
      assert.equal(actualSource, source);
      assert.ok(recordHeld);
      events.push("other.acquire");
      otherHeld = true;
      await hooks.beforeOtherRegistration?.();
      if (!hooks.skipRegistration)
        retainCleanup(async (outcome) => {
          events.push("other.release:" + outcome);
          otherHeld = false;
          await hooks.otherRelease?.();
        });
      otherHeld = true;
      await hooks.otherAcquire?.();
      return hooks.noOther ? undefined : other;
    },
  };
  const options = { reader, otherDomains };
  const participant = createLocalAccountSecuritySourceV1(options);
  async function acquire(selected = participant, overrides) {
    return withUnit((unit) => selected.acquire(unit, location, invocation, source), overrides);
  }
  function finish(outcome = "rolled-back") {
    if (closeWork) return closeWork;
    closeWork = (async () => {
      await cleanup?.(outcome);
      ownerActive = false;
    })();
    return closeWork;
  }
  t.after(() => (closeWork === undefined ? finish() : undefined));
  return {
    hooks,
    events,
    abort,
    record,
    domains,
    location,
    source,
    token,
    local,
    other,
    options,
    participant,
    acquire,
    finish,
    withUnit,
    lastUnit: () => lastUnit,
  };
}

test("only real account revision joins six explicitly supplied domains and original cleanup", async (t) => {
  const f = fixture(t);
  const lease = await f.acquire();
  assert.equal(lease.facts.versions.account, 7);
  assert.equal(lease.facts.accountId, "account-a");
  assert.deepEqual(
    Object.fromEntries(Object.entries(lease.facts.versions).filter(([key]) => key !== "account")),
    f.domains.versions,
  );
  assert.equal("credentialAccountId" in lease.facts, false);
  assert.equal("incarnation" in lease.facts, false);
  assert.ok(Object.isFrozen(lease.facts.versions));
  assert.throws(() => f.lastUnit().assertActive(), /callback closed/);
  assert.equal(lease.assertCurrent(), undefined);
  await f.withUnit((unit) => lease.prepareCommit(unit));
  assert.deepEqual(f.events.slice(0, 3), ["cleanup.register", "record.lock", "other.acquire"]);
  await f.finish("committed");
  await f.finish("committed");
  assert.equal(f.events.filter((event) => event === "record.release").length, 1);
  assert.equal(f.events.filter((event) => event === "other.release:committed").length, 1);
  assert.throws(lease.assertCurrent, DependencyUnavailableError);
});

test("missing reader or any genuine other-domain producer refuses before acquisition", async (t) => {
  for (const missing of ["reader", "otherDomains"]) {
    const f = fixture(t);
    const source = createLocalAccountSecuritySourceV1({ ...f.options, [missing]: undefined });
    assert.equal(await f.acquire(source), undefined);
    assert.deepEqual(f.events, []);
  }
});

for (const state of ["provisioning", "deleted"]) {
  test(state + " is unavailable and never promoted by user presence", async (t) => {
    const f = fixture(t);
    f.record.state = state;
    assert.equal(await f.acquire(), undefined);
    assert.equal(f.events.includes("other.acquire"), false);
    await f.finish();
    assert.equal(f.events.includes("record.release"), true);
  });
}

test("missing record stays unavailable without a synthetic initial version", async (t) => {
  const f = fixture(t);
  f.hooks.noRecord = true;
  assert.equal(await f.acquire(), undefined);
  assert.equal(f.events.includes("other.acquire"), false);
});

test("exact canonical account, issuer, live user and credential-row identity are required", async (t) => {
  for (const field of [
    "installationId",
    "accountId",
    "issuer",
    "subject",
    "currentUserId",
    "credentialAccountId",
    "incarnation",
  ]) {
    const f = fixture(t);
    f.record[field] = field === "credentialAccountId" || field === "incarnation" ? null : "foreign";
    assert.equal(await f.acquire(), undefined);
    assert.equal(f.events.includes("other.acquire"), false);
  }
});

test("unsafe or missing account revisions are never coerced", async (t) => {
  for (const value of [undefined, 0, -1, 1.5, "7", Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture(t);
    f.record.accountVersion = value;
    assert.equal(await f.acquire(), undefined);
  }
});

test("unknown record secret fields are rejected instead of copied", async (t) => {
  const f = fixture(t);
  f.record.password = "synthetic-private";
  assert.equal(await f.acquire(), undefined);
});

test("every other-domain revision is bounded and remains an independent required input", async (t) => {
  for (const field of [
    "installation",
    "credential",
    "grants",
    "iamPolicy",
    "semanticMapping",
    "driverSelection",
  ]) {
    const f = fixture(t);
    delete f.domains.versions[field];
    await assert.rejects(f.acquire(), DependencyUnavailableError);
  }
});

test("credential source and selected-driver revisions cannot be replaced with account metadata", async (t) => {
  for (const change of [
    (f) => {
      f.domains.versions.credential = 7;
    },
    (f) => {
      f.domains.selectedIAM.revision = 7;
    },
    (f) => {
      f.domains.selectedIAM.driverId = "other-driver";
    },
    (f) => {
      f.domains.versions.account = 7;
    },
  ]) {
    const f = fixture(t);
    change(f);
    await assert.rejects(f.acquire(), DependencyUnavailableError);
  }
});

test("wrong issuer or Installation refuses before record acquisition", async (t) => {
  for (const change of [
    (f) => {
      f.location.principalIssuer = "browser-session";
    },
    (f) => {
      f.source.installationId = "foreign";
    },
  ]) {
    const f = fixture(t);
    change(f);
    assert.equal(await f.acquire(), undefined);
    assert.deepEqual(f.events, []);
  }
});

test("reader result returned after abort is still retained for original terminal closure", async (t) => {
  const f = fixture(t);
  f.hooks.afterRecord = () => f.abort.abort();
  await assert.rejects(f.acquire(), DependencyUnavailableError);
  await f.finish();
  assert.equal(f.events.includes("record.release"), true);
});

test("other guard cleanup survives acquisition failure after registration", async (t) => {
  const f = fixture(t);
  f.hooks.otherAcquire = () => {
    throw new Error("synthetic bearer must not escape");
  };
  await assert.rejects(
    f.acquire(),
    (error) => error instanceof DependencyUnavailableError && !String(error).includes("bearer"),
  );
  assert.equal(
    f.events.some((event) => event.startsWith("other.release")),
    false,
  );
  await f.finish("commit-unknown");
  assert.equal(f.events.includes("other.release:commit-unknown"), true);
  assert.equal(f.events.includes("record.release"), true);
});

test("a guard without actual cleanup enrollment cannot become positive", async (t) => {
  const f = fixture(t);
  f.hooks.skipRegistration = true;
  await assert.rejects(f.acquire(), DependencyUnavailableError);
});

test("record version, incarnation, identity and state changes fail preparation", async (t) => {
  for (const change of [
    (f) => {
      f.record.accountVersion += 1;
    },
    (f) => {
      f.record.incarnation = "different-incarnation";
    },
    (f) => {
      f.record.subject = "different-subject";
    },
    (f) => {
      f.record.state = "provisioning";
    },
  ]) {
    const f = fixture(t);
    const lease = await f.acquire();
    f.hooks.recordPrepare = () => change(f);
    await assert.rejects(
      f.withUnit((unit) => lease.prepareCommit(unit)),
      DependencyUnavailableError,
    );
  }
});

test("other-domain currentness changes fail preparation without updating the captured vector", async (t) => {
  const f = fixture(t);
  const lease = await f.acquire();
  f.hooks.otherPrepare = () => {
    f.domains.versions.grants += 1;
  };
  await assert.rejects(
    f.withUnit((unit) => lease.prepareCommit(unit)),
    DependencyUnavailableError,
  );
  assert.equal(lease.facts.versions.grants, 13);
});

test("fresh callback requires the original token and original deadline", async (t) => {
  for (const override of [
    (f) => ({ token: Object.freeze({}) }),
    (f) => ({ bounds: { ...f.lastUnit().bounds, deadline: "2099-01-01T00:00:00.000Z" } }),
  ]) {
    const f = fixture(t);
    const lease = await f.acquire();
    await assert.rejects(
      f.withUnit((unit) => lease.prepareCommit(unit), override(f)),
      DependencyUnavailableError,
    );
  }
});

test("one bound source cannot be acquired again for another command", async (t) => {
  const f = fixture(t);
  await f.acquire();
  await assert.rejects(f.acquire(), DependencyUnavailableError);
});

test("cleanup attempts every enrolled release even if another fails", async (t) => {
  const f = fixture(t);
  await f.acquire();
  f.hooks.otherRelease = () => {
    throw new Error("synthetic cleanup failure");
  };
  await assert.rejects(f.finish(), DependencyUnavailableError);
  assert.equal(f.events.includes("record.release"), true);
  // The original terminal already observed this expected failure.
  f.hooks.otherRelease = undefined;
});

for (const stage of ["acquire", "prepare", "final"]) {
  for (const settlement of ["resolve", "reject"]) {
    test(
      stage +
        " malformed asynchronous fence is drained before original writer cleanup: " +
        settlement,
      async (t) => {
        const f = fixture(t);
        let settle;
        const pending = new Promise((resolve, reject) => {
          settle = () =>
            settlement === "resolve" ? resolve() : reject(new Error("synthetic secret"));
        });
        const badFence = () => pending;
        let lease;
        if (stage !== "acquire") lease = await f.acquire();
        f.hooks.recordFence = badFence;
        let work;
        if (stage === "acquire") work = f.acquire();
        else if (stage === "prepare") work = f.withUnit((unit) => lease.prepareCommit(unit));
        else {
          assert.throws(lease.assertCurrent, DependencyUnavailableError);
          work = f.finish();
        }
        let settled = false;
        const observed = Promise.resolve(work).then(
          () => {
            settled = true;
          },
          (error) => {
            settled = true;
            assert.ok(error instanceof DependencyUnavailableError);
          },
        );
        await nextTurn();
        assert.equal(settled, false);
        assert.equal(f.events.includes("record.release"), false);
        settle();
        await observed;
        if (stage !== "final") await f.finish();
        assert.equal(f.events.includes("record.release"), true);
      },
    );
  }
}

for (const invalidation of ["abort", "expiry"]) {
  test(
    "already acquired other-domain guard is retained when " +
      invalidation +
      " precedes registration",
    async (t) => {
      const f = fixture(t);
      const originalNow = Date.now;
      f.hooks.beforeOtherRegistration = () => {
        if (invalidation === "abort") f.abort.abort();
        else Date.now = () => Date.parse(f.lastUnit().bounds.deadline) + 1;
      };
      try {
        await assert.rejects(f.acquire(), DependencyUnavailableError);
      } finally {
        Date.now = originalNow;
      }
      assert.equal(
        f.events.some((event) => event.startsWith("other.release:")),
        false,
      );
      await f.finish("rolled-back");
      assert.equal(f.events.filter((event) => event === "other.release:rolled-back").length, 1);
      assert.equal(f.events.filter((event) => event === "record.release").length, 1);
    },
  );
}
