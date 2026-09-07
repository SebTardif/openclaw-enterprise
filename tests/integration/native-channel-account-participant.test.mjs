import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createNativeChannelAccountSourceV1 } from "../../packages/occ/src/account-authority/native-channel.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/errors.ts";
import { accountFixture } from "../fixtures/native-channel-account-participant/fixture.mjs";

function fixture(t, options) {
  const value = accountFixture(options);
  t.after(() => value.dispose());
  return value;
}

for (const platform of ["slack", "msteams"]) {
  test(
    platform +
      ": real scope and IAM evaluator retain a native diagnostic through fresh preparation",
    async (t) => {
      const f = fixture(t, { platform });
      const lease = await f.enroll();
      assert.equal(lease.observation.subject.credentialMode, "native-channel");
      assert.equal(lease.observation.subject.principalKind, "principal");
      assert.equal(lease.observation.subject.accountId, "account-a");
      assert.deepEqual(lease.observation.versions, f.securityFacts.versions);
      assert.equal(lease.observation.subject.nativeChannel.sourceCredentialVersion, 11);
      assert.equal(lease.observation.subject.nativeChannel.sourceConfigurationVersion, 17);
      // Canonical channel version is independently supplied; never equated to 17.
      assert.equal(lease.observation.subject.nativeChannel.channelInstallationVersion, 3);
      assert.equal(lease.observation.validUntil, f.securityFacts.expiresAt);
      assert.equal("session" in lease.observation.subject, false);
      assert.equal("key" in lease.observation.subject, false);
      assert.equal("invocation" in lease.observation.subject, false);
      assert.ok(Object.isFrozen(lease.observation.versions));
      assert.throws(() => f.acquisitionUnit().assertActive(), /closed/);
      assert.equal(lease.assertCurrent(), undefined);
      await f.scope.runOperation("currentness-read", async () => {
        assert.equal(lease.assertCurrent(), undefined);
      });
      await f.scope.prepareCommit();
      assert.equal(f.scope.assertCommitReady(), undefined);
      assert.ok(f.events.indexOf("security.acquire") < f.events.indexOf("policy.lock"));
      assert.ok(f.events.indexOf("cleanup.register") < f.events.indexOf("policy.lock"));
      assert.ok(f.events.indexOf("policy.lock") < f.events.indexOf("iam.load"));
      assert.ok(f.events.indexOf("iam.load") < f.events.indexOf("parents.lock"));
      assert.equal(f.events.filter((event) => event === "locate").length, 1);
      assert.equal(f.events.filter((event) => event === "parents.lock").length, 1);
      assert.equal(f.events.filter((event) => event === "parents.read").length, 1);
      f.scope.markCommitDispatched();
      f.scope.observeCommitAcknowledgement("COMMIT");
      await f.finish("committed");
      assert.equal(f.securityHeld(), false);
      assert.deepEqual(
        f.events.filter((event) => event.startsWith("security.release:")),
        ["security.release:committed"],
      );
      assert.throws(lease.assertCurrent, DependencyUnavailableError);
    },
  );
}

test("absent original source or account writer stays unavailable before any locator or policy work", async (t) => {
  for (const missing of ["invocationSource", "accountSecurity"]) {
    const f = fixture(t);
    const source = createNativeChannelAccountSourceV1({
      ...f.participantOptions,
      [missing]: undefined,
    });
    await assert.rejects(f.enroll(source), DependencyUnavailableError);
    assert.deepEqual(f.events, []);
  }
});

test("schema-valid facts cannot reconstruct the original opaque invocation", async (t) => {
  const f = fixture(t);
  const source = createNativeChannelAccountSourceV1({
    ...f.participantOptions,
    invocation: structuredClone(f.invocation),
  });
  await assert.rejects(f.enroll(source), DependencyUnavailableError);
  assert.equal(f.events.includes("locate"), false);
});

test("request is copied before later mutation and cannot extend original owner bounds", async (t) => {
  const f = fixture(t);
  const source = f.source();
  f.request.installationId = "changed";
  f.request.deadline = "2099-01-01T00:00:00.000Z";
  const lease = await f.enroll(source);
  assert.equal(lease.observation.installationId, f.identity.installationId);
  assert.ok(Date.parse(lease.observation.validUntil) <= Date.parse(f.bounds.deadline));
  const g = fixture(t);
  const later = new Date(Date.parse(g.bounds.deadline) + 1).toISOString();
  const invalid = createNativeChannelAccountSourceV1({
    ...g.participantOptions,
    request: { ...g.request, deadline: later },
  });
  await assert.rejects(g.enroll(invalid), DependencyUnavailableError);
  assert.deepEqual(g.events, []);
});

