import { createHash } from "node:crypto";

export const REGISTRY_VERSION = "release-registry/v2";
export const OUTCOMES = ["pass", "fail", "blocked", "skipped", "unrun"];
export const CLASSES = ["source", "unit", "static", "render", "smoke", "probe", "live"];

// These are fixture requirements, not claims that the component fixtures exist.
const definitions = [
  [
    "R1",
    "installation",
    "operations",
    [
      [
        "public-install",
        "positive",
        "A second engineer installs the exact public Kubernetes, gVisor systrap/STRICT and standalone SPIRE profile without KVM or nested virtualization and completes the example.",
      ],
      [
        "private-dependency",
        "denial",
        "Setup needs no private identity service or undocumented intervention.",
      ],
      [
        "missing-prerequisite",
        "failure",
        "Missing prerequisites produce actionable sanitized diagnostics.",
      ],
    ],
  ],
  [
    "R2",
    "revision",
    "control-plane",
    [
      [
        "immutable-revision",
        "positive",
        "Draft changes preserve revision A; deploy B and distinguish admission from observed serving.",
      ],
      ["wrong-namespace", "denial", "Cross-Namespace references are refused."],
      ["activation-failure", "failure", "Failed activation is visible and does not claim serving."],
    ],
  ],
  [
    "R3",
    "collaboration",
    "collaboration",
    [
      [
        "two-person-work",
        "positive",
        "Two verified people complete repository work and a follow-up using real Codex tools and saved context/workspace.",
      ],
      [
        "unauthorized-followup",
        "denial",
        "An unauthorized sender cannot borrow the conversation's authority.",
      ],
      [
        "delivery-failure",
        "failure",
        "Delivery failure is visible without routing output to another conversation.",
      ],
    ],
  ],
  [
    "R4",
    "authorization",
    "authorization",
    [
      [
        "exact-authority",
        "positive",
        "Every invoke/read/grant use retains verified human and exact workload scope.",
      ],
      [
        "wrong-authority",
        "denial",
        "Disallowed sender, Namespace, Agent and stale or invalid workload identity are denied.",
      ],
      [
        "restart-denial",
        "failure",
        "Denials remain effective through supported restart and unavailable authority dependencies.",
      ],
    ],
  ],
  [
    "R5",
    "credential-exposure",
    "credentials",
    [
      [
        "native-ephemeral",
        "positive",
        "Native clients use only scoped ephemeral GitHub tokens with safe client-managed handling.",
      ],
      [
        "platform-canaries",
        "denial",
        "Platform long-lived credential canaries are absent from reachable state, children, workspace, logs and artifacts.",
      ],
      [
        "malicious-output",
        "failure",
        "Malicious operations cannot expose platform credentials through outputs; native token runtime memory visibility is not claimed absent.",
      ],
    ],
  ],
  [
    "R6",
    "access-profile",
    "containment",
    [
      [
        "native-routes",
        "positive",
        "Mediated model calls and explicitly permitted native GitHub API/GraphQL/HTTPS Git operations work.",
      ],
      [
        "route-bypass",
        "denial",
        "Direct model, cross-scope and unsupported routes, DNS/IP/IPv6/redirect/proxy escape are denied.",
      ],
      [
        "no-downgrade",
        "failure",
        "Dependency outage or unsupported profile fails closed without a silent fallback.",
      ],
    ],
  ],
  [
    "R7",
    "revoke",
    "credentials",
    [
      [
        "local-denial",
        "positive",
        "Measure disable-to-new-dispatch/issuance/mediated-denial against the proposed 60-second target.",
      ],
      [
        "native-token-disposition",
        "denial",
        "Record each outstanding native token's provider-confirmed revocation or explicit unknown/expiry; no unconditional off-sandbox 60-second guarantee.",
      ],
      [
        "execution-outcome",
        "failure",
        "Record stream/execution interruption or unknown effects and retained workspace.",
      ],
    ],
  ],
  [
    "R8",
    "reconciliation",
    "control-plane",
    [
      [
        "recover-revision",
        "positive",
        "API/worker restart before and after prepare/activation reaches the admitted revision or explicit failure.",
      ],
      [
        "preserve-routing",
        "denial",
        "Recovery retains channel restrictions and refuses cross-Agent routing.",
      ],
      [
        "interrupted-activation",
        "failure",
        "Interrupted activation remains distinguishable from observed serving.",
      ],
    ],
  ],
  [
    "R9",
    "stop",
    "runtime",
    [
      [
        "durable-stop",
        "positive",
        "Stop survives worker restart, removes active routing and prevents automatic recreation.",
      ],
      ["post-stop-dispatch", "denial", "Stopped runtime cannot accept new work."],
      [
        "termination-unknown",
        "failure",
        "Termination is observed or explicitly unknown with failure, never inferred from request acceptance.",
      ],
    ],
  ],
  [
    "R10",
    "continuity",
    "persistence",
    [
      [
        "disconnect-restart",
        "positive",
        "A disconnects; B continues; supported gateway and harness restart preserves Agent mapping, completed context and workspace.",
      ],
      ["no-tool-replay", "denial", "Ambiguous tool effects are not silently replayed."],
      [
        "interruption-purge",
        "failure",
        "Interrupted work is visible and purge effects have separate intentional assertions.",
      ],
    ],
  ],
  [
    "R11",
    "bounded-operation",
    "operations",
    [
      [
        "resource-envelope",
        "positive",
        "Measure one-Agent/two-person CPU, memory, concurrency, time, storage and output bounds.",
      ],
      ["second-agent-isolation", "denial", "A separate second-Agent fixture verifies isolation."],
      [
        "safe-diagnostics",
        "failure",
        "Launch, denial, busy/queued, unreachable, exhausted storage and audit sink failures remain diagnosable without sensitive content.",
      ],
    ],
  ],
  [
    "R12",
    "package",
    "operations",
    [
      [
        "clean-build-example",
        "positive",
        "Clean public build, installation and example verify pinned artifact checksums.",
      ],
      [
        "unsafe-artifact",
        "denial",
        "Unsafe or unavailable artifacts and unresolved redistribution findings block release.",
      ],
      [
        "maintenance-inventory",
        "failure",
        "License/dependency/SBOM inventory, maintainer, intake, limitations and troubleshooting are present and truthful.",
      ],
    ],
  ],
  [
    "R13",
    "gvisor",
    "runtime",
    [
      [
        "actual-gvisor",
        "positive",
        "Observe the workload executing through verified runsc and containerd-shim-runsc-v1. Bind the complete installed six-member archive/hash closure, including gvisor-bin/checkpointgofer, gvisor-bin/gvisor-sentry-prewarmer, gvisor-bin/gvisor_sentry and gvisor-bin/runsc-metric-server. Record distinct actual runsc/shim version outputs and the companions selected or invoked for the fixture's operations; do not require every conditional helper to execute or invent per-helper version interfaces. Retain one intended Harness across provision, update and stop.",
      ],
      [
        "effective-handler",
        "positive",
        "Observe occ/kubernetes-gvisor with isolationProfile gvisor-systrap, RuntimeClass and handler oce-gvisor-systrap, runtimeType io.containerd.runsc.v1, platform systrap and sidecar-usage-policy STRICT. Bind effective node handler arguments/environment and final admitted shape to the configuration digest; require a Compute-owned dedicated Harness Deployment and separate trusted gateway.",
      ],
      [
        "companion-selection",
        "denial",
        "Deny substituted binaries, unauthorized GVISOR_SIDECAR_BINARIES_DIR and directory/environment overrides. Freeze and exercise the separate sidecar-release-enforcement-policy and GVISOR_ENFORCE_RELEASE behavior; STRICT alone excludes embedded companion fallback and does not pin companion resolution or release matching. These companions are host runtime programs, not Kubernetes sidecars.",
      ],
      [
        "containment-controls",
        "denial",
        "Observe approved process, privilege, filesystem/mount, network and resource controls, including gateway-private state separation. A RuntimeClass label, readiness or userspace-kernel selection alone does not prove effective controls, VM-equivalent isolation or hardware attestation.",
      ],
      [
        "missing-handler",
        "failure",
        "Missing or substituted handler, unsafe final shape, embedded placement, SandboxDriver composition or required control failure denies activation without ordinary-container fallback. Later OpenShell/Kata qualification cannot replace current gVisor evidence.",
      ],
    ],
  ],
  [
    "R14",
    "workload-identity",
    "identity",
    [
      [
        "standalone-spire",
        "positive",
        "Two Agents receive distinct authorized identities through an implemented standalone SPIRE enrollment, delivery and verifier path for the actual gVisor sandbox/component. Bind server-owned installation, Namespace, Agent, revision, component, assignment and generation; a shared host Workload API socket, ServiceAccount or label does not prove the executing workload.",
      ],
      [
        "direct-provider-binding",
        "positive",
        "Bind the Compute-owned Deployment UID, cluster reference, Namespace UID, exact ReplicaSet/Deployment ancestry, Pod UID, trusted runsc sandbox identity and a separate required process execution discriminator to the preallocated create effect. Preserve original observation time/freshness and exact runtime, image, policy, resource and store references. openShellSandboxId is absent only for the explicitly admitted typed direct-gVisor Harness profile; absence grants no authority.",
      ],
      [
        "forged-identity",
        "denial",
        "Wrong trust domain, forged assignment, wrong Agent, substituted execution instance and retired generation are denied. Readiness, runtimeclass strings, Pod labels, projected tokens and shared host sockets cannot substitute for protected workload identity and currentness evidence.",
      ],
      [
        "identity-lifecycle",
        "failure",
        "Exercise issuance, rotation, expiration, runtime replacement and dependency outage for the actual bound workload. A Harness process/container restart under the same Pod UID, even with unchanged sandbox identity, requires fresh assignment, binding and identity evidence; predecessor authority cannot be reused.",
      ],
    ],
  ],
  [
    "R15",
    "identity-adapter",
    "identity",
    [
      [
        "same-adapter",
        "positive",
        "Exercise trust-domain, bundle, registration and Workload API configuration through the same adapter; standalone R14 remains required.",
      ],
      ["bad-configuration", "denial", "Invalid trust and registration configuration fails closed."],
      [
        "provider-outage",
        "failure",
        "Report unavailable provider configuration without claiming validation.",
      ],
    ],
  ],
  [
    "R16",
    "turn-ordering",
    "collaboration",
    [
      [
        "overlap",
        "positive",
        "Overlapping requests preserve attribution and permit at most one mutating turn per workspace with visible queued/busy/terminal outcomes.",
      ],
      [
        "duplicate-leakage",
        "denial",
        "Duplicate delivery does not repeat work; unauthorized follow-up and cross-context replies are refused.",
      ],
      [
        "queue-interruption",
        "failure",
        "Bounded queued work runs or receives a visible interrupted/cancelled/unknown outcome.",
      ],
    ],
  ],
];

