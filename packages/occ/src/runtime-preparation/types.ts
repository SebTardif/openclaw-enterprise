import { createHash } from "node:crypto";
import {
  canonicalRuntimeAuthorityMutationV1,
  parseRuntimeAuthorityV1,
  parseRuntimeEffectsV1,
  type BindRuntimeV1,
  type ExactAuthorityOperationV1,
  type RuntimeAssignmentTargetV1,
  type RuntimeAuthorityScopeV1,
  type RuntimeClosedPlanV1,
  type RuntimeCreateV1,
  type RuntimeGateGuardV1,
  type RuntimePreparedChildV1,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ScopeViolationError } from "../errors.ts";
import { exactRuntimeAuthorityOperation } from "../runtime-authority/repository.ts";

/** Internal retained data. None of these records grants effect or runtime authority. */
export interface RuntimePreparationIntent {
  readonly intentRef: string;
  readonly mode: "running" | "disabled" | "stopped";
  readonly lifecycleGeneration: number;
}
interface MutationIdentity {
  readonly schemaVersion: 1;
  readonly operationRef: string;
  readonly preparationRef: string;
  readonly target: RuntimeAssignmentTargetV1;
  readonly currentIntent: RuntimePreparationIntent;
}
interface ExistingPreparation extends MutationIdentity {
  readonly expectedVersion: number;
  readonly guard: RuntimeGateGuardV1;
}
export type RuntimePreparationMutation =
  | (MutationIdentity & {
      readonly kind: "retain-plan";
      readonly expectedVersion: null;
      readonly guard: RuntimeGateGuardV1;
      readonly plan: RuntimeClosedPlanV1;
      readonly preparation: RuntimeCreateV1["preparation"];
    })
  | (ExistingPreparation & {
      readonly kind: "retain-child";
      readonly child: RuntimePreparedChildV1;
      readonly providerWireUtf8: string;
    })
  | (ExistingPreparation & {
      readonly kind: "retain-binding";
      readonly proposal: BindRuntimeV1;
      readonly operation: ExactAuthorityOperationV1;
    })
  | (ExistingPreparation & {
      readonly kind: "supersede-plan";
      readonly nextGuard: RuntimeGateGuardV1;
      readonly plan: RuntimeClosedPlanV1;
      readonly preparation: RuntimeCreateV1["preparation"];
    })
  | (ExistingPreparation & {
      readonly kind: "close";
      readonly reason: "closed" | "superseded";
    });

