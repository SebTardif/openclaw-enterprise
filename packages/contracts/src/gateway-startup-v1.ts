import type { AuthorityCallV1 } from "./runtime-authority-v1.ts";
import type { WorkloadProfileRolesV1, WorkloadProfileSelectionV1 } from "./workload-profile-v1.ts";

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

/** Versioned Agent Gateway subject. Namespace is immutable membership; the
 * retained head key is Installation + Agent. Installation services remain
 * independently owned subjects and cannot be represented by a synthetic Agent. */
export type GatewayStartupSubjectV2 = Readonly<{
  kind: "agent-gateway";
  installationId: string;
  namespaceRef: string;
  agentRef: string;
}>;
export type GatewayStartupOperationLocatorV2 = Readonly<{
  schemaVersion: 2;
  subject: GatewayStartupSubjectV2;
  processRef: string;
  processGeneration: number;
  operationRef: string;
  operationDigest: string;
}>;
/** Original four-field selection and role/configuration association. Legacy host
 * profile operands remain separately resolved by the original module/role owner;
 * manifest/admission identities cannot be copied into those operands. Native
 * configDigest, admittedConfigurationDigest and hostRuntimeGeneration remain
 * distinct from one another and from this subject's process generation. */
export type GatewayStartupBindingV2 = Readonly<
  Omit<GatewayStartupBindingV1, "startup" | "selection"> & {
    schemaVersion: 2;
    startup: GatewayStartupOperationLocatorV2;
    selection: WorkloadProfileSelectionV1;
    profileRefs: WorkloadProfileRolesV1;
    admittedConfigurationDigest: string;
  }
>;
export type GatewayProcessCreateInputV2 = Readonly<{
  binding: GatewayStartupBindingV2;
  target: GatewayProcessTargetV1;
  launchPlan: GatewayStartupRecordRefV1;
}>;
export type GatewayProcessObjectV2 = Readonly<
  Omit<GatewayProcessObjectV1, "binding"> & { binding: GatewayStartupBindingV2 }
>;
export type GatewayProcessObservationInputV2 = Readonly<{ original: GatewayProcessObjectV2 }>;
export type GatewayProcessRetirementInputV2 = Readonly<{
  original: GatewayProcessObjectV2;
  responsibility: GatewayStartupRecordRefV1;
}>;
/** The accepting owner must enroll the exact V2 call, component, complete input
 * and current authority. A V1 call or a structural subject is not enrollment. */
declare const processCallV2Brand: unique symbol;
export interface GatewayProcessCallV2 {
  readonly [processCallV2Brand]: true;
  readonly authorityCall: AuthorityCallV1;
}
export type GatewayProcessFailureV2 =
  | Readonly<{ kind: "denied" | "unavailable" }>
  | Readonly<{ kind: "unknown"; operation: GatewayStartupOperationLocatorV2 }>;
export type GatewayProcessCreateResultV2 =
  GatewayProcessFailureV2 | Readonly<{ kind: "accepted-object"; original: GatewayProcessObjectV2 }>;
export type GatewayProcessDiscoveryResultV2 =
  | GatewayProcessFailureV2
  | Readonly<{ kind: "found"; original: GatewayProcessObjectV2 }>
  | Readonly<{ kind: "absent" | "ambiguous"; operation: GatewayStartupOperationLocatorV2 }>;
export type GatewayProcessObservationResultV2 =
  | GatewayProcessFailureV2
  | Readonly<{
      kind: "observed";
      original: GatewayProcessObjectV2;
      chain: GatewayProcessUidChainV1;
      evidence: GatewayStartupRecordRefV1;
      observedAt: string;
    }>
  | Readonly<{
      kind: "absent";
      original: GatewayProcessObjectV2;
      evidence: GatewayStartupRecordRefV1;
      observedAt: string;
    }>
  | Readonly<{ kind: "ambiguous"; original: GatewayProcessObjectV2 }>;
export type GatewayProcessRetirementResultV2 =
  | GatewayProcessFailureV2
  | Readonly<{
      kind: "requested";
      original: GatewayProcessObjectV2;
      responsibility: GatewayStartupRecordRefV1;
      termination: "unknown";
    }>;
export type GatewayProcessRecoveryResultV2 = GatewayProcessDiscoveryResultV2;
export type GatewayProcessDispositionResultV2 =
  | GatewayProcessFailureV2
  | Readonly<{
      kind: "verified-disposition";
      operation: GatewayStartupOperationLocatorV2;
      disposition: "complete-initial" | "retired";
      receipt: GatewayStartupRecordRefV1;
    }>;
export interface GatewayProcessParticipantV2 {
  createOriginal(
    input: GatewayProcessCreateInputV2,
    call: GatewayProcessCallV2,
  ): Promise<GatewayProcessCreateResultV2>;
  discoverOriginal(
    locator: GatewayStartupOperationLocatorV2,
    call: GatewayProcessCallV2,
  ): Promise<GatewayProcessDiscoveryResultV2>;
  observeExact(
    input: GatewayProcessObservationInputV2,
    call: GatewayProcessCallV2,
  ): Promise<GatewayProcessObservationResultV2>;
  requestRetirement(
    input: GatewayProcessRetirementInputV2,
    call: GatewayProcessCallV2,
  ): Promise<GatewayProcessRetirementResultV2>;
  recoverOriginal(
    locator: GatewayStartupOperationLocatorV2,
    call: GatewayProcessCallV2,
  ): Promise<GatewayProcessRecoveryResultV2>;
  readReplacementDisposition(
    locator: GatewayStartupOperationLocatorV2,
    call: GatewayProcessCallV2,
  ): Promise<GatewayProcessDispositionResultV2>;
}
declare const submissionV2Brand: unique symbol;
export interface GatewayProcessSubmissionV2 {
  readonly [submissionV2Brand]: true;
}
export type GatewayProcessSubmissionResultV2 =
  GatewayProcessFailureV2 | Readonly<{ kind: "claimed"; submission: GatewayProcessSubmissionV2 }>;
export interface GatewayProcessSubmissionOwnerV2 {
  claimOriginal(
    input: GatewayProcessCreateInputV2,
    call: GatewayProcessCallV2,
  ): Promise<GatewayProcessSubmissionResultV2>;
  consumeSubmission(
    submission: GatewayProcessSubmissionV2,
    input: GatewayProcessCreateInputV2,
    call: GatewayProcessCallV2,
  ): undefined;
}
