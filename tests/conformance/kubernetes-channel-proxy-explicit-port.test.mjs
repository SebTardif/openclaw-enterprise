import assert from "node:assert/strict";
import test from "node:test";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { freeze, render, scenarios } from "../fixtures/kubernetes-resource-builders/scenarios.mjs";

const baseline = scenarios().find(({ name }) => name === "runtime-dedicated-routed-channels");

function configuredScenario(proxyUrl) {
  const options = freeze({
    ...baseline.options,
    runtime: {
      ...baseline.options.runtime,
      channels: { ...baseline.options.runtime.channels, proxyUrl },
    },
  });
  return { ...baseline, options, driver: new KubernetesComputeDriver(options) };
}

for (const [proxyUrl, cidr, port] of [
  ["http://192.0.2.15:80", "192.0.2.15/32", 80],
  ["https://192.0.2.15:443/", "192.0.2.15/32", 443],
  ["http://[2001:db8::15]:80/", "2001:db8::15/128", 80],
  ["https://[2001:db8::15]:443", "2001:db8::15/128", 443],
  ["HTTPS://[2001:0DB8:0:0:0:0:0:15]:00443/", "2001:db8::15/128", 443],
  ["http://192.0.2.15:8080", "192.0.2.15/32", 8080],
  ["https://[2001:db8::15]:8443", "2001:db8::15/128", 8443],
]) {
  test(`channel proxy renders its explicit endpoint: ${proxyUrl}`, () => {
    const scenario = configuredScenario(proxyUrl);
    // The real Driver renders desired resources without initializing API clients.
    const actual = render(scenario);
    assert.equal(scenario.driver.apiClients, undefined);
    assert.deepEqual(actual.channelPolicy.spec, {
      podSelector: {
        matchLabels: {
          "openclaw.dev/workload-role": "gateway",
          "openclaw.dev/agent": scenario.revision.agentId,
        },
      },
      policyTypes: ["Egress"],
      egress: [{ to: [{ ipBlock: { cidr } }], ports: [{ protocol: "TCP", port }] }],
    });
    assert.deepEqual(
      actual.gatewayDeployment.spec.template.spec.containers[0].env.filter(
        ({ name }) => name === "HTTPS_PROXY",
      ),
      [{ name: "HTTPS_PROXY", value: proxyUrl }],
    );
    assert.equal(
      actual.agentDeployment.spec.template.spec.containers[0].env.some(
        ({ name }) => name === "HTTPS_PROXY",
      ),
      false,
    );
    // Changing the proxy must not change the Agent's separate egress policy.
    assert.deepEqual(actual.agentPolicies, render(baseline).agentPolicies);
  });
}

test("disabled channels retain empty proxy egress and no gateway proxy environment", () => {
  const scenario = configuredScenario("https://192.0.2.15:443");
  scenario.revision = freeze({
    ...scenario.revision,
    configuration: {
      ...scenario.revision.configuration,
      channels: { slack: { enabled: false }, msteams: { enabled: false } },
    },
  });
  const actual = render(scenario);
  assert.deepEqual(actual.channelPolicy.spec.egress, []);
  assert.equal(
    actual.gatewayDeployment.spec.template.spec.containers[0].env.some(
      ({ name }) => name === "HTTPS_PROXY",
    ),
    false,
  );
  assert.equal(scenario.driver.apiClients, undefined);
});

test("channel proxy still requires an explicit port and a credential-free HTTP(S) IP URL", () => {
  for (const proxyUrl of [
    undefined,
    null,
    443,
    "",
    "not a URL",
    "http://192.0.2.15",
    "https://192.0.2.15/",
    "http://[2001:db8::15]",
    "https://[2001:db8::15]/",
    "http://192.0.2.15:",
    "https://[2001:db8::15]:/",
    "ftp://192.0.2.15:21",
    "https://proxy.example:443",
    "https://user:password@192.0.2.15:443",
    "http://user@192.0.2.15:80",
    "http://192.0.2.15:65536",
    "https://192.0.2.15:-443",
    "http://192.0.2.15:80x",
    "http://192.0.2.15:80/path",
    "https://192.0.2.15:443?target=other",
    "https://192.0.2.15:443#fragment",
    "http://2001:db8::15:80",
    "https://[2001:db8::15:443",
  ]) {
    assert.throws(() => configuredScenario(proxyUrl), /Channel proxy URL/, String(proxyUrl));
  }
});

test("default-port recovery does not admit authorities or suffixes normalized by URL parsing", () => {
  for (const proxyUrl of [
    "http:192.0.2.15:80",
    "http:/192.0.2.15:80",
    "http:///192.0.2.15:80",
    "http:\\192.0.2.15:80",
    "http://192.0.2.15:80\\",
    "http://192.0.2.\t15:80",
    "http://192.0.2.\n15:80",
    "https://192.0.2.15:4\r43",
    "http://192.0.2.15:80\n",
    "http://@192.0.2.15:80",
    "http://0xc000020f:80",
    "http://3221225999:80",
    "http://0300.0.2.17:80",
    "http://192.0.2.15.:80",
    "http://%31%39%32.0.2.15:80",
    "http://192.0.2.15:80/.",
    "http://192.0.2.15:80/path/..",
    "http://192.0.2.15:80?",
    "https://192.0.2.15:443#",
  ]) {
    assert.throws(() => configuredScenario(proxyUrl), /Channel proxy URL/, proxyUrl);
  }
});
