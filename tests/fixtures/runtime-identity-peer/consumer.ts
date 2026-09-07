import type { RuntimeAuthorityCallBoundsV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type {
  RuntimeWorkloadVerifierV1,
  RuntimeWorkloadExpectationV1,
  TrustedRuntimeRegistrationReaderV1,
  RuntimeWorkloadDiagnosticV1,
  VerifiedWorkloadV1,
} from "@openclaw-enterprise/contracts/runtime-identity-v1";
import {
  createRuntimeWorkloadVerifierV1,
  type RuntimeNativeConnectionInspectorV1,
} from "../../../packages/occ/src/runtime-identity/peer-verifier-v1.ts";

export function install<C extends object>(
  native: RuntimeNativeConnectionInspectorV1<C>,
  registration: TrustedRuntimeRegistrationReaderV1<C>,
): RuntimeWorkloadVerifierV1<C> {
  return createRuntimeWorkloadVerifierV1({ native, registration });
}
export async function originalConnection<C extends object>(
  verifier: RuntimeWorkloadVerifierV1<C>,
  connection: C,
  expectation: RuntimeWorkloadExpectationV1,
  call: RuntimeAuthorityCallBoundsV1,
) {
  const first = await verifier.verify(connection, expectation, call);
  if (first.kind !== "verified") return first;
  return verifier.inspect(first.proof, call);
}
export function rejectDiagnostics(diagnostic: RuntimeWorkloadDiagnosticV1) {
  // @ts-expect-error Diagnostic parsing has no original verifier/transport ownership.
  const proof: VerifiedWorkloadV1 = diagnostic;
  // @ts-expect-error No default native or registration issuer exists.
  createRuntimeWorkloadVerifierV1({});
  return proof;
}
