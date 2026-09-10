import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  canonicalRuntimeServiceTrust,
  parseRuntimeServiceTrustRecord,
  RUNTIME_SERVICE_NATIVE_LIMITS,
  runtimeServiceTrustDigest,
} from "../../../packages/occ/src/runtime-authority/service-trust-schema.ts";
import { verifyNativeExecutable } from "../../../apps/controller/src/admission/native-child-lifetime.ts";

// Documentation/test inputs, not a new product configuration or an authority
// producer. A profile's parser acceptance does not establish clone/fetch success.
export const READ_CONFIGURATION_MATRIX = Object.freeze([
  Object.freeze({
    id: "mediated-git-read-v3",
    protocolVersion: 3,
    operationPolicy: "github-git-read-rpc-v3",
    transportProfileRef: "owned-child-stdio-github-git-read-v3",
    alpn: "oce-github-git-read-v3",
    capability: "discovery and upload-pack; clone/fetch needs composed verification",
    publication: "disabled by READ scope; no publication setting exists in this profile",
    history: "ordinary fetched history remains visible",
  }),
  Object.freeze({
    id: "mediated-metadata-v2",
    protocolVersion: 2,
    operationPolicy: "github-metadata-rpc-v2",
    transportProfileRef: "owned-child-stdio-github-metadata-v2",
    alpn: "oce-github-mediation-v2",
    capability: "repository metadata only; not Git clone/fetch",
    publication: "unavailable in this profile",
    history: "no Git transfer implemented by this metadata profile",
  }),
]);

export const READ_CAPABILITY_GATES = Object.freeze([
  Object.freeze({
    id: "component-configuration",
    selector: "^READ-05 component:",
    inputs: "existing Node and matching workspace dependencies",
    evidence: "actual profile/wire parsers and negative startup guards; no child or listener",
  }),
  Object.freeze({
    id: "native-configuration",
    selector: "^READ-05 native:",
    inputs: "OCC_GITHUB_GIT_READ_TEST_BINARY: absolute protected selected executable",
    evidence: "actual native validate-profile and CLI only; no Workload API source or TLS session",
  }),
  Object.freeze({
    id: "native-identity",
    inputs: "selected mediation binary and OCE_GITHUB_MEDIATION_FIXTURE_BINARY; READ-03",
    evidence: "separately selected original Unix socket, workload identity and maintained mTLS",
  }),
  Object.freeze({
    id: "composed-clone-fetch",
    inputs: "READ-01/04 explicitly selected Git and maintained read transport artifacts",
    evidence:
      "loopback external origin/peers only; retain exact logical origin, TLS and identity checks",
  }),
  Object.freeze({
    id: "native-scoped-token",
    inputs: "separate native client and repository-authority qualification",
    evidence: "specs/20 direction; not selected by a mediated profile or a mode flag",
  }),
  Object.freeze({
    id: "history-isolated",
    inputs: "separate snapshot service, fresh runtime/workspace/session and acceptance",
    evidence: "specs/20 direction; not provided by clone/fetch or credential mediation",
  }),
  Object.freeze({
    id: "external-services",
    inputs: "explicit separate provider, PostgreSQL, cluster, model or public GitHub selection",
    evidence: "none selected by this suite; publication remains outside READ acceptance",
  }),
]);

const uuid = (last) => `00000000-0000-4000-8000-${String(last).padStart(12, "0")}`;
export const READ_SCOPE = Object.freeze({
  installationId: `ins_${uuid(1)}`,
  namespaceId: `ns_${uuid(2)}`,
  agentId: `agt_${uuid(3)}`,
});
export const READ_SERVICE = `runtime-service/${uuid(4)}`;
const digest = (digit) => `sha256:${digit.repeat(64)}`;

export function readProfile(protocolVersion = 3, sourceOverrides = {}) {
  const row = READ_CONFIGURATION_MATRIX.find((entry) => entry.protocolVersion === protocolVersion);
  assert.ok(row, "A test must choose the existing metadata or Git read profile.");
  const source = {
    schemaVersion: 1,
    sourceRef: "source/read-mvp",
    workloadApiSocketPath: "/read-mvp/workload.sock",
    ownSPIFFEId: "spiffe://read-mvp.test/controller",
    recipientRef: "recipient/read-mvp",
    recipientSPIFFEId: "spiffe://read-mvp.test/controller",
    trustDomain: "read-mvp.test",
    trustRootsRef: "roots/read-mvp",
    trustBundleSha256: digest("1"),
    verifierProfileRef: "verifier/read-mvp",
    nativeExecutableSha256: digest("2"),
    transportProfileRef: row.transportProfileRef,
    limits: { ...RUNTIME_SERVICE_NATIVE_LIMITS },
    ...sourceOverrides,
  };
  return {
    ...source,
    sourceConfigurationDigest: runtimeServiceTrustDigest(source),
    operationPolicy: row.operationPolicy,
    peerSPIFFEId: "spiffe://read-mvp.test/injector",
  };
}

export function readDeployment() {
  return {
    listenPath: "/read-mvp/listener.sock",
    peerUid: process.getuid?.() ?? 0,
    trustedAncestorUids: [...new Set([0, process.getuid?.() ?? 0])],
  };
}

