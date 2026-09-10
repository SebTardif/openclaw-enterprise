# Trusted repository publication

The version 1 publication component captures an immutable Git candidate and
coordinates three application actions: prepare, approve, and publish. Publication
means one expected-old branch update followed by a separate draft pull request.
The application never exposes a production token or performs GitHub HTTP requests.

## What this component implements

`GitObjectCustodyV1` validates and retains actual Git object bytes in a selected
protected persistent directory. `RepositoryPublicationOwnerV1` implements the
application sequence through purpose-specific original Work, State/IAM, and
dispatcher interfaces. It has no permissive provider, synthetic approval, or
fallback transport.

The declarations alone do not establish those original suppliers. A production
composition must provide actual Work admission, configured approval policy and
current IAM, durable candidate and effect records, and the authenticated protected
dispatcher. Object-custody and decoder tests are component evidence. They do not
establish successful publication through those internal owners or qualify a live
deployment.

## Immutable candidate

A candidate binds all of the following into its versioned SHA-256 action digest:

- The original Work operation, invocation, Work and authority revisions, execution
  binding digest, requester, and installation/Agent scope.
- The stable numeric GitHub repository and App installation identity.
- Base branch and captured base OID; target branch and either an exact expected
  old OID or explicit branch creation.
- Exact proposed commit OID, complete object-graph digest, retained pack digest,
  object count, and byte counts.
- Exact draft PR title and body and the ordered action bundle `push`, then
  `create-draft-pr`.

These records are comparison data. A Git OID, captured graph, database COMMIT,
candidate reference, or caller-supplied object is not human approval or permission
to dispatch. Only the original sources recognize their private operands.

### Supported Git object profile

The import accepts bounded explicit records containing an OID, object type, and
raw bytes. It copies the records before awaiting validation. It accepts SHA-1
commit, tree, and blob objects with complete ancestry and tree closure. Both the
proposed commit and captured base are graph roots. An update additionally requires
the expected old commit to be an ancestor of the proposed commit. Unreachable
extra objects, missing history, wrong-type edges, and duplicate OIDs are refused.

The initial profile supports regular files, executable files, and directories.
It refuses tags, submodules, symlinks, noncanonical tree order, ambiguous paths,
and nonportable names. Names are bounded printable ASCII with explicit exclusions
for traversal, Git-directory aliases, case collisions, and platform-special
names. Commit headers support tree, bounded parents, author, committer, optional
UTF-8 encoding, and a folded `gpgsig` header. Other extension headers are refused.
Signatures are retained content; this component does not interpret them as approval.

Limits separately bound unique objects, individual and aggregate raw bytes,
retained pack bytes, tree depth, path length, expanded root paths, and capture
time. Shared subtrees are checked at every root path. Large or shallow histories
that exceed this profile are unsupported; no omitted base objects are trusted
implicitly.

