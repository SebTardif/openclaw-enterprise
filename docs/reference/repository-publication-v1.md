# Publication coordinator

This library coordinates a proposed branch update and a later draft pull request.
It binds the exact publishing request to a saved
[Git snapshot](git-object-store.md), then calls supplied Work, State, and dispatcher
interfaces in the required order.

It is exported at `@openclaw-enterprise/occ/repository-publication-v1`. There is
no controller route or default publisher. The supplied interfaces still need
real application implementations before a user can approve or publish a change.

## Why it exists

Keeping commit A's bytes available solves only part of publishing an approved
change. Approval must also name the repository, target branch, expected previous
branch tip, and exact PR title/body. Otherwise the same saved content could be
sent somewhere the person did not approve.

A push and a draft PR are separate operations. A push may succeed while PR
creation fails or its response is lost. The coordinator preserves that distinction
so callers can see partial success and avoid repeating an uncertain operation.

## Inputs and operations

`RepositoryPublicationOwnerV1` requires these constructor options:

| Option       | Responsibility                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `store`      | A real `GitObjectStore` for capture and recovery.                                              |
| `work`       | Admit the requesting operation and check its current authority.                                |
| `state`      | Persist candidates, approvals, and distinct operation results; enforce current IAM and policy. |
| `dispatcher` | Prepare and send the exact branch update or draft-PR request.                                  |
| `policy`     | Explicit approver, repository, branch, creation, and expiry rules.                             |
| `clock`      | Time and an explicit uncertainty bound, used for expiry checks.                                |
| `maxPending` | Maximum number of accepted application operations, from 1 to 64.                               |

The collaborator interfaces exchange handles recognized by the component that
issued them. A copied identifier or structurally matching object does not create
authentication, approval, or permission to send a request.

| Method    | Resulting sequence                                                                                                                            |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare` | Admit Work, capture Git bytes, bind the full request, and ask State to persist the candidate.                                                 |
| `approve` | Obtain State's approval lease, reopen the saved snapshot, recheck policy/currentness, and commit approval.                                    |
| `publish` | Claim a push, prepare it, recheck current authority, send it, and record its result. Only a confirmed push permits a separate draft-PR claim. |
| `status`  | Read the candidate's durable status through State.                                                                                            |
| `close`   | Stop accepting operations and wait for pending work and collaborator cleanup.                                                                 |

The candidate digest covers Work identity/revisions, numeric GitHub repository
and installation identity, base and target branches, captured base and proposed
commit IDs, expected previous target or creation, the snapshot descriptor, and
exact draft-PR title/body. Its only action sequence is `push`, then
`create-draft-pr`. The store receives only the three Git root/ancestry fields;
approval retains the complete publishing request.

## Approval and publishing requirements

The local policy check compares data. It does not authenticate a human. Real
approval integration must authenticate an eligible human and apply current
exact-Agent IAM permission and the configured approver list. The initial human
workflow may allow an eligible requester to approve; Agents and helpers cannot
approve. The current component's `allowSelfApproval` field only compares principal
IDs and must be reconciled with that authenticated workflow when integrated.

The dispatcher must provide an atomic comparison with the expected previous
branch tip and a fast-forward requirement. Reading the branch first and later
sending a generic update is insufficient. The profile allows one branch update
followed by a same-repository draft PR; force pushes, deletion, tags, and multiple
ref updates are absent.

Draft-PR creation selects branch names, which can move. The coordinator therefore
checks the returned repository, branches, commit IDs, title/body, draft flag,
number, and URL. It cannot promise an atomic commit-ID condition on GitHub's PR
creation API. A mismatched observation remains uncertain while any confirmed
push remains visible.

## Results, cancellation, and recovery

A `complete` method result means the status was read successfully. Inspect its
`state` and the separate push/PR outcomes to determine whether publication
finished. Unknown results never authorize automatic replay.

Once a submission may have occurred, caller cancellation must not discard its
result. The coordinator observes an available result promise before reading the
submission's `drained` promise, and waits for settlement even if that later field
is missing or throws. State must retain the actual result and account for it
durably before releasing its observer. Those guarantees depend on the real State
and dispatcher implementations honoring their interfaces.

Cleanup retries operate on the same handles and cannot submit another upstream
operation. Persistent cleanup failure keeps the operation and `close()` pending;
this component supplies no operational recovery deadline. Durable recovery,
reconciliation, and an approval-only application composition remain integration
work. Reopening a Git snapshot alone restores neither approval nor a right to
publish.

## Verification

See [coordinator testing](../testing/repository-publication.md). Its controlled
collaborators verify sequencing, comparisons, shutdown, and result retention.
They do not establish a working human approval flow, PostgreSQL persistence,
GitHub publication, or deployment readiness.
