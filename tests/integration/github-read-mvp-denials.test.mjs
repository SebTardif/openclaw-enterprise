import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startGitHubMediationNative } from "../../apps/controller/src/admission/github-mediation-context.ts";
import { runtimeServiceTrustOperations } from "../../apps/controller/src/admission/runtime-service-trust.ts";
import {
  decodeGitHubMediationRequest,
  EMPTY_BODY_SHA256,
  githubGitReadDigest,
  githubMetadataDigest,
} from "../../packages/occ/src/github-mediation-v2/wire.ts";
import { actualAssembly } from "../fixtures/github-mediation-native.mjs";
import {
  createRuntimeServiceTrustFixture,
  serviceRequest,
  signal,
  sourceRequest,
} from "../fixtures/runtime-service-trust.mjs";
import { signInToControllerApp } from "../helpers/auth-session.mjs";

// These are real management HTTP and native transport boundary tests. The
// existing assembly has no original Work/repository/custody operation owner;
// its valid reads return unavailable. It cannot prove repository-use permission,
// Work expiry, clone/fetch success or release-wide publication disablement.
const mutation = runtimeServiceTrustOperations.find(
  (operation) => operation.operationId === "mutateRuntimeServiceTrust",
);
const recovery = runtimeServiceTrustOperations.find(
  (operation) => operation.operationId === "recoverRuntimeServiceTrust",
);
assert.ok(mutation);
assert.ok(recovery);
const recoveryPath = (operationRef) => recovery.path.replace(":operationRef", operationRef);
const profiles = [
  {
    version: 2,
    operationPolicy: "github-metadata-rpc-v2",
    transportProfileRef: "owned-child-stdio-github-metadata-v2",
    binary: process.env.OCE_GITHUB_MEDIATION_TEST_BINARY,
  },
  {
    version: 3,
    operationPolicy: "github-git-read-rpc-v3",
    transportProfileRef: "owned-child-stdio-github-git-read-v3",
    binary: process.env.OCC_GITHUB_GIT_READ_TEST_BINARY,
  },
];

function readRequest(version) {
  const owner = "openclaw";
  const name = "example";
  return {
    version,
    sequence: 1,
    request_ref: randomBytes(16).toString("hex"),
    method: "open-read",
    attachment_ref: "attachment/external-read-mvp-denial",
    repository_owner: owner,
    repository_name: name,
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
        ? githubGitReadDigest(owner, name, "discovery", 0, EMPTY_BODY_SHA256)
        : githubMetadataDigest(owner, name),
  };
}

async function absentOperation(f, operationRef) {
  assert.equal(
    await f.state.read((view) =>
      view.runtimeServiceTrust.findOperation(f.owner.installation.id, operationRef),
    ),
    undefined,
  );
}

async function requestNative(external, session, metadata) {
  assert.equal(
    (await external.command("connect", { session }).wait("connected")).kind,
    "connected",
  );
  try {
    return await external.command("request", { session, metadata }).wait("response");
  } finally {
    await external.command("close", { session }).wait("closed");
  }
}

async function healthyRefusal(external, session, version) {
  const metadata = readRequest(version);
  const response = await requestNative(external, session, metadata);
  assert.equal(response.kind, "response");
  assert.equal(response.secret_length, 0);
  assert.deepEqual(response.metadata, {
    version,
    sequence: 1,
    request_ref: metadata.request_ref,
    ok: false,
    code: "unavailable",
  });
}

