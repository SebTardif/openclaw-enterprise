import { types as nodeTypes } from "node:util";
import { type TSchema } from "typebox";
import { Check } from "typebox/value";
import { immutableCopy, sha256Hex } from "@openclaw-enterprise/utils";
import {
  parseRepositoryPreparationV1,
  parsePreparationReceiptExchangeV1,
} from "./repository-preparation-codec-v1.ts";
import {
  RuntimeEvidenceProvenanceSchemaV1,
  type RuntimeEffectClockV1,
} from "./runtime-effects-v1.ts";
import {
  PREPARATION_JOB_LIMITS_V1 as limits,
  PreparationJobSchemasV1,
  type PreparationJobSchemaNameV1,
  type PreparationJobValueV1,
  type PreparationJobPlanV1,
  type PreparationJobTargetV1,
  type PreparationJobReserveV1,
  type PreparationJobMutationV1,
  type PreparationJobReadV1,
  type PreparationJobIdentityV1,
  type PreparationJobObservationV1,
  type PreparationJobClosureV1,
  type PreparationJobReceiptPairV1,
  type PreparationJobMutationResultV1,
  type PreparationJobReadResultV1,
  type PreparationJobClosureResultV1,
  type PreparationJobAdmissionSnapshotV1,
  type PreparationJobAdmissionReadV1,
  type PreparationJobAdmissionResultV1,
} from "./preparation-job-v1.ts";

function invalid(): never {
  throw new TypeError("Invalid preparation Job V1 value");
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function plain(
  value: unknown,
  stack = new Set<object>(),
  depth = 0,
  budget = { nodes: 0 },
): boolean {
  if (depth > limits.maxDepth || ++budget.nodes > 32768) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 1024;
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
  if (!record(value) && !Array.isArray(value)) return false;
  if (nodeTypes.isProxy(value) || stack.has(value)) return false;
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 257 || (array && (value.length > 256 || keys.length !== value.length + 1)))
    return false;
  stack.add(value);
  for (const key of keys) {
    if (typeof key !== "string") return false;
    if (array && key === "length") continue;
    if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      !plain(descriptor.value, stack, depth + 1, budget)
    )
      return false;
  }
  stack.delete(value);
  return true;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const equal = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const hash = (domain: string, value: unknown): string =>
  `sha256:${sha256Hex(`${domain}\n${canonical(value)}`)}`;
const time = (value: string): number => Date.parse(value);
function duration(start: string, end: string, max: number): boolean {
  return time(end) > time(start) && time(end) - time(start) <= max;
}
function times(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(times);
  if (!record(value)) return true;
  return Object.entries(value).every(([key, item]) => {
    if (
      /(?:At|NotAfter)$/.test(key) ||
      key === "deadline" ||
      key === "validUntil" ||
      key === "notAfter"
    ) {
      return (
        typeof item === "string" &&
        Number.isFinite(time(item)) &&
        new Date(item).toISOString() === item
      );
    }
    return times(item);
  });
}
/** Close reused Pick fragments too: absence of additionalProperties in an imported
 * schema is never an extension point for this new wire protocol. */
