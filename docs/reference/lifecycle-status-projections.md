# Lifecycle status projections

The lifecycle status library selects the public fields of the existing lifecycle
read contracts, validates their request and response correspondence, and returns
detached immutable values. It preserves the distinction between desired state,
observed state and uncertain outcomes. It does not produce observations or
authorize reads.

The implementation is available through two OCC source subpaths:

```ts
import { projectLifecycleStatusReadV1 } from "@openclaw-enterprise/occ/lifecycle/status-projector-v1";
import { createSanitizedLifecycleStatusReaderV1 } from "@openclaw-enterprise/occ/lifecycle/status-reader-v1";
```

Both use the existing types and parsers from
[lifecycle admission](lifecycle-admission-ports.md) and
[lifecycle observations](lifecycle-handler-ports.md). No second status, operation,
receipt or failure protocol is introduced. Production repositories, management
routes, account authorization, observation producers and capability publication
are not installed by this library.

## Projection and authorized reads

`projectLifecycleStatusReadV1(method, requestInput, resultInput)` accepts one of
`readStatus`, `readOperation`, `listOperations` or `readCapability`. The result
input has the existing `LifecycleReadResultV1` envelope. For a successful read,
the projector selects only the declared fields of that method's canonical value.
Incidental actor, account, audit, conversation, credential, protected path and
backend fields are omitted. Dropped values are not traversed; accessors on
required public fields, unsupported object shapes and invalid public values fail
closed. No thrown message or backend error body becomes a public response.

The original parsers then check the selected value and exact request
correspondence. This includes Namespace/Agent equality for status, the original
operation reference for exact operation reads, and the requested limit and
generation cursor for discovery pages. The projector retains only the existing
closed `rejected` codes or `unavailable` failure. Hidden and foreign targets use
the same `NOT_FOUND` representation without incidental owner or count details.
Malformed requests and results return `unavailable`.

`parseLifecycleStatusReadRequestV1(method, input)` exposes the same strict
request decoding for adapters. Unlike result redaction, request decoding rejects
extra fields. It never accepts a caller-selected Installation or interprets an
operation reference as authority.

`createSanitizedLifecycleStatusReaderV1(source)` wraps the existing
`LifecycleStatusReadPortV1`. Each call parses its request, invokes exactly the
corresponding source method, forwards the same original `LifecycleReadCallV1`,
and projects the response. Each discovery page requires its own invocation.
There is no permission cache, result cache, automatic page walk or mutation
retry. A missing source, thrown source error, invalid response or signal aborted
before or after the awaited read yields closed `unavailable`. The source remains
responsible for honoring cancellation and its own bounded reads; the wrapper
cannot terminate a source that ignores its signal.

The owning server must supply an actual authorized reader. That reader verifies
private invocation and Installation custody, current account/session and
selected policy, and exact Agent-read permission at its disclosure boundary,
including around its own waits. A structurally matching TypeScript object, an
earlier allowed account observation and a valid projected value do not prove
these facts. Every page requires current authorization. Revision documents still
require both Agent and AgentRevision read permission; these projections contain
only the permitted revision references.

For an already qualified server-owned source and original call, the composition
is:

```ts
const reader = createSanitizedLifecycleStatusReaderV1(authorizedSource);
const result = await reader.readStatus(scope, originalReadCall);
```

There is no public authenticated-handle constructor in this example. An absent
source stays unavailable. The wrapper is not registered as an HTTP route and
cannot enable a deployment or compatibility stage.

## What the values mean

Status keeps requested, selected and serving revisions separate. An accepted
intent or selected revision does not establish serving. A later receipt time
does not refresh the original source observation time. Generation and revision
correspondence are checked by the canonical decoder; authentic provenance,
freshness and exhaustive provider coverage remain the observation producer's
responsibility.

The access-denial, route-removal, execution-termination, credential-revocation
and state-retention conditions remain independent. Denied access with unknown
termination stays unknown. Unresolved possible creates cannot become affirmative
stop completion. A stopped intent does not prove credential invalidation or safe
retained state. Projection does not manufacture missing source facts or aggregate
provider bodies.

Exact operation reads retain the original immutable operation and its
observation after the current head advances. Discovery returns bounded minimal
operation records and an integer cursor, without revision documents, original
actors, audits or runtime details. A short page or empty result does not prove a
lost mutation rolled back. Ambiguous discovery does not identify a lost request,
and an uncertain response never authorizes another mutation submission.

Minimal accepted or unchanged mutation receipts are separate from these
authorized reads. They cannot be expanded into a head, revision, observation or
history using mutation permission. Likewise, a capability read observes the
source's existing server-owned compatibility record; it is not a toggle or proof
that all consumers are installed.

## Fixtures and verification

The portable
[sanitized fixture data](../../tests/fixtures/lifecycle-status-projector-v1/sanitized.json)
and its [consumer instructions](../../tests/fixtures/lifecycle-status-projector-v1/README.md)
provide synthetic examples for presentation and server consumers. They cover
initial status, separate revision selections, historical operations, bounded and
ambiguous discovery, minimal receipts, lost responses, stale source times,
independent conditions and compatibility stages. The fixture wrapper is not a
management API. Browser presentation can read these JSON values without importing
OCC runtime or Node-only contract decoders. Actual browser hookup, authorized
server reads, operator procedures and installed runtime verification remain with
their respective consumers.

With the repository's declared dependency preparation available, run the actual
projection and adapter checks:

```sh
node --test tests/conformance/lifecycle-status-projector-v1.test.mjs tests/conformance/lifecycle-status-reader-v1.test.mjs
```

The projector tests exercise canonical redaction and correspondence using pure
synthetic data. Reader tests use absent or controlled denying, hidden, throwing
and cancelling peers to check actual forwarding and failure behavior. These
checks do not verify authentication, live IAM, repository filtering, providers,
HTTP routes or browser integration. Independently compiled consumers in the
fixture family express the existing call/read/value contracts without executing
fabricated authorized producers.
