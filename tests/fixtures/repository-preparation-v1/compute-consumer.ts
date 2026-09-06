import {
  parsePreparationReceiptExchangeV1,
  parseRepositoryPreparationV1,
} from "@openclaw-enterprise/contracts/repository-preparation-codec-v1";
import type {
  AuthorityCallV1,
  PreparationCheckoutReceiptV1,
  PreparationCheckoutRequestV1,
  PreparationReceiptDiagnosticV1,
  PreparationReceiptResultV1,
  RepositoryPreparationReceiptPortV1,
  RuntimeEffectClockV1,
  RuntimeEvidenceProvenanceV1,
  StoreBindingRefV1,
} from "@openclaw-enterprise/contracts/repository-preparation-v1";

/**
 * Compile-only consumer of the credential-facing Compute receipt boundary.
 * Real producer-owned ports and call contexts are injected. Job/Pod identity,
 * execution, staging observation and readiness require their separate producer.
 */
function unreachable(value: never): never {
  throw new Error("Unhandled preparation receipt variant.");
}

/** Expected store data establishes neither a mounted staging area nor cleanup. */
export function expectedPreparationStore(request: PreparationCheckoutRequestV1): StoreBindingRefV1 {
  return request.preparation.staging;
}

/** Retain the actual producer observation time; never refresh it on local readback. */
export function sourceObservation(receipt: PreparationCheckoutReceiptV1): {
  readonly provenance: RuntimeEvidenceProvenanceV1;
  readonly clock: RuntimeEffectClockV1;
  readonly staging: StoreBindingRefV1;
} {
  return {
    provenance: receipt.provenance,
    clock: receipt.provenance.clock,
    staging: receipt.staging,
  };
}

/**
 * Parse diagnostic metadata and check exact request/receipt correspondence.
 * The trusted owner supplies the evaluation clock separately; source timestamps
 * remain unchanged. A successful parse provides no producer handle or readiness.
 * A live handle-bearing result must stay with its owner, outside this JSON path.
 */
export function inspectReceiptCorrespondence(
  request: PreparationCheckoutRequestV1,
  diagnosticInput: unknown,
  evaluationClock: RuntimeEffectClockV1,
): PreparationReceiptDiagnosticV1 {
  const diagnostic = parseRepositoryPreparationV1("receiptResult", diagnosticInput);
  const result = parsePreparationReceiptExchangeV1(request, diagnostic, evaluationClock);
  switch (result.status) {
    case "complete":
    case "incomplete":
    case "unknown":
    case "rejected":
    case "cancelled":
    case "stale":
    case "conflict":
    case "not-visible":
      return result;
    default:
      return unreachable(result);
  }
}

export async function readExactPreparationReceipt(
  producer: RepositoryPreparationReceiptPortV1,
  request: PreparationCheckoutRequestV1,
  call: AuthorityCallV1,
): Promise<PreparationReceiptResultV1> {
  const result = await producer.readReceiptV1(request, call);
  switch (result.status) {
    case "complete":
      // Preserve the opaque producer capability together with its exact receipt.
      // Callers still need currentness checks after awaits and a lifecycle decision.
      return result;
    case "incomplete":
    case "unknown":
    case "rejected":
    case "cancelled":
    case "stale":
    case "conflict":
    case "not-visible":
      // Neither transport closure nor an incomplete result establishes readiness.
      return result;
    default:
      return unreachable(result);
  }
}
