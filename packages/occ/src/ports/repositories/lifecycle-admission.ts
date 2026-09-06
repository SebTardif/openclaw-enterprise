import type { AuditEvent } from "@openclaw-enterprise/contracts/identity/audit";
import type {
  LifecycleAdmissionAssociationV1,
  LifecycleMutationRequestV1,
  ReconcileAgentLifecycleV1,
} from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import type {
  RuntimeAllocation,
  RuntimeIntentAttribution,
  RuntimeScope,
} from "@openclaw-enterprise/contracts/runtime-assignment";
import type { ControllerWork, PlatformOperation } from "./work.ts";

export type ProtectiveRequestV1 = Extract<
  LifecycleMutationRequestV1,
  { readonly kind: "disable" | "stop" }
>;

/** Trusted persistence input. None of these values is authenticated request custody. */
export interface ProtectiveAdmissionWriteV1 {
  readonly request: ProtectiveRequestV1;
  readonly transitionRef: string;
  readonly attribution: RuntimeIntentAttribution;
  readonly audit: Readonly<AuditEvent>;
  readonly workId: string;
  readonly responsibilityRef: string;
}

/** A versioned row in the existing work store, outside the legacy dispatcher. */
export interface PersistedLifecycleWorkV1 {
  readonly schemaVersion: 1;
  readonly input: ReconcileAgentLifecycleV1;
  readonly row: Readonly<ControllerWork>;
}

/** One working collection retains both protocols; outward legacy views unwrap only V0. */
export type StoredPlatformWork =
  | { readonly version: 0; readonly operation: Readonly<PlatformOperation> }
  | { readonly version: 1; readonly work: Readonly<PersistedLifecycleWorkV1> };

export interface RuntimeCleanupResponsibilityV1 extends RuntimeScope {
  readonly installationId: string;
  readonly responsibilityRef: string;
  readonly responsibilityVersion: 1;
  readonly originKind: "lifecycle-protective-v1";
  readonly originOperationRef: string;
  readonly lifecycleGeneration: number;
  readonly kind: "protective-fence" | "retained-stop";
  readonly predecessor: {
    readonly transitionRef: string;
    readonly generation: number;
  } | null;
  readonly inventoryStatus: "unresolved";
  readonly createdAt: string;
  /** Original immutable allocations only; an empty set does not establish absence. */
  readonly allocations: readonly Readonly<RuntimeAllocation>[];
}

export interface PendingAuditExportV1 {
  readonly auditEventId: string;
  readonly installationId: string;
  readonly namespaceId: string;
  readonly originKind: "lifecycle-protective-v1";
  readonly originOperationRef: string;
  readonly state: "pending";
  readonly createdAt: string;
}

/** Retained correspondence in one snapshot, not a commit receipt or cleanup authority. */
export interface ProtectiveAdmissionRecordV1 {
  readonly association: Readonly<LifecycleAdmissionAssociationV1>;
  readonly work: Readonly<PersistedLifecycleWorkV1>;
  readonly audit: Readonly<AuditEvent>;
  readonly cleanup: Readonly<RuntimeCleanupResponsibilityV1>;
  readonly export: Readonly<PendingAuditExportV1>;
}

export type ProtectiveAdmissionStorageResultV1 =
  | {
      readonly kind: "unchanged";
      readonly lifecycleGeneration: number;
      readonly desiredMode: "disabled" | "stopped";
    }
  | { readonly kind: "provisional"; readonly retained: Readonly<ProtectiveAdmissionRecordV1> };

export interface LifecycleAdmissionReadRepository {
  /** The caller owns read authorization and must use a fresh transaction after unknown COMMIT. */
  findCommitted(
    scope: RuntimeScope,
    operationRef: string,
  ): Promise<Readonly<ProtectiveAdmissionRecordV1> | undefined>;
}

export interface LifecycleAdmissionRepository extends LifecycleAdmissionReadRepository {
  /** Isolated original unit only. Success stays provisional until the outer owner commits. */
  applyProtective(input: ProtectiveAdmissionWriteV1): Promise<ProtectiveAdmissionStorageResultV1>;
}
