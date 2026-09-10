import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CODEX_PLUGIN_CATALOG_DRIVER_ID,
  PluginInventoryValidationError,
  validatePluginInventory,
} from "../../packages/contracts/src/index.ts";
import { loadCodexPluginInventory } from "../../apps/controller/src/drivers/plugins/codex/index.ts";
import {
  normalizePluginListResponse,
  run as runGenerator,
} from "../../scripts/generate-codex-plugin-inventory.mjs";

function rawPluginList(overrides = {}) {
  return {
    marketplaces: [
      {
        name: "openai-curated-remote",
        path: null,
        interface: { displayName: "OpenAI curated" },
        plugins: [
          {
            id: "alpha@openai-curated-remote",
            remotePluginId: "remote-alpha",
            version: "1.2.3",
            localVersion: "ignored",
            name: "Alpha",
            source: { type: "remote" },
            installed: true,
            enabled: true,
            shareContext: { shareUrl: "https://example.invalid/secret" },
            availability: "available",
            eligiblePlanTypes: ["enterprise"],
          },
          {
            id: "beta@openai-curated-remote",
            remotePluginId: "remote-beta",
            name: "Beta",
            source: { type: "remote" },
            installed: false,
            enabled: false,
          },
        ],
      },
    ],
    marketplaceLoadErrors: [],
    featuredPluginIds: ["alpha@openai-curated-remote"],
    ...overrides,
  };
}

