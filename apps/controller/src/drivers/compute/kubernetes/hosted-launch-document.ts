import { isDeepStrictEqual } from "node:util";
import type { GatewayProcessCreateInputV2 } from "@openclaw-enterprise/contracts/gateway-startup-v1";
import { gatewayLaunchMaxBytes } from "@openclaw-enterprise/contracts/hosted-gateway-launch-v1";
import {
  canonicalGatewayStartupValueV1,
  parseGatewayStartupBindingV2,
  parseGatewayStartupCommandV2,
} from "@openclaw-enterprise/occ/gateway-startup-v1/owner";
import { WorkloadProfileSelectionError } from "@openclaw-enterprise/occ/workload-profiles/selection";

const unavailable = () => new WorkloadProfileSelectionError("unavailable");

/** Construction correspondence only. The original reader still validates the
 * native profile, independent native configuration version, association and
 * Harness fields; neither document format confers process or resource authority. */
export function selectedHostedLaunchDocument(
  document: string,
  expected?: GatewayProcessCreateInputV2,
) {
  if (
    typeof document !== "string" ||
    !document ||
    Buffer.byteLength(document) > gatewayLaunchMaxBytes
  )
    throw unavailable();
  if (Buffer.from(document, "utf8").toString("utf8") !== document) throw unavailable();
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    throw unavailable();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unavailable();
  const value = parsed as Record<string, unknown>;
  if (value.schemaVersion === 1) {
    // Historical V1 construction remains separate. An original V2 allocation
    // cannot submit a V1 document under its subject or effect.
    if (expected !== undefined || JSON.stringify(value) !== document) throw unavailable();
    return Object.freeze({ schemaVersion: 1 as const });
  }
  if (
    value.schemaVersion !== 2 ||
    expected === undefined ||
    Object.keys(value).sort().join() !==
      "address,association,binding,configurationVersion,consumeCommand,harness,profile,schemaVersion" ||
    canonicalGatewayStartupValueV1(value) !== document
  )
    throw unavailable();
  try {
    const binding = parseGatewayStartupBindingV2(value.binding);
    const original = parseGatewayStartupBindingV2(expected.binding);
    const command = parseGatewayStartupCommandV2(value.consumeCommand);
    if (
      !isDeepStrictEqual(binding, original) ||
      command.kind !== "consume-startup" ||
      !isDeepStrictEqual(command.subject, binding.startup.subject) ||
      !isDeepStrictEqual(command.startup, binding.startup) ||
      !isDeepStrictEqual(command.expectedHead.startup, binding.startup)
    )
      throw unavailable();
    return Object.freeze({ schemaVersion: 2 as const, binding });
  } catch {
    throw unavailable();
  }
}
