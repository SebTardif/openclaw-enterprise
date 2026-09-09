import { isDeepStrictEqual } from "node:util";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type { ComputeDriver, WorkloadLaunchContext } from "@openclaw-enterprise/contracts";
import type {
  GatewayStartupAcceptedOperationV1,
  GatewayStartupOwnerLeaseV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/owner";
import { WorkloadProfileSelectionError } from "@openclaw-enterprise/occ/workload-profiles/selection";
import type {
  WorkloadProfileRendererContributionV2,
  WorkloadProfileDefinitionRequestV2,
} from "@openclaw-enterprise/occ/workload-profiles/admitted-use";
import { deriveWorkloadProfileManifestV2 } from "@openclaw-enterprise/occ/workload-profiles/projections";
import { admittedGatewayDeployment, fixedAdmittedGatewayTemplate } from "./resources/gateway.ts";
import {
  normalizeKubernetesResourcePlan,
  assertKubernetesResourceComparison,
  assertKubernetesConfiguredQuota,
  type KubernetesResourceContributionMap,
} from "./resources/revision-resource-plan.ts";
import type {
  FixedWorkloadDefinition,
  FixedWorkloadRenderer,
} from "./resources/fixed-workload-renderer.ts";

type RevisionArguments = Parameters<
  WorkloadProfileRendererContributionV2["verifyRevisionRendererLocked"]
>;
type DefinitionArguments = Parameters<
  WorkloadProfileRendererContributionV2["verifyRendererDefinitionLocked"]
>;
type Manifest = RevisionArguments[1];

/** These are installed functions, not a descriptor accepted as their proof.
 * The original owner must resolve the manifest's immutable implementation to
 * the actual selected instance/configuration and all of these complete paths. */
export interface SelectedKubernetesRendererDefinition {
  readonly workload: FixedWorkloadDefinition;
  readonly admittedTemplate: typeof fixedAdmittedGatewayTemplate;
  readonly admittedDeployment: typeof admittedGatewayDeployment;
  readonly normalizeResources: typeof normalizeKubernetesResourcePlan;
}

export interface InstalledKubernetesRendererLease extends GatewayStartupOwnerLeaseV1 {
  readonly accounting: Readonly<Record<"gateway" | "harness", KubernetesResourceContributionMap>>;
  /** Exact actual dispatcher return and image projection resolved by the original
   * installed source. Optional means unavailable, never an empty environment. */
  readonly harnessOperands?: Readonly<{
    launch: Readonly<WorkloadLaunchContext>;
    imageSetDigest: string;
  }>;
}

/** Original Runtime/definition-owner adapter, installed by composition. It
 * authenticates the exact factory-selected Driver and original unit/IO; copied
 * ids, methods, descriptors, manifests or caller-supplied leases cannot enroll.
 * It independently resolves complete installed launcher/helper/readiness,
 * environment/module/material/runtime support. Unknown legacy token/WebSocket,
 * model-key or projected-token branches reject as unsupported; missing current
 * original inputs reject as unavailable. No production adapter is implied by
 * this type. The lease ends at the original SQL terminal, before provider work. */
export interface KubernetesRendererSource {
  acquireDefinition(
    selected: ComputeDriver,
    definition: SelectedKubernetesRendererDefinition,
    ...input: DefinitionArguments
  ): Promise<InstalledKubernetesRendererLease>;
  acquireRevision(
    selected: ComputeDriver,
    definition: SelectedKubernetesRendererDefinition,
    ...input: RevisionArguments
  ): Promise<InstalledKubernetesRendererLease>;
}

function unavailable(): never {
  throw new WorkloadProfileSelectionError("unavailable");
}
function unsupported(): never {
  throw new WorkloadProfileSelectionError("unsupported-capability");
}

/** Own the partial source lease immediately, retain invalid deferred assertions,
 * and release once in reverse order. This never creates whole capability or
 * later provider-call authority. The original aggregator retains the returned
 * handle through its own last transaction fence and terminal cleanup. */
async function acquireRendererLease(
  io: GatewayStartupAcceptedOperationV1,
  acquire: () => Promise<InstalledKubernetesRendererLease>,
  qualify: (lease: InstalledKubernetesRendererLease) => void,
): Promise<GatewayStartupOwnerLeaseV1> {
  const checks: (() => undefined)[] = [];
  const releases: (() => Promise<void>)[] = [];
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  let failed = false;
  let failure: unknown;
  let closing: Promise<void> | undefined;
  const synchronous = (work: () => unknown): void => {
    const result = work();
    if (result === undefined) return;
    const deferred = Promise.resolve(result);
    pending.add(deferred);
    void deferred.then(
      () => pending.delete(deferred),
      () => pending.delete(deferred),
    );
    unavailable();
  };
  const poison = (error: unknown): void => {
    // A faulty poison callback must not strand an already acquired lease. Any
    // invalid deferred callback is retained through the same drain as fences.
    try {
      synchronous(() => io.poison(error));
    } catch {
      // The primary acquisition/currentness failure remains the result. This
      // local scope is already failing and cannot return an accepted handle.
    }
  };
  const release = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    // Publish the one closing promise before any original cleanup callback can
    // reenter this handle; reentrancy must not start a second source release.
    closing = Promise.resolve().then(async () => {
      while (pending.size) await Promise.allSettled([...pending]);
      let cleanupFailed = false;
      let cleanupFailure: unknown;
      for (const close of releases.reverse()) {
        try {
          await close();
        } catch (error) {
          if (!cleanupFailed) {
            cleanupFailed = true;
            cleanupFailure = error;
          }
          poison(error);
        }
      }
      while (pending.size) await Promise.allSettled([...pending]);
      if (cleanupFailed) throw cleanupFailure;
    });
    return closing;
  };
  const assertCurrent = (): undefined => {
    if (closed) unavailable();
    if (failed) throw failure;
    try {
      for (const check of checks) synchronous(check);
    } catch (error) {
      failed = true;
      failure = error;
      poison(error);
      throw error;
    }
    return undefined;
  };
  const acquiring = (): void => {
    synchronous(() => io.assertActive());
    assertCurrent();
  };
  try {
    acquiring();
    const lease = await acquire();
    // Capture cleanup before inspecting accounting, other getters or fences.
    const close = lease.release;
    if (typeof close !== "function") unavailable();
    releases.push(close.bind(lease));
    const check = lease.assertCurrent;
    if (typeof check !== "function") unavailable();
    checks.push(check.bind(lease));
    acquiring();
    qualify(lease);
    acquiring();
    return Object.freeze({ assertCurrent, release });
  } catch (error) {
    poison(error);
    try {
      await release();
    } catch {
      // release already poisoned and drained its cleanup failure; preserve the
      // original acquisition result without starting another poison callback.
    }
    throw error;
  }
}

