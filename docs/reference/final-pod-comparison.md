# Final Pod comparison

`FinalPodContainmentComparatorV1` compares complete supplied Pod and Deployment
documents against a supplied expected shape using the existing
[containment admission contract](containment-admission.md). It is a bounded,
stateless, in-process library. Its result has purpose `comparison-only`.

The library does not authenticate an expectation, resolve an image or secret,
look up current admission, invoke Kubernetes or observe a runtime. The original
producer must bind the exact supplied content to the existing immutable
selection/use and configuration. The original accepting boundary must still
check current authority, withdrawal, producer authenticity and any required
runtime or writer evidence. Supplying equal trees establishes none of those
facts, even when the comparison returns `conforming`.

```ts
import { FinalPodContainmentComparatorV1 } from "@openclaw-enterprise/occ/containment/final-pod-comparison-v1";
import { decodeContainmentAdmissionInputV1 } from "@openclaw-enterprise/contracts/containment-admission-v1";

const decoded = decodeContainmentAdmissionInputV1(supplied);
if (decoded.kind === "invalid") {
  // Deny the comparison request.
} else {
  const result = await new FinalPodContainmentComparatorV1().compare(decoded.value);
  // Keep the complete binding. Only a comparison has occurred; check the
  // original accepting boundary's independent requirements before any use.
}
```

The constructor has no provider, clock, store, authority or policy dependencies.
The method defensively decodes its input and checks its output with the original
exchange decoder. Malformed input rejects with the fixed
`TypeError("Invalid containment comparison input")`. An invalid internal result
rejects with `TypeError("Invalid containment comparison result")`. Neither error
contains supplied keys or values. Consumers deny rejected calls; there is no
fabricated binding or fourth outcome for a malformed request.

## Evaluation and outcomes

The evaluator preserves the original binding, full Runtime observation records
and their source timestamps. Candidate provider-object and execution facts are
correctly `not-due`; no future Pod UID, runsc instance or target SVID is required.
Observed objects retain the original exact identity/resourceVersion and
observation checks. An actual Runtime `preallocated-candidate` observation is
distinct from a pre-persistence comparison request.

