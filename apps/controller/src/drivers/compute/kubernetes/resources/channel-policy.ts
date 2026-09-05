import { isIP } from "node:net";
import { asRecord, sha256Hex } from "@openclaw-enterprise/utils";
import type { AgentRevision } from "@openclaw-enterprise/contracts";
import {
  manifest,
  required,
  ConfigurationFailure,
  AGENT_TRANSPORT_PORT,
  type DesiredKubernetesObject,
  type DesiredNetworkPolicySpec,
} from "./identity.ts";
export type ChannelRevision = Pick<
  AgentRevision,
  "id" | "namespaceId" | "agentId" | "servicePrincipalId" | "configuration" | "harness"
>;

export const CHANNEL_REQUIREMENTS = {
  slack: {
    secrets: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"],
    egress: "https-proxy",
  },
  msteams: {
    secrets: ["MSTEAMS_APP_PASSWORD"],
    egress: "https-proxy",
  },
} as const;

export type ChannelRequirements = (typeof CHANNEL_REQUIREMENTS)[keyof typeof CHANNEL_REQUIREMENTS];

export function channelProxy(value: unknown): { address: string; port: number } {
  const raw = required(value, "Channel proxy URL");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigurationFailure(
      "Channel proxy URL must identify one exact HTTP(S) IP endpoint.",
    );
  }
  const address = parsed.hostname.replace(/^\[|\]$/g, "");
  let port = parsed.port;
  if (!port) {
    // URL removes explicit default ports; recover only an exact literal-IP endpoint.
    const endpoint = /^https?:\/\/(\[[^\]]+\]|[^:/?#\\]+):([0-9]+)\/?$/i.exec(raw);
    if (endpoint && endpoint[0] === raw && isIP(endpoint[1]!.replace(/^\[|\]$/g, "")) !== 0) {
      port = endpoint[2]!;
    }
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    isIP(address) === 0 ||
    !port ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ConfigurationFailure(
      "Channel proxy URL must identify one credential-free HTTP(S) IP endpoint.",
    );
  }
  return { address, port: Number(port) };
}

export function enabledChannels(
  channelsConfigured: boolean,
  revision: Pick<ChannelRevision, "configuration" | "harness">,
): readonly ChannelRequirements[] {
  const configured = asRecord(asRecord(revision.configuration)?.channels);
  if (configured === undefined) return [];
  const enabled: ChannelRequirements[] = [];
  for (const [provider, configuration] of Object.entries(configured)) {
    if (["defaults", "modelByChannel"].includes(provider)) continue;
    if (asRecord(configuration)?.enabled === false) continue;
    if (!Object.hasOwn(CHANNEL_REQUIREMENTS, provider)) {
      throw new ConfigurationFailure(`Unsupported OpenClaw channel provider "${provider}".`);
    }
    enabled.push(CHANNEL_REQUIREMENTS[provider as keyof typeof CHANNEL_REQUIREMENTS]);
  }
  if (enabled.length === 0) return enabled;
  if (revision.harness.mode === "embedded") {
    throw new ConfigurationFailure("Configured channels require a dedicated Agent workload.");
  }
  if (!channelsConfigured) {
    throw new ConfigurationFailure(
      "Enabled channel configuration requires isolated credentials and a reviewed proxy.",
    );
  }
  return enabled;
}

export function channelNetworkPolicy(
  proxyUrl: string | undefined,
  revision: Pick<ChannelRevision, "namespaceId" | "agentId">,
  enabled: readonly ChannelRequirements[],
  namespace: string,
): DesiredKubernetesObject<"NetworkPolicy"> {
  const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
  const proxy = enabled.some(({ egress }) => egress === "https-proxy")
    ? channelProxy(proxyUrl)
    : undefined;
  return {
    ...manifest(
      "networking.k8s.io/v1",
      "NetworkPolicy",
      `allow-gateway-channels-${sha256Hex(revision.agentId, 12)}`,
      ownership,
      namespace,
    ),
    spec: {
      podSelector: {
        matchLabels: {
          "openclaw.dev/workload-role": "gateway",
          "openclaw.dev/agent": revision.agentId,
        },
      },
      policyTypes: ["Egress"],
      egress:
        proxy !== undefined
          ? [
              {
                to: [
                  {
                    ipBlock: { cidr: `${proxy.address}/${isIP(proxy.address) === 4 ? 32 : 128}` },
                  },
                ],
                ports: [{ protocol: "TCP", port: proxy.port }],
              },
            ]
          : [],
    },
  };
}