const channelGates = new Set(["R3", "R10", "R16"]);
const cases = definitions.flatMap(([requirement, name, producer, assertions]) => {
  const channels = channelGates.has(requirement) ? ["slack", "teams"] : ["none"];
  return channels.map((channel) => ({
    id: `${requirement.toLowerCase()}-${name}${channel === "none" ? "" : `-${channel}`}`,
    requirement,
    channel,
    producer,
    required: true,
    profile: "kubernetes-gvisor-systrap-strict-standalone-spire-native",
    executionClass: "live",
    fixture: { id: `${producer}-${name}-v2`, status: "to-build", adapter: "pending" },
    prerequisites: [
      "component-fixture",
      "accepted-assertions",
      "frozen-inputs",
      "operator-environment",
      "identified-executor",
      ...(channel === "none" ? [] : [`${channel}-application`, "two-authorized-participants"]),
    ],
    assertions: assertions.map(([id, kind, description]) => ({ id, kind, description })),
  }));
});
cases.push({
  ...cases.find((item) => item.requirement === "R15"),
  id: "r15-operator-managed-provider",
  required: false,
  profile: "kubernetes-gvisor-systrap-strict-operator-managed-spire-native",
  fixture: { id: "identity-operator-managed-provider-v2", status: "to-build", adapter: "pending" },
  prerequisites: [
    "component-fixture",
    "accepted-assertions",
    "frozen-inputs",
    "operator-environment",
    "identified-executor",
    "selected-provider-environment",
  ],
});

export function registry() {
  return structuredClone({ version: REGISTRY_VERSION, cases });
}
export const REGISTRY_DIGEST = `sha256:${createHash("sha256").update(JSON.stringify(registry())).digest("hex")}`;
export function validateRegistry(value) {
  if (JSON.stringify(value) !== JSON.stringify(registry())) throw new Error("registry-mismatch");
  return true;
}
export function emptyCounts() {
  return Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
}
