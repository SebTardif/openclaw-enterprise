import { RuntimeProfileWorker } from "./worker/runtime-profile.ts";
import { isPositiveSafeInteger } from "@openclaw-enterprise/utils";
import { isSandboxFacet } from "@openclaw-enterprise/contracts";
import type {
  ComputeDriver,
  ConfigurationDriver,
  Driver,
  IAMDriver,
  Installation,
  ProviderDefinition,
  SandboxDriver,
  SecretDriver,
} from "@openclaw-enterprise/contracts";
import {
  NativeIAMDriver,
  validatePersistedNativeIAMState,
  type NativeIAMState,
} from "@openclaw-enterprise/iam";
import {
  PostgresPlatformState,
  PostgresWorkQueue,
  type PostgresPool,
  type PostgresQueryClient,
  type PostgresWorkQueueOptions,
  providerDefinitionMap,
  validateProviderDefinitions,
  validateServiceAccountProviderBinding,
} from "@openclaw-enterprise/occ";
import type { InstallationRuntimeDrivers } from "./composition/installation-config.ts";
import { resolveApprovedHarness } from "./composition/production-harness.ts";
import { withComputeAbortSignal } from "./drivers/compute/operation-context.ts";
import { WorkerRevisionCleanup } from "./worker/cleanup.ts";
import { WorkerFinalization } from "./worker/finalization.ts";
import { LeasedEffects } from "./worker/leased-effect.ts";
import { NamespaceReconciler } from "./worker/namespaces.ts";
import { WorkerRevisionInputs, validRevisionObservation } from "./worker/revision-inputs.ts";
import { RevisionReconciler } from "./worker/revisions.ts";
import { WorkerRunner } from "./worker/runner.ts";
import { RuntimeFaultWorker } from "./worker/runtime-fault.ts";

export interface ControllerWorkerOptions {
  readonly pool: PostgresPool & PostgresQueryClient;
  readonly mode?: "development" | "production";
  readonly drivers?: InstallationRuntimeDrivers;
  readonly computeDriver?: ComputeDriver;
  readonly sandboxDriver?: SandboxDriver;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly maxAttempts?: number;
  readonly convergenceTimeoutMs?: number;
  readonly emit?: (event: Readonly<Record<string, unknown>>) => void;
  readonly onHealthy?: () => Promise<void>;
}

