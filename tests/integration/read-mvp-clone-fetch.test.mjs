import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  exerciseCloneFetch,
  readClientLimits,
  readObservation,
  validateReadEndpoint,
  withReadClientLifetime,
} from "../fixtures/read-mvp/compose-read-path.mjs";

// Default cases are contract validation only: no binaries, network or authority.
// Explicit fixture selection adds real Git against failure/cancellation peers.
// The accepting owner's separate module selects the genuine maintained path.
const fixtureSelection = process.env.OCC_READ_MVP_CLIENT_FIXTURE;
const compositionModule = process.env.OCC_READ_MVP_ENDPOINT_FACTORY;
const manifestPath = process.env.OCC_READ_MVP_CLIENT_TOOLS;
const selected = fixtureSelection !== undefined || compositionModule !== undefined;
const fixtureOptions = {
  timeout: 60000,
  skip:
    fixtureSelection === "1"
      ? false
      : "Select OCC_READ_MVP_CLIENT_FIXTURE=1 and exact prepared client tools.",
};

function descriptor(overrides = {}) {
  return {
    proofKind: "client-fixture",
    url: "http://127.0.0.1:12345/example.git",
    gitConfig: {},
    observe: () => ({ discovery: 0, uploadPack: 0, upstreamReceivePack: 0, activeConnections: 0 }),
    close: async () => {},
    ...overrides,
  };
}

test("READ client contract rejects direct origin promotion, credentials and unbounded limits", () => {
  const origin = "http://127.0.0.1:12345/example.git";
  assert.equal(validateReadEndpoint(descriptor(), origin).proofKind, "client-fixture");
  for (const proofKind of ["maintained-read-transport", "original-authority-composition"]) {
    assert.throws(() => validateReadEndpoint(descriptor({ proofKind }), origin));
  }
  for (const url of [
    "http://user:password@127.0.0.1:12345/example.git",
    `${origin}?credential=1`,
    "file:///tmp/example.git",
  ]) {
    assert.throws(() => validateReadEndpoint(descriptor({ url }), origin));
  }
  for (const gitConfig of [
    { extraHeader: "Authorization: test" },
    { proxy: "http://user:password@127.0.0.1:12345/" },
    { proxy: "http://example.com:12345/" },
    { caInfo: "relative-ca.pem" },
  ])
    assert.throws(() => validateReadEndpoint(descriptor({ gitConfig }), origin));
  for (const input of [
    { outputBytes: Infinity },
    { maximumCommands: 0 },
    { retries: 1 },
    { commandMilliseconds: 45001 },
  ]) {
    assert.throws(() => readClientLimits(input));
  }
  assert.equal(readClientLimits({ maximumCommands: 8 }).maximumCommands, 8);
});

test("READ client contract snapshots selected routing and requires closed finite observations", () => {
  const endpoint = descriptor({
    proofKind: "maintained-read-transport",
    url: "https://github.com/example/project.git",
    gitConfig: { proxy: "http://127.0.0.1:12345/", caInfo: "/selected/public-fixture-ca.pem" },
  });
  const held = validateReadEndpoint(endpoint, "http://127.0.0.1:12346/example.git");
  endpoint.url = "https://github.com/other/project.git";
  endpoint.gitConfig.proxy = "http://127.0.0.1:54321/";
  assert.equal(held.url, "https://github.com/example/project.git");
  assert.ok(held.args.includes("http.proxy=http://127.0.0.1:12345/"));
  const observation = { discovery: 1, uploadPack: 2, upstreamReceivePack: 0, activeConnections: 0 };
  const saved = readObservation(observation);
  observation.discovery = 3;
  assert.equal(saved.discovery, 1);
  assert.throws(() => readObservation({ ...observation, token: "synthetic" }));
  assert.throws(() => readObservation({ ...observation, uploadPack: -1 }));
});

test("READ client explicit selection is complete and cannot silently skip malformed inputs", () => {
  if (!selected) {
    assert.equal(manifestPath, undefined, "Tools without a selected case are ambiguous.");
    return;
  }
  assert.ok(fixtureSelection === undefined || fixtureSelection === "1");
  assert.ok(manifestPath && isAbsolute(manifestPath));
  if (compositionModule !== undefined) assert.ok(isAbsolute(compositionModule));
});

