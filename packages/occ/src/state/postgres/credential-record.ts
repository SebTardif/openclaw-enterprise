import { decodeCredentialWorkloadSelectionV1 } from "@openclaw-enterprise/contracts/credential-workload-selection-v1";
import { ScopeViolationError } from "../../errors.ts";
import type { RepositoryScope, TransactionQuery } from "../../ports/repository-factory.ts";
import type { ProtectedRevisionCredentialReaderV1 } from "../../workload-profiles/credential-record.ts";

type ReadArguments = Parameters<ProtectedRevisionCredentialReaderV1["readLocked"]>;

/** Created only by the original selection-operation owner. This context borrows
 * its exact query and private enrollment assertion; its shape authenticates no
 * caller, held selection or transaction. No pool or transaction is opened here. */
export interface PostgresRevisionCredentialContextV1 {
  readonly scope: Readonly<RepositoryScope>;
  readonly query: TransactionQuery;
  assertEnrolled(...args: ReadArguments): void;
  poison(error: unknown): void;
}

export function createPostgresRevisionCredentialReaderV1(
  context: PostgresRevisionCredentialContextV1,
): ProtectedRevisionCredentialReaderV1 {
  const assertEnrolled = context.assertEnrolled.bind(context);
  const query = context.query.query.bind(context.query);
  const poison = context.poison.bind(context);
  const installationId = context.scope.installationId;
  const namespaceId = context.scope.namespaceId;
  return Object.freeze({
    async readLocked(...args: ReadArguments): Promise<unknown> {
      const [request] = args;
      try {
        assertEnrolled(...args);
        if (request.installationId !== installationId || request.namespaceId !== namespaceId)
          throw new ScopeViolationError("The protected revision credential scope is unavailable.");
        const result = await query(
          `SELECT i.id AS installation_id, r.namespace_id, r.agent_id, r.id AS revision_id,
                  r.admitted_spec->>'configuration_id' AS configuration_id,
                  r.admitted_spec->>'configuration_generation' AS configuration_generation,
                  r.admitted_spec->'credential_workload_selection' AS credential_record
             FROM occ.agent_revisions r
             JOIN occ.agents a ON a.namespace_id=r.namespace_id AND a.id=r.agent_id
             JOIN occ.namespaces n ON n.id=r.namespace_id
             JOIN occ.installation i ON i.id=$1
            WHERE r.namespace_id=$2 AND r.agent_id=$3 AND r.id=$4`,
          [installationId, namespaceId, request.agentId, request.revisionId],
        );
        assertEnrolled(...args);
        const row = result.rows[0];
        if (
          result.rowCount !== 1 ||
          result.rows.length !== 1 ||
          row === null ||
          typeof row !== "object"
        )
          throw new ScopeViolationError("The protected revision credential record is unavailable.");
        const value = row as Record<string, unknown>;
        if (
          value.installation_id !== installationId ||
          value.namespace_id !== namespaceId ||
          value.agent_id !== request.agentId ||
          value.revision_id !== request.revisionId ||
          value.configuration_id !== request.configurationRef ||
          value.configuration_generation !== String(request.configurationVersion)
        )
          throw new ScopeViolationError(
            "The protected revision credential association is unavailable.",
          );
        const decoded = decodeCredentialWorkloadSelectionV1(value.credential_record);
        if (
          decoded.kind !== "valid" ||
          decoded.value.scope.installationId !== installationId ||
          decoded.value.scope.namespaceId !== namespaceId ||
          decoded.value.scope.agentId !== request.agentId ||
          decoded.value.revisionId !== request.revisionId
        )
          throw new ScopeViolationError("The protected revision credential record is invalid.");
        assertEnrolled(...args);
        return decoded.value;
      } catch (error) {
        poison(error);
        throw error;
      }
    },
  });
}
