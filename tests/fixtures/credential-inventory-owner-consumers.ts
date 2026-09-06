import {
  createCredentialInventoryReadProjectionV1,
  type CredentialInventorySafeReadV1,
  type PlatformReadView,
} from "../../packages/occ/src/ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "../../packages/occ/src/ports/platform-unit-of-work.ts";
import type {
  CredentialInventoryTransactionOwnerV1,
  CredentialInventoryTransactionV1,
  CredentialInventoryAcceptingOwnerV1,
  InventoryCommitV1,
  InventoryScopeV1,
} from "../../packages/occ/src/credential-inventory-v1/ports.ts";
import type { CredentialStorageCallBoundsV1 } from "@openclaw-enterprise/contracts/credential-storage-v1";

declare const transaction: CredentialInventoryTransactionV1;
declare const assertAcceptedRead: () => void;
declare const owner: CredentialInventoryTransactionOwnerV1;
declare const acceptingOwner: CredentialInventoryAcceptingOwnerV1;
declare const scope: InventoryScopeV1;
declare const bounds: CredentialStorageCallBoundsV1;
declare const readView: PlatformReadView;
declare const unit: PlatformUnitOfWork;

const result: Promise<InventoryCommitV1<number>> = owner.run(scope, bounds, async (tx) => {
  tx.assertActive();
  return 7;
});
const projection: CredentialInventorySafeReadV1 = createCredentialInventoryReadProjectionV1(
  transaction,
  assertAcceptedRead,
);
void result;
void acceptingOwner.acceptCurrent;
void acceptingOwner.acceptMitigation;
void acceptingOwner.acceptRead;
void projection.findOperation;
void projection.findRecord;
void projection.liveCounts;
void projection.listLive;
void projection.findMintClaim;
void projection.findRevocationClaim;
void projection.findSnapshot;
// @ts-expect-error Metadata reads cannot load protected material.
void projection.loadRevocationToken;
// @ts-expect-error Metadata reads cannot stage protected material.
void projection.retainToken;
// @ts-expect-error Metadata reads cannot issue accepting audit effects.
void projection.appendAudit;
// @ts-expect-error Metadata reads expose no mutation capability.
void projection.insertSnapshot;
// @ts-expect-error Metadata reads expose no raw query.
void projection.query;
// @ts-expect-error Ordinary platform reads gain no inventory authority.
void readView.credentialInventory;
// @ts-expect-error Ordinary platform mutation units gain no inventory facade.
void unit.credentialInventory;
