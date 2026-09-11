# Runtime file and state ownership delivery

**Date:** 2026-09-11
**Status:** Proposed — ownership and update direction approved; implementation unshipped
**Scope:** M1.2 (#76), supporting M1.1 (#75) and pre-Agent files (#89)

## Decision and scope

The authoritative decision lives in [Runtime files and durable state](../docs/design/files.md).
This specification records delivery slices and proof obligations, not a second
architecture. Configuration supplies independent Agent file defaults; managed-file
changes apply only on deployment. The design chapter explains the benefits and
intentional loss of live propagation.

This documentation-only PR follows [gateway-placement PR #125](https://github.com/openclaw/openclaw-enterprise/pull/125)
and is stacked against its branch. It does not complete
[M1.1](https://github.com/openclaw/openclaw-enterprise/issues/75),
[M1.2](https://github.com/openclaw/openclaw-enterprise/issues/76), or
[pre-Agent configuration](https://github.com/openclaw/openclaw-enterprise/issues/89).

The placement decision in M1.1 establishes the boundary M1.2 needs to target.
Removing cross-target storage coupling then enables the actual dedicated gateway
move in M1.1. Completing all gateway relocation before file exchange would invert
that dependency. Separate clusters remain a design constraint, not an initial
deployment requirement; embedded execution remains tenant-local and untrusted.

This proposal supersedes the common-mount target of the historical
[dedicated shared-workspace specification](.archive/12-dedicated-harness-shared-workspace-drive.md).
That historical record and current shared-storage implementation remain unchanged.

## Baseline and gaps

At parent commit `ea6a7d56014b0ce565391aa42109507769b2bcf5`:

- [Kubernetes Compute](../apps/controller/src/drivers/compute/kubernetes/index.ts)
  shares workspace, sessions, generated images, bundled skills, and plugin skills
  through one RWX claim. Gateway database/private state uses separate storage.
- [Runtime entrypoints](../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts)
  publish gateway image assets into shared skill paths; the Harness consumes mounts.
- [Workspace-file access](../docs/flows/workspace-files.md) requires an active
  revision and reachable gateway, with four supported filenames. It does not
  persist desired file contents in OCC or support pre-Agent defaults.
- The [OpenShell adapter](../docs/reference/drivers/openshell-sandbox.md) still
  consumes the workspace mount contract. It is not an existing implementation of
  the proposed exchanges.
- [Harness execution](../docs/reference/harness-execution.md#isolation-and-activation)
  records a dedicated existing-session resume limitation. Preserving bytes alone
  cannot close that runtime acceptance gap.

## Small implementation PRs

Keep each change independently reviewable, with focused tests and an honest
statement of the storage coupling that remains. These are delivery slices, not
permission to ship unfinished paths as supported capabilities.

1. **Separate placement planning from effects.** Introduce explicit gateway and
   Harness targets inside the selected ComputeDriver while preserving current
   placement and behavior. Test exact ownership and existing lifecycle outcomes.
2. **Persist managed intent.** Add Configuration file defaults and atomic independent
   Agent copies; authorize each operation and pin desired files at deployment.
   Deliver the API/UI semantics coherently: saved versus deployed, no runtime
   write-through fallback. Coordinate this slice with #89.
3. **Materialize managed inputs.** Choose one supported transport/storage realization
   behind the existing Driver boundaries. Stage and verify immutable input sets;
   make candidate readiness depend on both consumers. Prove tamper, wrong-owner,
   partial-transfer, and retry outcomes. Other shared categories still remain.
4. **Transfer immutable skills.** Replace the two shared skill mounts, preserving
   selected runtime/plugin assets, integrity checks, and read-only consumption.
5. **Publish artifacts explicitly.** Replace shared generated-image visibility with
   bounded, durable output publication and useful failure reporting. Prove a real
   generated result, not only a marker file.
6. **Replace session sharing and isolate mutable state.** Resolve native session
   context/continuation requirements; retain Harness-private working state and
   gateway-private stores with single-writer handoff. Split native-runtime support
   and Compute changes into further PRs where needed. Verify replacement and
   rollback without treating configuration rollback as data rollback.
7. **Complete adapter parity and remove the common claim.** Implement the equivalent
   supported OpenShell materialization contract, or explicitly reject an unsupported
   combination. Remove the shared claim only after every category has a replacement.
   A rejected combination is not evidence of OpenShell parity or complete coverage.
8. **Finish M1.1 placement.** Add location-aware network policy, owner-bound
   connectivity, consumer-target secret delivery, and dedicated gateway relocation
   in separate PRs. Prove same-cluster, cross-namespace lifecycle and isolation
   before claiming the move complete. Cross-cluster transport remains later work.

## Verification and documentation ownership

This PR checks formatting, documentation lengths, navigation/links, and workspace
isolation; it changes no runtime behavior and makes no new integration claim.

Implementation must prove: files saved before Agent creation reach first execution;
sibling copies stay independent; subsequent saves leave the active revision
unchanged; deployment consumes an exact set; partial creation/transfer cannot
publish partial state; wrong-owner access fails; and replacement retains required
working/session state without any common gateway/Harness mount. Exercise authentic
runtime outcomes and fail-closed state handoff, not just fixture marker visibility.

Affected current documentation must ship with each behavior-changing slice:
[Configuration](../docs/reference/configuration.md),
[Agents](../docs/reference/agents.md),
[Harness execution](../docs/reference/harness-execution.md),
[Kubernetes storage](../docs/reference/drivers/kubernetes-compute/storage-and-credentials.md),
[OpenShell](../docs/reference/drivers/openshell-sandbox.md), and
[workspace-file flow](../docs/flows/workspace-files.md), plus affected console,
deployment guides, and [testing procedures](../docs/testing/README.md).
Do not describe this proposal as current support before those implementations ship.