export function agentNetworkPolicies(
  runtimeEnabled: boolean,
  revision: Pick<ChannelRevision, "id" | "namespaceId" | "agentId" | "harness">,
  namespace: string,
): DesiredKubernetesObject<"NetworkPolicy">[] {
  if (!runtimeEnabled) return [];
  const suffix = sha256Hex(revision.agentId, 12);
  const ownership = { namespaceId: revision.namespaceId, agentId: revision.agentId };
  const agent = {
    matchLabels: {
      "openclaw.dev/workload-role": "agent",
      "openclaw.dev/agent": revision.agentId,
      "openclaw.dev/revision": revision.id,
    },
  };
  const gateway = {
    matchLabels: {
      "openclaw.dev/workload-role": "gateway",
      "openclaw.dev/agent": revision.agentId,
    },
  };
  const policy = (
    name: string,
    spec: DesiredNetworkPolicySpec,
  ): DesiredKubernetesObject<"NetworkPolicy"> => ({
    ...manifest("networking.k8s.io/v1", "NetworkPolicy", `${name}-${suffix}`, ownership, namespace),
    spec,
  });
  // TODO(model-egress-proxy): Replace public TCP/443 with the approved per-Agent model proxy.
  const modelEgress = [
    {
      to: [
        {
          ipBlock: {
            cidr: "0.0.0.0/0",
            except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"],
          },
        },
      ],
      ports: [{ protocol: "TCP", port: 443 }],
    },
  ];
  if (revision.harness.mode === "embedded") {
    return [
      policy("allow-agent-runtime", {
        podSelector: gateway,
        policyTypes: ["Egress"],
        egress: modelEgress,
      }),
    ];
  }
  const transport = [{ protocol: "TCP", port: AGENT_TRANSPORT_PORT }];
  return [
    policy("allow-gateway-agent", {
      podSelector: gateway,
      policyTypes: ["Egress"],
      egress: [{ to: [{ podSelector: agent }], ports: transport }],
    }),
    policy("allow-agent-runtime", {
      podSelector: agent,
      policyTypes: ["Ingress", "Egress"],
      ingress: [{ from: [{ podSelector: gateway }], ports: transport }],
      egress: modelEgress,
    }),
  ];
}

export function agentAuthenticationNetworkPolicy(
  runtimeEnabled: boolean,
  revision: ChannelRevision,
  namespace: string,
): DesiredKubernetesObject<"NetworkPolicy"> {
  const runtime = agentNetworkPolicies(runtimeEnabled, revision, namespace).find(
    ({ metadata }) => metadata.name === `allow-agent-runtime-${sha256Hex(revision.agentId, 12)}`,
  );
  const egress = runtime?.spec?.egress;
  if (!Array.isArray(egress) || egress.length === 0) {
    throw new ConfigurationFailure(
      "Agent authentication requires an approved model egress policy.",
    );
  }
  const ownership = {
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    servicePrincipalId: revision.servicePrincipalId,
  };
  return {
    ...manifest(
      "networking.k8s.io/v1",
      "NetworkPolicy",
      `allow-agent-auth-${sha256Hex(revision.agentId, 12)}`,
      ownership,
      namespace,
    ),
    spec: {
      podSelector: {
        matchLabels: {
          "openclaw.dev/workload-role": "agent",
          "openclaw.dev/agent": revision.agentId,
          "openclaw.dev/revision": revision.id,
        },
      },
      policyTypes: ["Egress"],
      egress,
    },
  };
}
