import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { types } from "node:util";
import { AgentId, InstallationId, NamespaceId, RevisionId } from "./api/common.ts";
import {
  WorkloadProfileSelectionSchemaV1,
  WorkloadProfileUseSchemaV1,
  WorkloadProfileIdSchemaV1,
  decodeWorkloadProfileSelectionV1,
  decodeWorkloadProfileUseV1,
  type WorkloadProfileSelectionV1,
  type WorkloadProfileUseV1,
} from "./workload-profile-v1.ts";
import {
  RuntimeObservationResultSchemaV1,
  parseRuntimeEffectsV1,
  type RuntimeObservationResultV1,
} from "./runtime-effects-v1.ts";
import type { RuntimeAssignmentTargetV1, RuntimeBindingV1 } from "./runtime-authority-v1.ts";

/** An in-process comparison contract. Parsing supplies no admission, currentness,
 * authenticated observation, runtime enforcement, or predecessor-writer proof. */
export const CONTAINMENT_ADMISSION_LIMITS_V1 = Object.freeze({
  maxInputBytes: 262_144,
  maxDepth: 32,
  maxNodes: 16_384,
  maxContainerEntries: 1_024,
  maxFindings: 64,
});
export const CONTAINMENT_ADMISSION_FIELD_GROUPS_V1 = Object.freeze([
  "images-and-pull-policy",
  "ordered-commands-and-arguments",
  "init-main-ephemeral-containers",
  "probes-and-lifecycle-hooks",
  "environment-and-source-selectors",
  "process-security-and-identity",
  "mounts-volumes-and-propagation",
  "resources-overhead-and-defaults",
  "dns-hosts-and-service-links",
  "restart-termination-and-controller-update",
  "placement-and-runtime",
  "approved-annotations",
] as const);
export const CONTAINMENT_ADMISSION_DIAGNOSTIC_EXCLUSIONS_V1 = Object.freeze([
  "pod.metadata.creationTimestamp",
  "pod.metadata.managedFields",
  "controller.metadata.creationTimestamp",
  "controller.metadata.managedFields",
] as const);
export const CONTAINMENT_ADMISSION_FIELD_PATHS_V1 = Object.freeze([
  "$",
  "pod.apiVersion",
  "pod.kind",
  "pod.metadata.uid",
  "pod.metadata.resourceVersion",
  "pod.metadata.annotations.*",
  "pod.metadata.labels.*",
  "pod.metadata.ownerReferences[*]",
  "pod.spec.containers[*]",
  "pod.spec.initContainers[*]",
  "pod.spec.ephemeralContainers[*]",
  "pod.spec.containers[*].image",
  "pod.spec.containers[*].imagePullPolicy",
  "pod.spec.containers[*].command",
  "pod.spec.containers[*].args",
  "pod.spec.containers[*].env[*]",
  "pod.spec.containers[*].envFrom[*]",
  "pod.spec.containers[*].securityContext",
  "pod.spec.containers[*].volumeMounts[*]",
  "pod.spec.containers[*].resources",
  "pod.spec.containers[*].livenessProbe",
  "pod.spec.containers[*].readinessProbe",
  "pod.spec.containers[*].startupProbe",
  "pod.spec.containers[*].lifecycle",
  "pod.spec.securityContext",
  "pod.spec.serviceAccountName",
  "pod.spec.automountServiceAccountToken",
  "pod.spec.volumes[*]",
  "pod.spec.resources",
  "pod.spec.overhead",
  "pod.spec.dnsPolicy",
  "pod.spec.dnsConfig",
  "pod.spec.hostAliases[*]",
  "pod.spec.enableServiceLinks",
  "pod.spec.restartPolicy",
  "pod.spec.terminationGracePeriodSeconds",
  "pod.spec.runtimeClassName",
  "pod.spec.nodeName",
  "pod.spec.nodeSelector",
  "pod.spec.affinity",
  "pod.spec.tolerations[*]",
  "pod.spec.hostNetwork",
  "pod.spec.hostPID",
  "pod.spec.hostIPC",
  "pod.status",
  "controller.apiVersion",
  "controller.kind",
  "controller.metadata.uid",
  "controller.metadata.resourceVersion",
  "controller.spec.replicas",
  "controller.spec.strategy",
  "controller.spec.template",
  "unknown-field",
] as const);

