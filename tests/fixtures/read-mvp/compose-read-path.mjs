import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { finished } from "node:stream/promises";
import { types as nodeTypes } from "node:util";

// Client boundary only. The accepting owner supplies the actual READ endpoint.
// This helper neither creates Work authority nor turns endpoint metadata into it.
export const READ_CLIENT_DEFAULTS = Object.freeze({
  commandMilliseconds: 5000,
  operationMilliseconds: 45000,
  cleanupMilliseconds: 3000,
  outputBytes: 131072,
  maximumCommands: 64,
  maximumFiles: 32,
  maximumFileBytes: 65536,
});
const oidPattern = /^[0-9a-f]{40}$/;
const proofKinds = [
  "client-fixture",
  "maintained-read-transport",
  "original-authority-composition",
];
const isNativeError = nodeTypes.isNativeError;

function deadline(milliseconds, caller, name) {
  const controller = new AbortController();
  const expires = performance.now() + milliseconds;
  const cancel = () => controller.abort(new Error(`READ client ${name} interrupted.`));
  caller?.addEventListener("abort", cancel, { once: true });
  if (caller?.aborted) cancel();
  const timer = setTimeout(cancel, milliseconds);
  return {
    signal: controller.signal,
    cancel,
    check() {
      if (performance.now() >= expires || caller?.aborted) cancel();
      controller.signal.throwIfAborted();
    },
    stop() {
      clearTimeout(timer);
      caller?.removeEventListener("abort", cancel);
    },
  };
}

// This only bounds waiting. The original promise remains in the lifetime's
// pending set and cleanup joins it; interruption never means it was retired.
async function waitCurrent(promise, budget) {
  budget.check();
  let interrupted;
  try {
    const value = await new Promise((resolve, reject) => {
      interrupted = () => reject(budget.signal.reason);
      budget.signal.addEventListener("abort", interrupted, { once: true });
      promise.then(resolve, reject);
      if (budget.signal.aborted) interrupted();
    });
    budget.check();
    return value;
  } finally {
    budget.signal.removeEventListener("abort", interrupted);
  }
}

/**
 * Shared client lifetime, exported for contract-only regressions. The operation
 * calls call(name, originalOwner, work, adopt?) for every awaited boundary.
 * adopt synchronously retains newly acquired resources even after interruption.
 * It must not start further work. Cleanup callbacks run after all original
 * operation calls settle and use cleanup.call to retain their own pending work.
 *
 * A single cleanup budget includes that drain, close, final observation and
 * scratch removal. An interrupted caller receives a failure immediately after
 * the bounded cleanup wait; error.readClientEvidence.retainedWork holds the
 * original calls/owners. inspect() is metadata only; join() waits for the actual
 * retained cleanup task, with no timeout or cancellation-as-retirement fiction.
 * The caller must retain this handle until it joins or separately retires the
 * original owners. A late join never changes the failed operation into success.
 * inspect()/join() also retain settledCalls and rejectedCalls from those exact
 * invocations. Rejection metadata never reads message/name/stack/code properties
 * or copies raw reasons; the original interruption remains the primary failure.
 */
