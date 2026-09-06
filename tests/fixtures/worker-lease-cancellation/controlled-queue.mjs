import { registerHooks } from "node:module";
export { WorkClaimLostError } from "../../../packages/occ/src/state/postgres-work-queue.ts";

const installedHelper = new URL(
  "../../../apps/controller/src/worker/leased-effect.ts",
  import.meta.url,
);
const canonicalQueue = new URL(
  "../../../packages/occ/src/state/postgres-work-queue.ts",
  import.meta.url,
);

// The unprepared OCC barrel reaches unrelated SDK modules. Resolve only this
// installed helper's one bare import to the actual canonical queue module.
// No source is replaced: this is not full OCC-barrel, SDK or database proof.
export async function loadInstalledLeasedEffects() {
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL === installedHelper.href && specifier === "@openclaw-enterprise/occ")
        return nextResolve(canonicalQueue.href, context);
      return nextResolve(specifier, context);
    },
  });
  try {
    return await import(installedHelper.href);
  } finally {
    hook.deregister();
  }
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function claim() {
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const instant = new Date();
  const revisionId = `rev_${uuid(3)}`;
  return {
    idempotencyKey: `agent_revision:${revisionId}:reconcile`,
    namespaceId: `ns_${uuid(1)}`,
    agentId: `agt_${uuid(2)}`,
    revisionId,
    actorId: "principal/lease-test",
    runtimeTransitionRef: uuid(4),
    lifecycleGeneration: 1,
    state: "claimed",
    claimToken: uuid(5),
    leaseExpiresAt: new Date(instant.getTime() + 60_000),
    availableAt: instant,
    attemptCount: 1,
    createdAt: instant,
    updatedAt: instant,
  };
}

// Scripted boundary results only: no lease decisions or queue logic is modeled.
export function controlledQueue(...responses) {
  const calls = [];
  return {
    calls,
    async heartbeat(input) {
      const response = responses[calls.length];
      calls.push(input);
      if (!response) throw new Error("Unexpected controlled heartbeat call.");
      return response(input);
    },
  };
}