type Immutable<T> = T extends readonly (infer V)[]
  ? readonly Immutable<V>[]
  : T extends object
    ? string extends keyof T
      ? T
      : { readonly [K in keyof T]: Immutable<T[K]> }
    : T;
/** Complete supplied raw JSON tree. Unknown keys, explicit null, empty values and
 * array order survive. This is neither a Kubernetes DTO nor a profile normalizer. */
export type ContainmentRawJsonValueV1 =
  | null
  | boolean
  | number
  | string
  | readonly ContainmentRawJsonValueV1[]
  | { readonly [key: string]: ContainmentRawJsonValueV1 };
export type ContainmentRawObjectV1 = { readonly [key: string]: ContainmentRawJsonValueV1 };
const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const rawObject = Type.Unsafe<ContainmentRawObjectV1>({
  type: "object",
  additionalProperties: true,
});
const ref = Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:/-]+$" });
const id = WorkloadProfileIdSchemaV1;
const unavailableReason = Type.Enum([
  "static-input-unavailable",
  "profile-use-unavailable",
  "expectation-adapter-unavailable",
  "stage-binding-unavailable",
  "observation-unavailable",
  "normalization-unavailable",
]);
const fieldGroup = Type.Enum(CONTAINMENT_ADMISSION_FIELD_GROUPS_V1);
const exclusions = Type.Array(Type.Enum(CONTAINMENT_ADMISSION_DIAGNOSTIC_EXCLUSIONS_V1), {
  maxItems: 4,
});
const rawDocument = object({ pod: rawObject, controller: rawObject });
export const ContainmentRevisionTargetSchemaV1 = object({
  installationId: InstallationId,
  namespaceId: NamespaceId,
  agentId: AgentId,
  revisionId: RevisionId,
});
export type ContainmentRevisionTargetV1 = Pick<
  RuntimeAssignmentTargetV1,
  "installationId" | "namespaceId" | "agentId" | "revisionId"
>;
const objectIdentity = object({
  clusterRef: ref,
  kubernetesNamespaceUid: ref,
  podUid: ref,
  podResourceVersion: ref,
  deploymentUid: ref,
  deploymentResourceVersion: ref,
});
const candidateSubject = object({
  stage: Type.Literal("candidate"),
  requestRef: id,
  operation: Type.Enum(["create", "update", "patch", "ephemeral-containers"]),
});
const observedSubject = object({
  stage: Type.Literal("observed"),
  objectIdentity,
  observation: RuntimeObservationResultSchemaV1,
});
export const ContainmentAdmissionSubjectSchemaV1 = Type.Union([candidateSubject, observedSubject]);
export type ContainmentAdmissionSubjectV1 = Immutable<
  Static<typeof ContainmentAdmissionSubjectSchemaV1>
>;
/** Supplied references remain ordinary data. The named original producer must
 * authenticate and populate them; this contract never creates a trusted context. */
const due = <T extends string>(owner: T) =>
  Type.Union([
    object({ status: Type.Literal("supplied"), owner: Type.Literal(owner), evidenceRef: ref }),
    object({
      status: Type.Literal("unavailable"),
      owner: Type.Literal(owner),
      reasonCode: unavailableReason,
    }),
  ]);
const later = <T extends string>(owner: T) =>
  object({ status: Type.Literal("not-due"), owner: Type.Literal(owner) });
const commonBindings = {
  deploymentScope: due("deployment-authority"),
  configuration: due("configuration-authority"),
  servicePrincipal: due("service-account-authority"),
  stores: due("store-reservation-authority"),
};
const candidateBindings = object({
  ...commonBindings,
  providerObjects: later("runtime-observer"),
  execution: later("runtime-observer"),
});
const observedBindings = object({
  ...commonBindings,
  providerObjects: due("runtime-observer"),
  execution: due("runtime-observer"),
});
const commonBinding = {
  schemaVersion: Type.Literal(1),
  comparisonVersion: Type.Literal(1),
  normalizationVersion: Type.Literal(1),
  comparisonRef: id,
  target: ContainmentRevisionTargetSchemaV1,
  profileContentDomain: Type.Literal("manifestDigest"),
  selection: WorkloadProfileSelectionSchemaV1,
  profileUse: Type.Union([WorkloadProfileUseSchemaV1, Type.Null()]),
  // Original producer content locators: no canonicalization or digest is performed here.
  actualContentRef: ref,
  expectedContentRef: Type.Union([ref, Type.Null()]),
  diagnosticExclusions: exclusions,
};
export const ContainmentAdmissionBindingSchemaV1 = Type.Union([
  object({ ...commonBinding, subject: candidateSubject, serverBindings: candidateBindings }),
  object({ ...commonBinding, subject: observedSubject, serverBindings: observedBindings }),
]);
export type ContainmentAdmissionBindingV1 = Immutable<
  Static<typeof ContainmentAdmissionBindingSchemaV1>
