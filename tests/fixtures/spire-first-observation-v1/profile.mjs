import { createHash } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";

// This module only admits explicit inputs and builds objects. Preparation owns
// management/cluster lifecycle; the real test owns its two Pods and entries.
export const SELECTOR_PREFIXES = Object.freeze([
  "k8s:ns",
  "k8s:sa",
  "k8s:pod-uid",
  "k8s:container-name",
  "k8s:node-name",
  "unix:uid",
  "unix:gid",
]);
export const LIMITS = Object.freeze({
  operationMs: 1_800_000,
  caseMs: 120_000,
  fetchMs: 10_000,
  controlMs: 60_000,
  settleMs: 5_000,
  responseBytes: 4 * 1024 * 1024,
  responseEntries: 4,
  bundles: 4,
  authoritiesPerBundle: 16,
});
// UDS-only experiments require loopback-only gVisor networking. Ordinary
// NetworkPolicy does not establish isolation from the workload's own node.
// No host/network fallback is admitted when this selected combination fails.
const runtimeFlags = [
  "--platform=systrap",
  "--sidecar-usage-policy=STRICT",
  "--host-uds=open",
  "--network=none",
];
const runtimeMemberNames = [
  "runsc",
  "containerd-shim-runsc-v1",
  "gvisor-bin/checkpointgofer",
  "gvisor-bin/gvisor-sentry-prewarmer",
  "gvisor-bin/gvisor_sentry",
  "gvisor-bin/runsc-metric-server",
];
const sha = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const namePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const imagePattern = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/;
const uidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const labelKey = "app.kubernetes.io/part-of";
const labelValue = "spire-first-observation";
const roleKey = "app.kubernetes.io/component";
const fail = () => {
  throw new Error("Invalid explicit SPIRE observation profile");
};
const need = (condition) => {
  if (!condition) fail();
};
function keys(value, fields) {
  need(value !== null && typeof value === "object" && !Array.isArray(value));
  need(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  need(Object.keys(value).length === fields.length);
  for (const key of Object.keys(value)) need(fields.includes(key));
  for (const key of fields) need(Object.hasOwn(value, key));
}
function string(value, pattern, max = 256) {
  need(typeof value === "string" && value.length > 0 && value.length <= max && pattern.test(value));
}
function absolute(value) {
  string(value, /^\/[A-Za-z0-9_./-]+$/, 1024);
  need(value !== "/" && path.posix.normalize(value) === value && !value.endsWith("/"));
}
function integer(value, low, high) {
  need(Number.isSafeInteger(value) && value >= low && value <= high);
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function validateProfile(input, { nowMs = Date.now() } = {}) {
  keys(input, [
    "schemaVersion",
    "sourceCommit",
    "artifacts",
    "cluster",
    "paths",
    "management",
    "runtime",
    "workloads",
    "deadlineEpochMs",
  ]);
  need(input.schemaVersion === 1);
  string(input.sourceCommit, commit);
  integer(nowMs, 0, Number.MAX_SAFE_INTEGER);
  integer(input.deadlineEpochMs, nowMs + 1, nowMs + LIMITS.operationMs);
  const a = input.artifacts;
  keys(a, [
    "nodeBaseImage",
    "observerImage",
    "managementImage",
    "observerSHA256",
    "spireAgentSHA256",
    "spireServerSHA256",
    "runscSHA256",
    "sentrySHA256",
    "spireCommit",
    "runscRelease",
    "runtimeMembers",
    "k3dSHA256",
    "kubectlSHA256",
    "dockerSHA256",
  ]);
  for (const key of ["nodeBaseImage", "observerImage", "managementImage"])
    string(a[key], imagePattern, 512);
  for (const key of [
    "observerSHA256",
    "spireAgentSHA256",
    "spireServerSHA256",
    "runscSHA256",
    "sentrySHA256",
    "k3dSHA256",
    "kubectlSHA256",
    "dockerSHA256",
  ])
    string(a[key], sha);
  string(a.spireCommit, commit);
  string(a.runscRelease, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 128);
  need(Array.isArray(a.runtimeMembers) && a.runtimeMembers.length === 6);
  const memberNames = new Set();
  for (const member of a.runtimeMembers) {
    keys(member, ["name", "sha256"]);
    need(runtimeMemberNames.includes(member.name));
    string(member.sha256, sha);
    need(!memberNames.has(member.name));
    memberNames.add(member.name);
  }
  need(
    a.runtimeMembers.some((member) => member.name === "runsc" && member.sha256 === a.runscSHA256),
  );
  need(
    a.runtimeMembers.some(
      (member) => member.name === "gvisor-bin/gvisor_sentry" && member.sha256 === a.sentrySHA256,
    ),
  );
  const c = input.cluster;
  keys(c, [
    "name",
    "context",
    "nodeName",
    "nodeIPv4",
    "apiURL",
    "apiIPv4",
    "apiPort",
    "kubeconfigPath",
    "kubeconfigSHA256",
    "kubectlPath",
    "k3dPath",
    "dockerPath",
    "dockerConfigDirectory",
    "dockerConfigSHA256",
  ]);
  string(c.kubeconfigSHA256, sha);
  string(c.dockerConfigSHA256, sha);
  absolute(c.dockerConfigDirectory);
  need(!c.dockerConfigDirectory.split("/").includes(".docker"));
  for (const key of ["name", "nodeName"]) string(c[key], namePattern);
  need(c.context === `k3d-${c.name}` && c.nodeName === `k3d-${c.name}-server-0`);
  for (const key of ["nodeIPv4", "apiIPv4"]) need(typeof c[key] === "string" && isIP(c[key]) === 4);
  integer(c.apiPort, 1, 65535);
  string(c.apiURL, /^https:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/);
  integer(Number(new URL(c.apiURL).port || "443"), 1, 65535);
  for (const key of ["kubeconfigPath", "kubectlPath", "k3dPath", "dockerPath"]) absolute(c[key]);
  need(!c.kubeconfigPath.endsWith("/.kube/config"));
  const p = input.paths;
  keys(p, [
    "evidenceDir",
    "socketDirectory",
    "socketPath",
    "serverAdminSocket",
    "observerBinary",
    "spireAgentBinary",
    "spireServerBinary",
    "receiverCollector",
  ]);
  Object.values(p).forEach(absolute);
  need(path.posix.dirname(p.socketPath) === p.socketDirectory && p.socketPath.length <= 100);
  need(p.serverAdminSocket === "/var/lib/spire-server/api.sock");
  need(
    p.observerBinary === "/opt/fixture/observer" &&
      p.spireAgentBinary === "/opt/fixture/spire-agent" &&
      p.spireServerBinary === "/opt/fixture/spire-server" &&
      p.receiverCollector === "/opt/fixture/receiver-collector.mjs",
  );
  const m = input.management;
  keys(m, [
    "namespace",
    "agentPod",
    "serverPod",
    "agentContainer",
    "serverContainer",
    "agentServiceAccount",
    "serverServiceAccount",
    "serverIPv4",
    "serverPort",
    "trustDomain",
    "clusterID",
    "kubeletAudience",
    "trustBundleConfigMap",
    "kubeletCAConfigMap",
    "trustBundleSHA256",
    "kubeletCASHA256",
  ]);
  string(m.trustBundleSHA256, sha);
  string(m.kubeletCASHA256, sha);
  for (const key of [
    "namespace",
    "agentPod",
    "serverPod",
    "agentContainer",
    "serverContainer",
    "agentServiceAccount",
    "serverServiceAccount",
    "trustBundleConfigMap",
    "kubeletCAConfigMap",
  ])
    string(m[key], namePattern);
  need(
    m.agentPod !== m.serverPod &&
      m.agentServiceAccount !== m.serverServiceAccount &&
      m.trustBundleConfigMap !== m.kubeletCAConfigMap,
  );
  need(typeof m.serverIPv4 === "string" && isIP(m.serverIPv4) === 4);
  integer(m.serverPort, 1, 65535);
  string(m.trustDomain, /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/, 253);
  need(!m.trustDomain.includes(".."));
  string(m.clusterID, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 128);
  string(m.kubeletAudience, /^[A-Za-z0-9][A-Za-z0-9:/._-]*$/, 256);
  need(m.kubeletAudience !== "spire-server");
  keys(input.runtime, ["runtimeClassName", "handler", "flags"]);
  string(input.runtime.runtimeClassName, namePattern);
  string(input.runtime.handler, namePattern);
  need(
    Array.isArray(input.runtime.flags) &&
      input.runtime.flags.length === runtimeFlags.length &&
      runtimeFlags.every((flag) => input.runtime.flags.includes(flag)),
  );
  const w = input.workloads;
  keys(w, ["namespace", "a", "b"]);
  string(w.namespace, namePattern);
  need(w.namespace !== m.namespace);
  for (const id of ["a", "b"]) {
    keys(w[id], ["podName", "containerName", "spiffeID"]);
    string(w[id].podName, namePattern);
    string(w[id].containerName, namePattern);
    string(w[id].spiffeID, /^spiffe:\/\/[a-z0-9.-]+\/[A-Za-z0-9/_-]+$/, 512);
    need(
      w[id].spiffeID.startsWith(`spiffe://${m.trustDomain}/`) && !w[id].spiffeID.includes("//", 9),
    );
  }
  need(w.a.podName !== w.b.podName && w.a.spiffeID !== w.b.spiffeID);
  return freeze(structuredClone(input));
}

const q = (value) => JSON.stringify(value);
export function buildAgentConfig(profile) {
  const p = validateProfile(profile),
    m = p.management;
  return `agent {
  data_dir = "/var/lib/spire-agent"
  log_level = "ERROR"
  log_format = "JSON"
  log_selectors = ${q(SELECTOR_PREFIXES)}
  server_address = ${q(m.serverIPv4)}
  server_port = ${m.serverPort}
  socket_path = ${q(p.paths.socketPath)}
  trust_bundle_path = "/etc/spire-bundle/bundle.crt"
  trust_domain = ${q(m.trustDomain)}
}
plugins {
  KeyManager "disk" { plugin_data { directory = "/var/lib/spire-agent/keys" } }
  NodeAttestor "k8s_psat" {
    plugin_data { cluster = ${q(m.clusterID)} token_path = "/var/run/spire-psat/token" }
  }
  WorkloadAttestor "k8s" {
    plugin_data {
      node_name = ${q(p.cluster.nodeIPv4)}
      kubelet_secure_port = 10250
      kubelet_ca_path = "/etc/kubelet-ca/ca.crt"
      token_path = "/var/run/kubelet-token/token"
      skip_kubelet_verification = false
      use_anonymous_authentication = false
      disable_kubelet_client = false
      disable_container_selectors = false
      use_new_container_locator = true
      verbose_container_locator_logs = false
      enable_namespace_labels = false
    }
  }
  WorkloadAttestor "unix" { plugin_data { discover_workload_path = false } }
}
`;
}

export function buildServerConfig(profile) {
  return renderServerConfig(validateProfile(profile));
}

function renderServerConfig(p) {
  const m = p.management;
  return `server {
  bind_address = "0.0.0.0"
  bind_port = ${m.serverPort}
  socket_path = ${q(p.paths.serverAdminSocket)}
  trust_domain = ${q(m.trustDomain)}
  data_dir = "/var/lib/spire-server"
  log_level = "ERROR"
  log_format = "JSON"
}
plugins {
  DataStore "sql" { plugin_data { database_type = "sqlite3" connection_string = "/var/lib/spire-server/datastore.sqlite3" } }
  KeyManager "disk" { plugin_data { keys_path = "/var/lib/spire-server/keys.json" } }
  NodeAttestor "k8s_psat" {
    plugin_data {
      clusters = {
        ${q(m.clusterID)} = {
          service_account_allow_list = [${q(`${m.namespace}:${m.agentServiceAccount}`)}]
          audience = ["spire-server"]
          allowed_node_label_keys = []
          allowed_pod_label_keys = []
        }
      }
    }
  }
}
`;
}

const labels = (role) => ({ [labelKey]: labelValue, [roleKey]: role });
const metadata = (name, namespace, role) => ({
  name,
  ...(namespace ? { namespace } : {}),
  ...(role ? { labels: labels(role) } : {}),
});
const security = (uid) => ({
  privileged: false,
  procMount: "Default",
  runAsUser: uid,
  runAsGroup: uid,
  runAsNonRoot: uid !== 0,
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ["ALL"] },
  seccompProfile: { type: "RuntimeDefault" },
});
const resources = (cpu, memory) => ({ requests: { cpu, memory }, limits: { cpu, memory } });
const configMap = (name, namespace, data) => ({
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: metadata(name, namespace),
  immutable: true,
  data,
});
function pod(profile, name, namespace, role, container) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: metadata(name, namespace, role),
    spec: {
      nodeName: profile.cluster.nodeName,
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
      shareProcessNamespace: false,
      enableServiceLinks: false,
      automountServiceAccountToken: false,
      restartPolicy: "Never",
      terminationGracePeriodSeconds: 5,
      containers: [container],
    },
  };
}

