# GitHub read MVP release

Status: **implementation milestone; not released**. Point-in-time specification
dated 2026-09-10. This records the first repository-read milestone and its required
evidence. It follows the [platform design](../docs/design.md) and
[repository access modes](20-repository-access-modes.md). Current behavior remains
owned by the [Repository Work reference](../docs/reference/repository-work-v2.md)
and its linked native, State and custody references.

## Intended user outcome

An authenticated, authorized Agent can read metadata for one exact GitHub
repository and clone or fetch that repository using one explicitly selected
configuration. The resulting checkout must contain the expected repository
content. Push and pull-request publication remain unavailable in this milestone.

This smaller delivery scope does not replace the broader native Git/gh direction
in the repository-access proposal. Native scoped-token access, broker-backed
mediation and history-isolated access have different credential boundaries. An
implementation or controlled test of one does not qualify the others. Local Git
history remains visible after clone/fetch; this milestone makes no history
isolation claim.

## Current implementation and release blockers

The repository contains separate native transport, broker, Runtime origin, Work,
State, policy, protected custody and inventory components. Their interfaces and
component tests do not establish a working deployed repository feature.

| Boundary                              | Current implementation                                                                                                                                                                                                   | Required before release                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Selected execution and Work admission | `RepositoryWorkSelectedExecutionAdmissionSourceV2` declares the required original supplier; no production implementation is supplied.                                                                                    | Authenticate the original native Session against the selected execution and actual Work admission through their original owners. |
| Service composition                   | `startGitHubMediationNative`, `RepositoryWorkOperationOwnerV2` and `createProtectedGitHubRepositorySourcesV2` have component/fixture use; the controller server and worker do not assemble the positive repository flow. | Wire the actual owners and verify request-to-metadata/clone/fetch through that construction.                                     |
| Configuration                         | Programmatic profiles and native parsers describe bounded components. They do not add a supported Agent or deployment setting.                                                                                           | Select exactly one complete configuration and demonstrate both its success and refusal outside it.                               |
| Persistence and outcomes              | State and inventory retain original operations, uncertain outcomes and cleanup responsibility. Existing component tests use various controlled internal peers.                                                           | Demonstrate the enabled flow with actual State persistence, original custody and cancellation/outcome ownership.                 |
| Release verification                  | Focused component and external-fixture checks can establish their named boundaries.                                                                                                                                      | Complete positive and negative integration acceptance and independent review against one frozen candidate.                       |

As of this specification, there is **no qualified deployment configuration and
no successful complete clone/fetch acceptance result**. Unsupported or unavailable
composition must fail explicitly. Adding `github` or `repositoryAccess` to the
maintained deployment configuration does not install this feature; those settings
are unsupported. An unavailable dependency result is useful refusal evidence and
does not satisfy the positive read requirement.

## Must ship and later work

| Priority            | Requirement                                                  | Acceptance evidence                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Must ship           | Authenticated metadata and clone/fetch                       | Real internal composition yields the expected exact repository and commit contents through the selected entry points.                                                                 |
| Must ship           | Identity, repository and permission denials                  | Wrong identity/repository, absent or excessive permissions, expired authority and withdrawn Work fail through the actual API or protocol entry points.                                |
| Must ship           | Cancellation and cleanup                                     | Cancellation closes new use, entered work drains, and each original owner retains its cleanup responsibilities. A timeout is not proof of termination.                                |
| Must ship           | Uncertain outcome accounting                                 | A lost response or COMMIT acknowledgment retains the original operation and unknown outcome, permits inspection through the original owners, and cannot authorize duplicate dispatch. |
| Must ship           | Publication unavailable                                      | API and native/protocol checks refuse push, receive-pack and PR publication on the selected path. Absence of a successful publication test is insufficient.                           |
| Must ship           | One explicit configuration and artifact path                 | The actual selected artifact and configuration work; unsupported versions, profiles, paths and wrong artifact contents refuse.                                                        |
| Must ship           | Coherent verification and review                             | Relevant checks and a complete integration run use the same frozen candidate, with independent correctness/security review and recorded limitations.                                  |
| Later               | Push and PR publication                                      | Separate current-authority, expected-old update, approval, outcome and recovery implementation must close its correctness findings before enabling publication.                       |
| Later               | Broad configuration/platform coverage                        | Additional clients, environments and repository operations require their own qualification.                                                                                           |
| Later               | Automated reconciliation, performance and richer diagnostics | Retained outcomes and an honest manual procedure are required now; automation and wider operational tooling can follow.                                                               |
| Later               | Remaining broader conformance                                | Unenabled operations can remain open; invariants reachable through metadata or clone/fetch remain mandatory.                                                                          |
| Conditional blocker | Artifact readers reachable from the selected configuration   | Any reachable artifact-integrity finding must close before release. An unused reader can be excluded only by an explicit configuration boundary that is verified.                     |

