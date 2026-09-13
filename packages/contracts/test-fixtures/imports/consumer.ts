import { SecretReference, SecretBinding, SecretBindings } from "@openclaw-enterprise/contracts";
import { Check } from "typebox/value";

// Each root export must work as both its resource type and runtime validation schema.
export function validateSecrets(
  reference: SecretReference,
  binding: SecretBinding,
  bindings: SecretBindings,
): boolean {
  return (
    Check(SecretReference, reference) &&
    Check(SecretBinding, binding) &&
    Check(SecretBindings, bindings)
  );
}
