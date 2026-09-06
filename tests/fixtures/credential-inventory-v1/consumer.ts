import type {
  CredentialInventoryMintClaimPortV1,
  MintClaimInputV1,
} from "@openclaw-enterprise/occ/credential-inventory-v1/ports";
import type { CurrentCredentialAuthorityV1 } from "@openclaw-enterprise/contracts/credential-authority-v1";
import type { CredentialStorageCallBoundsV1 } from "@openclaw-enterprise/contracts/credential-storage-v1";
import { bindCredentialInventoryBackendV1 } from "@openclaw-enterprise/occ/credential-inventory-v1/backend";
export { bindCredentialInventoryBackendV1 };
/** A known claim only permits proceeding to the accepting owner's fresh callback
 * comparison; readback or an existing claim never issues provider authority. */
export async function claim(
  inventory: CredentialInventoryMintClaimPortV1,
  input: MintClaimInputV1,
  authority: CurrentCredentialAuthorityV1,
  bounds: CredentialStorageCallBoundsV1,
) {
  const result = await inventory.claimProviderMintV1(input, authority, bounds);
  return result.kind === "claimed"
    ? { kind: "fresh-current-owner-check-required" as const, claim: result.claim }
    : { kind: "provider-callback-withheld" as const, result };
}