function closed(inputSchema: TSchema, value: unknown): boolean {
  const schema = inputSchema as TSchema & {
    anyOf?: readonly TSchema[];
    properties?: Record<string, TSchema>;
    items?: TSchema;
  };
  if (Array.isArray(schema.anyOf))
    return schema.anyOf.some((s: TSchema) => Check(s, value) && closed(s, value));
  if (record(value) && record(schema.properties)) {
    const properties = schema.properties;
    return Object.keys(value).every(
      (key) => Object.hasOwn(properties, key) && closed(properties[key]!, value[key]),
    );
  }
  if (Array.isArray(value) && schema.items)
    return value.every((item) => closed(schema.items!, item));
  return true;
}
function shape(schema: TSchema, value: unknown): boolean {
  return (
    plain(value) &&
    Buffer.byteLength(JSON.stringify(value)) <= limits.maxJsonBytes &&
    Check(schema, value) &&
    closed(schema, value) &&
    times(value)
  );
}
function clockValid(clock: RuntimeEffectClockV1): boolean {
  const source = time(clock.sourceObservedAt),
    received = time(clock.receivedAt),
    until = time(clock.validUntil);
  return (
    clock.uncertaintyMs <= limits.uncertaintyMaxMs &&
    source <= received + clock.uncertaintyMs &&
    until >= source &&
    until <= source + limits.observationMaxAgeMs &&
    received + clock.uncertaintyMs <= until &&
    received - source + clock.uncertaintyMs <= limits.observationMaxAgeMs
  );
}
function clocks(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(clocks);
  if (!record(value)) return true;
  if (record(value.clock) && !clockValid(value.clock as RuntimeEffectClockV1)) return false;
  return Object.values(value).every(clocks);
}
function targetValid(target: PreparationJobTargetV1): boolean {
  parseRepositoryPreparationV1("subject", target.preparation);
  return target.purpose === target.preparation.purpose;
}
function planBytes(plan: PreparationJobPlanV1): unknown {
  // The two explicit plan-digest slots are self references. All other original
  // identity, scope, deadlines, profiles, roots and admission fields are bound.
  const { planDigest: _digest, ...rest } = plan;
  const { planDigest: _gateDigest, ...gate } = plan.target.preparation.gate;
  return { ...rest, target: { ...plan.target, preparation: { ...plan.target.preparation, gate } } };
}
function planDigest(plan: PreparationJobPlanV1): string {
  return hash("preparation-job-plan-v1", planBytes(plan));
}
function unique<T>(items: readonly T[], key: (item: T) => string): boolean {
  return new Set(items.map(key)).size === items.length;
}
function planValid(plan: PreparationJobPlanV1, checkDigest = true): boolean {
  const original = plan.target.preparation;
  return (
    targetValid(plan.target) &&
    plan.planRef === original.gate.planRef &&
    plan.planVersion === original.gate.planVersion &&
    (!checkDigest ||
      (plan.planDigest === planDigest(plan) && original.gate.planDigest === plan.planDigest)) &&
    plan.profile.admittedExecutionNotAfter === original.notAfter &&
    unique(plan.producerDomains, (d) => d.domainRef) &&
    unique(plan.producerDomains, (d) => d.kind)
  );
}
function mutationDigest(input: PreparationJobMutationV1): string {
  // Unlike a fresh read call, every original mutation field including deadlines
  // and checkout correspondence is retained. Only its own digest is excluded.
  const { requestDigest: _digest, ...intent } = input;
  return hash("preparation-job-effect-v1", intent);
}
function originalOf(input: PreparationJobMutationV1): PreparationJobReserveV1 {
  return input.method === "reserve-job" ? input : input.original;
}
function currentScope(
  original: PreparationJobReserveV1,
  gate: PreparationJobReadV1["gate"],
): boolean {
  return (
    equal(gate.scope, original.target.preparation.scope) &&
    gate.lifecycleGeneration >= original.gate.lifecycleGeneration &&
    gate.requestedFenceEpoch >= original.gate.requestedFenceEpoch
  );
}
function cleanupValid(
  input:
    | PreparationJobClosureV1
    | Extract<PreparationJobMutationV1, { method: "seal-job" | "terminate-exact" }>,
): boolean {
  const original = input.original,
    binding = input.cleanupBinding;
  return (
    currentScope(original, input.gate) &&
    input.gate.responsibility.kind !== "preparation" &&
    binding.reserveEffectRef === original.effectRef &&
    binding.reserveRequestDigest === original.requestDigest &&
    binding.targetPlanRef === original.plan.planRef &&
    binding.targetPlanVersion === original.plan.planVersion &&
    binding.targetPlanDigest === original.plan.planDigest &&
    equal(binding.responsibility, input.gate.responsibility)
  );
}
function predicateValid(
  input: Exclude<PreparationJobMutationV1, PreparationJobReserveV1>,
): boolean {
  const original = input.original,
    p = input.predicate,
    subject = original.target.preparation;
  return (
    p.namespaceUid === original.target.kubernetesNamespaceUid &&
    p.ownerPreparationRef === subject.preparationRef &&
    p.ownerIncarnationRef === subject.incarnationRef &&
    p.ownerReserveEffectRef === original.effectRef &&
    p.fenceEpoch <= input.gate.requestedFenceEpoch &&
    p.fenceEpoch >= original.gate.requestedFenceEpoch
  );
}
function releaseGuardValid(
  original: PreparationJobReserveV1,
  current: PreparationJobReadV1["gate"],
): boolean {
  const {
    gateVersion: previousVersion,
    admittedChildCutoff: previousCutoff,
    ...previous
  } = original.gate;
  const { gateVersion, admittedChildCutoff, ...remaining } = current;
  // Same comparator as the canonical preparation binding: no inferred lease or
  // responsibility renewal. Only gate version and admitted cutoff may advance.
  return (
    equal(previous, remaining) &&
    gateVersion >= previousVersion &&
    admittedChildCutoff >= previousCutoff
  );
}
function rootMatchesMutation(input: PreparationJobMutationV1, uid: string): boolean {
  return input.method === "reserve-job" || input.predicate.jobUid === uid;
}
function rootOwned(
  original: PreparationJobReserveV1,
  root: PreparationJobObservationV1["job"],
  gate: PreparationJobReadV1["gate"],
): boolean {
  return (
    root.namespaceUid === original.target.kubernetesNamespaceUid &&
    root.ownerPreparationRef === original.target.preparation.preparationRef &&
    root.ownerIncarnationRef === original.target.preparation.incarnationRef &&
    root.ownerReserveEffectRef === original.effectRef &&
    root.fenceEpoch >= original.gate.requestedFenceEpoch &&
    root.fenceEpoch <= gate.requestedFenceEpoch
  );
}
function mutationValid(input: PreparationJobMutationV1, checkDigest = true): boolean {
  if (
    !duration(input.createdAt, input.deadline, limits.callMaxMs) ||
    (checkDigest && input.requestDigest !== mutationDigest(input))
  )
    return false;
  if (input.method === "reserve-job") {
    parseRepositoryPreparationV1("checkoutRequest", input.checkout);
    return (
      targetValid(input.target) &&
      planValid(input.plan) &&
      equal(input.target, input.plan.target) &&
      equal(input.checkout.preparation, input.target.preparation) &&
      equal(input.gate, input.target.preparation.gate) &&
      input.effectRef !== input.releaseEffectRef &&
      input.checkout.effectRef === input.releaseEffectRef &&
      time(input.createdAt) >= time(input.target.preparation.createdAt) &&
      time(input.deadline) <= time(input.target.preparation.notAfter)
    );
  }
  if (
    !mutationValid(input.original) ||
    !predicateValid(input) ||
    input.effectRef === input.original.effectRef ||
    time(input.createdAt) < time(input.original.createdAt)
  )
    return false;
  if (input.method === "release-job") {
    return (
      input.effectRef === input.original.releaseEffectRef &&
      releaseGuardValid(input.original, input.gate) &&
      time(input.deadline) <= time(input.original.checkout.deadline) &&
      time(input.deadline) <= time(input.original.target.preparation.notAfter)
    );
  }
  if (!cleanupValid(input) || input.effectRef === input.original.releaseEffectRef) return false;
  if (input.method === "seal-job")
    return (
      input.closeAdmittedChildCutoff === input.gate.admittedChildCutoff &&
      input.closeAdmittedChildCutoff >= input.original.gate.admittedChildCutoff
    );
  const child = input.terminationTarget;
  return (
    child.pod.namespaceUid === input.predicate.namespaceUid &&
    child.pod.jobUid === input.predicate.jobUid &&
    child.pod.controllerUid === input.predicate.jobUid &&
    (child.kind === "pod" ||
      (child.execution.podUid === child.pod.podUid &&
        runtimeProfileMatches(input.original, child.execution)))
  );
}
function runtimeProfileMatches(
  original: PreparationJobReserveV1,
  execution: PreparationJobIdentityV1["execution"],
): boolean {
  const profile = original.plan.profile;
  return (
    execution.runscExecutableDigest === profile.runscExecutableDigest &&
    execution.runtimeProfileDigest === profile.runtimeProfileDigest &&
    execution.identityProfileRef === profile.identityProfileRef &&
    execution.identityProfileDigest === profile.identityProfileDigest
  );
}
function provenanceMatches(
  original: PreparationJobReserveV1,
  kind: PreparationJobPlanV1["producerDomains"][number]["kind"],
  evidence: PreparationJobIdentityV1["runtime"],
): boolean {
  const expected = original.plan.producerDomains.find((d) => d.kind === kind);
  return (
    expected !== undefined &&
    evidence.producerRef === expected.requiredProducerRef &&
    evidence.producerProfileDigest === expected.profileDigest
  );
}
function identityValid(identity: PreparationJobIdentityV1): boolean {
  const subject = identity.target.preparation;
  return (
    targetValid(identity.target) &&
    identity.authorizationGeneration === subject.authorizationGeneration &&
    identity.lifecycleGeneration === subject.gate.lifecycleGeneration &&
    identity.fenceEpoch === subject.gate.requestedFenceEpoch &&
    identity.pod.namespaceUid === identity.target.kubernetesNamespaceUid &&
    identity.pod.jobUid === identity.pod.controllerUid &&
    identity.pod.podUid === identity.execution.podUid &&
    identity.reserveEffectRef !== identity.releaseEffectRef &&
    identity.controlPlane.evidenceRef !== identity.runtime.evidenceRef
  );
}
function observationValid(observation: PreparationJobObservationV1): boolean {
  const original = observation.original;
  return (
    mutationValid(original) &&
    currentScope(original, observation.gate) &&
    rootOwned(original, observation.job, observation.gate) &&
    observation.collection.observedChildCutoff <= observation.gate.admittedChildCutoff &&
    unique(observation.pods, (p) => p.podUid) &&
    unique(observation.executions, (e) => e.executionRef) &&
    observation.pods.every(
      (p) =>
        p.namespaceUid === original.target.kubernetesNamespaceUid &&
        p.jobUid === observation.job.uid &&
        p.controllerUid === observation.job.uid,
    ) &&
    observation.executions.every(
      (e) =>
        observation.pods.some((p) => p.podUid === e.podUid) && runtimeProfileMatches(original, e),
    ) &&
    provenanceMatches(original, "job-controller", observation.controlPlane) &&
    provenanceMatches(original, "node-runtime", observation.runtime) &&
    observation.controlPlane.evidenceRef !== observation.runtime.evidenceRef
  );
}
function manifestDigest(attempts: PreparationJobClosureV1["attempts"]): string {
  return hash("preparation-job-attempt-manifest-v1", attempts);
}
function memberOf(
  attempt: PreparationJobClosureV1["attempts"][number],
): PreparationJobAdmissionSnapshotV1["members"][number] {
  const { attemptRef, effectRef, requestDigest, domainRef, admittedSequence } = attempt;
  return { attemptRef, effectRef, requestDigest, domainRef, admittedSequence };
}
function admissionDigest(members: PreparationJobAdmissionSnapshotV1["members"]): string {
  return hash("preparation-job-admission-manifest-v1", members);
}
function admissionValid(snapshot: PreparationJobAdmissionSnapshotV1): boolean {
  const original = snapshot.original;
  return (
    mutationValid(original) &&
    currentScope(original, snapshot.gate) &&
    snapshot.gate.responsibility.kind !== "preparation" &&
    snapshot.closedChildCutoff === snapshot.gate.admittedChildCutoff &&
    snapshot.closedChildCutoff >= original.gate.admittedChildCutoff &&
    snapshot.targetPlanDigest === original.plan.planDigest &&
    snapshot.manifestDigest === admissionDigest(snapshot.members) &&
    unique(snapshot.members, (m) => m.attemptRef) &&
    unique(snapshot.members, (m) => String(m.admittedSequence)) &&
    snapshot.members.every(
      (m, i) =>
        m.admittedSequence <= snapshot.closedChildCutoff &&
        (i === 0 || snapshot.members[i - 1]!.admittedSequence < m.admittedSequence) &&
        original.plan.producerDomains.some((d) => d.domainRef === m.domainRef),
    ) &&
    snapshot.members.some(
      (m) => m.effectRef === original.effectRef && m.requestDigest === original.requestDigest,
    )
  );
}
function closureValid(closure: PreparationJobClosureV1): boolean {
  const original = closure.original;
  if (
    !mutationValid(original) ||
    !cleanupValid(closure) ||
    !rootOwned(original, closure.root, closure.gate) ||
    closure.root.fenceEpoch !== closure.gate.requestedFenceEpoch ||
    !admissionValid(closure.admission) ||
    !equal(closure.admission.original, original) ||
    !equal(closure.admission.gate, closure.gate) ||
    closure.admission.admissionSealVersion !== closure.admissionSealVersion ||
    !equal(closure.admission.members, closure.attempts.map(memberOf)) ||
    closure.targetPlanDigest !== original.plan.planDigest ||
    closure.closedChildCutoff !== closure.gate.admittedChildCutoff ||
    closure.closedChildCutoff < original.gate.admittedChildCutoff ||
    !equal(closure.staging, original.target.preparation.staging) ||
    !equal(closure.storeEvidence.staging, closure.staging) ||
    closure.storeEvidence.closedChildCutoff !== closure.closedChildCutoff ||
    closure.storeEvidence.targetPlanDigest !== closure.targetPlanDigest ||
    closure.attemptManifestDigest !== manifestDigest(closure.attempts)
  )
    return false;
  if (
    !unique(closure.producerDomains, (d) => d.domainRef) ||
    !unique(closure.producerDomains, (d) => d.kind) ||
    !unique(closure.producerDomains, (d) => d.provenance.evidenceRef) ||
    !unique(closure.attempts, (a) => a.attemptRef) ||
    !unique(closure.attempts, (a) => `${a.domainRef}/${a.admittedSequence}`)
  )
    return false;
  if (
    !closure.producerDomains.every((d) => {
      const expected = original.plan.producerDomains.find((e) => e.domainRef === d.domainRef);
      return (
        expected &&
        expected.kind === d.kind &&
        expected.requiredCapabilityRef === d.capabilityRef &&
        expected.requiredProducerRef === d.provenance.producerRef &&
        expected.profileDigest === d.provenance.producerProfileDigest &&
        d.originalReserveEffectRef === original.effectRef &&
        d.targetPlanDigest === closure.targetPlanDigest &&
        d.closedChildCutoff === closure.closedChildCutoff &&
        d.sealVersion === closure.admissionSealVersion
      );
    })
  )
    return false;
  // The admission owner must authenticate manifest completeness; these checks
  // reject structurally incomplete coverage, never establish it from a Pod list.
  return (
    closure.attempts.every(
      (a) =>
        a.admittedSequence <= closure.closedChildCutoff &&
        closure.producerDomains.some(
          (d) =>
            d.domainRef === a.domainRef && d.provenance.evidenceRef === a.resolutionEvidenceRef,
        ),
    ) &&
    closure.attempts.some(
      (a) =>
        a.outcome === "inert-root" &&
        a.effectRef === original.effectRef &&
        a.requestDigest === original.requestDigest,
    ) &&
    closure.attempts.every((a) => {
      if (a.outcome === "inert-root")
        return (
          a.effectRef === original.effectRef &&
          a.requestDigest === original.requestDigest &&
          a.rootUid === closure.root.uid &&
          a.rootResourceVersion === closure.root.resourceVersion
        );
      if (a.outcome === "prevented") return a.effectRef !== original.effectRef;
      if (a.outcome === "executions-excluded") return a.effectRef === original.releaseEffectRef;
      return (
        a.pod.namespaceUid === original.target.kubernetesNamespaceUid &&
        a.pod.jobUid === closure.root.uid &&
        a.pod.controllerUid === closure.root.uid &&
        a.execution.podUid === a.pod.podUid &&
        runtimeProfileMatches(original, a.execution)
      );
    }) &&
    (!closure.attempts.some((a) => a.outcome === "terminated") ||
      closure.attempts.some((a) => a.outcome === "executions-excluded")) &&
    provenanceMatches(original, "staging-writers", closure.storeEvidence.provenance)
  );
}
function pairValid(pair: PreparationJobReceiptPairV1): boolean {
  parseRepositoryPreparationV1("checkoutReceipt", pair.receipt);
  const original = pair.release.original,
    identity = pair.identity;
  return (
    mutationValid(pair.release) &&
    identityValid(identity) &&
    equal(pair.receipt.request, original.checkout) &&
    equal(identity.target, original.target) &&
    identity.reserveEffectRef === original.effectRef &&
    identity.reserveRequestDigest === original.requestDigest &&
    identity.releaseEffectRef === pair.release.effectRef &&
    identity.pod.jobUid === pair.release.predicate.jobUid &&
    runtimeProfileMatches(original, identity.execution) &&
    provenanceMatches(original, "job-controller", identity.controlPlane) &&
    provenanceMatches(original, "node-runtime", identity.runtime)
  );
}
function readValid(input: PreparationJobReadV1 | PreparationJobAdmissionReadV1): boolean {
  return (
    mutationValid(input.original) &&
    currentScope(originalOf(input.original), input.gate) &&
    duration(input.createdAt, input.deadline, limits.readMaxMs) &&
    (input.method !== "read-closure" ||
      (admissionValid(input.admission) &&
        equal(input.admission.original, originalOf(input.original)) &&
        equal(input.admission.gate, input.gate)))
  );
}
function mutationResultValid(result: PreparationJobMutationResultV1): boolean {
  return mutationValid(result.original);
}
function readResultValid(result: PreparationJobReadResultV1): boolean {
  if (!mutationValid(result.original)) return false;
  if (result.status === "observed")
    return (
      observationValid(result.observation) &&
      equal(result.observation.original, originalOf(result.original)) &&
      rootMatchesMutation(result.original, result.observation.job.uid)
    );
  if (result.status === "effect-record")
    return mutationResultValid(result.result) && equal(result.result.original, result.original);
  return true;
}
function closureResultValid(result: PreparationJobClosureResultV1): boolean {
  return result.status === "closed" ? closureValid(result.closure) : mutationValid(result.original);
}
function valid(kind: PreparationJobSchemaNameV1, input: unknown): boolean {
  // These narrow assertions follow Check for this exact NEW schema. No legacy
  // Deployment/Harness target or authority is coerced into preparation identity.
  switch (kind) {
    case "target":
      return targetValid(input as PreparationJobTargetV1);
    case "plan":
      return planValid(input as PreparationJobPlanV1);
    case "reserve":
    case "release":
    case "seal":
    case "terminate":
    case "mutation":
      return mutationValid(input as PreparationJobMutationV1);
    case "read":
      return readValid(input as PreparationJobReadV1);
    case "admissionRead":
      return readValid(input as PreparationJobAdmissionReadV1);
    case "admissionSnapshot":
      return admissionValid(input as PreparationJobAdmissionSnapshotV1);
    case "admissionResult": {
      const result = input as PreparationJobAdmissionResultV1;
      return result.status === "admitted"
        ? admissionValid(result.snapshot)
        : mutationValid(result.original);
    }
    case "identity":
      return identityValid(input as PreparationJobIdentityV1);
    case "observation":
      return observationValid(input as PreparationJobObservationV1);
    case "closure":
      return closureValid(input as PreparationJobClosureV1);
    case "receiptPair":
      return pairValid(input as PreparationJobReceiptPairV1);
    case "mutationResult":
      return mutationResultValid(input as PreparationJobMutationResultV1);
    case "readResult":
      return readResultValid(input as PreparationJobReadResultV1);
    case "closureResult":
      return closureResultValid(input as PreparationJobClosureResultV1);
  }
}
/** Closed immutable value validation only: no authentication, authority lookup,
 * producer implementation, capability creation or readiness decision occurs here. */
