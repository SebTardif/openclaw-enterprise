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
  GatewayProcessParticipantV2,
  GatewayProcessCallV2,
  GatewayProcessCreateInputV2,
  GatewayProcessCreateResultV2,
  GatewayProcessObjectV2,
  GatewayProcessObservationInputV2,
  GatewayProcessObservationResultV2,
  GatewayProcessDiscoveryResultV2,
  GatewayProcessRetirementInputV2,
  GatewayProcessRetirementResultV2,
  GatewayProcessDispositionResultV2,
  GatewayProcessFailureV2,
  GatewayProcessSubmissionOwnerV2,
  GatewayProcessSubmissionV2,
  GatewayStartupOperationLocatorV2,
} from "@openclaw-enterprise/contracts/gateway-startup-v1";
import { deepFreeze, immutableCopy } from "@openclaw-enterprise/utils";
import { isDeepStrictEqual } from "node:util";
import { withComputeAbortSignal } from "../operation-context.ts";
import {
  renderAdmittedGatewayLaunch,
  type AdmittedGatewayLaunchSource,
} from "./admitted-launch-plan.ts";
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

type AgentMethod = keyof GatewayProcessParticipantV2;
type AgentInput<K extends AgentMethod = AgentMethod> = Parameters<
  GatewayProcessParticipantV2[K]
>[0];
type AgentResult = Awaited<ReturnType<GatewayProcessParticipantV2[AgentMethod]>>;

/** The genuine call owner registers the drain before returning this scope. Its
 * settlement outlives the inner submit transaction and joins original retained
 * work even when the visible call has already returned an unknown outcome. */
export interface AgentGatewayInvocationScope {
  settle(): Promise<void>;
}

export interface KubernetesAgentGatewayDependencies {
  readonly invocations: {
    /** Synchronous original call/method/input custody, before accepting or any
     * fence. This enrollment is not admission or current effect authority. */
    enrollInvocation<K extends AgentMethod>(
      method: K,
      input: AgentInput<K>,
      call: GatewayProcessCallV2,
      drain: () => Promise<void>,
    ): AgentGatewayInvocationScope | undefined;
  };
  readonly accepting: {
    accept<K extends AgentMethod>(
      method: K,
      input: AgentInput<K>,
      call: GatewayProcessCallV2,
    ): Promise<InstallationProcessAuthorization | undefined>;
    readOriginal(
      locator: GatewayStartupOperationLocatorV2,
      call: GatewayProcessCallV2,
    ): Promise<GatewayProcessObjectV2 | undefined>;
    readCleanup(
      input: GatewayProcessRetirementInputV2,
      call: GatewayProcessCallV2,
    ): Promise<InstallationCleanupResponsibility<GatewayProcessObjectV2> | undefined>;
    retainCreate(
      submission: GatewayProcessSubmissionV2,
      input: GatewayProcessCreateInputV2,
      outcome: InstallationCreateOutcome,
    ): Promise<GatewayProcessObjectV2 | undefined>;
    retainDescendants(
      original: GatewayProcessObjectV2,
      descendants: InstallationApiDescendants,
    ): Promise<void>;
    retainObservation(
      original: GatewayProcessObjectV2,
      observation: InstallationApiObservation,
    ): Promise<
      | {
          readonly original: GatewayProcessObjectV2;
          readonly observation: InstallationApiObservation;
          readonly evidence: GatewayStartupRecordRefV1;
          readonly observedAt: string;
        }
      | undefined
    >;
  };
  readonly launchPlans: AdmittedGatewayLaunchSource;
  readonly submission: GatewayProcessSubmissionOwnerV2;
  readonly settlement: InstallationSettlementReader<
    GatewayStartupOperationLocatorV2,
    GatewayProcessCallV2
  >;
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
      typeof body.spec.template.spec?.runtimeClassName === "string" &&
      body.spec.template.spec.runtimeClassName.length > 0 &&
      body.spec.template.spec.runtimeClassName.trim() === body.spec.template.spec.runtimeClassName,
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
  readonly agent: GatewayProcessParticipantV2;

