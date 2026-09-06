import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Check } from "typebox/value";
import { Type } from "typebox";
import {
  AcceptanceDigestDomainsV1,
  ACCEPTANCE_LIMITS_V1,
} from "@openclaw-enterprise/contracts/acceptance-companion-v1";
import { safeDirectory, relativeSource, readBounded } from "../collector.mjs";
import { ALLOCATION_RUN_LIMITS_V1, parseAllocationJsonV1 } from "./reader.ts";
import { buildAllocationReportV1, encodeAllocationReportV1 } from "./report.ts";

const path = Type.String({ minLength: 1, maxLength: 160 });
const closed = (properties) => Type.Object(properties, { additionalProperties: false });
const filesSchema = closed({
  schemaVersion: Type.Literal("allocation-run-files/v1"),
  selection: path,
  companions: Type.Array(path, { maxItems: 324, uniqueItems: true }),
  receipts: Type.Array(path, { maxItems: ALLOCATION_RUN_LIMITS_V1.maxRecords, uniqueItems: true }),
  attempts: Type.Array(path, { maxItems: ALLOCATION_RUN_LIMITS_V1.maxAttempts, uniqueItems: true }),
  artifacts: Type.Array(
    closed({
      path,
      identity: closed({
        domain: Type.Enum(AcceptanceDigestDomainsV1),
        sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
        byteLength: Type.Integer({
          minimum: 1,
          maximum: ALLOCATION_RUN_LIMITS_V1.maxArtifactBytes,
        }),
      }),
    }),
    { maxItems: ALLOCATION_RUN_LIMITS_V1.maxArtifacts },
  ),
});

/** Do not retain the inherited helper's limit-sized backing allocation per file. */
export async function readAllocationFileV1(root, relative, limit) {
  return new Uint8Array(await readBounded(root, relativeSource(relative), limit));
}

export async function main(args) {
  if (args.length !== 6 || args[0] !== "--root" || args[2] !== "--files" || args[4] !== "--output")
    throw new Error(
      "usage: --root ABSOLUTE_DIRECTORY --files RELATIVE_JSON --output ABSOLUTE_NEW_JSON",
    );
  const root = await safeDirectory(args[1]);
  const output = args[5];
  if (!isAbsolute(output) || resolve(output) !== output || !output.endsWith(".json"))
    throw new Error("invalid-output-path");
  await safeDirectory(dirname(output));
  const fileBytes = await readAllocationFileV1(
    root,
    relativeSource(args[3]),
    ALLOCATION_RUN_LIMITS_V1.maxSelectionBytes,
  );
  const files = parseAllocationJsonV1(fileBytes, ALLOCATION_RUN_LIMITS_V1.maxSelectionBytes);
  if (!Check(filesSchema, files)) throw new Error("invalid-file-list");
  let used = fileBytes.byteLength;
  const load = async (relative, limit) => {
    const remaining = ALLOCATION_RUN_LIMITS_V1.maxAggregateBytes - used;
    if (remaining < 1) throw new Error("aggregate-limit");
    const bytes = await readAllocationFileV1(root, relative, Math.min(limit, remaining));
    used += bytes.byteLength;
    return bytes;
  };
  const loadAll = async (names, limit) => {
    const result = [];
    for (const name of names) result.push(await load(name, limit));
    return result;
  };
  const selection = await load(files.selection, ALLOCATION_RUN_LIMITS_V1.maxSelectionBytes);
  const companions = await loadAll(files.companions, ACCEPTANCE_LIMITS_V1.maxJsonBytes);
  const receipts = await loadAll(files.receipts, ACCEPTANCE_LIMITS_V1.maxJsonBytes);
  const attempts = await loadAll(files.attempts, ACCEPTANCE_LIMITS_V1.maxJsonBytes);
  const artifacts = [];
  for (const artifact of files.artifacts)
    artifacts.push({
      identity: artifact.identity,
      bytes: await load(artifact.path, ALLOCATION_RUN_LIMITS_V1.maxArtifactBytes),
    });
  const report = buildAllocationReportV1({ selection, companions, receipts, attempts, artifacts });
  const bytes = encodeAllocationReportV1(report);
  const handle = await open(
    output,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  process.stdout.write(
    `${report.structuralValidity}; inventory ${report.inventoryCompleteness}; authentication unverified\n`,
  );
  return report.structuralValidity === "valid" && report.inventoryCompleteness === "complete"
    ? 0
    : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    process.stderr.write(
      "allocation reader failed; check inputs, bounds, and exclusive output path\n",
    );
    process.exitCode = 1;
  }
}