function qualifyResources(
  definition: SelectedKubernetesRendererDefinition,
  manifest: Manifest,
  lease: InstalledKubernetesRendererLease,
): void {
  const selected = definition.workload.options;
  if (
    selected.isolationProfile !== "gvisor-systrap" ||
    selected.runtime !== undefined ||
    selected.servicePrincipalCredentials.mode !== "disabled" ||
    manifest.artifactSet.gateway.reference !== definition.workload.images.gateway ||
    manifest.artifactSet.harness.reference !== definition.workload.images.harness
  )
    // The legacy runtime path actually emits capability-token transport and
    // direct credentials. A definition lease cannot promote those branches to
    // the admitted pair's module/material protocol. Explicit image entrypoints
    // still require the original executable/environment owner's qualification.
    unsupported();
  const plan = normalizeKubernetesResourcePlan(
    manifest.launchConfiguration.resourceEnvelope.podAndRuntimeAccounting.envelope,
    immutableCopy(lease.accounting),
  );
  // Both real constructors have precisely one ordinary init and application.
  // The existing normalizer rejects extra helpers/concurrency/storage shapes;
  // defaults and quota remain comparisons, never inferred current admission.
  assertKubernetesResourceComparison(plan.gateway.application, selected.resources.gateway);
  assertKubernetesResourceComparison(plan.harness.application, selected.resources.agent);
  assertKubernetesConfiguredQuota(plan.gateway, selected.namespaceResources);
  assertKubernetesConfiguredQuota(plan.harness, selected.namespaceResources);
}

/** Reconstruct the original canonical value without freezing a typed array.
 * A fresh byte view on every read prevents a peer from changing the captured
 * definition during an await. This is correspondence, never source authority. */
