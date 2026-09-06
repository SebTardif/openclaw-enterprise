import type { RuntimeReadCallV1 } from "@openclaw-enterprise/contracts/runtime-effects-v1";
import type {
  ContainmentControlObserverV1,
  ContainmentControlInputV1,
  ContainmentControlResultV1,
  ImmutableContainmentControlV1,
} from "@openclaw-enterprise/contracts/containment-controls-v1";

/** Independent compiler example for a producer with no protected control evidence.
 * It constructs only unavailable outcomes; this is not a runtime implementation. */
export class UnavailableObserver implements ContainmentControlObserverV1 {
  async readControls(
    input: ImmutableContainmentControlV1<ContainmentControlInputV1>,
    call: RuntimeReadCallV1,
  ): Promise<ImmutableContainmentControlV1<ContainmentControlResultV1>> {
    if (call.signal.aborted) {
      return {
        schemaVersion: 1,
        projectionVersion: 1,
        input,
        eligibility: "observation-only",
        status: "cancelled",
        reasonCode: "cancelled",
      };
    }
    return {
      schemaVersion: 1,
      projectionVersion: 1,
      input,
      eligibility: "observation-only",
      status: "unavailable",
      reasonCode: "evidence-incomplete",
    };
  }
}
