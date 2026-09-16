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
  const length: number = await custody.withCaptured(
    handle,
    bounds,
    async (value) => value.byteLength,
  );
  const label: string = await custody.withCaptured(handle, bounds, async () => "borrowed");
  const opened: EphemeralTokenHandleV1 = custody.captureOpened(bytes, context, bounds);
  const envelope: OriginalSealedMaterial = await envelopes.sealIssuedMaterialV1(
    context,
    handle,
    bounds,
  );
  const reopenedLabel: string = await envelopes.withIssuedMaterialV1(
    context,
    sealed,
    bounds,
    async (material) => {
      const original: EphemeralTokenHandleV1 = material;
      void original;
      return "opened";
    },
  );
  const nested: { readonly length: number } = await envelopes.withIssuedMaterialV1(
    context,
    sealed,
    bounds,
    (material) =>
      custody.withCaptured(material, bounds, async (value) => ({ length: value.byteLength })),
  );
  // @ts-expect-error A foreign nominal token cannot enter the original custody owner.
  custody.withCaptured(foreign, bounds, async (value) => value.byteLength);
  // @ts-expect-error A foreign nominal token cannot be sealed as original material.
  envelopes.sealIssuedMaterialV1(context, foreign, bounds);
  // @ts-expect-error Committed retention and transient custody handles are distinct.
  custody.withCaptured(retained, bounds, async (value) => value.byteLength);
  // @ts-expect-error Plain data cannot manufacture the original token brand.
  const forged: EphemeralTokenHandleV1 = {};
  // @ts-expect-error Reopened custody is not a committed retained credential.
  const committed: RetainedCredential = opened;
  // @ts-expect-error Opening returns the original token, never plaintext bytes.
  const plaintext: Uint8Array = opened;
  // @ts-expect-error Custody callbacks require asynchronous settlement.
  custody.withCaptured(handle, bounds, (value) => value.byteLength);
  envelopes.withIssuedMaterialV1(
    context,
    sealed,
    bounds,
    // @ts-expect-error Envelope callbacks receive an original token, not raw bytes.
    async (value: Uint8Array) => value.byteLength,
  );
  void [length, label, envelope, reopenedLabel, nested, forged, committed, plaintext];
}

export function immutableContextNegatives(context: IssuedMaterialContextV1): void {
  const { purpose, ...missingPurpose } = context;
  const { bindingDigest, ...missingBinding } = context;
  const { configuration, ...missingConfiguration } = context;
  const { observation, ...missingObservation } = context;
  const { keyDigest, ...missingRetainedKey } = context;
  // @ts-expect-error Root/preparation purpose is mandatory immutable context.
  const noPurpose: IssuedMaterialContextV1 = missingPurpose;
  // @ts-expect-error Full original binding correspondence is mandatory.
  const noBinding: IssuedMaterialContextV1 = missingBinding;
  // @ts-expect-error Configuration retains its original schema and digest.
  const noConfiguration: IssuedMaterialContextV1 = missingConfiguration;
  // @ts-expect-error The original observation cannot be reconstructed later.
  const noObservation: IssuedMaterialContextV1 = missingObservation;
  // @ts-expect-error Retained key digest cannot be omitted.
  const noKey: IssuedMaterialContextV1 = missingRetainedKey;
  const wrongPurpose: IssuedMaterialContextV1 = {
    ...context,
    // @ts-expect-error Cipher purpose is not Work/preparation context purpose.
    purpose: "github-installation-token-v1",
  };
  // @ts-expect-error Opaque connection generations cannot become numbers.
  const numericGeneration: IssuedMaterialContextV1 = { ...context, connectionGeneration: 1 };
  // @ts-expect-error Full retained profile/schema cannot collapse to an ID.
  const profileId: IssuedMaterialContextV1 = { ...context, profile: "profile-id" };
  const configurationDigest: IssuedMaterialContextV1 = {
    ...context,
    // @ts-expect-error Complete configuration cannot collapse to its digest.
    configuration: context.configuration.digest,
  };
  // @ts-expect-error Context fields are immutable after original selection.
  context.keyId = "replacement-key";
  void [
    purpose,
    bindingDigest,
    configuration,
    observation,
    keyDigest,
    noPurpose,
    noBinding,
    noConfiguration,
    noObservation,
    noKey,
    wrongPurpose,
    numericGeneration,
    profileId,
    configurationDigest,
  ];
}
