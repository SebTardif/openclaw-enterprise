import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { gatewayLaunchMaxBytes } from "@openclaw-enterprise/contracts/hosted-gateway-launch-v1";
import type { GatewayLaunchResourceAllocationV2 } from "@openclaw-enterprise/contracts/gateway-launch-resource-v2";
import type { GatewayLaunchResourceSourceV2 } from "../../gateway-startup-v1/launch-resource.ts";
import {
  canonicalGatewayStartupValueV1,
  parseGatewayStartupBindingV2,
  parseGatewayStartupCommandV2,
  type GatewayStartupMutationEventV2,
  type GatewayStartupSelectionUnitV2,
  type GatewayStartupAcceptedOperationV1,
} from "../../gateway-startup-v1/owner.ts";

const unavailable = () => new Error("The original Gateway launch allocation is unavailable.");
type Reference = Pick<
  GatewayLaunchResourceAllocationV2,
  "recordRef" | "recordVersion" | "effectRef"
>;

/** Capture a selected source within the original mandatory-audit phase. This
 * returns data for the same transaction, never a resource ticket or an installed
 * launch qualification. The original source owns every profile/material operand. */
export async function prepareGatewayLaunchAllocationV2(
  source: GatewayLaunchResourceSourceV2,
  event: GatewayStartupMutationEventV2,
  reference: Reference,
  unit: GatewayStartupSelectionUnitV2,
  io: GatewayStartupAcceptedOperationV1,
  assertOriginal: () => void,
): Promise<GatewayLaunchResourceAllocationV2> {
  assertOriginal();
  if (event.kind !== "accept-startup" || !event.acceptance) throw unavailable();
  const lease = await source.prepareLocked(event, reference, unit, io);
  const releaseOriginal = lease.release.bind(lease);
  const pending = new Set<Promise<unknown>>();
  let released = false;
  let failed = false;
  let close: Promise<void> | undefined;
  const release = () =>
    (close ??= Promise.resolve().then(async () => {
      released = true;
      while (pending.size > 0) await Promise.allSettled([...pending]);
      await releaseOriginal();
    }));
  let retained = false;
  try {
    unit.phase.retainCleanup(release);
    retained = true;
    const sourceSignal = lease.signal;
    const assertion = lease.assertCurrent.bind(lease);
    if (!(sourceSignal instanceof AbortSignal)) throw unavailable();
    const assertCurrent = (): undefined => {
      if (released || failed || sourceSignal.aborted) throw unavailable();
      try {
        const result: unknown = assertion();
        if (result !== undefined) {
          const work = Promise.resolve(result);
          pending.add(work);
          void work.then(
            () => pending.delete(work),
            () => pending.delete(work),
          );
          throw unavailable();
        }
        if (released || sourceSignal.aborted) throw unavailable();
      } catch {
        failed = true;
        throw unavailable();
      }
      return undefined;
    };
    unit.phase.retainCurrentness(assertCurrent);
    assertOriginal();
    assertCurrent();
    const processTarget = immutableCopy(lease.processTarget);
    const configMapName = lease.configMapName;
    const canonicalDocument = lease.canonicalDocument;
    if (
      !processTarget ||
      Object.keys(processTarget).sort().join() !== "clusterRef,deploymentName,namespace" ||
      typeof processTarget.clusterRef !== "string" ||
      !processTarget.clusterRef ||
      typeof processTarget.deploymentName !== "string" ||
      !/^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/.test(processTarget.deploymentName) ||
      !processTarget.namespace ||
      Object.values(processTarget.namespace).some((value) => typeof value !== "string" || !value) ||
      Object.keys(processTarget.namespace).sort().join() !== "name,resourceVersion,uid" ||
      typeof configMapName !== "string" ||
      !/^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/.test(configMapName) ||
      typeof canonicalDocument !== "string" ||
      Buffer.byteLength(canonicalDocument, "utf8") < 1 ||
      Buffer.byteLength(canonicalDocument, "utf8") > gatewayLaunchMaxBytes ||
      // UTF-8 replaces lone UTF-16 surrogates. Exact bounded round-trip equality
      // rejects those inputs using the configured Node/TypeScript library.
      Buffer.from(canonicalDocument, "utf8").toString("utf8") !== canonicalDocument
    )
      throw unavailable();
    const document: unknown = JSON.parse(canonicalDocument);
    if (
      document === null ||
      typeof document !== "object" ||
      Array.isArray(document) ||
      Object.keys(document).sort().join() !==
        "address,association,binding,configurationVersion,consumeCommand,harness,profile,schemaVersion" ||
      !("schemaVersion" in document) ||
      document.schemaVersion !== 2 ||
      !("binding" in document) ||
      !("consumeCommand" in document) ||
      canonicalGatewayStartupValueV1(document) !== canonicalDocument ||
      !isDeepStrictEqual(parseGatewayStartupBindingV2(document.binding), event.acceptance.binding)
    )
      throw unavailable();
    const command = parseGatewayStartupCommandV2(document.consumeCommand);
    if (
      command.kind !== "consume-startup" ||
      !isDeepStrictEqual(command.startup, event.startup) ||
      !isDeepStrictEqual(command.subject, unit.subject) ||
      command.expectedHead.version !== event.afterHeadVersion + 1 ||
      command.expectedHead.recordVersion !== event.afterRecordVersion + 1 ||
      !isDeepStrictEqual(command.expectedHead.startup, event.startup)
    )
      throw unavailable();
    const allocation = immutableCopy({
      ...reference,
      original: {
        binding: event.acceptance.binding,
        target: processTarget,
        launchPlan: { recordRef: reference.recordRef, recordVersion: reference.recordVersion },
      },
      target: {
        clusterRef: processTarget.clusterRef,
        namespace: processTarget.namespace,
        configMapName,
      },
      canonicalDocument,
      documentDigest: `sha256:${createHash("sha256").update(canonicalDocument, "utf8").digest("hex")}`,
    });
    assertCurrent();
    assertOriginal();
    return allocation;
  } catch (error) {
    unit.phase.poison(error);
    if (!retained) await release();
    throw error;
  }
}
