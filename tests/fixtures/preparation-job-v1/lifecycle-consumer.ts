import type {
  PreparationJobEffectsV1,
  PreparationJobReadV1,
  PreparationJobSealV1,
} from "@openclaw-enterprise/contracts/preparation-job-v1";
import {
  parsePreparationJobReadExchangeV1,
  parsePreparationJobMutationExchangeV1,
} from "@openclaw-enterprise/contracts/preparation-job-codec-v1";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type { RuntimeEffectClockV1 } from "@openclaw-enterprise/contracts/runtime-effects-v1";

export async function readOriginal(
  port: PreparationJobEffectsV1,
  input: PreparationJobReadV1 & { readonly method: "read-original-effect" },
  call: AuthorityCallV1,
  clock: () => RuntimeEffectClockV1,
) {
  const result = await port.readback(input, call);
  // Preserve original target, method, bytes/digest and call authority through await.
  return parsePreparationJobReadExchangeV1(input, result, clock());
}
export async function sealOriginal(
  port: PreparationJobEffectsV1,
  input: PreparationJobSealV1,
  call: AuthorityCallV1,
  clock: () => RuntimeEffectClockV1,
) {
  const result = await port.seal(input, call);
  // An acknowledged seal still has physicalOutcome unproven; no successor action.
  return parsePreparationJobMutationExchangeV1(input, result, clock());
}
