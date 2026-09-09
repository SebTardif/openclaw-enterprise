import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentRevision,
  AuthorizationDecision,
  AuthorizationRequest,
  ComputeRevisionContext,
  NamespaceDeleteResult,
  NamespaceEnsureResult,
} from "@openclaw-enterprise/contracts";
import { WorkClaimLostError, type PostgresWorkQueue } from "@openclaw-enterprise/occ";
import type { WorkerClaimContext } from "./leased-effect.ts";

export type Observation = NamespaceEnsureResult | NamespaceDeleteResult;
export type Outcome = "success" | "pending" | "retry" | "permanent";

export interface DispatchResult {
  readonly outcome: Outcome;
  readonly code: string;
  readonly observation?: Observation;
  readonly decision?: AuthorizationDecision;
  readonly authorization?: AuthorizationRequest;
}

export interface RevisionDispatchResult extends DispatchResult {
  readonly revision?: Readonly<AgentRevision>;
  readonly previous?: Readonly<AgentRevision>;
  readonly supersededBy?: Readonly<AgentRevision>;
  readonly expectedActiveRevisionId?: string;
  readonly context?: ComputeRevisionContext;
}

export interface WorkerRunnerOptions {
  readonly runtimeProfiles?: { runOne(signal: AbortSignal): Promise<boolean> };
  readonly runtimeFaults?: { runOne(signal: AbortSignal): Promise<boolean> };
  readonly queue: Pick<PostgresWorkQueue, "recoverStale" | "claim" | "pending">;
  readonly signal: AbortSignal;
  readonly stopping: () => boolean;
  readonly pollIntervalMs: number;
  readonly dispatch: (context: WorkerClaimContext) => Promise<void>;
  readonly emit: (event: Readonly<Record<string, unknown>>) => void;
  readonly onHealthy?: () => Promise<void>;
}

/** Polls and dispatches claims; completion remains with the single finalizer. */
export class WorkerRunner {
  private readonly options: WorkerRunnerOptions;
  private lastHealthAt = 0;

  constructor(options: WorkerRunnerOptions) {
    this.options = options;
  }

  async run(): Promise<void> {
    const options = this.options;
    while (!options.stopping()) {
      try {
        if (await options.runtimeProfiles?.runOne(options.signal)) {
          await this.health(true);
          continue;
        }
        if (await options.runtimeFaults?.runOne(options.signal)) {
          await this.health(true);
          continue;
        }
        await options.queue.recoverStale();
        const claim = await options.queue.claim();
        if (claim !== undefined) {
          await options.dispatch(Object.freeze({ claim, signal: options.signal }));
          await this.health(true);
          continue;
        }
        await this.health(false);
      } catch (error) {
        options.emit({
          event: "worker.error",
          code: error instanceof WorkClaimLostError ? "CLAIM_LOST" : "WORKER_UNAVAILABLE",
        });
      }
      try {
        await delay(options.pollIntervalMs, undefined, { signal: options.signal });
      } catch (error) {
        if (!options.stopping()) throw error;
      }
    }
  }

  async health(force: boolean): Promise<void> {
    const options = this.options;
    const now = Date.now();
    if (!force && now - this.lastHealthAt < Math.max(1_000, options.pollIntervalMs * 20)) return;
    const pending = await options.queue.pending();
    await options.onHealthy?.();
    this.lastHealthAt = now;
    options.emit({ event: "worker.health", status: "ready", pending });
  }
}
