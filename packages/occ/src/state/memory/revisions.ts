import {
  decodeCredentialWorkloadSelectionV1,
  type CredentialWorkloadSelectionV1,
} from "@openclaw-enterprise/contracts/credential-workload-selection-v1";
import type { AgentRevision } from "@openclaw-enterprise/contracts/resources/agent";
import { decodeWorkloadProfileUseV2 } from "@openclaw-enterprise/contracts/workload-profile-v1";
import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";
import type { SecretBindings } from "@openclaw-enterprise/contracts/resources/secret";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ScopeViolationError, ResourceConflictError } from "../../errors.ts";
import type { AgentReadRepository } from "../../ports/repositories/agent.ts";
import type { AgentRevisionRepository } from "../../ports/repositories/revision.ts";
import type {
  MemoryRepositoryFactoryContext,
  RepositoryFactory,
} from "../../ports/repository-factory.ts";
import type { PersistedNamespace } from "../../ports/repositories/namespace.ts";
import { decodeWorkloadProfileAdmissionHeadV2 } from "../../workload-profiles/admission-record.ts";

/** Stored only in the original collection; public repository projections omit it. */
interface StoredAgentRevision extends AgentRevision {
  readonly credential_workload_selection?: CredentialWorkloadSelectionV1;
}
function publicRevision(revision: Readonly<StoredAgentRevision>): Readonly<AgentRevision> {
  return immutableCopy({
    id: revision.id,
    namespaceId: revision.namespaceId,
    agentId: revision.agentId,
    revision: revision.revision,
    ...(revision.maximumExecutionMs === undefined
      ? {}
      : { maximumExecutionMs: revision.maximumExecutionMs }),
    providerId: revision.providerId,
    configurationId: revision.configurationId,
    configurationKind: revision.configurationKind,
    configurationGeneration: revision.configurationGeneration,
    configuration: revision.configuration,
    harness: revision.harness,
    compute: revision.compute,
    ...(revision.workloadProfileUse === undefined
      ? {}
      : { workloadProfileUse: revision.workloadProfileUse }),
    ...(revision.sandboxDriverId === undefined
      ? {}
      : { sandboxDriverId: revision.sandboxDriverId }),
    ...(revision.secretDriverId === undefined ? {} : { secretDriverId: revision.secretDriverId }),
    ...(revision.secretBindings === undefined ? {} : { secretBindings: revision.secretBindings }),
    ...(revision.serviceAccount === undefined ? {} : { serviceAccount: revision.serviceAccount }),
    servicePrincipalId: revision.servicePrincipalId,
    createdAt: revision.createdAt,
  });
}

/** Live owner maps; only the revision collection is writable through this projection. */
export interface MemoryRevisionSnapshot {
  readonly installation: Readonly<Installation> | undefined;
  readonly namespaces: ReadonlyMap<string, Readonly<Pick<PersistedNamespace, "deletedAt">>>;
  readonly revisions: Map<string, readonly Readonly<StoredAgentRevision>[]>;
  readonly workloadProfileAdmissions: ReadonlyMap<string, unknown>;
}
export interface MemoryRevisionRepositoryContext extends MemoryRepositoryFactoryContext<MemoryRevisionSnapshot> {
  readonly agents: Pick<AgentReadRepository, "findAgent">;
  revisionKey(namespaceId: string, agentId: string): string;
  assertInitialized(): void;
  assertAdmittedAgentRevision(revision: AgentRevision): void;
  normalizedSecretBindings(bindings?: SecretBindings): SecretBindings | undefined;
  assertSecretBindingsAvailable(
    namespaceId: string,
    bindings: SecretBindings | undefined,
  ): Promise<void>;
}

/** Borrows canonical validation, raw collaborators and one owner snapshot. */
export const createMemoryRevisionRepository: RepositoryFactory<
  MemoryRevisionRepositoryContext,
  AgentRevisionRepository
