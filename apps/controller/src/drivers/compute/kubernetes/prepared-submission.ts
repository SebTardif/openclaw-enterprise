import { isDeepStrictEqual } from "node:util";
import type { AuthorityCallV1, ComputeDriver } from "@openclaw-enterprise/contracts";
import type {
  RuntimeCreateV1,
  RuntimeEffectCallV1,
  RuntimeEffectsV1,
} from "@openclaw-enterprise/contracts/runtime-effects-v1";
import { DriverSelection } from "@openclaw-enterprise/occ/application/driver-selection";
import type {
  RuntimePreparationCommittedSubmissionV1,
  RuntimePreparationResponseObservationSourceV1,
  RuntimePreparationSubmissionFactoryV1,
  RuntimePreparationSubmissionOwnerV1,
  RuntimePreparationRetainResponseV1,
} from "@openclaw-enterprise/occ/runtime-preparation/submission-owner";
import type { RuntimePreparationDeploymentResponseV1 } from "@openclaw-enterprise/occ/runtime-preparation/submission";
import {
  LifecycleEffectGuard,
  type LifecycleWorkerGuardContext,
} from "../../../worker/lifecycle-effect-guard.ts";
import {
  captureKubernetesPreparedProvider,
  type KubernetesPreparationProviderOptions,
  type KubernetesPreparedProviderEntryV1,
} from "./runtime-preparation-provider.ts";

/** Required ORIGINAL supplier inputs, not an installed issuer or a registration
 * API. The actual original worker/effect constructor must adopt this finite
 * consumer boundary before composition supplies it. Structural objects and a
 * committed marker do not grant permission. Missing source refuses before State
 * submit. No generic owner.run, SQL unit, gate or effect result is forwarded. */
export interface KubernetesPreparationExecutionSourceV1<I extends object = never> {
  acquireExecution(
    driver: ComputeDriver,
    committed: RuntimePreparationCommittedSubmissionV1,
    fixedProvider: KubernetesPreparedProviderEntryV1,
  ): Promise<KubernetesPreparationExecutionLeaseV1<I>>;
  acquireObservation(
    driver: ComputeDriver,
    committed: RuntimePreparationCommittedSubmissionV1,
    originalResponse: RuntimePreparationDeploymentResponseV1,
  ): Promise<KubernetesPreparationObservationCallLeaseV1>;
}

export interface KubernetesPreparationExecutionLeaseV1<I extends object = never> {
  readonly context: LifecycleWorkerGuardContext;
  /** Full original interface, retained by the SAME original guard constructor.
   * The original create implementation alone may call fixedProvider, after its
   * independent accepting protocol. Other methods are neither wrapped nor lost. */
  readonly effects: RuntimeEffectsV1;
  readonly guard: LifecycleEffectGuard;
  assertCurrent(): undefined;
  /** Original private accepting invocation membership and currentness, including
   * this bounded call after any verifier wait. NOT a caller-positive validator.
   * Its genuine producer is still a required, separately owned source input. */
  assertProviderEntry(request: RuntimeCreateV1, originalCall: RuntimeEffectCallV1): undefined;
  /** Synchronously lends the SAME original accepting implementation's private I
   * for this exact already-accepted request/call. That implementation owns its
   * registration and cleanup through release, after every entered SDK/outcome
   * continuation joins. It must refuse an absent, wrong-purpose, expired or
   * unaccepted invocation. A successful assertion, DTO, brand or marker cannot
   * create I. This declaration does not implement the required genuine issuer. */
  retainProviderInvocation(request: RuntimeCreateV1, originalCall: RuntimeEffectCallV1): I;
  release(): Promise<void>;
}

export interface KubernetesPreparationObservationCallLeaseV1 {
  readonly call: AuthorityCallV1;
  assertCurrent(): undefined;
  release(): Promise<void>;
}

export interface KubernetesPreparedSubmissionOptions<
  I extends object = never,
> extends KubernetesPreparationProviderOptions<I> {
  readonly state: KubernetesPreparationProviderOptions<I>["state"] &
    RuntimePreparationSubmissionFactoryV1;
  readonly originals?: KubernetesPreparationExecutionSourceV1<I>;
  readonly responseSource?: RuntimePreparationResponseObservationSourceV1;
}

const unavailable = () =>
  new Error("The original preparation invocation/response owner is unavailable.");
const holdSelection = DriverSelection.prototype.acquireGuardedSelection;
const originalGuardRun = LifecycleEffectGuard.prototype.run;

/** Canonical durable submission is OUTSIDE guard/create. The one post-COMMIT
 * participant obtains a fresh original worker/effect lease. No stored marker,
 * child fields, response row or callback success becomes effect authority. */
export class KubernetesPreparedSubmission<
  I extends object = never,
