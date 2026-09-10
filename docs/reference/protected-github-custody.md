# Protected GitHub credential custody

The protected custody backend stores GitHub installation tokens outside Agent
execution and recovers the same token for exact provider revocation after a
process restart. It reuses the existing GitHub App provider and original
repository inventory. Ciphertext files contain material only; the inventory
remains the operation, mint-claim, outcome and cleanup journal.

This component does not register a production endpoint or admit repository use.
The original State participant must check recorded material under its transaction.
User-operation delivery requires the original known-committed
release, fresh Work authority and the original authenticated native receiver.

## Selected storage

`ProtectedGitHubTokenStoreV1` requires an explicit selection:

```ts
{
  kind: "persistent-posix",
  directory: "/var/lib/oce/github-custody",
  writerMode: "single"
}
```

The deployment must provide a dedicated persistent volume at that directory,
retain it across controller restarts, and enforce a single custody writer. The
backend neither creates a volume nor configures controller replicas. Its local
checks support Linux ext4 and XFS, require a canonical owned directory with mode
`0700`, and reject known temporary paths and unsupported filesystems. There is
no memory or temporary-directory fallback.

Each original attempt has a deterministic ciphertext filename. The backend uses
exclusive file creation, file `fsync`, atomic publication without overwriting an
existing file, and directory `fsync` before acknowledging retention. Recovery
handles a completed pending file and the two hard-link names left by an
interrupted publication. Conflicting files and invalid ciphertext remain
unavailable. Neither conflict nor absence permits a second mint attempt.

Filesystem checks establish local ownership and supported operation semantics.
They do not prove persistent-volume retention after a Kubernetes reschedule,
single-writer deployment, or the storage device's power-loss guarantees. Those
properties require deployment verification.

## Keys and immutable App source

The encryption key is a separately selected 32-byte file with a SHA-256 pin. Its
owned parent directory must have mode `0700`; the regular key file must have mode
`0400` or `0600` and exactly one hard link. The owner rejects symlinks, checks file
identity before and after every read, verifies the digest, and wipes its temporary
key buffer. The key cannot be stored below the token material directory.

The immutable Kubernetes App key source fixes the OCE Driver, Namespace and
Secret identity, Kubernetes namespace and object UID, resource version, data key,
GitHub key identity and encrypted-envelope digest. It reads the actual named
Namespace and immutable Secret, verifies their exact ownership, decrypts the RSA
key and uses the existing GitHub App material implementation. It accepts private
RSA keys from 2048 through 8192 bits. App key bytes and encryption keys are never
Agent mounts or files in the token volume.

The source performs fresh external reads before signing and after the provider
consumer settles, with a bounded source lease. Those reads do not make external
Secret deletion instantaneous. The original current-authority owner must still
validate the selected binding and key generation at provider dispatch.

## Capture, retention and recovery

`ProtectedGitHubTokenCustodyV1` is bound to one immutable access lease, stable
GitHub target, App key identity, provider attempt, token reference and protected
revocation reference. Provider IDs must convert from canonical positive decimal
strings to safe integers without rounding.

Before the single provider attempt starts, the original accepting owner must
commit this complete identity in its original mint claim. Recovery needs the
same lease, historical key selection and preallocated token and revocation
references. An accepted-token row written after the provider returns cannot
recover a crash between capture and that later commit. Key rotation must not
replace the claim's original key identity with the current selection.

Capture synchronously copies provider-owned bytes before the provider wipes its
buffer. It attempts encryption and durable retention immediately. A temporary
key or storage failure keeps the bounded original copy in the protected process
for exact retention retry. Only a successful `retain` call supplies a durable
material receipt; capture alone cannot accept inventory metadata or authorize
use. Process loss before successful retention leaves the original mint claim and
target hold unresolved.

AES-256-GCM authenticates the complete immutable identity and the original
captured scope/expiry observation. App-key and installation-token envelopes use
separate authentication domains. Changed context, ciphertext, observation or key
cannot recover a usable token. Handles are private object identities and cannot
be reconstructed from JSON or reused by another custody owner.

Late, invalid-scope and unknown-expiry tokens remain cleanup material. Recovery
uses the original attempt context even if no handle reached the request caller.
An exact retry adopts the original ciphertext and references. Cancellation,
metadata rollback, unknown COMMIT, expired request and provider revocation do not
silently remove the retained file. This backend does not independently prune
material or settle the inventory obligation.

## Exact revocation and release boundary

The raw-token revocation borrower is private to the original GitHub provider
construction. `createRevocationProvider` returns only the existing fixed
`DELETE /installation/token` operation. It needs retained token material and
independent cleanup authority; it does not need the App RSA signing key and
cannot mint a replacement token. Each revoker binds the independently recorded
cleanup provider attempt; it preserves the original mint identity for ciphertext
provenance.

Both provider constructions expose `settleAttempt(originalResult)`. It recognizes
the exact result object returned by that provider invocation and waits for its
original callback, material postchecks and cleanup. A bounded `unknown` result
can precede that settlement. Copied results and results from another provider
cannot select pending work; a busy call owns only its own completed no-work
result. Settlement performs no provider action, returns no material and does not
change an unknown outcome into proof of provider execution or nonexecution.