function serverPod(p) {
  const m = p.management;
  const server = pod(p, m.serverPod, m.namespace, "server", {
    name: m.serverContainer,
    image: p.artifacts.managementImage,
    imagePullPolicy: "Never",
    command: [p.paths.spireServerBinary, "run", "-config", "/etc/spire/server.conf"],
    securityContext: security(0),
    resources: resources("500m", "512Mi"),
    volumeMounts: [
      { name: "config", mountPath: "/etc/spire", readOnly: true },
      { name: "data", mountPath: "/var/lib/spire-server" },
    ],
  });
  server.spec.serviceAccountName = m.serverServiceAccount;
  server.spec.automountServiceAccountToken = true;
  server.spec.volumes = [
    { name: "config", configMap: { name: `${m.serverPod}-config` } },
    { name: "data", emptyDir: { sizeLimit: "512Mi" } },
  ];
  return server;
}

// Bootstrap admits only fields already knowable before the genuine Server
// creates its bundle. It cannot be passed as an admitted observation profile.
export function validateServerBootstrap(input, { nowMs = Date.now() } = {}) {
  keys(input, [
    "schemaVersion",
    "stage",
    "sourceCommit",
    "artifacts",
    "cluster",
    "paths",
    "management",
    "deadlineEpochMs",
  ]);
  need(input.schemaVersion === 1 && input.stage === "server-bootstrap");
  string(input.sourceCommit, commit);
  integer(nowMs, 0, Number.MAX_SAFE_INTEGER);
  integer(input.deadlineEpochMs, nowMs + 1, nowMs + LIMITS.operationMs);
  keys(input.artifacts, ["managementImage", "spireServerSHA256"]);
  string(input.artifacts.managementImage, imagePattern, 512);
  string(input.artifacts.spireServerSHA256, sha);
  keys(input.cluster, ["nodeName", "apiIPv4", "apiPort"]);
  string(input.cluster.nodeName, namePattern);
  need(typeof input.cluster.apiIPv4 === "string" && isIP(input.cluster.apiIPv4) === 4);
  integer(input.cluster.apiPort, 1, 65535);
  keys(input.paths, ["spireServerBinary", "serverAdminSocket"]);
  need(
    input.paths.spireServerBinary === "/opt/fixture/spire-server" &&
      input.paths.serverAdminSocket === "/var/lib/spire-server/api.sock",
  );
  const m = input.management;
  keys(m, [
    "namespace",
    "serverPod",
    "serverContainer",
    "serverServiceAccount",
    "agentPod",
    "agentServiceAccount",
    "serverPort",
    "trustDomain",
    "clusterID",
  ]);
  for (const key of [
    "namespace",
    "serverPod",
    "serverContainer",
    "serverServiceAccount",
    "agentPod",
    "agentServiceAccount",
  ])
    string(m[key], namePattern);
  need(m.agentPod !== m.serverPod && m.agentServiceAccount !== m.serverServiceAccount);
  need(`${m.serverPod}-config`.length <= 63);
  integer(m.serverPort, 1, 65535);
  string(m.trustDomain, /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/, 253);
  need(!m.trustDomain.includes(".."));
  string(m.clusterID, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 128);
  return freeze(structuredClone(input));
}

