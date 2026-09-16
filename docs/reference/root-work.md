# ROOT Work identity and owner contracts

The public contracts package supplies the `root-work-v1` retained DATA codec.
The OCC package supplies callable Work and selected-IAM contracts for the normal
authenticated deployment → immutable AgentRevision → runtime authentication path.
These contracts have no Work admission, persistence, IAM companion or runtime
provider implementation. Configuring an owner is not available through this page.

## Retained identity DATA

`RootWorkIdentityV1` retains Installation, Namespace, Agent/revision, original
root/execution, requester, service owner, assignment/generation, selected-IAM
instance/generation, immutable ceiling digest, policy version and admission time.
Its explicit duration policy retains a finite original deadline or `uncapped`
with `null`; finite use leases remain required. Cancellation retains an
independently authorized owner, authorization identity and dependency list.

Import `decodeRootWorkIdentityV1`, `encodeRootWorkIdentityV1` and
`digestRootWorkIdentityV1` from `@openclaw-enterprise/contracts`. Decode an already
parsed unknown value; encoding revalidates it and produces one fixed field order.
The digest is lowercase SHA-256 over the UTF-8 canonical encoding. Dependency
order is preserved. State must retain these exact bytes/digest and verify indexed
identity columns match them; the codec does not implement that persistence.

The closed schema permits ordinary or null-prototype records with enumerable
own data fields. It rejects custom prototypes, accessors, excess/hidden/symbolic
keys, foreign versions, invalid discriminants and malformed digests. IDs have no
whitespace/control characters or lone surrogates and are limited to 256 UTF-8
bytes. Records and dependency arrays reject proxies, including revoked proxies,
without invoking traps; decode, encode and digest use the same generic `TypeError`.
Dependency arrays are dense, unique lists of at most 64 IDs. Timestamps
are nonnegative safe integers; finite horizons must follow admission. Decoding
returns a detached, deeply immutable copy. Invalid DATA raises a `TypeError`
without including rejected input. Correct the producing record; never substitute
an unsupported version or reconstruct an authority handle.

**DATA and its digest cannot authenticate authority.** The Work owner must retain
and verify the full `RootWorkPolicyV1`: service policy/version, scope/resource
ceiling, eligible data domains, audiences, aggregate limits, duration and
independently authorized cancellation. A digest cannot replace that policy.

## Original owner ports

Import these types from `@openclaw-enterprise/occ`. They reuse the existing
`PlatformUnitOfWork`, `Bounds` and nominal `CoreAuthenticationBinding`.

| Port                                  | Input and result                                                     | Required original-owner behavior                                                                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RootWorkOwnerV1.admitDeploymentIn`   | Real UoW and `RootDeploymentAdmissionV1` → identity DATA             | Authenticate the invocation requester; independently resolve the locked Agent's service owner; verify full policy, duration/cancellation and immutable execution/assignment; retain one root per execution. |
| `RootWorkOwnerV1.resolveForRevision`  | Actual readonly AgentRevision and Bounds → Core binding or undefined | Resolve genuine retained current root authority. Revision/configuration and decoded DATA cannot mint it.                                                                                                    |
| `WorkAdmissionOwner.checkIn`          | Same real UoW and `AuthorityBinding` → void                          | After lock waits, authenticate original custody, ownership/open root, ceilings/horizons, assignment/execution, grant/lease and selected configuration.                                                      |
| `SelectedIamAdmissionOwner.prepare`   | Exact binding and finite deadline → opaque evidence                  | Prepare outside the admission transaction under the original selected IAM's coherent policy/selection protocol.                                                                                             |
| `SelectedIamAdmissionOwner.consumeIn` | Same UoW, original evidence and same binding → void                  | Authenticate/spend evidence once; compare current fence/epoch and durable selection generation through outer commit/rollback.                                                                               |
| `RootWorkOwnerV1.cancelIn`            | Same UoW and `RootCancellationV1` → void                             | Independently authorize exact `work.cancel`; monotonically close the root against admission while preserving retained cleanup/finalization.                                                                 |

The invocation and retained service-policy roles have distinct discriminants.
Their principal strings are metadata: the original owner authenticates their
provenance and correspondence, including when the same principal holds both roles.
Caller cancellation/abort alone does not authorize root closure.

`AuthorityBinding` separates ROOT cancellation, credential acquisition/exchange/
refresh, ordinary resource dispatch and PR creation. All retain genuine Core
custody, root identity, grant/lease, original operation/attempt/reservation,
input/facts digests and finite bounds/capacity/withdrawal profile. External effects
also retain the admitted backend/schema/connection, canonical credential target,
service/audience, profile and exact receiver incarnation. PR dispatch alone
requires its original opaque claim; credential admission cannot consume it.
ROOT cancellation has no fabricated external or PR operands. Owners enforce exact
operand equality and runtime currentness; type correctness is insufficient.

`IamAdmissionEvidence` and `OriginalPrCreationClaimV1` are type-only owner handles,
with no public constructor or serialized reconstruction. The standard `IAMDriver`
contract is unchanged. Ordinary authorization plus a local TTL cannot manufacture
transaction-bound or external-policy validity. Unsupported observation/withdrawal
profiles deny admission; provider calls never run inside the admission UoW.

## Commit, ownership and current limits

Identity output is inert until the original State owner knows outer COMMIT.
No usable Core binding may escape before that point. Unknown commit requires exact
original readback; it never permits root/attempt reissue or replay. Original Work
owns admission/currentness/closure, selected IAM owns evidence/fence participation,
State owns retention and transaction lifetime, and the existing runtime
broker/Compute/Sandbox owners supply actual composition and provider behavior.

The selected MVP has one active gateway, one immutable service-owned ROOT Work
per execution and one immutable version per admitted bundle. Original owners must
retain that root/execution across an identical restart. This contract adds
no SQL, general Session, journal, turn or SDK port. Remote execution and broader
installed/live qualification remain outside this component. The
[contributor CI guide](../testing/ci.md#root-contract-conformance) owns executable
contract verification and its proof limits.
