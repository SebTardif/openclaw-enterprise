import { Type } from "typebox";

const NON_EMPTY_SAFE_STRING = /^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export const CODEX_PLUGIN_CATALOG_DRIVER_ID = "codex";
export const CODEX_PLUGIN_CATALOG_SOURCE_METHOD = "plugin/list";
export const PLUGIN_INVENTORY_SCHEMA_VERSION = 1;

export const SUPPORTED_PLUGIN_CATALOG_DRIVER_IDS = Object.freeze([
  CODEX_PLUGIN_CATALOG_DRIVER_ID,
] as const);

export type SupportedPluginCatalogDriverId = (typeof SUPPORTED_PLUGIN_CATALOG_DRIVER_IDS)[number];

export interface PluginIdentity {
  readonly driverId: string;
  readonly pluginId: string;
}

export interface PluginInventoryEntry {
  readonly id: string;
  readonly remoteMarketplaceName: string;
  readonly remotePluginId: string;
  readonly pluginName: string;
  readonly version: string | null;
}

export interface PluginInventory {
  readonly driverId: string;
  readonly inventory: {
    readonly schemaVersion: 1;
    readonly generatedAt: string;
    readonly codexVersion: string;
    readonly sourceMethod: "plugin/list";
  };
  readonly plugins: readonly PluginInventoryEntry[];
}

export interface AgentPluginSnapshot {
  readonly driverId: string;
  readonly pluginId: string;
  readonly remoteMarketplaceName: string;
  readonly remotePluginId: string;
  readonly version: string | null;
  readonly catalogCodexVersion: string;
}

export interface PluginInstallationError {
  readonly driverId: string;
  readonly pluginId: string;
  readonly code: "PLUGIN_INSTALL_FAILED";
  readonly message: "Plugin installation failed.";
}

export class PluginInventoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginInventoryValidationError";
  }
}

const SafeStringSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: NON_EMPTY_SAFE_STRING.source,
});

export const PluginIdentitySchema = Type.Object(
  { driverId: SafeStringSchema, pluginId: SafeStringSchema },
  { additionalProperties: false },
);

