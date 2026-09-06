import type { AppsV1Api, CoreV1Api, V1Deployment } from "@kubernetes/client-node";
import type {
  GatewayProcessCallV1,
  GatewayProcessCreateInputV1,
  GatewayProcessCreateResultV1,
  GatewayProcessDiscoveryResultV1,
  GatewayProcessDispositionResultV1,
  GatewayProcessObjectV1,
  GatewayProcessObservationInputV1,
  GatewayProcessObservationResultV1,
  GatewayProcessParticipantV1,
  GatewayProcessRecoveryResultV1,
  GatewayProcessRetirementInputV1,
  GatewayProcessRetirementResultV1,
  GatewayProcessSubmissionOwnerV1,
  GatewayProcessSubmissionV1,
  GatewayStartupOperationLocatorV1,
  GatewayStartupRecordRefV1,
} from "@openclaw-enterprise/contracts/gateway-startup-v1";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { isDeepStrictEqual } from "node:util";
import { withComputeAbortSignal } from "../operation-context.ts";
import { GVISOR_RUNTIME_CLASS } from "./resources/identity.ts";
import {
  installationObjectIdentity,
  observeInstallationApi,
  type InstallationApiDescendants,
  type InstallationApiObservation,
  type InstallationPlannedContainer,
} from "./installation-process-observations.ts";
import {
  readInstallationDisposition,
  requireInstallationFence,
  retireInstallationProcess,
  type InstallationCleanupResponsibility,
  type InstallationSettlementReader,
} from "./installation-process-retirement.ts";

type Method = keyof GatewayProcessParticipantV1;
type Input =
  | GatewayProcessCreateInputV1
  | GatewayProcessObservationInputV1
  | GatewayProcessRetirementInputV1
  | GatewayStartupOperationLocatorV1;
type Result =
  | GatewayProcessCreateResultV1
  | GatewayProcessDiscoveryResultV1
  | GatewayProcessObservationResultV1
  | GatewayProcessRetirementResultV1
  | GatewayProcessDispositionResultV1;

/** This lifetime is provided only by the selected protected Installation owner
 * after inspecting the exact caller, recipient, method and complete input. It is
 * never minted from a brand, matching strings, an Agent call, or a JSON setting. */
export interface InstallationProcessAuthorization {
  readonly signal: AbortSignal;
  recheckCurrent(): Promise<void>;
  assertCurrent(): undefined;
}

export interface InstallationLaunchPlan {
  readonly input: GatewayProcessCreateInputV1;
  readonly deployment: V1Deployment;
  /** The selected original bootstrap/material owner remains current. */
  recheckCurrent(): Promise<void>;
  assertCurrent(): undefined;
}

export type InstallationCreateOutcome =
  | {
      readonly kind: "acknowledged";
      readonly deployment: GatewayProcessObjectV1["deployment"];
      readonly controllerGeneration: number;
    }
  | { readonly kind: "unknown" };

/** Internal protected owner ports, not a second ledger or a public authority
 * factory. Production selection requires their actual authenticated implementations.
 * Durable submission/late retention remains with the original record owner. */
export interface KubernetesInstallationProcessDependencies {
  readonly accepting: {
    accept(
      method: Method,
      input: Input,
      call: GatewayProcessCallV1,
    ): Promise<InstallationProcessAuthorization | undefined>;
    readOriginal(
      locator: GatewayStartupOperationLocatorV1,
      call: GatewayProcessCallV1,
    ): Promise<GatewayProcessObjectV1 | undefined>;
    readCleanup(
      input: GatewayProcessRetirementInputV1,
      call: GatewayProcessCallV1,
    ): Promise<InstallationCleanupResponsibility | undefined>;
    /** This consumes the already retained original claim, independently of the
     * requesting connection's cancellation/currentness. A failed ACK stays unknown. */
    retainCreate(
      submission: GatewayProcessSubmissionV1,
      input: GatewayProcessCreateInputV1,
      outcome: InstallationCreateOutcome,
    ): Promise<GatewayProcessObjectV1 | undefined>;
    retainDescendants(
      original: GatewayProcessObjectV1,
      descendants: InstallationApiDescendants,
    ): Promise<void>;
    retainObservation(
      original: GatewayProcessObjectV1,
      observation: InstallationApiObservation,
    ): Promise<
      | {
          readonly original: GatewayProcessObjectV1;
          readonly observation: InstallationApiObservation;
          readonly evidence: GatewayStartupRecordRefV1;
          readonly observedAt: string;
        }
      | undefined
    >;
  };
  readonly submission: GatewayProcessSubmissionOwnerV1;
  readonly launchPlans: {
    read(
      original: GatewayProcessCreateInputV1 | GatewayProcessObjectV1,
      call: GatewayProcessCallV1,
    ): Promise<InstallationLaunchPlan | undefined>;
  };
  readonly settlement: InstallationSettlementReader;
}

