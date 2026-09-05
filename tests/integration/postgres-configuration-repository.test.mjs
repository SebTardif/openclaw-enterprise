import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { createPostgresConfigurationRepository } from "../../packages/occ/src/state/postgres/configurations.ts";
import { PostgresPlatformState } from "../../packages/occ/src/state/postgres-state.ts";
import {
  configurationResources,
  configurationBindings,
  seedConfigurationInstallation,
  verifyConfigurationRepositoryBootstrap,
  verifyConfigurationRepositoryOwnership,
  verifyConfigurationRepositoryBindings,
  verifyConfigurationRepositoryGenerations,
  verifyConfigurationRepositoryLifetime,
  verifyConfigurationRepositoryAtomicity,
} from "../conformance/configuration-repository.contract.mjs";

const databaseUrl = process.env.OCC_TEST_DATABASE_URL;
const options = {
  skip: databaseUrl
    ? false
    : "Set OCC_TEST_DATABASE_URL for actual PostgreSQL Configuration coverage.",
  timeout: 60000,
};

test("PostgreSQL Configuration factory construction performs no backend or scope access", () => {
  // This sentinel proves construction only; persistence below runs the actual
  // aggregate wiring, including its unchanged private Secret and row helpers.
  const unexpected = () => assert.fail("factory construction accessed its backend");
  const repository = createPostgresConfigurationRepository({
    transaction: { assertActive: unexpected },
    query: { query: unexpected },
    requireInitialized: unexpected,
    namespaces: { lockNamespace: unexpected },
    serializeSecretBindings: unexpected,
    validateSecretBindingsAvailable: unexpected,
    secretBindingsFromJson: unexpected,
    rows: unexpected,
    text: unexpected,
    timestamp: unexpected,
    get scope() {
      return unexpected();
    },
  });
  assert.deepEqual(Object.keys(repository).sort(), [
    "advanceConfigurationGeneration",
    "createConfiguration",
    "deleteConfiguration",
    "findConfiguration",
    "lockConfiguration",
  ]);
});

test(
  "PostgreSQL Configuration and Secret writes share the owner's uncommitted client",
  options,
  async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    t.after(() => pool.end());
    const store = new PostgresPlatformState(pool);
    await seedConfigurationInstallation(store);
    const { namespace, configuration, secret } = configurationResources();
    const bound = { ...configuration, secretBindings: configurationBindings(secret) };
    const rollback = new Error("rollback borrowed Configuration client writes");
    await assert.rejects(
      store.transact(async (s) => {
        await s.namespaces.createNamespace(namespace);
        await s.secrets.createSecret(secret);
        assert.deepEqual(await s.configurations.createConfiguration(bound), bound);
        assert.deepEqual(
          await s.configurations.lockConfiguration(namespace.id, configuration.id),
          bound,
        );
        const advanced = await s.configurations.advanceConfigurationGeneration(
          namespace.id,
          configuration.id,
          1,
        );
        assert.deepEqual(advanced, { ...bound, generation: 2 });
        // The independent observer cannot see any uncommitted row, while the real
        // repository resolves both the Namespace and Secret on its owner's client.
        for (const [table, id] of [
          ["namespaces", namespace.id],
          ["secrets", secret.id],
          ["configurations", configuration.id],
        ])
          assert.equal(
            (await pool.query(`SELECT id FROM occ.${table} WHERE id=$1`, [id])).rowCount,
            0,
          );
        throw rollback;
      }),
      (error) => error === rollback,
    );
    for (const [table, id] of [
      ["namespaces", namespace.id],
      ["secrets", secret.id],
      ["configurations", configuration.id],
    ])
      assert.equal((await pool.query(`SELECT id FROM occ.${table} WHERE id=$1`, [id])).rowCount, 0);
  },
);

test(
  "PostgreSQL Configuration row lock orders an independent generation contender",
  options,
  async (t) => {
    // A one-connection owner pool makes its observed backend PID exact; contender
    // and observer use separate real connections, with no substituted pool/client.
    const ownerPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    const otherPool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    t.after(async () => {
      await ownerPool.end();
      await otherPool.end();
    });
    const store = new PostgresPlatformState(ownerPool);
    const contenderStore = new PostgresPlatformState(otherPool);
    await seedConfigurationInstallation(store);
    const { namespace, configuration } = configurationResources();
    await store.transact(async (s) => {
      await s.namespaces.createNamespace(namespace);
      await s.configurations.createConfiguration(configuration);
    });
    const {
      rows: [{ pid }],
    } = await ownerPool.query("SELECT pg_backend_pid() AS pid");
    const locked = Promise.withResolvers();
    const release = Promise.withResolvers();
    let contender;
    const owner = store.transact(async (s) => {
      assert.deepEqual(
        await s.configurations.lockConfiguration(namespace.id, configuration.id),
        configuration,
      );
      locked.resolve();
      await release.promise;
      return s.configurations.advanceConfigurationGeneration(namespace.id, configuration.id, 1);
    });
    // Observe errors immediately even if setup fails before the final await.
    owner.catch((error) => locked.reject(error));
    try {
      await locked.promise;
      contender = contenderStore.transact((s) =>
        s.configurations.advanceConfigurationGeneration(namespace.id, configuration.id, 1),
      );
      contender.catch(() => {});
      const deadline = Date.now() + 10000;
      let blocked = false;
      while (Date.now() < deadline) {
        const { rows } = await otherPool.query(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked",
          [pid],
        );
        if (rows[0].blocked) {
          blocked = true;
          break;
        }
        await delay(20);
      }
      assert.equal(blocked, true, "the actual contender must wait on lockConfiguration's row lock");
      release.resolve();
      assert.deepEqual(await owner, { ...configuration, generation: 2 });
      assert.equal(await contender, undefined);
      assert.deepEqual(
        await store.read((s) => s.configurations.findConfiguration(namespace.id, configuration.id)),
        { ...configuration, generation: 2 },
      );
    } finally {
      release.resolve();
      await Promise.allSettled([owner, ...(contender ? [contender] : [])]);
    }
  },
);

for (const [name, verify] of [
  [
    "preserves exact ownership, lifecycle and Agent reference constraints",
    verifyConfigurationRepositoryOwnership,
  ],
  [
    "normalizes real Secret bindings and distinguishes preservation from clearing",
    verifyConfigurationRepositoryBindings,
  ],
  [
    "serializes independent generation writers and rolls back speculative updates",
    verifyConfigurationRepositoryGenerations,
  ],
  [
    "drains cross-domain calls and closes all escaped Configuration methods",
    verifyConfigurationRepositoryLifetime,
  ],
  [
    "commits and rolls back Configuration, Secret, Agent, audit and work together",
    verifyConfigurationRepositoryAtomicity,
  ],
])
  test(`PostgreSQL Configuration aggregate ${name}`, options, async (t) => {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    t.after(() => pool.end());
    await verify(new PostgresPlatformState(pool));
  });

const bootstrapUrl = process.env.OCC_PRODUCTION_WIREUP_DATABASE_URL;
test(
  "PostgreSQL Configuration bootstrap shares one unit and rolls back to an empty database",
  {
    skip: bootstrapUrl
      ? false
      : "Set OCC_PRODUCTION_WIREUP_DATABASE_URL to an independently migrated empty disposable database.",
    timeout: 60000,
  },
  async (t) => {
    const pool = new pg.Pool({ connectionString: bootstrapUrl, max: 2 });
    t.after(() => pool.end());
    await verifyConfigurationRepositoryBootstrap(new PostgresPlatformState(pool));
  },
);
