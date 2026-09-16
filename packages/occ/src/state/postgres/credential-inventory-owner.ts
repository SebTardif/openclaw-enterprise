import { randomUUID } from "node:crypto";
import type { PlatformStateStore, PlatformUnitOfWork } from "../platform-state.ts";
import type { PostgresQueryClient } from "../postgres-work-queue.ts";
export interface CredentialInventoryMetadataTransactionOwnerV1 extends PlatformStateStore {
  queryInTransaction(
    unit: PlatformUnitOfWork,
    statement: string,
    parameters?: readonly unknown[],
  ): ReturnType<PostgresQueryClient["query"]>;
}
import { ScopeViolationError } from "../../errors.ts";
import { CredentialInventoryOwnerPhaseV1 } from "../../credential-inventory-v1/phase.ts";
import {
  createPostgresCredentialInventoryV1,
  preparePostgresCredentialInventoryScopeV1,
  preparePostgresCredentialInventoryKeysV1,
  type PostgresCredentialInventoryContextV1,
  type PostgresCredentialInventoryKeySetV1,
} from "./credential-inventory.ts";
import type {
  CredentialInventoryTransactionV1,
  InventoryScopeV1,
} from "../../credential-inventory-v1/ports.ts";
const emptyKeys = (): PostgresCredentialInventoryKeySetV1 => ({
  operations: [],
  records: [],
  mintClaims: [],
  revocationClaims: [],
});
/** Trusted metadata component only. Scope and historical observations confer no
 * authority. The returned value becomes committed only after the original outer
 * transact resolves. Unknown COMMIT propagates; never retry without reconciliation. */
export async function transactCredentialInventoryMetadataV1<T>(
  store: CredentialInventoryMetadataTransactionOwnerV1,
  scope: InventoryScopeV1,
  work: (repository: CredentialInventoryTransactionV1) => Promise<T>,
  {
    keys = emptyKeys(),
    commitRef = randomUUID(),
  }: { keys?: PostgresCredentialInventoryKeySetV1; commitRef?: string } = {},
): Promise<T> {
  scope = Object.freeze({ ...scope });
  keys = Object.freeze(
    Object.fromEntries(
      Object.entries(keys).map(([kind, refs]) => [kind, Object.freeze([...refs])]),
    ),
  ) as unknown as PostgresCredentialInventoryKeySetV1;
  return store.transact(async (unit) => {
    const phase = new CredentialInventoryOwnerPhaseV1();
    let preparation: "scope" | "keys" | "complete" = "scope";
    const context: PostgresCredentialInventoryContextV1 = {
      scope: { installationId: scope.installationId, namespaceId: scope.namespaceId },
      inventoryScope: scope,
      commitRef,
      transaction: { assertActive: () => phase.assertOperationActive() },
      query: {
        query: (statement, parameters) => store.queryInTransaction(unit, statement, parameters),
      },
      phase: {
        assertActive() {
          phase.assertOperationActive();
          if (preparation !== "complete")
            throw new ScopeViolationError("Inventory preparation is incomplete.");
        },
        assertWriting() {
          this.assertActive();
        },
        assertPreparing(stage) {
          phase.assertOperationActive();
          if (preparation !== stage)
            throw new ScopeViolationError("Inventory preparation is out of order.");
        },
        runOperation: (work) => phase.runOperation(work),
        poison: (error) => phase.poison(error),
        recordEffect: () => phase.assertOperationActive(),
      },
    };
    const repository = createPostgresCredentialInventoryV1(context);
    try {
      const value = await phase.runTransition(async () => {
        await phase.runAcceptance(async () => {
          await preparePostgresCredentialInventoryScopeV1(context);
          preparation = "keys";
          await preparePostgresCredentialInventoryKeysV1(context, keys);
          preparation = "complete";
          // Preparation admits metadata scheduling only; no authority is accepted.
          return true;
        });
        return work(repository);
      });
      await phase.drainAccepted();
      await phase.runFinalization(async () => phase.assertOperationActive());
      await phase.drainAccepted();
      phase.assertCommitReady();
      return value;
    } finally {
      // Poison survives caught failures and prevents the outer COMMIT.
      phase.close();
    }
  });
}
