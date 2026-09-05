import { admitLoggingConfiguration } from "../../../packages/contracts/src/index.ts";
import {
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../../apps/controller/src/drivers/compute/kubernetes/index.ts";

export function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const namespaceId = "ns_00000000-0000-4000-8000-000000000008";
const namespace = kubernetesNamespaceName(namespaceId);
const resources = {
  requests: { cpu: "100m", memory: "64Mi" },
  limits: { cpu: "250m", memory: "128Mi" },
};
const runtime = {
  transportSecretPrefix: "transport",
  modelSecretPrefix: "model",
  gatewayStorageClassName: "local-path",
};
const routing = {
  gatewayName: "oce-agent-gateways",
  gatewayNamespace: "openclaw-system",
  envoyNamespace: "envoy-gateway-system",
};
const trustedGateway = {
  trustedProxies: ["10.42.0.0/16"],
  allowRealIpFallback: true,
  auth: {
    mode: "trusted-proxy",
    trustedProxy: { userHeader: "x-occ-identity", allowUsers: ["occ-workspace-files"] },
    identityScopes: { "occ-workspace-files": ["operator.admin"] },
  },
};

export function scenarios() {
  return [
    { name: "fixture-embedded", embedded: true },
    {
      name: "runtime-dedicated-routed-channels",
      runtime: {
        ...runtime,
        channels: { secretPrefix: "channel", proxyUrl: "http://10.42.0.15:3128" },
      },
      routing,
      channels: { slack: {}, msteams: {}, discord: { enabled: false }, defaults: {} },
    },
    { name: "runtime-embedded-secret", runtime, embedded: true, boundSecret: true },
    {
      name: "runtime-dedicated-ipv6-proxy",
      runtime: {
        ...runtime,
        channels: { secretPrefix: "channel", proxyUrl: "https://[2001:db8::15]:8443" },
      },
      routing: { ...routing, hostname: "agents.example.internal" },
      channels: { msteams: {} },
    },
  ].map((scenario, index) => {
    const options = freeze({
      authentication: { mode: "inCluster" },
      images: { gateway: "gateway:local", agent: "agent:local", requireImmutableDigest: false },
      resources: {
        gateway: resources,
        agent: resources,
        namespace: { quota: { pods: "10" }, containerDefaults: resources },
      },
      network: {
        dns: { namespace: "kube-system", podLabels: { app: "dns" } },
        gatewayPort: 8080,
        ...(scenario.routing
          ? {}
          : { gatewayClients: [{ namespace: "controller", podLabels: { app: "controller" } }] }),
      },
      servicePrincipalCredentials: {
        mode: "projectedServiceAccountToken",
        audience: "openclaw-controller",
        expirationSeconds: 900,
      },
      ...(scenario.runtime ? { runtime: scenario.runtime } : {}),
      ...(scenario.routing ? { gatewayRouting: scenario.routing } : {}),
    });
    const driver = new KubernetesComputeDriver(options);
    const agentId = `agent-builders-${index + 1}`;
    const secretId = "sec_00000000-0000-4000-8000-000000000008";
    const revision = freeze({
      id: `revision-builders-${index + 1}`,
      namespaceId,
      agentId,
      revision: index + 1,
      configurationId: "cfg_00000000-0000-4000-8000-000000000008",
      configurationKind: "agent",
      configurationGeneration: index + 2,
      configuration: admitLoggingConfiguration(
        {
          ...(scenario.routing ? { gateway: trustedGateway } : {}),
          ...(scenario.channels ? { channels: scenario.channels } : {}),
          ...(scenario.boundSecret
            ? {
                secrets: { providers: { model: { source: "env", allowlist: ["OPENAI_API_KEY"] } } },
                models: {
                  providers: {
                    openai: { apiKey: { source: "env", provider: "model", id: "OPENAI_API_KEY" } },
                  },
                },
              }
            : {}),
        },
        "info",
      ),
      harness: {
        id: scenario.embedded ? "openclaw" : "codex",
        version: "1.0.0",
        mode: scenario.embedded ? "embedded" : "dedicated",
      },
      compute: { id: driver.id, implementation: driver.implementation },
      servicePrincipalId: `principal-builders-${index + 1}`,
      ...(scenario.boundSecret
        ? {
            secretDriverId: "secret-kubernetes",
            secretBindings: {
              OPENAI_API_KEY: { source: { kind: "secret", namespaceId, id: secretId } },
            },
          }
        : {}),
      createdAt: "2026-08-18T00:00:00.000Z",
    });
    const context = freeze({
      secretEnvironment: scenario.boundSecret
        ? [
            {
              name: "OPENAI_API_KEY",
              secretId,
              namespaceId,
              agentId,
              backendRef: {
                namespaceName: namespace,
                name: "stored-model-key",
                key: "value",
                uid: "observed-secret-uid",
              },
            },
          ]
        : [],
    });
    const ownership = freeze({ namespaceId, agentId });
    const agentOwnership = freeze({
      ...ownership,
      servicePrincipalId: revision.servicePrincipalId,
      revisionId: revision.id,
    });
    const environment = freeze({ OCE_SERVICE_PRINCIPAL_ID: revision.servicePrincipalId });
    return {
      name: scenario.name,
      driver,
      options,
      revision,
      namespace,
      ownership,
      agentOwnership,
      environment,
      context,
    };
  });
}

// Invoke the production Driver's real rendering methods; no client, cluster, or replacement builder.
export function render(scenario, builder = scenario.driver) {
  const { options, revision, namespace, ownership, agentOwnership, environment, context } =
    scenario;
  const configuration = freeze(builder.gatewayConfiguration(revision));
  const enabled = freeze(builder.enabledChannels(revision));
  const projected = builder.secretEnvironmentForRevision(revision, context, namespace);
  const gatewayService = freeze(
    builder.service(
      "gateway-builders",
      ownership,
      namespace,
      freeze({ "app.kubernetes.io/name": configuration.name }),
    ),
  );
  const result = {
    identity: builder.ownershipMetadata(agentOwnership),
    namespaceManifest: builder.manifest(
      "v1",
      "Namespace",
      namespace,
      freeze({ namespaceId: revision.namespaceId }),
    ),
    configuration,
    membership: builder.gatewayMembershipLabels(),
    policies: builder.networkPolicies(ownership, namespace),
    channelPolicy: builder.channelNetworkPolicy(revision, enabled, namespace),
    agentPolicies: builder.agentNetworkPolicies(revision, namespace),
    enabled,
    projected,
    gatewayService,
    gatewayDeployment: builder.deployment(
      configuration.name,
      ownership,
      namespace,
      options.images.gateway,
      "gateway-sa",
      "gateway",
      environment,
      configuration.loggingLevel,
      configuration,
      revision.harness.mode === "embedded",
      revision.harness.mode === "embedded" ? revision.servicePrincipalId : undefined,
      undefined,
      enabled,
      projected,
    ),
    workspace: builder.sharedWorkspaceClaim(revision.agentId, ownership, namespace),
    mounts: {
      gateway: builder.sharedWorkspaceVolumeMounts("gateway"),
      agent: builder.sharedWorkspaceVolumeMounts("agent"),
      embeddedPrivate: builder.gatewayPrivateStateVolumeMounts(true),
      dedicatedPrivate: builder.gatewayPrivateStateVolumeMounts(false),
    },
    directories: {
      gateway: builder.privateStateDirectories("gateway"),
      agent: builder.privateStateDirectories("agent"),
    },
  };
  if (options.runtime) {
    result.privateState = builder.gatewayPrivateStateClaim(revision.agentId, ownership, namespace);
    result.authenticationPolicy = builder.agentAuthenticationNetworkPolicy(revision, namespace);
  }
  if (options.gatewayRouting) {
    result.routeWithoutUid = builder.gatewayRoute(revision, ownership, namespace, gatewayService);
    result.routeWithUid = builder.gatewayRoute(
      revision,
      ownership,
      namespace,
      freeze({
        ...gatewayService,
        metadata: { ...gatewayService.metadata, uid: "observed-service-uid" },
      }),
    );
  }
  if (revision.harness.mode === "dedicated") {
    result.agentService = builder.service(
      "agent-builders",
      agentOwnership,
      namespace,
      freeze({ "app.kubernetes.io/name": "agent-builders" }),
    );
    result.agentDeployment = builder.deployment(
      "agent-builders",
      agentOwnership,
      namespace,
      options.images.agent,
      "agent-sa",
      "agent",
      environment,
      configuration.loggingLevel,
    );
  }
  return result;
}