>;
const availableExpectation = object({
  status: Type.Literal("available"),
  fieldGroups: Type.Array(fieldGroup, { minItems: 12, maxItems: 12 }),
  document: rawDocument,
});
const unavailableExpectation = object({
  status: Type.Literal("unavailable"),
  reasonCode: unavailableReason,
  missingFieldGroups: Type.Array(fieldGroup, { minItems: 0, maxItems: 12 }),
});
export const ContainmentAdmissionInputSchemaV1 = object({
  binding: ContainmentAdmissionBindingSchemaV1,
  expectation: Type.Union([availableExpectation, unavailableExpectation]),
  actual: rawDocument,
});
export type ContainmentAdmissionInputV1 = Immutable<
  Static<typeof ContainmentAdmissionInputSchemaV1>
>;
const finding = object({
  reasonCode: Type.Enum([
    "field-mismatch",
    "required-field-absent",
    "unsupported-field",
    "unsupported-value",
    "profile-mismatch",
    "static-input-unavailable",
    "profile-use-unavailable",
    "expectation-adapter-unavailable",
    "stage-binding-unavailable",
    "observation-unavailable",
    "normalization-unavailable",
  ]),
  fieldPath: Type.Enum(CONTAINMENT_ADMISSION_FIELD_PATHS_V1),
});
const resultCommon = {
  binding: ContainmentAdmissionBindingSchemaV1,
  purpose: Type.Literal("comparison-only"),
};
export const ContainmentAdmissionResultSchemaV1 = Type.Union([
  object({
    ...resultCommon,
    outcome: Type.Literal("conforming"),
    findings: Type.Array(finding, { maxItems: 0 }),
  }),
  object({
    ...resultCommon,
    outcome: Type.Literal("nonconforming"),
    findings: Type.Array(finding, { minItems: 1, maxItems: 64 }),
  }),
  object({
    ...resultCommon,
    outcome: Type.Literal("unknown"),
    findings: Type.Array(finding, { minItems: 1, maxItems: 64 }),
  }),
]);
export type ContainmentAdmissionResultV1 = Immutable<
  Static<typeof ContainmentAdmissionResultSchemaV1>
>;
/** Implemented by the later comparison library. No evaluator/provider is supplied
 * here. Original owners separately supply expectations and protected observations. */
export interface ContainmentAdmissionComparatorV1 {
  compare(input: ContainmentAdmissionInputV1): Promise<ContainmentAdmissionResultV1>;
}
export type ContainmentAdmissionDecodeResultV1<T> =
  | { readonly kind: "valid"; readonly value: Immutable<T> }
  | { readonly kind: "invalid"; readonly reasonCode: "invalid-input" };

