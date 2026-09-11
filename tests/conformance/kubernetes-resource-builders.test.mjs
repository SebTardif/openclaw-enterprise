import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as identity from "../../apps/controller/src/drivers/compute/kubernetes/resources/identity.ts";
import * as gateway from "../../apps/controller/src/drivers/compute/kubernetes/resources/gateway.ts";
import * as network from "../../apps/controller/src/drivers/compute/kubernetes/resources/network.ts";
import * as storage from "../../apps/controller/src/drivers/compute/kubernetes/resources/storage.ts";
import * as channel from "../../apps/controller/src/drivers/compute/kubernetes/resources/channel-policy.ts";
import * as secret from "../../apps/controller/src/drivers/compute/kubernetes/resources/secret-projection.ts";
import { deployment } from "../../apps/controller/src/drivers/compute/kubernetes/resources/harness.ts";
import { freeze, render, scenarios } from "../fixtures/kubernetes-resource-builders/scenarios.mjs";

// These are deterministic Driver/desired-resource fixtures, not live SDK or cluster qualification.
// Captured from the accepted pre-extraction Driver to retain exact desired-resource behavior.
const baseline = JSON.parse(
  readFileSync(
    new URL("../fixtures/kubernetes-resource-builders/pre-extraction.json", import.meta.url),
    "utf8",
  ),
);

// This adapter only supplies explicit immutable options to real leaf functions.
// It implements no manifest, policy, validation, or ownership behavior itself.
function directBuilders(options) {
  return {
    ...identity,
    ...gateway,
    ...network,
    ...storage,
    ...channel,
    ...secret,
    gatewayMembershipLabels: () => gateway.gatewayMembershipLabels(options.gatewayRouting),
    gatewayRoute: (...args) =>
      gateway.gatewayRoute(
        { gatewayRouting: options.gatewayRouting, gatewayPort: options.network.gatewayPort },
        ...args,
      ),
    networkPolicies: (...args) => network.networkPolicies(options, ...args),
    service: (...args) =>
      network.service(
        { gatewayPort: options.network.gatewayPort, runtimeEnabled: options.runtime !== undefined },
        ...args,
      ),
    gatewayPrivateStateClaim: (...args) =>
      storage.gatewayPrivateStateClaim(options.runtime?.gatewayStorageClassName, ...args),
    enabledChannels: (...args) =>
      channel.enabledChannels(options.runtime?.channels !== undefined, ...args),
    channelNetworkPolicy: (...args) =>
      channel.channelNetworkPolicy(options.runtime?.channels?.proxyUrl, ...args),
    agentNetworkPolicies: (...args) =>
      channel.agentNetworkPolicies(options.runtime !== undefined, ...args),
    agentAuthenticationNetworkPolicy: (...args) =>
      channel.agentAuthenticationNetworkPolicy(options.runtime !== undefined, ...args),
    deployment: (...args) => deployment(options, ...args),
  };
}

for (const scenario of scenarios()) {
  test(`real Kubernetes Driver preserves pre-extraction resources: ${scenario.name}`, () => {
    const inputsBefore = structuredClone({
      options: scenario.options,
      revision: scenario.revision,
      context: scenario.context,
    });
    const actual = render(scenario);
    // These recorded scenarios do not select password authentication. Retain the
    // archived resource baseline and assert the new explicit metadata separately.
    const expected = {
      ...baseline[scenario.name],
      configuration: {
        ...baseline[scenario.name].configuration,
        usesGatewayPasswordEnv: false,
      },
    };
    assert.deepEqual(actual, expected);
    assert.deepEqual(
      render(scenario, directBuilders(scenario.options)),
      expected,
      "direct leaves preserve the same pre-extraction baseline",
    );
    assert.deepEqual(
      render(scenario),
      actual,
      "rendering is repeatable without resource allocation or client initialization",
    );
    assert.deepEqual(
      { options: scenario.options, revision: scenario.revision, context: scenario.context },
      inputsBefore,
    );
    assert.equal(
      scenario.driver.apiClients,
      undefined,
      "pure rendering must not start the Kubernetes SDK",
    );
    assert.equal(Object.isFrozen(scenario.revision.configuration.logging), true);
  });
}

test("desired routing consumes an observed Service UID without inventing one", () => {
  const scenario = scenarios().find(({ name }) => name === "runtime-dedicated-routed-channels");
  const actual = render(scenario);
  assert.equal(Object.hasOwn(actual.gatewayService.metadata, "uid"), false);
  assert.equal(Object.hasOwn(actual.routeWithoutUid.metadata, "ownerReferences"), false);
  assert.deepEqual(actual.routeWithUid.metadata.ownerReferences, [
    {
      apiVersion: "v1",
      kind: "Service",
      name: "gateway-builders",
      uid: "observed-service-uid",
      controller: false,
      blockOwnerDeletion: false,
    },
  ]);
  assert.equal(
    actual.gatewayDeployment.spec.template.metadata.labels["openclaw.dev/revision"],
    scenario.revision.id,
  );
  assert.equal(
    actual.gatewayDeployment.spec.template.metadata.annotations[
      "openclaw.dev/configuration-generation"
    ],
    String(scenario.revision.configurationGeneration),
  );
  assert.equal(
    actual.agentDeployment.spec.template.metadata.labels["openclaw.dev/service-principal"],
    scenario.revision.servicePrincipalId,
  );
});

