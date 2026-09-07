import { Buffer } from "node:buffer";
import type { Readable, Writable } from "node:stream";

export const MATERIAL_METADATA_BYTES = 2048;
export const MATERIAL_PAYLOAD_BYTES = 28672;
export const MATERIAL_FRAME_BYTES = 32768;
export const MATERIAL_ENDPOINT_BYTES = 65536;

/** These tags carry data on an already owned pipe/connection; none issues authority. */
export const materialFrameKinds = Object.freeze({
  bootstrap: 1,
  ready: 2,
  connected: 3,
  request: 4,
  inspect: 5,
  inspected: 6,
  result: 7,
  completed: 8,
  closed: 9,
} as const);
export type MaterialFrameKindV1 = (typeof materialFrameKinds)[keyof typeof materialFrameKinds];
export interface MaterialFrameV1 {
  readonly kind: MaterialFrameKindV1;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Borrowed mutable view; release zeroes its entire original backing frame. */
  readonly payload: Uint8Array;
  release(): void;
}
type Owned = { bytes: Buffer; metadataText: string; released: boolean; writing: boolean };
const frames = new WeakMap<MaterialFrameV1, Owned>();
const reading = new WeakSet<Readable>();
const writing = new WeakSet<Writable>();
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const backingsInUse = new WeakSet<ArrayBuffer>();
const unavailable = () => new Error("Native material channel unavailable");
const utf8 = new TextDecoder("utf-8", { fatal: true });
/** Exact metadata-only encoding shared with the Go JSON writer; no payload encoder. */
export function materialMetadataTextV1(value: unknown): string {
  let nodes = 0;
  const inspect = (item: unknown, depth: number): void => {
    if (++nodes > 256 || depth > 12) throw unavailable();
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "string") {
      if (Buffer.byteLength(item, "utf8") > MATERIAL_METADATA_BYTES) throw unavailable();
      return;
    }
    if (typeof item === "number" && Number.isSafeInteger(item)) return;
    if (!item || typeof item !== "object") throw unavailable();
    if (Object.getPrototypeOf(item) !== Object.prototype && !Array.isArray(item))
      throw unavailable();
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === "length") continue;
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))
        throw unavailable();
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw unavailable();
      inspect(descriptor.value, depth + 1);
    }
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  inspect(value, 0);
  const text = JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  if (Buffer.byteLength(text, "utf8") > MATERIAL_METADATA_BYTES) throw unavailable();
  return text;
}
function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}
function adopt(bytes: Buffer): MaterialFrameV1 {
  try {
    const length = bytes.readUInt32BE(0) + 4;
    const kind = bytes[4] as MaterialFrameKindV1;
    const headerLength = bytes.readUInt16BE(5);
    const payloadLength = length - 7 - headerLength;
    if (
      length !== bytes.length ||
      length > MATERIAL_FRAME_BYTES ||
      !Number.isInteger(kind) ||
      kind < 1 ||
      kind > 9 ||
      headerLength < 2 ||
      headerLength > MATERIAL_METADATA_BYTES ||
      payloadLength < 0 ||
      payloadLength > MATERIAL_PAYLOAD_BYTES ||
      (kind !== materialFrameKinds.result && payloadLength !== 0)
    )
      throw unavailable();
    const text = utf8.decode(bytes.subarray(7, 7 + headerLength));
    const metadata: unknown = JSON.parse(text);
    if (materialMetadataTextV1(metadata) !== text) throw unavailable();
    freeze(metadata);
    const state: Owned = { bytes, metadataText: text, released: false, writing: false };
    backingsInUse.add(bytes.buffer as ArrayBuffer);
    const result: MaterialFrameV1 = Object.freeze({
      kind,
      metadata: metadata as Readonly<Record<string, unknown>>,
      payload: bytes.subarray(7 + headerLength),
      release() {
        // Pending output still owns the original bytes. Its joined writer releases them.
        if (state.writing) throw unavailable();
        if (!state.released) {
          state.released = true;
          backingsInUse.delete(bytes.buffer as ArrayBuffer);
          new Uint8Array(bytes.buffer).fill(0);
        }
      },
    });
    frames.set(result, state);
    return result;
  } catch {
    new Uint8Array(bytes.buffer).fill(0);
    throw unavailable();
  }
}

/** Allocates the sole native-owned output frame; CRD encodes directly into payload. */
export function createMaterialFrameV1(
  kind: MaterialFrameKindV1,
  metadata: unknown,
  payloadLength = 0,
): MaterialFrameV1 {
  if (
    !Number.isSafeInteger(payloadLength) ||
    payloadLength < 0 ||
    payloadLength > MATERIAL_PAYLOAD_BYTES
  )
    throw unavailable();
  const text = materialMetadataTextV1(metadata),
    headerLength = Buffer.byteLength(text, "utf8");
  const length = 7 + headerLength + payloadLength;
  if (length > MATERIAL_FRAME_BYTES) throw unavailable();
  const bytes = Buffer.alloc(MATERIAL_FRAME_BYTES).subarray(0, length);
  bytes.writeUInt32BE(length - 4, 0);
  bytes[4] = kind;
  bytes.writeUInt16BE(headerLength, 5);
  bytes.write(text, 7, headerLength, "utf8");
  return adopt(bytes);
}