The custodian emits a normal non-delta Git PACK v2 with a checksum, using the
[Git pack format](https://git-scm.com/docs/gitformat-pack). Each OID is checked
against its canonical object framing and by a fixed Git `hash-object` invocation.

### Protected execution and storage

Construction requires the absolute protected Git executable path, its SHA-256
pin, and its exact expected owner UID. The selected build must support
collision-detecting SHA-1. An executable name or version string does not prove
that build property. A local SHA-256 graph digest does not change Git's remote
SHA-1 object namespace or establish that namespace as collision-free.

On Linux the custodian retains a verified executable descriptor and rechecks its
identity and contents before use. It invokes only `hash-object --no-filters
--stdin -t <closed-type>`, with `--no-replace-objects`, an explicit nonrepository
`--git-dir=/dev/null`, a fixed environment, no shell, and `/` as the working
directory. It supplies raw copied object bytes on stdin. There is no repository
path, checkout, hook, attribute filter, helper, replacement, alternate, ambient
configuration, or project-command operand. Child output and lifetime are bounded;
cancellation joins actual child exit.

The selected directory must already exist, be owned by its configured UID, have
mode `0700`, and have no symlink components. Files are content-addressed, mode
`0600`, and published exclusively with file and directory fsync. Existing bytes
are compared rather than overwritten. Reads reject hardlinks, symlinks, ownership
changes, content corruption, and replacement of the selected directory. The
stored bundle retains raw objects and exact pack bytes; recovery revalidates the
graph and the selected Git object hashes. Exported pack buffers are fresh copies.

`durability: "persistent-posix"` is an explicit deployment selection, not a proof
that a temporary directory or container writable layer survives rescheduling.
The deployment must mount persistent custody-only storage, enforce the selected
owner and access boundary, and provision adequate finite storage. No temporary,
memory, or alternate-volume fallback is supplied. The directory stores immutable
content; candidate, approval, and effect journals belong to State. Failed or
cancelled capture can leave retained content without an approved candidate.
Garbage collection and storage lifetime must account for durable State references.

## Approval policy and original authority

The constructor requires an explicit immutable policy: policy reference and
revision, selected approver principals, self-approval behavior, exact repository
and base/target branch rules, permission to create a branch, and approval lifetime.
There is no default approver, wildcard repository, or implicit self-approval.

The local predicate adds closed policy checks; it does not authenticate anyone.
The actual State/IAM supplier must authenticate the original actor, hold and
recheck current policy and Work authority, and commit approval for the exact
candidate/action digest and expiry. The application reopens retained Git content
before approval and compares the committed approval with the original selection.
A factual protected clock with an explicit usable uncertainty bound is required.

The application preserves the exact original call object supplied to Work, State,
and the dispatcher. It captures and rechecks the request reference and signal
without copying the call into a new purported enrollment.

Currentness assertions and the final submission fence must complete synchronously
and return `undefined`. An unexpected asynchronous return refuses progression;
the application joins that observed work before releasing its original lease.
Each original supplier must also retain its own hidden work and cleanup lifetime.

## Two distinct upstream effects

For push, the original State owner commits a unique effect claim before upstream
submission. The dispatcher prepares the fixed request and receiver. State then
acquires a fresh committed-use lease and rechecks current Work, approval, IAM, and
repository controls after preparation. The synchronous submission fence is
immediately followed by the fixed dispatcher submission, without an intervening
await. The use lease remains held through actual acknowledgement or physical
retirement.

The dispatcher must perform one atomic expected-old ref update for the exact new
OID, with a separate fast-forward requirement. A preflight read or a generic
non-force REST update is not an atomic expected-old comparison. This first profile
permits one branch; deletion, tags, force changes, and multi-ref updates are absent.

Only a separately confirmed and recorded push permits a distinct draft-PR claim.
That claim retains the exact predecessor push effect and receives its own fresh
current-authority check and submission lifetime. A publication call may continue
from a previously recorded push, but an existing or recovered claim provides no
fresh execution operand and unknown effects are never replayed automatically.

GitHub's draft-PR API selects moving branch names; this component does not claim
an atomic base/head OID precondition for PR creation. The dispatcher must retain
the attributed response's repository, branches, OIDs, title, body, draft flag,
number, and URL. Completion requires that observation to match the approved
candidate. A mismatched or unattributable result remains unknown with its actual
observation, while the confirmed push remains visible. Matching text on a
preexisting PR does not prove that the current attempt created it.

## Status, uncertainty, and shutdown

The application returns explicit durable status: awaiting approval, approved,
publishing, pushed, draft PR created, rejected, cancelled, or unknown. A successful
status read does not mean publication finished; consumers must inspect its state
and both effect outcomes. The decoder rejects contradictory completion records
and checks the PR's predecessor and observed head against the confirmed push.

An original result is retained even if drain, inspection, correspondence, or
outcome recording fails. State receives that exact original result for uncertainty
accounting, rather than an invented replacement DTO. A known outcome cannot be
downgraded by subsequent uncertain acknowledgement. State's independently retained
observer records outcomes after caller cancellation and supplies status before
its original effect lifetime is released.

Before asynchronous outcome recording, State synchronously enrolls custody of
the exact offered original observation. Failed or unknown acknowledgement cannot
discard that observation in favor of a generic unknown marker. The original
effect observer remains held until the observation is durably accounted or
transferred to State's actual durable recovery ownership. Dispatcher outcomes
remain recognizable across prepared-request cleanup until that transfer finishes.
These obligations belong to the existing original effect journal and do not
permit another upstream attempt.

`close()` stops new application work and joins pending submissions and finalizers.
Idempotent cleanup is retried on the same original operands if necessary; retries
cannot submit another effect. Unproven retirement keeps close pending. The service
assembler closes shared Git custody and clock sources only afterward. Durable
recovery and reconciliation remain with the original State and dispatcher owners;
reconstructing a Git capture does not reconstruct approval or an execution claim.

## Component verification

The conformance files use Node's built-in test runner and TypeScript stripping:

```sh
node --experimental-strip-types --test \
  tests/conformance/repository-publication-v1.test.mjs \
  tests/conformance/repository-publication-v1-git-objects.test.mjs
```

The Git cases require four explicit environment selections:

- `OCE_PUBLICATION_TEST_GIT_PATH`: absolute path to the selected Git executable.
- `OCE_PUBLICATION_TEST_GIT_SHA256`: exact lowercase SHA-256 of that executable.
- `OCE_PUBLICATION_TEST_GIT_OWNER_UID`: its expected numeric owner UID.
- `OCE_PUBLICATION_TEST_ARTIFACT_BUDGET_BYTES`: finite budget for the test's
  measured fixture artifacts.

With all four absent, Git-dependent cases report unavailable skips. Partial or
malformed selection fails. Select a Git build with collision detection; the
tests do not install or discover a replacement. Tests measure apparent and
allocated fixture bytes after Git commands and before cleanup. These are sampled
measurements, not continuous observation of every transient file.

These checks exercise real local Git objects, retained custody, closed data
contracts, and explicitly labeled application refusal and lifecycle controls.
Controlled internal operands and sequences establish only those component
behaviors. They establish no genuine Work authority, State approval or commit,
credential release, or upstream publication. Complete verification must compose the actual
Work, State/IAM, and dispatcher owners, including separate push and draft-PR
claims, current-authority leases, exact outcome attribution, and recovery. No
test in this component performs live publication.