export interface RuntimePreparationAttribution {
  readonly writerRef: string;
  readonly recordedAt: string;
}
export interface StoredRuntimePreparationOperation {
  readonly schemaVersion: 1;
  readonly operationRef: string;
  readonly preparationRef: string;
  readonly target: RuntimeAssignmentTargetV1;
  readonly kind: RuntimePreparationMutation["kind"];
  readonly localVersion: number;
  readonly retainedChildSequence: number;
  readonly localState: "open" | "closed" | "superseded";
  readonly guard: RuntimeGateGuardV1;
  readonly canonicalRequest: string;
  readonly requestDigest: string;
  readonly attribution: RuntimePreparationAttribution;
}
export interface RetainedRuntimePreparation {
  readonly status: "retained";
  readonly preparationRef: string;
  readonly target: RuntimeAssignmentTargetV1;
  readonly localVersion: number;
  readonly retainedChildSequence: number;
  readonly localState: "open" | "closed" | "superseded";
  readonly guard: RuntimeGateGuardV1;
  readonly plan: RuntimeClosedPlanV1;
  readonly preparation: RuntimeCreateV1["preparation"];
  readonly children: readonly Readonly<{
    sequence: number;
    child: RuntimePreparedChildV1;
    providerWireUtf8: string;
  }>[];
  readonly bindingProposals: readonly Readonly<{
    proposal: BindRuntimeV1;
    canonicalProposalJson: string;
    operation: ExactAuthorityOperationV1;
  }>[];
}
export interface RuntimePreparationWriteResult {
  readonly status: "retained" | "exact-replay";
  readonly operation: StoredRuntimePreparationOperation;
}
export type { RuntimeAuthorityScopeV1 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REF = /^[A-Za-z0-9._:/-]{1,200}$/;
export const RUNTIME_PREPARATION_MAX_REQUEST_BYTES = 1_048_576;
export function requirePreparation(value: unknown): asserts value {
  if (!value) throw new ScopeViolationError("The retained runtime preparation data is invalid.");
}
function exactString(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.exec(value)?.[0] === value;
}
function data(value: unknown, depth = 0): void {
  requirePreparation(depth <= 40);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    requirePreparation(
      !value.includes("\0") && Buffer.from(value, "utf8").toString("utf8") === value,
    );
    return;
  }
  if (typeof value === "number") {
    requirePreparation(Number.isSafeInteger(value) && value >= 0);
    return;
  }
  requirePreparation(typeof value === "object");
  const array = Array.isArray(value);
  requirePreparation(
    array
      ? Object.getPrototypeOf(value) === Array.prototype
      : [Object.prototype, null].includes(Object.getPrototypeOf(value)),
  );
  const properties = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  requirePreparation(keys.every((key) => typeof key === "string"));
  requirePreparation(keys.length <= 1025);
  if (array)
    requirePreparation(
      value.length <= 1024 &&
        Object.keys(value).length === value.length &&
        Object.keys(value).every((key, index) => key === String(index)),
    );
  for (const [key, descriptor] of Object.entries(properties)) {
    if (array && key === "length") continue;
    requirePreparation(descriptor.enumerable && "value" in descriptor);
    data(descriptor.value, depth + 1);
  }
}
export function canonicalRuntimePreparation(
  value: unknown,
  maxBytes = RUNTIME_PREPARATION_MAX_REQUEST_BYTES,
): string {
  data(value);
  const encode = (item: unknown): string => {
    if (item === null || typeof item !== "object") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  };
  const result = encode(value);
  requirePreparation(Buffer.byteLength(result, "utf8") <= maxBytes);
  return result;
}
export function runtimePreparationDigest(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}
export function samePreparationValue(a: unknown, b: unknown): boolean {
  return canonicalRuntimePreparation(a) === canonicalRuntimePreparation(b);
}
function keys(value: Record<string, unknown>, names: readonly string[]): void {
  requirePreparation(Object.keys(value).sort().join(",") === [...names].sort().join(","));
}
export function parseRuntimePreparationAttribution(input: unknown): RuntimePreparationAttribution {
  data(input);
  requirePreparation(input !== null && typeof input === "object" && !Array.isArray(input));
  const value = input as Record<string, unknown>;
  keys(value, ["writerRef", "recordedAt"]);
  requirePreparation(exactString(value.writerRef, REF) && typeof value.recordedAt === "string");
  const time = Date.parse(value.recordedAt);
  requirePreparation(
    Number.isFinite(time) &&
      new Date(time).toISOString() === value.recordedAt &&
      exactString(
        value.recordedAt,
        /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/,
      ),
  );
  return immutableCopy(value) as unknown as RuntimePreparationAttribution;
}
export function parseRuntimePreparationMutation(input: unknown): RuntimePreparationMutation {
  canonicalRuntimePreparation(input);
  requirePreparation(input !== null && typeof input === "object" && !Array.isArray(input));
  const value = input as Record<string, unknown>;
  const common = [
    "schemaVersion",
    "operationRef",
    "preparationRef",
    "target",
    "currentIntent",
    "kind",
    "expectedVersion",
    "guard",
  ];
  const extras: Record<string, readonly string[]> = {
    "retain-plan": ["plan", "preparation"],
    "retain-child": ["child", "providerWireUtf8"],
    "retain-binding": ["proposal", "operation"],
    "supersede-plan": ["nextGuard", "plan", "preparation"],
    close: ["reason"],
  };
  requirePreparation(typeof value.kind === "string" && Object.hasOwn(extras, value.kind));
  keys(value, [...common, ...extras[value.kind]!]);
  requirePreparation(
    value.schemaVersion === 1 &&
      exactString(value.operationRef, UUID) &&
      exactString(value.preparationRef, UUID),
  );
  const guard = parseRuntimeEffectsV1("gateGuard", value.guard);
  // The accepted target schema is already nested in this exact public locator.
  const target = parseRuntimeEffectsV1("effectLocator", {
    schemaVersion: 1,
    target: value.target,
    effectRef: value.operationRef,
    effectKind: "materialize",
    responsibility: guard.responsibility,
    requestDigest: `sha256:${"0".repeat(64)}`,
  }).target;
  requirePreparation(
    samePreparationValue(guard.scope, {
      installationId: target.installationId,
      namespaceId: target.namespaceId,
      agentId: target.agentId,
    }),
  );
  requirePreparation(guard.responsibility.kind === "preparation");
  requirePreparation(
    value.currentIntent !== null &&
      typeof value.currentIntent === "object" &&
      !Array.isArray(value.currentIntent),
  );
  const intent = value.currentIntent as Record<string, unknown>;
  keys(intent, ["intentRef", "mode", "lifecycleGeneration"]);
  requirePreparation(
    exactString(intent.intentRef, UUID) &&
      ["running", "disabled", "stopped"].includes(String(intent.mode)) &&
      Number.isSafeInteger(intent.lifecycleGeneration) &&
      (intent.lifecycleGeneration as number) >= 1,
  );
  requirePreparation(
    value.kind === "retain-plan"
      ? value.expectedVersion === null
      : Number.isSafeInteger(value.expectedVersion) && (value.expectedVersion as number) >= 1,
  );
  const parsed = { ...value, guard, target };
  if (value.kind === "retain-plan" || value.kind === "supersede-plan") {
    const plan = parseRuntimeEffectsV1("closedPlan", value.plan);
    const next =
      value.kind === "retain-plan" ? guard : parseRuntimeEffectsV1("gateGuard", value.nextGuard);
    requirePreparation(
      samePreparationValue(plan.scope, guard.scope) &&
        next.planRef === plan.planRef &&
        next.planVersion === plan.planVersion &&
        next.planDigest === plan.planDigest,
    );
    requirePreparation(
      samePreparationValue(next.scope, guard.scope) && next.responsibility.kind === "preparation",
    );
    requirePreparation(
      plan.targets.some(
        (item) =>
          samePreparationValue(item.target.ownerAssignmentRef, target.assignmentRef) &&
          item.target.ownerCreateEffectRef === target.createEffectRef,
      ),
    );
    requirePreparation(
      value.preparation !== null &&
        typeof value.preparation === "object" &&
        !Array.isArray(value.preparation),
    );
    const preparation = value.preparation as Record<string, unknown>;
    requirePreparation(preparation.kind === "nonmutating" || preparation.kind === "writable");
    keys(preparation, [
      "kind",
      "preparationRef",
      "preparationVersion",
      "admittedProfileDigest",
      preparation.kind === "nonmutating" ? "retainedStoreAccess" : "priorWriterEvidence",
    ]);
    requirePreparation(
      preparation.preparationRef === value.preparationRef &&
        Number.isSafeInteger(preparation.preparationVersion) &&
        (preparation.preparationVersion as number) >= 1 &&
        exactString(preparation.admittedProfileDigest, /^sha256:[0-9a-f]{64}$/),
    );
    if (preparation.kind === "nonmutating")
      requirePreparation(preparation.retainedStoreAccess === "none");
    else {
      const prior = parseRuntimeEffectsV1(
        "priorWriterEvidenceRef",
        preparation.priorWriterEvidence,
      );
      requirePreparation(
        prior.closedPlanDigest === plan.planDigest &&
          prior.admittedChildCutoff === next.admittedChildCutoff &&
          samePreparationValue(prior.reservation.scope, next.scope) &&
          samePreparationValue(prior.workspaceStore.scope, next.scope) &&
          prior.stores.every((store) => samePreparationValue(store.scope, next.scope)) &&
          new Set(prior.stores.map((store) => store.bindingRef)).size === prior.stores.length &&
          prior.stores.some((store) => samePreparationValue(store, prior.workspaceStore)),
      );
    }
    Object.assign(
      parsed,
      { plan, preparation },
      value.kind === "supersede-plan" ? { nextGuard: next } : {},
    );
  } else if (value.kind === "retain-child") {
    const child = parseRuntimeEffectsV1("preparedChild", value.child);
    requirePreparation(
      samePreparationValue(child.guard, guard) && samePreparationValue(child.effect.target, target),
    );
    requirePreparation(
      typeof value.providerWireUtf8 === "string" &&
        Buffer.byteLength(value.providerWireUtf8, "utf8") === child.providerWire.byteLength &&
        runtimePreparationDigest(value.providerWireUtf8) === child.providerWire.bytesDigest,
    );
    requirePreparation(
      Buffer.byteLength(value.providerWireUtf8, "utf8") >= 1 &&
        Buffer.byteLength(value.providerWireUtf8, "utf8") <= 65_536,
    );
    Object.assign(parsed, { child });
  } else if (value.kind === "retain-binding") {
    const proposal = parseRuntimeAuthorityV1("bind", value.proposal);
    const operation = parseRuntimeAuthorityV1("exactOperation", value.operation);
    requirePreparation(
      samePreparationValue(proposal.target, target) &&
        proposal.responsibilityRef === guard.responsibility.responsibilityRef &&
        proposal.expectedResponsibilityVersion === guard.responsibility.responsibilityVersion &&
        samePreparationValue(operation, exactRuntimeAuthorityOperation(proposal)),
    );
    // Canonical authority bytes omit requestRef; retaining both proposal and locator preserves it.
    canonicalRuntimeAuthorityMutationV1(proposal);
    Object.assign(parsed, { proposal, operation });
  } else requirePreparation(value.reason === "closed" || value.reason === "superseded");
  return immutableCopy(parsed) as unknown as RuntimePreparationMutation;
}

export function parseRuntimePreparationCanonical(input: string): RuntimePreparationMutation {
  requirePreparation(
    typeof input === "string" &&
      Buffer.byteLength(input, "utf8") <= RUNTIME_PREPARATION_MAX_REQUEST_BYTES,
  );
  const value = parseRuntimePreparationMutation(JSON.parse(input));
  // Also rejects duplicate keys, whitespace, number aliases and rounded fractional lexemes.
  requirePreparation(canonicalRuntimePreparation(value) === input);
  return value;
}
