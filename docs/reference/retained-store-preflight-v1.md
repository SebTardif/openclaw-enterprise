# Retained store preflight V1

`compareRetainedStorePreflightV1` compares a complete admitted store inventory
with trusted candidate descriptors and returns `match`, `mismatch`, or
`unavailable`. It is a pure in-process comparison. It performs no provider,
filesystem, attachment, lifecycle, or writer operation.

Import the callable from
`@openclaw-enterprise/occ/persistence/retained-store-preflight-v1`. Its store
types come from `@openclaw-enterprise/contracts/completed-state-v1`; its mount
type is the existing verified arm of
`@openclaw-enterprise/contracts/runtime-effects-v1`'s `StoreBindingResultV1`.
The [runtime effect reference](runtime-effects.md#shared-store-and-reservation-values)
owns the admitted-policy versus observed-mount distinction.

## Inputs and trust boundary

The first argument, `RetainedStoreDescriptorsV1`, contains `stores` and `mounts`.
The candidate argument is either `{ status: "present", descriptors }` or a
closed `missing`, `terminating`, `unknown`, or `unavailable` status. Those states
are supplied by the caller; the comparator never observes Kubernetes or derives
object lifecycle from a name or label.

Both inventories must already be decoded, bounded, plain contract values from
trusted sources. This function is not an untrusted JSON decoder and does not
accept partial `StoreBindingV1` objects. A missing or unverified required fact
must remain unavailable at the caller's existing decoding/observation boundary.
The caller supplies the complete approved inventory for one exact Agent;
omitting a store from both arguments cannot prove that the inventory is complete.

Each `RetainedStoreMountDescriptorV1` is a comparison projection containing:

- `store`: the existing immutable `StoreBindingRefV1`.
- `component`: the existing approved-subpath `gateway` or `harness` component.
- `mount`: the existing `StoreBindingResultV1` verified arm's mount descriptor.

The projection is comparison data, not a new provider evidence format. The
caller retains the complete authenticated Runtime result, target/execution
binding, provenance and freshness checks. It must establish the component and
exact store correlation before using this projection. Expected mount identities
must belong to the selected candidate; old execution mount identities cannot be
reused as a replacement's expectation. A caller must not derive the expected
inventory from the candidate under evaluation and treat the resulting equality
as independent confirmation.

Use `mounts: null` when required mount evidence is missing. The comparator also
requires exactly one mount descriptor for every component present in each
Kubernetes store's approved subpaths. Configuration backend objects have no
mount descriptors; an explicitly empty mount list is valid for an inventory
containing only configuration objects. A volume-policy comparison without
complete expected and candidate mount descriptors returns `unavailable`.

## Comparison behavior

The comparator checks the complete Installation/Namespace/Agent key, logical
store reference, binding reference and immutable version. It compares store
kind and role, Kubernetes cluster/namespace name and UID, claim name and UID,
PV name and UID, storage profile reference/digest, local node identity/affinity,
filesystem/access/volume mode, mount policy digest, numeric ownership and all
approved directional subpaths. A configuration store instead compares its exact
backend/object/version/content digest and storage profile.

Store, component-mount and subpath collections are keyed sets: reordering alone
does not change the result. Duplicate logical stores, binding references,
component descriptors or mount identities are rejected. Individual opaque
identities and paths compare exactly, without case folding, path resolution,
trimming or digest normalization.

Mount descriptors must correlate with the immutable binding's namespace, PVC,
PV and node UIDs, effective mount policy, filesystem, access mode and ownership.
Each component's actual subpaths and read-only modes must exactly match its
admitted set. Top-level mount identity, filesystem identity and every subpath
mount identity also compare against the selected candidate's expected values.

Gateway-private stores require gateway-only `state`, `agent` and `media`
categories. The canonical database and adjacent WAL/SHM belong under the
private `agent` category; media remains on the same private claim under its
separate category. Categories cannot alias or overlap through a parent path.
Workspace stores cannot contain those private categories. Distinct stores cannot
alias the same claim or PV within the same cluster. This checks descriptor
separation; it does not inspect a database file, WAL, media bytes, symlink or
physical mount.

Workspace, sessions, generated images and skill categories must match the
explicit admitted component/path/mode set. An omitted optional category is
disabled only by its omission from the complete trusted admitted inventory.
The comparator does not silently add mount defaults.

Explicit `codex-home` or `.codex` path segments are rejected. Existing store and
mount descriptors contain no transient credential-home overlay or complete
credential exclusion fact. In particular, a parent `agent` directory descriptor
cannot establish that its nested native home remains ephemeral. Every result
therefore includes `credentialHomeExclusion: "not-established"`, including a
metadata match. This field must remain an unmet provider evidence obligation
where physical credential exclusion is required.

## Results and bounds

Every result has this content-free shape:

```ts
{
  schemaVersion: 1,
  status: "match" | "mismatch" | "unavailable",
  reasonCode: RetainedStorePreflightReasonV1,
  guarantee: "descriptor-comparison-only",
  credentialHomeExclusion: "not-established"
}
```

One closed reason is returned in deterministic check order. Diagnostics contain
no input identifiers, paths, descriptor values or arbitrary provider text.
`missing`, `terminating`, `unknown` and `unavailable` candidates produce separate
unavailable reasons. A missing expected inventory or required mount coverage
also stays unavailable. Positive identity, policy, layout or correlation
conflicts produce mismatch reasons, including `claim-replaced` and
`volume-replaced` for same-name replacement UIDs.

V1 accepts at most 16 stores and 32 component mount descriptors per inventory.
The existing store and runtime declarations each limit per-store subpaths to 16. Oversize inventories return `inventory-limit`; evidence is never truncated.
These are comparison limits, not measured deployment capacity.

A match grants no attachment or writer authority. Current authorization, actual
Runtime target/provenance/freshness, physical mount translation, credential-home
exclusion, prior-writer termination and resolution of possible creates remain
separate checks. RWO, a matching UID or a new generation cannot replace them.
The comparator establishes no durability, flush/readback, database recovery,
retained-volume restart or gVisor qualification.

## Verification

With compatible local dependencies, run the focused behavior and public package
consumer checks:

```sh
node --test tests/unit/retained-store-preflight.test.mjs
node node_modules/typescript/bin/tsc --project tests/fixtures/retained-store-preflight-v1/tsconfig.json --pretty false
```

The vectors call the actual comparator with synthetic contract descriptors.
They cover exact field changes, same-name UID replacements, private/workspace
layout, directional modes, explicit native-home paths, missing evidence,
duplicate/oversize inventories and deterministic diagnostics. The compiler
fixture consumes the existing store and Runtime types through their public
subpaths and rejects authority-bearing interpretations of the comparison.
These tests supply no live storage or Runtime evidence. The Runtime consumer
still needs its actual retained-store and prior-writer tests before integration
can establish those capabilities.
