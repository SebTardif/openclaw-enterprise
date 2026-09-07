import type { CredentialWorkloadSelectionV1 } from "@openclaw-enterprise/contracts/credential-workload-selection-v1";

/** Synthetic nonsecret producer: it supplies no account, material or current authority. */
export function exampleCredentialWorkloadSelectionV1(): CredentialWorkloadSelectionV1 {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const digest = `sha256:${"a".repeat(64)}`;
  const scope = () => ({
    installationId: `ins_${id(1)}`,
    namespaceId: `ns_${id(2)}`,
    agentId: `agt_${id(3)}`,
  });
  const reference = (name: string) => ({ ref: `${name}/example`, version: 1, digest });
  const binding = (name: string, secret: number) => ({
    schemaVersion: 1 as const,
    scope: scope(),
    bindingRef: `binding/${name}`,
    bindingVersion: 1,
    secretId: `sec_${id(secret)}`,
    secretVersion: 1,
    providerId: `provider/${name}`,
    account: reference(`account/${name}`),
    driverId: "driver/example",
    backendBindingRef: "backend/example",
  });
  return {
    schemaVersion: 1,
    scope: scope(),
    revisionId: `rev_${id(4)}`,
    association: {
      selection: {
        manifestRef: id(5),
        manifestDigest: digest,
        admissionRef: id(6),
        admissionVersion: 1,
      },
      profileRefs: {
        provider: { ref: id(10), version: 1, contentDigest: digest },
        runtime: { ref: id(11), version: 1, contentDigest: digest },
        identity: { ref: id(12), version: 1, contentDigest: digest },
        containment: { ref: id(13), version: 1, contentDigest: digest },
        storage: { ref: id(14), version: 1, contentDigest: digest },
      },
      admittedConfigurationDigest: digest,
    },
    model: {
      schemaVersion: 1,
      scope: scope(),
      profile: {
        schemaVersion: 1,
        scope: scope(),
        profile: reference("profile/model"),
        providerId: "provider/model",
        account: reference("account/model"),
        transport: reference("transport/model"),
        kind: "model",
        mode: "mediated",
        modelProfile: reference("model-profile"),
        credentialClass: "api-key",
      },
      binding: binding("model", 20),
      accountLink: reference("account-link/model"),
      upstreamWorkspaceRef: "workspace/model",
      invocationProfile: reference("invocation/model"),
      custody: "external-protected-owner",
      setup: {
        kind: "api-key-import",
        invocationMaterial: "api-key",
        rotationOwnerRef: "rotation-owner/example",
        lifecycleProfile: reference("lifecycle/model"),
      },
    },
    repository: {
      profile: {
        schemaVersion: 1,
        scope: scope(),
        profile: reference("profile/repository"),
        providerId: "provider/repository",
        account: reference("account/repository"),
        transport: reference("transport/repository"),
        kind: "repository",
        mode: "native",
        providerInstallationRef: "installation/repository",
        permissionProfile: reference("permission/repository"),
        credentialClass: "installation-token",
      },
      binding: binding("repository", 21),
      grant: {
        providerInstallationRef: "installation/repository",
        repositoryIds: ["101"],
        permissions: [
          { name: "contents", access: "read" },
          { name: "metadata", access: "read" },
        ],
        permissionProfile: reference("permission/repository"),
      },
    },
    materialSelection: { recordRef: "selection/example", recordVersion: 1 },
    channels: [
      {
        kind: "slack",
        moduleId: "channel/slack",
        profileRef: "channel-profile/slack",
        bot: { ref: "credential/slack-bot", version: 1 },
        app: { ref: "credential/slack-app", version: 1 },
      },
      {
        kind: "teams",
        moduleId: "channel/teams",
        profileRef: "channel-profile/teams",
        credential: { ref: "credential/teams", version: 1 },
      },
    ],
  };
}
