import { modelProbeTimeoutDiagnostic } from "./runtime-model-probe-diagnostic.mjs";

const observed = (events, key, value) =>
  events.some((event) => event.event === "observe" && event.key === key && event.value === value);

export function modelProbeSettled({ events }) {
  return (
    events.some(
      (event) =>
        event.event === "observe" &&
        event.key === "runtimeFailure" &&
        event.value !== null &&
        event.value !== undefined,
    ) ||
    (observed(events, "ready", true) && observed(events, "plugin", "ready"))
  );
}

export function modelProbeDiagnostic(snapshot, stress, reason) {
  const probe = snapshot.probe ?? {};
  return {
    ...modelProbeTimeoutDiagnostic(snapshot, {
      submitted: stress?.requested ?? 0,
      settled: stress?.settled ?? 0,
      failed: stress?.rejected ?? 0,
    }),
    reason,
    running: snapshot.running,
    pluginReadyObserved: observed(snapshot.events, "plugin", "ready"),
    probeStage: snapshot.probeStage ?? "not-observed",
    capMs: probe.capMs,
    elapsedMs: probe.elapsedMs,
    cpuWaitMs: probe.cpuWaitMs,
    loadClientsStarted: stress?.started ?? 0,
  };
}

// The marker proves the owned Node process reached its busy loop, not merely
// that a Docker exec request was submitted. Keep no child output or error text.
export function trackProbeCpuHog(operation, stress) {
  stress.requested++;
  let pending = "";
  let started = false;
  let admit;
  const admitted = new Promise((resolve) => {
    admit = resolve;
  });
  operation.child.stdout.on("data", (chunk) => {
    pending = (pending + String(chunk)).slice(-64);
    if (!started && pending.includes("openclaw-cpu-hog-started\n")) {
      started = true;
      stress.started++;
      admit(true);
    }
  });
  const settled = operation.then(
    () => {
      stress.settled++;
      admit(false);
    },
    () => {
      stress.settled++;
      admit(false);
      stress.rejected++;
    },
  );
  return { admitted, settled };
}

// Only the stress fixture uses this gate. The production program stays intact
// and starts in the same process/cgroup after the caller admits all load clients.
export function modelProbeLoadGate(program, marker = "/tmp/openclaw-probe-load-ready") {
  return {
    program: `(() => {
const marker = ${JSON.stringify(marker)};
process.stdout.write("openclaw-probe-load-waiting\\n");
const gate = setInterval(() => {
  if (!require("node:fs").existsSync(marker)) return;
  clearInterval(gate);
  require("node:vm").runInThisContext(${JSON.stringify(program)});
}, 25);
})();`,
    release: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ready\\n", { flag: "wx", mode: 0o600 });`,
  };
}

export async function waitForProbeCpuLoad(load, stress, deadline) {
  const remainingMs = deadline - Date.now();
  if (!Number.isFinite(deadline) || remainingMs <= 0) {
    throw new Error("CPU load admission exceeded its budget.");
  }
  let timer;
  try {
    const admitted = await Promise.race([
      Promise.all(load.map((client) => client.admitted)),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("CPU load admission exceeded its budget.")),
          remainingMs,
        );
      }),
    ]);
    if (Date.now() >= deadline) {
      throw new Error("CPU load admission exceeded its budget.");
    }
    if (
      load.length !== 8 ||
      !admitted.every(Boolean) ||
      stress.started !== 8 ||
      stress.settled !== 0
    ) {
      throw new Error("All eight CPU load clients must be running before the Gateway starts.");
    }
  } finally {
    clearTimeout(timer);
  }
}