// Contract-faithful registry response for startup rejection tests. Both records
// pass the actual record parser. This is no IAM admission, durable commit, live
// source or positive Work/State/custody grant; startup itself is never patched.
export function readCurrentRecord(profile = readProfile()) {
  const { operationPolicy, peerSPIFFEId, sourceConfigurationDigest, ...source } = profile;
  const common = {
    schemaVersion: 1,
    installationId: READ_SCOPE.installationId,
    recordVersion: 1,
    actorId: "actor/read-mvp",
    committedAt: "2026-09-10T00:00:00.000Z",
  };
  const sourceRequest = {
    schemaVersion: 1,
    kind: "source-admit",
    operationRef: uuid(5),
    expectedVersion: null,
    sourceRef: source.sourceRef,
  };
  const sourceAdmission = parseRuntimeServiceTrustRecord({
    ...common,
    kind: "source-admit",
    subjectKind: "source",
    subjectRef: source.sourceRef,
    operationRef: sourceRequest.operationRef,
    auditId: `aud_${uuid(6)}`,
    canonicalRequest: canonicalRuntimeServiceTrust(sourceRequest),
    requestDigest: runtimeServiceTrustDigest(sourceRequest),
    source,
    sourceConfigurationDigest,
  });
  const serviceRequest = {
    schemaVersion: 1,
    kind: "service-admit",
    operationRef: uuid(7),
    expectedVersion: null,
    serviceIdentityRef: null,
    sourceRef: source.sourceRef,
    namespaceId: READ_SCOPE.namespaceId,
    agentId: READ_SCOPE.agentId,
    peerSPIFFEId,
    operationPolicy,
  };
  const admission = parseRuntimeServiceTrustRecord({
    ...common,
    kind: "service-admit",
    subjectKind: "service",
    subjectRef: READ_SERVICE,
    operationRef: serviceRequest.operationRef,
    auditId: `aud_${uuid(8)}`,
    canonicalRequest: canonicalRuntimeServiceTrust(serviceRequest),
    requestDigest: runtimeServiceTrustDigest(serviceRequest),
    sourceOperationRef: sourceAdmission.operationRef,
    sourceRecordVersion: sourceAdmission.recordVersion,
    profile,
    configuration: {
      schemaVersion: 1,
      installationId: READ_SCOPE.installationId,
      configurationVersion: 1,
      serviceIdentityRef: READ_SERVICE,
      serviceTrustProfileRef: `runtime-service-profile/${uuid(9)}`,
      serviceTrustProfileDigest: runtimeServiceTrustDigest(profile),
      trustRootsRef: profile.trustRootsRef,
      verifierProfileRef: profile.verifierProfileRef,
      permittedRecipientRef: profile.recipientRef,
      role: "repository-issuer",
      allowedScope: { kind: "agent", ...READ_SCOPE },
    },
  });
  return Object.freeze({ admission, sourceAdmission });
}

export function readStartupOptions(trust, protocolVersion = 3) {
  return {
    ...readDeployment(),
    // Deliberately missing: reaching the real executable validator instead of
    // the tested guard causes TypeError. No executable can be started.
    binaryPath: undefined,
    serviceIdentityRef: READ_SERVICE,
    installationId: READ_SCOPE.installationId,
    recipientRef: "recipient/read-mvp",
    trust,
    protocolVersion,
    limits: {
      maximumSessions: 1,
      maximumCallMilliseconds: 3000,
      maximumOperationMilliseconds: 30000,
      maximumLeaseMilliseconds: 2000,
      clockAllowanceMilliseconds: 100,
    },
  };
}

export function nativeProfile(protocolVersion = 3) {
  return {
    version: 1,
    ...(protocolVersion === 3 ? { protocol_version: 3 } : {}),
    workload_api_socket_path: "/read-mvp/workload.sock",
    own_spiffe_id: "spiffe://read-mvp.test/controller",
    peer_spiffe_id: "spiffe://read-mvp.test/injector",
    recipient_spiffe_id: "spiffe://read-mvp.test/controller",
    trust_bundle_sha256: digest("1"),
    listen_path: "/read-mvp/listener.sock",
    peer_uid: 0,
    trusted_ancestor_uids: [0],
    handshake_timeout_ms: 3000,
    recheck_interval_ms: 1000,
    max_connection_age_ms: 30000,
    request_timeout_ms: 3000,
  };
}

export async function selectedNativeBinary() {
  const path = process.env.OCC_GITHUB_GIT_READ_TEST_BINARY;
  assert.ok(typeof path === "string" && isAbsolute(path), "Select an absolute native binary.");
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 268_435_456);
  const sha256 = `sha256:${createHash("sha256")
    .update(await readFile(path))
    .digest("hex")}`;
  // Same executable validation as production, followed by actual native parser
  // invocation. The caller selects provenance; hashing alone does not establish it.
  await verifyNativeExecutable(path, sha256, AbortSignal.timeout(3000));
  return { path, sha256 };
}

export function nativeConfigurationCommand(path, args, profile) {
  const bytes = profile === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(profile));
  assert.ok(bytes.length <= 16_384);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(bytes.length);
  return new Promise((resolve, reject) => {
    const child = execFile(
      path,
      args,
      { env: {}, timeout: 4000, killSignal: "SIGKILL", maxBuffer: 1024, encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error && (error.killed || typeof error.code !== "number")) {
          reject(error);
          return;
        }
        resolve({ code: error?.code ?? 0, stdout, stderr });
      },
    );
    // Rejected command lines can close their input before the write settles.
    // Exit status and the bounded original output remain the observed result.
    child.stdin.on("error", () => {});
    child.stdin.end(profile === undefined ? undefined : Buffer.concat([header, bytes]));
  });
}

export function nativeConfigurationReply(result) {
  assert.equal(result.stderr.length, 0);
  assert.ok(result.stdout.length >= 8);
  assert.equal(result.stdout.readUInt32BE(4), 0);
  assert.equal(result.stdout.readUInt32BE(0), result.stdout.length - 8);
  return JSON.parse(result.stdout.subarray(8).toString("utf8"));
}
