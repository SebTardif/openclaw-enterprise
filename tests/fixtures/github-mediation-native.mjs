import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { RuntimeServiceTrustService } from "../../packages/occ/src/index.ts";
import {
  startGitHubMediationNative,
  validateNativeGitHubMediationProfile,
} from "../../apps/controller/src/admission/github-mediation-context.ts";
import {
  createRuntimeServiceTrustFixture,
  serviceRequest,
  sourceRequest,
  signal,
} from "./runtime-service-trust.mjs";

const binaryPath = process.env.OCE_GITHUB_MEDIATION_TEST_BINARY;
const fixturePath = process.env.OCE_GITHUB_MEDIATION_FIXTURE_BINARY;
export const nativeFixtureSelected = binaryPath && fixturePath;

// External Workload API and DS network fixture only. This helper does not
// authorize Work or manufacture an original State/custody release.
export async function externalFixture(protocolVersion = 2, scenario = "ordinary") {
  assert.ok(protocolVersion === 2 || protocolVersion === 3);
  assert.ok(scenario === "ordinary" || scenario === "server-expiry");
  const child = spawn(fixturePath, ["-test.run=^TestCrossLanguageFixture$"], {
    env: {
      ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
      OCE_GITHUB_BRIDGE_FIXTURE: "1",
      ...(protocolVersion === 3 ? { OCE_GITHUB_BRIDGE_FIXTURE_PROTOCOL_VERSION: "3" } : {}),
      ...(scenario === "server-expiry"
        ? { OCE_GITHUB_BRIDGE_FIXTURE_SCENARIO: "server-expiry" }
        : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let ended = false;
  let sequence = 0;
  let errorOutput = "";
  const queued = [];
  const waiters = new Set();
  const exited = new Promise((resolve) => child.once("close", resolve));
  child.once("error", () => {});
  child.stderr.on("data", (chunk) => {
    errorOutput = (errorOutput + chunk).slice(-4096);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (line === "PASS") return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      errorOutput = (errorOutput + line).slice(-4096);
      return;
    }
    const match = [...waiters].find((waiter) => waiter.matches(event));
    if (match) {
      waiters.delete(match);
      match.resolve(event);
    } else queued.push(event);
  });
  void exited.then(() => {
    ended = true;
    for (const waiter of waiters)
      waiter.reject(new Error(`External fixture exited: ${errorOutput}`));
    waiters.clear();
  });
  const wait = (matches) => {
    const index = queued.findIndex(matches);
    if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
    if (ended) return Promise.reject(new Error(`External fixture exited: ${errorOutput}`));
    return new Promise((resolve, reject) => {
      let waiter;
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`External fixture response timed out: ${errorOutput}`));
      }, 6000);
      waiter = {
        matches,
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      waiters.add(waiter);
    });
  };
  const command = (kind, fields = {}) => {
    const command_id = `command/${++sequence}`;
    child.stdin.write(`${JSON.stringify({ kind, command_id, ...fields })}\n`);
    return {
      command_id,
      wait: (eventKind) =>
        wait(
          (event) =>
            event.command_id === command_id &&
            (event.kind === eventKind || event.kind === "failed"),
        ),
    };
  };
  const ready = await wait((event) => event.kind === "ready");
  return {
    profile: ready.native_profile,
    clientMaximumConnectionAgeMilliseconds: ready.client_max_connection_age_ms,
    command,
    async close() {
      if (!ended) {
        const stopping = command("shutdown");
        try {
          await stopping.wait("stopped");
        } finally {
          child.stdin.end();
        }
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
        lines.close();
      }
      assert.equal(child.exitCode, 0, errorOutput);
    },
  };
}

// Actual service admission backed by InMemoryPlatformState. Callers requiring
// shared PostgreSQL authority can reuse externalFixture with their own original
// registry/State assembly. Interface phase fixtures do not prove that assembly.
export async function actualAssembly(
  t,
  operationsFactory,
  protocolVersion = 2,
  scenario = "ordinary",
) {
  assert.ok(protocolVersion === 2 || protocolVersion === 3);
  const selectedBinary =
    protocolVersion === 3 ? process.env.OCC_GITHUB_GIT_READ_TEST_BINARY : binaryPath;
  const external = await externalFixture(protocolVersion, scenario);
  t.after(() => external.close());
  const native = external.profile;
  const deployment = Object.freeze({
    listenPath: native.listen_path,
    peerUid: native.peer_uid,
    trustedAncestorUids: Object.freeze([...native.trusted_ancestor_uids]),
  });
  const f = await createRuntimeServiceTrustFixture({
    binaryPath: selectedBinary,
    sourceOverrides: {
      workloadApiSocketPath: native.workload_api_socket_path,
      ownSPIFFEId: native.own_spiffe_id,
      recipientSPIFFEId: native.recipient_spiffe_id,
      trustDomain: new URL(native.own_spiffe_id).hostname,
      trustBundleSha256: native.trust_bundle_sha256,
      transportProfileRef:
        protocolVersion === 3
          ? "owned-child-stdio-github-git-read-v3"
          : "owned-child-stdio-github-metadata-v2",
    },
  });
  t.after(() => f.close());
  // Retain the actual state, IAM engine and authenticated actor from the existing
  // fixture, and select this use's actual native parser at the admission seam.
  const trust = new RuntimeServiceTrustService({
    ...f.options,
    validateProfile: (profile, requestSignal) =>
      validateNativeGitHubMediationProfile(selectedBinary, profile, deployment, requestSignal),
  });
  await trust.apply(sourceRequest(f.source.sourceRef), f.context, signal());
  const admitted = await trust.apply(
    serviceRequest(f, {
      operationPolicy: protocolVersion === 3 ? "github-git-read-rpc-v3" : "github-metadata-rpc-v2",
      peerSPIFFEId: native.peer_spiffe_id,
    }),
    f.context,
    signal(),
  );
  assert.equal(admitted.result, "applied");
  assert.equal(admitted.record.configuration.role, "repository-issuer");
  const serviceIdentityRef = admitted.record.subjectRef;
  const endpoint = await startGitHubMediationNative({
    ...deployment,
    binaryPath: selectedBinary,
    ...(protocolVersion === 3 ? { protocolVersion: 3 } : {}),
    serviceIdentityRef,
    installationId: f.owner.installation.id,
    recipientRef: f.source.recipientRef,
    trust,
    ...(operationsFactory ? { operationsFactory } : {}),
    limits: {
      maximumSessions: 1,
      maximumCallMilliseconds: 3000,
      maximumOperationMilliseconds: 30000,
      maximumLeaseMilliseconds: 2000,
      clockAllowanceMilliseconds: 100,
    },
  });
  t.after(() => endpoint.close());
  return { external, endpoint, trust, f, serviceIdentityRef };
}
