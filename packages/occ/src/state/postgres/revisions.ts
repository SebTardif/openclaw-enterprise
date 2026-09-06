import type { AgentRevision } from "@openclaw-enterprise/contracts/resources/agent";
import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";
import type { SecretBindings } from "@openclaw-enterprise/contracts/resources/secret";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ScopeViolationError } from "../../errors.ts";
import type { AgentReadRepository } from "../../ports/repositories/agent.ts";
import type { AgentRevisionRepository } from "../../ports/repositories/revision.ts";
import type {
  QueryRepositoryFactoryContext,
  RepositoryFactory,
} from "../../ports/repository-factory.ts";

type PostgresRow = Record<string, unknown>;
export interface PostgresRevisionRepositoryContext extends QueryRepositoryFactoryContext {
  readonly agents: Pick<AgentReadRepository, "findAgent">;
  requireInitialized(): Promise<Readonly<Installation>>;
  rows(value: unknown[]): PostgresRow[];
  revisionFromRow(row: PostgresRow): Readonly<AgentRevision>;
  secretBindingsFromState(
    bindings: SecretBindings,
    namespaceId: string,
  ): SecretBindings | undefined;
  validateSecretBindingsAvailable(
    namespaceId: string,
    bindings: SecretBindings | undefined,
  ): Promise<void>;
}

/** Borrows the guarded query and shared mapper; the owner controls the transaction. */
export const createPostgresRevisionRepository: RepositoryFactory<
  PostgresRevisionRepositoryContext,
  AgentRevisionRepository
> = (context) => {
  const client = context.query;
  const {
    agents,
    rows,
    revisionFromRow,
    secretBindingsFromState,
    validateSecretBindingsAvailable,
  } = context;
  async function requireInitialized(): Promise<void> {
    const installation = await context.requireInitialized();
    context.transaction.assertActive();
    if (context.scope.installationId !== installation.id)
      throw new ScopeViolationError(
        "The resource does not belong to the server-owned Installation.",
      );
  }
  async function withinTransaction<T>(work: () => Promise<T>): Promise<T> {
    context.transaction.assertActive();
    const result = await work();
    context.transaction.assertActive();
    return result;
  }
  const revisions: AgentRevisionRepository = {
    findRevision: async (namespaceId, agentId, revisionId) => {
      const found = rows(
        (
          await client.query(
            `SELECT r.id, r.namespace_id, r.agent_id, r.revision_number, r.provider_id,
                      r.admitted_spec,
                      r.admitted_at, a.service_principal_id
               FROM occ.agent_revisions AS r
               JOIN occ.agents AS a ON a.namespace_id = r.namespace_id AND a.id = r.agent_id
               JOIN occ.namespaces AS n ON n.id = r.namespace_id AND n.deleted_at IS NULL
               WHERE r.namespace_id = $1 AND r.agent_id = $2 AND r.id = $3`,
            [namespaceId, agentId, revisionId],
          )
        ).rows,
      )[0];
      return found === undefined ? undefined : revisionFromRow(found);
    },
    listRevisions: async (namespaceId, agentId) => {
      const found = rows(
        (
          await client.query(
            `SELECT r.id, r.namespace_id, r.agent_id, r.revision_number, r.provider_id,
                      r.admitted_spec,
                      r.admitted_at, a.service_principal_id
               FROM occ.agent_revisions AS r
               JOIN occ.agents AS a ON a.namespace_id = r.namespace_id AND a.id = r.agent_id
               JOIN occ.namespaces AS n ON n.id = r.namespace_id AND n.deleted_at IS NULL
               WHERE r.namespace_id = $1 AND r.agent_id = $2 ORDER BY r.revision_number`,
            [namespaceId, agentId],
          )
        ).rows,
      );
      return Object.freeze(found.map((row) => revisionFromRow(row)));
    },
    createRevision: async (revision) => {
      await requireInitialized();
      const owner = await agents.findAgent(revision.namespaceId, revision.agentId);
      if (
        owner === undefined ||
        owner.servicePrincipalId !== revision.servicePrincipalId ||
        owner.providerId !== revision.providerId ||
        revision.serviceAccount?.id !== owner.serviceAccountId
      )
        throw new ScopeViolationError("The AgentRevision belongs to an unavailable Agent.");
      const secretBindings =
        revision.secretBindings === undefined
          ? undefined
          : secretBindingsFromState(revision.secretBindings, revision.namespaceId);
      await validateSecretBindingsAvailable(revision.namespaceId, secretBindings);
      await client.query(
        `INSERT INTO occ.agent_revisions
           (id, namespace_id, agent_id, revision_number, provider_id, admitted_spec, admitted_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          revision.id,
          revision.namespaceId,
          revision.agentId,
          revision.revision,
          revision.providerId,
          JSON.stringify({
            configuration_id: revision.configurationId,
            configuration_kind: revision.configurationKind,
            configuration_generation: revision.configurationGeneration,
            draft_spec: revision.configuration,
            harness: revision.harness,
            compute: revision.compute,
            ...(revision.sandboxDriverId === undefined
              ? {}
              : { sandbox_driver_id: revision.sandboxDriverId }),
            ...(revision.secretDriverId === undefined
              ? {}
              : { secret_driver_id: revision.secretDriverId }),
            ...(secretBindings === undefined ? {} : { secret_bindings: secretBindings }),
            ...(revision.serviceAccount === undefined
              ? {}
              : { service_account: revision.serviceAccount }),
          }),
          revision.createdAt,
        ],
      );
      const { secretBindings: _providedSecretBindings, ...withoutSecretBindings } = revision;
      return immutableCopy({
        ...withoutSecretBindings,
        ...(secretBindings === undefined ? {} : { secretBindings }),
      });
    },
  };

  // Raw collaborators remain active while outward admissions close and drain.
  return Object.freeze<AgentRevisionRepository>({
    findRevision: (namespaceId, agentId, revisionId) =>
      withinTransaction(() => revisions.findRevision(namespaceId, agentId, revisionId)),
    listRevisions: (namespaceId, agentId) =>
      withinTransaction(() => revisions.listRevisions(namespaceId, agentId)),
    createRevision: (revision) => withinTransaction(() => revisions.createRevision(revision)),
  });
};