State participant composition must borrow the original transaction's inventory
projection, check the exact outstanding record, immutable lease, target,
receiver, provider attempt, token references, inventory version and accepted
expiry, and require durable custody before release staging. Staging must emit no
token bytes. State owns mandatory audit, COMMIT classification and its genuine
committed-release witness. Recovery data is not a release witness.

`bindCommittedReleaseV2` pairs one retained token with the original native
service source and its privately enrolled session. Its State source stages
material without exposing bytes. Its fixed `writeCommitted` method requires the
original known-committed State receipt and canonical dispatch metadata for the
construction-selected protocol, including the exact release reference. The State session diagnostic
and the broker's later-generated session nonce are separate values; the actual
native exchange authenticates the latter.

The writer first prepares the fixed native exchange, then acquires the original
State current-use lease. It checks that lease, decrypts inside custody, checks
again and invokes the native writer synchronously before any further await.
Custody wipes its plaintext after the native writer takes its synchronous copy,
then waits for the actual write acknowledgement or proved receiver retirement
before releasing State use. The State owner must preserve submitted-write
responsibility through that settlement even when the request is cancelled or
expires. A historical commit, shutdown timeout or newly constructed receipt
cannot satisfy this requirement.

## Original repository operation assembly

`createProtectedGitHubRepositorySourcesV2` constructs the original Runtime origin
owner and Work State adapter around the selected raw native service source,
original State assignments and repository selection, Runtime service trust,
protected key material and persistent token store. Construction selects one
literal protocol before accepting requests: omission or `protocolVersion: 2`
selects metadata; Git read requires explicit `protocolVersion: 3`. Requests cannot
change that selection. Native acquisition, State assignment, Runtime origin,
Work preparation and selection must all belong to that same protocol.

| Protocol | Original Work policy                                      | Exact installation-token permissions     |
| -------- | --------------------------------------------------------- | ---------------------------------------- |
| 2        | `metadata:read`                                           | `{ metadata: "read" }`                   |
| 3        | `git:read`, requiring `contents:read` and `metadata:read` | `{ contents: "read", metadata: "read" }` |

The Git declaration retains discovery or upload-pack, Git protocol `version=2`,
body size, body SHA-256 and the complete request digest. The assembler compares
that declaration with the original Work selection and immutable access lease.
The protected release binder independently checks the exact State-staged and
known-committed declaration, opening request, token permissions and selected
protocol before preparing the fixed native write. A metadata receipt or a subset
permission match cannot supply Git-read authority. Physical Git body custody
remains with the original native exchange.

The Runtime origin and raw native session are different private operands. A
one-time construction binding supplies Runtime's original recognizer only to the
protected closure. Work receives the Runtime origin; custody retains the exact
raw native session for State correlation and the fixed prepared writer. Runtime
alone owns release of that raw session. No recognizer, rebinding method or token
getter is returned.

Issuance first records the complete original custody identity in a known-committed
mint claim. The provider runs under the original submitted-use lease; its full
invocation settles before that lease is released. Retained material and actual
provider observations are then recorded through the same inventory journal.
Unknown acknowledgements trigger exact original-operation readback and keep the
responsibility retained when readback is unavailable. Historical readback never
creates another mint permission or a committed user release.

The required clock is an explicitly selected `CustodyClockV1`. Its uncertainty
must be an established bound from that source. Time spent sampling the local
clock is not a substitute for a wall-clock error bound. Invalid or unavailable
clock observations refuse time-dependent use and expiry settlement.

The returned `close()` stops new acquisition and submission, retires the original
Runtime owner, and joins accepted State, native and provider work plus retained
inventory cleanup. The original Work/broker owner must settle every returned
preparation with its actual outcome. A preparation that completes after shutdown
starts is still returned to that original caller for settlement. Shutdown remains
pending if the original caller has not settled or mitigation remains unresolved;
it cannot manufacture an outcome or treat a timeout as cleanup completion.

Startup recovery additionally requires original State/Work enrollment for a
retained cleanup responsibility and an authenticated current inventory record
with its full historical mint and revocation claims. A live preparation or an
in-memory operation map cannot provide that after process loss. The protected
material recovery API alone does not install that startup enrollment. Cleanup
must use the historical custody identity and revoke-only provider independently
of the retired native exchange and App signing key.

## Verification and operational limits

Run the focused suites with prepared workspace dependencies:

```sh
node --test tests/conformance/protected-github-crypto.test.mjs
node --test tests/conformance/protected-github-app-material.test.mjs
node --test tests/integration/protected-github-custody.test.mjs
node --test tests/conformance/github-app-provider-v1.test.mjs
```

The custody suite uses real local filesystem operations, AES-GCM, process
restart, the original provider and a supported local TLS protocol endpoint.
Synthetic identities and currentness controls in the provider cases establish
protocol and material behavior only. They do not establish admitted Work,
authentic State release, installed Kubernetes isolation or live GitHub results.

Errors intentionally report only that custody is unavailable. Check the selected
volume, ownership, file modes, key pin and exact original context through the
protected operator environment. Preserve conflicting or partial files and the
original inventory obligation for reconciliation. Do not log or export token
bytes while diagnosing failure. Buffer wiping reduces ordinary retained copies;
it cannot guarantee erasure of runtime strings or OpenSSL-managed key memory.
