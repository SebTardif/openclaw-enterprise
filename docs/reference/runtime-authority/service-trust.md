# Operator-admitted runtime service trust

Part of the [Runtime authority interfaces](../runtime-authority.md) reference.

## Operator-admitted service trust

`RuntimeServiceTrustService` owns one append-only registry in the existing OCC
store. `runtimeAuthoritySources` in the Installation configuration contains
protected technical source descriptions; loading this file admits no service.
A current human session, resolved human Principal and selected IAM `administer`
permission on the exact Installation are required for both management routes:

| Route                                                    | Result                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `POST /v1/runtime-service-trust/operations`              | Admit or withdraw one exact source or service subject with its expected version. |
| `GET /v1/runtime-service-trust/operations/:operationRef` | Recover the original operator's exact retained operation.                        |

Service API keys cannot use these routes, including keys whose IAM role otherwise
permits Installation administration. Requests use the existing session and browser
intent protections. Bodies never select an Installation, actor, role, socket,
executable, roots, verifier or transport limits. Every newly committed record
has a matching durable mutation audit with the original human identity and actual
selected IAM decision. A failed admission poisons its enclosing unit even if its
caller catches the error.

The four request kinds are `source-admit`, `source-withdraw`, `service-admit` and
`service-withdraw`. Each supplies `schemaVersion: 1`, a preknown UUID
`operationRef`, and `expectedVersion`. First admissions use `null`; subsequent
changes use the exact current version. Source requests name a configured
`sourceRef`. A first service admission also supplies `serviceIdentityRef: null`,
exact `namespaceId` and `agentId`, and the intended `peerSPIFFEId`. The server
allocates the service identity and immutable profile references. Re-admission
names the existing service identity and advances its retained version.

Both admitted profiles permit only `lifecycle-authority` within one exact Agent.
The original request shape selects `read-operation-only-v1`, paired with
`owned-child-stdio-readback-v1`. It still permits only exact original-service
`readOperation`. Its retained bytes and request shape remain unchanged.

A service admission with the explicit field
`operationPolicy: "initial-harness-bind-v1"` requires the protected source
`transportProfileRef: "owned-child-stdio-initial-harness-bind-v1"`. This separately
versioned profile permits an initial Harness `bind` with provider
`occ/kubernetes-gvisor` and `expectedBindingVersion: null`, plus independently
authorized original-service `readOperation`. A source file alone cannot select
that privilege; the current human administrator must admit it. Crossed profile
pairs, omitted bind-policy selection, arbitrary policies, broader roles and
installation-wide scopes deny. Evidence writes, retirement, purpose resolution,
gateway binding and replacement binding are outside both profiles.

Native dispatch and the actual service each enforce this operation ceiling.
The initial bind reaches the service with its original request custody, but
returns `rejected-before-effect` / `lookup-unavailable` while current preparation,
approved workload profiles and protected Compute observations remain absent.
Neither profile creates an IAM Principal, enrolls a workload, grants successful
runtime binding or permits serving, restoration, model or credential use.
The real native validator checks the resolved source/profile syntax before
service admission; the later real TLS handshake proves peer possession. Full
transport configuration and executable custody are described in
[Runtime service transport](../runtime-service-transport.md).

New operator results return `{result: "applied", record}`; exact retries return
`{result: "exact-replay", record}` inside the normal `data`/`meta` HTTP envelope.
The exact canonical operator request and original actor are checked before new
identity generation or source resolution. A retry of an old admission therefore
retains its original result after withdrawal or source replacement and cannot
reactivate the current subject. A lost database COMMIT acknowledgement returns
`{result: "commit-unknown", operationRef, nextAction: "exact-readback-only"}`.
Use the exact recovery GET and retain that locator; never replace it with a new
operation ID to guess whether the write committed.

Current reads use fresh transactions with no positive cache. The service record
must still be its subject's latest admission; its exact referenced source
admission must also remain current and match the loaded deployment configuration.
Source replacement invalidates all bindings to the prior source admission, even
when an old configuration's bytes later reappear. Withdrawal, missing state,
corruption, an unavailable database or a mismatched loaded source denies new use.
A controller restart constructs new child/context incarnations from fresh state;
retained receipts and startup files cannot restore a prior live context.
The private current-reader result carries the original configuration and its
registry-backed operation policy separately; the closed runtime trust DTO is
unchanged. These current reads do not serialize a future successful bind with
withdrawal: that acceptor still requires all current predicates in the owning
transaction under shared lock ordering.

Bounded reads require a PostgreSQL pool with a positive connection timeout no
larger than 250 ms and ordinary non-pipelined clients without asynchronous
connection hooks. Registry-enabled controller composition requires at least two
pool connections for current IAM reads during an operator transaction. The
PostgreSQL 18 read path sets server timeouts from the remaining request budget,
checks client disconnection, destroys cancelled clients and joins issued queries.
An interrupted pool checkout is drained before completion; cleanup may take up
to its 250 ms checkout limit after the public response deadline. Native request
ownership separately joins the service's actual pending history reads and its
current-registry reads before accepting a replacement request or finishing close.
It never waits indefinitely for an arbitrary external inspector to honor abort.
These bounds are tested local behavior, not deployment-qualified latency claims.

The application role can select and insert registry history; it cannot update or
delete records. Database constraints preserve exact owner/source/profile/version,
canonical request and human audit attribution. This uses the existing trusted
controller database role, which already writes IAM and audit records; it does not
isolate code that has obtained that role's credential. Native children and TLS
peers receive no database credential or registry writer.

Run the dedicated `runtime-service-trust` memory, API and PostgreSQL suites with
the actual native validator selected by `OCC_RUNTIME_AUTHORITY_TEST_BINARY`.
The PostgreSQL cases additionally use `OCC_RUNTIME_SERVICE_TRUST_DATABASE_URL`
for the limited role and `OCC_RUNTIME_SERVICE_TRUST_MIGRATOR_DATABASE_URL` for
reversible lock/constraint verification in the same disposable database. The
native accepting-path suite exercises actual local certificates and Workload API
fixtures; it does not establish production SPIRE enrollment or guest identity.
