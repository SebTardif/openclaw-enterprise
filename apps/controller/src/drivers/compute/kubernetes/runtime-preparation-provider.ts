import type { AppsV1Api } from "@kubernetes/client-node";
import { isDeepStrictEqual } from "node:util";
import type { PostgresPlatformState } from "@openclaw-enterprise/occ";
import type {
  RuntimeCreateEncodingHoldingV1,
  RuntimeCreateEncodingSelectionV1,
} from "@openclaw-enterprise/occ/state/postgres/runtime-create-encoding-holding";
import type { DriverSelection } from "@openclaw-enterprise/occ/application/driver-selection";
import type { RuntimePreparationCommittedSubmissionV1 } from "@openclaw-enterprise/occ/runtime-preparation/submission-owner";
import type { RuntimePreparationCurrentUseLeaseV1 } from "@openclaw-enterprise/occ/runtime-preparation/current-use";
import type {
  WorkloadProfileOwnedLeaseV2,
  WorkloadProfileOwnedOperationV2,
} from "@openclaw-enterprise/occ/workload-profiles/admitted-use";
import type { WorkloadProfileCapabilitySourceV2 } from "@openclaw-enterprise/occ/workload-profiles/selection";
import type {
  RuntimeCreateV1,
  RuntimeEffectCallV1,
} from "@openclaw-enterprise/contracts/runtime-effects-v1";
import type { ComputeDriver } from "@openclaw-enterprise/contracts";
import {
  prepareKubernetesDeploymentRequest,
  type KubernetesPreparedDeploymentResponse,
} from "./prepared-deployment.ts";

export interface KubernetesPreparationProviderOptions<I extends object = never> {
  /** I belongs to the original accepting effect implementation. These methods
   * consume its retained identity; this constructor cannot issue one. */
  readonly encodingHolding: Pick<
    RuntimeCreateEncodingHoldingV1<I, never, never>,
    "beginMutation" | "retainOutcome"
  >;
  /** Expected physical selection from the selected original Driver. These data
   * are independently matched by holding against the accepted invocation; a
   * namespace read or this callback's success is not writer authority. */
  readonly encodingSelection: (
    committed: RuntimePreparationCommittedSubmissionV1,
    namespace: string,
    originalCall: RuntimeEffectCallV1,
  ) => Promise<RuntimeCreateEncodingSelectionV1>;
  readonly driver: ComputeDriver;
  readonly selection: DriverSelection;
  readonly state: Pick<PostgresPlatformState, "withRuntimePreparationWorkerCurrentUseV1">;
  readonly capabilities: WorkloadProfileCapabilitySourceV2;
  readonly verify: (
    lease: RuntimePreparationCurrentUseLeaseV1,
    io: WorkloadProfileOwnedOperationV2,
  ) => Promise<WorkloadProfileOwnedLeaseV2>;
  readonly clients: () => Promise<{
    readonly apps: Pick<AppsV1Api, "createNamespacedDeployment" | "patchNamespacedDeployment">;
  }>;
  readonly namespace: (namespaceId: string) => Promise<string>;
  readonly request: <T>(operation: () => Promise<T>, call: RuntimeEffectCallV1) => Promise<T>;
}

/** Fixed SDK consumer, not RuntimeEffects.create and not an accepting owner.
 * Only the original full RuntimeEffects implementation may enter this callback
 * after its own admission/fence/current-call checks. The canonical marker never
 * grants that permission. This helper returns the real response projection only;
 * the original effect owner separately owns RuntimeEffectResultV1 provenance. */
export type KubernetesPreparedProviderEntryV1 = (
  request: RuntimeCreateV1,
  originalCall: RuntimeEffectCallV1,
) => Promise<KubernetesPreparedDeploymentResponse>;

