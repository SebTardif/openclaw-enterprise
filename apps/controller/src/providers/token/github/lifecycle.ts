import type {
  TokenIssuerAttemptV1,
  TokenIssuerCallBoundsV1,
  TokenMintResultV1,
  TokenRevokeResultV1,
} from "@openclaw-enterprise/contracts";
import { assertBounds, GitHubAppTokenIssuerErrorV1 } from "./guards.ts";
import { notDispatched } from "./protocol.ts";

type TokenResult = TokenMintResultV1 | TokenRevokeResultV1;
type NotDispatched = Extract<TokenResult, { kind: "not-dispatched" }>;

export type OwnerRunner = <Args extends unknown[], Result extends TokenResult>(
  use: (consume: (...args: Args) => Promise<Result>) => Promise<Result>,
  perform: (...args: Args) => Promise<Result>,
) => Promise<Result>;

interface Invocation {
  drained: Promise<void>;
  readonly release: () => void;
}

function safeAttemptRef(input: TokenIssuerAttemptV1): string {
  try {
    const value = input.providerAttemptRef;
    return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,200}$/.test(value)
      ? value
      : "invalid-attempt";
  } catch {
    return "invalid-attempt";
  }
}

function snapshotAttempt(input: TokenIssuerAttemptV1, clock: () => number): TokenIssuerAttemptV1 {
  if (
    typeof input.providerAttemptRef !== "string" ||
    !/^[A-Za-z0-9._:/-]{1,200}$/.test(input.providerAttemptRef)
  )
    throw new GitHubAppTokenIssuerErrorV1();
  const now = clock();
  assertBounds(input.bounds, now);
  if (input.bounds.deadline - now > 30000) throw new GitHubAppTokenIssuerErrorV1();
  return Object.freeze({
    providerAttemptRef: input.providerAttemptRef,
    bounds: Object.freeze({ signal: input.bounds.signal, deadline: input.bounds.deadline }),
  });
}

async function waitForOwner<T>(
  work: Promise<T>,
  bounds: TokenIssuerCallBoundsV1,
  clock: () => number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new GitHubAppTokenIssuerErrorV1());
    timer = setTimeout(abort, Math.max(1, bounds.deadline - clock()));
    bounds.signal.addEventListener("abort", abort, { once: true });
    if (bounds.signal.aborted) abort();
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    clearTimeout(timer);
    if (abort) bounds.signal.removeEventListener("abort", abort);
  }
}

async function runWithOwner<Args extends unknown[], Result extends TokenResult>(
  call: TokenIssuerAttemptV1,
  invocation: Invocation,
  clock: () => number,
  use: (consume: (...args: Args) => Promise<Result>) => Promise<Result>,
  perform: (...args: Args) => Promise<Result>,
): Promise<Result> {
  let callbackEntered = false;
  let ownerClosed = false;
  let ownerTracked = false;
  let callbackWork: Promise<Result> | undefined;
  let callbackResult: Result | undefined;
  const finish = async () => {
    ownerClosed = true;
    await callbackWork?.catch(() => {});
    invocation.release();
  };
  try {
    const work = use((...args) => {
      if (callbackEntered || ownerClosed) throw new GitHubAppTokenIssuerErrorV1();
      callbackEntered = true;
      callbackWork = perform(...args).then((result) => {
        callbackResult = Object.freeze(result);
        return callbackResult;
      });
      // An owner can drop this promise; its actual work still holds capacity.
      void callbackWork.catch(() => {});
      return callbackWork;
    }).finally(finish);
    invocation.drained = work.then(
      () => undefined,
      () => undefined,
    );
    ownerTracked = true;
    const result = await waitForOwner(work, call.bounds, clock);
    if (callbackResult === undefined || result !== callbackResult)
      throw new GitHubAppTokenIssuerErrorV1();
    return callbackResult;
  } finally {
    // A synchronous owner throw may follow dispatch. Join late capture before
    // the operation classifies failure and returns its cleanup handle.
    if (!ownerTracked) await finish();
  }
}

/** Owns the shared mint/revoke slot and settlement identities for one instance.
 * Outward cancellation never releases an owner whose callback is still running. */
export function createAttemptLifecycle(clock: () => number) {
  let active = false;
  const settlements = new WeakMap<object, Promise<void>>();

  function retain<Result extends TokenResult>(result: Result, drained: Promise<void>): Result {
    const frozen = Object.freeze(result);
    settlements.set(frozen, drained);
    return frozen;
  }

  async function run<Result extends TokenResult>(
    input: TokenIssuerAttemptV1,
    operation: (call: TokenIssuerAttemptV1, withOwner: OwnerRunner) => Promise<Result>,
  ): Promise<Result | NotDispatched> {
    let call: TokenIssuerAttemptV1;
    try {
      call = snapshotAttempt(input, clock);
    } catch {
      return retain(notDispatched(safeAttemptRef(input)), Promise.resolve());
    }
    if (active) return retain(notDispatched(call.providerAttemptRef), Promise.resolve());
    active = true;
    const invocation: Invocation = {
      drained: Promise.resolve(),
      release: () => {
        active = false;
      },
    };
    let ownerStarted = false;
    const withOwner: OwnerRunner = (use, perform) => {
      ownerStarted = true;
      return runWithOwner(call, invocation, clock, use, perform);
    };
    try {
      const result = await operation(call, withOwner);
      return retain(result, invocation.drained);
    } finally {
      if (!ownerStarted) invocation.release();
    }
  }

  async function settleAttempt(originalResult: TokenResult): Promise<void> {
    if (!originalResult || typeof originalResult !== "object")
      throw new GitHubAppTokenIssuerErrorV1();
    const drained = settlements.get(originalResult);
    if (drained === undefined) throw new GitHubAppTokenIssuerErrorV1();
    await drained;
  }

  return Object.freeze({ run, settleAttempt });
}
