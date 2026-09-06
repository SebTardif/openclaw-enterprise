import {
  normalizeResourceRequirements,
  normalizeResourceAccountingEnvelope,
  resourceRequirementsFromVector,
  compareResourceRequirements,
  compareResourceQuota,
  type ResourceRequirementsNormalizationResult,
  type ResourceEnvelopeNormalizationResult,
  type NormalizedResourceRequirements,
  type ResourceComparisonResult,
  type ResourceQuotaResult,
} from "../../../apps/controller/src/drivers/compute/kubernetes/resources/resource-normalization.ts";
import {
  validateRuntimeResourceAccountingV1,
  type RuntimeResourceAccountingEnvelopeV1,
  type RuntimeResourceAccountingResultV1,
  type RuntimeResourceVectorV1,
} from "@openclaw-enterprise/contracts/runtime-resource-accounting-v1";

export function produceResources(input: unknown): ResourceRequirementsNormalizationResult {
  return normalizeResourceRequirements(input);
}
export function produceEnvelope(input: unknown): ResourceEnvelopeNormalizationResult {
  return normalizeResourceAccountingEnvelope(input);
}
// The actual accepted resource-accounting consumer receives the normalized immutable envelope.
export function consumeEnvelope(
  input: RuntimeResourceAccountingEnvelopeV1,
): RuntimeResourceAccountingResultV1 {
  return validateRuntimeResourceAccountingV1(input);
}
export function serializeResources(input: RuntimeResourceVectorV1): NormalizedResourceRequirements {
  return resourceRequirementsFromVector(input);
}
export function compareDefaults(
  input: RuntimeResourceVectorV1,
  proposed: unknown,
): ResourceComparisonResult {
  return compareResourceRequirements(input, proposed);
}
export function checkQuota(
  input: RuntimeResourceVectorV1,
  hard: RuntimeResourceVectorV1,
  used: RuntimeResourceVectorV1,
): ResourceQuotaResult {
  return compareResourceQuota(input, hard, used);
}
