import type {
  CurrentCredentialAuthorityV1,
  CredentialMitigationHandleV1,
} from "@openclaw-enterprise/contracts/credential-authority-v1";
import type {
  EphemeralTokenHandleV1,
  MintOutcomeV1,
  OutstandingTokenInventoryPortV1,
  CredentialStorageCallBoundsV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import type {
  CredentialInventoryMintClaimPortV1,
  MintClaimInputV1,
} from "@openclaw-enterprise/occ/credential-inventory-v1/ports";
declare const inventory: OutstandingTokenInventoryPortV1 & CredentialInventoryMintClaimPortV1;
declare const accepted: Extract<MintOutcomeV1, { outcome: "accepted" }>;
declare const unknown: Extract<MintOutcomeV1, { outcome: "unknown" }>;
declare const responsibility: CredentialMitigationHandleV1;
declare const token: EphemeralTokenHandleV1;
declare const bounds: CredentialStorageCallBoundsV1;
declare const mint: MintClaimInputV1;
// @ts-expect-error A diagnostic object is not current authority.
const fabricated: CurrentCredentialAuthorityV1 = { handle: {}, observation: {} };
// @ts-expect-error Accepted token metadata requires a nominal custody handle.
inventory.recordMintOutcomeV1(accepted, responsibility, undefined, bounds);
// @ts-expect-error Unknown outcome cannot carry token custody.
inventory.recordMintOutcomeV1(unknown, responsibility, token, bounds);
// @ts-expect-error A mitigation handle is not current original-turn authority.
inventory.claimProviderMintV1(mint, responsibility, bounds);
// @ts-expect-error A current authority pair cannot be reconstructed from readback.
inventory.claimProviderMintV1(mint, { kind: "found", nextAction: "observation-only" }, bounds);
void fabricated;