test("foreign recipient, tenant, sender or target never reaches account authority", async (t) => {
  for (const mutate of [
    (f) => {
      f.sourceFacts.recipientRef = "other-recipient";
    },
    (f) => {
      f.bindings.parent.providerTenantRef = "other-tenant";
    },
    (f) => {
      f.bindings.human.providerSubjectRef = "other-human";
    },
    (f) => {
      f.bindings.agent.agentId = "other-agent";
    },
    (f) => {
      f.bindings.agent.scopeKind = "unsupported-channel";
    },
  ]) {
    const f = fixture(t);
    mutate(f);
    await assert.rejects(f.enroll(), DependencyUnavailableError);
    assert.equal(f.events.includes("security.acquire"), false);
  }
});

test("locator is never followed to a replacement after the ordered parent lock", async (t) => {
  for (const mutate of [
    (f) => {
      f.bindings.human.version++;
    },
    (f) => {
      f.bindings.parent.status = "disabled";
    },
    (f) => {
      f.bindings.agent.agentId = "other-agent";
    },
  ]) {
    const f = fixture(t);
    f.hooks.parents = () => mutate(f);
    await assert.rejects(f.enroll(), DependencyUnavailableError);
    assert.equal(f.events.filter((event) => event === "locate").length, 1);
    assert.equal(f.securityHeld(), true);
    await f.finish().catch(() => {});
    assert.equal(f.securityHeld(), false);
  }
});

test("canonical local account and real versions are required without default epochs", async (t) => {
  for (const mutate of [
    (f) => {
      f.securityFacts.accountState = "disabled";
    },
    (f) => {
      f.securityFacts.accountId = "unrelated-account";
    },
    (f) => {
      f.securityFacts.selectedIAM.driverId = "replacement";
    },
    (f) => {
      f.securityFacts.versions.credential++;
    },
    (f) => {
      f.securityFacts.versions.account = 0;
    },
    (f) => {
      delete f.securityFacts.versions.semanticMapping;
    },
  ]) {
    const f = fixture(t);
    mutate(f);
    await assert.rejects(f.enroll(), DependencyUnavailableError);
    assert.equal(f.retainedLease(), undefined);
  }
});

test("actual IAM evaluation rejects a missing or changed human principal", async (t) => {
  for (const mutate of [
    (f) => {
      f.iamState.identities = [];
    },
    (f) => {
      f.iamState.identities[0].id = "another-principal";
    },
    (f) => {
      f.iamState.identities[0] = { id: "principal-a", kind: "service_principal" };
    },
  ]) {
    const f = fixture(t);
    mutate(f);
    await assert.rejects(f.enroll(), DependencyUnavailableError);
    assert.ok(f.events.includes("iam.load"));
    assert.equal(f.events.includes("parents.lock"), false);
  }
});

test("invalidation immediately after an awaited policy lock closes the participant", async (t) => {
  const f = fixture(t);
  f.hooks.policy = () => f.invalidateAccount();
  await assert.rejects(f.enroll(), DependencyUnavailableError);
  assert.equal(f.events.includes("parents.lock"), false);
  assert.equal(f.securityHeld(), true);
});

for (const kind of ["account", "source", "version", "abort"]) {
  test(
    "retained " + kind + " invalidation prevents an effect and final commit preparation",
    async (t) => {
      const f = fixture(t);
      const lease = await f.enroll();
      if (kind === "account") f.invalidateAccount();
      if (kind === "source") f.invalidateSource();
      if (kind === "version") f.securityFacts.versions.account++;
      if (kind === "abort") f.controller.abort();
      assert.throws(lease.assertCurrent, DependencyUnavailableError);
      let effect = false;
      await assert.rejects(
        f.scope.runOperation("journal-mutation", async () => {
          effect = true;
        }),
      );
      assert.equal(effect, false);
      await assert.rejects(f.scope.prepareCommit());
    },
  );
}

test("prepareCommit rechecks locked bindings and never refreshes a changed source generation", async (t) => {
  for (const mutate of [
    (f) => {
      f.bindings.human.version++;
    },
    (f) => {
      f.sourceFacts.sourceConfigurationVersion++;
    },
  ]) {
    const f = fixture(t);
    await f.enroll();
    mutate(f);
    await assert.rejects(f.scope.prepareCommit(), DependencyUnavailableError);
    assert.equal(f.securityHeld(), true);
    assert.equal(
      f.events.some((event) => event.startsWith("security.release:")),
      false,
    );
  }
});