export function buildServerBootstrap(input) {
  const p = validateServerBootstrap(input),
    m = p.management;
  const serverConfig = renderServerConfig(p);
  const manifests = [
    { apiVersion: "v1", kind: "Namespace", metadata: metadata(m.namespace) },
    {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: metadata(m.serverServiceAccount, m.namespace),
      automountServiceAccountToken: false,
    },
    configMap(`${m.serverPod}-config`, m.namespace, { "server.conf": serverConfig }),
    serverPod(p),
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: metadata("default-deny", m.namespace),
      spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"], ingress: [], egress: [] },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: metadata("server-api", m.namespace),
      spec: {
        podSelector: { matchLabels: labels("server") },
        policyTypes: ["Ingress", "Egress"],
        ingress: [
          {
            from: [{ podSelector: { matchLabels: labels("agent") } }],
            ports: [{ protocol: "TCP", port: m.serverPort }],
          },
        ],
        egress: [
          {
            to: [{ ipBlock: { cidr: `${p.cluster.apiIPv4}/32` } }],
            ports: [{ protocol: "TCP", port: p.cluster.apiPort }],
          },
        ],
      },
    },
  ];
  const grant = (name, kind, namespace, rules) => [
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind,
      metadata: metadata(name, namespace),
      rules,
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: `${kind}Binding`,
      metadata: metadata(name, namespace),
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind, name },
      subjects: [{ kind: "ServiceAccount", name: m.serverServiceAccount, namespace: m.namespace }],
    },
  ];
  manifests.push(
    ...grant(`${m.namespace}-psat`, "ClusterRole", undefined, [
      { apiGroups: ["authentication.k8s.io"], resources: ["tokenreviews"], verbs: ["create"] },
      {
        apiGroups: [""],
        resources: ["nodes"],
        resourceNames: [p.cluster.nodeName],
        verbs: ["get"],
      },
    ]),
    ...grant(`${m.namespace}-psat-pods`, "Role", m.namespace, [
      { apiGroups: [""], resources: ["pods"], resourceNames: [m.agentPod], verbs: ["get"] },
    ]),
  );
  return {
    stage: "server-bootstrap",
    serverConfig,
    serverConfigSHA256: createHash("sha256").update(serverConfig).digest("hex"),
    manifests,
  };
}

