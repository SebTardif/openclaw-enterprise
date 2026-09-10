import { Type } from "typebox";
import { Value } from "typebox/value";

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

export function validatePluginInventory(
  value: unknown,
  options: {
    readonly driverId?: string;
    readonly codexVersion?: string;
    readonly allowEmpty?: boolean;
  } = {},
): PluginInventory {
  if (!Value.Check(PluginInventorySchema, value)) {
    const firstError = [...Value.Errors(PluginInventorySchema, value)][0];
    throw new PluginInventoryValidationError(
      `Plugin inventory does not match its schema${
        firstError === undefined ? "" : `: ${firstError.message}`
      }.`,
    );
  }

  const envelope = value as PluginInventory;
  const { driverId } = envelope;
  if (options.driverId !== undefined && driverId !== options.driverId) {
    throw new PluginInventoryValidationError(
      "Plugin inventory driverId does not match the catalog.",
    );
  }

  const { inventory } = envelope;
  if (
    !UTC_TIMESTAMP.test(inventory.generatedAt) ||
    Number.isNaN(Date.parse(inventory.generatedAt))
  ) {
    throw new PluginInventoryValidationError("inventory.generatedAt must be a UTC timestamp.");
  }
  if (options.codexVersion !== undefined && inventory.codexVersion !== options.codexVersion) {
    throw new PluginInventoryValidationError("Plugin inventory codexVersion is unsupported.");
  }

  if (envelope.plugins.length === 0 && options.allowEmpty !== true) {
    throw new PluginInventoryValidationError("Plugin inventory is empty without explicit review.");
  }

  const ids = new Set<string>();
  const locators = new Map<string, string>();
  let previousId = "";
  const plugins = envelope.plugins.map((entry, index) => {
    const { id, remoteMarketplaceName, remotePluginId, pluginName, version } = entry;
    if (ids.has(id)) throw new PluginInventoryValidationError(`Duplicate plugin id ${id}.`);
    if (index > 0 && id.localeCompare(previousId) <= 0) {
      throw new PluginInventoryValidationError("Plugin inventory entries must be sorted by id.");
    }
    previousId = id;
    ids.add(id);
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
      pluginName,
      version,
    });
  });

  return Object.freeze({
    driverId,
    inventory: Object.freeze({
      schemaVersion: PLUGIN_INVENTORY_SCHEMA_VERSION,
      generatedAt: inventory.generatedAt,
      codexVersion: inventory.codexVersion,
      sourceMethod: CODEX_PLUGIN_CATALOG_SOURCE_METHOD,
    }),
    plugins: Object.freeze(plugins),
  }) as PluginInventory;
}
