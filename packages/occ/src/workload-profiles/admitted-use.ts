import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  decodeWorkloadProfileSelectionV1,
  decodeWorkloadProfileUseV2,
} from "@openclaw-enterprise/contracts/workload-profile-v1";
import { canonicalizeWorkloadProfileJson } from "./canonical.ts";
import { deriveAdmittedConfigurationV1 } from "./admitted-configuration.ts";
import { decodeWorkloadProfileAdmissionHeadV2 } from "./admission-record.ts";
import { deriveWorkloadProfileManifestV2 } from "./projections.ts";
import {
  WorkloadProfileSelectionError,
  decodeWorkloadProfileSelectionRequestV2,
  type WorkloadProfileCapabilitySourceV2,
} from "./selection.ts";
import type { AuthenticatedRequestHandleV1 } from "@openclaw-enterprise/contracts/account-authority-v1";
import type { AgentRevision } from "@openclaw-enterprise/contracts/resources/agent";
import type {
  WorkloadProfileScopeV2,
  WorkloadProfileSelectionV1,
  WorkloadProfileUseV2,
} from "@openclaw-enterprise/contracts/workload-profile-v1";
import type { PlatformReadView } from "../ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";
import type {
  GatewayStartupAcceptedOperationV1,
  GatewayStartupOwnerLeaseV1,
  GatewayStartupOwnerUnitV1,
  GatewayStartupOwnerUnitV2,
} from "../gateway-startup-v1/owner.ts";
import type {
  WorkloadProfileAccountLease,
  WorkloadProfileAccountUnit,
} from "../services/workload-profile/port.ts";
import type { AdmittedConfigurationProjectionV1 } from "./admitted-configuration.ts";
import type { WorkloadProfileAdmissionHeadV2 } from "./admission-record.ts";
import type {
  WorkloadProfileSelectionLeaseV2,
  WorkloadProfileSelectionRequestV2,
} from "./selection.ts";
import type { DerivedWorkloadProfileManifestV2 } from "./projections.ts";

/** Exact existing tracked IO protocol. Its shape does not enroll an owner. */
export type WorkloadProfileOwnedOperationV2 = GatewayStartupAcceptedOperationV1;
export type WorkloadProfileOwnedLeaseV2 = GatewayStartupOwnerLeaseV1;

/** Only the original Platform owner constructs and recognizes this unit. The
 * platform is the actual ambient transaction, never its selected repository view.
 * retain registers with that same owner's final fences/terminal cleanup. */
export interface WorkloadProfileDeploymentUnitV2 {
  readonly kind: "deployment";
  readonly installationId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly operationRef: string;
  readonly platform: PlatformUnitOfWork;
  readonly signal: AbortSignal;
  retain(lease: WorkloadProfileOwnedLeaseV2): undefined;
}
/** Read-only recovery never accepts an active head, prepares Use or mutates. */
export interface WorkloadProfileRecoveryUnitV2 {
  readonly kind: "deployment-recovery";
  readonly installationId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly operationRef: string;
  readonly read: PlatformReadView;
  readonly signal: AbortSignal;
  retain(lease: WorkloadProfileOwnedLeaseV2): undefined;
}
export interface WorkloadProfileDraftUnitV2 {
  readonly kind: "agent-selection";
  readonly installationId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly platform: PlatformUnitOfWork;
  readonly signal: AbortSignal;
  retain(lease: WorkloadProfileOwnedLeaseV2): undefined;
}
export interface WorkloadProfileDefinitionUnitV2 {
  readonly kind: "profile-definition";
  readonly installationId: string;
  readonly namespaceId: string;
  readonly operationRef: string;
  readonly account: WorkloadProfileAccountUnit;
  readonly signal: AbortSignal;
  retain(lease: WorkloadProfileOwnedLeaseV2): undefined;
}
export type WorkloadProfileSelectionUnitV2 =
  GatewayStartupOwnerUnitV1 | GatewayStartupOwnerUnitV2 | WorkloadProfileDeploymentUnitV2;

