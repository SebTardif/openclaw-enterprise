import type {
  ContainmentControlInputV1,
  ContainmentControlObserverV1,
  ImmutableContainmentControlV1,
} from "@openclaw-enterprise/contracts/containment-controls-v1";
import type {
  RuntimeFaultSinkV1,
  RuntimeReadCallV1,
} from "@openclaw-enterprise/contracts/runtime-effects-v1";
import {
  evaluateContainmentEvidenceV1,
  type ContainmentEvidenceClockV1,
  type ContainmentEvidenceEvaluationInputV1,
  type ContainmentEvidenceEvaluationV1,
  type ContainmentEvidenceStateV1,
} from "@openclaw-enterprise/occ/containment/evidence-evaluator-v1";
import {
  ContainmentFaultRequestAdapterV1,
  type ContainmentFaultClockV1,
} from "@openclaw-enterprise/occ/containment/fault-request-adapter-v1";

/** Independent compiler composition over original injected ports. No service
 * context, source evidence, authority result or durable receipt is constructed.
 * The original observer owns authenticated finite reads and producer custody;
 * the accepting owner supplies the complete expected controls and original
 * authority exchange. The resulting comparison cannot grant a runtime purpose.
 */
export class OriginalContainmentPorts {
  readonly faults: ContainmentFaultRequestAdapterV1;
  private readonly observer: ContainmentControlObserverV1;

  constructor(
    observer: ContainmentControlObserverV1,
    sink: RuntimeFaultSinkV1,
    clock: ContainmentFaultClockV1,
  ) {
    this.observer = observer;
    this.faults = new ContainmentFaultRequestAdapterV1({ sink, clock });
  }

  async compareOriginalRead(
    expected: ImmutableContainmentControlV1<ContainmentControlInputV1>,
    original: Omit<ContainmentEvidenceEvaluationInputV1, "expected" | "observation" | "clock">,
    previous: ImmutableContainmentControlV1<ContainmentEvidenceStateV1>,
    call: RuntimeReadCallV1,
    sampleTrustedClock: () => ContainmentEvidenceClockV1,
  ): Promise<ContainmentEvidenceEvaluationV1> {
    if (call.signal.aborted) throw new Error("Original read was cancelled before invocation.");
    const observation = await this.observer.readControls(expected, call);
    if (call.signal.aborted) throw new Error("Original read was cancelled.");
    return evaluateContainmentEvidenceV1(
      { ...original, expected, observation, clock: sampleTrustedClock() },
      previous,
    );
  }
}
