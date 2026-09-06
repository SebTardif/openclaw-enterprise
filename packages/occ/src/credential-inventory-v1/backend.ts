import {
  assessCredentialBackendProfileV1,
  parseCredentialBackendProfileV1,
} from "@openclaw-enterprise/contracts/credential-backend-profile-v1";
import type { CredentialBackendProfileV1 } from "@openclaw-enterprise/contracts/credential-backend-profile-v1";
import {
  createCredentialInventoryV1,
  type CredentialInventoryDependenciesV1,
} from "./inventory.ts";
import { inventoryDigestV1 } from "./transactions.ts";

/** The existing owner supplies actual composition, never inferred from the
 * capability declaration. This is not a production PostgreSQL adapter. */
export interface CredentialInventoryOwnerBindingV1 {
  readonly profileDigest: string;
  readonly dependencies: CredentialInventoryDependenciesV1;
}
export type CredentialInventoryCompositionV1 =
  | {
      readonly kind: "bound";
      readonly inventory: ReturnType<typeof createCredentialInventoryV1>;
      readonly delivery: "disabled";
      readonly runtimeQualification: "not-established";
    }
  | {
      readonly kind: "unavailable";
      readonly reason:
        | "invalid-profile"
        | "capability-unprovided"
        | "owner-composition-unprovided"
        | "owner-profile-mismatch";
    };

/** Declarations can withhold composition but never provide missing owner objects.
 * Selection does not attest access, encryption, runtime protection or durability. */
export function bindCredentialInventoryBackendV1(
  input: CredentialBackendProfileV1,
  owner?: CredentialInventoryOwnerBindingV1,
): CredentialInventoryCompositionV1 {
  try {
    const profile = parseCredentialBackendProfileV1(input);
    if (
      profile.custody.kind === "unprovided" ||
      assessCredentialBackendProfileV1(profile).kind !== "compatible-declaration"
    )
      return { kind: "unavailable", reason: "capability-unprovided" };
    if (!owner) return { kind: "unavailable", reason: "owner-composition-unprovided" };
    if (inventoryDigestV1(profile) !== owner.profileDigest)
      return { kind: "unavailable", reason: "owner-profile-mismatch" };
    return {
      kind: "bound",
      inventory: createCredentialInventoryV1(owner.dependencies),
      delivery: "disabled",
      runtimeQualification: "not-established",
    };
  } catch {
    return { kind: "unavailable", reason: "invalid-profile" };
  }
}