/** No revision, Use/H or physical create target exists at definition acceptance. */
export interface WorkloadProfileDefinitionRequestV2 {
  readonly scope: WorkloadProfileScopeV2;
  readonly selection: WorkloadProfileSelectionV1;
  readonly manifest: DerivedWorkloadProfileManifestV2;
}
export interface WorkloadProfileDefinitionSourceV2 {
  verifyDefinitionLocked(
    request: WorkloadProfileDefinitionRequestV2,
    unit: WorkloadProfileDefinitionUnitV2,
    io: WorkloadProfileOwnedOperationV2,
  ): Promise<WorkloadProfileOwnedLeaseV2>;
}

/** Partial Compute contribution. A renderer lease cannot replace the complete
 * original Runtime definition/configuration/module/identity/store sources. */
export interface WorkloadProfileRendererContributionV2 {
  verifyRendererDefinitionLocked(
    ...args: Parameters<WorkloadProfileDefinitionSourceV2["verifyDefinitionLocked"]>
  ): Promise<WorkloadProfileOwnedLeaseV2>;
  verifyRevisionRendererLocked(
    request: WorkloadProfileSelectionRequestV2,
    manifest: DerivedWorkloadProfileManifestV2["content"],
    use: WorkloadProfileUseV2,
    unit: WorkloadProfileSelectionUnitV2,
    io: WorkloadProfileOwnedOperationV2,
  ): Promise<WorkloadProfileOwnedLeaseV2>;
}

export interface WorkloadProfileSelectionValidationV2 {
  readonly installationId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly selection: WorkloadProfileSelectionV1;
}
/** Private captured reader. It recognizes actual owner/unit/io before reading;
 * the returned head must be held against withdrawal through terminal cleanup. */
export interface WorkloadProfileActiveReaderV2 {
  readLocked(
    request: WorkloadProfileSelectionValidationV2,
    unit: WorkloadProfileDeploymentUnitV2 | WorkloadProfileDraftUnitV2,
    io: WorkloadProfileOwnedOperationV2,
  ): Promise<WorkloadProfileOwnedLeaseV2 & { readonly head: WorkloadProfileAdmissionHeadV2 }>;
}
export interface WorkloadProfileCandidateSourceV2 {
  resolveLocked(
    request: WorkloadProfileSelectionRequestV2,
    candidate: Readonly<AgentRevision>,
    head: WorkloadProfileAdmissionHeadV2,
    unit: WorkloadProfileDeploymentUnitV2,
    io: WorkloadProfileOwnedOperationV2,
  ): Promise<
    WorkloadProfileOwnedLeaseV2 & {
      readonly projection: AdmittedConfigurationProjectionV1;
    }
  >;
}
export interface WorkloadProfilePreparedUseV2 extends WorkloadProfileOwnedLeaseV2 {
  readonly use: WorkloadProfileUseV2;
  /** Same captured request/unit; resolves the actual own inserted row. */
  verifyInserted(io: WorkloadProfileOwnedOperationV2): Promise<WorkloadProfileSelectionLeaseV2>;
}
export interface WorkloadProfileUseResolverV2 {
  validateSelectionLocked(
    request: WorkloadProfileSelectionValidationV2,
    unit: WorkloadProfileDeploymentUnitV2 | WorkloadProfileDraftUnitV2,
    io: WorkloadProfileOwnedOperationV2,
  ): Promise<WorkloadProfileOwnedLeaseV2>;
  prepareUseLocked(
    request: WorkloadProfileSelectionRequestV2,
    candidate: Readonly<AgentRevision>,
    unit: WorkloadProfileDeploymentUnitV2,
    io: WorkloadProfileOwnedOperationV2,
  ): Promise<WorkloadProfilePreparedUseV2>;
}

/** Opaque original request custody remains separate from active profile use.
 * The original central binder owns the actual command/actor verification and
 * transaction; these callbacks never open a unit or authorize by shape. */
/** Separate real account purposes over original immutable command operands.
 * The original auth owner validates exact request custody, actor/reference and
 * session/security state using this unit, then keeps currentness to terminal.
 * Recovery authorizes original retained disclosure without current profile use. */
