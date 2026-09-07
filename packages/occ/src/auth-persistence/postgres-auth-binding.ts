import type { Pool } from "pg";
import type { SchemaAuthBindingFactoryV1 } from "./schema-auth-boundary-v1.ts";

/** Bind the caller's pool to the original complete schema without acquiring it. */
export const createPostgresAuthBinding: SchemaAuthBindingFactoryV1 = async (pool) => {
  const [{ drizzle }, schema] = await Promise.all([
    import("drizzle-orm/node-postgres"),
    import("../state/postgres-schema.ts"),
  ]);

  // The existing public pool contract is narrower than pg.Pool. Keep this type
  // crossing internal and pass the exact caller object through to Drizzle.
  // An explicit client avoids mistaking structural pools for Drizzle config.
  return { schema, database: drizzle({ client: pool as Pool, schema }) };
};