  constructor(
    io: KubernetesInstallationProcessIo,
    dependencies?: KubernetesInstallationProcessDependencies,
    agentDependencies?: KubernetesAgentGatewayDependencies,
  ) {
    this.io = io;
    this.dependencies = dependencies;
    this.agent = new AgentGatewayProcess(io, agentDependencies, (work) => this.retain(work));
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
          runtimeClassName: selectedPlan.spec!.template.spec!.runtimeClassName!,
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
        (work) => requireInstallationFence(work()),
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
        (work) => requireInstallationFence(work()),
      ),
    );
  }
}

interface AgentInvocation {
  readonly dependencies: KubernetesAgentGatewayDependencies;
  signal: AbortSignal;
  possibleEffect: boolean;
  track<T>(work: Promise<T>): Promise<T>;
  fence(work: () => unknown): void;
  assertLocal(): void;
  current(): Promise<void>;
  assertCurrent(): undefined;
}

function agentLocator(input: AgentInput): GatewayStartupOperationLocatorV2 {
  if ("binding" in input) return input.binding.startup;
  if ("original" in input) return input.original.binding.startup;
  return input;
}

function requireAgentLocator(locator: GatewayStartupOperationLocatorV2): void {
  requireValue(locator.schemaVersion === 2 && locator.subject.kind === "agent-gateway");
  for (const value of [
    locator.subject.installationId,
    locator.subject.namespaceRef,
    locator.subject.agentRef,
    locator.processRef,
    locator.operationRef,
    locator.operationDigest,
  ])
    requireValue(typeof value === "string" && value.length > 0);
  requireValue(Number.isSafeInteger(locator.processGeneration) && locator.processGeneration > 0);
}

