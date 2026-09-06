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
  slack: Parameters<typeof createSlackGatewayModule>[0];
  teams: Parameters<typeof createTeamsGatewayModule>[0];
}>;

/** Exact public factories loaded by trusted code, never selected from startup JSON. */
export type GatewayCompositionFactories = Readonly<{
  host: typeof startGatewayHostV1;
  slack: typeof createSlackHostedAdapterV1;
  teams: typeof createMSTeamsHostedIngress;
}>;

export type GatewayComposition = Readonly<{
  slack: SlackGatewayModule["native"];
  start(): ReturnType<typeof startGatewayHostV1>;
}>;

/** Prepare the fixed two-channel composition without starting either transport. */
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

  const slack = createSlackGatewayModule(input.slack, factories.slack);
  const teams = createTeamsGatewayModule(input.teams, factories.teams);
  const available = [...external, slack.module, teams];
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
  return Object.freeze({
    /** Retain only these existing native ports when wiring the genuine Slack receiver. */
    slack: slack.native,
    start() {
      if (started) throw unavailable();
      started = true;
      return startHost(configuration, { ...policies, modules });
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
