import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { vectors as v } from "./accepted-fixtures.mjs";

const root = new URL("../../../", import.meta.url);
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export function sourceBinding() {
  const owned = readdirSync(new URL("./", import.meta.url))
    .filter((name) => /\.(ts|mjs|json)$/.test(name))
    .map((name) => `tests/runtime/direct-compute-interruption/${name}`);
  const paths = [
    ...owned,
    ...["packages/contracts/src/", "packages/utils/src/"].flatMap((directory) =>
      readdirSync(new URL(directory, root), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => `${entry.parentPath}/${entry.name}`.slice(fileURLToPath(root).length)),
    ),
    "package.json",
    "packages/contracts/package.json",
    "packages/utils/package.json",
    "pnpm-workspace.yaml",
    "tests/fixtures/runtime-effects-v1/vectors.mjs",
    "tests/fixtures/runtime-effects-v1/lifecycle-consumer.ts",
    "tests/fixtures/kubernetes-lifecycle-collaborators/scenarios.mjs",
    "pnpm-lock.yaml",
  ].sort();
  const git = (...args) =>
    execFileSync("git", args, { cwd: fileURLToPath(root), encoding: "utf8" }).trim();
  return {
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    files: paths.map((path) => ({ path, sha256: digest(readFileSync(new URL(path, root))) })),
  };
}

export function scenarioInput(scenarioId, source = sourceBinding()) {
  const method = scenarioId.split("/")[0];
  const requests = { create: v.createRequest, observe: v.candidate, setRoute: v.routeRequest };
  // Unknown scenario IDs still reach the runner's closed-manifest refusal.
  const request = (requests[method] ?? v.createRequest)();
  const create = v.createRequest();
  return {
    scenarioId,
    binding: {
      schemaVersion: 1,
      evidenceKind: "controlled-preparation",
      source,
      fixtureRef: "runtime-effects-v1/representation-fixtures",
      imageDigests: v.binding().imageDigests,
      imageSetDigest: create.admittedRuntime.imageSetDigest,
      configurationDigest: create.admittedRuntime.configurationDigest,
      runtimeProfileDigest: create.admittedRuntime.runtimeProfileDigest,
      ownedResources: [v.providerTarget(), v.providerTarget(2, "Service")],
    },
    request,
    cleanup: null,
    callTimeoutMs: 100,
    maxReadbacks: 2,
  };
}

export function retainedCleanup() {
  const request = v.stopRequest();
  request.effect.target = v.target();
  request.providerTarget = v.providerTarget();
  request.predicate = v.expectedObject();
  request.binding = v.binding();
  return v.signRequest(request);
}

/** Passive transport scripting. It contains no admission, ownership, discovery,
 * retry, cleanup or lifecycle decisions. The runner must make those decisions.
 * The inert context is never sent to a real accepting boundary or authenticated.
 */
export function controlledSession(input, behavior = {}) {
  const calls = [];
  const signal = behavior.signal ?? new AbortController().signal;
  let checkpoint;
  let opened = 0;
  const response = (name, request) => {
    if (Object.hasOwn(behavior, name)) {
      const selected = behavior[name];
      return typeof selected === "function" ? selected(request, calls) : structuredClone(selected);
    }
    if (name === "discover")
      return {
        schemaVersion: 1,
        status: "incomplete",
        input: request,
        reasonCode: "evidence-incomplete",
      };
    if (name === "observe")
      return {
        schemaVersion: 1,
        status: "unknown",
        input: request,
        reasonCode: "provider-outcome-unknown",
      };
    if (name === "readEffect")
      return { schemaVersion: 1, effect: request, status: "not-found", outcome: "unknown" };
    return v.unknownResult(request);
  };
  const effects = Object.fromEntries(
    ["create", "observe", "setRoute", "discover", "readEffect", "stopRetainingState"].map(
      (name) => [
        name,
        async (request, call) => {
          calls.push({ name, request, call });
          behavior.onCall?.(name, request, call);
          const isPrimary = calls.length === 1;
          if (isPrimary && !behavior.omitCheckpoints) {
            checkpoint("possible-submission");
          }
          const value = await response(name, request);
          if (
            isPrimary &&
            !behavior.omitCheckpoints &&
            input.scenarioId.endsWith("lost-acknowledgment")
          )
            checkpoint("response-produced");
          return value;
        },
      ],
    ),
  );
  return {
    calls,
    get opened() {
      return opened;
    },
    options: {
      signal,
      openSession(callback) {
        opened++;
        checkpoint = callback;
        behavior.onOpen?.();
        return { effects, context: Object.freeze({}), recipientRef: "controlled-fixture-only" };
      },
    },
  };
}
