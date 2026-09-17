import type { EphemeralTokenHandleV1 } from "@openclaw-enterprise/contracts";
import type {
  Bounds,
  IssuedMaterialContextV1,
  OriginalIssuedMaterialCustodyV1,
  SealedMaterial,
  SqlEnvelopeOwnerV1,
} from "@openclaw-enterprise/occ/internal/credential-material-v1";
import type {
  Bounds as OriginalBounds,
  RetainedCredential,
} from "../../src/credential-gateway-v1/handles.ts";
import type { SealedMaterial as OriginalSealedMaterial } from "../../src/credential-gateway-v1/issuance.ts";
import type { RetainedSchemaValue } from "../../src/credential-gateway-v1/schema.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type OptionalKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? K : never }[keyof T];
export type FullImmutableContext = Assert<
  Equal<
    keyof IssuedMaterialContextV1,
    | "purpose"
    | "bindingDigest"
    | "materialId"
    | "attemptId"
    | "accessId"
    | "leaseId"
    | "definition"
    | "connectionId"
    | "connectionGeneration"
    | "target"
    | "profile"
    | "configuration"
    | "observation"
    | "keyId"
    | "keyDigest"
  >
>;
export type RequiredContext = Assert<Equal<OptionalKeys<IssuedMaterialContextV1>, never>>;
export type OriginalBoundsExport = Assert<Equal<Bounds, OriginalBounds>>;
export type OriginalEnvelopeExport = Assert<Equal<SealedMaterial, OriginalSealedMaterial>>;
export type OriginalConfiguration = Assert<
  Equal<IssuedMaterialContextV1["configuration"], RetainedSchemaValue>
>;
export type OriginalOpaqueGeneration = Assert<
  Equal<IssuedMaterialContextV1["connectionGeneration"], string>
>;

// Independent published call signatures retain the original token brand and
// generic result correspondence even if a future implementation widens results.
export type CapturedCallbackContract = Assert<
  Equal<
    OriginalIssuedMaterialCustodyV1["withCaptured"],
    <T>(
      handle: EphemeralTokenHandleV1,
      bounds: Bounds,
      use: (bytes: Uint8Array) => Promise<T>,
    ) => Promise<T>
  >
>;
export type OpenedCaptureContract = Assert<
  Equal<
    OriginalIssuedMaterialCustodyV1["captureOpened"],
    (bytes: Uint8Array, context: IssuedMaterialContextV1, bounds: Bounds) => EphemeralTokenHandleV1
  >
>;
export type SealingContract = Assert<
  Equal<
    SqlEnvelopeOwnerV1["sealIssuedMaterialV1"],
    (
      context: IssuedMaterialContextV1,
      material: EphemeralTokenHandleV1,
      bounds: Bounds,
    ) => Promise<OriginalSealedMaterial>
  >
>;
export type OpenedCallbackContract = Assert<
  Equal<
    SqlEnvelopeOwnerV1["withIssuedMaterialV1"],
    <T>(
      context: IssuedMaterialContextV1,
      sealed: OriginalSealedMaterial,
      bounds: Bounds,
      use: (material: EphemeralTokenHandleV1) => Promise<T>,
    ) => Promise<T>
  >
>;

declare const foreignTokenBrand: unique symbol;
type ForeignToken = { readonly [foreignTokenBrand]: true };

// Compiler-only: authentic operands are supplied, never fixture-minted. The two
// generic callbacks must preserve distinct result types through the real ports.
export async function completeMaterialPorts(
  custody: OriginalIssuedMaterialCustodyV1,
  envelopes: SqlEnvelopeOwnerV1,
  context: IssuedMaterialContextV1,
  handle: EphemeralTokenHandleV1,
  sealed: SealedMaterial,
  bounds: Bounds,
  bytes: Uint8Array,
  foreign: ForeignToken,
  retained: RetainedCredential,
): Promise<void> {
  (await custody.withCaptured(handle, bounds, async (value) => value.byteLength)) satisfies number;
  (await custody.withCaptured(handle, bounds, async () => "borrowed")) satisfies string;
  const opened: EphemeralTokenHandleV1 = custody.captureOpened(bytes, context, bounds);
  (await envelopes.sealIssuedMaterialV1(context, handle, bounds)) satisfies OriginalSealedMaterial;
  (await envelopes.withIssuedMaterialV1(context, sealed, bounds, async (material) => {
    material satisfies EphemeralTokenHandleV1;
    return "opened";
  })) satisfies string;
  (await envelopes.withIssuedMaterialV1(context, sealed, bounds, (material) =>
    custody.withCaptured(material, bounds, async (value) => ({ length: value.byteLength })),
  )) satisfies { readonly length: number };
  // @ts-expect-error A foreign nominal token cannot enter the original custody owner.
  custody.withCaptured(foreign, bounds, async (value) => value.byteLength);
  // @ts-expect-error A foreign nominal token cannot be sealed as original material.
  envelopes.sealIssuedMaterialV1(context, foreign, bounds);
  // @ts-expect-error Committed retention and transient custody handles are distinct.
  custody.withCaptured(retained, bounds, async (value) => value.byteLength);
  // @ts-expect-error Plain data cannot manufacture the original token brand.
  ({}) satisfies EphemeralTokenHandleV1;
  // @ts-expect-error Reopened custody is not a committed retained credential.
  opened satisfies RetainedCredential;
  // @ts-expect-error Opening returns the original token, never plaintext bytes.
  opened satisfies Uint8Array;
  // @ts-expect-error Custody callbacks require asynchronous settlement.
  custody.withCaptured(handle, bounds, (value) => value.byteLength);
  envelopes.withIssuedMaterialV1(
    context,
    sealed,
    bounds,
    // @ts-expect-error Envelope callbacks receive an original token, not raw bytes.
    async (value: Uint8Array) => value.byteLength,
  );
}

export function immutableContextNegatives(context: IssuedMaterialContextV1): void {
  const { purpose, ...missingPurpose } = context;
  const { bindingDigest, ...missingBinding } = context;
  const { configuration, ...missingConfiguration } = context;
  const { observation, ...missingObservation } = context;
  const { keyDigest, ...missingRetainedKey } = context;
  // @ts-expect-error Root/preparation purpose is mandatory immutable context.
  missingPurpose satisfies IssuedMaterialContextV1;
  // @ts-expect-error Full original binding correspondence is mandatory.
  missingBinding satisfies IssuedMaterialContextV1;
  // @ts-expect-error Configuration retains its original schema and digest.
  missingConfiguration satisfies IssuedMaterialContextV1;
  // @ts-expect-error The original observation cannot be reconstructed later.
  missingObservation satisfies IssuedMaterialContextV1;
  // @ts-expect-error Retained key digest cannot be omitted.
  missingRetainedKey satisfies IssuedMaterialContextV1;
  ({
    ...context,
    // @ts-expect-error Cipher purpose is not Work/preparation context purpose.
    purpose: "github-installation-token-v1",
  }) satisfies IssuedMaterialContextV1;
  // @ts-expect-error Opaque connection generations cannot become numbers.
  ({ ...context, connectionGeneration: 1 }) satisfies IssuedMaterialContextV1;
  // @ts-expect-error Full retained profile/schema cannot collapse to an ID.
  ({ ...context, profile: "profile-id" }) satisfies IssuedMaterialContextV1;
  ({
    ...context,
    // @ts-expect-error Complete configuration cannot collapse to its digest.
    configuration: context.configuration.digest,
  }) satisfies IssuedMaterialContextV1;
  // @ts-expect-error Context fields are immutable after original selection.
  context.keyId = "replacement-key";
}
