import { IncomingMessage } from "node:http";
import { addAbortListener, EventEmitter } from "node:events";
import { types } from "node:util";
import { createGitHubMetadataOperationV1 } from "@openclaw-enterprise/occ";
import type { Bounds, GitHubMetadataRepositoryV1 } from "@openclaw-enterprise/occ";
import { inspectRequestHeadV1 } from "../http/request.ts";
import { projectMetadataResponseV1, snapshotMetadataRepositoryV1 } from "./metadata.ts";
import type {
  MetadataFailureV1,
  MetadataInspectionResultV1,
  MetadataReadResultV1,
} from "./metadata.ts";

const RESPONSE_BODY_LIMIT_BYTES = 1_048_576;
const RESPONSE_HEADER_LIMIT_BYTES = 32_768;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\x20-\x7e]*$/;
const signalPrototype = AbortSignal.prototype;
const nativeAbortedGetter = Object.getOwnPropertyDescriptor(signalPrototype, "aborted")?.get;
const nativeAdd = EventTarget.prototype.addEventListener;
const nativeRemove = EventTarget.prototype.removeEventListener;
const nativeMessageOn = EventEmitter.prototype.on;
const nativeMessageRemoveListener = EventEmitter.prototype.removeListener;
const nativeDestroy = IncomingMessage.prototype.destroy;
const nativeResume = IncomingMessage.prototype.resume;
const now = Date.now;
interface CapturedBounds {
  readonly signal: AbortSignal;
  readonly original: Bounds;
  deadline: number;
}
const failure = (kind: MetadataFailureV1["kind"]): MetadataFailureV1 => Object.freeze({ kind });
function isAborted(signal: AbortSignal): boolean {
  if (!nativeAbortedGetter) throw new Error("Native signal state unavailable");
  return Reflect.apply(nativeAbortedGetter, signal, []);
}
function captureBounds(bounds: Bounds): CapturedBounds | null {
  try {
    if (bounds === null || typeof bounds !== "object") return null;
    // Retain exactly the operands that were validated, before any other reflection.
    const signal = bounds.signal;
    const deadline = bounds.deadline;
    if (!signal || types.isProxy(signal) || !Number.isSafeInteger(deadline) || deadline <= 0)
      return null;
    isAborted(signal);
    return { signal, deadline, original: bounds };
  } catch {
    return null;
  }
}
// addAbortListener resists stopImmediatePropagation, but internally looks up these
// properties. Permit only the captured native descriptors, without invoking getters.
function supportsSubscription(signal: AbortSignal): boolean {
  if (Object.getPrototypeOf(signal) !== signalPrototype) return false;
  for (const name of ["aborted", "addEventListener", "removeEventListener"])
    if (Object.getOwnPropertyDescriptor(signal, name)) return false;
  if (Object.getPrototypeOf(signalPrototype) !== EventTarget.prototype) return false;
  return (
    Object.getOwnPropertyDescriptor(signalPrototype, "aborted")?.get === nativeAbortedGetter &&
    !Object.getOwnPropertyDescriptor(signalPrototype, "addEventListener") &&
    !Object.getOwnPropertyDescriptor(signalPrototype, "removeEventListener") &&
    Object.getOwnPropertyDescriptor(EventTarget.prototype, "addEventListener")?.value ===
      nativeAdd &&
    Object.getOwnPropertyDescriptor(EventTarget.prototype, "removeEventListener")?.value ===
      nativeRemove
  );
}
function boundsFailure(bounds: CapturedBounds): MetadataFailureV1 | null {
  try {
    const signal = bounds.original.signal;
    const deadline = bounds.original.deadline;
    if (signal !== bounds.signal || !Number.isSafeInteger(deadline) || deadline <= 0)
      return failure("unavailable");
    bounds.deadline = Math.min(bounds.deadline, deadline);
    const supported = supportsSubscription(bounds.signal);
    // All caller reflection is over. Never add a getter after these final guards.
    if (isAborted(bounds.signal)) return failure("aborted");
    if (!supported) return failure("unavailable");
    if (now() >= bounds.deadline) return failure("expired");
    return null;
  } catch {
    return failure("unavailable");
  }
}
function stopMessage(message: IncomingMessage) {
  try {
    Reflect.apply(nativeDestroy, message, []);
  } catch {
    // Native destruction is best effort for a malformed local stream operand.
  }
}
function hasTrailers(message: IncomingMessage): boolean {
  return message.rawTrailers.length !== 0 || Object.keys(message.trailers).length !== 0;
}

