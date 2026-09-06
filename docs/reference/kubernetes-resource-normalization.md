# Kubernetes resource normalization and diagnostics

The Kubernetes Compute implementation provides exact resource normalization,
supplied-accounting validation, desired-template rendering and bounded diagnostic
projection. These operations use the existing [resource-accounting
contract](runtime-resource-accounting-v1.md). Arithmetic and rendered desired
objects do not establish resource admission, available capacity or effective
allocation.

## Quantities and immutable accounting

`normalizeResourceRequirements` accepts explicit `requests` and `limits` for
`cpu`, `memory` and `ephemeral-storage`. It returns normalized values, incomplete
input or invalid input. Missing dimensions remain incomplete; unknown fields,
malformed quantities and requests greater than limits are invalid. Successful
results are detached immutable objects containing integral millicpu/bytes and
canonical Kubernetes strings.

Quantities are strings of at most 64 characters. Decimal coefficients and decimal
SI suffixes are supported, along with decimal exponents from -30 through 30.
Byte dimensions also support binary suffixes from `Ki` through `Ei`. CPU binary
suffixes, coefficient signs, whitespace, fractional final base units and unsafe
integers are refused. There is no rounding or unit inference. For example, CPU
`0.1` and `100m` have the same value, while CPU `0.0001` cannot be represented as
an integral millicpu quantity.

`normalizeResourceAccountingEnvelope` calls the canonical parser and accounting
validator. It preserves the original contribution identities, phases, overhead
charging, Pod/node reservations, process limits, log/storage sub-budgets and
required/supplied/unsupported/unavailable distinctions. The separate repository
preparation workload receives no Harness fallback. An accounted result remains
supplied arithmetic, with effective resources unavailable.

`compareResourceRequirements` compares normalized values without applying a
default. `compareResourceQuota` compares supplied demand plus supplied usage
against independent request and limit hard caps. Missing usage is not zero;
these pure comparisons acquire no quota or admission right.

## Selected desired-template builder

`normalizeKubernetesResourcePlan` validates the complete accounting envelope and
the contribution maps for both gateway and Harness before exposing selected
builder values. The current selected template contains one application and one
ordinary sequential `prepare-private-state` init container. Other helper,
restartable-init or concurrent-init arrangements are unsupported by this
renderer even when the general accounting contract can represent them.

The planned renderer requires a positive finite CPU, memory and ephemeral-storage
limit for each application/init container. Zero requests remain distinct and are
permitted. General accounting retains its broader nonnegative-value semantics.
The selected runtime-home and temporary volumes are disk-backed emptyDirs with
explicit capacities. The renderer rebuilds the complete plan from retained
accounting values and rejects disagreement with derived container or storage
fields before using them.

The actual Compute rendering adapter forwards this plan to the production
Deployment builder. Application and init resources are separate; runtime-home
and temporary size limits come from the selected values. Existing environment,
identity, service-account, mount, security and runtime-command assembly remains
in the selected builder.

Configured application values are compared with the selection. Both main and
init containers have explicit requests and limits for every supported dimension,
so a LimitRange container default supplies none of those fields and need not
equal them. Malformed configured defaults are refused.

The planned renderer also requires explicit configured caps for `pods`,
`requests.cpu`, `limits.cpu`, `requests.memory`, `limits.memory`,
`requests.ephemeral-storage` and `limits.ephemeral-storage`. It computes the
maximum simultaneous declared Pod reservation across the supplied workload
concurrency groups, including each workload's maximum concurrent instances.
Sequential attempt counts, node-charged overhead and storage/log sub-budgets are
not added again. A missing cap or a declared demand exceeding a cap is refused.

This is a necessary configured-cap comparison only. It conservatively compares
all supplied gateway/Harness/preparation demand against the configured namespace
caps; it establishes neither actual preparation Job placement nor authenticated
namespace membership. Current quota usage, available capacity and reservation
remain unavailable until supplied by their actual owners.

## Admission boundary

The trusted Compute constructor accepts a resource policy with mode `configured`
or `admitted`. The default configured path uses the existing configured-resource
orchestration and validates resource quantity syntax and request/limit order. It
does not represent admitted accounting.

The admitted policy currently returns an unavailable protected resource-envelope
association before public `prepareRevision` or `activateRevision` can initialize
clients or run workload hooks. This also applies when runtime integration is
disabled. Missing input cannot switch that policy to configured behavior.

Enabling positive admitted preparation requires the original admission/profile
producer to associate exact immutable accounting bytes/ref/version with the
original admitted digest, revision/configuration and retained component target
and effect. That callable is not currently supplied. The existing manifest
resource projection has its own meaning and digest domain; the accounting
envelope is not an alias for it. Neither equal strings, an accounting `ownerRef`,
a fixture nor a desired Deployment can supply that association.

The pure planned renderer remains callable for supplied-value validation. It
does not authorize public preparation. Existing legacy preparation/activation
methods are not the canonical fenced effect API; this resource implementation
does not add its accepting-boundary authority or gate protocol. Positive
admitted preparation/activation, existing-workload resource correspondence at
activation and authenticated currentness remain unfinished producer/consumer
integration obligations.

## Bounded diagnostics

`KubernetesComputeDriver.resourceDiagnostics` consumes the actual pure
`projectRuntimeResourceDiagnostics` implementation. Callers supply the original
runtime observation input/result, evaluation time, previous evidence version and
operation outcome. The projector reads no wall clock and makes no provider call.

It preserves incomplete, ambiguous, unknown and missing observations. Complete
observations retain the source/received/expiry times, uncertainty and evidence
versions for observation, owner-chain, execution and delivered/effective profile
provenance. Freshness is checked independently. A regressed clock cannot become
zero age; equal or older main observation versions remain out of order. Desired,
delivered and effective profiles remain separate.

Output uses bounded fields and fixed reasons. It excludes arbitrary provider
objects, owner/producer references, free-form messages, environment dumps and
credentials. Every projection retains `authority: "none"` and
`effectiveResources: "unavailable"`. An unknown submitted effect remains unknown;
normalization does not enforce an operation deadline, prove physical stop or
complete cleanup.

## Verification

The three resource conformance suites exercise pure normalization/diagnostics,
the real desired Deployment builder and public required-policy refusals. Strict
producer, diagnostic-consumer, builder-consumer and negative compiler projects
resolve actual implementation and contract types. Run the conformance files
directly with Node's test runner:

```sh
node --test tests/conformance/kubernetes-resource-normalization.test.mjs tests/conformance/kubernetes-resource-diagnostics.test.mjs tests/conformance/kubernetes-resource-plan.test.mjs
```

These suites use synthetic accounting and supplied observations. They do not
construct a Kubernetes SDK client, contact a cluster, provide an authenticated
admission association, measure effective resources or qualify a runtime.
