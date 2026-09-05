import type {
  AffectedTokenPageV1,
  AffectedTokenQueryV1,
  ClaimRevocationV1,
  CredentialMaterialHandleV1,
  CredentialMitigationHandleV1,
  CredentialOperationResultV1,
  CredentialReadHandleV1,
  CredentialStorageCallBoundsV1,
  CredentialUseResultV1,
  CurrentCredentialAuthorityV1,
  EphemeralTokenHandleV1,
  ExactCredentialOperationV1,
  InventoryWriteResultV1,
  IssuanceReservationResultV1,
  MintOutcomeV1,
  NamedCredentialUseV1,
  OutstandingTokenInventoryPortV1,
  OutstandingTokenRecordV1,
  ProtectedCredentialPortV1,
  RecordedTokenDeliveryV1,
  ReserveIssuanceV1,
  RevocationClaimResultV1,
  RevocationOutcomeV1,
  TokenDeliveryResultV1,
} from "@openclaw-enterprise/contracts";

/**
 * Compile-only consumer wiring, never invoked by a test. Real owners supply all
 * ports, authenticated capabilities, exact server-selected requests and fixed
 * adapters. This fixture implements no authority, provider or storage backend.
 */
function unreachable(value: never): never {
  throw new Error("Unhandled credential storage variant.");
}

export async function useSelectedModelCredential<T>(
  credentials: ProtectedCredentialPortV1,
  input: Extract<NamedCredentialUseV1, { purpose: "model-use" }>,
  currentAuthority: CurrentCredentialAuthorityV1,
  invokeFixedModelAdapter: (material: CredentialMaterialHandleV1) => Promise<T>,
  bounds: CredentialStorageCallBoundsV1,
): Promise<CredentialUseResultV1<T>> {
  const result = await credentials.withNamedCredentialV1(
    input,
    currentAuthority,
    invokeFixedModelAdapter,
    bounds,
  );
  switch (result.kind) {
    case "used":
      return result;
    case "effect-unknown":
      // An ambiguous model effect must retain its original operation, not replay.
      return result;
    case "denied":
    case "conflict":
    case "unavailable":
    case "capacity-exhausted":
      return result;
    default:
      return unreachable(result);
  }
}

