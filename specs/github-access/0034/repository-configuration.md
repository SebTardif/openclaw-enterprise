# Repository configuration and CredentialGatewayDriver

Proposed configuration and ownership for [RFC 0034](../0034-github-app-credentials.md).
The current public Agent create/update API has no repository field, and the
current Driver capability list has no credential gateway. The shapes below are
proposals, not existing endpoints or released capabilities. The proposed internal
credential selection is `repository { profile, binding, grant }`; it is absent
from this RFC's public base and does not establish production access.

## Administrator workflow

1. An Installation operator selects the credential gateway implementation and
   protected storage. A Namespace administrator enrolls an exact GitHub App
   installation and verifies its organization, repositories, and permissions.
2. The administrator selects repository access on an Agent using the typed
   structure below. Repository selection is platform configuration, separate
   from model instructions or repository-supplied files.
3. OCC authenticates the administrator and authorizes the exact Namespace,
   Agent create/update, selected Configuration, integration binding, broker,
   and referenced Secret. Permission to edit the Agent alone cannot grant use
   of another binding. Cross-Namespace or unresolved references deny admission.
4. A separately authorized deployment resolves the checkout ref to a full
   commit OID, verifies repository identity and scope, and freezes the draft
   selection and referenced generations into `AgentRevision`. Saving the draft
   does not admit or activate a revision. Independently authorized withdrawal
   can deny current access immediately without deploying the draft.

This is native, admin-managed OCE configuration. Entra integration and personal
GitHub ACL synchronization are not prerequisites. User/channel allowlists
authorize invocation separately; they neither confer repository permission nor
lend the requester's GitHub credentials to the Agent.

## Proposed typed Agent selection

Propose an optional `repositoryAccess: AgentRepositorySelection` on Agent create
and update. Omission on create selects no access; omission on update preserves
the draft. An empty array clears the draft selection. Accept at most one
repository. Save grants nothing; deployment freezes a separately authorized revision.

```ts
type AgentRepositorySelection = {
  schemaVersion: 1;
  repositories: Array<{
    bindingRef: OccReference;
    repositoryId: number;
    checkoutRef: string;
    accessProfile?: "read" | "read-write"; // default: read
  }>;
};
```

Field names are illustrative. Use validated reference and lossless repository-ID
codecs, bounded refs and a versioned DTO. Reject unknown fields/versions and
multiple or ambiguous repositories. Existing read-only selections, including
`publication: disabled`, cannot acquire writes implicitly. Repository, profile
or Work-context changes require fresh admission/execution and a fresh Pod/gVisor
boundary. Independent withdrawal can deny active operations immediately.

The admitted revision retains the binding generation, GitHub App/installation
identity, canonical repository name and ID, resolved commit, access profile,
and policy generation. IDs govern authority; names aid
review and cannot redirect access. Public resources contain references and safe
metadata, never signing keys or tokens. The [GitHub access record](github-app-v1-spec.md#admitted-data)
derives from this selection.

Effective access is the intersection of current OCC/IAM service authority,
the admitted Agent revision, the original Work selection, applicable restrictions,
and the App installation's available repository permissions. The gateway
requests one repository and the exact fixed token profile admitted for that grant. It denies
unsupported intersections; it cannot fall back to installation-wide access.

Each runtime repository operation still needs genuine original Work, its current
assignment and operation authority. Preparation is separately admitted; cleanup
uses independently retained platform authority after Work or assignment closure.
Configuration, admission snapshots, and successful enrollment are ceilings, not
reusable authorization decisions.

## Proposed CredentialGatewayDriver

The proposal adds `credential_gateway` to the Driver capability registry, with
`CredentialGatewayDriver` as its interface. The Installation selects its
implementation through the Driver model. Selection names an implementation; only trusted composition can supply the admitted
Work, IAM, inventory, custody, and runtime handles required to serve requests.
Configuration strings or reconstructed objects cannot manufacture those handles.

| Owner                     | Responsibility                                                                                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OCC/IAM                   | Sole platform authorizer for configuration, work admission, current operations, withdrawal, and independently authorized cleanup. GitHub also enforces provider permissions.                       |
| `CredentialGatewayDriver` | Hosts protocol mediation and composes the broker and provider issuers; consumes admitted handles, enforces exact operations, and owns startup, quiesce, recovery, and disposal of this capability. |
| `SecretBroker` and issuer | Broker retains leases, protected custody, durable inventory and cleanup obligations; issuer performs exact authorized GitHub issuance/revocation.                                                  |
| `SecretDriver`            | Backend secret storage.                                                                                                                                                                            |
| `ServiceAccountDriver`    | Service-account provisioning and its existing credential contract; no expansion into general GitHub mediation.                                                                                     |
| Compute and SandboxDriver | Execution, safe checkout and termination observations; network/runtime containment and observed writer termination.                                                                                |

Expose only operations needed by real composition or runtime callers. Keep
capture, transaction, settlement and capacity helpers inside their owning modules;
compiler fixtures alone do not justify public exports. The proposed Driver offers
these narrow local operations:

- **Admit access:** consume OCC's exact admitted selection and assignment,
  returning an opaque access reference. It cannot create Work or widen a grant.
- **Mediate:** validate the bearer and original server-owned binding, then consume current operation authority; validate
  the canonical provider request, acquire an eligible credential, and dispatch.
- **Close and recover:** close local access, retain unresolved effects and
  credential obligations, and run cleanup under separate current authority.
- **Quiesce/dispose:** stop new calls and join bounded work while preserving
  durable records. Process shutdown does not mean provider revocation.

The [broker operations](credential-broker-operations.md#broker-operations) and
[issuer ports](credential-broker-operations.md#issuer-interface) supply the detailed
contracts. This capability adds no public Token, Lease, Issuer, or gateway
resource. The credential gateway is separate from the Agent's messaging
gateway. A deployment may cohost broker and mediator outside Agent execution;
process layout does not change authority or custody boundaries.

## Publication modes and delivery

`read-write` authorizes direct push and independent same-repository PR creation
under current Work/IAM authority. Human approval, candidate retention and branch
provenance are not gates. `read` denies both write operations. The
[publication contract](github-publication.md#trusted-publication) owns exact
request validation, receipts and accepted destination-security limits.

The standalone TypeScript gateway runs one active process, with durable PostgreSQL
custody, inventory and claims. Reuse OCC/IAM and State transaction owners. Observe
predecessor termination before replacement; accept downtime and defer scaling.
Constrained recipes select trusted primitives; connections configure upstreams,
while OCE grants authorize operations. The [broker contract](credential-broker-v1-spec.md#backend-recipes)
owns per-bundle pinning, retirement and the controlled second-backend proof.
Additional production providers, remote execution, protected-origin authentication
and approved-candidate publication remain future scope.

[Acceptance](lifecycle-acceptance.md#acceptance-matrix) must prove reads, direct
push and PR creation through genuine owners and the regular Agent runtime.
