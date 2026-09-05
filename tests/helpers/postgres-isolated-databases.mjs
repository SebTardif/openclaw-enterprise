import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import pg from "pg";

export const suites = Object.freeze({
  runtime: "tests/integration/postgres-runtime-assignment-state.test.mjs",
  channels: "tests/integration/postgres-channel-bindings.test.mjs",
});

export async function readConfiguration(path) {
  const info = await lstat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid())
    throw new Error("Configuration must be an owner-only regular file owned by this user.");
  const config = JSON.parse(await readFile(path, "utf8"));
  if (
    config.host !== "127.0.0.1" ||
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535 ||
    config.adminUser !== "postgres" ||
    !/^\d+$/.test(config.systemIdentifier) ||
    !/^oce_[a-z0-9]{1,16}$/.test(config.namePrefix) ||
    !Number.isFinite(Date.parse(config.expiresAt))
  )
    throw new Error("Select an explicit allocated loopback PostgreSQL instance and finite lease.");
  for (const key of ["adminPassword", "migratorPassword", "applicationPassword"])
    if (typeof config[key] !== "string" || config[key].length < 20)
      throw new Error("Separate protected random credentials are required.");
  if (
    new Set([config.adminPassword, config.migratorPassword, config.applicationPassword]).size !== 3
  )
    throw new Error("Role credentials must differ.");
  return Object.freeze(config);
}

export function createPlan(config, selected = Object.keys(suites)) {
  if (
    !selected.length ||
    selected.length > 2 ||
    new Set(selected).size !== selected.length ||
    selected.some((name) => !Object.hasOwn(suites, name))
  )
    throw new Error("Select runtime, channels, or both complete pilot suites.");
  const runId = randomBytes(6).toString("hex");
  return Object.freeze({
    schemaVersion: 1,
    runId,
    server: Object.freeze({
      host: config.host,
      port: config.port,
      systemIdentifier: config.systemIdentifier,
    }),
    databases: Object.freeze(
      selected.map((suite) =>
        Object.freeze({
          name: `${config.namePrefix}_${runId}_${suite}`,
          suite,
          token: randomBytes(16).toString("hex"),
        }),
      ),
    ),
  });
}

export function connectionURL(config, role, database) {
  const names = { admin: config.adminUser, migrator: "occ_migrator", application: "occ_app" };
  const keys = {
    admin: "adminPassword",
    migrator: "migratorPassword",
    application: "applicationPassword",
  };
  if (!Object.hasOwn(names, role)) throw new Error("Unknown database role.");
  const url = new URL(`postgresql://${config.host}:${config.port}/${database}`);
  url.username = names[role];
  url.password = config[keys[role]];
  return url.href;
}

export function redact(config, value) {
  let text = String(value);
  for (const key of ["adminPassword", "migratorPassword", "applicationPassword"])
    for (const secret of [config[key], encodeURIComponent(config[key])])
      text = text.replaceAll(secret, "[redacted]");
  return text;
}

export async function withConnection(config, role, database, operation) {
  const client = new pg.Client({
    connectionString: connectionURL(config, role, database),
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
    statement_timeout: 10000,
  });
  client.on("error", () => {});
  try {
    await client.connect();
    return await operation(client);
  } finally {
    await client.end();
  }
}

const identifier = (name) => {
  if (!/^oce_[a-z0-9_]{1,58}$/.test(name)) throw new Error("Invalid owned database name.");
  return `"${name}"`;
};

