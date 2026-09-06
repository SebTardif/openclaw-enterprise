import type {
  NormalizedResourceRequirements,
  ResourceEnvelopeNormalizationResult,
} from "../../../apps/controller/src/drivers/compute/kubernetes/resources/resource-normalization.ts";
import type {
  RuntimeResourceDiagnosticInput,
  RuntimeResourceDiagnostics,
} from "../../../apps/controller/src/drivers/compute/kubernetes/resource-diagnostics.ts";

export function rejectMutableOrAuthoritativeOutput(
  resources: NormalizedResourceRequirements,
  result: ResourceEnvelopeNormalizationResult,
  diagnostic: RuntimeResourceDiagnostics,
  input: RuntimeResourceDiagnosticInput,
): void {
  // @ts-expect-error Normalized requirements are deeply readonly.
  resources.limits.cpu = "1";
  // @ts-expect-error Unknown effects cannot become successful stop evidence.
  const stopped: "stopped" = diagnostic.effectOutcome;
  // @ts-expect-error Diagnostics never grant admission authority.
  const admitted: "admitted" = diagnostic.authority;
  // @ts-expect-error Effective resource evidence has no available producer.
  const metered: "available" = diagnostic.effectiveResources;
  // @ts-expect-error A caller cannot substitute an informal observation DTO.
  const informal: RuntimeResourceDiagnosticInput["expected"] = { component: "harness" };
  if (result.status === "invalid") {
    // @ts-expect-error Invalid normalization has no envelope to consume.
    const envelope: NonNullable<ResourceEnvelopeNormalizationResult["envelope"]> = result.envelope;
    void envelope;
  }
  if (result.envelope !== null) {
    // @ts-expect-error Preserved accepted envelope quantities are deeply readonly.
    result.envelope.envelopeVersion = 2;
  }
  void stopped;
  void admitted;
  void metered;
  void informal;
  void input;
}
