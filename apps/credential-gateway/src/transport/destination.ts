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
  bounds: SelectionBounds,
  config: Readonly<DestinationConfig>,
  factory: DestinationResolverFactory,
): Promise<Readonly<NumericDestination>> {
  return new Promise((resolve, reject) => {
    new DestinationLookup(hostname, bounds, resolve, reject).start(config, factory);
  });
}

// Each selection owns its resolver, bounds subscription and terminal settlement.
class DestinationLookup {
  private readonly hostname: GitHubHostname;
  private readonly bounds: SelectionBounds;
  private readonly resolve: (destination: Readonly<NumericDestination>) => void;
  private readonly reject: (error: DestinationError) => void;
  private resolver: DestinationResolver | undefined;
  private settled = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private subscription: ReturnType<typeof addAbortListener> | undefined;

  constructor(
    hostname: GitHubHostname,
    bounds: SelectionBounds,
    resolve: (destination: Readonly<NumericDestination>) => void,
    reject: (error: DestinationError) => void,
  ) {
    this.hostname = hostname;
    this.bounds = bounds;
    this.resolve = resolve;
    this.reject = reject;
  }

  start(config: Readonly<DestinationConfig>, factory: DestinationResolverFactory): void {
    try {
      this.subscription = addAbortListener(this.bounds.signal, () =>
        this.fail(new DestinationError("aborted")),
      );
      this.timer = setTimeout(
        () => this.fail(this.bounds.currentError() ?? new DestinationError("deadline")),
        this.bounds.duration,
      );
    } catch {
      this.fail(new DestinationError("invalid-bounds"));
      return;
    }
    try {
      this.lookup(config, factory);
    } catch {
      this.fail(new DestinationError("dns-failure"));
    }
  }

  private lookup(config: Readonly<DestinationConfig>, factory: DestinationResolverFactory): void {
    const beforeFactory = this.bounds.currentError();
    if (beforeFactory) return this.fail(beforeFactory);

    const resolver = factory(config);
    this.resolver = resolver;
    // Factory code can abort synchronously before its resolver is returned.
    if (this.settled) {
      this.cleanup();
      return;
    }
    if (
      !resolver ||
      typeof resolver.resolve4 !== "function" ||
      typeof resolver.resolve6 !== "function" ||
      typeof resolver.cancel !== "function"
    ) {
      this.fail(new DestinationError("dns-failure"));
      return;
    }
    const afterFactory = this.bounds.currentError();
    if (afterFactory) return this.fail(afterFactory);

    // Both queries get handlers before either answer is awaited, including after abort.
    const a = queryAnswers(resolver, this.hostname, 4);
    const aaaa = queryAnswers(resolver, this.hostname, 6);
    void Promise.all([a, aaaa]).then(
      ([v4, v6]) => this.succeed(v4, v6),
      (error: unknown) =>
        this.fail(error instanceof DestinationError ? error : new DestinationError("dns-failure")),
    );
  }

  private succeed(v4: readonly string[], v6: readonly string[]): void {
    if (this.settled) return;
    const error = this.bounds.currentError();
    if (error) return this.fail(error);
    const address = v4[0] ?? v6[0];
    if (address === undefined) return this.fail(new DestinationError("empty-answer"));

    const result: Readonly<NumericDestination> = Object.freeze({
      hostname: this.hostname,
      address,
      family: v4.length ? 4 : 6,
      port: 443,
    });
    this.settled = true;
    const cleanupError = this.cleanup();
    // Resolver cleanup can itself abort an otherwise successful selection.
    const afterCleanup = cleanupError ?? this.bounds.currentError();
    if (afterCleanup) this.reject(afterCleanup);
    else this.resolve(result);
  }

  private fail(error: DestinationError): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.reject(error);
  }

  private cleanup(): DestinationError | undefined {
    clearTimeout(this.timer);
    const subscription = this.subscription;
    this.subscription = undefined;
    try {
      subscription?.[Symbol.dispose]();
    } catch {
      return new DestinationError("invalid-bounds");
    } finally {
      // Relinquish ownership before caller code runs; cancellation can reenter cleanup.
      const resolver = this.resolver;
      this.resolver = undefined;
      try {
        resolver?.cancel();
      } catch {
        /* Cancellation cannot grant authority. */
      }
    }
    return undefined;
  }
}
