const kubernetesConfigurationFailures = new WeakSet<Error>();

/** Register a normalized validation failure without retaining its upstream cause. */
export function markKubernetesConfigurationFailure<T extends Error>(error: T): T {
  kubernetesConfigurationFailures.add(error);
  return error;
}

/** Only locally registered categories can affect routine startup output. */
export function startupDiagnostic(component: "api" | "worker", error: unknown) {
  const kubernetes =
    typeof error === "object" &&
    error !== null &&
    kubernetesConfigurationFailures.has(error as Error);
  return {
    event: component === "api" ? "startup-error" : "worker.startup-error",
    code: kubernetes ? "KUBERNETES_CONFIGURATION_INVALID" : "STARTUP_FAILED",
    error: kubernetes
      ? "Kubernetes client configuration is unavailable or invalid."
      : "Controller startup failed. Check the configured startup prerequisites.",
  };
}
