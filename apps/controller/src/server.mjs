import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { loadStartupConfigurationSnapshot } from "./composition/startup-config/read.ts";
import { startupDiagnostic } from "./startup-diagnostics.ts";
import { createOccLogger } from "./logging.ts";

const loopbackHosts = new Set(["127.0.0.1", "::1", "[::1]"]);
const developmentBindHosts = new Set(["127.0.0.1", "::1", "0.0.0.0"]);
const DEFAULT_BETTER_AUTH_BASE_URL = "http://127.0.0.1:3000";

function startupFailure(error) {
  const logger = createOccLogger({ component: "occ-api", level: "info", destination: "stderr" });
  // The diagnostic contains only locally selected fixed fields, never the original Error.
  logger.error(startupDiagnostic("api", error));
  process.exitCode = 1;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be explicitly configured.`);
  }
  return value;
}

function optionalEnvironment(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be explicitly configured.`);
  }
  return value;
}

function configuration() {
  const mode = process.env.NODE_ENV;
  if (mode !== "development" && mode !== "production")
    throw new Error("NODE_ENV must explicitly select development or production mode.");

  const host = requiredEnvironment("OCC_HOST");
  const trustedDevelopmentBridgeCidr = process.env.OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR;
  if (
    mode === "development" &&
    (!developmentBindHosts.has(host) ||
      (host === "0.0.0.0" &&
        (trustedDevelopmentBridgeCidr === undefined ||
          trustedDevelopmentBridgeCidr.trim().length === 0)))
  ) {
    throw new Error(
      "Development OCC_HOST must be 127.0.0.1 or ::1, or 0.0.0.0 with OCC_DEVELOPMENT_TRUSTED_BRIDGE_CIDR.",
    );
  }
  if (
    mode === "production" &&
    (isIP(host) === 0 ||
      host === "0.0.0.0" ||
      host === "::" ||
      host === "::1" ||
      /^127\./.test(host) ||
      /^::ffff:127\./i.test(host))
  )
    throw new Error("Production OCC_HOST must identify one explicit Pod interface address.");

  const rawPort = requiredEnvironment("OCC_PORT");
  if (!/^\d+$/.test(rawPort)) {
    throw new Error("OCC_PORT must be a valid TCP port.");
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("OCC_PORT must be a valid TCP port.");
  }

  const databaseUrl = process.env.OCC_DATABASE_URL;
  if (mode === "production" && databaseUrl === undefined)
    throw new Error("OCC_DATABASE_URL must be explicitly configured in production.");
  if (databaseUrl !== undefined) {
    let parsed;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      throw new Error("OCC_DATABASE_URL must be a valid PostgreSQL connection URL.");
    }
    if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
      throw new Error("OCC_DATABASE_URL must be a valid PostgreSQL connection URL.");
    }
  }

  const rawPoolMax = process.env.OCC_DATABASE_POOL_MAX;
  const poolMax = rawPoolMax === undefined ? undefined : Number(rawPoolMax);
  if (
    rawPoolMax !== undefined &&
    (!/^\d+$/.test(rawPoolMax) || !Number.isSafeInteger(poolMax) || poolMax < 1)
  ) {
    throw new Error("OCC_DATABASE_POOL_MAX must be a positive integer.");
  }

  const runtimeAuthorityBinaryPath = process.env.OCC_RUNTIME_AUTHORITY_BINARY_PATH;
  const runtimeAuthorityReadbackConfigPath = process.env.OCC_RUNTIME_AUTHORITY_READBACK_CONFIG_PATH;
  for (const path of [runtimeAuthorityBinaryPath, runtimeAuthorityReadbackConfigPath]) {
    if (path !== undefined && (path.length === 0 || !isAbsolute(path)))
      throw new Error("Runtime authority paths must identify absolute protected files.");
  }
  if (runtimeAuthorityReadbackConfigPath !== undefined && databaseUrl === undefined)
    throw new Error("Runtime authority readback requires PostgreSQL persistence.");
  const settings = {
    mode,
    host,
    port,
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    ...(poolMax === undefined ? {} : { poolMax }),
    ...(runtimeAuthorityBinaryPath === undefined ? {} : { runtimeAuthorityBinaryPath }),
    ...(runtimeAuthorityReadbackConfigPath === undefined
      ? {}
      : { runtimeAuthorityReadbackConfigPath }),
  };

  if (process.env.OCC_WORKSPACE_FILES_CONFIG_PATH !== undefined) {
    throw new Error("OCC_WORKSPACE_FILES_CONFIG_PATH has been removed.");
  }

  const gatewayApiKeyPath = process.env.OCC_GATEWAY_API_KEY_PATH;
  if (gatewayApiKeyPath !== undefined) {
    if (gatewayApiKeyPath.trim().length === 0 || !isAbsolute(gatewayApiKeyPath)) {
      throw new Error("OCC_GATEWAY_API_KEY_PATH must identify an absolute mounted-file path.");
    }
  }

  const configuredAuthBaseURL =
    mode === "production"
      ? requiredEnvironment("OCC_AUTH_BASE_URL")
      : (process.env.OCC_AUTH_BASE_URL ?? DEFAULT_BETTER_AUTH_BASE_URL);
  let authBaseURL;
  try {
    authBaseURL = new URL(configuredAuthBaseURL).toString().replace(/\/$/, "");
  } catch {
    throw new Error("OCC_AUTH_BASE_URL must be a valid absolute URL.");
  }
  if (mode === "development" && !loopbackHosts.has(new URL(authBaseURL).hostname)) {
    throw new Error("Development OCC_AUTH_BASE_URL must identify a loopback host.");
  }

  if (mode === "production") {
    return Object.freeze({
      ...settings,
      authSecret: requiredEnvironment("OCC_AUTH_SECRET"),
      authBaseURL,
      ...(gatewayApiKeyPath === undefined ? {} : { gatewayApiKeyPath }),
    });
  }

  const authSecret = optionalEnvironment(
    "OCC_AUTH_SECRET",
    "openclaw-development-auth-secret-minimum-32-bytes",
  );
  if (authSecret.length < 32) {
    throw new Error("OCC_AUTH_SECRET must be at least 32 characters.");
  }
  return Object.freeze({
    ...settings,
    authSecret,
    authBaseURL,
    ...(gatewayApiKeyPath === undefined ? {} : { gatewayApiKeyPath }),
    ...(trustedDevelopmentBridgeCidr === undefined ? {} : { trustedDevelopmentBridgeCidr }),
  });
}

