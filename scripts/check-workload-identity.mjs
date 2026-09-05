import { pathToFileURL } from "node:url";

const HELP = `Check a configured local SPIFFE Workload API.

Usage:
  node scripts/check-workload-identity.mjs --socket-path PATH --spiffe-id ID [--audience AUDIENCE] [--timeout-ms MILLISECONDS]

The socket must belong to an operator-trusted SPIRE Agent or compatible provider.
The check prints identity and expiry metadata only. It does not verify guest
attestation, remote mTLS, current runtime authority, or deployment readiness.
`;

function optionsFromArgs(args) {
  const options = {};
  const allowed = new Set(["--socket-path", "--spiffe-id", "--audience", "--timeout-ms"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.has(flag) || Object.hasOwn(options, flag) || !value || value.startsWith("--")) {
      throw new Error("invalid-arguments");
    }
    options[flag] = value;
  }
  if (!options["--socket-path"] || !options["--spiffe-id"]) throw new Error("invalid-arguments");
  const timeoutMs =
    options["--timeout-ms"] === undefined ? 10_000 : Number(options["--timeout-ms"]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error("invalid-arguments");
  }
  return {
    socketPath: options["--socket-path"],
    expectedSpiffeId: options["--spiffe-id"],
    timeoutMs,
    audience: options["--audience"],
  };
}

export async function checkWorkloadIdentity(
  args,
  { stdout = process.stdout, stderr = process.stderr } = {},
) {
  if (args.length === 1 && args[0] === "--help") {
    stdout.write(HELP);
    return 0;
  }
  let options;
  try {
    options = optionsFromArgs(args);
  } catch {
    stderr.write("Invalid workload identity arguments. Use --help for supported options.\n");
    return 2;
  }

  let source;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.timeoutMs);
  timer.unref();
  const interrupted = () => abort.abort();
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    const { createSpiffeWorkloadIdentitySource } =
      await import("../apps/controller/src/identity/index.ts");
    source = createSpiffeWorkloadIdentitySource({
      socketPath: options.socketPath,
      expectedSpiffeId: options.expectedSpiffeId,
      timeoutMs: options.timeoutMs,
    });
    await source.start({ signal: abort.signal });
    let jwt;
    if (options.audience !== undefined) {
      const fetched = await source.fetchJwtSvid({
        audience: options.audience,
        signal: abort.signal,
      });
      jwt = await source.validateJwtSvid({
        token: fetched.token,
        audience: options.audience,
        expectedSpiffeId: options.expectedSpiffeId,
        signal: abort.signal,
      });
    }
    const identity = source.getX509IdentityMetadata();
    stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        status: "available",
        spiffeId: identity.spiffeId,
        x509ExpiresAt: identity.expiresAt,
        ...(jwt === undefined ? {} : { jwt: { status: "validated", expiresAt: jwt.expiresAt } }),
        scope: "local-workload-api",
      })}\n`,
    );
    return 0;
  } catch {
    // Provider errors can contain paths, certificates, or credential material.
    stderr.write(
      `${JSON.stringify({
        schemaVersion: 1,
        status: "unavailable",
        reason: abort.signal.aborted ? "cancelled-or-timed-out" : "workload-identity-check-failed",
        scope: "local-workload-api",
      })}\n`,
    );
    return 1;
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    source?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await checkWorkloadIdentity(process.argv.slice(2));
}
