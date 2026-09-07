import { createHash } from "node:crypto";
import { createSchemaMetadataTools } from "../core-schema-extraction/metadata.mjs";

export const domainTableNames = [
  "serviceAccountDriverBindings",
  "auditEvents",
  "channelInstallations",
  "channelHumanBindings",
  "channelAgentBindings",
];

// Reuse the actual Drizzle normalizer; this fixture never declares a replacement table.
export function createDomainMetadataTools(dependencies) {
  const tools = createSchemaMetadataTools(dependencies);
  function snapshot(schema) {
    const complete = tools.normalizeSchemaMetadata(schema);
    const tables = Object.fromEntries(
      domainTableNames.map((name) => [name, complete.tables[name]]),
    );
    const targets = new Set(Object.values(tables).map((table) => `${table.schema}.${table.name}`));
    const relatedForeignKeys = Object.entries(complete.tables).flatMap(([source, table]) =>
      table.foreignKeys
        .filter(
          (key) =>
            domainTableNames.includes(source) ||
            targets.has(`${key.foreignTable.schema}.${key.foreignTable.name}`),
        )
        .map((key) => ({ source, ...key })),
    );
    return {
      schema: complete.schema,
      exports: complete.exports,
      tableCount: Object.keys(complete.tables).length,
      completeMetadataSha256: createHash("sha256").update(JSON.stringify(complete)).digest("hex"),
      tables,
      relatedForeignKeys,
    };
  }
  return { ...tools, snapshot };
}
