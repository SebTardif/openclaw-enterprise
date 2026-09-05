# Channel administration

Channel installations and external human bindings are manual administrative
records. Their create, get, list, and status operations require a currently
admitted human session, a matching human Principal from the selected IAM Driver,
and an explicit Installation-administrator registration on a granting
AccessBinding. A generic `administer` permission alone does not classify a human
as an administrator. See [Manual channel bindings](channel-bindings.md) for the
actual endpoints and record lifecycle.

## Exact operations

The additional human requirement applies to these eight operation IDs:

| Record                 | Create                      | Get                      | List                       | Change status                  |
| ---------------------- | --------------------------- | ------------------------ | -------------------------- | ------------------------------ |
| Channel installation   | `createChannelInstallation` | `getChannelInstallation` | `listChannelInstallations` | `setChannelInstallationStatus` |
| External human binding | `createChannelHumanBinding` | `getChannelHumanBinding` | `listChannelHumanBindings` | `setChannelHumanBindingStatus` |

Each operation also requires the selected Driver's existing `administer` check
on the server-owned singleton Installation. A service key cannot satisfy the
human requirement, even when its service Principal has the same Role and generic
permissions as an administrator. The four Agent-binding operations retain their
existing admission and permission checks. Creating or enabling an Agent binding
also requires current `read` and `operate` on its exact Agent.

The controller installs one admission verifier when it creates the channel
service. It retains the original request, admitted session, resolved human
context, selected IAM object and Driver ID in private process memory. A protected
dispatch receives one opaque invocation object, consumed for that exact service
operation and removed when dispatch finishes. The verifier resolves the human
again through the same selected Driver before the service checks permission.
Direct callers cannot substitute a JSON object, issuer/subject pair, claimed
Principal ID, or service key for this request custody. Startup installation is
sealed after installation or first protected use; a later caller cannot replace
the verifier.

Each controller and channel-service instance belongs to one admission-owning
Fastify app. Recreating an app uses a new controller over the retained platform
store. Reusing the same service instance for another app is rejected at startup,
so a second app cannot replace the original request registry or extend its
invocation lifetime.

Existing browser-intent checks apply to session mutations. Invalid explicit keys
still fail admission even if a valid session cookie is also supplied. Stored
session expiry still prevents access. A disabled or disappeared target human
does not prevent an authorized administrator from disabling its binding;
re-enabling requires the original exact human lookup to succeed.

## Registration on existing IAM state

The native IAM implementation stores optional `channelAdministration` metadata
on the existing AccessBinding:

```json
{
  "schemaVersion": 1,
  "version": 1,
  "status": "enabled",
  "installationId": "ins_11111111-1111-4111-8111-111111111111",
  "roleId": "the-existing-role-id",
  "semanticClass": "installation-administrator"
}
```

The Role and binding must have Installation scope. The metadata names the same
Role as the containing binding and the actual Installation. A resource-specific
binding must target that Installation. The Role must grant the ordinary exact
permission, and the binding must actually contribute to the decision. Role names,
group labels, account creation, email domains, and the presence of a broad Role
do not create this registration. Group bindings can contribute only through the
native evaluator's current membership and grant checks.

Initial native human bootstrap explicitly registers its newly created human
binding at version 1. Its independent service binding remains unmapped. Additional
accounts bound to an existing Role remain unmapped. Existing persisted bindings
are not automatically classified. Channel APIs do not create or edit IAM policy;
existing protected IAM provisioning owns explicit registrations and withdrawals.
There is no new public registration endpoint in this change.

PostgreSQL stores the closed object in `occ.iam_access_bindings.channel_administration`.
Database checks bind it to the existing Role, binding owner, and singleton
Installation. New registrations start at version 1. Once registered, the binding
identity, subject, Role, and resource scope are retained: it cannot be retargeted,
deleted, or returned to SQL NULL. Changing enabled/disabled status requires exactly
the next safe integer version. An unchanged write is a no-op. Withdrawal retains
the disabled mapping and its version; it does not erase evidence of registration.
The application database role gains no IAM update or delete privileges.

## Decision evidence and failures

The native Driver validates and evaluates one loaded IAM snapshot. For the exact
Installation administration request it emits closed `channelAdministration`
evidence containing the Installation and the actual granting binding IDs, Role
IDs, and enabled mapping versions. The service requires the evidence identity
to match the current human and every mapping to belong to the decision's grant
IDs. Any applicable Restriction denies the operation. Successful channel
mutations retain this evidence in the existing transactional audit record.

| Condition                                                                                            | Result                                    |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Missing, invalid, or expired admission evidence                                                      | `401 UNAUTHENTICATED`                     |
| Service admission, nongranting human, absent/disabled registration, or applicable Restriction        | `403 FORBIDDEN`                           |
| Inconsistent registration, unavailable IAM, selected Driver change, or unsupported semantic evidence | `503 DEPENDENCY_UNAVAILABLE`              |
| Authorized lookup of an unknown or differently owned record                                          | Existing fixed `404 NOT_FOUND` envelope   |
| Authorized stale record version                                                                      | Existing `409 RESOURCE_CONFLICT` envelope |

Custom IAM Drivers must supply the same qualified evidence from their own
authoritative granting state. Omitting that capability does not fall back to a
Role name or generic allow decision. The schema and diagnostic evidence do not
themselves prove session admission, current account state, or authority to mutate
an account.

These checks use actual request admission and fresh selected-IAM reads. They do
not implement account/security epochs or an atomic compare-and-consume across
the session provider, IAM provider, and record transaction. PostgreSQL loads the
native Role/binding state in one repeatable-read snapshot; later requests observe
committed withdrawals. A withdrawal that races an already authorized mutation
has no new global revocation guarantee here. Cross-process invocation proofs and
account recovery invalidation are also outside this component.

## Exact revision disclosure

An exact AgentRevision read first authorizes `read` on the requested Agent, then
checks the revision's exact Namespace and Agent ownership and authorizes `read`
on that revision. A revision-only grant, sibling Agent grant, foreign Namespace
grant, or Agent Restriction cannot disclose the revision. Both exact reads are
sufficient without a separate Namespace-read grant. These checks also apply to
direct controller calls. The [generated API reference](api.md) lists both
permissions.

## Verification

Run the focused in-process suites from the repository root with the installed
workspace dependencies:

```sh
node --test tests/conformance/channel-administration.test.mjs tests/conformance/iam.test.mjs tests/conformance/occ-read.test.mjs tests/conformance/occ-api-security.test.mjs tests/integration/channel-bindings-api.test.mjs
```

They exercise real Native IAM evaluation, Fastify routes, Better Auth sessions and
keys, current mapping withdrawal and corruption, direct-service denial, retained
Agent-binding behavior, and both revision permission checks. Their platform state
is in memory. The dedicated `tests/integration/postgres-channel-administration.test.mjs`
uses a disposable supported PostgreSQL database selected by
`OCC_CHANNEL_ADMINISTRATION_DATABASE_URL` and its separately limited owner URL
`OCC_CHANNEL_ADMINISTRATION_MIGRATION_DATABASE_URL`. It exercises persistence and
actual database constraints; without those explicit test URLs it skips that
integration. Neither suite verifies a live channel provider, account security
epoch, or production deployment.
