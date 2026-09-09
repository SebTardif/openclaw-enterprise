import { createHash } from "node:crypto";
import type { Readable, Writable } from "node:stream";

export const NATIVE_FRAME_LIMIT = 131072;
export const NATIVE_REQUEST_LIMIT = 65536;
export const nativeUnavailable = () => new Error("Gateway native startup unavailable");
export const nativeDigest = (bytes: Uint8Array): string =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** This channel selects canonical UTF-8 JSON, further constrained by a closed
 * message shape. Comparing the re-encoding rejects duplicate names, alternate
 * number spellings and escaped aliases before either side can select fields. */
export function nativeJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (JSON.stringify(value) !== text) throw nativeUnavailable();
  const visit = (item: unknown, depth: number): void => {
    if (depth > 32) throw nativeUnavailable();
    if (typeof item === "number" && !Number.isSafeInteger(item)) throw nativeUnavailable();
    if (item !== null && typeof item === "object")
      for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(value, 0);
  return value;
}
export function closedNativeObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw nativeUnavailable();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key)))
    throw nativeUnavailable();
  return object;
}
export function nativePayload(value: unknown, maximum = NATIVE_REQUEST_LIMIT): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maximum / 3) * 4)
    throw nativeUnavailable();
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maximum || bytes.toString("base64") !== value) throw nativeUnavailable();
  return bytes;
}
export function nativeTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw nativeUnavailable();
  return value;
}

/** Owns no authority. The caller owns the child and invalidates it on failure.
 * No frame queue is retained: onFrame runs synchronously once per bounded frame.
 * A partial-frame timer starts on its first byte, including a partial prefix. */
export function consumeNativeFrames(
  stream: Readable,
  onFrame: (bytes: Buffer) => void,
  onFailure: (reason: "eof" | "error") => void,
): () => void {
  let prefix = Buffer.alloc(4),
    prefixUsed = 0,
    body: Buffer | undefined,
    bodyUsed = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const fail = () => {
    if (!stopped) {
      stop();
      onFailure("error");
    }
  };
  const end = () => {
    if (stopped) return;
    if (prefixUsed !== 0 || body !== undefined) {
      fail();
      return;
    }
    stop();
    onFailure("eof");
  };
  const data = (chunk: Buffer) => {
    try {
      let offset = 0;
      while (offset < chunk.length && !stopped) {
        timer ??= setTimeout(fail, 3000);
        if (body === undefined) {
          const copied = chunk.copy(prefix, prefixUsed, offset, offset + 4 - prefixUsed);
          prefixUsed += copied;
          offset += copied;
          if (prefixUsed !== 4) continue;
          const length = prefix.readUInt32BE();
          if (length < 1 || length > NATIVE_FRAME_LIMIT) throw nativeUnavailable();
          body = Buffer.alloc(length);
        }
        const copied = chunk.copy(body, bodyUsed, offset, offset + body.length - bodyUsed);
        bodyUsed += copied;
        offset += copied;
        if (bodyUsed !== body.length) continue;
        clearTimeout(timer);
        timer = undefined;
        const complete = body;
        prefixUsed = 0;
        body = undefined;
        bodyUsed = 0;
        onFrame(complete);
      }
    } catch {
      fail();
    }
  };
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    stream.off("data", data);
    stream.off("end", end);
    stream.off("error", fail);
    stream.off("close", fail);
  };
  stream.on("data", data);
  stream.once("end", end);
  stream.once("error", fail);
  stream.once("close", fail);
  return stop;
}

/** One caller serializes writes. Callback completion or abort settles the actual
 * write; the owning child shutdown destroys its stream to interrupt backpressure. */
export async function writeNativeFrame(
  stream: Writable,
  value: unknown,
  signal: AbortSignal,
): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length < 1 || bytes.length > NATIVE_FRAME_LIMIT || signal.aborted)
    throw nativeUnavailable();
  const frame = Buffer.alloc(4 + bytes.length);
  frame.writeUInt32BE(bytes.length);
  bytes.copy(frame, 4);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      stream.destroy();
      reject(nativeUnavailable());
    };
    signal.addEventListener("abort", abort, { once: true });
    stream.write(frame, (error) => {
      signal.removeEventListener("abort", abort);
      if (error || signal.aborted) reject(nativeUnavailable());
      else resolve();
    });
    if (signal.aborted) abort();
  });
}
