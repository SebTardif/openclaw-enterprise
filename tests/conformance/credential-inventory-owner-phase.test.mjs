import assert from "node:assert/strict";
import test from "node:test";
import { CredentialInventoryOwnerPhaseV1 } from "../../packages/occ/src/credential-inventory-v1/phase.ts";
import { ScopeViolationError } from "../../packages/occ/src/errors.ts";

// These exercise the actual execution phase. Boolean acceptance callbacks are
// scheduling inputs, not evidence of authentic authority, custody or database work.
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const isFailure = (expected) => (actual) => {
  assert.equal(actual, expected);
  return true;
};
async function finalize(phase) {
  await phase.drainAccepted();
  await phase.runFinalization(async () => {
    phase.assertOperationActive();
  });
  await phase.drainAccepted();
  phase.assertCommitReady();
}

test("admitted operations serialize and keep query permission through callback closure", async () => {
  const phase = new CredentialInventoryOwnerPhaseV1();
  const resume = deferred();
  const steps = [];
  let first;
  let second;
  const result = await phase.runTransition(async () => {
    phase.assertActive();
    assert.equal(
      await phase.runAcceptance(async () => {
        phase.assertOperationActive();
        return true;
      }),
      true,
    );
    first = phase.runOperation(async () => {
      phase.assertOperationActive();
      steps.push("first query");
      await resume.promise;
      phase.assertOperationActive();
      steps.push("second query");
    });
    second = phase.runOperation(async () => {
      phase.assertOperationActive();
      steps.push("next operation");
    });
    return "provisional";
  });
  assert.equal(result, "provisional");
  assert.deepEqual(steps, ["first query"]);
  let drained = false;
  const draining = phase.drainAccepted().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  resume.resolve();
  await draining;
  await Promise.all([first, second]);
  assert.deepEqual(steps, ["first query", "second query", "next operation"]);
  await finalize(phase);
  phase.close();
  assert.throws(() => phase.assertActive(), ScopeViolationError);
});

for (const failure of [new Error("decode failed after an effect"), undefined]) {
  test(`caught failure remains the first failure (${failure === undefined ? "undefined" : "Error"})`, async () => {
    const phase = new CredentialInventoryOwnerPhaseV1();
    const steps = [];
    await assert.rejects(
      phase.runTransition(async () => {
        await phase.runAcceptance(async () => true);
        try {
          await phase.runOperation(async () => {
            steps.push("effect finished");
            throw failure;
          });
        } catch {
          // Returning an ordinary conflict cannot clear an already failed body.
        }
        phase.poison(new Error("later cleanup error"));
        return { kind: "conflict" };
      }),
      isFailure(failure),
    );
    await assert.rejects(phase.drainAccepted(), isFailure(failure));
    assert.deepEqual(steps, ["effect finished"]);
    assert.throws(() => phase.assertCommitReady(), isFailure(failure));
  });
}

test("ignored rejection is observed and queued operations start no later effects", async () => {
  const phase = new CredentialInventoryOwnerPhaseV1();
  const resume = deferred();
  const failure = new Error("custody continuation failed");
  let laterEffects = 0;
  await phase.runTransition(async () => {
    await phase.runAcceptance(async () => true);
    void phase.runOperation(async () => {
      await resume.promise;
      throw failure;
    });
    void phase.runOperation(async () => {
      laterEffects += 1;
    });
  });
  const draining = assert.rejects(phase.drainAccepted(), isFailure(failure));
  resume.resolve();
  await draining;
  assert.equal(laterEffects, 0);
  assert.throws(() => phase.assertCommitReady(), isFailure(failure));
});

test("late registration during drainage poisons while accepted work still settles", async () => {
  const phase = new CredentialInventoryOwnerPhaseV1();
  const resume = deferred();
  let settled = false;
  let lateRan = false;
  await phase.runTransition(async () => {
    await phase.runAcceptance(async () => true);
    void phase.runOperation(async () => {
      await resume.promise;
      settled = true;
      phase.assertOperationActive();
    });
  });
  const draining = assert.rejects(phase.drainAccepted(), ScopeViolationError);
  await assert.rejects(
    phase.runOperation(async () => {
      lateRan = true;
    }),
    ScopeViolationError,
  );
  assert.equal(settled, false);
  resume.resolve();
  await draining;
  assert.equal(settled, true);
  assert.equal(lateRan, false);
});

