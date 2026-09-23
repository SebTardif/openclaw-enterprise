import { isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

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

function assertOAuthCredential(credential, provider, delivered) {
  if (
    credential?.type !== "oauth" ||
    credential.provider !== provider ||
    typeof credential.access !== "string" ||
    credential.access.length === 0 ||
    typeof credential.refresh !== "string" ||
    credential.refresh.length === 0 ||
    !Number.isFinite(credential.expires) ||
    credential.expires <= 0 ||
    credential.copyToAgents === true
  ) {
    throw failure("NATIVE_OAUTH_INVALID_CREDENTIAL");
  }
  if (
    delivered !== undefined &&
    Object.keys(delivered).some(
      (key) => !Object.hasOwn(credential, key) || typeof credential[key] !== typeof delivered[key],
    )
  ) {
    throw failure("NATIVE_OAUTH_INCOMPLETE_CREDENTIAL");
  }
}

/**
 * Called in the model runtime before startup with a validated private envelope and
 * the public openclaw/plugin-sdk/provider-auth module from its qualified image.
 * The caller owns the live Agent/generation/PVC fence, including on every retry.
 */
export async function initializeNativeOAuthProfile({
  sdk,
  envelope,
  agentDir,
  stateDir,
  assertCurrent,
}) {
  if (typeof sdk?.updateAuthProfileStoreWithLock !== "function") {
    throw failure("NATIVE_OAUTH_RUNTIME_UNAVAILABLE");
  }
  if (typeof assertCurrent !== "function") {
    throw failure("NATIVE_OAUTH_INVALID_AUTHORITY");
  }
  const profileId = nativeOAuthProfileId(envelope ?? {});
  if (envelope.profileId !== profileId || !identifier.test(envelope.method ?? "")) {
    throw failure("NATIVE_OAUTH_INVALID_BINDING");
  }
  assertOAuthCredential(envelope.credential, envelope.provider);
  if (
    typeof agentDir !== "string" ||
    typeof stateDir !== "string" ||
    !isAbsolute(agentDir) ||
    !isAbsolute(stateDir) ||
    resolve(agentDir) !== agentDir ||
    resolve(stateDir) !== stateDir ||
    isAbsolute(relative(stateDir, agentDir)) ||
    relative(stateDir, agentDir).startsWith(`..${sep}`) ||
    relative(stateDir, agentDir) === ".." ||
    relative(stateDir, agentDir) === ""
  ) {
    throw failure("NATIVE_OAUTH_INVALID_STORE");
  }
  // Capture the validated delivery before native lock acquisition can yield.
  const { provider, method, connectionId, generation } = envelope;
  const credential = structuredClone(envelope.credential);
  const current = () => {
    try {
      if (assertCurrent() === undefined) {
        return;
      }
    } catch {
      // This predicate also runs inside native code that may log thrown errors.
      throw failure("NATIVE_OAUTH_INVALID_AUTHORITY");
    }
    throw failure("NATIVE_OAUTH_INVALID_AUTHORITY");
  };
  let status = "existing";
  try {
    current();
    const updated = await sdk.updateAuthProfileStoreWithLock({
      agentDir,
      stateDir,
      updater(store) {
        current();
        if (Object.hasOwn(store.profiles, profileId)) {
          assertOAuthCredential(store.profiles[profileId], provider, credential);
          return false;
        }
        store.profiles[profileId] = credential;
        status = "initialized";
        return true;
      },
    });
    if (updated === null) {
      throw failure("NATIVE_OAUTH_PERSISTENCE_FAILED");
    }
    current();
    // Read through a new native transaction, not a runtime snapshot or inherited
    // profile view. A failed read keeps custody pending even if the write committed.
    let persisted = false;
    const reopened = await sdk.updateAuthProfileStoreWithLock({
      agentDir,
      stateDir,
      updater(store) {
        current();
        assertOAuthCredential(store.profiles[profileId], provider, credential);
        if (status === "initialized" && !isDeepStrictEqual(store.profiles[profileId], credential)) {
          throw failure("NATIVE_OAUTH_INCOMPLETE_CREDENTIAL");
        }
        persisted = true;
        return false;
      },
    });
    if (reopened === null || !persisted) {
      throw failure("NATIVE_OAUTH_PERSISTENCE_FAILED");
    }
    current();
    return { provider, method, connectionId, generation, profileId, status };
  } catch {
    // Native errors and caller predicates can contain credentials. Return only a
    // stable failure code; an uncertain write is retried under the same fence.
    throw failure("NATIVE_OAUTH_HANDOFF_FAILED");
  }
}
