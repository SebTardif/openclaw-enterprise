import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  EMPTY_BODY_SHA256,
  githubGitReadDigest,
  githubMetadataDigest,
} from "../../packages/occ/src/github-mediation-v2/wire.ts";
import { actualAssembly } from "../fixtures/github-mediation-native.mjs";

// This file proves the existing authenticated native owner's shutdown boundary.
// Its assembly uses actual controller authentication, IAM, State enrollment,
// native profile validation and native processes. The external Workload API and
// remote client are controlled. No repository operation owner is supplied.
// TODO(read MVP M3): add entered Work/State/custody lifecycle acceptance after the
// original selected-execution admission producer and read composition exist.
// Native retirement alone does not prove token cleanup or a persisted outcome.

function openRequest(version) {
  return {
    version,
    sequence: 1,
    request_ref: randomBytes(16).toString("hex"),
    method: "open-read",
    attachment_ref: "attachment/read-mvp-lifecycle",
    repository_owner: "openclaw",
    repository_name: "example",
    ...(version === 3
      ? {
          git_operation: "discovery",
          git_protocol: "version=2",
          body_bytes: 0,
          body_sha256: EMPTY_BODY_SHA256,
        }
      : {}),
    request_sha256:
      version === 3
        ? githubGitReadDigest("openclaw", "example", "discovery", 0, EMPTY_BODY_SHA256)
        : githubMetadataDigest("openclaw", "example"),
  };
}

for (const version of [2, 3]) {
  const nativeSelected =
    process.env.OCE_GITHUB_MEDIATION_FIXTURE_BINARY &&
    (version === 3
      ? process.env.OCC_GITHUB_GIT_READ_TEST_BINARY
      : process.env.OCE_GITHUB_MEDIATION_TEST_BINARY);
  test(
    `v${version} authenticated native shutdown joins a submitted remote RPC and independently observed process retirement`,
    {
      timeout: 30000,
      skip: nativeSelected
        ? false
        : "Select the current native executable and matching external Workload API fixture binary.",
    },
    async (t) => {
      const { external, endpoint } = await actualAssembly(t, undefined, version);
      const session = `mvp-retirement-v${version}`;
      assert.equal(
        (await external.command("connect", { session }).wait("connected")).kind,
        "connected",
      );

      // OS-stop only the fixture's independently authenticated native peer. The
      // request is then physically submitted by the real remote client while
      // the native child cannot consume it or return an acknowledgment.
      const paused = await external.command("pause-peer", { session }).wait("peer-paused");
      assert.equal(paused.kind, "peer-paused");
      assert.equal(paused.state, "stopped");
      let rpc;
      try {
        rpc = external.command("request", {
          session,
          metadata: openRequest(version),
        });
        assert.equal((await rpc.wait("request-started")).kind, "request-started");
        const response = rpc.wait("response");
        let resultObserved = false;
        void response.then(
          () => {
            resultObserved = true;
          },
          () => {
            resultObserved = true;
          },
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(resultObserved, false, "a stopped peer cannot acknowledge this RPC");

        // Repeated shutdown shares the original join. A local cancellation or
        // socket close is insufficient: the external fixture checks the peer's
        // original pidfd after shutdown, without trusting the controller result.
        const firstClose = endpoint.close();
        assert.equal(endpoint.close(), firstClose);
        await firstClose;
        const retired = await external.command("peer-state", { session }).wait("peer-state");
        assert.equal(retired.kind, "peer-state");
        assert.equal(retired.state, "exited");
        const failed = await response;
        assert.equal(failed.kind, "failed", "lost native response must not report success");
        assert.equal(Object.hasOwn(failed, "secret_length"), false);
        assert.equal(endpoint.close(), firstClose, "retirement is idempotent after settlement");
        await endpoint.close();
        assert.equal((await external.command("close", { session }).wait("closed")).kind, "closed");
        t.diagnostic(
          "Actual native RPC drain and retirement passed; no Work dispatch, credential mint, durable unknown, or clone/fetch was exercised.",
        );
      } finally {
        // An assertion failure must not leave this test-owned native peer stopped.
        await external.command("resume-peer", { session }).wait("peer-resumed");
        await endpoint.close();
      }
    },
  );
}
