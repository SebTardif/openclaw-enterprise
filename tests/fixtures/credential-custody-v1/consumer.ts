import type { NamedCredentialCustodyV1 } from "@openclaw-enterprise/occ/credential-custody-v1/custody";
import type {
  ProtectedCredentialPortV1,
  NamedCredentialUseV1,
  CredentialMaterialHandleV1,
  CredentialStorageCallBoundsV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import type { CurrentCredentialAuthorityV1 } from "@openclaw-enterprise/contracts/credential-authority-v1";

/** Supplied startup-registered callback stays in its protected process. */
export function invoke<T>(
  owner: NamedCredentialCustodyV1,
  request: NamedCredentialUseV1,
  authority: CurrentCredentialAuthorityV1,
  fixedConsumer: (handle: CredentialMaterialHandleV1) => Promise<T>,
  bounds: CredentialStorageCallBoundsV1,
) {
  const accepted: ProtectedCredentialPortV1 = owner;
  return accepted.withNamedCredentialV1(request, authority, fixedConsumer, bounds);
}
