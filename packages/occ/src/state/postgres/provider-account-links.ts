import { DependencyUnavailableError, ScopeViolationError } from "../../errors.ts";
import type {
  ProviderAccountLink,
  ProviderAccountLinkKey,
  ProviderAccountLinks,
} from "../../ports/provider-account-links.ts";
import type { QueryRepositoryFactoryContext } from "../../ports/repository-factory.ts";

/** Borrows the initialized singleton Installation transaction without acquiring a client. */
export function createPostgresProviderAccountLinks(
  context: QueryRepositoryFactoryContext,
): ProviderAccountLinks {
  let installationId: string | undefined;

  function assertScope(): void {
    context.transaction.assertActive();
    const current = context.scope.installationId;
    if (installationId === undefined) installationId = current;
    if (installationId !== current)
      throw new ScopeViolationError(
        "The resource does not belong to the server-owned Installation.",
      );
  }

  async function withinTransaction<T>(work: () => Promise<T>): Promise<T> {
    assertScope();
    const result = await work();
    assertScope();
    return result;
  }

  return Object.freeze({
    create: (key: ProviderAccountLinkKey, externalAccountId: string): Promise<void> =>
      withinTransaction(async () => {
        await context.query.query(
          `INSERT INTO occ.service_account_driver_bindings
             (service_account_id, namespace_id, provider_id, driver_id, external_account_id, workspace_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            key.serviceAccountId,
            key.namespaceId,
            key.providerId,
            key.driverId,
            externalAccountId,
            key.workspaceId,
          ],
        );
      }),

    find: (key: ProviderAccountLinkKey): Promise<Readonly<ProviderAccountLink> | undefined> =>
      withinTransaction(async () => {
        const result = await context.query.query(
          `SELECT driver_id AS "driverId", external_account_id AS "externalAccountId",
                  provider_id AS "providerId", external_credential_id AS "externalCredentialId",
                  workspace_id AS "workspaceId"
           FROM occ.service_account_driver_bindings
           WHERE service_account_id = $1 AND namespace_id = $2`,
          [key.serviceAccountId, key.namespaceId],
        );
        if (result.rows.length === 0) return undefined;
        const linked = result.rows[0] as ProviderAccountLink;
        if (linked.providerId !== key.providerId)
          throw new DependencyUnavailableError("The service-account Provider does not match.");
        if (linked.driverId !== key.driverId)
          throw new DependencyUnavailableError(
            "The service-account provider Driver does not match.",
          );
        if (linked.workspaceId !== key.workspaceId)
          throw new DependencyUnavailableError(
            "The service-account provider workspace does not match.",
          );
        return Object.freeze({
          providerId: linked.providerId,
          driverId: linked.driverId,
          externalAccountId: linked.externalAccountId,
          externalCredentialId: linked.externalCredentialId,
          workspaceId: linked.workspaceId,
        });
      }),

    recordCredential: (key: ProviderAccountLinkKey, externalCredentialId: string): Promise<void> =>
      withinTransaction(async () => {
        const result = await context.query.query(
          `UPDATE occ.service_account_driver_bindings
           SET external_credential_id = $4
           WHERE service_account_id = $1 AND namespace_id = $2 AND driver_id = $3`,
          [key.serviceAccountId, key.namespaceId, key.driverId, externalCredentialId],
        );
        if (result.rowCount !== 1)
          throw new DependencyUnavailableError(
            "The exact service-account Driver binding is missing.",
          );
      }),
  });
}