export interface WorkloadProfileMutationAccountParticipantV2<DeploymentBinding, DraftBinding> {
  consume(
    invocation: AuthenticatedRequestHandleV1,
    request:
      | Readonly<{ purpose: "workload-profile-deployment"; binding: DeploymentBinding }>
      | Readonly<{ purpose: "workload-profile-draft-selection"; binding: DraftBinding }>
      | Readonly<{ purpose: "workload-profile-deployment-recovery"; binding: DeploymentBinding }>,
    unit: WorkloadProfileAccountUnit,
  ): Promise<WorkloadProfileAccountLease>;
}
export interface WorkloadProfileMutationEnrollmentV2<DeploymentBinding, DraftBinding> {
  withDeployment<T>(
    invocation: AuthenticatedRequestHandleV1,
    binding: DeploymentBinding,
    work: (
      unit: WorkloadProfileDeploymentUnitV2,
      io: WorkloadProfileOwnedOperationV2,
    ) => Promise<T>,
  ): Promise<T>;
  withRecovery<T>(
    invocation: AuthenticatedRequestHandleV1,
    binding: DeploymentBinding,
    work: (unit: WorkloadProfileRecoveryUnitV2, io: WorkloadProfileOwnedOperationV2) => Promise<T>,
  ): Promise<T>;
  withDraft<T>(
    invocation: AuthenticatedRequestHandleV1,
    binding: DraftBinding,
    work: (unit: WorkloadProfileDraftUnitV2, io: WorkloadProfileOwnedOperationV2) => Promise<T>,
  ): Promise<T>;
}

const text = new TextDecoder("utf-8", { fatal: true });
const bytes = new TextEncoder();
function unavailable(): never {
  throw new WorkloadProfileSelectionError("unavailable");
}
function mismatch(): never {
  throw new WorkloadProfileSelectionError("selection-mismatch");
}
function equalData(left: unknown, right: unknown): boolean {
  return (
    text.decode(canonicalizeWorkloadProfileJson(left, "operator-envelope")) ===
    text.decode(canonicalizeWorkloadProfileJson(right, "operator-envelope"))
  );
}

/** One bounded composite over actual producer leases; it cannot enroll an owner.
 * Invalid asynchronous assertions retain their work through original cleanup. */
function heldWork(io: WorkloadProfileOwnedOperationV2, unitCurrent: () => void) {
  const closes: (() => Promise<void>)[] = [];
  const checks: (() => unknown)[] = [];
  const pending = new Set<Promise<unknown>>();
  let closed = false,
    failed = false;
  let failure: unknown;
  let terminal: Promise<void> | undefined;
  function synchronous(work: () => unknown): void {
    const result = work();
    if (result === undefined) return;
    const task = Promise.resolve(result);
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    unavailable();
  }
  const assertCurrent = (): undefined => {
    if (closed) unavailable();
    if (failed) throw failure;
    try {
      synchronous(unitCurrent);
      for (const check of checks) synchronous(check);
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    }
    return undefined;
  };
  const acquiring = () => {
    synchronous(() => io.assertActive());
    assertCurrent();
  };
  const retain = <T extends WorkloadProfileOwnedLeaseV2>(lease: T): T => {
    const close = lease.release;
    if (typeof close !== "function") unavailable();
    closes.push(close.bind(lease));
    const check = lease.assertCurrent;
    if (typeof check !== "function") unavailable();
    checks.push(check.bind(lease));
    acquiring();
    return lease;
  };
  const release = (): Promise<void> => {
    if (terminal) return terminal;
    closed = true;
    // Publish before any producer cleanup callback can reenter this release.
    terminal = Promise.resolve().then(async () => {
      while (pending.size) await Promise.allSettled([...pending]);
      let closeFailed = false;
      let closeError: unknown;
      for (const close of closes.reverse()) {
        try {
          await close();
        } catch (error) {
          if (!closeFailed) {
            closeFailed = true;
            closeError = error;
          }
        }
      }
      if (closeFailed) throw closeError;
    });
    return terminal;
  };
  const reject = async (error: unknown): Promise<never> => {
    // Reporting failure cannot relinquish custody of already acquired work.
    try {
      io.poison(error);
    } catch {
      /* original failure remains primary */
    }
    try {
      await release();
    } catch (cleanupError) {
      try {
        io.poison(cleanupError);
      } catch {
        /* cleanup is already joined */
      }
    }
    throw error;
  };
  return { assertCurrent, acquiring, retain, release, reject };
}
function selectionRequest(
  input: WorkloadProfileSelectionValidationV2,
): WorkloadProfileSelectionValidationV2 {
  // The draft request has no revision; validate its own exact data grammar.
  const own = Reflect.ownKeys(input);
  if (
    own.length !== 4 ||
    !["installationId", "namespaceId", "agentId", "selection"].every((key) => own.includes(key))
  )
    mismatch();
  canonicalizeWorkloadProfileJson(input, "operator-envelope");
  const selected = decodeWorkloadProfileSelectionV1(input.selection);
  if (selected.kind !== "valid") mismatch();
  for (const value of [input.installationId, input.namespaceId, input.agentId])
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,254}$/.test(value))
      mismatch();
  return immutableCopy({ ...input, selection: selected.value });
}
function assertUnit(
  request: WorkloadProfileSelectionValidationV2,
  unit: WorkloadProfileDeploymentUnitV2 | WorkloadProfileDraftUnitV2,
): void {
  if (
    (unit.kind !== "deployment" && unit.kind !== "agent-selection") ||
    unit.signal.aborted ||
    unit.installationId !== request.installationId ||
    unit.namespaceId !== request.namespaceId ||
    unit.agentId !== request.agentId
  )
    unavailable();
}
function selectedHead(input: unknown, request: WorkloadProfileSelectionValidationV2) {
  const head = decodeWorkloadProfileAdmissionHeadV2(input);
  if (
    head.state !== "admitted" ||
    head.scope.installationId !== request.installationId ||
    head.scope.namespaceId !== request.namespaceId ||
    !equalData(head.selection, request.selection)
  )
    mismatch();
  return head;
}

