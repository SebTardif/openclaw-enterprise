# Credential token issuance and reconciliation

Use this contract to implement durable issuance, delivery, revocation and exact
reconciliation. The [credential storage interfaces](../credential-storage.md)
own the required capabilities, current-authority checks, binding and cache rules,
and [shared bounds and error handling](../credential-storage.md#bounds-and-error-handling).
This is an interface checkpoint; it supplies no protected backend, provider client
or live token authority.

## Durable issuance, delivery and reconciliation

### Intent and exact idempotency

`reserveIssuanceV1` records exact service/owner, original turn, binding/profile,
repository IDs and minimum permission set, authority/invalidation versions,
audit reference and operation before any mint. IDs and permissions use canonical
ordering; duplicate permission names, write access to metadata, omitted repository
scope and unknown permission kinds are rejected.

The semantic request bytes retain every ownership, profile, method, operation,
audit, payload and expected-CAS field. Only per-call `requestId`, `createdAt` and
`deadline` are excluded so an exact read/reconciliation call can have fresh
correlation and bounds. The owner computes and checks the digest; a submitted
digest does not establish its own provenance. Exact duplicate intent returns
existing state. A changed owner/body/CAS under the operation is an integrity
conflict, never permission to mint again.

A fresh `reserved` result contains only a durable reserved row and audit
acceptance. Its receipt operation and digest must match that issuance exactly;
later write and claim receipts retain their separate operation identities.
An `existing` result is reconciliation-only. `commit-unknown` and
`not-found` readback retain the original operation and do not imply no effect.
A provider does not acquire idempotent token minting merely because an internal
operation ID exists.

Repository `withNamedCredentialV1` also names a preknown `providerAttemptRef` and
expected inventory version. Before its fixed callback, the protected owner must
atomically claim that issuance's single mint attempt and durably link issuance,
named-use operation and provider attempt in the same operation journal. The
relationship survives replicas, restart and acknowledgement loss. Another named-use
operation or fresh authority cannot invoke a second possible mint against that
issuance. Uncertain claim/callback outcomes require exact reconciliation, with no
automatic callback retry. A current handle and reserved row alone are insufficient.

### Every known token is an inventory obligation

Record every usable returned token before runtime delivery, including one whose
response has mismatched scope or missing/unproved expiry. Accepted token metadata
travels with a separately supplied `EphemeralTokenHandleV1`; other mint outcomes
cannot carry that handle through the typed method overloads.

Known token metadata includes an opaque protected revocation reference, exact
original intent and version, returned-scope evidence, expiry evidence, delivery
state and revocation state. A fingerprint alone is insufficient to revoke a
bearer. `expiry-unproven`, `mismatch` or `unproved` returned scope requires
`mitigation-only`; it never becomes delivery permission merely because the
requested scope was valid.

If protected persistence fails after provider acceptance, suppress delivery,
retain the preissue unknown record and report the actual persistence/provider
uncertainty. The original trusted issuer may perform independently preauthorized
exact revocation while it still has the material. A plaintext fallback file,
a guessed expiry or a falsely successful inventory acknowledgement is prohibited.

A definite inventory CAS conflict while recording a late result permits a fresh,
independently authorized reconciliation operation using the current inventory CAS.
It retains the original issuance, token, provider attempt, claim and authenticated
outcome evidence. The owner checks the retained attempt record even if its original
claim has expired, and records historical truth without new provider work or
overwriting stronger terminal evidence. The prior operation's CAS and digest never
change. Commit acknowledgement loss instead reads the unchanged original operation
first; it must not be disguised as a definite conflict or new outcome operation.

### Unknown mint with no token bytes

`unknown` records preserve `expiry-unproven`. A timeout plus a nominal token
lifetime cannot establish provider mint time. Later `unknown-expiry-established`
evidence may supply a provider-derived deadline; the row remains `mint-unknown`
and scope-held while that deadline is in the future.

Only definitive no-issuance evidence, conservatively elapsed evidenced expiry,
or a confirmed broader revocation performed under separately established exact
responsibility can resolve that obligation without a token value. The latter
two use `resolved-without-token` with explicit evidence. A planned broader
revocation, missing delivery or empty enumeration result is insufficient. A
broader response requires its own authority and actual provider result; the
storage method creates neither.

### Delivery remains a separate effect

A recorded token is not automatically deliverable. `deliverRecordedTokenV1`
requires native mode, the exact record/token/binding and original authority,
current versions and sufficient evidenced expiry. The acceptor persists a
delivery intent before invoking its fixed delivery callback and performs the
current compare-and-consume at release. Late mint after rotation, narrowing,
retirement or disable remains tracked for mitigation.

Callback loss or commit acknowledgement loss can occur after bytes were delivered.
`delivery-unknown` therefore directs exact readback and preserves uncertainty.
Redelivery of an already issued token needs a new exact current check and retained
delivery identity; it never mints a replacement implicitly. Native execution can
read and retain delivered ephemeral tokens. Changing an environment variable,
closing a local lease or issuing a narrower token does not revoke existing copies.

## Revocation, audit loss and affected snapshots

A revocation claim has a CAS version, bounded lease, exact provider attempt and
prior-outcome state. The claim lease expiring does not prove the previous request
ended. Takeover must reconcile that exact attempt before any independently safe
new attempt. Keep provider-confirmed revocation, pending, unknown,
failed-terminal and elapsed provider expiry distinct. When an outstanding row and
its expired-revocation evidence both contain a provider deadline, they must name
the same current deadline; observation times and evidence references may differ.
A newly evidenced expiry can resolve a previously unproved deadline. Corrections
to a known deadline reconcile the current row while preserving prior evidence in
the original operation history.

New-authority mutations require durable audit acceptance under the existing
security-event contract. Audit delivery to an external sink can occur later
through an accepted durable outbox. Audit outage must not suppress independently
preauthorized exact disable, attenuation, stop or revocation. Mitigation records
therefore distinguish `accepted`, `obligation-recorded` and `evidence-missing`.
When inventory persistence is also unavailable, report a missing-evidence
incident and the observed provider outcome; do not fabricate a successful durable
write. This permits no broader emergency authority.

Affected queries bind exact owner, logical binding, cause and invalidation
operation/version to a persisted snapshot and filter digest. Cursors are opaque,
bounded and tied to that snapshot/filter; no credential values appear in them.
The backend must retain snapshot membership across replicas/restarts for its
valid lifetime and invalidate unavailable/inconsistent snapshots explicitly.
Queries include pending and unknown issuance and late outcomes, with current
ownership checked by the actual accepting owner.

Page counters describe live known-token and unresolved-issuance counts within
that snapshot. Confirmed/expired and resolved history remains retained but does
not consume a live-token count. A continuation must advance through an actual
returned record. A completed page sequence proves only coverage of its persisted
snapshot. It never proves all later effects ended or all provider tokens were
revoked; the owning invalidation/reconciliation protocol must include concurrent
late outcomes before declaring mitigation complete.
