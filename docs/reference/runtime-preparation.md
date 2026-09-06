# Retained runtime preparation

The OCC platform store retains a preparation's complete closed plan, exact provider
request bytes, binding proposals and local closure history. This is an internal
repository available through `PlatformUnitOfWork.runtimePreparation`; read views
expose its three history methods. It has no HTTP endpoint or startup option.

PostgreSQL retention records durable intent and data; the memory adapter remains
process-local. Retention does not admit a provider operation,
submit a request, establish current service authority, complete a fence or authorize
a writable successor. The authenticated runtime authority service preserves its
existing mutation and purpose denials until those accepting dependencies exist.

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

## Transactions and verification

The memory adapter uses the existing working snapshot and transaction lifetime.
The PostgreSQL adapter borrows the owner's transaction and uses immutable rows,
exact allocation ownership, unique operation/child/proposal identities, local
version constraints and guarded inserts. The application role can read and append
these records, but cannot update, delete or truncate them. Failed preparation
writes poison the same existing authority transaction guard, including errors
caught by a caller; accepted work drains before commit and late submissions fail.

Run the focused memory suite with `node --test
 tests/conformance/runtime-preparation.test.mjs`. The integration suite is
`tests/integration/runtime-preparation-postgres.test.mjs`; it requires the explicit
isolated PostgreSQL application and migrator URLs and a private restart-receipt
path. It checks actual transactions, limited-role constraints, independent-client
races, cancellation and protocol-level lost COMMIT acknowledgment. Its separate
fresh-process mode verifies the retained receipt after an actual database restart.
See the [testing guide](../testing.md) for environment custody and supported tools.

The binding-candidate round trip consumes the actual original helper, stores its
canonical proposal and locator, and reads those same bytes after restart.
Synthetic Compute observations in that representation test qualify neither a
live provider nor authenticated mutation admission. Production acceptance still
requires current preparation/service/profile evidence and the actual provider
accepting boundary; this store does not supply those missing producers.