export async function withReadClientLifetime(
  { signal, limits: input = {}, evidence = {} },
  operation,
) {
  assert.ok(signal instanceof AbortSignal);
  assert.equal(typeof operation, "function");
  const limits = readClientLimits(input);
  const active = deadline(limits.operationMilliseconds, signal, "operation");
  const pending = new Set();
  const owners = new Set();
  const cleanupPlans = [];
  const cleanupErrors = [];
  const rejectedCalls = [];
  let settledCalls = 0;
  let cleanupSettled = false;
  let cleanupWithinBudget = false;
  let cleanupTask;
  let totalCalls = 0;
  const retain = (name, owner, work, adopt) => {
    assert.ok(++totalCalls <= 1024, "READ client boundary budget exhausted.");
    owners.add(owner);
    const record = { invocation: totalCalls, name, owner, settled: undefined };
    const original = Promise.resolve()
      .then(work)
      .then((value) => {
        adopt?.(value);
        return value;
      });
    record.settled = original.then(
      () => {
        settledCalls++;
        pending.delete(record);
      },
      (reason) => {
        // Use a captured native intrinsic, not replaceable exception properties or
        // user conversion hooks. Even an opaque rejection keeps its call identity.
        let errorKind = "unclassified";
        try {
          errorKind = isNativeError(reason) ? "error" : reason === null ? "null" : typeof reason;
        } catch {}
        rejectedCalls.push(
          Object.freeze({
            invocation: record.invocation,
            call:
              typeof name === "string" && /^[a-z0-9:-]{1,96}$/.test(name)
                ? name
                : "unlabelled-boundary",
            outcome: "rejected",
            errorKind,
            afterOperationAbort: active.signal.aborted,
          }),
        );
        // There are at most 1024 admitted invocations and one settlement per
        // original promise. Keep every rejection; no truncation or eviction.
        settledCalls++;
        pending.delete(record);
      },
    );
    pending.add(record);
    return original;
  };
  const drain = async () => {
    while (pending.size) await Promise.all([...pending].map((record) => record.settled));
  };
  const inspect = () =>
    Object.freeze({
      pendingCalls: Object.freeze([...pending].map(({ name }) => name)),
      retainedOwners: owners.size,
      settledCalls,
      rejectedCalls: Object.freeze([...rejectedCalls]),
      cleanupSettled,
      cleanupWithinBudget,
      cleanupErrors: cleanupErrors.length,
    });
  const retainedWork = Object.freeze({
    inspect,
    async join() {
      await cleanupTask;
      return Object.freeze({
        ...evidence,
        endpointClosed: Boolean(evidence.endpointClosed && cleanupWithinBudget),
        lateEndpointRetirementObserved: Boolean(evidence.endpointClosed && !cleanupWithinBudget),
        ...inspect(),
      });
    },
  });
  const lifetime = Object.freeze({
    signal: active.signal,
    check: () => active.check(),
    async call(name, owner, work, adopt) {
      active.check();
      const original = retain(
        name,
        owner,
        () => {
          active.check();
          return work();
        },
        adopt,
      );
      return waitCurrent(original, active);
    },
    cleanup(name, owner, work) {
      active.check();
      owners.add(owner);
      cleanupPlans.push({ name, owner, work });
    },
  });
  let result;
  let failure;
  try {
    active.check();
    result = await waitCurrent(
      retain("operation-body", operation, () => operation(lifetime)),
      active,
    );
    active.check();
  } catch (error) {
    failure = error;
    active.cancel();
  }
  const cleanupBudget = deadline(limits.cleanupMilliseconds, undefined, "cleanup");
  const cleanup = Object.freeze({
    signal: cleanupBudget.signal,
    // Cleanup may finish after its deadline. Retain and observe that real work;
    // the bounded caller wait and final checks still refuse late success.
    call: (name, owner, work) => retain(name, owner, work),
  });
  cleanupTask = (async () => {
    await drain();
    for (const plan of [...cleanupPlans].reverse()) {
      try {
        await plan.work(cleanup);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    await drain();
    cleanupSettled = true;
  })();
  try {
    await waitCurrent(cleanupTask, cleanupBudget);
    cleanupBudget.check();
    cleanupWithinBudget = true;
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, "READ client cleanup failed.");
    active.check();
  } catch (error) {
    failure = failure
      ? new AggregateError([failure, error], "READ client operation or cleanup unconfirmed.")
      : error;
    active.cancel();
  } finally {
    active.stop();
    // Preserve the cleanup deadline signal until the actual task settles.
    void cleanupTask.then(
      () => cleanupBudget.stop(),
      () => cleanupBudget.stop(),
    );
  }
  if (failure) {
    const current = inspect();
    const snapshot = Object.freeze({
      ...evidence,
      endpointClosed: Boolean(evidence.endpointClosed && cleanupWithinBudget),
      ...current,
      retainedWork,
    });
    // A boundary may reject with a frozen Error or a non-Error value. Always
    // attach the retained ownership handle to a fresh, owned diagnostic.
    const reported = new Error("READ client failed; inspect retained cleanup evidence.", {
      cause: failure,
    });
    Object.defineProperty(reported, "readClientEvidence", { value: snapshot });
    throw reported;
  }
  // Monotonic time and caller cancellation are checked at the last synchronous
  // return boundary too, including time spent in successful cleanup.
  try {
    active.check();
  } catch (error) {
    Object.defineProperty(error, "readClientEvidence", {
      value: Object.freeze({ ...evidence, ...inspect(), retainedWork }),
    });
    throw error;
  }
  return Object.freeze({ ...result, cleanup: Object.freeze({ ...evidence, ...inspect() }) });
}

export function readClientLimits(input = {}) {
  assert.ok(input && typeof input === "object" && !Array.isArray(input));
  const result = { ...READ_CLIENT_DEFAULTS };
  for (const [name, value] of Object.entries(input)) {
    assert.ok(Object.hasOwn(result, name), `Unknown READ client limit: ${name}`);
    assert.ok(Number.isSafeInteger(value) && value > 0 && value <= result[name], name);
    result[name] = value;
  }
  assert.ok(result.commandMilliseconds <= result.operationMilliseconds);
  return Object.freeze(result);
}

function credentialFreeURL(value) {
  assert.equal(typeof value, "string");
  const url = new URL(value);
  assert.equal(url.href, value, "Select a canonical URL.");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.equal(url.hash, "");
  assert.equal(url.search, "");
  return url;
}

/**
 * startEndpoint({origin, signal, limits}) -> {proofKind,url,gitConfig,observe,close}.
 * gitConfig permits only {proxy?,caInfo?}; no credentials or TLS bypass.
 * observe({signal}) -> {discovery,uploadPack,upstreamReceivePack,activeConnections}.
 * Counters describe the selected endpoint's observations, not authority proof.
 * close({signal}) must join original owned connections/processes and support
 * repeated calls. A fulfilled close/observe promise describes actual completion;
 * requesting cancellation alone cannot fulfill it as retirement. If a caller
 * cannot cooperate before its budget, its original promise/owner stays retained
 * in error.readClientEvidence.retainedWork until actual settlement.
 * Startup rejection must follow actual rollback; fulfillment transfers that
 * exact endpoint to this lifetime. The caller-owned origin's zero-argument
 * addCommit promise is retained and joined without closing or cancelling its
 * owner through an invented API.
 */
export function validateReadEndpoint(endpoint, originURL) {
  assert.ok(endpoint && proofKinds.includes(endpoint.proofKind));
  assert.equal(typeof endpoint.observe, "function");
  assert.equal(typeof endpoint.close, "function");
  const url = credentialFreeURL(endpoint.url);
  if (endpoint.proofKind === "client-fixture") {
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.ok(url.port);
  } else {
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "github.com");
    assert.equal(url.port, "");
    assert.match(url.pathname, /^\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\.git$/);
    assert.notEqual(endpoint.url, originURL, "A direct fixture origin is not a mediated endpoint.");
  }
  const config = endpoint.gitConfig ?? {};
  assert.ok(config && typeof config === "object" && !Array.isArray(config));
  assert.ok(Object.keys(config).every((key) => key === "proxy" || key === "caInfo"));
  const args = [];
  if (config.proxy !== undefined) {
    const proxy = credentialFreeURL(config.proxy);
    assert.equal(proxy.protocol, "http:");
    assert.equal(proxy.hostname, "127.0.0.1");
    assert.ok(proxy.port);
    assert.equal(proxy.pathname, "/");
    args.push("-c", `http.proxy=${proxy.href}`);
  }
  if (config.caInfo !== undefined) {
    assert.equal(typeof config.caInfo, "string");
    assert.ok(isAbsolute(config.caInfo));
    args.push("-c", `http.sslCAInfo=${config.caInfo}`);
  }
  // A local CONNECT router and explicit public fixture CA retain the canonical
  // GitHub URL for controlled maintained-transport qualification.
  if (endpoint.proofKind !== "client-fixture") {
    assert.ok(config.proxy && config.caInfo, "Select the loopback router and fixture TLS trust.");
  }
  return Object.freeze({
    proofKind: endpoint.proofKind,
    url: endpoint.url,
    args: Object.freeze(args),
  });
}

