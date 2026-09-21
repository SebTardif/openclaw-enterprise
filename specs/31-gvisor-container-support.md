# RFC: gVisor container support

**Date:** 2026-09-18

**Status:** Accepted direction. Implementation and qualification pending.

**Owner:** Kubernetes Compute and its runtime consumers.

## Problem and proposal

Agent tools run repository code, dependencies and build scripts that must not gain
access to the host, other Agents or the gateway's private state. Add an opt-in
gVisor profile to the existing Kubernetes Compute Driver in OpenClaw Enterprise
(OCE). Dedicated Codex and its tools run under `runsc` with `systrap`; the trusted
OpenClaw gateway remains in a separate Pod on the ordinary runtime. The existing
Compute lifecycle owns preparation, readiness, activation, stop and retirement.

Trusted Installation configuration selects the profile for OCE-owned tenant
namespaces. OpenClaw Control Plane (OCC) admits each revision with a fixed runtime
requirement. Omitting the
profile preserves ordinary Kubernetes; a failed stronger selection never
silently downgrades. [Configuration and admission](31-gvisor-container-support/interfaces.md#configuration-and-admission)
defines the selector and supported combinations.

```mermaid
---
config:
  theme: base
  htmlLabels: true
  themeVariables:
    fontSize: 16px
    lineColor: "#8B949E"
    edgeLabelBackground: "#FFFFFF"
  flowchart:
    curve: linear
    nodeSpacing: 28
    rankSpacing: 26
    padding: 14
---
flowchart TB
  Request["<b>Authorized Agent</b><br/>Approved repository task"]
  Compute["<b>OCC and Compute</b><br/>Admit and check runtime"]
  Codex["<b>Dedicated Codex</b><br/>Tools inside gVisor"]
  Contribution["<b>Disposable contribution</b><br/>Test, push and open PR"]
  Recovery["<b>Later selected work</b><br/>Retain and recover state"]
  Request -.->|admit revision| Compute
  Compute -.->|prepare and observe| Codex
  Codex -.->|managed repository access| Contribution
  Contribution -.->|separate delivery gates| Recovery
  classDef pending fill:#F3F4F6,stroke:#98A2AE,color:#344054,stroke-width:1px,stroke-dasharray:4 4
  classDef gate fill:#F7F1E5,stroke:#B3A078,color:#514532,stroke-width:1px
  class Request,Codex,Contribution,Recovery pending
  class Compute gate
  linkStyle default stroke:#8B949E,stroke-width:1px
```

Dashed arrows show the proposed contribution and recovery path. The
[full lifecycle](31-gvisor-container-support/architecture.md#request-lifecycle)
includes the separate gateway, authorization, failure handling and closure.

## Scope and delivery

The proposal has four [delivery increments](31-gvisor-container-support/delivery.md#increments-and-qualification):

1. **Runtime checkpoint.** An authorized Agent uses genuine Codex, models and tools
   on one operator-managed gVisor installation. Existing supported storage
   suffices for this checkpoint.
2. **Disposable contribution.** Complete temporary storage admission, creation
   and disposal, plus managed Git/`gh` in real tool children
   to clone, edit, test, commit, push and open an approved same-repository PR.
3. **Retained current state.** Preserve files, local commits and completed context
   through same-build, same-cluster replacement. Exclude every predecessor writer
   before any successor writes, then resume under fresh authority.
4. **Continuing recovery.** Capture visible writes, verify and export recovery
   artifacts, and restore to fresh stores without blindly repeating uncertain
   model or repository effects.

All four remain selected scope. The runtime checkpoint alone does not complete
contribution or recovery. [Storage and recovery](31-gvisor-container-support/storage-and-recovery.md)
defines disposal, writer exclusion and completed-context restore; the exact
disposal transition and native import interface remain
[open decisions](31-gvisor-container-support/interfaces.md#owner-decisions).

## Security and limits

Compute must observe the complete candidate Pod set and the required RuntimeClass
before activation. Missing evidence blocks readiness; a positive isolation
violation triggers [guarded containment](31-gvisor-container-support/architecture.md#containment-and-availability).
Selecting a RuntimeClass alone does not prove the installed sandbox.

Runtime selection grants no personal, team or repository authority. The first
profile may expose model credentials to tools and leave destinations unconfined;
repository provider credentials stay service-private. The stronger
[protected composition](31-gvisor-container-support/architecture.md#protected-composition)
adds verified receiving identity, network confinement and external credential
custody. It has separate requirements, and every deployment must satisfy its
selected profile. [Security](31-gvisor-container-support/security.md) defines
these boundaries and traffic-withdrawal limits.

Embedded execution, SandboxDriver composition and existing-namespace adoption
are excluded initially. Broader installation automation, other backends,
exact-container origin, outage termination and host-loss or changed-build recovery
remain [follow-ups](31-gvisor-container-support/delivery.md#decisions-and-follow-ups).
