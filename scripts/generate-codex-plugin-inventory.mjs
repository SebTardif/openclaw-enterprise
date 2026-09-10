#!/usr/bin/env node
import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  CODEX_PLUGIN_CATALOG_DRIVER_ID,
  CODEX_PLUGIN_CATALOG_SOURCE_METHOD,
  PLUGIN_INVENTORY_SCHEMA_VERSION,
  validatePluginInventory,
} from "../packages/contracts/src/index.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_CODEX_VERSION = "0.152.1";
const DEFAULT_OUTPUT = new URL(
  "../apps/controller/src/drivers/plugins/codex/inventory.json",
  import.meta.url,
);
const REMOTE_SOURCE_TYPE = "remote";

function usage() {
  return `Usage:
  node scripts/generate-codex-plugin-inventory.mjs --allow-marketplace <name> [options]

Options:
  --output <path>                 Inventory artifact path. Defaults to the bundled Codex catalog path.
  --raw-input <path>              Normalize an existing private plugin/list JSON capture instead of spawning Codex.
  --raw-output <path>             Write private raw capture evidence. Keep this outside the repository.
  --codex-bin <path>              Codex binary to execute. Defaults to codex.
  --codex-home <path>             Isolated CODEX_HOME used by the app-server.
  --codex-version <version>       Required Codex version. Defaults to ${DEFAULT_CODEX_VERSION}.
  --allow-marketplace <name>      Remote marketplace approved for publication. Repeatable.
  --allow-empty-reviewed          Permit an expected reviewed marketplace to contain no entries.
`;
}

function parseArgs(argv) {
  const options = {
    codexBin: "codex",
    codexVersion: DEFAULT_CODEX_VERSION,
    output: fileURLToPath(DEFAULT_OUTPUT),
    allowMarketplaces: [],
    allowEmptyReviewed: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--allow-empty-reviewed") {
      options.allowEmptyReviewed = true;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${arg} requires a value.`);
    }
    index += 1;
    if (arg === "--output") options.output = resolve(next);
    else if (arg === "--raw-input") options.rawInput = resolve(next);
    else if (arg === "--raw-output") options.rawOutput = resolve(next);
    else if (arg === "--codex-bin") options.codexBin = next;
    else if (arg === "--codex-home") options.codexHome = resolve(next);
    else if (arg === "--codex-version") options.codexVersion = next;
    else if (arg === "--allow-marketplace") options.allowMarketplaces.push(next);
    else throw new Error(`Unknown option ${arg}.`);
  }
  return options;
}

function safeString(value, description) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${description} must be a nonempty safe string.`);
  }
  return value;
}

