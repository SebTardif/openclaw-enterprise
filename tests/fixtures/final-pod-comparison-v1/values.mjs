// Complete fictional comparison content. No actual profile, producer, authority
// or runtime is created. Original contract bindings are reused as fixture inputs.
import {
  candidate as contractCandidate,
  observed as contractObserved,
  observedPreallocated as contractPreallocated,
  copy,
  digest,
} from "../containment-admission-v1/values.mjs";
export { copy, digest };
export function document() {
  const value = contractCandidate().actual;
  const pod = value.pod;
  Object.assign(pod.metadata, { name: "fixture-agent", namespace: "fixture-namespace" });
  const main = pod.spec.containers[0];
  delete main.livenessProbe;
  delete main.startupProbe;
  delete main.lifecycle;
  Object.assign(main.readinessProbe, {
    initialDelaySeconds: 0,
    timeoutSeconds: 1,
    successThreshold: 1,
    failureThreshold: 3,
  });
  main.securityContext.privileged = false;
  main.terminationMessagePath = "/dev/termination-log";
  main.terminationMessagePolicy = "File";
  main.ports = [{ name: "transport", containerPort: 18790, protocol: "TCP" }];
  main.volumeMounts.push(
    { name: "runtime-temporary", mountPath: "/tmp", readOnly: false },
    { name: "workspace", mountPath: "/home/node/workspace", subPath: "workspace", readOnly: false },
    {
      name: "workspace",
      mountPath: "/home/node/.openclaw/agents/main/sessions",
      subPath: "sessions",
      readOnly: true,
    },
    {
      name: "workspace",
      mountPath: "/home/node/openclaw-runtime-assets/bundled",
      subPath: "bundled-skills",
      readOnly: true,
    },
    { name: "bootstrap", mountPath: "/var/run/secrets/fixture", readOnly: true },
  );
  pod.spec.initContainers = [
    {
      name: "prepare-private-state",
      image: main.image,
      imagePullPolicy: "IfNotPresent",
      command: ["node"],
      args: ["prepare.js"],
      env: [],
      envFrom: [],
      securityContext: copy(main.securityContext),
      volumeMounts: [copy(main.volumeMounts[0])],
      resources: {
        requests: { cpu: "100m", memory: "16Mi", "ephemeral-storage": "4Mi" },
        limits: { cpu: "250m", memory: "32Mi", "ephemeral-storage": "8Mi" },
      },
    },
  ];
  pod.spec.volumes.push(
    { name: "runtime-temporary", emptyDir: { sizeLimit: "64Mi" } },
    {
      name: "workspace",
      persistentVolumeClaim: { claimName: "fixture-agent-claim", readOnly: false },
    },
    {
      name: "bootstrap",
      projected: {
        defaultMode: 288,
        sources: [
          {
            serviceAccountToken: {
              audience: "fixture-audience",
              expirationSeconds: 600,
              path: "token",
            },
          },
        ],
      },
    },
  );
  pod.spec.resources = {
    requests: { cpu: "350m", memory: "80Mi", "ephemeral-storage": "12Mi" },
    limits: { cpu: "1250m", memory: "160Mi", "ephemeral-storage": "24Mi" },
  };
  pod.spec.overhead = { cpu: "10m", memory: "8Mi", "ephemeral-storage": "1Mi" };
  pod.spec.securityContext.supplementalGroupsPolicy = "Strict";
  pod.spec.hostAliases = [{ ip: "192.0.2.2", hostnames: ["fixture.invalid"] }];
  pod.spec.schedulerName = "default-scheduler";
  pod.spec.priority = 0;
  pod.spec.priorityClassName = "fixture-priority";
  pod.spec.preemptionPolicy = "Never";
  pod.spec.affinity = {
    nodeAffinity: {
      requiredDuringSchedulingIgnoredDuringExecution: {
        nodeSelectorTerms: [
          {
            matchExpressions: [
              { key: "fixture.example/runtime", operator: "In", values: ["synthetic"] },
            ],
          },
        ],
      },
    },
  };
  pod.spec.tolerations = [
    { key: "fixture.example/runtime", operator: "Equal", value: "synthetic", effect: "NoSchedule" },
  ];
  value.controller.metadata = {
    name: "fixture-agent",
    namespace: "fixture-namespace",
    labels: copy(pod.metadata.labels),
    annotations: {},
  };
  value.controller.spec.selector = { matchLabels: copy(pod.metadata.labels) };
  value.controller.spec.template = {
    metadata: { labels: copy(pod.metadata.labels), annotations: {} },
    spec: copy(pod.spec),
  };
  return value;
}
function complete(value) {
  const raw = document();
  if (value.binding.subject.stage === "observed") {
    const identity = value.binding.subject.objectIdentity;
    Object.assign(raw.pod.metadata, {
      uid: identity.podUid,
      resourceVersion: identity.podResourceVersion,
    });
    raw.controller.metadata.name =
      value.binding.subject.observation.status === "complete"
        ? value.binding.subject.observation.object.target.name
        : "fixture-deployment";
    Object.assign(raw.controller.metadata, {
      uid: identity.deploymentUid,
      resourceVersion: identity.deploymentResourceVersion,
    });
    raw.pod.status = {
      phase: "Running",
      podIP: "192.0.2.10",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [
        {
          name: "agent",
          image: raw.pod.spec.containers[0].image,
          imageID: digest(50),
          ready: true,
          restartCount: 0,
          state: { running: { startedAt: "2026-01-01T00:00:00.000Z" } },
          lastState: {},
        },
      ],
    };
  }
  value.actual = copy(raw);
  value.expectation.document = copy(raw);
  return value;
}
export const candidate = () => complete(contractCandidate());
export const observed = () => complete(contractObserved());
export const preallocated = (status = "complete", expectedObject = false) =>
  complete(contractPreallocated(status, expectedObject));
export const main = (value) => value.actual.pod.spec.containers[0];
export const expectedMain = (value) => value.expectation.document.pod.spec.containers[0];
export function unavailable(value = candidate(), reasonCode = "static-input-unavailable") {
  value.expectation = {
    status: "unavailable",
    reasonCode,
    missingFieldGroups: ["images-and-pull-policy"],
  };
  return value;
}
