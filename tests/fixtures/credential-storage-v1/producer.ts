import type {
  CredentialStorageDependenciesV1,
  OutstandingTokenInventoryPortV1,
  ProtectedCredentialPortV1,
  SecretDriver,
} from "@openclaw-enterprise/contracts";

/**
 * Compile-only assembly: the embedding protected owner supplies its actual
 * custody, currentness, audit and durable inventory implementations. This
 * fixture supplies no backend, authority issuer, material accessor or provider.
 */
export interface TrustedProtectedStorageBuilder {
  create(dependencies: CredentialStorageDependenciesV1): {
    readonly credentials: ProtectedCredentialPortV1;
    readonly inventory: OutstandingTokenInventoryPortV1;
  };
}

/**
 * Named-backend lifecycle uses the existing selected SecretDriver. Its resolve
 * method returns a safe backend reference; material custody requires the
 * protected owner's separately implemented and qualified access path.
 *
 * The injected owner must durably reserve exact intent before mint, preserve
 * CAS and exact body/owner idempotency, and inventory every known returned token
 * before delivery. Late, scope-invalid or expiry-unproven tokens remain cleanup
 * obligations. Persistence or provider acknowledgment loss stays uncertain.
 *
 * Current original-turn authority is checked at each new effect. Readback and
 * reservations confer no delivery authority. New authority requires durable
 * audit acceptance; independently preauthorized exact mitigation retains its
 * separate capability and evidence obligation through audit loss.
 *
 * Binding the real methods preserves their owner and full published signatures,
 * including generic custody callbacks and mint-outcome custody overloads. It
 * neither creates a capability nor qualifies the backend's runtime behavior.
 */
export function createProtectedCredentialProducer(
  secretDriver: SecretDriver,
  backend: TrustedProtectedStorageBuilder,
): ProtectedCredentialPortV1 & OutstandingTokenInventoryPortV1 {
  const owner = backend.create({ secretDriver });

  return {
    withNamedCredentialV1: owner.credentials.withNamedCredentialV1.bind(owner.credentials),
    rotateBindingV1: owner.credentials.rotateBindingV1.bind(owner.credentials),
    reserveIssuanceV1: owner.inventory.reserveIssuanceV1.bind(owner.inventory),
    recordMintOutcomeV1: owner.inventory.recordMintOutcomeV1.bind(owner.inventory),
    deliverRecordedTokenV1: owner.inventory.deliverRecordedTokenV1.bind(owner.inventory),
    listAffectedV1: owner.inventory.listAffectedV1.bind(owner.inventory),
    claimRevocationV1: owner.inventory.claimRevocationV1.bind(owner.inventory),
    recordRevocationV1: owner.inventory.recordRevocationV1.bind(owner.inventory),
    readOperationV1: owner.inventory.readOperationV1.bind(owner.inventory),
  };
}
