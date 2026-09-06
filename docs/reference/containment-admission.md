# Final Pod comparison contract

The `@openclaw-enterprise/contracts/containment-admission-v1` package subpath
provides an in-process contract for comparing a complete supplied Harness Pod
and its Deployment with an exact expected shape. It exports versioned input,
result and comparator declarations, closed structural decoders, bounded raw JSON
values and independent compiling producer and consumer examples.

The comparator implementation and the original producer's expectation adapter
are not implemented by this module. Successful decoding establishes structural
validity and intrinsic correspondence. A `conforming` value remains supplied
comparison data: it establishes neither current profile admission, authenticated
observation, Kubernetes enforcement, runtime eligibility nor a prior-writer
barrier. This module creates no resources and invokes no provider.

## Existing ownership and content association

`binding.selection` reuses `WorkloadProfileSelectionV1`; `binding.profileUse`
reuses `WorkloadProfileUseV1`, including its canonical format, immutable
manifest/admission/version association, five role references and content digests,
and admitted configuration digest. These original types currently apply only
to **Harness**. Gateway and repository-preparation Job applicability is not
inferred. The revision target reuses the original Runtime identity field types.

`profileContentDomain: "manifestDigest"` names the existing normalized manifest
domain for `selection.manifestDigest`. It does not describe the raw Pod bytes.
`actualContentRef` and `expectedContentRef` are original producer-owned immutable
comparison-content locators. The original producer must bind those locators to
the exact supplied documents, comparison request, target, selection/use and
stage. Decoder acceptance does not authenticate that association. A changed
input requires its original producer's new corresponding reference and request
association; reference strings are not bearer capabilities.

The future original expectation adapter must use the existing manifest
normalization and domain-separated projections, validate all five derived role
associations and the exact revision/configuration association, and supply its
complete expected document. This contract imports no application implementation,
normalizes no profile, and computes no digest. Current unresolved static inputs,
image-set identity or configuration content must produce an unavailable
expectation; a complete synthetic fixture does not fill those actual inputs.

## Candidate and observed stages

The schema requires exactly one stage, and repeats the complete binding in the
result. Schema, comparison and normalization versions are each exactly `1`.
Unsupported versions and unknown envelope properties fail decoding.

| Stage       | Required identity                                                                                                                                                 | Later Runtime information                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `candidate` | Exact Installation, Namespace, Agent and revision target; comparison reference; candidate request reference and create/update/patch/ephemeral-container operation | Provider-object and execution bindings are explicitly `not-due`. There is no future Pod UID, runsc identity or target SVID field.                                                     |
| `observed`  | The same revision/use association; cluster and namespace identity; actual Pod and Deployment UIDs and resource versions                                           | The complete original `RuntimeObservationResultV1`, including its original input, provider/execution correspondence, provenance and desired/delivered/effective profile observations. |

A candidate means the complete proposed object before the applicable
persistence. It is distinct from the Runtime contract's
`preallocated-candidate`, which observes an actual unbound object and retains
its original create-effect/responsibility contract. The observed stage embeds
that original union without relabeling it or copying its proof protocol.

Deployment scope, immutable configuration, service-principal association and
store/reservation bindings are explicit original-authority references at both
stages. Each is either `supplied` or `unavailable`; missing descriptors are
invalid. Candidate provider-object and execution bindings must be `not-due`.
At the observed stage they must be `supplied` or `unavailable`. These owner names
are routing labels in ordinary data, not authenticated producer context.
A store reference alone proves no reservation, mount safety or writer exclusion.

For a complete observed result, the decoder checks the original Runtime
contract, exact Harness revision target, immutable cluster/namespace/Pod and
Deployment correspondence, Deployment resource version, admitted configuration
and provider/runtime/identity profile digests. Raw observed Pod and Deployment
metadata must match their respective UID and resource version. Original source
and receipt times and policy-stage records remain unchanged. An incomplete,
ambiguous or unknown original observation cannot yield a conforming comparison.
When such an observation retains a known `bound-instance` input, its original
instance identity, configuration and profile digests must still match the
comparison binding. A `preallocated-candidate` input similarly retains its known
provider cluster/namespace and any expected Deployment UID. Its earlier expected
resource version is preserved without requiring equality to a later observation.
An unavailable outcome does not erase already known facts.

## Full raw-field presence

`actual` and an available `expectation.document` each contain the **whole raw**
Pod and Deployment JSON trees. Both require their supported `apiVersion`/`kind`
(`v1`/`Pod` and `apps/v1`/`Deployment`). They are not narrowed through a
Kubernetes SDK DTO. Unknown keys, explicitly absent fields, `null`, empty
containers and array order remain distinguishable. The decoder retains unknown
executable fields for the comparator to reject or evaluate; it does not silently
strip them or decide their conformance.

An available expectation declares all twelve field groups, exactly once:

