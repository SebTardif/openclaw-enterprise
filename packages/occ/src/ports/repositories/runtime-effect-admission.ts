import type {
  ExactRuntimeFaultOperationV1,
  ExactRuntimeFaultV1,
  RuntimeAssignmentTargetV1,
  RuntimeAuthorityScopeV1,
  RuntimeClosedPlanV1,
  RuntimeGateGuardV1,
} from "@openclaw-enterprise/contracts";
import type { AuditEvent } from "@openclaw-enterprise/contracts/identity/audit";
import type { RuntimeFaultWorkV1 } from "../../lifecycle/runtime-fault-work-v1.ts";

/** The canonical durable gate projection. It is not current caller authority,
 * provider evidence, an execution lease, or a RuntimeGateStateV1 response. */
export interface StoredRuntimeEffectGateV1 {
  readonly schemaVersion: 1;
  readonly preparationRef: string;
  readonly preparationOperationRef: string;
  readonly target: RuntimeAssignmentTargetV1;
  readonly guard: RuntimeGateGuardV1;
  readonly plan: RuntimeClosedPlanV1;
  readonly ordinaryAdmission: "closed";
  readonly sealerAdmission: "closed";
  readonly lastClosureOperationRef: string | null;
}

/** Exact original fault and closure retained in the existing cleanup owner.
 * Retention does not authenticate the fault producer or establish stop delivery. */
export interface StoredRuntimeFaultRequestV1 {
  readonly schemaVersion: 1;
  readonly fault: ExactRuntimeFaultV1;
  readonly canonicalRequest: string;
  readonly closedGuard: RuntimeGateGuardV1;
  readonly work: RuntimeFaultWorkV1;
  readonly auditEventId: string;
  readonly writerRef: string;
  readonly recordedAt: string;
}

export interface RuntimeFaultStorageWriteV1 {
  readonly fault: ExactRuntimeFaultV1;
  readonly workId: string;
  readonly audit: Readonly<AuditEvent>;
}

export interface RuntimeEffectAdmissionReadRepository {
  findGate(scope: RuntimeAuthorityScopeV1): Promise<StoredRuntimeEffectGateV1 | undefined>;
  findFaultRequest(
    operation: ExactRuntimeFaultOperationV1,
  ): Promise<StoredRuntimeFaultRequestV1 | undefined>;
}

/** Internal original-transaction storage operations. The outer owner must
 * authenticate source custody before accepting a fault request; the provisional
 * return is never the public RuntimeEffectAdmissionV1 acceptance result. */
export interface RuntimeEffectAdmissionRepository extends RuntimeEffectAdmissionReadRepository {
  /** Resolves an original retained plan, initializes closed, and never backfills
   * retained children into the independently admitted cutoff. */
  retainClosedGate(
    scope: RuntimeAuthorityScopeV1,
    preparationOperationRef: string,
  ): Promise<Readonly<{ kind: "provisional"; gate: StoredRuntimeEffectGateV1 }>>;
  retainFaultRequest(input: RuntimeFaultStorageWriteV1): Promise<
    Readonly<{
      kind: "provisional" | "exact-replay";
      retained: StoredRuntimeFaultRequestV1;
    }>
  >;
}