/** Own only the message stream. No connection establishment, header forwarding or credential use. */
function collectMessageBody(
  message: IncomingMessage,
  limit: number,
  declared: number | null,
  bounds: CapturedBounds,
  invalid: "invalid-request" | "invalid-response",
): Promise<{ body: Uint8Array; bytes: number } | MetadataFailureV1> {
  return new Promise((resolve) => {
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listeners: [string, (...args: never[]) => void][] = [];
    function cleanup(): boolean {
      let clean = true;
      // Attempt every cleanup even if one local operand is malformed.
      const attempt = (action: () => void) => {
        try {
          action();
        } catch {
          clean = false;
        }
      };
      attempt(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
      attempt(() => {
        Reflect.apply(nativeRemove, bounds.signal, ["abort", aborted]);
      });
      for (const [event, listener] of listeners)
        attempt(() => {
          Reflect.apply(nativeMessageRemoveListener, message, [event, listener]);
        });
      return clean;
    }
    function finish(result: { body: Uint8Array; bytes: number } | MetadataFailureV1) {
      if (settled) return;
      settled = true;
      if (!cleanup()) result = failure("unavailable");
      chunks.length = 0;
      if ("kind" in result) stopMessage(message);
      resolve(result);
    }
    function guarded(action: () => void) {
      if (settled) return;
      try {
        action();
      } catch {
        finish(failure("unavailable"));
      }
    }
    function aborted() {
      finish(failure("aborted"));
    }
    function streamAborted() {
      guarded(() => finish(boundsFailure(bounds) ?? failure(invalid)));
    }
    function error() {
      guarded(() => finish(boundsFailure(bounds) ?? failure("unavailable")));
    }
    function closed() {
      guarded(() => {
        if (!message.readableEnded) finish(boundsFailure(bounds) ?? failure(invalid));
      });
    }
    function data(chunk: unknown) {
      guarded(() => {
        const stopped = boundsFailure(bounds);
        if (settled) return;
        if (stopped) {
          finish(stopped);
          return;
        }
        if (!Buffer.isBuffer(chunk)) {
          finish(failure(invalid));
          return;
        }
        bytes += chunk.length;
        if (bytes > limit) {
          finish(failure("limit-exceeded"));
          return;
        }
        if (declared !== null && bytes > declared) {
          finish(failure(invalid));
          return;
        }
        chunks.push(chunk);
      });
    }
    function end() {
      guarded(() => {
        const valid =
          message.complete &&
          !message.aborted &&
          !hasTrailers(message) &&
          (declared === null || bytes === declared);
        const stopped = boundsFailure(bounds);
        if (settled) return;
        if (stopped) {
          finish(stopped);
          return;
        }
        if (!valid) {
          finish(failure(invalid));
          return;
        }
        finish({ body: Buffer.concat(chunks, bytes), bytes });
      });
    }
    function schedule() {
      timer = setTimeout(expire, Math.min(2147483647, Math.max(1, bounds.deadline - now())));
    }
    function expire() {
      guarded(() => {
        const stopped = boundsFailure(bounds);
        if (settled) return;
        if (stopped) finish(stopped);
        else schedule();
      });
    }
    guarded(() => {
      if (isAborted(bounds.signal)) {
        finish(failure("aborted"));
        return;
      }
      if (!supportsSubscription(bounds.signal)) {
        finish(failure("unavailable"));
        return;
      }
      // Retain callback identity ourselves: the library disposer does a late,
      // shadowable removeEventListener lookup.
      addAbortListener(bounds.signal, aborted);
      const invalidStream =
        message.destroyed ||
        message.aborted ||
        message.readableEnded ||
        message.readableEncoding !== null ||
        message.readableDidRead;
      const stopped = boundsFailure(bounds);
      if (settled) return;
      if (stopped) {
        finish(stopped);
        return;
      }
      if (invalidStream) {
        finish(failure(invalid));
        return;
      }
      for (const [event, listener] of [
        ["data", data],
        ["end", end],
        ["aborted", streamAborted],
        ["error", error],
        ["close", closed],
      ] satisfies [string, (...args: never[]) => void][]) {
        listeners.push([event, listener]);
        Reflect.apply(nativeMessageOn, message, [event, listener]);
        if (settled) {
          Reflect.apply(nativeMessageRemoveListener, message, [event, listener]);
          return;
        }
      }
      schedule();
      Reflect.apply(nativeResume, message, []);
    });
  });
}

export async function inspectGitHubMetadataRequestV1(
  request: IncomingMessage,
  repository: Readonly<GitHubMetadataRepositoryV1>,
  requestId: string,
  bounds: Bounds,
): Promise<MetadataInspectionResultV1> {
  try {
    const captured = captureBounds(bounds);
    if (!captured || !(request instanceof IncomingMessage)) return failure("invalid-request");
    // Check the original state before even reading a repository operand.
    if (isAborted(captured.signal)) {
      stopMessage(request);
      return failure("aborted");
    }
    const operation = createGitHubMetadataOperationV1(repository, requestId);
    if (!operation) return failure("invalid-request");
    const expected = operation.target.repository;
    const parsed = inspectRequestHeadV1(request);
    if (parsed.kind !== "parsed")
      return failure(parsed.code === "limit-exceeded" ? "limit-exceeded" : "invalid-request");
    const { head } = parsed;
    if (
      head.route.kind !== "metadata" ||
      head.route.owner !== expected.canonicalOwner ||
      head.route.repository !== expected.canonicalName ||
      head.contentEncoding !== "identity" ||
      head.expectContinue ||
      head.bodyLimits.wire !== 0 ||
      head.bodyLimits.decoded !== 0 ||
      head.framing.kind === "chunked" ||
      (head.framing.kind === "content-length" && head.framing.bytes !== 0) ||
      hasTrailers(request)
    )
      return failure("invalid-request");
    const stopped = boundsFailure(captured);
    if (stopped) {
      stopMessage(request);
      return stopped;
    }
    const collected = await collectMessageBody(request, 0, 0, captured, "invalid-request");
    if ("kind" in collected) return collected;
    const valid = request.complete && !hasTrailers(request);
    const after = boundsFailure(captured);
    if (after) {
      stopMessage(request);
      return after;
    }
    if (!valid) {
      stopMessage(request);
      return failure("invalid-request");
    }
    return Object.freeze({ kind: "inspected", operation });
  } catch {
    if (request instanceof IncomingMessage) stopMessage(request);
    return failure("unavailable");
  }
}

function inspectResponseHead(
  response: IncomingMessage,
): { declared: number | null } | MetadataFailureV1 {
  if (
    response.httpVersion !== "1.1" ||
    response.statusCode !== 200 ||
    response.rawHeaders.length % 2 !== 0 ||
    response.rawHeaders.length > 256
  )
    return failure("invalid-response");
  const headers = new Map<string, string>();
  let headerBytes = 0;
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    const name = response.rawHeaders[i];
    const value = response.rawHeaders[i + 1];
    if (
      typeof name !== "string" ||
      typeof value !== "string" ||
      !HEADER_NAME.test(name) ||
      !HEADER_VALUE.test(value)
    )
      return failure("invalid-response");
    headerBytes += name.length + value.length;
    if (headerBytes > RESPONSE_HEADER_LIMIT_BYTES) return failure("limit-exceeded");
    const key = name.toLowerCase();
    if (
      headers.has(key) ||
      /(?:authorization|authenticate|authentication|cookie|credential|token|secret|api-key)/.test(
        key,
      ) ||
      ["location", "refresh", "trailer", "upgrade", "content-range"].includes(key)
    )
      return failure("invalid-response");
    headers.set(key, value);
  }
  const coding = headers.get("content-encoding");
  const type = headers.get("content-type");
  const connection = headers.get("connection");
  if (
    (coding !== undefined && coding !== "identity") ||
    (type !== "application/json" && type !== "application/json; charset=utf-8") ||
    (connection !== undefined && !["close", "keep-alive"].includes(connection.toLowerCase()))
  )
    return failure("invalid-response");
  const length = headers.get("content-length");
  const transfer = headers.get("transfer-encoding");
  if (length !== undefined) {
    if (transfer !== undefined || !/^(0|[1-9][0-9]*)$/.test(length))
      return failure("invalid-response");
    const declared = Number(length);
    if (!Number.isSafeInteger(declared)) return failure("invalid-response");
    if (declared > RESPONSE_BODY_LIMIT_BYTES) return failure("limit-exceeded");
    return { declared };
  }
  if (transfer !== "chunked") return failure("invalid-response");
  return { declared: null };
}

