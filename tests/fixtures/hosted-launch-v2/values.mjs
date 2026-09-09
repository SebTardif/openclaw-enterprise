import { binding as originalV1Binding } from "../gateway-startup-v1/values.mjs";
import { canonicalGatewayStartupValueV1 } from "../../../packages/occ/src/gateway-startup-v1/owner.ts";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ref = (recordRef) => ({ recordRef, recordVersion: 1 });
/** Controlled valid V2 construction operands only, not installed native material,
 * original-account enrollment, process authority or an executable descriptor. */
export function hostedLaunchV2(target, ownership = {}) {
  const subject = {
    kind: "agent-gateway",
    installationId: `ins_${uuid(3)}`,
    namespaceRef: ownership.namespaceId ?? `ns_${uuid(4)}`,
    agentRef: ownership.agentId ?? `agt_${uuid(5)}`,
  };
  const startup = {
    schemaVersion: 2,
    subject,
    processRef: "process-fixture",
    processGeneration: 7,
    operationRef: "startup-fixture",
    operationDigest: "a".repeat(64),
  };
  const binding = {
    ...originalV1Binding(),
    schemaVersion: 2,
    startup,
    namespaceRef: subject.namespaceRef,
    agentRef: subject.agentRef,
    admittedRevisionRef: ownership.revisionId ?? "revision-fixture",
    selection: {
      manifestRef: uuid(1),
      manifestDigest: `sha256:${"1".repeat(64)}`,
      admissionRef: uuid(2),
      admissionVersion: 1,
    },
    profileRefs: Object.fromEntries(
      ["provider", "runtime", "identity", "containment", "storage"].map((key, i) => [
        key,
        { ref: uuid(i + 20), version: 1, contentDigest: `sha256:${"2".repeat(64)}` },
      ]),
    ),
    admittedConfigurationDigest: `sha256:${"3".repeat(64)}`,
  };
  const original = {
    binding,
    target: structuredClone(target),
    launchPlan: ref("launch-allocation"),
  };
  const value = {
    schemaVersion: 2,
    address: "127.0.0.1:43123",
    configurationVersion: 1,
    profile: { sourceRef: "controlled-native-source" },
    association: { startup },
    harness: null,
    binding,
    consumeCommand: {
      schemaVersion: 2,
      subject,
      kind: "consume-startup",
      operationRef: "consume-fixture",
      startup,
      expectedHead: { version: 2, recordVersion: 2, startup },
      recipient: {
        recipient: ref("recipient"),
        process: ref("process"),
        incarnationRef: "incarnation",
        observation: ref("observation"),
      },
    },
  };
  return { original, value, document: canonicalGatewayStartupValueV1(value) };
}
