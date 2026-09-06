import { createHash } from "node:crypto";
import { types } from "node:util";

export const WORKLOAD_PROFILE_CANONICAL_FORMAT = "oce.workload-profile.canonical-json.v1" as const;

/** Byte limits apply to both received UTF-8 and canonical output. Structural
 * limits bound this lexical utility; they are not a manifest field dictionary.
 * Depth counts containers (the root container is depth 1). Nodes count values,
 * including containers, but not object keys. */
export const WORKLOAD_PROFILE_JSON_LIMITS = Object.freeze({
  maxBytes: 65_536,
  maxDepth: 32,
  maxContainerEntries: 1_024,
  maxNodes: 8_192,
});

export type WorkloadProfileJsonMode = "manifest-content" | "operator-envelope";
export type WorkloadProfileJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly WorkloadProfileJsonValue[]
  | { readonly [key: string]: WorkloadProfileJsonValue };

export interface DecodedWorkloadProfileJson {
  readonly value: WorkloadProfileJsonValue;
  /** Independently allocated bytes. Mutating them does not mutate value. */
  readonly canonicalBytes: Uint8Array;
}

export type WorkloadProfileJsonErrorCode =
  | "invalid-input"
  | "invalid-utf8"
  | "invalid-json"
  | "duplicate-key"
  | "invalid-unicode"
  | "invalid-number"
  | "null-forbidden"
  | "non-ascii-key"
  | "byte-limit"
  | "depth-limit"
  | "container-limit"
  | "node-limit"
  | "unsupported-value"
  | "invalid-mode"
  | "invalid-domain";

export class WorkloadProfileJsonError extends Error {
  readonly code: WorkloadProfileJsonErrorCode;

  constructor(code: WorkloadProfileJsonErrorCode) {
    super(`Invalid workload profile JSON: ${code}`);
    this.name = "WorkloadProfileJsonError";
    this.code = code;
  }
}

export const WORKLOAD_PROFILE_DIGEST_DOMAINS = Object.freeze({
  manifestDigest: "oce.workload-profile.manifest.v1\n",
  artifactSetDigest: "oce.workload-profile.artifact-set.v1\n",
  launchConfigurationDigest: "oce.workload-profile.launch-configuration.v1\n",
  containmentDigest: "oce.workload-profile.containment.v1\n",
  endpointsDigest: "oce.workload-profile.endpoints.v1\n",
  evidenceRequirementsDigest: "oce.workload-profile.evidence-requirements.v1\n",
  providerProfileDigest: "oce.workload-profile.provider-profile.v1\n",
  runtimeProfileDigest: "oce.workload-profile.runtime-profile.v1\n",
  identityProfileDigest: "oce.workload-profile.identity-profile.v1\n",
  storageProfileDigest: "oce.workload-profile.storage-profile.v1\n",
  imageSetDigest: "oce.workload-profile.image-set.v1\n",
  mountPolicyDigest: "oce.workload-profile.mount-policy.v1\n",
  resourceEnvelopeDigest: "oce.workload-profile.resource-envelope.v1\n",
  runtimeFlagsDigest: "oce.workload-profile.runtime-flags.v1\n",
  admittedConfigurationDigest: "oce.workload-profile.admitted-configuration.v1\n",
});

export type WorkloadProfileDigestDomain = keyof typeof WORKLOAD_PROFILE_DIGEST_DOMAINS;

export const WORKLOAD_PROFILE_OPERATOR_DIGEST_DOMAINS = Object.freeze({
  clientIntentDigest: "oce.workload-profile.operator-intent.v1\n",
  operationDigest: "oce.workload-profile.operator-operation.v1\n",
});

const encoder = new TextEncoder();
const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;

function reject(code: WorkloadProfileJsonErrorCode): never {
  throw new WorkloadProfileJsonError(code);
}

function checkMode(mode: WorkloadProfileJsonMode): void {
  if (mode !== "manifest-content" && mode !== "operator-envelope") {
    reject("invalid-mode");
  }
}

function checkAsciiKey(key: string): void {
  if (key.length > WORKLOAD_PROFILE_JSON_LIMITS.maxBytes) reject("byte-limit");
  for (let index = 0; index < key.length; index += 1) {
    if (key.charCodeAt(index) > 0x7f) reject("non-ascii-key");
  }
}

function checkUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) reject("invalid-unicode");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      reject("invalid-unicode");
    }
  }
}

function checkContainer(depth: number, entries: number): void {
  if (depth > WORKLOAD_PROFILE_JSON_LIMITS.maxDepth) reject("depth-limit");
  if (entries > WORKLOAD_PROFILE_JSON_LIMITS.maxContainerEntries) {
    reject("container-limit");
  }
}

class LexicalParser {
  #text: string;
  #mode: WorkloadProfileJsonMode;
  #position = 0;
  #nodes = 0;

  constructor(text: string, mode: WorkloadProfileJsonMode) {
    this.#text = text;
    this.#mode = mode;
  }

  parse(): WorkloadProfileJsonValue {
    const value = this.#value(0);
    this.#whitespace();
    if (this.#position !== this.#text.length) reject("invalid-json");
    return value;
  }

  #whitespace(): void {
    while (
      this.#text[this.#position] === " " ||
      this.#text[this.#position] === "\t" ||
      this.#text[this.#position] === "\n" ||
      this.#text[this.#position] === "\r"
    ) {
      this.#position += 1;
    }
  }

  #value(depth: number): WorkloadProfileJsonValue {
    this.#nodes += 1;
    if (this.#nodes > WORKLOAD_PROFILE_JSON_LIMITS.maxNodes) reject("node-limit");
    this.#whitespace();
    const first = this.#text[this.#position];
    if (first === '"') return this.#string();
    if (first === "{") return this.#object(depth + 1);
    if (first === "[") return this.#array(depth + 1);
    if (first !== undefined && first >= "0" && first <= "9") {
      return this.#integer();
    }
    if (this.#text.startsWith("true", this.#position)) {
      this.#position += 4;
      return true;
    }
    if (this.#text.startsWith("false", this.#position)) {
      this.#position += 5;
      return false;
    }
    if (this.#text.startsWith("null", this.#position)) {
      if (this.#mode !== "operator-envelope") reject("null-forbidden");
      this.#position += 4;
      return null;
    }
    if (first === "-" || first === "+" || first === ".") {
      reject("invalid-number");
    }
    reject("invalid-json");
  }

  #integer(): number {
    const start = this.#position;
    if (this.#text[this.#position] === "0") {
      this.#position += 1;
    } else {
      while (this.#digit()) this.#position += 1;
    }
    const next = this.#text[this.#position];
    if (this.#digit() || next === "." || next === "e" || next === "E") {
      reject("invalid-number");
    }
    const lexeme = this.#text.slice(start, this.#position);
    if (lexeme.length > 16 || (lexeme.length === 16 && lexeme > "9007199254740991")) {
      reject("invalid-number");
    }
    return Number(lexeme);
  }

  #digit(): boolean {
    const value = this.#text[this.#position];
    return value !== undefined && value >= "0" && value <= "9";
  }