export interface KubernetesInstallationProcessIo {
  clients(): Promise<{
    readonly core: Pick<CoreV1Api, "readNamespace" | "listNamespacedPod">;
    readonly apps: Pick<
      AppsV1Api,
      | "createNamespacedDeployment"
      | "readNamespacedDeployment"
      | "listNamespacedReplicaSet"
      | "deleteNamespacedDeployment"
    >;
  }>;
  request<T>(operation: () => Promise<T>, options?: { readonly mutating?: boolean }): Promise<T>;
}

interface Invocation {
  readonly dependencies: KubernetesInstallationProcessDependencies;
  readonly signal: AbortSignal;
  possibleEffect: boolean;
  current(): Promise<void>;
  assertCurrent(): undefined;
}

function requireValue(value: unknown): asserts value {
  if (!value) throw new Error("Installation process input is unavailable.");
}

function recordRef(value: GatewayStartupRecordRefV1): boolean {
  return (
    typeof value.recordRef === "string" &&
    value.recordRef.length > 0 &&
    Number.isSafeInteger(value.recordVersion) &&
    value.recordVersion > 0
  );
}

function locatorOf(input: Input): GatewayStartupOperationLocatorV1 {
  if ("binding" in input) return input.binding.startup;
  if ("original" in input) return input.original.binding.startup;
  return input;
}

function validateLocator(locator: GatewayStartupOperationLocatorV1): void {
  requireValue(
    locator &&
      typeof locator.installationId === "string" &&
      locator.installationId.length > 0 &&
      typeof locator.processRef === "string" &&
      locator.processRef.length > 0 &&
      Number.isSafeInteger(locator.processGeneration) &&
      locator.processGeneration > 0 &&
      typeof locator.operationRef === "string" &&
      locator.operationRef.length > 0 &&
      typeof locator.operationDigest === "string" &&
      locator.operationDigest.length > 0,
  );
}

function matchesOriginal(
  original: GatewayProcessObjectV1,
  locator: GatewayStartupOperationLocatorV1,
): void {
  requireValue(
    isDeepStrictEqual(original.binding.startup, locator) && recordRef(original.correlation),
  );
  requireValue(
    original.deployment.name === original.target.deploymentName &&
      original.deployment.uid.length > 0 &&
      original.deployment.resourceVersion.length > 0 &&
      Number.isSafeInteger(original.controllerGeneration) &&
      original.controllerGeneration > 0,
  );
}

function validatePlan(
  plan: InstallationLaunchPlan,
  input: GatewayProcessCreateInputV1,
): V1Deployment {
  requireValue(isDeepStrictEqual(plan.input, input));
  const body = immutableCopy(plan.deployment);
  requireValue(
    body.apiVersion === "apps/v1" &&
      body.kind === "Deployment" &&
      body.metadata?.name === input.target.deploymentName &&
      body.metadata.namespace === input.target.namespace.name &&
      body.metadata.uid === undefined &&
      body.metadata.resourceVersion === undefined &&
      body.metadata.generateName === undefined &&
      body.metadata.deletionTimestamp === undefined &&
      body.spec?.replicas === 1 &&
      body.spec.template.spec?.runtimeClassName === GVISOR_RUNTIME_CLASS,
  );
  requireValue(
    body.spec.template.spec.automountServiceAccountToken === false &&
      body.spec.template.spec.hostNetwork !== true &&
      body.spec.template.spec.hostPID !== true &&
      body.spec.template.spec.hostIPC !== true &&
      (body.spec.template.spec.ephemeralContainers?.length ?? 0) === 0,
  );
  const names = new Set<string>();
  for (const container of [
    ...body.spec.template.spec.containers,
    ...(body.spec.template.spec.initContainers ?? []),
  ]) {
    requireValue(
      typeof container.name === "string" &&
        container.name.length > 0 &&
        !names.has(container.name) &&
        typeof container.image === "string" &&
        container.image.length > 0,
    );
    names.add(container.name);
  }
  requireValue(body.spec.template.spec.containers.length > 0);
  return body;
}

function raceAbort<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => undefined);
  });
}

/** One collaborator of the selected Compute Driver. It has no default authority,
 * issuer, independent Kubernetes configuration, or successor allocation path. */
