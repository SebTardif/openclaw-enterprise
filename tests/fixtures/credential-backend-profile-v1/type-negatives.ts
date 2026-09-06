import type {
  CredentialBackendLocalBindingsV1,
  CredentialBackendProfileV1,
} from "@openclaw-enterprise/contracts/credential-backend-profile-v1";
import type {
  CredentialReadHandleV1,
  CredentialMitigationHandleV1,
} from "@openclaw-enterprise/contracts/credential-authority-v1";
import type {
  CredentialMaterialHandleV1,
  EphemeralTokenHandleV1,
  CredentialSecretBindingV1,
  NamedCredentialUseV1,
  MintOutcomeV1,
  RecordedTokenDeliveryV1,
  CredentialStorageCallBoundsV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";

declare const bindings: CredentialBackendLocalBindingsV1;
declare const request: NamedCredentialUseV1;
declare const read: CredentialReadHandleV1;
declare const mitigation: CredentialMitigationHandleV1;
declare const bounds: CredentialStorageCallBoundsV1;
declare const accepted: Extract<MintOutcomeV1, { outcome: "accepted" }>;
declare const delivery: RecordedTokenDeliveryV1;
declare const versionless: Omit<CredentialSecretBindingV1, "secretVersion">;
declare const profile: CredentialBackendProfileV1;

// @ts-expect-error Credential material is the original nominal handle, never bytes.
const rawMaterial: CredentialMaterialHandleV1 = new Uint8Array(1);
// @ts-expect-error Tokens are not serialized local references.
const serializedToken: EphemeralTokenHandleV1 = { tokenRef: "token/example" };
// @ts-expect-error An account or secret reference without its exact version is insufficient.
const missingVersion: CredentialSecretBindingV1 = versionless;
// @ts-expect-error Remote process placement requires a separate accepted mapping.
const remote: CredentialBackendProfileV1["placement"]["kind"] = "remote-process";
// @ts-expect-error Material handles cannot be substituted for the existing read authority.
const fabricatedRead: CredentialReadHandleV1 = rawMaterial;
// @ts-expect-error Read handles do not authorize model use or minting.
bindings.protectedCredentials.withNamedCredentialV1(request, read, async () => undefined, bounds);
// @ts-expect-error An accepted mint requires protected token custody, not undefined.
bindings.inventory.recordMintOutcomeV1(accepted, mitigation, undefined, bounds);
// @ts-expect-error Raw byte custody is not the existing ephemeral-token handle.
bindings.inventory.recordMintOutcomeV1(accepted, mitigation, new Uint8Array(1), bounds);
// @ts-expect-error Mitigation is not current delivery authority.
bindings.inventory.deliverRecordedTokenV1(delivery, mitigation, async () => undefined, bounds);
// @ts-expect-error The selected metadata audit coupling is same-transaction only.
const outbox: CredentialBackendProfileV1["inventory"]["auditCoupling"] = "durable-outbox";
// @ts-expect-error Unknown capabilities cannot silently widen the requirement set.
profile.capabilities.unrestrictedSecretAccess;
// @ts-expect-error A supported claim names the exact versioned adapter and evidence.
const missingEvidence: CredentialBackendProfileV1["capabilities"]["externalCustody"] = {
  status: "supported",
};
void [serializedToken, missingVersion, remote, fabricatedRead, outbox, missingEvidence];
