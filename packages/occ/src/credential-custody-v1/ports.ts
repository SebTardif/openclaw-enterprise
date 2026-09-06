import { parseCredentialStorageV1 } from "@openclaw-enterprise/contracts/credential-storage-v1";
import type { SecretDriver } from "@openclaw-enterprise/contracts/drivers/secret";
import type { SecretBackendRef, Secret } from "@openclaw-enterprise/contracts/resources/secret";
import type { CredentialBackendProfileV1 } from "@openclaw-enterprise/contracts/credential-backend-profile-v1";
import type {
  CurrentCredentialAuthorityV1,
  CredentialManagementHandleV1,
} from "@openclaw-enterprise/contracts/credential-authority-v1";
import type {
  BindingMutationResultV1,
  CredentialCachePartitionV1,
  CredentialMaterialHandleV1,
  CredentialSecretBindingV1,
  CredentialStorageCallBoundsV1,
  CredentialStorageFailureV1,
  CredentialUseResultV1,
  NamedCredentialUseV1,
  RotateCredentialBindingV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import type {
  ProviderAccountLinkKey,
  ProviderAccountLink,
  ProviderAccountLinksAccess,
} from "../ports/provider-account-links.ts";

import type { SecretReadRepository } from "../ports/repositories/secret.ts";
import type { ServiceAccountReadRepository } from "../ports/repositories/service-account.ts";

/** Exact selection from the existing trusted owner, never a public selector.
 * Installation and read lifetime remain with that owner's ambient composition.
 * The provider-account driver and Secret driver are distinct identities. */
export interface NamedCredentialMetadataSelectionV1 {
  readonly secretId: string;
  readonly secretDriverId: string;
  readonly accountKey: ProviderAccountLinkKey;
}
export interface NamedCredentialMetadataDependenciesV1 {
  readonly secrets: Pick<SecretReadRepository, "findSecret">;
  readonly accounts: Pick<
    ServiceAccountReadRepository,
    "findServiceAccount" | "findServiceAccountProviderBinding"
  >;
  readonly accountLinks: ProviderAccountLinksAccess;
  readonly secretDriver: Pick<SecretDriver, "id" | "resolve">;
}
/** An observation only: no logical binding, immutable version, profile,
 * current authority or protected material can be inferred from these fields. */
export type NamedCredentialMetadataResultV1 =
  | CredentialStorageFailureV1
  | Readonly<{
      kind: "metadata-observed";
      selection: NamedCredentialMetadataSelectionV1;
      backendRef: SecretBackendRef;
      credentialIssued: boolean;
      accountLink: ProviderAccountLink;
      namedCapabilities: Readonly<{
        authenticatedExactNamedAccess: Readonly<{
          status: "unsupported";
          reason: "capability-unimplemented";
        }>;
        versionedReadAndRotation: Readonly<{
          status: "unsupported";
          reason: "capability-unimplemented";
        }>;
      }>;
      custody: Extract<CredentialBackendProfileV1["custody"], { kind: "unprovided" }>;
      externalCustody: Readonly<{ status: "unsupported"; reason: "adapter-unprovided" }>;
    }>;

/** Trusted clock error bounds never extend a material lifetime. */
export interface CustodyClockV1 {
  read(): Readonly<{ wallMs: number; monotonicMs: number; uncertaintyMs: number }>;
}
/** Fresh projection from the existing account/Secret owner; values are not authority. */
export interface NamedCustodyProjectionV1 {
  readonly partition: CredentialCachePartitionV1;
  readonly secret: Secret;
  readonly accountKey: ProviderAccountLinkKey;
  readonly accountLink: ProviderAccountLink;
  readonly namedSecret: CredentialBackendProfileV1["namedSecret"];
}
export interface NamedCustodyProjectionOwnerV1 {
  readCurrent(
    binding: CredentialSecretBindingV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<NamedCustodyProjectionV1 | undefined>;
}
/** Transfer one bounded minimum invocation-material lease, never login/refresh
 * state. release synchronously invalidates the handle and wipes adapter-owned
 * mutable buffers. It is idempotent and must not throw. Brands do not authenticate. */
export interface ProtectedMaterialLeaseV1 {
  readonly handle: CredentialMaterialHandleV1;
  readonly partition: CredentialCachePartitionV1;
  readonly byteLength: number;
  readonly expiresAtMs: number;
  release(): void;
}
export interface ImmutableCustodyAdapterV1 {
  readonly kind: "protected-immutable-custody";
  readonly adapter: Extract<
    CredentialBackendProfileV1["custody"],
    { kind: "external-protected-adapter" }
  >["adapter"];
  /** Actual owner authenticates access and exact UID/resourceVersion/immutable
   * version history, bounds allocation, and issues an owner-checked handle. */
  readMinimumInvocation(
    projection: NamedCustodyProjectionV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<ProtectedMaterialLeaseV1>;
  /** Confirms an ALREADY staged version. No import or mutable Secret update.
   * Preserve staged material after ambiguous logical publication. */
  confirmStagedVersion(
    input: RotateCredentialBindingV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<boolean>;
}
/** Existing authority/audit owner authenticates the nominal handle and compares
 * original operation/effect/profile/account/binding/current invalidation, enforces
 * same-journal original-operation idempotency (including unknown outcomes), commits
 * mandatory audit and consumes authority immediately before effect. No cache. */
export interface CustodyUseOwnerV1 {
  withCurrentModelUse<T>(
    input: Extract<NamedCredentialUseV1, { purpose: "model-use" }>,
    authority: CurrentCredentialAuthorityV1,
    effect: () => Promise<T>,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<CredentialUseResultV1<T>>;
}
/** Existing management/journal owner authenticates before staging lookup and
 * rechecks before atomic binding CAS + invalidation + affected scan + audit.
 * Only known OUTER commit can return rotated; ambiguous writes need readback. */
export interface CustodyRotationOwnerV1 {
  checkManagement(
    input: RotateCredentialBindingV1,
    authority: CredentialManagementHandleV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<boolean>;
  commitStagedRotation(
    input: RotateCredentialBindingV1,
    authority: CredentialManagementHandleV1,
    bounds: CredentialStorageCallBoundsV1,
  ): Promise<BindingMutationResultV1>;
}
export type CustodyConsumerV1 = (material: CredentialMaterialHandleV1) => Promise<unknown>;
export interface NamedCredentialCustodyDependenciesV1 {
  readonly profile: CredentialBackendProfileV1;
  readonly secretDriver: SecretDriver;
  readonly accountLinks: ProviderAccountLinksAccess;
  readonly projections: NamedCustodyProjectionOwnerV1;
  readonly clock: CustodyClockV1;
  /** Exact callbacks fixed at trusted startup, outside request data. */
  readonly consumers: readonly CustodyConsumerV1[];
  readonly custody?: ImmutableCustodyAdapterV1;
  readonly useOwner?: CustodyUseOwnerV1;
  readonly rotationOwner?: CustodyRotationOwnerV1;
}
export class CredentialCustodyErrorV1 extends Error {
  readonly failure: CredentialStorageFailureV1;
  constructor(
    failure: CredentialStorageFailureV1 = { kind: "unavailable", reason: "secret-unavailable" },
  ) {
    super("Credential custody unavailable.");
    this.name = "CredentialCustodyErrorV1";
    this.failure = custodyFailureV1(failure);
  }
}

/** Never return fields copied from an exception, even a forged typed exception. */
export function custodyFailureV1(value: unknown): CredentialStorageFailureV1 {
  try {
    const result = parseCredentialStorageV1("useResult", value);
    if (result.kind !== "used" && result.kind !== "effect-unknown") return result;
  } catch {
    /* Closed constant below; no raw exception or input values. */
  }
  return Object.freeze({ kind: "unavailable", reason: "secret-unavailable" });
}

/** Also contain exceptions from forged error-property accessors. */
export function custodyFailureFromErrorV1(error: unknown): CredentialStorageFailureV1 {
  try {
    if (error instanceof CredentialCustodyErrorV1) return custodyFailureV1(error.failure);
  } catch {
    /* A broken error object is not a diagnostic. */
  }
  return Object.freeze({ kind: "unavailable", reason: "secret-unavailable" });
}