export function captureKubernetesPreparedProvider<I extends object>(
  options: KubernetesPreparationProviderOptions<I>,
  committed: RuntimePreparationCommittedSubmissionV1,
  assertEntry: (request: RuntimeCreateV1, call: RuntimeEffectCallV1) => undefined,
  retainProviderInvocation: (request: RuntimeCreateV1, originalCall: RuntimeEffectCallV1) => I,
  captureResponse: (response: KubernetesPreparedDeploymentResponse) => Promise<void>,
  track: <T>(work: () => Promise<T>) => Promise<T>,
): KubernetesPreparedProviderEntryV1 {
  let entered = false;
  return (request, call) => {
    // Reserve and register the entire continuation before external callbacks.
    if (entered) {
      return track(async () => {
        throw new Error("The original provider entry was already used.");
      });
    }
    entered = true;
    return track(async () => {
      assertEntry(request, call);
      if (!isDeepStrictEqual(request, committed.child.request))
        throw new Error("The provider request differs from the committed child.");
      const clients = await options.clients();
      assertEntry(request, call);
      const namespace = await options.namespace(committed.request.selection.namespaceId);
      assertEntry(request, call);
      const selected = await options.encodingSelection(committed, namespace, call);
      assertEntry(request, call);
      // Detach only expected data. Preserve the genuine invocation identity below.
      const encodingSelection = Object.freeze({
        installationId: selected.installationId,
        namespaceId: selected.namespaceId,
        agentId: selected.agentId,
        clusterRef: selected.clusterRef,
        kubernetesNamespaceUid: selected.kubernetesNamespaceUid,
        namespace: selected.namespace,
        name: selected.name,
      });
      if (
        encodingSelection.installationId !== committed.request.selection.installationId ||
        encodingSelection.namespaceId !== committed.request.selection.namespaceId ||
        encodingSelection.agentId !== committed.request.selection.agentId ||
        encodingSelection.namespace !== namespace ||
        encodingSelection.name !== committed.child.providerTarget.name ||
        Object.values(encodingSelection).some(
          (value) => typeof value !== "string" || !value.length || value.includes("\0"),
        )
      )
        throw new Error("The original physical encoding selection differs.");
      assertEntry(request, call);
      const prepared = await options.state.withRuntimePreparationWorkerCurrentUseV1(
        options.selection,
        committed.claim,
        committed.request,
        { signal: call.signal, timeoutMs: 3_000 },
        async (lease, io) => {
          lease.assertCurrent();
          assertEntry(request, call);
          if (
            !isDeepStrictEqual(lease.child, committed.child) ||
            lease.providerWireUtf8 !== committed.providerWireUtf8
          )
            throw new Error("The current retained provider input differs.");
          const renderer = await options.verify(lease, io);
          lease.retain(renderer);
          renderer.assertCurrent();
          lease.assertCurrent();
          assertEntry(request, call);
          return prepareKubernetesDeploymentRequest(lease.child, lease.providerWireUtf8, namespace);
        },
        options.capabilities,
      );
      // SQL ownership has ended. The independently accepting original effect
      // source must still recognize this exact provider call immediately here.
      assertEntry(request, call);
      let sdkEntered = false;
      const response = await options.request(() => {
        if (sdkEntered) throw new Error("The original SDK operation was already entered.");
        sdkEntered = true;
        // Register the actual entered SDK/outcome continuation independently of
        // the request wrapper's public wait, before any external supplier callback.
        return track(async () => {
          // The SAME accepting lease lends its already-owned private I. A
          // successful assertion or copied request cannot manufacture it here.
          assertEntry(request, call);
          const originalInvocation = retainProviderInvocation(request, call);
          assertEntry(request, call);
          const response = await prepared.submit(clients.apps, {
            originalInvocation,
            holding: options.encodingHolding,
            target: Object.freeze({
              committed,
              selection: encodingSelection,
              child: committed.child,
              providerWireUtf8: committed.providerWireUtf8,
            }),
          });
          // No old worker/profile check follows the ACK. Independent observation
          // owns this response even if the request wrapper has already unwound.
          await captureResponse(response);
          return response;
        });
      }, call);
      return response;
    });
  };
}
