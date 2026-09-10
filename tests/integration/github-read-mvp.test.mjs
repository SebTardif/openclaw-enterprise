import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";

// This case verifies current controller/native refusal behavior. It does not
// establish repository Work, PostgreSQL persistence, minting or Git results.
const nativeSelectors = [
  "OCE_GITHUB_MEDIATION_TEST_BINARY",
  "OCC_GITHUB_GIT_READ_TEST_BINARY",
  "OCE_GITHUB_MEDIATION_FIXTURE_BINARY",
];
// Existing artifact selectors are the opt-in. A partial or empty selection is
// an attempted native run and must fail its prerequisites rather than skip.
const nativeSelected = nativeSelectors.some((name) => process.env[name] !== undefined);

async function requireNativeArtifacts() {
  const missing = nativeSelectors.filter((name) => !process.env[name]);
  assert.deepEqual(
    missing,
    [],
    `Native integration prerequisites unavailable: explicitly select ${missing.join(", ")}. ` +
      "No native admission or Git integration has run.",
  );
  for (const name of nativeSelectors) {
    const path = process.env[name];
    assert.ok(isAbsolute(path), `${name} must select an absolute prepared executable.`);
    const info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `${name} must select a regular file.`);
    await access(path, constants.R_OK | constants.X_OK);
  }
}