export class KubernetesInstallationProcess implements GatewayProcessParticipantV1 {
  private readonly io: KubernetesInstallationProcessIo;
  private readonly dependencies: KubernetesInstallationProcessDependencies | undefined;
  private readonly retained = new Set<Promise<unknown>>();

  constructor(
    io: KubernetesInstallationProcessIo,
    dependencies?: KubernetesInstallationProcessDependencies,
  ) {
    this.io = io;
    this.dependencies = dependencies;
  }

  private retain(work: Promise<unknown>): void {
    this.retained.add(work);
    // The durable original claim remains authoritative even when retention fails.
    // Keep failed continuations reachable until this participant is retired.
    void work.then(
      () => this.retained.delete(work),
      () => undefined,
    );
  }

  private async invoke<R extends Result>(
    method: Method,
    rawInput: Input,
    call: GatewayProcessCallV1,
    body: (input: Input, invocation: Invocation) => Promise<R>,
  ): Promise<
    | R
    | { readonly kind: "denied" | "unavailable" }
    | { readonly kind: "unknown"; readonly operation: GatewayStartupOperationLocatorV1 }
  > {
    if (this.dependencies === undefined) return { kind: "unavailable" };
    let invocation: Invocation | undefined;
    let locator: GatewayStartupOperationLocatorV1 | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Presence is only a prerequisite; the protected owner still performs all
      // authentication/currentness. Missing retention cannot be discovered after dispatch.
      requireValue(
        this.dependencies.accepting &&
          this.dependencies.submission &&
          this.dependencies.launchPlans &&
          this.dependencies.settlement,
      );
      for (const port of [
        this.dependencies.accepting.accept,
        this.dependencies.accepting.readOriginal,
        this.dependencies.accepting.readCleanup,
        this.dependencies.accepting.retainCreate,
        this.dependencies.accepting.retainDescendants,
        this.dependencies.accepting.retainObservation,
        this.dependencies.submission.claimOriginal,
        this.dependencies.submission.consumeSubmission,
        this.dependencies.launchPlans.read,
        this.dependencies.settlement.readCurrent,
      ])
        requireValue(typeof port === "function");
      const input = immutableCopy(rawInput);
      locator = locatorOf(input);
      validateLocator(locator);
      const bounds = call.authorityCall;
      const expires = Date.parse(bounds.deadline);
      requireValue(Number.isFinite(expires) && new Date(expires).toISOString() === bounds.deadline);
      requireValue(
        bounds.signal instanceof AbortSignal && !bounds.signal.aborted && expires > Date.now(),
      );
      const started = performance.now();
      const remaining = expires - Date.now();
      const deadline = new AbortController();
      timer = setTimeout(
        () => deadline.abort(new Error("Installation process call expired.")),
        Math.min(expires - Date.now(), 2_147_483_647),
      );
      const initialSignal = AbortSignal.any([bounds.signal, deadline.signal]);
      const authorization = await raceAbort(
        initialSignal,
        this.dependencies.accepting.accept(method, input, call),
      );
      if (authorization === undefined) return { kind: "denied" };
      const signal = AbortSignal.any([initialSignal, authorization.signal]);
      const active = () => {
        signal.throwIfAborted();
        requireValue(Date.now() < expires && performance.now() - started < remaining);
      };
      invocation = {
        dependencies: this.dependencies,
        signal,
        possibleEffect: false,
        current: async () => {
          active();
          await raceAbort(signal, authorization.recheckCurrent());
          active();
          requireInstallationFence(authorization.assertCurrent());
          active();
        },
        assertCurrent: () => {
          active();
          requireInstallationFence(authorization.assertCurrent());
          active();
          return undefined;
        },
      };
      await invocation.current();
      const result = await raceAbort(
        signal,
        withComputeAbortSignal(signal, () => body(input, invocation!)),
      );
      invocation.assertCurrent();
      return result;
    } catch {
      return invocation?.possibleEffect && locator !== undefined
        ? { kind: "unknown", operation: locator }
        : { kind: "unavailable" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async createOriginal(
    input: GatewayProcessCreateInputV1,
    call: GatewayProcessCallV1,
  ): Promise<GatewayProcessCreateResultV1> {
    return this.invoke("createOriginal", input, call, async (snapshot, invocation) => {
      requireValue("launchPlan" in snapshot);
      const plan = await invocation.dependencies.launchPlans.read(snapshot, call);
      await invocation.current();
      if (plan === undefined) return { kind: "unavailable" };
      const deployment = validatePlan(plan, snapshot);
      await plan.recheckCurrent();
      await invocation.current();
      const clients = await this.io.clients();
      await invocation.current();
      const namespace = await this.io.request(() => {
        requireInstallationFence(invocation.assertCurrent());
        requireInstallationFence(plan.assertCurrent());
        requireInstallationFence(invocation.assertCurrent());
        return clients.core.readNamespace({ name: snapshot.target.namespace.name });
      });
      await invocation.current();
      await plan.recheckCurrent();
      const ns = installationObjectIdentity(namespace.metadata);
      requireValue(
        namespace.kind === "Namespace" &&
          namespace.apiVersion === "v1" &&
          namespace.metadata?.deletionTimestamp === undefined &&
          ns.name === snapshot.target.namespace.name &&
          ns.uid === snapshot.target.namespace.uid,
      );
      // Claim/COMMIT uncertainty itself prohibits another original submission.
      invocation.possibleEffect = true;
      const claim = await invocation.dependencies.submission.claimOriginal(snapshot, call);
      if (claim.kind !== "claimed") return claim;
      await invocation.current();
      await plan.recheckCurrent();
      requireInstallationFence(invocation.assertCurrent());
      requireInstallationFence(plan.assertCurrent());
      requireInstallationFence(invocation.assertCurrent());
      requireInstallationFence(
        invocation.dependencies.submission.consumeSubmission(claim.submission, snapshot, call),
      );
      const pending = Promise.resolve().then(async (): Promise<GatewayProcessCreateResultV1> => {
        let outcome: InstallationCreateOutcome;
        try {
          const result = await this.io.request(
            () => {
              requireInstallationFence(invocation.assertCurrent());
              requireInstallationFence(plan.assertCurrent());
              requireInstallationFence(invocation.assertCurrent());
              return clients.apps.createNamespacedDeployment({
                namespace: ns.name,
                body: deployment,
              });
            },
            { mutating: true },
          );
          const identity = installationObjectIdentity(result.metadata);
          requireValue(
            result.kind === "Deployment" &&
              result.apiVersion === "apps/v1" &&
              result.metadata?.namespace === ns.name &&
              identity.name === snapshot.target.deploymentName &&
              Number.isSafeInteger(result.metadata.generation) &&
              result.metadata.generation! > 0,
          );
          outcome = {
            kind: "acknowledged",
            deployment: identity,
            controllerGeneration: result.metadata.generation!,
          };
        } catch {
          outcome = { kind: "unknown" };
        }
        // This owner call deliberately uses the original retained ticket, without
        // an aborted caller signal or a substituted fresh authorization context.
        const original = await invocation.dependencies.accepting.retainCreate(
          claim.submission,
          snapshot,
          outcome,
        );
        if (outcome.kind === "unknown" || original === undefined)
          return { kind: "unknown", operation: snapshot.binding.startup };
        matchesOriginal(original, snapshot.binding.startup);
        requireValue(
          isDeepStrictEqual(original.binding, snapshot.binding) &&
            isDeepStrictEqual(original.target, snapshot.target) &&
            isDeepStrictEqual(original.deployment, outcome.deployment) &&
            original.controllerGeneration === outcome.controllerGeneration,
        );
        await invocation.current();
        return { kind: "accepted-object", original };
      });
      this.retain(pending);
      return pending;
    });
  }

  private async discover(
    method: "discoverOriginal" | "recoverOriginal",
    locator: GatewayStartupOperationLocatorV1,
    call: GatewayProcessCallV1,
  ): Promise<GatewayProcessDiscoveryResultV1> {
    return this.invoke(method, locator, call, async (snapshot, invocation) => {
      const operation = locatorOf(snapshot);
      const original = await invocation.dependencies.accepting.readOriginal(operation, call);
      await invocation.current();
      if (original === undefined) return { kind: "unknown", operation };
      matchesOriginal(original, operation);
      // Found means the protected original correlation exists. It is neither a
      // current API observation nor proof that an unknown create cannot settle.
      return { kind: "found", original };
    });
  }

  discoverOriginal(
    locator: GatewayStartupOperationLocatorV1,
    call: GatewayProcessCallV1,
  ): Promise<GatewayProcessDiscoveryResultV1> {
    return this.discover("discoverOriginal", locator, call);
  }

  recoverOriginal(
    locator: GatewayStartupOperationLocatorV1,
    call: GatewayProcessCallV1,
  ): Promise<GatewayProcessRecoveryResultV1> {
    return this.discover("recoverOriginal", locator, call);
  }

  async observeExact(
    input: GatewayProcessObservationInputV1,
    call: GatewayProcessCallV1,
  ): Promise<GatewayProcessObservationResultV1> {
    return this.invoke("observeExact", input, call, async (snapshot, invocation) => {
      requireValue("original" in snapshot);
      const original = await invocation.dependencies.accepting.readOriginal(
        snapshot.original.binding.startup,
        call,
      );
      await invocation.current();
      requireValue(original && isDeepStrictEqual(original, snapshot.original));
      const plan = await invocation.dependencies.launchPlans.read(original, call);
      await invocation.current();
      requireValue(
        plan &&
          isDeepStrictEqual(plan.input.binding, original.binding) &&
          isDeepStrictEqual(plan.input.target, original.target),
      );
      const selectedPlan = validatePlan(plan, plan.input);
      const selectedContainers: InstallationPlannedContainer[] = [];
      for (const [kind, containers] of [
        ["main", selectedPlan.spec!.template.spec!.containers],
        ["init", selectedPlan.spec!.template.spec!.initContainers ?? []],
      ] as const) {
        for (const container of containers)
          selectedContainers.push({ kind, name: container.name, image: container.image! });
      }
      const observation = await observeInstallationApi(
        {
          ...this.io,
          request: (operation, options) =>
            this.io.request(() => {
              requireInstallationFence(invocation.assertCurrent());
              requireInstallationFence(plan.assertCurrent());
              requireInstallationFence(invocation.assertCurrent());
              return operation();
            }, options),
          current: async () => {
            await invocation.current();
            await plan.recheckCurrent();
            requireInstallationFence(invocation.assertCurrent());
            requireInstallationFence(plan.assertCurrent());
            requireInstallationFence(invocation.assertCurrent());
          },
          retainDescendants: async (descendants) => {
            const pending = invocation.dependencies.accepting.retainDescendants(
              original,
              descendants,
            );
            this.retain(pending);
            await pending;
          },
        },
        {
          namespace: original.target.namespace,
          deployment: original.deployment,
          generation: original.controllerGeneration,
          runtimeClassName: GVISOR_RUNTIME_CLASS,
        },
        selectedContainers,
      );
      await invocation.current();
      if (observation.status === "unavailable") return { kind: "unavailable" };
      if (observation.status === "ambiguous") return { kind: "ambiguous", original };
      const retained = await invocation.dependencies.accepting.retainObservation(
        original,
        observation,
      );
      await invocation.current();
      requireValue(
        retained &&
          isDeepStrictEqual(retained.original, original) &&
          isDeepStrictEqual(retained.observation, observation) &&
          recordRef(retained.evidence) &&
          Number.isFinite(Date.parse(retained.observedAt)),
      );
      if (observation.status === "absent")
        return {
          kind: "absent",
          original,
          evidence: retained.evidence,
          observedAt: retained.observedAt,
        };
      // All descendants are retained above. A single-chain result is available
      // only when there is exactly one attributable Pod, including terminal Pods.
      if (observation.ancestry.pods.length !== 1) return { kind: "ambiguous", original };
      const pod = observation.ancestry.pods[0]!;
      const replicaSet = observation.ancestry.replicaSets.find(
        ({ uid }) => uid === pod.replicaSetUid,
      );
      requireValue(replicaSet);
      return {
        kind: "observed",
        original,
        evidence: retained.evidence,
        observedAt: retained.observedAt,
        chain: {
          namespace: observation.ancestry.root.namespace,
          deployment: observation.ancestry.root.deployment,
          replicaSet,
          pod: pod.identity,
        },
      };
    });
  }

  async requestRetirement(
    input: GatewayProcessRetirementInputV1,
    call: GatewayProcessCallV1,
  ): Promise<GatewayProcessRetirementResultV1> {
    return this.invoke("requestRetirement", input, call, async (snapshot, invocation) => {
      requireValue("responsibility" in snapshot);
      const cleanup = await invocation.dependencies.accepting.readCleanup(snapshot, call);
      await invocation.current();
      if (cleanup === undefined) return { kind: "unavailable" };
      // An in-flight retirement may have taken effect even when its caller stops waiting.
      invocation.possibleEffect = true;
      return retireInstallationProcess(
        {
          ...this.io,
          current: invocation.current,
          assertCurrent: invocation.assertCurrent,
          retain: (work) => this.retain(work),
        },
        snapshot,
        cleanup,
      );
    });
  }

  async readReplacementDisposition(
    locator: GatewayStartupOperationLocatorV1,
    call: GatewayProcessCallV1,
  ): Promise<GatewayProcessDispositionResultV1> {
    return this.invoke("readReplacementDisposition", locator, call, async (snapshot, invocation) =>
      readInstallationDisposition(
        invocation.dependencies.settlement,
        locatorOf(snapshot),
        call,
        invocation.current,
      ),
    );
  }
}
