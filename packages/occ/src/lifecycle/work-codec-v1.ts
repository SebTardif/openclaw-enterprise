import { types } from "node:util";
import { LIFECYCLE_ADMISSION_LIMITS_V1 } from "@openclaw-enterprise/contracts/lifecycle-admission-v1";
import { parseReconcileAgentLifecycleV1, type ReconcileAgentLifecycleV1 } from "./work-v1.ts";

export class LifecycleWorkCodecErrorV1 extends Error {
  readonly code = "INVALID_WORK";
  constructor() {
    super("Invalid lifecycle work encoding.");
    this.name = "LifecycleWorkCodecErrorV1";
  }
}

function invalid(): never {
  throw new LifecycleWorkCodecErrorV1();
}

const keys = [
  "schemaVersion",
  "handler",
  "namespaceId",
  "agentId",
  "operationRef",
  "lifecycleGeneration",
  "workId",
] as const;
const byteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)!.get!;
const backingBuffer = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "buffer",
)!.get!;

/** One canonical serialization of the existing inert work input. Encoding never
 * enqueues work, grants authority or changes its original operation identity.
 */
export function encodeLifecycleWorkV1(input: unknown): string {
  try {
    const work = parseReconcileAgentLifecycleV1(input);
    return JSON.stringify(Object.fromEntries(keys.map((key) => [key, work[key]])));
  } catch {
    return invalid();
  }
}

/** Strict flat JSON decoding preserves duplicate-key detection before JSON.parse
 * can discard it. The canonical work schema supplies all value constraints.
 * This is a codec definition, not an installed queue kind or dispatcher.
 */
export function decodeLifecycleWorkV1(input: string | Uint8Array): ReconcileAgentLifecycleV1 {
  try {
    const maximum = LIFECYCLE_ADMISSION_LIMITS_V1.maxJsonBytes;
    let wire: string;
    if (typeof input === "string") {
      if (input.length > maximum || Buffer.byteLength(input, "utf8") > maximum) return invalid();
      wire = input;
    } else {
      if (
        !types.isUint8Array(input) ||
        types.isProxy(input) ||
        types.isSharedArrayBuffer(backingBuffer.call(input)) ||
        byteLength.call(input) > maximum
      )
        return invalid();
      // Keep a BOM visible so the JSON grammar rejects it rather than silently
      // giving byte and string inputs different meanings.
      wire = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
    }
    let offset = 0;
    const whitespace = () => {
      while (offset < wire.length && /[\t\n\r ]/.test(wire[offset]!)) offset++;
    };
    const take = (character: string) => {
      whitespace();
      if (wire[offset++] !== character) invalid();
    };
    const token =
      /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    const value = (): unknown => {
      whitespace();
      token.lastIndex = offset;
      const match = token.exec(wire);
      if (!match) return invalid();
      offset = token.lastIndex;
      return JSON.parse(match[0]);
    };
    const object: Record<string, unknown> = Object.create(null);
    take("{");
    whitespace();
    if (wire[offset] !== "}") {
      while (true) {
        const key = value();
        if (
          typeof key !== "string" ||
          !keys.some((candidate) => candidate === key) ||
          Object.hasOwn(object, key)
        )
          return invalid();
        take(":");
        object[key] = value();
        whitespace();
        if (wire[offset] !== ",") break;
        offset++;
      }
    }
    take("}");
    whitespace();
    if (offset !== wire.length) return invalid();
    return parseReconcileAgentLifecycleV1(object);
  } catch {
    return invalid();
  }
}
