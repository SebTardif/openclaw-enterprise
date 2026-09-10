# Identified deployment commands and admitted configuration

The deployment command codec defines a client-retained operation identity and
exact saved-draft expectations. The admitted-configuration codec defines the
immutable configuration projection associated with that deployment. The Agent
update and deployment services consume the shared profile selection and Use
definitions, and the deploy HTTP operation requires this explicit V2 command.
These adapters require the original authenticated request, transaction enrollment,
active admission and capability implementations. Their presence in the route
catalog does not supply those producers or enable a missing composition.

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
    maximumExecutionMs: null | positiveSafeInteger,
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
number. `providerId` retains its model-provider meaning. `maximumExecutionMs`
must match the saved Agent cap: explicit `null` means uncapped duration. A finite
selection has no fifteen-minute ceiling and is copied into the newly admitted
immutable revision. Creation-time defaulting does not permit omission from this
identified command; changing a draft or replaying an accepted command cannot
extend an existing attempt.

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

The accepting transaction must perform fresh authorization over the
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

The deploy registration retains raw bytes in an encapsulated JSON parser until
the original command decoder has rejected duplicate names, invalid UTF-8 and
unsupported numeric representations. The existing admission hook still runs
before parsing; schema validation and current identity resolution still precede
dispatch. Other operations retain their existing parsers. A successful deploy
response contains only the original accepted operation reference, generation,
timestamp and fixed deploy/saved-draft/running fields, with response metadata.
It does not expose the revision document or its protected credential selection.

An existing Agent can save an explicit `workloadProfileSelection` through its
authorized update path. Omission preserves the selection; null, an implicit
latest profile and a default selection are unsupported. Changing or explicitly
resubmitting a selection requires the original enrolled active-head validator
and its withdrawal-conflicting lease. Agent creation retains its existing
behavior. Public Agent and revision reads project optional Selection and shared
pair-wide `workloadProfileUse` respectively; historical absence is preserved.

The selected deployment service serializes the command and resolves a committed
exact replay before reading today's draft, head, Drivers or active profile. The
original enrollment must authenticate current authority over the retained
original operands before that lookup can disclose a result. For a new command,
the service compares all saved-draft expectations, normalizes and validates the
Configuration, prepares Use before the first revision INSERT, and invokes the
same-unit selector against the inserted row. The protected credential record is
the second argument to that same revision INSERT. Both returned profile leases
transfer to the original transaction owner for final checks and terminal cleanup.

Acknowledgement recovery runs after the failed write transaction has unwound,
through the original read owner and a separate current recovery enrollment. It
uses the same client-retained command, not a new transport request ID, and never
prepares Use, changes the lifecycle head or submits provider work. Missing or
failed readback remains unavailable; it cannot establish rollback.

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

Additional conformance sources are
`tests/conformance/agent-workload-profile-selection.test.mjs` and
`tests/conformance/deployment-workload-use.test.mjs`. They exercise the actual
services and raw HTTP boundary with explicitly controlled owner participants.
Such fixtures do not qualify production authentication, held account/policy
authority, durable commit or active profile capability.

The accepting composition must install genuine current invocation, original
unit/read enrollment and profile resolution inputs in the Agent and deployment
services. Missing inputs leave the selected methods unavailable. Complete native
SDK/Driver qualification, actual account and reference guards, profile storage
and invalidation, and client command retention remain with their original
implementations. No second manifest, profile selector, request journal, or
caller-supplied positive authority is defined here.
