import {
  parseRuntimeEffectsV1,
  type ExactCreateEffectV1,
  type RuntimeAuthorityScopeV1,
  type RuntimePreparedChildV1,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  decodeRuntimePreparationOperation,
  projectRuntimePreparation,
  retainedRuntimePreparationRequest,
} from "./repository.ts";
import {
  canonicalRuntimePreparation,
  requirePreparation,
  runtimePreparationDigest,
  samePreparationValue,
  type RetainedRuntimePreparation,
  type StoredRuntimePreparationOperation,
} from "./types.ts";
import type { RuntimePreparationDeploymentResponseV1 } from "./submission.ts";

/** Private expected locators, never authorization. createEffectRef names the
 * selected child.effect.effectRef, NOT target.createEffectRef/ownerCreateEffectRef. */
export type RuntimePreparationCreateLocatorV1 =
  | Readonly<{ kind: "create-effect"; createEffectRef: string }>
  | Readonly<{ kind: "submission"; submissionRef: string }>;

export interface RuntimePreparationCreateSubmissionV1 {
  readonly submissionRef: string;
  readonly effectRef: string;
  readonly installationId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly preparationRef: string;
  readonly preparationVersion: number;
  readonly requestDigest: string;
  readonly providerWireDigest: string;
  readonly submittedAt: string;
}

/** Original State read. History is the COMPLETE contiguous prefix through the
 * exact marker preparationVersion, or childOperation.localVersion without one.
 * The original State owner supplies/authenticates its query context separately. */
export interface RuntimePreparationCreateCorrelationRetainedV1 {
  readonly status: "retained";
  readonly childOperation: StoredRuntimePreparationOperation;
  readonly history: readonly StoredRuntimePreparationOperation[];
  readonly preparation: RetainedRuntimePreparation;
  readonly child: RuntimePreparedChildV1;
  readonly providerWireUtf8: string;
  readonly submission?: RuntimePreparationCreateSubmissionV1;
  readonly response?: RuntimePreparationDeploymentResponseV1;
}
export type RuntimePreparationCreateCorrelationReadV1 =
  Readonly<{ status: "absent" }> | RuntimePreparationCreateCorrelationRetainedV1;
export type RuntimePreparationCreateReferenceResultV1 =
  | Readonly<{ status: "absent" }>
  | Readonly<{
      status: "located";
      input: ExactCreateEffectV1;
      retained: RuntimePreparationCreateCorrelationRetainedV1;
    }>;

/** Constructed only by the original State callback from its borrowed context.
 * No context/client can be supplied to read. This interface grants no read rights
 * and returns inert historical data, not a native correlation exchange. */
export interface RuntimePreparationCreateReferenceReaderV1 {
  read(
    scope: RuntimeAuthorityScopeV1,
    locator: RuntimePreparationCreateLocatorV1,
  ): Promise<RuntimePreparationCreateReferenceResultV1>;
}

