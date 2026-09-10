import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { actualAssembly } from "../github-mediation-native.mjs";
import {
  EMPTY_BODY_SHA256,
  githubGitReadDigest,
  githubMetadataDigest,
} from "../../../packages/occ/src/github-mediation-v2/wire.ts";

// Both protocols use cmd/oce-github-mediation. The explicitly admitted profile
// selects metadata V2 or Git READ V3; a binary filename cannot select a protocol.
// The Go test executable must contain the maintained TestCrossLanguageFixture.
export function nativeSelection(protocolVersion) {
  assert.ok(protocolVersion === 2 || protocolVersion === 3);
  return Object.freeze({
    protocolVersion,
    binaryPath:
      protocolVersion === 3
        ? process.env.OCC_GITHUB_GIT_READ_TEST_BINARY
        : process.env.OCE_GITHUB_MEDIATION_TEST_BINARY,
    fixturePath: process.env.OCE_GITHUB_MEDIATION_FIXTURE_BINARY,
  });
}

export function nativeTestOptions(protocolVersion) {
  const selected = nativeSelection(protocolVersion);
  return {
    timeout: 30000,
    skip:
      selected.binaryPath && selected.fixturePath
        ? false
        : `Select absolute paths to the current V${protocolVersion} native executable and external Workload API fixture.`,
  };
}

export async function selectedNativeAssembly(t, operationsFactory, protocolVersion) {
  const selected = nativeSelection(protocolVersion);
  assert.ok(selected.binaryPath && isAbsolute(selected.binaryPath));
  assert.ok(selected.fixturePath && isAbsolute(selected.fixturePath));
  // Reuse the original State, IAM, authenticated actor, native validation and
  // remote TLS client. No reconstructed registry or diagnostic-to-context seam.
  return actualAssembly(t, operationsFactory, protocolVersion);
}

export function openRead(protocolVersion) {
  assert.ok(protocolVersion === 2 || protocolVersion === 3);
  return {
    version: protocolVersion,
    sequence: 1,
    request_ref: randomBytes(16).toString("hex"),
    method: "open-read",
    attachment_ref: "attachment/read-mvp-native-client",
    repository_owner: "openclaw",
    repository_name: "example",
    ...(protocolVersion === 3
      ? {
          git_operation: "discovery",
          git_protocol: "version=2",
          body_bytes: 0,
          body_sha256: EMPTY_BODY_SHA256,
        }
      : {}),
    request_sha256:
      protocolVersion === 3
        ? githubGitReadDigest("openclaw", "example", "discovery", 0, EMPTY_BODY_SHA256)
        : githubMetadataDigest("openclaw", "example"),
  };
}

export function deferred() {
  const result = Promise.withResolvers();
  result.promise.catch(() => {});
  return result;
}

// The production broker intentionally hides operation errors from its remote
// caller. Preserve assertion failures through a separate test observation port.
export function refusingNativeConsumer(visit) {
  const failure = deferred();
  let caught;
  const forbidden = async () => {
    const error = new Error("This native boundary consumer authorizes no Work or dispatch.");
    caught = error;
    failure.reject(error);
    throw error;
  };
  return {
    factory: {
      create(source) {
        return {
          async prepare(request, call) {
            try {
              await visit({ source, request, call });
              return { kind: "refused", code: "unavailable" };
            } catch (error) {
              caught = error;
              failure.reject(error);
              throw error;
            }
          },
          dispatch: forbidden,
          check: forbidden,
          writeRelease: forbidden,
          settle: forbidden,
        };
      },
    },
    waitFor: (promise) => Promise.race([promise, failure.promise]),
    assertHealthy() {
      if (caught) throw caught;
    },
  };
}

export async function inspectOriginal(source, request, call) {
  const held = await source.acquire(request, call);
  assert.ok(held, "the original authenticated request must acquire its native Session");
  const observed = await source.inspect(held, call);
  assert.equal(observed.context, call.context);
  assert.equal(observed.verified.transportBinding, held.transportBinding);
  assert.equal(observed.lifetime, held.signal);
  assert.equal(held.signal.aborted, false);
  source.assertCurrent(held, call);
  return { source, request, call, held, observed };
}

export function waitForAbort(signal, milliseconds = 1500) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      reject(new Error("Original native lifetime did not cancel before the observation bound."));
    }, milliseconds);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}

export function assertRefused(response, request) {
  assert.equal(response.kind, "response");
  assert.equal(response.secret_length, 0);
  assert.deepEqual(response.metadata, {
    version: request.version,
    sequence: 1,
    request_ref: request.request_ref,
    ok: false,
    code: "unavailable",
  });
}
