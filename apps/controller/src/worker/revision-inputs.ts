import { normalizeSecretBindings } from "@openclaw-enterprise/contracts";
import type {
  Agent,
  AgentRevision,
  AuthorizationDecision,
  AuthorizationRequest,
  ComputeRevisionContext,
  IAMDriver,
  ProviderDefinition,
  SecretBindings,
  SecretEnvironmentProjection,
  SecretReference,
} from "@openclaw-enterprise/contracts";
import type { NativeIAMState } from "@openclaw-enterprise/iam";
import type { ClaimedWork } from "@openclaw-enterprise/occ";
import type { PlatformReadView } from "@openclaw-enterprise/occ/ports/platform-read-view";
import type { RevisionDispatchResult } from "./runner.ts";

export interface WorkerRevisionInputsView {
  readonly serviceAccounts: Pick<
    PlatformReadView["serviceAccounts"],
    "findServiceAccountProviderBinding"
  >;
  readonly secrets: Pick<PlatformReadView["secrets"], "findSecret">;
}

export interface WorkerRevisionInputsOptions {
  readonly read: <T>(work: (view: WorkerRevisionInputsView) => Promise<T>) => Promise<T>;
  readonly loadIAMState: () => Promise<NativeIAMState>;
  readonly iam: Pick<IAMDriver, "id" | "authorize">;
  readonly providerMap: ReadonlyMap<string, ProviderDefinition>;
  readonly secretDriverId: string | undefined;
  readonly validateServiceAccountProviderBinding: (
    providers: ReadonlyMap<string, ProviderDefinition>,
    providerId: string | null,
    binding: Awaited<
      ReturnType<PlatformReadView["serviceAccounts"]["findServiceAccountProviderBinding"]>
    >,
  ) => void;
}

export async function workerIAMDecision(
  driver: Pick<IAMDriver, "id" | "authorize">,
  request: AuthorizationRequest,
): Promise<AuthorizationDecision> {
  const decision = await driver.authorize(request);
  const evidence = decision?.evidence;
  if (
    decision === null ||
    typeof decision !== "object" ||
    typeof decision.allowed !== "boolean" ||
    typeof decision.reason !== "string" ||
    decision.driverId !== driver.id ||
    evidence === null ||
    typeof evidence !== "object" ||
    (evidence.identityId !== undefined &&
      (typeof evidence.identityId !== "string" || evidence.identityId.trim().length === 0)) ||
    ![evidence.groupIds, evidence.bindingIds, evidence.roleIds, evidence.restrictionIds].every(
      (values) =>
        Array.isArray(values) &&
        values.every((value) => typeof value === "string" && value.trim().length > 0),
    )
  ) {
    throw new Error("The selected IAM Driver returned an invalid authorization decision.");
  }
  return decision;
}

export function validRevisionObservation(
  value: unknown,
  revision: Readonly<AgentRevision>,
): boolean {
  if (typeof value !== "object" || value === null || Object.hasOwn(value, "installationId"))
    return false;
  const observation = value as Record<string, unknown>;
  return (
    observation.namespaceId === revision.namespaceId &&
    observation.agentId === revision.agentId &&
    observation.revisionId === revision.id &&
    typeof observation.ready === "boolean"
  );
}

export function revisionSecretBindings(
  revision: Readonly<AgentRevision>,
): { readonly bindings: SecretBindings } | { readonly result: RevisionDispatchResult } {
  try {
    return { bindings: normalizeSecretBindings(revision.secretBindings) };
  } catch {
    return { result: { outcome: "permanent", code: "INVALID_SECRET_BINDINGS" } };
  }
}

export function uniqueSecretRefs(bindings: SecretBindings): readonly SecretReference[] {
  const refs = new Map<string, SecretReference>();
  for (const { source } of Object.values(bindings)) {
    refs.set(`${source.namespaceId}\u0000${source.id}`, source);
  }
  return [...refs.values()];
}

/** Resolves the original revision authorization and selected input bindings. */
export class WorkerRevisionInputs {
  private readonly options: WorkerRevisionInputsOptions;

  constructor(options: WorkerRevisionInputsOptions) {
    this.options = options;
  }

