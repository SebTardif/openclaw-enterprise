import type { AuthenticatedRequestHandleV1 } from "../../../packages/contracts/src/account-authority-v1.ts";
import type { AuthorityCallV1 } from "../../../packages/contracts/src/runtime-authority-v1.ts";
import {
  parseTurnManagementV1,
  projectTurnCancellationCommitV1,
  projectTurnCancellationReadV1,
  projectTurnStatusV1,
  turnManagementAccountRequestV1,
  turnManagementCancellationOperationMatchesV1,
  turnManagementResultMatchesRequestV1,
  type TurnManagementApplicationV1,
  type TurnManagementDependenciesV1,
  type TurnManagementRequestV1,
  type TurnCancellationRequestV1,
  type TurnCancellationReadRequestV1,
  type TurnStatusRequestV1,
  type TurnManagementResultV1,
  type TurnCancellationResultV1,
} from "../../../packages/contracts/src/turn-management-v1.ts";

/** Compiling owner integration example. These callbacks must be implemented by
 * the actual accepting AUT/service owner. This fixture supplies no implementation,
 * handle factory, cache, view authority or scope-resolution proof. */
export interface AcceptingViewExample {
  resolveExactView(
    authenticated: AuthenticatedRequestHandleV1,
    request: TurnManagementRequestV1,
  ): Promise<void>;
  assertCurrent(
    authenticated: AuthenticatedRequestHandleV1,
    request: TurnManagementRequestV1,
  ): Promise<void>;
  now(): string;
}
async function authorize(
  deps: TurnManagementDependenciesV1,
  view: AcceptingViewExample,
  authenticated: AuthenticatedRequestHandleV1,
  request: TurnManagementRequestV1,
  call: AuthorityCallV1,
): Promise<boolean> {
  await view.resolveExactView(authenticated, request);
  checkCall(request, call);
  const result = await deps.authority.authorizeExactV1(
    authenticated,
    turnManagementAccountRequestV1(request),
  );
  checkCall(request, call);
  const locator = request.kind === "status" ? request.locator : request.cancellation.locator;
  if (
    result.kind !== "allowed" ||
    result.observation.subject.principalId !== locator.callerPrincipalRef
  )
    return false;
  // The callback inspects genuine evidence/current exact scope, not this boolean.
  await view.assertCurrent(authenticated, request);
  checkCall(request, call);
  return true;
}
function checkCall(request: TurnManagementRequestV1, call: AuthorityCallV1): void {
  if (
    call.signal.aborted ||
    call.requestRef !== request.invocation.account.requestId ||
    call.deadline !== request.invocation.account.deadline
  )
    throw new Error("Invocation unavailable.");
}

/** Status uses the original read port. Projection excludes transcript/native IDs. */
export async function readStatusExample(
  deps: TurnManagementDependenciesV1,
  view: AcceptingViewExample,
  authenticated: AuthenticatedRequestHandleV1,
  input: TurnStatusRequestV1,
  call: AuthorityCallV1,
) {
  const request = parseTurnManagementV1("statusRequest", input);
  checkCall(request, call);
  if (!(await authorize(deps, view, authenticated, request, call)))
    return { kind: "not-visible" } as const;
  const result = await deps.journal.read(
    (reader) => reader.findAttempt(request.locator.attempt, call),
    call,
  );
  checkCall(request, call);
  await view.assertCurrent(authenticated, request);
  checkCall(request, call);
  if (result.kind === "unavailable") return result;
  if (result.kind !== "found") return { kind: "not-visible" } as const;
  const projected = projectTurnStatusV1(request.locator, result.record, view.now());
  if (!turnManagementResultMatchesRequestV1(request, projected))
    throw new Error("Result unavailable.");
  return projected;
}
/** Only one real outer transaction; no new journal or distributed transaction.
 * Caller wraps pre-submission failures as sanitized unavailable. After submission,
 * all thrown/aborted settlement remains commit-unknown, with status-only readback.
 */
