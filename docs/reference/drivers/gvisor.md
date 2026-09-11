# gVisor isolation (Alpha)

The bundled Kubernetes Compute Driver accepts an explicit
`isolationProfile: gvisor-systrap` selection in both development and production.
**Support is Alpha.** The Agent workload requests the separately installed
`oce-gvisor-systrap` RuntimeClass; its trusted gateway retains the existing
runtime selection. The explicitly selected real-cluster suite exercises the HTTP
fixture through gVisor, revision preparation and replacement, retained workspace data, and containment
of observed unsafe placement. Full gateway/Codex and model compatibility require
separate qualification.

gVisor implements a userspace kernel, not a VM boundary.
`runsc --platform=systrap` can operate without `/dev/kvm`. See the upstream
[platform documentation](https://gvisor.dev/docs/user_guide/platforms/) and
[Kubernetes integration](https://gvisor.dev/docs/user_guide/quick_start/kubernetes/).
A gVisor deployment does not establish OpenShell policy enforcement,
Kata guest isolation, SPIRE workload attestation, or deployment qualification.
OpenShell/Kata is a separate runtime profile with its own prerequisites and
qualification requirements.

## Selection and boundaries

- Select `isolationProfile: gvisor-systrap` in trusted Installation startup
  configuration. Unknown profiles fail validation. Both explicit kubeconfig
  and in-cluster authentication remain supported.
- The profile uses `occ/kubernetes-gvisor` as a distinct Compute implementation
  in admitted revisions. A revision belonging to that implementation cannot
  execute through ordinary Kubernetes Compute when the profile is removed.
- Dedicated Harness placement is supported. Embedded placement and composition
  with a SandboxDriver are rejected, preserving the separate trusted gateway.
  OpenShell-selected workloads retain their provider path; this profile never
  changes an OpenShell Sandbox into a direct Deployment or applies OpenShell's
  override of the inner Codex sandbox.
- Production still requires immutable image digests, the normal runtime
  configuration, and projected ServicePrincipal credentials. gVisor adds no
  exception to those requirements.
- Agent ServiceAccount selection, authentication, workspace PVC subpaths,
  resource requests/limits, restricted Pod security, and default-deny network
  policy construction remain in the Kubernetes Compute path. A projected
  token is not SPIRE attestation; the profile installs no broker or identity
  service.

The existing credential contract is unchanged: trusted gateway/channel and
controller credentials stay outside the dedicated Harness, while the current
Codex runtime receives its model or selected provider credential and scoped
workload/transport credentials. Tools in that Harness may read credentials
available to it. Selecting gVisor does not implement external model mediation,
short-lived repository issuance, credential secrecy from tools, or additional
per-command authorization. Those capabilities require separate integration and
validation. See [Kubernetes credential placement](kubernetes-compute.md).

## Trusted startup selection

Add this field to the bundled Kubernetes Compute configuration in the
[Installation startup YAML](kubernetes-compute.md#configuration):

```yaml
drivers:
  compute:
    id: compute-gvisor
    configuration:
      isolationProfile: gvisor-systrap
      # Keep the normal authentication, images, resources, network,
      # servicePrincipalCredentials and runtime configuration.
```

Omitting the field preserves ordinary Kubernetes runtime selection. The Docker
Compute Driver is unchanged. Use approved images and keep host homes, Docker
sockets, SSH agents, gateway state and broker credentials outside the Harness.
For local tests, use disposable identities and harmless fixture data, without
production model or channel credentials. An HTTP fixture is not a real Codex
app-server and does not establish model, GitHub or channel behavior.

## Offline runtime preparation

`scripts/gvisor-development-setup.mjs` prepares a new private prefix from
operator-supplied local artifacts. It never downloads files, contacts a
cluster, edits shared daemon configuration, changes a default runtime, or
restarts a service. Provide an independently verified immutable release bundle:
`runsc`, `containerd-shim-runsc-v1`, and all four adjacent `gvisor-bin/`
programs. Current releases require this complete layout; see the upstream
[installation instructions](https://gvisor.dev/docs/user_guide/install/).
A checksum supplied
alongside an untrusted artifact is not an independent authenticity guarantee.

Run the helper's `--help` for the exact manifest schema, then:

```sh
node scripts/gvisor-development-setup.mjs \
  --manifest /private/oce-development/gvisor-artifacts.json \
  --prefix /private/oce-development/gvisor
```

The canonical manifest uses `schemaVersion: 2`, a pinned `releaseVersion`, and
six artifact entries. The two entrypoint programs include exact version-probe
expectations; each sidecar includes its local path and SHA-256. The helper
verifies every file before executing bounded version probes, rechecks hashes
after each probe, and refuses an existing destination. Its `bin/` directory
preserves the sidecar layout and execution permissions needed after runsc drops
privileges. The `runsc-systrap` wrapper fixes `platform=systrap` and
`sidecar-usage-policy=STRICT`, rejecting caller overrides.

Preserve the resulting receipt with the artifact provenance. Missing artifacts,
a checksum mismatch, or a version mismatch are failures; there is no download
or runc fallback. A successful preparation receipt is not a sandbox smoke test.

For local qualification, install the prepared runtime in a disposable cluster
or isolated containerd instance. Keep the current default runtime and shared services.
Register the exact RuntimeClass name `oce-gvisor-systrap` against a handler
whose inspected configuration invokes the verified runsc binary with
`platform=systrap` and `sidecar-usage-policy=STRICT`. Keep its complete `bin/`
layout together when mounting it into a node. The wrapper contains its prepared
host path; a node mounted at a different path must configure its local runsc
path and both flags explicitly. Do not grant an unrestricted Pod Security exemption:
Harness Pods retain restricted security settings. Distribution and
containerd configuration must be verified against the installed versions.

## Readiness and no-fallback checks

Startup and preparation read the exact `oce-gvisor-systrap` RuntimeClass and
require its handler to also be `oce-gvisor-systrap`. A missing, deleting, or
mismatched class fails before workload writes. Readiness repeats that check.
The Helm API/worker roles grant only `get` for this exact RuntimeClass;
operators using separate RBAC must supply the same limited read permission.
No runtime registration or mutation permission is granted.

The desired Agent Deployment always sets
`spec.template.spec.runtimeClassName: oce-gvisor-systrap`. A missing handler
prevents Kubernetes from starting the Pod; OCE never retries without the class.
Compute checks Pod placement during rollout as well as after the Deployment
reports readiness. Readiness requires exactly one live Pod with its exact
ownership labels, namespace, `Running` phase, `Ready=True`, and the same
RuntimeClass. Missing, duplicated, or unready Pods prevent readiness; a removed
or substituted RuntimeClass fails explicitly. A matching Pod with a deletion
timestamp is still checked for runtime violations until its phase is
`Succeeded` or `Failed`; deletion intent does not establish that its process
has stopped. A safely placed deleting Pod never contributes to readiness.

A positively observed isolation violation during preparation or activation
also requests containment: an atomic selector/UID/resourceVersion check
removes routing only while the Service still selects that exact revision,
cleanup hooks run, and a UID-guarded foreground deletion targets its dedicated
Deployment. These requests preserve the gateway, workspace PVCs and other
revisions. An unsuccessful cleanup remains an error. Deletion is asynchronous;
neither a request nor a rejected readiness result proves that processes have
stopped. Ordinary pending readiness and transient API failures do not trigger
this destructive path.

These checks establish requested placement and observed Kubernetes state.
A RuntimeClass name is not proof of the runtime executable or platform that
actually ran. A trusted operator could map the handler incorrectly; node-side
runtime evidence is required before reporting gVisor containment.

## Local conformance checks

```sh
node --test tests/conformance/gvisor-development-profile.test.mjs tests/conformance/gvisor-development-setup.test.mjs
```

These tests exercise the real configuration/Compute code against transport
fixtures and the offline artifact helper against labeled executable fixtures.
They make no cluster or gVisor runtime claim.

## Live fixture verification

`tests/integration/gvisor-kubernetes-real.test.mjs` requires explicit opt-in and
a disposable loopback k3d cluster with an installed handler, RuntimeClass,
imported HTTP fixture image, enforcing NetworkPolicies, and prepared shared
local-path storage. It uses the actual Compute Driver and scoped controller
credentials. It checks gVisor kernel output, allowed DNS and denied traffic,
revision preparation and replacement, retained workspace bytes, and observed
Pod removal after exact-revision containment. The fixture has no real runtime
configuration, so activation deliberately leaves routing inactive; production
activation and route cutover require the real-runtime suite. The suite preserves the
operator-owned RuntimeClass and removes its own namespaces and RBAC.
See [the test procedure](../../testing/gvisor.md#gvisor-alpha-http-fixture).

The workload is an HTTP fixture. These checks do not establish genuine
OpenClaw gateway, authenticated Codex transport, provider model turns, or a
general sandbox security certification. Node-side binary and platform evidence
must accompany a live result.

## Deployment qualification

No live qualification is implied by the conformance tests. On a prepared
isolated host, retain evidence for all of the following:

1. Verified binary SHA-256, exact runsc and shim versions, kernel and workload
   image digest, handler configuration, and explicit `platform=systrap`.
2. A real sandbox process and node-side runtime inspection proving that the
   workload ran through that binary/platform. Include the failure when the
   handler or binary is unavailable; confirm no runc workload was created.
3. The actual OCE Compute fixture path: namespace preparation, dedicated
   Harness creation, readiness, stop, cleanup, and exact resource ownership.
   Test workspace content across supported replacement separately from
   explicit purge; the existing retirement path can delete the final Agent's
   workspace, so retirement is not a persistence guarantee.
4. Read-only root, writable approved workspace, UID/capability behavior,
   blocked host files, denied unrelated/metadata egress, allowed approved
   traffic, and observed CPU/memory/process limits. Configuration alone does
   not establish enforcement or a general compatibility guarantee.
5. Pinned Git and gh on harmless fixtures: local Git init/status/diff/log/commit
   and Git exchange with an allowed test remote; gh version/help plus any
   separately authorized API matrix. Local commands do not establish GitHub
   authentication, scoped issuance, refresh, revocation, or mediated access.

CPU and memory configuration does not establish a process-count limit. The
Compute profile does not configure the kubelet's Pod PID limit; operators must
set and verify that node policy separately. See
[Kubernetes PID limits](https://kubernetes.io/docs/concepts/policy/pid-limiting/)
and the [gVisor resource model](https://gvisor.dev/docs/architecture_guide/resources/).
Measure host sandbox limits separately from process accounting inside gVisor.

Full gateway/Codex model execution must be measured separately on this Alpha
profile; unit tests and HTTP fixtures are not that evidence. The intended
external credential mediation boundary also requires its own integration and
identity/authorization tests. SPIRE workload identity, credential mediation,
networking, persistence, and channel behavior require evidence on the selected
runtime profile. The separate OpenShell/Kata profile additionally requires a
VM-capable host for its guest-specific qualification; those requirements do not
apply to running this gVisor systrap profile.

## Rollback

Stop and remove only resources belonging to the disposable development
Installation/cluster, then remove its separately registered runtime and
prepared prefix after confirming no workload uses them. Preserve evidence and
retained workspace data before deletion. Do not restart shared Docker or
remove unrelated runtime registrations. Removing the profile from startup is
not an in-place downgrade for its admitted revisions. Retire those revisions
through their matching implementation and deliberately admit new revisions for
the replacement profile, preserving data according to the existing lifecycle
contract.
