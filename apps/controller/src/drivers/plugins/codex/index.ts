import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CODEX_PLUGIN_CATALOG_DRIVER_ID,
  PluginInventoryValidationError,
  validatePluginInventory,
  type PluginInventory,
} from "@openclaw-enterprise/contracts";

export const CODEX_PLUGIN_CATALOG_VERSION = "0.153.4";

export type CodexPluginCatalogLoadResult =
  | { readonly available: true; readonly inventory: PluginInventory }
  | { readonly available: false; readonly reason: string };

export interface CodexPluginCatalogOptions {
  readonly inventoryPath?: string;
}

const DEFAULT_INVENTORY_PATH = join(dirname(fileURLToPath(import.meta.url)), "inventory.json");

export async function loadCodexPluginInventory(
  options: CodexPluginCatalogOptions = {},
): Promise<CodexPluginCatalogLoadResult> {
  const inventoryPath = options.inventoryPath ?? DEFAULT_INVENTORY_PATH;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(inventoryPath, "utf8"));
  } catch {
    return {
      available: false,
      reason: "Codex plugin inventory artifact is unavailable.",
    };
  }

  try {
    return {
      available: true,
      inventory: validatePluginInventory(parsed, {
        driverId: CODEX_PLUGIN_CATALOG_DRIVER_ID,
        codexVersion: CODEX_PLUGIN_CATALOG_VERSION,
        allowEmpty: true,
      }),
    };
  } catch (error) {
    if (error instanceof PluginInventoryValidationError) {
      return { available: false, reason: error.message };
    }
    throw error;
  }
}
