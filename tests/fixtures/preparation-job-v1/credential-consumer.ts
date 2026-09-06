import type { RepositoryPreparationReceiptPortV1 } from "@openclaw-enterprise/contracts/repository-preparation-v1";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type { RuntimeEffectClockV1 } from "@openclaw-enterprise/contracts/runtime-effects-v1";
import type {
  PreparationJobIdentityV1,
  PreparationJobReleaseV1,
} from "@openclaw-enterprise/contracts/preparation-job-v1";
import { parsePreparationJobReceiptPairV1 } from "@openclaw-enterprise/contracts/preparation-job-codec-v1";

// Compile-time consumer of the REAL credential-owned port and nominal handle.
// This returns diagnostic correspondence, never a readiness/credential capability.
export async function compareCurrentReceipt(
  receipts: RepositoryPreparationReceiptPortV1,
  release: PreparationJobReleaseV1,
  identity: PreparationJobIdentityV1,
  call: AuthorityCallV1,
  clock: () => RuntimeEffectClockV1,
) {
  const original = release.original.checkout;
  const result = await receipts.readReceiptV1(original, call);
  if (result.status !== "complete") return result;
  const pair = parsePreparationJobReceiptPairV1(
    { schemaVersion: 1, release, identity, receipt: result.receipt },
    release,
    clock(),
  );
  const current = await receipts.assertCurrentReceiptV1(original, result, call);
  if (current.status !== "complete") return current;
  if (
    current.receipt.receiptRef !== result.receipt.receiptRef ||
    current.receipt.receiptVersion !== result.receipt.receiptVersion
  )
    throw new Error("Receipt changed during comparison");
  return parsePreparationJobReceiptPairV1({ ...pair, receipt: current.receipt }, release, clock());
}
