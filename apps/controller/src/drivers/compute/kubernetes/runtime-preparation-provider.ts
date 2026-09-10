import type { AppsV1Api } from "@kubernetes/client-node";
import { isDeepStrictEqual } from "node:util";
import type { PostgresPlatformState } from "@openclaw-enterprise/occ";
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

export interface KubernetesPreparationProviderOptions {
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

export function captureKubernetesPreparedProvider(
  options: KubernetesPreparationProviderOptions,
  committed: RuntimePreparationCommittedSubmissionV1,
  assertEntry: (request: RuntimeCreateV1, call: RuntimeEffectCallV1) => undefined,
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
      const response = await options.request(() => prepared.submit(clients.apps), call);
      // The capture was registered before provider entry. No old worker/profile
      // fence runs after the actual ACK: independent observation owns this late
      // response, even if the guard's public wait already returned unresolved.
      await captureResponse(response);
      return response;
    });
  };
}
