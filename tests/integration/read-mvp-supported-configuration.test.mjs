import assert from "node:assert/strict";
import test from "node:test";
import { parseRuntimeServiceNativeProfile } from "../../packages/occ/src/runtime-authority/service-trust-schema.ts";
import {
  decodeGitHubMediationRequest,
  EMPTY_BODY_SHA256,
  GITHUB_GIT_READ_ALPN,
  GITHUB_MEDIATION_ALPN,
  githubGitReadDigest,
} from "../../packages/occ/src/github-mediation-v2/wire.ts";
import {
  startGitHubMediationNative,
  validateNativeGitHubMediationProfile,
} from "../../apps/controller/src/admission/github-mediation-context.ts";
import { validateNativeRuntimeServiceProfile } from "../../apps/controller/src/admission/runtime-authority-profile.ts";
import {
  READ_CONFIGURATION_MATRIX,
  READ_SCOPE,
  READ_SERVICE,
  nativeConfigurationCommand,
  nativeConfigurationReply,
  nativeProfile,
  readCurrentRecord,
  readDeployment,
  readProfile,
  readStartupOptions,
  selectedNativeBinary,
} from "../fixtures/read-mvp/configuration.mjs";

// Component cases invoke existing application functions. Native cases invoke
// only the selected executable's pure parser/CLI, with no external provider,
// database, cluster, model, listener or Workload API fixture. They cannot prove
// installed service identity or successful Git clone/fetch.
const nativeOptions = {
  timeout: 30_000,
  skip:
    process.env.OCC_GITHUB_GIT_READ_TEST_BINARY === undefined
      ? "Select OCC_GITHUB_GIT_READ_TEST_BINARY for actual native parser/CLI checks."
      : false,
};
const unavailable = { message: "Native runtime readback unavailable." };
const signal = () => new AbortController().signal;

test("READ-05 component: metadata V2 and explicit Git V3 are exact separate profiles", () => {
  for (const row of READ_CONFIGURATION_MATRIX) {
    const parsed = parseRuntimeServiceNativeProfile(readProfile(row.protocolVersion));
    assert.equal(parsed.operationPolicy, row.operationPolicy);
    assert.equal(parsed.transportProfileRef, row.transportProfileRef);
    assert.equal(
      row.alpn,
      row.protocolVersion === 3 ? GITHUB_GIT_READ_ALPN : GITHUB_MEDIATION_ALPN,
    );
  }
  // Recompute the source digest so a crossed policy/transport fails the closed
  // pair contract, rather than merely failing stale digest validation.
  for (const [version, other] of [
    [2, 3],
    [3, 2],
  ]) {
    const candidate = readProfile(version, {
      transportProfileRef: readProfile(other).transportProfileRef,
    });
    assert.throws(() => parseRuntimeServiceNativeProfile(candidate));
  }
});

test("READ-05 component: unsupported modes publication and fallback flags cannot extend the profile", () => {
  const profile = readProfile();
  for (const change of [
    { repositoryAccessMode: "native" },
    { repositoryAccessMode: "mediated" },
    { repositoryAccessMode: "history-isolated" },
    { publication: false },
    { publication: true },
    { allowPush: true },
    { fallback: "native" },
    { alpn: GITHUB_GIT_READ_ALPN },
    { protocolVersion: 3 },
    { operationPolicy: "github-git-write-rpc-v3" },
  ]) {
    // Even publication:false is unknown here: publication disabled describes
    // this READ wave, not a newly implemented product configuration switch.
    assert.throws(() => parseRuntimeServiceNativeProfile({ ...profile, ...change }));
  }
});