export function parsePreparationJobV1<K extends PreparationJobSchemaNameV1>(
  kind: K,
  input: unknown,
): PreparationJobValueV1<K> {
  try {
    if (
      !Object.hasOwn(PreparationJobSchemasV1, kind) ||
      !shape(PreparationJobSchemasV1[kind], input) ||
      !clocks(input) ||
      !valid(kind, input)
    )
      invalid();
    return immutableCopy(input) as PreparationJobValueV1<K>;
  } catch {
    return invalid();
  }
}
export function preparationJobPlanDigestV1(input: PreparationJobPlanV1): string {
  try {
    if (!shape(PreparationJobSchemasV1.plan, input) || !planValid(input, false)) invalid();
    return planDigest(input);
  } catch {
    return invalid();
  }
}
export function preparationJobMutationDigestV1(input: PreparationJobMutationV1): string {
  try {
    if (!shape(PreparationJobSchemasV1.mutation, input) || !mutationValid(input, false)) invalid();
    return mutationDigest(input);
  } catch {
    return invalid();
  }
}
export function preparationJobAttemptManifestDigestV1(
  input: PreparationJobClosureV1["attempts"],
): string {
  if (!shape(PreparationJobSchemasV1.closure.properties.attempts, input)) return invalid();
  return manifestDigest(input);
}

