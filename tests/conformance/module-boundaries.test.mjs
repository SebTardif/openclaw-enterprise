import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { verifyModuleBoundaries } from "../../scripts/verify-module-boundaries.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const fixture = new URL("../fixtures/module-boundaries/", import.meta.url);
const policy = JSON.parse(
  await readFile(new URL("../../scripts/module-boundaries/policy.json", import.meta.url), "utf8"),
);
const run = promisify(execFile);

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "module-boundaries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fixture, root, { recursive: true });
  const config = { ...policy, packages: ["apps/controller", "packages/contracts", "packages/occ"] };
  const write = async (path, content) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await write("scripts/module-boundaries/policy.json", JSON.stringify(config));
  await write(
    "scripts/module-boundaries/exceptions.json",
    JSON.stringify({ version: 1, exceptions: [] }),
  );
  return { root, write, check: (extra = {}) => verifyModuleBoundaries({ root, ...extra }) };
}

test("supports real leaf exports, source extension mapping, composition, and new console leaves", async (t) => {
  const { root, check } = await workspace(t);
  const report = await check();
  assert.equal(report.ok, true, JSON.stringify(report.violations));
  assert.ok(
    report.edges.some(
      (edge) =>
        edge.to === "packages/occ/src/ports/configuration.ts" && edge.specifier.endsWith(".js"),
    ),
  );
  assert.ok(
    report.edges.some(
      (edge) =>
        edge.kind === "dynamic-import" &&
        edge.to === "apps/controller/src/console/pages/detail.mjs",
    ),
  );
  const { stdout, stderr } = await run(process.execPath, [
    join(repository, "scripts/verify-module-boundaries.mjs"),
    "--root",
    root,
    "--json",
  ]);
  assert.equal(stderr, "");
  assert.equal(JSON.parse(stdout).ok, true);
});

test("rejects concrete storage edges, including erased imports, re-exports and external database dependencies", async (t) => {
  const { write, check } = await workspace(t);
  await write(
    "packages/occ/src/services/invalid.ts",
    `
    import type { transactionBackend } from "../state/postgres/transaction.ts";
    export { transactionBackend as backend } from "../state/postgres/transaction.ts";
    import type { Pool } from "pg";
  `,
  );
  const report = await check();
  const violations = report.violations.filter((item) => item.rule === "domain-to-implementation");
  assert.equal(violations.length, 3);
  assert.equal(violations.filter((item) => item.typeOnly).length, 2);
});

test("enforces supported package specifiers, blocked exports and owning library root boundaries", async (t) => {
  const { write, check } = await workspace(t);
  await write(
    "packages/contracts/src/resources/invalid.ts",
    `
    import type { Scope } from "../index.ts";
    export type { Scope as RootScope } from "@openclaw-enterprise/contracts";
    import { configurationKey } from "@openclaw-enterprise/occ/src/index.ts";
    import { installationScope } from "@openclaw-enterprise/contracts/blocked";
    import * as publicValues from "../resources/scope.ts";
  `,
  );
  await write(
    "apps/controller/src/private.ts",
    'import type { Scope } from "../../../packages/contracts/src/resources/scope.ts";',
  );
  const report = await check();
  assert.equal(report.violations.filter((item) => item.rule === "internal-root-barrel").length, 2);
  assert.equal(
    report.violations.filter((item) => item.rule === "unsupported-package-export").length,
    2,
  );
  assert.equal(report.violations.filter((item) => item.rule === "cross-package-source").length, 1);
});

