import { addAbortListener } from "node:events";
import { types } from "node:util";
import { BlockList, isIP } from "node:net";
import { performance } from "node:perf_hooks";

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
  // A private native dependent isolates addAbortListener's mutable method calls.
  // Native dependency propagation also bypasses source abort-event suppression.
  Object.defineProperties(signal, {
    constructor: { value: NativeAbortSignal },
    aborted: {
      get() {
        return nativeAborted.call(signal);
      },
    },
    reason: {
      get() {
        return nativeReason.call(signal);
      },
    },
    addEventListener: { value: nativeAdd },
    removeEventListener: { value: nativeRemove },
    dispatchEvent: { value: nativeDispatch },
  });
  return signal;
}

export type GitHubHostname = "github.com" | "api.github.com";
export interface DnsServer {
  readonly address: string;
  readonly port: number;
}
export interface DestinationConfig {
  readonly servers: readonly DnsServer[];
  readonly lookupTimeoutMs: number;
}
export interface DestinationResolver {
  resolve4(hostname: GitHubHostname): Promise<readonly string[]>;
  resolve6(hostname: GitHubHostname): Promise<readonly string[]>;
  cancel(): void;
}
export type DestinationResolverFactory = (
  config: Readonly<DestinationConfig>,
) => DestinationResolver;
export interface NumericDestination {
  readonly hostname: GitHubHostname;
  readonly address: string;
  readonly family: 4 | 6;
  readonly port: 443;
}
export interface DestinationSelector {
  select(
    hostname: GitHubHostname,
    bounds: { readonly signal: AbortSignal; readonly deadline: number },
  ): Promise<Readonly<NumericDestination>>;
}
export class DestinationError extends Error {
  readonly code:
    | "invalid-config"
    | "invalid-host"
    | "invalid-bounds"
    | "aborted"
    | "deadline"
    | "dns-failure"
    | "empty-answer"
    | "answer-limit"
    | "address-denied";

  constructor(code: DestinationError["code"]) {
    super(`Destination selection refused: ${code}`);
    this.name = "DestinationError";
    this.code = code;
  }
}

// Conservative github-public-destination-v1; special-service exceptions stay denied.
const denied = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  denied.addSubnet(address, prefix, "ipv4");
const allowed6 = new BlockList();
allowed6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
] as const)
  denied.addSubnet(address, prefix, "ipv6");

function numericAddress(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 45 && !/[\s%\[\]]/.test(value) && isIP(value) !== 0
  );
}
function publicAddress(value: unknown, family: 4 | 6): value is string {
  if (!numericAddress(value) || isIP(value) !== family) return false;
  if (family === 4) return !denied.check(value, "ipv4");
  return (
    /^[0-9a-fA-F:]+$/.test(value) && allowed6.check(value, "ipv6") && !denied.check(value, "ipv6")
  );
}
function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function retainedConfig(config: DestinationConfig): Readonly<DestinationConfig> {
  if (!config || typeof config !== "object") throw new DestinationError("invalid-config");
  const inputServers = ownData(config, "servers");
  const timeout = ownData(config, "lookupTimeoutMs");
  if (
    !Array.isArray(inputServers) ||
    inputServers.length < 1 ||
    inputServers.length > 3 ||
    typeof timeout !== "number" ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 5000
  ) {
    throw new DestinationError("invalid-config");
  }
  const servers: DnsServer[] = [];
  for (let i = 0; i < inputServers.length; i++) {
    const server = ownData(inputServers, String(i));
    if (!server || typeof server !== "object") throw new DestinationError("invalid-config");
    const address = ownData(server, "address");
    const port = ownData(server, "port");
    if (
      !numericAddress(address) ||
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new DestinationError("invalid-config");
    servers.push(Object.freeze({ address, port }));
  }
  return Object.freeze({ servers: Object.freeze(servers), lookupTimeoutMs: timeout });
}
function copyAnswers(value: unknown, family: 4 | 6): readonly string[] {
  if (!Array.isArray(value)) throw new DestinationError("dns-failure");
  if (value.length > 32) throw new DestinationError("answer-limit");
  const copy: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor) || !publicAddress(descriptor.value, family)) {
      throw new DestinationError("address-denied");
    }
    copy.push(descriptor.value);
  }
  return Object.freeze(copy);
}
function noData(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return Object.getOwnPropertyDescriptor(error, "code")?.value === "ENODATA";
}

