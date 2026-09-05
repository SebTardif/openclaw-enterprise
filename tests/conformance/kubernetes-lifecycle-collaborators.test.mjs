import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  inputs,
  runScenario,
  scenarioNames,
} from "../fixtures/kubernetes-lifecycle-collaborators/scenarios.mjs";

const frozen = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/kubernetes-lifecycle-collaborators/before-extraction.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const mutations = (trace) => trace.calls.filter(({ method }) => /^(patch|delete)/.test(method));
const deletions = (trace) => trace.calls.filter(({ method }) => method.startsWith("delete"));
const phases = (trace) => trace.events.map(({ phase, owner }) => `${phase}:${owner}`);
const starts = ["beforeWorkloadStart:first", "beforeWorkloadStart:second"];
const stops = ["beforeWorkloadStop:second", "beforeWorkloadStop:first"];

test("lifecycle corpus records the fixed pre-extraction Driver and every declared scenario", () => {
  assert.equal(frozen.provenance.baseCommit, "e174c90a729c4c8e58285111aa4edf9f886fa077");
  assert.equal(frozen.provenance.nodeVersion, "v24.20.0");
  assert.equal(
    frozen.provenance.driverSourceSha256,
    "3a13e2456741531d86783185dbed50a731dd3781b75e900d763bffb73a85e06b",
  );
  assert.deepEqual(Object.keys(frozen.traces), scenarioNames);
});

