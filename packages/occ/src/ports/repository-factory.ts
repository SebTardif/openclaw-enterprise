import type { RepositoryTransaction, RepositoryTransactionLifetime } from "./transaction.ts";

/** Exact server-owned identity. A scope value is not authorization evidence. */
export interface RepositoryScope {
  readonly installationId: string;
  readonly namespaceId?: string;
}

export interface TransactionQueryResult {
  readonly rows: unknown[];
  readonly rowCount: number | null;
}

/**
 * Queries use the owner's existing transaction and reject after its lifetime.
 * Trusted adapter code may issue only its domain's queries, retaining exact
 * keys, decoding and lock order. No connection acquisition or transaction
 * control is available through this interface; BEGIN/COMMIT/ROLLBACK remain
 * exclusively in the transaction owner, never in a repository factory.
 */
export interface TransactionQuery {
  query(statement: string, parameters?: readonly unknown[]): Promise<TransactionQueryResult>;
}

export interface RepositoryFactoryContext<Scope extends RepositoryScope = RepositoryScope> {
  /**
   * Exact scope from the owning transaction or working snapshot. A live owner
   * accessor may throw while the owner's current Installation is unavailable.
   * Factories that support pre-bootstrap use must defer access to their methods.
   * Those methods resolve the owner's optional current Installation first and
   * preserve existing absent-Installation reads/errors without accessing scope.
   * Once present, the Installation identity is fixed for this transaction; no
   * placeholder or caller-supplied identity may stand in for it.
   */
  readonly scope: Readonly<Scope>;
  readonly transaction: RepositoryTransaction;
}

export interface QueryRepositoryFactoryContext<
  Scope extends RepositoryScope = RepositoryScope,
> extends RepositoryFactoryContext<Scope> {
  readonly query: TransactionQuery;
}

/** Snapshot is the domain's explicit projection of the owner's working snapshot. */
export interface MemoryRepositoryFactoryContext<
  Snapshot,
  Scope extends RepositoryScope = RepositoryScope,
> extends RepositoryFactoryContext<Scope> {
  readonly snapshot: Snapshot;
}

/**
 * Composition supplies only a domain backend and required read projections.
 * Factories are synchronous and do not perform I/O. Returned methods remain
 * bound to the same transaction; they never create a nested transaction.
 *
 * Preserve the current lock sequences: Namespace before Agent/configuration/
 * Secret/ServiceAccount; channel installation before its child binding; runtime
 * intent/allocation uses Namespace then Agent. Authority operation advisory lock
 * precedes its Agent lock; service trust locks operation then subject. These
 * separate sequences are not a new global lock hierarchy. Keep the existing
 * within-transaction mutation serializers and authority poison guard.
 */
export type RepositoryFactory<Backend extends RepositoryFactoryContext, Repository> = (
  backend: Backend,
) => Repository;

/**
 * Wrap only the outward projection. Internal repository collaborators retain
 * backend access while already accepted operations drain. Method names are
 * explicit so class-backed projections do not lose prototype methods.
 */
export function bindRepository<Repository extends object, Key extends keyof Repository>(
  repository: Repository,
  lifetime: RepositoryTransactionLifetime,
  methods: readonly Key[],
): Pick<Repository, Key> {
  const result = {} as Pick<Repository, Key>;
  for (const key of methods) {
    const method = repository[key];
    if (typeof method !== "function") throw new TypeError("A repository method is required.");
    Object.defineProperty(result, key, {
      enumerable: true,
      value: (...args: unknown[]) => lifetime.run(() => Reflect.apply(method, repository, args)),
    });
  }
  return Object.freeze(result);
}
