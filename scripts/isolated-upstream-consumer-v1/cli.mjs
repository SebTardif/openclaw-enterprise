#!/usr/bin/env node
import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectResults } from "./collector.mjs";
import { loadManifest, preparePlan, readArtifact, verifyArtifacts } from "./consumer.mjs";
import { LIMITS, parseJson } from "./manifest.mjs";

/** Args are data; this CLI never spawns, imports supplied code, installs, or retries. */
export async function main(args) {
  const [operation, ...rest] = args;
  assert.ok(["verify", "plan", "collect"].includes(operation), "expected verify, plan or collect");
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    assert.ok(
      [
        "--root",
        "--manifest",
        "--expected",
        "--observations",
        "--environment",
        "--output",
      ].includes(rest[i]),
    );
    assert.ok(rest[i + 1] && !Object.hasOwn(options, rest[i]));
    options[rest[i]] = rest[i + 1];
  }
  const root = options["--root"];
  assert.ok(typeof root === "string" && isAbsolute(root));
  const m = await loadManifest(root, options["--manifest"], options["--expected"]);
  let result;
  if (operation === "collect") {
    assert.ok(options["--observations"] && !options["--environment"]);
    result = collectResults(
      m,
      options["--expected"],
      (await readArtifact(root, options["--observations"])).content,
    );
  } else if (operation === "plan") {
    assert.ok(!options["--observations"] && !options["--environment"]);
    result = preparePlan(m, options["--expected"]);
  } else {
    assert.ok(!options["--observations"]);
    const environment = options["--environment"]
      ? parseJson((await readArtifact(root, options["--environment"])).content)
      : [];
    result = await verifyArtifacts(root, m, environment);
  }
  const output = `${JSON.stringify(result, null, 2)}\n`;
  assert.ok(Buffer.byteLength(output) <= LIMITS.jsonBytes, "result size limit");
  if (options["--output"]) {
    assert.ok(isAbsolute(options["--output"]));
    const file = await open(options["--output"], "wx", 0o600);
    try {
      await file.writeFile(output);
    } finally {
      await file.close();
    }
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = await main(process.argv.slice(2));
    process.stdout.write(output);
    const result = JSON.parse(output);
    if (["fail", "blocked"].includes(result.outcome) || result.allRequiredReportedPass === false)
      process.exitCode = 2;
  } catch {
    process.stderr.write("Isolated consumer input rejected; no operation retried.\n");
    process.exitCode = 1;
  }
}
