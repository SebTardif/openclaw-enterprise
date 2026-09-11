# SPIRE first observation fixture

This test-only fixture observes real SPIRE X.509 identity delivery inside two
gVisor workloads. It combines a receiver-side SPIRE denial record, independent
node observations, and a complete delivered identity set from the Go Workload
API client. Both A and B Pods are created first and coexist in the separately
prepared disposable environment. Only their identity-observer phases run
serially.

| Question                   | Required observation                                                                                                            | Evidence limit                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| H0: actual delivery path   | SPIRE's `No identity issued` record and the client's actual `PermissionDenied`, followed by delivery on the retained connection | The receiver PID comes from SPIRE; accepted socket UID, GID and start identity remain unobserved.                              |
| H1: caller to sandbox      | Protected node reads map that receiver PID to the selected Pod UID and gVisor sandbox before and after delivery                 | The host peer may be a runtime process. The correlation does not establish an inner workload PID or a native SPIRE request ID. |
| H2: intended identity sets | A and B each receive exactly their distinct intended singleton, inspecting every entry before SDK selection                     | This is the complete delivered response under the selected registrations, not enumeration of the Agent's authorization cache.  |

The fixture uses genuine SPIRE registrations and issuance. The observer does
not issue credentials or replace Workload API authentication. It executes no
native Codex model turn and does not establish current runtime authority,
production consumer behavior, or completion of broader identity qualification.

## Ownership and preparation

The external preparation owner supplies and settles the disposable cluster,
runtime installation, immutable images, management resources, SPIRE Server and
Agent, protected receiver collector, and their evidence. The real test owns
only its A/B Pods, genuine workload registrations, and observer/helper child
processes. The test does not create a cluster, build images, select a default
kubeconfig, discover a provider credential, or replace management preparation.

Preparation must bind fresh names, an explicit loopback Kubernetes API and
kubeconfig, actual tool and artifact hashes, immutable image digests, a finite
deadline, and protected evidence storage. It must verify effective gVisor
systrap/STRICT execution with `--host-uds=open` and `--network=none`, node
attestation, the initial registration inventory, and enforcing routes before
delivery can qualify. The exact required flags are `--platform=systrap`,
`--sidecar-usage-policy=STRICT`, `--host-uds=open` and `--network=none`.
Unsupported UDS access or this networking configuration fails qualification;
there is no alternate runtime or networking fallback.

The observation consumer accepts SPIRE's `k8s_psat` node-attestation selector
type and the `k8s` workload selector type authored by the registration builder.
Selector values remain bounded and duplicate-free; registration readback must
match the exact expected selector set, including selector types.

[profile.mjs](profile.mjs) validates the explicit profile and exports builders
for management manifests, SPIRE configuration, workload Pods and genuine
registration plans. These builders produce objects and configuration; calling
them does not provision or verify an environment. The preparation owner must
also supply the trusted Server bundle, kubelet CA, socket directory, runtime
configuration and effective endpoint addresses.

Server startup has a distinct preparation schema: `validateServerBootstrap`
and `buildServerBootstrap` admit only inputs available before the fresh Server
address and bundle exist. This stage is not a valid live-test profile.
`assertServerBootstrapMatches` checks configuration and resource continuity
against the completed profile without extending the deadline. Preparation
still verifies the actual Server identity and immutable bytes; placeholder
addresses or hashes do not substitute for those observations.

Observed Kubernetes resources are compared with the authored manifests after
two explicit JSON serialization equivalences. For `v1/Pod`, omitted
`hostNetwork`, `hostPID` and `hostIPC` match only explicitly authored `false`:
these are value booleans with `omitempty` in the Kubernetes API. Required
`true` remains required, including the management Agent's host PID setting.
Pointer booleans such as `shareProcessNamespace`, `enableServiceLinks` and
`automountServiceAccountToken` retain explicit false values and must remain
present. Nested container security settings receive no omission normalization.

For `networking.k8s.io/v1/NetworkPolicy`, an omitted ingress or egress list
matches only the corresponding explicitly empty authored list, with exact
explicit `policyTypes: [Ingress, Egress]`. The entire policy spec remains exact,
including its selector, nonempty rules and ports. The comparison rejects added
rules, changed selectors, null values and missing nonempty lists. These rules
apply to actual management, prepared-access and workload checks; they do not
change manifest builders, declared bootstrap continuity, Pod security checks
or the required live evidence.

The management profile selects a host-PID Agent outside the workloads, UID/GID
0 with all capabilities dropped, a read-only root, and bounded writable data.
It separates the projected PSAT token from the kubelet-audience token. Agent
kubelet access is `get nodes/pods` restricted to the selected node; Server
PSAT access is TokenReview creation and reads of the selected node and Agent
Pod. Workloads have no ServiceAccount tokens. Default-deny policies admit the
explicit management routes. Effective proc access, kubelet authorization,
certificate validation and policy enforcement still require live verification;
a failure requires an explicit reviewed profile change.