test("prepareCommit rejects expired acquisition IO or another unit token", async (t) => {
  const f = fixture(t);
  const lease = await f.enroll();
  await assert.rejects(lease.prepareCommit(f.acquisitionUnit()), DependencyUnavailableError);
  const g = fixture(t);
  await assert.rejects(
    g.withUnit((unit) => lease.prepareCommit(unit)),
    DependencyUnavailableError,
  );
});

test("original native expiry cannot be reset by a later read", async (t) => {
  const f = fixture(t);
  f.sourceFacts.expiresAt = new Date(Date.now() - 1).toISOString();
  await assert.rejects(f.enroll(), DependencyUnavailableError);
  assert.equal(f.events.includes("locate"), false);
});

test("pre-policy acquired cleanup remains with owner when acquisition throws late", async (t) => {
  const f = fixture(t);
  f.hooks.acquire = () => {
    throw new Error("private-provider-failure-marker");
  };
  await assert.rejects(f.enroll(), (error) => {
    assert.ok(error instanceof DependencyUnavailableError);
    assert.equal(error.cause, undefined);
    assert.equal(error.message.includes("private-provider-failure-marker"), false);
    return true;
  });
  assert.equal(f.securityHeld(), true);
  assert.equal(f.events.includes("policy.lock"), false);
  assert.equal(
    f.events.some((event) => event.startsWith("security.release:")),
    false,
  );
  await f.finish().catch(() => {});
  assert.deepEqual(
    f.events.filter((event) => event.startsWith("security.release:")),
    ["security.release:rolled-back"],
  );
});

test("unknown commit preserves actual terminal outcome and closes local guard once", async (t) => {
  const f = fixture(t);
  const lease = await f.enroll();
  await f.scope.prepareCommit();
  f.scope.markCommitDispatched();
  await f.finish("commit-unknown");
  await f.finish("commit-unknown");
  assert.deepEqual(
    f.events.filter((event) => event.startsWith("security.release:")),
    ["security.release:commit-unknown"],
  );
  assert.throws(lease.assertCurrent, DependencyUnavailableError);
  await assert.rejects(lease.release("committed"), DependencyUnavailableError);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

for (const stage of ["acquisition", "preparation", "final-fence"]) {
  for (const outcome of ["resolve", "reject"]) {
    test(
      stage + ": rejected async fence drains " + outcome + " before original writer cleanup",
      async (t) => {
        const f = fixture(t);
        const pending = deferred();
        const started = deferred();
        const malformedFence = () => {
          started.resolve();
          return pending.promise;
        };
        let operation;
        if (stage === "acquisition") {
          f.hooks.securityFence = malformedFence;
          operation = f.enroll();
        } else {
          await f.enroll();
          if (stage === "preparation") {
            f.hooks.securityPrepare = () => {
              f.hooks.securityFence = malformedFence;
            };
            operation = f.scope.prepareCommit();
          } else {
            await f.scope.prepareCommit();
            f.hooks.securityFence = malformedFence;
            assert.throws(() => f.scope.assertCommitReady(), DependencyUnavailableError);
          }
        }
        // Observe the outer failure immediately, including a possible late reject.
        let operationSettled = false;
        const observed = operation?.then(
          () => {
            operationSettled = true;
            return undefined;
          },
          (error) => {
            operationSettled = true;
            return error;
          },
        );
        await started.promise;
        let terminalSettled = false;
        const terminal = f.finish().then(
          () => {
            terminalSettled = true;
            return undefined;
          },
          (error) => {
            terminalSettled = true;
            return error;
          },
        );
        await nextTurn();
        assert.equal(terminalSettled, false);
        if (stage !== "final-fence") assert.equal(operationSettled, false);
        assert.equal(f.securityHeld(), true);
        assert.equal(
          f.events.some((event) => event.startsWith("security.release:")),
          false,
        );
        if (outcome === "resolve") pending.resolve();
        else pending.reject(new Error("private-async-provider-marker"));
        if (observed) {
          const error = await observed;
          assert.ok(error instanceof DependencyUnavailableError);
          assert.equal(error.message.includes("private-async-provider-marker"), false);
          assert.equal(error.cause, undefined);
        }
        assert.ok((await terminal) instanceof DependencyUnavailableError);
        assert.equal(f.securityHeld(), false);
        assert.deepEqual(
          f.events.filter((event) => event.startsWith("security.release:")),
          ["security.release:rolled-back"],
        );
      },
    );
  }
}