  #string(): string {
    this.#position += 1;
    const chunks: string[] = [];
    while (this.#position < this.#text.length) {
      const character = this.#text[this.#position]!;
      this.#position += 1;
      if (character === '"') {
        const value = chunks.join("");
        checkUnicode(value);
        return value;
      }
      if (character.charCodeAt(0) < 0x20) reject("invalid-json");
      if (character !== "\\") {
        chunks.push(character);
        continue;
      }
      const escape = this.#text[this.#position];
      this.#position += 1;
      if (escape === '"' || escape === "\\" || escape === "/") {
        chunks.push(escape);
      } else if (escape === "b") {
        chunks.push("\b");
      } else if (escape === "f") {
        chunks.push("\f");
      } else if (escape === "n") {
        chunks.push("\n");
      } else if (escape === "r") {
        chunks.push("\r");
      } else if (escape === "t") {
        chunks.push("\t");
      } else if (escape === "u") {
        const hex = this.#text.slice(this.#position, this.#position + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) reject("invalid-json");
        chunks.push(String.fromCharCode(Number.parseInt(hex, 16)));
        this.#position += 4;
      } else {
        reject("invalid-json");
      }
    }
    reject("invalid-json");
  }

  #object(depth: number): WorkloadProfileJsonValue {
    checkContainer(depth, 0);
    this.#position += 1;
    const result: { [key: string]: WorkloadProfileJsonValue } = Object.create(null);
    const seen = new Set<string>();
    this.#whitespace();
    if (this.#text[this.#position] === "}") {
      this.#position += 1;
      return Object.freeze(result);
    }
    while (true) {
      checkContainer(depth, seen.size + 1);
      if (this.#text[this.#position] !== '"') reject("invalid-json");
      const key = this.#string();
      checkAsciiKey(key);
      if (seen.has(key)) reject("duplicate-key");
      seen.add(key);
      this.#whitespace();
      if (this.#text[this.#position] !== ":") reject("invalid-json");
      this.#position += 1;
      result[key] = this.#value(depth);
      this.#whitespace();
      const separator = this.#text[this.#position];
      this.#position += 1;
      if (separator === "}") return Object.freeze(result);
      if (separator !== ",") reject("invalid-json");
      this.#whitespace();
    }
  }

  #array(depth: number): WorkloadProfileJsonValue {
    checkContainer(depth, 0);
    this.#position += 1;
    const result: WorkloadProfileJsonValue[] = [];
    this.#whitespace();
    if (this.#text[this.#position] === "]") {
      this.#position += 1;
      return Object.freeze(result);
    }
    while (true) {
      checkContainer(depth, result.length + 1);
      result.push(this.#value(depth));
      this.#whitespace();
      const separator = this.#text[this.#position];
      this.#position += 1;
      if (separator === "]") return Object.freeze(result);
      if (separator !== ",") reject("invalid-json");
    }
  }
}

class CanonicalWriter {
  #parts: string[] = [];
  #bytes = 0;
  #nodes = 0;
  #active = new Set<object>();
  #mode: WorkloadProfileJsonMode;

  constructor(mode: WorkloadProfileJsonMode) {
    this.#mode = mode;
  }

  encode(value: unknown): Uint8Array {
    this.#value(value, 0);
    return encoder.encode(this.#parts.join(""));
  }

  #append(part: string): void {
    this.#bytes += Buffer.byteLength(part, "utf8");
    if (this.#bytes > WORKLOAD_PROFILE_JSON_LIMITS.maxBytes) reject("byte-limit");
    this.#parts.push(part);
  }

  #string(value: string): void {
    if (value.length > WORKLOAD_PROFILE_JSON_LIMITS.maxBytes) reject("byte-limit");
    checkUnicode(value);
    this.#append('"');
    // Iterate scalar values so a surrogate pair is counted as its four UTF-8 bytes.
    for (const character of value) {
      if (character === '"') this.#append('\\"');
      else if (character === "\\") this.#append("\\\\");
      else if (character === "\b") this.#append("\\b");
      else if (character === "\f") this.#append("\\f");
      else if (character === "\n") this.#append("\\n");
      else if (character === "\r") this.#append("\\r");
      else if (character === "\t") this.#append("\\t");
      else if (character.charCodeAt(0) < 0x20) {
        this.#append(`\\u00${character.charCodeAt(0).toString(16).padStart(2, "0")}`);
      } else this.#append(character);
    }
    this.#append('"');
  }

  #value(value: unknown, depth: number): void {
    this.#nodes += 1;
    if (this.#nodes > WORKLOAD_PROFILE_JSON_LIMITS.maxNodes) reject("node-limit");
    if (value === null) {
      if (this.#mode !== "operator-envelope") reject("null-forbidden");
      this.#append("null");
      return;
    }
    if (typeof value === "string") {
      this.#string(value);
      return;
    }
    if (typeof value === "boolean") {
      this.#append(value ? "true" : "false");
      return;
    }
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
        reject("invalid-number");
      }
      this.#append(String(value));
      return;
    }
    if (typeof value !== "object" || types.isProxy(value)) {
      reject("unsupported-value");
    }
    if (this.#active.has(value)) reject("unsupported-value");
    this.#active.add(value);
    if (Array.isArray(value)) this.#array(value, depth + 1);
    else this.#object(value, depth + 1);
    this.#active.delete(value);
  }

