# GitHub credential architecture

[Overview](../github-credentials.md) · [Contract](contract.md)

**Historical scope:** This page records the September 22 design and delivery contract. Read the [September 24 amendment](../github-credentials.md#current-source-amendment--24-september-2026) and its living references for later supported behavior.

This design gives an ordinary Agent temporary repository access while a separate credential process owns GitHub credentials. The [delivery record](../github-credentials.md#objective) distinguishes merged implementation from runtime qualification.

## Vocabulary

An **Agent** is the OCE resource configured to perform work. Its **revision** is an immutable admitted snapshot. A **workload** is the running execution of that revision. A **binding** selects a repository by `repositoryRef`. A **profile** selects permissions and permitted requests: `git-read`, `git-write` or explicit `git-full`. Omission selects `git-write`. A **session** is temporary gateway authority for one admitted binding and deadline.

The requested binding resolves through the Namespace registry to a grant, then enters the immutable revision. The worker opens a session and transfers its client material to Compute. These correlations identify owners and cleanup work. They do not prove cryptographic workload origin. The [admission contract](contract.md#admission-and-authority) defines exact identities and drift refusal.

## Responsibilities

OpenClaw Control Plane (OCC) uses IAM for admission and State for the frozen revision. Existing Provider membership/configuration supplies a concrete private control client. Membership does not authorize repositories, and the repository Provider is distinct from the Agent's model-provider association.

The introduced [RepoDriver](https://github.com/openclaw/openclaw-enterprise/blob/48ec47c0c7f105d32b09ac87b29b2666749503ef/apps/controller/src/drivers/repo/github/driver.ts) resolves bindings and manages sessions. The worker retains claim, correlation and cleanup ownership. Compute owns delivery of the complete runtime-file generation.

Inside the credential process, the broker coordinates sessions and custody, the private backend acquires/retires credentials, and the HTTPS gateway mediates requests. These are internal responsibilities, not additional public Drivers or services. GitHub issues tokens and applies remote effects.

Existing SecretDriver stores supplied Namespace secrets and resolves backend references. The inspected repository paths instead load protected service inputs and create Kubernetes Secrets directly. Model-key delivery uses the separate Secret path.

The [worker-Pod template](https://github.com/openclaw/openclaw-enterprise/blob/48ec47c0c7f105d32b09ac87b29b2666749503ef/deploy/helm/openclaw-enterprise/templates/deployments.yaml) places worker and credential service in separate containers within one Pod. They share a private Unix control socket. Private service inputs remain service-only. The Agent runs outside that Pod and sends HTTPS data requests. This source topology does not establish installed isolation.

## Credential placement

| Material                                 | Holder and purpose                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| App private key                          | Protected service input used to sign App JWTs.                                               |
| App JWT                                  | Service/backend authentication for GitHub issuance.                                          |
| Installation tokens and renewal material | Service custody for upstream requests and settlement.                                        |
| Gateway bearer and client files          | Worker and Compute transfer private material. The Agent holds its bearer to use the gateway. |
| Safe session/grant correlations          | State records identities, deadlines and cleanup ownership, not provider-token inventory.     |
| Model credential                         | Separate Harness delivery supplies the Agent's model access.                                 |

Each issuance requests exactly one repository. Multiple bindings have separate sessions and client material. Demand renewal can produce successive or overlapping tokens within a session, so a binding does not mean one permanent token. [Custody and request bounds](contract.md#security-and-request-bounds) govern these transfers.

State can retain a revision and cleanup records after the credential service loses its sessions and provider inventory. Those records cannot reconstruct lost authority or prove that GitHub effects settled. The [restart contract](contract.md#restart-and-future-obligations) distinguishes recovery with surviving service knowledge from replacement after that knowledge is lost.

## One contribution

The operator first enables repository credentials and configures approved repositories. The Agent owner includes separate contribution and read-only bindings in the Agent request. This fragment is illustrative, not an executed result:

```json
{
  "repositoryBindings": [
    { "repositoryRef": "contribution", "profile": "git-full" },
    { "repositoryRef": "reference", "profile": "git-read" }
  ]
}
```

1. Create the Agent through the API or CLI with the requested repository bindings.
2. Deploy the Agent. Revision admission freezes the two grants and their deadline. The worker records attempts, opens two sessions and records their identities. Compute publishes one complete runtime-file generation.
3. Observe the admitted revision and deployment readiness before using its repository access. The pinned [Agent usage guide](https://github.com/openclaw/openclaw-enterprise/blob/48ec47c0c7f105d32b09ac87b29b2666749503ef/docs/guides/repository-credentials.md) describes the merged implementation.
4. The Agent reads reference material, edits/tests/commits in the contribution checkout, runs native `git push`, then pinned `gh pr create --head feature-branch` against that same repository. A reference push refuses before acquisition or dispatch.

Each effective request receives its own authorization check. `RepoDriver.open` opens a credential session, not a PR. `RepoDriver.close` withdraws session use, not the GitHub PR. Stop retires owned runtime material while unresolved provider cleanup retains its owner. See [interfaces](contract.md#repodriver-operations), [permissions](contract.md#admission-and-authority) and [cleanup](contract.md#request-lifecycle).

## Why these boundaries

A narrow Driver reuses platform selection and lifecycle ownership. A private backend isolates provider issuance differences without adding generic issuer/broker resources. A generic framework would need independent resource, authorization and lifecycle contracts. Recipes can arrange calls but do not supply admission, custody or settlement guarantees.

Stock Git preserves native remote/helper selection. Mediation authorizes effective requests without a custom Git grammar or whole-command preflight. Protected native identity/read mediation addresses stronger origin/currentness authority separately. Durable accounting, encrypted secret recovery and runtime continuation solve distinct problems. No JWT/Postgres recovery design, PAT import, additional provider or replica topology is selected.

OpenShell integration is developed separately around this service, not as its replacement. OCE retains GitHub App issuance, token custody, repository sessions and the Git/REST/GraphQL gateway. OpenShell confines the workload and permits HTTPS to the exact OCE endpoint; OCE still authorizes each request.

[Current Compute admission](https://github.com/openclaw/openclaw-enterprise/blob/48ec47c0c7f105d32b09ac87b29b2666749503ef/apps/controller/src/drivers/compute/kubernetes/index.ts#L1087) still rejects repository-enabled OpenShell Agents. Private material delivery, protected model startup and identity/lifecycle integration remain with their existing owners. Ordinary-Agent contribution, refusal, renewal, withdrawal and crash proof are required before enabling that composition; transport experiments alone do not qualify it.