async function start() {
  const settings = configuration();
  const startupConfiguration = await loadStartupConfigurationSnapshot({ mode: settings.mode });
  const logging = startupConfiguration.logging;
  const logger = createOccLogger({ component: "occ-api", level: logging.level });
  if (settings.gatewayApiKeyPath !== undefined) {
    const { validateWorkspaceFilesApiKeyPath } = await import("./composition/workspace-files.ts");
    await validateWorkspaceFilesApiKeyPath(settings.gatewayApiKeyPath);
  }
  const compositionSettings = { ...settings, logger, logging };
  const { loadInstallationConfiguration } = await import("./composition/installation-config.ts");
  const drivers = await loadInstallationConfiguration({
    mode: settings.mode,
    startupConfiguration,
  });
  let serviceAccountDriverFactory;
  const selectedServiceAccountDriver = drivers?.installation.drivers.service_account;
  if (selectedServiceAccountDriver !== undefined) {
    if (settings.databaseUrl === undefined) {
      throw new Error("Provider-managed ServiceAccounts require PostgreSQL persistence.");
    }
    if (
      typeof drivers.computeDriver.storeServiceAccountCredential !== "function" ||
      typeof drivers.computeDriver.deleteServiceAccountCredential !== "function"
    ) {
      throw new Error("The selected Compute Driver cannot manage ServiceAccount credentials.");
    }
    const providerDefinition = drivers.installation.provider.find(
      (provider) => provider.drivers.service_account === selectedServiceAccountDriver.id,
    );
    if (providerDefinition === undefined) {
      throw new Error("The selected ServiceAccount Driver requires an owning Provider.");
    }
    const { configuration } = providerDefinition;
    let adminKey;
    try {
      adminKey = (await readFile(configuration.apiKeyPath, "utf8")).trim();
    } catch {
      throw new Error("The configured ChatGPT admin-key Secret is unavailable.");
    }
    if (adminKey.length === 0) {
      throw new Error("The mounted ChatGPT admin key must be nonempty.");
    }
    const { ChatGPTClient } = await import("./providers/chatgpt.ts");
    const { createChatGPTServiceAccountDriverFactory } =
      await import("./drivers/service-account/chatgpt.ts");
    const provider = {
      id: providerDefinition.id,
      drivers: providerDefinition.drivers,
      client: new ChatGPTClient({
        workspaceId: configuration.workspaceId,
        adminKey,
        ...(configuration.credentialTtlSeconds === undefined
          ? {}
          : { credentialTtlSeconds: configuration.credentialTtlSeconds }),
      }),
    };
    serviceAccountDriverFactory = createChatGPTServiceAccountDriverFactory(
      provider,
      drivers.computeDriver,
    );
  }
  if (settings.mode === "development" && settings.databaseUrl === undefined) {
    throw new Error("OCC_DATABASE_URL must be explicitly configured in development.");
  }
  let app;
  if (settings.mode === "production") {
    if (drivers === undefined) throw new Error("Production Driver configuration is unavailable.");
    const { composeProduction } = await import("./composition/production.ts");
    app = await composeProduction({
      ...compositionSettings,
      drivers,
      logger,
      ...(serviceAccountDriverFactory === undefined ? {} : { serviceAccountDriverFactory }),
    });
  } else {
    const { composePostgresDevelopment } = await import("./composition/development-postgres.ts");
    app = await composePostgresDevelopment(
      compositionSettings,
      drivers,
      serviceAccountDriverFactory,
    );
  }

  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    try {
      await app.close();
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    }
  }

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  try {
    await app.listen({ host: settings.host, port: settings.port });
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
  logger.info({ event: "listening", host: settings.host, port: settings.port });
}

try {
  await start();
} catch (error) {
  startupFailure(error);
}
