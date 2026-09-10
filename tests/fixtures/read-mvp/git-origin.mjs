import { startGitHubReadMvpExternalService } from "../github-read-mvp/external-service.mjs";

// Lifecycle adapter only. The canonical external service owns Git objects,
// smart HTTP, TLS, signed App issuance, provider faults and request bounds.
// This adapter never issues or injects a token and never implements Git transport.
const ceilings = Object.freeze({
  maxRequests: 64,
  maxRequestBytes: 256 * 1024,
  maxResponseBytes: 2 * 1024 * 1024,
  requestMilliseconds: 5000,
  lifetimeMilliseconds: 60000,
});

function selectLimits(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
    throw new TypeError("limits must be an object");
  const selected = { ...ceilings };
  for (const [name, value] of Object.entries(overrides)) {
    let minimum = 1;
    if (name === "maxResponseBytes") minimum = 1024;
    if (name === "requestMilliseconds") minimum = 100;
    if (
      !Object.hasOwn(ceilings, name) ||
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > ceilings[name]
    )
      throw new RangeError(`Unsupported origin limit: ${name}`);
    selected[name] = value;
  }
  return selected;
}

/**
 * root is an existing absolute directory under the current user's home.
 * app is caller-owned test material: { clientId, publicKey: RSA KeyObject }.
 * The caller uses its real fixture producer to obtain provider authorization.
 * addCommit() accepts no arguments and serializes the provider's fixed revision
 * advance; arbitrary file/message updates are deliberately unsupported.
 * Use this adapter's close() for ownership of the external service lifetime.
 */
export async function createGitOrigin({
  root,
  app,
  host = "127.0.0.1",
  port = 0,
  signal,
  installationId = 41,
  repository = { id: 73, fullName: "fixture/repo" },
  strictNativeHeaders = false,
  limits: overrides = {},
  ...unknown
} = {}) {
  if (Object.keys(unknown).length) throw new TypeError("Unsupported origin option");
  if (typeof root !== "string" || !root || host !== "127.0.0.1" || port !== 0)
    throw new TypeError("Select a root and the ephemeral 127.0.0.1 endpoint");
  if (signal !== undefined && !(signal instanceof AbortSignal))
    throw new TypeError("signal must be an AbortSignal");
  if (signal?.aborted) throw new Error("Git origin creation cancelled");
  const limits = selectLimits(overrides);
  const external = await startGitHubReadMvpExternalService({
    tempParent: root,
    app,
    installationId,
    repository,
    permissions: { metadata: "read", contents: "read" },
    strictNativeHeaders,
    maxRequests: limits.maxRequests,
    maxRequestBytes: limits.maxRequestBytes,
    maxResponseBytes: limits.maxResponseBytes,
    requestTimeoutMs: limits.requestMilliseconds,
  });
  let closed = false;
  let closePromise;
  let advanceTail = Promise.resolve();
  const close = () => {
    if (closePromise) return closePromise;
    closed = true;
    clearTimeout(lifetime);
    signal?.removeEventListener("abort", abort);
    closePromise = Promise.all([external.close(), advanceTail]).then(() => {});
    return closePromise;
  };
  const abort = () => {
    void close().catch(() => {});
  };
  const lifetime = setTimeout(abort, limits.lifetimeMilliseconds);
  signal?.addEventListener("abort", abort, { once: true });
  // The canonical constructor has no signal input. An abort during startup
  // completes that bounded startup, then removes its resources before rejection.
  if (signal?.aborted) {
    await close();
    throw new Error("Git origin creation cancelled");
  }
  const addCommit = (...args) => {
    if (args.length) return Promise.reject(new TypeError("addCommit() accepts no arguments"));
    const operation = advanceTail.then(async () => {
      if (closed) throw new Error("Git origin is closed");
      const parent = external.currentSnapshot().commit;
      const oid = await external.advance();
      return { oid, parent, files: external.currentSnapshot().files };
    });
    // Rejection does not strand the queue. The canonical service enforces the
    // 16-revision limit and refuses further work after its close begins.
    advanceTail = operation.catch(() => {});
    return operation;
  };
  return Object.freeze({
    url: external.gitUrl,
    repository: external.repository,
    directory: external.directory,
    initialCommit: external.initialCommit,
    ca: external.ca,
    caPath: external.caPath,
    endpoint: external.endpoint,
    gitConfig: Object.freeze({ "protocol.version": "2", "http.sslCAInfo": external.caPath }),
    // The installed Git wrapper also needs this explicit CA environment entry.
    gitEnvironment: Object.freeze({ GIT_SSL_CAINFO: external.caPath }),
    external,
    addCommit,
    get requests() {
      return external.observations();
    },
    get state() {
      return { closed, ...external.resources() };
    },
    close,
  });
}
