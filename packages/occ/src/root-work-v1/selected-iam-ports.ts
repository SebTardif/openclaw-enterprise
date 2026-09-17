/** Original-owner contracts for the selected native IAM effect participant.
 * Work owns Core and effect correspondence; State owns transactions and fences.
 */
import type {
  AuthorizationDecision,
  AuthorizationRequest,
  ResourceRef,
  RootWorkIdentityV1,
  RootWorkPolicyV1,
} from "@openclaw-enterprise/contracts";
import {
  evaluateAuthorization,
  type NativeIAMDriver,
  type NativeIAMState,
} from "@openclaw-enterprise/iam";
import type { PlatformUnitOfWork } from "../state/platform-state.ts";
import type { Bounds } from "../credential-gateway-v1/handles.ts";
import type { CredentialAccessGrant } from "../credential-gateway-v1/connection.ts";
import type { DefinitionRef, RetainedSchemaValue } from "../credential-gateway-v1/schema.ts";
import type { AuthorityBinding, SelectedIamAdmissionOwner } from "./ports.ts";
import type {
  RootCoreRecognitionV1,
  RootDeploymentPolicyOwnerV1,
  RootEffectCorrespondenceOwnerV1,
  RootEffectLocatorV1,
  RetainedRootRecordV1,
} from "./dependencies.ts";

/** Aliases only: one original Core brand, one recognizer, one effect record owner. */
export type OriginalCoreRecognitionV1 = RootCoreRecognitionV1;
export type OriginalRootEffectV1 = NonNullable<
  Awaited<ReturnType<RootEffectCorrespondenceOwnerV1["readIn"]>>
>;
export type InitialDeploymentPolicyOwnerV1 = RootDeploymentPolicyOwnerV1;
export type NativeSelectionV1 = RootWorkIdentityV1["selectedIam"];

/** Independently resolved policy/grant/profile facts, never echoed candidate DATA. */
export interface NativeExternalEntitlementV1 {
  readonly kind: "external-service-entitlement";
  readonly servicePrincipalId: string;
  readonly servicePolicyId: string;
  readonly servicePolicyVersion: string;
  readonly policyVersion: string;
  readonly immutableCeilingDigest: string;
  readonly grant: Readonly<CredentialAccessGrant>;
  readonly callerServiceId: string;
  readonly serviceId: string;
  readonly audienceRef: string;
  readonly exactAction: string;
  readonly canonicalResource: string;
  readonly eligibleDataDomains: readonly string[];
  readonly requiredDataDomains: readonly string[];
  readonly aggregateCharges: readonly { readonly name: string; readonly amount: number }[];
  /** Exact original registered supported mode determines whether zero sources is legal. */
  readonly protectedSourceMode: "source-free" | "protected-secrets";
  readonly protectedSourceRefs: readonly Readonly<{
    kind: "secret";
    id: string;
    namespaceId: string;
  }>[];
  readonly validUntil: number;
}
export interface NativeCancellationEntitlementV1 {
  readonly kind: "root-cancellation-entitlement";
  /** Business action only. Never pass this string to the native evaluator. */
  readonly action: "work.cancel";
  readonly rootWorkId: string;
  readonly authorizationId: string;
  readonly authorizedPrincipalId: string;
  readonly dependencyIds: readonly string[];
  readonly validUntil: number;
}
export type NativeEntitlementV1 = NativeExternalEntitlementV1 | NativeCancellationEntitlementV1;

interface NativeRootIamSnapshotBaseV1 {
  readonly installationId: string;
  readonly policyEpoch: string;
  readonly selectedIam: NativeSelectionV1;
  readonly nativePolicy: NativeIAMState;
  /** Current original State record, including open/closed and closureVersion. */
  readonly root: Readonly<RetainedRootRecordV1>;
}
/** Cancellation remains available through its independent authorization even when
 * service entitlement is withdrawn. Immutable root.fullPolicy exists in both lanes.
 */
export type NativeRootIamSnapshotV1 = NativeRootIamSnapshotBaseV1 &
  (
    | {
        readonly kind: "external";
        /** Full current service entitlement; may narrow immutable root.fullPolicy. */
        readonly currentServicePolicy: RootWorkPolicyV1;
        readonly entitlement: NativeExternalEntitlementV1;
      }
    | {
        readonly kind: "root-cancel";
        readonly currentServicePolicy: null;
        readonly entitlement: NativeCancellationEntitlementV1;
      }
  );

/** State-owned closure valid only inside this one enrolled consume callback.
 * lockSnapshot acquires the Installation policy/selection fence FIRST and returns
 * post-wait current facts. Subsequent Work effect readIn uses the SAME authentic
 * UoW. The scope is not a public authority handle or a new transaction manager.
 */