| Outcome         | Conditions                                                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conforming`    | The expected document is complete for the supported field policy; all due facts are supplied; an observed result is complete; both actual documents match without findings.                                |
| `nonconforming` | The expectation and due facts are usable, but actual field presence, supported shape or values differ.                                                                                                     |
| `unknown`       | Expected static content is missing, the expected shape uses unsupported fields/normalization, an original expectation is unavailable, a due fact is unavailable or the original observation is incomplete. |

Unavailable facts take precedence over raw mismatches. An incomplete expected
document cannot become usable merely because both trees contain the same
omissions or because its producer listed all twelve field groups. A same-on-both
unsupported field or enum yields `unknown`. With a usable expectation, an
unsupported actual field or enum yields `nonconforming`. Both outcomes deny use.

The policy validates both the complete Pod and the complete Deployment template.
It checks intrinsic uniqueness, volume-name links, mutually exclusive source or
handler alternatives, controller strategy completeness and container-role name
correspondence. Supplied status-role inventories must match their spec role names;
named HTTP/TCP handler ports and explicit resource-field source container names
must resolve within the supplied container inventory. Defined port names must be
unique; unnamed numeric ports remain supported. Pod and Deployment namespace
strings must agree. This checks their supplied correspondence without resolving
a namespace name to an authoritative UID. Object metadata requires
namespace plus name or generateName; observed objects require names, and the
observed controller name matches the original complete Runtime object target.
Template metadata has its separate shape. The selected Deployment policy requires
a nonempty literal matchLabels selector matching both template and Pod labels;
nonempty Deployment expression selectors remain unsupported. Affinity expressions
remain supported as explicit comparison content. It does not add Kubernetes fields for claim/PV identity or derive
an authoritative owner from labels. Those facts remain with the original stage
producers and expectation adapter.

## Comparison rules

Normalization version 1 uses these exact rules:

- Object member order is irrelevant. All own keys and recursively supplied
  values otherwise participate.
- Arrays remain ordered. There is no name-based sorting, set normalization,
  merging or duplicate collapse. Named container, environment, volume and other
  supported identity lists reject ambiguous duplicate identities.
- Scalars and presence are exact. Absent, null, empty arrays/maps, empty strings,
  false and zero remain distinct. No Unicode, case, path, address, image, port or
  quantity conversion occurs.
- Required executable defaults must be supplied explicitly. Every selected probe
  requires initialDelaySeconds, timeoutSeconds, periodSeconds, successThreshold
  and failureThreshold; omission is not a request for a hidden default. The evaluator does
  not fill Kubernetes or OCI defaults, inspect image configuration, calculate
  scheduler accounting or assume a missing resource means unlimited.
- Only an individually selected diagnostic exclusion is ignored, at its exact
  bound path. The supported names are `pod.metadata.creationTimestamp`,
  `pod.metadata.managedFields`, `controller.metadata.creationTimestamp` and
  `controller.metadata.managedFields`.

Diagnostic exclusions affect comparison views only. Raw input values remain in
the detached bounded snapshot. Without an exclusion, those named diagnostic
values are compared as opaque JSON data. A top-level Pod exclusion does not
exclude template metadata. No entire metadata, status, owner-reference, UID or
resourceVersion object is stripped. Unrecognized status fields deny; status is
not universally diagnostic.

For example, CPU quantities `1000m` and `1` compare differently. Omitted argv is
not equivalent to an empty array, and an omitted expected entrypoint is unknown
rather than an inferred OCI default. Expanding these equivalences requires a
reviewed versioned semantic change. This library computes no canonical manifest
bytes or digest and never writes later observed fields into an immutable profile.

## Supported field coverage

The recursive policy has a closed field set at every structural object context.
Known annotation, label and source-key maps compare their exact expected entries;
they do not permit unknown structural fields elsewhere. New API or feature fields
are denied until their semantics are supported explicitly. The policy covers all
twelve comparison groups, while allowing unsupported Kubernetes features to
remain unavailable.

| Group                           | Compared fields and limits                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Images and pull policy          | Explicit digest-pinned image references and supported pull policy for every selected main/init/ephemeral record. No registry or mutable tag resolution.                                                                                                                                                                                                   |
| Command and arguments           | Explicit ordered executable and argument strings for every selected role, including supported executable probe/hook actions.                                                                                                                                                                                                                              |
| Container inventory             | Every main, init and ephemeral record, exact cardinality/name/order, unique role identity and complete required fields.                                                                                                                                                                                                                                   |
| Probes and lifecycle hooks      | Supported exec, HTTP, TCP and gRPC probes, ordered headers/argv, timing/thresholds and supported exec/HTTP/TCP/sleep lifecycle actions. Multiple action alternatives deny.                                                                                                                                                                                |
| Environment and sources         | Exact names/literals, envFrom and typed field/resource/config/secret selectors, optional flags and source associations. No source content is read.                                                                                                                                                                                                        |
| Process and identity            | Pod/container UID/GID/nonroot/groups, capabilities, privilege escalation/read-only root, supported seccomp/AppArmor/proc settings, sysctls, namespace sharing, account/token and interface shape. Unknown OS/device/security mechanisms deny.                                                                                                             |
| Mounts and volumes              | Selected emptyDir/PVC/projected/config/secret/downwardAPI source alternatives, directions, names, paths, subpaths, modes, size limits, propagation and projected token selectors. Unknown volume mechanisms deny. The expected runtime-home plus nested workspace/projection hierarchy remains valid; an unexpected shadow mount differs from that shape. |
| Resources and defaults          | Explicit CPU/memory/ephemeral-storage requests and limits for every selected main/init record, plus supplied Pod resource and overhead fields. Quantity spelling remains exact. Original resource/accounting owners retain aggregate capacity, reservation, defaults and other workload budgets.                                                          |
| DNS and service links           | Resolver/search/options, DNS policy, hosts, hostname/subdomain and service-link settings. No resolver lookup or inferred network permission.                                                                                                                                                                                                              |
| Restart, termination and update | Supported Pod/container lifecycle/deadline/message fields, controller replicas/strategy and related rollout settings. Defaults are explicit; unsupported restart-rule features deny. Matching a stop policy is not termination evidence.                                                                                                                  |
| Placement and runtime           | RuntimeClass, node/scheduler, selectors/affinity/tolerations, priority/preemption and supported topology inputs. Unsupported scheduling/resource-claim features deny. A matching RuntimeClass string is not handler attestation.                                                                                                                          |
| Approved annotations            | Exact expected key/value sets on Pod, Deployment and template metadata, without ignored prefixes or wildcard additions.                                                                                                                                                                                                                                   |

A usable expectation contains complete Pod/Deployment metadata/spec/template,
explicit container-role inventories, image/pull/argv, required security/account
and resource values, environment/source and volume/mount inventories, DNS/service
links, lifecycle/controller behavior and runtime/placement decisions. Optional
absent behavior is compared as exact absence. The original adapter must validate
the selected policy and resolve its actual static inputs; the grammar alone does
not authenticate those choices.

The existing `selection.manifestDigest` still denotes its original whole manifest
domain. `actualContentRef` and `expectedContentRef` are original producer-owned
comparison-content locators. This evaluator does not claim final Pod bytes hash
to the manifest digest, rederive the five role projections, allocate profile IDs
or implement current-use authority.

## Findings, limits and verification

Findings use only the existing closed reason codes and field paths. Nested or
unsupported paths map to a fixed family or `unknown-field`; raw container names,
environment values, unknown keys and provider errors are never emitted. Findings
are deduplicated, deterministically ordered and capped at 64. Failure is decided
before that cap, and an unavailable reason always survives an unknown result.
Inputs and results retain the original 256 KiB, depth, node and container-entry
decoder limits. Caller trees are not mutated.

With the repository's existing dependencies prepared, run:

```sh
node --test tests/conformance/final-pod-comparison-v1.test.mjs
```

The suite includes complete fictional candidate/observed positives, independently
specified mutations for every rule family, static/due/unsupported expectations,
raw-field preservation, redaction, exact exchange and input bounds. Its versioned
fixture matrix records every behavior and boundary case plus separately owned
integration cases. Five independent strict TypeScript projects compile the
module, producer, candidate consumer, observed consumer and negative type uses
with `noEmit` and `skipLibCheck: false`. The module project checks the
implementation directly; the four producer/consumer/type projects import actual
public package subpaths.

The original admission integration still owns actual create/update/generated
Deployment/ReplicaSet/Pod, patch/apply and ephemeral paths, defaulting/mutators,
protected writers and service failure denial. The supplied contract accepts only
its existing Pod/Deployment wrapper; this evaluator does not broaden API routing.
Actual current/withdrawn-use guards and authentic runtime, identity, credential
exclusion and prior-writer evidence remain with their original accepting
boundaries. Synthetic conformance performs no such operation or qualification.