export async function reserveNativeIssuance(
  inventory: OutstandingTokenInventoryPortV1,
  input: ReserveIssuanceV1,
  currentAuthority: CurrentCredentialAuthorityV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<IssuanceReservationResultV1> {
  const result = await inventory.reserveIssuanceV1(input, currentAuthority, bounds);
  switch (result.kind) {
    case "reserved":
      // The fixed mint adapter must load this reservation and recheck authority.
      return result;
    case "existing":
    case "commit-unknown":
      // Existing intent and uncertain commits cannot cause another mint.
      return result;
    case "denied":
    case "conflict":
    case "unavailable":
    case "capacity-exhausted":
      return result;
    default:
      return unreachable(result);
  }
}

type ProviderMintObservation = {
  [Outcome in MintOutcomeV1["outcome"]]: {
    readonly outcome: Outcome;
    readonly metadata: Extract<MintOutcomeV1, { outcome: Outcome }>;
  } & (Outcome extends "accepted" ? { readonly material: EphemeralTokenHandleV1 } : {});
}[MintOutcomeV1["outcome"]];

/** The protected issuer supplies these observations; this function never mints. */
export async function recordObservedMint(
  inventory: OutstandingTokenInventoryPortV1,
  observation: ProviderMintObservation,
  responsibility: CredentialMitigationHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<InventoryWriteResultV1> {
  switch (observation.outcome) {
    case "accepted":
      return inventory.recordMintOutcomeV1(
        observation.metadata,
        responsibility,
        observation.material,
        bounds,
      );
    case "definitely-rejected":
    case "unknown":
    case "unknown-expiry-established":
    case "unknown-expired":
    case "unknown-broader-revocation-confirmed":
      return inventory.recordMintOutcomeV1(observation.metadata, responsibility, undefined, bounds);
    default:
      return unreachable(observation);
  }
}

type RecordHandling =
  | "unresolved-issuance-held"
  | "unresolved-issuance-with-expiry-held"
  | "unknown-issuance-expiry-evidenced"
  | "broader-revocation-confirmed"
  | "definitive-no-issuance"
  | "current-delivery-check-required"
  | "mitigation-required"
  | "delivery-reconciliation-required"
  | "revocation-pending"
  | "revocation-unknown"
  | "revocation-failed-terminal"
  | "revocation-claimed"
  | "provider-revocation-confirmed"
  | "provider-expiry-evidenced";

export function inspectOutstandingRecord(record: OutstandingTokenRecordV1): RecordHandling {
  switch (record.state) {
    case "reserved":
      return "unresolved-issuance-held";
    case "mint-unknown":
      // Provider-derived expiry bounds an unknown mint; it does not resolve it.
      switch (record.expiry.kind) {
        case "expiry-unproven":
          return "unresolved-issuance-held";
        case "provider-expiry":
          return "unresolved-issuance-with-expiry-held";
        default:
          return unreachable(record.expiry);
      }
    case "resolved-without-token":
      switch (record.resolution.kind) {
        case "expired":
          return "unknown-issuance-expiry-evidenced";
        case "broader-revocation-confirmed":
          return "broader-revocation-confirmed";
        default:
          return unreachable(record.resolution);
      }
    case "not-issued":
      return "definitive-no-issuance";
    case "outstanding":
      switch (record.revocation.state) {
        case "confirmed":
          return "provider-revocation-confirmed";
        case "expired":
          return "provider-expiry-evidenced";
        case "pending":
          return "revocation-pending";
        case "unknown":
          return "revocation-unknown";
        case "failed-terminal":
          return "revocation-failed-terminal";
        case "claimed":
          return "revocation-claimed";
        case "unrequested":
          switch (record.disposition) {
            case "mitigation-only":
              return "mitigation-required";
            case "current-check-required":
              if (
                record.expiry.kind !== "provider-expiry" ||
                record.returnedScope.status !== "matches-request"
              ) {
                return "mitigation-required";
              }
              switch (record.delivery.state) {
                case "not-delivered":
                  return "current-delivery-check-required";
                case "intent-recorded":
                case "delivered":
                case "unknown":
                  return "delivery-reconciliation-required";
                default:
                  return unreachable(record.delivery);
              }
            default:
              return unreachable(record);
          }
        default:
          return unreachable(record.revocation);
      }
    default:
      return unreachable(record);
  }
}

type NativeDeliveryProgress<T> =
  | { readonly kind: "inventory-outcome"; readonly outcome: InventoryWriteResultV1 }
  | {
      readonly kind: "record-retained";
      readonly record: OutstandingTokenRecordV1;
      readonly handling: RecordHandling;
    }
  | { readonly kind: "delivery-outcome"; readonly outcome: TokenDeliveryResultV1<T> };

/**
 * Record the accepted token before asking its original authority owner for a new
 * delivery capability. Equality, currentness, expiry and compare-and-consume are
 * still enforced by the real storage acceptor at material release.
 */
export async function recordThenDeliverNativeToken<T>(
  inventory: OutstandingTokenInventoryPortV1,
  accepted: Extract<ProviderMintObservation, { outcome: "accepted" }>,
  responsibility: CredentialMitigationHandleV1,
  exactDelivery: RecordedTokenDeliveryV1,
  obtainCurrentDeliveryAuthority: () => Promise<CurrentCredentialAuthorityV1>,
  deliverToSelectedNativeAdapter: (token: EphemeralTokenHandleV1) => Promise<T>,
  bounds: CredentialStorageCallBoundsV1,
): Promise<NativeDeliveryProgress<T>> {
  const written = await recordObservedMint(inventory, accepted, responsibility, bounds);
  switch (written.kind) {
    case "recorded": {
      const handling = inspectOutstandingRecord(written.record);
      if (handling !== "current-delivery-check-required") {
        return { kind: "record-retained", record: written.record, handling };
      }
      // A write receipt is not current authority. Acquisition remains separate.
      const authority = await obtainCurrentDeliveryAuthority();
      const outcome = await inventory.deliverRecordedTokenV1(
        exactDelivery,
        authority,
        deliverToSelectedNativeAdapter,
        bounds,
      );
      switch (outcome.kind) {
        case "delivered":
          return { kind: "delivery-outcome", outcome };
        case "delivery-unknown":
          // The adapter may already have released the bearer; do not redeliver.
          return { kind: "delivery-outcome", outcome };
        case "denied":
        case "conflict":
        case "unavailable":
        case "capacity-exhausted":
          return { kind: "delivery-outcome", outcome };
        default:
          return unreachable(outcome);
      }
    }
    case "commit-unknown":
    case "evidence-missing":
      // Retain the exact outcome and accepted mitigation responsibility. Neither
      // an unknown commit nor missing evidence establishes durable inventory.
      return { kind: "inventory-outcome", outcome: written };
    case "denied":
    case "conflict":
    case "unavailable":
    case "capacity-exhausted":
      return { kind: "inventory-outcome", outcome: written };
    default:
      return unreachable(written);
  }
}

export async function inspectAffectedSnapshot(
  inventory: OutstandingTokenInventoryPortV1,
  input: AffectedTokenQueryV1,
  reader: CredentialReadHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<AffectedTokenPageV1> {
  const result = await inventory.listAffectedV1(input, reader, bounds);
  switch (result.kind) {
    case "page":
      // next=null ends only this persisted snapshot. Preserve unresolved counts
      // and records; neither pagination exhaustion nor an empty page proves revoke.
      return result;
    case "snapshot-invalid":
      // The caller restarts the exact authorized filter, never a broader scan.
      return result;
    case "denied":
    case "conflict":
    case "unavailable":
    case "capacity-exhausted":
      return result;
    default:
      return unreachable(result);
  }
}

/** Accepted mitigation survives loss of authority to mint or deliver. */
export async function claimAcceptedRevocation(
  inventory: OutstandingTokenInventoryPortV1,
  input: ClaimRevocationV1,
  responsibility: CredentialMitigationHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<RevocationClaimResultV1> {
  const result = await inventory.claimRevocationV1(input, responsibility, bounds);
  switch (result.kind) {
    case "claimed":
      // An accepted claim can require reconciliation of the previous attempt.
      return result;
    case "busy":
    case "commit-unknown":
    case "denied":
    case "conflict":
    case "unavailable":
    case "capacity-exhausted":
      return result;
    default:
      return unreachable(result);
  }
}

export async function recordObservedRevocation(
  inventory: OutstandingTokenInventoryPortV1,
  input: RevocationOutcomeV1,
  responsibility: CredentialMitigationHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<InventoryWriteResultV1> {
  switch (input.outcome) {
    case "confirmed":
    case "expired":
    case "pending":
    case "unknown":
    case "failed-terminal":
      return inventory.recordRevocationV1(input, responsibility, bounds);
    default:
      return unreachable(input);
  }
}

export async function inspectExactOperation(
  inventory: OutstandingTokenInventoryPortV1,
  input: ExactCredentialOperationV1,
  reader: CredentialReadHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<CredentialOperationResultV1> {
  const result = await inventory.readOperationV1(input, reader, bounds);
  switch (result.kind) {
    case "found":
    case "not-found":
    case "unavailable":
    case "not-visible":
      // Readback is observation only, including a completed operation.
      return result;
    default:
      return unreachable(result);
  }
}
