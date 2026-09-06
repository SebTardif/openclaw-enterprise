import type {
  PreparationJobEffectsV1,
  PreparationJobAdmissionPortV1,
  PreparationJobAdmissionReadV1,
} from "@openclaw-enterprise/contracts/preparation-job-v1";
import {
  parsePreparationJobClosureExchangeV1,
  parsePreparationJobAdmissionExchangeV1,
} from "@openclaw-enterprise/contracts/preparation-job-codec-v1";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type { RuntimeEffectClockV1 } from "@openclaw-enterprise/contracts/runtime-effects-v1";

// Both supplied ports belong to the existing accepting owners. This fixture does
// not implement them, manufacture completeness, release writers or grant purge.
export async function readRetainedClosure(
  port: PreparationJobEffectsV1,
  admission: PreparationJobAdmissionPortV1,
  input: PreparationJobAdmissionReadV1,
  call: AuthorityCallV1,
  clock: () => RuntimeEffectClockV1,
) {
  const admitted = parsePreparationJobAdmissionExchangeV1(
    input,
    await admission.readAdmission(input, call),
    clock(),
  );
  if (admitted.status !== "admitted") return admitted;
  const request = { ...input, method: "read-closure" as const, admission: admitted.snapshot };
  const result = await port.readClosure(request, call);
  const current = parsePreparationJobAdmissionExchangeV1(
    input,
    await admission.assertCurrentAdmission(input, admitted.snapshot, call),
    clock(),
    admitted.snapshot,
  );
  if (current.status !== "admitted") return current;
  // Recheck closure freshness after the actual current-owner await. A refreshed
  // admission observation never extends the earlier physical observation's age.
  return parsePreparationJobClosureExchangeV1(request, result, clock());
}
