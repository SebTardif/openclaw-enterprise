import {
  ACCOUNT_CURRENTNESS_PROFILE_V1,
  decodeCurrentAccountDiagnosticV1,
  decodeExactAccountActionDiagnosticV1,
  type AccountAuthorityFailureV1,
  type AccountAuthorityObservationHandleV1,
  type AccountOperationV1,
  type AccountSubjectV1,
  type AuthenticatedRequestHandleSourceV1,
  type AuthenticatedRequestHandleV1,
  type CurrentAccountAuthorityPortV1,
  type CurrentAccountResultV1,
  type ExactAccountActionRequestV1,
  type ExactAccountActionResultV1,
  type ResolveAccountRequestV1,
} from "@openclaw-enterprise/contracts";

/**
 * Compile-only conversation-read consumer; never invoked by a test.
 * The real adapter supplies invocation authentication and independently resolves
 * the exact target. This fixture implements neither authentication nor a route.
 */
type ConversationRead = AccountOperationV1 & {
  readonly kind: "conversation.read";
};

type PendingGuardedRead = {
  readonly kind: "requires-guarded-read";
  readonly authenticated: AuthenticatedRequestHandleV1;
  readonly request: ExactAccountActionRequestV1;
  readonly observed: Extract<ExactAccountActionResultV1, { kind: "allowed" }>;
};

function unreachable(value: never): never {
  throw new Error("Unhandled account authority result.");
}

/**
 * This invocation-local handoff is not an effect permit or response payload.
 * The accepting route must compare all current authority at the real read acceptor,
 * establish its effect guard, and accept durable audit before disclosing data.
 * An allowed observation alone must never be used to read history or cursors.
 */
export async function prepareConversationRead(
  source: AuthenticatedRequestHandleSourceV1,
  accounts: CurrentAccountAuthorityPortV1,
  serverRequest: ResolveAccountRequestV1,
  serverResolvedOperation: ConversationRead,
): Promise<PendingGuardedRead | AccountAuthorityFailureV1> {
  const authenticated = await source.forCurrentInvocation();
  const current = await accounts.resolveSubjectV1(authenticated, serverRequest);
  switch (current.kind) {
    case "denied":
      return { kind: "denied" };
    case "not-visible":
      return { kind: "not-visible" };
    case "unavailable":
      return { kind: "unavailable" };
    case "current": {
      // Resolve success supplies expected versions, never reusable authorization.
      const request: ExactAccountActionRequestV1 = {
        ...serverRequest,
        currentnessProfile: ACCOUNT_CURRENTNESS_PROFILE_V1,
        operation: serverResolvedOperation,
        expectedVersions: current.observation.versions,
      };
      const observed = await accounts.authorizeExactV1(authenticated, request);
      switch (observed.kind) {
        case "denied":
          return { kind: "denied" };
        case "not-visible":
          return { kind: "not-visible" };
        case "unavailable":
          return { kind: "unavailable" };
        case "allowed":
          return { kind: "requires-guarded-read", authenticated, request, observed };
        default:
          return unreachable(observed);
      }
    }
    default:
      return unreachable(current);
  }
}

/** Successful JSON validation provides diagnostics, never invocation provenance. */
export function rejectDiagnosticAuthority(input: unknown): void {
  const current = decodeCurrentAccountDiagnosticV1(input);
  if (current.kind === "valid" && current.value.kind === "current") {
    // @ts-expect-error Deserialized current diagnostics have no trusted authority handle.
    const protectedCurrent: CurrentAccountResultV1 = current.value;
    // @ts-expect-error Schema-valid subject data cannot authenticate an invocation.
    const authenticated: AuthenticatedRequestHandleV1 = current.value.observation.subject;
    void protectedCurrent;
    void authenticated;
  }

  const action = decodeExactAccountActionDiagnosticV1(input);
  if (action.kind === "valid" && action.value.kind === "allowed") {
    // @ts-expect-error An allowed diagnostic is not a trusted port result.
    const protectedAction: ExactAccountActionResultV1 = action.value;
    // @ts-expect-error A validated observation cannot supply its own provenance handle.
    const authority: AccountAuthorityObservationHandleV1 = action.value.observation;
    void protectedAction;
    void authority;
  }
}

/** Closed discriminants prevent human sessions from becoming service authority. */
export function rejectUnsupportedSubjectsAndOperations(
  subject: AccountSubjectV1,
  conversation: ConversationRead,
): void {
  if (subject.principalKind === "service_principal") {
    // @ts-expect-error Independent service authority is backed by a key, not a human session.
    const session = subject.session;
    void session;
  } else {
    // @ts-expect-error A human session cannot be treated as service-key authority.
    const key = subject.key;
    void key;
  }

  // @ts-expect-error The closed operation vocabulary has no wildcard authorization action.
  const wildcard: AccountOperationV1 = { ...conversation, kind: "agent.*" };
  const callerPrincipal: AccountOperationV1 = {
    ...conversation,
    target: {
      ...conversation.target,
      // @ts-expect-error The exact target cannot carry a caller-selected principal.
      principalId: "caller-selected-principal",
    },
  };
  void wildcard;
  void callerPrincipal;
}
