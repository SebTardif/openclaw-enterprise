import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import * as sdk from "@kubernetes/client-node";
import { KubernetesComputeDriver } from "../../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { currentComputeAbortSignal } from "../../../apps/controller/src/drivers/compute/operation-context.ts";

const { options } = JSON.parse(
  readFileSync(
    new URL("../kubernetes-lifecycle-collaborators/inputs.json", import.meta.url),
    "utf8",
  ),
);
const ref = (recordRef) => ({ recordRef, recordVersion: 1 });
const identity = (name, uid, resourceVersion = "1") => ({ name, uid, resourceVersion });
const clone = structuredClone;

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Explicit controlled protected peers, not production identity/record/physical
 * producers. Product logic runs in the real collaborator and official SDK below. */
export function fixture({ missing = false, original = true } = {}) {
  const locator = {
    installationId: "installation-fixture",
    processRef: "gateway-process",
    processGeneration: 7,
    operationRef: "original-startup-operation",
    operationDigest: "sha256:" + "a".repeat(64),
  };
  const binding = {
    startup: locator,
    createEffectRef: "original-create-effect",
    selection: ref("selection"),
    configurationRef: "configuration",
    configurationVersion: 2,
    profileRef: "gateway-profile",
    profileVersion: 1,
    namespaceRef: "attribution-namespace",
    agentRef: "attribution-agent",
    admittedRevisionRef: "admitted-revision",
    gatewayAssignmentRef: "gateway-assignment",
    hostRuntimeGeneration: 19,
    nativeConfigRef: "native-config",
    configDigest: "sha256:" + "b".repeat(64),
    stateOwnership: ref("state"),
    stateSchemaVersion: 1,
    agentSchemaVersion: 1,
    protocolVersion: 1,
    modules: [],
    startupDeadlineMs: 1000,
    shutdownDeadlineMs: 1000,
  };
  const namespaceIdentity = identity("installation-system", "namespace-uid");
  const target = {
    clusterRef: "selected-cluster",
    namespace: namespaceIdentity,
    deploymentName: "installation-gateway",
  };
  const createInput = { binding, target, launchPlan: ref("fixed-launch-plan") };
  const deploymentIdentity = identity(target.deploymentName, "deployment-uid");
  const replicaSetIdentity = identity("installation-gateway-rs", "replicaset-uid", "3");
  const podIdentity = identity("installation-gateway-pod", "pod-uid", "4");
  const owner = (value, kind) => ({
    apiVersion: "apps/v1",
    kind,
    name: value.name,
    uid: value.uid,
    controller: true,
  });
  const template = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: target.deploymentName, namespace: namespaceIdentity.name },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: "gateway" } },
      template: {
        metadata: { labels: { app: "gateway" } },
        spec: {
          runtimeClassName: "oce-gvisor-systrap",
          automountServiceAccountToken: false,
          containers: [
            {
              name: "gateway",
              image: "fixture/gateway@sha256:" + "c".repeat(64),
              securityContext: { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false },
            },
          ],
          initContainers: [{ name: "initialize", image: "fixture/init@sha256:" + "d".repeat(64) }],
        },
      },
    },
  };
  const namespace = { apiVersion: "v1", kind: "Namespace", metadata: clone(namespaceIdentity) };
  const deployment = {
    ...clone(template),
    metadata: { ...clone(template.metadata), ...deploymentIdentity, generation: 1 },
  };
  const replicaSet = {
    apiVersion: "apps/v1",
    kind: "ReplicaSet",
    metadata: {
      ...replicaSetIdentity,
      namespace: namespaceIdentity.name,
      ownerReferences: [owner(deploymentIdentity, "Deployment")],
    },
  };
  const status = (name) => ({
    name,
    containerID: `containerd://${name}`,
    imageID: `sha256:${name}`,
    restartCount: 0,
    ready: true,
    state: { running: { startedAt: "2026-09-06T00:00:00.000Z" } },
  });
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      ...podIdentity,
      namespace: namespaceIdentity.name,
      ownerReferences: [owner(replicaSetIdentity, "ReplicaSet")],
    },
    spec: { ...clone(template.spec.template.spec), nodeName: "selected-node" },
    status: {
      phase: "Running",
      containerStatuses: [status("gateway")],
      initContainerStatuses: [status("initialize")],
    },
  };
  const f = {
    locator,
    createInput,
    template,
    namespace,
    deployment,
    replicaSet,
    pod,
    original: original
      ? {
          binding: clone(binding),
          target: clone(target),
          deployment: clone(deploymentIdentity),
          controllerGeneration: 1,
          correlation: ref("original-correlation"),
        }
      : undefined,
    requests: [],
    inspections: [],
    outcomes: [],
    descendants: [],
    observations: [],
    cleanupOutcomes: [],
    claimCount: 0,
    consumeCount: 0,
    claimUnknown: false,
    claimed: false,
    current: true,
    planCurrent: true,
    cleanupCurrent: true,
    cleanupAvailable: true,
    retainAvailable: true,
    settlement: undefined,
    responseHook: undefined,
    claimHook: undefined,
    retainHook: undefined,
    descendantHook: undefined,
    extraPods: [],
    listMetadata: { resourceVersion: "list-1" },
    missingObject: undefined,
  };
  const enrolled = new WeakMap();
  const tickets = new WeakMap();
  const activeSignal = new AbortController();
  f.enroll = (method, input, milliseconds = 30_000) => {
    const abort = new AbortController();
    const authorityCall = {
      requestRef: `request-${f.inspections.length}-${method}`,
      recipientRef: "installation-compute-recipient",
      context: Object.freeze({}),
      deadline: new Date(Date.now() + milliseconds).toISOString(),
      signal: abort.signal,
    };
    const call = Object.freeze({ authorityCall });
    enrolled.set(call, { method, input: clone(input), authorityCall, revoked: false });
    return {
      call,
      abort,
      revoke: () => {
        enrolled.get(call).revoked = true;
      },
    };
  };
  function check(method, input, call) {
    const record = enrolled.get(call);
    if (
      !record ||
      record.revoked ||
      record.method !== method ||
      !isDeepStrictEqual(record.input, input) ||
      record.authorityCall !== call.authorityCall ||
      call.authorityCall.signal.aborted ||
      !f.current
    )
      throw new Error("Controlled peer denied.");
  }
  const deps = {
    accepting: {
      async accept(method, input, call) {
        f.inspections.push({ method, input: clone(input), call });
        try {
          check(method, input, call);
        } catch {
          return undefined;
        }
        return {
          signal: activeSignal.signal,
          async recheckCurrent() {
            check(method, input, call);
          },
          assertCurrent() {
            check(method, input, call);
            return undefined;
          },
        };
      },
      async readOriginal() {
        return clone(f.original);
      },
      async retainCreate(ticket, input, outcome) {
        const entry = tickets.get(ticket);
        if (!entry?.used || !isDeepStrictEqual(entry.input, input))
          throw new Error("Unknown original claim.");
        f.outcomes.push(clone(outcome));
        if (f.retainHook) await f.retainHook(outcome);
        if (!f.retainAvailable || outcome.kind !== "acknowledged") return undefined;
        f.original = {
          binding: clone(input.binding),
          target: clone(input.target),
          deployment: clone(outcome.deployment),
          controllerGeneration: outcome.controllerGeneration,
          correlation: ref("retained-create"),
        };
        return clone(f.original);
      },
      async retainDescendants(_original, descendants) {
        f.descendants.push(clone(descendants));
        if (f.descendantHook) await f.descendantHook();
      },
      async retainObservation(originalValue, observation) {
        f.observations.push(clone(observation));
        return {
          original: clone(originalValue),
          observation: clone(observation),
          evidence: ref("api-observation"),
          observedAt: new Date().toISOString(),
        };
      },
      async readCleanup(input) {
        if (!f.cleanupAvailable) return undefined;
        return {
          original: clone(input.original),
          responsibility: clone(input.responsibility),
          policy: { gracePeriodSeconds: 30, propagationPolicy: "Foreground" },
          async recheckCurrent() {
            if (!f.cleanupCurrent) throw new Error("Cleanup revoked.");
          },
          assertCurrent() {
            if (!f.cleanupCurrent) throw new Error("Cleanup revoked.");
            return undefined;
          },
          async retainRequest(outcome) {
            f.cleanupOutcomes.push(outcome);
          },
        };
      },
    },
    submission: {
      async claimOriginal(input, call) {
        f.claimCount++;
        check("createOriginal", input, call);
        if (f.claimHook) await f.claimHook();
        if (f.claimUnknown || f.claimed)
          return { kind: "unknown", operation: input.binding.startup };
        f.claimed = true;
        const ticket = Object.freeze({});
        tickets.set(ticket, { input: clone(input), call, used: false });
        return { kind: "claimed", submission: ticket };
      },
      consumeSubmission(ticket, input, call) {
        const entry = tickets.get(ticket);
        if (!entry || entry.used || entry.call !== call || !isDeepStrictEqual(entry.input, input))
          throw new Error("Submission denied.");
        check("createOriginal", input, call);
        entry.used = true;
        f.consumeCount++;
        return undefined;
      },
    },
    launchPlans: {
      async read() {
        return {
          input: clone(f.createInput),
          deployment: clone(f.template),
          async recheckCurrent() {
            if (!f.planCurrent) throw new Error("Plan revoked.");
          },
          assertCurrent() {
            if (!f.planCurrent) throw new Error("Plan revoked.");
            return undefined;
          },
        };
      },
    },
    settlement: {
      async readCurrent() {
        return f.settlement;
      },
    },
  };
  const configuration = sdk.createConfiguration({
    baseServer: new sdk.ServerConfiguration("https://controlled-kubernetes.invalid", {}),
    httpApi: {
      send(request) {
        return new sdk.Observable(
          (async () => {
            const record = {
              method: request.getHttpMethod(),
              path: new URL(request.getUrl()).pathname,
              body: request.getBody() === undefined ? undefined : JSON.parse(request.getBody()),
              signal: currentComputeAbortSignal(),
            };
            f.requests.push(record);
            let response;
            if (f.responseHook) response = await f.responseHook(record);
            if (response === undefined) {
              const path = record.path;
              if (path.endsWith("/namespaces/installation-system"))
                response = {
                  status: f.missingObject === "namespace" ? 404 : 200,
                  body: f.namespace,
                };
              else if (record.method === "DELETE") response = { status: 200, body: f.deployment };
              else if (
                record.method === "POST" ||
                path.endsWith("/deployments/installation-gateway")
              )
                response = {
                  status: f.missingObject === "deployment" && record.method !== "POST" ? 404 : 200,
                  body: f.deployment,
                };
              else if (path.endsWith("/replicasets"))
                response = {
                  status: 200,
                  body: {
                    kind: "ReplicaSetList",
                    apiVersion: "apps/v1",
                    metadata: f.listMetadata,
                    items: [f.replicaSet],
                  },
                };
              else if (path.endsWith("/pods"))
                response = {
                  status: 200,
                  body: {
                    kind: "PodList",
                    apiVersion: "v1",
                    metadata: f.listMetadata,
                    items: [f.pod, ...f.extraPods],
                  },
                };
              else throw new Error("Unexpected controlled SDK route.");
            }
            const text = JSON.stringify(response.body);
            return new sdk.ResponseContext(
              response.status,
              { "content-type": "application/json" },
              {
                async text() {
                  return text;
                },
                async binary() {
                  return Buffer.from(text);
                },
              },
            );
          })(),
        );
      },
    },
  });
  f.dependencies = deps;
  f.driver = new KubernetesComputeDriver(
    clone(options),
    missing ? {} : { installationProcessDependencies: deps },
  );
  // Selected official SDK clients with a controlled transport. Driver constructor,
  // participant wiring, request retries and serializers execute unchanged.
  f.driver.apiClients = Promise.resolve({
    core: new sdk.CoreV1Api(configuration),
    apps: new sdk.AppsV1Api(configuration),
  });
  f.participant = f.driver.getInstallationProcessParticipant();
  f.retirementInput = () => ({
    original: clone(f.original),
    responsibility: ref("separate-cleanup"),
  });
  return f;
}
