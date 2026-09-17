import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const tsc = new URL("../../node_modules/typescript/bin/tsc", import.meta.url);
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      !name.startsWith("GIT_") && !["ENV", "BASH_ENV", "NODE_OPTIONS", "NODE_PATH"].includes(name),
  ),
);
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function compile(args, options) {
  try {
    return execFileSync(process.execPath, args, options);
  } catch (error) {
    const diagnostics = String(error.stdout ?? error.message)
      .split("\n")
      .filter((line) => line.includes("error TS"));
    throw new Error(
      diagnostics.length ? diagnostics.join("\n") : `Compiler failed: ${error.message}`,
    );
  }
}

test("supported package subpath resolves actual owner DATA and emits no absent factory body", () => {
  const program = `
    import assert from "node:assert/strict";
    import * as selected from "@openclaw-enterprise/occ/internal/backend-recipe-operations-v1";
    const resolved = import.meta.resolve("@openclaw-enterprise/occ/internal/backend-recipe-operations-v1");
    assert.equal(selected.githubOperationRegistrationsV1.length, 10);
    assert.deepEqual(Object.keys(selected).sort(), ["githubOperationRegistrationsV1", "githubResourcePolicyEncodingV1"]);
    assert.equal(Object.hasOwn(selected, "registerSelectedRecipeOperationRowsV1"), false);
    console.log(JSON.stringify({ resolved, declarationRuntime: "absent", githubRows: 10 }));
  `;
  const result = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", program], {
      cwd: new URL("../../packages/occ/", import.meta.url),
      env: cleanEnvironment,
      encoding: "utf8",
      timeout: 15000,
    }),
  );
  assert.equal(
    result.resolved,
    new URL(
      "../../packages/occ/src/credential-gateway-v1/selected-recipe-operations-contract.ts",
      import.meta.url,
    ).href,
  );
  assert.equal(result.declarationRuntime, "absent");
});

for (const [role, entry] of [
  ["producer", "producer"],
  ["grant-projector", "grant-projector-consumer"],
  ["iam", "iam-consumer"],
]) {
  test(`separate strict ${role} consumer preserves original signatures, nominal negatives and fresh emitted source`, (t) => {
    const output = mkdtempSync(join(tmpdir(), `oce-selected-${role}-`));
    try {
      const result = compile(
        [
          tsc.pathname,
          "--project",
          `tests/fixtures/selected-recipe-operations/tsconfig.${role}.json`,
          "--types",
          "node",
          "--strict",
          "--skipLibCheck",
          "false",
          "--noEmit",
          "false",
          "--declaration",
          "true",
          "--outDir",
          output,
          "--listFiles",
          "--pretty",
          "false",
        ],
        {
          cwd: root,
          env: cleanEnvironment,
          encoding: "utf8",
          timeout: 60000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      // Actual compiler inputs, not replacement ambient declarations, bind this proof.
      for (const supplier of [
        "packages/occ/src/credential-gateway-v1/schema.ts",
        "packages/occ/src/credential-gateway-v1/recipe-operation.ts",
        "packages/occ/src/credential-broker-v1/schema-registry.ts",
        "packages/occ/src/root-work-v1/selected-iam.ts",
        "packages/occ/src/root-work-v1/selected-iam-ports.ts",
        "tests/fixtures/selected-recipe-operations/negative-vectors.ts",
      ])
        assert.ok(
          result.includes(new URL(supplier, root).pathname),
          `Missing actual compiler input: ${supplier}`,
        );
      const js = join(output, "tests", "fixtures", "selected-recipe-operations", `${entry}.js`);
      const declaration = join(
        output,
        "tests",
        "fixtures",
        "selected-recipe-operations",
        `${entry}.d.ts`,
      );
      const iamBody = join(output, "packages", "occ", "src", "root-work-v1", "selected-iam.js");
      const originalSchema = join(
        output,
        "packages",
        "occ",
        "src",
        "credential-gateway-v1",
        "schema.d.ts",
      );
      for (const emitted of [js, declaration, iamBody, originalSchema])
        assert.ok(existsSync(emitted), `Missing fresh output: ${emitted}`);
      t.diagnostic(
        JSON.stringify({
          role,
          strict: true,
          skipLibCheck: false,
          physicalEmit: [
            { kind: "consumer-js", sha256: sha256(js) },
            { kind: "consumer-declaration", sha256: sha256(declaration) },
            { kind: "actual-iam-body", sha256: sha256(iamBody) },
            { kind: "original-schema-declaration", sha256: sha256(originalSchema) },
          ],
          execution: "declaration call sites only; absent owner bodies not invoked",
        }),
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
}
