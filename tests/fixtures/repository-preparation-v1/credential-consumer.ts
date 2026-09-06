import type {
  CredentialMitigationHandleV1,
  CredentialReadHandleV1,
} from "@openclaw-enterprise/contracts/credential-authority-v1";
import type {
  CredentialMaterialHandleV1,
  CredentialStorageCallBoundsV1,
  CredentialUseResultV1,
  EphemeralTokenHandleV1,
  OutstandingTokenInventoryPortV1,
  TokenDeliveryResultV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import type {
  CurrentPreparationCredentialAuthorityV1,
  PreparationAffectedTokenPageV1,
  PreparationAffectedTokenQueryV1,
  PreparationClaimRevocationV1,
  PreparationInventoryWriteResultV1,
  PreparationMintOutcomeV1,
  PreparationNamedCredentialUseV1,
  PreparationOperationResultV1,
  PreparationReadOperationV1,
  PreparationRevocationClaimResultV1,
  PreparationRevocationOutcomeV1,
  PreparationTokenDeliveryV1,
  PreparationTokenRecordV1,
  RepositoryCredentialAuthorityV1,
  RepositoryCredentialExchangeV1,
  RepositoryCredentialRequestV1,
  RepositoryPreparationCredentialPortV1,
} from "@openclaw-enterprise/contracts/repository-preparation-v1";

/**
 * Compile-only consumer wiring, never invoked by a test. Actual owners supply
 * exact requests, current authority, protected custody and fixed adapters.
 * This fixture implements no issuer, authority evaluator or inventory backend.
 */
function unreachable(value: never): never {
  throw new Error("Unhandled repository preparation variant.");
}

type ReservationInput = {
  [Purpose in RepositoryCredentialAuthorityV1["purpose"]]: Extract<
    RepositoryCredentialAuthorityV1,
    { purpose: Purpose }
  > & {
    readonly request: Extract<
      Extract<RepositoryCredentialRequestV1, { purpose: Purpose }>["request"],
      { method: "reserveIssuance" }
    >;
  };
}[RepositoryCredentialAuthorityV1["purpose"]];

type ReservationOutput = Extract<
  RepositoryCredentialExchangeV1,
  { request: { method: "reserveIssuance" } }
>;

/** Dispatch preserves the original request and its accepted digest unchanged. */
export async function reserveForExactPurpose(
  originalInventory: OutstandingTokenInventoryPortV1,
  preparation: RepositoryPreparationCredentialPortV1,
  input: ReservationInput,
  bounds: CredentialStorageCallBoundsV1,
): Promise<ReservationOutput> {
  switch (input.purpose) {
    case "original-turn-runtime":
      return {
        purpose: input.purpose,
        request: input.request,
        result: await originalInventory.reserveIssuanceV1(input.request, input.authority, bounds),
      };
    case "candidate-repository-preparation":
      return {
        purpose: input.purpose,
        request: input.request,
        result: await preparation.reserveIssuanceV1(input.request, input.authority, bounds),
      };
    default:
      return unreachable(input);
  }
}

export async function useReservedPreparationMaterial<T>(
  preparation: RepositoryPreparationCredentialPortV1,
  request: PreparationNamedCredentialUseV1,
  obtainCurrentAuthority: () => Promise<CurrentPreparationCredentialAuthorityV1>,
  invokeFixedMintAdapter: (material: CredentialMaterialHandleV1) => Promise<T>,
  bounds: CredentialStorageCallBoundsV1,
): Promise<CredentialUseResultV1<T>> {
  const authority = await obtainCurrentAuthority();
  // The owner rechecks currentness after awaits and claims the retained provider
  // attempt before invoking this adapter. A supplied locator cannot establish it.
  const result = await preparation.withNamedCredentialV1(
    request,
    authority,
    invokeFixedMintAdapter,
    bounds,
  );
  switch (result.kind) {
    case "used":
    case "effect-unknown":
    case "denied":
    case "conflict":
    case "unavailable":
    case "capacity-exhausted":
      // Preserve the original operation on uncertainty; never call again here.
      return result;
    default:
      return unreachable(result);
  }
}

type ObservedPreparationMint = {
  [Outcome in PreparationMintOutcomeV1["outcome"]]: {
    readonly outcome: Outcome;
    readonly metadata: Extract<PreparationMintOutcomeV1, { outcome: Outcome }>;
  } & (Outcome extends "accepted" ? { readonly material: EphemeralTokenHandleV1 } : {});
}[PreparationMintOutcomeV1["outcome"]];

/** Record original issuer observations even after that candidate was fenced. */
export async function retainPreparationMintOutcome(
  preparation: RepositoryPreparationCredentialPortV1,
  observed: ObservedPreparationMint,
  responsibility: CredentialMitigationHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<PreparationInventoryWriteResultV1> {
  switch (observed.outcome) {
    case "accepted":
      return preparation.recordMintOutcomeV1(
        observed.metadata,
        responsibility,
        observed.material,
        bounds,
      );
    case "definitely-rejected":
    case "unknown":
    case "unknown-expiry-established":
    case "unknown-expired":
    case "unknown-broader-revocation-confirmed":
      return preparation.recordMintOutcomeV1(observed.metadata, responsibility, undefined, bounds);
    default:
      return unreachable(observed);
  }
}

type PreparationRecordHandling =
  | "issuance-held"
  | "unknown-issuance-with-expiry-held"
  | "definitive-no-issuance"
  | "unknown-issuance-expired"
  | "broader-revocation-confirmed"
  | "fresh-delivery-check-required"
  | "mitigation-only"
  | "delivery-reconciliation-required"
  | "revocation-pending"
  | "revocation-unknown"
  | "revocation-failed-terminal"
  | "revocation-claimed"
  | "revocation-confirmed"
  | "token-expired";

export function inspectPreparationRecord(
  record: PreparationTokenRecordV1,
): PreparationRecordHandling {
  switch (record.state) {
    case "reserved":
      return "issuance-held";
    case "mint-unknown":
      switch (record.expiry.kind) {
        case "expiry-unproven":
          return "issuance-held";
        case "provider-expiry":
          return "unknown-issuance-with-expiry-held";
        default:
          return unreachable(record.expiry);
      }
    case "not-issued":
      return "definitive-no-issuance";
    case "resolved-without-token":
      switch (record.resolution.kind) {
        case "expired":
          return "unknown-issuance-expired";
        case "broader-revocation-confirmed":
          return "broader-revocation-confirmed";
        default:
          return unreachable(record.resolution);
      }
    case "outstanding":
      switch (record.revocation.state) {
        case "pending":
          return "revocation-pending";
        case "unknown":
          return "revocation-unknown";
        case "failed-terminal":
          return "revocation-failed-terminal";
        case "claimed":
          return "revocation-claimed";
        case "confirmed":
          return "revocation-confirmed";
        case "expired":
          return "token-expired";
        case "unrequested":
          if (
            record.disposition === "mitigation-only" ||
            record.expiry.kind !== "provider-expiry" ||
            record.returnedScope.status !== "matches-request"
          ) {
            return "mitigation-only";
          }
          switch (record.delivery.state) {
            case "not-delivered":
              return "fresh-delivery-check-required";
            case "intent-recorded":
            case "delivered":
            case "unknown":
              return "delivery-reconciliation-required";
            default:
              return unreachable(record.delivery);
          }
        default:
          return unreachable(record.revocation);
      }
    default:
      return unreachable(record);
  }
}

type PreparationDeliveryProgress<T> =
  | { readonly kind: "inventory-outcome"; readonly result: PreparationInventoryWriteResultV1 }
  | {
      readonly kind: "record-retained";
      readonly record: PreparationTokenRecordV1;
      readonly handling: PreparationRecordHandling;
    }
  | { readonly kind: "delivery-outcome"; readonly result: TokenDeliveryResultV1<T> };

export async function recordThenDeliverPreparationToken<T>(
  preparation: RepositoryPreparationCredentialPortV1,
  observed: Extract<ObservedPreparationMint, { outcome: "accepted" }>,
  responsibility: CredentialMitigationHandleV1,
  exactDelivery: PreparationTokenDeliveryV1,
  obtainCurrentAuthority: () => Promise<CurrentPreparationCredentialAuthorityV1>,
  deliverToExactPreparationAdapter: (token: EphemeralTokenHandleV1) => Promise<T>,
  bounds: CredentialStorageCallBoundsV1,
): Promise<PreparationDeliveryProgress<T>> {
  const written = await retainPreparationMintOutcome(preparation, observed, responsibility, bounds);
  switch (written.kind) {
    case "recorded": {
      const handling = inspectPreparationRecord(written.record);
      if (handling !== "fresh-delivery-check-required") {
        return { kind: "record-retained", record: written.record, handling };
      }
      const authority = await obtainCurrentAuthority();
      // The actual acceptor compares candidate/record/request correspondence and
      // current grant, secret, profile and generation immediately before release.
      const result = await preparation.deliverRecordedTokenV1(
        exactDelivery,
        authority,
        deliverToExactPreparationAdapter,
        bounds,
      );
      switch (result.kind) {
        case "delivered":
        case "delivery-unknown":
        case "denied":
        case "conflict":
        case "unavailable":
        case "capacity-exhausted":
          return { kind: "delivery-outcome", result };
        default:
          return unreachable(result);
      }
    }
    case "commit-unknown":
    case "evidence-missing":
    case "denied":
    case "conflict":
    case "unavailable":
    case "capacity-exhausted":
      // Failed/unknown persistence cannot establish before-delivery durability.
      return { kind: "inventory-outcome", result: written };
    default:
      return unreachable(written);
  }
}

export async function inspectAffectedPreparationInventory(
  preparation: RepositoryPreparationCredentialPortV1,
  request: PreparationAffectedTokenQueryV1,
  reader: CredentialReadHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<PreparationAffectedTokenPageV1> {
  const result = await preparation.listAffectedV1(request, reader, bounds);
  switch (result.kind) {
    case "page":
      // Keep the exact candidate filter and unresolved counts. End of this
      // persisted snapshot cannot establish complete revocation or cleanup.
      return result;
    case "snapshot-invalid":
    case "denied":
    case "conflict":
    case "unavailable":
    case "capacity-exhausted":
      return result;
    default:
      return unreachable(result);
  }
}

export async function claimPreparationRevocation(
  preparation: RepositoryPreparationCredentialPortV1,
  request: PreparationClaimRevocationV1,
  responsibility: CredentialMitigationHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<PreparationRevocationClaimResultV1> {
  const result = await preparation.claimRevocationV1(request, responsibility, bounds);
  switch (result.kind) {
    case "claimed":
      // The nextAction may require reconciling a prior provider attempt.
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

export async function recordPreparationRevocation(
  preparation: RepositoryPreparationCredentialPortV1,
  observed: PreparationRevocationOutcomeV1,
  responsibility: CredentialMitigationHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<PreparationInventoryWriteResultV1> {
  switch (observed.outcome) {
    case "confirmed":
    case "expired":
    case "pending":
    case "unknown":
    case "failed-terminal":
      return preparation.recordRevocationV1(observed, responsibility, bounds);
    default:
      return unreachable(observed);
  }
}

export async function readExactPreparationOperation(
  preparation: RepositoryPreparationCredentialPortV1,
  request: PreparationReadOperationV1,
  reader: CredentialReadHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<PreparationOperationResultV1> {
  const result = await preparation.readOperationV1(request, reader, bounds);
  switch (result.kind) {
    case "found":
    case "not-found":
    case "unavailable":
    case "not-visible":
      // Exact readback, including not-found, cannot authorize mint or redelivery.
      return result;
    default:
      return unreachable(result);
  }
}