export function readObservation(value) {
  const names = ["discovery", "uploadPack", "upstreamReceivePack", "activeConnections"];
  assert.ok(value && typeof value === "object");
  assert.deepEqual(Object.keys(value).sort(), [...names].sort());
  for (const name of names) assert.ok(Number.isSafeInteger(value[name]) && value[name] >= 0, name);
  return Object.freeze(Object.fromEntries(names.map((name) => [name, value[name]])));
}

async function protectedDirectory(path, lifetime) {
  assert.ok(typeof path === "string" && isAbsolute(path));
  const stat = await lifetime.call("scratch-parent-stat", path, () => lstat(path));
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
  assert.equal(stat.mode & 0o022, 0, "Select a private existing scratch parent.");
}

async function selectedGit(git, lifetime) {
  assert.ok(git && isAbsolute(git.path) && isAbsolute(git.execPath));
  assert.match(git.sha256, /^[0-9a-f]{64}$/);
  const stat = await lifetime.call("git-binary-stat", git, () => lstat(git.path));
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0);
  assert.equal(stat.mode & 0o022, 0);
  assert.ok(
    (await lifetime.call("git-helpers-stat", git, () => lstat(git.execPath))).isDirectory(),
  );
  const hash = createHash("sha256");
  await lifetime.call("git-binary-hash", git, async () => {
    const stream = createReadStream(git.path, { signal: lifetime.signal });
    const settled = finished(stream, { cleanup: true });
    void settled.catch(() => {});
    try {
      lifetime.check();
      for await (const chunk of stream) {
        lifetime.check();
        hash.update(chunk);
        lifetime.check();
      }
      lifetime.check();
    } finally {
      stream.destroy();
      await settled.catch(() => {});
    }
  });
  assert.equal(hash.digest("hex"), git.sha256, "Selected Git executable changed.");
}