export interface NativeRootIamAdmissionScopeV1 {
  lockSnapshot(
    locator: RootEffectLocatorV1,
    bounds: Bounds,
  ): Promise<Readonly<NativeRootIamSnapshotV1>>;
}

/** The original State owner implements this port; no implementation exists here.
 *
 * Preparation owns one authentic original State transaction. Its callback receives
 * that UoW so effects.readIn(uow, locator, bounds) can independently read originals.
 * No candidate binding is passed to State as authoritative evidence. State resolves
 * root, service/cancellation entitlement and policy solely from retained records.
 * Cancellation originals authenticate the actual ingress canceller; a string in
 * candidate.requester, owner metadata or abort is never authentication.
 *
 * Consume synchronously recognizes originalUow and enrolls the WHOLE callback in
 * its original RepositoryTransactionLifetime AND RuntimeAuthorityTransactionGuard
 * before returning its Promise or first awaiting. It invokes consume synchronously
 * after enrollment so evidence is spent before consumeIn first yields. Callback
 * invocation, evidence
 * recognition/spending, boundsFor, Core recognition, all snapshot/effect reads,
 * every comparison/evaluator check and post-await expiry/abort checks are enrolled.
 * Every failure poisons outer COMMIT even when the caller catches or never awaits
 * it. A failed callback must reject; an internal catch cannot turn denial into success.
 * The fence remains held through original outer commit/rollback/unknown outcome.
 *
 * Original guard.run serializes a queue: wrapping the callback in run while a
 * nested owner awaits another run DEADLOCKS. The original State owner must extend that same guard
 * with tracked NONSERIAL participant enrollment and sticky failure/drain, while
 * preserving run's existing mutation serialization. Do not create a second guard,
 * expose a client, or enqueue participant completion behind an awaited child.
 * Close external registrations before drain; owner-authenticated already-enrolled
 * operations may complete their internal reads during drain. Foreign/closed UoW,
 * late registration and escaped scope deny. Scope lock failures poison even when
 * caught inside consume. No new top-level enrollment is accepted from drain work.
 * Provider tests must prove this lifecycle; these signatures alone cannot.
 */
export interface NativeRootIamStateOwnerV1 {
  withPreparationSnapshot<T>(
    locator: RootEffectLocatorV1,
    bounds: Bounds,
    use: (
      originalUow: PlatformUnitOfWork,
      snapshot: Readonly<NativeRootIamSnapshotV1>,
    ) => Promise<T>,
  ): Promise<T>;
  retainAdmissionFenceIn<T>(
    originalUow: PlatformUnitOfWork,
    consume: (scope: NativeRootIamAdmissionScopeV1) => Promise<T>,
  ): Promise<T>;
}

/** Internal original-owner DATA projection; backend semantics remain with the owner. */
export interface RegisteredGrantOperationProjectionV1 {
  readonly grantId: string;
  readonly connectionId: string;
  readonly connectionGeneration: string;
  readonly definition: DefinitionRef;
  readonly originalOperations: RetainedSchemaValue;
  readonly originalProfile: CredentialAccessGrant["credentialProfile"];
  readonly permitted: readonly Readonly<{
    serviceId: string;
    exactAction: string;
    canonicalResource: string;
    profileSelectionDigest: string;
  }>[];
}
export interface OriginalGrantOperationProjectionOwnerV1 {
  projectRegisteredGrant(
    grant: Readonly<CredentialAccessGrant>,
  ): Readonly<RegisteredGrantOperationProjectionV1>;
}

export interface NativeRootIamAdmissionDependenciesV1 {
  readonly selectedNativeDriver: NativeIAMDriver;
  readonly selection: NativeSelectionV1;
  readonly core: OriginalCoreRecognitionV1;
  readonly state: NativeRootIamStateOwnerV1;
  readonly effects: RootEffectCorrespondenceOwnerV1;
  readonly grantOperations: OriginalGrantOperationProjectionOwnerV1;
  readonly now: () => number;
  readonly maximumPrepareMs: number;
  readonly maximumEvidenceLifetimeMs: number;
  readonly maximumActiveEvidence: number;
  readonly adoptedEnvelope: "native-root-iam-envelope-v1";
}
/** The component body is defined in selected-iam.ts. */
export declare function createNativeRootIamAdmissionV1(
  dependencies: NativeRootIamAdmissionDependenciesV1,
): SelectedIamAdmissionOwner;

/** Selected native envelope mapping. This returns only necessary native requests.
 * It does NOT authorize backend use/cancellation, authenticate Core or spend evidence.
 * The component must first compare candidate to original Work effect and entitlement.
 */
