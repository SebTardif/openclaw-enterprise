import { createNamedCredentialCustodyV1 } from "@openclaw-enterprise/occ/credential-custody-v1/custody";
import type { NamedCredentialCustodyDependenciesV1 } from "@openclaw-enterprise/occ/credential-custody-v1/ports";
import type { ProtectedCredentialPortV1 } from "@openclaw-enterprise/contracts/credential-storage-v1";

/** Compile-only producer: actual existing owners must supply every capability. */
export function bindCustody(
  dependencies: NamedCredentialCustodyDependenciesV1,
): ProtectedCredentialPortV1 {
  return createNamedCredentialCustodyV1(dependencies);
}

import { readNamedCredentialMetadataV1 } from "@openclaw-enterprise/occ/credential-custody-v1/backend";
import type {
  NamedCredentialMetadataDependenciesV1,
  NamedCredentialMetadataSelectionV1,
} from "@openclaw-enterprise/occ/credential-custody-v1/ports";
import type { SecretReadRepository } from "../../../packages/occ/src/ports/repositories/secret.ts";
import type { ServiceAccountReadRepository } from "../../../packages/occ/src/ports/repositories/service-account.ts";
import type { CredentialStorageCallBoundsV1 } from "@openclaw-enterprise/contracts/credential-storage-v1";

/** Actual canonical repository producers fit without a replacement repository. */
export function readSelectedMetadata(
  secrets: SecretReadRepository,
  accounts: ServiceAccountReadRepository,
  remaining: Pick<NamedCredentialMetadataDependenciesV1, "secretDriver" | "accountLinks">,
  selection: NamedCredentialMetadataSelectionV1,
  bounds: CredentialStorageCallBoundsV1,
) {
  return readNamedCredentialMetadataV1({ secrets, accounts, ...remaining }, selection, bounds);
}
