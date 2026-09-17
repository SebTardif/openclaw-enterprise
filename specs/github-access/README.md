# GitHub access, identity, Work, and runtime lifecycle

**Status: Proposed.** RFCs 0034–0037 define the GitHub gateway MVP and its
credential, authority and runtime contracts. Implementation qualification is
separate from design acceptance.

Start with the [series overview](0027/runtime-access-overview.md), then the
proposal owning the behavior you want to review:

| Proposal                                                                                         | Responsibility                                                            | Supporting contract                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0034: Credential lifecycle and GitHub App access](0034-github-app-credentials.md)               | Protected credentials, mediated reads, direct push and PR creation        | [GitHub profile](0034/github-app-v1-spec.md), [broker](0034/credential-broker-v1-spec.md), [configuration](0034/repository-configuration.md), [qualification](0034/lifecycle.md) |
| [0035: Workload identity and runtime authority](0035-workload-identity-and-runtime-authority.md) | Stable Agent identity, execution binding and finite enforcement authority | [Enforcement specification](0035/enforcement-spec.md)                                                                                                                            |
| [0036: Work authority](0036-turn-bound-delegated-authority.md)                                   | Service-owned root Work, requester provenance, scope and cancellation     | [Work authority specification](0036/work-authority-spec.md)                                                                                                                      |
| [0037: Persistent runtime lifecycle](0037-persistent-agent-runtime-lifecycle.md)                 | Construction, writer exclusion, replacement and recovery                  | [Lifecycle specification](0037/lifecycle-spec.md)                                                                                                                                |

## MVP scope

An administrator admits one private repository. Access defaults to read;
`read-write` also permits direct push and minimal same-repository PR creation.
The gateway validates an Agent access token and current online authority for
each operation. GitHub credentials stay outside Agent execution. Genuine root
Work, separately admitted checkout preparation, cancellation and observed writer
termination are required.

Ship one active gateway and one immutable root Work per execution. Constrained
recipes select trusted primitives; pin one version per admitted bundle and prove
identical-version restart. An independently authored synthetic non-GitHub recipe
is required alongside GitHub to prove the shared admission and credential path.
Provider-specific recipes and implementations may live in separate repositories;
admission still requires supported primitives and the same authority and custody
contracts. Additional live providers, remote-broker execution, multi-replica
operation and concurrent bundle versions are deferred.

Bearer copying and ongoing destination ownership/visibility protection are
[known limitations](0034/github-publication.md). Protected-origin authentication,
approved-candidate publication, broader Work and public lifecycle controls are
future capabilities.

## Documentation ownership

These proposals extend the [platform design](../../docs/design.md). Supported
behavior belongs in the [feature references](../../docs/reference/README.md);
implementation changes update their affected references, guides and flows.
Existing model and ServiceAccount credential delivery remain separate.