// Every case invokes an actual public Driver operation. The fixed observations
// represent controlled SDK responses, not Kubernetes API, Pod, or gateway runtime proof.
for (const name of scenarioNames) {
  test(`Kubernetes lifecycle extraction preserves ${name}`, async () => {
    const actual = await runScenario(name);
    assert.deepEqual(actual, frozen.traces[name]);
    assert.ok(actual.events.every(({ frozen, signalAborted }) => frozen && !signalAborted));

    if (name === "namespace-ensure-ready") {
      assert.deepEqual(actual.outcome.value, {
        namespaceId: inputs.tenant.id,
        namespaceReady: true,
      });
      assert.deepEqual(phases(actual), [
        "afterNamespacePrepared:first",
        "afterNamespacePrepared:second",
      ]);
      assert.ok(
        actual.order.lastIndexOf("patchNamespacedNetworkPolicy") <
          actual.order.indexOf("afterNamespacePrepared:first"),
      );
    }

    if (name === "adoption" || name === "adoption-same-tenant-conflict") {
      assert.deepEqual(actual.outcome.value, {
        namespaceId: inputs.tenant.id,
        namespaceReady: false,
      });
      assert.equal(mutations(actual).length, 1);
      const patch = mutations(actual)[0];
      assert.equal(patch.method, "patchNamespace");
      assert.equal(patch.request.body.metadata.resourceVersion, "7");
      assert.equal(patch.request.force, false);
      assert.equal(patch.request.body.metadata.labels["openclaw.dev/namespace"], inputs.tenant.id);
      assert.deepEqual(patch.request.body.metadata.annotations, {
        "openclaw.dev/namespace-id": inputs.tenant.id,
      });
      assert.ok(
        actual.order.indexOf("listNamespacedNetworkPolicy") <
          actual.order.indexOf("patchNamespace"),
      );
    }
    if (
      [
        "adoption-competing-tenant-conflict",
        "adoption-foreign-policy",
        "adoption-missing-resource-version",
        "external-delete-foreign-policy",
      ].includes(name)
    ) {
      assert.equal(actual.outcome.value.failure, "permanent");
      assert.equal(mutations(actual).length, name === "adoption-competing-tenant-conflict" ? 1 : 0);
    }
    if (name === "external-delete") {
      assert.equal(actual.outcome.value.namespaceDeleted, true);
      assert.deepEqual(
        deletions(actual).map(({ request }) => request.name),
        ["openclaw-quota", "openclaw-limits", "allow-dns", "allow-gateway-ingress", "default-deny"],
      );
      assert.ok(
        deletions(actual).every(
          ({ request }) => typeof request.body.preconditions.uid === "string",
        ),
      );
      assert.equal(
        actual.calls.some(({ method }) => method === "deleteNamespace"),
        false,
      );
      assert.deepEqual(phases(actual), [
        "beforeNamespaceDelete:second",
        "beforeNamespaceDelete:first",
      ]);
    }
    if (name.startsWith("namespace-delete")) {
      assert.equal(actual.outcome.value.namespaceDeleted, name === "namespace-delete-complete");
      assert.equal(deletions(actual).length, 1);
      assert.match(deletions(actual)[0].request.body.preconditions.uid, /^uid-oce-/);
      assert.ok(
        actual.order.indexOf("beforeNamespaceDelete:first") <
          actual.order.indexOf("deleteNamespace"),
      );
    }
    if (
      [
        "prepare-ready",
        "prepare-transient-read",
        "prepare-stale-gateway-generation",
        "prepare-endpoints-for-another-service-uid",
        "prepare-stale-agent-generation",
      ].includes(name)
    ) {
      assert.equal(
        actual.outcome.value.ready,
        ["prepare-ready", "prepare-transient-read"].includes(name),
      );
      assert.equal(actual.outcome.value.revisionId, inputs.revision.id);
      if (name === "prepare-stale-gateway-generation") {
        assert.equal(
          actual.calls.some(({ method }) => method === "listNamespacedEndpointSlice"),
          false,
        );
      }
      assert.deepEqual(
        phases(actual),
        ["prepare-ready", "prepare-transient-read", "prepare-stale-agent-generation"].includes(name)
          ? starts
          : [],
      );
      if (name === "prepare-transient-read")
        assert.equal(actual.calls.filter(({ method }) => method === "listNamespace").length, 3);
    }
    if (
      [
        "prepare-changed-immutable-document",
        "prepare-mutable-configuration",
        "prepare-extra-binary-configuration",
      ].includes(name)
    ) {
      assert.match(actual.outcome.error.message, /invalid immutable Kubernetes ConfigMap/);
      assert.deepEqual(mutations(actual), []);
      assert.deepEqual(actual.events, []);
    }
    if (name === "prepare-incompatible-claim") {
      assert.match(actual.outcome.error.message, /invalid PersistentVolumeClaim/);
      assert.deepEqual(
        mutations(actual).map(({ method }) => method),
        ["patchNamespacedServiceAccount"],
      );
      assert.deepEqual(actual.events, []);
    }
    if (name === "activate-unready-revision") {
      assert.match(actual.outcome.error.message, /exact AgentRevision workload is not ready/);
      assert.deepEqual(mutations(actual), []);
    }
    if (name === "activate-ready-revision") {
      const last = mutations(actual).at(-1);
      assert.equal(last.method, "patchNamespacedService");
      assert.equal(last.request.body.selector["openclaw.dev/revision"], inputs.revision.id);
      assert.ok(
        actual.order.indexOf("listNamespacedEndpointSlice") <
          actual.order.lastIndexOf("patchNamespacedService"),
      );
    }
    if (name.startsWith("deactivate")) {
      assert.equal(mutations(actual).length, name === "deactivate-current-revision" ? 1 : 0);
      if (name === "deactivate-current-revision")
        assert.match(
          mutations(actual)[0].request.body.selector["app.kubernetes.io/name"],
          /-inactive$/,
        );
    }
    if (name.startsWith("retire")) {
      assert.deepEqual(phases(actual), stops);
      assert.ok(
        actual.order.indexOf("beforeWorkloadStop:first") <
          actual.order.indexOf("deleteNamespacedDeployment"),
      );
      assert.ok(
        deletions(actual).every(
          ({ request }) => typeof request.body?.preconditions?.uid === "string",
        ),
      );
    }
    if (["retire-predecessor-revision", "retire-route-successor-without-gateway"].includes(name)) {
      assert.deepEqual(
        deletions(actual).map(({ method }) => method),
        ["deleteNamespacedDeployment"],
      );
      assert.match(deletions(actual)[0].request.name, /^agent-.*-rev-/);
    }
    if (name === "retire-current-revision") {
      assert.deepEqual(
        deletions(actual).map(({ method }) => method),
        [
          "deleteNamespacedDeployment",
          "deleteNamespacedPersistentVolumeClaim",
          "deleteNamespacedPersistentVolumeClaim",
          "deleteHTTPRoute",
          "deleteNamespacedService",
          "deleteNamespacedServiceAccount",
          "deleteNamespacedDeployment",
        ],
      );
      assert.match(deletions(actual).at(-1).request.name, /^gateway-/);
    }
    if (name === "retire-service-delete-failure") {
      assert.equal(actual.outcome.originalMutationError, true);
      assert.equal(
        actual.calls.filter(({ method }) => method === "deleteNamespacedService").length,
        1,
      );
      // The gateway Deployment remains a retry witness until dependent Service deletion succeeds.
      assert.equal(
        deletions(actual).some(
          ({ method, request }) =>
            method === "deleteNamespacedDeployment" && request.name.startsWith("gateway-"),
        ),
        false,
      );
    }
    if (name === "retire-route-missing-uid") {
      assert.match(actual.outcome.error.message, /UID must be explicitly observed/);
      assert.equal(
        deletions(actual).some(({ method }) => method === "deleteHTTPRoute"),
        false,
      );
    }
    if (name === "retire-claim-missing-uid") {
      assert.match(actual.outcome.error.message, /PersistentVolumeClaim UID/);
      assert.equal(
        deletions(actual).some(({ method }) => method === "deleteNamespacedPersistentVolumeClaim"),
        false,
      );
    }
    if (
      [
        "prepare-unknown-mutation-effect",
        "prepare-cleanup-failure",
        "prepare-owner-cancellation",
      ].includes(name)
    ) {
      assert.equal(actual.unknownMutationObserved, true);
      assert.equal(
        actual.calls.filter(
          ({ method, request }) =>
            method === "patchNamespacedDeployment" && request.name.startsWith("agent-"),
        ).length,
        1,
      );
      assert.deepEqual(
        phases(actual),
        name === "prepare-cleanup-failure" ? [...starts, stops[0]] : [...starts, ...stops],
      );
      assert.ok(
        actual.order.lastIndexOf("patchNamespacedDeployment") <
          actual.order.indexOf("beforeWorkloadStop:second"),
      );
      if (name === "prepare-unknown-mutation-effect")
        assert.equal(actual.outcome.originalMutationError, true);
      if (name === "prepare-cleanup-failure") {
        assert.equal(actual.outcome.error.name, "AggregateError");
        assert.equal(actual.outcome.error.errors[0].statusCode, 503);
        assert.match(actual.outcome.error.errors[1].message, /beforeWorkloadStop/);
      }
      if (name === "prepare-owner-cancellation") {
        assert.equal(actual.outcome.originalCancellation, true);
        assert.equal(actual.requestSignalAborted, true);
      }
    }
    if (name === "prepare-already-cancelled") {
      assert.equal(actual.outcome.originalCancellation, true);
      assert.deepEqual(actual.calls, []);
      assert.deepEqual(actual.events, []);
    }
  });
}
