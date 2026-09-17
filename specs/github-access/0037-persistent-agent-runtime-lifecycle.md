---
title: Persistent Agent and runtime lifecycle
authors:
  - Free Wortley
created: 2026-09-08
last_updated: 2026-09-15
status: draft
issue:
---

# Proposal: Persistent Agent and runtime lifecycle

## Summary

Extend [OCE platform design](../../docs/design/workloads.md#agent-deployment) with persistent Agent lifecycle contracts. The GitHub gateway MVP supports mediated reads, direct push and minimal same-repository PR creation with current operation authority. Broader persistent Work, independently admitted durable children, approved-candidate publication, and public Stop/Start controls follow later. Agent identity persists and execution defaults to uncapped; authority leases remain finite. These runtime contracts remain proposals, not deployed guarantees.

## Motivation

Restarting a process cannot safely mean continuing its work. Files may contain unfinished changes, credentials may be revoked, and remote writes may already have succeeded. We need to distinguish accepted intent, effective authority withdrawal, observed termination, and credential cleanup without making the entire lifecycle API a prerequisite for initial GitHub access.

## Goals

- Preserve stable Agent identity while tracking separate work and process lifetimes.
- Require exact authority, containment, cancellation, and writer exclusion from the first supported runtime.
- Add durable controls and compatible completed-state recovery as separately qualified capabilities.

## Non-Goals

No initial active-session migration, cross-build or cross-cluster recovery, memory restore, historical tool replay, workflow scheduler, automatic merging, or independent-child coordination.

## Proposal

### Delivery sequence

1. **Gateway MVP.** Bind the exact runtime assignment and immutable authority; enforce containment; retain construction cancellation and helper-stop ownership before construction; observe termination before handing writable state to a successor. Reads, direct push and minimal PR creation use one immutable service-owned root Work per execution with qualified subordinate helpers. Qualify a root-only profile where helper authority, aggregate limits, containment, cancellation, and physical cleanup are unproven; reject unsupported helper requests. [RFC 0034](0034-github-app-credentials.md) owns access profiles and operations; direct writes require no reviewed candidate or human approval.
2. **Broader persistence later.** Add durable Work coordination, independently admitted children, public **Stop task**, **Stop Agent**, and **Start Agent**, plus selected recovery, drain, and delivery profiles. Approved-candidate publication is a separate future profile.

The full public lifecycle API and its unselected default Stop behavior do not block the gateway MVP. Its minimum runtime obligations remain mandatory. Configurable-cap components and lifecycle status reads do not establish complete control mutations or runtime qualification. [Detailed scope and qualification](0037/runtime-contract.md#delivery-sequence-and-implementation-boundary) define these boundaries.

### Runtime baseline

OCC owns policy; Compute and Sandbox drivers realize admitted intent and report observations. Use [RFC 0035's assignment](0035-workload-identity-and-runtime-authority.md) and [RFC 0036's work authority](0036-turn-bound-delegated-authority.md). Admission fixes the effective finite-or-uncapped execution selection on the original attempt, including startup and waiting. Draft edits, reconnects, and credential rotation cannot change it. Uncapped execution still requires finite enforcement leases and current authority; missing authority never means uncapped permission. Both modes retain an owner responsible for stopping exact native construction and all supported helpers.

OCC constructs separately admitted read-only preparation authority and hands it to access delivery. Observe preparation writers terminated before workspace handoff; pending assignment and readiness grant no access. Changes to admitted permission scope require fresh execution and, in the Kubernetes/gVisor profile, a fresh Pod. The gateway's bearer authenticates the original grant and execution, not the caller's physical container; [RFC 0035](0035-workload-identity-and-runtime-authority.md#identity-and-authority) owns that boundary.

Retain push and PR operation identity and uncertain outcomes across disconnect, cancellation and restart. Register independent bounded finalization before dispatch and report success only after a known receipt commit. This required finalization is separate from later completed-result delivery; neither runtime replacement nor restored context permits automatic replay. [Operation retention](0037/runtime-contract.md#operation-retention-and-finalization) defines the lifecycle requirements.

The [current ordinary Kubernetes controller](https://github.com/openclaw/openclaw-enterprise/blob/3eeacb85d9e8e087bc3e74d792778e4ef3123412/apps/controller/src/worker.ts#L987) selects and requests successor activation before requesting predecessor retirement. Its activation checks and Recreate gateway rollout do not establish the full observed-stop and shared-writer exclusion contract required here. This call order alone does not prove concurrent writers.

Implement RFC 0027's required replacement order:

1. Prepare an isolated, nonserving candidate with Harness execution disabled.
2. Retire the predecessor and observe that its Harness and owned writers have terminated. Resolve uncertain creates before any successor writes shared storage.
3. Select the sole active revision, permit execution, and enable routing after readiness.

This deliberately creates an availability gap between predecessor retirement and successor serving. It provides no zero-downtime guarantee. Readiness, route withdrawal, lease expiry, credential revocation, and elapsed time cannot prove writer exclusion. Unknown termination blocks writable replacement; retain the data and cleanup obligation. [Activation details](0037/runtime-contract.md#activation-and-writer-exclusion) also cover initialization and restore.

### Later lifecycle controls and recovery

The proposed inventory reports intended state, observed work, observation time, configured cap, and pending or unknown outcomes. **Stop task** targets exact work and its owned helpers or admitted descendants. **Stop Agent** durably blocks new work and drives affected work to stop while preserving identity and retained files. **Start Agent** requires separate authorization; it cannot bypass disable, revive canceled work, or replay uncertain effects.

[Durable admission](0037/runtime-contract.md#durable-admission) atomically retains authorized intent, attribution, generation, idempotency key, and processing obligation. Acceptance, effective withdrawal, physical termination, and credential cleanup remain separate outcomes. Stopped intent survives restart and messages. Default Stop behavior and optional finite drain require a later product decision.

If selected, the first [recovery profile](0037/recovery-and-qualification.md#recovery-contract) restores completed state on same-build, same-cluster retained storage with exact compatibility checks. Expose residual files and unknown effects for disposition. Restore supplies neither authority nor permission to execute historical tools. Active-session migration and replay remain later work.

![Optional later graceful-stop profile: finite drain and pre-admitted completed delivery; cancellation withdraws both.](0037/stop-and-delivery.png)

**Figure 1.** A later graceful-stop profile may preserve separately admitted, finite delivery of a completed result. Delivery fixes content, audience, destination, and horizon and requires current authority. A late approval or delivery event cannot restart stopped execution, reopen canceled Work, or authorize replay. Unknown posting outcomes do not authorize reposting. [Delivery details](0037/recovery-and-qualification.md#completed-result-delivery) retain cancellation and cleanup obligations.

## Rationale

Staged qualification keeps initial access attainable while preserving mandatory runtime safety. Separate observations prevent accepted intent or readable status from masquerading as completed execution control.

## Unresolved questions

Later selections cover default Stop behavior, drain and withdrawal bounds, recovery compatibility and retention, delivery enforcement, and independent-child coordination. The [sidecar](0037/recovery-and-qualification.md#open-decisions) records these decisions; none substitutes for first-stage containment, cancellation, or observed writer termination.
