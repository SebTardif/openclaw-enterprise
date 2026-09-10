# Repository read execution binding

The Runtime selected-execution consumer connects an authenticated GitHub read
Session to an execution retained by its original accepting owner. It supports
metadata protocol V2 and Git discovery/upload-pack protocol V3. It does not admit
publication or derive an execution from an attachment name.

`createRepositoryWorkNativeExecutionSourceV2` takes the original native Session
source, the fixed `RepositoryWorkAcceptedExecutionOwnerV2`, the current service
registry reader, one explicit protocol version and bounded acquisition limits.
It implements State's `RepositoryWorkNativeSelectedExecutionSourceV2` contract.
Each successful acquisition produces a private Runtime execution handle. Copied
handles, foreign Sessions and unrelated State contexts fail recognition.

The accepting owner must return its original execution borrow only after known
journal-start commitment and original native acceptance. Its handle must already
bind the Session to the exact retained ready execution, Runtime assignment and
preparation child, and explicitly selected Work admission operation. A journal
start document, request field, historical row or matching identifier cannot
create that membership. The consumer preserves the exact original admission
operation object when exposing comparison data to State.

State binds its original participant once. `retain(context, execution, session,
call)` authenticates that exact State context before entering the accepting
owner's current-use prefix. State retains ownership of journal, assignment,
preparation, current policy, first Work admission and transaction locks. Runtime
performs no SQL and grants no authority during a State readset handoff.

The consumer captures original methods and receivers at construction. Before
returning an execution it refreshes the actual native Session/Exchange and the
registered service, checks the closed V2/V3 profile pair, and compares the full
original attempt and scope with the Runtime assignment and admission facts.
Subsequent currentness checks preserve the original context, request, recipient,
native transport and execution membership. A new call must first be authenticated
by the original native source; changing a deadline cannot create an Exchange.

Per-call cutoffs use monotonic time and never reset for the same deadline. Native,
execution and admission horizons can only shorten a borrow. The native Session
lifetime is independent of a successful RPC's temporary cancellation signal.
Releasing a Runtime borrow joins its accepted work and current State holds, then
releases the original execution borrow. It does not close the native transport
or terminate the whole selected execution. State prefix cleanup also waits for
entered preparation work. Unexpected asynchronous assertions are refused and
joined to every original State drain currently holding that execution.

The component test entry is
`tests/conformance/repository-work-native-execution-v2.test.mjs`. It uses
contract-faithful internal peers to exercise the real consumer's membership,
comparison, time and cleanup behavior. Those peers do not establish native
authentication, journal COMMIT, PostgreSQL, first Work admission, credentials or
deployment qualification. Run this entry with the repository's maintained Node
test runner when its exact receiving prerequisites and execution resources are
selected.

The original journal/native accepting producer remains a separate construction
dependency. The source contains no replacement producer or data enrollment API.
Controller deployment must provide that original owner and the original State,
Work and fixed custody components before it can serve repository reads.

## Controller read assembly

Trusted process composition defines a metadata service with
`defineControllerGitHubMetadataReadV2` and a Git read service with
`defineControllerGitHubGitReadV3`. Both require an explicit native binary,
listener, permitted recipient, registered service identity, peer UID, trusted
ancestor UIDs, finite limits, original accepting owner and original Work
construction receiver. Their returned startup definitions have private module
membership. Plain configuration objects and copied definitions cannot start a
service. There is no publication constructor or protocol fallback.

Set `ProductionConfig.githubReadServices` to the selected definitions. The
maintained production composition captures its existing controller's original
`DriverSelection` and supplies it with the same State, installation and runtime
service trust instance to `startControllerGitHubReadMediation`. The assembly
allows at most one metadata and one Git read service, with distinct listener
paths and service identities. It validates and reserves the entire selected set
before the first startup wait; definitions cannot be reused for a second start.

The actual native starter invokes its operations factory once with its original
Session source. The factory constructs the Runtime execution consumer and calls
`state.repositoryWorkSelectedExecutionAdmissionV2(originalSelection, options)`.
It gives that exact admission core and the same native/execution sources to the
fixed Work construction receiver, then constructs the existing
`RepositoryWorkOperationOwnerV2` from the returned original sources. The Work
receiver completes its original selection/use, observation, inventory and custody
composition. The admission core is not a full selection source and is never cast
to one. The receiver must own cleanup if its constructor throws before returning
collaborators.

Startup failures join every successfully constructed service. Normal shutdown
stops the Work owner first, joins native transport closure, releases the fixed
Work collaborators and retires the Runtime execution consumer before the
production State owner closes its database pool. Failure of one cleanup does not
skip the others. The native starter currently exposes startup completion and
`close()`; it does not expose an independent ongoing liveness signal. This
assembly therefore makes no additional native readiness claim.

`tests/conformance/github-read-mediation-composition.test.mjs` exercises actual
assembly and Work-owner construction with controlled internal native and State
peers. It covers literal V2/V3 selection, constructor and receiver capture,
invalid/copied definitions, competing startup, partial construction failure and
joined shutdown. Its maintained entry uses Node's
`--experimental-test-module-mocks --test` flags. Component results remain
separate from qualification of the original selected-execution producer, full
Work/custody construction and a deployed native listener.