Publication implementation continues separately. This specification neither
enables it nor waives the correctness requirements in the
[publication reference](../docs/reference/repository-publication-v1.md).

## One selected configuration

The release candidate must record a single concrete configuration, including:

- The accepting service/entry point and whether credentials are delivered to the
  native runtime or retained in trusted mediation.
- The selected client and service artifacts, exact immutable identities, install
  paths, ownership and required finite limits.
- Original identity enrollment, selected execution, Work admission, current
  repository policy, State persistence and protected custody suppliers.
- The exact repository/App installation target, permitted operations and minimum
  token permissions; no broader default credential or fallback profile.
- The native identity, endpoint and network enforcement setup actually used,
  including the external fixture substitution when applicable.
- A verification command that runs the complete selected flow and rejects an
  unavailable positive prerequisite instead of reporting it as passed.

The existing component selection uses metadata protocol V2 or explicitly selected
Git read V3. V2 permits only `metadata:read`. V3 requires `protocolVersion: 3`,
`github-git-read-rpc-v3` / `owned-child-stdio-github-git-read-v3`, and exactly the
ordered Work permissions `contents:read`, `metadata:read`. The inventory asks for
exactly `{ contents: "read", metadata: "read" }` in V3. This source-level
selection is described in the [Work](../docs/reference/repository-work-v2.md),
[State](../docs/reference/repository-work-state-v2.md), and
[Runtime](../docs/reference/repository-work-origin-v2.md) references. It is not a
supported installation recipe or evidence that both protocols are deployed.

The existing [native client mechanics](../docs/reference/native-git-client-mechanics.md)
and [native HTTPS transport](../docs/reference/native-github-egress.md) remain
separate source components with their documented missing suppliers. A pinned
client or parser test cannot fill those suppliers or qualify a controller image.

## Verification boundary

External GitHub and Kubernetes services may be replaced by controlled peers.
For the Git peer, genuine Git transport and known repository content must be
exercised. A canned successful HTTP response does not prove clone/fetch.

The following must remain the actual internal implementations in the complete
acceptance case:

1. Controller authentication and exact identity enrollment.
2. Selected-execution and Work authorization with current repository policy.
3. State transaction, persistence and known-versus-unknown COMMIT handling.
4. Protected credential custody, original release and cleanup ownership.
5. Native protocol, cancellation, child/connection drain and outcome accounting.

A test-written Work admission supplier, credential sink or State decision can
test a component contract but cannot stand in for a missing production owner in
that acceptance case. Real Git against an external fixture proves the external
transport boundary only until it is connected through these actual internals.

Each result records its exact source candidate, command, selected configuration,
external substitutions, executed assertions, failures, skips and unresolved
prerequisites. Existing or reused evidence is labeled as such. Authored but unrun
tests, frozen source packets and valid evidence bundles do not count as executed
acceptance. The [release evidence harness](../docs/reference/release-evidence.md)
does not itself execute or authenticate the product flow.

### Commands and evidence