/** Exact full backing ownership is adopted, not copied. Synthetic callers gain no proof. */
export function decodeMaterialFrameV1(value: Uint8Array): MaterialFrameV1 {
  if (
    !(value instanceof Uint8Array) ||
    !(value.buffer instanceof ArrayBuffer) ||
    resizable?.call(value.buffer) === true ||
    backingsInUse.has(value.buffer) ||
    value.byteOffset !== 0 ||
    value.byteLength !== value.buffer.byteLength ||
    value.byteLength < 9 ||
    value.byteLength > MATERIAL_FRAME_BYTES
  )
    throw unavailable();
  return adopt(Buffer.from(value.buffer));
}

/** Detects an encoder changing framing/header through the borrowed payload's backing. */
export function assertMaterialFrameV1(frame: MaterialFrameV1): void {
  const state = frames.get(frame);
  if (!state || state.released) throw unavailable();
  const bytes = state.bytes;
  const headerLength = Buffer.byteLength(state.metadataText, "utf8");
  if (
    bytes.readUInt32BE(0) !== bytes.length - 4 ||
    bytes[4] !== frame.kind ||
    bytes.readUInt16BE(5) !== headerLength ||
    utf8.decode(bytes.subarray(7, 7 + headerLength)) !== state.metadataText ||
    frame.payload.byteOffset !== bytes.byteOffset + 7 + headerLength ||
    frame.payload.byteLength !== bytes.length - 7 - headerLength
  )
    throw unavailable();
}

/** One pending output. No copy, payload string, queue, or success before write settlement. */
export async function writeMaterialFrameV1(
  stream: Writable,
  frame: MaterialFrameV1,
  signal: AbortSignal,
): Promise<void> {
  assertMaterialFrameV1(frame);
  const state = frames.get(frame)!;
  if (state.writing || writing.has(stream) || signal.aborted || stream.destroyed)
    throw unavailable();
  writing.add(stream);
  state.writing = true;
  try {
    await new Promise<void>((resolve, reject) => {
      let failed = false;
      const onError = () => {
        failed = true;
      };
      const onAbort = () => {
        failed = true;
        stream.destroy(unavailable());
      };
      stream.on("error", onError);
      signal.addEventListener("abort", onAbort, { once: true });
      const done = (error?: Error | null) => {
        signal.removeEventListener("abort", onAbort);
        if (error || failed || signal.aborted) {
          // Node may emit error after its write callback. Retain observation
          // through the actual terminal close, with no payload in diagnostics.
          stream.once("close", () => stream.off("error", onError));
          reject(unavailable());
        } else {
          stream.off("error", onError);
          resolve();
        }
      };
      try {
        stream.write(state.bytes, done);
      } catch {
        done(unavailable());
      }
    });
  } finally {
    writing.delete(stream);
    state.writing = false;
    frame.release();
  }
}

/** Reads one frame and adopts one exact owned allocation. No next-frame prefetch. */
export async function readMaterialFrameV1(
  stream: Readable,
  signal: AbortSignal,
  reuse?: MaterialFrameV1,
): Promise<MaterialFrameV1> {
  if (reading.has(stream) || signal.aborted) throw unavailable();
  const original = reuse === undefined ? undefined : frames.get(reuse);
  const backing = original?.bytes.buffer as ArrayBuffer | undefined;
  if (
    reuse !== undefined &&
    (!original?.released ||
      original.writing ||
      !backing ||
      backing.byteLength !== MATERIAL_FRAME_BYTES ||
      backingsInUse.has(backing))
  )
    throw unavailable();
  if (backing) backingsInUse.add(backing);
  reading.add(stream);
  let allocation: Buffer | undefined;
  const readInto = async (target: Uint8Array): Promise<void> => {
    let offset = 0;
    while (offset < target.byteLength) {
      if (signal.aborted || stream.destroyed || stream.readableEnded) throw unavailable();
      // Consume a present partial fragment. Waiting for the entire remaining
      // length can repeatedly re-notify readable and starve later fragments.
      // A single-byte read borrows the first segment instead of asking Node to
      // concatenate fragments through a larger global Buffer pool. The bounded
      // frame is the only allocation this reader creates.
      const chunk: unknown = stream.read(1);
      if (chunk !== null) {
        if (
          !(chunk instanceof Uint8Array) ||
          chunk.byteLength === 0 ||
          chunk.byteLength > target.byteLength - offset ||
          chunk.buffer.byteLength > MATERIAL_FRAME_BYTES
        )
          throw unavailable();
        target.set(chunk, offset);
        offset += chunk.byteLength;
        continue;
      }
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          stream.off("readable", ready);
          stream.off("end", bad);
          stream.off("close", bad);
          stream.off("error", bad);
          signal.removeEventListener("abort", bad);
        };
        const ready = () => {
          cleanup();
          resolve();
        };
        const bad = () => {
          cleanup();
          reject(unavailable());
        };
        stream.once("readable", ready);
        stream.once("end", bad);
        stream.once("close", bad);
        stream.once("error", bad);
        signal.addEventListener("abort", bad, { once: true });
        if (signal.aborted || stream.destroyed || stream.readableEnded) bad();
      });
    }
  };
  try {
    // The four-byte prefix shares the eventual frame allocation: no third payload buffer.
    allocation = backing ? Buffer.from(backing) : Buffer.alloc(MATERIAL_FRAME_BYTES);
    allocation.fill(0);
    await readInto(allocation.subarray(0, 4));
    const length = allocation.readUInt32BE(0) + 4;
    if (length < 9 || length > MATERIAL_FRAME_BYTES) throw unavailable();
    await readInto(allocation.subarray(4, length));
    const frame = adopt(allocation.subarray(0, length));
    allocation = undefined;
    return frame;
  } catch {
    throw unavailable();
  } finally {
    allocation?.fill(0);
    reading.delete(stream);
    if (allocation && backing) backingsInUse.delete(backing);
  }
}
