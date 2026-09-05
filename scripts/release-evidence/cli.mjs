import { dirname, basename, resolve } from "node:path";
import { registry } from "./registry.mjs";
import { check, LIMITS, summarize } from "./evidence.mjs";
import { collect, exportCandidate, loadAttempt, readJson } from "./collector.mjs";

const readArgument = (path) => readJson(dirname(resolve(path)), basename(path), LIMITS.bundleBytes);
// Stream errors arrive asynchronously, outside the command's try/catch. Emit
// one fixed fallback, never a raw stack/path or another write to failed stdout.
let outputFailed = false;
process.stderr.on("error", () => {
  process.exitCode = 1;
});
process.stdout.on("error", () => {
  process.exitCode = 1;
  if (!outputFailed) {
    outputFailed = true;
    process.stderr.write('{"status":"failure","reasonCode":"output-unavailable"}\n');
  }
});
const output = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "registry") {
    check(args.length === 0, "usage");
    output(registry());
  } else if (command === "report") {
    check(args.length >= 1 && args.length <= LIMITS.attempts + 1, "usage");
    const inputs = await readArgument(args[0]);
    const attempts = [];
    for (const directory of args.slice(1)) {
      // Preserve stale evidence in history. summarize compares it to the current
      // inputs, invalidates its coverage, and retains its original result.
      const manifest = await readJson(resolve(directory), "manifest.json", LIMITS.bundleBytes);
      attempts.push(await loadAttempt(resolve(directory), manifest.metadata.inputs));
    }
    output(summarize(attempts, inputs));
  } else if (command === "validate") {
    check(args.length === 2, "usage");
    await loadAttempt(resolve(args[0]), await readArgument(args[1]));
    output({
      status: "valid",
      provenance: "unverified-import",
      releaseAcceptance: "not-established",
    });
  } else if (command === "collect") {
    check(args.length === 1, "usage");
    const request = await readArgument(args[0]);
    const result = await collect(request);
    output(result);
    if (result.status !== "complete") process.exitCode = 1;
  } else if (command === "candidate") {
    check(args.length === 4, "usage");
    const result = await exportCandidate({
      directory: resolve(args[0]),
      outputDirectory: resolve(args[1]),
      expectedInputs: await readArgument(args[2]),
      review: await readArgument(args[3]),
    });
    output(result);
    if (result.status !== "complete") process.exitCode = 1;
  } else check(false, "usage");
} catch {
  // Imported command strings are data. There is deliberately no fixture runner
  // or shell execution path in this program, and no raw errors on its output.
  output({ status: "rejected", reasonCode: "invalid-command-or-evidence" });
  process.exitCode = 1;
}
