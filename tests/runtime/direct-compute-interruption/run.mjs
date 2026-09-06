import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SCENARIOS, DEFERRED_CASES, RETAINED_LIFECYCLE_FIXTURE } from "./scenarios.ts";

async function main(args) {
  if (args.length === 1 && args[0] === "--list") {
    console.log(
      JSON.stringify(
        {
          scenarios: SCENARIOS,
          deferred: DEFERRED_CASES,
          retainedFixture: RETAINED_LIFECYCLE_FIXTURE,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (args.length !== 3 || args[0] !== "--controlled" || args[1] !== "--output" || !args[2])
    throw new Error("Use --list or --controlled --output FILE (new file only).");
  const { scenarioInput, controlledSession, sourceBinding } =
    await import("./controlled-fixture.mjs");
  const { runInterruptionMatrix } = await import("./runner.ts");
  const source = sourceBinding();
  const inputs = SCENARIOS.map(({ id }) => scenarioInput(id, source));
  const reports = await runInterruptionMatrix(inputs, (input) => controlledSession(input).options);
  const output = resolve(args[2]);
  writeFileSync(
    output,
    JSON.stringify(
      {
        schemaVersion: 1,
        evidenceKind: "controlled-preparation",
        reports,
        deferred: DEFERRED_CASES,
        retainedFixture: RETAINED_LIFECYCLE_FIXTURE,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(JSON.stringify({ output, scenarios: reports.length, runtimePasses: 0 }));
}

main(process.argv.slice(2)).catch(() => {
  console.error(
    "Interruption preparation failed; check the command, owned dependencies and output path.",
  );
  process.exitCode = 1;
});
