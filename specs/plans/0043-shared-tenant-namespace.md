# Implementation plan: one tenant namespace in a single cluster

- **ID:** TASK-0043
- **Delivery status:** Completed
- **Owner:** Kimi Yu
- **Authority:** [Platform architecture](../../docs/design.md)
- **Source baseline:** b9613e5d1b7b55f02c685fb61a2ff2a2f1edc968

## Outcome and scope

Single-cluster Kubernetes Compute places dedicated Gateways, Harnesses and
canonical tenant configuration and credentials in one tenant namespace. Separate
Pods, identities, credential groups, private volumes, node placement and exact
Agent/revision network peers remain. Two-cluster execution retains its separate
control target. This supersedes the same-cluster namespace allocation in
[the earlier placement plan](36-control-plane-gateways-plan.md).

Namespace workload managers are trusted for both roles. Namespace quotas and
namespace-wide operations cover both roles; this change adds no admission system.
Existing split-layout resources and volumes are not migrated or deleted.

## Contract and source touchpoints

Kubernetes Compute owns placement, credential provisioning and lifecycle.
Kubernetes Secret and Configuration Drivers discover the canonical storage target
through verified namespace metadata. A single-cluster tenant advertises that
storage role itself; the two-cluster control namespace retains it separately.
Gateway/Harness credential delivery uses execution roles rather than namespace
inequality. Ownership, Secret UID and revision guards continue to apply.

## Implementation

- [x] Unify same-cluster placement and canonical storage discovery, including
      adopted namespaces, without changing the two-cluster target.
- [x] Preserve role-specific credentials, storage and network policies; update
      stop, retirement, deletion and development/fixture resource grants.
- [x] Extend existing credential, ownership and real-cluster lifecycle tests.
- [x] Update current architecture, references, guides and topology flow.
- [x] Run focused conformance, type/lint/format/docs and real-cluster checks.

## Verification

| Required outcome                                   | Check                                                                                             | Result |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------ |
| One namespace; role-specific credentials and PVCs  | Kubernetes Compute and runtime-credential conformance; real Kubernetes lifecycle/API-worker suite | Passed |
| Adopted tenant ownership and preservation          | Secret/Configuration conformance and real adopted-namespace case                                  | Passed |
| Cross-Agent network denial and replacement cleanup | Existing Kubernetes integration suite                                                             | Passed |
| Two-cluster placement preserved                    | Two-cluster OAuth handoff, logs and missing-execution-target cleanup conformance                  | Passed |

## Delivery record

Implemented the shared target, storage-role discovery, role-based delivery,
Agent/revision cleanup and single-target fixture grants. Focused validation has
512 passing tests with one macOS skip for the Linux argument-size limit;
typecheck, focused lint, formatting, workspace/module boundaries, docs/link and
spec checks pass. All four real Kubernetes 1.35 fixture cases pass across the
full run and scoped reruns: lifecycle/isolation, adopted namespace preservation,
provisioning handoff, and authenticated PostgreSQL API/worker deployments. The
lifecycle case checks that the Harness mounts its revision projection rather than
the canonical model source. The handoff case checks canonical sources in the
shared tenant; it does not assert runtime activation. The full API/worker case
checks activation separately. Native model turns, production node-pool isolation
and two-cluster real execution are outside this fixture proof.

A broader local conformance attempt reported 1521 passes, eight failures and four
skips. Failures included unavailable Linux-only fixture paths, a local control
directory restriction and timing-sensitive cancellation, redaction, SSH and
Gateway startup cases. The Gateway startup case passes the focused rerun; this
is not a claim that the broader suite is green.

## Manual Notes

## Changelog

- 2026-10-02: Complete implementation and focused/local real-cluster verification.
- 2026-10-02: Begin authorized same-cluster namespace simplification (b9613e5d; 01a0fe72-58b2-7cc3-b770-7310f5401deb).
