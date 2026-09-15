import { types } from "node:util";
import { performance } from "node:perf_hooks";
import { ownData } from "./destination-config.ts";
import { DestinationError } from "./destination-types.ts";

// Capture native operations; caller-owned signal methods are never subscriptions.
const NativeAbortSignal = AbortSignal;
const nativeAny = NativeAbortSignal.any;
const nativeAborted = Object.getOwnPropertyDescriptor(NativeAbortSignal.prototype, "aborted")!.get!;
const nativeReason = Object.getOwnPropertyDescriptor(NativeAbortSignal.prototype, "reason")!.get!;
const nativeAdd = EventTarget.prototype.addEventListener;
const nativeRemove = EventTarget.prototype.removeEventListener;
const nativeDispatch = EventTarget.prototype.dispatchEvent;

function retainedSignal(value: unknown): AbortSignal {
  if (
    !value ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== NativeAbortSignal.prototype ||
    !(value instanceof NativeAbortSignal) ||
    ["constructor", "aborted", "reason", "dispatchEvent"].some((key) => Object.hasOwn(value, key))
  )
    throw new DestinationError("invalid-bounds");
  // The getter alone accepts transparent Proxies; isProxy must precede native use.
  nativeAborted.call(value);
  const signal = nativeAny.call(NativeAbortSignal, [value as AbortSignal]);
  // addAbortListener dynamically calls signal methods, including during disposal.
  // A private native dependent pins those methods and bypasses source event suppression.
  Object.defineProperties(signal, {
    constructor: { value: NativeAbortSignal },
    aborted: { get: nativeAborted },
    reason: { get: nativeReason },
    addEventListener: { value: nativeAdd },
    removeEventListener: { value: nativeRemove },
    dispatchEvent: { value: nativeDispatch },
  });
  return signal;
}

export interface SelectionBounds {
  readonly signal: AbortSignal;
  readonly duration: number;
  currentError(): DestinationError | undefined;
}

export function retainBounds(bounds: unknown, lookupTimeoutMs: number): SelectionBounds {
  let signal: AbortSignal;
  let deadline: number;
  let aborted: boolean;
  // Normalize descriptor, type and native-brand inspection before any effects.
  try {
    if (!bounds || typeof bounds !== "object") throw new DestinationError("invalid-bounds");
    const inputSignal = ownData(bounds, "signal");
    const inputDeadline = ownData(bounds, "deadline");
    if (
      types.isProxy(inputSignal) ||
      typeof inputDeadline !== "number" ||
      !Number.isSafeInteger(inputDeadline)
    )
      throw new DestinationError("invalid-bounds");
    signal = retainedSignal(inputSignal);
    deadline = inputDeadline;
    aborted = nativeAborted.call(signal);
  } catch {
    throw new DestinationError("invalid-bounds");
  }
  if (aborted) throw new DestinationError("aborted");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new DestinationError("deadline");
  const duration = Math.min(remaining, lookupTimeoutMs);
  const monotonicDeadline = performance.now() + duration;
  return {
    signal,
    duration,
    currentError() {
      try {
        if (nativeAborted.call(signal)) return new DestinationError("aborted");
        if (Date.now() >= deadline || performance.now() >= monotonicDeadline) {
          return new DestinationError("deadline");
        }
        return undefined;
      } catch {
        return new DestinationError("invalid-bounds");
      }
    },
  };
}