export async function readGitHubMetadataResponseV1(
  response: IncomingMessage,
  expected: Readonly<GitHubMetadataRepositoryV1>,
  bounds: Bounds,
): Promise<MetadataReadResultV1> {
  try {
    const captured = captureBounds(bounds);
    if (!captured || !(response instanceof IncomingMessage)) {
      if (response instanceof IncomingMessage) stopMessage(response);
      return failure("invalid-response");
    }
    if (isAborted(captured.signal)) {
      stopMessage(response);
      return failure("aborted");
    }
    const repository = snapshotMetadataRepositoryV1(expected);
    if (!repository) {
      stopMessage(response);
      return failure("invalid-response");
    }
    const head = inspectResponseHead(response);
    if ("kind" in head) {
      stopMessage(response);
      return head;
    }
    const stopped = boundsFailure(captured);
    if (stopped) {
      stopMessage(response);
      return stopped;
    }
    const collected = await collectMessageBody(
      response,
      RESPONSE_BODY_LIMIT_BYTES,
      head.declared,
      captured,
      "invalid-response",
    );
    if ("kind" in collected) return collected;
    const valid = response.complete && !hasTrailers(response);
    const value = valid ? projectMetadataResponseV1(collected.body, repository) : null;
    const after = boundsFailure(captured);
    if (after) {
      stopMessage(response);
      return after;
    }
    if (!value) {
      stopMessage(response);
      return failure("invalid-response");
    }
    return Object.freeze({ kind: "metadata", value, bytes: collected.bytes });
  } catch {
    if (response instanceof IncomingMessage) stopMessage(response);
    return failure("unavailable");
  }
}