  async authorizeRevision(
    claim: Readonly<ClaimedWork>,
    agent: Readonly<Agent>,
    revision: Readonly<AgentRevision>,
  ): Promise<RevisionDispatchResult | undefined> {
    const state = await this.options.loadIAMState();
    const driver = this.options.iam;
    const authorization: AuthorizationRequest = {
      principalId: claim.actorId,
      action: "deploy",
      resource: { kind: "agent", id: agent.id, namespaceId: agent.namespaceId },
    };
    const actor = state.identities.find((identity) => identity.id === claim.actorId);
    if (actor === undefined) {
      const decision = await workerIAMDecision(driver, authorization);
      return { outcome: "permanent", code: "ACTOR_REVOKED", authorization, decision };
    }
    const identity = state.identities.find(
      (candidate) =>
        candidate.kind === "service_principal" &&
        candidate.id === revision.servicePrincipalId &&
        candidate.namespaceId === agent.namespaceId &&
        candidate.agentId === agent.id,
    );
    if (identity === undefined) return { outcome: "permanent", code: "INVALID_AGENT_PRINCIPAL" };
    const decision = await workerIAMDecision(driver, authorization);
    if (!decision.allowed)
      return {
        outcome: "permanent",
        code: "AUTHORIZATION_DENIED",
        authorization,
        decision,
      };

    const secretBindings = revisionSecretBindings(revision);
    if ("result" in secretBindings) return secretBindings.result;
    for (const ref of uniqueSecretRefs(secretBindings.bindings)) {
      for (const principalId of [claim.actorId, revision.servicePrincipalId]) {
        const secretAuthorization: AuthorizationRequest = {
          principalId,
          action: "operate",
          resource: ref,
        };
        const secretDecision = await workerIAMDecision(driver, secretAuthorization);
        if (!secretDecision.allowed)
          return {
            outcome: "permanent",
            code: "AUTHORIZATION_DENIED",
            authorization: secretAuthorization,
            decision: secretDecision,
          };
      }
    }

    if (revision.serviceAccount !== undefined) {
      const accountAuthorization: AuthorizationRequest = {
        principalId: claim.actorId,
        action: "read",
        resource: {
          kind: "service_account",
          id: revision.serviceAccount.id,
          namespaceId: revision.namespaceId,
        },
      };
      const accountDecision = await workerIAMDecision(driver, accountAuthorization);
      if (!accountDecision.allowed)
        return {
          outcome: "permanent",
          code: "AUTHORIZATION_DENIED",
          authorization: accountAuthorization,
          decision: accountDecision,
        };
    }
    return undefined;
  }

  async resolveRevisionProvider(
    revision: Readonly<AgentRevision>,
  ): Promise<RevisionDispatchResult | undefined> {
    if (revision.providerId !== null && !this.options.providerMap.has(revision.providerId)) {
      return { outcome: "permanent", code: "PROVIDER_UNAVAILABLE" };
    }
    if (revision.serviceAccount?.credential.kind !== "access_token") return undefined;
    const binding = await this.options.read((view) =>
      view.serviceAccounts.findServiceAccountProviderBinding(
        revision.namespaceId,
        revision.serviceAccount!.id,
      ),
    );
    try {
      this.options.validateServiceAccountProviderBinding(
        this.options.providerMap,
        revision.providerId,
        binding,
      );
      return undefined;
    } catch {
      return { outcome: "permanent", code: "SERVICE_ACCOUNT_PROVIDER_MISMATCH" };
    }
  }

  async resolveRevisionSecretContext(
    revision: Readonly<AgentRevision>,
  ): Promise<
    { readonly context: ComputeRevisionContext } | { readonly result: RevisionDispatchResult }
  > {
    const bindings = revisionSecretBindings(revision);
    if ("result" in bindings) return { result: bindings.result };
    if (Object.keys(bindings.bindings).length === 0) return { context: { secretEnvironment: [] } };
    const secretDriverId = this.options.secretDriverId;
    if (typeof secretDriverId !== "string" || revision.secretDriverId !== secretDriverId) {
      return { result: { outcome: "permanent", code: "SECRET_DRIVER_MISMATCH" } };
    }

    const resolved = await this.options.read(async (view) => {
      const projections: SecretEnvironmentProjection[] = [];
      for (const [name, binding] of Object.entries(bindings.bindings)) {
        const secret = await view.secrets.findSecret(binding.source.namespaceId, binding.source.id);
        if (
          secret === undefined ||
          secret.namespaceId !== revision.namespaceId ||
          secret.driverId !== secretDriverId ||
          secret.backendRef.namespaceName.trim().length === 0 ||
          secret.backendRef.name.trim().length === 0 ||
          secret.backendRef.key.trim().length === 0 ||
          secret.backendRef.uid.trim().length === 0
        ) {
          return undefined;
        }
        projections.push({
          name,
          secretId: secret.id,
          namespaceId: secret.namespaceId,
          agentId: revision.agentId,
          backendRef: secret.backendRef,
        });
      }
      return projections;
    });

    return resolved === undefined
      ? { result: { outcome: "permanent", code: "SECRET_BINDING_UNAVAILABLE" } }
      : { context: { secretEnvironment: Object.freeze(resolved) } };
  }
}