export class OwnedDatabases {
  #config;
  #plan;
  #owned = new Map();
  #pending = new Set();
  #journal;
  constructor(config, plan, journal) {
    this.#config = config;
    this.#plan = plan;
    this.#journal = journal;
    assert.deepEqual(plan.server, {
      host: config.host,
      port: config.port,
      systemIdentifier: config.systemIdentifier,
    });
    if (
      !/^[0-9a-f]{12}$/.test(plan.runId) ||
      plan.databases.length < 1 ||
      plan.databases.length > 2 ||
      new Set(plan.databases.map((entry) => entry.name)).size !== plan.databases.length ||
      plan.databases.some(
        (entry) =>
          !Object.hasOwn(suites, entry.suite) ||
          !/^[0-9a-f]{32}$/.test(entry.token) ||
          entry.name !== `${config.namePrefix}_${plan.runId}_${entry.suite}`,
      )
    )
      throw new Error("Invalid immutable database plan.");
    if (typeof journal !== "function") throw new Error("A custody journal is required.");
  }
  async #admin(operation) {
    return withConnection(this.#config, "admin", "postgres", async (client) => {
      const identity = (
        await client.query("SELECT system_identifier::text FROM pg_control_system()")
      ).rows[0];
      if (identity.system_identifier !== this.#config.systemIdentifier)
        throw new Error("PostgreSQL instance identity changed; refusing database operations.");
      const version = (await client.query("SHOW server_version_num")).rows[0].server_version_num;
      if (Number(version) < 180000 || Number(version) >= 190000)
        throw new Error("This pilot requires PostgreSQL 18.");
      return operation(client);
    });
  }
  #entry(entry) {
    if (!this.#plan.databases.includes(entry))
      throw new Error("Database is outside this immutable plan.");
    identifier(entry.name);
  }
  async inspect() {
    return this.#admin(async (client) => {
      const roles = (
        await client.query(
          "SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname IN ('occ_app','occ_migrator') ORDER BY rolname",
        )
      ).rows;
      if (
        roles.length !== 2 ||
        roles.some((r) => r.rolsuper || r.rolcreatedb || r.rolcreaterole || r.rolbypassrls)
      )
        throw new Error("The existing limited occ_app/occ_migrator role contract is required.");
      this.#journal({ event: "roles-verified", roles });
      return roles;
    });
  }
  async create(entry) {
    this.#entry(entry);
    if (Date.now() >= Date.parse(this.#config.expiresAt) - 60000)
      throw new Error("Resource lease lacks a one-minute cleanup margin.");
    return this.#admin(async (client) => {
      if (
        (await client.query("SELECT oid FROM pg_database WHERE datname=$1", [entry.name])).rowCount
      )
        throw new Error(`Refusing preexisting database ${entry.name}.`);
      const owned = {
        name: entry.name,
        marker: `isolated-test:${this.#plan.runId}:${entry.token}`,
        state: "create-requested",
      };
      this.#journal({ event: "database-create-requested", ...owned });
      this.#pending.add(entry.name);
      // A lost CREATE acknowledgement is deliberately not inferred as ownership.
      // Preserve its exact name in the journal for the allocation's custodian.
      await client.query(`CREATE DATABASE ${identifier(entry.name)}`);
      this.#pending.delete(entry.name);
      this.#owned.set(entry.name, owned);
      this.#journal({ event: "database-created", name: entry.name });
      const row = (
        await client.query("SELECT oid::text,datdba::text FROM pg_database WHERE datname=$1", [
          entry.name,
        ])
      ).rows[0];
      if (!row) throw new Error("Created database disappeared before identity capture.");
      Object.assign(owned, row, { state: "identified" });
      this.#journal({ event: "database-identity", ...owned });
      await client.query(`COMMENT ON DATABASE ${identifier(entry.name)} IS '${owned.marker}'`);
      owned.state = "marked";
      this.#journal({ event: "database-marked", ...owned });
      await withConnection(this.#config, "admin", entry.name, (setup) =>
        setup.query(
          `GRANT CREATE ON DATABASE ${identifier(entry.name)} TO occ_migrator; CREATE SCHEMA occ AUTHORIZATION occ_migrator; CREATE SCHEMA drizzle AUTHORIZATION occ_migrator; REVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
        ),
      );
      return { ...owned };
    });
  }
  async seedProbe(entry) {
    this.#entry(entry);
    if (!this.#owned.has(entry.name)) throw new Error("Probe requires this invocation's database.");
    await withConnection(this.#config, "migrator", entry.name, async (client) => {
      await client.query(
        "CREATE SCHEMA isolated_test; CREATE TABLE isolated_test.marker (value text PRIMARY KEY); GRANT USAGE ON SCHEMA isolated_test TO occ_app; GRANT SELECT ON isolated_test.marker TO occ_app;",
      );
      await client.query("INSERT INTO isolated_test.marker VALUES ($1)", [entry.token]);
    });
  }
  async verifyProbe(entry, { requireInstallation = false } = {}) {
    this.#entry(entry);
    return withConnection(this.#config, "application", entry.name, async (client) => {
      const identity = (
        await client.query("SELECT current_database() AS database,current_user AS role")
      ).rows[0];
      assert.deepEqual(identity, { database: entry.name, role: "occ_app" });
      const rows = (await client.query("SELECT value FROM isolated_test.marker")).rows;
      assert.deepEqual(rows, [{ value: entry.token }]);
      const installations = requireInstallation
        ? (await client.query("SELECT id FROM occ.installation")).rows.map((r) => r.id)
        : [];
      if (requireInstallation) assert.equal(installations.length, 1);
      const result = {
        event: "isolation-verified",
        ...identity,
        token: entry.token,
        installations,
      };
      this.#journal(result);
      return result;
    });
  }
  async cleanup() {
    const errors = [];
    const report = (event) => {
      try {
        this.#journal(event);
      } catch (error) {
        errors.push(error);
      }
    };
    for (const name of this.#pending) {
      try {
        await this.#admin(async (client) => {
          if ((await client.query("SELECT oid FROM pg_database WHERE datname=$1", [name])).rowCount)
            throw new Error(
              `Uncertain CREATE outcome for ${name}; custodian must resolve ownership before removal.`,
            );
          this.#pending.delete(name);
          report({ event: "uncertain-create-absence-verified", name });
        });
      } catch (error) {
        errors.push(error);
        report({
          event: "uncertain-create-custody-required",
          name,
          error: redact(this.#config, error.message),
        });
      }
    }
    for (const owned of [...this.#owned.values()].reverse()) {
      try {
        await this.#admin(async (client) => {
          const row = (
            await client.query(
              "SELECT oid::text,datdba::text,shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1",
              [owned.name],
            )
          ).rows[0];
          if (!row)
            throw new Error(
              `Owned database ${owned.name} disappeared before cleanup; identity cannot be checked.`,
            );
          if (
            !owned.oid ||
            row.oid !== owned.oid ||
            row.datdba !== owned.datdba ||
            row.marker !== (owned.state === "marked" ? owned.marker : null)
          )
            throw new Error(`Ownership mismatch for ${owned.name}; refusing cleanup.`);
          const active = (
            await client.query(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datid=$1",
              [owned.oid],
            )
          ).rows[0].count;
          if (active !== 0)
            throw new Error(
              `Database ${owned.name} still has ${active} connections; refusing forced termination.`,
            );
          await client.query(`DROP DATABASE ${identifier(owned.name)}`);
          if (
            (await client.query("SELECT oid FROM pg_database WHERE datname=$1", [owned.name]))
              .rowCount
          )
            throw new Error(`Database ${owned.name} remained after DROP.`);
          this.#owned.delete(owned.name);
          report({ event: "database-absence-verified", name: owned.name, oid: owned.oid });
        });
      } catch (error) {
        errors.push(error);
        report({
          event: "cleanup-failed",
          name: owned.name,
          error: redact(this.#config, error.message),
        });
      }
    }
    if (errors.length)
      throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
  }
}