for (const profile of profiles) {
  test(`v${profile.version} GitHub service management requires a current authorized human`, async (t) => {
    const f = await createRuntimeServiceTrustFixture({
      sourceOverrides: { transportProfileRef: profile.transportProfileRef },
    });
    t.after(() => f.close());
    // The actual HTTP owner admits a protected source, proving the route and
    // current administrator work before varying caller identity and permission.
    const original = sourceRequest(f.source.sourceRef);
    const admitted = await f.request(mutation.method, mutation.path, original);
    assert.equal(admitted.status, 200, JSON.stringify(admitted));
    assert.equal(admitted.data.result, "applied");
    assert.equal(
      (await f.request(recovery.method, recoveryPath(original.operationRef))).status,
      200,
    );

    const request = () => serviceRequest(f, { operationPolicy: profile.operationPolicy });
    const missingSession = request();
    assert.equal(
      (
        await f.request(mutation.method, mutation.path, missingSession, {
          host: "127.0.0.1",
          origin: "http://127.0.0.1",
        })
      ).status,
      401,
    );
    await absentOperation(f, missingSession.operationRef);

    // A real signed-in human is explicitly enrolled as an identity, with no
    // administrator binding. This exercises NativeIAMDriver, not an allow hook.
    const credentials = {
      email: `read-mvp-unprivileged-${randomUUID()}@example.invalid`,
      password: `Test-password-${randomUUID()}`,
    };
    const account = await f.auth.createAccount(credentials);
    f.policy.identities.push(f.auth.principalSeed(account).principal);
    const unprivileged = await signInToControllerApp(f.app, credentials);
    const denied = request();
    assert.equal(
      (
        await f.request(mutation.method, mutation.path, denied, {
          ...f.headers,
          cookie: unprivileged.cookie,
        })
      ).status,
      403,
    );
    await absentOperation(f, denied.operationRef);

    const foreignAgent = serviceRequest(f, {
      operationPolicy: profile.operationPolicy,
      agentId: `agt_${randomUUID()}`,
    });
    assert.equal((await f.request(mutation.method, mutation.path, foreignAgent)).status, 404);
    await absentOperation(f, foreignAgent.operationRef);

    // Removing the original store's administrator binding must also deny exact
    // replay and readback of an earlier successful operation.
    const bindings = f.policy.bindings.splice(0);
    try {
      assert.equal((await f.request(mutation.method, mutation.path, original)).status, 403);
      assert.equal(
        (await f.request(recovery.method, recoveryPath(original.operationRef))).status,
        403,
      );
    } finally {
      f.policy.bindings.push(...bindings);
    }
    const audits = await f.state.transact((unit) => unit.audit.list());
    assert.ok(audits.some((entry) => entry.kind === "authorization_denial"));
    assert.equal(audits.filter((entry) => entry.id === admitted.data.record.auditId).length, 1);
  });

  test(`v${profile.version} actual management API refuses publication authority fields and policies`, async (t) => {
    const f = await createRuntimeServiceTrustFixture({
      sourceOverrides: { transportProfileRef: profile.transportProfileRef },
    });
    t.after(() => f.close());
    assert.equal(
      (await f.request(mutation.method, mutation.path, sourceRequest(f.source.sourceRef))).status,
      200,
    );
    // Only the maintained service-admit route is exercised. None of these
    // adversarial additions can become repository or publication authority.
    for (const change of [
      { permissions: { contents: "write" } },
      { permissions: { pull_requests: "write" } },
      { role: "repository-issuer" },
      { operationPolicy: "github-git-write-rpc-v3" },
      { operationPolicy: "github-publication-rpc-v3" },
    ]) {
      const body = {
        ...serviceRequest(f, { operationPolicy: profile.operationPolicy }),
        ...change,
      };
      const response = await f.request(mutation.method, mutation.path, body);
      assert.equal(response.status, 400, JSON.stringify(response));
      await absentOperation(f, body.operationRef);
      assert.equal((await f.request(recovery.method, recoveryPath(body.operationRef))).status, 404);
    }
  });

  const native = {
    timeout: 45000,
    skip:
      profile.binary && process.env.OCE_GITHUB_MEDIATION_FIXTURE_BINARY
        ? false
        : "Select the actual native binary and external Workload API fixture; no native proof ran.",
  };

  test(
    `v${profile.version} actual native protocol closes publication requests before an operation is opened`,
    native,
    async (t) => {
      const { external } = await actualAssembly(t, undefined, profile.version);
      await healthyRefusal(external, "before-publication", profile.version);
      const base = readRequest(profile.version);
      const changes = [
        { method: "open-publish" },
        { method: "dispatch-publish" },
        { http_method: "POST", http_path: "/repos/openclaw/example/pulls" },
        { http_method: "PATCH", http_path: "/repos/openclaw/example/pulls/1" },
        { permissions: "contents:write" },
        ...(profile.version === 3
          ? [{ git_operation: "receive-pack" }, { git_operation: "git-receive-pack" }]
          : [{ git_operation: "receive-pack" }]),
      ];
      for (const [index, change] of changes.entries()) {
        const metadata = {
          ...base,
          ...change,
          request_ref: randomBytes(16).toString("hex"),
        };
        assert.equal(
          decodeGitHubMediationRequest(Buffer.from(JSON.stringify(metadata)), profile.version),
          undefined,
        );
        // A parser refusal closes the actual mTLS connection. It is different
        // from the broker's well-formed unavailable reply for a valid read.
        const response = await requestNative(external, `publication-${index}`, metadata);
        assert.equal(response.kind, "failed", JSON.stringify(response));
        assert.equal(response.failure_stage, "read", JSON.stringify(response));
        assert.equal(response.timed_out, false, JSON.stringify(response));
        assert.ok(
          ["peer-eof", "peer-reset"].includes(response.error_code),
          JSON.stringify(response),
        );
      }
      await healthyRefusal(external, "after-publication", profile.version);
    },
  );

  test(
    `v${profile.version} original service withdrawal closes the already authenticated native entry`,
    native,
    async (t) => {
      const { external, trust, f, serviceIdentityRef } = await actualAssembly(
        t,
        undefined,
        profile.version,
      );
      await healthyRefusal(external, "before-withdrawal", profile.version);
      const session = "withdrawal-held";
      assert.equal(
        (await external.command("connect", { session }).wait("connected")).kind,
        "connected",
      );
      const withdrawn = await trust.apply(
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
      assert.equal(withdrawn.result, "applied");
      assert.equal(await trust.readCurrentRecord(serviceIdentityRef, signal()), undefined);
      const response = await external
        .command("request", { session, metadata: readRequest(profile.version) })
        .wait("response");
      assert.equal(response.kind, "failed", JSON.stringify(response));
      await external.command("close", { session }).wait("closed");
    },
  );

  test(
    `v${profile.version} actual native peer identity must match the newly admitted service`,
    native,
    async (t) => {
      const assembly = await actualAssembly(t, undefined, profile.version);
      const { external, trust, f, serviceIdentityRef } = assembly;
      await healthyRefusal(external, "before-peer-change", profile.version);
      await assembly.endpoint.close();
      // Keep the real external client's certificate unchanged, and admit a
      // different exact peer through the original registry and native validator.
      const replacement = await trust.apply(
        serviceRequest(f, {
          operationPolicy: profile.operationPolicy,
          serviceIdentityRef,
          expectedVersion: 1,
          peerSPIFFEId: `spiffe://${f.source.trustDomain}/other-github-service`,
        }),
        f.context,
        signal(),
      );
      assert.equal(replacement.result, "applied");
      const endpoint = await startGitHubMediationNative({
        listenPath: external.profile.listen_path,
        peerUid: external.profile.peer_uid,
        trustedAncestorUids: external.profile.trusted_ancestor_uids,
        binaryPath: profile.binary,
        ...(profile.version === 3 ? { protocolVersion: 3 } : {}),
        serviceIdentityRef,
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
      });
      t.after(() => endpoint.close());
      const session = "wrong-peer";
      const connection = await external.command("connect", { session }).wait("connected");
      if (connection.kind === "connected") {
        const response = await external
          .command("request", {
            session,
            metadata: readRequest(profile.version),
          })
          .wait("response");
        assert.equal(response.kind, "failed", JSON.stringify(response));
        await external.command("close", { session }).wait("closed");
      } else assert.equal(connection.kind, "failed");
    },
  );

  test(
    `v${profile.version} native server closes an idle connection before the external client's expiry`,
    native,
    async (t) => {
      const { external, f } = await actualAssembly(t, undefined, profile.version, "server-expiry");
      const serverAge = f.source.limits.maxConnectionAgeMs;
      assert.equal(serverAge, 30000);
      assert.equal(external.clientMaximumConnectionAgeMilliseconds, 60000);
      await healthyRefusal(external, "before-age-expiry", profile.version);
      const session = "age-expired";
      assert.equal(
        (await external.command("connect", { session }).wait("connected")).kind,
        "connected",
      );
      // The unavailable response is terminal, so the successful control above
      // uses a separate connection. This held connection sends no request and
      // has no application I/O deadline that could manufacture a close.
      await delay(serverAge - 2000);
      const before = await external.command("client-state", { session }).wait("client-state");
      assert.equal(before.kind, "client-state", JSON.stringify(before));
      assert.equal(before.client_authority_current, true);
      assert.equal(before.requests_started, 0);
      assert.equal(before.peer_write_closed, false);
      assert.ok(before.connected_age_ms >= serverAge - 2500);
      assert.ok(before.connected_age_ms < serverAge);
      assert.ok(before.client_remaining_ms > 25000);

      // POLLRDHUP observes closure by the actual remote server before any
      // read/request is attempted. Inspect still recognizes the client's own
      // live authority, whose independent expiry is another ~29 seconds away.
      await delay(serverAge + 1000 - before.connected_age_ms);
      const after = await external.command("client-state", { session }).wait("client-state");
      assert.equal(after.kind, "client-state", JSON.stringify(after));
      assert.equal(after.client_authority_current, true);
      assert.equal(after.requests_started, 0);
      assert.equal(after.peer_write_closed, true);
      assert.ok(after.connected_age_ms >= serverAge);
      assert.ok(after.connected_age_ms < serverAge + 5000);
      assert.ok(after.client_remaining_ms > 20000);

      // This is actual server transport expiry, with no original Work horizon
      // claim. The closed entry also refuses the subsequent application read.
      const response = await external
        .command("request", { session, metadata: readRequest(profile.version) })
        .wait("response");
      assert.equal(response.kind, "failed", JSON.stringify(response));
      await external.command("close", { session }).wait("closed");
      await healthyRefusal(external, "fresh-after-age-expiry", profile.version);
    },
  );
}