// JSON.parse establishes grammar first. This bounded second pass rejects duplicate
// decoded property names and numeric lexemes that would be rounded or aliased.
function lexemes(text: string): void {
  let at = 0;
  const space = () => {
    while (/\s/.test(text[at] ?? "") && at < text.length) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const character = text[at++];
      if (character === "\\") at++;
      else if (character === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    return invalid();
  };
  const visit = (depth: number): void => {
    if (depth > limits.maxDepth) invalid();
    space();
    if (text[at] === '"') {
      string();
      return;
    }
    if (text[at] === "{") {
      at++;
      space();
      const seen = new Set<string>();
      if (text[at] === "}") {
        at++;
        return;
      }
      for (;;) {
        space();
        const key = string();
        if (seen.has(key)) invalid();
        seen.add(key);
        space();
        at++;
        visit(depth + 1);
        space();
        if (text[at++] === "}") return;
      }
    }
    if (text[at] === "[") {
      at++;
      space();
      if (text[at] === "]") {
        at++;
        return;
      }
      for (;;) {
        visit(depth + 1);
        space();
        if (text[at++] === "]") return;
      }
    }
    const start = at;
    while (at < text.length && !/[\s,}\]]/.test(text[at]!)) at++;
    const token = text.slice(start, at);
    if (["true", "false", "null"].includes(token)) return;
    if (!/^(?:0|[1-9][0-9]*)$/.test(token) || !Number.isSafeInteger(Number(token))) invalid();
  };
  visit(0);
}
export function parsePreparationJobJsonV1<K extends PreparationJobSchemaNameV1>(
  kind: K,
  text: string,
): PreparationJobValueV1<K> {
  try {
    if (typeof text !== "string" || Buffer.byteLength(text) > limits.maxJsonBytes) invalid();
    const input: unknown = JSON.parse(text);
    lexemes(text);
    return parsePreparationJobV1(kind, input);
  } catch {
    return invalid();
  }
}
function checkedClock(clock: RuntimeEffectClockV1): void {
  if (!shape(RuntimeEvidenceProvenanceSchemaV1.properties.clock, clock) || !clockValid(clock))
    invalid();
}
function fresh(
  provenance: PreparationJobIdentityV1["runtime"],
  clock: RuntimeEffectClockV1,
): boolean {
  const evidence = provenance.clock,
    uncertainty = evidence.uncertaintyMs + clock.uncertaintyMs;
  return (
    time(clock.receivedAt) + uncertainty >= time(evidence.sourceObservedAt) &&
    time(clock.receivedAt) - time(evidence.sourceObservedAt) + uncertainty <=
      limits.observationMaxAgeMs &&
    time(clock.receivedAt) + uncertainty <= time(evidence.validUntil)
  );
}
function callCurrent(
  input: { createdAt: string; deadline: string },
  clock: RuntimeEffectClockV1,
): boolean {
  return (
    time(clock.receivedAt) + clock.uncertaintyMs >= time(input.createdAt) &&
    time(clock.receivedAt) + clock.uncertaintyMs <= time(input.deadline)
  );
}
/** Request/response correspondence and freshness checks only. A caller-supplied
 * clock/provenance is not authenticated by this function. Existing owner performs
 * current authority and exact protected producer checks before and after awaits. */