// This checks declared continuity, not live Kubernetes bytes. Preparation must
// also verify the actual immutable config and unchanged owned Server identity.
export function assertServerBootstrapMatches(bootstrap, profile) {
  const b = validateServerBootstrap(bootstrap),
    p = validateProfile(profile);
  const subsetMatches = (left, right) =>
    left && typeof left === "object"
      ? right &&
        typeof right === "object" &&
        Object.keys(left).every((key) => subsetMatches(left[key], right[key]))
      : left === right;
  for (const key of [
    "schemaVersion",
    "sourceCommit",
    "artifacts",
    "cluster",
    "paths",
    "management",
  ])
    need(subsetMatches(b[key], p[key]));
  need(p.deadlineEpochMs <= b.deadlineEpochMs);
  const initial = buildServerBootstrap(b),
    final = buildManagementManifests(p);
  need(initial.serverConfig === buildServerConfig(p));
  for (const object of initial.manifests) {
    const corresponding = final.find(
      (item) =>
        item.kind === object.kind &&
        item.metadata.name === object.metadata.name &&
        item.metadata.namespace === object.metadata.namespace,
    );
    need(JSON.stringify(corresponding) === JSON.stringify(object));
  }
  return initial.serverConfigSHA256;
}

export function buildHarnessPod(profile, caseName) {
  const p = validateProfile(profile);
  need(caseName === "a" || caseName === "b");
  const c = p.workloads[caseName];
  const result = pod(p, c.podName, p.workloads.namespace, `harness-${caseName}`, {
    name: c.containerName,
    image: p.artifacts.observerImage,
    imagePullPolicy: "Never",
    command: ["node", "-e", "setInterval(() => {}, 1000)"],
    securityContext: security(1000),
    resources: resources("1", "1Gi"),
    volumeMounts: [
      {
        name: "workload-api",
        mountPath: p.paths.socketDirectory,
        readOnly: true,
        mountPropagation: "None",
      },
    ],
  });
  result.spec.runtimeClassName = p.runtime.runtimeClassName;
  result.spec.serviceAccountName = "default";
  result.spec.activeDeadlineSeconds = Math.max(
    1,
    Math.ceil((p.deadlineEpochMs - Date.now()) / 1000),
  );
  result.spec.volumes = [
    { name: "workload-api", hostPath: { path: p.paths.socketDirectory, type: "Directory" } },
  ];
  return result;
}

