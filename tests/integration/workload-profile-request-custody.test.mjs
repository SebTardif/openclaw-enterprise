import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { ControllerAdmissionVerifier } from "../../apps/controller/src/auth/index.ts";
import { createHttpAdmission } from "../../apps/controller/src/http/admission.ts";
import { requestFailure, failure } from "../../apps/controller/src/http/errors.ts";
import { createIdentityResolver } from "../../apps/controller/src/http/identity.ts";
import { createControllerWorkloadProfileSessionSecurityV1 } from "../../apps/controller/src/auth/workload-profile-session-security.ts";
import { createWorkloadProfilePurposeAccountParticipantV1 } from "../../packages/occ/src/account-authority/workload-profile.ts";

// Actual controller capture/admission/custody/security and account consumer,
// with controlled verifier-result, identity and transaction-reader collaborators.
// No BetterAuth provider/login, listener, database, SQL, policy write or deployment
// runs here. The synthetic record proves adapter behavior, not writer exclusion.
const deployment = "workload-profile-deployment";
const draft = "workload-profile-draft-selection";
const recovery = "workload-profile-deployment-recovery";
const unavailable = (error) => error instanceof Error && /unavailable/.test(error.message);
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(t, options = {}) {
  const hooks = {},
    events = [],
    requests = [];
  const installationId = "ins-controller-custody-fixture";
  const issuer = `occ:installation:${installationId}:better-auth`;
  const accountId = "account-fixture",
    principalId = "principal-fixture";
  const origin = "https://controller.example.invalid";
  let recipient = {},
    currentDriver;
  let verifiedCalls = 0;
  const session = {
    id: "session-fixture",
    userId: accountId,
    token: "controlled-session-credential",
    expiresAt: new Date(Date.now() + 60000),
  };
  const actualResult = { response: { session, user: { id: accountId } } };
  const auth = {
    api: {
      async getSession(input) {
        verifiedCalls += 1;
        assert.deepEqual(input.query, { disableCookieCache: true, disableRefresh: true });
        assert.equal(input.asResponse, false);
        assert.equal(input.returnHeaders, true);
        events.push("verifier.enter");
        await hooks.verify?.();
        events.push("verifier.return");
        return hooks.result ? hooks.result() : actualResult;
      },
      async verifyApiKey() {
        return {
          valid: true,
          key: {
            id: "key-fixture",
            configId: "occ-service",
            referenceId: "service-fixture",
            metadata: { installationId },
            name: "fixture",
            expiresAt: new Date(Date.now() + 60000),
          },
        };
      },
    },
  };
  const verifier = new ControllerAdmissionVerifier(auth, installationId);
  const custody = verifier.createWorkloadProfileRequestCustodyV1({
    maxRequestLifetimeMs: options.maxMs ?? 30000,
  });
  // This is the same source captured before the app's maps exist.
  const construction = { invocations: custody.invocations, requests: custody.requests };
  const admissions = new WeakMap(),
    contexts = new WeakMap(),
    identityAuthorities = new WeakMap();
  const driver = {
    id: "iam-fixture",
    async lookupIdentity(input) {
      if (input.servicePrincipalId)
        return { kind: "service_principal", id: input.servicePrincipalId, installationId };
      assert.deepEqual(input, { issuer, subject: accountId });
      return { kind: "principal", id: principalId, issuer, subject: accountId };
    },
  };
  currentDriver = driver;
  const receiver = {
    admissions,
    contexts,
    identityAuthorities,
    resolveRecipient: () => recipient,
    selectedIAMDriver: () => currentDriver,
  };
  if (!options.unattached) custody.attachReceiver(receiver);
  const operation = { operationId: options.operation ?? "deployAgent" };
  const admission = createHttpAdmission({
    development: { enabled: false },
    installationId,
    publicOrigin: origin,
    admissions,
    verifyAdmission: verifier.verify.bind(verifier),
    workloadProfileRequests: custody,
    async denial() {
      events.push("denial");
    },
  });
  const identity = createIdentityResolver({
    admissions,
    contexts,
    selectedIAMDriver: () => currentDriver,
    recordIdentityAuthority: (request, authority) => identityAuthorities.set(request, authority),
    async denial() {
      events.push("identity.denial");
    },
  });
  function request() {
    const raw = new EventEmitter();
    raw.aborted = false;
    raw.socket = { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" };
    const value = {
      id: `request-${requests.length}`,
      method: "POST",
      raw,
      params: {},
      query: {},
      headers: { host: "controller.example.invalid", origin, cookie: "controlled-cookie" },
    };
    requests.push(value);
    return value;
  }
  const req = request();
  t.after(() => {
    for (const value of requests) custody.closeRequest(value);
  });
  async function admit(value = req) {
    await admission.admit(value, operation, "ordinary");
    await identity(value, operation);
  }
  function purpose(kind = deployment) {
    return {
      purpose: kind,
      binding: [
        principalId,
        kind === draft
          ? { namespaceId: "namespace-fixture", agentId: "agent-fixture", name: "draft" }
          : {
              namespaceId: "namespace-fixture",
              agentId: "agent-fixture",
              command: {
                version: 2,
                operationRef: "operation-fixture",
                expectedLifecycleGeneration: 7,
              },
            },
      ],
    };
  }
  function owner() {
    const abort = new AbortController();
    let active = true,
      acquiring = true,
      terminal,
      released = false;
    const pending = new Set();
    const assertOuter = () => {
      if (!active || abort.signal.aborted) throw new Error("owner unavailable");
    };
    const assertAcquiring = () => {
      assertOuter();
      if (!acquiring) throw new Error("IO unavailable");
    };
    const unit = {
      installationId,
      signal: abort.signal,
      retainSecurityCleanup(callback) {
        assertAcquiring();
        assert.equal(terminal, undefined);
        terminal = callback;
        events.push("terminal.register");
      },
      async query(statement, parameters) {
        assertAcquiring();
        events.push("reader.query");
        assert.equal(statement, "controlled profile-session read");
        assert.deepEqual(parameters, [installationId, accountId, session.id]);
        await hooks.query?.();
        assertAcquiring();
        return { rows: [], rowCount: 0 };
      },
    };
    const source = {
      bind(received, cleanup) {
        assert.equal(received, unit);
        unit.retainSecurityCleanup(cleanup);
        return {
          assertAcquiring,
          assertCurrent: assertOuter,
          retainAccepted(task) {
            pending.add(task);
            void task.then(
              () => pending.delete(task),
              () => pending.delete(task),
            );
          },
        };
      },
    };
    async function drain() {
      while (pending.size) await Promise.all([...pending]);
    }
    async function finish() {
      if (released) return;
      released = true;
      await drain();
      events.push("database.cleanup");
      terminal?.();
      await drain();
      events.push("terminal.return");
      active = false;
    }
    t.after(finish);
    return {
      unit,
      source,
      abort,
      finish,
      assertOuter,
      seal: () => {
        acquiring = false;
      },
      endOwner: () => {
        active = false;
      },
      pending,
    };
  }
  function security(transaction, supplied = {}) {
    let seen;
    const reader = {
      async lock(unit, lookup) {
        assert.equal(unit, transaction.unit);
        seen = lookup;
        assert.deepEqual(lookup, {
          installationId,
          accountId,
          issuer,
          subject: accountId,
          sessionId: session.id,
          sessionCredentialDigest: digest(session.token),
        });
        assert.ok(Object.isFrozen(lookup));
        await unit.query("controlled profile-session read", [
          installationId,
          accountId,
          session.id,
        ]);
        const value = {
          installationId,
          accountId,
          issuer,
          subject: accountId,
          incarnation: "incarnation-fixture",
          accountVersion: 8,
          state: "active",
          currentUserId: accountId,
          credentialAccountId: "credential-fixture",
          sessionId: session.id,
          sessionUserId: accountId,
          sessionCredentialDigest: digest(session.token),
          expiresAt: session.expiresAt.toISOString(),
          assertCurrent() {
            transaction.assertOuter();
            return hooks.readerFence?.();
          },
          release() {
            events.push("reader.release");
            return hooks.readerRelease?.();
          },
          ...supplied,
        };
        return hooks.readerResult ? hooks.readerResult(value) : value;
      },
    };
    return {
      source: createControllerWorkloadProfileSessionSecurityV1({ requests: custody, reader }),
      lookup: () => seen,
    };
  }
  async function acquire(transaction, input, selectedSecurity = security(transaction).source) {
    const participant = createWorkloadProfilePurposeAccountParticipantV1({
      owner: transaction.source,
      requests: custody.requests,
      security: selectedSecurity,
    });
    const handle = await custody.invocations.forCurrentInvocation();
    return participant.consume(handle, input, transaction.unit);
  }
  return {
    hooks,
    events,
    installationId,
    issuer,
    accountId,
    principalId,
    session,
    verifier,
    custody,
    construction,
    receiver,
    admissions,
    contexts,
    identityAuthorities,
    driver,
    req,
    request,
    admit,
    operation,
    admission,
    identity,
    purpose,
    owner,
    security,
    acquire,
    verifiedCalls: () => verifiedCalls,
    replaceRecipient: () => {
      recipient = {};
    },
    replaceDriver: () => {
      currentDriver = { ...driver };
    },
  };
}

for (const kind of [deployment, draft, recovery])
  test(`actual private issuer consumes only ${kind}`, async (t) => {
    const f = fixture(t, { operation: kind === draft ? "updateAgent" : "deployAgent" });
    await f.admit();
    assert.equal(f.construction.invocations, f.custody.invocations);
    const tx = f.owner(),
      input = f.purpose(kind);
    await f.custody.withWorkloadProfileInvocation(f.req, input, async () => {
      const lease = await f.acquire(tx, input);
      assert.equal(lease.principal.id, f.principalId);
      assert.equal(lease.accountRef, f.accountId);
      assert.equal(lease.requestId, f.req.id);
      tx.seal();
      lease.assertCurrent(); // Final fence uses outer owner, not expired acquisition IO.
      lease.release();
      assert.equal(f.events.includes("reader.release"), false);
      await tx.finish();
    });
    assert.ok(f.events.indexOf("database.cleanup") < f.events.indexOf("reader.release"));
    assert.equal(f.events.filter((e) => e === "terminal.register").length, 1);
    assert.equal(f.events.filter((e) => e === "reader.release").length, 1);
  });

test("construction is stable and fails closed before one actual receiver attachment", async (t) => {
  const f = fixture(t, { unattached: true });
  await assert.rejects(f.custody.invocations.forCurrentInvocation(), unavailable);
  assert.throws(() => f.custody.beginRequest(f.req), unavailable);
  f.custody.attachReceiver(f.receiver);
  assert.throws(() => f.custody.attachReceiver(f.receiver), unavailable);
  assert.throws(
    () => f.verifier.createWorkloadProfileRequestCustodyV1({ maxRequestLifetimeMs: 5000 }),
    /already exists/,
  );
  await f.admit();
});
test("response close before begin is a permanent negative entry", async (t) => {
  const f = fixture(t);
  f.custody.closeRequest(f.req);
  f.custody.closeRequest(f.req);
  await assert.rejects(f.admit(), unavailable);
  assert.equal(f.verifiedCalls(), 0);
});
test("already aborted begin closes listeners and cannot restart", async (t) => {
  const f = fixture(t);
  f.req.raw.aborted = true;
  await assert.rejects(f.admit(), unavailable);
  assert.equal(f.req.raw.listenerCount("aborted"), 0);
  f.req.raw.aborted = false;
  assert.throws(() => f.custody.beginRequest(f.req), unavailable);
});
test("close while actual verifier is pending cannot revive capture", async (t) => {
  const f = fixture(t),
    gate = deferred();
  f.hooks.verify = () => gate.promise;
  const admitted = f.admit();
  await nextTurn();
  f.custody.closeRequest(f.req);
  gate.resolve();
  await assert.rejects(admitted, unavailable);
  await assert.rejects(
    f.custody.withWorkloadProfileInvocation(f.req, f.purpose(), async () => {}),
    unavailable,
  );
});
test("configured Origin failure closes private custody after actual verification", async (t) => {
  const f = fixture(t);
  f.req.headers.origin = "https://other.example.invalid";
  await assert.rejects(f.admit(), (error) => error.status === 403 || error.statusCode === 403);
  assert.equal(f.verifiedCalls(), 1);
  f.req.headers.origin = "https://controller.example.invalid";
  await assert.rejects(f.admit(), unavailable);
});
test("public admission has no session credential or private digest", async (t) => {
  const f = fixture(t);
  await f.admit();
  const caller = f.admissions.get(f.req);
  assert.deepEqual(Object.keys(caller).sort(), [
    "admittedScope",
    "decisionId",
    "externalIdentity",
    "method",
  ]);
  assert.equal(JSON.stringify(caller).includes(f.session.token), false);
  assert.equal(JSON.stringify(caller).includes(digest(f.session.token)), false);
  const tx = f.owner(),
    input = f.purpose();
  await f.custody.withWorkloadProfileInvocation(f.req, input, async () => {
    const handle = await f.custody.invocations.forCurrentInvocation();
    assert.deepEqual(Reflect.ownKeys(handle), []);
    let cleanup;
    const request = await f.custody.requests.consume(handle, input, tx.unit, (value) => {
      cleanup = value;
    });
    assert.equal(JSON.stringify(request.facts).includes(digest(f.session.token)), false);
    assert.equal(
      f.custody.resolveConsumedSession(request, tx.unit).sessionCredentialDigest,
      digest(f.session.token),
    );
    cleanup();
    assert.throws(() => f.custody.resolveConsumedSession(request, tx.unit), unavailable);
  });
});
for (const field of ["id", "userId", "token"])
  test(`incomplete actual session ${field} does not create request authority`, async (t) => {
    const f = fixture(t);
    delete f.session[field];
    await f.admit();
    assert.equal(f.admissions.get(f.req).method, "session");
    await assert.rejects(
      f.custody.withWorkloadProfileInvocation(f.req, f.purpose(), async () => {}),
      unavailable,
    );
  });
test("a cloned verifier result cannot consume the original private session capture", async (t) => {
  const f = fixture(t);
  f.custody.beginRequest(f.req);
  const original = await f.verifier.verify({
    requestId: f.req.id,
    method: "POST",
    routeId: "deployAgent",
    requestedScope: { installationId: f.installationId },
    transport: { remoteAddress: "127.0.0.1" },
    headers: f.req.headers,
  });
  const copied = structuredClone(original);
  f.admissions.set(f.req, copied);
  f.custody.captureAdmission(f.req, copied);
  await f.identity(f.req, f.operation);
  await assert.rejects(
    f.custody.withWorkloadProfileInvocation(f.req, f.purpose(), async () => {}),
    unavailable,
  );
});
test("service-key admission remains ordinary and never becomes human custody", async (t) => {
  const f = fixture(t);
  f.req.headers["x-api-key"] = "controlled-key";
  delete f.req.headers.origin;
  await f.admit();
  assert.equal(f.admissions.get(f.req).method, "api_key");
  assert.equal(f.verifiedCalls(), 0);
  await assert.rejects(
    f.custody.withWorkloadProfileInvocation(f.req, f.purpose(), async () => {}),
    unavailable,
  );
});
test("foreign and copied opaque handles cannot use genuine receiver membership", async (t) => {
  const f = fixture(t);
  await f.admit();
  const tx = f.owner(),
    input = f.purpose();
  await f.custody.withWorkloadProfileInvocation(f.req, input, async () => {
    const original = await f.custody.invocations.forCurrentInvocation();
    await assert.rejects(
      f.custody.requests.consume({ ...original }, input, tx.unit, () => {}),
      unavailable,
    );
    const lease = await f.acquire(tx, input);
    lease.assertCurrent();
    await assert.rejects(
      f.custody.requests.consume(original, input, tx.unit, () => {}),
      unavailable,
    );
    await assert.rejects(f.custody.invocations.forCurrentInvocation(), unavailable);
    await tx.finish();
  });
});
test("an exact changed command is rejected and burns only that issued handle", async (t) => {
  const f = fixture(t);
  await f.admit();
  const tx = f.owner(),
    input = f.purpose();
  await f.custody.withWorkloadProfileInvocation(f.req, input, async () => {
    const handle = await f.custody.invocations.forCurrentInvocation();
    const changed = structuredClone(input);
    changed.binding[1].command.operationRef = "different-operation";
    await assert.rejects(
      f.custody.requests.consume(handle, changed, tx.unit, () => {}),
      unavailable,
    );
    await assert.rejects(
      f.custody.requests.consume(handle, input, tx.unit, () => {}),
      unavailable,
    );
  });
});
test("binding is captured before an asynchronous callback can mutate the caller input", async (t) => {
  const f = fixture(t);
  await f.admit();
  const tx = f.owner(),
    input = f.purpose(),
    original = structuredClone(input),
    gate = deferred();
  const work = f.custody.withWorkloadProfileInvocation(f.req, input, async () => {
    await gate.promise;
    const lease = await f.acquire(tx, original);
    lease.assertCurrent();
    await tx.finish();
  });
  input.binding[1].command.operationRef = "caller-mutated";
  gate.resolve();
  await work;
});
for (const [label, change] of [
  ["context", (f) => f.contexts.set(f.req, { ...f.contexts.get(f.req) })],
  [
    "actor",
    (f) => {
      f.contexts.get(f.req).actorId = "changed-principal";
    },
  ],
  ["admission", (f) => f.admissions.set(f.req, structuredClone(f.admissions.get(f.req)))],
  ["driver selection", (f) => f.replaceDriver()],
  [
    "driver id",
    (f) => {
      f.driver.id = "changed-driver";
    },
  ],
  [
    "authority record",
    (f) => {
      f.identityAuthorities.get(f.req).id = "changed-authority";
    },
  ],
  ["recipient", (f) => f.replaceRecipient()],
  [
    "request id",
    (f) => {
      f.req.id = "changed-request";
    },
  ],
  [
    "request abort",
    (f) => {
      f.req.raw.aborted = true;
      f.req.raw.emit("aborted");
    },
  ],
])
  test(`currentness rejects changed ${label}`, async (t) => {
    const f = fixture(t);
    await f.admit();
    const tx = f.owner(),
      input = f.purpose();
    await f.custody.withWorkloadProfileInvocation(f.req, input, async () => {
      const lease = await f.acquire(tx, input);
      tx.seal();
      change(f);
      assert.throws(() => lease.assertCurrent(), unavailable);
      await tx.finish();
    });
  });
test("request deadline includes verification time and is never started after its await", async (t) => {
  const f = fixture(t, { maxMs: 1000 }),
    gate = deferred();
  f.hooks.verify = () => gate.promise;
  const pending = f.admit();
  await nextTurn();
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 1001);
  gate.resolve();
  await assert.rejects(pending, unavailable);
});
test("recovery is a fresh purpose after unwind, using the original request deadline", async (t) => {
  const f = fixture(t, { maxMs: 1000 });
  await f.admit();
  let failedHandle;
  const first = f.owner(),
    input = f.purpose();
  await assert.rejects(
    f.custody.withWorkloadProfileInvocation(f.req, input, async () => {
      failedHandle = await f.custody.invocations.forCurrentInvocation();
      const lease = await createWorkloadProfilePurposeAccountParticipantV1({
        owner: first.source,
        requests: f.custody.requests,
        security: f.security(first).source,
      }).consume(failedHandle, input, first.unit);
      lease.assertCurrent();
      await first.finish();
      throw new Error("controlled transaction failure");
    }),
    /controlled transaction failure/,
  );
  const second = f.owner(),
    recoveryInput = f.purpose(recovery);
  await f.custody.withWorkloadProfileInvocation(f.req, recoveryInput, async () => {
    const fresh = await f.custody.invocations.forCurrentInvocation();
    assert.notEqual(fresh, failedHandle);
    await assert.rejects(
      f.custody.requests.consume(failedHandle, recoveryInput, second.unit, () => {}),
      unavailable,
    );
    const lease = await f.acquire(second, recoveryInput);
    const now = Date.now();
    t.mock.method(Date, "now", () => now + 1001);
    assert.throws(() => lease.assertCurrent(), unavailable);
    await second.finish();
  });
});
test("nested invocation, wrong route and repeated purpose are refused", async (t) => {
  const f = fixture(t);
  await f.admit();
  const input = f.purpose();
  await f.custody.withWorkloadProfileInvocation(f.req, input, async () => {
    await assert.rejects(
      f.custody.withWorkloadProfileInvocation(f.req, f.purpose(recovery), async () => {}),
      unavailable,
    );
  });
  await assert.rejects(
    f.custody.withWorkloadProfileInvocation(f.req, input, async () => {}),
    unavailable,
  );
  await assert.rejects(
    f.custody.withWorkloadProfileInvocation(f.req, f.purpose(draft), async () => {}),
    unavailable,
  );
});
test("missing original reader provides no account-security authority", async (t) => {
  const f = fixture(t);
  await f.admit();
  const tx = f.owner(),
    input = f.purpose();
  await f.custody.withWorkloadProfileInvocation(f.req, input, async () => {
    await assert.rejects(
      f.acquire(
        tx,
        input,
        createControllerWorkloadProfileSessionSecurityV1({ requests: f.custody }),
      ),
      unavailable,
    );
    assert.equal(f.events.includes("reader.query"), false);
    await tx.finish();
  });
});
for (const [field, value] of [
  ["state", "provisioning"],
  ["state", "deleted"],
  ["accountVersion", 0],
  ["accountVersion", Number.MAX_SAFE_INTEGER + 1],
  ["incarnation", ""],
  ["credentialAccountId", null],
  ["currentUserId", "different-user"],
  ["sessionUserId", "different-user"],
  ["sessionCredentialDigest", digest("rotated-credential")],
  ["sessionId", "different-session"],
]) {
  test(`locked reader ${field}=${String(value)} refuses current authority`, async (t) => {
    const f = fixture(t);
    await f.admit();
    const tx = f.owner(),
      input = f.purpose();
    await f.custody.withWorkloadProfileInvocation(f.req, input, async () => {
      await assert.rejects(
        f.acquire(tx, input, f.security(tx, { [field]: value }).source),
        unavailable,
      );
      assert.equal(f.events.includes("reader.release"), false);
      await tx.finish();
    });
    assert.ok(f.events.indexOf("database.cleanup") < f.events.indexOf("reader.release"));
  });
}
test("foreign request lease or different unit cannot resolve the private session locator", async (t) => {
  const f = fixture(t);
  await f.admit();
  const tx = f.owner(),
    input = f.purpose();
  await f.custody.withWorkloadProfileInvocation(f.req, input, async () => {
    const handle = await f.custody.invocations.forCurrentInvocation();
    const lease = await f.custody.requests.consume(handle, input, tx.unit, () => {});
    assert.equal(f.custody.resolveConsumedSession({ ...lease }, tx.unit), undefined);
    assert.equal(f.custody.resolveConsumedSession(lease, { ...tx.unit }), undefined);
  });
});
test("reader cleanup is transferred before a later result getter fails", async (t) => {
  const f = fixture(t);
  await f.admit();
  const tx = f.owner(),
    input = f.purpose();
  f.hooks.readerResult = (value) =>
    Object.defineProperty(value, "accountVersion", {
      get() {
        throw new Error("controlled record failure");
      },
    });
  await f.custody.withWorkloadProfileInvocation(f.req, input, async () => {
    await assert.rejects(f.acquire(tx, input), unavailable);
    assert.equal(f.events.includes("reader.release"), false);
    await tx.finish();
  });
  assert.equal(f.events.filter((e) => e === "reader.release").length, 1);
});
for (const outcome of ["resolve", "reject"])
  test(`malformed final reader fence ${outcome} is joined before cleanup`, async (t) => {
    const f = fixture(t);
    await f.admit();
    const tx = f.owner(),
      input = f.purpose(),
      gate = deferred();
    await f.custody.withWorkloadProfileInvocation(f.req, input, async () => {
      const lease = await f.acquire(tx, input);
      tx.seal();
      f.hooks.readerFence = () => gate.promise;
      assert.throws(() => lease.assertCurrent(), unavailable);
      const terminal = tx.finish();
      await nextTurn();
      assert.equal(f.events.includes("database.cleanup"), false);
      assert.equal(f.events.includes("reader.release"), false);
      gate[outcome]();
      await terminal;
    });
    assert.ok(f.events.indexOf("database.cleanup") < f.events.indexOf("reader.release"));
  });
