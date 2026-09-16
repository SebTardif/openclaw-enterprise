import type { EphemeralTokenHandleV1 } from "@openclaw-enterprise/contracts";
import type { Bounds } from "./handles.ts";
import type { SealedMaterial } from "./issuance.ts";
import type { RetainedSchemaValue } from "./schema.ts";

export type { Bounds } from "./handles.ts";
export type { SealedMaterial } from "./issuance.ts";

/** Complete immutable envelope correspondence. Original nested target, profile,
 * configuration and observation retain their exact schemas and digests. This is
 * data, never Work/IAM admission, committed retention or request-use authority. */
export interface IssuedMaterialContextV1 extends Pick<
  SealedMaterial,
  | "materialId"
  | "attemptId"
  | "accessId"
  | "leaseId"
  | "definition"
  | "connectionId"
  | "connectionGeneration"
  | "target"
  | "profile"
  | "observation"
  | "keyId"
  | "keyDigest"
> {
  readonly purpose: "root-execution" | "preparation";
  readonly bindingDigest: string;
  readonly configuration: RetainedSchemaValue;
}

/** Trusted serialization projection of the original protected custody owner.
 * Implementations authenticate original handle/context identity, enforce bounds,
 * drain callbacks and wipe owned bytes. Borrowed bytes must stay in the callback.
 * captureOpened is reserved for fully authenticated envelope opening. */
export interface OriginalIssuedMaterialCustodyV1 {
  withCaptured<T>(
    handle: EphemeralTokenHandleV1,
    bounds: Bounds,
    use: (bytes: Uint8Array) => Promise<T>,
  ): Promise<T>;
  captureOpened(
    bytes: Uint8Array,
    context: IssuedMaterialContextV1,
    bounds: Bounds,
  ): EphemeralTokenHandleV1;
}

/** The concrete adapter must authenticate complete context, retained exact keys
 * and ciphertext before reopening an original custody handle. Seal/open grants
 * no known-COMMIT evidence, retained credential or protected request capability. */
export interface SqlEnvelopeOwnerV1 {
  sealIssuedMaterialV1(
    context: IssuedMaterialContextV1,
    material: EphemeralTokenHandleV1,
    bounds: Bounds,
  ): Promise<SealedMaterial>;
  withIssuedMaterialV1<T>(
    context: IssuedMaterialContextV1,
    sealed: SealedMaterial,
    bounds: Bounds,
    use: (material: EphemeralTokenHandleV1) => Promise<T>,
  ): Promise<T>;
}
