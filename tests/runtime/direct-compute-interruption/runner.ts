import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  canonicalRuntimeEffectRequestV1,
  parseRuntimeEffectExchangeV1,
  parseRuntimeEffectsResponseV1,
  parseRuntimeEffectsV1,
  RUNTIME_EFFECT_LIMITS_V1,
  type ConditionalRouteV1,
  type ExactCleanupV1,
  type ExactCreateEffectV1,
  type RuntimeCreateV1,
  type RuntimeEffectBindingV1,
  type RuntimeEffectCallV1,
  type RuntimeEffectStateV1,
  type RuntimeEffectsV1,
  type RuntimeObservationInputV1,
  type RuntimeProviderTargetV1,
} from "../../../packages/contracts/src/runtime-effects-v1.ts";
import { SCENARIOS, type Scenario, type ScenarioMethod } from "./scenarios.ts";

type Request = RuntimeCreateV1 | ConditionalRouteV1 | RuntimeObservationInputV1;
type Mutation = RuntimeCreateV1 | ConditionalRouteV1 | ExactCleanupV1;
type Checkpoint = "possible-submission" | "response-produced";
type Ports = Pick<
  RuntimeEffectsV1,
  "create" | "observe" | "setRoute" | "discover" | "readEffect" | "stopRetainingState"
>;

export interface SourceBinding {
  readonly commit: string;
  readonly tree: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}
export interface PreparationBinding {
  readonly schemaVersion: 1;
  readonly evidenceKind: "controlled-preparation";
  readonly source: SourceBinding;
  readonly fixtureRef: string;
  readonly imageDigests: readonly { readonly name: string; readonly digest: string }[];
  readonly imageSetDigest: string;
  readonly configurationDigest: string;
  readonly runtimeProfileDigest: string;
  readonly ownedResources: readonly RuntimeProviderTargetV1[];
}
export interface ScenarioInput {
  readonly scenarioId: string;
  readonly binding: PreparationBinding;
  readonly request: Request;
  readonly cleanup: ExactCleanupV1 | null;
  readonly callTimeoutMs: number;
  readonly maxReadbacks: number;
}
export interface ControlledSession {
  readonly effects: Ports;
  /** Supplied by the existing caller; this runner cannot authenticate or mint it. */
  readonly context: RuntimeEffectCallV1["context"];
  readonly recipientRef: string;
}
export interface RunnerOptions {
  readonly signal: AbortSignal;
  /** The controlled fixture calls checkpoints at its transport boundary. */
  readonly openSession: (checkpoint: (phase: Checkpoint) => void) => ControlledSession;
}
type Attempt =
  | { kind: "response"; value: unknown }
  | { kind: "not-invoked"; reason: "cancelled" | "deadline" }
  | { kind: "unavailable"; reason: "cancelled" | "deadline" | "call-failed" };
export interface Outcome {
  readonly status:
    "not-invoked" | "unresolved" | "settled" | "observed" | "unsupported" | "invalid-response";
  readonly reason: string;
  readonly response?: unknown;
}
export interface ScenarioReport {
  readonly schemaVersion: 1;
  readonly evidenceKind: "controlled-preparation";
  readonly scenario: Scenario;
  readonly binding: PreparationBinding;
  readonly request: Request;
  readonly canonicalRequest: string | null;
  readonly cleanupRequest: ExactCleanupV1 | null;
  readonly cleanupCanonicalRequest: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
  readonly limits: {
    readonly callTimeoutMs: number;
    readonly maxReadbacks: number;
    readonly maxScenarioAwaitMs: number;
  };
  readonly checkpointReached: boolean;
  readonly primary: Outcome;
  readonly resolution: Outcome;
  readonly cleanup: Outcome;
  readonly cleanupResolution: Outcome;
  readonly events: readonly { sequence: number; phase: string; at: string; detail?: unknown }[];
  readonly runtimeMeasurements: {
    accessDenied: "unmeasured";
    routeRemoved: "unmeasured";
    cancellationOutcome: "unmeasured";
    executionTerminated: "unmeasured";
    credentialRevocation: "unmeasured";
  };
}

const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const digest = (value: unknown) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 200;
const sameData = (left: unknown, right: unknown) =>
  isDeepStrictEqual(left, right, { skipPrototype: true });