function snapshotDefinitionRequest(
  request: WorkloadProfileDefinitionRequestV2,
): WorkloadProfileDefinitionRequestV2 {
  const { scope, selection } = immutableCopy({
    scope: request.scope,
    selection: request.selection,
  });
  const supplied = request.manifest;
  const bytes = new Uint8Array(supplied.canonicalBytes);
  const derived = deriveWorkloadProfileManifestV2(bytes);
  const fields = [
    "content",
    "projections",
    "digests",
    "roleDigests",
    "unavailableDigests",
  ] as const;
  if (
    Object.keys(request).length !== 3 ||
    !Object.keys(request).every((key) => ["scope", "selection", "manifest"].includes(key)) ||
    scope.component !== "gateway-harness-pair" ||
    selection.manifestDigest !== derived.digests.manifestDigest ||
    !isDeepStrictEqual(bytes, derived.canonicalBytes) ||
    fields.some(
      (key) => !isDeepStrictEqual(immutableCopy(supplied[key]), immutableCopy(derived[key])),
    )
  )
    throw new WorkloadProfileSelectionError("invalid-record");
  const { canonicalBytes: _bytes, ...other } = derived;
  const values = immutableCopy(other);
  const manifest = Object.freeze({
    ...values,
    get canonicalBytes(): Uint8Array {
      return new Uint8Array(bytes);
    },
  });
  return Object.freeze({ scope, selection, manifest });
}

/** Partial renderer contribution only: deliberately has no canonical acquire
 * method, so it cannot stand in for Runtime's complete capability source. */
export class KubernetesWorkloadProfileCapability implements WorkloadProfileRendererContributionV2 {
  readonly #selected: ComputeDriver;
  readonly #definition: SelectedKubernetesRendererDefinition;
  readonly #acquireRevision: KubernetesRendererSource["acquireRevision"] | undefined;
  readonly #acquireDefinition: KubernetesRendererSource["acquireDefinition"] | undefined;
  constructor(
    selected: ComputeDriver,
    renderer: FixedWorkloadRenderer,
    source?: KubernetesRendererSource,
  ) {
    this.#selected = selected;
    this.#definition = Object.freeze({
      workload: renderer.definition(),
      admittedTemplate: fixedAdmittedGatewayTemplate,
      admittedDeployment: admittedGatewayDeployment,
      normalizeResources: normalizeKubernetesResourcePlan,
    });
    this.#acquireRevision = source?.acquireRevision?.bind(source);
    this.#acquireDefinition = source?.acquireDefinition?.bind(source);
    Object.freeze(this);
  }

  async verifyRendererDefinitionLocked(
    ...input: DefinitionArguments
  ): Promise<GatewayStartupOwnerLeaseV1> {
    const acquire = this.#acquireDefinition;
    if (!acquire) unavailable();
    const [request, unit, io] = input;
    let snapshot: WorkloadProfileDefinitionRequestV2 | undefined;
    return acquireRendererLease(
      io,
      async () => {
        snapshot = snapshotDefinitionRequest(request);
        return acquire(this.#selected, this.#definition, snapshot, unit, io);
      },
      (lease) => {
        if (!snapshot) unavailable();
        qualifyResources(this.#definition, snapshot.manifest.content, lease);
      },
    );
  }

  /** Same original source acquisition; comparison consumes its actual operands
   * without invoking any launch hook in the current SQL transaction. */
  async verifyPreparedHarnessLocked(
    input: RevisionArguments,
    compare: (lease: InstalledKubernetesRendererLease) => void,
  ): Promise<GatewayStartupOwnerLeaseV1> {
    const acquire = this.#acquireRevision;
    if (!acquire) unavailable();
    const [request, manifest, use, unit, io] = input;
    const snapshot = immutableCopy({ request, manifest, use });
    return acquireRendererLease(
      io,
      () =>
        acquire(
          this.#selected,
          this.#definition,
          snapshot.request,
          snapshot.manifest,
          snapshot.use,
          unit,
          io,
        ),
      (lease) => {
        qualifyResources(this.#definition, snapshot.manifest, lease);
        compare(lease);
      },
    );
  }

  async verifyRevisionRendererLocked(
    ...input: RevisionArguments
  ): Promise<GatewayStartupOwnerLeaseV1> {
    const acquire = this.#acquireRevision;
    if (!acquire) unavailable();
    const [request, manifest, use, unit, io] = input;
    let snapshot:
      | Readonly<{ request: RevisionArguments[0]; manifest: Manifest; use: RevisionArguments[2] }>
      | undefined;
    return acquireRendererLease(
      io,
      async () => {
        snapshot = immutableCopy({ request, manifest, use });
        if (snapshot.manifest.target.component !== "gateway-harness-pair") unsupported();
        return acquire(
          this.#selected,
          this.#definition,
          snapshot.request,
          snapshot.manifest,
          snapshot.use,
          unit,
          io,
        );
      },
      (lease) => {
        if (!snapshot) unavailable();
        qualifyResources(this.#definition, snapshot.manifest, lease);
      },
    );
  }
}
