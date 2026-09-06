// Existing resource-accounting synthetic values are reused as data, never production defaults.
export {
  envelope as resourceEnvelope,
  supplied,
  unavailable,
  required,
  vector,
  resourceInputs,
  selectedRequirements,
} from "../runtime-resource-accounting-v1/values.mjs";

export function resourceRequirements() {
  return {
    requests: { cpu: "250m", memory: "512Mi", "ephemeral-storage": "256Mi" },
    limits: { cpu: "1", memory: "1Gi", "ephemeral-storage": "1Gi" },
  };
}
