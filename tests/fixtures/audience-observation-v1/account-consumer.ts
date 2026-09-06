import {
  audienceReaderAccountsMatchObservationV1,
  audienceObservationMatchesRequestV1,
  decodeAudienceDiagnosticV1,
  type AudienceActingAccountV1,
  type AudienceFailureV1,
  type AudienceInvocationHandleV1,
  type AudienceObservationPortV1,
  type AudienceObservationResultV1,
  type AudienceObservationRequestV1,
  type AudienceReaderAccountPortV1,
  type AudienceReaderAccountsHandleV1,
  type AudienceReaderAccountsDiagnosticV1,
  type AudienceReaderAccountsResultV1,
} from "@openclaw-enterprise/contracts/audience-observation-v1";
import {
  ACCOUNT_CURRENTNESS_PROFILE_V1,
  type CurrentAccountAuthorityPortV1,
  type ExactAccountActionDiagnosticV1,
  type ExactAccountActionResultV1,
} from "@openclaw-enterprise/contracts/account-authority-v1";

/**
 * Independently compiled account consumer. Actual ports/handles are injected by
 * their original owners, never manufactured for synthetic readers. This example
 * collects no positive effect authorization: the exact journal composition is absent.
 */
export async function checkBeforeCanonicalComposition(input: {
  readonly invocation: AudienceInvocationHandleV1;
  readonly request: AudienceObservationRequestV1;
  readonly audience: AudienceObservationResultV1;
  readonly native: AudienceObservationPortV1;
  readonly readers: AudienceReaderAccountPortV1 | undefined;
  readonly account: CurrentAccountAuthorityPortV1;
  readonly actor: AudienceActingAccountV1;
  readonly signal: AbortSignal;
}): Promise<AudienceFailureV1> {
  const { invocation, request, native, signal } = input;
  if (input.audience.kind !== "observed") return input.audience;
  const custody = input.audience.custody;
  let accountCustody: AudienceReaderAccountsHandleV1 | undefined;
  try {
    if (signal.aborted) return { kind: "unavailable", reason: "cancelled" };
    if (!input.readers) return { kind: "unavailable", reason: "missing-reader-account-producer" };
    const current = await native.inspectV1(invocation, custody, request, signal);
    if (current.kind !== "observed") return current;
    const decoded = decodeAudienceDiagnosticV1({
      kind: "observed",
      observation: current.observation,
    });
    if (decoded.kind === "invalid" || decoded.value.kind !== "observed") return { kind: "denied" };
    const observation = decoded.value.observation;
    if (
      current.custody !== custody ||
      observation.observationRef !== input.audience.observation.observationRef ||
      !audienceObservationMatchesRequestV1(observation, request)
    )
      return { kind: "denied" };
    const checked = await input.readers.checkReadersV1(invocation, custody, request, signal);
    if (checked.kind !== "checked") return checked;
    accountCustody = checked.custody;
    if (!audienceReaderAccountsMatchObservationV1(checked.observation, observation))
      return { kind: "denied" };
    if (signal.aborted) return { kind: "unavailable", reason: "cancelled" };
    // Original acting permission remains independent from passive-reader disclosure.
    // Its exact operation is resolved and bound by the accepting owner, not this example.
    const actor = await input.account.authorizeExactV1(input.actor.authenticated, {
      schemaVersion: 1,
      requestId: request.requestId,
      installationId: request.scope.installationId,
      currentnessProfile: ACCOUNT_CURRENTNESS_PROFILE_V1,
      createdAt: request.startedAt,
      deadline: request.deadline,
      operation: input.actor.operation,
    });
    if (actor.kind !== "allowed")
      return actor.kind === "unavailable"
        ? { kind: "unavailable", reason: "dependency-unavailable" }
        : actor;
    if (signal.aborted) return { kind: "unavailable", reason: "cancelled" };
    // TODO: consume the exact permitted journal declarations through the sole OCC
    // transaction and recheck current native/account/binding versions at consumption.
    // No substitute attempt/slot/effect type or positive completion is exported here.
    return { kind: "unavailable", reason: "missing-effect-composition" };
  } finally {
    try {
      if (accountCustody && input.readers)
        await input.readers.releaseV1(invocation, accountCustody);
    } finally {
      await native.releaseV1(invocation, custody);
    }
  }
}

function diagnosticIsNotAuthority(diagnostic: ExactAccountActionDiagnosticV1): void {
  // @ts-expect-error account-authority diagnostic decoding cannot manufacture an authority handle.
  const noAccountAuthority: ExactAccountActionResultV1 = diagnostic;
  void noAccountAuthority;
}
void diagnosticIsNotAuthority;

function readerDiagnosticIsNotCustody(diagnostic: AudienceReaderAccountsDiagnosticV1): void {
  // @ts-expect-error Passive-reader diagnostics cannot mint account observation custody.
  const noReaderCustody: AudienceReaderAccountsResultV1 = diagnostic;
  void noReaderCustody;
}
void readerDiagnosticIsNotCustody;

/** Synthetic passive-reader data, intentionally without any login/session/key. */
export function syntheticReaderAccountsDiagnostic(
  request: AudienceObservationRequestV1,
  nativeObservationRef: string,
): AudienceReaderAccountsDiagnosticV1 {
  const { namespaceId, agentId, conversationRef, commonGrantRef } = request.target;
  return {
    kind: "checked",
    observation: {
      schemaVersion: 1,
      nativeObservationRef,
      request,
      evaluatedAt: "2026-01-01T00:00:00.200Z",
      validUntil: "2026-01-01T00:00:04.800Z",
      clockUncertaintyMs: 20,
      selectedIAM: { driverId: "synthetic-selected-iam", revision: 1 },
      operation: {
        kind: "conversation.read",
        target: { namespaceId, agentId, conversationRef, commonGrantRef },
      },
      readers: ["a", "b"].map((suffix) => ({
        readerRef: `synthetic-reader-${suffix}`,
        providerSubjectRef: `synthetic-user-${suffix}`,
        principalId: `synthetic-principal-${suffix}`,
        accountId: `synthetic-account-${suffix}`,
        accountState: "active",
        humanBindingId: `synthetic-human-binding-${suffix}`,
        humanBindingVersion: 1,
        versions: {
          installation: 1,
          account: 2,
          grants: 3,
          iamPolicy: 4,
          semanticMapping: 5,
          driverSelection: 6,
        },
        decisionRef: `synthetic-decision-${suffix}`,
        roleIds: ["synthetic-read-role"],
        accessBindingIds: [`synthetic-read-binding-${suffix}`],
      })),
    },
  };
}
