import type { AuthorityCallV1 } from "./runtime-authority-v1.ts";

/** Local types never authenticate a caller. Only their original private owner can enroll them. */
declare const recipientBrand: unique symbol;
declare const startupBrand: unique symbol;
declare const processCallBrand: unique symbol;
export interface GatewayStartupRecipientV1 {
  readonly [recipientBrand]: true;
}
export interface GatewayStartupHandleV1 {
  readonly [startupBrand]: true;
}
export interface GatewayProcessCallV1 {
  readonly [processCallBrand]: true;
  /** Preserve original context, request, recipient and deadline; no existing purpose is widened. */
  readonly authorityCall: AuthorityCallV1;
}

export type GatewayStartupRecordRefV1 = Readonly<{ recordRef: string; recordVersion: number }>;
export type GatewayStartupOperationLocatorV1 = Readonly<{
  installationId: string;
  processRef: string;
  processGeneration: number;
  operationRef: string;
  operationDigest: string;
}>;
export type GatewayStartupModuleSelectionV1 = Readonly<{
  id: string;
  kind: "identity" | "channel" | "harness" | "persistence";
  profileRef: string;
  requiredCapabilities: readonly string[];
}>;
/** Nonsecret original association. Configuration bytes, paths and capabilities stay with their owners. */
export type GatewayStartupBindingV1 = Readonly<{
  startup: GatewayStartupOperationLocatorV1;
  createEffectRef: string;
  selection: GatewayStartupRecordRefV1;
  configurationRef: string;
  configurationVersion: number;
  profileRef: string;
  profileVersion: number;
  namespaceRef: string;
  agentRef: string;
  admittedRevisionRef: string;
  gatewayAssignmentRef: string;
  hostRuntimeGeneration: number;
  nativeConfigRef: string;
  configDigest: string;
  stateOwnership: GatewayStartupRecordRefV1;
  stateSchemaVersion: number;
  agentSchemaVersion: number;
  protocolVersion: number;
  modules: readonly GatewayStartupModuleSelectionV1[];
  startupDeadlineMs: number;
  shutdownDeadlineMs: number;
}>;
export type GatewayStartupCloseV1 = Readonly<{
  cleanup: "finished" | "failed" | "unknown";
  termination: "unknown";
}>;
export interface GatewayStartupLifetimeV1 {
  readonly signal: AbortSignal;
  readonly closed: Promise<GatewayStartupCloseV1>;
  recheckCurrent(): Promise<void>;
  assertCurrent(): undefined;
  close(): Promise<GatewayStartupCloseV1>;
}
export type GatewayStartupStartResultV1 =
  | Readonly<{ kind: "started"; lifetime: GatewayStartupLifetimeV1 }>
  | Readonly<{ kind: "denied" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "recovery-required"; operation: GatewayStartupOperationLocatorV1 }>;
export interface GatewayStartupUsePortV1 {
  /** Non-started results join every invocation-owned local cleanup and late settlement. */
  start(
    recipient: GatewayStartupRecipientV1,
    startup: GatewayStartupHandleV1,
  ): Promise<GatewayStartupStartResultV1>;
}
export type GatewayStartupEnrollmentV1 = Readonly<{
  usePort: GatewayStartupUsePortV1;
  recipient: GatewayStartupRecipientV1;
  startup: GatewayStartupHandleV1;
}>;

/** These identities describe provider evidence, never a physical termination permit. */
export type GatewayProcessObjectIdentityV1 = Readonly<{
  name: string;
  uid: string;
  resourceVersion: string;
}>;
/** Corresponds to the existing Kubernetes UID-chain value shape without importing Controller or Agent authority. */
export type GatewayProcessUidChainV1 = Readonly<{
  namespace: GatewayProcessObjectIdentityV1;
  deployment: GatewayProcessObjectIdentityV1;
  replicaSet: GatewayProcessObjectIdentityV1;
  pod: GatewayProcessObjectIdentityV1 &
    Readonly<{
      nodeName: string;
      runtimeClassName: string | null;
      containers: readonly Readonly<{
        kind: "init" | "main";
        name: string;
        containerId: string;
        imageId: string;
        restartCount: number;
        startedAt: string | null;
      }>[];
    }>;
}>;
export type GatewayProcessTargetV1 = Readonly<{
  clusterRef: string;
  namespace: GatewayProcessObjectIdentityV1;
  deploymentName: string;
}>;
export type GatewayProcessCreateInputV1 = Readonly<{
  binding: GatewayStartupBindingV1;
  target: GatewayProcessTargetV1;
  launchPlan: GatewayStartupRecordRefV1;
}>;
export type GatewayProcessObjectV1 = Readonly<{
  binding: GatewayStartupBindingV1;
  target: GatewayProcessTargetV1;
  deployment: GatewayProcessObjectIdentityV1;
  controllerGeneration: number;
  correlation: GatewayStartupRecordRefV1;
}>;
export type GatewayProcessObservationInputV1 = Readonly<{ original: GatewayProcessObjectV1 }>;
export type GatewayProcessRetirementInputV1 = Readonly<{
  original: GatewayProcessObjectV1;
  responsibility: GatewayStartupRecordRefV1;
}>;
export type GatewayProcessFailureV1 =
  | Readonly<{ kind: "denied" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "unknown"; operation: GatewayStartupOperationLocatorV1 }>;
