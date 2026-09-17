# Backend recipe operation declarations

Trusted OpenClaw Control Plane (OCC) components use
`@openclaw-enterprise/occ/internal/backend-recipe-operations-v1` to share the
GitHub operation catalog and provider-neutral schema/recipe types. This is a
supported internal construction boundary. It grants no backend access.

## Selected data

`githubOperationRegistrationsV1` contains bounded schema registrations and
`RecipeOperation` descriptors. `SelectedRecipeOperationRegistrationV1` describes
that unregistered data shape without codec custody, a callable resource projector
or dispatch authority. Consumers preserve exact service, action, profile and
schema correspondence.

| Backend/profile     | Operations                                                                                | Retained profile      |
| ------------------- | ----------------------------------------------------------------------------------------- | --------------------- |
| GitHub `read`       | metadata, fetch discovery, fetch                                                          | `repository-read-v1`  |
| GitHub `read-write` | metadata, fetch discovery, fetch, push discovery, push probe, push, pull-request creation | `repository-write-v1` |

Read-write metadata and fetch keep the write profile. Independent preparation
requires a separately admitted read profile and authority; selecting a read
operation never downgrades runtime credentials.

Third-party catalogs, provider-specific schema/authentication mappings and
operational configuration can live in separate private repositories. This
package exports their shared types without importing those implementations.
A provider's original trusted owner must supply its installed catalog and exact
admitted definitions. Merely supplying a backend name or definition does not
install an implementation or authorize an operation.

## Original registration contract

`SelectedRecipeDefinitionsV1<Backend>` is a readonly record whose keys name the
finite selection made by trusted startup and whose values are independently
admitted original `DefinitionRef` values. The declaration
`registerSelectedRecipeOperationRowsV1(schemas, definitions)` requires the original
`CredentialSchemaRegistryV1` and the selected definitions. It accepts no caller
codec, action callback or resource mapping callback.

The result, `SelectedRecipeOperationRowsV1<Backend>`, preserves exactly those keys
and readonly arrays of `SelectedRecipeOperationRowV1`. A GitHub-only selection
returns only its GitHub group; a separately installed provider can have its own
selected group without changing a shared provider enum. Each row contains its
definition, operation, operation/profile registrations, original registered codecs,
service/action data and the original `canonicalResource(resource)` contract.

An implementation must match each admitted definition to its installed trusted
owner catalog, refuse missing catalogs, begin one original registry scope per
definition, register distinct bindings once, commit the scopes and authenticate
both codecs against the exact row bindings. Codec kind alone is insufficient:
foreign registry, operation, profile, backend, pending and discarded codecs must
refuse. Repository placement changes none of these authority requirements.

The package re-exports the original `DefinitionRef`, `SchemaRef`,
`SchemaRegistration`, `RegisteredSchemaCodec`, `RetainedSchemaValue`,
`ResourceIdentity`, `RecipeOperation`, `OperationCaptureOwner`, `OperationOutcome`,
`ResourceOperationAdapter` and `CredentialSchemaRegistryV1` types. It introduces
no replacement custody brand.

## Resource correspondence

Each backend supplies its resource-policy encoding data. The original resource
projector must first check exact `resourceSchema` correspondence, then encode
`[prefix, upstreamInstanceId, resourceNamespace, resourceKind, canonicalResourceId]`
as a JSON array using that data. Namespace and kind remain stable across schema
revisions; schema version and digest are checked before projection. Upstream
instance identity distinguishes the same opaque repository ID on different
providers or instances. IDs remain byte-for-byte and case-sensitive, including
nested identifiers. Display names and parsed path fragments are insufficient.

The original projector and selected IAM guard must enforce a nonempty canonical
resource of at most 4096 UTF-8 bytes and 4096 UTF-16 code units for every provider.
The supplied GitHub operation schemas use a 4096-byte input envelope whose
lossless resource keys reuse the same encoded IDs with less fixed overhead.
Other provider catalogs must establish their own correspondence and bounds;
registration alone makes no size guarantee for their projected keys. Every
provider also remains subject to the complete IAM facts envelope's separate
aggregate limit. Other tuple identifiers retain their 256 limits.

## Runtime status

The selected registration factory and resource projector are declarations;
the package supplies no callable implementation of either. Production
construction must refuse missing owner bodies. Execution and mechanism
references are inactive descriptors requiring admission of their exact real
installed implementations. The data does not establish endpoint reachability,
provider credentials, request submission or installed gateway behavior.

The implemented schema registry can register bounded operation and profile
schemas and validate, retain and restore their data. Conformance uses the GitHub
catalog and an independently invented synthetic provider fixture. Compiler
consumers check selected key inference, original synchronous grant projection and
the native IAM constructor. These checks do not execute the absent selected
factory or production grant projector, or qualify any real third-party provider.
See [schema runtime verification](../testing/credential-schema-registry.md) for
the original registry lifecycle and proof limits.