test("resolves dynamic URLs, constant paths, lexical shadowing and dependency anchors without loading code", async (t) => {
  const { write, check } = await workspace(t);
  await write(
    "apps/controller/src/dynamic.ts",
    `
    import { createRequire } from "node:module";
    const requireOccDependency = createRequire(new URL("../../../packages/occ/package.json", import.meta.url));
    await import(requireOccDependency.resolve("drizzle-orm/node-postgres"));
    const directory = "../../../packages/contracts/src/resources/";
    const schemaPath = directory + "scope.ts";
    await import(schemaPath);
    await import(new URL("../../../packages/contracts/src/resources/%73cope.ts?probe=1#fragment", import.meta.url).href);
    const page = "unresolved-outside-scope.ts";
    async function load() {
      const page = "./console/pages/detail.mjs";
      return import(page);
    }
  `,
  );
  const report = await check();
  assert.equal(
    report.violations.filter(
      (item) =>
        item.rule === "unresolved-local-import" || item.rule === "unresolved-dynamic-import",
    ).length,
    0,
  );
  assert.ok(
    report.violations.some(
      (item) => item.rule === "cross-package-source" && item.kind === "dependency-anchor",
    ),
  );
  assert.ok(
    report.violations.some(
      (item) =>
        item.rule === "cross-package-source" &&
        item.specifier === "file:packages/contracts/src/resources/scope.ts",
    ),
  );
  assert.ok(
    report.edges.some(
      (item) => item.from.endsWith("dynamic.ts") && item.to.endsWith("console/pages/detail.mjs"),
    ),
  );
  assert.ok(!JSON.stringify(report).includes("module-boundaries-"));
  await write(
    "apps/controller/src/path-anchor.mjs",
    `
    import { createRequire } from "node:module";
    import { fileURLToPath } from "node:url";
    const load = createRequire(fileURLToPath(new URL("../../../packages/occ/package.json", import.meta.url)));
    load("drizzle-orm/node-postgres");
  `,
  );
  assert.ok(
    (await check()).violations.some(
      (edge) =>
        edge.rule === "cross-package-source" &&
        edge.kind === "dependency-anchor" &&
        edge.from.endsWith("path-anchor.mjs") &&
        edge.to === "packages/occ/package.json",
    ),
  );
});

test("reports unresolved dynamic and local paths, while ignoring comments and embedded runtime scripts", async (t) => {
  const { write, check } = await workspace(t);
  await write(
    "apps/controller/src/unknown.mjs",
    `
    // import "./comment-does-not-exist.ts";
    const runtimeScript = 'require("./embedded-does-not-exist.ts")';
    import "./does-not-exist.mjs";
    import "#unregistered";
    export const configured = (name) => import(name);
    export const template = (name) => import(\`./console/\${name}.mjs\`);
  `,
  );
  const report = await check();
  assert.equal(report.violations.length, 4);
  assert.equal(
    report.violations.filter((item) => item.rule === "unresolved-dynamic-import").length,
    2,
  );
  assert.ok(!JSON.stringify(report.violations).includes("does-not-exist.ts"));
});

test("distinguishes runtime cycles from cycles requiring erased type edges", async (t) => {
  const { write, check } = await workspace(t);
  await write(
    "apps/controller/src/cycles/type-a.ts",
    'import type { B } from "./type-b.ts"; export interface A { b: B }',
  );
  await write("apps/controller/src/cycles/type-b.ts", 'export type { A as B } from "./type-a.ts";');
  await write(
    "apps/controller/src/cycles/runtime-a.ts",
    'import { type B } from "./runtime-b.ts"; export interface A {}',
  );
  await write(
    "apps/controller/src/cycles/runtime-b.ts",
    'export { type A as B } from "./runtime-a.ts";',
  );
  await write(
    "apps/controller/src/cycles/query.ts",
    'export type Query = import("./type-a.ts").A;',
  );
  // Native execution preserves these empty declarations and evaluates their targets.
  assert.match(stripTypeScriptTypes('import { type A } from "./a.ts";'), /import\s*\{\s*\}\s*from/);
  assert.match(stripTypeScriptTypes('export { type A } from "./a.ts";'), /export\s*\{\s*\}\s*from/);
  const report = await check();
  assert.equal(report.runtimeCycles.length, 1);
  assert.ok(report.runtimeCycles[0].every((path) => path.includes("runtime-")));
  assert.equal(report.typeInvolvingCycles.length, 1);
  assert.equal(report.typeOnlyCycles.length, 1);
  assert.ok(report.typeInvolvingCycles[0].every((path) => path.includes("type-")));
  assert.equal(report.violations.filter((item) => item.rule === "runtime-cycle").length, 1);
  assert.equal(report.edges.find((edge) => edge.from.endsWith("query.ts")).typeOnly, true);
});