/** Real first-INSERT orchestration. Every source defaults unavailable. The caller
 * owns each returned lease and must register it exactly once with original retain. */
export function createWorkloadProfileUseResolverV2(
  active?: WorkloadProfileActiveReaderV2,
  candidateSource?: WorkloadProfileCandidateSourceV2,
  capabilities?: WorkloadProfileCapabilitySourceV2,
  selector?: {
    resolveLocked(
      request: WorkloadProfileSelectionRequestV2,
      unit: WorkloadProfileSelectionUnitV2,
      io: WorkloadProfileOwnedOperationV2,
    ): Promise<WorkloadProfileSelectionLeaseV2>;
  },
): WorkloadProfileUseResolverV2 {
  const read = active?.readLocked?.bind(active);
  const resolve = candidateSource?.resolveLocked?.bind(candidateSource);
  const acquire = capabilities?.acquire?.bind(capabilities);
  const inserted = selector?.resolveLocked?.bind(selector);
  const resolver: WorkloadProfileUseResolverV2 = {
    async validateSelectionLocked(input, unit, io) {
      if (!read) unavailable();
      const request = selectionRequest(input);
      const held = heldWork(io, () => assertUnit(request, unit));
      try {
        held.acquiring();
        const original = held.retain(await read(request, unit, io));
        selectedHead(original.head, request);
        held.acquiring();
        return Object.freeze({ assertCurrent: held.assertCurrent, release: held.release });
      } catch (error) {
        return held.reject(error);
      }
    },
    async prepareUseLocked(input, candidate, unit, io) {
      if (!read || !resolve || !acquire || !inserted) unavailable();
      const request = decodeWorkloadProfileSelectionRequestV2(input);
      const originalCandidate = immutableCopy(candidate);
      const held = heldWork(io, () => {
        assertUnit(request, unit);
        if (unit.kind !== "deployment") unavailable();
      });
      try {
        held.acquiring();
        if (
          originalCandidate.id !== request.revisionId ||
          originalCandidate.agentId !== request.agentId ||
          originalCandidate.namespaceId !== request.namespaceId ||
          originalCandidate.configurationId !== request.configurationRef ||
          originalCandidate.configurationGeneration !== request.configurationVersion
        )
          mismatch();
        const headRequest = selectionRequest({
          installationId: request.installationId,
          namespaceId: request.namespaceId,
          agentId: request.agentId,
          selection: request.selection,
        });
        const source = held.retain(await read(headRequest, unit, io));
        const head = selectedHead(source.head, request);
        const derived = deriveWorkloadProfileManifestV2(bytes.encode(head.canonicalManifest));
        const candidateLease = held.retain(
          await resolve(request, originalCandidate, head, unit, io),
        );
        const projected = deriveAdmittedConfigurationV1(candidateLease.projection);
        const projection = projected.projection;
        const bindings = projection.resolvedProfileBindingParameters;
        if (
          projection.manifestDigest !== request.selection.manifestDigest ||
          projection.configurationRef !== originalCandidate.configurationId ||
          projection.configurationGeneration !== originalCandidate.configurationGeneration ||
          bindings.installationId !== request.installationId ||
          bindings.namespaceId !== request.namespaceId ||
          bindings.agentId !== request.agentId ||
          !equalData(bindings.roleBindings, head.profileRefs) ||
          !equalData(projection.immutableConfigurationContent, {
            kind: originalCandidate.configurationKind,
            values: originalCandidate.configuration,
            secretBindings: originalCandidate.secretBindings,
          }) ||
          !equalData(bindings.serviceAccountAssociation, {
            servicePrincipalId: originalCandidate.servicePrincipalId,
            serviceAccount: originalCandidate.serviceAccount,
          })
        )
          mismatch();
        const declaredStores = (["gateway", "harness"] as const).flatMap((component) =>
          derived.content.launchConfiguration[component].mounts.map((mount) => ({
            component,
            ...mount,
          })),
        );
        if (
          !equalData(
            [...bindings.storePolicyBindings].sort(
              (a, b) => a.component.localeCompare(b.component) || a.name.localeCompare(b.name),
            ),
            declaredStores.sort(
              (a, b) => a.component.localeCompare(b.component) || a.name.localeCompare(b.name),
            ),
          )
        )
          mismatch();
        const decoded = decodeWorkloadProfileUseV2({
          schemaVersion: 2,
          ...head.scope,
          ...head.selection,
          canonicalFormat: head.canonicalFormat,
          profileRefs: head.profileRefs,
          admittedConfigurationDigest: projected.admittedConfigurationDigest,
        });
        if (decoded.kind !== "valid") mismatch();
        const use = decoded.value;
        held.retain(await acquire(request, derived.content, use, unit, io));
        held.acquiring();
        let verified = false;
        return Object.freeze({
          use,
          assertCurrent: held.assertCurrent,
          release: held.release,
          async verifyInserted(nextIO: WorkloadProfileOwnedOperationV2) {
            if (verified) unavailable();
            verified = true;
            const verifying = heldWork(nextIO, () => {
              held.assertCurrent();
            });
            try {
              verifying.acquiring();
              const selected = verifying.retain(await inserted(request, unit, nextIO));
              if (!equalData(selected.use, use) || !equalData(selected.request, request))
                mismatch();
              verifying.acquiring();
              // Return a caller-owned wrapper; this helper never registers it twice.
              return Object.freeze({
                ...selected,
                assertCurrent: verifying.assertCurrent,
                release: verifying.release,
              });
            } catch (error) {
              return verifying.reject(error);
            }
          },
        });
      } catch (error) {
        return held.reject(error);
      }
    },
  };
  return Object.freeze(resolver);
}

