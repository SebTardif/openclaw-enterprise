import { DriverSelection } from "@openclaw-enterprise/occ/application/driver-selection";
import {
  WorkloadProfilePrerequisiteErrorV2,
  type WorkloadProfileCompleteContributionV2,
  type WorkloadProfileCandidateQualifiersV2,
} from "@openclaw-enterprise/occ/workload-profiles/admitted-use";
import type { OriginalCredentialCandidateSourceV1 } from "@openclaw-enterprise/occ/ports/workload-profile-credentials";
import {
  createWifServiceAccountCredentialQualifierV1,
  type OriginalWifCredentialCandidatePolicyV1,
} from "@openclaw-enterprise/occ/services/service-account/workload-profile-credentials";
import { WorkloadProfileSelectionError } from "@openclaw-enterprise/occ/workload-profiles/selection";
import type { KubernetesInstalledRendererDefinitionOwner } from "../drivers/compute/kubernetes/renderer-source.ts";
import {
  selectedComputeRendererOwner,
  selectedComputeWorkloadProfileCapability,
} from "./driver-factories/compute.ts";
import type {
  WorkloadProfileCompositionOwnerAssemblyV2,
  WorkloadProfileCompositionOwnerFactoryV2,
} from "./production.ts";

type Construction = Parameters<WorkloadProfileCompositionOwnerFactoryV2>;
type Contribution = WorkloadProfileCompleteContributionV2;
type Qualifiers = WorkloadProfileCandidateQualifiersV2;

/** These are trusted original constructors, not request-supplied callbacks.
 * Construction must be synchronous and acquire nothing. Each original owner
 * captures the supplied context and original State ports and later recognizes
 * its own exact unit, immutable source and operation. Method shape is not proof
 * of semantic support; the returned sources must still refuse missing custody. */
export interface WorkloadProfileRuntimeInputOwnerV2 {
  create(...args: Construction): Readonly<{
    contribution: Contribution;
    native: Qualifiers["native"];
  }>;
}
export interface WorkloadProfileIdentityInputOwnerV2 {
  create(...args: Construction): Readonly<{
    contribution: Contribution;
    roles: Qualifiers["roles"];
  }>;
}
export interface WorkloadProfileStorageInputOwnerV2 {
  create(...args: Construction): Readonly<{
    contribution: Contribution;
    storage: Qualifiers["storage"];
  }>;
}
export interface WorkloadProfileCredentialInputOwnerV2 {
  /** The genuine WIF owner supplies this pair before Central constructs its
   * candidate context. Definition/revision construction cannot borrow a later
   * candidate capture or turn it into another phase's authority. */
  readonly source: OriginalCredentialCandidateSourceV1;
  readonly policy: OriginalWifCredentialCandidatePolicyV1;
  create(...args: Construction): Contribution;
}
export interface WorkloadProfileOwnedInputsV2 {
  readonly installedRenderer: KubernetesInstalledRendererDefinitionOwner;
  readonly runtime: WorkloadProfileRuntimeInputOwnerV2;
  readonly identity: WorkloadProfileIdentityInputOwnerV2;
  readonly credentials: WorkloadProfileCredentialInputOwnerV2;
  readonly storage: WorkloadProfileStorageInputOwnerV2;
}

const selectedCompute = DriverSelection.prototype.selectedDriver<"compute">;

function unavailable(): never {
  throw new WorkloadProfileSelectionError("unavailable");
}
function missing(name: string): never {
  throw new WorkloadProfilePrerequisiteErrorV2([`owned-inputs.${name}`]);
}
function synchronousObject(value: unknown): asserts value is object {
  if (value instanceof Promise) {
    // Constructors must acquire nothing. Observe a rejected native Promise
    // without accepting it or invoking an arbitrary thenable's method.
    void Promise.prototype.then.call(value, undefined, () => {});
    unavailable();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || "then" in value)
    unavailable();
}