export function parsePreparationJobMutationExchangeV1(
  input: PreparationJobMutationV1,
  output: unknown,
  clock: RuntimeEffectClockV1,
): PreparationJobMutationResultV1 {
  try {
    const request = parsePreparationJobV1("mutation", input);
    const result = parsePreparationJobV1("mutationResult", output);
    checkedClock(clock);
    if (!equal(result.original, request)) invalid();
    // A late/expired call can retain an unknown result; only a fresh positive ACK
    // is accepted, and even that ACK explicitly leaves physical outcome unproven.
    if (
      result.status === "acknowledged" &&
      (!callCurrent(request, clock) || !fresh(result.provenance, clock))
    )
      invalid();
    return result;
  } catch {
    return invalid();
  }
}
export function parsePreparationJobReadExchangeV1(
  input: PreparationJobReadV1,
  output: unknown,
  clock: RuntimeEffectClockV1,
): PreparationJobReadResultV1 {
  try {
    const request = parsePreparationJobV1("read", input);
    const result = parsePreparationJobV1("readResult", output);
    checkedClock(clock);
    if (request.method === "read-closure" || !equal(result.original, request.original)) invalid();
    if (result.status === "observed") {
      const observation = result.observation;
      if (
        (request.method !== "observe-job" && request.method !== "discover-job") ||
        !callCurrent(request, clock) ||
        !equal(observation.gate, request.gate) ||
        observation.collection.state !== "complete" ||
        observation.collection.observedChildCutoff !== request.gate.admittedChildCutoff ||
        !fresh(observation.controlPlane, clock) ||
        !fresh(observation.runtime, clock)
      )
        invalid();
    }
    if (
      result.status === "effect-record" &&
      (request.method !== "read-original-effect" ||
        !callCurrent(request, clock) ||
        !fresh(result.provenance, clock))
    )
      invalid();
    return result;
  } catch {
    return invalid();
  }
}
export function parsePreparationJobClosureExchangeV1(
  input: PreparationJobReadV1,
  output: unknown,
  clock: RuntimeEffectClockV1,
): PreparationJobClosureResultV1 {
  try {
    const request = parsePreparationJobV1("read", input);
    const result = parsePreparationJobV1("closureResult", output);
    checkedClock(clock);
    if (request.method !== "read-closure") invalid();
    if (result.status === "closed") {
      const closure = result.closure;
      if (
        !callCurrent(request, clock) ||
        !equal(closure.original, originalOf(request.original)) ||
        !rootMatchesMutation(request.original, closure.root.uid) ||
        !equal(closure.admission, request.admission) ||
        !fresh(closure.admission.provenance, clock) ||
        !equal(closure.gate, request.gate) ||
        !closure.producerDomains.every((d) => fresh(d.provenance, clock)) ||
        !fresh(closure.storeEvidence.provenance, clock)
      )
        invalid();
    } else if (!equal(result.original, request.original)) invalid();
    return result;
  } catch {
    return invalid();
  }
}
export function parsePreparationJobReceiptPairV1(
  input: PreparationJobReceiptPairV1,
  expectedRelease: PreparationJobValueV1<"release">,
  clock: RuntimeEffectClockV1,
): PreparationJobReceiptPairV1 {
  try {
    const pair = parsePreparationJobV1("receiptPair", input);
    const release = parsePreparationJobV1("release", expectedRelease);
    checkedClock(clock);
    if (
      !equal(pair.release, release) ||
      !fresh(pair.identity.controlPlane, clock) ||
      !fresh(pair.identity.runtime, clock)
    )
      invalid();
    // Preserve the repository preparation contract's checkout digest and original
    // deadline and receipt rules.
    parsePreparationReceiptExchangeV1(
      release.original.checkout,
      { status: "complete", receipt: pair.receipt },
      clock,
    );
    return pair;
  } catch {
    return invalid();
  }
}