test("only one literal boolean acceptance can open transaction methods", async () => {
  const denied = new CredentialInventoryOwnerPhaseV1();
  await denied.runTransition(async () => {
    assert.equal(await denied.runAcceptance(async () => false), false);
  });
  await finalize(denied);

  for (const value of [false, "accepted", {}]) {
    const phase = new CredentialInventoryOwnerPhaseV1();
    let ran = false;
    await assert.rejects(
      phase.runTransition(async () => {
        await phase.runAcceptance(async () => value);
        await phase.runOperation(async () => {
          ran = true;
        });
      }),
      ScopeViolationError,
    );
    assert.equal(ran, false);
    await assert.rejects(phase.drainAccepted(), ScopeViolationError);
  }

  const twice = new CredentialInventoryOwnerPhaseV1();
  await assert.rejects(
    twice.runTransition(async () => {
      await twice.runAcceptance(async () => true);
      await twice.runAcceptance(async () => true).catch(() => {});
    }),
    ScopeViolationError,
  );
});

test("preaccept operations and direct query access outside an admitted body poison", async () => {
  const before = new CredentialInventoryOwnerPhaseV1();
  let ran = false;
  await assert.rejects(
    before.runTransition(async () => {
      await before.runOperation(async () => {
        ran = true;
      });
    }),
    ScopeViolationError,
  );
  assert.equal(ran, false);
  const outside = new CredentialInventoryOwnerPhaseV1();
  outside.assertActive();
  assert.throws(() => outside.assertOperationActive(), ScopeViolationError);
  await assert.rejects(outside.drainAccepted(), ScopeViolationError);
});

test("self-queued operations reject without blocking the accepted body's drain", async () => {
  const phase = new CredentialInventoryOwnerPhaseV1();
  let nestedRan = false;
  await assert.rejects(
    phase.runTransition(async () => {
      await phase.runAcceptance(async () => true);
      await phase.runOperation(async () => {
        await phase.runOperation(async () => {
          nestedRan = true;
        });
      });
    }),
    ScopeViolationError,
  );
  await assert.rejects(phase.drainAccepted(), ScopeViolationError);
  assert.equal(nestedRan, false);
});

test("detached async continuations lose query permission when their body settles", async () => {
  const phase = new CredentialInventoryOwnerPhaseV1();
  const resume = deferred();
  let detached;
  await phase.runTransition(async () => {
    await phase.runAcceptance(async () => true);
    await phase.runOperation(async () => {
      detached = resume.promise.then(() => phase.assertOperationActive());
      void detached.catch(() => {});
    });
  });
  await phase.drainAccepted();
  resume.resolve();
  await assert.rejects(detached, ScopeViolationError);
  await assert.rejects(phase.drainAccepted(), ScopeViolationError);
});

test("finalization is required, can query after admission closes and preserves failure", async () => {
  const incomplete = new CredentialInventoryOwnerPhaseV1();
  await incomplete.runTransition(async () => {
    await incomplete.runAcceptance(async () => true);
  });
  await incomplete.drainAccepted();
  assert.throws(() => incomplete.assertCommitReady(), ScopeViolationError);

  const phase = new CredentialInventoryOwnerPhaseV1();
  const failure = new Error("incomplete audit correspondence");
  await phase.runTransition(async () => {
    await phase.runAcceptance(async () => true);
    return { kind: "denied" };
  });
  await phase.drainAccepted();
  await assert.rejects(
    phase.runFinalization(async () => {
      phase.assertOperationActive();
      await Promise.resolve();
      phase.assertOperationActive();
      throw failure;
    }),
    isFailure(failure),
  );
  await assert.rejects(phase.drainAccepted(), isFailure(failure));
  assert.throws(() => phase.assertCommitReady(), isFailure(failure));
});

test("independent phases retain separate async operation permission", async () => {
  const phases = [new CredentialInventoryOwnerPhaseV1(), new CredentialInventoryOwnerPhaseV1()];
  const ready = phases.map(() => deferred());
  await Promise.all(
    phases.map((phase, index) =>
      phase.runTransition(async () => {
        await phase.runAcceptance(async () => true);
        await phase.runOperation(async () => {
          phase.assertOperationActive();
          ready[index].resolve();
          await ready[1 - index].promise;
          phase.assertOperationActive();
        });
      }),
    ),
  );
  await Promise.all(phases.map((phase) => finalize(phase)));
});
