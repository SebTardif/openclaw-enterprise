import type { CredentialMitigationHandleV1 } from "@openclaw-enterprise/contracts/credential-authority-v1";
import type { CredentialStorageCallBoundsV1 } from "@openclaw-enterprise/contracts/credential-storage-v1";
import type {
  AuthorityCallV1,
  PreparationCheckoutRequestV1,
  PreparationFenceResultV1,
  PreparationFenceV1,
  PreparationReceiptDiagnosticV1,
  RepositoryPreparationCredentialPortV1,
  RepositoryPreparationReceiptPortV1,
  RuntimeGateGuardV1,
} from "@openclaw-enterprise/contracts/repository-preparation-v1";

/** Compile-only lifecycle consumers; neither function activates a candidate. */
function unreachable(value: never): never {
  throw new Error("Unhandled preparation lifecycle variant.");
}

/** Use the owning lifecycle guard representation without inventing Job identity. */
export function expectedLifecycleGuard(request: PreparationCheckoutRequestV1): RuntimeGateGuardV1 {
  return request.preparation.gate;
}

/**
 * A complete receipt remains evidence for the lifecycle owner's separate current
 * decision. The injected producer checks actual provenance and exact scope; the
 * second call repeats currentness after the intervening asynchronous read.
 */
export async function inspectReceiptAfterLifecycleRead(
  receipts: RepositoryPreparationReceiptPortV1,
  request: PreparationCheckoutRequestV1,
  call: AuthorityCallV1,
  readCurrentLifecycleState: () => Promise<void>,
): Promise<PreparationReceiptDiagnosticV1> {
  const first = await receipts.readReceiptV1(request, call);
  switch (first.status) {
    case "complete": {
      await readCurrentLifecycleState();
      const checked = await receipts.assertCurrentReceiptV1(request, first, call);
      switch (checked.status) {
        case "complete":
        case "incomplete":
        case "unknown":
        case "rejected":
        case "cancelled":
        case "stale":
        case "conflict":
        case "not-visible":
          return checked;
        default:
          return unreachable(checked);
      }
    }
    case "incomplete":
    case "unknown":
    case "rejected":
    case "cancelled":
    case "stale":
    case "conflict":
    case "not-visible":
      // Lost connection, cancellation or a deadline cannot establish no effect.
      return first;
    default:
      return unreachable(first);
  }
}

/**
 * The sole credential owner fences only the exact candidate and retains its
 * inventory/cleanup obligation. The independently serving grant is unaffected;
 * this result establishes no Job stop, staging cleanup or provider revocation.
 */
export async function fenceExactPreparation(
  credentials: RepositoryPreparationCredentialPortV1,
  request: PreparationFenceV1,
  responsibility: CredentialMitigationHandleV1,
  bounds: CredentialStorageCallBoundsV1,
): Promise<PreparationFenceResultV1> {
  const result = await credentials.fencePreparationV1(request, responsibility, bounds);
  switch (result.kind) {
    case "fenced":
    case "commit-unknown":
    case "evidence-missing":
    case "denied":
    case "conflict":
    case "unavailable":
    case "capacity-exhausted":
      return result;
    default:
      return unreachable(result);
  }
}
