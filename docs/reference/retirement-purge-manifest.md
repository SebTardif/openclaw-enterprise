# Retirement and purge manifest

A purge manifest identifies the exact live objects selected for deletion after an
Agent is stopped. It extends the existing permanent retirement barrier and uses
the same lifecycle transaction. A manifest, decoded value, historical receipt,
or progress response supplies no current deletion permission.

## Immutable inventory

`PurgeManifestV1` binds one original purge operation, request, manifest version,
Agent scope, retired identity inventory, and ordered store inventory. Each store
entry includes a preallocated deletion operation and the original store binding
reference/version. Kubernetes entries retain cluster, namespace UID, claim UID,
volume UID and admitted profile/mount digests. Configuration entries identify
only exclusively owned materializations with the exact backend object version.

For the Kubernetes variant, the deletion target is explicitly the original
PersistentVolumeClaim. The bound volume UID remains an identity precondition;
claim absence cannot establish backing-volume deletion. Backing volumes follow
separate disposal and cannot be selected by changing this target field.

An identically named replacement object is a different object. A changed inventory,
binding version, object UID/version, retired generation, operation or request is
a different manifest. Recomputing its digest does not permit replacing the
manifest already retained under the original operation. This version selects no
automatic successor-manifest or retry operation.

The retired inventory identifies exact route versions, context creation identity,
and channel-installation generations. The existing retirement owner must resolve
these values against the authoritative records, current lifecycle version and
its complete inventory. A supplied list is not proof that all affected identities
have been found. No new replay clock, activation watermark or retirement store
is established by this interface.

## Encoding and limits

`createPurgeManifestV1` accepts a strict `PurgeManifestBodyV1` and computes its
digest. The digest is SHA-256 over the UTF-8 domain prefix
`retirement-purge-manifest-v1` followed by one LF character, then the canonical
JSON encoding of the complete body. The digest field itself is excluded. Object
keys are lexicographically ordered, arrays retain their exact order, and admitted
reference/key strings are ASCII. The hexadecimal digest is lowercase with a
`sha256:` prefix.

Use `parseRetirementPurgeV1` for an untrusted in-process value and
`parseRetirementPurgeJsonV1` for a wire string. The latter accepts exactly the
canonical spelling produced by `encodeRetirementPurgeV1`; duplicate keys,
insignificant whitespace and alternative escaped spellings are rejected. The
decoder bounds input before schema evaluation and returns an immutable copy.
Accessors, exotic prototypes, cycles, sparse arrays, symbol properties, malformed
Unicode, unknown fields and unsafe numbers are rejected with a sanitized error.

The version supports at most 64 store entries, 256 retired identities, 256 KiB of
encoded metadata, depth 16 and 16,384 visited values. Store/manifest versions and
observation sequences are positive safe integers. Bounds do not assert deployment
capacity or a provider latency guarantee. The owner must reject an incomplete or
over-capacity inventory without beginning deletion.

## Progress and unknown outcomes

Each store is `pending`, `unknown`, `observed-present`, or `observed-absent`.
An observation retains the exact manifest locator, deletion operation, complete
store precondition, observation identity/sequence, timestamp and evidence
reference. Only an actual protected observer can supply trusted evidence for the
original object. Parsing metadata cannot establish that provenance.

Unknown is not absence. A delete request, a successful response without exact
readback, an incomplete listing, an expired lease or a changed UID does not prove
the original object is absent. A same-name successor must never become the target
of recovery for the original request.

`comparePurgeProgressV1` is a pure consistency check. It permits one changed store
observation per expected-record-version advance, preserves the immutable manifest,
and requires the next observation sequence. An exact repeated value is `existing`;
a stale version, changed receipt, changed inventory or regression from resolved
absence conflicts. The real lifecycle transaction must inspect observation
provenance and apply the actual durable compare-and-swap.

`live-objects-absent` means every inventoried live object has a retained exact
absence observation. It does not mean physical erasure. Shared secrets and
configurations are excluded. Backups, snapshots, retained backing volumes, audit,
and provider messages follow their separately documented retention/disposal.
The permanent content-free retirement barrier survives for the installation's
lifetime, including after all selected live objects are absent.

## Lifecycle and current authority

The original lifecycle owner serializes retirement, publication and resume under
its existing lock and outer transaction. Retirement must be durable before any
destructive request; late intake, dispatch, checkpoint publication and delivery
must honor that same retired identity/generation. A purge progress write must not
reactivate a route, move a completed head, release an unresolved writer, or change
a successor's state.

The executor separately proves current purge authorization, actual physical stop,
resolved create effects and store-specific absence of every possible writer.
That inventory includes restoration, checkpoint preparation, media collection,
maintenance/backup writers and pending storage effects. Generic fencing, requested
termination and new runtime generations cannot replace physical evidence.

Unknown outer commit retains the original operation/request and exact manifest
locator for status readback. A later read can reconcile retained facts; it cannot
return a fresh deletion, resume, dispatch or release capability. Method-local
success before the outer commit is provisional. A missing transaction/barrier
owner binding remains unavailable.

The value and comparison exports in this module are usable for independent
metadata consumers. They do not yet provide an installed lifecycle transaction
adapter or executor. Such a binding must name the existing retirement producer,
authenticate its in-process provenance, preserve its immutable barrier version
and generations, and be accepted alongside the consuming lifecycle ports.

The concrete callable extension still requires four owner decisions: the exact
existing barrier reference/version/generation and complete inventory projection;
the original lifecycle operation and expected-generation binding; the exact
original outer-unit/lock attachment; and the protected attachment/observation
provenance plus independently current metadata-read authority. The value exports
do not fill these gaps or claim that a barrier was actually committed. Consequently
this module supplies no callable retirement-versus-publication, late-effect denial,
or purge-versus-resume serialization implementation.

## Validation scope

The contract vectors exercise encoding, exact identity/digest comparisons, version
conflicts, immutable progress, wrong-object observations and retained uncertainty.
The independent TypeScript consumer can summarize pending objects and preserve an
exact readback locator without obtaining an action capability. These checks do
not establish PostgreSQL concurrency, restart durability, current authorization,
complete inventory, physical termination, provider deletion or storage erasure.
