import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { type LoggingConfiguration, operationalLoggingConfiguration } from "../../logging.ts";
import type { ConfigurationRecord, StartupConfigurationSnapshot } from "./schema.ts";

export async function startupConfiguration(
  options: {
    readonly mode: "development" | "production";
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
  required: boolean,
): Promise<ConfigurationRecord | undefined> {
  const environment = options.environment ?? process.env;
  const path = environment.OCC_CONFIG_PATH;
  if (path === undefined) {
    if (!required) return undefined;
    throw new Error("OCC_CONFIG_PATH must identify the Installation startup YAML.");
  }
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("OCC_CONFIG_PATH must identify the Installation startup YAML.");
  }
  if (!isAbsolute(path)) {
    throw new Error("OCC_CONFIG_PATH must identify an absolute Installation startup YAML path.");
  }

  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    throw new Error("The configured Installation startup YAML is unavailable.");
  }

  // Missing or unreadable configuration must fail before loading runtime dependencies.
  const [{ loadYaml }, { validateStartupConfiguration }] = await Promise.all([
    import("@kubernetes/client-node"),
    import("./schema.ts"),
  ]);
  let parsed: unknown;
  try {
    parsed = loadYaml(contents);
  } catch {
    throw new Error("The configured Installation startup file must contain valid YAML.");
  }
  return validateStartupConfiguration(parsed);
}

export async function loadStartupConfigurationSnapshot(options: {
  readonly mode: "development" | "production";
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<StartupConfigurationSnapshot> {
  const configuration = await startupConfiguration(options, options.mode === "production");
  const logging = operationalLoggingConfiguration(configuration?.logging);
  return Object.freeze({
    ...(configuration === undefined ? {} : { configuration }),
    logging,
  });
}

export async function loadOperationalLoggingConfiguration(options: {
  readonly mode: "development" | "production";
  readonly environment?: Readonly<Record<string, string | undefined>>;
}): Promise<LoggingConfiguration> {
  const configuration = await startupConfiguration(options, false);
  return operationalLoggingConfiguration(configuration?.logging);
}
