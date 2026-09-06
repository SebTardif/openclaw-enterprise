import { decodeContainmentControlExchangeV1 } from "@openclaw-enterprise/contracts/containment-controls-codec-v1";
import type {
  RuntimeReadCallV1,
  RuntimeFaultSinkV1,
} from "@openclaw-enterprise/contracts/runtime-effects-v1";
import type { RuntimeAuthorityContextFactoryV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type {
  ContainmentControlInputV1,
  ContainmentControlObserverV1,
  ImmutableContainmentControlV1,
} from "@openclaw-enterprise/contracts/containment-controls-v1";

/** Independent consumer: structural summaries remain untrusted observation data.
 * The actual evaluator must additionally verify original protected producers, current
 * authority and every original source clock/version before granting its own purpose. */
export async function summarize(
  observer: ContainmentControlObserverV1,
  input: ImmutableContainmentControlV1<ContainmentControlInputV1>,
  call: RuntimeReadCallV1,
  contexts: RuntimeAuthorityContextFactoryV1<unknown>,
) {
  const service = await contexts.inspect(call.context, call);
  if (!service || call.signal.aborted) return { status: "unknown" } as const;
  const result = decodeContainmentControlExchangeV1(
    input,
    await observer.readControls(input, call),
  );
  if (result.kind === "invalid" || result.value.status !== "observed")
    return { status: "unknown" } as const;
  return {
    status: "untrusted-observation",
    controls: result.value.controls,
    runtime: result.value.runtimeObservation,
  } as const;
}
// Fault currentness, durable responsibility and stop remain the original port.
export type ExistingFaultWriter = RuntimeFaultSinkV1;