function runner({ git, directory, signal, limits, events }) {
  let commands = 0;
  const environment = {
    PATH: "/usr/bin:/bin",
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_EXEC_PATH: git.execPath,
    GIT_ATTR_NOSYSTEM: "1",
  };
  const base = [
    "-c",
    "protocol.version=2",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.http.allow=always",
    "-c",
    "protocol.https.allow=always",
    "-c",
    "credential.helper=",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "http.proxy=",
    "-c",
    "http.sslVerify=true",
    "-c",
    "http.followRedirects=false",
    "-c",
    "http.version=HTTP/1.1",
    "-c",
    "http.extraHeader=",
    "-c",
    "http.extraHeader=Connection: close",
    "-c",
    "maintenance.auto=false",
    "-c",
    "gc.auto=0",
    "-c",
    "fetch.recurseSubmodules=false",
    "-c",
    "user.name=READ client fixture",
    "-c",
    "user.email=read-client@local.invalid",
    "-c",
    "commit.gpgSign=false",
  ];
  return async (phase, args, options = {}) => {
    signal.throwIfAborted();
    assert.ok(++commands <= limits.maximumCommands, "READ client command budget exhausted.");
    const child = spawn(git.path, [...base, ...args], {
      cwd: directory,
      env: environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let bytes = 0;
    let failure;
    let hardKill;
    const stdout = [];
    const terminate = (reason) => {
      failure ??= reason;
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      hardKill ??= setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }, 250);
    };
    const abort = () => terminate(new Error(`READ client aborted during ${phase}.`));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(
      () => terminate(new Error(`READ client deadline during ${phase}.`)),
      limits.commandMilliseconds,
    );
    const capture = (chunk, output) => {
      bytes += chunk.length;
      if (bytes > limits.outputBytes)
        terminate(new Error(`READ client output limit during ${phase}.`));
      else if (output) stdout.push(chunk);
    };
    child.stdout.on("data", (chunk) => capture(chunk, true));
    child.stderr.on("data", (chunk) => capture(chunk, false));
    child.on("error", () => {
      failure ??= new Error(`READ client failed to spawn during ${phase}.`);
    });
    const code = await new Promise((resolve) => child.once("close", resolve));
    clearTimeout(timer);
    clearTimeout(hardKill);
    signal.removeEventListener("abort", abort);
    events.push(Object.freeze({ phase, code, outputBytes: bytes }));
    if (failure) throw failure;
    if (!options.allowFailure) assert.equal(code, 0, `Git ${phase} failed; output withheld.`);
    return { code, stdout: Buffer.concat(stdout) };
  };
}