export interface WorkloadProfileCompleteContributionV2
  extends WorkloadProfileDefinitionSourceV2, WorkloadProfileCapabilitySourceV2 {}
export interface WorkloadProfileCapabilityContributorsV2 {
  readonly renderer: WorkloadProfileRendererContributionV2;
  readonly runtime: WorkloadProfileCompleteContributionV2;
  readonly identity: WorkloadProfileCompleteContributionV2;
  readonly credentials: WorkloadProfileCompleteContributionV2;
  readonly storage: WorkloadProfileCompleteContributionV2;
}
/** Fixed original-owner aggregation. No caller capability-name registry or
 * partial renderer success grants the remaining native/material/store support. */
export function createWorkloadProfileCapabilityAggregatorV2(
  sources?: WorkloadProfileCapabilityContributorsV2,
): WorkloadProfileCompleteContributionV2 {
  const rendererDefinition = sources?.renderer?.verifyRendererDefinitionLocked?.bind(
    sources.renderer,
  );
  const rendererRevision = sources?.renderer?.verifyRevisionRendererLocked?.bind(sources.renderer);
  const definitions = sources
    ? [sources.runtime, sources.identity, sources.credentials, sources.storage].map((source) =>
        source?.verifyDefinitionLocked?.bind(source),
      )
    : [];
  const revisions = sources
    ? [sources.runtime, sources.identity, sources.credentials, sources.storage].map((source) =>
        source?.acquire?.bind(source),
      )
    : [];
  const aggregator: WorkloadProfileCompleteContributionV2 = {
    async verifyDefinitionLocked(request, unit, io) {
      if (!rendererDefinition || definitions.length !== 4 || definitions.some((source) => !source))
        unavailable();
      const held = heldWork(io, () => {
        if (
          unit.kind !== "profile-definition" ||
          unit.signal.aborted ||
          unit.installationId !== request.scope.installationId ||
          unit.namespaceId !== request.scope.namespaceId
        )
          unavailable();
      });
      try {
        held.acquiring();
        held.retain(await rendererDefinition(request, unit, io));
        for (const source of definitions) {
          if (!source) unavailable();
          held.retain(await source(request, unit, io));
        }
        held.acquiring();
        return Object.freeze({ assertCurrent: held.assertCurrent, release: held.release });
      } catch (error) {
        return held.reject(error);
      }
    },
    async acquire(request, manifest, use, unit, io) {
      if (!rendererRevision || revisions.length !== 4 || revisions.some((source) => !source))
        unavailable();
      const held = heldWork(io, () => {});
      try {
        held.acquiring();
        held.retain(await rendererRevision(request, manifest, use, unit, io));
        for (const source of revisions) {
          if (!source) unavailable();
          held.retain(await source(request, manifest, use, unit, io));
        }
        held.acquiring();
        return Object.freeze({ assertCurrent: held.assertCurrent, release: held.release });
      } catch (error) {
        return held.reject(error);
      }
    },
  };
  return Object.freeze(aggregator);
}

