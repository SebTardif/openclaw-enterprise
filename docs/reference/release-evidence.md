# Release evidence harness

The release evidence harness registers required behavior, collects bounded
structured observations and checks an immutable result bundle. It gives missing,
failed and uncertain evidence an explicit place in the report. It does not run
product fixtures, authorize a release, authenticate an executor or publish files.

This implementation is a scaffold with synthetic adapter tests. Every component
fixture is registered as `to-build`, and release-input, fixture-assertion and
security-event adapters remain `pending`. A valid imported `pass` is an unverified
claim. Even a result labelled `live` cannot establish release acceptance. Real
runtime, identity, channel, model, repository and installation acceptance require
separate component execution and review on frozen inputs.

## Reference chapters

- [Release evidence records and collection](release-evidence/records-and-collection.md): versioned records, collector bounds, reruns, retention and producer gaps.

## Commands

Run from the repository root with Node.js 24 or newer. No dependencies or package
installation are required:

```sh
node scripts/release-evidence/cli.mjs registry
node scripts/release-evidence/cli.mjs report inputs.json
node --test tests/integration/release-evidence.test.mjs
```

`registry` prints the complete deterministic `release-registry/v2` registry.
`report inputs.json` prints fresh coverage with all **16 gates and 19 required
cases unrun**, plus one separately reported optional provider case. Adding result
bundle directories consumes their observations without executing their recorded
commands:

```sh
node scripts/release-evidence/cli.mjs collect request.json
node scripts/release-evidence/cli.mjs validate /absolute/path/to/bundle inputs.json
node scripts/release-evidence/cli.mjs report inputs.json /absolute/path/to/first-bundle /absolute/path/to/rerun-bundle
```

Collection takes a private request file with `sourceRoot`, `outputDirectory`,
`metadata`, `sources`, `retention` and optional `canaries`. Supply absolute existing
source/parent directories and a **new** output directory. Directory paths must be
canonical absolute paths without `.`/`..` components or symlink ancestors. Input filenames must
contain only letters, digits, hyphens, underscores and the `.json` suffix; nested
source directories use the same restricted names. The output directory is created
with mode `0700`, files with `0600`. Existing output directories are rejected.

`validate` checks the envelope, declared current inputs, artifact bytes/checksums,
closed projection and observed assertion links. Success means structurally valid,
unverified evidence. `report` verifies each bundle before computing coverage. It
returns a report even when coverage is incomplete; it is not a release gate exit
code. Invalid input, rejected collection or candidate creation exits with code 1.
Partial collection also exits with code 1 and preserves its explicit omissions.
Diagnostics are fixed codes and never include imported values or operating-system
error messages.

## Registry and coverage

| Gates   | Required case coverage                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------ |
| R1–R2   | Public installation; immutable revisions, exact Namespace authorization and observed activation              |
| R3      | Separate real Slack and Teams two-person repository work and follow-up                                       |
| R4      | Exact human/workload invoke, read and grant authority, including restart and dependency failures             |
| R5      | Platform credential exclusion and safe scoped ephemeral native GitHub token handling                         |
| R6      | Working mediated model/native GitHub routes, denied bypass and fail-closed profile selection                 |
| R7      | Measured local disable/issuance/mediation denial and separately recorded native token dispositions           |
| R8–R9   | Interrupted reconciliation; durable stop with routing removal and observed or unknown termination            |
| R10     | Separate Slack and Teams disconnect/restart continuity, no ambiguous tool replay and distinct purge evidence |
| R11–R12 | Resource bounds, isolation and safe failure diagnosis; clean package and maintenance inventory               |
| R13–R14 | Actual gVisor systrap/STRICT enforcement and standalone SPIRE identity for the bound sandbox/component       |
| R15     | Required same-adapter trust-domain, bundle, registration and Workload API configuration                      |
| R16     | Separate Slack and Teams overlap, duplicate-delivery, attribution and queue interruption                     |

Every case retains positive, denial and failure assertions, a component producer,
a deterministic fixture ID and prerequisites. These assertions describe the fixture
to build; they are not implementations of authorization or confinement.
R3/R10/R16 keep Slack and Teams separate. Channel application setup, authenticated
ingress, verified sender mapping and delivery/retry semantics must be reconciled
with the accepted native fixture before live acceptance.

The optional `r15-operator-managed-provider` case reports its selected environment
through frozen configuration/tuple identities and evidence. An unrun optional
provider permits no provider-validation claim and cannot remove required
standalone or same-adapter cases. OpenShell/Kata are later profiles with separate
qualification; neither their evidence nor historical gVisor checks qualify the
current selected profile.

The native credential cases do not claim that an ephemeral GitHub token is absent
from runtime memory. R6 permits the explicitly selected native GitHub route while
requiring denial of direct model, cross-scope, unsupported and fallback routes.
R7 treats a proposed local 60-second denial target separately from provider-confirmed
revocation, unknown status or expiry for each outstanding native token. Optional
mediated or history-isolated repository profiles are not added to this denominator.

## Selected runtime and required producer evidence