function text(result) {
  return result.stdout.toString("utf8").trimEnd();
}

function snapshotOrigin(origin, limits) {
  const snapshot = origin.external.currentSnapshot();
  assert.match(snapshot.commit, oidPattern);
  assert.ok(snapshot.files && typeof snapshot.files === "object");
  const files = Object.entries(snapshot.files);
  assert.ok(files.length > 0 && files.length <= limits.maximumFiles);
  for (const [name, value] of files) {
    assert.match(name, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
    assert.notEqual(name, ".git");
    assert.equal(typeof value, "string");
    assert.ok(Buffer.byteLength(value) <= limits.maximumFileBytes);
  }
  return Object.freeze({
    commit: snapshot.commit,
    files: Object.freeze(Object.fromEntries(files)),
  });
}

function objectOid(kind, bytes) {
  return createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
}

function expectedObjects(snapshot) {
  const entries = Object.entries(snapshot.files)
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(([name, value]) => ({
      name,
      bytes: Buffer.from(value),
      oid: objectOid("blob", Buffer.from(value)),
    }));
  // The external fixture exports its ordinary 100644 flat-file snapshot. Git's
  // object identity can be checked without reaching into its private bare repo.
  const tree = Buffer.concat(
    entries.flatMap((entry) => [
      Buffer.from(`100644 ${entry.name}\0`),
      Buffer.from(entry.oid, "hex"),
    ]),
  );
  return {
    entries,
    tree: objectOid("tree", tree),
    ids: [snapshot.commit, objectOid("tree", tree), ...entries.map((entry) => entry.oid)],
  };
}

async function assertCheckout(run, checkout, snapshot, graph, limits, lifetime) {
  const { entries, tree } = expectedObjects(snapshot);
  const oid = snapshot.commit;
  assert.equal(
    text(await run("checkout-tree", ["-C", checkout, "rev-parse", `${oid}^{tree}`])),
    tree,
  );
  const actualNames = (await lifetime.call("checkout-directory", checkout, () => readdir(checkout)))
    .filter((name) => name !== ".git")
    .sort();
  assert.deepEqual(actualNames, entries.map((entry) => entry.name).sort());
  for (const entry of entries) {
    const file = join(checkout, entry.name);
    const stat = await lifetime.call("checkout-file-stat", checkout, () => lstat(file));
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limits.maximumFileBytes);
    assert.deepEqual(
      await lifetime.call("checkout-file-bytes", checkout, () =>
        readFile(file, { signal: lifetime.signal }),
      ),
      entry.bytes,
    );
    assert.deepEqual(
      (await run("checkout-blob", ["-C", checkout, "cat-file", "blob", entry.oid])).stdout,
      entry.bytes,
    );
    assert.equal(stat.mode & 0o111, 0);
  }
  const graphOids = [...new Set(graph.flatMap((version) => expectedObjects(version).ids))].sort();
  const stored = text(
    await run("stored-objects", [
      "-C",
      checkout,
      "cat-file",
      "--batch-all-objects",
      "--batch-check=%(objectname)",
    ]),
  )
    .split("\n")
    .sort();
  assert.deepEqual(stored, graphOids);
  const reachable = text(
    await run("reachable-objects", ["-C", checkout, "rev-list", "--objects", graph.at(-1).commit]),
  )
    .split("\n")
    .map((line) => line.split(" ")[0])
    .sort();
  assert.deepEqual(reachable, graphOids);
  assert.equal(
    text(
      await run("worktree-status", [
        "-C",
        checkout,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]),
    ),
    "",
  );
}

