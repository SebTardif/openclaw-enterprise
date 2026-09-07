# Workload profile request authentication

Workload profile deployment, draft selection and deployment recovery require the
original controller request, a current human session and the account participant
bound to the selected transaction or recovery read. A browser cookie alone does
not authorize a workload profile operation.

## Construction and HTTP receiving order

Create one request custody instance through
`auth.admissionVerifier.createWorkloadProfileRequestCustodyV1({ maxRequestLifetimeMs })`
before constructing the controller. The lifetime is explicitly configured and
bounded to 1–120,000 milliseconds. The production and development PostgreSQL
composition callers select a server-owned 30,000-millisecond ceiling. Supply its stable `invocations` and `requests`
sources to the original workload profile account composition. Supply that same
instance to the HTTP application as `workloadProfileRequests`.

After the application creates its existing admission, identity-context and
identity-authority maps, attach those exact maps once, together with the original
controller recipient and selected IAM Driver. This two-stage construction does
not mutate an already constructed controller's options. An arbitrary existing
controller cannot be retrofitted with another request source.

The admission hook begins custody before awaiting verification. It captures only
the original successful verifier result after the configured Origin check. The
application closes custody on ServerResponse `close`, `onResponse`, or request abort; admission
failure also closes it. Close is permanent even if it happens before admission
begins. A closed request cannot be reopened by a later verifier completion.

The verifier uses BetterAuth's actual primary-store session result with cookie
cache and refresh disabled. It privately retains the selected session ID, user
ID, expiry and SHA-256 digest of the actual session token. Neither the token nor
its digest is added to `AdmittedCaller`, the opaque handle, public request facts,
logs or response bodies. Missing complete session evidence keeps the workload
profile producer unavailable. Existing service-key admission stays distinct and
does not become a human-session request.

## Exact invocation binding

A draft update with explicit selection uses one detached canonical
`UpdateAgentInput` for both binding and callback; an omitted selection keeps the
ordinary update path. Precreation and receiver attachment alone do not enroll a
workload-profile service; the original central constructor supplies enrollment.

The receiving route wraps the original operation in
`withWorkloadProfileInvocation(actualRequest, { purpose, binding }, work)`.
The three supported purposes are:

| Purpose                                | Binding                                                    |
| -------------------------------------- | ---------------------------------------------------------- |
| `workload-profile-deployment`          | Original readonly `[principalId, DeployAgentCommandInput]` |
| `workload-profile-draft-selection`     | Original readonly `[principalId, UpdateAgentInput]`        |
| `workload-profile-deployment-recovery` | Original readonly `[principalId, DeployAgentCommandInput]` |

The complete binding is copied immutably before asynchronous acquisition. The
original opaque handle is accepted once, only within that invocation and by the
same custody source. The request, admitted caller, resolved Principal, selected
IAM Driver, recipient, operation and original lifetime remain current through
the outer transaction's final fence. No native-channel or turn-command handle is
accepted as a substitute.

Recovery runs after the failed transaction has unwound. It uses a fresh handle
and the original recovery-read owner with the same command. It does not renew the
HTTP request deadline, reuse the failed transaction's enrollment or acquire an
active workload profile. The original central owner supplies outcome handling;
this request adapter does not replay a command after uncertain commit. Session
expiry is anchored once during authentic capture to the original request wall and
monotonic clock observations, retaining any earlier capture deadline. Deployment
and recovery reuse that same bound; a wall-clock rollback cannot renew it.

An unavailable or inactive required invocation uses the original
`DependencyUnavailableError`, which the existing HTTP mapper reports as 503
`DEPENDENCY_UNAVAILABLE`. The wrapper preserves the callback's original errors,
including 403, 404, 409 and uncertain-commit outcomes; it does not blanket-wrap
transaction failures.

## Required original session reader

The session-security consumer resolves its lookup only from a genuinely consumed
request lease and its same canonical `WorkloadProfileAccountUnit`. A copied lease
or different unit cannot extract that lookup. The supplied original reader must
recognize the real unit and use its original client before the IAM policy seal.

The locked result must match the exact Installation, account issuer/subject,
account and session IDs, and private credential digest. It must contain the
actual active account-security record, retained incarnation, bounded positive
writer-owned account version, current user and credential locators, matching
session owner and an unexpired session. These fields are read once. No default
version, session epoch, historical activation or account backfill is inferred.

The original state and SQL owners must provide writer exclusion for every
identity-affecting user, credential and session mutation, including token
replacement and deletion. They also own helper privileges and the lock order.
The consumer declaration does not provide those mechanisms. A missing original
reader, helper privilege, current record or session yields no authority.

## Cleanup and evidence limits

The account participant transfers cleanup through the original canonical unit
before acquisition. Reader cleanup is captured before later result getters or
fences can fail. Only the original owner joins accepted work and the raw commit,
rollback or uncertain-outcome cleanup, then invokes the transferred callbacks.
The local account lease's release closes its observation; it does not release
SQL locks. Final currentness uses the active outer owner/client, not a short
acquisition callback that has already finished. Malformed asynchronous fences
are refused and their accepted work remains joined before cleanup.

The focused tests exercise actual controller capture, HTTP admission, identity
receiving, opaque request custody and both account consumers with controlled
verifier, IAM and reader/transaction collaborators. They do not execute a login,
real database/helper/role, provider, deployment or native runtime. Successful
controlled tests do not qualify production assembly or its writer exclusion.