function matchesExecutionTuple(execution: RuntimeEffectBindingV1, binding: PreparationBinding) {
  const byName = (left: { name: string }, right: { name: string }) =>
    left.name.localeCompare(right.name);
  return (
    execution.admittedConfigurationDigest === binding.configurationDigest &&
    execution.profileDigests.runtime === binding.runtimeProfileDigest &&
    sameData([...execution.imageDigests].sort(byName), [...binding.imageDigests].sort(byName))
  );
}
function requireInput(condition: unknown): asserts condition {
  if (!condition) throw new Error("Incomplete or inconsistent interruption preparation input.");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function isMutation(request: Request): request is RuntimeCreateV1 | ConditionalRouteV1 {
  return request.kind === "create" || request.kind === "set-route";
}
function canonicalMutation(request: Mutation): string {
  const canonical = canonicalRuntimeEffectRequestV1(request);
  requireInput(hash(canonical) === request.effect.requestDigest);
  return canonical;
}
function requestFor(method: ScenarioMethod, input: unknown): Request {
  const parsers = {
    create: () => parseRuntimeEffectsV1("create", input),
    observe: () => parseRuntimeEffectsV1("observationInput", input),
    setRoute: () => parseRuntimeEffectsV1("setRoute", input),
  };
  return parsers[method]();
}
function validate(input: ScenarioInput) {
  const scenario = SCENARIOS.find(({ id }) => id === input.scenarioId);
  requireInput(scenario);
  requireInput(
    Number.isSafeInteger(input.callTimeoutMs) &&
      input.callTimeoutMs >= 1 &&
      input.callTimeoutMs <= RUNTIME_EFFECT_LIMITS_V1.providerRequestMaxMs,
  );
  requireInput(
    Number.isSafeInteger(input.maxReadbacks) && input.maxReadbacks >= 1 && input.maxReadbacks <= 3,
  );
  // Snapshot before invoking injected code. Future caller mutations cannot change retained bytes.
  const binding = structuredClone(input.binding);
  requireInput(binding?.schemaVersion === 1 && binding.evidenceKind === "controlled-preparation");
  requireInput(
    /^[a-f0-9]{40}$/.test(binding.source?.commit) && /^[a-f0-9]{40}$/.test(binding.source?.tree),
  );
  requireInput(
    Array.isArray(binding.source.files) &&
      binding.source.files.length > 0 &&
      binding.source.files.length <= 128,
  );
  requireInput(
    binding.source.files.every(
      (file) =>
        text(file.path) &&
        !file.path.startsWith("/") &&
        !file.path.split("/").includes("..") &&
        digest(file.sha256),
    ),
  );
  requireInput(
    new Set(binding.source.files.map((file) => file.path)).size === binding.source.files.length,
  );
  requireInput(
    text(binding.fixtureRef) &&
      digest(binding.imageSetDigest) &&
      digest(binding.configurationDigest) &&
      digest(binding.runtimeProfileDigest),
  );
  requireInput(
    Array.isArray(binding.imageDigests) &&
      binding.imageDigests.length > 0 &&
      binding.imageDigests.length <= 16 &&
      binding.imageDigests.every((image) => text(image.name) && digest(image.digest)),
  );
  requireInput(
    new Set(binding.imageDigests.map((image) => image.name)).size === binding.imageDigests.length,
  );
  requireInput(
    Array.isArray(binding.ownedResources) &&
      binding.ownedResources.length > 0 &&
      binding.ownedResources.length <= 32,
  );
  binding.ownedResources.forEach((resource) => parseRuntimeEffectsV1("providerTarget", resource));
  const owns = (resource: RuntimeProviderTargetV1) =>
    binding.ownedResources.some((owned) => sameData(owned, resource));
  const request = requestFor(scenario.method, input.request);
  const canonical = isMutation(request) ? canonicalMutation(request) : null;
  const target = isMutation(request) ? request.effect.target : request.target;
  if (isMutation(request)) requireInput(owns(request.providerTarget));
  if (request.kind === "create") {
    requireInput(
      request.admittedRuntime.imageSetDigest === binding.imageSetDigest &&
        request.admittedRuntime.configurationDigest === binding.configurationDigest &&
        request.admittedRuntime.runtimeProfileDigest === binding.runtimeProfileDigest,
    );
  }
  if (request.kind === "preallocated-candidate")
    requireInput(owns(request.createEffect.providerTarget));
  if (request.kind === "bound-instance")
    requireInput(
      binding.ownedResources.some(
        (resource) =>
          resource.apiKind === "Deployment" &&
          resource.clusterRef === request.binding.clusterRef &&
          resource.kubernetesNamespaceUid === request.binding.kubernetesNamespaceUid &&
          sameData(resource.ownerAssignmentRef, request.target.assignmentRef) &&
          resource.ownerCreateEffectRef === request.target.createEffectRef,
      ),
    );
  let knownExecution: RuntimeEffectBindingV1 | null = null;
  if (request.kind === "bound-instance") knownExecution = request.binding;
  if (request.kind === "set-route" && request.desiredRoute.kind === "active")
    knownExecution = request.desiredRoute.binding;
  if (knownExecution) requireInput(matchesExecutionTuple(knownExecution, binding));
  const cleanup =
    input.cleanup === null ? null : parseRuntimeEffectsV1("stopRetainingState", input.cleanup);
  const cleanupCanonical = cleanup ? canonicalMutation(cleanup) : null;
  if (cleanup) {
    requireInput(sameData(cleanup.effect.target, target) && owns(cleanup.providerTarget));
    requireInput(!isMutation(request) || cleanup.effect.effectRef !== request.effect.effectRef);
    requireInput(matchesExecutionTuple(cleanup.binding, binding));
    if (knownExecution) requireInput(sameData(cleanup.binding, knownExecution));
    if (request.kind === "create" && request.predicate.kind === "expected-object")
      requireInput(cleanup.binding.deploymentUid === request.predicate.uid);
  }
  return {
    scenario,
    binding: freeze(binding),
    request,
    canonical,
    cleanup,
    cleanupCanonical,
    callTimeoutMs: input.callTimeoutMs,
    maxReadbacks: input.maxReadbacks,
  };
}

function classify(result: RuntimeEffectStateV1): Outcome {
  if (result.status === "unknown" || result.status === "not-found")
    return { status: "unresolved", reason: result.status, response: result };
  if (result.status === "unsupported")
    return { status: "unsupported", reason: result.status, response: result };
  return { status: "settled", reason: result.status, response: result };
}
function mutationResponse(request: Mutation, response: unknown): Outcome {
  return classify(parseRuntimeEffectExchangeV1(request, response));
}
function readbackResponse(request: Mutation, response: unknown): Outcome {
  const result = parseRuntimeEffectsResponseV1("readEffect", request.effect, response);
  // Locator correlation alone cannot validate an applied UID, route or termination receipt.
  return result.status === "not-found" ? classify(result) : mutationResponse(request, result);
}
function observationResponse(
  request: RuntimeObservationInputV1,
  response: unknown,
  binding: PreparationBinding,
): Outcome {
  const result = parseRuntimeEffectsResponseV1("observe", request, response);
  if (result.status === "complete") {
    requireInput(
      binding.ownedResources.some((resource) => sameData(resource, result.object.target)),
    );
    requireInput(matchesExecutionTuple(result.binding, binding));
  }
  return {
    status: result.status === "complete" ? "observed" : "unresolved",
    reason: result.status,
    response: result,
  };
}
function decode(attempt: Attempt, parse: (response: unknown) => Outcome): Outcome {
  if (attempt.kind === "not-invoked") return { status: "not-invoked", reason: attempt.reason };
  if (attempt.kind === "unavailable") return { status: "unresolved", reason: attempt.reason };
  try {
    return parse(attempt.value);
  } catch {
    return { status: "invalid-response", reason: "contract-or-correlation-failed" };
  }
}
function cleanupConflictsWithResolution(
  request: Request,
  resolution: Outcome,
  cleanup: ExactCleanupV1,
): boolean {
  if (resolution.status === "observed" && !isMutation(request)) {
    const observed = parseRuntimeEffectsResponseV1("observe", request, resolution.response);
    return observed.status === "complete" && !sameData(observed.binding, cleanup.binding);
  }
  if (resolution.status === "settled" && request.kind === "create") {
    const result = parseRuntimeEffectExchangeV1(request, resolution.response);
    return result.status === "applied" && result.object.uid !== cleanup.binding.deploymentUid;
  }
  return false;
}

/** Finite controlled orchestration. There is no provider factory or replacement/restore API. */
export async function runInterruptionScenario(
  input: ScenarioInput,
  options: RunnerOptions,
): Promise<ScenarioReport> {
  const prepared = validate(input);
  const {
    scenario,
    binding,
    request,
    canonical,
    cleanup,
    cleanupCanonical,
    callTimeoutMs,
    maxReadbacks,
  } = prepared;
  requireInput(options.signal instanceof AbortSignal && typeof options.openSession === "function");
  const { signal, openSession } = options;
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const events: { sequence: number; phase: string; at: string; detail?: unknown }[] = [];
  const record = (phase: string, detail?: unknown) =>
    events.push({
      sequence: events.length + 1,
      phase,
      at: new Date().toISOString(),
      ...(detail === undefined ? {} : { detail }),
    });
  let checkpointReached = scenario.interruption === "before-call";
  let activePrimary: AbortController | null = null;
  let lastCheckpoint: Checkpoint | null = null;
  let checkpointInvalid = false;
  const session =
    scenario.interruption === "before-call" || signal.aborted
      ? null
      : openSession((phase) => {
          if (!activePrimary || activePrimary.signal.aborted) return;
          if (
            (phase !== "possible-submission" && phase !== "response-produced") ||
            (phase === "possible-submission" && lastCheckpoint !== null) ||
            (phase === "response-produced" && lastCheckpoint !== "possible-submission")
          ) {
            checkpointInvalid = true;
            activePrimary.abort();
            return;
          }
          lastCheckpoint = phase;
          record(`checkpoint/${phase}`);
          if (
            (scenario.interruption === "in-flight" && phase === "possible-submission") ||
            (scenario.interruption === "lost-acknowledgment" && phase === "response-produced")
          ) {
            checkpointReached = true;
            activePrimary.abort();
          }
        });
  if (session) {
    requireInput(
      text(session.recipientRef) && session.context && typeof session.effects === "object",
    );
    for (const method of [
      "create",
      "observe",
      "setRoute",
      "discover",
      "readEffect",
      "stopRetainingState",
    ] as const)
      requireInput(typeof session.effects[method] === "function");
  }
  let callIndex = 0;
  async function invoke(
    name: string,
    operation: (call: RuntimeEffectCallV1) => Promise<unknown>,
    primary = false,
  ): Promise<Attempt> {
    if (signal.aborted) return { kind: "not-invoked", reason: "cancelled" };
    const controller = new AbortController();
    if (primary) activePrimary = controller;
    let reason: "cancelled" | "deadline" = "cancelled";
    const outerAbort = () => controller.abort();
    signal.addEventListener("abort", outerAbort, { once: true });
    let abortListener: (() => void) | undefined;
    const interrupted = new Promise<Attempt>((resolve) => {
      abortListener = () => resolve({ kind: "unavailable", reason });
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    const timer = setTimeout(() => {
      reason = "deadline";
      controller.abort();
    }, callTimeoutMs);
    const call: RuntimeEffectCallV1 = {
      requestRef: `controlled-interruption/${++callIndex}`,
      recipientRef: session!.recipientRef,
      context: session!.context,
      deadline: new Date(Date.now() + callTimeoutMs).toISOString(),
      signal: controller.signal,
    };
    let dispatched = false;
    try {
      // Cancellation is rechecked at dispatch, after the scheduling microtask gap.
      // Rejection is handled even if a late completion loses the bounded wait.
      const response = Promise.resolve().then(async (): Promise<Attempt> => {
        if (controller.signal.aborted || signal.aborted) return { kind: "not-invoked", reason };
        dispatched = true;
        record(`call/${name}`, { deadline: call.deadline, requestRef: call.requestRef });
        try {
          return { kind: "response", value: await operation(call) };
        } catch {
          return { kind: "unavailable", reason: "call-failed" };
        }
      });
      const returned = await Promise.race([interrupted, response]);
      const outcome: Attempt = dispatched ? returned : { kind: "not-invoked", reason };
      record(`return/${name}`, {
        kind: outcome.kind,
        ...(outcome.kind !== "response" ? { reason: outcome.reason } : {}),
      });
      return outcome;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", outerAbort);
      if (abortListener) controller.signal.removeEventListener("abort", abortListener);
      if (primary) activePrimary = null;
    }
  }
  let primary: Outcome = {
    status: "not-invoked",
    reason: signal.aborted ? "owner-cancelled" : "before-call",
  };
  let resolution: Outcome = primary;
  let cleanupOutcome: Outcome = {
    status: "not-invoked",
    reason: cleanup ? "primary-not-invoked" : "no-preaccepted-cleanup",
  };
  let cleanupResolution = cleanupOutcome;
  if (session) {
    const effects = session.effects;
    const callPrimary = (call: RuntimeEffectCallV1) => {
      if (request.kind === "create") return effects.create(request, call);
      if (request.kind === "set-route") return effects.setRoute(request, call);
      return effects.observe(request, call);
    };
    primary = decode(await invoke(scenario.method, callPrimary, true), (response) =>
      isMutation(request)
        ? mutationResponse(request, response)
        : observationResponse(request, response, binding),
    );
    if (checkpointInvalid)
      primary = { status: "invalid-response", reason: "invalid-checkpoint-order" };
    resolution = primary;
    if (primary.status === "unresolved" || primary.status === "invalid-response") {
      for (let attempt = 0; attempt < maxReadbacks && !signal.aborted; attempt++) {
        if (request.kind === "create") {
          const exact: ExactCreateEffectV1 = parseRuntimeEffectsV1("exactCreate", {
            schemaVersion: 1,
            effect: request.effect,
            providerTarget: request.providerTarget,
            expectedObject: null,
          });
          const discovered = await invoke("discover", (call) => effects.discover(exact, call));
          if (discovered.kind === "response") {
            try {
              record(
                "discovery",
                parseRuntimeEffectsResponseV1("discover", exact, discovered.value),
              );
            } catch {
              record("discovery-invalid", { reason: "contract-or-correlation-failed" });
            }
          }
          // Discovery (including zero candidates) cannot settle an original possibly pending create.
        }
        resolution = decode(
          await invoke(isMutation(request) ? "readEffect" : "observe-readback", (call) =>
            isMutation(request)
              ? effects.readEffect(request.effect, call)
              : effects.observe(request, call),
          ),
          (response) =>
            isMutation(request)
              ? readbackResponse(request, response)
              : observationResponse(request, response, binding),
        );
        record("resolution", resolution);
        if (resolution.status !== "unresolved") break;
      }
    }
    // Cleanup has its own preaccepted effect and result. It cannot overwrite the primary failure.
    if (cleanup && cleanupConflictsWithResolution(request, resolution, cleanup)) {
      cleanupOutcome = { status: "not-invoked", reason: "resolved-execution-mismatch" };
      cleanupResolution = cleanupOutcome;
    } else if (cleanup && !signal.aborted) {
      cleanupOutcome = decode(
        await invoke("stopRetainingState", (call) => effects.stopRetainingState(cleanup, call)),
        (response) => mutationResponse(cleanup, response),
      );
      cleanupResolution = cleanupOutcome;
      if (cleanupOutcome.status === "unresolved" || cleanupOutcome.status === "invalid-response") {
        for (let attempt = 0; attempt < maxReadbacks && !signal.aborted; attempt++) {
          const next = decode(
            await invoke("cleanup-readEffect", (call) => effects.readEffect(cleanup.effect, call)),
            (response) => readbackResponse(cleanup, response),
          );
          record("cleanup-resolution", next);
          cleanupResolution = next;
          if (next.status !== "unresolved") break;
        }
      }
    } else if (cleanup) {
      cleanupOutcome = { status: "not-invoked", reason: "owner-cancelled" };
      cleanupResolution = cleanupOutcome;
    }
  }
  return freeze({
    schemaVersion: 1,
    evidenceKind: "controlled-preparation",
    scenario,
    binding,
    request,
    canonicalRequest: canonical,
    cleanupRequest: cleanup,
    cleanupCanonicalRequest: cleanupCanonical,
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: performance.now() - started,
    limits: {
      callTimeoutMs,
      maxReadbacks,
      maxScenarioAwaitMs:
        (1 +
          (request.kind === "create" ? 2 : 1) * maxReadbacks +
          (cleanup ? 1 + maxReadbacks : 0)) *
        callTimeoutMs,
    },
    checkpointReached,
    primary,
    resolution,
    cleanup: cleanupOutcome,
    cleanupResolution,
    events,
    runtimeMeasurements: {
      accessDenied: "unmeasured",
      routeRemoved: "unmeasured",
      cancellationOutcome: "unmeasured",
      executionTerminated: "unmeasured",
      credentialRevocation: "unmeasured",
    },
  });
}

/** A fixed ordered selection; execution cannot branch into a deferred descriptor. */
export async function runInterruptionMatrix(
  inputs: readonly ScenarioInput[],
  options: (input: ScenarioInput) => RunnerOptions,
) {
  requireInput(inputs.length > 0 && inputs.length <= SCENARIOS.length);
  const selected = freeze(structuredClone(inputs));
  let prior = -1;
  // Validate the entire selection before the first fixture call.
  for (const input of selected) {
    validate(input);
    const index = SCENARIOS.findIndex(({ id }) => id === input.scenarioId);
    requireInput(index > prior);
    prior = index;
  }
  const reports: ScenarioReport[] = [];
  for (const input of selected) reports.push(await runInterruptionScenario(input, options(input)));
  return freeze(reports);
}
