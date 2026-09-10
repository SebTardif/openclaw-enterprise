import { isDeepStrictEqual } from "node:util";
import type { AgentRevision } from "@openclaw-enterprise/contracts/resources/agent";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { WorkloadProfilePrerequisiteErrorV2 } from "@openclaw-enterprise/occ/workload-profiles/admitted-use";
import { WorkloadProfileSelectionError } from "@openclaw-enterprise/occ/workload-profiles/selection";
import { selectedComputeRendererOwner } from "../../../composition/driver-factories/compute.ts";
import { KubernetesComputeDriver } from "./index.ts";
import { KubernetesRendererOwner } from "./renderer-owner.ts";
import {
  ProtectedInstalledArtifactStore,
  type InstalledArtifactLease,
} from "./installed-artifact-store.ts";
import type {
  InstalledRendererDefinition,
  InstalledRendererRevision,
  KubernetesInstalledRendererDefinitionOwner,
} from "./renderer-source.ts";
import type { KubernetesRendererSource } from "./workload-profile-capability.ts";

export type DefinitionArgs = Parameters<KubernetesRendererSource["acquireDefinition"]>;
export type RevisionArgs = Parameters<KubernetesRendererSource["acquireRevision"]>;

/** This trusted producer owns executable/environment/module behavior for the
 * independently acquired definition bytes and image contents. A projection
 * decoded from those bytes alone does not implement this contract. Definition
 * acquisition is revision-free and must not run a launch hook or select material. */
export interface InstalledBehaviorLease extends Pick<
  InstalledRendererDefinition,
  "projection" | "accounting" | "assertCurrent" | "release"
> {}

/** The original revision/material/placement owners supply actual constructor
 * inputs and outputs under the same request/unit. The full image-set digest
 * covers application, init and helper images; this consumer does not replace
 * that producer's definition with a hash of the two application references. */
export interface InstalledRevisionOperandsLease extends Pick<
  InstalledRendererRevision,
  "inputs" | "outputs" | "assertCurrent" | "release"
> {
  readonly revision: Readonly<AgentRevision>;
  readonly harnessOperands: NonNullable<InstalledRendererRevision["harnessOperands"]>;
}

export interface TrustedInstalledRendererSuppliers {
  acquireBehavior(
    input: Readonly<{
      artifacts: InstalledArtifactLease;
      selected: DefinitionArgs[0];
      definition: DefinitionArgs[1];
      unit: DefinitionArgs[3] | RevisionArgs[5];
      io: DefinitionArgs[4];
    }>,
  ): Promise<InstalledBehaviorLease>;
  acquireRevisionOperands(
    input: Readonly<{
      artifacts: InstalledArtifactLease;
      behavior: InstalledBehaviorLease;
      original: Readonly<RevisionArgs>;
    }>,
  ): Promise<InstalledRevisionOperandsLease>;
}

const originalAcquire = ProtectedInstalledArtifactStore.prototype.acquire;
const originalDefinition = KubernetesRendererOwner.prototype.definition;
const originalLaunch = KubernetesComputeDriver.prototype.acquireCurrentLaunchOperands;
const originalSelectedOwner = selectedComputeRendererOwner;
const digest = /^sha256:[a-f0-9]{64}$/;
function unavailable(): never {
  throw new WorkloadProfileSelectionError("unavailable");
}
function corresponding(left: DefinitionArgs[1], right: DefinitionArgs[1]): boolean {
  return (
    left.workload === right.workload &&
    left.admittedTemplate === right.admittedTemplate &&
    left.admittedDeployment === right.admittedDeployment &&
    left.normalizeResources === right.normalizeResources
  );
}

/** Constructed before Compute exists. The existing renderer-source enters these
 * methods only after original State enrollment and its held Driver selection.
 * This consumer recognizes the factory-owned renderer; it neither re-enrolls
 * State nor creates another DriverSelection. Missing suppliers refuse acquisition
 * while allowing the real artifact component to be constructed independently. */
export class InstalledKubernetesRendererDefinitionOwner implements KubernetesInstalledRendererDefinitionOwner {
  readonly #store: ProtectedInstalledArtifactStore;
  readonly #behavior: TrustedInstalledRendererSuppliers["acquireBehavior"] | undefined;
  readonly #revision: TrustedInstalledRendererSuppliers["acquireRevisionOperands"] | undefined;