test("Codex plugin inventory projection keeps only reviewed remote locator fields", () => {
  const inventory = normalizePluginListResponse(rawPluginList(), {
    codexVersion: "0.153.4",
    allowMarketplaces: ["openai-curated-remote"],
  });

  assert.equal(inventory.driverId, CODEX_PLUGIN_CATALOG_DRIVER_ID);
  assert.deepEqual(inventory.inventory, {
    schemaVersion: 1,
    generatedAt: inventory.inventory.generatedAt,
    codexVersion: "0.153.4",
    sourceMethod: "plugin/list",
  });
  assert.deepEqual(inventory.plugins, [
    {
      id: "alpha@openai-curated-remote#remote-alpha",
      remoteMarketplaceName: "openai-curated-remote",
      remotePluginId: "remote-alpha",
      pluginName: "Alpha",
      version: "1.2.3",
    },
    {
      id: "beta@openai-curated-remote#remote-beta",
      remoteMarketplaceName: "openai-curated-remote",
      remotePluginId: "remote-beta",
      pluginName: "Beta",
      version: null,
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(inventory),
    /installed|enabled|shareUrl|eligiblePlanTypes|localVersion|featuredPluginIds/i,
  );
});

test("Codex plugin inventory accepts direct app-server capture wrappers", () => {
  const inventory = normalizePluginListResponse(
    { response: { result: rawPluginList() } },
    {
      codexVersion: "0.153.4",
      allowMarketplaces: ["openai-curated-remote"],
    },
  );

  assert.equal(inventory.plugins.length, 2);
  assert.equal(inventory.plugins[0].remotePluginId, "remote-alpha");
});

test("Codex plugin inventory IDs are stable with or without raw ID collisions", () => {
  const inventory = normalizePluginListResponse(
    rawPluginList({
      marketplaces: [
        {
          name: "openai-curated-remote",
          path: null,
          plugins: [
            {
              id: "duplicate@openai-curated-remote",
              remotePluginId: "remote-one",
              name: "Duplicate",
              version: "1.0.0",
              source: { type: "remote" },
            },
            {
              id: "duplicate@openai-curated-remote",
              remotePluginId: "remote-two",
              name: "Duplicate",
              version: "2.0.0",
              source: { type: "remote" },
            },
          ],
        },
      ],
    }),
    {
      codexVersion: "0.153.4",
      allowMarketplaces: ["openai-curated-remote"],
    },
  );

  assert.deepEqual(
    inventory.plugins.map(({ id, remotePluginId, version }) => ({ id, remotePluginId, version })),
    [
      {
        id: "duplicate@openai-curated-remote#remote-one",
        remotePluginId: "remote-one",
        version: "1.0.0",
      },
      {
        id: "duplicate@openai-curated-remote#remote-two",
        remotePluginId: "remote-two",
        version: "2.0.0",
      },
    ],
  );

  const withoutCollision = normalizePluginListResponse(
    rawPluginList({
      marketplaces: [
        {
          name: "openai-curated-remote",
          path: null,
          plugins: [
            {
              id: "duplicate@openai-curated-remote",
              remotePluginId: "remote-one",
              name: "Duplicate",
              version: "1.0.0",
              source: { type: "remote" },
            },
          ],
        },
      ],
    }),
    {
      codexVersion: "0.153.4",
      allowMarketplaces: ["openai-curated-remote"],
    },
  );

  assert.equal(withoutCollision.plugins[0].id, "duplicate@openai-curated-remote#remote-one");
});

test("Codex plugin inventory rejects incomplete, local, duplicate, and unreviewed captures", () => {
  assert.throws(
    () =>
      normalizePluginListResponse(
        rawPluginList({ marketplaceLoadErrors: [{ message: "failed" }] }),
        {
          codexVersion: "0.153.4",
          allowMarketplaces: ["openai-curated-remote"],
        },
      ),
    /marketplace load errors/,
  );

  assert.throws(
    () =>
      normalizePluginListResponse(
        rawPluginList({
          marketplaces: [{ name: "openai-curated-remote", path: "/tmp/local", plugins: [] }],
        }),
        { codexVersion: "0.153.4", allowMarketplaces: ["openai-curated-remote"] },
      ),
    /local-path backed/,
  );

  assert.throws(
    () =>
      normalizePluginListResponse(rawPluginList({ marketplaces: [] }), {
        codexVersion: "0.153.4",
        allowMarketplaces: ["openai-curated-remote"],
      }),
    /Expected marketplace/,
  );

  assert.throws(
    () =>
      normalizePluginListResponse(rawPluginList({ marketplaces: [] }), {
        codexVersion: "0.153.4",
        allowMarketplaces: ["openai-curated-remote"],
        allowEmptyReviewed: true,
      }),
    /Expected marketplace/,
  );

  assert.throws(
    () =>
      normalizePluginListResponse(rawPluginList({ marketplaces: [] }), {
        codexVersion: "0.153.4",
        allowMarketplaces: [],
        allowEmptyReviewed: true,
      }),
    /At least one --allow-marketplace/,
  );

  const reviewedEmpty = normalizePluginListResponse(
    rawPluginList({
      marketplaces: [{ name: "openai-curated-remote", path: null, plugins: [] }],
    }),
    {
      codexVersion: "0.153.4",
      allowMarketplaces: ["openai-curated-remote"],
      allowEmptyReviewed: true,
    },
  );
  assert.deepEqual(reviewedEmpty.plugins, []);

  assert.throws(
    () =>
      normalizePluginListResponse(
        rawPluginList({
          marketplaces: [
            {
              name: "openai-curated-remote",
              path: null,
              plugins: [
                { id: "local", remotePluginId: "local", name: "Local", source: { type: "local" } },
              ],
            },
          ],
        }),
        { codexVersion: "0.153.4", allowMarketplaces: ["openai-curated-remote"] },
      ),
    /not a remote catalog entry/,
  );

  assert.throws(
    () =>
      validatePluginInventory(
        {
          driverId: "codex",
          inventory: {
            schemaVersion: 1,
            generatedAt: "2026-09-10T01:00:00.000Z",
            codexVersion: "0.153.4",
            sourceMethod: "plugin/list",
          },
          plugins: [
            {
              id: "a",
              remoteMarketplaceName: "openai-curated-remote",
              remotePluginId: "same",
              pluginName: "A",
              version: null,
            },
            {
              id: "b",
              remoteMarketplaceName: "openai-curated-remote",
              remotePluginId: "same",
              pluginName: "B",
              version: null,
            },
          ],
        },
        { driverId: "codex", codexVersion: "0.153.4" },
      ),
    PluginInventoryValidationError,
  );
});

test("Codex plugin catalog loader accepts reviewed bundled artifacts and reports missing artifacts honestly", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-catalog-loader-"));
  t.after(() =>
    import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })),
  );

  const missing = await loadCodexPluginInventory({
    inventoryPath: join(directory, "missing.json"),
  });
  assert.deepEqual(missing, {
    available: false,
    reason: "Codex plugin inventory artifact is unavailable.",
  });

  const inventoryPath = join(directory, "inventory.json");
  await writeFile(
    inventoryPath,
    JSON.stringify({
      driverId: "codex",
      inventory: {
        schemaVersion: 1,
        generatedAt: "2026-09-10T01:00:00.000Z",
        codexVersion: "0.153.4",
        sourceMethod: "plugin/list",
      },
      plugins: [],
    }),
  );
  const emptyReviewed = await loadCodexPluginInventory({ inventoryPath });
  assert.equal(emptyReviewed.available, true);
  assert.deepEqual(emptyReviewed.inventory.plugins, []);
});

test("Codex plugin inventory generator preserves the previous artifact when validation fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-catalog-generator-"));
  t.after(() =>
    import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true })),
  );
  const output = join(directory, "inventory.json");
  const rawInput = join(directory, "raw.json");
  await writeFile(output, '{"previous":true}\n');
  await writeFile(rawInput, JSON.stringify({ marketplaces: [], marketplaceLoadErrors: [] }));

  await assert.rejects(
    () =>
      runGenerator({
        rawInput,
        output,
        codexVersion: "0.153.4",
        allowMarketplaces: ["openai-curated-remote"],
      }),
    /Expected marketplace/,
  );
  assert.equal(await readFile(output, "utf8"), '{"previous":true}\n');

  await assert.rejects(
    () =>
      runGenerator({
        rawInput,
        output,
        codexVersion: "0.153.4",
        allowMarketplaces: ["openai-curated-remote"],
        allowEmptyReviewed: true,
      }),
    /Expected marketplace/,
  );
  assert.equal(await readFile(output, "utf8"), '{"previous":true}\n');
});
