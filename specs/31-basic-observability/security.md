# Basic observability: security

[Overview](../31-basic-observability.md) · [Architecture](architecture.md) · [Interfaces](interfaces.md)

**Status:** Proposed controls and qualification requirements. Recorded trust/scope limits below do not accept missing implementation or undecided risks.

## Assets, actors and trust

Protect the historical facts, their original attribution, exact authorization references, recovery references and retention metadata. Opaque identifiers can reveal protected relationships even when they contain no credential. Local integrity means ordinary application roles cannot alter an accepted fact. It does not mean an independent party has witnessed that fact.

The trusted producers are lifecycle admission, State, workers, authentication and credential owners, each for its own facts. Reader C has an explicitly granted audit permission. Deployer A and requester B retain their separate identities and authorities. The [repository scenario](repository-read.md#decision) must prove those distinctions through real handoffs.

Browser, Agent, model/tool, header, provider and network data are untrusted as assertions about an owner. Trusted producer compromise, database/host administrators and independent backups remain outside the local integrity guarantee. Product-created copies and operator-owned copies have separate [retention responsibilities](retention.md#restore-and-copy-ownership).

## Fact authenticity and disclosure

An attacker-controlled string must not become an apparent admission, execution or authorization fact. Only the named owner establishes that assertion. Validate closed projections before persistence and again before disclosure. Reject unknown versions/fields, unsafe text and excess size or depth under the [fact contract](interfaces.md#facts-and-events).

Exclude raw `details`, credentials and custody handles. Also exclude identity labels and issuer/subject claims, requests and plans, URLs, headers, commands, paths, prompts, responses, provider bodies and exception text. Their presence can leak content or cause the reader to mistake untrusted input for evidence. Legacy facts need original trusted provenance and cannot acquire synthesized causation during projection.

References remain protected metadata, never lookup authority. Serialized assurance grants no effect authority. A revision identifier cannot prove that an Agent executed a request, and a bearer cannot establish requester B. Actual receiving and runtime association remain [producer obligations](repository-read.md#currentness-and-closure).

Every page and exact recovery observation requires current authenticated account/session state and the selected IAM Driver's exact permission. Apply the [disclosure transaction](interfaces.md#disclosure-transaction) so an earlier committed revoke prevents disclosure and bytes leave only after acknowledged COMMIT. Refusal, uncertain commit and dependency loss release no protected page.

## Audit failure and protective work

New authority, privileged mutation, credential dispatch, retention changes and History disclosure require established local evidence before effects or bytes. New restrictive intent shares its original transaction. Otherwise an apparently successful action could lack the evidence needed to distinguish acceptance from uncertainty.

Already durably accepted protective work can continue during remote-delivery failure. Audit failure must not block safe refusal or closure. Such work must not fabricate newly durable stop/revoke acceptance when no local commit established it. The [retention writer order](retention.md#expiry-and-concurrency) still applies without inventing a human session for a protective worker.

Report append refusal, unknown COMMIT, storage pressure and overdue erasure through sanitized operational health. Do not expose protected content or high-cardinality labels. Required operations fail closed when local audit cannot commit, including under indefinite retention.

## Accepted limits and closure

This heading records the existing trust and scope boundaries. It does not declare unresolved mechanisms to be accepted residual risk. In particular, expiry-crossing release, recovery keys/reference policy and authoritative restore custody remain [owner decisions](interfaces.md#retention-interface-index) that require closure before serving acceptance.

Already released bytes cannot be recalled. Live-ledger erasure cannot certify deletion of downloads, backups or other independent copies. The [restore contract](retention.md#restore-and-copy-ownership) must prevent expired evidence from reappearing through an older database.

Exact mutation recovery observes local acceptance only. Entire-response loss before the caller receives its reference is outside that contract. Missing or erased evidence stays unknown. Search, client idempotency, replay, compensation, an operation journal and a transaction-status API await a separately selected lifecycle/API use case with pre-response identity, deduplication and real unknown-outcome proof. A signature made before COMMIT cannot certify acceptance.

The following remain separately triggered capabilities:

- **Transcripts and broader content.** Content/IAM must select and enforce separate content authority before transcript storage is added.
- **Installation-wide search and CLI.** State/API must provide bounded authorized queries for search. A later CLI reuses the same History API.
- **General policy editing or remote policy mutation.** IAM must establish grant ceilings and a durable-intent/recovery contract. Observability adds neither a general access-management UI nor another policy writer.
- **Remote export and cryptographic or independent witnessing.** Audit, operators and the independent trust domain must define custody, acknowledgment, replay/completeness and evidence-loss verification. Preserve stable event identity, version, receipt, scope, causation and the producer/State boundary for that later work. The local ledger currently makes no such assurance claim.

[Retention follow-ups](retention.md#acceptance-and-follow-ups) retain richer periods and legal holds. [Runtime follow-ups](repository-read.md#alternatives-and-follow-ups) retain exact-container origin, outage-time physical termination and provider cleanup recovery. These successors cannot weaken the selected off-Pod protection, traffic withdrawal or original erasure deadlines.

## Threat closure evidence

The acceptance evidence must follow the actual threat boundary:

| Threat                                          | Required evidence owner                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cross-scope reads or revoked access             | [Lifecycle acceptance](architecture.md#availability-and-delivery): real account/Group/Restriction races, exact post-deletion grants and browser denial.                                                |
| Forged time or resurrection                     | [Retention acceptance](retention.md#acceptance-and-follow-ups): restricted SQL roles, concurrent expiry transitions and actual restore continuity.                                                     |
| Token/reference leakage or fabricated requester | [Repository acceptance](repository-read.md#acceptance-and-delivery): ordinary A/B/C turn, managed child, off-Pod denial and secret/reference exclusion.                                                |
| Unknown effects mistaken for safe replay        | [Recovery](interfaces.md#mutation-outcomes) and [repository handoffs](repository-read.md#connect-authentic-handoffs): lost acknowledgment, durable independent fences and retained settlement custody. |

Verify privacy through the real producers, storage, HTTP, diagnostics and health surfaces. Keep source, composed, installed, live-provider and release evidence distinct. These are required future checks, not claims that the proposed controls have passed.