function invalid(): never {
  throw new Error("Invalid containment comparison data");
}
function scalarString(value: string): void {
  if (value.length > CONTAINMENT_ADMISSION_LIMITS_V1.maxInputBytes) invalid();
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const low = value.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) invalid();
    } else if (c >= 0xdc00 && c <= 0xdfff) invalid();
  }
}
/** Descriptor-only snapshot: no coercion, accessors, proxies or caller toJSON. */
function snapshot(input: unknown): unknown {
  let nodes = 0;
  let bytes = 0;
  const charge = (size: number): void => {
    bytes += size;
    if (bytes > CONTAINMENT_ADMISSION_LIMITS_V1.maxInputBytes) invalid();
  };
  const seen = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    if (
      ++nodes > CONTAINMENT_ADMISSION_LIMITS_V1.maxNodes ||
      depth > CONTAINMENT_ADMISSION_LIMITS_V1.maxDepth
    )
      invalid();
    if (value === null || typeof value === "boolean") {
      charge(value === null ? 4 : value ? 4 : 5);
      return value;
    }
    if (typeof value === "string") {
      scalarString(value);
      charge(Buffer.byteLength(JSON.stringify(value), "utf8"));
      return value;
    }
    if (typeof value === "number") {
      if (
        !Number.isFinite(value) ||
        Math.abs(value) > Number.MAX_SAFE_INTEGER ||
        Object.is(value, -0)
      )
        invalid();
      charge(JSON.stringify(value).length);
      return value;
    }
    if (typeof value !== "object" || types.isProxy(value) || seen.has(value)) invalid();
    seen.add(value);
    const array = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length > CONTAINMENT_ADMISSION_LIMITS_V1.maxContainerEntries + (array ? 1 : 0))
      invalid();
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    if (array && keys.length !== value.length + 1) invalid();
    const entries = keys.length - (array ? 1 : 0);
    charge(2 + Math.max(0, entries - 1));
    for (const key of keys) {
      if (typeof key !== "string") invalid();
      if (array && key === "length") continue;
      scalarString(key);
      if (!array) charge(Buffer.byteLength(JSON.stringify(key), "utf8") + 1);
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(result);
  };
  const result = copy(input, 0);
  if (
    Buffer.byteLength(JSON.stringify(result), "utf8") >
    CONTAINMENT_ADMISSION_LIMITS_V1.maxInputBytes
  )
    invalid();
  return result;
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    !a ||
    !b ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const ak = Object.keys(a),
    bk = Object.keys(b);
  return (
    ak.length === bk.length &&
    ak.every(
      (k) =>
        Object.hasOwn(b, k) &&
        same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  );
}
function checkBinding(binding: ContainmentAdmissionBindingV1): void {
  if (decodeWorkloadProfileSelectionV1(binding.selection).kind !== "valid") invalid();
  if (new Set(binding.diagnosticExclusions).size !== binding.diagnosticExclusions.length) invalid();
  if (binding.profileUse) {
    if (decodeWorkloadProfileUseV1(binding.profileUse).kind !== "valid") invalid();
    const use: WorkloadProfileUseV1 = binding.profileUse;
    const selection: WorkloadProfileSelectionV1 = binding.selection;
    if (
      use.installationId !== binding.target.installationId ||
      use.namespaceId !== binding.target.namespaceId ||
      use.component !== "harness"
    )
      invalid();
    for (const key of [
      "manifestRef",
      "manifestDigest",
      "admissionRef",
      "admissionVersion",
    ] as const)
      if (use[key] !== selection[key]) invalid();
  }
  if (binding.subject.stage === "observed") {
    const observation: RuntimeObservationResultV1 = parseRuntimeEffectsV1(
      "observationResult",
      binding.subject.observation,
    );
    const target = observation.input.target;
    if (target.component !== "harness") invalid();
    for (const key of ["installationId", "namespaceId", "agentId", "revisionId"] as const)
      if (target[key] !== binding.target[key]) invalid();
    const identity = binding.subject.objectIdentity;
    if (observation.input.kind === "preallocated-candidate") {
      const create = observation.input.createEffect;
      if (
        create.providerTarget.clusterRef !== identity.clusterRef ||
        create.providerTarget.kubernetesNamespaceUid !== identity.kubernetesNamespaceUid ||
        (create.expectedObject && create.expectedObject.uid !== identity.deploymentUid)
      )
        invalid();
      // Expected resourceVersion may precede this observation; retain the original UID-only rule.
    }
    const instances: RuntimeBindingV1[] = [];
    // An incomplete result still retains its known bound-instance input.
    if (observation.input.kind === "bound-instance") instances.push(observation.input.binding);
    if (observation.status === "complete") {
      instances.push(observation.binding);
      if (observation.object.resourceVersion !== identity.deploymentResourceVersion) invalid();
    }
    for (const instance of instances) {
      if (
        instance.component !== "harness" ||
        instance.clusterRef !== identity.clusterRef ||
        instance.kubernetesNamespaceUid !== identity.kubernetesNamespaceUid ||
        instance.podUid !== identity.podUid ||
        instance.deploymentUid !== identity.deploymentUid
      )
        invalid();
      if (binding.profileUse) {
        if (instance.admittedConfigurationDigest !== binding.profileUse.admittedConfigurationDigest)
          invalid();
        for (const role of ["provider", "runtime", "identity"] as const)
          if (instance.profileDigests[role] !== binding.profileUse.profileRefs[role].contentDigest)
            invalid();
      }
    }
  }
}
function dueUnavailable(binding: ContainmentAdmissionBindingV1): boolean {
  return (
    !binding.profileUse ||
    binding.expectedContentRef === null ||
    Object.values(binding.serverBindings).some((x) => x.status === "unavailable") ||
    (binding.subject.stage === "observed" && binding.subject.observation.status !== "complete")
  );
}
function checkInput(input: ContainmentAdmissionInputV1): void {
  checkBinding(input.binding);
  const expectation = input.expectation;
  if (expectation.status === "available") {
    if (!input.binding.profileUse || input.binding.expectedContentRef === null) invalid();
    if (
      new Set(expectation.fieldGroups).size !== CONTAINMENT_ADMISSION_FIELD_GROUPS_V1.length ||
      !CONTAINMENT_ADMISSION_FIELD_GROUPS_V1.every((g) => expectation.fieldGroups.includes(g))
    )
      invalid();
  } else {
    if (new Set(expectation.missingFieldGroups).size !== expectation.missingFieldGroups.length)
      invalid();
    if (
      expectation.reasonCode === "static-input-unavailable" &&
      expectation.missingFieldGroups.length === 0
    )
      invalid();
  }
  for (const document of [
    input.actual,
    ...(expectation.status === "available" ? [expectation.document] : []),
  ]) {
    if (
      document.pod.apiVersion !== "v1" ||
      document.pod.kind !== "Pod" ||
      document.controller.apiVersion !== "apps/v1" ||
      document.controller.kind !== "Deployment"
    )
      invalid();
  }
  if (input.binding.subject.stage === "observed") {
    const identity = input.binding.subject.objectIdentity;
    const podMetadata = input.actual.pod.metadata,
      controllerMetadata = input.actual.controller.metadata;
    if (
      !podMetadata ||
      typeof podMetadata !== "object" ||
      Array.isArray(podMetadata) ||
      !controllerMetadata ||
      typeof controllerMetadata !== "object" ||
      Array.isArray(controllerMetadata)
    )
      invalid();
    if (
      (podMetadata as ContainmentRawObjectV1).uid !== identity.podUid ||
      (podMetadata as ContainmentRawObjectV1).resourceVersion !== identity.podResourceVersion ||
      (controllerMetadata as ContainmentRawObjectV1).uid !== identity.deploymentUid ||
      (controllerMetadata as ContainmentRawObjectV1).resourceVersion !==
        identity.deploymentResourceVersion
    )
      invalid();
  }
}
function checkResult(result: ContainmentAdmissionResultV1): void {
  checkBinding(result.binding);
  const unavailable = result.findings.some((f) => f.reasonCode.endsWith("unavailable"));
  if (result.outcome !== "unknown" && dueUnavailable(result.binding)) invalid();
  if (result.outcome === "nonconforming" && unavailable) invalid();
  if (result.outcome === "unknown" && !unavailable) invalid();
}
function decode<S extends TSchema>(
  schema: S,
  input: unknown,
  check: (value: Static<S>) => void,
): ContainmentAdmissionDecodeResultV1<Static<S>> {
  try {
    const value = snapshot(input);
    if (!Check(schema, value)) invalid();
    check(value as Static<S>);
    return Object.freeze({ kind: "valid", value: value as Immutable<Static<S>> });
  } catch {
    return Object.freeze({ kind: "invalid", reasonCode: "invalid-input" });
  }
}
export function decodeContainmentAdmissionInputV1(
  input: unknown,
): ContainmentAdmissionDecodeResultV1<ContainmentAdmissionInputV1> {
  return decode(ContainmentAdmissionInputSchemaV1, input, checkInput);
}
export function decodeContainmentAdmissionResultV1(
  input: unknown,
): ContainmentAdmissionDecodeResultV1<ContainmentAdmissionResultV1> {
  return decode(ContainmentAdmissionResultSchemaV1, input, checkResult);
}
/** Only intrinsic correlation is checked. The later comparator must evaluate the
 * whole raw objects; this function never computes a conforming outcome. */
export function decodeContainmentAdmissionExchangeV1(
  input: unknown,
  result: unknown,
): ContainmentAdmissionDecodeResultV1<ContainmentAdmissionResultV1> {
  const request = decodeContainmentAdmissionInputV1(input);
  const response = decodeContainmentAdmissionResultV1(result);
  if (
    request.kind === "invalid" ||
    response.kind === "invalid" ||
    !same(request.value.binding, response.value.binding)
  )
    return Object.freeze({ kind: "invalid", reasonCode: "invalid-input" });
  if (request.value.expectation.status === "unavailable" && response.value.outcome !== "unknown")
    return Object.freeze({ kind: "invalid", reasonCode: "invalid-input" });
  return response;
}
