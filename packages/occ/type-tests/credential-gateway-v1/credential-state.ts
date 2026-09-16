import type {
  PostgresPlatformState,
  PlatformReadView,
  PlatformStateStore,
} from "@openclaw-enterprise/occ";
import type {
  CredentialCommitOutcomeV1,
  KnownCredentialCommitV1,
  OriginalCredentialStateBinderV1,
  OriginalCredentialUnitV1,
  PlatformUnitOfWork,
} from "@openclaw-enterprise/occ/internal/credential-state-v1";
import type { LocalHandle } from "../../src/credential-gateway-v1/handles.ts";
import type {
  IssuanceStateDependencies,
  IssuanceRetentionTransaction,
  KnownIssuanceCommit,
} from "../../src/credential-gateway-v1/issuance.ts";
import type { CredentialInventoryTransactionV1 } from "../../src/credential-inventory-v1/ports.ts";
import type { PostgresQueryClient } from "../../src/state/postgres-work-queue.ts";

// These named receiving checkpoints compile original declared operands. They do
// not supply downstream admission, accepting inventory or retention bodies.
export function actualProducer(producer: PostgresPlatformState): OriginalCredentialStateBinderV1 {
  return producer;
}

export function crd03AdmissionReceivingOperand<T>(
  originalState: Pick<OriginalCredentialStateBinderV1, "bindCredentialUnitIn">,
  uow: PlatformUnitOfWork,
  consume: (unit: OriginalCredentialUnitV1) => Promise<T>,
): Promise<T> {
  const unit = originalState.bindCredentialUnitIn(uow);
  const nominal: LocalHandle<"original-credential-unit-v1"> = unit;
  void nominal;
  return unit.run(() => consume(unit));
}

export function crd04RetentionReceivingOperand(
  originalState: OriginalCredentialStateBinderV1,
  uow: PlatformUnitOfWork,
  issuance: IssuanceStateDependencies,
): IssuanceRetentionTransaction {
  const unit = originalState.bindCredentialUnitIn(uow);
  return issuance.bindTransaction(unit.uow);
}

export function crd41InventoryReceivingOperand(
  unit: OriginalCredentialUnitV1,
  repository: CredentialInventoryTransactionV1,
): ReturnType<CredentialInventoryTransactionV1["liveCounts"]> {
  const borrowedQuery: PostgresQueryClient = unit;
  void borrowedQuery;
  return unit.run(() => repository.liveCounts());
}

export async function credentialNegativeBoundaries(
  binder: OriginalCredentialStateBinderV1,
  base: PlatformStateStore,
  read: PlatformReadView,
  unit: OriginalCredentialUnitV1,
  commit: KnownCredentialCommitV1,
): Promise<CredentialCommitOutcomeV1> {
  // @ts-expect-error A base store is not the separately supplied original State binder.
  const wrongOwner: OriginalCredentialStateBinderV1 = base;
  // @ts-expect-error Original read views cannot become mutable transaction operands.
  binder.bindCredentialUnitIn(read);
  // @ts-expect-error Unit construction belongs to the original nominal owner.
  const copiedBrand: OriginalCredentialUnitV1 = { uow: unit.uow, run: unit.run, query: unit.query };
  // @ts-expect-error Original State evidence does not specialize inventory/envelope issuance identities.
  const issuance: KnownIssuanceCommit = commit;
  // @ts-expect-error A preallocated reference cannot establish outer COMMIT.
  const allocated: KnownCredentialCommitV1 = "preallocated";
  // @ts-expect-error Borrowers have no lifetime finishing surface.
  unit.lifetime.finish();
  // @ts-expect-error Borrowers have no raw connection COMMIT surface.
  unit.client.query("COMMIT");
  // @ts-expect-error Binding accepts only the exact original UoW operand.
  binder.bindCredentialUnitIn(unit.uow, {});
  void [wrongOwner, copiedBrand, issuance, allocated];
  return binder.recognizeCredentialCommit(unit);
}
