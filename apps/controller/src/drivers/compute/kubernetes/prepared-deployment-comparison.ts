import { isDeepStrictEqual } from "node:util";
import type { V1Deployment } from "@kubernetes/client-node";
import { ObjectSerializer } from "@kubernetes/client-node/dist/gen/models/ObjectSerializer.js";
import type { RuntimePreparedChildV1 } from "@openclaw-enterprise/contracts";
import {
  PREPARED_DEPLOYMENT_ANNOTATIONS,
  prepareKubernetesDeploymentRequest,
} from "./prepared-deployment.ts";

/** Pure correspondence against the actual selected constructor's full result.
 * The caller must own the original revision/launcher/profile and current source;
 * neither expected wire nor a matching template establishes that provenance. */
export function comparePreparedHarnessDeployment(
  actual: V1Deployment,
  child: RuntimePreparedChildV1,
  wire: string,
): void {
  const namespace = actual.metadata?.namespace;
  if (
    !namespace ||
    actual.metadata?.name !== child.providerTarget.name ||
    !actual.spec ||
    child.request.kind !== "create"
  )
    throw new Error("The original Harness construction differs from the preparation target.");
  prepareKubernetesDeploymentRequest(child, wire, namespace);
  const identity = {
    [PREPARED_DEPLOYMENT_ANNOTATIONS.assignment]: child.providerTarget.ownerAssignmentRef.id,
    [PREPARED_DEPLOYMENT_ANNOTATIONS.create]: child.providerTarget.ownerCreateEffectRef,
    [PREPARED_DEPLOYMENT_ANNOTATIONS.fence]: String(child.guard.requestedFenceEpoch),
  };
  const supplied = JSON.parse(wire) as unknown;
  if (child.request.action === "reserve-inert") {
    const expected = {
      ...actual,
      metadata: {
        ...actual.metadata,
        annotations: { ...actual.metadata.annotations, ...identity },
      },
      spec: { ...actual.spec, replicas: 0 },
    };
    if (JSON.stringify(ObjectSerializer.serialize(expected, "V1Deployment", "")) !== wire)
      throw new Error("The inert reservation differs from the original full Harness construction.");
  } else {
    // Codec above requires exactly five retained predicates and one spec write.
    if (!Array.isArray(supplied) || !isDeepStrictEqual(supplied[5].value, actual.spec))
      throw new Error("Materialization differs from the original full Harness construction.");
  }
}