> = (context) => {
  const {
    snapshot,
    transaction,
    agents,
    revisionKey: agentKey,
    assertAdmittedAgentRevision,
    normalizedSecretBindings,
    assertSecretBindingsAvailable,
  } = context;
  function requireInitialized(): void {
    context.assertInitialized();
    if (
      snapshot.installation === undefined ||
      context.scope.installationId !== snapshot.installation.id
    )
      throw new ScopeViolationError(
        "The resource does not belong to the server-owned Installation.",
      );
  }
  const revisions: AgentRevisionRepository = {
    findRevision: async (namespaceId, agentId, revisionId) => {
      if (snapshot.namespaces.get(namespaceId)?.deletedAt !== undefined) return undefined;
      const candidate = snapshot.revisions
        .get(agentKey(namespaceId, agentId))
        ?.find((revision) => revision.id === revisionId);
      return candidate?.namespaceId === namespaceId && candidate.agentId === agentId
        ? publicRevision(candidate)
        : undefined;
    },
    listRevisions: async (namespaceId, agentId) =>
      Object.freeze(
        snapshot.namespaces.get(namespaceId)?.deletedAt === undefined
          ? (snapshot.revisions.get(agentKey(namespaceId, agentId)) ?? [])
              .filter(
                (revision) => revision.namespaceId === namespaceId && revision.agentId === agentId,
              )
              .map((revision) => publicRevision(revision))
          : [],
      ),
    createRevision: async (revision, credentialWorkloadSelection) => {
      const useDescriptor = Object.getOwnPropertyDescriptor(revision, "workloadProfileUse");
      if (useDescriptor !== undefined && (!("value" in useDescriptor) || !useDescriptor.enumerable))
        throw new ScopeViolationError("The revision workload profile Use must be data.");
      const decodedUse =
        useDescriptor?.value === undefined
          ? undefined
          : decodeWorkloadProfileUseV2(useDescriptor.value);
      if (decodedUse?.kind === "invalid")
        throw new ScopeViolationError("The revision workload profile Use is invalid.");
      const use = decodedUse?.value;
      revision = immutableCopy(revision);
      const decoded =
        credentialWorkloadSelection === undefined
          ? undefined
          : decodeCredentialWorkloadSelectionV1(credentialWorkloadSelection);
      if (decoded?.kind === "invalid")
        throw new ScopeViolationError("The revision credential record is invalid.");
      const credential = decoded?.value;
      requireInitialized();
      if (
        use !== undefined &&
        (use.installationId !== context.scope.installationId ||
          use.namespaceId !== revision.namespaceId)
      )
        throw new ScopeViolationError(
          "The revision workload profile Use belongs to another scope.",
        );
      if (
        credential !== undefined &&
        (credential.scope.installationId !== context.scope.installationId ||
          credential.scope.namespaceId !== revision.namespaceId ||
          credential.scope.agentId !== revision.agentId ||
          credential.revisionId !== revision.id)
      )
        throw new ScopeViolationError("The revision credential record belongs to another scope.");
      assertAdmittedAgentRevision(revision);
      const owner = await agents.findAgent(revision.namespaceId, revision.agentId);
      if (
        owner === undefined ||
        owner.servicePrincipalId !== revision.servicePrincipalId ||
        owner.providerId !== revision.providerId ||
        revision.serviceAccount?.id !== owner.serviceAccountId
      )
        throw new ScopeViolationError("The AgentRevision belongs to an unavailable Agent.");
      const secretBindings = normalizedSecretBindings(revision.secretBindings);
      await assertSecretBindingsAvailable(revision.namespaceId, secretBindings);
      // The serial memory owner holds this same snapshot through commit. Match
      // the PostgreSQL first-INSERT head guard, without requalifying later reads.
      if (use !== undefined) {
        const raw = snapshot.workloadProfileAdmissions.get(
          JSON.stringify([context.scope.installationId, use.admissionRef]),
        );
        if (raw === undefined)
          throw new ScopeViolationError("The revision workload profile admission is unavailable.");
        const head = decodeWorkloadProfileAdmissionHeadV2(raw);
        if (
          head.state !== "admitted" ||
          head.scope.installationId !== use.installationId ||
          head.scope.namespaceId !== use.namespaceId ||
          head.selection.admissionVersion !== use.admissionVersion ||
          head.selection.manifestRef !== use.manifestRef ||
          head.selection.manifestDigest !== use.manifestDigest ||
          Object.entries(use.profileRefs).some(([role, value]) => {
            const original = head.profileRefs[role as keyof typeof head.profileRefs];
            return (
              original.ref !== value.ref ||
              original.version !== value.version ||
              original.contentDigest !== value.contentDigest
            );
          })
        )
          throw new ScopeViolationError("The revision workload profile admission is not current.");
      }
      const key = agentKey(revision.namespaceId, revision.agentId);
      const previous = snapshot.revisions.get(key) ?? [];
      if (previous.some((existing) => existing.id === revision.id))
        throw new ResourceConflictError("The server generated an existing AgentRevision identity.");
      const { secretBindings: _providedSecretBindings, ...withoutSecretBindings } =
        publicRevision(revision);
      const saved = immutableCopy({
        ...withoutSecretBindings,
        ...(use === undefined ? {} : { workloadProfileUse: use }),
        ...(secretBindings === undefined ? {} : { secretBindings }),
        ...(credential === undefined ? {} : { credential_workload_selection: credential }),
      });
      snapshot.revisions.set(key, Object.freeze([...previous, saved]));
      return publicRevision(saved);
    },
  };

  for (const key of Object.keys(revisions) as (keyof AgentRevisionRepository)[]) {
    const method = revisions[key];
    Object.defineProperty(revisions, key, {
      value: async (...args: unknown[]) => {
        transaction.assertActive();
        const result = await Reflect.apply(method, revisions, args);
        transaction.assertActive();
        return result;
      },
    });
  }
  return Object.freeze(revisions);
};