test("accepts only exact reviewed exceptions and rejects them after dependency removal", async (t) => {
  const { write, check } = await workspace(t);
  const path = "packages/contracts/src/resources/pending.ts";
  await write(path, 'import type { Scope } from "../index.ts";');
  const exception = {
    rule: "internal-root-barrel",
    from: path,
    to: "packages/contracts/src/index.ts",
    specifier: "../index.ts",
    kind: "import",
    typeOnly: true,
    bindings: ["type:Scope"],
    owner: "Resource contracts",
    removeWhen: "Use the scope leaf.",
    reason: "This consumer is awaiting its reviewed leaf extraction.",
  };
  const exceptions = { version: 1, exceptions: [exception] };
  assert.equal((await check({ exceptions })).ok, true);
  await write(path, 'import type { Scope, installationScope } from "../index.ts";');
  assert.deepEqual((await check({ exceptions })).violations.map((item) => item.rule).sort(), [
    "internal-root-barrel",
    "stale-exception",
  ]);
  await write(path, 'import { installationScope } from "../index.ts";');
  assert.deepEqual((await check({ exceptions })).violations.map((item) => item.rule).sort(), [
    "internal-root-barrel",
    "stale-exception",
  ]);
  await write(path, 'import type { Scope } from "./scope.ts";');
  assert.deepEqual(
    (await check({ exceptions })).violations.map((item) => item.rule),
    ["stale-exception"],
  );
  assert.equal((await check()).ok, true);
  await assert.rejects(
    check({ exceptions: { version: 1, exceptions: [exception, exception] } }),
    /Duplicate/,
  );
  await assert.rejects(
    check({ exceptions: { version: 1, exceptions: [{ ...exception, owner: "" }] } }),
    /capability owner/,
  );
});

test("follows createRequire aliases and conditional require exports, while preserving helper semantics", async (t) => {
  const { write, check } = await workspace(t);
  await write(
    "apps/controller/src/known-require.mjs",
    `
    import module from "module";
    import { fileURLToPath as toPath } from "node:url";
    import * as path from "node:path";
    const require = module.createRequire(import.meta.url);
    const load = require;
    load("@openclaw-enterprise/contracts/conditional");
    const directory = path.dirname(toPath(import.meta.url));
    await import(path.join(directory, "/console/pages/detail.mjs"));
  `,
  );
  await write(
    "packages/contracts/package.json",
    JSON.stringify({
      name: "@openclaw-enterprise/contracts",
      type: "module",
      exports: {
        ".": "./src/index.ts",
        "./resources/*": "./src/resources/*.ts",
        "./scope": "./src/resources/scope.ts",
        "./conditional": { require: "./src/resources/scope.ts", import: null },
      },
    }),
  );
  let report = await check();
  assert.equal(report.ok, true, JSON.stringify(report.violations));
  assert.ok(
    report.edges.some((edge) => edge.kind === "require" && edge.to.endsWith("resources/scope.ts")),
  );
  assert.ok(
    report.edges.some(
      (edge) =>
        edge.from.endsWith("known-require.mjs") && edge.to.endsWith("console/pages/detail.mjs"),
    ),
  );
  await write(
    "packages/occ/src/services/require-database.ts",
    `
    import module from "node:module";
    const require = module.createRequire(import.meta.url);
    const load = require;
    load("pg");
  `,
  );
  report = await check();
  assert.ok(
    report.violations.some(
      (edge) => edge.rule === "domain-to-implementation" && edge.specifier === "pg",
    ),
  );
  await write(
    "packages/occ/package.json",
    JSON.stringify({
      name: "@openclaw-enterprise/occ",
      type: "module",
      exports: {
        ".": "./src/index.ts",
        "./conditional": {
          import: "./src/ports/configuration.ts",
          require: "./src/state/postgres/transaction.ts",
        },
      },
    }),
  );
  await write(
    "apps/controller/src/worker/conditional.ts",
    `
    import { createRequire } from "module";
    const require = createRequire(import.meta.url);
    const selected = require.resolve("@openclaw-enterprise/occ/conditional");
    await import(selected);
  `,
  );
  report = await check();
  assert.ok(
    report.violations.some(
      (edge) =>
        edge.rule === "domain-to-implementation" &&
        edge.from.endsWith("conditional.ts") &&
        edge.to.endsWith("state/postgres/transaction.ts"),
    ),
  );
});

