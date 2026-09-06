import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createOccLogger, emitOccLogEvent } from "../apps/controller/src/logging.ts";
import { MigrationExecutionError, runMigrations } from "./turn-journal-phase-upgrade.mjs";

const databaseUrl = process.env.OCC_MIGRATION_DATABASE_URL;
let pool;
let logger = createOccLogger({ component: "occ-migration", level: "info", destination: "stderr" });

try {
  const args = process.argv.slice(2);
  const local = args.length === 1 && args[0] === "--local";
  if (args.length !== 0 && !local)
    throw new Error("Usage: node scripts/migrate-production.mjs [--local]");
  if (!local) {
    const { loadOperationalLoggingConfiguration } =
      await import("../apps/controller/src/composition/installation-config.ts");
    const logging = await loadOperationalLoggingConfiguration({ mode: "production" });
    logger = createOccLogger({
      component: "occ-migration",
      level: logging.level,
      destination: "stderr",
    });
  }
  if (typeof databaseUrl !== "string" || databaseUrl.trim().length === 0) {
    throw new Error("OCC_MIGRATION_DATABASE_URL must contain the dedicated migrator credential.");
  }
  const parsed = new URL(databaseUrl);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("The migration connection must identify a PostgreSQL database.");
  }

  const dependency = createRequire(new URL("../packages/occ/package.json", import.meta.url));
  const { Pool } = dependency("pg");
  pool = new Pool({ connectionString: databaseUrl, max: 1 });
  await runMigrations(pool, {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
  process.stdout.write(`${JSON.stringify({ event: "migration.completed" })}\n`);
  emitOccLogEvent(logger, { event: "migration.completed" });
} catch (error) {
  emitOccLogEvent(logger, {
    event: "migration.failed",
    code:
      error instanceof MigrationExecutionError && error.outcome === "unknown"
        ? "MIGRATION_COMMIT_UNKNOWN"
        : "MIGRATION_FAILED",
  });
  process.exitCode = 1;
} finally {
  if (pool !== undefined) await pool.end();
}