test("READ-05 component: selected executable trust and workload identity remain source bound", () => {
  const profile = readProfile();
  for (const change of [
    { nativeExecutableSha256: `sha256:${"3".repeat(64)}` },
    { trustBundleSha256: `sha256:${"4".repeat(64)}` },
    { workloadApiSocketPath: "/read-mvp/replaced.sock" },
    { ownSPIFFEId: "spiffe://read-mvp.test/replaced" },
  ])
    assert.throws(() => parseRuntimeServiceNativeProfile({ ...profile, ...change }));

  for (const sourceChange of [
    { recipientSPIFFEId: "spiffe://read-mvp.test/another-recipient" },
    {
      ownSPIFFEId: "spiffe://other.test/controller",
      recipientSPIFFEId: "spiffe://other.test/controller",
    },
    { workloadApiSocketPath: "/read-mvp/../workload.sock" },
    { workloadApiSocketPath: "tcp://127.0.0.1:8443" },
    { trustBundleSha256: "unselected" },
    { nativeExecutableSha256: "unselected" },
    { limits: { ...profile.limits, maxConnections: 2 } },
  ])
    assert.throws(() => parseRuntimeServiceNativeProfile(readProfile(3, sourceChange)));

  assert.throws(() =>
    parseRuntimeServiceNativeProfile({
      ...profile,
      peerSPIFFEId: "spiffe://other.test/injector",
    }),
  );
  for (const key of [
    "nativeExecutableSha256",
    "trustBundleSha256",
    "workloadApiSocketPath",
    "ownSPIFFEId",
    "peerSPIFFEId",
    "recipientSPIFFEId",
    "sourceConfigurationDigest",
  ]) {
    const missing = { ...profile };
    delete missing[key];
    assert.throws(() => parseRuntimeServiceNativeProfile(missing), key);
  }
});

test("READ-05 component: startup cannot infer Git V3 or cross admitted profile selection", async () => {
  for (const [admittedVersion, selectedVersion] of [
    [3, undefined],
    [3, 2],
    [2, 3],
  ]) {
    const record = readCurrentRecord(readProfile(admittedVersion));
    let reads = 0;
    const trust = {
      async readCurrentRecord(serviceIdentityRef, requestSignal) {
        assert.equal(serviceIdentityRef, READ_SERVICE);
        assert.equal(requestSignal.aborted, false);
        reads++;
        return record;
      },
    };
    const options = readStartupOptions(trust);
    if (selectedVersion === undefined) delete options.protocolVersion;
    else options.protocolVersion = selectedVersion;
    // If the profile guard were bypassed, this missing binary input would cause
    // a TypeError in the actual executable validator, not the expected refusal.
    options.binaryPath = undefined;
    await assert.rejects(startGitHubMediationNative(options), unavailable);
    assert.equal(reads, 1);
  }
  // Control: a matching current profile reaches that real executable validator.
  // No child can start; this is not a positive startup assertion.
  const options = readStartupOptions({
    async readCurrentRecord() {
      return readCurrentRecord();
    },
  });
  options.binaryPath = undefined;
  await assert.rejects(startGitHubMediationNative(options), TypeError);
});

test("READ-05 component: missing registry and invalid protocol selection fail without fallback", async () => {
  for (const protocolVersion of [0, 1, 4, "3", "native", "history-isolated"]) {
    let read = false;
    const trust = {
      async readCurrentRecord() {
        read = true;
        return readCurrentRecord();
      },
    };
    await assert.rejects(
      startGitHubMediationNative(readStartupOptions(trust, protocolVersion)),
      unavailable,
    );
    assert.equal(read, false);
  }
  let reads = 0;
  const trust = {
    async readCurrentRecord() {
      reads++;
      return undefined;
    },
  };
  const missing = readStartupOptions(trust);
  missing.binaryPath = undefined;
  await assert.rejects(startGitHubMediationNative(missing), unavailable);
  assert.equal(reads, 1);
});

test("READ-05 component: startup binds exact Installation service and recipient inputs", async () => {
  const record = readCurrentRecord();
  for (const change of [
    { installationId: READ_SCOPE.installationId.replace(/1$/, "9") },
    { serviceIdentityRef: READ_SERVICE.replace(/4$/, "9") },
    { recipientRef: "recipient/different" },
  ]) {
    const options = {
      ...readStartupOptions({
        async readCurrentRecord() {
          return record;
        },
      }),
      ...change,
      binaryPath: undefined,
    };
    await assert.rejects(startGitHubMediationNative(options), unavailable);
  }
});

test("READ-05 component: absent Git validator cannot fall back to the runtime validator", async () => {
  for (const version of [2, 3]) {
    // A missing legacy binary would cause a TypeError if reached. The actual
    // admission entrypoint refuses the missing dedicated Git validation input.
    await assert.rejects(
      validateNativeRuntimeServiceProfile(undefined, readProfile(version), signal()),
      unavailable,
    );
  }
});

