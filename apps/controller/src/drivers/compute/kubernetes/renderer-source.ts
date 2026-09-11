import { isDeepStrictEqual } from "node:util";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type { ComputeDriver } from "@openclaw-enterprise/contracts";
import type { V1Deployment } from "@kubernetes/client-node";
import { DriverSelection } from "@openclaw-enterprise/occ/application/driver-selection";
import {
  WorkloadProfilePrerequisiteErrorV2,
  type WorkloadProfileSourceEnrollmentV2,
  type WorkloadProfileOwnedLeaseV2,
} from "@openclaw-enterprise/occ/workload-profiles/admitted-use";
import { WorkloadProfileSelectionError } from "@openclaw-enterprise/occ/workload-profiles/selection";
import { KubernetesRendererOwner } from "./renderer-owner.ts";
import {
  acquireRendererLease,
  type KubernetesRendererSource,
  type InstalledKubernetesRendererLease,
  type SelectedKubernetesRendererDefinition,
} from "./workload-profile-capability.ts";

type DefinitionArguments = Parameters<KubernetesRendererSource["acquireDefinition"]>;
type RevisionArguments = Parameters<KubernetesRendererSource["acquireRevision"]>;
type Manifest = RevisionArguments[3];
type Construction = ReturnType<KubernetesRendererOwner["acquire"]>;
type Projection = Pick<Manifest, "artifactSet" | "launchConfiguration">;

/** Separate original immutable-definition custodian. The factory cannot derive
 * immutable implementation identity or executable/environment support from a
 * manifest naming them. Its real resolver must retain the exact source record,
 * selected image contents, and original operation through terminal cleanup.
 * No built-in implementation is claimed while that producer is unavailable. */
export interface KubernetesInstalledRendererDefinitionOwner {
  acquireDefinition(...args: DefinitionArguments): Promise<InstalledRendererDefinition>;
  acquireRevision(...args: RevisionArguments): Promise<InstalledRendererRevision>;
  acquirePreparedRevision?(...args: RevisionArguments): Promise<InstalledRendererPreparedRevision>;
}
export interface InstalledRendererDefinition extends InstalledKubernetesRendererLease {
  readonly definition: SelectedKubernetesRendererDefinition;
  readonly projection: Projection;
}
export interface InstalledRendererRevision extends InstalledRendererDefinition {
  /** Original captured candidate/material and logical placement. These template
   * operands require neither a created Namespace UID nor a completed launch. */
  readonly inputs: {
    readonly gateway: Parameters<Construction["gatewayTemplate"]>;
    readonly harness: Parameters<Construction["harnessTemplate"]>[0];
  };
  readonly outputs: Readonly<Record<"gateway" | "harness", V1Deployment>>;
}
export interface InstalledRendererPreparedRevision extends InstalledRendererDefinition {
  /** Actual original target/material and completed-launch custody, qualified
   * separately from static admission by the fixed prepared-Harness path. */
  readonly inputs: {
    readonly gateway: Parameters<Construction["gatewayDeployment"]>;
    readonly harness: Parameters<Construction["harnessTemplate"]>[0];
  };
  readonly outputs: Readonly<Record<"gateway" | "harness", V1Deployment>>;
}

const acquireOriginal = KubernetesRendererOwner.prototype.acquire;
const definitionOriginal = KubernetesRendererOwner.prototype.definition;
function unavailable(): never {
  throw new WorkloadProfileSelectionError("unavailable");
}
function corresponding(
  supplied: SelectedKubernetesRendererDefinition,
  original: SelectedKubernetesRendererDefinition,
): boolean {
  return (
    supplied.workload === original.workload &&
    supplied.admittedTemplate === original.admittedTemplate &&
    supplied.admittedDeployment === original.admittedDeployment &&
    supplied.normalizeResources === original.normalizeResources
  );
}

/** Installed only by the original Compute factory. A source acquisition first
 * authenticates original Platform membership, then holds the selected renderer
 * and independent immutable-definition owner. This is renderer contribution
 * only: the unchanged aggregator still requires all other original owners. */