export function preparationJobAdmissionManifestDigestV1(
  input: PreparationJobAdmissionSnapshotV1["members"],
): string {
  if (!shape(PreparationJobSchemasV1.admissionSnapshot.properties.members, input)) return invalid();
  return admissionDigest(input);
}
function sameAdmission(
  a: PreparationJobAdmissionSnapshotV1,
  b: PreparationJobAdmissionSnapshotV1,
): boolean {
  const { provenance: ap, ...previous } = a;
  const { provenance: bp, ...current } = b;
  if (!equal(previous, current)) return false;
  if (equal(ap, bp)) return true;
  // A cached observation keeps its exact provenance. Fresh source evidence must
  // have a distinct producer-owned identity/version, not a timestamp replacement.
  return (
    ap.producerRef === bp.producerRef &&
    ap.producerServiceVersion === bp.producerServiceVersion &&
    ap.producerProfileRef === bp.producerProfileRef &&
    ap.producerProfileDigest === bp.producerProfileDigest &&
    ap.acceptedPortRef === bp.acceptedPortRef &&
    (ap.evidenceRef !== bp.evidenceRef || bp.evidenceVersion > ap.evidenceVersion) &&
    time(bp.clock.sourceObservedAt) >= time(ap.clock.sourceObservedAt)
  );
}
/** The actual canonical owner independently reads/rechecks this snapshot. These
 * value comparisons cannot authenticate it or manufacture admission completeness. */
export function parsePreparationJobAdmissionExchangeV1(
  input: PreparationJobAdmissionReadV1,
  output: unknown,
  clock: RuntimeEffectClockV1,
  expected?: PreparationJobAdmissionSnapshotV1,
): PreparationJobAdmissionResultV1 {
  try {
    const request = parsePreparationJobV1("admissionRead", input);
    const result = parsePreparationJobV1("admissionResult", output);
    checkedClock(clock);
    if (result.status === "admitted") {
      if (
        !callCurrent(request, clock) ||
        !equal(result.snapshot.original, originalOf(request.original)) ||
        !equal(result.snapshot.gate, request.gate) ||
        !fresh(result.snapshot.provenance, clock)
      )
        invalid();
      if (
        expected &&
        !sameAdmission(parsePreparationJobV1("admissionSnapshot", expected), result.snapshot)
      )
        invalid();
    } else if (!equal(result.original, request.original)) invalid();
    return result;
  } catch {
    return invalid();
  }
}
