import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createOccLogger, emitOccLogEvent } from "../apps/controller/src/logging.ts";
import { migrationFailureLogFields, runMigrations } from "./turn-journal-phase-upgrade.mjs";

const databaseUrl = process.env.OCC_MIGRATION_DATABASE_URL;
let pool;
let logger = createOccLogger({ component: "occ-migration", level: "info", destination: "stderr" });
let operation = "entry-arguments";

try {
  const args = process.argv.slice(2);
  const local = args.length === 1 && args[0] === "--local";
  if (args.length !== 0 && !local)
    throw new Error("Usage: node scripts/migrate-production.mjs [--local]");
  if (!local) {
    operation = "entry-configuration";
    const { loadOperationalLoggingConfiguration } =
      await import("../apps/controller/src/composition/installation-config.ts");
    const logging = await loadOperationalLoggingConfiguration({ mode: "production" });
    logger = createOccLogger({
      component: "occ-migration",
      level: logging.level,
      destination: "stderr",
    });
  }
  operation = "entry-database-url";
  if (typeof databaseUrl !== "string" || databaseUrl.trim().length === 0) {
    throw new Error("OCC_MIGRATION_DATABASE_URL must contain the dedicated migrator credential.");
  }
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("The migration connection must identify a PostgreSQL database.");
  }

  operation = "entry-pg-load";
  const dependency = createRequire(new URL("../packages/occ/package.json", import.meta.url));
  const { Pool } = dependency("pg");
  operation = "entry-pool-create";
  pool = new Pool({ connectionString: databaseUrl, max: 1 });
  operation = "entry-migration";
  await runMigrations(pool, {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  operation = "entry-reporting";
  process.stdout.write(`${JSON.stringify({ event: "migration.completed" })}\n`);
  emitOccLogEvent(logger, { event: "migration.completed" });
} catch (error) {
  emitOccLogEvent(logger, {
    event: "migration.failed",
    ...migrationFailureLogFields(error, operation),
  });
  process.exitCode = 1;
} finally {
  if (pool !== undefined) await pool.end();
}
