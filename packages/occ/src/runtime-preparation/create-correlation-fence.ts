// Exact declaration extraction from the accepted original native and State owners.
// This module constructs no lease, authenticates no caller, and performs no I/O.
import type { ExactCreateEffectV1, RuntimeReadCallV1 } from "@openclaw-enterprise/contracts";
import type { CurrentRuntimeServiceTrust } from "../runtime-authority/service-trust-schema.ts";
import type { RuntimePreparationCreateCorrelationRetainedV1 } from "./create-reference.ts";
import type {
  RuntimeCreateCorrelationAuthorityV1,
  RuntimeCreateCorrelationLeaseV1,
  RuntimeCreateCorrelationNativeSourceV1,
  RuntimeCreateCorrelationObservationV1,
  RuntimeCreateCorrelationOperationV1,
  RuntimeCreateCorrelationOwnerV1,
  RuntimeCreateCorrelationReferenceV1,
  RuntimeCreateCorrelationSourceContextV1,
} from "./create-correlation.ts";

/** Proposed exact protected-owner construction seam, NOT an installed issuer.
 * TODO(CTL15 protected effect owner): supply genuine writer-custody/encoding
 * qualification for this native operation and selected Compute destination.
 * A caller-created implementation or matching annotations cannot satisfy the
 * original-owner installation obligation. Root must accept that source first. */
export interface NativeCreateCorrelationProtectedEffectParticipantV1 {
  acquireCurrentCreateFence(
    expected: ExactCreateEffectV1,
    destination: Readonly<{
      namespace: string;
      uid: string;
      resourceVersion: string;
    }>,
    originalCall: RuntimeReadCallV1,
  ): Promise<NativeCreateCorrelationFenceLeaseV1>;
}
export interface NativeCreateCorrelationFenceLeaseV1 extends RuntimeCreateCorrelationLeaseV1 {
  readonly input: ExactCreateEffectV1;
  readonly destination: Readonly<{ namespace: string; uid: string; resourceVersion: string }>;
  readonly authority: RuntimeCreateCorrelationAuthorityV1;
  readonly observation: RuntimeCreateCorrelationObservationV1;
}

/** Private construction dependency supplied only by the original State owner.
 * These observations confer no native operation or provider authority. */
export interface RuntimeCreateCorrelationHeldRegistryV1 extends CurrentRuntimeServiceTrust {
  assertCurrent(): undefined;
}
export interface RuntimeCreateCorrelationStateParticipantV1 {
  assertAccept(
    context: RuntimeCreateCorrelationSourceContextV1,
    operation: RuntimeCreateCorrelationOperationV1,
    call: RuntimeReadCallV1,
  ): undefined;
  assertReadCurrent(
    context: RuntimeCreateCorrelationSourceContextV1,
    reference: RuntimeCreateCorrelationReferenceV1,
    call: RuntimeReadCallV1,
  ): undefined;
  acquireRegistry(
    context: RuntimeCreateCorrelationSourceContextV1,
    authority: RuntimeCreateCorrelationAuthorityV1,
  ): Promise<RuntimeCreateCorrelationHeldRegistryV1>;
  assertRetained(
    context: RuntimeCreateCorrelationSourceContextV1,
    retained: RuntimePreparationCreateCorrelationRetainedV1,
  ): undefined;
}
/** Create through PostgresPlatformState.runtimeCreateCorrelationBindingV1().
 * The original native constructor captures participant; bindOriginalSource is
 * called once, before any owner exists. It is never an enrollment mutator. */
export interface RuntimeCreateCorrelationStateBindingV1 {
  readonly participant: RuntimeCreateCorrelationStateParticipantV1;
  bindOriginalSource(
    source: RuntimeCreateCorrelationNativeSourceV1,
  ): RuntimeCreateCorrelationOwnerV1;
}
