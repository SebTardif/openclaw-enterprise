import type { ServicePrincipal } from "@openclaw-enterprise/contracts/identity/identity";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type { JournalExecutionStartV1 } from "@openclaw-enterprise/contracts/turn-journal-v1";
import type { OpenRead } from "../github-mediation-v2/wire.ts";
import type {
  WorkExecutionAssociationV2,
  WorkOriginalOperationV2,
  WorkProfileRefV2,
} from "../lifecycle/work-authority-ports-v2.ts";
import type { RepositoryWorkNativeSessionSourceV2 } from "../runtime-authority/repository-work-origin-v2.ts";
import type {
  RepositoryWorkHeldLeaseV2,
  RepositoryWorkSelectedExecutionAdmissionSourceV2,
  RepositoryWorkSelectedExecutionDataV2,
  RepositoryWorkTransactionContextV2,
} from "./repository-work-v2.ts";

/** Comparison facts from the ORIGINAL native accepting owner. In particular the
 * original admission operation is explicitly selected before State looks for a
 * row. Missing rows, attachment strings and a copied start do not admit Work. */
export interface RepositoryWorkNativeSelectedExecutionDataV2 {
  readonly start: JournalExecutionStartV1;
  readonly execution: WorkExecutionAssociationV2;
  readonly runtime: RepositoryWorkSelectedExecutionDataV2["runtime"];
  readonly service: ServicePrincipal;
  readonly requesterPrincipalId: string;
  readonly admission: Readonly<{
    readonly original: WorkOriginalOperationV2;
    readonly membershipProfile: WorkProfileRefV2;
    readonly mode:
      | Readonly<{ kind: "admit-root" }>
      | Readonly<{ kind: "admit-child"; parentWorkRef: string }>
      | Readonly<{ kind: "existing"; workRef: string }>;
    readonly workBeganAt: string;
    readonly originalHorizon: string;
    readonly policyRef: string;
  }>;
  readonly attachmentRef: string;
  readonly dnsBindingRef: string;
  readonly upstreamIpv4: string;
  readonly validUntil: string;
}

/** State recognizes only its currently entered private prefix. Completion joins
 * use context.joinAccepted; recognition grants no raw SQL or extra authority. */
export interface RepositoryWorkSelectedExecutionNativeParticipantV2<N, E> {
  assertOriginal(
    context: RepositoryWorkTransactionContextV2,
    execution: E,
    session: N,
    call: AuthorityCallV1,
  ): undefined;
}

export interface RepositoryWorkNativeSelectedExecutionLeaseV2<E> {
  readonly original: E;
  /** Every call returns the SAME original admission operation object. */
  inspect(): RepositoryWorkNativeSelectedExecutionDataV2;
  assertCurrent(call: AuthorityCallV1): undefined;
  /** Joins only this borrow, never the whole execution or a future State write. */
  release(): Promise<void>;
}

/** Fixed original Runtime/native construction. It privately recognizes the
 * Session -> retained ready execution -> selected admission-operation chain.
 * Implementations must be paired at the actual known-start accepting boundary;
 * an implementation assembled from request DTOs or affirmative callbacks fails
 * this contract. Contract-faithful INTERNAL mocks may exercise component tests.
 * No fresh original actor, execution or observer is inferred by this port. */
export interface RepositoryWorkNativeSelectedExecutionSourceV2<N, E, V extends 2 | 3 = 2> {
  bindState(participant: RepositoryWorkSelectedExecutionNativeParticipantV2<N, E>): undefined;
  acquire(
    session: N,
    request: OpenRead<V>,
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkNativeSelectedExecutionLeaseV2<E> | undefined>;
  /** Capture cleanup before inspecting returned currentness. The lease enrolls
   * source/service/registry locks in THIS State context before parent locks.
   * It must not call back into selector Assignment currentness. */
  retain(
    context: RepositoryWorkTransactionContextV2,
    execution: E,
    session: N,
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkHeldLeaseV2>;
}

declare const selectedAdmission: unique symbol;
export type RepositoryWorkSelectedAdmissionV2<V extends 2 | 3 = 2> = {
  readonly [selectedAdmission]: (version: V) => V;
};
/** Deliberately the admission component, not a placeholder full selection source.
 * Later original use/observer/inventory components complete the receiving port. */
export type RepositoryWorkSelectedExecutionAdmissionCoreV2<N, V extends 2 | 3 = 2> = Pick<
  RepositoryWorkSelectedExecutionAdmissionSourceV2<N, RepositoryWorkSelectedAdmissionV2<V>, V>,
  "bindState" | "acquire" | "inspect" | "assertCurrent" | "release"
>;
export interface RepositoryWorkSelectedExecutionAdmissionConstructionV2<N, E, V extends 2 | 3 = 2> {
  readonly protocolVersion: V;
  readonly maximumAdmissions: number;
  readonly native: RepositoryWorkNativeSessionSourceV2<N, V>;
  readonly executions: RepositoryWorkNativeSelectedExecutionSourceV2<N, E, V>;
}

/** The next independently implemented component preserves the five admission
 * methods and adds only an original same-transaction use lease. Observer and
 * inventory enrollment remain separate original producers. */
export type RepositoryWorkSelectedExecutionUseCoreV2<
  N,
  V extends 2 | 3 = 2,
> = RepositoryWorkSelectedExecutionAdmissionCoreV2<N, V> &
  Pick<
    RepositoryWorkSelectedExecutionAdmissionSourceV2<N, RepositoryWorkSelectedAdmissionV2<V>, V>,
    "retainUse"
  >;