  #dataProperty(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      reject("unsupported-value");
    }
    return descriptor.value;
  }

  #array(value: unknown[], depth: number): void {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      reject("unsupported-value");
    }
    const length = Object.getOwnPropertyDescriptor(value, "length")!.value as number;
    checkContainer(depth, length);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1) reject("unsupported-value");
    this.#append("[");
    for (let index = 0; index < length; index += 1) {
      if (index > 0) this.#append(",");
      this.#value(this.#dataProperty(value, String(index)), depth);
    }
    this.#append("]");
  }

  #object(value: object, depth: number): void {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      reject("unsupported-value");
    }
    const keys = Reflect.ownKeys(value);
    checkContainer(depth, keys.length);
    const names: string[] = [];
    for (const key of keys) {
      if (typeof key !== "string") reject("unsupported-value");
      checkAsciiKey(key);
      names.push(key);
    }
    names.sort();
    this.#append("{");
    let count = 0;
    for (const name of names) {
      if (count > 0) this.#append(",");
      this.#string(name);
      this.#append(":");
      this.#value(this.#dataProperty(value, name), depth);
      count += 1;
    }
    this.#append("}");
  }
}

/** Decode bytes before a schema owner validates its closed field dictionary.
 * This checks only bounded lexical/encoding rules; successful decoding does not
 * validate a manifest, normalize schema-defined sets, or authorize profile use.
 * Operator-envelope mode permits null lexically; its schema owner must restrict
 * null to explicitly declared fields and validate manifest content separately. */
export function decodeWorkloadProfileJson(
  input: Uint8Array,
  mode: WorkloadProfileJsonMode = "manifest-content",
): DecodedWorkloadProfileJson {
  checkMode(mode);
  if (types.isProxy(input) || !types.isUint8Array(input)) reject("invalid-input");
  if (Reflect.apply(typedArrayByteLength, input, []) > WORKLOAD_PROFILE_JSON_LIMITS.maxBytes) {
    reject("byte-limit");
  }
  if (types.isSharedArrayBuffer(Reflect.apply(typedArrayBuffer, input, []))) {
    reject("invalid-input");
  }
  let text: string;
  try {
    // Preserve a leading BOM in the decoded text so JSON grammar rejects it.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
  } catch {
    reject("invalid-utf8");
  }
  const value = new LexicalParser(text, mode).parse();
  const canonicalBytes = canonicalizeWorkloadProfileJson(value, mode);
  return Object.freeze({ value, canonicalBytes });
}

/** Encode data after the owning schema has validated and normalized it. The
 * unknown-value boundary rejects accessors, proxies and non-JSON object shapes
 * without calling toJSON or coercing objects. It cannot recover number lexemes
 * or duplicate keys lost by an earlier ordinary JSON.parse. */
export function canonicalizeWorkloadProfileJson(
  value: unknown,
  mode: WorkloadProfileJsonMode = "manifest-content",
): Uint8Array {
  checkMode(mode);
  return new CanonicalWriter(mode).encode(value);
}

function digest(prefix: string, value: unknown, mode: WorkloadProfileJsonMode): string {
  return `sha256:${createHash("sha256")
    .update(prefix, "utf8")
    .update(canonicalizeWorkloadProfileJson(value, mode))
    .digest("hex")}`;
}

/** Select the exact schema-owned projection for this domain before hashing.
 * A content hash is byte identity only, never evidence of schema or admission. */
export function workloadProfileDigest(domain: WorkloadProfileDigestDomain, value: unknown): string {
  if (typeof domain !== "string" || !Object.hasOwn(WORKLOAD_PROFILE_DIGEST_DOMAINS, domain)) {
    reject("invalid-domain");
  }
  return digest(WORKLOAD_PROFILE_DIGEST_DOMAINS[domain], value, "manifest-content");
}

/** Hash the closed ordinary client intent, before server identity allocation. */
export function operatorIntentDigest(value: unknown): string {
  return digest(
    WORKLOAD_PROFILE_OPERATOR_DIGEST_DOMAINS.clientIntentDigest,
    value,
    "operator-envelope",
  );
}

/** Hash the separately validated envelope binding clientIntentDigest, original
 * actor/scope and all once-allocated operation identities. Allocation and replay
 * are repository responsibilities; this helper does not allocate or validate. */
export function operatorOperationDigest(value: unknown): string {
  return digest(
    WORKLOAD_PROFILE_OPERATOR_DIGEST_DOMAINS.operationDigest,
    value,
    "operator-envelope",
  );
}
