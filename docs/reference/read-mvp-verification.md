# READ MVP verification

This page explains how to verify the selected clone/fetch READ components with
publication disabled. It distinguishes actual component behavior, controlled
local composition, and deployed internal access. The receiving results below
record selected fixture and component coverage; three clone/fetch opt-ins remain
unselected.

Receiving checkpoint: **2026-09-10**, source commit
`1c1e3e8741df7e7a8f3ec25d52a4e0553ae0a919`. These results describe that exact
checkpoint, not later source changes or full internal READ acceptance.

The current source supplies the [Git read broker](github-mediation.md#git-read-successor),
[native identity/session boundary](github-mediation-identity.md), and
[bounded native Git transport](native-github-egress.md#broker-backed-git-clone-and-fetch).
Those components do not by themselves enable repository access in a deployment.
The genuine selected-execution admission source and production controller caller
that supplies the original repository operations remain required for positive
internal reads. Their absence does not prevent testing a component against an
explicit, faithful substitute at its dependency port.

## Selected read contract

The Git successor requires all of the following to agree:

| Selection                | Value                                                          |
| ------------------------ | -------------------------------------------------------------- |
| Broker wire version      | `3`                                                            |
| Native operation policy  | `github-git-read-rpc-v3`                                       |
| Native transport profile | `owned-child-stdio-github-git-read-v3`                         |
| TLS application protocol | `oce-github-git-read-v3`                                       |
| Git protocol             | `version=2`                                                    |
| Repository permission    | Exact admitted repository, `contents:read` and `metadata:read` |
| Requests                 | Fixed GitHub discovery and upload-pack routes                  |

The constructor's literal `protocolVersion: 3` explicitly selects the successor.
The protected native profile uses its existing literal `protocol_version: 3`.
Metadata V2 has a different selection and cannot authorize a V3 Git session.
These are existing component contracts, not a new Agent configuration schema.
The [repository access modes proposal](../../specs/20-repository-access-modes.md)
remains implementation direction; its proposed mode selection is not a supported
product setting.

Discovery is an empty-body request to the exact repository's
`info/refs?service=git-upload-pack`. Upload-pack uses that repository's exact
`git-upload-pack` endpoint. The original request, Work, session, repository and
credential release remain bound throughout each exchange. Each HTTP exchange
has one credential use; later fetch rounds cannot extend the original Work
horizon. Missing authority, identity, custody or currentness must refuse.

Publication is disabled for this verification scope. A write rejection counts
only when the actual component rejects it and the fixture records whether a
broker or provider submission occurred. Merely disabling a test origin's write
service does not establish that the product transport rejected a write.

## Evidence levels

| Level                       | Required observation                                                                                                                        | What it establishes                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Fixture validation          | Real Git client exchanges with the controlled smart-HTTP origin and expected repository contents                                            | The fixture serves the intended Git behavior.                                           |
| Component contract          | Actual component invoked through its maintained interface; every substituted dependency named                                               | That component's behavior under the supplied dependency outcomes.                       |
| Controlled composition      | Real Git clone/fetch through the actual selected read transport, with the exercised broker/native boundaries identified                     | Compatibility and composed behavior for those exact clients, artifacts and substitutes. |
| Internal read flow          | Genuine selected execution, original Work/admission, authenticated native connection, current authority and custody in the installed caller | The selected deployed internal path, subject to its recorded environment and cases.     |
| Live provider qualification | Separately selected real GitHub repository, real scoped token lifecycle and upstream outcomes                                               | The specific provider behaviors actually observed.                                      |

A local private Git origin is a real Git server fixture. It is not a real internal
OCE execution or a live GitHub origin. Interface-faithful internal mocks are
useful for component acceptance; they do not establish the availability or
correctness of the corresponding production owners. Fixture certificates,
synthetic token bytes and in-memory State must be labeled wherever used.

## Focused READ checks

Run exact files from the repository root after the selected source and required
artifacts have been prepared. Keep test selectors scoped to the selected process;
follow the [testing guide](../testing.md#run-tests) for environment selection.
Do not install or reconcile dependencies as a side effect of verification.

The inventory below describes each suite's target and input boundary. The
entrypoints remain subject to each fixture's actual selectors and prepared
artifacts; an entrypoint alone does not select every case. Observed receiving
results are recorded separately below.

| Check                    | Actual component or client intended for verification                          | Controlled inputs and evidence limit                                                                                                                                                                                                                                 | Suite entrypoint                                                                       |
| ------------------------ | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| READ-01: local origin    | Real Git client and Git smart-HTTP backend                                    | Canonical disposable origin in `tests/fixtures/github-read-mvp/external-service.mjs`, used through the READ adapter in `tests/fixtures/read-mvp/git-origin.mjs` with distinct lifecycle tests; proves the origin fixture only. Record exact Git and helper binaries. | `node --test tests/integration/read-mvp-git-origin.test.mjs`                           |
| READ-02: broker          | Actual V3 `GitHubMediationService` and closed wire/digest contracts           | Explicit transport and original-operation dependency substitutes in `tests/fixtures/read-mvp/broker-peers.mjs`; identify supplied preparation, release and currentness outcomes. No production owner acceptance follows from a mock allow.                           | `node --test tests/integration/read-mvp-broker.test.mjs`                               |
| READ-03: native identity | Actual native child, controller identity/session boundary and V2/V3 selection | External Workload API/certificate fixture and any operation-port substitutes in `tests/fixtures/read-mvp/native-session.mjs`; prepared native and fixture binaries are required. Separate native transport evidence from Work/State/custody acceptance.              | `node --test --test-concurrency=1 tests/integration/read-mvp-native-identity.test.mjs` |
| READ-04: clone/fetch     | Real Git and actual maintained selected read transport                        | Composition in `tests/fixtures/read-mvp/compose-read-path.mjs`; record the exact native transport artifact and which broker, identity, authority and custody links are real or substituted. Missing selected composition inputs remain explicit.                     | `node --test --test-concurrency=1 tests/integration/read-mvp-clone-fetch.test.mjs`     |
| READ-05: configuration   | Actual selected component parsers and read-only boundaries                    | Controlled configuration in `tests/fixtures/read-mvp/configuration.mjs`; prove rejection and selection through maintained parsers. A test fixture configuration is not a new product schema.                                                                         | `node --test tests/integration/read-mvp-supported-configuration.test.mjs`              |

Before selecting a binary-dependent file, inspect its fixture's actual selector
contract. Record every executable's version and content digest, its build source,
and whether it is a production executable or a test-only fixture. A missing
artifact is a verification gap; a skipped or unselected case is not a pass.
Do not infer READ suite selectors from adjacent suites.

The existing [native identity verification](github-mediation-identity.md#scope-and-verification)
documents the native executable and external Workload API fixture used by that
component. The existing [native client mechanics](native-git-client-mechanics.md#verification-and-remaining-qualification)
documents the prepared Git/gh manifest for its own selected qualification suite.
Those requirements remain scoped to the files that actually consume them.

## Recorded receiving results

The selected receiving cases passed with no failures or cancellations. Counts
retain their original suite and selection boundaries:

| Check   | Result at the receiving checkpoint                                    | Evidence scope                                                                                                        |
| ------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| READ-01 | **6 passed**, none skipped                                            | Actual controlled Git-origin lifecycle through the canonical external fixture and READ adapter.                       |
| READ-02 | **43 test nodes passed**: 10 top-level and 33 nested; none skipped    | Actual broker with contract peers and supplied operation-owner outcomes.                                              |
| READ-03 | **4 passed**, none skipped                                            | Actual native identity sessions with a refusing consumer; no positive original repository-use admission.              |
| READ-04 | **7 passed; 3 explicitly unselected**                                 | Seven client/transport contract cases. The three opt-ins below were reported skipped and supply no acceptance credit. |
| READ-05 | **8 component cases and 3 native parser groups passed**, none skipped | Selected configuration parsers and native profile validation; separate component and native selections.               |

The three READ-04 opt-ins remain unexecuted: **two actual external-Git fixture
cases for cancellation/failure**, and **one clone/fetch case through genuine
accepting composition**. The seven contract passes do not establish those
external-Git observations or successful clone/fetch through the internal accepting
path. Select each remaining case through its maintained fixture contract when
its required inputs are ready; do not substitute contract-case counts for it.

These are scoped fixture/component receiving results. A real controlled Git
origin is an external-service fixture, and a refusing native consumer does not
supply positive internal admission. The recorded cases do not establish the full
internal flow, S2 acceptance, live Codex execution, live GitHub qualification or
publication readiness. This documentation update records existing results and
adds no test execution.

## Accepting a result

For each executed file, retain a bounded receipt containing:

- Exact source commit or content digests, selected test files and command.
- Tool and binary versions/digests, selected test flags and relevant nonsecret
  limits; no credentials, private filesystem paths or actor identifiers in a
  public report.
- Actual component path and every mock, fixture, in-memory backend or external
  provider substitute on that path.
- Exit status, passed/failed/skipped counts, and the observed assertions that
  support each claim. A source review or successful import is not test execution.
- Any missing prerequisites, cleanup failure, unsupported case or remaining
  composition gap.

For clone/fetch, require observable repository results: clone the first revision,
update the owned origin, fetch the later revision, and verify the expected
revision and file contents. Record denial observations for unsupported or write
requests, credential handling and cancellation/currentness only to the extent
that the actual selected test exercises them. Keep broker component, native
session and composed-client results separate even if they run in one batch.

A successful local composition with substituted authority can establish its
bounded local acceptance. Claiming a supported installed internal READ path
also requires the genuine admission and original-operation caller, selected
identity/currentness, credential custody and deployment enforcement on that same
path. Preserve the component results while that composed acceptance is pending.

## Current limits and evidence status

This profile supports bounded protocol-v2 full SHA-1 clone/fetch mechanics.
It rejects receive-pack/publication, shallow or deepen requests, partial-clone
filters, server options, alternate pack/bundle locations and unsupported commands.
LFS, submodule repository requests, alternate hosts, redirects, GraphQL and
general `gh api` are outside this selected READ profile. Git history can enter
the authorized checkout; this is not history isolation.

The native transport acquires upload-pack bodies before admission, with compressed
and decoded input each bounded to 4 MiB, and buffers each response to a configured
limit no greater than 64 MiB. Pack object, reconstruction and delta bounds also
apply. See the [native transport reference](native-github-egress.md#broker-backed-git-clone-and-fetch)
for the exact limits. A successful small fixture does not qualify arbitrary
repository sizes or other Git features.

Historical verification remains separate from the receiving results above:

- Rust **60/60** is reusable for the exact **118 unchanged inputs**; do not repeat
  it solely for these READ additions.
- Broker **29/29** remains historical. Select the targeted changed type/composition
  check; repeating the historical suite is not a prerequisite for source landing.
- Native **23/23** includes **seven predecessor cases**. Later identity/test changes
  and the module addition still require current **bridge/CLI race checks** and
  **14 maintained native integration cases**.

These historical counts are not current READ regression results and cannot be
added together as composed acceptance.
The separate **468-case CNI** result provides no Git bridge regression credit.

Live GitHub token issuance, expiry/revocation and upstream permission boundaries;
PostgreSQL durability; installed Kubernetes/gVisor routing and bypass denial;
real execution attachment replacement; and production publication remain outside
the evidence recorded here unless independently selected and executed. This
receiving checkpoint does not establish production readiness.

## Later qualification preparation

The following slots prepare later scenarios in the existing harness. Every slot
is **UNRUN**. This register does not enable publication in the selected READ
profile or change the receiving results above. Preparation is complete when the
selected inputs are identified or explicitly left **UNBOUND**; executing a slot
requires binding its actual inputs first.

The recorded source checkpoint above identifies the existing READ test paths.
For each later run, bind its selected source commit or content hashes, executable
and image identities, configuration, resources and deadlines in the bounded
receipt described under [accepting a result](#accepting-a-result). **UNBOUND**
means this preparation has not selected an exact input, resource or callable;
it does not mean that its implementation is absent. Component roles below retain
cleanup ownership. A timeout or an abort request alone is not physical settlement.

### Read and genuine fullflow

- **Source and inputs:** reuse `tests/fixtures/read-mvp/compose-read-path.mjs`
  and `tests/integration/read-mvp-clone-fetch.test.mjs`. The selected composition
  module, Git/helper artifact identities and genuine original admission,
  `GitHubMediationService`, Work/State, inventory/custody and native receiver
  inputs are **UNBOUND**. The native transport retains its existing
  `Mediator::serve(socket, attachment_ref)` boundary.
- **Entrypoint:** `node --test --test-concurrency=1 tests/integration/read-mvp-clone-fetch.test.mjs`.
  The two external-Git fixture cases use `OCC_READ_MVP_CLIENT_FIXTURE=1`.
  The accepting case selects `OCC_READ_MVP_ENDPOINT_FACTORY`, whose module must
  export `createReadClientComposition`; that exact module and its inputs remain
  **UNBOUND**. These are test selectors, not Agent configuration settings.
  Both selections also require `OCC_READ_MVP_CLIENT_TOOLS` to name an absolute
  prepared-tools manifest; that exact manifest path and its artifact identities
  remain **UNBOUND**.
- **Resources and bounds:** prepared Git and HTTP helpers, owned checkout and
  scratch, the canonical external origin and selected native connections.
  Exact resource instances, artifact manifests and scenario deadlines are
  **UNBOUND**; retain the selected components' finite limits.
- **Observables:** exact clone/fetch revision and file contents, original
  repository/request binding, denied unsupported requests, cancellation outcome
  and retained-work settlement. Keep direct fixture Git success separate from
  successful Git through genuine accepting composition.
- **Cleanup owner and substitution:** the client harness owns its client process
  and checkout; the origin fixture owns its server and scratch; original native,
  broker and custody owners retain their connections, effects and borrowed leases
  until actual settlement. The canonical external-service fixture substitutes
  GitHub. Genuine fullflow must use the original internal participants.

### Approval and denial

- **Source and inputs:** the existing `RepositoryPublicationOwnerV1` and
  `tests/conformance/repository-publication-http.test.mjs`. Exact selected source,
  authenticated principal/call, immutable candidate/base/ref and original
  Work/State/custody/receiver inputs are **UNBOUND**. The original publication
  HTTP owner supplies the genuine composed approval/denial entrypoint, also
  **UNBOUND** here.
- **Entrypoint:** the maintained local component entry is
  `node --experimental-strip-types --test tests/conformance/repository-publication-http.test.mjs`
  after its coherent inputs are selected. This does not select positive composed
  publication; the READ profile must continue to refuse publication.
- **Resources and bounds:** owned candidate repository, selected State/test
  resources, external provider peer and operation deadlines are **UNBOUND**.
  Bind the original component limits without widening them for the scenario.
- **Observables:** actual authorized/unauthorized decisions, immutable approved
  OID = submitted OID = observed OID, exact expected-old ref comparison, and
  distinct push/PR outcomes where later publication is selected. Preserve
  complete, refused and unknown results without replaying unknown effects.
- **Cleanup owner and substitution:** the publication owner retains candidate
  and effect responsibility; original custody/native owners settle credential
  use and receiver work; the fixture owner cleans its repository/provider peer.
  External GitHub may be controlled for component/composed scenarios. Genuine
  approval, authority, State commit and internal effect ownership are not supplied
  by a fixture success.

### Outage and unknown effect

- **Source and inputs:** reuse the broker's `handle`, `close`, `join` and `stop`
  interfaces and original native session/custody lifecycle. Exact selected
  source, fault phase, original request/effect and currentness inputs are
  **UNBOUND**. The original lifecycle owner supplies the scenario entrypoint;
  no additional executable command is selected here.
- **Resources and bounds:** retained requests, connections and effects plus
  controlled external fault peers. Exact resource instances, outage control,
  operation horizon and bounded observation deadline are **UNBOUND**.
- **Observables:** denial of new dispatch when current authority is unavailable,
  no cached allow, no blind retry after possible submission, truthful unknown or
  observed outcome, and separately observed native/provider settlement.
- **Cleanup owner and substitution:** original broker/native/custody owners retain
  pending calls, borrowed leases and effects until their actual settlement;
  the external fixture owner stops its peers. Declare external loss/delay
  simulation. Genuine internal currentness or retirement observations cannot be
  replaced with a successful test callback.

### Fresh Pod and retirement

- **Source and inputs:** selected immutable runtime image/profile, original
  Compute/Sandbox creation and retirement callables, and original execution,
  identity/enrollment and route/fence inputs are **UNBOUND**. Bind the actual
  installed scenario entrypoint from the original runtime qualification owner;
  no installed command is selected by this register.
- **Resources and bounds:** explicitly owned disposable Pod/sandbox, namespace,
  retained workspace and network/identity resources. Exact instances, authorities,
  resource budgets and retirement/observation deadlines are **UNBOUND**.
- **Observables:** distinct old/new Pod and execution identities, denial of new
  authority to the old process, intended retained workspace behavior, actual
  route isolation and physical termination or explicitly retained stop
  responsibility. A sibling container or timeout is not a fresh-Pod/stop proof.
- **Cleanup owner and substitution:** the original Compute/Sandbox lifecycle
  owner retains teardown and retirement responsibility; identity and route owners
  settle their owned registrations/openings. A declared external GitHub simulator
  is permitted for selected-runtime composition. Installed identity, containment
  and physical termination require actual observations.

### Later live provider and model

- **Source and inputs:** exact selected read/runtime source and images, authorized
  repository/App or model configuration, credential references and original
  identity/current authority are **UNBOUND**. The original provider and runtime
  qualification owners supply their existing live entrypoints/selectors; those
  exact callables are **UNBOUND** here, not invented shell commands.
- **Resources and bounds:** an explicitly authorized provider repository or model
  session, owned runtime and scoped test artifacts. Exact resource identities,
  request/spend budgets, deadlines and cleanup targets are **UNBOUND**. Keep
  credentials out of commands, public receipts and retained output.
- **Observables:** for live read, actual clone/fetch OIDs, permitted scope,
  credential absence and local disable versus confirmed revoke or unknown/expiry;
  for live model execution, actual authenticated runtime/model outcomes. Record
  each boundary independently; neither implies live publication acceptance.
- **Cleanup owner and substitution:** original provider/custody owners retain
  token/effect responsibility and provider cleanup; the runtime owner retains
  session termination and workload cleanup. The boundary being qualified as live
  cannot use a simulator. Declare any other controlled external peers, and keep
  any unselected live boundary **UNRUN**.