test("bound model Secret projection is minimal and rejects changed identity before rendering", () => {
  const scenario = scenarios().find(({ name }) => name === "runtime-embedded-secret");
  const actual = render(scenario);
  const environment = actual.gatewayDeployment.spec.template.spec.containers[0].env;
  assert.deepEqual(
    environment.filter(({ name }) => name === "OPENAI_API_KEY"),
    [
      {
        name: "OPENAI_API_KEY",
        valueFrom: { secretKeyRef: { name: "stored-model-key", key: "value", optional: false } },
      },
    ],
  );
  assert.equal(
    environment.some(({ valueFrom }) => valueFrom?.secretKeyRef?.name.startsWith("model-")),
    false,
  );
  assert.equal(Object.isFrozen(actual.projected), true);
  for (const change of [
    { agentId: "foreign-agent" },
    { namespaceId: "foreign-namespace" },
    { secretId: "foreign-secret" },
    {
      backendRef: {
        ...scenario.context.secretEnvironment[0].backendRef,
        namespaceName: "foreign-namespace",
      },
    },
    { backendRef: { ...scenario.context.secretEnvironment[0].backendRef, uid: "" } },
  ]) {
    const context = freeze({
      secretEnvironment: [{ ...scenario.context.secretEnvironment[0], ...change }],
    });
    assert.throws(
      () =>
        scenario.driver.secretEnvironmentForRevision(
          scenario.revision,
          context,
          scenario.namespace,
        ),
      /does not match AgentRevision bindings/,
    );
  }
  assert.equal(scenario.driver.apiClients, undefined);
});

test("channel restrictions remain closed for embedded or unsupported configurations", () => {
  const scenario = scenarios().find(({ name }) => name === "runtime-dedicated-routed-channels");
  const embedded = freeze({
    ...scenario.revision,
    harness: { id: "openclaw", version: "1.0.0", mode: "embedded" },
  });
  assert.throws(() => scenario.driver.enabledChannels(embedded), /dedicated Agent workload/);
  const unsupported = freeze({
    ...scenario.revision,
    configuration: { ...scenario.revision.configuration, channels: { unknown: {} } },
  });
  assert.throws(
    () => scenario.driver.enabledChannels(unsupported),
    /Unsupported OpenClaw channel provider/,
  );
  const environment = render(scenario).gatewayDeployment.spec.template.spec.containers[0].env;
  assert.equal(
    environment.some(({ name }) => name === "OPENAI_API_KEY"),
    false,
    "dedicated gateway cannot receive the Agent model credential",
  );
  assert.equal(
    environment.some(({ name }) => name === "OPENCLAW_GATEWAY_TOKEN"),
    false,
    "trusted proxy authentication omits the gateway shared token",
  );
});

test("real prepareRevision stages exact immutable configuration before the workload hook", async () => {
  const { prepareRecorder } =
    await import("../fixtures/kubernetes-resource-builders/prepare-recorder.mjs");
  const scenario = scenarios().find(({ name }) => name === "fixture-embedded");
  const { events, writes, objects } = prepareRecorder(scenario);
  // No readiness status is supplied: successful rendering and staging cannot establish execution.
  assert.deepEqual(await scenario.driver.prepareRevision(scenario.revision), {
    namespaceId: scenario.revision.namespaceId,
    agentId: scenario.revision.agentId,
    revisionId: scenario.revision.id,
    ready: false,
  });
  assert.deepEqual(events, [
    "apply:ConfigMap",
    "apply:ServiceAccount",
    "hook:beforeWorkloadStart",
    "apply:Deployment",
    "apply:Service",
  ]);
  const configuration = writes.find(({ kind }) => kind === "ConfigMap");
  const snapshot = scenario.driver.gatewayConfiguration(scenario.revision);
  assert.deepEqual(
    configuration,
    gateway.gatewayConfigurationMap(
      snapshot,
      JSON.stringify(scenario.revision.configuration),
      scenario.ownership,
      scenario.namespace,
    ),
  );
  assert.equal(configuration.immutable, true);
  assert.deepEqual(Object.keys(configuration.data), ["openclaw.json"]);
  assert.equal(
    configuration.data["openclaw.json"],
    JSON.stringify(scenario.revision.configuration),
  );
  assert.deepEqual(configuration.metadata.annotations, {
    "openclaw.dev/namespace-id": scenario.revision.namespaceId,
    "openclaw.dev/agent-id": scenario.revision.agentId,
    ...snapshot.annotations,
  });
  // A same-name snapshot with changed bytes must fail before another workload hook or apply.
  objects.get(`ConfigMap/${snapshot.name}`).data["openclaw.json"] = "{}";
  const before = [...events];
  await assert.rejects(
    scenario.driver.prepareRevision(scenario.revision),
    /invalid immutable Kubernetes ConfigMap/,
  );
  assert.deepEqual(events, before);
});
