import type {
  AgentRevision,
  ComputeLifecycleHooks,
  Driver,
  Namespace,
  WorkloadLaunchContext,
} from "@openclaw-enterprise/contracts";
import { isDeepStrictEqual } from "node:util";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { currentComputeAbortSignal } from "./operation-context.ts";

type HookPhase = keyof ComputeLifecycleHooks;
type CleanupPhase = "beforeWorkloadStop" | "beforeNamespaceDelete";

interface SelectedDriver {
  readonly capability: Driver["capability"];
  readonly id: string;
  readonly callbacks: {
    readonly [phase in HookPhase]: ComputeLifecycleHooks[phase];
  };
}

const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const OPAQUE_PLACEHOLDER = /^opaque-[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESERVED_ENVIRONMENT_NAME =
  /^(?:HOME|PATH|TMPDIR|CODEX_HOME|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|LOG_FORMAT|RUST_LOG|XDG_.*|OPENCLAW_.*|OTEL_.*|LD_.*|DYLD_.*)$/;
const FALLBACK_SIGNAL = new AbortController().signal;

function validateLaunch({ environment }: WorkloadLaunchContext): void {
  const entries = Object.entries(environment);
  if (
    entries.length > 64 ||
    entries.some(
      ([name, value]) =>
        !ENVIRONMENT_NAME.test(name) ||
        RESERVED_ENVIRONMENT_NAME.test(name) ||
        typeof value !== "string" ||
        !OPAQUE_PLACEHOLDER.test(value),
    )
  ) {
    throw new Error("Unsafe workload launch environment contribution");
  }
}

function hookFailure(phase: HookPhase, owner: SelectedDriver): Error {
  return Object.assign(
    new Error(`Compute lifecycle hook ${phase} failed for ${owner.capability}:${owner.id}`),
    { phase },
  );
}

export class ComputeLifecycleDispatcher {
  readonly #drivers: readonly SelectedDriver[];
  // Captured only after this original dispatcher actually completes its hooks.
  // These operands prove construction provenance, never admission or effects.
  readonly #launches = new Map<
    string,
    {
      readonly revision: Readonly<AgentRevision>;
      readonly launch: Readonly<WorkloadLaunchContext> | undefined;
      readonly signal: AbortSignal;
    }
  >();

  readonly #revisionCleanup = new Map<string, number>();
  readonly #namespaceCleanup = new Map<string, number>();

  constructor(drivers: readonly Driver[]) {
    this.#drivers = drivers.map(({ capability, id, computeLifecycleHooks: hooks }) => ({
      capability,
      id,
      callbacks: {
        afterNamespacePrepared: hooks?.afterNamespacePrepared?.bind(hooks),
        beforeWorkloadStart: hooks?.beforeWorkloadStart?.bind(hooks),
        beforeWorkloadStop: hooks?.beforeWorkloadStop?.bind(hooks),
        beforeNamespaceDelete: hooks?.beforeNamespaceDelete?.bind(hooks),
      },
    }));
  }

  async afterNamespacePrepared(namespace: Readonly<Namespace>): Promise<void> {
    const preparedNamespace = immutableCopy(namespace);
    const signal = currentComputeAbortSignal() ?? FALLBACK_SIGNAL;
    const completed: SelectedDriver[] = [];

    for (const owner of this.#drivers) {
      const hook = owner.callbacks.afterNamespacePrepared;
      if (hook === undefined) continue;

      try {
        signal.throwIfAborted();
        await hook(preparedNamespace, signal);
        completed.push(owner);
        signal.throwIfAborted();
      } catch {
        await this.#deleteNamespace(preparedNamespace, completed, signal, true);
        throw hookFailure("afterNamespacePrepared", owner);
      }
    }
  }

  async beforeWorkloadStart(
    revision: Readonly<AgentRevision>,
  ): Promise<Readonly<WorkloadLaunchContext>> {
    const preparedRevision = immutableCopy(revision);
    const signal = currentComputeAbortSignal() ?? FALLBACK_SIGNAL;
    if (
      this.#revisionCleanup.has(preparedRevision.id) ||
      this.#namespaceCleanup.has(preparedRevision.namespaceId) ||
      (this.#launches.has(preparedRevision.id) &&
        this.#launches.get(preparedRevision.id)!.launch === undefined)
    )
      throw new Error("The original workload launch is already changing.");
    const acquisition = { revision: preparedRevision, signal, launch: undefined };
    this.#launches.set(preparedRevision.id, acquisition);
    const completed: SelectedDriver[] = [];
    const launch: WorkloadLaunchContext = { environment: {} };
    let currentOwner: SelectedDriver | undefined;

    try {
      for (const owner of this.#drivers) {
        const hook = owner.callbacks.beforeWorkloadStart;
        if (hook === undefined) continue;

        currentOwner = owner;
        signal.throwIfAborted();
        await hook(preparedRevision, launch, signal);
        completed.push(owner);
        signal.throwIfAborted();
      }

      signal.throwIfAborted();
      if (this.#launches.get(preparedRevision.id) !== acquisition)
        throw new Error("The original workload launch acquisition was superseded.");
      validateLaunch(launch);
      const captured = immutableCopy(launch);
      this.#launches.set(preparedRevision.id, {
        revision: preparedRevision,
        launch: captured,
        signal,
      });
      return captured;
    } catch {
      if (this.#launches.get(preparedRevision.id) === acquisition)
        this.#launches.delete(preparedRevision.id);
      await this.#stopRevision(preparedRevision, completed, signal, true);
      if (currentOwner === undefined) throw new Error("Compute workload preparation failed");
      throw hookFailure("beforeWorkloadStart", currentOwner);
    }
  }

  /** Resolve the actual return from this dispatcher's original launch action.
   * A copied context or matching environment cannot acquire operand custody. */
  acquireLaunchOperands(
    revision: Readonly<AgentRevision>,
    launch: Readonly<WorkloadLaunchContext>,
  ) {
    return this.#acquireLaunchOperands(revision, launch);
  }

  /** Read an already completed original launch without invoking any hooks. */
  acquireCurrentLaunchOperands(revision: Readonly<AgentRevision>) {
    const captured = this.#launches.get(revision.id);
    if (captured?.launch === undefined)
      throw new Error("The original workload launch operands are unavailable.");
    const operands = this.#acquireLaunchOperands(revision, captured.launch);
    return Object.freeze({ launch: captured.launch, ...operands });
  }

  #acquireLaunchOperands(
    revision: Readonly<AgentRevision>,
    launch: Readonly<WorkloadLaunchContext>,
  ) {
    const captured = this.#launches.get(revision.id);
    let released = false;
    const assertCurrent = (): undefined => {
      if (
        released ||
        captured === undefined ||
        captured.launch === undefined ||
        captured.launch !== launch ||
        !isDeepStrictEqual(captured.revision, revision) ||
        captured.signal.aborted ||
        this.#launches.get(revision.id) !== captured
      )
        throw new Error("The original workload launch operands are unavailable.");
      return undefined;
    };
    assertCurrent();
    return Object.freeze({
      environment: captured!.launch!.environment,
      assertCurrent,
      release: async () => {
        released = true;
      },
    });
  }

  async beforeWorkloadStop(
    revision: Readonly<AgentRevision>,
    options?: { readonly cleanup?: boolean },
  ): Promise<void> {
    await this.#stopRevision(
      immutableCopy(revision),
      this.#drivers,
      currentComputeAbortSignal() ?? FALLBACK_SIGNAL,
      options?.cleanup === true,
    );
  }

  async beforeNamespaceDelete(namespace: Readonly<Namespace>): Promise<void> {
    return this.#deleteNamespace(
      immutableCopy(namespace),
      this.#drivers,
      currentComputeAbortSignal() ?? FALLBACK_SIGNAL,
    );
  }

  async #deleteNamespace(
    namespace: Readonly<Namespace>,
    drivers: readonly SelectedDriver[],
    signal: AbortSignal,
    recoverCancelled = false,
  ): Promise<void> {
    const key = namespace.id;
    this.#namespaceCleanup.set(key, (this.#namespaceCleanup.get(key) ?? 0) + 1);
    const invalidate = () => {
      for (const [id, capture] of this.#launches)
        if (capture.revision.namespaceId === key) this.#launches.delete(id);
    };
    invalidate();
    try {
      await this.#cleanup(
        "beforeNamespaceDelete",
        immutableCopy(namespace),
        drivers,
        signal,
        recoverCancelled,
      );
    } finally {
      invalidate();
      const remaining = this.#namespaceCleanup.get(key)! - 1;
      if (remaining) this.#namespaceCleanup.set(key, remaining);
      else this.#namespaceCleanup.delete(key);
    }
  }

  async #stopRevision(
    revision: Readonly<AgentRevision>,
    drivers: readonly SelectedDriver[],
    signal: AbortSignal,
    recoverCancelled = false,
  ): Promise<void> {
    const key = revision.id;
    this.#revisionCleanup.set(key, (this.#revisionCleanup.get(key) ?? 0) + 1);
    this.#launches.delete(key);
    try {
      await this.#cleanup("beforeWorkloadStop", revision, drivers, signal, recoverCancelled);
    } finally {
      this.#launches.delete(key);
      const remaining = this.#revisionCleanup.get(key)! - 1;
      if (remaining) this.#revisionCleanup.set(key, remaining);
      else this.#revisionCleanup.delete(key);
    }
  }

  async #cleanup(
    phase: CleanupPhase,
    resource: Readonly<AgentRevision> | Readonly<Namespace>,
    drivers: readonly SelectedDriver[],
    signal: AbortSignal,
    recoverCancelled = false,
  ): Promise<void> {
    const cleanupSignal = recoverCancelled && signal.aborted ? AbortSignal.timeout(5_000) : signal;

    for (const owner of [...drivers].reverse()) {
      const hook = owner.callbacks[phase] as
        | ((
            resource: Readonly<AgentRevision> | Readonly<Namespace>,
            signal: AbortSignal,
          ) => Promise<void>)
        | undefined;
      if (hook === undefined) continue;
      cleanupSignal.throwIfAborted();

      try {
        await hook(resource, cleanupSignal);
        cleanupSignal.throwIfAborted();
      } catch {
        throw hookFailure(phase, owner);
      }
    }
  }
}