export function createDestinationSelector(
  config: DestinationConfig,
  factory: DestinationResolverFactory,
): DestinationSelector {
  let retained: Readonly<DestinationConfig>;
  try {
    if (typeof factory !== "function") throw new DestinationError("invalid-config");
    retained = retainedConfig(config);
  } catch {
    throw new DestinationError("invalid-config");
  }
  return Object.freeze({
    async select(hostname, bounds) {
      if (hostname !== "github.com" && hostname !== "api.github.com") {
        throw new DestinationError("invalid-host");
      }
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
      const duration = Math.min(remaining, retained.lookupTimeoutMs);
      const monotonicDeadline = performance.now() + duration;
      const currentError = (): DestinationError | undefined => {
        try {
          if (nativeAborted.call(signal)) return new DestinationError("aborted");
          if (Date.now() >= deadline || performance.now() >= monotonicDeadline) {
            return new DestinationError("deadline");
          }
          return undefined;
        } catch {
          return new DestinationError("invalid-bounds");
        }
      };
      return new Promise<Readonly<NumericDestination>>((resolve, reject) => {
        let resolver: DestinationResolver | undefined;
        let settled = false;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let subscription: ReturnType<typeof addAbortListener> | undefined;
        const cleanup = (): DestinationError | undefined => {
          clearTimeout(timer);
          const disposable = subscription;
          subscription = undefined;
          let error: DestinationError | undefined;
          try {
            disposable?.[Symbol.dispose]();
          } catch {
            error = new DestinationError("invalid-bounds");
          }
          // Disposal failure must never prevent cancellation or terminal settlement.
          if (resolver && !cancelled) {
            cancelled = true;
            try {
              resolver.cancel();
            } catch {
              /* Cancellation cannot grant authority. */
            }
          }
          return error;
        };
        const fail = (error: DestinationError) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const onAbort = () => fail(new DestinationError("aborted"));
        try {
          subscription = addAbortListener(signal, onAbort);
          timer = setTimeout(
            () => fail(currentError() ?? new DestinationError("deadline")),
            duration,
          );
        } catch {
          fail(new DestinationError("invalid-bounds"));
          return;
        }
        try {
          const beforeFactory = currentError();
          if (beforeFactory) {
            fail(beforeFactory);
            return;
          }
          resolver = factory(retained);
          if (settled) {
            cleanup();
            return;
          }
          if (
            !resolver ||
            typeof resolver.resolve4 !== "function" ||
            typeof resolver.resolve6 !== "function" ||
            typeof resolver.cancel !== "function"
          ) {
            fail(new DestinationError("dns-failure"));
            return;
          }
          const afterFactory = currentError();
          if (afterFactory) {
            fail(afterFactory);
            return;
          }
          const query = (family: 4 | 6) => {
            let operation: Promise<readonly string[]>;
            try {
              operation =
                family === 4 ? resolver!.resolve4(hostname) : resolver!.resolve6(hostname);
            } catch (error) {
              operation = Promise.reject(error);
            }
            return Promise.resolve(operation).then(
              (answers) => copyAnswers(answers, family),
              (error: unknown) => {
                if (noData(error)) return Object.freeze([]) as readonly string[];
                throw new DestinationError("dns-failure");
              },
            );
          };
          // Each query gets settlement handlers before either answer is awaited.
          const a = query(4);
          const aaaa = query(6);
          void Promise.all([a, aaaa]).then(
            ([v4, v6]) => {
              if (settled) return;
              const error = currentError();
              if (error) {
                fail(error);
                return;
              }
              const address = v4[0] ?? v6[0];
              if (address === undefined) {
                fail(new DestinationError("empty-answer"));
                return;
              }
              const result: Readonly<NumericDestination> = Object.freeze({
                hostname,
                address,
                family: v4.length ? 4 : 6,
                port: 443,
              });
              settled = true;
              const cleanupError = cleanup();
              // A trusted resolver's cancel callback may itself trigger cancellation.
              const afterCleanup = cleanupError ?? currentError();
              if (afterCleanup) reject(afterCleanup);
              else resolve(result);
            },
            (error: unknown) =>
              fail(error instanceof DestinationError ? error : new DestinationError("dns-failure")),
          );
        } catch {
          fail(new DestinationError("dns-failure"));
        }
      });
    },
  } satisfies DestinationSelector);
}
