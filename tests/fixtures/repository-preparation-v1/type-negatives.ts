import type {
  CurrentPreparationCredentialAuthorityV1,
  PreparationCredentialAuthorityObservationV1,
  PreparationReserveIssuanceV1,
  PreparationNamedCredentialUseV1,
  PreparationMintOutcomeV1,
  PreparationTokenDeliveryV1,
  PreparationTokenRecordV1,
  RepositoryCredentialSubjectV1,
  RepositoryCredentialInventoryRecordV1,
  RepositoryCredentialAuthorityV1,
  RepositoryCredentialRequestV1,
  RepositoryPreparationCredentialPortV1,
  RepositoryPreparationReceiptPortV1,
  PreparationCheckoutRequestV1,
  PreparationCheckoutReceiptV1,
  PreparationReceiptDiagnosticV1,
  ProtectedPreparationReceiptHandleV1,
  AuthorityCallV1,
} from "@openclaw-enterprise/contracts/repository-preparation-v1";
import type {
  CurrentCredentialAuthorityV1,
  CredentialMitigationHandleV1,
  OriginalCredentialBindingV1,
} from "@openclaw-enterprise/contracts/credential-authority-v1";
import type {
  ReserveIssuanceV1,
  OutstandingTokenRecordV1,
  OutstandingTokenInventoryPortV1,
  CredentialStorageCallBoundsV1,
  EphemeralTokenHandleV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import type { RuntimeAssignmentTargetV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";

/** Compile-only negative correspondence. Never called or imported by runtime tests.
 * Parameters stand for actual owner-supplied values; no fixture creates a capability.
 */
export function rejectForbiddenSubstitutions(
  preparationPort: RepositoryPreparationCredentialPortV1,
  originalPort: OutstandingTokenInventoryPortV1,
  receiptPort: RepositoryPreparationReceiptPortV1,
  originalAuthority: CurrentCredentialAuthorityV1,
  preparationAuthority: CurrentPreparationCredentialAuthorityV1,
  observation: PreparationCredentialAuthorityObservationV1,
  original: OriginalCredentialBindingV1,
  originalReserve: ReserveIssuanceV1,
  preparationReserve: PreparationReserveIssuanceV1,
  preparationUse: PreparationNamedCredentialUseV1,
  preparationDelivery: PreparationTokenDeliveryV1,
  originalRecord: OutstandingTokenRecordV1,
  preparationRecord: PreparationTokenRecordV1,
  accepted: Extract<PreparationMintOutcomeV1, { outcome: "accepted" }>,
  unknown: Extract<PreparationMintOutcomeV1, { outcome: "unknown" }>,
  mitigation: CredentialMitigationHandleV1,
  token: EphemeralTokenHandleV1,
  request: PreparationCheckoutRequestV1,
  receipt: PreparationCheckoutReceiptV1,
  diagnostic: Extract<PreparationReceiptDiagnosticV1, { status: "complete" }>,
  bounds: CredentialStorageCallBoundsV1,
  call: AuthorityCallV1,
): void {
  const preparationPurpose: "candidate-repository-preparation" = "candidate-repository-preparation";
  const originalPurpose: "original-turn-runtime" = "original-turn-runtime";
  const relabeledSubject = { purpose: preparationPurpose, original };
  const relabeledOriginalInventory = { purpose: preparationPurpose, record: originalRecord };
  const relabeledPreparationInventory = { purpose: originalPurpose, record: preparationRecord };
  const relabeledAuthority = { purpose: originalPurpose, authority: preparationAuthority };
  const relabeledPreparationRequest = { purpose: originalPurpose, request: preparationReserve };
  const relabeledOriginalRequest = { purpose: preparationPurpose, request: originalReserve };
  const relabeledUnknownMint = { purpose: originalPurpose, request: unknown };
  // @ts-expect-error A preparation request has no canonical original-turn projection.
  const oldRequest: ReserveIssuanceV1 = preparationReserve;
  // @ts-expect-error The old request has no explicitly admitted preparation subject.
  const newRequest: PreparationReserveIssuanceV1 = originalReserve;
  // @ts-expect-error Purpose labels cannot relabel an original turn as preparation.
  const badSubject: RepositoryCredentialSubjectV1 = relabeledSubject;
  // @ts-expect-error Original inventory cannot silently acquire a preparation purpose.
  const newInventory: RepositoryCredentialInventoryRecordV1 = relabeledOriginalInventory;
  // @ts-expect-error Preparation inventory cannot become original-turn inventory.
  const oldInventory: RepositoryCredentialInventoryRecordV1 = relabeledPreparationInventory;
  // @ts-expect-error The same nominal handle identity does not equate observation purposes.
  const oldAuthority: CurrentCredentialAuthorityV1 = preparationAuthority;
  // @ts-expect-error An original authority observation has no preparation subject.
  const newAuthority: CurrentPreparationCredentialAuthorityV1 = originalAuthority;
  // @ts-expect-error A union's purpose must correspond to its authority variant.
  const badAuthority: RepositoryCredentialAuthorityV1 = relabeledAuthority;
  // @ts-expect-error Original-turn union members retain the original request dictionary.
  const oldUnionRequest: RepositoryCredentialRequestV1 = relabeledPreparationRequest;
  // @ts-expect-error A preparation purpose cannot fill its subject from original-turn fields.
  const newUnionRequest: RepositoryCredentialRequestV1 = relabeledOriginalRequest;
  // @ts-expect-error Shared mint fields cannot hide a preparation purpose in the original branch.
  const originalUnknownMint: RepositoryCredentialRequestV1 = relabeledUnknownMint;
  // @ts-expect-error Parsed observation data does not contain an authenticated handle.
  const observationAsAuthority: CurrentPreparationCredentialAuthorityV1 = observation;
  // @ts-expect-error The original port cannot consume a preparation request.
  void originalPort.reserveIssuanceV1(preparationReserve, originalAuthority, bounds);
  // @ts-expect-error The preparation port cannot consume an original request.
  void preparationPort.reserveIssuanceV1(originalReserve, preparationAuthority, bounds);
  // @ts-expect-error Fresh original-turn authority cannot authorize a preparation operation.
  void preparationPort.reserveIssuanceV1(preparationReserve, originalAuthority, bounds);
  void preparationPort.withNamedCredentialV1(
    preparationUse,
    // @ts-expect-error Named material use retains its preparation authority purpose.
    originalAuthority,
    async () => undefined,
    bounds,
  );
  void preparationPort.deliverRecordedTokenV1(
    preparationDelivery,
    // @ts-expect-error Delivery retains its preparation authority purpose.
    originalAuthority,
    async () => undefined,
    bounds,
  );
  // @ts-expect-error Known accepted tokens require protected custody, not undefined.
  void preparationPort.recordMintOutcomeV1(accepted, mitigation, undefined, bounds);
  // @ts-expect-error Unknown issuance does not invent a protected token handle.
  void preparationPort.recordMintOutcomeV1(unknown, mitigation, token, bounds);
  // @ts-expect-error Opaque Compute receipt handles have no public constructor.
  const forgedHandle: ProtectedPreparationReceiptHandleV1 = {};
  // @ts-expect-error A parsed complete diagnostic lacks the actual producer-owned handle.
  void receiptPort.assertCurrentReceiptV1(request, diagnostic, call);
  // @ts-expect-error A credential-facing locator is not a gateway/harness assignment or Job identity.
  const assignment: RuntimeAssignmentTargetV1 = request.preparation;
  // @ts-expect-error A complete receipt is metadata, not a readiness decision.
  void receipt.ready;
  // @ts-expect-error The admitted commit is immutable after decoding.
  request.preparation.commit.oid = "b".repeat(40);
  // @ts-expect-error Inventory retains immutable original candidate attribution.
  preparationRecord.issuance.preparation.incarnationRef = "incarnation/other";
  void [
    oldRequest,
    newRequest,
    badSubject,
    newInventory,
    oldInventory,
    oldAuthority,
    newAuthority,
    badAuthority,
    oldUnionRequest,
    newUnionRequest,
    originalUnknownMint,
    observationAsAuthority,
    forgedHandle,
    assignment,
  ];
}