test(
  "READ MVP current boundary: authenticated HTTP enrollment reaches native refusal without Work",
  {
    timeout: 60000,
    skip: nativeSelected
      ? false
      : "Select the actual metadata/Git native executables and external Workload API fixture.",
  },
  async (t) => {
    // Check selection before importing application dependencies so unavailable
    // artifacts fail explicitly even in an unprepared checkout.
    await requireNativeArtifacts();
    const [controller, core, runtime, native, fixture, trustFixture, wire] = await Promise.all([
      import("../../apps/controller/src/index.ts"),
      import("../../packages/occ/src/index.ts"),
      import("../../packages/occ/src/runtime-authority/service-trust.ts"),
      import("../../apps/controller/src/admission/github-mediation-context.ts"),
      import("../fixtures/github-mediation-native.mjs"),
      import("../fixtures/runtime-service-trust.mjs"),
      import("../../packages/occ/src/github-mediation-v2/wire.ts"),
    ]);

    for (const version of [2, 3]) {
      await t.test(`HTTP enrollment and actual native protocol v${version}`, async (caseTest) => {
        // Reuse the original external Workload API/SPIFFE peer fixture. The
        // actual controller authenticates the operator and owns IAM, registry
        // writes and audit; the fixture cannot manufacture repository Work.
        const external = await fixture.externalFixture(version);
        caseTest.after(() => external.close());
        const profile = external.profile;
        const binaryPath =
          version === 2
            ? process.env.OCE_GITHUB_MEDIATION_TEST_BINARY
            : process.env.OCC_GITHUB_GIT_READ_TEST_BINARY;
        const deployment = {
          listenPath: profile.listen_path,
          peerUid: profile.peer_uid,
          trustedAncestorUids: profile.trusted_ancestor_uids,
        };
        const f = await trustFixture.createRuntimeServiceTrustFixture({
          binaryPath,
          sourceOverrides: {
            workloadApiSocketPath: profile.workload_api_socket_path,
            ownSPIFFEId: profile.own_spiffe_id,
            recipientSPIFFEId: profile.recipient_spiffe_id,
            trustDomain: new URL(profile.own_spiffe_id).hostname,
            trustBundleSha256: profile.trust_bundle_sha256,
            transportProfileRef:
              version === 2
                ? "owned-child-stdio-github-metadata-v2"
                : "owned-child-stdio-github-git-read-v3",
          },
        });
        caseTest.after(() => f.close());
        // Each actual HTTP receiver installs its own one-time human verifier.
        // Reuse the original fixture's real State/auth/IAM, but construct this
        // receiver's controller before selecting its native parser and routes.
        const acceptingController = new core.OpenClawController(f.owner.installation, {
          state: f.state,
          recordOperations: false,
        });
        for (const [kind, driver] of [
          ["iam", f.iam],
          ["configuration", f.appOptions.configurationDriver],
        ]) {
          acceptingController.registerDriver(driver);
          acceptingController.selectDriver(kind, driver.id);
        }
        const trust = new runtime.RuntimeServiceTrustService({
          ...f.options,
          iam: () => acceptingController.selectedDriver("iam"),
          validateProfile: (value, signal) =>
            native.validateNativeGitHubMediationProfile(binaryPath, value, deployment, signal),
        });
        const app = controller.createFastifyApp({
          ...f.appOptions,
          controller: acceptingController,
          runtimeServiceTrust: trust,
        });
        caseTest.after(() => app.close());
        await app.ready();
        const operationPath = "/v1/runtime-service-trust/operations";
        async function request(method, path, payload) {
          const response = await app.inject({
            method,
            url: path,
            headers: f.headers,
            ...(payload === undefined ? {} : { payload }),
          });
          assert.equal(response.statusCode, 200, response.body);
          return response.json().data;
        }
        const sourceRequest = trustFixture.sourceRequest(f.source.sourceRef);
        const sourceResult = await request("POST", operationPath, sourceRequest);
        assert.equal(sourceResult.result, "applied");
        const serviceRequest = trustFixture.serviceRequest(f, {
          operationPolicy: version === 2 ? "github-metadata-rpc-v2" : "github-git-read-rpc-v3",
          peerSPIFFEId: profile.peer_spiffe_id,
        });
        const admitted = await request("POST", operationPath, serviceRequest);
        assert.equal(admitted.result, "applied");
        assert.equal(admitted.record.configuration.role, "repository-issuer");
        assert.deepEqual(admitted.record.configuration.allowedScope, {
          kind: "agent",
          installationId: f.owner.installation.id,
          namespaceId: f.owner.namespace.id,
          agentId: f.owner.agent.id,
        });

        // HTTP recovery must observe the same real State operation and audit.
        // This is InMemoryPlatformState coverage; it does not claim durable SQL.
        const recovered = await request(
          "GET",
          `${operationPath}/${encodeURIComponent(serviceRequest.operationRef)}`,
        );
        assert.deepEqual(recovered, admitted.record);
        const stored = await f.state.read((view) =>
          view.runtimeServiceTrust.findOperation(
            f.owner.installation.id,
            serviceRequest.operationRef,
          ),
        );
        assert.deepEqual(stored, admitted.record);
        const audit = (await f.state.transact((unit) => unit.audit.list())).filter(
          (event) => event.id === admitted.record.auditId,
        );
        assert.equal(audit.length, 1);
        assert.equal(audit[0].actorId, f.seed.principal.id);
        assert.equal(audit[0].action, "openclaw.runtime-service-trust.service-admit");
        assert.equal(audit[0].outcome, "success");

        // Deliberately omit operations/operationsFactory. The actual accepting
        // service must refuse after transport authentication; service admission
        // and a repository locator alone cannot grant repository access.
        const endpoint = await native.startGitHubMediationNative({
          ...deployment,
          binaryPath,
          protocolVersion: version,
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
        });
        caseTest.after(() => endpoint.close());
        const operations = version === 2 ? [undefined] : ["discovery", "upload-pack"];
        for (const operation of operations) {
          const session = `read-mvp/${version}/${operation ?? "metadata"}`;
          assert.equal(
            (await external.command("connect", { session }).wait("connected")).kind,
            "connected",
          );
          // This is protocol refusal coverage. Even the upload-pack description
          // conveys no Git body or successful Git command through the fixture.
          const body = operation === "upload-pack" ? Buffer.from("0000") : Buffer.alloc(0);
          const bodyDigest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
          const opening = {
            version,
            sequence: 1,
            request_ref: randomBytes(16).toString("hex"),
            method: "open-read",
            attachment_ref: "attachment/unadmitted-read-mvp",
            repository_owner: "fixture",
            repository_name: "repo",
            request_sha256:
              version === 2
                ? wire.githubMetadataDigest("fixture", "repo")
                : wire.githubGitReadDigest("fixture", "repo", operation, body.length, bodyDigest),
            ...(version === 3
              ? {
                  git_operation: operation,
                  git_protocol: "version=2",
                  body_bytes: body.length,
                  body_sha256: bodyDigest,
                }
              : {}),
          };
          const response = await external
            .command("request", { session, metadata: opening })
            .wait("response");
          assert.equal(response.kind, "response");
          assert.equal(response.secret_length, 0);
          assert.deepEqual(response.metadata, {
            version,
            sequence: 1,
            request_ref: opening.request_ref,
            ok: false,
            code: "unavailable",
          });
          assert.equal(
            (await external.command("close", { session }).wait("closed")).kind,
            "closed",
          );
        }
      });
    }
  },
);