function matchesAgentOriginal(
  original: GatewayProcessObjectV2,
  locator: GatewayStartupOperationLocatorV2,
): void {
  requireAgentLocator(locator);
  requireValue(
    original.binding.schemaVersion === 2 &&
      isDeepStrictEqual(original.binding.startup, locator) &&
      original.binding.agentRef === locator.subject.agentRef &&
      original.binding.namespaceRef === locator.subject.namespaceRef &&
      original.deployment.name === original.target.deploymentName &&
      recordRef(original.correlation) &&
      Number.isSafeInteger(original.controllerGeneration) &&
      original.controllerGeneration > 0,
  );
  installationObjectIdentity(original.deployment);
  installationObjectIdentity(original.target.namespace);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function invocationScope(value: unknown): value is AgentGatewayInvocationScope {
  return (
    value !== null &&
    typeof value === "object" &&
    "settle" in value &&
    typeof value.settle === "function"
  );
}

/** Current Agent protocol of the same selected collaborator. It borrows the
 * same cached client and request path; it has no creator or authority fallback. */
class AgentGatewayProcess implements GatewayProcessParticipantV2 {
  private readonly io: KubernetesInstallationProcessIo;
  private readonly dependencies: KubernetesAgentGatewayDependencies | undefined;
  private readonly retain: (work: Promise<unknown>) => void;

  constructor(
    io: KubernetesInstallationProcessIo,
    dependencies: KubernetesAgentGatewayDependencies | undefined,
    retain: (work: Promise<unknown>) => void,
  ) {
    this.io = io;
    this.dependencies = dependencies;
    this.retain = retain;
  }

  async createOriginal(
    input: GatewayProcessCreateInputV2,
    call: GatewayProcessCallV2,
  ): Promise<GatewayProcessCreateResultV2> {
    return this.invoke("createOriginal", input, call, async (snapshot, invocation) => {
      const plan = await invocation.dependencies.launchPlans.read(snapshot, call);
      await invocation.current();
      if (plan === undefined) return { kind: "unavailable" };
      const { deployment } = renderAdmittedGatewayLaunch(snapshot, plan.record);
      await plan.recheckCurrent();
      await invocation.current();
      const clients = await this.io.clients();
      await invocation.current();
      const assertPlan = () => {
        invocation.assertCurrent();
        invocation.fence(() => plan.assertCurrent());
        invocation.assertCurrent();
      };
      const namespace = await this.io.request(() => {
        assertPlan();
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
      // The original durable submission claim can itself become uncertain.
      invocation.possibleEffect = true;
      const claim = await invocation.dependencies.submission.claimOriginal(snapshot, call);
      if (claim.kind !== "claimed") return claim;
      await invocation.current();
      await plan.recheckCurrent();
      const pending = invocation.track(
        Promise.resolve().then(async (): Promise<GatewayProcessCreateResultV2> => {
          let outcome: InstallationCreateOutcome;
          try {
            const result = await this.io.request(
              () => {
                assertPlan();
                // Consume the same original ticket at the actual SDK boundary. No
                // await, owner callback, or replacement scope intervenes afterwards.
                const consumed: unknown = invocation.dependencies.submission.consumeSubmission(
                  claim.submission,
                  snapshot,
                  call,
                );
                if (consumed !== undefined) {
                  invocation.track(Promise.resolve(consumed));
                  throw new Error("An Agent Gateway submission must be synchronous.");
                }
                invocation.assertLocal();
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
          // The whole invocation owns this late continuation even after its inner
          // claim COMMIT or visible cancellation. No fresh call replaces it.
          const original = await invocation.dependencies.accepting.retainCreate(
            claim.submission,
            snapshot,
            outcome,
          );
          if (outcome.kind === "unknown" || original === undefined)
            return { kind: "unknown", operation: snapshot.binding.startup };
          matchesAgentOriginal(original, snapshot.binding.startup);
          requireValue(
            isDeepStrictEqual(original.binding, snapshot.binding) &&
              isDeepStrictEqual(original.target, snapshot.target) &&
              isDeepStrictEqual(original.deployment, outcome.deployment) &&
              original.controllerGeneration === outcome.controllerGeneration,
          );
          await invocation.current();
          return { kind: "accepted-object", original };
        }),
      );
      return pending;
    });
  }

  private async discover(
    method: "discoverOriginal" | "recoverOriginal",
    locator: GatewayStartupOperationLocatorV2,
    call: GatewayProcessCallV2,
  ): Promise<GatewayProcessDiscoveryResultV2> {
    return this.invoke(method, locator, call, async (snapshot, invocation) => {
      const original = await invocation.dependencies.accepting.readOriginal(snapshot, call);
      await invocation.current();
      if (original === undefined) return { kind: "unknown", operation: snapshot };
      matchesAgentOriginal(original, snapshot);
      return { kind: "found", original };
    });
  }

  discoverOriginal(
    locator: GatewayStartupOperationLocatorV2,
    call: GatewayProcessCallV2,
  ): Promise<GatewayProcessDiscoveryResultV2> {
    return this.discover("discoverOriginal", locator, call);
  }

  recoverOriginal(
    locator: GatewayStartupOperationLocatorV2,
    call: GatewayProcessCallV2,
  ): Promise<GatewayProcessDiscoveryResultV2> {
    return this.discover("recoverOriginal", locator, call);
  }

  async observeExact(
    input: GatewayProcessObservationInputV2,
    call: GatewayProcessCallV2,
  ): Promise<GatewayProcessObservationResultV2> {
    return this.invoke("observeExact", input, call, async (snapshot, invocation) => {
      const original = await invocation.dependencies.accepting.readOriginal(
        snapshot.original.binding.startup,
        call,
      );
      await invocation.current();
      requireValue(original && isDeepStrictEqual(original, snapshot.original));
      matchesAgentOriginal(original, snapshot.original.binding.startup);
      const plan = await invocation.dependencies.launchPlans.read(original, call);
      await invocation.current();
      requireValue(plan);
      const { deployment } = renderAdmittedGatewayLaunch(original, plan.record);
      const selectedContainers: InstallationPlannedContainer[] = [];
      for (const [kind, containers] of [
        ["main", deployment.spec!.template.spec!.containers],
        ["init", deployment.spec!.template.spec!.initContainers ?? []],
      ] as const)
        for (const container of containers)
          selectedContainers.push({ kind, name: container.name, image: container.image! });
      const observation = await observeInstallationApi(
        {
          ...this.io,
          request: (operation, options) =>
            this.io.request(() => {
              invocation.assertCurrent();
              invocation.fence(() => plan.assertCurrent());
              invocation.assertCurrent();
              return operation();
            }, options),
          current: async () => {
            await invocation.current();
            await plan.recheckCurrent();
            invocation.assertCurrent();
            invocation.fence(() => plan.assertCurrent());
            invocation.assertCurrent();
          },
          retainDescendants: (descendants) =>
            invocation.track(
              invocation.dependencies.accepting.retainDescendants(original, descendants),
            ),
        },
        {
          namespace: original.target.namespace,
          deployment: original.deployment,
          generation: original.controllerGeneration,
          runtimeClassName: deployment.spec!.template.spec!.runtimeClassName!,
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
    input: GatewayProcessRetirementInputV2,
    call: GatewayProcessCallV2,
  ): Promise<GatewayProcessRetirementResultV2> {
    return this.invoke("requestRetirement", input, call, async (snapshot, invocation) => {
      matchesAgentOriginal(snapshot.original, snapshot.original.binding.startup);
      const cleanup = await invocation.dependencies.accepting.readCleanup(snapshot, call);
      await invocation.current();
      if (cleanup === undefined) return { kind: "unavailable" };
      invocation.possibleEffect = true;
      return retireInstallationProcess(
        {
          ...this.io,
          current: invocation.current,
          assertCurrent: invocation.assertCurrent,
          retain: (pending) => {
            invocation.track(pending);
          },
        },
        snapshot,
        cleanup,
        invocation.fence,
      );
    });
  }

  async readReplacementDisposition(
    locator: GatewayStartupOperationLocatorV2,
    call: GatewayProcessCallV2,
  ): Promise<GatewayProcessDispositionResultV2> {
    return this.invoke("readReplacementDisposition", locator, call, async (snapshot, invocation) =>
      readInstallationDisposition(
        invocation.dependencies.settlement,
        snapshot,
        call,
        invocation.current,
        invocation.fence,
      ),
    );
  }

  private async invoke<K extends AgentMethod, R extends AgentResult>(
    method: K,
    rawInput: AgentInput<K>,
    call: GatewayProcessCallV2,
    work: (input: AgentInput<K>, invocation: AgentInvocation) => Promise<R>,
  ): Promise<R | GatewayProcessFailureV2> {
    const dependencies = this.dependencies;
    if (dependencies === undefined) return { kind: "unavailable" };
    const pending = new Set<Promise<unknown>>();
    let closed = false;
    let failed = false;
    let scope: AgentGatewayInvocationScope | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let locator: GatewayStartupOperationLocatorV2 | undefined;
    let invocation: AgentInvocation | undefined;
    const track = <T>(promise: Promise<T>): Promise<T> => {
      pending.add(promise);
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      );
      this.retain(promise);
      return promise;
    };
    const drain = async () => {
      closed = true;
      while (pending.size > 0) await Promise.allSettled([...pending]);
    };
    try {
      requireValue(
        dependencies.invocations &&
          dependencies.accepting &&
          dependencies.launchPlans &&
          dependencies.submission &&
          dependencies.settlement,
      );
      for (const port of [
        dependencies.invocations.enrollInvocation,
        dependencies.accepting.accept,
        dependencies.accepting.readOriginal,
        dependencies.accepting.readCleanup,
        dependencies.accepting.retainCreate,
        dependencies.accepting.retainDescendants,
        dependencies.accepting.retainObservation,
        dependencies.launchPlans.read,
        dependencies.submission.claimOriginal,
        dependencies.submission.consumeSubmission,
        dependencies.settlement.readCurrent,
      ])
        requireValue(typeof port === "function");
      // Preserve the method-indexed argument type while performing the same
      // clone-and-freeze operation as immutableCopy.
      const input = structuredClone(rawInput);
      deepFreeze(input);
      locator = agentLocator(input);
      requireAgentLocator(locator);
      // This synchronous original-owner registration precedes accepting itself.
      // A deferred enrollment can never be upgraded into an accepted call.
      const enrolled: unknown = dependencies.invocations.enrollInvocation(
        method,
        input,
        call,
        drain,
      );
      if (isThenable(enrolled)) {
        const late = Promise.resolve(enrolled).then(async (value) => {
          closed = true;
          if (invocationScope(value)) await value.settle();
        });
        this.retain(late);
        return { kind: "unavailable" };
      }
      if (!invocationScope(enrolled)) return { kind: "unavailable" };
      scope = enrolled;
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
        () => deadline.abort(new Error("Agent Gateway call expired.")),
        Math.min(remaining, 2_147_483_647),
      );
      const signal = AbortSignal.any([bounds.signal, deadline.signal]);
      const assertLocal = () => {
        requireValue(!closed && !failed);
        signal.throwIfAborted();
        invocation?.signal.throwIfAborted();
        requireValue(Date.now() < expires && performance.now() - started < remaining);
      };
      const fence = (callback: () => unknown) => {
        assertLocal();
        try {
          const result = callback();
          if (result !== undefined) {
            track(Promise.resolve(result));
            throw new Error("An Agent Gateway fence must be synchronous.");
          }
          assertLocal();
        } catch (error) {
          failed = true;
          throw error;
        }
      };
      let authorization: InstallationProcessAuthorization | undefined;
      const current = async () => {
        fence(() => undefined);
        requireValue(authorization);
        await track(Promise.resolve().then(() => authorization!.recheckCurrent()));
        fence(() => authorization!.assertCurrent());
        authorization.signal.throwIfAborted();
      };
      invocation = {
        dependencies,
        signal,
        possibleEffect: false,
        track,
        fence,
        current,
        assertLocal,
        assertCurrent: () => {
          fence(() => {
            requireValue(authorization);
            authorization.signal.throwIfAborted();
            return authorization.assertCurrent();
          });
          return undefined;
        },
      };
      const active = invocation;
      const accepted = track(
        Promise.resolve().then(async (): Promise<R | GatewayProcessFailureV2> => {
          fence(() => undefined);
          authorization = await dependencies.accepting.accept(method, input, call);
          fence(() => undefined);
          if (authorization === undefined) return { kind: "denied" };
          active.signal = AbortSignal.any([signal, authorization.signal]);
          await active.current();
          const body = track(
            Promise.resolve().then(() =>
              withComputeAbortSignal(active.signal, () => work(input, active)),
            ),
          );
          const result = await raceAbort(active.signal, body);
          active.assertCurrent();
          return result;
        }),
      );
      return await raceAbort(signal, accepted);
    } catch {
      return invocation?.possibleEffect && locator !== undefined
        ? { kind: "unknown", operation: locator }
        : { kind: "unavailable" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (scope !== undefined) {
        // The original owner retains this settlement. Do not put it into pending:
        // it joins drain and must not wait on itself. Visible unknown can precede
        // physical/retention settlement, whose original ownership remains intact.
        this.retain(Promise.resolve().then(() => scope!.settle()));
      } else {
        closed = true;
      }
    }
  }
}
