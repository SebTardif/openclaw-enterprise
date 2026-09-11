# Repository Work inventory issuance and cleanup

[Back to repository work state v2](../repository-work-state-v2.md).

The [Repository Work State adapter](../repository-work-state-v2.md) supplies the original State transaction and participants. Inventory responsibility remains separate from live Work settlement; no data-only result authorizes provider submission.

## Inventory issuance and independent cleanup

The fixed protected custody producer receives `adapter.inventory`. It acquires a
private inventory responsibility from the actual preparation and native origin.
`selection.acquireInventory` must supply the original State-owned reservation,
phase-operation selection, separate token-issue lease, and independently retained
observer. Omission refuses inventory issuance; a repository-use policy alone does
not authorize token issuance. Reservation fixes the complete Work/execution,
repository target, credential binding, permission profile, requested permissions,
and original horizon. V2 requires exactly `{ metadata: "read" }`; explicit V3
requires exactly `{ contents: "read", metadata: "read" }`. Inventory permission
objects are compared by exact keys and values, independently of the ordered
Work policy tuple. Neither arm grants an extra provider permission.

`transition` accepts the closed V2 reserve, mint-claim, mint-result, retirement,
resolution, cleanup-claim and cleanup-result mutations. It obtains original phase
operations from the construction-captured State selection and retains their exact
object identities. The original business request digest and the inventory
mutation digest remain separate. Operation references cannot be rebound, reused
for another purpose, or borrowed from business dispatch. Each responsibility
retains at most 128 distinct phase operations; exceeding that implementation
bound refuses further enrollment and preserves the retained history.

Reserve and claim use the actual State readset and hold both current Work policy
and original token-issue authority. Every mutation passes both Work and custody
qualifiers in that same State unit. Only a staged claim followed by acknowledged
outer COMMIT and private State recognition returns a private mint claim.
`existing` is reconciliation-only. Unknown COMMIT or a recovered operation cannot
create a mint claim, retry the provider, or prove noncommit.

`acquireMint` consumes that original claim once and enters State's fresh held
mint-use transaction. Custody keeps the returned lease through awaited key and
signing work, calls `beginSubmittedUse` immediately before the one provider
submission, and uses `assertCurrent` for subsequent permission checks. The
provider's bounded outward result may precede actual completion. Custody must
join its original `settleAttempt` before releasing the held mint lease.

Late result/revocation and exact operation recovery use the inventory observer's
own bounded call. They survive old Work/native closure, but cannot authorize new
issuance. Work settlement closes live admission while the inventory responsibility
retains its separate operation membership and source lifetime. `release` joins
entered operations and mint-use leases before releasing that observer and the
selection. It does not clear durable inventory holds or invent provider evidence.

The current operation owner calls `custody.prepareToken` during dispatch, after
State has returned P. No mint occurs before P in this implementation. Moving mint
into preparation requires an explicit original lifecycle composition; the opaque
P must not be fabricated to reach these inventory methods early.

An acknowledged, newly staged `claimRepositoryRevocation` returns a separate
private `cleanupClaim`. `acquireRevocation(I, cleanupClaim)` obtains the original
inventory observer call internally and asks State for its fresh cleanup-use lease.
It returns that exact bounded call with the held operation, currentness checks,
one-submission latch and joined release. The protected provider uses those original
bounds for DELETE; it must not create a replacement deadline or reuse the closed
user call. State and both original participants check the same current cleanup
claim, token/revocation references and attempt without requiring open Work.
The inventory responsibility remains held until the provider's original
`settleAttempt` and the returned cleanup lease have joined. Recovery and replay
never create a cleanup claim. Data-only operation results do not authorize DELETE.
