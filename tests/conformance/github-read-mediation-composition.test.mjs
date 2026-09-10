import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { RepositoryWorkOperationOwnerV2 } from "../../packages/occ/src/lifecycle/repository-work-v2.ts";
import { githubMetadataDigest } from "../../packages/occ/src/github-mediation-v2/wire.ts";

// The native starter and State/Work construction peers are controlled INTERNAL
// components. The assembly and RepositoryWorkOperationOwnerV2 are real. These
// cases establish neither a native executable nor State/Work admission.
let nativeHook;
mock.module(
  new URL("../../apps/controller/src/admission/github-mediation-context.ts", import.meta.url).href,
  {
    namedExports: { startGitHubMediationNative: async (options) => nativeHook(options) },
  },
);
const {
  defineControllerGitHubMetadataReadV2,
  defineControllerGitHubGitReadV3,
  startControllerGitHubReadMediation,
} = await import("../../apps/controller/src/composition/github-read-mediation.ts");
const fail = () => {
  throw new Error("No original authority supplied by this component peer.");
};
function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  const starts = [],
    admissions = [],
    constructions = [],
    events = [];
  const selection = Object.freeze({ fixture: "original-driver-selection" });
  const trust = { readCurrentRecord: fail };
  const state = {
    repositoryWorkSelectedExecutionAdmissionV2(original, options) {
      assert.equal(this, state);
      assert.equal(original, selection);
      options.executions.bindState({ assertOriginal: fail });
      const core = Object.freeze({
        bindState() {},
        acquire: fail,
        inspect: fail,
        assertCurrent: fail,
        release: async () => {},
      });
      admissions.push({ options, core });
      return core;
    },
  };
  const context = { state, selection, trust, installationId: "installation/component" };
  let startupHook = async () => {};
  let sourceAcquisition = async () => undefined;
  let releaseHook = async () => {};
  let bundleHook = (bundle) => bundle;
  nativeHook = async (options) => {
    const native = Object.freeze({
      acquire: fail,
      inspect: fail,
      assertCurrent: fail,
      release: async () => {},
      prepareCommittedToken: fail,
      writePreparedCommittedToken: fail,
    });
    const entry = { options, native };
    starts.push(entry);
    entry.operations = options.operationsFactory.create(native);
    assert.ok(entry.operations instanceof RepositoryWorkOperationOwnerV2);
    await startupHook(entry);
    return Object.freeze({
      async close() {
        events.push(`native-close-${options.protocolVersion}`);
      },
    });
  };
  function define(version = 2, change = () => {}) {
    const work = {
      create(input) {
        assert.equal(this, work);
        assert.equal(input.state, state);
        assert.equal(input.selection, selection);
        assert.equal(input.trust, trust);
        const accepted = admissions.at(-1);
        assert.equal(input.native, accepted.options.native);
        assert.equal(input.executions, accepted.options.executions);
        assert.equal(input.admission, accepted.core);
        assert.equal(input.protocolVersion, version);
        constructions.push(input);
        const sources = {
          native: {
            acquire: (...args) => sourceAcquisition(...args),
            inspect: fail,
            inspectNative: fail,
            assertNativeCurrent: fail,
            assertCurrent: fail,
            release: async () => {},
          },
          state: {
            prepare: fail,
            readPreparationOriginal: fail,
            readCurrent: fail,
            commitDispatch: fail,
            inspectCommitted: fail,
            settle: async () => "unavailable",
          },
          custody: { prepareToken: fail, writeCommitted: fail, settleToken: async () => {} },
        };
        return bundleHook({
          sources,
          async release() {
            events.push(`work-release-${version}`);
            await releaseHook();
          },
        });
      },
    };
    const input = {
      deployment: {
        binaryPath: "/controlled/component-native",
        serviceIdentityRef: `runtime-service/component-${version}`,
        recipientRef: `recipient/read-${version}`,
        listenPath: `/controlled/read-${version}.sock`,
        peerUid: 1234,
        trustedAncestorUids: [0, 1234],
      },
      limits: {
        maximumSessions: 2,
        maximumCallMilliseconds: 1000,
        maximumOperationMilliseconds: 10000,
        maximumLeaseMilliseconds: 1000,
        clockAllowanceMilliseconds: 5,
      },
      accepted: { acquire: fail, retain: fail },
      work,
    };
    change(input);
    const definition = (
      version === 2 ? defineControllerGitHubMetadataReadV2 : defineControllerGitHubGitReadV3
    )(input);
    return { definition, input };
  }
  return {
    context,
    starts,
    admissions,
    constructions,
    events,
    define,
    set startupHook(value) {
      startupHook = value;
    },
    set sourceAcquisition(value) {
      sourceAcquisition = value;
    },
    set releaseHook(value) {
      releaseHook = value;
    },
    set bundleHook(value) {
      bundleHook = value;
    },
  };
}