export function proposedNativeEnvelopeV1(
  binding: AuthorityBinding,
  entitlement: NativeEntitlementV1,
): readonly AuthorizationRequest[] {
  const resource: ResourceRef = {
    kind: "agent",
    id: binding.root.agentId,
    namespaceId: binding.root.namespaceId,
  };
  if (binding.effect === "root-cancel") {
    if (entitlement.kind !== "root-cancellation-entitlement")
      throw new TypeError("Mismatched IAM entitlement family.");
    return [{ principalId: binding.requester.principalId, action: "operate", resource }];
  }
  if (entitlement.kind !== "external-service-entitlement")
    throw new TypeError("Mismatched IAM entitlement family.");
  if (
    entitlement.protectedSourceMode !== "source-free" &&
    entitlement.protectedSourceMode !== "protected-secrets"
  )
    throw new TypeError("Unsupported original protected source mode.");
  if (
    (entitlement.protectedSourceMode === "source-free" &&
      entitlement.protectedSourceRefs.length !== 0) ||
    (entitlement.protectedSourceMode === "protected-secrets" &&
      entitlement.protectedSourceRefs.length === 0)
  )
    throw new TypeError("Mismatched original protected source mode.");
  const checks: AuthorizationRequest[] = [
    {
      principalId: binding.root.servicePrincipalId,
      action: "operate",
      resource,
    },
  ];
  // Every original required protected source participates, for every external family.
  for (const source of entitlement.protectedSourceRefs) {
    if (source.namespaceId !== binding.root.namespaceId)
      throw new TypeError("Protected source is outside the ROOT Namespace.");
    checks.push({
      principalId: binding.root.servicePrincipalId,
      action: "operate",
      resource: source,
    });
  }
  return checks;
}
/** Genuine current native evaluator. All decisions AND independent entitlement must pass. */
export function evaluateProposedEnvelopeV1(
  binding: AuthorityBinding,
  snapshot: Readonly<NativeRootIamSnapshotV1>,
): readonly AuthorizationDecision[] {
  return proposedNativeEnvelopeV1(binding, snapshot.entitlement).map((request) =>
    evaluateAuthorization(request, snapshot.nativePolicy, snapshot.selectedIam.driverId),
  );
}

/** Mandatory consumer correspondence:
 * - core.recognize(binding.authentication) returns identity/fullPolicy/closureVersion.
 *   Compare the entire identity and full immutable policy to snapshot.root, including
 *   original cancellation, duration and all ceilings; require current open record and
 *   exact closureVersion. Missing, copied, proxied, foreign or expired Core denies.
 * - bounds = effects.boundsFor(binding), never core.bounds. Require original signal,
 *   finite deadline; caller prepare deadline may ONLY shorten it. Intersect request,
 *   authority, finite-root, entitlement, selection and configured evidence deadlines.
 *   After every await recheck original signal/clock/currentness before issuing or using.
 * - Build exact RootEffectLocatorV1 from validated original keys and call readIn in
 *   preparation AND consumption under the matching original State fence. Missing or
 *   closed result denies. Compare every field of original.binding to candidate except
 *   authentication, which only Work recognizes. Keep discriminants and original PR
 *   claim object identity; deep-detach DATA without cloning opaque handles.
 * - Compare originalBundle with connection.definition using current recipeId,
 *   recipeVersion, recipeDigest and interpreter. Root cancellation has no bundle;
 *   external effects require the original admitted DefinitionRef, never legacy package IDs.
 * - Compare original capacity[].limitName/currentUnits/requestedUnits with exact
 *   immutable/current aggregateLimits[].name/maximum and entitlement
 *   aggregateCharges[].name/amount. All numbers finite nonnegative; names unique;
 *   no absent-limit/charge fallback, overflow or double reservation. Capacity/claim
 *   reservation transition stays original broker/State, never native allow.
 * - External: exact action/resource in BOTH immutable and current scopeCeiling;
 *   full service policy IDs/versions/digest, service principal owning Agent/Namespace,
 *   grant, target, profile/schema, caller/service/audience and required/eligible domains
 *   match independent originals. Current policy only narrows; all native checks pass.
 * - Cancellation: original authenticated requester equals current authorizedPrincipalId;
 *   exact rootWorkId, authorizationId and dependencyIds match original root/fullPolicy
 *   and current admitted cancellation facts. Generic operate alone never suffices.
 * - Evidence is exact-owner, bounded, one-use; claim/spend synchronously before its
 *   first await inside the enrolled callback. Any rejection/abort/rollback/unknown
 *   commit leaves it spent. No restored handle or resubmission after uncertainty.
 * - Initial deployment is the unchanged Work alias: prepare(request),
 *   lockSelectionIn(uow, installationId, bounds), consumePreparedIn(uow, evidence,
 *   authenticatedInvocation, lockedAgent, expectedFullPolicy, bounds), and
 *   checkRetainedIn(uow, identity, fullPolicy, bounds). No Core/effect operand.
 *   Keep actual requester deployAgent and separate locked-Agent service policy.
 */
