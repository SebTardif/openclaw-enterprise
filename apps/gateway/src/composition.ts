import type { GatewayStartupCloseV1 } from "@openclaw-enterprise/contracts/gateway-startup-v1";
import type {
  GatewayHostConfigurationV1,
  GatewayHostDependenciesV1,
  GatewayHostModuleV1,
  startGatewayHostV1,
} from "openclaw/plugin-sdk/gateway-host";
import type { createMSTeamsHostedIngress } from "openclaw/plugin-sdk/msteams-hosted";
import type { createSlackHostedAdapterV1 } from "openclaw/plugin-sdk/slack-hosted";
import { createSlackGatewayModule, type SlackGatewayModule } from "./channels/slack.ts";
import { createTeamsGatewayModule } from "./channels/teams.ts";

export type GatewayCompositionInput = Readonly<{
  configuration: GatewayHostConfigurationV1;
  /** Genuine identity, Harness and persistence owners, with the existing policy ports. */
  dependencies: GatewayHostDependenciesV1;
  /** Explicit null means that the accepted module selection has no such channel. */
  slack: Parameters<typeof createSlackGatewayModule>[0] | null;
  teams: Parameters<typeof createTeamsGatewayModule>[0] | null;
}>;

/** Exact public factories loaded by trusted code, never selected from startup JSON. */
export type GatewayCompositionFactories = Readonly<{
  host: typeof startGatewayHostV1;
  slack: typeof createSlackHostedAdapterV1;
  teams: typeof createMSTeamsHostedIngress;
}>;

export type GatewayCompositionClose = Readonly<{ cleanup: GatewayStartupCloseV1["cleanup"] }>;

export type GatewayComposition = Readonly<{
  close(): Promise<GatewayCompositionClose>;
  slack: SlackGatewayModule["native"] | null;
  start(): ReturnType<typeof startGatewayHostV1>;
}>;

/** Prepare only the explicitly selected fixed channels, without starting transport. */
export function createGatewayComposition(
  input: GatewayCompositionInput,
  factories: GatewayCompositionFactories,
): GatewayComposition {
  const configuration = structuredClone(input.configuration);
  const startHost = factories.host;
  const policies = {
    authorizeOperation: input.dependencies.authorizeOperation,
    consumeAttempt: input.dependencies.consumeAttempt,
    reauthorizeOutput: input.dependencies.reauthorizeOutput,
  };
  const unavailable = () => new Error("Hosted gateway composition unavailable");
  if (
    typeof factories.host !== "function" ||
    typeof factories.slack !== "function" ||
    typeof factories.teams !== "function" ||
    Object.values(policies).some((policy) => typeof policy !== "function")
  )
    throw unavailable();

  // Required owners are supplied as real modules. This is correspondence checking,
  // not proof that a module's policy or production implementation is available.
  const external = [...input.dependencies.modules];
  if (
    external.length !== 3 ||
    ["identity", "harness", "persistence"].some(
      (kind) => external.filter((module) => module.kind === kind).length !== 1,
    ) ||
    external.some(
      (module) => typeof module.start !== "function" || typeof module.close !== "function",
    )
  )
    throw unavailable();

  if (input.slack === undefined || input.teams === undefined) throw unavailable();
  const slack =
    input.slack === null ? null : createSlackGatewayModule(input.slack, factories.slack);
  const teams =
    input.teams === null ? null : createTeamsGatewayModule(input.teams, factories.teams);
  const available = [
    ...external,
    ...(slack === null ? [] : [slack.module]),
    ...(teams === null ? [] : [teams]),
  ];
  if (
    configuration.modules.length !== available.length ||
    new Set(available.map((module) => module.id)).size !== available.length ||
    new Set(configuration.modules.map((module) => module.id)).size !== available.length
  )
    throw unavailable();
  const modules: GatewayHostModuleV1[] = configuration.modules.map((selection) => {
    const module = available.find((candidate) => candidate.id === selection.id);
    if (!module || module.kind !== selection.kind || module.profileRef !== selection.profileRef) {
      throw unavailable();
    }
    return module;
  });
  let started = false;
  let closed = false;
  let host: ReturnType<typeof startGatewayHostV1> | undefined;
  let closePromise: Promise<GatewayCompositionClose> | undefined;
  return Object.freeze({
    /** Retain only these existing native ports when wiring the genuine Slack receiver. */
    slack: slack?.native ?? null,
    start() {
      if (started || closed) throw unavailable();
      started = true;
      host = startHost(configuration, { ...policies, modules });
      return host;
    },
    close() {
      closed = true;
      // Publish the one close join before calling an owner that could reenter it.
      closePromise ??= Promise.resolve().then(async (): Promise<GatewayCompositionClose> => {
        if (host) {
          // Once returned, the actual host owns its module cleanup. Runtime also
          // retains this same host and quiesces it before waiting for readiness.
          try {
            const result = await host.close();
            return {
              cleanup:
                result.cleanup === "finished" || result.cleanup === "failed"
                  ? result.cleanup
                  : "unknown",
            };
          } catch {
            return { cleanup: "failed" };
          }
        }
        // No host took ownership, including a synchronous start failure. Invoke
        // every constructed module's original close and join all late settlement.
        const results = await Promise.allSettled(modules.map(async (module) => module.close()));
        return {
          cleanup: results.every((result) => result.status === "fulfilled") ? "finished" : "failed",
        };
      });
      return closePromise;
    },
  });
}

/** Fixed public package entrypoints; loading these exports does not admit startup. */
export async function loadGatewayCompositionFactories(): Promise<GatewayCompositionFactories> {
  const [host, slack, teams] = await Promise.all([
    import("openclaw/plugin-sdk/gateway-host"),
    import("openclaw/plugin-sdk/slack-hosted"),
    import("openclaw/plugin-sdk/msteams-hosted"),
  ]);
  return Object.freeze({
    host: host.startGatewayHostV1,
    slack: slack.createSlackHostedAdapterV1,
    teams: teams.createMSTeamsHostedIngress,
  });
}

/**
 * Fixed preparation adapter captured once by the protected startup owner.
 * Preparation starts no transport; the owner retains the synchronous host returned
 * by start() before awaiting readiness and joins that host on revocation.
 */
export async function prepareGatewayComposition(
  input: GatewayCompositionInput,
): Promise<GatewayComposition> {
  const factories = await loadGatewayCompositionFactories();
  return createGatewayComposition(input, factories);
}
