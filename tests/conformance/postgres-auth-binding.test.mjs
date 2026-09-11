import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import ts from "typescript-compiler-api";
import { createPostgresAuthBinding } from "../../packages/occ/src/auth-persistence/postgres-auth-binding.ts";
import * as canonicalSchema from "../../packages/occ/src/state/postgres-schema.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const compiler = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));
const fixtures = "apps/controller/tests/fixtures/postgres-auth-binding/";

function run(args) {
  const result = spawnSync(process.execPath, ["--max-old-space-size=1536", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 90_000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `Child terminated: ${result.signal}`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test("the real factory retains the caller pool and complete canonical schema without I/O", async () => {
  const pool = new pg.Pool({ max: 1 });
  const calls = [];
  // These observations belong to the caller's real resource. The factory and
  // Drizzle are unchanged; construction must not borrow, query or close it.
  for (const method of ["connect", "query", "end"]) {
    Object.defineProperty(pool, method, {
      configurable: true,
      value() {
        calls.push(method);
        throw new Error(`Unexpected pool ${method}`);
      },
    });
  }
  let pending;
  assert.doesNotThrow(() => {
    pending = createPostgresAuthBinding(pool);
  });
  assert.ok(pending instanceof Promise);
  const binding = await pending;
  assert.strictEqual(binding.schema, canonicalSchema);
  assert.strictEqual(binding.database.$client, pool);
  assert.strictEqual(binding.database._.fullSchema, canonicalSchema);
  for (const key of Object.keys(canonicalSchema)) {
    assert.strictEqual(binding.schema[key], canonicalSchema[key], key);
  }
  assert.deepEqual(Object.keys(binding).sort(), ["database", "schema"]);
  assert.equal("end" in binding, false);
  assert.equal("close" in binding, false);
  assert.equal(pool.totalCount, 0);
  assert.equal(pool.idleCount, 0);
  assert.equal(pool.waitingCount, 0);
  assert.deepEqual(calls, []);
  // Independent bindings retain the same supplied resource and table objects.
  const second = await createPostgresAuthBinding(pool);
  assert.notStrictEqual(second.database, binding.database);
  assert.strictEqual(second.database.$client, pool);
  assert.strictEqual(second.schema, binding.schema);
  assert.deepEqual(calls, []);
});

test("structural caller pools with config-like fields retain their exact identity", async () => {
  const underlying = new pg.Pool({ max: 1 });
  // The accepted public pool type is structural. These real-resource wrappers
  // remain pools even when callers attach fields also used by Drizzle config.
  for (const extra of [{ schema: {} }, { logger: false }, { connection: {} }, { client: {} }]) {
    let connects = 0;
    let ends = 0;
    const caller = {
      async connect() {
        connects++;
        return underlying.connect();
      },
      async end() {
        ends++;
        return underlying.end();
      },
      query: underlying.query.bind(underlying),
      ...extra,
    };
    const binding = await createPostgresAuthBinding(caller);
    assert.strictEqual(binding.database.$client, caller, Object.keys(extra)[0]);
    assert.strictEqual(binding.schema, canonicalSchema);
    assert.strictEqual(binding.database._.fullSchema, canonicalSchema);
    assert.equal(connects, 0);
    assert.equal(ends, 0);
    assert.equal(underlying.totalCount, 0);
  }
});

for (const dependency of ["drizzle", "schema"]) {
  test(`actual ${dependency} import rejection propagates without pool teardown`, () => {
    run([`${fixtures}import-failure.mjs`, dependency]);
  });
}

test("construction avoids caller constructor-accessor failure and preserves ownership", () => {
  run([`${fixtures}constructor-failure.mjs`]);
});

for (const project of ["producer", "consumer", "negatives"]) {
  test(`supported auth binding compiles the independent ${project} project`, () => {
    run([compiler, "--project", `${fixtures}${project}.tsconfig.json`, "--pretty", "false"]);
  });
}

test("emitted factory imports remain in OCC without a BetterAuth or pool-constructor import", () => {
  const path = new URL(
    "../../packages/occ/src/auth-persistence/postgres-auth-binding.ts",
    import.meta.url,
  );
  const emitted = ts.transpileModule(readFileSync(path, "utf8"), {
    fileName: fileURLToPath(path),
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });
  assert.deepEqual(emitted.diagnostics, []);
  // This checks the actual emitted module's dependency boundary only; the real
  // factory tests above establish object identity and observable resource use.
  const syntax = ts.createSourceFile(
    "binding.js",
    emitted.outputText,
    ts.ScriptTarget.ES2022,
    true,
  );
  const imports = [];
  function visit(node) {
    if (ts.isImportDeclaration(node)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  assert.deepEqual(imports.sort(), ["../state/postgres-schema.ts", "drizzle-orm/node-postgres"]);
});
