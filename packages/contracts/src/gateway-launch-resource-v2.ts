import type {
  GatewayProcessCallV2,
  GatewayProcessCreateInputV2,
  GatewayStartupRecordRefV1,
} from "./gateway-startup-v1.ts";

/** Immutable resource expectations retained by the original accepting state.
 * These values, including the allocation reference, are not effect authority. */
export interface GatewayLaunchResourceAllocationV2 extends GatewayStartupRecordRefV1 {
  readonly effectRef: string;
  readonly original: GatewayProcessCreateInputV2;
  readonly target: {
    readonly clusterRef: string;
    readonly namespace: {
      readonly name: string;
      readonly uid: string;
      readonly resourceVersion: string;
    };
    readonly configMapName: string;
  };
  readonly canonicalDocument: string;
  readonly documentDigest: string;
}

export interface GatewayLaunchResourceObjectV2 {
  readonly allocation: GatewayLaunchResourceAllocationV2;
  readonly configMap: {
    readonly name: string;
    readonly uid: string;
    readonly resourceVersion: string;
  };
}

declare const createTicket: unique symbol;
export interface GatewayLaunchCreateTicketV2 {
  readonly [createTicket]: true;
}
declare const cleanupTicket: unique symbol;
export interface GatewayLaunchCleanupTicketV2 {
  readonly [cleanupTicket]: true;
}

/** The original call owner registers drain before evaluating authority or IO.
 * A failure before returning this scope remains owned by that original call.
 * Settlement closes the scope and joins retained work; it does not renew a call. */
export interface GatewayLaunchResourceScopeV2 {
  readonly signal: AbortSignal;
  recheckCurrent(): Promise<void>;
  assertCurrent(): undefined;
  settle(): Promise<void>;
}

export type GatewayLaunchResourceFailureV2 =
  | Readonly<{ kind: "denied" | "unavailable" }>
  | Readonly<{ kind: "unknown"; allocation: GatewayStartupRecordRefV1 }>;

export type GatewayLaunchResourceCreateOutcomeV2 =
  | Readonly<{ kind: "acknowledged"; configMap: GatewayLaunchResourceObjectV2["configMap"] }>
  | Readonly<{ kind: "unknown" }>;

/** Protected original-state ports, not a public allocation or authority factory.
 * Creation has its own durable effect and once-consumed SDK ticket. Neither an
 * accepted Deployment submission nor a matching ConfigMap creates these tickets.
 * Every callback authenticates the original method/call and exact retained input. */
export interface KubernetesGatewayLaunchResourceOwnerV2 {
  claimCreate(
    allocation: GatewayLaunchResourceAllocationV2,
    call: GatewayProcessCallV2,
    drain: () => Promise<void>,
  ): Promise<
    | GatewayLaunchResourceFailureV2
    | (GatewayLaunchResourceScopeV2 &
        Readonly<{ kind: "claimed"; ticket: GatewayLaunchCreateTicketV2 }>)
  >;
  consumeCreate(
    ticket: GatewayLaunchCreateTicketV2,
    allocation: GatewayLaunchResourceAllocationV2,
    call: GatewayProcessCallV2,
  ): undefined;
  /** Retain the original create outcome even after cancellation. A lost ACK or
   * uncertain retention cannot be promoted by readback, adopted, or retried. */
  retainCreate(
    ticket: GatewayLaunchCreateTicketV2,
    allocation: GatewayLaunchResourceAllocationV2,
    outcome: GatewayLaunchResourceCreateOutcomeV2,
  ): Promise<GatewayLaunchResourceObjectV2 | undefined>;
  readCurrent(
    original: GatewayLaunchResourceObjectV2,
    call: GatewayProcessCallV2,
    drain: () => Promise<void>,
  ): Promise<GatewayLaunchResourceScopeV2 | undefined>;
  claimCleanup(
    original: GatewayLaunchResourceObjectV2,
    call: GatewayProcessCallV2,
    drain: () => Promise<void>,
  ): Promise<
    | GatewayLaunchResourceFailureV2
    | (GatewayLaunchResourceScopeV2 &
        Readonly<{ kind: "claimed"; ticket: GatewayLaunchCleanupTicketV2 }>)
  >;
  consumeCleanup(
    ticket: GatewayLaunchCleanupTicketV2,
    original: GatewayLaunchResourceObjectV2,
    call: GatewayProcessCallV2,
  ): undefined;
  /** An acknowledged delete and later exact scoped absence are distinct
   * observations. A claimed cleanup may retain an initial exact scoped GET 404
   * without consuming a delete ticket; no mutation is invented for that read.
   * Neither observation establishes Deployment/process termination. */
  retainCleanup(
    ticket: GatewayLaunchCleanupTicketV2,
    original: GatewayLaunchResourceObjectV2,
    outcome: Readonly<{ kind: "acknowledged" | "unknown" | "absent" }>,
  ): Promise<void>;
}
