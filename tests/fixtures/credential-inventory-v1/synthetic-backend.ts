import { randomUUID } from "node:crypto";
import type {
  CredentialInventoryTransactionOwnerV1,
  CredentialInventoryTransactionV1,
  CredentialInventoryAcceptingOwnerV1,
  InventoryOperationV1,
  ProviderMintClaimV1,
  RetainedRevocationClaimV1,
  InventorySnapshotV1,
  InventoryScopeV1,
  InventoryMutationV1,
} from "../../../packages/occ/src/credential-inventory-v1/ports.ts";
import type {
  CredentialStorageCallBoundsV1,
  OutstandingTokenRecordV1,
  EphemeralTokenHandleV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import type {
  CurrentCredentialAuthorityV1,
  CredentialMitigationHandleV1,
  CredentialReadHandleV1,
} from "@openclaw-enterprise/contracts/credential-authority-v1";
import { createCredentialInventoryV1 } from "../../../packages/occ/src/credential-inventory-v1/inventory.ts";
import {
  inventoryIntentDigestV1,
  inventoryDigestV1,
  isLiveInventoryRecordV1,
} from "../../../packages/occ/src/credential-inventory-v1/transactions.ts";

interface SyntheticState {
  rows: OutstandingTokenRecordV1[];
  operations: InventoryOperationV1[];
  mintClaims: ProviderMintClaimV1[];
  revokeClaims: RetainedRevocationClaimV1[];
  snapshots: InventorySnapshotV1[];
  tokens: string[];
}
/** TEST ONLY. Memory and JSON reconstruction test algorithms, not PostgreSQL,
 * process restart, cryptography, actual authority or protected token custody. */
export class SyntheticInventoryBackendV1 implements CredentialInventoryTransactionOwnerV1 {
  now = Date.parse("2026-01-01T00:00:00.000Z");
  uncertaintyMs = 0;
  audit: "accepted" | "obligation-recorded" | "evidence-missing" = "accepted";
  fault:
    "none" | "unknown-committed" | "unknown-rolled-back" | "unavailable" | "throw-after-commit" =
    "none";
  retainReceipts = true;
  writes = 0;
  auditCalls = 0;
  custodyCalls = 0;
  private state: SyntheticState = {
    rows: [],
    operations: [],
    mintClaims: [],
    revokeClaims: [],
    snapshots: [],
    tokens: [],
  };
  private tail: Promise<void> = Promise.resolve();
  private grants = new WeakMap<object, string>();
  private tokens = new WeakMap<object, string>();
  private lastTransaction?: CredentialInventoryTransactionV1;
  readonly acceptingOwner: CredentialInventoryAcceptingOwnerV1 = {
    acceptCurrent: async (input, authority) =>
      this.grants.get(authority) === inventoryIntentDigestV1(input),
    acceptMitigation: async (input, handle) =>
      this.grants.get(handle) === inventoryIntentDigestV1(input),
    acceptRead: async (input, handle) => this.grants.get(handle) === inventoryDigestV1(input),
  };
  current(input: InventoryMutationV1): CurrentCredentialAuthorityV1 {
    // Explicit synthetic fixture cast; this identity is accepted only by this
    // test owner's WeakMap, and never supplies canonical currentness.
    const value = Object.freeze({
      handle: Object.freeze({}),
      observation: Object.freeze({}),
    }) as unknown as CurrentCredentialAuthorityV1;
    this.grants.set(value, inventoryIntentDigestV1(input));
    return value;
  }
  mitigation(input: InventoryMutationV1): CredentialMitigationHandleV1 {
    const value = Object.freeze({}) as CredentialMitigationHandleV1;
    this.grants.set(value, inventoryIntentDigestV1(input));
    return value;
  }
  reader(input: unknown): CredentialReadHandleV1 {
    const value = Object.freeze({}) as CredentialReadHandleV1;
    this.grants.set(value, inventoryDigestV1(input));
    return value;
  }
  token(tokenRef: string, revocationRef: string): EphemeralTokenHandleV1 {
    const value = Object.freeze({}) as EphemeralTokenHandleV1;
    this.tokens.set(value, tokenRef + ":" + revocationRef);
    return value;
  }
  port() {
    return createCredentialInventoryV1({
      transactions: this,
      acceptingOwner: this.acceptingOwner,
      clock: { read: () => ({ now: this.now, uncertaintyMs: this.uncertaintyMs }) },
    });
  }
  checkpoint(): string {
    return JSON.stringify(this.state);
  }
  restore(checkpoint: string): void {
    this.state = JSON.parse(checkpoint) as SyntheticState;
  }
  records(): readonly OutstandingTokenRecordV1[] {
    return structuredClone(this.state.rows);
  }
  operations(): readonly InventoryOperationV1[] {
    return structuredClone(this.state.operations);
  }
  assertClosed(): void {
    this.lastTransaction!.assertActive();
  }

  async run<T>(
    scope: InventoryScopeV1,
    bounds: CredentialStorageCallBoundsV1,
    work: (tx: CredentialInventoryTransactionV1) => Promise<T>,
  ) {
    // Serialization is only a synthetic fixture, not a production lock/queue.
    const prior = this.tail;
    let unlock!: () => void;
    this.tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await prior;
    let active = true,
      poisoned = false;
    const fault = this.fault;
    this.fault = "none";
    const state = structuredClone(this.state);
    const commitRef = randomUUID();
    const scoped = (row: OutstandingTokenRecordV1) =>
      inventoryDigestV1(row.issuance.scope) === inventoryDigestV1(scope);
    const guard = () => {
      if (!active || poisoned || bounds.signal.aborted)
        throw new Error("Synthetic transaction closed.");
    };
    const operation = async <V>(fn: () => V): Promise<V> => {
      guard();
      try {
        return structuredClone(fn());
      } catch (error) {
        poisoned = true;
        throw error;
      }
    };
    const tx: CredentialInventoryTransactionV1 = {
      assertActive: guard,
      commitRef,
      findOperation: (operationRef) =>
        operation(() =>
          state.operations.find(
            (op) =>
              op.input.scope.installationId === scope.installationId &&
              op.input.operationRef === operationRef,
          ),
        ),
      appendOperation: (op) =>
        operation(() => {
          if (
            state.operations.some(
              (old) =>
                old.input.scope.installationId === scope.installationId &&
                old.input.operationRef === op.input.operationRef,
            )
          )
            throw new Error("Synthetic unique operation conflict.");
          state.operations.push(structuredClone(op));
          this.writes++;
        }),
      findRecord: (recordRef) =>
        operation(() =>
          state.rows.find((row) => scoped(row) && row.target.recordRef === recordRef),
        ),
      insertRecord: (row) =>
        operation(() => {
          if (
            !scoped(row) ||
            state.rows.some((old) => old.target.recordRef === row.target.recordRef)
          )
            throw new Error("Synthetic insert conflict.");
          state.rows.push(structuredClone(row));
          this.writes++;
        }),
      replaceRecord: (version, row) =>
        operation(() => {
          const index = state.rows.findIndex(
            (old) =>
              scoped(old) &&
              old.target.recordRef === row.target.recordRef &&
              old.inventoryVersion === version,
          );
          if (index < 0 || !scoped(row) || row.inventoryVersion !== version + 1)
            throw new Error("Synthetic CAS conflict.");
          state.rows[index] = structuredClone(row);
          this.writes++;
        }),
      liveCounts: () =>
        operation(() => {
          const live = state.rows.filter(isLiveInventoryRecordV1);
          return {
            installation: live.filter(
              (row) => row.issuance.scope.installationId === scope.installationId,
            ).length,
            agent: live.filter(scoped).length,
            unresolved: live.filter((row) => scoped(row) && row.state !== "outstanding").length,
          };
        }),
      listLive: (bindingRef) =>
        operation(() =>
          state.rows.filter(
            (row) =>
              scoped(row) &&
              row.issuance.binding.bindingRef === bindingRef &&
              isLiveInventoryRecordV1(row),
          ),
        ),
      findMintClaim: (recordRef) =>
        operation(() =>
          state.mintClaims.find(
            (claim) =>
              claim.recordRef === recordRef &&
              state.rows.some((row) => scoped(row) && row.target.recordRef === recordRef),
          ),
        ),
      insertMintClaim: (claim) =>
        operation(() => {
          if (
            state.mintClaims.some(
              (old) =>
                old.recordRef === claim.recordRef ||
                old.providerAttemptRef === claim.providerAttemptRef,
            )
          )
            throw new Error("Synthetic unique mint conflict.");
          state.mintClaims.push(structuredClone(claim));
          this.writes++;
        }),
      findRevocationClaim: (claimRef) =>
        operation(() =>
          state.revokeClaims.find(
            (claim) =>
              claim.claimRef === claimRef &&
              inventoryDigestV1(claim.input.scope) === inventoryDigestV1(scope),
          ),
        ),
      appendRevocationClaim: (claim) =>
        operation(() => {
          if (state.revokeClaims.some((old) => old.claimRef === claim.claimRef))
            throw new Error("Synthetic claim conflict.");
          state.revokeClaims.push(structuredClone(claim));
          this.writes++;
        }),
      findSnapshot: (snapshotRef) =>
        operation(() =>
          state.snapshots.find(
            (snapshot) =>
              snapshot.snapshotRef === snapshotRef &&
              inventoryDigestV1(snapshot.filter.scope) === inventoryDigestV1(scope),
          ),
        ),
      insertSnapshot: (snapshot) =>
        operation(() => {
          if (state.snapshots.some((old) => old.snapshotRef === snapshot.snapshotRef))
            throw new Error("Synthetic snapshot conflict.");
          state.snapshots.push(structuredClone(snapshot));
          this.writes++;
        }),
      retainToken: (input, token) =>
        operation(() => {
          this.custodyCalls++;
          if (this.tokens.get(token) !== input.tokenRef + ":" + input.protectedRevocationRef)
            throw new Error("Synthetic custody unavailable.");
          if (!state.tokens.includes(input.tokenRef)) state.tokens.push(input.tokenRef);
        }),
      loadRevocationToken: async (row) => {
        guard();
        if (!state.tokens.includes(row.tokenRef)) throw new Error("Synthetic custody unavailable.");
        return this.token(row.tokenRef, row.protectedRevocationRef);
      },
      appendAudit: (input, mitigation) =>
        operation(() => {
          this.auditCalls++;
          if (this.audit === "accepted")
            return {
              state: "accepted" as const,
              eventRef: input.originalAuditRef,
              commitRef,
              source: "credential" as const,
              category: "credential" as const,
            };
          if (this.audit === "obligation-recorded" && mitigation)
            return {
              state: "obligation-recorded" as const,
              eventRef: input.originalAuditRef,
              obligationRef: randomUUID(),
              commitRef,
            };
          return {
            state: "evidence-missing" as const,
            eventRef: input.originalAuditRef,
            incidentRef: randomUUID(),
          };
        }),
    };
    this.lastTransaction = tx;
    try {
      if (fault === "unavailable") return { kind: "unavailable" as const };
      const value = await work(tx);
      guard();
      if (fault === "unknown-rolled-back") return { kind: "commit-unknown" as const };
      this.state = state;
      if (fault === "throw-after-commit")
        throw new Error("Synthetic acknowledgment transport failed.");
      if (fault === "unknown-committed") return { kind: "commit-unknown" as const };
      const acknowledgedAt = new Date(this.now).toISOString();
      if (this.retainReceipts) {
        // Emulates ORIGINAL owner's optional durable acknowledgment projection,
        // not a product receipt cache. Not an atomicity or restart guarantee.
        this.state.operations = this.state.operations.map((op) =>
          op.commitRef === commitRef
            ? {
                ...op,
                originalReceipt: {
                  schemaVersion: 1,
                  operationRef: op.input.operationRef,
                  intentDigest: op.digest,
                  commitRef,
                  inventoryVersion: op.record.inventoryVersion,
                  committedAt: acknowledgedAt,
                },
              }
            : op,
        );
      }
      return { kind: "committed" as const, value, acknowledgedAt };
    } finally {
      active = false;
      unlock();
    }
  }
}
