import type { GatewayHostModuleV1 } from "openclaw/plugin-sdk/gateway-host";
import type {
  createMSTeamsHostedIngress,
  MSTeamsHostedIngressOptions,
} from "openclaw/plugin-sdk/msteams-hosted";

export type TeamsGatewayModuleInput = Readonly<{
  id: GatewayHostModuleV1["id"];
  ingress: MSTeamsHostedIngressOptions;
  listener: Readonly<{ port: number; host: string }>;
}>;

type NativeIngress = Awaited<ReturnType<typeof createMSTeamsHostedIngress>>;
type NativeListener = Awaited<ReturnType<NativeIngress["listen"]>>;
type StartContext = Parameters<GatewayHostModuleV1["start"]>[0];

const profileRef = "teams-standard-mentioned-v1";

function unavailableError(): Error {
  return new Error("DEPENDENCY_UNAVAILABLE");
}

/** Owns local listener readiness and cleanup, never process termination or turn authority. */
export function createTeamsGatewayModule(
  input: TeamsGatewayModuleInput,
  createIngress: typeof createMSTeamsHostedIngress,
): GatewayHostModuleV1 {
  const id = input.id;
  const address = { ...input.listener };
  const supplied = {
    ...input.ingress,
    profile: { ...input.ingress.profile },
    authority: { ...input.ingress.authority },
    admission: { ...input.ingress.admission },
  };
  const lifetime = new AbortController();
  let context: StartContext | undefined;
  let started = false;
  let stopped = false;
  let cleanupFailed = false;
  let ingress: NativeIngress | undefined;
  let listener: NativeListener | undefined;
  let construction: Promise<NativeIngress> | undefined;
  let listening: Promise<NativeListener> | undefined;
  let nativeClosing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;

  const assertCurrent = () => {
    if (stopped || !context || context.signal.aborted) {
      throw unavailableError();
    }
    context.assertCurrent();
    if (stopped || context.signal.aborted) {
      throw unavailableError();
    }
  };

  const requestClose = () => {
    // Preserve the rejected cleanup promise for the host's close join.
    void close().catch(() => {});
  };
  const loseReadiness = () => {
    if (stopped) {
      return;
    }
    try {
      context?.unavailable();
    } catch {
      cleanupFailed = true;
    }
    requestClose();
  };

  const closeNative = () => {
    if (ingress && !nativeClosing) {
      const acquired = ingress;
      nativeClosing = Promise.resolve()
        .then(() => acquired.close())
        .catch(() => {
          cleanupFailed = true;
        });
    }
  };

  function close(): Promise<void> {
    if (closing) {
      return closing;
    }
    let resolveClose!: () => void;
    let rejectClose!: (error: Error) => void;
    closing = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    // Publish the single join before cancellation can synchronously reenter close.
    stopped = true;
    lifetime.abort();
    context?.signal.removeEventListener("abort", requestClose);
    closeNative();
    void (async () => {
      await construction?.catch(() => undefined);
      closeNative();
      await listening?.catch(() => undefined);
      await nativeClosing;

      // Native close may finish before pending listen opens its server. Its memoized
      // promise cannot close that late server; this owner must join the returned handle.
      if (listener?.listening) {
        try {
          await new Promise<void>((resolve, reject) => {
            listener!.close((error) => {
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            });
          });
        } catch {
          cleanupFailed = true;
        }
      }
      listener?.removeListener("close", loseReadiness);
      listener?.removeListener("error", loseReadiness);
      if (cleanupFailed) {
        throw unavailableError();
      }
    })().then(resolveClose, () => rejectClose(unavailableError()));
    return closing;
  }

  return Object.freeze<GatewayHostModuleV1>({
    id,
    kind: "channel",
    profileRef,
    async start(startContext) {
      if (started || stopped) {
        throw unavailableError();
      }
      started = true;
      context = startContext;
      context.signal.addEventListener("abort", requestClose, { once: true });
      try {
        assertCurrent();
        if (
          supplied.profile.adapterProfileRef !== profileRef ||
          supplied.profile.installationRef !== context.configuration.installationRef
        ) {
          throw unavailableError();
        }
        // Assign ownership before invoking trusted code, which may synchronously cancel.
        construction = Promise.resolve()
          .then(() => {
            assertCurrent();
            return createIngress({
              ...supplied,
              authority: {
                ...supplied.authority,
                assertCurrent() {
                  assertCurrent();
                  supplied.authority.assertCurrent();
                  assertCurrent();
                },
              },
              admission: {
                ...supplied.admission,
                assertCurrent() {
                  assertCurrent();
                  supplied.admission.assertCurrent();
                  assertCurrent();
                },
              },
              async getBotToken(request, signal) {
                assertCurrent();
                const combined = AbortSignal.any([signal, lifetime.signal, startContext.signal]);
                combined.throwIfAborted();
                const token = await supplied.getBotToken(request, combined);
                combined.throwIfAborted();
                assertCurrent();
                return token;
              },
            });
          })
          .then((acquired) => {
            ingress = acquired;
            return acquired;
          });
        const acquired = await construction;
        assertCurrent();
        listening = Promise.resolve()
          .then(() => {
            assertCurrent();
            return acquired.listen(address.port, address.host);
          })
          .then((server) => {
            listener = server;
            return server;
          });
        const server = await listening;
        server.on("close", loseReadiness);
        server.on("error", loseReadiness);
        assertCurrent();
        if (!server.listening) {
          throw unavailableError();
        }
        return { capabilities: ["msteams.hosted-listener"] };
      } catch {
        // Startup must settle independently; close may already be joining its resources.
        requestClose();
        throw unavailableError();
      }
    },
    close,
  });
}