export const PluginInventoryEntrySchema = Type.Object(
  {
    id: SafeStringSchema,
    remoteMarketplaceName: SafeStringSchema,
    remotePluginId: SafeStringSchema,
    pluginName: SafeStringSchema,
    version: Type.Union([SafeStringSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const PluginInventorySchema = Type.Object(
  {
    driverId: Type.Literal(CODEX_PLUGIN_CATALOG_DRIVER_ID),
    inventory: Type.Object(
      {
        schemaVersion: Type.Literal(PLUGIN_INVENTORY_SCHEMA_VERSION),
        generatedAt: Type.String({ format: "date-time" }),
        codexVersion: SafeStringSchema,
        sourceMethod: Type.Literal(CODEX_PLUGIN_CATALOG_SOURCE_METHOD),
      },
      { additionalProperties: false },
    ),
    plugins: Type.Array(PluginInventoryEntrySchema),
  },
  { additionalProperties: false },
);

export const AgentPluginSnapshotSchema = Type.Object(
  {
    driverId: SafeStringSchema,
    pluginId: SafeStringSchema,
    remoteMarketplaceName: SafeStringSchema,
    remotePluginId: SafeStringSchema,
    version: Type.Union([SafeStringSchema, Type.Null()]),
    catalogCodexVersion: SafeStringSchema,
  },
  { additionalProperties: false },
);

export const PluginInstallationErrorSchema = Type.Object(
  {
    driverId: SafeStringSchema,
    pluginId: SafeStringSchema,
    code: Type.Literal("PLUGIN_INSTALL_FAILED"),
    message: Type.Literal("Plugin installation failed."),
  },
  { additionalProperties: false },
);

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  description: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new PluginInventoryValidationError(`${description} has unexpected fields.`);
  }
}

function record(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PluginInventoryValidationError(`${description} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function safeString(value: unknown, description: string): string {
  if (typeof value !== "string" || !NON_EMPTY_SAFE_STRING.test(value)) {
    throw new PluginInventoryValidationError(`${description} must be a nonempty safe string.`);
  }
  return value;
}

function nullableVersion(value: unknown, description: string): string | null {
  if (value === null) return null;
  return safeString(value, description);
}

export function validatePluginInventory(
  value: unknown,
  options: {
    readonly driverId?: string;
    readonly codexVersion?: string;
    readonly allowEmpty?: boolean;
  } = {},
): PluginInventory {
  const envelope = record(value, "Plugin inventory");
  exactKeys(envelope, ["driverId", "inventory", "plugins"], "Plugin inventory");

  const driverId = safeString(envelope.driverId, "driverId");
  if (options.driverId !== undefined && driverId !== options.driverId) {
    throw new PluginInventoryValidationError("Plugin inventory driverId does not match the catalog.");
  }

  const inventory = record(envelope.inventory, "inventory");
  exactKeys(inventory, ["schemaVersion", "generatedAt", "codexVersion", "sourceMethod"], "inventory");
  if (inventory.schemaVersion !== PLUGIN_INVENTORY_SCHEMA_VERSION) {
    throw new PluginInventoryValidationError("Plugin inventory schemaVersion is unsupported.");
  }
  const generatedAt = safeString(inventory.generatedAt, "inventory.generatedAt");
  if (!UTC_TIMESTAMP.test(generatedAt) || Number.isNaN(Date.parse(generatedAt))) {
    throw new PluginInventoryValidationError("inventory.generatedAt must be a UTC timestamp.");
  }
  const codexVersion = safeString(inventory.codexVersion, "inventory.codexVersion");
  if (options.codexVersion !== undefined && codexVersion !== options.codexVersion) {
    throw new PluginInventoryValidationError("Plugin inventory codexVersion is unsupported.");
  }
  if (inventory.sourceMethod !== CODEX_PLUGIN_CATALOG_SOURCE_METHOD) {
    throw new PluginInventoryValidationError("Plugin inventory sourceMethod is unsupported.");
  }

  if (!Array.isArray(envelope.plugins)) {
    throw new PluginInventoryValidationError("plugins must be an array.");
  }
  if (envelope.plugins.length === 0 && options.allowEmpty !== true) {
    throw new PluginInventoryValidationError("Plugin inventory is empty without explicit review.");
  }

  const ids = new Set<string>();
  const locators = new Map<string, string>();
  let previousId = "";
  const plugins = envelope.plugins.map((entryValue, index) => {
    const entry = record(entryValue, `plugins[${index}]`);
    exactKeys(
      entry,
      ["id", "remoteMarketplaceName", "remotePluginId", "pluginName", "version"],
      `plugins[${index}]`,
    );
    const id = safeString(entry.id, `plugins[${index}].id`);
    if (ids.has(id)) throw new PluginInventoryValidationError(`Duplicate plugin id ${id}.`);
    if (index > 0 && id.localeCompare(previousId) <= 0) {
      throw new PluginInventoryValidationError("Plugin inventory entries must be sorted by id.");
    }
    previousId = id;
    ids.add(id);
    const remoteMarketplaceName = safeString(
      entry.remoteMarketplaceName,
      `plugins[${index}].remoteMarketplaceName`,
    );
    const remotePluginId = safeString(entry.remotePluginId, `plugins[${index}].remotePluginId`);
    const locator = `${remoteMarketplaceName}\u0000${remotePluginId}`;
    const existing = locators.get(locator);
    if (existing !== undefined && existing !== id) {
      throw new PluginInventoryValidationError(
        `Conflicting plugin locator ${remoteMarketplaceName}/${remotePluginId}.`,
      );
    }
    locators.set(locator, id);
    return Object.freeze({
      id,
      remoteMarketplaceName,
      remotePluginId,
      pluginName: safeString(entry.pluginName, `plugins[${index}].pluginName`),
      version: nullableVersion(entry.version, `plugins[${index}].version`),
    });
  });

  return Object.freeze({
    driverId,
    inventory: Object.freeze({
      schemaVersion: PLUGIN_INVENTORY_SCHEMA_VERSION,
      generatedAt,
      codexVersion,
      sourceMethod: CODEX_PLUGIN_CATALOG_SOURCE_METHOD,
    }),
    plugins: Object.freeze(plugins),
  }) as PluginInventory;
}