/** Candidate projection over the original held source inputs.
 * Reuses the existing lifetime and decoder implementation.
 * Required sources below are private original-owner receiving dependencies.
 * Their shape does not enroll a unit or prove that normalization occurred.
 */
type CandidateConfigurationInputsV2 = Pick<
  AdmittedConfigurationProjectionV1,
  "configurationRef" | "configurationGeneration" | "immutableConfigurationContent"
>;
type CandidateResolvedBindingsV2 = Pick<
  AdmittedConfigurationProjectionV1["resolvedProfileBindingParameters"],
  "serviceAccountAssociation" | "storePolicyBindings" | "roleBindings"
>;

/** Central's original per-operation slot is established BEFORE prepareUseLocked
 * by the trusted Deployment normalization continuation. readLocked recognizes
 * its exact private unit/token/IO and original request/candidate data; it performs
 * no new parent locks after the active admission head has been locked. A later
 * copied candidate is compared against the privately retained snapshot, not by
 * caller object identity. Normalization/selected-Driver guards are owner-held.
 */
export interface WorkloadProfileCandidateContextReaderV2 {
  readLocked(
    request: WorkloadProfileSelectionRequestV2,
    candidate: Readonly<AgentRevision>,
    unit: WorkloadProfileDeploymentUnitV2,
    io: WorkloadProfileOwnedOperationV2,
  ): Promise<
    WorkloadProfileOwnedLeaseV2 & {
      readonly configuration: CandidateConfigurationInputsV2;
    }
  >;
}

/** Pre-H original qualification, over real captured normalization/reference
 * records and actual immutable native/identity/credential/store definitions.
 * Neither expected manifest mounts nor head role references qualify themselves.
 * The source resolves the selected originals and retains every contributing
 * lease, including exact ServiceAccount backend-reference correspondence.
 * Native Configuration semantics are qualified here; the generic Configuration
 * Driver's JSON validation alone is insufficient. This source must recognize
 * the same genuine captured candidate context, not just these input values.
 */
export interface WorkloadProfileCandidateBindingsSourceV2 {
  resolveLocked(
    request: WorkloadProfileSelectionRequestV2,
    candidate: Readonly<AgentRevision>,
    manifest: DerivedWorkloadProfileManifestV2["content"],
    unit: WorkloadProfileDeploymentUnitV2,
    io: WorkloadProfileOwnedOperationV2,
  ): Promise<
    WorkloadProfileOwnedLeaseV2 & {
      readonly bindings: CandidateResolvedBindingsV2;
    }
  >;
}

