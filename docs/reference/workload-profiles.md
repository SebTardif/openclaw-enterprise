# Workload profile contracts and retained preparations

Workload profile support currently provides closed selection contracts, a strict canonical byte codec, a closed manifest decoder and projections, storage adapters for inert preparation records, and internal [candidate binding qualification](workload-profiles/candidate-binding.md#candidate-binding-qualification). The controller registers the five closed operator routes. Production composes their original BetterAuth request custody, selected IAM identity, and same-transaction PostgreSQL account/session participant. Memory authentication has no accepting PostgreSQL account unit. Complete definition admission and profile-backed deployment remain unavailable while native, credential, storage, role and complete capability contributors are missing. Retaining a candidate does not approve it, authorize deployment, select Compute, or establish current runtime protection.

An immutable selection names `manifestRef`, `manifestDigest`, `admissionRef`, and `admissionVersion`. A runtime use additionally identifies its Installation, Namespace, `harness` component, five immutable profile roles, canonical format, and admitted configuration digest. These references identify intended bytes; current authorization must be checked separately when accepting or using them.

The V2 pair manifest permits an explicit zero-channel module selection. It still
requires exactly one identity, Harness and persistence module, the complete
material/path selection, resource envelope and every declared capability.
Removing channel modules changes the canonical manifest digest. Static decoding
does not supply missing admission, capability or runtime owners, and configured
channels still require their exact selected material.
The [hosted Gateway reference](hosted-gateway.md#compose-actual-dependencies)
records the prepared SDK's remaining channel requirement; accepting these static
bytes does not make that runtime support no-channel startup.

Agent draft updates accept `workloadProfileSelection`. Deployment requires the [identified V2 command](lifecycle-deploy-v2.md), including exact saved-draft expectations and a retained operation identity; bodyless deployment requests are rejected. The Agent update and deployment services consume the selection and admitted-configuration definitions, but still require the original authenticated request, transaction enrollment, active admission and capability implementations. The default composition lacks the complete profile suppliers and leaves profile-backed admission unavailable. `Agent.providerId` continues to select the model provider.

The PostgreSQL application role can update the draft selection through a
column-scoped grant. It has no table-wide Agent update permission; Agent identity
and ownership columns remain protected. Saving selection data does not admit a
profile or authorize deployment, and the database rejects malformed selections.

Verify these permissions and real repository updates with
`tests/integration/postgres-agent-draft-selection.test.mjs`. Set
`OCC_AGENT_DRAFT_SELECTION_TEST_DATABASE_URL` to a separately migrated, empty
disposable database using the restricted `occ_app` role. The test refuses an
existing Installation or queued work and skips explicitly when its URL is absent.

## Contract chapters

- [Manifest encoding and projections](workload-profiles/manifest.md): closed shapes, static accounting selection, digest domains and conformance limits.
- [Preparation and operator transactions](workload-profiles/preparation.md): retained identity, capacity, routes, account custody, replay and uncertain-commit recovery.
- [Candidate binding and composition](workload-profiles/candidate-binding.md): original qualification leases and production/development prerequisites.
- [Selected native construction](workload-profiles/native-construction.md): explicit launch operands, Pod and policy construction, and remaining runtime qualification.
