import { setHeaderOptions, type AppsV1Api, type V1Deployment } from "@kubernetes/client-node";
import { ObjectSerializer } from "@kubernetes/client-node/dist/gen/models/ObjectSerializer.js";
import {
  parseRuntimeEffectsV1,
  type RuntimePreparedChildV1,
} from "@openclaw-enterprise/contracts/runtime-effects-v1";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const PREPARED_DEPLOYMENT_ANNOTATIONS = Object.freeze({
  assignment: "openclaw.dev/runtime-assignment-ref",
  create: "openclaw.dev/runtime-create-effect-ref",
  fence: "openclaw.dev/runtime-fence-epoch",
});

export interface KubernetesPreparedDeploymentResponse {
  readonly namespace: string;
  readonly name: string;
  readonly uid: string;
  readonly resourceVersion: string;
  readonly receivedAt: string;
}

const refuse = (): never => {
  throw new Error("The retained conditional Deployment request is invalid.");
};
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return refuse();
  return value as Record<string, unknown>;
}
function reference(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\0")
  )
    return refuse();
  return value;
}
const pointer = (name: string) =>
  `/metadata/annotations/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`;

/** Only a wire codec and selected SDK boundary. The original accepting owner
 * must retain/authorize the exact child and keep late response responsibility.
 * No method here authenticates an admission, renderer or copied source record. */
export function prepareKubernetesDeploymentRequest(
  input: RuntimePreparedChildV1,
  providerWireUtf8: string,
  namespace: string,
) {
  const child = parseRuntimeEffectsV1("preparedChild", input);
  reference(namespace);
  if (
    child.request.kind !== "create" ||
    child.providerTarget.apiKind !== "Deployment" ||
    child.effect.target.component !== "harness" ||
    typeof providerWireUtf8 !== "string" ||
    Buffer.byteLength(providerWireUtf8, "utf8") !== child.providerWire.byteLength ||
    `sha256:${createHash("sha256").update(providerWireUtf8, "utf8").digest("hex")}` !==
      child.providerWire.bytesDigest
  )
    return refuse();
  const body: unknown = JSON.parse(providerWireUtf8);
  // The selected SDK JSON serializer must emit precisely the retained bytes.
  if (JSON.stringify(body) !== providerWireUtf8) return refuse();
  const target = child.providerTarget;
  const action = child.request.action;
  if (
    action === "reserve-inert" &&
    JSON.stringify(ObjectSerializer.serialize(body, "V1Deployment", "")) !== providerWireUtf8
  )
    return refuse();
  const identity = {
    [PREPARED_DEPLOYMENT_ANNOTATIONS.assignment]: target.ownerAssignmentRef.id,
    [PREPARED_DEPLOYMENT_ANNOTATIONS.create]: target.ownerCreateEffectRef,
    [PREPARED_DEPLOYMENT_ANNOTATIONS.fence]: String(child.guard.requestedFenceEpoch),
  };
  if (action === "reserve-inert") {
    const deployment = record(body),
      metadata = record(deployment.metadata),
      spec = record(deployment.spec);
    const annotations = record(metadata.annotations);
    if (
      child.predicate.kind !== "expected-absent" ||
      deployment.apiVersion !== "apps/v1" ||
      deployment.kind !== "Deployment" ||
      metadata.name !== target.name ||
      metadata.namespace !== namespace ||
      metadata.uid !== undefined ||
      metadata.resourceVersion !== undefined ||
      metadata.generateName !== undefined ||
      metadata.deletionTimestamp !== undefined ||
      spec.replicas !== 0 ||
      Object.entries(identity).some(([key, value]) => annotations[key] !== value)
    )
      return refuse();
  } else {
    if (child.predicate.kind !== "expected-object" || !Array.isArray(body)) return refuse();
    const predicate = child.predicate;
    if (predicate.fenceEpoch !== child.guard.requestedFenceEpoch) return refuse();
    const tests = [
      { op: "test", path: "/metadata/uid", value: predicate.uid },
      { op: "test", path: "/metadata/resourceVersion", value: predicate.resourceVersion },
      {
        op: "test",
        path: pointer(PREPARED_DEPLOYMENT_ANNOTATIONS.assignment),
        value: predicate.ownerAssignmentRef.id,
      },
      {
        op: "test",
        path: pointer(PREPARED_DEPLOYMENT_ANNOTATIONS.create),
        value: predicate.ownerCreateEffectRef,
      },
      {
        op: "test",
        path: pointer(PREPARED_DEPLOYMENT_ANNOTATIONS.fence),
        value: String(predicate.fenceEpoch),
      },
    ];
    if (!isDeepStrictEqual(body.slice(0, tests.length), tests) || body.length !== tests.length + 1)
      return refuse();
    const mutation = record(body[tests.length]);
    // No annotation/owner mutation, copy/move, test deletion or later predicate
    // rebasing is expressible through this selected materialization primitive.
    if (
      Object.keys(mutation).sort().join(",") !== "op,path,value" ||
      mutation.op !== "replace" ||
      mutation.path !== "/spec"
    )
      return refuse();
    record(mutation.value);
  }
  return Object.freeze({
    child,
    namespace,
    providerWireUtf8,
    async submit(
      apps: Pick<AppsV1Api, "createNamespacedDeployment" | "patchNamespacedDeployment">,
    ): Promise<KubernetesPreparedDeploymentResponse> {
      const response: V1Deployment =
        action === "reserve-inert"
          ? await apps.createNamespacedDeployment({ namespace, body: body as V1Deployment })
          : await apps.patchNamespacedDeployment(
              { namespace, name: target.name, body },
              setHeaderOptions("Content-Type", "application/json-patch+json"),
            );
      const metadata = response.metadata;
      if (
        response.apiVersion !== "apps/v1" ||
        response.kind !== "Deployment" ||
        !metadata ||
        metadata.namespace !== namespace ||
        metadata.name !== target.name ||
        metadata.deletionTimestamp !== undefined ||
        Object.entries(identity).some(([key, value]) => metadata.annotations?.[key] !== value) ||
        (child.predicate.kind === "expected-object" && metadata.uid !== child.predicate.uid)
      )
        return refuse();
      return Object.freeze({
        namespace,
        name: target.name,
        uid: reference(metadata.uid),
        resourceVersion: reference(metadata.resourceVersion),
        receivedAt: new Date().toISOString(),
      });
    },
  });
}
