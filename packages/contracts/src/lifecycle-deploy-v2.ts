import { types } from "node:util";
import { Type, type TProperties, type TSchema } from "typebox";
import { Check } from "typebox/value";
import {
  ConfigurationGeneration,
  ConfigurationId,
  HarnessExecutionModeSchema,
  InstallationId,
  ProviderId,
  ServiceAccountId,
} from "./api/common.ts";
import type { ProviderRef } from "./drivers/provider.ts";
import type { HarnessExecutionMode } from "./resources/agent.ts";
import {
  LIFECYCLE_ADMISSION_LIMITS_V1,
  LifecycleGenerationBodySchemaV1,
  LifecycleOperationReadRequestSchemaV1,
  LifecycleScopeSchemaV1,
  type LifecycleGenerationBodyV1,
  type LifecycleScopeV1,
} from "./lifecycle-admission-v1.ts";
import {
  WorkloadProfileSelectionSchemaV1,
  decodeWorkloadProfileSelectionV1,
  type WorkloadProfileSelectionV1,
} from "./workload-profile-v1.ts";

/** Data-only command identity. These codecs install no route, admission or replay writer. */
export const LIFECYCLE_DEPLOY_LIMITS_V2 = Object.freeze({
  maxJsonBytes: LIFECYCLE_ADMISSION_LIMITS_V1.maxJsonBytes,
  maxDepth: LIFECYCLE_ADMISSION_LIMITS_V1.maxDepth,
  maxNodes: LIFECYCLE_ADMISSION_LIMITS_V1.maxNodes,
  maxContainerEntries: LIFECYCLE_ADMISSION_LIMITS_V1.maxContainerEntries,
});
const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const selectionProperties = WorkloadProfileSelectionSchemaV1.properties;
// Copy unfrozen imported schema fragments before freezing this module's registry.
const selection = object({
  manifestRef: { ...selectionProperties.manifestRef },
  manifestDigest: { ...selectionProperties.manifestDigest },
  admissionRef: { ...selectionProperties.admissionRef },
  admissionVersion: { ...selectionProperties.admissionVersion },
});

export const LifecycleDeployExpectedDraftSchemaV2 = object({
  configurationId: { ...ConfigurationId },
  configurationGeneration: { ...ConfigurationGeneration },
  providerId: Type.Union([{ ...ProviderId }, Type.Null()]),
  executionMode: Type.Union(HarnessExecutionModeSchema.anyOf.map((schema) => ({ ...schema }))),
  maximumExecutionMs: Type.Union([
    Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    Type.Null(),
  ]),
  serviceAccountId: Type.Union([{ ...ServiceAccountId }, Type.Null()]),
  workloadProfileSelection: selection,
});
export interface LifecycleDeployExpectedDraftV2 {
  readonly configurationId: string;
  readonly configurationGeneration: number;
  readonly providerId: ProviderRef;
  readonly executionMode: HarnessExecutionMode;
  readonly maximumExecutionMs: number | null;
  readonly serviceAccountId: string | null;
  readonly workloadProfileSelection: Readonly<WorkloadProfileSelectionV1>;
}

/** Exact client-retained body. Scope and accepting actor are never body operands. */
export const LifecycleDeployCommandSchemaV2 = object({
  schemaVersion: Type.Literal(2),
  operationRef: LifecycleOperationReadRequestSchemaV1.properties.operationRef,
  expectedLifecycleGeneration:
    LifecycleGenerationBodySchemaV1.properties.expectedLifecycleGeneration,
  revisionSource: Type.Literal("saved-draft"),
  expectedDraft: LifecycleDeployExpectedDraftSchemaV2,
});
export interface LifecycleDeployCommandV2 {
  readonly schemaVersion: 2;
  readonly operationRef: string;
  readonly expectedLifecycleGeneration: LifecycleGenerationBodyV1["expectedLifecycleGeneration"];
  readonly revisionSource: "saved-draft";
  readonly expectedDraft: LifecycleDeployExpectedDraftV2;
}

