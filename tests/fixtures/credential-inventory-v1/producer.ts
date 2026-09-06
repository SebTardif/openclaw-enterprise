import {
  createCredentialInventoryV1,
  type CredentialInventoryDependenciesV1,
} from "@openclaw-enterprise/occ/credential-inventory-v1/inventory";
import type { OutstandingTokenInventoryPortV1 } from "@openclaw-enterprise/contracts/credential-storage-v1";
import type { CredentialInventoryMintClaimPortV1 } from "@openclaw-enterprise/occ/credential-inventory-v1/ports";
/** Compile-only actual owner injection; no handle, backend or currentness factory. */
export function compose(
  dependencies: CredentialInventoryDependenciesV1,
): OutstandingTokenInventoryPortV1 & CredentialInventoryMintClaimPortV1 {
  return createCredentialInventoryV1(dependencies);
}