/** Concrete input construction for the one existing prod/dev receiving path.
 * It does not bind Compute's renderer a second time, enroll a source, obtain a
 * lease or publish readiness. Original prod/dev still creates Central's capture
 * context first and calls this assembly once before its original aggregators.
 *
 * This boundary has no built-in positive implementation for missing Runtime,
 * identity, credential, storage or role owners. All are required original inputs.
 */
export function createWorkloadProfileOwnedInputsV2(
  input: WorkloadProfileOwnedInputsV2,
): WorkloadProfileCompositionOwnerAssemblyV2 {
  synchronousObject(input);
  const installed = input.installedRenderer;
  const runtime = input.runtime;
  const identity = input.identity;
  const credentials = input.credentials;
  const storage = input.storage;
  // Capture all fixed constructors and original receivers before publishing the
  // assembly. No caller can replace a method between pre-head capture and use.
  const runtimeMethod = runtime?.create;
  const identityMethod = identity?.create;
  const credentialMethod = credentials?.create;
  const storageMethod = storage?.create;
  const definitionMethod = installed?.acquireDefinition;
  const revisionMethod = installed?.acquireRevision;
  const preparedRevisionMethod = installed?.acquirePreparedRevision;
  const source = credentials?.source;
  const captureMethod = source?.acquireCapturedLocked;
  const policy = credentials?.policy;
  const policyMethod = policy?.assertCandidate;
  if (typeof definitionMethod !== "function" || typeof revisionMethod !== "function")
    missing("renderer.immutable-definition-owner");
  if (typeof runtimeMethod !== "function") missing("runtime");
  if (typeof identityMethod !== "function") missing("identity");
  if (typeof credentialMethod !== "function") missing("credentials");
  if (typeof storageMethod !== "function") missing("storage");
  if (typeof captureMethod !== "function") missing("credentials.capture");
  if (typeof policyMethod !== "function") missing("credentials.policy");
  const constructRuntime = runtimeMethod.bind(runtime);
  const constructIdentity = identityMethod.bind(identity);
  const constructCredentials = credentialMethod.bind(credentials);
  const constructStorage = storageMethod.bind(storage);
  const installedRenderer = Object.freeze({
    acquireDefinition: definitionMethod.bind(installed),
    acquireRevision: revisionMethod.bind(installed),
    // Prepared support is optional here; its fixed caller owns the prerequisite.
    ...(typeof preparedRevisionMethod === "function"
      ? { acquirePreparedRevision: preparedRevisionMethod.bind(installed) }
      : {}),
  });
  const credentialSource = Object.freeze({ acquireCapturedLocked: captureMethod.bind(source) });
  const capturedPolicy = Object.freeze({ assertCandidate: policyMethod.bind(policy) });
  let attempted = false;

  const create: WorkloadProfileCompositionOwnerFactoryV2 = (context, originals) => {
    // Latch before getters or original constructors can reenter. A failed or
    // asynchronous construction cannot retry against different original ports.
    if (attempted) unavailable();
    attempted = true;
    synchronousObject(context);
    synchronousObject(originals);
    const selection = context.selection;
    if (!(selection instanceof DriverSelection)) unavailable();
    const readSelectedCompute = () => {
      try {
        return selectedCompute.call(selection, "compute");
      } catch {
        unavailable();
      }
    };
    // Production constructs its Driver after receiving this assembly option.
    // Capture that exact original selection here, never an independently
    // supplied Driver or a second factory construction.
    const compute = readSelectedCompute();
    const rendererOwner = selectedComputeRendererOwner(compute);
    const rendererCapability = selectedComputeWorkloadProfileCapability(compute);
    if (!rendererOwner || !rendererCapability) missing("renderer.original-compute");
    const assertSelection = () => {
      if (
        readSelectedCompute() !== compute ||
        selectedComputeRendererOwner(compute) !== rendererOwner ||
        selectedComputeWorkloadProfileCapability(compute) !== rendererCapability
      )
        unavailable();
    };
    assertSelection();
    const enrollment = originals.sourceEnrollment;
    const records = originals.candidateRecords;
    const consume = originals.consumeCapturedCredentialV1;
    if (typeof enrollment?.definition !== "function" || typeof enrollment?.revision !== "function")
      missing("source-enrollment");
    if (typeof records?.readLocked !== "function") missing("candidate-records");
    if (typeof consume !== "function") missing("credentials.recognition");

    function contribution(owner: Contribution, name: string): Contribution {
      synchronousObject(owner);
      const definition = owner.verifyDefinitionLocked;
      const revision = owner.acquire;
      if (typeof definition !== "function" || typeof revision !== "function") missing(name);
      const verify = definition.bind(owner);
      const acquire = revision.bind(owner);
      return Object.freeze({
        verifyDefinitionLocked(...args: Parameters<Contribution["verifyDefinitionLocked"]>) {
          assertSelection();
          return verify(...args);
        },
        acquire(...args: Parameters<Contribution["acquire"]>) {
          assertSelection();
          return acquire(...args);
        },
      });
    }

    // All required constructors were checked before the first invocation. Their
    // results are captured synchronously, in the original domain order. The
    // existing aggregator alone owns acquisition and terminal lease cleanup.
    const runtimeInputs = constructRuntime(context, originals);
    synchronousObject(runtimeInputs);
    const runtimeContribution = contribution(runtimeInputs.contribution, "runtime");
    const native = runtimeInputs.native;
    const nativeMethod = native?.qualifyLocked;
    if (typeof nativeMethod !== "function") missing("candidate.native");
    const qualifyNative = nativeMethod.bind(native);
    assertSelection();
    const identityInputs = constructIdentity(context, originals);
    synchronousObject(identityInputs);
    const identityContribution = contribution(identityInputs.contribution, "identity");
    const roles = identityInputs.roles;
    const rolesMethod = roles?.resolveLocked;
    if (typeof rolesMethod !== "function") missing("candidate.roles");
    const resolveRoles = rolesMethod.bind(roles);
    assertSelection();
    const credentialContribution = contribution(
      constructCredentials(context, originals),
      "credentials",
    );
    assertSelection();
    const storageInputs = constructStorage(context, originals);
    synchronousObject(storageInputs);
    const storageContribution = contribution(storageInputs.contribution, "storage");
    const storageQualifier = storageInputs.storage;
    const storageQualifierMethod = storageQualifier?.resolveLocked;
    if (typeof storageQualifierMethod !== "function") missing("candidate.storage");
    const resolveStorage = storageQualifierMethod.bind(storageQualifier);
    // This is the actual account-owned qualifier, with the original Central
    // borrowed recognizer and the paired THREE-operand protected policy. Capture
    // and source cleanup remain in Central's pre-head normalization slot.
    const credentialQualifier = createWifServiceAccountCredentialQualifierV1(
      Object.freeze({ consumeCapturedCredentialV1: consume.bind(originals) }),
      capturedPolicy,
    );
    const resolveCredentials = credentialQualifier.resolveLocked.bind(credentialQualifier);
    assertSelection();
    return Object.freeze({
      installedRenderer,
      contributors: Object.freeze({
        runtime: runtimeContribution,
        identity: identityContribution,
        credentials: credentialContribution,
        storage: storageContribution,
      }),
      candidateQualifiers: Object.freeze({
        native: Object.freeze({
          qualifyLocked(...args: Parameters<Qualifiers["native"]["qualifyLocked"]>) {
            assertSelection();
            return qualifyNative(...args);
          },
        }),
        credentials: Object.freeze({
          resolveLocked(...args: Parameters<Qualifiers["credentials"]["resolveLocked"]>) {
            assertSelection();
            return resolveCredentials(...args);
          },
        }),
        storage: Object.freeze({
          resolveLocked(...args: Parameters<Qualifiers["storage"]["resolveLocked"]>) {
            assertSelection();
            return resolveStorage(...args);
          },
        }),
        roles: Object.freeze({
          resolveLocked(...args: Parameters<Qualifiers["roles"]["resolveLocked"]>) {
            assertSelection();
            return resolveRoles(...args);
          },
        }),
      }),
    });
  };
  return Object.freeze({ credentialSource, create });
}