test("READ-05 component: Git read request selection does not admit publication or implicit upgrade", () => {
  const request = {
    version: 3,
    sequence: 1,
    request_ref: "1".repeat(32),
    method: "open-read",
    attachment_ref: "attachment/read-mvp",
    repository_owner: "fixture",
    repository_name: "read-mvp",
    git_operation: "discovery",
    git_protocol: "version=2",
    body_bytes: 0,
    body_sha256: EMPTY_BODY_SHA256,
    request_sha256: githubGitReadDigest("fixture", "read-mvp", "discovery", 0, EMPTY_BODY_SHA256),
  };
  const bytes = (value) => Buffer.from(JSON.stringify(value));
  assert.equal(decodeGitHubMediationRequest(bytes(request), 3)?.git_operation, "discovery");
  assert.equal(decodeGitHubMediationRequest(bytes(request)), undefined);
  assert.equal(decodeGitHubMediationRequest(bytes(request), 2), undefined);
  for (const change of [
    { git_operation: "receive-pack" },
    { git_operation: "push" },
    { method: "publish" },
    { method: "graphql" },
    { git_protocol: "version=1" },
    { publication: false },
    { publication: true },
  ])
    assert.equal(decodeGitHubMediationRequest(bytes({ ...request, ...change }), 3), undefined);
});

test(
  "READ-05 native: selected executable validates both projections and rejects digest substitution",
  nativeOptions,
  async () => {
    const binary = await selectedNativeBinary();
    for (const version of [2, 3]) {
      const profile = readProfile(version, { nativeExecutableSha256: binary.sha256 });
      await validateNativeGitHubMediationProfile(binary.path, profile, readDeployment(), signal());
      // A good source digest for the substituted executable digest reaches the
      // actual file-identity check, rather than failing source canonicalization.
      const otherDigest = `sha256:${(binary.sha256[7] === "0" ? "1" : "0").repeat(64)}`;
      await assert.rejects(
        validateNativeGitHubMediationProfile(
          binary.path,
          readProfile(version, { nativeExecutableSha256: otherDigest }),
          readDeployment(),
          signal(),
        ),
        unavailable,
      );
    }
  },
);

test(
  "READ-05 native: literal V3 and omitted V2 are the only native profile selectors",
  nativeOptions,
  async () => {
    const { path } = await selectedNativeBinary();
    for (const version of [2, 3]) {
      const result = await nativeConfigurationCommand(
        path,
        ["validate-profile"],
        nativeProfile(version),
      );
      assert.equal(result.code, 0);
      assert.deepEqual(nativeConfigurationReply(result), { version: 1, result: "valid" });
    }
    const profile = nativeProfile();
    for (const change of [
      { protocol_version: 2 },
      { protocol_version: 0 },
      { protocol_version: null },
      { protocol_version: "3" },
      { protocol_version: 4 },
      { protocolVersion: 3 },
      { alpn: GITHUB_GIT_READ_ALPN },
      { publication: false },
      { publication: true },
      { fallback: "metadata" },
      { peer_spiffe_id: "spiffe://other.test/injector" },
      { recipient_spiffe_id: "spiffe://read-mvp.test/other" },
      { workload_api_socket_path: "tcp://127.0.0.1:8443" },
      { listen_path: "/read-mvp/workload.sock" },
      { trust_bundle_sha256: "unselected" },
      { trusted_ancestor_uids: [] },
      { trusted_ancestor_uids: [0, 0] },
    ]) {
      const result = await nativeConfigurationCommand(path, ["validate-profile"], {
        ...profile,
        ...change,
      });
      assert.equal(result.code, 1, JSON.stringify(change));
      assert.deepEqual(nativeConfigurationReply(result), { version: 1, result: "invalid" });
    }
  },
);

test(
  "READ-05 native: unknown commands and flags cannot activate another execution mode",
  nativeOptions,
  async () => {
    const { path } = await selectedNativeBinary();
    for (const args of [
      [],
      ["clone"],
      ["publish"],
      ["native"],
      ["history-isolated"],
      ["validate-profile", "--protocol-version=3"],
      ["validate-profile", "--allow-publication"],
      ["serve", "--fallback=metadata"],
    ]) {
      const result = await nativeConfigurationCommand(path, args);
      assert.equal(result.code, 2, JSON.stringify(args));
      assert.equal(result.stdout.length, 0);
      assert.equal(result.stderr.length, 0);
    }
  },
);
