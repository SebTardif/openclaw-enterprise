import type { PostgresWorkQueue, PlatformReadView } from "@openclaw-enterprise/occ";
import type { RuntimeAuthorityScopeV1 } from "@openclaw-enterprise/contracts";
import { isDeepStrictEqual } from "node:util";

interface Options {
  queue: Pick<
    PostgresWorkQueue,
    "claimRuntimeProfile" | "deferRuntimeProfile" | "recoverRuntimeProfile"
  >;
  findProfile(
    scope: RuntimeAuthorityScopeV1,
    invalidationRef: string,
  ): ReturnType<NonNullable<PlatformReadView["runtimeEffectAdmission"]>["findProfileClosure"]>;
  emit(event: Readonly<Record<string, unknown>>): void;
}

/** The original worker recognizes profile cleanup separately from running work.
 * This dispatcher retains pending responsibility until the genuine protected
 * provider fence/stop owner is installed. It never invokes legacy prepare/repair. */
export class RuntimeProfileWorker {
  private readonly options: Options;
  constructor(options: Options) {
    this.options = options;
  }

  async runOne(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    await this.options.queue.recoverRuntimeProfile();
    if (signal.aborted) return false;
    const claimed = await this.options.queue.claimRuntimeProfile();
    if (claimed === undefined) return false;
    try {
      const work = claimed.work;
      const retained = await this.options.findProfile(
        {
          installationId: work.installationId,
          namespaceId: work.namespaceId,
          agentId: work.agentId,
        },
        work.invalidationRef,
      );
      if (retained === undefined || !isDeepStrictEqual(retained.work, work))
        throw new Error("The original runtime profile work association is unavailable.");
      // TODO(runtime profile execution): connect authenticated exact responsibility
      // readback and the selected provider sealer before accepting stop effects.
      // A queue claim or an earlier profile record cannot supply the missing authority.
      this.options.emit({ event: "worker.runtime-profile", code: "PROVIDER_FENCE_UNAVAILABLE" });
    } finally {
      await this.options.queue.deferRuntimeProfile(claimed.claim);
    }
    return true;
  }
}
