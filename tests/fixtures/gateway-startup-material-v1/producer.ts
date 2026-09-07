import type { GatewayCompositionInput } from "../../../apps/gateway/src/composition.ts";
import type {
  GatewayMaterialSelectionV1,
  GatewayMaterialSourceLeaseV1,
  GatewayMaterialSourceV1,
} from "../../../apps/gateway/src/startup-material.ts";

/** Compile-only integration example. Every positive value is supplied by the
 * original protected reader; this fixture implements no secret or authority. */
export interface OriginalProtectedReader {
  assertCurrent(): undefined;
  remainingMs(): number;
  read(
    selection: GatewayMaterialSelectionV1,
    signal: AbortSignal,
  ): Promise<{
    readonly actualSelection: GatewayMaterialSelectionV1;
    readonly composition: GatewayCompositionInput;
    readonly invalidated: AbortSignal;
    assertCurrent(): undefined;
    remainingMs(): number;
    release(): Promise<Readonly<{ cleanup: "finished" | "failed" | "unknown" }>>;
  }>;
}

export function bindOriginalReader(reader: OriginalProtectedReader): GatewayMaterialSourceV1 {
  return {
    assertCurrent: reader.assertCurrent.bind(reader),
    remainingMs: reader.remainingMs.bind(reader),
    async acquire(selection, signal): Promise<GatewayMaterialSourceLeaseV1> {
      const original = await reader.read(selection, signal);
      // Capture late results; the borrower's custody retains their release.
      return {
        observed: original.actualSelection,
        input: original.composition,
        signal: original.invalidated,
        assertCurrent: original.assertCurrent.bind(original),
        remainingMs: original.remainingMs.bind(original),
        release: original.release.bind(original),
      };
    },
  };
}

// @ts-expect-error Mutable metadata is not the protected source capability.
const metadataSource: GatewayMaterialSourceV1 = { secretName: "named-version" };
void metadataSource;
// @ts-expect-error A Boolean is not the required original synchronous fence.
const booleanFence: GatewayMaterialSourceV1["assertCurrent"] = () => true;
void booleanFence;