  constructor(
    store: ProtectedInstalledArtifactStore,
    suppliers?: TrustedInstalledRendererSuppliers,
  ) {
    this.#store = store;
    this.#behavior = suppliers?.acquireBehavior?.bind(suppliers);
    this.#revision = suppliers?.acquireRevisionOperands?.bind(suppliers);
    Object.freeze(this);
  }

  async acquireDefinition(...args: DefinitionArgs): Promise<InstalledRendererDefinition> {
    return this.#acquire(args, undefined);
  }

  async acquireRevision(...args: RevisionArgs): Promise<InstalledRendererRevision> {
    return this.#acquire(undefined, args) as Promise<InstalledRendererRevision>;
  }

  async #acquire(
    definitionArgs: DefinitionArgs | undefined,
    revisionArgs: RevisionArgs | undefined,
  ): Promise<InstalledRendererDefinition | InstalledRendererRevision> {
    const args = definitionArgs ?? revisionArgs!;
    const selected = args[0];
    const suppliedDefinition = args[1];
    const unit = definitionArgs ? definitionArgs[3] : revisionArgs![5];
    const io = definitionArgs ? definitionArgs[4] : revisionArgs![6];
    const checkIO = io.assertActive.bind(io);
    const expected = immutableCopy(
      definitionArgs ? definitionArgs[2].manifest.content : revisionArgs![3],
    );
    const expectedRevision = revisionArgs ? immutableCopy(revisionArgs[2]) : undefined;
    const owner = originalSelectedOwner(selected);
    if (!owner) unavailable();
    const installed = originalDefinition.call(owner);
    if (!corresponding(suppliedDefinition, installed)) unavailable();
    if (!this.#behavior) throw new WorkloadProfilePrerequisiteErrorV2(["renderer.behavior-source"]);
    if (revisionArgs && !this.#revision)
      throw new WorkloadProfilePrerequisiteErrorV2(["renderer.revision-operands-source"]);

    // Startup owner units have no signal. Their original IO and supplier leases
    // enforce currentness; a local signal only owns this artifact acquisition.
    const local = new AbortController();
    const signal = "signal" in unit ? unit.signal : local.signal;
    const checks: (() => unknown)[] = [];
    const releases: (() => Promise<void>)[] = [];
    const pending = new Set<Promise<unknown>>();
    let failed = false;
    let failure: unknown;
    let closed = false;
    let closing: Promise<void> | undefined;
    let cleanupFailure: unknown;
    let cleanupFailed = false;

    const remember = (error: unknown): void => {
      if (!failed) {
        failed = true;
        failure = error;
      }
    };
    const retainDeferred = (value: unknown): void => {
      // Register before a foreign thenable getter/continuation can run.
      const actual = Promise.resolve().then(() => value);
      pending.add(actual);
      void actual.then(
        () => pending.delete(actual),
        (error) => {
          remember(error);
          pending.delete(actual);
        },
      );
    };
    const sync = (check: () => unknown): void => {
      const result = check();
      if (result !== undefined) {
        retainDeferred(result);
        unavailable();
      }
    };
    const localCurrent = (): void => {
      if (closed || signal.aborted) unavailable();
      if (failed) throw failure;
      if (
        originalSelectedOwner(selected) !== owner ||
        !corresponding(originalDefinition.call(owner), installed) ||
        !corresponding(suppliedDefinition, installed)
      )
        unavailable();
      if (
        !isDeepStrictEqual(
          immutableCopy(definitionArgs ? definitionArgs[2].manifest.content : revisionArgs![3]),
          expected,
        ) ||
        (revisionArgs && !isDeepStrictEqual(immutableCopy(revisionArgs[2]), expectedRevision))
      )
        unavailable();
      if (closed || signal.aborted) unavailable();
      if (failed) throw failure;
    };
    const assertCurrent = (): undefined => {
      try {
        localCurrent();
        for (const check of checks) sync(check);
        // External fences may synchronously invalidate or re-enter this lease.
        localCurrent();
        if (failed) throw failure;
        return undefined;
      } catch (error) {
        remember(error);
        throw error;
      }
    };
    const active = (): void => {
      assertCurrent();
      try {
        sync(checkIO);
      } catch (error) {
        remember(error);
        throw error;
      }
      assertCurrent();
    };
    const own = <T extends { assertCurrent(): unknown; release(): Promise<void> }>(lease: T): T => {
      // A returned lease's disposer is retained before reading any other field.
      const release = lease.release.bind(lease);
      releases.push(release);
      checks.push(lease.assertCurrent.bind(lease));
      return lease;
    };
    const release = (): Promise<void> => {
      if (closing) return closing;
      closed = true;
      // Publish the one join before abort listeners or original disposers run.
      closing = Promise.resolve().then(async () => {
        local.abort();
        while (pending.size) await Promise.allSettled([...pending]);
        for (const dispose of releases.reverse()) {
          try {
            await dispose();
          } catch (error) {
            if (!cleanupFailed) {
              cleanupFailed = true;
              cleanupFailure = error;
            }
          }
        }
        while (pending.size) await Promise.allSettled([...pending]);
        if (cleanupFailed) throw cleanupFailure;
      });
      return closing;
    };

    try {
      active();
      const artifacts = own(await originalAcquire.call(this.#store, signal));
      active();
      const behavior = own(
        await this.#behavior(
          Object.freeze({
            artifacts,
            selected,
            definition: installed,
            unit,
            io,
          }),
        ),
      );
      active();
      const projection = immutableCopy(behavior.projection);
      const accounting = immutableCopy(behavior.accounting);
      if (
        !isDeepStrictEqual(
          projection,
          immutableCopy({
            artifactSet: expected.artifactSet,
            launchConfiguration: expected.launchConfiguration,
          }),
        )
      )
        unavailable();
      for (const role of ["gateway", "harness"] as const) {
        const image = artifacts.images[role];
        const artifact = projection.artifactSet[role];
        if (
          artifact.reference !== installed.workload.images[role] ||
          artifact.reference !== image.reference ||
          artifact.platformDigest !== image.descriptor.digest ||
          image.readFile(artifact.executable.path).digest !== artifact.executable.contentDigest
        )
          unavailable();
      }
      installed.normalizeResources(
        projection.launchConfiguration.resourceEnvelope.podAndRuntimeAccounting.envelope,
        accounting,
      );
      active();
      let revisionResult:
        Pick<InstalledRendererRevision, "inputs" | "outputs" | "harnessOperands"> | undefined;
      if (revisionArgs) {
        // Freeze the tuple, retaining the actual original operands by identity.
        const original = Object.freeze([...revisionArgs]) as Readonly<RevisionArgs>;
        const operands = own(
          await this.#revision!(Object.freeze({ artifacts, behavior, original })),
        );
        active();
        const revision = operands.revision;
        const request = expectedRevision!;
        if (
          revision.id !== request.revisionId ||
          revision.agentId !== request.agentId ||
          revision.namespaceId !== request.namespaceId
        )
          unavailable();
        const launch = own(originalLaunch.call(selected as KubernetesComputeDriver, revision));
        active();
        const supplied = operands.harnessOperands;
        const suppliedLaunch = supplied.launch;
        const imageSetDigest = supplied.imageSetDigest;
        if (
          suppliedLaunch !== launch.launch ||
          typeof imageSetDigest !== "string" ||
          !digest.test(imageSetDigest)
        )
          unavailable();
        const inputs = immutableCopy(operands.inputs);
        const outputs = immutableCopy(operands.outputs);
        checks.push(() => {
          if (
            revision.id !== request.revisionId ||
            revision.agentId !== request.agentId ||
            revision.namespaceId !== request.namespaceId ||
            supplied.launch !== suppliedLaunch ||
            supplied.imageSetDigest !== imageSetDigest ||
            suppliedLaunch !== launch.launch
          )
            unavailable();
          return undefined;
        });
        revisionResult = {
          inputs,
          outputs,
          harnessOperands: supplied,
        };
      }
      active();
      const result = Object.freeze({
        definition: installed,
        projection,
        accounting,
        ...(revisionResult ?? {}),
        assertCurrent,
        release,
      });
      active();
      return result;
    } catch (error) {
      remember(error);
      // An awaited late supplier is owned above before cancellation is checked.
      // Refusal does not settle until its actual acquisition and cleanup join.
      try {
        await release();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Installed renderer acquisition and cleanup failed.",
        );
      }
      throw error;
    }
  }
}