export type GatewayProcessCreateResultV1 =
  GatewayProcessFailureV1 | Readonly<{ kind: "accepted-object"; original: GatewayProcessObjectV1 }>;
export type GatewayProcessDiscoveryResultV1 =
  | GatewayProcessFailureV1
  | Readonly<{ kind: "found"; original: GatewayProcessObjectV1 }>
  | Readonly<{ kind: "absent"; operation: GatewayStartupOperationLocatorV1 }>
  | Readonly<{ kind: "ambiguous"; operation: GatewayStartupOperationLocatorV1 }>;
export type GatewayProcessObservationResultV1 =
  | GatewayProcessFailureV1
  | Readonly<{
      kind: "observed";
      original: GatewayProcessObjectV1;
      chain: GatewayProcessUidChainV1;
      evidence: GatewayStartupRecordRefV1;
      observedAt: string;
    }>
  | Readonly<{
      kind: "absent";
      original: GatewayProcessObjectV1;
      evidence: GatewayStartupRecordRefV1;
      observedAt: string;
    }>
  | Readonly<{ kind: "ambiguous"; original: GatewayProcessObjectV1 }>;
export type GatewayProcessRetirementResultV1 =
  | GatewayProcessFailureV1
  | Readonly<{
      kind: "requested";
      original: GatewayProcessObjectV1;
      responsibility: GatewayStartupRecordRefV1;
      termination: "unknown";
    }>;
export type GatewayProcessRecoveryResultV1 = GatewayProcessDiscoveryResultV1;
export type GatewayProcessDispositionResultV1 =
  | GatewayProcessFailureV1
  | Readonly<{
      kind: "verified-disposition";
      operation: GatewayStartupOperationLocatorV1;
      disposition: "complete-initial" | "retired";
      receipt: GatewayStartupRecordRefV1;
    }>;

/** Each accepting boundary verifies original call/method/full input and current ownership before I/O. */
export interface GatewayProcessParticipantV1 {
  createOriginal(
    input: GatewayProcessCreateInputV1,
    call: GatewayProcessCallV1,
  ): Promise<GatewayProcessCreateResultV1>;
  discoverOriginal(
    locator: GatewayStartupOperationLocatorV1,
    call: GatewayProcessCallV1,
  ): Promise<GatewayProcessDiscoveryResultV1>;
  observeExact(
    input: GatewayProcessObservationInputV1,
    call: GatewayProcessCallV1,
  ): Promise<GatewayProcessObservationResultV1>;
  requestRetirement(
    input: GatewayProcessRetirementInputV1,
    call: GatewayProcessCallV1,
  ): Promise<GatewayProcessRetirementResultV1>;
  recoverOriginal(
    locator: GatewayStartupOperationLocatorV1,
    call: GatewayProcessCallV1,
  ): Promise<GatewayProcessRecoveryResultV1>;
  readReplacementDisposition(
    locator: GatewayStartupOperationLocatorV1,
    call: GatewayProcessCallV1,
  ): Promise<GatewayProcessDispositionResultV1>;
}

/**
 * The original record owner grants a one-use submission claim atomically before
 * provider dispatch. Retained intent or readback cannot supply this capability.
 * Runtime checks the opaque original ticket separately from the local host claim.
 */
declare const submissionBrand: unique symbol;
export interface GatewayProcessSubmissionV1 {
  readonly [submissionBrand]: true;
}
export type GatewayProcessSubmissionResultV1 =
  GatewayProcessFailureV1 | Readonly<{ kind: "claimed"; submission: GatewayProcessSubmissionV1 }>;
export interface GatewayProcessSubmissionOwnerV1 {
  claimOriginal(
    input: GatewayProcessCreateInputV1,
    call: GatewayProcessCallV1,
  ): Promise<GatewayProcessSubmissionResultV1>;
  /** Synchronous exact private-ticket consumption at the actual provider boundary. */
  consumeSubmission(
    submission: GatewayProcessSubmissionV1,
    input: GatewayProcessCreateInputV1,
    call: GatewayProcessCallV1,
  ): undefined;
}