- Images and pull policy.
- Ordered commands and arguments.
- Init, main and ephemeral containers.
- Probes and lifecycle hooks.
- Environment and source selectors.
- Process security and identity, including host/process/network namespaces.
- Mounts, volumes and propagation.
- Resources, overhead and defaults.
- DNS, hosts and service links.
- Restart, termination and controller update behavior.
- Placement and runtime.
- Approved annotations.

This list declares the expected comparison coverage. It does not verify that a
producer actually resolved every required value; that remains the original
expectation adapter and comparison implementation's responsibility. Unresolved
static groups are identified explicitly by an unavailable expectation. Missing
fields never acquire wildcard permission or unlimited resource defaults.

Diagnostic exclusions are individually named, versioned comparison inputs. The
only recognized names in this contract are:

- `pod.metadata.creationTimestamp`
- `pod.metadata.managedFields`
- `controller.metadata.creationTimestamp`
- `controller.metadata.managedFields`

The list may be empty, and duplicate entries fail. Raw values remain present
regardless of the declared exclusions. The later comparator applies accepted
normalization rules. Whole metadata/status exclusion, UID/resource-version
exclusion and arbitrary field-path exclusions are unsupported. Changing this
finite vocabulary requires a reviewed version change.

## Outcomes and decoding

`ContainmentAdmissionComparatorV1.compare` declares an asynchronous in-process
port. There is no supplied evaluator, RPC endpoint or default implementation.
The three decoders are:

```ts
import {
  decodeContainmentAdmissionInputV1,
  decodeContainmentAdmissionResultV1,
  decodeContainmentAdmissionExchangeV1,
} from "@openclaw-enterprise/contracts/containment-admission-v1";
```

Each accepts unknown data and returns either `{ kind: "valid", value }` or the
fixed `{ kind: "invalid", reasonCode: "invalid-input" }`. Input and result
objects are detached and deeply frozen. The exchange decoder checks both
objects and their complete binding equality. It does not run the comparator or
recompute a document digest. Consumers must use the original producer's bound
content, the actual comparator and the exchange decoder together.

| Outcome         | Structural requirement                                                                                               | Consumer meaning                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `conforming`    | No findings; available profile use/content locator and all due bindings; complete original observation when observed | Supplied comparison success only. Original current-admission and protected-operation authority remain required. |
| `nonconforming` | At least one closed mismatch finding; no unavailable reason and no unavailable due binding                           | Deny the compared use.                                                                                          |
| `unknown`       | At least one closed unavailable reason                                                                               | Deny the compared use. Required missing facts cannot become success or a definitive mismatch.                   |

An unavailable expectation requires an `unknown` exchange result independently
of other binding fields. Findings contain only bounded closed reason codes and
field paths. Paths use fixed placeholders, such as
`pod.spec.containers[*].image` and `unknown-field`, never raw container names,
environment values, provider errors or arbitrary field names. Binding content
locators and original observation references must already be sanitized by their
original producers. Raw input trees can contain sensitive configuration and
must not be logged or turned into diagnostics.

## Value and verification limits

Decoding is an in-process JSON-value boundary. It accepts plain objects (including
null-prototype objects), dense ordinary arrays and valid JSON scalar values.
It rejects accessors without invoking them, proxies, caller serialization hooks,
symbol/hidden properties, class instances, cycles and shared object aliases.
It also rejects undefined values, nonfinite numbers, negative zero, numeric
magnitudes beyond JavaScript's safe-integer range and malformed Unicode.
Finite fractions within that range remain raw supplied values.

Limits apply during the descriptor-only snapshot: 256 KiB of serialized UTF-8,
32 levels of nesting, 16,384 visited values, 1,024 members per object or array,
and 64 result findings. Exceeding a limit returns the same fixed invalid result.
These limits bound the contract; they are not Kubernetes resource budgets.

This module is not a JSON text parser. A future wire adapter must reject
ambiguous source encodings, duplicate keys and unsupported presence or enum
values before they can be discarded, preserve the original canonical profile
bytes and digest domains, and then call this contract. Ordinary JSON
serialization is exercised for lossless valid-value roundtrips; it does not
redefine a canonical manifest digest.

With the repository's existing TypeScript, TypeBox and Node dependencies
prepared, run:

```sh
node --test tests/conformance/containment-admission-v1.contract.test.mjs
```

The suite exercises the actual structural decoders and exchange correspondence,
including stage/version substitutions, missing static and due inputs, preserved
raw fields, original Runtime identity/provenance, safe decoding, bounded redacted
findings and serialization. It also runs five separate strict TypeScript
projects: the module, independent producer, independent candidate consumer,
independent observed consumer and negative type assertions. Each uses
`skipLibCheck: false` and `noEmit: true`; examples import public package subpaths.
The fixtures are fictional contract data, with no authenticated producer,
selected executable profile, live admission or runtime execution.