// A plan for the genuine Server API, not an issued identity or approval. The
// caller must supply the observed Pod UID and actual attested Agent ID.
export function buildRegistration(profile, caseName, podUID, agentID) {
  const p = validateProfile(profile);
  need(caseName === "a" || caseName === "b");
  string(podUID, uidPattern);
  string(agentID, /^spiffe:\/\/[a-z0-9.-]+\/spire\/agent\/k8s_psat\/[A-Za-z0-9._/-]+$/, 512);
  need(
    agentID.startsWith(
      `spiffe://${p.management.trustDomain}/spire/agent/k8s_psat/${p.management.clusterID}/`,
    ),
  );
  string(agentID.slice(agentID.lastIndexOf("/") + 1), uidPattern);
  need(
    agentID ===
      `spiffe://${p.management.trustDomain}/spire/agent/k8s_psat/${p.management.clusterID}/${agentID.slice(agentID.lastIndexOf("/") + 1)}`,
  );
  return {
    parentID: agentID,
    spiffeID: p.workloads[caseName].spiffeID,
    hint: "",
    selectors: [
      { type: "k8s", value: `ns:${p.workloads.namespace}` },
      { type: "k8s", value: `pod-uid:${podUID}` },
      { type: "k8s", value: `container-name:${p.workloads[caseName].containerName}` },
    ],
    ttl: 300,
  };
}

