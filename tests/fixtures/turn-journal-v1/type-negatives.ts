import type {
  TurnJournalUnitOfWorkV1,
  VerifiedAdmissionInputV1,
  PendingInitiationClaimV1,
  VerifiedConsumptionV1,
} from "@openclaw-enterprise/contracts";
import { parseTurnJournalV1 } from "@openclaw-enterprise/contracts";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts";
export function cannotMint(
  unit: TurnJournalUnitOfWorkV1,
  call: AuthorityCallV1,
  data: unknown,
  claim: PendingInitiationClaimV1,
) {
  const locator = parseTurnJournalV1("consumption", data);
  // @ts-expect-error Serialized locators cannot mint the server provenance handle.
  const forged: VerifiedConsumptionV1 = locator;
  // @ts-expect-error A verification boolean has no issuer provenance.
  const admission: VerifiedAdmissionInputV1 = { verified: true };
  // @ts-expect-error A pending local claim has no initiation method.
  claim.initiate();
  // @ts-expect-error Ordinary lookup cannot return an execution permit.
  unit.findAttempt(locator.attempt, call).then((result) => result.initiate());
  return { forged, admission };
}
