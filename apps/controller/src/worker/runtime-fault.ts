import type { PostgresWorkQueue, PlatformReadView } from "@openclaw-enterprise/occ";
import type { ExactRuntimeFaultOperationV1 } from "@openclaw-enterprise/contracts";
import { isDeepStrictEqual } from "node:util";

interface Options {
  queue: Pick<PostgresWorkQueue, "claimRuntimeFault" | "deferRuntimeFault" | "recoverRuntimeFault">;
  findFault(
    operation: ExactRuntimeFaultOperationV1,
  ): ReturnType<NonNullable<PlatformReadView["runtimeEffectAdmission"]>["findFaultRequest"]>;
  emit(event: Readonly<Record<string, unknown>>): void;
}

/** The original worker recognizes fault cleanup separately from running work.
 * This dispatcher retains pending responsibility until the genuine protected
 * provider fence/stop owner is installed. It never invokes legacy prepare/repair. */
export class RuntimeFaultWorker {
  private readonly options: Options;
  constructor(options: Options) {
    this.options = options;
  }

  async runOne(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    await this.options.queue.recoverRuntimeFault();
    if (signal.aborted) return false;
    const claimed = await this.options.queue.claimRuntimeFault();
    if (claimed === undefined) return false;
    try {
      const work = claimed.work;
      const retained = await this.options.findFault({
        schemaVersion: 1,
        operationKind: "fault-and-fence",
        operationRef: work.operationRef,
        requestDigest: work.requestDigest,
        scope: {
          installationId: work.installationId,
          namespaceId: work.namespaceId,
          agentId: work.agentId,
        },
      });
      if (retained === undefined || !isDeepStrictEqual(retained.work, work))
        throw new Error("The original runtime fault work association is unavailable.");
      // TODO(runtime fault execution): connect authenticated exact responsibility
      // readback and the selected provider sealer before accepting stop effects.
      // A queue claim or an earlier fault DTO cannot supply the missing authority.
      this.options.emit({ event: "worker.runtime-fault", code: "PROVIDER_FENCE_UNAVAILABLE" });
    } finally {
      await this.options.queue.deferRuntimeFault(claimed.claim);
    }
    return true;
  }
}