export function buildManagementManifests(profile) {
  const p = validateProfile(profile),
    m = p.management,
    ns = m.namespace;
  const agentConfig = buildAgentConfig(p),
    serverConfig = buildServerConfig(p);
  const agentConfigName = `${m.agentPod}-config`,
    serverConfigName = `${m.serverPod}-config`;
  need(agentConfigName.length <= 63 && serverConfigName.length <= 63);
  const out = [m.namespace, p.workloads.namespace].map((name) => ({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: metadata(name),
  }));
  for (const name of [m.agentServiceAccount, m.serverServiceAccount])
    out.push({
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: metadata(name, ns),
      automountServiceAccountToken: false,
    });
  const grant = (name, kind, namespace, rules, sa) => {
    out.push({
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind,
      metadata: metadata(name, namespace),
      rules,
    });
    out.push({
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: `${kind}Binding`,
      metadata: metadata(name, namespace),
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind, name },
      subjects: [{ kind: "ServiceAccount", name: sa, namespace: ns }],
    });
  };
  grant(
    `${ns}-kubelet`,
    "ClusterRole",
    undefined,
    [
      {
        apiGroups: [""],
        resources: ["nodes/pods"],
        resourceNames: [p.cluster.nodeName],
        verbs: ["get"],
      },
    ],
    m.agentServiceAccount,
  );
  grant(
    `${ns}-psat`,
    "ClusterRole",
    undefined,
    [
      { apiGroups: ["authentication.k8s.io"], resources: ["tokenreviews"], verbs: ["create"] },
      {
        apiGroups: [""],
        resources: ["nodes"],
        resourceNames: [p.cluster.nodeName],
        verbs: ["get"],
      },
    ],
    m.serverServiceAccount,
  );
  grant(
    `${ns}-psat-pods`,
    "Role",
    ns,
    [{ apiGroups: [""], resources: ["pods"], resourceNames: [m.agentPod], verbs: ["get"] }],
    m.serverServiceAccount,
  );
  out.push(
    configMap(agentConfigName, ns, { "agent.conf": agentConfig }),
    configMap(serverConfigName, ns, { "server.conf": serverConfig }),
  );
  const server = serverPod(p);
  const agent = pod(p, m.agentPod, ns, "agent", {
    name: m.agentContainer,
    image: p.artifacts.managementImage,
    imagePullPolicy: "Never",
    command: ["node", p.paths.receiverCollector],
    args: [
      "--binary",
      p.paths.spireAgentBinary,
      "--binary-sha256",
      p.artifacts.spireAgentSHA256,
      "--config",
      "/etc/spire/agent.conf",
      "--config-sha256",
      createHash("sha256").update(agentConfig).digest("hex"),
      "--lifetime-ms",
      String(Math.max(1, p.deadlineEpochMs - Date.now())),
      "--settle-ms",
      String(LIMITS.settleMs),
    ],
    securityContext: security(0),
    resources: resources("500m", "512Mi"),
    volumeMounts: [
      { name: "config", mountPath: "/etc/spire", readOnly: true },
      { name: "data", mountPath: "/var/lib/spire-agent" },
      { name: "workload-api", mountPath: p.paths.socketDirectory, mountPropagation: "None" },
      { name: "trust-bundle", mountPath: "/etc/spire-bundle", readOnly: true },
      { name: "kubelet-ca", mountPath: "/etc/kubelet-ca", readOnly: true },
      { name: "psat", mountPath: "/var/run/spire-psat", readOnly: true },
      { name: "kubelet-token", mountPath: "/var/run/kubelet-token", readOnly: true },
    ],
  });
  agent.spec.hostPID = true;
  agent.spec.serviceAccountName = m.agentServiceAccount;
  const token = (name, audience) => ({
    name,
    projected: {
      defaultMode: 256,
      sources: [{ serviceAccountToken: { path: "token", audience, expirationSeconds: 600 } }],
    },
  });
  agent.spec.volumes = [
    { name: "config", configMap: { name: agentConfigName } },
    { name: "data", emptyDir: { sizeLimit: "512Mi" } },
    { name: "workload-api", hostPath: { path: p.paths.socketDirectory, type: "Directory" } },
    { name: "trust-bundle", configMap: { name: m.trustBundleConfigMap } },
    { name: "kubelet-ca", configMap: { name: m.kubeletCAConfigMap } },
    token("psat", "spire-server"),
    token("kubelet-token", m.kubeletAudience),
  ];
  out.push(server, agent);
  const policy = (name, namespace, selector, ingress, egress) => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: metadata(name, namespace),
    spec: { podSelector: selector, policyTypes: ["Ingress", "Egress"], ingress, egress },
  });
  out.push(
    policy("default-deny", ns, {}, [], []),
    policy("default-deny", p.workloads.namespace, {}, [], []),
  );
  const destination = (ip, port) => ({
    to: [{ ipBlock: { cidr: `${ip}/32` } }],
    ports: [{ protocol: "TCP", port }],
  });
  out.push(
    policy(
      "agent-egress",
      ns,
      { matchLabels: labels("agent") },
      [],
      [destination(m.serverIPv4, m.serverPort), destination(p.cluster.nodeIPv4, 10250)],
    ),
  );
  out.push(
    policy(
      "server-api",
      ns,
      { matchLabels: labels("server") },
      [
        {
          from: [{ podSelector: { matchLabels: labels("agent") } }],
          ports: [{ protocol: "TCP", port: m.serverPort }],
        },
      ],
      [destination(p.cluster.apiIPv4, p.cluster.apiPort)],
    ),
  );
  return out;
}

