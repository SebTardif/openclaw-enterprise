import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

const scriptURL = new URL("../../scripts/bootstrap-installation.mjs", import.meta.url);
const source = await readFile(scriptURL, "utf8");
const accountId = "local-account-actual-id";
const secret = "fixture-secret-value-that-must-never-enter-diagnostics";
const user = Object.freeze({ id: accountId, email: "admin@example.test", name: "Administrator" });

class CommitUnknown extends Error {
  constructor() {
    super("The PostgreSQL commit outcome is unknown.");
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Execute the complete script source with controlled module boundaries. No real
// bootstrap entry point, database, auth provider, file output or child process runs.
async function controlled(options = {}) {
  const calls = [];
  const logs = [];
  const output = [];
  const files = [];
  const reservation = Object.freeze({});
  const unit = Object.freeze({
    audit: Object.freeze({
      async append(event) {
        calls.push("audit");
        assert.equal(event.actorId, "principal-actual-id");
        assert.equal(event.details.servicePrincipalId, "service-principal-id");
        assert.equal(event.details.serviceKeyId, "key-id");
        if (options.auditError) throw options.auditError;
      },
    }),
  });
  let installation;
  let auth;
  let pool;
  let selectedSeed;
  let state;
  let finalizationError;
  let applied = false;
  let committed = false;
  let transactionStarted = false;
  let uuid = 0;
  const issuer = (id) => `occ:installation:${id}:better-auth`;
  const failure = (name) => {
    if (options[name]) throw options[name];
  };
  const processValue = {
    env: {
      NODE_ENV: "production",
      OCC_DATABASE_URL: "postgresql://controlled.invalid/database",
      OCC_AUTH_SECRET: secret,
      OCC_AUTH_BASE_URL: "https://controller.example.test",
      OCC_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
      OCC_BOOTSTRAP_INSTALLATION_NAME: "Controlled installation",
      OCC_BOOTSTRAP_PASSWORD_FILE: "/protected/password",
      OCC_BOOTSTRAP_SERVICE_KEY_FILE: "/protected/service-key",
      ...options.env,
    },
    argv: ["node", scriptURL.pathname],
    stdout: {
      write(text) {
        calls.push("stdout");
        if (options.stdoutError) throw options.stdoutError;
        output.push(JSON.parse(text));
      },
    },
    exitCode: undefined,
  };
  class Pool {
    constructor() {
      calls.push("pool");
      pool = this;
    }
    async end() {
      calls.push("pool:end");
    }
  }
  class State {
    constructor(actualPool) {
      assert.equal(actualPool, pool);
      state = this;
      if (options.missingReceiptLookup) this.freshBootstrapFailureReceiptV1 = undefined;
      if (options.missingReserve) this.reserveFreshInstallationV1 = undefined;
      if (options.missingFinalize) this.finalizeFreshInstallationV1 = undefined;
    }
    async loadInstallation() {
      calls.push("installation:read");
      return options.existing;
    }
    async reserveFreshInstallationV1(value) {
      calls.push("reservation:start");
      installation = value;
      options.reservationStarted?.resolve();
      if (options.reservationWait) await options.reservationWait;
      failure("reservationError");
      calls.push("reservation:commit");
      committed = true;
      return options.emptyReservation ? undefined : reservation;
    }
    async finalizeFreshInstallationV1(actualReservation, seed, runOriginalTransaction) {
      calls.push("finalizer:enter");
      assert.equal(actualReservation, reservation);
      assert.equal(committed, true);
      assert.equal(transactionStarted, false);
      assert.equal(seed.identities[0].subject, accountId);
      assert.equal(seed.identities[0].issuer, issuer(installation.id));
      assert.equal(Object.isFrozen(seed), true);
      assert.equal(Object.isFrozen(seed.identities), true);
      assert.equal(Object.isFrozen(seed.identities[0]), true);
      selectedSeed = seed;
      try {
        failure("finalizeError");
        const result = await runOriginalTransaction();
        failure("finalizerAfterCommitError");
        return result;
      } catch (error) {
        finalizationError = error;
        throw error;
      }
    }
    freshBootstrapFailureReceiptV1(error) {
      calls.push("finalizer:receipt");
      assert.equal(this, state);
      assert.equal(error, finalizationError);
      if (Object.hasOwn(options, "receiptLookupError")) throw options.receiptLookupError;
      return options.finalizationReceipt;
    }
    async loadNativeIAMState(id) {
      calls.push("iam:read");
      assert.equal(id, options.existing.id);
      return {
        identities: options.missingPrincipal
          ? []
          : [
              {
                kind: "principal",
                id: "existing-principal",
                issuer: issuer(id),
                subject: accountId,
              },
            ],
        roles: [
          {
            id: "existing-role",
            permissions: [
              { action: "read", resourceKind: "installation" },
              { action: "administer", resourceKind: "installation" },
            ],
          },
        ],
        bindings: [
          { subjectKind: "identity", subjectId: "existing-principal", roleId: "existing-role" },
        ],
      };
    }
  }
  class Controller {
    constructor(value, settings) {
      calls.push("controller");
      assert.equal(value, installation);
      assert.ok(settings.state instanceof State);
    }
    registerDriver() {}
    selectDriver() {}
    async transact(work) {
      calls.push("transaction:acquire");
      transactionStarted = true;
      calls.push("iam:apply");
      failure("applyError");
      applied = true;
      await work(unit);
      calls.push("transaction:commit");
      failure("finalCommitError");
      calls.push("transaction:ack");
    }
    async createNamespace(principal, input) {
      calls.push("namespace");
      assert.equal(applied, true);
      assert.equal(principal, "principal-actual-id");
      assert.equal(input.name, "default");
      failure("namespaceError");
      return { id: "namespace-id" };
    }
  }
  const createAuth = async (settings) => {
    calls.push("auth");
    assert.equal(settings.pool, pool);
    if (!options.existing) assert.equal(committed, true);
    failure("authError");
    auth = {
      issuer: issuer(settings.installationId),
      auth: {
        $context: Promise.resolve({
          internalAdapter: {
            async findUserByEmail() {
              calls.push("account:find");
              if (options.existing) return options.missingUser ? null : { user };
              return options.emailConflict ? { user } : null;
            },
          },
        }),
      },
      async createAccount(input) {
        calls.push("account:create");
        assert.equal(committed, true);
        assert.equal(input.password, secret);
        failure("accountError");
        return user;
      },
      async createServiceKey(input) {
        calls.push("key:create");
        assert.equal(input.principal.id, "service-principal-id");
        assert.notEqual(input.principal.id, accountId);
        failure("keyError");
        return {
          id: "key-id",
          key: secret,
          servicePrincipalId: input.principal.id,
          expiresAt: "2030-01-01T00:00:00Z",
        };
      },
      async revokeServiceKey(value) {
        calls.push("key:revoke");
        assert.equal(value.id, "key-id");
        assert.equal(value.servicePrincipalId, "service-principal-id");
        failure("revokeError");
      },
      async deleteAccount(value) {
        calls.push("account:delete");
        assert.equal(value.id, accountId);
        failure("deleteError");
      },
    };
    return auth;
  };
  const modules = {
    "node:path": { dirname },
    "node:crypto": {
      randomBytes: () => ({ toString: () => secret }),
      randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
    },
    "node:module": {
      createRequire: () => (name) => {
        assert.equal(name, "pg");
        return { Pool };
      },
    },
    "../apps/controller/src/auth/index.ts": { createPostgresControllerAuth: createAuth },
    "../apps/controller/src/composition/bootstrap-output.ts": {
      bootstrapOutputPath: (path) => path,
      async writeProtectedBootstrapFile(path, text) {
        calls.push("output:password");
        files.push({ path, text });
        failure("passwordOutputError");
      },
      async writeProtectedBootstrapJson(path, payload) {
        calls.push("output:key");
        files.push({ path, payload });
        failure("keyOutputError");
      },
    },
    "../packages/iam/src/index.ts": {
      NativeIAMDriver: class {
        id = "native-iam";
      },
      createBootstrapAdministratorSeed(id, actualIssuer, account) {
        calls.push("seed");
        assert.equal(account.id, accountId);
        assert.equal(actualIssuer, issuer(id));
        return {
          principal: {
            kind: "principal",
            id: "principal-actual-id",
            issuer: actualIssuer,
            subject: account.id,
          },
          servicePrincipal: { kind: "service_principal", id: "service-principal-id" },
          roles: [{ id: "administrator-role", permissions: [] }],
          bindings: [],
        };
      },
    },
    "../packages/occ/src/index.ts": {
      BOOTSTRAP_DEFAULT_NAMESPACE_NAME: "default",
      OpenClawController: Controller,
      PostgresPlatformState: State,
      PostgresCommitOutcomeUnknownError: CommitUnknown,
    },
    "../apps/controller/src/logging.ts": {
      createOccLogger: () => ({}),
      emitOccLogEvent(_logger, event) {
        if (
          event.event.startsWith("installation.bootstrap-compensation") &&
          options.compensationLoggerError
        ) {
          assert.equal(processValue.exitCode, 1);
          throw new Error(secret);
        }
        if (event.event === "installation.bootstrap-failed" && options.failureLoggerError) {
          assert.equal(processValue.exitCode, 1);
          throw new Error(secret);
        }
        logs.push(JSON.parse(JSON.stringify(event)));
      },
    },
    "../apps/controller/src/composition/installation-config.ts": {
      loadOperationalLoggingConfiguration: async () => ({ level: "info" }),
    },
  };
  const context = createContext({ process: processValue, URL, Date, Error, structuredClone });
  const script = new SourceTextModule(source, {
    context,
    identifier: scriptURL.href,
    initializeImportMeta(meta) {
      meta.url = scriptURL.href;
    },
  });
  await script.link((name) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected real import: ${name}`);
    const values = modules[name];
    return new SyntheticModule(
      Object.keys(values),
      function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      },
      { context },
    );
  });
  options.observed?.({ calls, logs, files });
  await script.evaluate();
  assert.equal(calls.at(-1), "pool:end");
  assert.equal(JSON.stringify({ logs, output }).includes(secret), false);
  return { calls, logs, output, files, exitCode: processValue.exitCode, selectedSeed };
}

const failed = (result) =>
  result.logs.findLast((event) => event.event === "installation.bootstrap-failed");
const untouchedAuth = (result) => assert.equal(result.calls.includes("auth"), false);
const noCompensation = (result) => {
  assert.equal(result.calls.includes("key:revoke"), false);
  assert.equal(result.calls.includes("account:delete"), false);
};

test("fresh script commits reservation, creates actual identities and finalizes on the original unit", async () => {
  const result = await controlled();
  assert.equal(result.exitCode, undefined);
  assert.equal(result.output[0].event, "installation.bootstrapped");
  const relevant = result.calls.filter((value) =>
    [
      "reservation:commit",
      "account:create",
      "key:create",
      "finalizer:enter",
      "transaction:acquire",
      "iam:apply",
      "namespace",
      "audit",
      "transaction:ack",
      "stdout",
    ].includes(value),
  );
  assert.deepEqual(relevant, [
    "reservation:commit",
    "account:create",
    "key:create",
    "finalizer:enter",
    "transaction:acquire",
    "iam:apply",
    "namespace",
    "audit",
    "transaction:ack",
    "stdout",
  ]);
  assert.equal(result.selectedSeed.identities[0].subject, accountId);
  noCompensation(result);
});

test("account DML cannot begin while reservation COMMIT acknowledgment is pending", async () => {
  const started = deferred();
  const finish = deferred();
  let observed;
  const running = controlled({
    reservationStarted: started,
    reservationWait: finish.promise,
    observed(value) {
      observed = value;
    },
  });
  await started.promise;
  assert.equal(observed.calls.includes("auth"), false);
  finish.resolve();
  assert.equal((await running).exitCode, undefined);
});

for (const [name, options] of [
  ["conflicting reservation", { reservationError: new Error("conflict") }],
  ["unknown reservation COMMIT", { reservationError: new CommitUnknown() }],
  ["missing reservation receipt", { emptyReservation: true }],
  ["missing reserve participant", { missingReserve: true }],
  ["missing finalize participant", { missingFinalize: true }],
]) {
  test(`${name} cannot reach authentication or adopt an Installation`, async () => {
    const result = await controlled(options);
    untouchedAuth(result);
    noCompensation(result);
    assert.equal(result.exitCode, 1);
    assert.equal(result.output.length, 0);
  });
}

for (const [name, options] of [
  ["failed account write with no returned identity", { accountError: new Error(secret) }],
  ["preexisting email", { emailConflict: true }],
]) {
  test(`${name} retains the incomplete Installation without guessed deletion`, async () => {
    const result = await controlled(options);
    noCompensation(result);
    assert.equal(failed(result).result, "account-outcome-unavailable");
    assert.equal(failed(result).attempt.authAccountId, undefined);
  });
}

test("failed service-key creation compensates only the exact returned human account", async () => {
  const result = await controlled({ keyError: new Error(secret) });
  assert.equal(result.calls.includes("key:revoke"), false);
  assert.equal(result.calls.includes("account:delete"), true);
  assert.equal(result.calls.includes("finalizer:enter"), false);
});

for (const [name, options] of [
  ["protected password output", { passwordOutputError: new Error(secret) }],
  ["protected key output", { keyOutputError: new Error(secret) }],
  ["finalizer refusal before transaction", { finalizeError: new Error(secret) }],
  ["finalizer refusal", { applyError: new Error(secret) }],
  ["Namespace failure", { namespaceError: new Error(secret) }],
  ["audit failure", { auditError: new Error(secret) }],
]) {
  test(`known ${name} failure compensates exact auth objects and retains protected output paths`, async () => {
    const result = await controlled(options);
    assert.deepEqual(
      result.calls.filter((value) => ["key:revoke", "account:delete"].includes(value)),
      ["key:revoke", "account:delete"],
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.output.length, 0);
    assert.equal(failed(result).pending, true);
    assert.equal(failed(result).attempt.authAccountId, accountId);
    assert.equal(result.files.length > 0, true);
  });
}

test("failed compensation remains attributed and cannot hide the second cleanup attempt", async () => {
  const result = await controlled({
    auditError: new Error(secret),
    revokeError: new Error(secret),
    deleteError: new Error(secret),
  });
  assert.equal(result.calls.includes("account:delete"), true);
  assert.equal(failed(result).result, "compensation-unavailable");
  assert.deepEqual(
    result.logs
      .filter((event) => event.event === "installation.bootstrap-compensation-failed")
      .map((event) => event.operation),
    ["revoke-service-key", "delete-account"],
  );
});

test("unknown final COMMIT preserves every returned identity and protected output", async () => {
  const result = await controlled({ finalCommitError: new CommitUnknown() });
  noCompensation(result);
  assert.equal(failed(result).result, "outcome-unknown");
  assert.equal(failed(result).attempt.authAccountId, accountId);
  assert.equal(failed(result).attempt.serviceKeyId, "key-id");
  assert.equal(result.files.length, 2);
  assert.equal(result.output.length, 0);
});

test("a success-output failure after definite COMMIT cannot delete committed bootstrap identities", async () => {
  const result = await controlled({ stdoutError: new Error(secret) });
  noCompensation(result);
  assert.equal(failed(result).result, "committed");
  assert.equal(result.calls.includes("transaction:ack"), true);
});

for (const [name, options, succeeds] of [
  ["existing exact administrator", {}, true],
  ["existing Installation missing configured user", { missingUser: true }, false],
  ["existing Installation missing exact Principal", { missingPrincipal: true }, false],
]) {
  test(`${name} stays on verification and cannot acquire fresh-finalization authority`, async () => {
    const result = await controlled({ existing: { id: "ins_existing" }, ...options });
    assert.equal(result.calls.includes("reservation:start"), false);
    assert.equal(result.calls.includes("account:create"), false);
    assert.equal(result.calls.includes("finalizer:enter"), false);
    noCompensation(result);
    assert.equal(result.exitCode, succeeds ? undefined : 1);
    assert.equal(
      result.output[0]?.event,
      succeeds ? "installation.already-bootstrapped" : undefined,
    );
  });
}

for (const revokeError of [undefined, new Error(secret)]) {
  test(`throwing compensation logger cannot skip account cleanup after ${revokeError ? "failed" : "acknowledged"} key revocation`, async () => {
    const result = await controlled({
      auditError: new Error(secret),
      revokeError,
      compensationLoggerError: true,
    });
    assert.deepEqual(
      result.calls.filter((value) => ["key:revoke", "account:delete"].includes(value)),
      ["key:revoke", "account:delete"],
    );
    assert.equal(result.exitCode, 1);
    assert.equal(
      failed(result).result,
      revokeError ? "compensation-unavailable" : "incomplete-installation",
    );
  });
}

test("a completely failed diagnostic sink cannot escape the bounded failure handler", async () => {
  const result = await controlled({
    auditError: new Error(secret),
    compensationLoggerError: true,
    failureLoggerError: true,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.calls.includes("account:delete"), true);
  assert.equal(result.output.length, 0);
});

test("a finalizer wrapper rejection after original COMMIT cannot compensate committed identities", async () => {
  const result = await controlled({ finalizerAfterCommitError: new Error(secret) });
  noCompensation(result);
  assert.equal(result.calls.includes("transaction:ack"), true);
  assert.equal(failed(result).result, "committed");
  assert.equal(result.output.length, 0);
  assert.equal(result.exitCode, 1);
});

// Controlled data receipt only: this fixture supplies no PostgreSQL privileges
// or state-owned failure classification. Actual projection is tested by the logger.
const finalizationReceipt = Object.freeze({
  schema: "fresh-bootstrap-failure-v1",
  stage: "iam-writer-lock",
  sqlstate: "42501",
  commitDisposition: "not-sent",
  establishedNoCommit: true,
});

test("bootstrap failure receipt comes from the same state and exact error before compensation", async () => {
  const result = await controlled({ finalizeError: new Error(secret), finalizationReceipt });
  assert.deepEqual(
    result.calls.filter((call) =>
      ["finalizer:receipt", "key:revoke", "account:delete"].includes(call),
    ),
    ["finalizer:receipt", "key:revoke", "account:delete"],
  );
  assert.equal(result.calls.includes("transaction:acquire"), false);
  assert.deepEqual(failed(result).finalization, finalizationReceipt);
  assert.equal(failed(result).code, "BOOTSTRAP_FAILED");
  assert.equal(failed(result).operation, "finalization");
  assert.equal(failed(result).result, "incomplete-installation");
  assert.equal(failed(result).pending, true);
  assert.deepEqual(
    result.logs
      .filter((event) => event.event === "installation.bootstrap-compensation")
      .map(({ operation, outcome }) => ({ operation, outcome })),
    [
      { operation: "revoke-service-key", outcome: "acknowledged" },
      { operation: "delete-account", outcome: "acknowledged" },
    ],
  );
});

for (const [name, options] of [
  ["unavailable receipt", {}],
  ["missing getter", { missingReceiptLookup: true }],
  ["throwing getter", { receiptLookupError: new CommitUnknown() }],
  ["undefined getter rejection", { receiptLookupError: undefined }],
]) {
  test(`bootstrap failure receipt ${name} preserves the original known failure and cleanup`, async () => {
    const result = await controlled({ finalizeError: new Error(secret), ...options });
    assert.equal(Object.hasOwn(failed(result), "finalization"), false);
    assert.equal(failed(result).code, "BOOTSTRAP_FAILED");
    assert.equal(failed(result).result, "incomplete-installation");
    assert.deepEqual(
      result.calls.filter((call) => ["key:revoke", "account:delete"].includes(call)),
      ["key:revoke", "account:delete"],
    );
    assert.equal(result.exitCode, 1);
  });
}

test("bootstrap failure receipt cannot authorize cleanup after an unknown original COMMIT", async () => {
  const result = await controlled({ finalCommitError: new CommitUnknown(), finalizationReceipt });
  // Deliberately conflicting diagnostic data cannot override the original failure.
  assert.deepEqual(failed(result).finalization, finalizationReceipt);
  assert.equal(failed(result).code, "COMMIT_OUTCOME_UNKNOWN");
  assert.equal(failed(result).result, "outcome-unknown");
  noCompensation(result);
});

test("bootstrap failure receipt lookup rejection cannot replace an unknown original COMMIT", async () => {
  const result = await controlled({
    finalCommitError: new CommitUnknown(),
    receiptLookupError: new Error(secret),
  });
  assert.equal(failed(result).code, "COMMIT_OUTCOME_UNKNOWN");
  assert.equal(failed(result).result, "outcome-unknown");
  assert.equal(Object.hasOwn(failed(result), "finalization"), false);
  noCompensation(result);
});

test("bootstrap failure receipt preserves acknowledged COMMIT after finalizer rejection", async () => {
  const result = await controlled({
    finalizerAfterCommitError: new Error(secret),
    finalizationReceipt,
  });
  assert.deepEqual(failed(result).finalization, finalizationReceipt);
  assert.equal(failed(result).result, "committed");
  assert.equal(result.calls.includes("transaction:ack"), true);
  noCompensation(result);
});

test("bootstrap failure receipt does not interrupt independent cleanup when logging fails", async () => {
  const result = await controlled({
    auditError: new Error(secret),
    finalizationReceipt,
    revokeError: new Error(secret),
    compensationLoggerError: true,
    failureLoggerError: true,
  });
  assert.deepEqual(
    result.calls.filter((call) =>
      ["finalizer:receipt", "key:revoke", "account:delete"].includes(call),
    ),
    ["finalizer:receipt", "key:revoke", "account:delete"],
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.output.length, 0);
});

test("bootstrap failure receipt is not requested on success, earlier failure or existing verification", async () => {
  for (const options of [
    {},
    { reservationError: new Error(secret) },
    { accountError: new Error(secret) },
    { keyOutputError: new Error(secret) },
    { stdoutError: new Error(secret) },
    { existing: { id: "ins_existing" } },
  ]) {
    const result = await controlled({ ...options, finalizationReceipt });
    assert.equal(result.calls.includes("finalizer:receipt"), false);
    assert.equal(Object.hasOwn(failed(result) ?? {}, "finalization"), false);
  }
});
