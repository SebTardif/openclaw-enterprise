# Workload profile contracts and retained preparations

Workload profile support currently provides closed selection contracts, a strict canonical byte codec, a closed manifest decoder and projections, storage adapters for inert preparation records, and internal [candidate binding qualification](#candidate-binding-qualification). The controller registers the five closed operator routes. Production composes their original BetterAuth request custody, selected IAM identity, and same-transaction PostgreSQL account/session participant. Memory authentication has no accepting PostgreSQL account unit. Complete definition admission and profile-backed deployment remain unavailable while native, credential, storage, role and complete capability contributors are missing. Retaining a candidate does not approve it, authorize deployment, select Compute, or establish current runtime protection.

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

The canonical JSON utility accepts UTF-8 bytes, rejects duplicate object keys, and sorts ASCII property names. It preserves Unicode scalar values and array order. It rejects malformed UTF-8, unpaired surrogates, negative numbers, fractions, exponent notation, unsafe integers, and null manifest content. Operator envelopes permit their explicitly declared null first-admission expectation. Lexical validity alone does not validate a complete manifest; the preparation repository also invokes the closed manifest decoder.

The manifest decoder recognizes one dedicated `codex/1.0.0` Harness definition for direct `occ/kubernetes-gvisor`, Linux/amd64, and a separate trusted gateway. Its eight required sections are target, profile roles, artifacts, launch configuration, containment, endpoints, evidence requirements, and capabilities, alongside schema version 1. Every nested shape, role, claim, capability, unresolved code and server-binding position is closed. Unknown fields or roles, cross-reference substitutions, unsupported controls, alternate units and path aliases reject. Resource quantities use integer millicpu and bytes. The decoder sorts only the declared sets and rejects duplicate identities; the init-before-main container sequence remains ordered.

The unresolved candidate retains 27 missing static inputs, eleven server-bound descriptors, and eight non-executable capabilities. The accounting position also accepts the explicit static selection described below; all other missing inputs remain unresolved. The descriptors identify five same-admission profile roles and six values supplied at their owning deployment, preparation, discovery or observation stages. Their presence supplies no server-resolved value or current authority. No resolved artifact or executable-capability variant is accepted by this candidate dictionary. Source and artifact identity fields have strict formats; their syntax and hashes do not verify provenance, installation or execution.

`launchConfiguration.resourceEnvelope.podAndRuntimeAccounting` accepts either its unchanged `{ status: "unresolved", code: "L10", owner, required }` descriptor or exactly `{ status: "selected", envelope }`. The selected envelope is the complete existing `RuntimeResourceAccountingEnvelopeV1`, validated by `parseRuntimeResourceAccountingV1`. It retains its own `envelopeRef`, positive integer `envelopeVersion`, owner references and every supplied or missing accounting input. Both `observations.gateway` and `observations.harness` must be exactly `{ status: "unavailable", ownerRef, reason: "producer-port-unavailable" }`, with a nonempty owner reference accepted by the original parser. `effectiveResources` remains the original unavailable declaration. Runtime observations, observed UIDs or timestamps, validator results, totals and extra fields cannot enter this static branch. The manifest's existing null prohibition and byte/structure limits still apply.

Selection identifies immutable candidate input, including unresolved budgets; it does not establish arithmetic feasibility. The separate accounting validator may return `incomplete` or `invalid` for a schema-valid seed. Its result and nullable totals are not serialized into the manifest. No default seed or production envelope identity is supplied. The internal `projectWorkloadProfileResourceAccountingV1(bytes)` accessor validates the complete manifest and returns the exact immutable unresolved or selected branch. It retains all seed fields and array order through the existing canonical JSON encoding; it does not resolve missing values, infer container correspondence from an accounting ID, or produce a runtime grant.

The complete outer resource envelope continues to use the `oce.workload-profile.resource-envelope.v1` digest domain. In the selected branch that includes the fixed manifest container quantities, the task-cap candidate, the selection tag and the entire RUN envelope, including its separate gateway and node inputs. A change to the seed, its reference or version therefore changes the resource-envelope, launch-configuration, runtime-profile and manifest digests. The standalone RUN envelope has no interchangeable digest here. The unresolved candidate's canonical bytes and digests remain unchanged.

Using this static selection for deployment still requires the original protected accepted-profile reader to correlate its exact retained manifest and seed with the actual revision, configuration generation, `RuntimeCreate` target, original create effect, accepted resource-envelope digest and guarded current profile selection. That producer and its current-use association are unavailable. Neither inert preparation nor accounting validation supplies them; all eight capabilities remain non-executable and the admitted-configuration digest remains unavailable. Synthetic conformance seeds establish only codec, projection and rejection behavior, not an admitted profile, resource allocation or runtime enforcement.

Both input and canonical output are bounded to 65,536 bytes. The codec also limits nesting to 32 containers, a container to 1,024 entries, and a document to 8,192 value nodes. Separate digest domains bind manifest content, its named subdocuments, client intent, and server-allocated operation identities. Hashes from different domains are not interchangeable.

Derivation constructs thirteen exact candidate projections: manifest, artifact set, launch configuration, provider profile, runtime profile, identity profile, containment, storage profile, endpoints, evidence requirements, mount policy, resource envelope and runtime flags. The containment role uses the containment digest; the other four roles use their corresponding profile digests. Aggregate artifacts include source and package identities, while Harness-specific artifact selectors exclude separate gateway artifacts. The selected accounting branch retains the complete cross-workload envelope as described above. The component image-set digest remains unavailable while main or init images are unresolved. The per-revision configuration digest remains unavailable without authoritative deployment inputs, including the Configuration resource generation. Neither unavailable domain is filled with a placeholder hash.

Documentary descriptions are bounded, nonempty text retained in the content digest. They cannot choose a producer, change a server-binding descriptor, resolve a missing input or supply an authorization result. Test fixtures use synthetic identities and documentary text; their expected digests identify only those fixture bytes.

Run `node --test tests/conformance/workload-profile-manifest.test.mjs` to verify the closed decoder and exact projections, including unchanged unresolved golden digests, selected seed identity, missing budgets and rejection of observation-bearing seeds. This is source conformance; it does not exercise account admission, PostgreSQL, Compute or a live runtime.

The preparation repository validates and derives the closed manifest before taking locks or allocating identities. An envelope's `canonicalUtf8` must already equal the normalized manifest bytes and its declared digest must match; the repository does not silently rewrite client intent. It retains exact canonical client intent, its digest, original account and principal correspondence, the once-allocated identity bundle, and a separate operation digest. Its internal storage key is Installation, original principal, and caller-known operation UUID; the account must also match. Exact replay reuses the retained IDs and time. Reusing that key with different bytes conflicts. Another actor cannot adopt or read its retained operation. Replay and readback revalidate the manifest even when an older record's outer operation and intent digests are internally consistent.

Preparation records are explicitly inert. They do not contain an approval, current authority, or a runtime receipt. The repository checks the exact scoped prior operation before allocating IDs. It serializes capacity before operation identity and Namespace access, limits unresolved ordinary preparations to 32, and caps ordinary history plus terminal reservations at 4,096 slots. Exact replay and readback consume no new slots. Unknown outcomes and abandoned history must not be evicted to recover capacity.

Memory storage borrows an isolated working snapshot and transaction lifetime. It does not provide a shared account/IAM authority gate. PostgreSQL storage borrows the owning transaction connection; schema composition, migrations, restricted-role grants and owner-enforced immutability must be installed before that adapter is available in the controller. The adapters do not start or commit transactions. Their owner must finish the profile transaction guard before committing so that caught repository errors roll back the unit.

The registered operator contracts expose these controller paths:

| Method and path                                          | Purpose                                                                                             |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `POST /workload-profile-operations`                      | Retain the caller's exact preparation and allocated identities.                                     |
| `POST /workload-profile-operations/:operationRef/accept` | Accept an exact retained preparation with a fresh current authority check; the request is bodyless. |
| `GET /workload-profile-operations/:operationRef`         | Read an original-actor operation under current read authority.                                      |
| `GET /workload-profiles/:admissionRef`                   | Read a sanitized retained profile.                                                                  |
| `POST /workload-profiles/:admissionRef/withdraw`         | Atomically consume an admission-owned reserved terminal template.                                   |

Every mutation acknowledgement is limited to its operation reference, action and exact scope. It must not expose retained manifest content, allocated identities, accounts, grants or audit records under mutation authority alone. An uncertain commit returns only the preknown operation locator and `exact-readback-only`; recovery must resolve that actor's own durable operation before any retry. Retained reads require current `read` and `administer` permission on the Installation plus the registered management class. Withdrawal accepts only the supported V2 request; V1 requests are rejected before account or storage admission. A fresh protective withdrawal does not require an additional read permission.

Terminal withdrawal and active admission are not implemented by inert preparation storage. The required terminal template belongs to the admission, contains preallocated closure identities, and reserves capacity independently of actor-owned pending preparations. Its atomic consumption must bind the current withdrawing actor without adopting an abandoned actor's operation. A durable profile invalidation request is a dedicated outbox record, not a runtime fence, physical stop, or proof of termination.

The production service consumes one exact method and canonical command from the real authenticated request. It acquires account/session security and fresh selected IAM policy on the original PostgreSQL transaction, retaining them through commit or rollback. The schema, restricted controller helper role and account security records must be installed; a missing dependency returns unavailable. Active profile admission requires a complete real selected definition, with every required missing static input resolved through an accepted successor dictionary. Active admission and profile-backed deployment additionally require connected current-use guards for allocation, preparation and binding, plus the actual invalidation consumer. Storage, metadata, a startup flag, or an observation cannot supply those missing capabilities.

The platform store exposes inert profile preparation through `PlatformUnitOfWork.workloadProfiles.prepareOperation` and exact original-actor history through `PlatformReadView.workloadProfiles.findOperation`. Both use the owner's existing transaction and lifetime. Memory state publishes an isolated snapshot; PostgreSQL retains the canonical envelopes and allocated identities with a matching capacity charge. Caught or unawaited preparation failures roll back the complete unit, and retained methods reject after that unit closes.

Ordinary preparation transactions remain conservatively isolated: the canonical Installation lookup and exact profile-history lookup are permitted, while unrelated repository work, borrowed SQL and a second preparation in the same unit are rejected. This preserves capacity/operation-before-Namespace locking without treating arbitrary SQL or a caller flag as current authority. Perform separate preparation requests in separate units and recover each exact original operation before retrying an uncertain commit.

Database checks enforce the closed retained envelope, canonical bytes, digests, scope, foreign keys, immutable history, capacity correspondence and per-Installation uniqueness for each of the thirteen reserved identifier kinds. The actual repository additionally rejects an invalid selected manifest on preparation, replay and readback. A direct application-role insert can retain a coherent inert envelope containing a semantically invalid manifest; it remains unusable through those repository operations and consumes its retained capacity. These records confer no active admission, terminal-withdrawal, deployment or provider authority. Preparing or reading an inert record does not qualify the missing complete definition or current-use contributors.

Verify with the public workload-profile unit-of-work tests and the allocated, migrated PostgreSQL workload-profile integration suite. The latter requires its explicitly selected limited application role and dedicated fixture; a skipped database suite does not prove persistence, restart or unknown-COMMIT recovery.

The PostgreSQL owner additionally provides `workloadProfileTransaction` for a bounded internal policy and preparation unit. It uses explicit `READ COMMITTED`, pins the actual selected Native IAM instance and its original store, and acquires the complete IAM writer-table lock set before fresh identity, permission and registered-class evaluation. A fixed lock-only database function grants the application role only execution of that fixed lock acquisition; it does not grant IAM update or delete access. The owner retains locks and the selection hold through COMMIT, rollback and uncertain-outcome cleanup. Account-adapter queries close before policy evaluation, and a single preparation or exact read follows; unrelated work cannot be authorized by a caller flag.

In this unit, successful preparation and its mandatory attributable local audit commit together. The preparation audit has a separate deterministic identity based on the exact Installation, original principal and operation. It leaves every reserved admission and terminal identifier unchanged. Exact replay verifies and retains the original audit instead of appending duplicate mutation evidence. Failed or unawaited work poisons the whole unit, including audit failure after the preparation was staged. Retained detail requires both current Installation read and administer permission and the enabled registered administrator mapping.

Production installs the operator account participant around this unit. The auth owner binds each of the five exact route IDs to its canonical operator command, original human Principal and request recipient, consumes the handle once, and retains the existing request deadline and cancellation signal. Service keys cannot enter the human operator path. The account consumer reuses the original session-security reader and transaction cleanup; it creates no independent transaction or IAM grant. The existing channel request handle cannot substitute. Missing participation returns dependency-unavailable, and memory authentication has no equivalent shared transaction. Complete capability contributors still refuse new acceptance and deployment; no admitted head is synthesized. Internal PostgreSQL tests with synthetic actor records establish policy/storage ordering only, never authenticated human admission.

The focused `workload-profile-admission` test verifies missing-participant denials and actual runtime instance/selection correspondence without a database. Its explicitly selected `workload-profile-admission-postgres` companion verifies actual policy writer contention, audit rollback, bounded cancellation and uncertain COMMIT on a dedicated migrated database. Successful internal tests do not establish authenticated production admission or remove the invalidation, runtime-definition and active-use prerequisites.

## Candidate binding qualification

[`createWorkloadProfileCandidateBindingsSourceV2`](../../packages/occ/src/workload-profiles/admitted-use.ts) composes an original `WorkloadProfileCandidateRecordsReaderV2` with four fixed qualifiers. Construct it with the genuine suppliers, then pass the result to `createWorkloadProfileCandidateSourceV2(contexts, bindings)` for the existing Use resolver. The records reader must recognize the original deployment unit and tracked operation, returning its captured locked normalization records and separate opaque source identity without acquiring new parent locks.

The PostgreSQL state's `workloadProfileCandidateContextV2(...)` supplies this reader as `records`, beside `candidates` and `contexts`. It reads the same completed normalization slot and selected admission head. Returned observations include the normalized Configuration, locked Agent and ServiceAccount, actual optional provider-binding lookup, and Secret metadata in original binding-entry order, including repeated aliases. API-key normalization leaves the provider binding undefined. Reads issue no new SQL or Driver resolution. The opaque identity belongs to the original slot; copied units or another operation cannot use it to enroll.

Each record lease owns only its observation. Retain it through the original transaction's final currentness checks, then release it; the enclosing owner retains and cleans up the original Driver guards. Currentness is synchronous, remains valid after acquisition closes while the owner is live, and fails after observer release, owner expiry or a guarded source change. Reusing a released observation poisons the recognized owner. The component protocol is exercised by `node --test tests/conformance/workload-profile-candidate-context.test.mjs` with actual state, repositories and normalizer over controlled SQL and Driver peers; it does not establish PostgreSQL locking or the four semantic qualifications below.

Each qualifier recognizes the same original records and supplies its own retained lease:

- `native`: installed native Configuration and module semantics.
- `credentials`: exact ServiceAccount credential/backend and model-provider association.
- `storage`: original logical storage policy and installed mount mapping.
- `roles`: admitted role records and their current original semantic sources.

The factory compares captured Agent, Configuration, ServiceAccount, provider, ordered Secret references and admission-head associations. Qualified outputs must match the original account credential reference, admitted roles and declared gateway/Harness mounts. Manifest expectations, generic JSON validation and copied records cannot supply the missing qualification producers.

The returned lease exposes `bindings`, synchronous `assertCurrent()` and idempotent asynchronous `release()`. Cleanup is retained before supplied data is inspected. Failed currentness remains latched; release joins pending assertions and closes acquired leases in reverse order. Currentness checks fail after release completes. Acquisition failure poisons the original tracked operation and joins captured cleanup. Consumers retain the lease through the original owner's terminal checks and cleanup. The outer Use resolver still owns complete capability acquisition and inserted-row verification.

Missing genuine records or qualifiers remain unavailable. This factory installs no production default, mints no admitted Use and grants no provider-call authority. For an `unavailable` result, inspect missing suppliers, original enrollment, cancellation and currentness; for `selection-mismatch`, inspect the exact captured references and qualified outputs. Do not substitute caller-provided records for an unavailable original source.

With Node.js 24 or newer and matching workspace dependencies prepared, run:

```sh
node --test tests/conformance/workload-profile-candidate-bindings.test.mjs
node --test tests/integration/workload-profile-candidate-mock-e2e.test.mjs
```

The focused suite checks fixed composition, detached inputs, correspondence, retained currentness and joined cleanup with controlled record and qualifier issuers. The composed suite calls the actual controller deployment service with the candidate source, binding factory, capability aggregator, Use resolver and selector. It checks first-insert Use correspondence, selected-row verification, commit/cleanup ordering, exact replay and refusals over scripted SQL and controlled account, Driver and qualification dependencies. Neither suite establishes a production records producer, authentic authority, PostgreSQL locking or durability, credential issuance, native support or provider execution. The composed suite does not exercise HTTP routes, the worker or a live runtime.

## Production composition and current verification boundary

Production now passes the actual PostgreSQL candidate context/records and inserted-row storage to the existing candidate and Use adapters. The same selected capability aggregator is used for definition acceptance, Use acquisition and inserted-row revalidation. Its missing original contributors and candidate qualifiers remain explicit unavailable dependencies. This composition does not grant renderer-only support, reinterpret metadata as native authority, or permit an unqualified deployment.

Production and PostgreSQL development assemble these connections in two stages.
The original invocation source is created once and enrolled with State before
owner collaborators are constructed. Candidate construction then borrows the
captured credential consumer from that same State context. Credential
qualification retains the original ServiceAccount observation and its paired
policy through currentness checks and joined cleanup; copied metadata cannot
replace either participant. The binding factory checks that the records reader
and all four qualifier methods are present before acquiring a record or invoking
any qualifier. An incomplete owner composition remains unavailable.

The maintained candidate-binding, candidate-source, prepared-use, use-v2 and
construction conformance suites exercise the real adapters, selector and
controller construction with controlled collaborators. They verify composition
and refusal behavior; they do not supply the missing production credential
issuer, complete capability contributors or a successful live deployment.

The selected Compute factory binds its renderer source once to the original
Driver-owned capability. Admission composition and prepared Harness verification
use that same instance; a second composition or replacement of a constructor-bound
source fails. The independent custodian's revision lease preserves its original
Harness launch operands through source currentness and cleanup. Missing operands
remain unavailable, and copied launch values do not acquire dispatcher custody.
These connections do not install the missing immutable-definition custodian or
complete contributors, select a native launcher, or authorize provider submission.

The focused operator and request-custody suites cover the registered HTTP boundary, actual BetterAuth sign-in with memory storage refusal, exact purpose/command consumption, replay refusal and cancellation-held cleanup. Controlled session-reader cases do not prove PostgreSQL writer exclusion. A separate allocated PostgreSQL production request must verify successful inert preparation/readback, current-account revocation and unchanged record counts after failed acceptance before those behaviors are treated as runtime evidence. No successful full profile deployment is claimed by this source increment.

## PostgreSQL development composition and verification boundary

PostgreSQL development also connects the registered operator routes to the original service, authenticated request/account/session custody and selected IAM. It passes the captured candidate context/records and inserted-row storage to the candidate source, capability aggregator, selector and Use resolver. The same aggregator serves definition acceptance, Use acquisition and inserted-row revalidation. The independent immutable renderer-definition custodian, complete contributors and candidate qualifiers remain required; missing suppliers remain unavailable.

The bounded PostgreSQL development check covers authenticated inert preparation, exact original-actor readback, current-session and request refusals, and genuine missing-contributor acceptance refusal. Failed acceptance must leave active admissions, retained history, capacity, successful acceptance audits and Compute effects unchanged. These observations must identify the exact receiving source, composition and database permissions.

A temporary isolated-fixture grant to existing `occ_app` of `EXECUTE` on `occ.read_locked_workload_profile_session_v1(text,text,text,text,text,text)` establishes only that fixture permission. Retain inner-helper and direct-account-record denial, revoke the grant after all application work joins, and verify restoration of the original outer-function ACL. This component check does not establish production role enrollment, complete profile admission or physical/provider support. An accepted private result does not establish behavior at a different receiving revision, composition or permission setup.

## Selected native construction data

The selected native definition decoder validates a bounded, closed construction
record against the existing V2 containment and endpoint references. It separates
the client-facing model/issuer TLS authority and port from the exact IPv4 address
and port visible to network policy after translation. Identity and Harness
transport remain opaque original definition references until their owners supply
accepted protocol schemas. There is no new V2 manifest field or universal
selected-record digest domain.

The private definition reader interface preserves separate definition and
revision lifetimes. Only the original enrolled owner can verify its immutable
bytes, digest domain, scope and current source custody. Parsing or matching a
reference does not implement that reader. No production source or positive
selection factory is installed.

The selected Harness constructor produces a complete desired Deployment from
explicit detached native launch, initializer, readiness, environment, process
identity, declared PVC and resource-accounting operands. It owns a fixed
Restricted Pod shape with explicit process groups and strict supplemental-group
handling, disables service links and automatic ServiceAccount token
mounting, and sets explicit protected DNS. It does not reuse the historical
login/shared-token entrypoint or infer a Node initializer. Missing inputs and
unsupported extra fields reject. The existing resource normalizer supplies the
separate application/init resources and bounded ephemeral storage capacities.

The constructor rejects Secret-based environment projections, host paths,
undeclared mounts and historical model/login/shared-token environment names.
These structural checks are not a secret detector or executable/configuration
qualification. Original runtime, environment, storage and identity owners must
validate actual initializer/probe behavior, all environment values, PVC custody,
artifact contents and protocol support before a production selection exists.
There is currently no production caller for this constructor, and existing
workload rendering behavior is unchanged.

The network constructor returns an explicitly **incomplete** contribution: a
selected-role default deny and exact resolver/model/issuer destination rules.
It does not enable native GitHub, identity bootstrap or authenticated Harness
transport. Those original suppliers and aggregate policy closure remain missing.
An additional default-deny policy cannot remove another policy's broad egress or
all-Pod DNS grant. Desired objects never establish actual DNS routing,
translation correspondence, outer enforcement, retained-socket closure or
installed effective controls.

Run the pure construction checks with prepared workspace dependencies:

```sh
node --test tests/conformance/selected-native-deployment.test.mjs
```

The cases exercise the real decoder and full Pod/policy constructors with
synthetic nonsecret construction data, including reference changes, extra fields,
missing launch operands, unsafe paths, credential projections and accounting
mismatch. They do not install a definition source, contact Kubernetes or a model,
qualify an image, or establish runtime authority. Compatibility with the separately
normalized final-Pod admission comparison remains pending its original receiving
composition; these checks assert the constructor output directly. Native launch, identity,
network-mechanism and original accepting-owner composition remain prerequisites
for enabling a selected deployment.