// This rejects additional privilege surfaces; callers also compare the actual
// Pod against all required fields in the expected manifest.
export class PodSecurityError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function validatePodSecurity(actual, expected) {
  const need = (condition, code) => {
    if (!condition) throw new PodSecurityError(code);
  };
  need(
    actual && expected && !actual.initContainers?.length && !actual.ephemeralContainers?.length,
    "UNREVIEWED_EXTRA_CONTAINER",
  );
  need(
    !actual.securityContext || Object.keys(actual.securityContext).length === 0,
    "UNREVIEWED_POD_SECURITY_CONTEXT",
  );
  need(actual.shareProcessNamespace !== true, "UNREVIEWED_PROCESS_NAMESPACE");
  need(actual.containers?.length === expected.containers.length, "UNREVIEWED_EXTRA_CONTAINER");
  for (let i = 0; i < actual.containers.length; i++) {
    const c = actual.containers[i],
      e = expected.containers[i],
      security = c.securityContext;
    need(
      security &&
        security.privileged !== true &&
        (!security.procMount || security.procMount === "Default"),
      "UNREVIEWED_CONTAINER_PRIVILEGE",
    );
    const allowed = new Set([...Object.keys(e.securityContext), "privileged", "procMount"]);
    need(
      Object.keys(security).every((k) => allowed.has(k)),
      "UNREVIEWED_SECURITY_CONTEXT_FIELD",
    );
    need(
      security.capabilities &&
        Object.keys(security.capabilities).every((k) => ["drop", "add"].includes(k)) &&
        (!security.capabilities.add || security.capabilities.add.length === 0),
      "UNREVIEWED_ADDED_CAPABILITY",
    );
    need(
      security.seccompProfile?.type === "RuntimeDefault" &&
        Object.keys(security.seccompProfile).length === 1,
      "UNREVIEWED_SECCOMP_PROFILE",
    );
    for (const key of [
      "env",
      "envFrom",
      "volumeDevices",
      "lifecycle",
      "startupProbe",
      "readinessProbe",
      "livenessProbe",
      "ports",
      "workingDir",
      "restartPolicy",
    ])
      need(!Object.hasOwn(c, key), "UNREVIEWED_CONTAINER_FIELD");
    need(c.stdin !== true && c.tty !== true && c.stdinOnce !== true, "UNREVIEWED_CONTAINER_INPUT");
    need(c.volumeMounts?.length === e.volumeMounts.length, "UNREVIEWED_CONTAINER_MOUNT");
    for (const mount of c.volumeMounts) {
      need(
        !Object.hasOwn(mount, "subPath") &&
          !Object.hasOwn(mount, "subPathExpr") &&
          (!mount.mountPropagation || mount.mountPropagation === "None") &&
          !Object.hasOwn(mount, "recursiveReadOnly"),
        "UNREVIEWED_MOUNT_MODE",
      );
    }
    need(
      Object.keys(c.resources ?? {}).every((k) => ["requests", "limits"].includes(k)),
      "UNREVIEWED_RESOURCES",
    );
    for (const kind of ["requests", "limits"])
      need(
        Object.keys(c.resources?.[kind] ?? {}).every((k) => Object.hasOwn(e.resources[kind], k)),
        "UNREVIEWED_RESOURCE_REQUEST",
      );
  }
  return true;
}