test("aborted query acquisition preserves registered terminal cleanup and refuses a result", async (t) => {
  const f = fixture(t);
  await f.admit();
  const tx = f.owner(),
    input = f.purpose();
  f.hooks.query = () => tx.abort.abort();
  await f.custody.withWorkloadProfileInvocation(f.req, input, async () => {
    await assert.rejects(f.acquire(tx, input), unavailable);
    assert.equal(f.events.includes("reader.release"), false);
    await tx.finish();
  });
  assert.equal(f.events.filter((e) => e === "terminal.register").length, 1);
});

test("own unavailable refusal uses the original typed HTTP 503 mapping", async (t) => {
  const f = fixture(t);
  f.custody.closeRequest(f.req);
  await assert.rejects(f.admit(), (error) => {
    const mapped = requestFailure(error);
    assert.equal(mapped.status, 503);
    assert.equal(mapped.code, "DEPENDENCY_UNAVAILABLE");
    return true;
  });
});
for (const status of [403, 404, 409, "unknown-commit"])
  test(`invocation preserves the original callback ${status} outcome`, async (t) => {
    const f = fixture(t);
    await f.admit();
    const original =
      status === "unknown-commit"
        ? Object.assign(new Error("controlled commit uncertainty"), { outcome: "unknown" })
        : failure(status, "CONTROLLED_OPERATION", "Controlled operation refusal.");
    await assert.rejects(
      f.custody.withWorkloadProfileInvocation(f.req, f.purpose(), async () => {
        throw original;
      }),
      (error) => error === original,
    );
  });

