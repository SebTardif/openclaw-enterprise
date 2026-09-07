import type { SecurityEventV1 } from "@openclaw-enterprise/contracts/security-events";

/** Internal storage input from the original authorized producer and operation.
 * This is not a wire request or a grant. Stage resolves the real outbox row. */
export interface SecurityEventStorageInputV1 {
  readonly event: Readonly<SecurityEventV1>;
  readonly producerInstanceRef: string;
  readonly producerSequence: number;
  readonly obligationRef: string;
  readonly origin: {
    readonly auditEventId: string;
    readonly originalOperationRef: string;
  };
}
export interface StagedSecurityEventV1 {
  readonly kind: "Staged";
  readonly key: { readonly installationId: string; readonly eventId: string };
  readonly eventDigest: string;
  readonly commitReceiptRef: string;
}
export interface SecurityEventStorageRefusalV1 {
  readonly kind: "RefusedBeforeCommit";
  readonly key: { readonly installationId: string; readonly eventId: string };
  readonly code:
    "InvalidRecord" | "WrongProducerScope" | "Capacity" | "Conflict" | "UnavailableBeforeCommit";
}
export type SecurityEventStorageReadV1 =
  | {
      readonly kind: "Committed";
      readonly key: StagedSecurityEventV1["key"];
      readonly eventDigest: string;
      readonly commitReceiptRef: string;
    }
  | { readonly kind: "Conflict"; readonly key: StagedSecurityEventV1["key"] }
  | {
      readonly kind: "Unknown";
      readonly key: StagedSecurityEventV1["key"];
      readonly code: "ReadbackUnavailable" | "StorageUnknown";
    };
export interface SecurityEventDeliveryRepositoryV1 {
  /** Must share the operation's guarded transaction; failure must abort that unit. */
  stage(
    input: SecurityEventStorageInputV1,
  ): Promise<StagedSecurityEventV1 | SecurityEventStorageRefusalV1>;
  /** A separately authorized fresh transaction, never a read-your-uncommitted-write. */
  readCommitted(input: SecurityEventStorageInputV1): Promise<SecurityEventStorageReadV1>;
}