test("allows worker collaborators while rejecting provider and inward contract regressions", async (t) => {
  const { write, check } = await workspace(t);
  await write(
    "apps/controller/src/worker/revision-inputs.ts",
    "export const revisionInput = {};\n",
  );
  await write(
    "apps/controller/src/worker/revisions.ts",
    'import { revisionInput } from "./revision-inputs.ts";',
  );
  assert.equal((await check()).ok, true);
  await write(
    "packages/contracts/src/resources/invalid-controller.ts",
    'import { configurationKey } from "@openclaw-enterprise/occ";',
  );
  await write(
    "apps/controller/src/worker/provider.ts",
    'import { createHttpApp } from "../index.ts";',
  );
  assert.equal(
    (await check()).violations.filter((item) => item.rule === "domain-to-implementation").length,
    2,
  );
});

test("runtime cycle exceptions bind the full existing edge set", async (t) => {
  const { write, check } = await workspace(t);
  await write("apps/controller/src/cycles/a.mjs", 'import "./b.mjs"; export const a = 1;');
  await write("apps/controller/src/cycles/b.mjs", 'import "./a.mjs"; export const b = 2;');
  const cycle = (await check()).violations.find((item) => item.rule === "runtime-cycle");
  const exceptions = {
    version: 1,
    exceptions: [
      {
        ...cycle,
        owner: "Controller composition",
        reason: "Existing runtime dependency cycle.",
        removeWhen: "Extract a shared leaf.",
      },
    ],
  };
  assert.equal((await check({ exceptions })).ok, true);
  await write(
    "apps/controller/src/cycles/a.mjs",
    'import "./b.mjs"; export { b } from "./b.mjs"; export const a = 1;',
  );
  assert.deepEqual((await check({ exceptions })).violations.map((item) => item.rule).sort(), [
    "runtime-cycle",
    "stale-exception",
  ]);
});

test("checks new HTTP and provider leaves and bounds CLI diagnostics", async (t) => {
  const { root, write, check } = await workspace(t);
  await write(
    "apps/controller/src/drivers/compute/kubernetes/resources/gateway.ts",
    "export const gateway = {};\n",
  );
  await write(
    "apps/controller/src/drivers/compute/docker/plan.ts",
    'export { gateway } from "../kubernetes/resources/gateway.ts";',
  );
  await write(
    "apps/controller/src/routes/configuration.ts",
    'export { gateway } from "../drivers/compute/kubernetes/resources/gateway.ts";',
  );
  const report = await check();
  assert.deepEqual(report.violations.map((item) => item.rule).sort(), [
    "cross-provider-implementation",
    "http-to-provider",
  ]);
  const config = JSON.parse(
    await readFile(join(root, "scripts/module-boundaries/policy.json"), "utf8"),
  );
  await write(
    "scripts/module-boundaries/policy.json",
    JSON.stringify({ ...config, diagnosticLimit: 1 }),
  );
  await assert.rejects(
    run(process.execPath, [
      join(repository, "scripts/verify-module-boundaries.mjs"),
      "--root",
      root,
    ]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /1 additional violations/);
      assert.equal(
        error.stderr
          .split("\n")
          .filter(
            (line) =>
              line.includes("[cross-provider-implementation]") ||
              line.includes("[http-to-provider]"),
          ).length,
        1,
      );
      return true;
    },
  );
});
