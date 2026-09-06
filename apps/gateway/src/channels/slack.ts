import type { GatewayHostModuleV1 } from "openclaw/plugin-sdk/gateway-host";
import type {
  createSlackHostedAdapterV1,
  SlackHostedAdapterOptionsV1,
  SlackHostedAdapterV1,
  SlackHostedAdmissionV1,
} from "openclaw/plugin-sdk/slack-hosted";

type StartContext = Parameters<GatewayHostModuleV1["start"]>[0];
type Health = Parameters<NonNullable<SlackHostedAdapterOptionsV1["onHealth"]>>[0];
type NativePorts = Pick<SlackHostedAdapterV1, "inspect" | "inspectNonTurn" | "deliver" | "update">;

export type SlackGatewayModule = Readonly<{
  module: GatewayHostModuleV1;
  /** Existing native ports for the trusted receiver; these confer no authority. */
  native: NativePorts;
}>;

/** Own one native adapter lifetime. Only trusted composition supplies these inputs. */
export function createSlackGatewayModule(
  input: Readonly<{
    id: string;
    options: SlackHostedAdapterOptionsV1;
    receiver: SlackHostedAdmissionV1;
  }>,
  createAdapter: typeof createSlackHostedAdapterV1,
): SlackGatewayModule {
  const { id, receiver } = input;
  const options = { ...input.options, profile: structuredClone(input.options.profile) };
  const current = options.assertCurrent;
  const report = options.onHealth;
  const lifetime = new AbortController();
  let phase: "new" | "starting" | "ready" | "closed" = "new";
  let context: StartContext | undefined;
  let adapter: SlackHostedAdapterV1 | undefined;
  let run: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let terminal: "stopped" | "retired" | undefined;
  let notificationFailed = false;
  let settleReceipts: (() => void) | undefined;
  let receipts: Promise<void> | undefined;
  let resolveReady: ((value: { capabilities: readonly string[] }) => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const unavailable = () => new Error("Hosted Slack module unavailable");

  function assertCurrent(): void {
    lifetime.signal.throwIfAborted();
    if (!context || (phase !== "starting" && phase !== "ready")) throw unavailable();
    context.signal.throwIfAborted();
    context.assertCurrent();
    current();
    lifetime.signal.throwIfAborted();
    context.signal.throwIfAborted();
    context.assertCurrent();
  }

  function loseReadiness(): void {
    rejectReady?.(unavailable());
    if (phase !== "closed") {
      lifetime.abort();
      try {
        context?.unavailable();
      } catch {
        notificationFailed = true;
      }
    }
  }

  function health(value: Health): void {
    if (value.state === "stopped") {
      terminal = "stopped";
      settleReceipts?.();
    } else if (value.state === "retired") {
      terminal = "retired";
      receipts ??= new Promise<void>((resolve) => {
        settleReceipts = resolve;
      });
    }
    if (value.state === "connected" && phase === "starting") {
      try {
        assertCurrent();
        phase = "ready";
        resolveReady?.({ capabilities: ["slack.hosted-transport"] });
      } catch {
        loseReadiness();
      }
    } else if (
      (value.state === "recovering" && phase === "ready") ||
      value.state === "stopped" ||
      value.state === "retired"
    ) {
      // A host module cannot restore readiness after generation readiness is lost.
      loseReadiness();
    }
    try {
      report?.(value);
    } catch {
      // Diagnostic consumers do not control native ownership or admission.
    }
  }

  const module: GatewayHostModuleV1 = {
    id,
    kind: "channel",
    profileRef: "slack-private-mentioned-v1",
    async start(next) {
      if (phase !== "new") throw unavailable();
      phase = "starting";
      context = next;
      const abort = () => {
        lifetime.abort();
        rejectReady?.(unavailable());
      };
      next.signal.addEventListener("abort", abort, { once: true });
      const ready = new Promise<{ capabilities: readonly string[] }>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      // Attach before factory/run work can synchronously reject readiness.
      void ready.catch(() => {});
      try {
        assertCurrent();
        if (
          options.profile.adapterProfileRef !== module.profileRef ||
          options.profile.installationRef !== next.configuration.installationRef
        )
          throw unavailable();
        adapter = createAdapter({ ...options, assertCurrent, onHealth: health });
        // Even an already-aborted run owns cleanup of the constructed adapter.
        run = Promise.resolve(adapter.run(receiver, lifetime.signal));
        void run.then(
          () => loseReadiness(),
          () => loseReadiness(),
        );
        const result = await ready;
        assertCurrent();
        return result;
      } catch {
        lifetime.abort();
        rejectReady?.(unavailable());
        throw unavailable();
      } finally {
        // The lifetime listener remains owned until close, including after readiness.
        if (!adapter) next.signal.removeEventListener("abort", abort);
        else
          void run?.finally(() => next.signal.removeEventListener("abort", abort)).catch(() => {});
      }
    },
    close() {
      phase = "closed";
      lifetime.abort();
      rejectReady?.(unavailable());
      closing ??= Promise.resolve().then(async () => {
        // A retired run may have returned while original host receipts remain pending.
        await run;
        if (adapter && terminal === undefined) throw unavailable();
        if (terminal === "retired") await receipts;
        if (notificationFailed) throw unavailable();
      });
      return closing;
    },
  };

  function activeAdapter(): SlackHostedAdapterV1 {
    try {
      assertCurrent();
      if (!adapter) throw unavailable();
      return adapter;
    } catch {
      throw unavailable();
    }
  }
  const native: NativePorts = {
    inspect: (value, signal) => activeAdapter().inspect(value, signal),
    inspectNonTurn: (value, signal) => activeAdapter().inspectNonTurn(value, signal),
    deliver: (turn, output, signal) => activeAdapter().deliver(turn, output, signal),
    update: (turn, output, signal) => activeAdapter().update(turn, output, signal),
  };
  return Object.freeze({ module: Object.freeze(module), native: Object.freeze(native) });
}