The current registry selects
`kubernetes-gvisor-systrap-strict-standalone-spire-native`; the optional provider
record uses `kubernetes-gvisor-systrap-strict-operator-managed-spire-native`.
R1 requires reproducible installation without KVM or nested virtualization.
R13 and R14 use distinct `r13-gvisor` and `r14-workload-identity` case IDs.
Every current fixture ID ends in `-v2` and remains `to-build`.

The selected topology is direct `occ/kubernetes-gvisor` Compute ownership of a
dedicated Harness Deployment with a separate trusted gateway. Embedded placement,
SandboxDriver composition and ordinary-container fallback are rejected. gVisor
systrap is a userspace kernel; these requirements claim no VM-equivalent isolation,
hardware attestation or malicious-administrator protection.

Before a producer can qualify current live execution, its frozen tuple,
configuration and protected observations must establish:

| Requirement             | Exact evidence to bind                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime artifacts       | The complete installed release archive and all six member hashes: `runsc`, `containerd-shim-runsc-v1`, and `gvisor-bin/checkpointgofer`, `gvisor-bin/gvisor-sentry-prewarmer`, `gvisor-bin/gvisor_sentry`, `gvisor-bin/runsc-metric-server`. Record distinct actual runsc and shim version outputs; the shim version need not equal the runsc release. Observe the companions actually selected or invoked for the fixture's operations. Conditional helpers need not all execute, and no per-helper version interface is presumed.                                                                                                                         |
| Effective handler       | `isolationProfile: gvisor-systrap`, RuntimeClass and handler `oce-gvisor-systrap`, `runtimeType: io.containerd.runsc.v1`, `platform: systrap`, `sidecar-usage-policy: STRICT`, and the exact admitted node handler arguments/environment and final workload shape. A RuntimeClass label or readiness result alone is insufficient.                                                                                                                                                                                                                                                                                                                          |
| Companion selection     | Freeze actual trusted directory resolution, `GVISOR_SIDECAR_BINARIES_DIR`, `sidecar-release-enforcement-policy` and `GVISOR_ENFORCE_RELEASE` behavior. Exercise absent/substituted binaries and unauthorized directory/environment overrides. STRICT prevents embedded companion fallback; it does not by itself pin the directory or release-matching policy. These companions are host runtime programs, not Kubernetes sidecars.                                                                                                                                                                                                                         |
| Containment             | Actual process/privilege, mount/filesystem, network and resource controls, exact store references and gateway-private state separation. Missing controls or unsafe placement deny activation. One intended Harness remains through provision/update/stop.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Workload identity       | An implemented SPIRE enrollment/delivery/verifier path for the actual gVisor sandbox/component, bound to server-owned installation, Namespace, Agent, revision, component, assignment and generation. Test two-Agent distinctions, wrong trust domain, forged assignment, replacement, retirement, rotation, expiry and dependency outage. A shared host Workload API socket, ServiceAccount, projected token or Pod label does not establish this binding. A Harness process/container restart under the same Pod UID, even with unchanged sandbox identity, needs fresh assignment, binding and identity evidence; it cannot reuse predecessor authority. |
| Provider correspondence | The Compute-owned Deployment UID, cluster reference, Namespace UID, exact ReplicaSet/Deployment ancestry, Pod UID, trusted runsc sandbox identity, separate required process execution discriminator and preallocated create effect. Preserve original observation time/freshness and exact runtime, image, policy, resource and store references. `openShellSandboxId` is absent only for an explicitly admitted typed direct-gVisor Harness; absence alone never grants applicability or authority.                                                                                                                                                       |

These are mandatory component-fixture assertions, not a new runtime-binding API or
an implemented tuple adapter. This harness validates their declared assertion
identities, record shape and exact input digests. It does not inspect a cluster,
parse the producer's entire runtime tuple or authenticate binary observations.
Required live coverage remains blocked until those adapters and evidence are
accepted. Runtime-specific values stay in the reviewed tuple/configuration bytes
bound by `inputs.tuple` and `inputs.configuration`; the existing evidence envelope
is unchanged.

R2–R12 and R16 keep their behavioral requirements under this selected runtime.
Recovery still needs the prior-writer barrier, exact stores, completed-context
import/readback and no ambiguous tool replay. Credentials still require external
model mediation and scoped ephemeral native GitHub tokens. Each native channel
must execute independently with the actual selected images and plugin-selected
Codex binary. Historical Codex 0.147 initialization, HTTP fixtures or version-only
checks do not qualify a changed image, current Codex version, SPIRE, mediated model
work or native channel/recovery behavior.

### Evidence transition

The `release-registry/v2` content digest and new profiles/fixture IDs intentionally
invalidate earlier applicability. The validator rejects the old registry digest,
Kata profiles, `r13-kata`, `r14-guest-identity` and old fixture IDs. Retain original
bundles and review receipts in their historical inventory; do not rewrite their
profile, identifiers, digests or outcomes. There is no automatic migration or
cross-profile coverage credit. New-profile execution needs fresh evidence against
its actual candidate inputs. Existing failed/unknown outcomes and rerun handling
remain unchanged for current-registry records.
