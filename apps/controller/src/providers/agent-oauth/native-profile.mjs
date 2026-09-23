const identifier = /^[a-z0-9][a-z0-9-]{0,63}$/;
const connectionIdentifier = /^aoc_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function failure(code) {
  return Object.assign(new Error(code), { code });
}

/** Stable across revisions, distinct for every explicitly reconnected generation. */
export function nativeOAuthProfileId({ provider, connectionId, generation }) {
  if (
    !identifier.test(provider ?? "") ||
    !connectionIdentifier.test(connectionId ?? "") ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    throw failure("NATIVE_OAUTH_INVALID_BINDING");
  }
  return `${provider}:oce:${connectionId}:g${generation}`;
}