export async function cancelExample(
  deps: TurnManagementDependenciesV1,
  view: AcceptingViewExample,
  authenticated: AuthenticatedRequestHandleV1,
  input: TurnCancellationRequestV1,
  call: AuthorityCallV1,
): Promise<TurnCancellationResultV1> {
  const request = parseTurnManagementV1("cancellationRequest", input);
  checkCall(request, call);
  if (!(await authorize(deps, view, authenticated, request, call))) return { kind: "not-visible" };
  const verified = await deps.cancellation.authorizeCancellation(
    request.cancellation.operation,
    call,
  );
  if ("kind" in verified) return verified.kind === "denied" ? { kind: "not-visible" } : verified;
  checkCall(request, call);
  await view.assertCurrent(authenticated, request);
  checkCall(request, call);
  try {
    const committed = await deps.journal.transact(
      request.cancellation.transactionRef,
      async (unit) => {
        await view.assertCurrent(authenticated, request);
        checkCall(request, call);
        const inspected = await deps.cancellation.inspectCancellation(verified, call);
        await view.assertCurrent(authenticated, request);
        checkCall(request, call);
        if ("kind" in inspected) return inspected;
        // The canonical operation digest binds all immutable management identity.
        if (!turnManagementCancellationOperationMatchesV1(request.cancellation, inspected))
          throw new Error("Operation mismatch.");
        return unit.commitCancellation(verified, call);
      },
      call,
    );
    checkCall(request, call);
    await view.assertCurrent(authenticated, request);
    checkCall(request, call);
    const projected = projectTurnCancellationCommitV1(request.cancellation, committed, view.now());
    if (!turnManagementResultMatchesRequestV1(request, projected))
      return { kind: "commit-unknown" };
    return projected;
  } catch {
    return { kind: "commit-unknown" };
  }
}
/** Readback calls no provenance mutation or journal transaction. Current requester
 * cancellation-purpose owning view is checked again, including initiator revocation. */
export async function findCancellationExample(
  deps: TurnManagementDependenciesV1,
  view: AcceptingViewExample,
  authenticated: AuthenticatedRequestHandleV1,
  input: TurnCancellationReadRequestV1,
  call: AuthorityCallV1,
) {
  const request = parseTurnManagementV1("cancellationReadRequest", input);
  checkCall(request, call);
  if (!(await authorize(deps, view, authenticated, request, call)))
    return { kind: "not-visible" } as const;
  const state = await deps.journal.read(
    (reader) => reader.findCancellation(request.cancellation.operation, call),
    call,
  );
  checkCall(request, call);
  await view.assertCurrent(authenticated, request);
  checkCall(request, call);
  const projected = projectTurnCancellationReadV1(request.cancellation, state, view.now());
  if (!turnManagementResultMatchesRequestV1(request, projected))
    throw new Error("Result unavailable.");
  return projected;
}

/** Independent presentation consumer: never retries a mutation, redirects output
 * to a native destination or converts an intent to physical termination. */
export async function presentationExample(
  app: TurnManagementApplicationV1,
  authenticated: AuthenticatedRequestHandleV1,
  request: TurnManagementRequestV1,
  signal: AbortSignal,
): Promise<string> {
  let result: TurnManagementResultV1;
  if (request.kind === "status") result = await app.status(authenticated, request, signal);
  else if (request.kind === "request-cancellation")
    result = await app.requestCancellation(authenticated, request, signal);
  else result = await app.findCancellation(authenticated, request, signal);
  if (signal.aborted) return "Unavailable";
  if (!turnManagementResultMatchesRequestV1(request, result)) return "Unavailable";
  if (result.kind === "intent" || result.kind === "found")
    return "Cancellation recorded; termination is not established";
  if (result.kind === "commit-unknown")
    return "Cancellation outcome unknown; use exact authorized status readback";
  if (result.kind === "status") return result.outcome.kind;
  return "Unavailable";
}

export function cannotMintAuthority(): void {
  // @ts-expect-error Serialized principal expectations are not an authenticated handle.
  const forged: AuthenticatedRequestHandleV1 = { principalId: "example" };
  void forged;
  // @ts-expect-error A method-local success is not an outer committed transaction.
  const wrong: Parameters<typeof projectTurnCancellationCommitV1>[1] = { kind: "recorded" };
  void wrong;
}
