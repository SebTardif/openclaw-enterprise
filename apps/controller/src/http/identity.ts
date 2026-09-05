import type { IAMDriver } from "@openclaw-enterprise/contracts/drivers/iam";
import type { OccApiRoute } from "@openclaw-enterprise/contracts/api/routes";
import type { FastifyRequest } from "fastify";
import type { AdmittedCaller } from "../admission/admission-verifier.ts";
import { failure } from "./errors.ts";

export interface RequestContext {
  readonly actorId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly admissionDecisionId: string;
  readonly operation: OccApiRoute;
}

export interface HttpIdentityOptions {
  readonly admissions: WeakMap<FastifyRequest, AdmittedCaller>;
  readonly contexts: WeakMap<FastifyRequest, RequestContext>;
  readonly selectedIAMDriver: () => IAMDriver;
  readonly recordIdentityAuthority: (
    request: FastifyRequest,
    authority: { driver: IAMDriver; id: string },
  ) => void;
  readonly denial: (
    operation: OccApiRoute,
    request: FastifyRequest,
    kind: "authorization_denial",
    context?: RequestContext,
  ) => Promise<void>;
}

export function createIdentityResolver(options: HttpIdentityOptions) {
  const { admissions, contexts, selectedIAMDriver, recordIdentityAuthority, denial } = options;
  const dependencyUnavailable = () =>
    failure(503, "DEPENDENCY_UNAVAILABLE", "A required platform dependency is unavailable.");
  async function resolveIdentity(request: FastifyRequest, operation: OccApiRoute): Promise<void> {
    const admitted = admissions.get(request);
    if (!admitted)
      throw failure(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "A required platform dependency is unavailable.",
      );
    let selected: IAMDriver;
    let selectedId: string;
    let identity;
    try {
      selected = selectedIAMDriver();
      selectedId = selected.id;
      identity = await selected.lookupIdentity(
        admitted.method === "api_key"
          ? {
              servicePrincipalId: admitted.externalIdentity.subject,
              ...(admitted.admittedScope.namespaceId === undefined
                ? {}
                : { namespaceId: admitted.admittedScope.namespaceId }),
            }
          : {
              issuer: admitted.externalIdentity.issuer,
              subject: admitted.externalIdentity.subject,
            },
      );
    } catch {
      throw failure(
        503,
        "DEPENDENCY_UNAVAILABLE",
        "A required platform dependency is unavailable.",
      );
    }

    if (
      !identity ||
      (admitted.method === "api_key"
        ? identity.kind !== "service_principal" ||
          identity.agentId !== undefined ||
          identity.id !== admitted.externalIdentity.subject ||
          identity.namespaceId !== admitted.admittedScope.namespaceId
        : identity.kind !== "principal" ||
          identity.issuer !== admitted.externalIdentity.issuer ||
          identity.subject !== admitted.externalIdentity.subject)
    ) {
      await denial(operation, request, "authorization_denial");
      throw failure(403, "FORBIDDEN", "The exact platform operation was not authorized.");
    }

    if (selectedIAMDriver() !== selected || selected.id !== selectedId)
      throw dependencyUnavailable();
    recordIdentityAuthority(request, { driver: selected, id: selectedId });
    const context: RequestContext = {
      actorId: identity.id,
      issuer: admitted.externalIdentity.issuer,
      subject: admitted.externalIdentity.subject,
      admissionDecisionId: admitted.decisionId,
      operation,
    };
    contexts.set(request, context);
    if (
      admitted.method === "api_key" &&
      admitted.admittedScope.namespaceId !== undefined &&
      admitted.admittedScope.namespaceId !== (request.params as Record<string, unknown>).namespaceId
    ) {
      await denial(operation, request, "authorization_denial", context);
      throw failure(403, "FORBIDDEN", "The admitted Namespace does not match.");
    }
  }

  return resolveIdentity;
}
