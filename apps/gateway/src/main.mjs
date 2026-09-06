import { requireAdmittedGatewayConfiguration } from "./admitted-configuration.ts";

/** Use the original enrollment once; Runtime retains the complete local lifetime. */
export async function main() {
  try {
    const { usePort, recipient, startup } = requireAdmittedGatewayConfiguration();
    const result = await usePort.start(recipient, startup);
    if (result.kind !== "started") throw new Error("Hosted gateway startup unavailable");

    // Waiting does not request shutdown. The owner closes and joins pending/late
    // work; external process supervision retains physical termination responsibility.
    const closed = result.lifetime.closed;
    if (!closed || typeof closed.then !== "function") {
      throw new Error("Hosted gateway lifetime unavailable");
    }
    const outcome = await closed;
    if (outcome.cleanup !== "finished" || outcome.termination !== "unknown") {
      throw new Error("Hosted gateway cleanup unavailable");
    }
  } catch {
    process.stderr.write("Hosted gateway unavailable: startup or cleanup is not confirmed.\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
