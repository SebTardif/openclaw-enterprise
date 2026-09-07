import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { fixtureIdentityLimits } from "../runtime-identity-v1/verifier-producer.ts";

export const peerSPIFFEId =
  "spiffe://runtime-peer.test/runtime/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/harness";
export const recipientSPIFFEId = "spiffe://runtime-peer.test/service/acceptor";
const digest = `sha256:${"a".repeat(64)}`;
/** Controlled canonical registration input only. This is no sandbox attestation,
 * deployment enrollment, live issuer, or current-purpose authority evaluator. */
export function registrationFixture(time = Date.now()) {
  return {
    assignment: {
      schemaVersion: 1,
      allocation: {
        installationId: "ins_11111111-1111-4111-8111-111111111111",
        namespaceId: "ns_22222222-2222-4222-8222-222222222222",
        agentId: "agt_33333333-3333-4333-8333-333333333333",
        providerProfileRef: "fixture/provider",
        runtimeProfileRef: "fixture/runtime",
        identityProfileRef: "identity/example-v1",
        assignmentRef: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        createEffectRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        revisionId: "rev_44444444-4444-4444-8444-444444444444",
        servicePrincipalId: "fixture/service",
        lifecycleGeneration: 1,
        component: "harness",
        runtimeGeneration: 1,
        bindingCondition: "unbound",
        createdAt: new Date(time - 1000).toISOString(),
      },
      binding: {
        status: "bound",
        instance: {
          schemaVersion: 1,
          bindingVersion: 1,
          provider: "occ/kubernetes-gvisor",
          component: "harness",
          clusterRef: "fixture/cluster",
          kubernetesNamespaceUid: "fixture/namespace",
          podUid: "fixture/pod",
          deploymentUid: "fixture/deployment",
          replicaSetUid: "fixture/replicaset",
          imageDigests: [{ name: "harness", digest }],
          policyRevision: "fixture/policy",
          admittedConfigurationDigest: digest,
          profileDigests: { provider: digest, runtime: digest, identity: digest },
          runtimeClass: "oce-gvisor-systrap",
          runtimeHandler: "oce-gvisor-systrap",
          runtimeType: "io.containerd.runsc.v1",
          platform: "systrap",
          isolation: "STRICT",
          runscSandboxId: "fixture/sandbox",
          runtimeInstanceRef: "fixture/instance",
          protectedRestartDiscriminator: "fixture/restart",
          runtimeBinaryDigest: digest,
          runtimeDistributionDigest: digest,
          runtimeFlagsDigest: digest,
        },
      },
      authority: { state: "active", assignmentRecordVersion: 1 },
    },
    spiffeId: peerSPIFFEId,
    registrationId: "fixture/registration",
    registrationVersion: 1,
    identityProfileRef: "identity/example-v1",
    bundleSetVersion: 1,
    sourceEvidenceRef: "fixture/registration-evidence",
    observedAt: new Date(time).toISOString(),
    validUntil: new Date(time + 1000).toISOString(),
  };
}
export function expectationFixture(registration = registrationFixture()) {
  const a = registration.assignment.allocation;
  return {
    target: {
      installationId: a.installationId,
      namespaceId: a.namespaceId,
      agentId: a.agentId,
      assignmentRef: { schemaVersion: 1, id: a.assignmentRef },
      revisionId: a.revisionId,
      component: a.component,
      lifecycleGeneration: a.lifecycleGeneration,
      runtimeGeneration: a.runtimeGeneration,
      createEffectRef: a.createEffectRef,
    },
    expectedPeerSPIFFEId: peerSPIFFEId,
    recipientRef: "fixture/recipient",
    identityProfileRef: "identity/example-v1",
    limits: { ...fixtureIdentityLimits },
  };
}
export function callFixture(time = Date.now(), overrides = {}) {
  return {
    requestRef: `request/${randomUUID()}`,
    recipientRef: "fixture/recipient",
    deadline: new Date(time + 1000).toISOString(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

// A bounded cleanup failure retains the original child until its actual close
// event. A timeout must not drop process/pipe ownership or report settlement.
const retainedChildren = new Set();

/** Test-only original helper/pipe owner. The token map is private; callers cannot
 * reconstruct a connection from a JSON event or fixture label. No production
 * protocol or Gateway profile is added by this command channel. */
export async function startNativePeerFixture(binary, options = {}) {
  const child = spawn(binary, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      OCE_RUNTIME_PEER_FIXTURE_LIFETIME_MS: String(options.lifetimeMs ?? 20000),
    },
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  const connections = new WeakMap();
  let sequence = 0,
    closed = false,
    readyResolve,
    readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let childClosed = false,
    cleanup;
  retainedChildren.add(child);
  const joined = new Promise((resolve) =>
    child.once("close", () => {
      childClosed = true;
      retainedChildren.delete(child);
      lines.close();
      stop();
      resolve();
    }),
  );
  const stop = () => {
    closed = true;
    readyReject(new Error("native fixture unavailable"));
    for (const item of pending.values()) item.reject(new Error("native fixture unavailable"));
    pending.clear();
  };
  function terminateAndJoin() {
    if (cleanup) return cleanup;
    stop();
    // This parent owns these pipes. EOF and signal cancellation both unblock
    // the helper's maintained nonblocking owned input descriptor.
    child.stdin.destroy();
    if (!childClosed) child.kill("SIGTERM");
    cleanup = (async () => {
      let forceTimer, boundTimer;
      const bounded = new Promise((resolve) => {
        forceTimer = setTimeout(() => {
          if (!childClosed) child.kill("SIGKILL");
        }, 250);
        boundTimer = setTimeout(() => resolve(false), 2000);
      });
      try {
        const settled = await Promise.race([joined.then(() => true), bounded]);
        if (!settled) {
          // The error exposes actual future settlement without pretending that
          // a kill request or elapsed budget released the original resources.
          const error = new Error("native fixture cleanup unsettled");
          Object.defineProperty(error, "settlement", { value: joined });
          throw error;
        }
      } finally {
        clearTimeout(forceTimer);
        clearTimeout(boundTimer);
      }
    })();
    // Event callbacks start cleanup immediately. Their callers subsequently
    // await the same original promise; suppress only an unhandled rejection.
    void cleanup.catch(() => {});
    return cleanup;
  }
  const fail = () => {
    void terminateAndJoin();
  };
  child.once("error", fail);
  child.stdin.on("error", fail);
  child.stdout.on("error", fail);
  child.stderr.on("error", fail);
  // Consume diagnostics without exposing provider output in assertions.
  child.stderr.on("data", () => {});
  let readySeen = false;
  lines.on("line", (line) => {
    if (closed) return;
    if (line.length > 32768) {
      fail();
      return;
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      fail();
      return;
    }
    if (value.kind === "ready" && !readySeen) {
      readySeen = true;
      readyResolve(value);
      return;
    }
    const waiter = pending.get(value.id);
    if (!waiter || value.challenge !== waiter.challenge) {
      fail();
      return;
    }
    pending.delete(value.id);
    waiter.resolve(value);
  });
  async function command(kind, body = {}, signal) {
    if (closed || signal?.aborted) throw new Error("native fixture unavailable");
    const id = String(++sequence),
      challenge = randomUUID();
    let timer, abort;
    const response = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, challenge });
      abort = fail;
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(fail, 3000);
      child.stdin.write(`${JSON.stringify({ id, challenge, kind, ...body })}\n`);
    });
    try {
      return await response;
    } catch {
      await terminateAndJoin();
      throw new Error("native fixture unavailable");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  const readyTimer = setTimeout(fail, 5000);
  const startupSignal = options.signal;
  startupSignal?.addEventListener("abort", fail, { once: true });
  if (startupSignal?.aborted) fail();
  try {
    await ready;
  } catch {
    await terminateAndJoin();
    throw new Error("native fixture unavailable");
  } finally {
    clearTimeout(readyTimer);
    startupSignal?.removeEventListener("abort", fail);
  }
  return Object.freeze({
    async connect() {
      const response = await command("connect");
      if (response.error) throw new Error("native TLS connection failed");
      const connection = Object.freeze(Object.create(null));
      connections.set(connection, {
        handle: response.handle,
        incarnation: Object.freeze(Object.create(null)),
        connectionRef: `fixture/connection-${response.handle}`,
      });
      return connection;
    },
    native: Object.freeze({
      async inspect(connection, call) {
        const owned = connections.get(connection);
        if (!owned || closed)
          return {
            schemaVersion: 1,
            kind: "transport-failure",
            reasonCode: "connection-closed",
            requestRef: call.requestRef,
          };
        const response = await command("inspect", { handle: owned.handle }, call.signal);
        if (response.error)
          return {
            schemaVersion: 1,
            kind: "transport-failure",
            reasonCode: "connection-closed",
            requestRef: call.requestRef,
          };
        if (
          response.peerSPIFFEId !== peerSPIFFEId ||
          response.recipientSPIFFEId !== recipientSPIFFEId
        )
          throw new Error("fixture native correspondence failed");
        return {
          kind: "inspected",
          observation: {
            connection,
            incarnation: owned.incarnation,
            connectionRef: owned.connectionRef,
            peerSPIFFEId: response.peerSPIFFEId,
            recipientRef: "fixture/recipient",
            identityProfileRef: "identity/example-v1",
            bundleSetVersion: 1,
            peerEvidenceRef: response.peerEvidenceRef,
            authenticatedAt: response.authenticatedAt,
            inspectedAt: response.inspectedAt,
            expiresAt: response.expiresAt,
          },
        };
      },
    }),
    /** Explicit controlled canonical record, freshly read only after inspecting
     * this original native connection. Its values are not native attestation. */
    registration(observation) {
      return Object.freeze({
        async resolve(connection, expected, call) {
          const owned = connections.get(connection);
          if (!owned || closed)
            return {
              schemaVersion: 1,
              kind: "verification-failure",
              reasonCode: "lookup-unavailable",
              requestRef: call.requestRef,
            };
          const response = await command("inspect", { handle: owned.handle }, call.signal);
          if (response.error)
            return {
              schemaVersion: 1,
              kind: "verification-failure",
              reasonCode: "lookup-unavailable",
              requestRef: call.requestRef,
            };
          return {
            kind: "observed",
            observation: {
              ...structuredClone(observation),
              observedAt: new Date().toISOString(),
              validUntil: new Date(Date.now() + 1000).toISOString(),
            },
          };
        },
      });
    },
    async disconnect(connection) {
      const owned = connections.get(connection);
      if (owned) await command("disconnect", { handle: owned.handle });
    },
    // Actual close-event settlement includes the child's stdio, unlike exit.
    settlement: joined,
    async interruptPartialInput() {
      // Deliberate native cancellation fixture: leave Scanner an incomplete
      // command and close only through this original child's owner.
      try {
        await new Promise((resolve, reject) =>
          child.stdin.write('{"id":', (error) => (error ? reject(error) : resolve())),
        );
      } finally {
        await terminateAndJoin();
      }
    },
    async close() {
      try {
        if (!closed) await command("shutdown");
      } finally {
        await terminateAndJoin();
      }
    },
  });
}