Management and workload containers explicitly select `privileged: false` and
the default proc mount. Actual Pod admission must reject unsafe additional
fields; matching selected manifest fields alone is insufficient. Configured
RBAC checks cover the expected grants. They do not establish the absence of
other grants to the same ServiceAccounts or their groups, so full effective
RBAC qualification remains separate work.

Kubernetes NetworkPolicy alone does not establish isolation from a Pod's own
node. This fixture additionally requires the selected gVisor network-none
configuration. The real test checks that guest interfaces are loopback-only
and that the three fixed, operator-owned kubelet, Kubernetes API and SPIRE
Server endpoints produce an admitted unreachable result without sending
application bytes. Timeout or connection refusal is insufficient. These
effective runtime and guest-network checks remain unrun until the live test
executes in an allocated environment.

The [Dockerfile](Dockerfile) has `observer`, `management`, and optional
`observer-native` targets. It requires a digest-qualified `NODE_BASE` and a
separately prepared build context containing the hash-bound `observer`,
`spire-agent`, `spire-server`, `receiver-collector.mjs`, and optional `native`
files required by the selected target. It performs no downloads, installations
or compilation. The optional native artifact remains unused by this test.

## Select the real test

Prepare a JSON profile conforming to `validateProfile` in
[profile.mjs](profile.mjs), then bind its exact bytes with SHA-256. Its required
top-level fields are:

| Field                           | Contents                                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`, `sourceCommit` | Schema version and selected source revision.                                                                                                                     |
| `artifacts`                     | Immutable base/fixture image references, observer/SPIRE/runtime/tool hashes, SPIRE source commit and runtime release/member inventory.                           |
| `cluster`                       | Exact cluster, context, node, endpoint addresses, kubeconfig path/hash and absolute tool paths.                                                                  |
| `paths`                         | Evidence directory, selected socket directory/path and fixed in-image executable/admin-socket paths.                                                             |
| `management`                    | Exact management Pods, containers, ServiceAccounts, endpoints, trust domain, cluster identifier, token audience, trusted ConfigMaps and public bundle/CA hashes. |
| `runtime`                       | Selected RuntimeClass, handler and required runtime flags.                                                                                                       |
| `workloads`                     | Namespace and distinct A/B Pod names, container names and SPIFFE IDs.                                                                                            |
| `deadlineEpochMs`               | Absolute deadline in milliseconds, no more than 30 minutes after validation.                                                                                     |

The validator requires the complete schema and rejects extra fields. Keep the
profile in protected operator storage; the repository contains no usable
environment-specific profile or credentials. The test establishes the actual
filesystem owner with a fresh protected-file ownership probe in the profile's
parent directory and requires the probe to settle. A mapped process UID is
not itself proof of the filesystem principal, and running as root does not
bypass the ownership requirement. Profile and kubeconfig files must be
canonical regular files with mode `0600`, one link and at most 16 KiB, inside
mode `0700` directories owned by the observed filesystem principal. The new
evidence directory must have an existing mode `0700` parent with that owner.

The profile also requires `cluster.dockerConfigDirectory` and
`cluster.dockerConfigSHA256`. The operator prepares a fresh canonical directory
with mode `0700`, owned by the same observed filesystem principal. Its parent
must also be canonical, mode `0700`, and owned by that principal; validation
checks the parent before and after reading the selected configuration, before
each Docker invocation. Paths containing a literal `.docker` component are
rejected. The directory contains exactly one
regular, single-link file, `config.json`, with that owner, mode
`0600`, and the exact UTF-8 bytes `{}\n` (an empty object followed by a newline).
The SHA-256 binds those file bytes. Every Docker invocation explicitly supplies
`--config DIRECTORY` before the fixed `--host` argument, including calls from
the node observer with its restricted environment. There is no home-directory
or environment fallback, and this operator configuration is not injected into
fixture images.
Unsettled validation descriptors or ownership-probe cleanup retain local-resource
custody even when unrelated helpers have settled.

The preparation owner finalizes
`management.trustBundleSHA256` after fresh Server startup and binds the kubelet
CA with `management.kubeletCASHA256`. The real test verifies the exact public
ConfigMap bytes and their immutability. From the repository root, select the
allocated environment explicitly:

```sh
OCC_TEST_SPIRE_FIRST_OBSERVATION_REAL=1 \
OCC_SPIRE_FIRST_OBSERVATION_PROFILE=/absolute/operator/profile.json \
OCC_SPIRE_FIRST_OBSERVATION_PROFILE_SHA256='<sha256-of-exact-profile-bytes>' \
node --test --test-concurrency=1 tests/integration/gvisor-spire-first-observation-real.test.mjs
```

Opt-in selects a real integration with required prepared dependencies. Missing,
expired, mismatched or unsupported inputs do not provide delivery evidence.
The default test run leaves live coverage explicitly unexecuted. Preparing or
validating a profile does not authorize environment effects.

## Observation sequence and records

After creating both Pods, the test runs A's Go observer first. It requests
identity with no matching registration.
The test requires an actual `PermissionDenied`, one corresponding protected
receiver record, and independent mapping of that receiver process. It creates
and reads back A's genuine SPIRE registration, with the actual attested Agent
parent, exact Pod UID/container selectors and an empty hint. The observer then
fetches its full response on the same underlying connection. B repeats this
sequence while A's registration remains present, providing a narrow
unregistered-wrong-caller control. A's Pod remains present throughout B's
observation; serial observation does not mean serial Pod existence.

The observer accepts `--socket-path` and `--expected-id`. Its successful JSON
record sequence is `denied` → `delivered` → `closed`. After `denied`, the
controller sends exactly `continue\n` and closes standard input: both the
newline and EOF are required. Extra input, premature EOF, timeout, another dial
or an unexpected RPC/connection event rejects the observation. Do not run the
observer with an immediately piped control command as a substitute for the
protected mapping and registration sequence.

Each observer has a 120-second lifetime, 10-second fetch limits and a 60-second
control gate. The response limit is 4 MiB, with at most four identity entries,
four bundles and 16 authorities per bundle. Malformed entries, duplicate IDs,
nonempty hints and overflow fail the whole observation. `delivered` records
retain identity IDs, public certificate digests/validity, bundle metadata and
connection/RPC counts. The one-response SDK API locally cancels its streaming
RPC after receiving the response; the recorded `Canceled` stream ending is
distinct from successful delivery. `closed` and actual child exit are both
needed for settlement.

The real test also validates the original positive workload
`activeDeadlineSeconds` and Agent lifetime against original creation and actual
start timestamps and the fixed profile deadline. The comparison permits at
most five seconds of timestamp/start tolerance. Validation does not grant a
fresh duration or extend the profile deadline.

[receiver-collector.mjs](receiver-collector.mjs) is the actual Agent parent,
outside both workloads. It captures stdout/stderr through private pipes and
projects only the selected ERROR/JSON denial event and allowed selectors.
Raw Agent logs must not be teed, inherited into container logging, or retained
in files. Limits are 16 KiB per frame, 1 MiB total input, 128 frames, 32 retained
records and 64 KiB retained output. Unknown event content is discarded;
malformed selected events, duplicate denials and overflow invalidate evidence.

Receiver fields `acceptedSocketUID`, `acceptedSocketGID` and
`acceptedSocketStartIdentity` remain `null`. Attestor UID/GID values carry
`spire-workload-attestor` provenance. [node-observer.mjs](node-observer.mjs)
separately reads process start ticks, namespace, executable digest, effective
IDs and Pod/CRI ownership with `protected-node-read` provenance. It runs only
in the protected operator environment and is excluded from workload images.
Node metadata alone is not authenticated SPIRE evidence. Missing or ambiguous
mapping, PID reuse, a shared peer across A/B, or reconnect prevents qualification.

No private keys, certificate bodies, JWTs, bearer tokens, raw response objects,
arbitrary provider errors or complete process arguments belong in retained
records. Credentials still exist in the normal SDK process memory lifetime;
the fixture makes no deterministic memory-zeroization guarantee.

## Verification and remaining coverage

Focused source checks are:

```sh
go -C components/runtime-security test ./testfixtures/spire-first-observation
node --test tests/integration/spire-first-observation-collectors.test.mjs
```

The observer builds from the existing Go module without additional
dependencies. An offline build requires the already verified module cache:

```sh
GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local CGO_ENABLED=0 \
go -C components/runtime-security build -trimpath \
  -o ./bin/spire-first-observation ./testfixtures/spire-first-observation
