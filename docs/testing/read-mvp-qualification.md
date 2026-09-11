# Later READ qualification scenarios

Prepare the five later READ qualification scenarios using the inputs, observations and cleanup ownership below. Every slot remains **UNRUN** and unselected inputs remain **UNBOUND**. The [READ MVP verification reference](../reference/read-mvp-verification.md) owns the selected read contract, evidence levels and recorded receiving results.

## Later qualification preparation

The following slots prepare later scenarios in the existing harness. Every slot
is **UNRUN**. This register does not enable publication in the selected READ
profile or change the [recorded receiving results](../reference/read-mvp-verification.md#recorded-receiving-results). Preparation is complete when the
selected inputs are identified or explicitly left **UNBOUND**; executing a slot
requires binding its actual inputs first.

The [recorded source checkpoint](../reference/read-mvp-verification.md) identifies the existing READ test paths.
For each later run, bind its selected source commit or content hashes, executable
and image identities, configuration, resources and deadlines in the bounded
receipt described under [accepting a result](../reference/read-mvp-verification.md#accepting-a-result). **UNBOUND**
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