function record<T>(
  value: T,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is NonNullable<T> & object {
  requirePreparation(value !== null && typeof value === "object" && !Array.isArray(value));
  requirePreparation([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(value);
  requirePreparation(
    names.every((name) => typeof name === "string" && [...required, ...optional].includes(name)),
  );
  requirePreparation(required.every((name) => Object.hasOwn(descriptors, name)));
  for (const name of names) {
    requirePreparation(typeof name === "string");
    const descriptor = descriptors[name]!;
    requirePreparation(descriptor.enumerable && "value" in descriptor);
  }
}
function array(value: unknown, maximum?: number): asserts value is readonly unknown[] {
  requirePreparation(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
  requirePreparation(maximum === undefined || value.length <= maximum);
  requirePreparation(Reflect.ownKeys(value).length === value.length + 1);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    requirePreparation(descriptor !== undefined && descriptor.enumerable && "value" in descriptor);
  }
}
function uuid(value: unknown): void {
  requirePreparation(
    typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value),
  );
}
function timestamp(value: unknown): void {
  requirePreparation(typeof value === "string");
  const time = Date.parse(value);
  requirePreparation(Number.isFinite(time) && new Date(time).toISOString() === value);
}
function scopeOf(target: RuntimeAuthorityScopeV1): RuntimeAuthorityScopeV1 {
  return {
    installationId: target.installationId,
    namespaceId: target.namespaceId,
    agentId: target.agentId,
  };
}
export function parseRuntimePreparationCreateLocatorV1(
  input: RuntimePreparationCreateLocatorV1,
): RuntimePreparationCreateLocatorV1 {
  canonicalRuntimePreparation(input);
  requirePreparation(input.kind === "create-effect" || input.kind === "submission");
  if (input.kind === "create-effect") {
    record(input, ["kind", "createEffectRef"]);
    uuid(input.createEffectRef);
  } else {
    record(input, ["kind", "submissionRef"]);
    uuid(input.submissionRef);
  }
  return immutableCopy(input);
}
function compareOperation(
  actual: StoredRuntimePreparationOperation,
  expected: StoredRuntimePreparationOperation,
): void {
  const { canonicalRequest, ...fields } = actual;
  const { canonicalRequest: expectedRequest, ...expectedFields } = expected;
  requirePreparation(
    canonicalRequest === expectedRequest && samePreparationValue(fields, expectedFields),
  );
}
function comparePreparation(
  actual: RetainedRuntimePreparation,
  expected: RetainedRuntimePreparation,
): void {
  record(actual, [
    "status",
    "preparationRef",
    "target",
    "localVersion",
    "retainedChildSequence",
    "localState",
    "guard",
    "plan",
    "preparation",
    "children",
    "bindingProposals",
  ]);
  const { children, bindingProposals, ...header } = actual;
  const {
    children: originalChildren,
    bindingProposals: originalBindings,
    ...originalHeader
  } = expected;
  requirePreparation(samePreparationValue(header, originalHeader));
  array(children, 256);
  array(bindingProposals, 1);
  requirePreparation(
    children.length === originalChildren.length &&
      bindingProposals.length === originalBindings.length,
  );
  children.forEach((child, index) =>
    requirePreparation(samePreparationValue(child, originalChildren[index])),
  );
  bindingProposals.forEach((binding, index) =>
    requirePreparation(samePreparationValue(binding, originalBindings[index])),
  );
}

/** Pure historical correspondence only. No lookup, clock, provider, identity,
 * source registry, gate transition or currentness assertion is implemented here.
 * Malformed/mismatched records throw; the enclosing State owner maps hidden scope
 * and availability. A scoped absent read does not prove provider absence. */
export function resolveRuntimePreparationCreateReferenceV1(
  scope: RuntimeAuthorityScopeV1,
  locator: RuntimePreparationCreateLocatorV1,
  originalRead: RuntimePreparationCreateCorrelationReadV1,
): RuntimePreparationCreateReferenceResultV1 {
  canonicalRuntimePreparation(scope);
  record(scope, ["installationId", "namespaceId", "agentId"]);
  requirePreparation(
    Object.values(scope).every((value) => typeof value === "string" && value.length > 0),
  );
  locator = parseRuntimePreparationCreateLocatorV1(locator);
  record(
    originalRead,
    ["status"],
    [
      "childOperation",
      "history",
      "preparation",
      "child",
      "providerWireUtf8",
      "submission",
      "response",
    ],
  );
  if (originalRead.status === "absent") {
    record(originalRead, ["status"]);
    return Object.freeze({ status: "absent" });
  }
  requirePreparation(originalRead.status === "retained");
  record(
    originalRead,
    ["status", "childOperation", "history", "preparation", "child", "providerWireUtf8"],
    ["submission", "response"],
  );
  const childOperation = decodeRuntimePreparationOperation(originalRead.childOperation);
  const selected = retainedRuntimePreparationRequest(childOperation);
  requirePreparation(selected.kind === "retain-child" && selected.child.request.kind === "create");
  requirePreparation(selected.child.providerTarget.apiKind === "Deployment");
  requirePreparation(samePreparationValue(scopeOf(childOperation.target), scope));
  requirePreparation(samePreparationValue(selected.child.effect.target, childOperation.target));
  requirePreparation(samePreparationValue(originalRead.child, selected.child));
  requirePreparation(originalRead.providerWireUtf8 === selected.providerWireUtf8);
  const child = selected.child;
  const providerWireUtf8 = selected.providerWireUtf8;
  requirePreparation(
    Buffer.byteLength(providerWireUtf8, "utf8") === child.providerWire.byteLength &&
      runtimePreparationDigest(providerWireUtf8) === child.providerWire.bytesDigest,
  );
  if (locator.kind === "create-effect")
    requirePreparation(locator.createEffectRef === child.effect.effectRef);

  let submission: RuntimePreparationCreateSubmissionV1 | undefined;
  if (Object.hasOwn(originalRead, "submission")) {
    const value = originalRead.submission;
    canonicalRuntimePreparation(value);
    record(value, [
      "submissionRef",
      "effectRef",
      "installationId",
      "namespaceId",
      "agentId",
      "revisionId",
      "preparationRef",
      "preparationVersion",
      "requestDigest",
      "providerWireDigest",
      "submittedAt",
    ]);
    uuid(value.submissionRef);
    timestamp(value.submittedAt);
    requirePreparation(samePreparationValue(scopeOf(value), scope));
    requirePreparation(
      value.effectRef === child.effect.effectRef &&
        value.revisionId === childOperation.target.revisionId &&
        value.preparationRef === childOperation.preparationRef,
    );
    requirePreparation(
      Number.isSafeInteger(value.preparationVersion) &&
        value.preparationVersion >= childOperation.localVersion,
    );
    requirePreparation(
      value.requestDigest === child.effect.requestDigest &&
        value.providerWireDigest === child.providerWire.bytesDigest,
    );
    if (locator.kind === "submission")
      requirePreparation(value.submissionRef === locator.submissionRef);
    submission = immutableCopy(value);
  }
  requirePreparation(locator.kind !== "submission" || submission !== undefined);
  const version = submission?.preparationVersion ?? childOperation.localVersion;
  array(originalRead.history);
  requirePreparation(originalRead.history.length === version);
  const history = originalRead.history.map(decodeRuntimePreparationOperation);
  const operations = new Set<string>();
  const effects = new Set<string>();
  let sequence = 0,
    bindings = 0;
  let previous: StoredRuntimePreparationOperation | undefined;
  let activePlan: RetainedRuntimePreparation["plan"] | undefined;
  let activePreparation: RetainedRuntimePreparation["preparation"] | undefined;
  for (const [index, entry] of history.entries()) {
    const request = retainedRuntimePreparationRequest(entry);
    requirePreparation(
      entry.localVersion === index + 1 &&
        entry.preparationRef === childOperation.preparationRef &&
        samePreparationValue(entry.target, childOperation.target),
    );
    requirePreparation(!operations.has(entry.operationRef));
    operations.add(entry.operationRef);
    if (!previous)
      requirePreparation(
        request.kind === "retain-plan" &&
          request.expectedVersion === null &&
          request.guard.admittedChildCutoff === 0,
      );
    else
      requirePreparation(
        request.kind !== "retain-plan" &&
          previous.localState === "open" &&
          samePreparationValue(request.guard, previous.guard),
      );
    if (request.kind === "retain-plan") {
      activePlan = request.plan;
      activePreparation = request.preparation;
    }
    if (request.kind === "supersede-plan") {
      requirePreparation(previous && activePreparation);
      requirePreparation(
        request.nextGuard.gateVersion === previous.guard.gateVersion + 1 &&
          request.nextGuard.requestedFenceEpoch >= previous.guard.requestedFenceEpoch,
      );
      requirePreparation(
        request.nextGuard.responsibility.responsibilityRef ===
          previous.guard.responsibility.responsibilityRef &&
          request.nextGuard.responsibility.responsibilityVersion >=
            previous.guard.responsibility.responsibilityVersion,
      );
      requirePreparation(
        request.nextGuard.planRef === previous.guard.planRef &&
          request.nextGuard.planVersion === previous.guard.planVersion + 1 &&
          request.nextGuard.admittedChildCutoff === previous.guard.admittedChildCutoff,
      );
      requirePreparation(
        samePreparationValue(request.preparation, activePreparation) ||
          request.preparation.preparationVersion === activePreparation.preparationVersion + 1,
      );
      activePlan = request.plan;
      activePreparation = request.preparation;
    }
    if (request.kind === "retain-child") {
      requirePreparation(previous && activePlan && activePreparation);
      requirePreparation(
        samePreparationValue(request.child.request.plan, activePlan) &&
          samePreparationValue(
            request.child.effect.responsibility,
            previous.guard.responsibility,
          ) &&
          request.child.effect.responsibility.kind === "preparation",
      );
      if (request.child.request.kind === "create")
        requirePreparation(
          samePreparationValue(request.child.request.preparation, activePreparation),
        );
      requirePreparation(!effects.has(request.child.effect.effectRef));
      effects.add(request.child.effect.effectRef);
      sequence += 1;
    }
    if (request.kind === "retain-binding") {
      bindings += 1;
      requirePreparation(bindings <= 1);
    }
    requirePreparation(entry.retainedChildSequence === sequence && sequence <= 256);
    previous = entry;
  }
  compareOperation(history[childOperation.localVersion - 1]!, childOperation);
  const preparation = projectRuntimePreparation(history);
  requirePreparation(preparation);
  comparePreparation(originalRead.preparation, preparation);
  const matches = preparation.children.filter(
    (entry) => entry.child.effect.effectRef === child.effect.effectRef,
  );
  requirePreparation(
    matches.length === 1 &&
      samePreparationValue(matches[0]!.child, child) &&
      matches[0]!.providerWireUtf8 === providerWireUtf8,
  );

  let response: RuntimePreparationDeploymentResponseV1 | undefined;
  if (Object.hasOwn(originalRead, "response")) {
    requirePreparation(submission);
    const value = originalRead.response;
    canonicalRuntimePreparation(value);
    record(value, ["namespace", "name", "uid", "resourceVersion", "receivedAt"]);
    requirePreparation(
      typeof value.namespace === "string" &&
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value.namespace),
    );
    requirePreparation(value.name === child.providerTarget.name);
    requirePreparation(
      typeof value.uid === "string" &&
        value.uid.length > 0 &&
        typeof value.resourceVersion === "string" &&
        value.resourceVersion.length > 0,
    );
    timestamp(value.receivedAt);
    // The response clock belongs to the SDK host; the submission clock belongs
    // to the database. Preserve both without inventing a cross-clock ordering.
    if (child.predicate.kind === "expected-object")
      requirePreparation(value.uid === child.predicate.uid);
    response = immutableCopy(value);
  }
  const input = parseRuntimeEffectsV1("exactCreate", {
    schemaVersion: 1,
    effect: child.effect,
    providerTarget: child.providerTarget,
    expectedObject: null,
  });
  return Object.freeze({
    status: "located",
    input,
    retained: Object.freeze({
      status: "retained",
      childOperation,
      history: Object.freeze(history),
      preparation,
      child,
      providerWireUtf8,
      ...(submission === undefined ? {} : { submission }),
      ...(response === undefined ? {} : { response }),
    }),
  });
}