/** Produces the existing projection from genuine held inputs. No INSERT, Use
 * minting, new authority token, definition registry, or unavailable substitute.
 * The existing prepareUseLocked performs its unchanged complete comparisons,
 * capability acquisition and subsequent same-row selector verification.
 */
export function createWorkloadProfileCandidateSourceV2(
  contexts: WorkloadProfileCandidateContextReaderV2,
  sources: WorkloadProfileCandidateBindingsSourceV2,
): WorkloadProfileCandidateSourceV2 {
  const read = contexts.readLocked.bind(contexts);
  const resolve = sources.resolveLocked.bind(sources);
  return Object.freeze({
    async resolveLocked(
      input: WorkloadProfileSelectionRequestV2,
      original: Readonly<AgentRevision>,
      inputHead: WorkloadProfileAdmissionHeadV2,
      unit: WorkloadProfileDeploymentUnitV2,
      io: WorkloadProfileOwnedOperationV2,
    ) {
      const request = decodeWorkloadProfileSelectionRequestV2(input);
      const held = heldWork(io, () => {
        assertUnit(request, unit);
        if (unit.kind !== "deployment") unavailable();
      });
      try {
        held.acquiring();
        const candidate = immutableCopy(original);
        const head = selectedHead(inputHead, request);
        if (
          candidate.id !== request.revisionId ||
          candidate.agentId !== request.agentId ||
          candidate.namespaceId !== request.namespaceId ||
          candidate.configurationKind !== "agent" ||
          candidate.configurationId !== request.configurationRef ||
          candidate.configurationGeneration !== request.configurationVersion ||
          candidate.serviceAccount === undefined ||
          candidate.secretBindings === undefined ||
          ("workloadProfileUse" in candidate && candidate.workloadProfileUse !== undefined)
        )
          mismatch();
        const manifest = deriveWorkloadProfileManifestV2(bytes.encode(head.canonicalManifest));
        // retain captures cleanup before reading any supplied result data.
        const captured = held.retain(await read(request, candidate, unit, io));
        const configuration = immutableCopy(captured.configuration);
        if (
          configuration.configurationRef !== request.configurationRef ||
          configuration.configurationGeneration !== request.configurationVersion ||
          !equalData(configuration.immutableConfigurationContent, {
            kind: candidate.configurationKind,
            values: candidate.configuration,
            secretBindings: candidate.secretBindings,
          })
        )
          mismatch();
        const qualified = held.retain(
          await resolve(request, candidate, manifest.content, unit, io),
        );
        const resolved = immutableCopy(qualified.bindings);
        const { projection } = deriveAdmittedConfigurationV1({
          manifestDigest: request.selection.manifestDigest,
          configurationRef: configuration.configurationRef,
          configurationGeneration: configuration.configurationGeneration,
          immutableConfigurationContent: configuration.immutableConfigurationContent,
          resolvedProfileBindingParameters: {
            installationId: request.installationId,
            namespaceId: request.namespaceId,
            agentId: request.agentId,
            serviceAccountAssociation: resolved.serviceAccountAssociation,
            storePolicyBindings: resolved.storePolicyBindings,
            roleBindings: resolved.roleBindings,
          },
        });
        const bindings = projection.resolvedProfileBindingParameters;
        if (
          !equalData(bindings.roleBindings, head.profileRefs) ||
          !equalData(bindings.serviceAccountAssociation, {
            servicePrincipalId: candidate.servicePrincipalId,
            serviceAccount: candidate.serviceAccount,
          })
        )
          mismatch();
        const declaredStores = (["gateway", "harness"] as const).flatMap((component) =>
          manifest.content.launchConfiguration[component].mounts.map((mount) => ({
            component,
            ...mount,
          })),
        );
        const compareStore = (
          a: CandidateResolvedBindingsV2["storePolicyBindings"][number],
          b: CandidateResolvedBindingsV2["storePolicyBindings"][number],
        ) => a.component.localeCompare(b.component) || a.name.localeCompare(b.name);
        if (
          !equalData(
            [...bindings.storePolicyBindings].sort(compareStore),
            declaredStores.sort(compareStore),
          )
        )
          mismatch();
        held.acquiring();
        return Object.freeze({
          projection,
          assertCurrent: held.assertCurrent,
          release: held.release,
        });
      } catch (error) {
        return held.reject(error);
      }
    },
  });
}
