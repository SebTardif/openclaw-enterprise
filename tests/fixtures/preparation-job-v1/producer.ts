import type {
  PreparationJobPlanV1,
  PreparationJobReserveV1,
  PreparationJobEffectsV1,
} from "@openclaw-enterprise/contracts/preparation-job-v1";
import {
  parsePreparationJobV1,
  preparationJobPlanDigestV1,
  preparationJobMutationDigestV1,
  parsePreparationJobMutationExchangeV1,
} from "@openclaw-enterprise/contracts/preparation-job-codec-v1";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type { RuntimeEffectClockV1 } from "@openclaw-enterprise/contracts/runtime-effects-v1";

// The real producer supplies an already admitted subject and closed plan. This
// example builds data only; no fixture manufactures admission or a service call.
export function closePlan(input: PreparationJobPlanV1): PreparationJobPlanV1 {
  const planDigest = preparationJobPlanDigestV1(input);
  return parsePreparationJobV1("plan", {
    ...input,
    planDigest,
    target: {
      ...input.target,
      preparation: {
        ...input.target.preparation,
        gate: { ...input.target.preparation.gate, planDigest },
      },
    },
  });
}
export function closeReservation(input: PreparationJobReserveV1): PreparationJobReserveV1 {
  return parsePreparationJobV1("reserve", {
    ...input,
    requestDigest: preparationJobMutationDigestV1(input),
  });
}
export async function submitOriginal(
  port: PreparationJobEffectsV1,
  input: PreparationJobReserveV1,
  call: AuthorityCallV1,
  clock: () => RuntimeEffectClockV1,
) {
  const original = parsePreparationJobV1("reserve", input);
  const result = await port.reserve(original, call);
  return parsePreparationJobMutationExchangeV1(original, result, clock());
}
