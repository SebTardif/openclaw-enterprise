# Runtime assignment storage

`runtimeAssignments` and `runtimeAuthority` retain the intent, allocation and
initial provider binding of an Agent execution inside `PlatformStateStore`
callbacks. Both memory and PostgreSQL implement the repositories.

The current controller does not produce or consume these records. This storage
component must land together with an owning Agent/Token workflow that uses it.
The records alone do not activate a runtime or grant access.

## Intent and allocation

An Agent retains its Agent-owned `servicePrincipalId`. An allocation copies that
stable subject together with the exact Installation, Namespace, Agent, revision,
component and profile references. Each execution receives a new `assignmentRef`
and component `runtimeGeneration`. Its `createEffectRef` identifies the original
create operation before any provider effect starts.

Intent initialization begins at generation one. Advancement and allocation use
expected-generation comparisons. Allocation requires the current running intent.
Gateway and harness allocations remain distinct. An exact create-effect replay
returns its original allocation even after the intent stops; changed owner,
generation, component or profiles conflict.

The state owner resolves the Installation, Agent principal and revision owner.
PostgreSQL foreign keys retain their relationship to the immutable intent.
Foreign owner locators return no record. Physical owner deletion cannot cascade
through retained history.

## Initial gVisor binding

An initial harness binding retains the exact Pod, deployment, replica set, runsc
sandbox, runtime instance and restart discriminator. It also retains the admitted
configuration, images, policy and provider/runtime/identity profile digests.
`expectedBindingVersion` must be null. Once bound, a new operation cannot refresh
or replace the instance; exact replay returns the original receipt.

The observation records the source time, receipt time, finite validity window,
owner-chain reference and create-effect correlation. Parsing checks supplied
values and their relationships. It does not authenticate the observation or
establish current runtime eligibility.

## Validation, replay and transaction outcomes

The curated `@openclaw-enterprise/contracts` entry point exports the versioned
schemas, parsers and canonical mutation encoder. The object parser produces
immutable snapshots of closed data. The raw JSON parser additionally rejects
duplicate keys and ambiguous numeric literals before ordinary JSON decoding
loses those distinctions. Errors identify a failed rule without echoing values.

Each accepted binding appends an immutable receipt. Replay first compares the
operation identity, full canonical payload and accepted service identity before
checking current intent or versions. Only request correlation may change. A
replay creates no effect and does not prove present authority.

An authority mutation failure rejects the enclosing transaction even when its
callback catches the error. Binding and receipt writes share the platform
transaction. Repository handles reject after the callback closes; read views
expose no mutations. See [platform repositories](../platform-repositories.md).

Lost PostgreSQL COMMIT acknowledgments retain
`PostgresCommitOutcomeUnknownError`. Read the exact original operation identity
before retrying an effect. Missing or unavailable readback does not prove the
transaction failed and cannot justify a replacement operation identity.

[Storage verification](../../testing/runtime-assignment.md) covers persistence,
constraints and transport uncertainty. The owning workflow must separately
supply authenticated service attribution, protected observations and authorized
admission.