test("read assembly pairs original native, Runtime execution, State core and real Work owner for V2 and V3", async () => {
  const f = fixture();
  const metadata = f.define(2),
    git = f.define(3);
  const running = await startControllerGitHubReadMediation(
    [metadata.definition, git.definition],
    f.context,
  );
  assert.deepEqual(
    f.starts.map((s) => s.options.protocolVersion),
    [2, 3],
  );
  assert.equal(f.admissions.length, 2);
  assert.equal(f.constructions.length, 2);
  assert.notEqual(f.constructions[0].executions, f.constructions[1].executions);
  for (const entry of f.starts) {
    assert.equal(entry.options.trust, f.context.trust);
    assert.equal(entry.options.installationId, f.context.installationId);
    assert.equal(entry.options.operations, undefined);
    assert.throws(() => entry.options.operationsFactory.create(entry.native));
  }
  await running.close();
  assert.equal(f.events.length, 4);
});

test("read deployment and original constructors are captured before later caller mutation", async () => {
  const f = fixture();
  const configured = f.define();
  configured.input.deployment.binaryPath = "/changed";
  configured.input.deployment.trustedAncestorUids.push(999);
  configured.input.work.create = fail;
  configured.input.accepted.acquire = fail;
  configured.input.limits.maximumSessions = 100000;
  const running = await startControllerGitHubReadMediation([configured.definition], f.context);
  assert.equal(f.starts[0].options.binaryPath, "/controlled/component-native");
  assert.deepEqual(f.starts[0].options.trustedAncestorUids, [0, 1234]);
  assert.equal(f.starts[0].options.limits.maximumSessions, 2);
  await running.close();
});

test("plain publication/configuration DTOs and copied startup definitions cannot start native services", async () => {
  const f = fixture();
  const original = f.define();
  for (const copied of [
    {},
    { ...original.definition },
    { protocolVersion: 1, operationPolicy: "github-publication-rpc-v1" },
  ])
    await assert.rejects(startControllerGitHubReadMediation([copied], f.context));
  assert.equal(f.starts.length, 0);
});

test("duplicate protocol, endpoint or service identity refuses the whole set before any startup", async () => {
  for (const kind of ["protocol", "endpoint", "identity"]) {
    const f = fixture();
    const a = f.define();
    const b = f.define(kind === "protocol" ? 2 : 3, (input) => {
      if (kind === "endpoint") input.deployment.listenPath = a.input.deployment.listenPath;
      if (kind === "identity")
        input.deployment.serviceIdentityRef = a.input.deployment.serviceIdentityRef;
    });
    await assert.rejects(
      startControllerGitHubReadMediation([a.definition, b.definition], f.context),
    );
    assert.equal(f.starts.length, 0);
  }
});

test("an invalid later definition cannot start an earlier valid service", async () => {
  const f = fixture();
  const a = f.define();
  await assert.rejects(startControllerGitHubReadMediation([a.definition, {}], f.context));
  assert.equal(f.starts.length, 0);
  const running = await startControllerGitHubReadMediation([a.definition], f.context);
  await running.close();
});