/** Route Namespace/Agent plus the server-owned Installation, never an authorization proof. */
export const LifecycleDeployScopeSchemaV2 = object({
  installationId: { ...InstallationId },
  ...LifecycleScopeSchemaV1.properties,
});
export interface LifecycleDeployScopeV2 extends LifecycleScopeV1 {
  readonly installationId: string;
}
export const LifecycleDeployBindingSchemaV2 = object({
  action: Type.Literal("agent.deploy"),
  scope: LifecycleDeployScopeSchemaV2,
  command: LifecycleDeployCommandSchemaV2,
});
export interface LifecycleDeployBindingV2 {
  readonly action: "agent.deploy";
  readonly scope: LifecycleDeployScopeV2;
  readonly command: LifecycleDeployCommandV2;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const LifecycleDeploySchemasV2 = freeze({
  expectedDraft: LifecycleDeployExpectedDraftSchemaV2,
  command: LifecycleDeployCommandSchemaV2,
  scope: LifecycleDeployScopeSchemaV2,
  binding: LifecycleDeployBindingSchemaV2,
});
export interface LifecycleDeploySchemaTypesV2 {
  readonly expectedDraft: LifecycleDeployExpectedDraftV2;
  readonly command: LifecycleDeployCommandV2;
  readonly scope: LifecycleDeployScopeV2;
  readonly binding: LifecycleDeployBindingV2;
}
export type LifecycleDeploySchemaNameV2 = keyof LifecycleDeploySchemaTypesV2;
export type LifecycleDeploySchemaValueV2<K extends LifecycleDeploySchemaNameV2> =
  LifecycleDeploySchemaTypesV2[K];

export class LifecycleDeployErrorV2 extends Error {
  readonly code = "INVALID_REQUEST" as const;
  constructor() {
    super("Invalid lifecycle deploy data.");
    this.name = "LifecycleDeployErrorV2";
  }
}
function reject(): never {
  throw new LifecycleDeployErrorV2();
}
type Data = null | boolean | number | string | readonly Data[] | { readonly [key: string]: Data };
function scalarString(value: string): boolean {
  for (let at = 0; at < value.length; at++) {
    const code = value.charCodeAt(at);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++at);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function copyData(
  input: unknown,
  seen: Set<object>,
  budget: { nodes: number; bytes: number },
  depth = 0,
): Data {
  if (depth > LIFECYCLE_DEPLOY_LIMITS_V2.maxDepth || --budget.nodes < 0) reject();
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isSafeInteger(input) || input < 0 || Object.is(input, -0)) reject();
    return input;
  }
  if (typeof input === "string") {
    if (input.length > budget.bytes || !scalarString(input)) reject();
    budget.bytes -= new TextEncoder().encode(input).byteLength;
    if (budget.bytes < 0) reject();
    return input;
  }
  if (typeof input !== "object" || types.isProxy(input) || seen.has(input)) reject();
  const array = Array.isArray(input);
  const prototype = Object.getPrototypeOf(input);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    reject();
  const keys = Reflect.ownKeys(input);
  if (keys.length > LIFECYCLE_DEPLOY_LIMITS_V2.maxContainerEntries + (array ? 1 : 0)) reject();
  seen.add(input);
  if (array) {
    if (keys.length !== input.length + 1) reject();
    const output: Data[] = [];
    for (let index = 0; index < input.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) reject();
      output.push(copyData(descriptor.value, seen, budget, depth + 1));
    }
    return output;
  }
  const output: { [key: string]: Data } = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/.test(key)) reject();
    budget.bytes -= key.length;
    if (budget.bytes < 0) reject();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) reject();
    output[key] = copyData(descriptor.value, seen, budget, depth + 1);
  }
  return output;
}
function canonical(value: Data): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