function positiveInteger(value: number, name: string): number {
  if (!isPositiveSafeInteger(value)) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

function validDriver(driver: ComputeDriver): boolean {
  return (
    typeof driver.id === "string" &&
    driver.id.trim().length > 0 &&
    driver.capability === "compute" &&
    typeof driver.implementation === "string" &&
    driver.implementation.trim().length > 0 &&
    typeof driver.ensureNamespace === "function" &&
    typeof driver.deleteNamespace === "function" &&
    typeof driver.prepareRevision === "function" &&
    typeof driver.retireRevision === "function"
  );
}

function validSandboxDriver(driver: SandboxDriver): boolean {
  return (
    typeof driver.id === "string" &&
    driver.id.trim().length > 0 &&
    driver.capability === "sandbox" &&
    typeof driver.implementation === "string" &&
    driver.implementation.trim().length > 0 &&
    Array.isArray(driver.facets) &&
    driver.facets.length > 0 &&
    driver.facets.every(isSandboxFacet) &&
    (driver.ensureNamespace === undefined || typeof driver.ensureNamespace === "function") &&
    (driver.provisionHarness === undefined || typeof driver.provisionHarness === "function") &&
    typeof driver.cleanup === "function"
  );
}

function validSecretDriver(driver: SecretDriver): boolean {
  return (
    typeof driver.id === "string" &&
    driver.id.trim().length > 0 &&
    driver.capability === "secret" &&
    typeof driver.implementation === "string" &&
    driver.implementation.trim().length > 0 &&
    typeof driver.create === "function" &&
    typeof driver.update === "function" &&
    typeof driver.delete === "function" &&
    typeof driver.resolve === "function"
  );
}

function validLifecycleHooks(driver: Driver): boolean {
  const hooks = driver.computeLifecycleHooks;
  if (hooks === undefined) return true;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return false;
  const phases = new Set([
    "afterNamespacePrepared",
    "beforeWorkloadStart",
    "beforeWorkloadStop",
    "beforeNamespaceDelete",
  ]);
  const candidate = hooks as unknown as Record<string, unknown>;
  return (
    Object.keys(candidate).length > 0 &&
    Object.entries(candidate).every(
      ([phase, callback]) => phases.has(phase) && typeof callback === "function",
    )
  );
}

export class ControllerWorker {
  private readonly state: PostgresPlatformState;
  private readonly queue: PostgresWorkQueue;
  private readonly compute: ComputeDriver;
  private readonly configuration: ConfigurationDriver | undefined;
  private readonly queueOptions: PostgresWorkQueueOptions;
  private readonly iamDriverId: string;
  private readonly iam: IAMDriver;
  private readonly secretDriverId: string | undefined;
  private readonly sandbox: SandboxDriver | undefined;
  private readonly providers: readonly ProviderDefinition[];
  private readonly providerMap: ReadonlyMap<string, ProviderDefinition>;
  private readonly requireComputePreflight: boolean;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly maxAttempts: number;
  private readonly convergenceTimeoutMs: number;
  private readonly maintenanceIntervalMs: number | undefined;
  private readonly mode: "development" | "production";
  private readonly emit: (event: Readonly<Record<string, unknown>>) => void;
  private readonly onHealthy: (() => Promise<void>) | undefined;
  private readonly abort = new AbortController();
  private installation: Readonly<Installation> | undefined;
  private loop: Promise<void> | undefined;
  private starting: Promise<void> | undefined;
  private shutdown: Promise<void> | undefined;
  private lifetime: "idle" | "starting" | "running" | "failed" | "stopping" | "stopped" = "idle";
  private readonly runner: WorkerRunner;

  constructor(options: ControllerWorkerOptions) {
    this.mode = options.mode ?? "development";
    if (this.mode !== "development" && this.mode !== "production")
      throw new Error("The controller worker mode must be development or production.");
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 250, "Worker poll interval");
    this.leaseDurationMs = positiveInteger(options.leaseDurationMs ?? 5_000, "Worker claim lease");
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 5, "Maximum worker attempts");
    this.convergenceTimeoutMs = positiveInteger(
      options.convergenceTimeoutMs ?? 900_000,
      "Worker convergence timeout",
    );
    const drivers = options.drivers;
    if (this.mode === "production" && drivers === undefined) {
      throw new Error("Production controller workers require Installation startup configuration.");
    }
    this.queueOptions = {
      leaseDurationMs: this.leaseDurationMs,
      maxAttempts: this.maxAttempts,
    };
    this.state = new PostgresPlatformState(options.pool);
    this.queue = new PostgresWorkQueue(options.pool, this.queueOptions);
    this.providers = validateProviderDefinitions(drivers?.installation.provider ?? []);
    this.providerMap = providerDefinitionMap(this.providers);
    this.iamDriverId = drivers?.installation.drivers.iam.id ?? "native-iam";
    this.iam =
      drivers === undefined
        ? new NativeIAMDriver(this.state, { id: "native-iam", implementation: "native" })
        : drivers.createIAMDriver(this.state);
    if (this.iam.capability !== "iam" || this.iam.id !== this.iamDriverId) {
      throw new Error("The selected IAM Driver is unavailable.");
    }
    const computeDriver = drivers === undefined ? options.computeDriver : drivers.computeDriver;
    if (computeDriver === undefined)
      throw new Error("The selected Compute Driver must be explicitly provided.");
    if (drivers === undefined && !validDriver(computeDriver))
      throw new Error("The selected Compute Driver is unavailable.");
    if (
      computeDriver.activationOrder === "beforeCommit" &&
      typeof computeDriver.activateRevision !== "function"
    ) {
      throw new Error("A before-commit Compute Driver must implement activateRevision.");
    }
    this.compute = computeDriver;
    const selectedSecretDriver = drivers?.secretDriver;
    const selectedSecretConfiguration = drivers?.installation.drivers.secret;
    this.secretDriverId = selectedSecretDriver?.id ?? selectedSecretConfiguration?.id;
    if (selectedSecretConfiguration !== undefined) {
      if (selectedSecretDriver === undefined || !validSecretDriver(selectedSecretDriver)) {
        throw new Error("The selected Secret Driver is unavailable.");
      }
      if (selectedSecretDriver.id !== selectedSecretConfiguration.id) {
        throw new Error("The selected Secret Driver does not match Installation configuration.");
      }
    }
    this.maintenanceIntervalMs =
      computeDriver.maintenanceIntervalMs === undefined
        ? undefined
        : positiveInteger(computeDriver.maintenanceIntervalMs, "Compute maintenance interval");
    this.configuration = drivers?.configurationDriver;
    if (this.configuration !== undefined && !validLifecycleHooks(this.configuration)) {
      throw new Error("The selected Configuration Driver exposes invalid lifecycle hooks.");
    }
    this.sandbox = drivers?.sandboxDriver ?? options.sandboxDriver;
    if (
      (drivers?.installation.drivers.sandbox === undefined) !==
      (drivers?.sandboxDriver === undefined)
    ) {
      throw new Error("The selected Sandbox Driver requires shared startup configuration.");
    }
    if (this.sandbox !== undefined) {
      if (!validSandboxDriver(this.sandbox)) {
        throw new Error("The selected Sandbox Driver is unavailable.");
      }
      if (!validLifecycleHooks(this.sandbox)) {
        throw new Error("The selected Sandbox Driver exposes invalid lifecycle hooks.");
      }
    }
    this.requireComputePreflight =
      this.mode === "production" && drivers?.installation.drivers.compute.package === undefined;
    this.emit =
      options.emit ??
      ((event) => {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      });
    this.onHealthy = options.onHealthy;

    const effects = new LeasedEffects({
      queue: Object.freeze({ heartbeat: this.queue.heartbeat.bind(this.queue) }),
      leaseDurationMs: this.leaseDurationMs,
      withAbortSignal: withComputeAbortSignal,
    });
    const cleanup = new WorkerRevisionCleanup({
      compute: this.compute,
      effects,
      mode: this.mode,
      maintenanceIntervalMs: this.maintenanceIntervalMs,
      listRevisions: (namespaceId, agentId) =>
        this.state.read((view) => view.revisions.listRevisions(namespaceId, agentId)),
      validObservation: validRevisionObservation,
    });
    const finalization = new WorkerFinalization({
      transact: (action) =>
        this.state.transactWithQueue(
          (unit, queue) =>
            action(
              Object.freeze({
                agents: Object.freeze({
                  lockAgent: unit.agents.lockAgent.bind(unit.agents),
                  compareAndSetActiveRevision: unit.agents.compareAndSetActiveRevision.bind(
                    unit.agents,
                  ),
                }),
                namespaces: Object.freeze({
                  lockNamespace: unit.namespaces.lockNamespace.bind(unit.namespaces),
                  transitionNamespaceStatus: unit.namespaces.transitionNamespaceStatus.bind(
                    unit.namespaces,
                  ),
                  markNamespaceDeleted: unit.namespaces.markNamespaceDeleted.bind(unit.namespaces),
                }),
                runtimeAdmissions: Object.freeze({
                  findRevisionAdmission: unit.runtimeAdmissions.findRevisionAdmission.bind(
                    unit.runtimeAdmissions,
                  ),
                }),
                runtimeAssignments: Object.freeze({
                  findRuntimeIntent: unit.runtimeAssignments.findRuntimeIntent.bind(
                    unit.runtimeAssignments,
                  ),
                  findRuntimeIntentHead: unit.runtimeAssignments.findRuntimeIntentHead.bind(
                    unit.runtimeAssignments,
                  ),
                }),
                audit: Object.freeze({ append: unit.audit.append.bind(unit.audit) }),
              }),
              Object.freeze({
                heartbeat: queue.heartbeat.bind(queue),
                complete: queue.complete.bind(queue),
                defer: queue.defer.bind(queue),
                retry: queue.retry.bind(queue),
                fail: queue.fail.bind(queue),
                enqueue: queue.enqueue.bind(queue),
              }),
            ),
          this.queueOptions,
        ),
      installation: () => this.installation,
      readCurrentness: (action, options) => this.state.read((view) => action(view), options),
      iamDriverId: this.iamDriverId,
      computeDriverId: this.compute.id,
      convergenceTimeoutMs: this.convergenceTimeoutMs,
      maxAttempts: this.maxAttempts,
      maintenanceIntervalMs: this.maintenanceIntervalMs,
      cleanup,
      emit: this.emit,
    });
    const inputs = new WorkerRevisionInputs({
      read: (action) =>
        this.state.read((view) =>
          action(
            Object.freeze({
              serviceAccounts: Object.freeze({
                findServiceAccountProviderBinding:
                  view.serviceAccounts.findServiceAccountProviderBinding.bind(view.serviceAccounts),
              }),
              secrets: Object.freeze({ findSecret: view.secrets.findSecret.bind(view.secrets) }),
            }),
          ),
        ),
      loadIAMState: () => this.loadIAMState(),
      iam: this.iam,
      providerMap: this.providerMap,
      secretDriverId: this.secretDriverId,
      validateServiceAccountProviderBinding,
    });
    const namespaces = new NamespaceReconciler({
      readNamespace: (namespaceId) =>
        this.state.read((view) => view.namespaces.findNamespace(namespaceId)),
      getInstallation: () => this.installation,
      loadIAMState: () => this.loadIAMState(),
      iam: this.iam,
      compute: this.compute,
      effects,
      finalize: (execution, namespace, result) =>
        finalization.finalize(execution, namespace, result),
    });
    const revisions = new RevisionReconciler({
      read: (action, options) =>
        this.state.read(
          (view) =>
            action(
              Object.freeze({
                namespaces: Object.freeze({
                  findNamespace: view.namespaces.findNamespace.bind(view.namespaces),
                }),
                agents: Object.freeze({ findAgent: view.agents.findAgent.bind(view.agents) }),
                revisions: Object.freeze({
                  findRevision: view.revisions.findRevision.bind(view.revisions),
                }),
                runtimeAdmissions: Object.freeze({
                  findRevisionAdmission: view.runtimeAdmissions.findRevisionAdmission.bind(
                    view.runtimeAdmissions,
                  ),
                }),
                runtimeAssignments: Object.freeze({
                  findRuntimeIntent: view.runtimeAssignments.findRuntimeIntent.bind(
                    view.runtimeAssignments,
                  ),
                  findRuntimeIntentHead: view.runtimeAssignments.findRuntimeIntentHead.bind(
                    view.runtimeAssignments,
                  ),
                }),
              }),
            ),
          options,
        ),
      installation: () => this.installation,
      compute: this.compute,
      resolveApprovedHarness,
      mode: this.mode,
      inputs,
      cleanup,
      finalization,
      effects,
    });
    this.runner = new WorkerRunner({
      runtimeProfiles: new RuntimeProfileWorker({
        queue: this.queue,
        findProfile: (scope, invalidationRef) =>
          this.state.read(async (view) => {
            if (view.runtimeEffectAdmission === undefined)
              throw new Error("The original runtime profile reader is unavailable.");
            return view.runtimeEffectAdmission.findProfileClosure(scope, invalidationRef);
          }),
        emit: this.emit,
      }),
      runtimeFaults: new RuntimeFaultWorker({
        queue: this.queue,
        findFault: (operation) =>
          this.state.read(async (view) => {
            if (view.runtimeEffectAdmission === undefined)
              throw new Error("The original runtime fault reader is unavailable.");
            return view.runtimeEffectAdmission.findFaultRequest(operation);
          }),
        emit: this.emit,
      }),
      queue: Object.freeze({
        recoverStale: this.queue.recoverStale.bind(this.queue),
        claim: this.queue.claim.bind(this.queue),
        pending: this.queue.pending.bind(this.queue),
      }),
      signal: this.abort.signal,
      stopping: () => this.stopping,
      pollIntervalMs: this.pollIntervalMs,
      dispatch: (execution) =>
        execution.claim.revisionId === undefined
          ? namespaces.reconcile(execution)
          : revisions.reconcile(execution),
      emit: this.emit,
      ...(this.onHealthy === undefined ? {} : { onHealthy: this.onHealthy }),
    });
  }

  start(): Promise<void> {
    if (this.stopping)
      return Promise.reject(new Error("The controller worker is stopping or stopped."));
    if (this.lifetime !== "idle")
      return Promise.reject(new Error("The controller worker has already been started."));
    this.lifetime = "starting";
    // Record ownership before calling any asynchronous or reentrant capability.
    this.starting = Promise.resolve().then(() => this.initialize());
    return this.starting;
  }

  private get stopping(): boolean {
    return this.lifetime === "stopping" || this.lifetime === "stopped";
  }

  private async initialize(): Promise<void> {
    try {
      await this.initializeRunningWorker();
    } catch (error) {
      if (!this.stopping) this.lifetime = "failed";
      throw error;
    }
  }

  private async initializeRunningWorker(): Promise<void> {
    if (this.stopping) return;
    const installation = await this.state.loadInstallation();
    if (this.stopping) return;
    if (installation === undefined)
      throw new Error("The platform Installation must be bootstrapped before starting the worker.");
    this.installation = installation;
    const iamState = await this.loadIAMState();
    if (this.stopping) return;
    validatePersistedNativeIAMState(iamState);
    this.attachLifecycleDrivers(this.iam);
    if (this.stopping) return;
    if (this.mode === "production") {
      const compute = this.compute as ComputeDriver & { preflight?: () => Promise<void> };
      if (typeof compute.preflight === "function") await compute.preflight();
      else if (this.requireComputePreflight)
        throw new Error("The selected bundled production Compute Driver requires preflight.");
    }
    if (this.stopping) return;
    this.lifetime = "running";
    this.emit({
      event: "worker.started",
      computeDriverId: this.compute.id,
      ...(this.sandbox === undefined ? {} : { sandboxDriverId: this.sandbox.id }),
    });
    this.loop = this.runner.run();
  }

  stop(): Promise<void> {
    if (this.shutdown !== undefined) return this.shutdown;
    this.lifetime = "stopping";
    this.shutdown = Promise.resolve().then(async () => {
      try {
        // The start caller retains its startup error; shutdown still owns cleanup.
        await this.starting?.catch(() => {});
        try {
          await this.loop;
        } finally {
          await this.state.close();
        }
        this.emit({ event: "worker.stopped" });
      } finally {
        this.lifetime = "stopped";
      }
    });
    // Memoize shutdown before cancellation can reenter stop through a Driver.
    this.abort.abort();
    return this.shutdown;
  }

  private async loadIAMState(): Promise<NativeIAMState> {
    if (this.installation === undefined) throw new Error("The worker Installation is unavailable.");
    return this.state.loadNativeIAMState();
  }

  private attachLifecycleDrivers(iam: IAMDriver): void {
    if (!validLifecycleHooks(iam)) {
      throw new Error("The selected IAM Driver exposes invalid lifecycle hooks.");
    }
    const lifecycleDrivers: Driver[] = [];
    if (this.configuration?.computeLifecycleHooks !== undefined) {
      lifecycleDrivers.push(this.configuration);
    }
    if (this.sandbox?.computeLifecycleHooks !== undefined) lifecycleDrivers.push(this.sandbox);
    if (iam.computeLifecycleHooks !== undefined) lifecycleDrivers.push(iam);
    if (lifecycleDrivers.length === 0) return;
    if (typeof this.compute.setLifecycleDrivers !== "function") {
      throw new Error("The selected Compute Driver cannot accept selected lifecycle Drivers.");
    }
    this.compute.setLifecycleDrivers(Object.freeze(lifecycleDrivers));
  }
}

export function createControllerWorker(options: ControllerWorkerOptions): ControllerWorker {
  return new ControllerWorker(options);
}
