# Runtime preparation records and recovery

Part of the [Retained runtime preparation](../runtime-preparation.md) reference.

## Repository operations

`retain(mutation, attribution)` runs inside the existing OCC transaction. Every
mutation has a preknown operation reference, preparation reference, exact runtime
allocation target and current intent reference, mode and lifecycle generation.
Attribution contains the original internal writer reference and recording time;
it is data and does not authenticate that writer.

| Kind             | Retained result and required comparison                                                                                                                                                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retain-plan`    | Starts local version one for an admitted revision and an actually unbound allocation. Retains the complete plan and separate preparation descriptor. The local expected version is `null`; admitted-child cutoff starts at zero.                                                                                                                                |
| `retain-child`   | Appends a prepared effect and its actual UTF-8 provider wire bytes after the complete plan exists. The exact previous local version and guard must match.                                                                                                                                                                                                       |
| `retain-binding` | Retains the original binding proposal, canonical authority submission bytes and exact original authority operation locator. The allocation must still be unbound; a matching retained materialization child is required.                                                                                                                                        |
| `supersede-plan` | Retains a new complete plan, increments local and gate versions, and increments plan version under the same plan identity. Fence epoch and responsibility version cannot decrease; responsibility identity stays fixed within the preparation. A changed preparation descriptor increments its separate version. All unresolved child/proposal history remains. |
| `close`          | Appends the local state `closed` or `superseded` under the exact prior version and guard plus current intent. It preserves outstanding history and does not claim nonexecution, physical termination or cleanup completion.                                                                                                                                     |

The guard comparison includes exact scope, intent, lifecycle generation, gate
version, requested fence epoch, responsibility identity/version, plan
identity/version/digest and admitted-child cutoff. The retained-child sequence is
separate from that cutoff. Retention never advances the authoritative admitted
cutoff. Kubernetes resource versions remain opaque strings; they are retained
without local arithmetic or rebasing.

A complete plan may name multiple allocations within the same Agent scope. Every
planned assignment/create-effect owner must exist canonically, and the plan must
include the primary allocation. Plans are stored in full, including descendant
producer domains. A child must preserve its original target predicate, plan,
responsibility and exact provider target. Retained data alone does not prove that
a producer domain is complete or that a renderer/profile was approved.

## Bytes, replay and recovery

Every operation retains canonical request JSON and its SHA-256 digest. Prepared
children preserve the separate canonical logical request and provider wire
reference, digest, byte length and renderer identity, together with the actual
wire string. Each logical request and wire payload is limited to 65,536 UTF-8
bytes independently. The accepted effects schema also bounds aggregate effect
JSON to 262,144 UTF-8 bytes, depth and collections. Oversize values are rejected
without truncation. The enclosing internal mutation is bounded to 1 MiB and
retained child count to 256.

Binding proposals use the existing runtime authority schemas and bounds. They
are not inserted into the provider-effect union. The canonical authority payload
excludes its request-reference slot by contract; the complete original proposal
and original `ExactAuthorityOperationV1` are retained as well, so recovery cannot
substitute a new locator.

`findOperation(scope, operationRef)`, `findPreparation(scope, preparationRef)` and
`listHistory(scope, preparationRef)` return detached immutable retained data for
the exact Installation, Namespace and Agent. Exact operation replay compares the
complete original mutation and attribution before checking the current head.
Changed bytes, renderer, owner, locator or attribution conflict. Historical reads
and exact repeats therefore survive later head advancement, plan supersession,
closure and successor allocation without reobserving or retrying anything.

After an unknown database COMMIT outcome, read the preknown original operation
reference in a new transaction. A missing record does not prove that a provider
request was never submitted. No repository result is a current authority receipt,
a fence-completion receipt or an instruction to retry an effect.