test("all selected definitions are reserved before the first native startup wait", async () => {
  const f = fixture();
  const a = f.define(),
    b = f.define(3);
  const entered = deferred(),
    gate = deferred();
  f.startupHook = async ({ options }) => {
    if (options.protocolVersion === 2) {
      entered.resolve();
      await gate.promise;
    }
  };
  const starting = startControllerGitHubReadMediation([a.definition, b.definition], f.context);
  await entered.promise;
  await assert.rejects(startControllerGitHubReadMediation([b.definition], f.context));
  gate.resolve();
  const running = await starting;
  await running.close();
  await assert.rejects(startControllerGitHubReadMediation([a.definition], f.context));
  assert.deepEqual(
    f.starts.map((s) => s.options.protocolVersion),
    [2, 3],
  );
});

test("missing original State core constructor refuses before native startup", async () => {
  const f = fixture();
  const a = f.define();
  await assert.rejects(
    startControllerGitHubReadMediation([a.definition], { ...f.context, state: {} }),
  );
  assert.equal(f.starts.length, 0);
});

test("throwing Work sources getter still joins captured collaborator cleanup", async () => {
  const f = fixture();
  const a = f.define();
  f.bundleHook = (bundle) => ({
    release: bundle.release,
    get sources() {
      throw new Error("source getter failed");
    },
  });
  await assert.rejects(startControllerGitHubReadMediation([a.definition], f.context));
  assert.deepEqual(f.events, ["work-release-2"]);
  await assert.rejects(f.constructions[0].executions.acquire({}, {}, {}));
});

test("failed second native startup joins both independent constructor lifetimes", async () => {
  const f = fixture();
  const a = f.define(),
    b = f.define(3);
  f.startupHook = async ({ options }) => {
    if (options.protocolVersion === 3) throw new Error("native startup refused");
  };
  await assert.rejects(startControllerGitHubReadMediation([a.definition, b.definition], f.context));
  assert.deepEqual(f.events, ["work-release-3", "native-close-2", "work-release-2"]);
  for (const input of f.constructions) await assert.rejects(input.executions.acquire({}, {}, {}));
});

test("Work acquisition joins before assembly retires its native receiver", async () => {
  const f = fixture();
  const a = f.define();
  const entered = deferred(),
    gate = deferred();
  f.sourceAcquisition = async () => {
    entered.resolve();
    await gate.promise;
    return undefined;
  };
  const running = await startControllerGitHubReadMediation([a.definition], f.context);
  const request = {
    version: 2,
    sequence: 1,
    request_ref: "1".repeat(32),
    method: "open-read",
    attachment_ref: "attachment/1",
    repository_owner: "octocat",
    repository_name: "example",
    request_sha256: githubMetadataDigest("octocat", "example"),
  };
  const call = {
    context: {},
    requestRef: request.request_ref,
    recipientRef: "recipient/read-2",
    deadline: new Date(Date.now() + 5000).toISOString(),
    signal: new AbortController().signal,
  };
  const preparing = f.starts[0].operations.prepare(request, call);
  await entered.promise;
  const closing = running.close();
  await Promise.resolve();
  assert.deepEqual(f.events, []);
  gate.resolve();
  assert.equal((await preparing).kind, "refused");
  await closing;
  assert.deepEqual(f.events, ["native-close-2", "work-release-2"]);
});

test("cleanup errors do not skip other owned cleanup and close is joined once", async () => {
  const f = fixture();
  const a = f.define();
  const running = await startControllerGitHubReadMediation([a.definition], f.context);
  f.releaseHook = async () => {
    throw new Error("work cleanup failed");
  };
  const first = running.close();
  assert.equal(running.close(), first);
  await assert.rejects(first, AggregateError);
  assert.deepEqual(f.events, ["native-close-2", "work-release-2"]);
  await assert.rejects(f.constructions[0].executions.acquire({}, {}, {}));
});

test("invalid finite admission limits refuse before defining a native service", () => {
  const f = fixture();
  assert.throws(() =>
    f.define(2, (input) => {
      input.limits.maximumSessions = 129;
    }),
  );
  assert.throws(() =>
    f.define(3, (input) => {
      input.limits.maximumCallMilliseconds = 3001;
    }),
  );
  assert.equal(f.starts.length, 0);
});
