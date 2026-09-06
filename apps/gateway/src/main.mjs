import { requireAdmittedGatewayConfiguration } from "./admitted-configuration.ts";

/** The fixed executable remains unavailable until the real startup consumer exists. */
export async function main() {
  try {
    requireAdmittedGatewayConfiguration();
    // TODO: Wire the actual admitted startup consumer to the fixed composition.
    // Until both are connected, even a returned value cannot enable this entrypoint.
    throw new Error("Hosted gateway composition is not connected");
  } catch {
    process.stderr.write("Hosted gateway unavailable: admitted startup is not connected.\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
