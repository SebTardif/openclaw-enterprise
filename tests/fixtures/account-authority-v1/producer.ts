import {
  ACCOUNT_CURRENTNESS_PROFILE_V1,
  type AuthenticatedRequestHandleSourceV1,
  type AuthenticatedRequestHandleV1,
  type CurrentAccountAuthorityPortV1,
  type CurrentAccountDiagnosticV1,
  type CurrentAccountResultV1,
  type ExactAccountActionDiagnosticV1,
  type ExactAccountActionRequestV1,
  type ExactAccountActionResultV1,
  type ResolveAccountRequestV1,
} from "@openclaw-enterprise/contracts";

/**
 * Compile-only account authority producer wiring. Dependencies stand for actual
 * trusted implementations; this fixture supplies neither implementation.
 * The resolver loads current credentials, account state and selected IAM Driver.
 * The authorizer repeats that work and checks exact IAM and semantic grants.
 * Both implementations must reject foreign/replayed invocation handles and
 * verify current Driver selection themselves, without native-driver fallback.
 */
export interface TrustedAccountServices {
  readonly resolver: Pick<CurrentAccountAuthorityPortV1, "resolveSubjectV1">;
  readonly authorizer: Pick<CurrentAccountAuthorityPortV1, "authorizeExactV1">;
}

export function createAccountProviderAdapter(
  services: TrustedAccountServices,
): CurrentAccountAuthorityPortV1 {
  return {
    resolveSubjectV1(
      authenticated: AuthenticatedRequestHandleV1,
      input: ResolveAccountRequestV1,
    ): Promise<CurrentAccountResultV1> {
      return services.resolver.resolveSubjectV1(authenticated, input);
    },
    authorizeExactV1(
      authenticated: AuthenticatedRequestHandleV1,
      input: ExactAccountActionRequestV1,
    ): Promise<ExactAccountActionResultV1> {
      return services.authorizer.authorizeExactV1(authenticated, input);
    },
  };
}

/**
 * The accepting service supplies server-resolved scope and exact operation.
 * Authentication comes only from its injected current-invocation dependency.
 * A positive resolution is not an authorization: the exact call must obtain a
 * new current observation, including expected-version comparison. No effect is
 * performed here; even an allowed result requires the real acceptor's remaining
 * scope, audience, runtime, compare-and-consume and durable-audit checks.
 */
export async function observeCurrentInvocation(
  authentication: AuthenticatedRequestHandleSourceV1,
  provider: CurrentAccountAuthorityPortV1,
  request: ExactAccountActionRequestV1,
): Promise<ExactAccountActionResultV1> {
  const authenticated = await authentication.forCurrentInvocation();
  const resolution = await provider.resolveSubjectV1(authenticated, {
    schemaVersion: request.schemaVersion,
    installationId: request.installationId,
    requestId: request.requestId,
    currentnessProfile: request.currentnessProfile,
    createdAt: request.createdAt,
    deadline: request.deadline,
  });
  if (resolution.kind !== "current") return resolution;
  return provider.authorizeExactV1(authenticated, {
    ...request,
    expectedVersions: request.expectedVersions ?? resolution.observation.versions,
  });
}

// Historical diagnostic examples only: neither object contains an authority
// handle, authenticates a caller, or represents a current/live authorization.
export const humanSessionDiagnostic = {
  kind: "current",
  observation: {
    schemaVersion: 1,
    requestId: "req_10000000-0000-4000-8000-000000000001",
    installationId: "ins_10000000-0000-4000-8000-000000000001",
    currentnessProfile: ACCOUNT_CURRENTNESS_PROFILE_V1,
    scope: "account-and-selected-iam-only",
    evaluatedAt: "2026-09-05T00:00:00.000Z",
    validUntil: "2026-09-05T00:00:05.000Z",
    subject: {
      principalId: "principal-human",
      principalKind: "principal",
      credentialMode: "session",
      accountState: "active",
      accountId: "account-human",
      selectedIAM: { driverId: "iam-selected", revision: 3 },
      session: {
        sessionId: "session-human",
        version: 2,
        expiresAt: "2026-09-05T01:00:00.000Z",
      },
    },
    versions: {
      installation: 1,
      account: 1,
      credential: 2,
      grants: 4,
      iamPolicy: 3,
      semanticMapping: 1,
      driverSelection: 3,
    },
  },
} satisfies CurrentAccountDiagnosticV1;

export const independentServiceDiagnostic = {
  kind: "allowed",
  observation: {
    ...humanSessionDiagnostic.observation,
    requestId: "req_10000000-0000-4000-8000-000000000002",
    subject: {
      principalId: "principal-cleanup-service",
      principalKind: "service_principal",
      credentialMode: "service-key",
      serviceClass: "independent",
      accountState: "active",
      namespaceId: "ns_10000000-0000-4000-8000-000000000001",
      selectedIAM: { driverId: "iam-selected", revision: 3 },
      key: {
        keyId: "key-cleanup-service",
        version: 2,
        expiresAt: "2026-09-05T01:00:00.000Z",
      },
    },
    operation: {
      kind: "runtime.cleanup",
      target: {
        namespaceId: "ns_10000000-0000-4000-8000-000000000001",
        agentId: "agt_10000000-0000-4000-8000-000000000001",
        responsibilityRef: "responsibility-predecessor-cleanup",
      },
    },
    decisionRef: "decision-service-cleanup",
    evidence: {
      evidenceRef: "evidence-service-cleanup",
      roleIds: ["role-service-cleanup"],
      bindingIds: ["binding-service-cleanup"],
      semanticGrantRef: "grant-service-cleanup",
    },
  },
} satisfies ExactAccountActionDiagnosticV1;
