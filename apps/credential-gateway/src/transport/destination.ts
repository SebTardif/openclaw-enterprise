import { addAbortListener } from "node:events";
import { copyAnswers } from "./destination-addresses.ts";
import { retainBounds, type SelectionBounds } from "./destination-bounds.ts";
import { retainConfig } from "./destination-config.ts";
import {
  DestinationError,
  type DestinationConfig,
  type DestinationResolver,
  type DestinationResolverFactory,
  type DestinationSelector,
  type GitHubHostname,
  type NumericDestination,
} from "./destination-types.ts";

export { DestinationError } from "./destination-types.ts";
export type {
  DestinationConfig,
  DestinationResolver,
  DestinationResolverFactory,
  DestinationSelector,
  DnsServer,
  GitHubHostname,
  NumericDestination,
} from "./destination-types.ts";

export function createDestinationSelector(
  config: DestinationConfig,
  factory: DestinationResolverFactory,
): DestinationSelector {
  if (typeof factory !== "function") throw new DestinationError("invalid-config");
  const retained = retainConfig(config);
  return Object.freeze({
    async select(hostname, bounds) {
      if (hostname !== "github.com" && hostname !== "api.github.com") {
        throw new DestinationError("invalid-host");
      }
      return selectDestination(
        hostname,
        retainBounds(bounds, retained.lookupTimeoutMs),
        retained,
        factory,
      );
    },
  } satisfies DestinationSelector);
}

function queryAnswers(
  resolver: DestinationResolver,
  hostname: GitHubHostname,
  family: 4 | 6,
): Promise<readonly string[]> {
  let operation: Promise<readonly string[]>;
  try {
    operation = family === 4 ? resolver.resolve4(hostname) : resolver.resolve6(hostname);
  } catch (error) {
    operation = Promise.reject(error);
  }
  return Promise.resolve(operation).then(
    (answers) => copyAnswers(answers, family),
    (error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        Object.getOwnPropertyDescriptor(error, "code")?.value === "ENODATA"
      ) {
        return Object.freeze([]);
      }
      throw new DestinationError("dns-failure");
    },
  );
}

function selectDestination(
  hostname: GitHubHostname,
  { signal, duration, currentError }: SelectionBounds,
  config: Readonly<DestinationConfig>,
  factory: DestinationResolverFactory,
): Promise<Readonly<NumericDestination>> {
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
      timer = setTimeout(() => fail(currentError() ?? new DestinationError("deadline")), duration);
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
      resolver = factory(config);
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
      // Each query gets settlement handlers before either answer is awaited.
      const a = queryAnswers(resolver, hostname, 4);
      const aaaa = queryAnswers(resolver, hostname, 6);
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
}
