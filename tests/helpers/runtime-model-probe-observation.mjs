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

export function modelProbeDiagnostic(snapshot, reason) {
  const probe = snapshot.probe ?? {};
  return {
    ...modelProbeTimeoutDiagnostic(snapshot),
    reason,
    running: snapshot.running,
    pluginReadyObserved: observed(snapshot.events, "plugin", "ready"),
    probeStage: snapshot.probeStage ?? "not-observed",
    capMs: probe.capMs,
    elapsedMs: probe.elapsedMs,
    cpuWaitMs: probe.cpuWaitMs,
    loadClientsStarted: 0,
  };
}