function record(value, description) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object.`);
  }
  return value;
}

function extractPluginListResult(raw) {
  if (typeof raw === "object" && raw !== null && Array.isArray(raw.marketplaces)) return raw;
  if (typeof raw === "object" && raw !== null && Array.isArray(raw.responses)) {
    const response = raw.responses.find(
      (entry) =>
        typeof entry === "object" && entry !== null && Array.isArray(entry.result?.marketplaces),
    );
    if (response !== undefined) return response.result;
  }
  throw new Error("Raw capture does not contain a plugin/list result.");
}

function projectedVersion(value) {
  if (value === undefined || value === null) return null;
  return safeString(value, "plugin.version");
}

export function normalizePluginListResponse(raw, options) {
  const codexVersion = safeString(options.codexVersion, "codexVersion");
  const allowMarketplaces = new Set(
    options.allowMarketplaces.map((name) => safeString(name, "allowMarketplace")),
  );
  if (allowMarketplaces.size === 0) {
    throw new Error("At least one --allow-marketplace is required.");
  }
  const result = extractPluginListResult(raw);
  const errors = result.marketplaceLoadErrors ?? [];
  if (!Array.isArray(errors)) throw new Error("marketplaceLoadErrors must be an array.");
  if (errors.length > 0) throw new Error("plugin/list reported marketplace load errors.");

  const plugins = [];
  const seenAllowedMarketplaces = new Set();
  for (const [marketplaceIndex, marketplaceValue] of result.marketplaces.entries()) {
    const marketplace = record(marketplaceValue, `marketplaces[${marketplaceIndex}]`);
    const name = safeString(marketplace.name, `marketplaces[${marketplaceIndex}].name`);
    if (!allowMarketplaces.has(name)) continue;
    seenAllowedMarketplaces.add(name);
    if (marketplace.path !== undefined && marketplace.path !== null) {
      throw new Error(`Allowed marketplace ${name} is local-path backed.`);
    }
    if (!Array.isArray(marketplace.plugins))
      throw new Error(`Allowed marketplace ${name} has no plugins array.`);
    for (const [pluginIndex, pluginValue] of marketplace.plugins.entries()) {
      const plugin = record(
        pluginValue,
        `marketplaces[${marketplaceIndex}].plugins[${pluginIndex}]`,
      );
      if (plugin.source?.type !== REMOTE_SOURCE_TYPE) {
        throw new Error(`Plugin ${plugin.id ?? pluginIndex} is not a remote catalog entry.`);
      }
      plugins.push({
        id: safeString(plugin.id, "plugin.id"),
        remoteMarketplaceName: name,
        remotePluginId: safeString(plugin.remotePluginId, "plugin.remotePluginId"),
        pluginName: safeString(plugin.name, "plugin.name"),
        version: projectedVersion(plugin.version),
      });
    }
  }
  for (const name of allowMarketplaces) {
    if (!seenAllowedMarketplaces.has(name)) {
      throw new Error(`Expected marketplace ${name} was not returned by plugin/list.`);
    }
  }

  const inventory = {
    driverId: CODEX_PLUGIN_CATALOG_DRIVER_ID,
    inventory: {
      schemaVersion: PLUGIN_INVENTORY_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      codexVersion,
      sourceMethod: CODEX_PLUGIN_CATALOG_SOURCE_METHOD,
    },
    plugins: plugins.sort((left, right) => left.id.localeCompare(right.id)),
  };
  return validatePluginInventory(inventory, {
    driverId: CODEX_PLUGIN_CATALOG_DRIVER_ID,
    codexVersion,
    allowEmpty: options.allowEmptyReviewed === true,
  });
}

async function codexVersion(codexBin) {
  const { stdout } = await execFileAsync(codexBin, ["--version"], { encoding: "utf8" });
  const version = stdout.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
  if (version === undefined) throw new Error(`Unable to parse Codex version from: ${stdout}`);
  return version;
}

function appServerRequest(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function captureFromCodex(options) {
  const actualVersion = await codexVersion(options.codexBin);
  if (actualVersion !== options.codexVersion) {
    throw new Error(`Codex binary is ${actualVersion}; expected ${options.codexVersion}.`);
  }

  const generatedHome =
    options.codexHome === undefined
      ? await mkdtemp(resolve(tmpdir(), "codex-plugin-inventory-"))
      : undefined;
  const codexHome = options.codexHome ?? generatedHome;
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const child = spawn(
    options.codexBin,
    [
      "-c",
      'otel.exporter="none"',
      "-c",
      "otel.log_user_prompt=false",
      "app-server",
      "--listen",
      "stdio://",
    ],
    {
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        HOME: codexHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const rawResponses = [];
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    let newline;
    while ((newline = stdout.indexOf("\n")) !== -1) {
      const line = stdout.slice(0, newline).trim();
      stdout = stdout.slice(newline + 1);
      if (line.length > 0) rawResponses.push(JSON.parse(line));
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const waitFor = async (id, timeoutMs) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const response = rawResponses.find((entry) => entry.id === id);
      if (response !== undefined) {
        if (response.error !== undefined) throw new Error(`app-server request ${id} failed.`);
        return response.result;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for app-server request ${id}.`);
  };

  try {
    appServerRequest(child, {
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "openclaw_plugin_inventory", version: "0.1.0" } },
    });
    await waitFor(1, 10_000);
    appServerRequest(child, { method: "initialized" });
    appServerRequest(child, {
      id: 2,
      method: "plugin/list",
      params: { forceRefetch: true },
    });
    await waitFor(2, 30_000);
    return {
      binary: `codex-cli ${actualVersion}`,
      codexHome,
      request: { method: "plugin/list", params: { forceRefetch: true } },
      responses: rawResponses,
      stderr,
    };
  } finally {
    child.kill("SIGTERM");
    const exit = await Promise.race([
      exited,
      new Promise((resolve) =>
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve({ code: null, signal: "SIGKILL" });
        }, 3_000),
      ),
    ]);
    if (generatedHome !== undefined) await rm(generatedHome, { recursive: true, force: true });
    if (exit.signal === "SIGKILL") throw new Error("Timed out stopping Codex app-server.");
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export async function run(options) {
  const raw =
    options.rawInput === undefined
      ? await captureFromCodex(options)
      : JSON.parse(await readFile(options.rawInput, "utf8"));
  if (options.rawOutput !== undefined) await writeJsonAtomic(options.rawOutput, raw);
  const inventory = normalizePluginListResponse(raw, options);
  await writeJsonAtomic(options.output, inventory);
  return inventory;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      process.exit(0);
    }
    const inventory = await run(options);
    process.stdout.write(
      `Wrote ${inventory.plugins.length} Codex plugin inventory entries to ${options.output}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(usage());
    process.exit(1);
  }
}
