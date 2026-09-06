// Synthetic arithmetic vectors, never owner-supplied production reservations.
export const supplied = (value, ownerRef = "fixture-owner") => ({
  status: "supplied",
  ownerRef,
  value,
});
export const unavailable = (ownerRef = "original-owner") => ({
  status: "unavailable",
  ownerRef,
  reason: "owner-input-missing",
});
export const required = (ownerRef = "original-owner") => ({ status: "required", ownerRef });
export const pair = (request, limit = request * 2) => ({ request, limit });
export const vector = (cpu = 100, memory = 1000, ephemeral = 10000) => ({
  cpuMilli: pair(cpu),
  memoryBytes: pair(memory),
  ephemeralStorageBytes: pair(ephemeral),
});
export const resourceInputs = (value = vector()) =>
  Object.fromEntries(Object.entries(value).map(([key, value]) => [key, supplied(value)]));
const cost = (name, kind, values) => ({
  accountingId: name,
  kind,
  resources: resourceInputs(values),
});
export function workload(name) {
  return {
    contributions: [
      cost(`${name}/app`, "application", vector()),
      cost(`${name}/init-a`, "init", vector(200, 3000, 30000)),
      cost(`${name}/init-b`, "init", vector(300, 2000, 20000)),
    ],
    phases: supplied([
      {
        phaseRef: "init-together",
        kind: "initialization",
        active: [`${name}/init-a`, `${name}/init-b`],
      },
      { phaseRef: "steady", kind: "steady", active: [`${name}/app`] },
    ]),
    overhead: supplied(
      name === "gateway"
        ? []
        : [
            {
              accountingId: `${name}/runsc`,
              kind: "runsc",
              chargedTo: "pod",
              resources: resourceInputs(vector(10, 100, 1000)),
            },
          ],
    ),
    podBudget: supplied(vector(600, 6000, 60000)),
    execution: supplied({ maxConcurrentInstances: 1, maxAttempts: 3, totalPreparationMs: 120000 }),
    processes: supplied({
      guestProcessLimit: 40,
      guestProcessBudget: 20,
      podHostTaskLimit: 256,
      podHostTaskBudget: 64,
      hostCoverage: "all-workload-runsc-helper-tasks",
    }),
    logs: supplied({
      storageId: `${name}/logs`,
      maxBytes: 1000,
      maxFileBytes: 200,
      maxFiles: 5,
      maxBytesPerSecond: 100,
      retentionSeconds: 60,
    }),
    storage: supplied([
      {
        accountingId: `${name}/logs`,
        kind: "logs",
        medium: "disk-ephemeral",
        capacityBytes: 2000,
        reservedBytes: 1000,
      },
      {
        accountingId: `${name}/home`,
        kind: "runtime-home",
        medium: "disk-ephemeral",
        capacityBytes: 50000,
        reservedBytes: 40000,
      },
      {
        accountingId: `${name}/tmp`,
        kind: "temporary",
        medium: "memory",
        capacityBytes: 1000,
        reservedBytes: 500,
      },
    ]),
    alternatives: supplied([]),
  };
}
export function envelope() {
  return {
    schemaVersion: 1,
    kind: "runtime-resource-accounting-v1",
    envelopeRef: "fixture-envelope",
    envelopeVersion: 1,
    gateway: supplied(workload("gateway")),
    harness: supplied(workload("harness")),
    repositoryPreparation: supplied(workload("job"), "fixture-job-owner"),
    workloadConcurrency: supplied([
      ["gateway", "harness"],
      ["gateway", "repositoryPreparation"],
    ]),
    externalReservations: Object.fromEntries(
      ["nodeSystem", "spire", "credentialMediator", "database", "ingress", "networkService"].map(
        (name) => [
          name,
          supplied(
            {
              accountingId: `external/${name}`,
              resources: vector(10, 100, 1000),
              hostTasks: 2,
              logBytes: 100,
              retainedStorageBytes: 1000,
            },
            `fixture-${name}-owner`,
          ),
        ],
      ),
    ),
    retainedStores: supplied([
      {
        accountingId: "retained/workspace",
        kind: "workspace",
        medium: "retained",
        capacityBytes: 400000,
        reservedBytes: 400000,
      },
      {
        accountingId: "retained/private",
        kind: "gateway-private",
        medium: "retained",
        capacityBytes: 100000,
        reservedBytes: 100000,
      },
    ]),
    nodeBudget: supplied(vector(10000, 100000, 1000000)),
    nodeHostTaskLimit: supplied(1000),
    observations: {
      gateway: unavailable("compute-observer"),
      harness: unavailable("compute-observer"),
    },
    effectiveResources: { status: "unavailable", reason: "producer-port-unavailable" },
  };
}

/** Selected requirements demonstrate unresolved input handling only. All newly
 * required reservations stay unavailable; no test reservation becomes a default. */
export function selectedRequirements() {
  const result = envelope();
  const Mi = 1024 ** 2;
  const Gi = 1024 ** 3;
  for (const [name, selected] of [
    [
      "gateway",
      {
        cpuMilli: pair(250, 1000),
        memoryBytes: pair(512 * Mi, Gi),
        ephemeralStorageBytes: pair(256 * Mi, Gi),
      },
    ],
    [
      "harness",
      {
        cpuMilli: pair(500, 2000),
        memoryBytes: pair(Gi, 4 * Gi),
        ephemeralStorageBytes: pair(Gi, 4 * Gi),
      },
    ],
  ]) {
    const w = result[name].value;
    w.contributions = [
      cost(`${name}/app`, "application", selected),
      {
        accountingId: `${name}/private-init`,
        kind: "init",
        resources: {
          cpuMilli: supplied(pair(100, 500)),
          memoryBytes: supplied(pair(64 * Mi, 256 * Mi)),
          ephemeralStorageBytes: unavailable("init-owner"),
        },
      },
    ];
    for (const field of [
      "phases",
      "overhead",
      "podBudget",
      "execution",
      "processes",
      "logs",
      "storage",
      "alternatives",
    ])
      w[field] = unavailable(`${field}-owner`);
  }
  result.repositoryPreparation = unavailable("repository-preparation-owner");
  result.workloadConcurrency = unavailable("compute-owner");
  for (const name of Object.keys(result.externalReservations))
    result.externalReservations[name] = unavailable(`${name}-owner`);
  result.retainedStores = unavailable("persistence-owner");
  result.nodeBudget = unavailable("delivery-owner");
  result.nodeHostTaskLimit = unavailable("containment-owner");
  return result;
}