function heldObservation() {
  let entered;
  let release;
  let settled = false;
  let observedSignal;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  return {
    entered: new Promise((resolve) => {
      entered = resolve;
    }),
    release: () =>
      release({ discovery: 2, uploadPack: 3, upstreamReceivePack: 0, activeConnections: 0 }),
    state: () => ({ settled, signal: observedSignal }),
    async observe({ signal }) {
      observedSignal = signal;
      entered();
      // This controlled peer deliberately retains its original pending call
      // after cancellation. The lifetime must report and join that exact work.
      const value = await waiting;
      settled = true;
      return value;
    },
  };
}

for (const cancellation of ["deadline", "caller-abort"]) {
  test(
    `READ client lifetime contract: ${cancellation} during final observation retains original work and cannot succeed late`,
    { timeout: 3000 },
    async () => {
      const controller = new AbortController();
      const held = heldObservation();
      let closes = 0;
      let originCloses = 0;
      const origin = {
        close() {
          originCloses++;
        },
      };
      const endpoint = {
        observe: (options) => held.observe(options),
        close: async () => {
          assert.equal(held.state().settled, true);
          closes++;
        },
      };
      const evidence = { endpointClosed: false };
      const outcome = withReadClientLifetime(
        {
          signal: controller.signal,
          limits: {
            commandMilliseconds: 40,
            operationMilliseconds: cancellation === "deadline" ? 40 : 1000,
            cleanupMilliseconds: 20,
          },
          evidence,
        },
        async (lifetime) => {
          lifetime.cleanup("endpoint", endpoint, async (cleanup) => {
            await cleanup.call("endpoint-close", endpoint, () =>
              endpoint.close({ signal: cleanup.signal }),
            );
            evidence.endpointClosed = true;
          });
          // Retain the borrowed origin operand without inventing cancellation
          // arguments or allowing lifetime cleanup to close caller-owned resources.
          await lifetime.call("borrowed-origin-snapshot", origin, () => ({
            commit: "synthetic-contract-only",
          }));
          await lifetime.call("final-operation-observe", endpoint, () =>
            endpoint.observe({ signal: lifetime.signal }),
          );
          return { completed: true };
        },
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      let result;
      try {
        await held.entered;
        if (cancellation === "caller-abort") controller.abort();
        result = await outcome;
        assert.ok(
          result.error,
          "A final observation cannot make an expired/cancelled operation succeed.",
        );
        assert.equal(result.value, undefined);
        const retained = result.error.readClientEvidence;
        assert.equal(retained.endpointClosed, false);
        assert.equal(retained.cleanupSettled, false);
        assert.equal(retained.cleanupWithinBudget, false);
        assert.ok(retained.retainedWork.inspect().pendingCalls.includes("final-operation-observe"));
        assert.ok(retained.retainedWork.inspect().retainedOwners >= 2);
        assert.equal(held.state().settled, false);
        assert.equal(held.state().signal.aborted, true);
        assert.equal(
          closes,
          0,
          "Close cannot be represented as joined while the original call is pending.",
        );
      } finally {
        held.release();
        result ??= await outcome;
        if (result.error) {
          const joined = await result.error.readClientEvidence.retainedWork.join();
          assert.equal(joined.pendingCalls.length, 0);
          assert.equal(joined.cleanupSettled, true);
          assert.equal(joined.cleanupWithinBudget, false);
          assert.equal(joined.endpointClosed, false);
          assert.equal(joined.lateEndpointRetirementObserved, true);
          assert.equal(
            result.error.readClientEvidence.endpointClosed,
            false,
            "Earlier unconfirmed evidence is immutable.",
          );
        }
        assert.equal(held.state().settled, true);
        assert.equal(closes, 1);
        assert.equal(originCloses, 0);
      }
    },
  );
}

test(
  "READ client lifetime contract: close and delayed final cleanup observation share one budget",
  { timeout: 3000 },
  async () => {
    const controller = new AbortController();
    const held = heldObservation();
    const evidence = { endpointClosed: false };
    let closeSignal;
    let closes = 0;
    const endpoint = {
      close: async ({ signal }) => {
        closeSignal = signal;
        closes++;
      },
      observe: (options) => held.observe(options),
    };
    const outcome = withReadClientLifetime(
      {
        signal: controller.signal,
        limits: { commandMilliseconds: 40, operationMilliseconds: 1000, cleanupMilliseconds: 20 },
        evidence,
      },
      async (lifetime) => {
        lifetime.cleanup("endpoint", endpoint, async (cleanup) => {
          await cleanup.call("endpoint-close", endpoint, () =>
            endpoint.close({ signal: cleanup.signal }),
          );
          const observed = await cleanup.call("endpoint-final-observe", endpoint, () =>
            endpoint.observe({ signal: cleanup.signal }),
          );
          assert.equal(readObservation(observed).activeConnections, 0);
          evidence.endpointClosed = true;
        });
        return { completed: true };
      },
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let result;
    try {
      await held.entered;
      result = await outcome;
      assert.ok(
        result.error,
        "A fulfilled close does not leave final observation outside the cleanup deadline.",
      );
      assert.equal(result.value, undefined);
      assert.equal(
        closeSignal,
        held.state().signal,
        "Close and observation receive the same finite cleanup signal.",
      );
      assert.equal(closeSignal.aborted, true);
      assert.equal(closes, 1);
      const retained = result.error.readClientEvidence;
      assert.equal(retained.endpointClosed, false);
      assert.equal(retained.cleanupWithinBudget, false);
      assert.ok(retained.retainedWork.inspect().pendingCalls.includes("endpoint-final-observe"));
      assert.equal(held.state().settled, false);
    } finally {
      held.release();
      result ??= await outcome;
      if (result.error) {
        const joined = await result.error.readClientEvidence.retainedWork.join();
        assert.equal(joined.cleanupSettled, true);
        assert.equal(joined.pendingCalls.length, 0);
        assert.equal(joined.endpointClosed, false);
        assert.equal(joined.lateEndpointRetirementObserved, true);
        assert.equal(result.error.readClientEvidence.endpointClosed, false);
      }
      assert.equal(held.state().settled, true);
      assert.equal(closes, 1);
    }
  },
);

test(
  "READ client lifetime contract: original late rejection remains observable after interruption",
  { timeout: 3000 },
  async () => {
    const controller = new AbortController();
    let entered;
    let rejectGate;
    let gateSettled = false;
    let closes = 0;
    let diagnosticReads = 0;
    const entry = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((_, reject) => {
      rejectGate = reject;
    });
    const lateFailure = new Error("credential-adjacent fixture canary");
    for (const property of ["message", "name", "stack", "code"]) {
      Object.defineProperty(lateFailure, property, {
        get() {
          diagnosticReads++;
          throw new Error("Exception properties must not be read.");
        },
      });
    }
    Object.freeze(lateFailure);
    const endpoint = {
      async observe() {
        entered();
        try {
          return await gate;
        } finally {
          gateSettled = true;
        }
      },
      async close() {
        assert.equal(gateSettled, true);
        closes++;
      },
    };
    const evidence = { endpointClosed: false };
    const outcome = withReadClientLifetime(
      {
        signal: controller.signal,
        limits: { commandMilliseconds: 40, operationMilliseconds: 40, cleanupMilliseconds: 20 },
        evidence,
      },
      async (lifetime) => {
        lifetime.cleanup("endpoint", endpoint, async (cleanup) => {
          await cleanup.call("endpoint-close", endpoint, () =>
            endpoint.close({ signal: cleanup.signal }),
          );
          evidence.endpointClosed = true;
        });
        await lifetime.call("late-rejecting-observe", endpoint, () =>
          endpoint.observe({ signal: lifetime.signal }),
        );
        return { completed: true };
      },
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let result;
    let primary;
    let previousRejections;
    try {
      await entry;
      result = await outcome;
      assert.ok(
        result.error,
        "The main invocation must report interruption before the original gate rejects.",
      );
      assert.equal(result.value, undefined);
      primary = result.error.cause;
      const retained = result.error.readClientEvidence;
      previousRejections = retained.retainedWork.inspect().rejectedCalls;
      assert.equal(
        previousRejections.some(({ call }) => call === "late-rejecting-observe"),
        false,
      );
      assert.ok(retained.retainedWork.inspect().pendingCalls.includes("late-rejecting-observe"));
      assert.equal(gateSettled, false);
      assert.equal(closes, 0);
    } finally {
      // Settle the same original pending invocation, then join its actual cleanup.
      // No replacement call, retry or synthesized fulfilled promise is involved.
      rejectGate(lateFailure);
      result ??= await outcome;
      if (result.error) {
        const joined = await result.error.readClientEvidence.retainedWork.join();
        const rejected = joined.rejectedCalls.filter(
          ({ call }) => call === "late-rejecting-observe",
        );
        assert.equal(rejected.length, 1);
        assert.ok(Number.isSafeInteger(rejected[0].invocation) && rejected[0].invocation > 0);
        assert.equal(rejected[0].outcome, "rejected");
        assert.equal(rejected[0].errorKind, "error");
        assert.equal(rejected[0].afterOperationAbort, true);
        assert.ok(joined.settledCalls >= joined.rejectedCalls.length);
        assert.equal(joined.pendingCalls.length, 0);
        assert.equal(
          joined.cleanupErrors,
          0,
          "Original-call rejection remains visible independently of successful cleanup.",
        );
        assert.equal(joined.cleanupSettled, true);
        assert.equal(joined.cleanupWithinBudget, false);
        assert.equal(joined.endpointClosed, false);
        assert.equal(joined.lateEndpointRetirementObserved, true);
        assert.equal(result.error.readClientEvidence.endpointClosed, false);
        if (primary)
          assert.equal(
            result.error.cause,
            primary,
            "The original timeout remains primary after the late rejection.",
          );
        if (previousRejections)
          assert.equal(
            previousRejections.some(({ call }) => call === "late-rejecting-observe"),
            false,
          );
        assert.ok(Object.isFrozen(joined.rejectedCalls) && Object.isFrozen(rejected[0]));
        assert.equal(
          JSON.stringify(joined.rejectedCalls).includes("credential-adjacent fixture canary"),
          false,
        );
      }
      assert.equal(gateSettled, true);
      assert.equal(closes, 1);
      assert.equal(diagnosticReads, 0);
    }
  },
);

async function toolsSelection() {
  assert.ok(manifestPath && isAbsolute(manifestPath));
  const stat = await lstat(manifestPath);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16384);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.execution, "local-synthetic-only");
  assert.equal(manifest.platform, "linux");
  assert.equal(manifest.arch, "x64");
  assert.equal(process.platform, manifest.platform);
  assert.equal(process.arch, manifest.arch);
  assert.ok(isAbsolute(manifest.scratchParent) && isAbsolute(manifest.gitExecPath));
  assert.equal(manifest.git.version, "2.55.0");
  assert.equal(manifest.git.commit, "e9019fcafe0040228b8631c30f97ae1adb61bcdc");
  // The harness rehashes the selected Git binary before each invocation. The
  // original artifact owner remains responsible for helper identity/provenance.
  return { root: manifest.scratchParent, git: { ...manifest.git, execPath: manifest.gitExecPath } };
}

async function ownClient(t) {
  const selection = await toolsSelection();
  const root = await mkdtemp(join(selection.root, "read-client-case-"));
  const controller = new AbortController();
  const cleanup = [];
  t.after(async () => {
    controller.abort();
    try {
      for (const close of cleanup.reverse()) await close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  return {
    ...selection,
    root,
    signal: controller.signal,
    controller,
    defer: (close) => cleanup.push(close),
  };
}

async function failingEndpoint(t, { signal, hang, controller }) {
  const sockets = new Set();
  let requests = 0;
  let closed = false;
  const server = createServer((_request, response) => {
    requests++;
    if (hang) controller.abort();
    else response.writeHead(503).end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = descriptor({
    url: `http://127.0.0.1:${server.address().port}/example.git`,
    observe: () => ({
      discovery: 0,
      uploadPack: 0,
      upstreamReceivePack: 0,
      activeConnections: sockets.size,
    }),
    close: async () => {
      if (closed) return;
      closed = true;
      const closing = new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      for (const socket of sockets) socket.destroy();
      await closing;
      // The close events settle after the server callback; join those original
      // sockets rather than treating a close request as observed retirement.
      await Promise.all(
        [...sockets].map((socket) => new Promise((resolve) => socket.once("close", resolve))),
      );
    },
  });
  t.after(() => endpoint.close());
  return { endpoint, requests: () => requests, signal };
}

for (const hang of [false, true]) {
  test(
    `READ client fixture: ${hang ? "cancellation" : "upstream failure"} joins Git and removes only owned scratch`,
    fixtureOptions,
    async (t) => {
      const fixture = await ownClient(t);
      // This inert origin operand is a contract mock. Neither controlled peer can
      // complete clone, so no Git graph or accepting authority is substituted.
      const origin = {
        url: "https://127.0.0.1:12345/fixture/repo.git",
        initialCommit: "1".repeat(40),
        external: {
          currentSnapshot: () => ({ commit: "1".repeat(40), files: { "README.md": "unused\n" } }),
        },
        addCommit: async () => assert.fail("A failed clone must not mutate the origin."),
      };
      // Cancel only the client invocation. The caller-owned origin must survive.
      const clientController = new AbortController();
      t.after(() => clientController.abort());
      const peer = await failingEndpoint(t, {
        signal: clientController.signal,
        controller: clientController,
        hang,
      });
      const before = (await readdir(fixture.root)).sort();
      let evidence;
      await assert.rejects(
        exerciseCloneFetch({
          ...fixture,
          origin,
          signal: clientController.signal,
          startEndpoint: async () => peer.endpoint,
        }),
        (error) => {
          evidence = error.readClientEvidence;
          return Boolean(evidence);
        },
      );
      assert.ok(
        peer.requests() > 0,
        "The selected failure occurred after real Git reached the fixture.",
      );
      assert.equal(evidence.endpointClosed, true);
      assert.equal(evidence.directoryRemoved, true);
      assert.ok(evidence.events.some((event) => event.phase === "clone" && event.code !== 0));
      assert.deepEqual((await readdir(fixture.root)).sort(), before);
      assert.equal(peer.endpoint.observe().activeConnections, 0);
    },
  );
}

test(
  "READ maintained endpoint: real Git clone/fetch through the separately supplied accepting composition",
  {
    timeout: 60000,
    skip: compositionModule
      ? false
      : "Receiving requirement: select OCC_READ_MVP_ENDPOINT_FACTORY exporting createReadClientComposition; no maintained listener is supplied by this client fixture.",
  },
  async (t) => {
    const fixture = await ownClient(t);
    assert.ok(isAbsolute(compositionModule));
    // The accepting owner constructs READ-01's external fixture with its own App
    // public key and composes actual issuance/native transport. This lane never
    // manufactures a token or a second anonymous origin to make clone succeed.
    const { createReadClientComposition } = await import(pathToFileURL(compositionModule).href);
    assert.equal(typeof createReadClientComposition, "function");
    const composition = await createReadClientComposition({
      root: fixture.root,
      signal: fixture.signal,
    });
    assert.equal(typeof composition.close, "function");
    fixture.defer(() => composition.close());
    assert.equal(typeof composition.startReadEndpoint, "function");
    const result = await exerciseCloneFetch({
      ...fixture,
      origin: composition.origin,
      startEndpoint: async (options) => {
        const endpoint = await composition.startReadEndpoint(options);
        if (
          endpoint.proofKind !== "maintained-read-transport" &&
          endpoint.proofKind !== "original-authority-composition"
        ) {
          await endpoint.close();
          assert.fail("Select an actual maintained READ endpoint.");
        }
        return endpoint;
      },
    });
    assert.equal(result.publication, "refused");
    assert.equal(result.cleanup.endpointClosed, true);
    assert.equal(result.cleanup.directoryRemoved, true);
    assert.ok(result.cleanup.events.some((event) => event.phase === "fetch" && event.code === 0));
    await assert.rejects(lstat(result.cleanup.directory), { code: "ENOENT" });
    // This result is client/transport evidence. The accepting owner's independent
    // tests must still prove original authority, native identity and release.
    t.diagnostic(
      `Selected boundary: ${result.proofKind}; original authority is not inferred from this descriptor.`,
    );
  },
);
