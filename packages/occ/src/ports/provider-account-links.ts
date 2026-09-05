/** Exact selected Provider ownership. Installation comes only from the owning transaction. */
export interface ProviderAccountLinkKey {
  readonly namespaceId: string;
  readonly serviceAccountId: string;
  readonly providerId: string;
  readonly driverId: string;
  readonly workspaceId: string;
}

/** Opaque external identifiers only; upstream credential values never cross this port. */
export interface ProviderAccountLink {
  readonly providerId: string;
  readonly driverId: string;
  readonly externalAccountId: string;
  readonly externalCredentialId: string | null;
  readonly workspaceId: string;
}

/**
 * Methods borrow the initialized Installation transaction and its lifetime.
 * Account creation precedes create; existing account mutations hold the exact
 * ServiceAccount lock. find validates Provider, Driver and workspace ownership.
 * recordCredential follows a successful find with no existing credential while
 * retaining that account lock. Account deletion retains its existing FK cascade.
 * These methods do not open transactions, authorize requests or hold credentials.
 */
export interface ProviderAccountLinks {
  create(key: ProviderAccountLinkKey, externalAccountId: string): Promise<void>;
  find(key: ProviderAccountLinkKey): Promise<Readonly<ProviderAccountLink> | undefined>;
  recordCredential(key: ProviderAccountLinkKey, externalCredentialId: string): Promise<void>;
}

/** Joins the composition owner's ambient mutation, without exposing controller or SQL access. */
export interface ProviderAccountLinksAccess {
  run<T>(work: (links: ProviderAccountLinks) => Promise<T>): Promise<T>;
}

/** Effects compensate only known transaction failures under the existing mutation owner. */
export interface ProviderAccountLinkCompensation {
  registerRollback(rollback: () => Promise<void>): void;
}
