import { setHeaderOptions, type AppsV1Api, type V1Deployment } from "@kubernetes/client-node";
import { ObjectSerializer } from "@kubernetes/client-node/dist/gen/models/ObjectSerializer.js";
import {
  parseRuntimeEffectsV1,
  type RuntimePreparedChildV1,
} from "@openclaw-enterprise/contracts/runtime-effects-v1";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  RuntimeCreateEncodingConditionalWireTargetV1,
  RuntimeCreateEncodingHoldingV1,
  RuntimeCreateEncodingMutationHoldV1,
  RuntimeCreateEncodingOutcomeV1,
} from "@openclaw-enterprise/occ/state/postgres/runtime-create-encoding-holding";

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

/** A projection of the original holding contract, not a new issuer. I is
 * forwarded unchanged from the original accepting execution lease. */
export interface KubernetesPreparedDeploymentEncodingV1<I extends object> {
  readonly originalInvocation: I;
  readonly holding: Pick<
    RuntimeCreateEncodingHoldingV1<I, never, never>,
    "beginMutation" | "retainOutcome"
  >;
  readonly target: RuntimeCreateEncodingConditionalWireTargetV1;
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
  let submitted = false;
  let poisoned = false;
  let poison: unknown;
  return Object.freeze({
    child,
    namespace,
    providerWireUtf8,
    async submit<I extends object>(
      apps: Pick<AppsV1Api, "createNamespacedDeployment" | "patchNamespacedDeployment">,
      input: KubernetesPreparedDeploymentEncodingV1<I>,
    ): Promise<KubernetesPreparedDeploymentResponse> {
      if (submitted) {
        if (!poisoned) {
          poisoned = true;
          poison = new Error("The original conditional Deployment submission was already entered.");
        }
        throw poison;
      }
      submitted = true;
      // Reserve before getters and publish the full continuation before supplier
      // entry. The original provider independently joins this returned promise.
      await Promise.resolve();
      const holding = input.holding;
      const beginMutation = holding.beginMutation;
      const retainOutcome = holding.retainOutcome;
      const originalInvocation = input.originalInvocation;
      const offered = input.target;
      const committed = offered.committed;
      const sourceSelection = offered.selection;
      const selection = Object.freeze({
        installationId: reference(sourceSelection.installationId),
        namespaceId: reference(sourceSelection.namespaceId),
        agentId: reference(sourceSelection.agentId),
        clusterRef: reference(sourceSelection.clusterRef),
        kubernetesNamespaceUid: reference(sourceSelection.kubernetesNamespaceUid),
        namespace: reference(sourceSelection.namespace),
        name: reference(sourceSelection.name),
      });
      if (
        typeof beginMutation !== "function" ||
        typeof retainOutcome !== "function" ||
        !isDeepStrictEqual(offered.child, child) ||
        !isDeepStrictEqual(committed.child, child) ||
        offered.providerWireUtf8 !== providerWireUtf8 ||
        committed.providerWireUtf8 !== providerWireUtf8 ||
        selection.installationId !== committed.request.selection.installationId ||
        selection.namespaceId !== committed.request.selection.namespaceId ||
        selection.agentId !== committed.request.selection.agentId ||
        selection.namespace !== namespace ||
        selection.name !== target.name
      )
        return refuse();
      const conditionalTarget: RuntimeCreateEncodingConditionalWireTargetV1 = Object.freeze({
        committed,
        selection,
        child,
        providerWireUtf8,
      });
      // Capture the exact SDK method/arguments before the final held fence. No
      // caller getter or authority callback is opened between it and dispatch.
      const dispatch =
        action === "reserve-inert"
          ? (() => {
              const create = apps.createNamespacedDeployment;
              const request = { namespace, body: body as V1Deployment };
              return () => Reflect.apply(create, apps, [request]) as Promise<V1Deployment>;
            })()
          : (() => {
              const patch = apps.patchNamespacedDeployment;
              const request = { namespace, name: target.name, body };
              const headers = setHeaderOptions("Content-Type", "application/json-patch+json");
              return () => Reflect.apply(patch, apps, [request, headers]) as Promise<V1Deployment>;
            })();
      let hold: RuntimeCreateEncodingMutationHoldV1 | undefined;
      let release: RuntimeCreateEncodingMutationHoldV1["release"] | undefined;
      let outcome: RuntimeCreateEncodingOutcomeV1 = Object.freeze({ status: "unknown" });
      let result: KubernetesPreparedDeploymentResponse | undefined;
      const errors: unknown[] = [];
      const deferred: Promise<unknown>[] = [];
      const assertLocal = () => {
        if (poisoned) throw poison;
      };
      try {
        assertLocal();
        // The genuine owner alone recognizes I, commits possible-effect history
        // definitely, and supplies exclusive all-writer custody. Values are data.
        const originalHold: RuntimeCreateEncodingMutationHoldV1 = await Reflect.apply(
          beginMutation,
          holding,
          [originalInvocation, conditionalTarget],
        );
        hold = originalHold;
        // Capture cleanup immediately, before currentness/history getters.
        release = originalHold.release;
        if (typeof release !== "function") return refuse();
        const current = originalHold.assertCurrent;
        if (typeof current !== "function") return refuse();
        const possible = originalHold.possibleEffect;
        const possibleSelection = possible.selection;
        if (
          possible.schemaVersion !== 1 ||
          possible.kind !== "possible-effect" ||
          possible.submissionRef !== committed.submissionRef ||
          Object.keys(possibleSelection).sort().join(",") !==
            Object.keys(selection).sort().join(",") ||
          Object.entries(selection).some(
            ([key, value]) => possibleSelection[key as keyof typeof selection] !== value,
          ) ||
          possible.childEffectRef !== child.effect.effectRef ||
          possible.assignmentRef !== target.ownerAssignmentRef.id ||
          possible.createEffectRef !== target.ownerCreateEffectRef ||
          possible.expectedUid !==
            (child.predicate.kind === "expected-object" ? child.predicate.uid : null) ||
          possible.expectedResourceVersion !==
            (child.predicate.kind === "expected-object" ? child.predicate.resourceVersion : null) ||
          possible.requestedFenceEpoch !== child.guard.requestedFenceEpoch ||
          possible.providerWireDigest !== child.providerWire.bytesDigest
        )
          return refuse();
        const returned: unknown = Reflect.apply(current, originalHold, []);
        if (returned !== undefined) {
          const pending = Promise.resolve(returned);
          void pending.catch(() => {});
          deferred.push(pending);
          return refuse();
        }
        assertLocal();
        // Await the actual SDK continuation without racing away from late work.
        // Public cancellation cannot release this hold or erase possible effects.
        const response: V1Deployment = await dispatch();
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
        result = Object.freeze({
          namespace,
          name: target.name,
          uid: reference(metadata.uid),
          resourceVersion: reference(metadata.resourceVersion),
          receivedAt: new Date().toISOString(),
        });
        outcome = Object.freeze({ status: "response", response: result });
      } catch (error) {
        errors.push(error);
      } finally {
        if (hold !== undefined) {
          // A malformed response, refusal after acquisition or SDK error remains
          // unknown. Neither outcome resolves the durable possible-effect entry.
          try {
            await Reflect.apply(retainOutcome, holding, [hold, outcome]);
          } catch (error) {
            errors.push(error);
          }
          const settled = await Promise.allSettled(deferred);
          for (const item of settled) if (item.status === "rejected") errors.push(item.reason);
          if (release !== undefined) {
            try {
              await Reflect.apply(release, hold, []);
            } catch (error) {
              errors.push(error);
            }
          }
        }
      }
      if (poisoned && !errors.includes(poison)) errors.push(poison);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new AggregateError(errors, "Conditional Deployment outcome or cleanup failed.", {
          cause: errors[0],
        });
      if (result === undefined) return refuse();
      // Return the SAME response projection retained above. The original Hume
      // observer then persists it under its independent response-call lifetime.
      return result;
    },
  });
}
