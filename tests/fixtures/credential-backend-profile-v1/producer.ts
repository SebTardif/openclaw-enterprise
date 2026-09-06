/** Compile-only owner composition. Every operational port is supplied by its
 * real owner; this fixture creates no credential backend or successful issuer.
 */
import {
  parseCredentialBackendProfileV1,
  type CredentialBackendLocalBindingsV1,
  type CredentialBackendModelProjectionV1,
} from "@openclaw-enterprise/contracts/credential-backend-profile-v1";
import type { SecretDriver } from "@openclaw-enterprise/contracts/drivers/secret";
import type { AccountVersionVectorV1 } from "@openclaw-enterprise/contracts/account-authority-v1";
import type {
  CredentialCachePartitionV1,
  CredentialSecretBindingV1,
  CredentialStorageBackendRequirementsV1,
  CredentialStorageDependenciesV1,
  OutstandingTokenInventoryPortV1,
  ProtectedCredentialPortV1,
  ProtectedModelBindingV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";

export function ownerBindingExample(
  profileInput: unknown,
  secretDriver: SecretDriver,
  protectedCredentials: ProtectedCredentialPortV1,
  inventory: OutstandingTokenInventoryPortV1,
): CredentialBackendLocalBindingsV1 {
  const dependencies: CredentialStorageDependenciesV1 = { secretDriver };
  const profile = parseCredentialBackendProfileV1(profileInput);
  const requirements: CredentialStorageBackendRequirementsV1 = profile.requirements;
  void requirements;
  // Parsing cannot validate the actual injected implementations, authorize use,
  // or prove their owner-known outer commit / custody / currentness guarantees.
  return { profile, dependencies, protectedCredentials, inventory };
}

export function modelProjectionExample(
  accountVersions: AccountVersionVectorV1,
  binding: CredentialSecretBindingV1,
  modelBinding: ProtectedModelBindingV1,
  cachePartition: Extract<CredentialCachePartitionV1, { purpose: "model-use" }>,
): CredentialBackendModelProjectionV1 {
  return { accountVersions, binding, modelBinding, cachePartition };
}
