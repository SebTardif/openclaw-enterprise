import assert from "node:assert/strict";
import { createNativeChannelAccountSourceV1 } from "../../../packages/occ/src/account-authority/native-channel.ts";
import { TurnCommandScopeV1 } from "../../../packages/occ/src/state/postgres/turn-command-scope.ts";
import { RepositoryTransactionLifetime } from "../../../packages/occ/src/ports/transaction.ts";
import { NativeIAMDriver, bindNativeIAMTransaction } from "../../../packages/iam/src/index.ts";

const uuid = "12345678-1234-4234-8234-123456789abc";

/**
 * Controlled participant ports around the actual transaction scope and actual
 * native IAM evaluator. No SQL, account persistence, native verifier or installed
 * authority is supplied. The explicit cleanup collection models only the central
 * port contract; it is not evidence for a PostgreSQL lock or central composition.
 */
export function accountFixture(options = {}) {
  const events = [];
  const controller = new AbortController();
  const now = Date.now();
  const deadline = new Date(now + 4000).toISOString();
  const identity = Object.freeze({
    installationId: `ins_${uuid}`,
    namespaceId: `ns_${uuid}`,
    agentId: `agt_${uuid}`,
    operationRef: "operation-a",
  });
  const bounds = Object.freeze({ signal: controller.signal, deadline });
  const transaction = new RepositoryTransactionLifetime();
  const scope = new TurnCommandScopeV1(transaction, identity, bounds);
  const invocation = Object.freeze({});
  const request = {
    schemaVersion: 1,
    installationId: identity.installationId,
    requestId: `req_${uuid}`,
    currentnessProfile: "account-currentness-v1",
    createdAt: new Date(now).toISOString(),
    deadline,
  };
  const sourceFacts = {
    platform: options.platform ?? "slack",
    installationId: identity.installationId,
    channelInstallationRef: `chi_${uuid}`,
    providerTenantRef: "provider-tenant",
    recipientAppRef: "recipient-app",
    providerSubjectRef: "human-sender",
    channelRef: "channel-a",
    recipientRef: "recipient-a",
    sourceInvocationRef: "invocation-a",
    sourceCredentialVersion: 11,
    sourceConfigurationVersion: 17,
    expiresAt: new Date(now + 3500).toISOString(),
  };
  const metadata = {
    installationId: identity.installationId,
    version: 3,
    status: "enabled",
    createdAt: new Date(now - 1000).toISOString(),
    updatedAt: new Date(now).toISOString(),
    createdBy: "principal-admin",
    updatedBy: "principal-admin",
  };
  const bindings = {
    parent: {
      ...metadata,
      id: sourceFacts.channelInstallationRef,
      platform: sourceFacts.platform,
      providerTenantRef: sourceFacts.providerTenantRef,
      recipientAppRef: sourceFacts.recipientAppRef,
    },
    human: {
      ...metadata,
      id: `chh_${uuid}`,
      channelInstallationId: sourceFacts.channelInstallationRef,
      providerSubjectRef: sourceFacts.providerSubjectRef,
      iamDriverId: "selected-native-iam",
      principalId: "principal-a",
      principalIssuer: "installation-account-issuer",
      principalSubject: "account-a",
    },
    agent: {
      ...metadata,
      id: `cha_${uuid}`,
      channelInstallationId: sourceFacts.channelInstallationRef,
      channelRef: sourceFacts.channelRef,
      scopeKind:
        sourceFacts.platform === "slack" ? "slack-private-channel" : "msteams-standard-channel",
      namespaceId: identity.namespaceId,
      agentId: identity.agentId,
    },
  };
  const securityFacts = {
    accountId: "account-a",
    principalId: bindings.human.principalId,
    principalIssuer: bindings.human.principalIssuer,
    principalSubject: bindings.human.principalSubject,
    accountState: "active",
    versions: {
      installation: 2,
      account: 7,
      credential: 11,
      grants: 13,
      iamPolicy: 19,
      semanticMapping: 23,
      driverSelection: 29,
    },
    selectedIAM: { driverId: bindings.human.iamDriverId, revision: 29 },
    expiresAt: new Date(now + 3000).toISOString(),
  };
  const iamState = {
    identities: [
      {
        id: securityFacts.principalId,
        kind: "principal",
        issuer: securityFacts.principalIssuer,
        subject: securityFacts.principalSubject,
      },
    ],
    groups: [],
    memberships: [],
    roles: [],
    bindings: [],
    restrictions: [],
  };
  let policyLocked = false;
  let parentsLocked = false;
  let located = false;
  let securityHeld = false;
  let securityCurrent = true;
  let sourceCurrent = true;
  let registered = false;
  let lease;
  let acquisitionUnit;
  let terminal;
  let closeWork;
  const cleanups = [];
  const hooks = {};
  const store = {
    async loadNativeIAMState() {
      throw new Error("The participant must use the original transactional IAM view.");
    },
    async loadNativeIAMStateInTransaction(token) {
      assert.equal(token, scope.unit);
      assert.equal(policyLocked, true);
      events.push("iam.load");
      return structuredClone(iamState);
    },
  };
  const driver = new NativeIAMDriver(store, { id: bindings.human.iamDriverId });
  const nativeIAM = bindNativeIAMTransaction(driver, store, scope.unit);

  async function withUnit(work) {
    let active = true;
    const assertActive = () => {
      if (!active) throw new Error("Acquisition callback IO is closed.");
      scope.assertOwned(scope.unit);
    };
    const unit = Object.freeze({
      token: scope.unit,
      identity,
      bounds,
      assertActive,
      iam: Object.freeze({
        assertCurrent() {
          assertActive();
          nativeIAM.assertCurrent();
        },
        async lookupIdentity(input) {
          assertActive();
          const result = await nativeIAM.lookupIdentity(input);
          assertActive();
          return result;
        },
        async authorize(input) {
          assertActive();
          const result = await nativeIAM.authorize(input);
          assertActive();
          return result;
        },
      }),
      async locateChannel(locator) {
        assertActive();
        assert.equal(located, false);
        assert.equal(policyLocked, false);
        assert.deepEqual(locator, {
          parentId: sourceFacts.channelInstallationRef,
          providerSubjectRef: sourceFacts.providerSubjectRef,
          channelRef: sourceFacts.channelRef,
        });
        located = true;
        events.push("locate");
        return structuredClone(bindings);
      },
      retainSecurityCleanup(release) {
        assertActive();
        assert.equal(policyLocked, false);
        assert.equal(registered, false);
        registered = true;
        cleanups.push(release);
        events.push("cleanup.register");
      },
      async lockPolicy() {
        assertActive();
        assert.equal(located, true);
        assert.equal(registered && securityHeld, true);
        assert.equal(policyLocked, false);
        events.push("policy.lock");
        await hooks.policy?.();
        assertActive();
        policyLocked = true;
      },
      async lockParentsAndReload() {
        assertActive();
        assert.equal(policyLocked, true);
        assert.equal(parentsLocked, false);
        events.push("parents.lock");
        await hooks.parents?.();
        assertActive();
        parentsLocked = true;
        return structuredClone(bindings);
      },
      async readLockedChannel() {
        assertActive();
        assert.equal(parentsLocked, true);
        events.push("parents.read");
        await hooks.read?.();
        assertActive();
        return structuredClone(bindings);
      },
    });
    try {
      return await work(unit);
    } finally {
      active = false;
    }
  }
  const invocationSource = {
    async inspect(candidate, unit) {
      unit.assertActive();
      if (candidate !== invocation || unit.token !== scope.unit || !sourceCurrent) return undefined;
      events.push("source.inspect");
      await hooks.inspect?.();
      return structuredClone(sourceFacts);
    },
    assertCurrent(candidate, token) {
      assert.equal(candidate, invocation);
      assert.equal(token, scope.unit);
      if (!sourceCurrent) throw new Error("Original invocation invalidated.");
      return hooks.sourceFence?.();
    },
  };
  const accountSecurity = {
    async acquire(unit, location, candidate, source) {
      unit.assertActive();
      assert.equal(policyLocked, false);
      assert.equal(candidate, invocation);
      assert.equal(source.sourceInvocationRef, sourceFacts.sourceInvocationRef);
      assert.deepEqual(location, {
        principalId: bindings.human.principalId,
        principalIssuer: bindings.human.principalIssuer,
        principalSubject: bindings.human.principalSubject,
        iamDriverId: bindings.human.iamDriverId,
      });
      events.push("security.acquire");
      securityHeld = true;
      unit.retainSecurityCleanup(async (outcome) => {
        events.push(`security.release:${outcome}`);
        assert.equal(securityHeld, true);
        securityHeld = false;
        registered = false;
      });
      await hooks.acquire?.();
      return {
        token: scope.unit,
        facts: securityFacts,
        assertOwned(token) {
          assert.equal(token, scope.unit);
          assert.equal(registered && securityHeld, true);
        },
        assertCurrent() {
          if (!securityCurrent || !securityHeld) throw new Error("Account writer invalidated.");
          return hooks.securityFence?.();
        },
        async prepareCommit(currentUnit) {
          currentUnit.assertActive();
          assert.equal(currentUnit.token, scope.unit);
          events.push("security.prepare");
          await hooks.securityPrepare?.();
          currentUnit.assertActive();
        },
      };
    },
  };
  const participantOptions = {
    invocation,
    request,
    recipientRef: "recipient-a",
    invocationSource,
    accountSecurity,
    ...options.participant,
  };
  function source() {
    return createNativeChannelAccountSourceV1(participantOptions);
  }
  async function enroll(selected = source()) {
    await scope.enroll({
      async consume(token) {
        assert.equal(token, scope.unit);
        return withUnit(async (unit) => {
          acquisitionUnit = unit;
          lease = await selected.consume(unit);
          if (!lease) return undefined;
          return {
            assertCurrent: lease.assertCurrent,
            prepareCommit: () => withUnit((current) => lease.prepareCommit(current)),
            release: (outcome) => lease.release(outcome),
          };
        });
      },
    });
    return lease;
  }
  async function finish(outcome = "rolled-back") {
    if (closeWork) {
      assert.equal(outcome, terminal);
      return closeWork;
    }
    terminal = outcome;
    closeWork = (async () => {
      try {
        await scope.finishTerminal(outcome);
      } finally {
        for (const cleanup of cleanups) await cleanup(outcome);
        transaction.close();
      }
    })();
    return closeWork;
  }
  return {
    events,
    sourceFacts,
    securityFacts,
    bindings,
    iamState,
    hooks,
    controller,
    identity,
    bounds,
    request,
    invocation,
    participantOptions,
    source,
    enroll,
    scope,
    withUnit,
    finish,
    acquisitionUnit: () => acquisitionUnit,
    retainedLease: () => lease,
    securityHeld: () => securityHeld,
    invalidateSource() {
      sourceCurrent = false;
    },
    invalidateAccount() {
      securityCurrent = false;
    },
    async dispose() {
      await finish(terminal ?? "rolled-back").catch(() => {});
    },
  };
}