test("a late reader lease after cancellation still transfers its cleanup before refusal", async (t) => {
  const f = fixture(t);
  await f.admit();
  const tx = f.owner(),
    input = f.purpose();
  f.hooks.readerResult = (value) => {
    tx.abort.abort();
    return value;
  };
  await f.custody.withWorkloadProfileInvocation(f.req, input, async () => {
    await assert.rejects(f.acquire(tx, input), unavailable);
    assert.equal(f.events.includes("reader.release"), false);
    await tx.finish();
  });
  assert.equal(f.events.filter((e) => e === "reader.release").length, 1);
});
test("the current reader expiry can shorten but never extend the originating lifetime", async (t) => {
  const f = fixture(t);
  await f.admit();
  const tx = f.owner(),
    input = f.purpose();
  const now = Date.now(),
    expiry = new Date(now + 500).toISOString();
  await f.custody.withWorkloadProfileInvocation(f.req, input, async () => {
    const lease = await f.acquire(tx, input, f.security(tx, { expiresAt: expiry }).source);
    t.mock.method(Date, "now", () => now + 501);
    assert.throws(() => lease.assertCurrent(), unavailable);
    await tx.finish();
  });
});

function clockFixture(t) {
  let wall = Date.now(),
    monotonic = process.hrtime.bigint();
  t.mock.method(Date, "now", () => wall);
  t.mock.method(process.hrtime, "bigint", () => monotonic);
  return {
    now: () => wall,
    rollbackAndExpire() {
      wall -= 10000;
      monotonic += 2000000000n;
    },
  };
}
test("wall-clock rollback before first invocation cannot renew captured session expiry", async (t) => {
  const clock = clockFixture(t),
    f = fixture(t, { maxMs: 10000 });
  f.session.expiresAt = new Date(clock.now() + 1000);
  await f.admit();
  clock.rollbackAndExpire();
  let called = false;
  await assert.rejects(
    f.custody.withWorkloadProfileInvocation(f.req, f.purpose(), async () => {
      called = true;
    }),
    unavailable,
  );
  assert.equal(called, false);
});
test("wall-clock rollback between deployment unwind and recovery retains the same session deadline", async (t) => {
  const clock = clockFixture(t),
    f = fixture(t, { maxMs: 10000 });
  f.session.expiresAt = new Date(clock.now() + 1000);
  await f.admit();
  await assert.rejects(
    f.custody.withWorkloadProfileInvocation(f.req, f.purpose(), async () => {
      await f.custody.invocations.forCurrentInvocation();
      throw new Error("controlled failed deployment");
    }),
    /controlled failed deployment/,
  );
  clock.rollbackAndExpire();
  let called = false;
  await assert.rejects(
    f.custody.withWorkloadProfileInvocation(f.req, f.purpose(recovery), async () => {
      called = true;
    }),
    unavailable,
  );
  assert.equal(called, false);
});
test("wall-clock rollback during verifier wait cannot extend the original session anchor", async (t) => {
  const clock = clockFixture(t),
    f = fixture(t, { maxMs: 10000 }),
    gate = deferred();
  f.session.expiresAt = new Date(clock.now() + 1000);
  f.hooks.verify = () => gate.promise;
  const admitted = f.admit();
  await nextTurn();
  clock.rollbackAndExpire();
  gate.resolve();
  await assert.rejects(admitted, unavailable);
});
