import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import test from "node:test";
import { RuntimeServiceTrustService } from "../../packages/occ/src/runtime-authority/service-trust.ts";
import { RepositoryWorkOriginOwnerV2 } from "../../packages/occ/src/runtime-authority/repository-work-origin-v2.ts";
import {
  githubMetadataDigest,
  githubGitReadDigest,
  EMPTY_BODY_SHA256,
} from "../../packages/occ/src/github-mediation-v2/wire.ts";
import {
  startGitHubMediationNative,
  validateNativeGitHubMediationProfile,
} from "../../apps/controller/src/admission/github-mediation-context.ts";
import {
  createRuntimeServiceTrustFixture,
  serviceRequest,
  sourceRequest,
  signal,
} from "../fixtures/runtime-service-trust.mjs";
const metadataBinaryPath = process.env.OCE_GITHUB_MEDIATION_TEST_BINARY;
const gitBinaryPath = process.env.OCC_GITHUB_GIT_READ_TEST_BINARY;
const fixturePath = process.env.OCE_GITHUB_MEDIATION_FIXTURE_BINARY;
// The existing identity owner's external fixture protocol harness is reused here.
// Only the Workload API and remote DS client are substituted. Registry/IAM, the
// native service, TLS, broker and Runtime origin implementation are actual code.
async function externalFixture(version) {
  const child = spawn(fixturePath, ["-test.run=^TestCrossLanguageFixture$"], {
    env: {
      ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
      OCE_GITHUB_BRIDGE_FIXTURE: "1",
      ...(version === 3 ? { OCE_GITHUB_BRIDGE_FIXTURE_PROTOCOL_VERSION: "3" } : {}),
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

for (const { version, operation, selectedVersion } of [
  { version: 2, operation: undefined, selectedVersion: 2 },
  { version: 3, operation: "discovery", selectedVersion: 3 },
  { version: 3, operation: "upload-pack", selectedVersion: 3 },
  { version: 3, operation: "upload-pack", selectedVersion: 2 },
  { version: 2, operation: undefined, selectedVersion: 3 },
]) {
  const binaryPath = version === 3 ? gitBinaryPath : metadataBinaryPath;
  test(
    `actual native v${version} ${operation ?? "metadata"} with Runtime v${selectedVersion} preserves original assignment boundary`,
    {
      timeout: 30000,
      skip:
        binaryPath && fixturePath
          ? false
          : "Select the actual native executable and external Workload API fixture.",
    },
    async (t) => {
      const external = await externalFixture(version);
      t.after(() => external.close());
      const profile = external.profile;
      const deployment = {
        listenPath: profile.listen_path,
        peerUid: profile.peer_uid,
        trustedAncestorUids: profile.trusted_ancestor_uids,
      };
      const f = await createRuntimeServiceTrustFixture({
        binaryPath,
        sourceOverrides: {
          workloadApiSocketPath: profile.workload_api_socket_path,
          ownSPIFFEId: profile.own_spiffe_id,
          recipientSPIFFEId: profile.recipient_spiffe_id,
          trustDomain: new URL(profile.own_spiffe_id).hostname,
          trustBundleSha256: profile.trust_bundle_sha256,
          transportProfileRef:
            version === 3
              ? "owned-child-stdio-github-git-read-v3"
              : "owned-child-stdio-github-metadata-v2",
        },
      });
      t.after(() => f.close());
      const trust = new RuntimeServiceTrustService({
        ...f.options,
        validateProfile: (value, signal) =>
          validateNativeGitHubMediationProfile(binaryPath, value, deployment, signal),
      });
      await trust.apply(sourceRequest(f.source.sourceRef), f.context, signal());
      const admitted = await trust.apply(
        serviceRequest(f, {
          operationPolicy: version === 3 ? "github-git-read-rpc-v3" : "github-metadata-rpc-v2",
          peerSPIFFEId: profile.peer_spiffe_id,
        }),
        f.context,
        signal(),
      );
      assert.equal(admitted.result, "applied");
      let reachedAssignment = 0;
      let returnedOrigin = false;
      let runtime;
      const denied = () => {
        throw new Error("No original assignment/Work/custody supplier installed.");
      };
      const endpoint = await startGitHubMediationNative({
        protocolVersion: version,
        ...deployment,
        binaryPath,
        serviceIdentityRef: admitted.record.subjectRef,
        installationId: f.owner.installation.id,
        recipientRef: f.source.recipientRef,
        trust,
        limits: {
          maximumSessions: 1,
          maximumCallMilliseconds: 3000,
          maximumOperationMilliseconds: 30000,
          maximumLeaseMilliseconds: 2000,
          clockAllowanceMilliseconds: 100,
        },
        operationsFactory: {
          create(native) {
            runtime = new RepositoryWorkOriginOwnerV2({
              protocolVersion: selectedVersion,
              trust,
              native,
              limits: {
                maximumOrigins: 1,
                maximumCallMilliseconds: 2500,
                maximumOperationMilliseconds: 30000,
                maximumLeaseMilliseconds: 2000,
                clockAllowanceMilliseconds: 100,
              },
              assignments: {
                bindOrigins: () => undefined,
                async acquire(request, original, call) {
                  // Genuine native membership, then deliberate absence of assignment.
                  // No positive State response, original Work or prepared handle exists.
                  await assert.rejects(native.inspect({ ...original }, call));
                  const current = await native.inspect(original, call);
                  native.assertCurrent(original, call);
                  assert.equal(current.context, call.context);
                  assert.equal(current.verified.transportBinding, original.transportBinding);
                  assert.equal(
                    current.verified.configuration.serviceIdentityRef,
                    admitted.record.subjectRef,
                  );
                  assert.equal(current.verified.configuration.role, "repository-issuer");
                  assert.notEqual(current.lifetime, call.signal);
                  assert.equal(current.lifetime.aborted, false);
                  assert.equal(original.attachmentRef, request.attachment_ref);
                  assert.equal(request.version, version);
                  if (version === 3) {
                    assert.equal(request.git_operation, operation);
                    assert.equal(request.git_protocol, "version=2");
                    assert.equal(request.body_bytes, operation === "discovery" ? 0 : 123);
                    assert.equal(
                      request.body_sha256,
                      operation === "discovery" ? EMPTY_BODY_SHA256 : "sha256:" + "a".repeat(64),
                    );
                    assert.equal(
                      request.request_sha256,
                      githubGitReadDigest(
                        "openclaw",
                        "example",
                        operation,
                        request.body_bytes,
                        request.body_sha256,
                      ),
                    );
                  }
                  reachedAssignment++;
                  return undefined;
                },
                inspect: denied,
                assertCurrent: denied,
                release: denied,
              },
            });
            return {
              async prepare(request, call) {
                const origin = await runtime.acquire(request, call);
                returnedOrigin = origin !== undefined;
                await runtime.close();
                return { kind: "refused", code: "unavailable" };
              },
              dispatch: denied,
              check: denied,
              writeRelease: denied,
              settle: denied,
            };
          },
        },
      });
      t.after(async () => {
        await runtime?.close();
        await endpoint.close();
      });
      const session = "runtime-origin/refusal";
      assert.equal(
        (await external.command("connect", { session }).wait("connected")).kind,
        "connected",
      );
      const metadata = {
        version,
        sequence: 1,
        request_ref: randomBytes(16).toString("hex"),
        method: "open-read",
        attachment_ref: "attachment/absent",
        repository_owner: "openclaw",
        repository_name: "example",
        request_sha256:
          version === 3
            ? githubGitReadDigest(
                "openclaw",
                "example",
                operation,
                operation === "discovery" ? 0 : 123,
                operation === "discovery" ? EMPTY_BODY_SHA256 : "sha256:" + "a".repeat(64),
              )
            : githubMetadataDigest("openclaw", "example"),
        ...(version === 3
          ? {
              git_operation: operation,
              git_protocol: "version=2",
              body_bytes: operation === "discovery" ? 0 : 123,
              body_sha256:
                operation === "discovery" ? EMPTY_BODY_SHA256 : "sha256:" + "a".repeat(64),
            }
          : {}),
      };
      const request = external.command("request", { session, metadata });
      assert.equal((await request.wait("request-started")).kind, "request-started");
      const response = await request.wait("response");
      assert.equal(response.kind, "response");
      assert.equal(response.secret_length, 0);
      assert.equal(response.metadata.code, "unavailable");
      assert.equal(response.metadata.request_ref, metadata.request_ref);
      assert.equal(reachedAssignment, version === selectedVersion ? 1 : 0);
      assert.equal(returnedOrigin, false);
      assert.equal((await external.command("close", { session }).wait("closed")).kind, "closed");
    },
  );
}