```

Unit checks exercise parser rejection, bounds, response projection, connection
accounting and owned-child settlement. Synthetic records and local test
children establish only those mechanisms. Unit-check and offline-build results
must be reported separately from the explicitly unrun live integration until
an actual allocated environment produces receipts.

When a fixture child fails, `observation-failed` includes a bounded
`childDiagnostic` when available. It identifies the source-authored operation
and child ordinal, byte counts for stdout/stderr and any incomplete record,
parsed-record count, and observed exit/stream-close/process-group state. It
contains no raw output, command arguments, environment or credentials. Any
stderr or incomplete interactive record still fails the observation; the
diagnostic distinguishes those causes without relaxing the output contract.
A missing diagnostic does not replace the original failure or imply settlement.
These process diagnostics do not establish Workload API contact or identity.

Every exit path after an effect requires settlement of owned streams, sockets,
children, Pods and registrations. The preparation owner separately settles
management and cluster resources. A timeout, attempted deletion or absent
receipt does not prove reclamation; unknown remaining state retains ownership.
For node-observer helpers, direct child close must also be followed by an
actual `ESRCH` observation for the captured process group before settlement
is recorded. An existing or unknown group retains custody.

Renewal, expiry/loss, bootstrap or replacement replay, new-Pod replacement,
same-Pod restart, retired-credential acceptance and actual production
consumer/adapter decisions remain separate coverage. A passing first
observation does not close those gaps.