Run maintained checks from the repository root using the prerequisites in
[Testing](../docs/testing.md) and the [documentation map](../docs/README.md).
Publication of a dedicated living read-MVP verification page remains pending.
Component verification commands remain with their
owning references, including [inventory persistence](../docs/reference/repository-credential-inventory-v2.md#verification)
and [native client mechanics](../docs/reference/native-git-client-mechanics.md).
They verify their stated boundaries and do not supply a complete release command.

There is currently no maintained command that proves an enabled deployed GitHub
read MVP through all the original internal owners. The release must not be
declared accepted by combining separately passing component results. The final
integration command and its observed metadata and checkout results must be added
when that construction is implemented and reviewed.

## Uncertain outcomes and manual reconciliation

A read-only user operation can still create provider-side credential issuance
and revocation effects. Losing a response does not establish that those effects
were absent. Business dispatch, credential exposure, token issuance and cleanup
have distinct records and must be inspected separately.

Preserve the exact original operation, access lease, provider target and attempt
identities. A recovered row, copied handle, token fingerprint or fresh operation
reference cannot reconstruct a permission to mint, release or dispatch. Unknown
COMMIT requires readback for the unchanged original operation through its original
State owner. A missing readback is not permission to repeat the provider request.

There is no operator-facing repository-outcome inspect or reconcile CLI/API in
the current assembly. The following describes the responsibilities of the
existing internal owners, not shell commands an operator can currently run:

1. Stop new use through the accepting owner's existing cancellation/withdrawal
   path and retain the original operation and inventory records. Do not delete
   those records to clear capacity or retry under a new identity.
2. Allow the independently retained observer to join entered provider work and
   recover the original operation through the original State/inventory owner.
   Observer completion does not require the cancelled user call to become live.
3. Retain authenticated late token material and its actual permissions/expiry.
   Ineligible or retired material remains `mitigation-only`; an uncertain mint
   remains `mint-unknown`. Neither is usable authority.
4. Use the original cleanup claim and bounded observer call for any authorized
   revocation and preserve its attributed outcome. Confirmed provider revocation,
   authenticated definite nonissuance, or conservatively elapsed evidenced
   provider expiry can resolve the applicable responsibility. A local deadline,
   failed read or unconfirmed revocation cannot do so.
5. Inspect the separately retained business and credential outcomes before any
   later action. An unresolved result stays unknown and continues to hold its
   provider target/capacity. It must not be relabeled success or noncommit.

The [State adapter](../docs/reference/repository-work-state-v2.md#fresh-committed-use-and-settlement),
[credential inventory](../docs/reference/repository-credential-inventory-v2.md#capacity-and-uncertainty),
and [protected custody](../docs/reference/protected-github-custody.md) own these
contracts. Source inspection has raised two questions for the original owners:
whether failed Work observation append/readback loses its retry path, and whether
an unresolved mint with unproved expiry can keep `close()` pending indefinitely.
These findings require owner confirmation and regression execution; they are not
executed full-flow test failures. The protected custody reference already makes
shutdown conditional on settlement and requires separate original enrollment for
startup recovery. Protected material recovery alone does not install that
enrollment or promise automatic deletion of encrypted files.

Unavailable observation is an operational gap, not proof of successful shutdown
or safe replay. A maintained, authorized inspection path and recoverable outcome
ownership for the selected composition remain required before this manual
procedure is operationally usable.

## Release and rollback limits

Before recording completion, the integration owner must retain the exact reviewed
source/artifact identities, configuration, integrated acceptance results and
remaining later work. Current reference and testing instructions must describe
that same construction. This point-in-time record does not supersede later
reference corrections or certify a deployment on its own.

Controlled external peers do not establish live GitHub permission enforcement,
provider token revocation, actual Kubernetes network enforcement or a production
installation. Claims about those boundaries require separately selected live
evidence. No production deployment or release rollback has been qualified by this
specification.

Rollback must preserve State history and protected credential/revocation
material. Close new admission, join entered work through its original owners and
retain unresolved effects for reconciliation. Reverting code or configuration
does not revoke a token, prove a remote operation absent, erase an uncertain
COMMIT or authorize its replay. There is no feature-specific automated rollback
command in the current assembly; use only an implemented, reviewed deployment
procedure once the selected configuration exists.
