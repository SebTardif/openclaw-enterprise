import { randomUUID } from "node:crypto";
import { workloadProfileManifestFixture } from "./workload-profile.mjs";
import { envelope } from "./runtime-resource-accounting-v1/values.mjs";
import { WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2 } from "../../packages/occ/src/workload-profiles/manifest.ts";
import { deriveWorkloadProfileManifestV2 } from "../../packages/occ/src/workload-profiles/projections.ts";
import {
  PROFILE_ALLOCATION_KINDS,
  createProfilePreparationV2,
  normalizeProfilePreparationV2,
} from "../../packages/occ/src/workload-profiles/types.ts";
import {
  createWorkloadProfileAdmittedHeadV2,
  workloadProfileAdmissionHistoryV2,
} from "../../packages/occ/src/workload-profiles/admission-record.ts";

// Data vocabulary from Runtime's original active-admission fixture (5883127a).
// The real codecs derive retained data. This fixture supplies no live producer,
// account authority, capability, image or PostgreSQL qualification.
const digest = (n) => `sha256:${n.repeat(64)}`;
const ref = (name) => ({ ref: name, version: 1, contentDigest: digest("1") });
export const profilePreparedAt = "2026-09-07T08:00:00.000Z";
export const profileAcceptedAt = "2026-09-07T08:01:00.000Z";
export function workloadProfilePairManifestFixture() {
  const accounting = envelope();
  for (const component of ["gateway", "harness"])
    accounting.observations[component] = {
      status: "unavailable",
      ownerRef: "synthetic-observer",
      reason: "producer-port-unavailable",
    };
  const image = (name) => ({
    reference: `example.invalid/${name}@${digest("2")}`,
    platformDigest: digest("2"),
    executable: { path: `/app/${name}`, contentDigest: digest("3") },
  });
  const process = (name) => ({
    argv: [
      { kind: "literal", value: `/app/${name}` },
      { kind: "binding", name: "configuration-path" },
    ],
    environmentDefinition: ref(`${name}-environment`),
    runtimeClass: "selected-runsc",
    protocolVersion: 1,
    stateSchemaVersion: 1,
    agentSchemaVersion: 1,
    mounts: [
      {
        name: `${name}-state`,
        path: `/state/${name}`,
        store: ref(`${name}-store`),
        access: "read-write",
      },
    ],
  });
  return {
    schemaVersion: 2,
    target: {
      component: "gateway-harness-pair",
      provider: "occ/kubernetes-gvisor",
      architecture: "linux/amd64",
      placement: "dedicated",
      fallback: "none",
      subject: "installation-namespace-agent",
    },
    profileRefs: workloadProfileManifestFixture().profileRefs,
    artifactSet: { gateway: image("gateway"), harness: image("harness") },
    launchConfiguration: {
      gateway: process("gateway"),
      harness: process("harness"),
      modules: ["identity", "channel", "harness", "persistence"].map((kind) => ({
        id: kind,
        kind,
        definition: ref(kind),
        artifactDigest: digest("4"),
      })),
      placement: { cluster: ref("cluster"), namespaceAllocation: ref("allocation") },
      runtime: { implementation: ref("runsc"), handler: "selected-runsc", platform: "systrap" },
      resourceEnvelope: { podAndRuntimeAccounting: { status: "selected", envelope: accounting } },
      credentials: {
        deliveryMode: "installation-channel-material-v1",
        materialSelection: ref("materials"),
        pathCustody: ref("paths"),
        harnessPlatformCredentials: "forbidden",
      },
    },
    containment: {
      definition: ref("containment"),
      kvmRequired: false,
      privileged: false,
      gatewayPrivateStateInHarness: "forbidden",
      supportedRunnableTuple: "requires-current-owner-validation",
    },
    endpoints: {
      identity: ref("identity"),
      modelMediator: ref("mediator"),
      repositoryIssuer: ref("issuer"),
      harnessTransport: ref("transport"),
    },
    evidenceRequirements: {
      bootstrap: "independent-installation-service",
      physicalCreator: "original-compute-createOriginal",
      context: "initialize-new-or-resume-retained",
      replacement: "exact-replaced-and-retained-participants",
      capabilities: WORKLOAD_PROFILE_PAIR_CAPABILITIES_V2.map((id) => ({
        id,
        implementation: ref(id),
      })),
    },
  };
}

export function workloadProfileAdmissionFixture({
  installationId = `ins_${randomUUID()}`,
  namespaceId = `ns_${randomUUID()}`,
  actor = { accountRef: "controlled/account", principalRef: "controlled/principal" },
  expected = null,
} = {}) {
  const derived = deriveWorkloadProfileManifestV2(
    new TextEncoder().encode(JSON.stringify(workloadProfilePairManifestFixture())),
  );
  const request = {
    schemaVersion: 2,
    component: "gateway-harness-pair",
    namespaceId,
    operationRef: randomUUID(),
    action: expected === null ? "admit" : "replace",
    expectedAdmission: expected,
    manifest: {
      format: "oce.workload-profile.canonical-json.v1",
      canonicalUtf8: new TextDecoder().decode(derived.canonicalBytes),
      manifestDigest: derived.digests.manifestDigest,
    },
  };
  const allocated = Object.fromEntries(PROFILE_ALLOCATION_KINDS.map((key) => [key, randomUUID()]));
  const prepared = createProfilePreparationV2(
    installationId,
    actor,
    normalizeProfilePreparationV2(request),
    allocated,
    profilePreparedAt,
  );
  const attribution = {
    actor,
    operationRef: prepared.operationRef,
    requestRef: "request/original",
    decisionRef: "decision/original",
  };
  const head = createWorkloadProfileAdmittedHeadV2(prepared, attribution, profileAcceptedAt);
  const history = workloadProfileAdmissionHistoryV2(head);
  const locator = { installationId, actor, operationRef: prepared.operationRef };
  return {
    installationId,
    namespaceId,
    actor,
    request,
    prepared,
    attribution,
    head,
    history,
    locator,
  };
}
