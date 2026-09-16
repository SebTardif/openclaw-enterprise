import type {
  EphemeralTokenHandleV1,
  TokenIssuerAttemptV1,
  TokenIssuerV1,
  TokenRevokerV1,
} from "@openclaw-enterprise/contracts";
import { createAttemptLifecycle } from "./lifecycle.ts";
import { mintToken, revokeToken } from "./operations.ts";
import { snapshotSelection } from "./protocol.ts";
import { createGitHubAppTransport } from "./transport.ts";
import type { GitHubAppTokenIssuerOptionsV1, GitHubAppTokenRevokerOptionsV1 } from "./types.ts";

function createRuntime(options: GitHubAppTokenRevokerOptionsV1) {
  const withRevocationToken = options.custody.withRevocationToken.bind(options.custody);
  const assertDispatchCurrent = options.assertDispatchCurrent;
  const clock = options.clock;
  const exchange = createGitHubAppTransport({
    endpoint: options.endpoint,
    clock,
    assertDispatchCurrent,
  });
  const lifecycle = createAttemptLifecycle(clock);
  return { withRevocationToken, assertDispatchCurrent, clock, exchange, lifecycle };
}

function composeRevoker(runtime: ReturnType<typeof createRuntime>): TokenRevokerV1 {
  const dependencies = {
    exchange: runtime.exchange,
    withRevocationToken: runtime.withRevocationToken,
  };
  return Object.freeze({
    revoke(input: TokenIssuerAttemptV1, handle: EphemeralTokenHandleV1) {
      return runtime.lifecycle.run(input, (call, withOwner) =>
        revokeToken(dependencies, call, handle, withOwner),
      );
    },
    settleAttempt: runtime.lifecycle.settleAttempt,
  });
}

// TODO(repository read integration): wire the selected issuer through production
// Work construction and the regular Agent read before landing this capability.
export function createGitHubAppTokenIssuerV1(
  options: GitHubAppTokenIssuerOptionsV1,
): TokenIssuerV1 {
  const selection = snapshotSelection(options.selection);
  const material = options.material;
  const capture = options.custody.capture.bind(options.custody);
  const runtime = createRuntime(options);
  const dependencies = {
    selection,
    material,
    capture,
    exchange: runtime.exchange,
    clock: runtime.clock,
    assertDispatchCurrent: runtime.assertDispatchCurrent,
  };
  return Object.freeze({
    ...composeRevoker(runtime),
    mint(input: TokenIssuerAttemptV1) {
      return runtime.lifecycle.run(input, (call, withOwner) =>
        mintToken(dependencies, call, withOwner),
      );
    },
  });
}

/** Exact retained-token cleanup does not require the App signing key. */
export function createGitHubAppTokenRevokerV1(
  options: GitHubAppTokenRevokerOptionsV1,
): TokenRevokerV1 {
  return composeRevoker(createRuntime(options));
}
