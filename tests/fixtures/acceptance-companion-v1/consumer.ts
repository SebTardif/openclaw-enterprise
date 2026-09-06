import type {
  AcceptanceClassV1,
  AcceptanceOutcomeV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-v1";
import {
  bindProducerReceiptV1,
  decodeAssertionCompanionV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-codec-v1";

/** Independently compiled reader; byte integrity never becomes execution authority. */
export function readClaim(
  companion: Uint8Array,
  receipt: Uint8Array,
):
  | {
      outcome: AcceptanceOutcomeV1 | null;
      declaredClass: AcceptanceClassV1 | null;
      authentication: "unverified";
    }
  | { error: string } {
  const binding = bindProducerReceiptV1(companion, receipt);
  if (!binding.ok) return { error: binding.code };
  const value = binding.receipt.value;
  return {
    outcome: value.outcome,
    declaredClass: value.execution.state === "observed" ? value.execution.executionClass : null,
    authentication: binding.authentication,
  };
}

export function cannotMutate(companion: Uint8Array): void {
  const decoded = decodeAssertionCompanionV1(companion);
  if (!decoded.ok) return;
  // @ts-expect-error A consumer cannot mutate decoded evidence identity.
  decoded.identity.sha256 = "replacement";
  // @ts-expect-error Nested metadata is immutable as well.
  decoded.value.leaf.required = false;
  // @ts-expect-error Structural parsing does not return authenticated provenance.
  const trusted: "authenticated" = decoded.authentication;
  void trusted;
}
