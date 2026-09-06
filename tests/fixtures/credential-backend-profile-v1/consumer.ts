/** Compile-only consumers of the original ports. No fixture is invoked. */
import type { CredentialBackendLocalBindingsV1 } from "@openclaw-enterprise/contracts/credential-backend-profile-v1";
import type {
  CurrentCredentialAuthorityV1,
  CredentialManagementHandleV1,
  CredentialMitigationHandleV1,
  CredentialReadHandleV1,
} from "@openclaw-enterprise/contracts/credential-authority-v1";
import type {
  AffectedTokenPageV1,
  AffectedTokenQueryV1,
  BindingMutationResultV1,
  ClaimRevocationV1,
  CredentialMaterialHandleV1,
  CredentialOperationResultV1,
  CredentialStorageCallBoundsV1,
  CredentialUseResultV1,
  EphemeralTokenHandleV1,
  ExactCredentialOperationV1,
  InventoryWriteResultV1,
  IssuanceReservationResultV1,
  MintOutcomeV1,
  NamedCredentialUseV1,
  RecordedTokenDeliveryV1,
  ReserveIssuanceV1,
  RevocationClaimResultV1,
  RevocationOutcomeV1,
  RotateCredentialBindingV1,
  TokenDeliveryResultV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";

type InvocationObservation = Readonly<{ kind: "provider-observation" }>;

export function namedUse(
  bindings: CredentialBackendLocalBindingsV1,
  request: NamedCredentialUseV1,
  authority: CurrentCredentialAuthorityV1,
  fixedInvocation: (material: CredentialMaterialHandleV1) => Promise<InvocationObservation>,
  bounds: CredentialStorageCallBoundsV1,
): Promise<CredentialUseResultV1<InvocationObservation>> {
  return bindings.protectedCredentials.withNamedCredentialV1(
    request,
    authority,
    fixedInvocation,
    bounds,
  );
}
export function rotate(
  bindings: CredentialBackendLocalBindingsV1,
  request: RotateCredentialBindingV1,
  authority: CredentialManagementHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<BindingMutationResultV1> {
  return bindings.protectedCredentials.rotateBindingV1(request, authority, bounds);
}
export function reserve(
  bindings: CredentialBackendLocalBindingsV1,
  request: ReserveIssuanceV1,
  authority: CurrentCredentialAuthorityV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<IssuanceReservationResultV1> {
  return bindings.inventory.reserveIssuanceV1(request, authority, bounds);
}
export function recordKnownMint(
  bindings: CredentialBackendLocalBindingsV1,
  request: Extract<MintOutcomeV1, { outcome: "accepted" }>,
  responsibility: CredentialMitigationHandleV1,
  token: EphemeralTokenHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<InventoryWriteResultV1> {
  return bindings.inventory.recordMintOutcomeV1(request, responsibility, token, bounds);
}
export function recordUnknownMint(
  bindings: CredentialBackendLocalBindingsV1,
  request: Exclude<MintOutcomeV1, { outcome: "accepted" }>,
  responsibility: CredentialMitigationHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<InventoryWriteResultV1> {
  return bindings.inventory.recordMintOutcomeV1(request, responsibility, undefined, bounds);
}
export function deliver<T>(
  bindings: CredentialBackendLocalBindingsV1,
  request: RecordedTokenDeliveryV1,
  authority: CurrentCredentialAuthorityV1,
  exactDelivery: (token: EphemeralTokenHandleV1) => Promise<T>,
  bounds: CredentialStorageCallBoundsV1,
): Promise<TokenDeliveryResultV1<T>> {
  return bindings.inventory.deliverRecordedTokenV1(request, authority, exactDelivery, bounds);
}
export function affected(
  bindings: CredentialBackendLocalBindingsV1,
  request: AffectedTokenQueryV1,
  authority: CredentialReadHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<AffectedTokenPageV1> {
  return bindings.inventory.listAffectedV1(request, authority, bounds);
}
export function claim(
  bindings: CredentialBackendLocalBindingsV1,
  request: ClaimRevocationV1,
  responsibility: CredentialMitigationHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<RevocationClaimResultV1> {
  return bindings.inventory.claimRevocationV1(request, responsibility, bounds);
}
export function recordRevocation(
  bindings: CredentialBackendLocalBindingsV1,
  request: RevocationOutcomeV1,
  responsibility: CredentialMitigationHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<InventoryWriteResultV1> {
  return bindings.inventory.recordRevocationV1(request, responsibility, bounds);
}
export function exactReadback(
  bindings: CredentialBackendLocalBindingsV1,
  request: ExactCredentialOperationV1,
  authority: CredentialReadHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<CredentialOperationResultV1> {
  // This readback cannot authorize or retry the original effect.
  return bindings.inventory.readOperationV1(request, authority, bounds);
}
