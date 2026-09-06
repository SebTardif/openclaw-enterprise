import type {
  CredentialMaterialHandleV1,
  CredentialCachePartitionV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import type { CurrentCredentialAuthorityV1 } from "@openclaw-enterprise/contracts/credential-authority-v1";
import type {
  ImmutableCustodyAdapterV1,
  ProtectedMaterialLeaseV1,
} from "@openclaw-enterprise/occ/credential-custody-v1/ports";

// @ts-expect-error JSON cannot construct protected material.
const fakeHandle: CredentialMaterialHandleV1 = {};
// @ts-expect-error A parsed observation is not current authority.
const fakeAuthority: CurrentCredentialAuthorityV1 = { observation: {} };
// @ts-expect-error Metadata-only resolution supplies no immutable material adapter.
const metadataCustody: ImmutableCustodyAdapterV1 = { resolve: async () => ({ name: "example" }) };
declare const lease: ProtectedMaterialLeaseV1;
// @ts-expect-error Protected material lease has no bytes accessor.
lease.bytes;
declare const partition: CredentialCachePartitionV1;
// @ts-expect-error No permission decisions in the partition.
partition.authority;
void fakeHandle;
void fakeAuthority;
void metadataCustody;

import type {
  NamedCredentialMetadataResultV1,
  NamedCustodyProjectionV1,
} from "@openclaw-enterprise/occ/credential-custody-v1/ports";
declare const metadata: Extract<NamedCredentialMetadataResultV1, { kind: "metadata-observed" }>;
// @ts-expect-error Metadata cannot supply an immutable logical/account binding.
const inventedProjection: NamedCustodyProjectionV1 = metadata;
// @ts-expect-error Metadata cannot provide the protected adapter.
const inventedAdapter: ImmutableCustodyAdapterV1 = metadata;
// @ts-expect-error Metadata has no immutable secret version.
metadata.secretVersion;
void inventedProjection;
void inventedAdapter;