export function createSelectedKubernetesRendererSource(
  driver: ComputeDriver,
  owner: KubernetesRendererOwner,
  selection: DriverSelection,
  units: WorkloadProfileSourceEnrollmentV2,
  installed?: KubernetesInstalledRendererDefinitionOwner,
): KubernetesRendererSource {
  const enrollDefinition = units.definition.bind(units);
  const enrollRevision = units.revision.bind(units);
  const resolveDefinition = installed?.acquireDefinition?.bind(installed);
  const resolveRevision = installed?.acquireRevision?.bind(installed);
  const resolvePreparedRevision = installed?.acquirePreparedRevision?.bind(installed);
  const original = definitionOriginal.call(owner);

  async function acquire(
    selected: ComputeDriver,
    definition: SelectedKubernetesRendererDefinition,
    manifest: Manifest,
    io: DefinitionArguments[4],
    enroll: () => WorkloadProfileOwnedLeaseV2,
    resolve: (() => Promise<InstalledRendererDefinition>) | undefined,
    phase: "definition" | "revision" | "prepared",
  ): Promise<InstalledKubernetesRendererLease> {
    // Enrollment precedes diagnostics and all independent-source operations.
    const enrollment = enroll();
    let construction: Construction | undefined;
    let resolved: WorkloadProfileOwnedLeaseV2 | undefined;
    let accounting: InstalledKubernetesRendererLease["accounting"] | undefined;
    let harnessOperands: InstalledKubernetesRendererLease["harnessOperands"];
    try {
      if (selected !== driver || !corresponding(definition, original)) unavailable();
      enrollment.assertCurrent();
      io.assertActive();
      construction = acquireOriginal.call(owner, selection);
      const held = construction;
      if (!resolve)
        throw new WorkloadProfilePrerequisiteErrorV2(["renderer.immutable-definition-owner"]);
      resolved = await acquireRendererLease(io, resolve, (source) => {
        const record = source;
        if (
          !corresponding(record.definition, original) ||
          !isDeepStrictEqual(
            immutableCopy(record.projection),
            immutableCopy({
              artifactSet: manifest.artifactSet,
              launchConfiguration: manifest.launchConfiguration,
            }),
          ) ||
          manifest.artifactSet.gateway.reference !== original.workload.images.gateway ||
          manifest.artifactSet.harness.reference !== original.workload.images.harness
        )
          throw new WorkloadProfileSelectionError("unsupported-capability");
        // The original normalizer proves the two actual container roles and
        // exact init/steady-phase accounting, never merely total resource sums.
        const mapping = immutableCopy(record.accounting);
        original.normalizeResources(
          manifest.launchConfiguration.resourceEnvelope.podAndRuntimeAccounting.envelope,
          mapping,
        );
        if (phase !== "definition") {
          const revision = record as InstalledRendererRevision | InstalledRendererPreparedRevision;
          const outputs = immutableCopy(revision.outputs);
          let actual: Readonly<Record<"gateway" | "harness", V1Deployment>>;
          if (phase === "prepared") {
            const inputs = immutableCopy((revision as InstalledRendererPreparedRevision).inputs);
            actual = {
              gateway: held.gatewayDeployment(...inputs.gateway),
              harness: held.harnessTemplate(inputs.harness),
            };
            harnessOperands = revision.harnessOperands;
          } else {
            const inputs = immutableCopy((revision as InstalledRendererRevision).inputs);
            if (inputs.gateway[1] !== manifest.launchConfiguration.gateway.runtimeClass)
              throw new WorkloadProfileSelectionError("unsupported-capability");
            actual = {
              gateway: held.gatewayTemplate(...inputs.gateway),
              harness: held.harnessTemplate(inputs.harness),
            };
          }
          if (!isDeepStrictEqual(immutableCopy(actual), outputs))
            throw new WorkloadProfileSelectionError("unsupported-capability");
          // Custody belongs to the original source and dispatcher. Preserve the
          // exact operand object; cloning its launch would lose that membership.
          // Absence stays unavailable to the prepared verifier, never an empty launch.
          // Static acquisition never forwards a launch, even if a peer adds one.
        }
        accounting = mapping;
      });
      if (!accounting) unavailable();
      const sourceLease = resolved;
      let released = false;
      let failed = false;
      let failure: unknown;
      let closing: Promise<void> | undefined;
      const assertCurrent = (): undefined => {
        if (released) unavailable();
        if (failed) throw failure;
        try {
          enrollment.assertCurrent();
          held.assertCurrent();
          sourceLease.assertCurrent();
          if (!corresponding(definitionOriginal.call(owner), original)) unavailable();
        } catch (error) {
          failed = true;
          failure = error;
          throw error;
        }
        return undefined;
      };
      const release = (): Promise<void> => {
        if (closing) return closing;
        released = true;
        closing = Promise.resolve().then(async () => {
          try {
            await sourceLease.release();
          } finally {
            try {
              held.release();
            } finally {
              await enrollment.release();
            }
          }
        });
        return closing;
      };
      const result = Object.freeze({
        accounting,
        ...(harnessOperands === undefined ? {} : { harnessOperands }),
        assertCurrent,
        release,
      });
      io.assertActive();
      result.assertCurrent();
      return result;
    } catch (error) {
      try {
        if (resolved) await resolved.release();
      } finally {
        try {
          construction?.release();
        } finally {
          await enrollment.release();
        }
      }
      throw error;
    }
  }
  return Object.freeze<KubernetesRendererSource>({
    acquireDefinition(selected, definition, request, unit, io) {
      return acquire(
        selected,
        definition,
        request.manifest.content,
        io,
        () => enrollDefinition(unit, io),
        resolveDefinition && (() => resolveDefinition(selected, definition, request, unit, io)),
        "definition",
      );
    },
    acquireRevision(selected, definition, request, manifest, use, unit, io) {
      return acquire(
        selected,
        definition,
        manifest,
        io,
        () => enrollRevision(request, unit, io),
        resolveRevision &&
          (() => resolveRevision(selected, definition, request, manifest, use, unit, io)),
        "revision",
      );
    },
    acquirePreparedRevision(selected, definition, request, manifest, use, unit, io) {
      return acquire(
        selected,
        definition,
        manifest,
        io,
        () => enrollRevision(request, unit, io),
        resolvePreparedRevision &&
          (() => resolvePreparedRevision(selected, definition, request, manifest, use, unit, io)),
        "prepared",
      );
    },
  });
}
