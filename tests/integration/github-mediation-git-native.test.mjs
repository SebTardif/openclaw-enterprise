import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import {
  EMPTY_BODY_SHA256,
  githubGitReadDigest,
  githubMetadataDigest,
} from "../../packages/occ/src/github-mediation-v2/wire.ts";
import { startGitHubMediationNative } from "../../apps/controller/src/admission/github-mediation-context.ts";
import { actualAssembly } from "../fixtures/github-mediation-native.mjs";
import { signal } from "../fixtures/runtime-service-trust.mjs";

const gitBinary = process.env.OCC_GITHUB_GIT_READ_TEST_BINARY;
const metadataBinary = process.env.OCE_GITHUB_MEDIATION_TEST_BINARY;
const selected = gitBinary && process.env.OCE_GITHUB_MEDIATION_FIXTURE_BINARY;
const options = {
  timeout: 30000,
  skip: selected ? false : "Select the actual Git native binary and external Workload API fixture.",
};
function openGit() {
  return {
    version: 3,
    sequence: 1,
    request_ref: randomBytes(16).toString("hex"),
    method: "open-read",
    attachment_ref: "attachment/external-git-client-input",
    repository_owner: "openclaw",
    repository_name: "example",
    git_operation: "discovery",
    git_protocol: "version=2",
    body_bytes: 0,
    body_sha256: EMPTY_BODY_SHA256,
    request_sha256: githubGitReadDigest("openclaw", "example", "discovery", 0, EMPTY_BODY_SHA256),
  };
}
function startup(assembly, binaryPath, protocolVersion) {
  const native = assembly.external.profile;
  return {
    listenPath: native.listen_path,
    peerUid: native.peer_uid,
    trustedAncestorUids: native.trusted_ancestor_uids,
    binaryPath,
    serviceIdentityRef: assembly.serviceIdentityRef,
    installationId: assembly.f.owner.installation.id,
    recipientRef: assembly.f.source.recipientRef,
    trust: assembly.trust,
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    limits: {
      maximumSessions: 1,
      maximumCallMilliseconds: 3000,
      maximumOperationMilliseconds: 30000,
      maximumLeaseMilliseconds: 2000,
      clockAllowanceMilliseconds: 100,
    },
  };
}

test(
  "actual Git profile and native Session preserve selected original input before broker refusal",
  options,
  async (t) => {
    let inspected = 0;
    const impossible = async () => {
      throw new Error("No original Work or dispatch owner is installed.");
    };
    const assembly = await actualAssembly(
      t,
      {
        create(source) {
          return {
            async prepare(request, call) {
              // The actual native Session is inspected, then this consumer refuses.
              // No original Work, repository permission or committed release is made.
              assert.equal(request.version, 3);
              assert.equal(request.git_operation, "discovery");
              const held = await source.acquire(request, call);
              assert.ok(held);
              const observed = await source.inspect(held, call);
              assert.equal(observed.context, call.context);
              assert.equal(observed.verified.configuration.role, "repository-issuer");
              assert.equal(observed.verified.transportBinding, held.transportBinding);
              const { git_operation, git_protocol, body_bytes, body_sha256, ...metadata } = request;
              assert.equal(await source.acquire({ ...metadata, version: 2 }, call), undefined);
              assert.throws(() => source.assertCurrent({ ...held }, call));
              await source.release(held);
              inspected++;
              return { kind: "refused", code: "unavailable" };
            },
            dispatch: impossible,
            check: impossible,
            writeRelease: impossible,
            settle: impossible,
          };
        },
      },
      3,
    );
    for (const session of ["git-first", "git-second"]) {
      assert.equal(
        (await assembly.external.command("connect", { session }).wait("connected")).kind,
        "connected",
      );
      const request = openGit();
      const response = await assembly.external
        .command("request", { session, metadata: request })
        .wait("response");
      assert.equal(response.kind, "response");
      assert.equal(response.secret_length, 0);
      assert.deepEqual(response.metadata, {
        version: 3,
        sequence: 1,
        request_ref: request.request_ref,
        ok: false,
        code: "unavailable",
      });
      await assembly.external.command("close", { session }).wait("closed");
    }
    assert.equal(inspected, 2);
  },
);

test(
  "native startup cannot select Git from a metadata profile or infer Git from a current record",
  {
    ...options,
    skip:
      selected && metadataBinary ? false : "Select both original metadata and Git native binaries.",
  },
  async (t) => {
    const git = await actualAssembly(t, undefined, 3);
    // Keep the admitted registry and external source live, but free the exact
    // protected endpoint. An occupied socket must not explain this rejection.
    await git.endpoint.close();
    await assert.rejects(async () => {
      const unexpected = await startGitHubMediationNative(startup(git, gitBinary));
      await unexpected.close();
    });
    const metadata = await actualAssembly(t);
    await metadata.endpoint.close();
    await assert.rejects(async () => {
      const unexpected = await startGitHubMediationNative(startup(metadata, metadataBinary, 3));
      await unexpected.close();
    });
  },
);

test(
  "Git native transport rejects crossed wire versions and semantic digests, then observes withdrawal",
  options,
  async (t) => {
    const assembly = await actualAssembly(t, undefined, 3);
    const { external, trust, f, serviceIdentityRef } = assembly;
    const valid = openGit();
    const { git_operation, git_protocol, body_bytes, body_sha256, ...metadata } = valid;
    const bad = [
      { ...metadata, version: 2, request_sha256: githubMetadataDigest("openclaw", "example") },
      { ...valid, request_sha256: githubMetadataDigest("openclaw", "example") },
    ];
    for (const [index, request] of bad.entries()) {
      const session = `git-crossed-${index}`;
      assert.equal(
        (await external.command("connect", { session }).wait("connected")).kind,
        "connected",
      );
      assert.equal(
        (await external.command("request", { session, metadata: request }).wait("response")).kind,
        "failed",
      );
      await external.command("close", { session }).wait("closed");
    }
    const withdrawal = await trust.apply(
      {
        schemaVersion: 1,
        kind: "service-withdraw",
        serviceIdentityRef,
        expectedVersion: 1,
        operationRef: randomUUID(),
      },
      f.context,
      signal(),
    );
    assert.equal(withdrawal.result, "applied");
    assert.equal(await trust.readCurrentRecord(serviceIdentityRef, signal()), undefined);
    const session = "git-withdrawn";
    const connected = await external.command("connect", { session }).wait("connected");
    if (connected.kind === "connected") {
      assert.equal(
        (await external.command("request", { session, metadata: openGit() }).wait("response")).kind,
        "failed",
      );
      await external.command("close", { session }).wait("closed");
    } else assert.equal(connected.kind, "failed");
  },
);