export class ObservedLifetimeError extends Error {
  constructor() {
    super("OBSERVED_LIFETIME_INVALID");
    this.code = "OBSERVED_LIFETIME_INVALID";
  }
}

// Compare the original admitted duration with actual Kubernetes creation/start
// metadata. The fixed tolerance never changes the profile's absolute deadline.
export function validateObservedLifetime(
  kind,
  createdAt,
  startedAt,
  lifetimeMs,
  deadlineEpochMs,
  nowMs = Date.now(),
) {
  const clockToleranceMs = 5_000;
  const require = (condition) => {
    if (!condition) throw new ObservedLifetimeError();
  };
  const timestamp = (value) => {
    require(
      typeof value === "string" &&
        value.length <= 40 &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value),
    );
    const parsed = Date.parse(value);
    require(Number.isSafeInteger(parsed) && parsed >= 0);
    require(new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19));
    return parsed;
  };
  require(kind === "pod" || kind === "agent");
  require(Number.isSafeInteger(nowMs) && nowMs >= 0);
  require(Number.isSafeInteger(deadlineEpochMs) && deadlineEpochMs > 0);
  require(Number.isSafeInteger(lifetimeMs) && lifetimeMs > 0 && lifetimeMs <= LIMITS.operationMs);
  const createdAtMs = timestamp(createdAt),
    startedAtMs = timestamp(startedAt);
  require(createdAtMs <= nowMs + clockToleranceMs && startedAtMs <= nowMs + clockToleranceMs);
  require(startedAtMs >= createdAtMs - clockToleranceMs);
  const computedExpiryEpochMs = Math.max(createdAtMs, startedAtMs) + lifetimeMs;
  require(Number.isSafeInteger(computedExpiryEpochMs));
  require(computedExpiryEpochMs <= deadlineEpochMs + clockToleranceMs);
  return Object.freeze({
    kind,
    createdAtMs,
    startedAtMs,
    lifetimeMs,
    deadlineEpochMs,
    computedExpiryEpochMs,
    clockToleranceMs,
  });
}