> implements RuntimePreparationSubmissionOwnerV1 {
  readonly #options: KubernetesPreparedSubmissionOptions<I>;
  readonly #factory: RuntimePreparationSubmissionFactoryV1["runtimePreparationSubmissionOwnerV1"];
  readonly #execution: KubernetesPreparationExecutionSourceV1<I>["acquireExecution"] | undefined;
  readonly #observation:
    KubernetesPreparationExecutionSourceV1<I>["acquireObservation"] | undefined;
  readonly #responseSource: RuntimePreparationResponseObservationSourceV1 | undefined;

  constructor(options: KubernetesPreparedSubmissionOptions<I>) {
    const {
      driver,
      encodingHolding,
      encodingSelection,
      selection,
      state,
      capabilities,
      verify,
      clients,
      namespace,
      request,
      originals,
      responseSource,
    } = options;
    // Fixed original holding methods and selection receiver, captured before I/O.
    const beginMutation = encodingHolding.beginMutation;
    const retainOutcome = encodingHolding.retainOutcome;
    const selectEncoding = encodingSelection.bind(options);
    const factory = state.runtimePreparationSubmissionOwnerV1;
    const currentUse = state.withRuntimePreparationWorkerCurrentUseV1;
    const acquireCapabilities = capabilities.acquire;
    this.#factory = factory.bind(state);
    this.#options = Object.freeze({
      driver,
      encodingSelection: selectEncoding,
      encodingHolding: Object.freeze({
        beginMutation: beginMutation.bind(encodingHolding),
        retainOutcome: retainOutcome.bind(encodingHolding),
      }),
      selection,
      verify,
      clients,
      namespace,
      request,
      capabilities: Object.freeze({ acquire: acquireCapabilities.bind(capabilities) }),
      state: Object.freeze({
        withRuntimePreparationWorkerCurrentUseV1: currentUse.bind(state),
        runtimePreparationSubmissionOwnerV1: this.#factory,
      }),
    });
    const acquireExecution = originals?.acquireExecution;
    const acquireObservation = originals?.acquireObservation;
    const acquireResponse = responseSource?.acquire;
    this.#execution = acquireExecution?.bind(originals);
    this.#observation = acquireObservation?.bind(originals);
    this.#responseSource =
      acquireResponse === undefined
        ? undefined
        : Object.freeze({
            acquire: acquireResponse.bind(responseSource),
          });
  }

  readonly submit: RuntimePreparationSubmissionOwnerV1["submit"] = async (
    claim,
    request,
    bounds,
  ) => {
    const acquireExecution = this.#execution;
    const acquireObservation = this.#observation;
    const responseSource = this.#responseSource;
    if (!acquireExecution || !acquireObservation || !responseSource)
      return Object.freeze({ status: "unavailable", effectRef: request.effectRef });
    const options = this.#options;
    const selection = holdSelection.call(options.selection, "compute", options.driver);
    let invoked = false;
    try {
      selection.assertCurrent();
      if (options.selection.selectedDriver("compute") !== options.driver) throw unavailable();
      const owner = this.#factory(
        options.selection,
        {
          invoke: async (committed, retainResponse) => {
            if (invoked) throw unavailable();
            invoked = true;
            await this.invoke(
              committed,
              retainResponse,
              acquireExecution,
              acquireObservation,
              selection.assertCurrent.bind(selection),
            );
          },
        },
        responseSource,
        options.capabilities,
      );
      // No prior guard/create entry surrounds this canonical call. The exact
      // CurrentUseRequest supplies original preparation/effect/version/guard;
      // WorkClaim never selects a latest or replacement preparation.
      return await owner.submit(claim, request, bounds);
    } finally {
      selection.release();
    }
  };

  private async invoke(
    committed: RuntimePreparationCommittedSubmissionV1,
    retainResponse: RuntimePreparationRetainResponseV1,
    acquireExecution: KubernetesPreparationExecutionSourceV1<I>["acquireExecution"],
    acquireObservation: KubernetesPreparationExecutionSourceV1<I>["acquireObservation"],
    assertSelection: () => void,
  ): Promise<void> {
    const options = this.#options;
    const pending = new Set<Promise<unknown>>();
    let failed = false;
    let failure: unknown;
    let guardOpen = false;
    let execution: KubernetesPreparationExecutionLeaseV1<I> | undefined;
    let release: (() => Promise<void>) | undefined;
    let current: (() => undefined) | undefined;
    let providerCurrent:
      KubernetesPreparationExecutionLeaseV1<I>["assertProviderEntry"] | undefined;
    let providerInvocation:
      KubernetesPreparationExecutionLeaseV1<I>["retainProviderInvocation"] | undefined;
    const noteFailure = (error: unknown) => {
      if (!failed) {
        failed = true;
        failure = error;
      }
    };
    const track = <T>(work: () => Promise<T>): Promise<T> => {
      // Publish before any external callback, including reentrant early return.
      const result = Promise.resolve().then(work);
      pending.add(result);
      void result.then(
        () => pending.delete(result),
        (error: unknown) => {
          noteFailure(error);
          pending.delete(result);
        },
      );
      return result;
    };
    const synchronous = (work: () => unknown): undefined => {
      const value = work();
      if (value !== undefined) {
        void track(() => Promise.resolve(value));
        throw unavailable();
      }
      return undefined;
    };
    const assertEntry = (input: RuntimeCreateV1, call: RuntimeEffectCallV1): undefined => {
      try {
        if (failed) throw failure;
        if (!guardOpen || !execution || !current || !providerCurrent) throw unavailable();
        assertSelection();
        synchronous(current);
        if (!isDeepStrictEqual(input, committed.child.request)) throw unavailable();
        synchronous(() => providerCurrent!(input, call));
        // Original callbacks can synchronously invalidate captured Driver facts.
        // Their successful return cannot replace this final local entry fence.
        if (failed) throw failure;
        if (!guardOpen) throw unavailable();
        assertSelection();
        if (failed) throw failure;
        return undefined;
      } catch (error) {
        noteFailure(error);
        throw error;
      }
    };
    const retainInvocation = (input: RuntimeCreateV1, call: RuntimeEffectCallV1): I => {
      try {
        assertEntry(input, call);
        if (!providerInvocation) throw unavailable();
        const invocation = providerInvocation(input, call);
        // Shape checks detect a broken synchronous supplier only. Authenticity
        // stays with the original owner; I is neither copied nor registered here.
        if (
          invocation === null ||
          (typeof invocation !== "object" && typeof invocation !== "function")
        )
          throw unavailable();
        const then: unknown = Reflect.get(invocation, "then");
        if (typeof then === "function") {
          // A nonconforming deferred supplier remains joined before source release.
          void track(
            () =>
              new Promise<unknown>((resolve, reject) => {
                Reflect.apply(then, invocation, [resolve, reject]);
              }),
          );
          throw unavailable();
        }
        assertEntry(input, call);
        return invocation;
      } catch (error) {
        noteFailure(error);
        throw error;
      }
    };
    const captureResponse = (response: RuntimePreparationDeploymentResponseV1): Promise<void> =>
      track(async () => {
        let observationRelease: (() => Promise<void>) | undefined;
        try {
          // Preserve original response identity. This is independent fresh service
          // observation, never the canceled worker call or a current-use read.
          const observed = await acquireObservation(options.driver, committed, response);
          observationRelease = observed.release.bind(observed);
          const observationCurrent = observed.assertCurrent.bind(observed);
          synchronous(observationCurrent);
          await retainResponse(response, observed.call);
          synchronous(observationCurrent);
        } catch (error) {
          // Preserve actual SDK response delivery to its original effect owner;
          // failed response persistence remains unknown to canonical submit.
          noteFailure(error);
        } finally {
          if (observationRelease) {
            try {
              await observationRelease();
            } catch (error) {
              noteFailure(error);
            }
          }
        }
      });
    // Registered before source acquisition or provider entry; the provider is
    // closed until the genuine original lease and guard have been entered.
    const fixedProvider = captureKubernetesPreparedProvider(
      options,
      committed,
      assertEntry,
      retainInvocation,
      captureResponse,
      track,
    );
    const provider: KubernetesPreparedProviderEntryV1 = (request, call) => {
      if (!guardOpen) {
        const error = unavailable();
        noteFailure(error);
        const refused = Promise.reject(error);
        void refused.catch(() => {});
        return refused;
      }
      return fixedProvider(request, call);
    };
    try {
      execution = await acquireExecution(options.driver, committed, provider);
      // Capture cleanup before any further source getter or currentness wait.
      release = execution.release.bind(execution);
      current = execution.assertCurrent.bind(execution);
      providerCurrent = execution.assertProviderEntry.bind(execution);
      providerInvocation = execution.retainProviderInvocation.bind(execution);
      if (failed) throw failure;
      synchronous(current);
      assertSelection();
      const context = execution.context;
      const guard = execution.guard;
      const effects = execution.effects;
      if (
        !(guard instanceof LifecycleEffectGuard) ||
        context.work.idempotencyKey !== committed.claim.idempotencyKey ||
        context.work.claimToken !== committed.claim.claimToken ||
        context.installationId !== committed.request.selection.installationId ||
        context.work.namespaceId !== committed.request.selection.namespaceId ||
        context.work.agentId !== committed.request.selection.agentId ||
        context.work.revisionId !== committed.request.selection.revisionId ||
        committed.child.request.kind !== "create" ||
        committed.child.effect.target.component !== "harness"
      )
        throw unavailable();
      // The supplied original source must retain its full effects object in this
      // exact guard. Reading its presence is correspondence, not authentication.
      if (!effects) throw unavailable();
      guardOpen = true;
      try {
        await originalGuardRun.call(guard, context, committed.child.request);
      } finally {
        guardOpen = false;
      }
    } catch (error) {
      noteFailure(error);
    } finally {
      guardOpen = false;
      // Guard.wait only bounds its public wait. Join the exact entered SDK and
      // observation continuations before releasing this original invocation.
      while (pending.size) await Promise.allSettled([...pending]);
      if (release) {
        try {
          await release();
        } catch (error) {
          noteFailure(error);
        }
      }
      while (pending.size) await Promise.allSettled([...pending]);
    }
    if (failed) throw failure;
  }
}
