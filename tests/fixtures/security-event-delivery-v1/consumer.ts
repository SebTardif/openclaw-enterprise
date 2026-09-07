/** Strict callable API consumer. The schema factory has a separate Drizzle dependency qualification. */
import { parseSecurityEventJson } from "@openclaw-enterprise/contracts/security-events";
import {
  createSecurityEventDeliveryV1,
  type SecurityEventTransactionBoundaryV1,
  type ProvisionalSecurityEventReceiptV1,
} from "../../../packages/audit/src/security-event-delivery-v1.ts";
import type {
  SecurityEventAppendV1,
  SecurityEventCommittedV1,
} from "../../../packages/audit/src/security-event-delivery-codec-v1.ts";
import {
  createPostgresSecurityEventDeliveryV1,
  type SecurityEventStorageContextV1,
} from "../../../packages/occ/src/state/postgres/security-event-delivery-v1.ts";
import type {
  SecurityEventDeliveryRepositoryV1,
  SecurityEventStorageInputV1,
} from "../../../packages/occ/src/ports/repositories/security-event-delivery-v1.ts";

export function storageInput(
  request: SecurityEventAppendV1,
  origin: SecurityEventStorageInputV1["origin"],
): SecurityEventStorageInputV1 {
  return {
    event: parseSecurityEventJson(request.canonicalEventUtf8),
    producerInstanceRef: request.producerInstanceRef,
    producerSequence: request.producerSequence,
    obligationRef: request.obligationRef,
    origin,
  };
}
/** Compiler-only owner seam; no current production callback is supplied here. */
export function consumingOwner(
  owner: {
    transact<T>(
      work: (repository: SecurityEventDeliveryRepositoryV1) => Promise<T>,
      signal: AbortSignal,
    ): Promise<T>;
    read<T>(
      work: (repository: SecurityEventDeliveryRepositoryV1) => Promise<T>,
      signal: AbortSignal,
    ): Promise<T>;
  },
  origin: SecurityEventStorageInputV1["origin"],
) {
  const boundary: SecurityEventTransactionBoundaryV1 = {
    transact: (request, signal) =>
      owner.transact((repository) => repository.stage(storageInput(request, origin)), signal),
    read: (request, signal) =>
      owner.read((repository) => repository.readCommitted(storageInput(request, origin)), signal),
  };
  return createSecurityEventDeliveryV1(boundary);
}
export function bindRepository(
  context: SecurityEventStorageContextV1,
): SecurityEventDeliveryRepositoryV1 {
  return createPostgresSecurityEventDeliveryV1(context);
}
export function rejectProvisional(receipt: ProvisionalSecurityEventReceiptV1) {
  // @ts-expect-error a nested transaction receipt does not establish COMMIT
  const committed: SecurityEventCommittedV1 = receipt;
  return committed;
}