/**
 * Real Git clone -> new trusted-origin commit -> fetch -> exact detached checkout
 * -> attempted push. Only this harness's child directory is removed. The caller
 * owns origin.close(). No build, install, provider request or default endpoint.
 * Successful return follows observed endpoint shutdown and local cleanup.
 * On rejection error.readClientEvidence records whether cleanup was confirmed.
 */
export function exerciseCloneFetch({
  root,
  git,
  origin,
  startEndpoint,
  signal,
  limits: input = {},
}) {
  const limits = readClientLimits(input);
  assert.equal(typeof startEndpoint, "function");
  const events = [];
  const evidence = { directory: undefined, endpointClosed: false, directoryRemoved: false, events };
  return withReadClientLifetime({ signal, limits, evidence }, async (lifetime) => {
    let directory;
    let endpoint;
    // Register original cleanup before acquisition: late startup/mkdtemp results
    // are adopted below and remain reachable until pending work actually joins.
    lifetime.cleanup("owned-scratch", root, async (cleanup) => {
      if (!directory) return;
      assert.ok(
        !endpoint || evidence.endpointClosed,
        "Owned scratch remains retained until endpoint retirement is observed.",
      );
      await cleanup.call("scratch-remove", directory, () =>
        rm(directory, { recursive: true, force: true }),
      );
      evidence.directoryRemoved = true;
    });
    lifetime.cleanup("owned-endpoint", startEndpoint, async (cleanup) => {
      if (!endpoint) return;
      await cleanup.call("endpoint-close", endpoint, () =>
        endpoint.close({ signal: cleanup.signal }),
      );
      const observed = await cleanup.call("endpoint-final-observe", endpoint, () =>
        endpoint.observe({ signal: cleanup.signal }),
      );
      assert.equal(readObservation(observed).activeConnections, 0);
      evidence.endpointClosed = true;
    });
    await protectedDirectory(root, lifetime);
    await selectedGit(git, lifetime);
    lifetime.check();
    assert.ok(origin && origin.external && typeof origin.external.currentSnapshot === "function");
    assert.match(origin.initialCommit, oidPattern);
    assert.equal(typeof origin.addCommit, "function");
    const initial = snapshotOrigin(origin, limits);
    assert.equal(
      initial.commit,
      origin.initialCommit,
      "Select a fresh initial external fixture graph.",
    );
    await lifetime.call(
      "scratch-create",
      root,
      () => mkdtemp(join(root, "read-client-")),
      (value) => {
        directory = value;
        evidence.directory = value;
      },
    );
    await lifetime.call("empty-template-create", directory, () =>
      mkdir(join(directory, "empty-template")),
    );
    const runGit = runner({ git, directory, signal: lifetime.signal, limits, events });
    const run = (phase, args, options) =>
      lifetime.call(`git:${phase}`, git, () => runGit(phase, args, options));
    assert.equal(text(await run("git-version", ["--version"])), "git version 2.55.0");
    await lifetime.call(
      "endpoint-start",
      startEndpoint,
      () => startEndpoint({ origin, signal: lifetime.signal, limits }),
      (value) => {
        endpoint = value;
      },
    );
    const selected = validateReadEndpoint(endpoint, origin.url);
    const before = readObservation(
      await lifetime.call("endpoint-observe", endpoint, () =>
        endpoint.observe({ signal: lifetime.signal }),
      ),
    );
    const checkout = join(directory, "checkout");
    const remote = [...selected.args];
    const gitAt = ["-C", checkout, ...remote];
    await run("clone", [
      ...remote,
      "clone",
      "--no-recurse-submodules",
      "--template",
      join(directory, "empty-template"),
      "--",
      selected.url,
      checkout,
    ]);
    const ref = async (name) =>
      text(await run("read-ref", ["-C", checkout, "rev-parse", "--verify", name]));
    assert.equal(await ref("HEAD"), origin.initialCommit);
    assert.equal(await ref("refs/heads/main"), origin.initialCommit);
    assert.equal(await ref("refs/remotes/origin/main"), origin.initialCommit);
    await assertCheckout(run, checkout, initial, [initial], limits, lifetime);
    const added = await lifetime.call("origin-add-commit", origin, () => origin.addCommit());
    assert.match(added.oid, oidPattern);
    assert.equal(added.parent, origin.initialCommit);
    assert.notEqual(added.oid, origin.initialCommit);
    const advanced = snapshotOrigin(origin, limits);
    assert.equal(advanced.commit, added.oid);
    assert.deepEqual(advanced.files, added.files);
    await run("fetch", [...gitAt, "fetch", "--no-recurse-submodules", "origin"]);
    // Fetch moves only the tracking ref; changing local files needs an explicit checkout.
    assert.equal(await ref("HEAD"), origin.initialCommit);
    assert.equal(await ref("refs/heads/main"), origin.initialCommit);
    assert.equal(await ref("refs/remotes/origin/main"), added.oid);
    assert.equal(await ref("FETCH_HEAD"), added.oid);
    assert.equal(
      text(await run("fetched-parent", ["-C", checkout, "rev-parse", `${added.oid}^`])),
      initial.commit,
    );
    await assertCheckout(run, checkout, initial, [initial, advanced], limits, lifetime);
    await run("checkout-fetched", ["-C", checkout, "checkout", "--detach", added.oid]);
    assert.equal(await ref("HEAD"), added.oid);
    await assertCheckout(run, checkout, advanced, [initial, advanced], limits, lifetime);
    const afterRead = readObservation(
      await lifetime.call("endpoint-observe", endpoint, () =>
        endpoint.observe({ signal: lifetime.signal }),
      ),
    );
    assert.ok(afterRead.discovery > before.discovery);
    assert.ok(afterRead.uploadPack > before.uploadPack);
    assert.equal(afterRead.upstreamReceivePack, before.upstreamReceivePack);
    const originRefs = () => run("origin-refs", [...gitAt, "ls-remote", "--refs", "origin"]);
    const expectedRefs = text(await originRefs());
    // A distinct unpublished commit ensures this cannot pass as a no-op push.
    await run("local-unpublished-commit", [
      "-C",
      checkout,
      "commit",
      "--allow-empty",
      "-m",
      "Must remain local",
    ]);
    const unpublished = await ref("HEAD");
    assert.notEqual(unpublished, added.oid);
    const pushed = await run(
      "refused-push",
      [...gitAt, "push", "--porcelain", "origin", "HEAD:refs/heads/read-mvp-must-not-publish"],
      { allowFailure: true },
    );
    assert.ok(
      pushed.code !== 0 && pushed.code !== null,
      "Publication must refuse with a completed Git failure.",
    );
    assert.equal(text(await originRefs()), expectedRefs);
    assert.deepEqual(snapshotOrigin(origin, limits), advanced);
    const afterPush = readObservation(
      await lifetime.call("endpoint-observe", endpoint, () =>
        endpoint.observe({ signal: lifetime.signal }),
      ),
    );
    assert.equal(afterPush.upstreamReceivePack, afterRead.upstreamReceivePack);
    lifetime.check();
    return {
      proofKind: selected.proofKind,
      cloneOid: origin.initialCommit,
      fetchedOid: added.oid,
      unpublishedOid: unpublished,
      publication: "refused",
      observations: { before, afterRead, afterPush },
    };
  });
}