/** Plain data only. Raw transport must use the JSON parser before duplicate keys are lost. */
export function parseLifecycleDeployV2<K extends LifecycleDeploySchemaNameV2>(
  kind: K,
  input: unknown,
): LifecycleDeploySchemaValueV2<K> {
  try {
    if (typeof kind !== "string" || !Object.hasOwn(LifecycleDeploySchemasV2, kind)) reject();
    const value = copyData(input, new Set(), {
      nodes: LIFECYCLE_DEPLOY_LIMITS_V2.maxNodes,
      bytes: LIFECYCLE_DEPLOY_LIMITS_V2.maxJsonBytes,
    });
    if (
      new TextEncoder().encode(canonical(value)).byteLength >
      LIFECYCLE_DEPLOY_LIMITS_V2.maxJsonBytes
    )
      reject();
    const schema: TSchema = LifecycleDeploySchemasV2[kind];
    if (!Check(schema, value)) reject();
    if (kind !== "scope") {
      let draft: LifecycleDeployExpectedDraftV2;
      if (kind === "binding")
        draft = (value as unknown as LifecycleDeployBindingV2).command.expectedDraft;
      else if (kind === "command")
        draft = (value as unknown as LifecycleDeployCommandV2).expectedDraft;
      else draft = value as unknown as LifecycleDeployExpectedDraftV2;
      if (decodeWorkloadProfileSelectionV1(draft.workloadProfileSelection).kind !== "valid")
        reject();
    }
    return freeze(value) as unknown as LifecycleDeploySchemaValueV2<K>;
  } catch {
    return reject();
  }
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
function transportText(input: string | Uint8Array): string {
  if (typeof input === "string") {
    if (
      input.length > LIFECYCLE_DEPLOY_LIMITS_V2.maxJsonBytes ||
      new TextEncoder().encode(input).byteLength > LIFECYCLE_DEPLOY_LIMITS_V2.maxJsonBytes
    )
      reject();
    return input;
  }
  if (!types.isUint8Array(input) || types.isProxy(input)) reject();
  const length = byteLengthGetter.call(input) as number;
  if (length > LIFECYCLE_DEPLOY_LIMITS_V2.maxJsonBytes) reject();
  const buffer = bufferGetter.call(input) as ArrayBuffer;
  if (types.isSharedArrayBuffer(buffer)) reject();
  const offset = byteOffsetGetter.call(input) as number;
  const bytes = new Uint8Array(new Uint8Array(buffer, offset, length));
  // Preserve a BOM so the JSON grammar rejects it, and never replace malformed UTF-8.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function json(text: string): unknown {
  let at = 0;
  let nodes = 0;
  const ws = () => {
    while (/[\x20\x09\x0a\x0d]/.test(text[at] ?? "!")) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const character = text[at++];
      if (character === "\\") at++;
      else if (character === '"') {
        const result: string = JSON.parse(text.slice(start, at));
        if (!scalarString(result)) reject();
        return result;
      }
    }
    return reject();
  };
  const value = (depth: number): unknown => {
    if (
      depth > LIFECYCLE_DEPLOY_LIMITS_V2.maxDepth ||
      ++nodes > LIFECYCLE_DEPLOY_LIMITS_V2.maxNodes
    )
      reject();
    ws();
    if (text[at] === '"') return string();
    if (text[at] === "{") {
      at++;
      ws();
      const result: Record<string, unknown> = Object.create(null);
      if (text[at] === "}") {
        at++;
        return result;
      }
      let entries = 0;
      for (;;) {
        if (++entries > LIFECYCLE_DEPLOY_LIMITS_V2.maxContainerEntries) reject();
        ws();
        if (text[at] !== '"') reject();
        const key = string();
        if (Object.hasOwn(result, key)) reject();
        ws();
        if (text[at++] !== ":") reject();
        result[key] = value(depth + 1);
        ws();
        const next = text[at++];
        if (next === "}") return result;
        if (next !== ",") reject();
      }
    }
    if (text[at] === "[") {
      at++;
      ws();
      const result: unknown[] = [];
      if (text[at] === "]") {
        at++;
        return result;
      }
      for (;;) {
        if (result.length >= LIFECYCLE_DEPLOY_LIMITS_V2.maxContainerEntries) reject();
        result.push(value(depth + 1));
        ws();
        const next = text[at++];
        if (next === "]") return result;
        if (next !== ",") reject();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      text.slice(at),
    );
    if (!token) reject();
    at += token[0].length;
    const parsed: unknown = JSON.parse(token[0]);
    // Reject numeric aliases before JSON.parse rounding can conceal a different expectation.
    if (
      typeof parsed === "number" &&
      (!/^(?:0|[1-9][0-9]*)$/.test(token[0]) || !Number.isSafeInteger(parsed))
    )
      reject();
    return parsed;
  };
  const result = value(0);
  ws();
  if (at !== text.length) reject();
  return result;
}

/** Bounded strict JSON/UTF-8 decoding, including escaped duplicate names and integer lexemes. */
export function parseLifecycleDeployJsonV2<K extends LifecycleDeploySchemaNameV2>(
  kind: K,
  input: string | Uint8Array,
): LifecycleDeploySchemaValueV2<K> {
  try {
    return parseLifecycleDeployV2(kind, json(transportText(input)));
  } catch {
    return reject();
  }
}
export type LifecycleDeployDecodeResultV2<T> =
  { readonly kind: "valid"; readonly value: T } | { readonly kind: "invalid" };
export function decodeLifecycleDeployV2<K extends LifecycleDeploySchemaNameV2>(
  kind: K,
  input: unknown,
): LifecycleDeployDecodeResultV2<LifecycleDeploySchemaValueV2<K>> {
  try {
    return Object.freeze({ kind: "valid", value: parseLifecycleDeployV2(kind, input) });
  } catch {
    return Object.freeze({ kind: "invalid" });
  }
}
export function decodeLifecycleDeployJsonV2<K extends LifecycleDeploySchemaNameV2>(
  kind: K,
  input: string | Uint8Array,
): LifecycleDeployDecodeResultV2<LifecycleDeploySchemaValueV2<K>> {
  try {
    return Object.freeze({ kind: "valid", value: parseLifecycleDeployJsonV2(kind, input) });
  } catch {
    return Object.freeze({ kind: "invalid" });
  }
}

/** Assemble inert identity after obtaining exact route and server Installation data.
 * The accepting owner must separately authenticate the original actor, authorize
 * original operands and retain this binding in its existing admission transaction. */
export function bindLifecycleDeployCommandV2(
  scopeInput: unknown,
  commandInput: unknown,
): LifecycleDeployBindingV2 {
  return parseLifecycleDeployV2("binding", {
    action: "agent.deploy",
    scope: parseLifecycleDeployV2("scope", scopeInput),
    command: parseLifecycleDeployV2("command", commandInput),
  });
}

/** Full normalized identity, encoded as UTF-8 JSON without a digest or trailing newline.
 * Object keys sort lexicographically; strings preserve scalar values without Unicode
 * normalization. Compare all bytes, under the separately retained original actor.
 * No transport request ID, current draft lookup or authority is introduced here. */
export function canonicalLifecycleDeployCommandV2(
  scopeInput: unknown,
  commandInput: unknown,
): string {
  return canonical(bindLifecycleDeployCommandV2(scopeInput, commandInput) as unknown as Data);
}
