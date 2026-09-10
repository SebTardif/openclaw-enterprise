import type { PostgresWorkQueue, PlatformReadView } from "@openclaw-enterprise/occ";
import type { RuntimeAuthorityScopeV1 } from "@openclaw-enterprise/contracts";
import { isDeepStrictEqual } from "node:util";
import type { RuntimeCleanupWorker } from "./cleanup.ts";

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
  readonly cleanup?: Pick<RuntimeCleanupWorker, "run">;
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
      // Only the original installed cleanup owner can supply the independently
      // authenticated call and retained effect. A saved closure is not authority.
      const observation = await this.options.cleanup?.run({
        kind: "profile",
        claimed,
        retained,
        signal,
      });
      this.options.emit({
        event: "worker.runtime-profile",
        code:
          observation === undefined
            ? "PROVIDER_FENCE_UNAVAILABLE"
            : observation.kind === "observed"
              ? "CLEANUP_EFFECT_OBSERVED"
              : observation.kind === "unresolved"
                ? "CLEANUP_OUTCOME_UNKNOWN"
                : "CLEANUP_EFFECT_BLOCKED",
      });
    } finally {
      // Individual effect/readback is not complete physical child/task/drain
      // settlement or the missing original guarded responsibility finalizer.
      await this.options.queue.deferRuntimeProfile(claimed.claim);
    }
    return true;
  }
}
