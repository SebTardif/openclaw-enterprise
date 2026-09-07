# Identified deployment commands and admitted configuration

The deployment command codec defines a client-retained operation identity and
exact saved-draft expectations. The admitted-configuration codec defines the
immutable configuration projection associated with that deployment. Both are
source components. They do not register an HTTP route, change the existing
deployment service, install an admission repository, or supply current authority.

## Command identity

`packages/contracts/src/lifecycle-deploy-v2.ts` defines this closed command:

```ts
{
  schemaVersion: 2,
  operationRef,
  expectedLifecycleGeneration: null | positiveSafeInteger,
  revisionSource: "saved-draft",
  expectedDraft: {
    configurationId,
    configurationGeneration,
    providerId: string | null,
    executionMode: "embedded" | "dedicated",
    serviceAccountId: string | null,
    workloadProfileSelection: {
      manifestRef,
      manifestDigest,
      admissionRef,
      admissionVersion
    }
  }
}
```

`operationRef` uses the original lowercase UUID-v4 lifecycle identity. Every
expectation is explicit; omission, `undefined`, or a bodyless request cannot
select a different snapshot. Configuration generation belongs to the existing
Configuration resource. It is independent of lifecycle generation and revision
number. `providerId` retains its model-provider meaning.

`parseLifecycleDeployJsonV2("command", bytes)` accepts bounded UTF-8 or a string
and rejects duplicate keys, unsupported fields or versions, invalid encoding,
numeric aliases, and unsupported IDs. `parseLifecycleDeployV2` accepts inspected
plain data when a prior transport parser has already preserved those properties.
The bounds reuse the original lifecycle admission limits. The source currently
uses Node dependencies; this contribution does not qualify a browser bundle.

`bindLifecycleDeployCommandV2(scope, command)` adds exact route Namespace/Agent
and the server-owned Installation to the fixed `agent.deploy` action.
`canonicalLifecycleDeployCommandV2` returns the complete normalized JSON string
for UTF-8 byte comparison, with sorted object keys and no trailing newline.
There is no new command digest or authority field. Original actor custody remains
separate from this serializable binding.

The eventual accepting transaction must perform fresh authorization over the
retained original operands before disclosing a committed result. Exact replay
then resolves the same canonical command and original revision, intent, work,
and mutation audit before comparing today's draft or lifecycle head. A changed
draft cannot rebuild an already accepted request. Replay does not reassert the
old intent or allocate another mutation. A fresh transport request ID is not a
replacement for the retained original attribution.

For a new operation, the accepting writer must serialize the operation identity,
compare every draft expectation and the expected lifecycle generation, resolve
current references and profile admission, and retain the complete immutable
association in one transaction. Caught admission failure must roll back that
unit. An unknown commit or an unavailable read remains unresolved; it does not
authorize a new operation ID, another provider submission, or a deadline reset.
Independent status reads retain their own current Agent-read authorization;
revision documents additionally require AgentRevision read. Mutation permission
does not grant either disclosure.

## Admitted configuration projection

`packages/occ/src/workload-profiles/admitted-configuration.ts` exports
`deriveAdmittedConfigurationV1(input)` and the retained-byte decoder
`decodeAdmittedConfigurationV1(bytes)`. They validate and normalize the full
projection before returning its immutable value, independently owned canonical
bytes, and `admittedConfigurationDigest`.

The exact input is:

```ts
{
  manifestDigest,
  configurationRef,
  configurationGeneration,
  immutableConfigurationContent: {
    kind: "agent",
    values, // actual admitted native document after sandbox/logging normalization
    secretBindings // original normalized typed Secret bindings
  },
  resolvedProfileBindingParameters: {
    installationId,
    namespaceId,
    agentId,
    serviceAccountAssociation: {
      servicePrincipalId,
      serviceAccount: { id, credential: { kind, secretRef: { name, key } } }
    },
    storePolicyBindings: [
      { component, name, path, store: { ref, version, contentDigest }, access }
    ],
    roleBindings // original provider/runtime/identity/containment/storage records
  }
}
```

The native document is the actual `admittedConfiguration` that DeploymentService
freezes after sandbox configuration and `admitLoggingConfiguration`. The codec
does not repeat those transformations or hash the earlier raw document. Native
Driver validation, exact model/runtime selection, current reference permission,
and profile capability checks remain mandatory in that accepting unit.

The initial closed native branch supports the existing Harness configuration
fixture's explicit model selection and provider/model records, the fixed local
Gateway configuration, the explicit Codex app-server configuration, optional
environment Secret references, and the bounded workspace-only file-tool
configuration. It requires the existing admitted logging fields and disabled
duplicate OTEL log delivery. Unknown native options, plugins, credential delivery
modes, inline credentials, and broader tool settings reject. Accepted values are
preserved rather than stripped or replaced with defaults. This is a bounded
configuration grammar, not complete native SDK validation or deployment approval.

Secret bindings reuse the existing closed reference and environment-delivery
normalizer. Every typed Secret reference must identify the exact Namespace.
Every native environment Secret allowlist member must also name one of those
typed bindings; an unbound process environment name cannot substitute.
The ServiceAccount association reuses the existing immutable revision credential
reference; only `api_key` and `access_token` are supported. Credential values and
backend identity do not enter this projection. An absent applicable association
has no implicit null/default variant.

Logical store members use the selected manifest's `component`, mount `name`,
`path`, immutable `store` reference/version/digest, and `access` mode. The codec
requires both Gateway and Harness coverage and unique component/name and
component/path members, with at most sixteen members for each component,
then sorts that declared set by component and name. The actual selector must
compare this complete set with the same admitted manifest and its current
policy authority; syntactically valid records are not evidence of those facts.
All five original role records remain distinct. PVC/PV/Pod UIDs, assignments,
create effects, observations, and later mount realization are excluded.

The digest is SHA-256 over the literal UTF-8 prefix
`oce.workload-profile.admitted-configuration.v1` followed by one LF byte and the
canonical bytes of the complete projection. It reuses
`oce.workload-profile.canonical-json.v1` unchanged: no null, fractional or negative
numbers, unsafe integers, implicit coercion, Unicode normalization, or generic
JSON fallback. Unsupported Configuration values must fail before create.
`manifestDigest`, launch-configuration digest, raw image digests, and this
per-revision digest have different meanings and are never aliases.

## Verification and remaining integration

Focused tests are `tests/conformance/lifecycle-deploy-v2.test.mjs` and
`tests/conformance/admitted-configuration.test.mjs`. Configuration fixtures run the
maintained Harness fixture and actual immutable/logging normalizers. They check
retained content, all five role records, scope and reference sensitivity, declared
set normalization, strict rejection, and independent snapshots. They do not run a
native Driver, database transaction, account producer, or runtime.

Agent selection fields, the shared pair-wide profile-use definition, both revision
freezers, the original admission repository, current authority guards, route and
client cutover still require their original implementations. No second manifest,
profile selector, request journal, or caller-supplied positive authority is defined
here. Unsupported production inputs remain unavailable until those actual
participants are connected.
