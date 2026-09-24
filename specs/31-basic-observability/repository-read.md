# Basic observability: trusted repository read

[Overview](../31-basic-observability.md) · [Architecture](architecture.md) · [Interfaces](interfaces.md)

**Status:** Proposed selected behavior. Shared invocation/runtime exports, credential-owner acceptance and connected qualification remain pending.

**Owners:** OCC/RBAC admission, Compute/Harness execution, identity/egress receiving controls, credential sessions/provider results and Audit/State projection.

## Decision

Deployer A creates and deploys a personal/team Agent. Different authenticated human B requests one approved GitHub HEAD read. Separately granted audit-only reader C follows B's admission through an actual Harness turn, managed Git child, session and strongest observed or unknown result.

[Lifecycle History](architecture.md#availability-and-delivery) can ship first. The [release decision](../31-basic-observability.md#release-decision) remains open: the current proposal requires this journey for the complete MVP; a review suggestion would move it to a follow-up. One qualified admission/runtime/channel profile and local accounts suffice. Full neighboring provider, Harness and retained-workspace deliveries remain separate.

## Current-source amendment — 2026-09-24

[Current main repository credentials](https://github.com/openclaw/openclaw-enterprise/blob/5ebd7305b0876db33276a249934bc82073b63424/docs/reference/repository-credentials.md) now support embedded OpenClaw and dedicated Codex through the selected `RepoDriver`, whose `listOptions`, `resolve`, `open`, `status` and `close` operations own repository admission and sessions. State retains immutable admission context and cleanup obligations after Agent deletion. Current implementation should consume those contracts; the older supplier limitations below remain historical evidence.

This advances the credential/runtime foundation, but does not establish requester B's authentic per-invocation attribution or this RFC's connected A/B/C acceptance. Session closure, provider cleanup, runtime retirement and observed Git results remain separate facts. The proposed stronger identity/egress profile still requires its own receiving and withdrawal evidence.

## Current boundary and scope

The separate [credential supplier](https://github.com/openclaw/openclaw-enterprise/blob/02f8fe0b1266462a5726c6684344394324a8bdf7/docs/reference/repository-credentials.md) supports Kubernetes embedded OpenClaw, rejects dedicated Harnesses and defaults omitted profiles to `git-write`. It checks open session, exact grant/profile and original finite deadline. Closure/expiry denies new exchanges and aborts owned exchanges while preserving possible dispatch.

Worker checks concern the queued deployment actor. They establish neither per-exchange human currentness nor an outage revocation guarantee. Revision bearer possession identifies neither B nor a native turn. Restart loses provider-token cleanup inventory and existing tokens may survive to expiry. Retained platform IDs cannot prove revocation.

That supplier is not this RFC's historical baseline. A separate historical integration supplier at `6538069`, outside main, has a [purpose resolver](https://github.com/openclaw/openclaw-enterprise/blob/65380694085693d6edb5218372ccddbc2ba493d9/packages/occ/src/runtime-authority/service.ts#L349) that returns unavailable on eligible lookup. Components and definitions do not establish the proposed joined path.

## Admit one operation

Consume the common proposed `AgentInvocation` admission/status/result/cancel, server-owned `AgentAuthorityContext` and `AgentInvocationRuntime` from the [RBAC owner](https://github.com/openclaw/openclaw-enterprise/pull/245). Current account/method/session and exact `invoke` admit the original human and personal/team authority. The common owner selects immutable revision and registers authority under the State/policy barrier.

Repository use additionally needs an approved assignment and current exact Agent-ServicePrincipal `use_repository`. The credential owner's accepted source defines actual guarantees. Preserve owner-issued opaque IDs, selected authority, actual authorization principal, IAM Driver, exact action/resource and admission reference. Initiator and authorization principal may differ.

Callers cannot choose another human, generation, ServicePrincipal, session, URL, command, profile or output destination. Freeze the one-operation shape/vocabulary only after accepted owner exports. Observability adds no invocation API, record, queue, Work implementation, authority lease or native Gateway client.

The real managed Git child uses explicit **`git-read`** on the admitted repository. Qualify packaged Git and GitHub against the proposed fixed operation:

```sh
git -c protocol.version=0 ls-remote --symref --exit-code -- <admitted-url> HEAD
```

The runtime supplies this fixed invocation. Callers do not supply the placeholder. Provider permission ceilings establish neither one-use command authority nor human initiation. Profiles, protocol and credential custody remain with the credential owner.

## Connect authentic handoffs

All connected-feature handoffs remain proposed. Existing ledger/credential source does not prove their composition, installed receiving control or genuine live-Agent execution.

Compute/Harness must supply the actual turn, status/result/cancel, unknown-dispatch reconciliation and private credential delivery. Dedicated Codex/separate Gateway needs a reviewed consumer of `RepositoryCredentialRuntimeBinding` in the actual executing child/role. That consumer must cover PATH, trust, material, initialization and generation behavior. Relaxing a topology check is insufficient.

For the protected profile, preserve this order:

1. Observe preparation with traffic disabled, then bind the exact incarnation.
2. Persist the immutable session attempt, open the session and read it back.
3. Deliver material without changing incarnation.
4. Validate current execution, material and serving selection, then enable traffic.

Replacement needs fresh admission, never session rebinding or downgrade. Coordinate bootstrap-probe authority with the [identity](https://github.com/openclaw/openclaw-enterprise/pull/247) and [egress](https://github.com/openclaw/openclaw-enterprise/pull/249) owners. Readiness alone is not current-serving selection. Protected bootstrap and current-serving mechanisms remain unresolved joins. The egress proposal to contain traffic before any untrusted instruction remains a proposed strengthening of mandatory pre-readiness containment, not a qualification claim.

Every reference needs its original source record and authorized diagnostic lookup. Independently authenticate request-to-authority and per-operation turn/session association, including concurrent turns sharing an execution. DTOs, copied IDs, deployment actor, Git author/configuration, model text or headers cannot establish B.

Admission/dispatch and native reply submission keep independent durable fences that survive audit erasure. Unknown start/send/provider outcomes require reconciliation without blind redispatch. A native reply also requires current content authority, complete eligible audience and original reply custody under the [common invocation/content owner](https://github.com/openclaw/openclaw-enterprise/pull/245).

The closed observation contains original invocation/authority references, provider-neutral repository/grant/session/profile IDs, admitted operation kind, dispatch state and strongest established transport/provider result. These are expanded producer obligations, not fields already present in the proposed lifecycle-only contract. Apply [fact contracts](interfaces.md#facts-and-events) and [safe projection exclusions](security.md#fact-authenticity-and-disclosure). A bearer without authentic invocation association leaves attribution unresolved. New credential dispatch requires established local evidence. Audit outage permits protective refusal/closure, not a newly claimed durable revoke.

## Currentness and closure

Authentication owns account/method/session validity and IAM owns exact authorization. The actual receiver owns execution assurance. Compute owns observation/termination, egress protected transport/streams, and credential owners deadlines, closure and provider cleanup. History records facts and implements none of those controls.

Only actual receiving verification supplies assignment, generation, component, admitted profile and original verification/expiry times. Protected evidence references require owner-authorized lookup. Compatibility records absent/unverified assurance. Serialized observations are not proof objects, leases or transferable authority. SVID/session strings do not prove physical origin.

Same-connection/request and current-serving evidence must remain in owner custody across waits and final dispatch/delivery fences. A withdrawn waiter cannot authorize acquisition or cancel another current waiter's work. The [identity currentness contract](https://github.com/openclaw/openclaw-enterprise/pull/247) owns this evidence. The actual [egress receiver](https://github.com/openclaw/openclaw-enterprise/pull/249) must consume it at the accepting transport.

The selected protected composition must measure **at most 30 seconds** from the defined authority-owner event to both new-work refusal and last protected bytes, including renewal-connectivity loss. Owners must specify the event, evidence age, clock/skew, monotonic deadline, cadence and closure reserve.

Preserve the separate integration supplier's [scoped five-second ceilings](https://github.com/openclaw/openclaw-enterprise/blob/65380694085693d6edb5218372ccddbc2ba493d9/packages/contracts/src/account-authority-v1.ts#L28) for dependency calls, operation starts, model rechecks and model closure. They are not global five-second revocation. These end-to-end guarantees remain unqualified. Timers or maintenance intervals are insufficient evidence.

Renewal cannot change owner, source grant/profile, generation or original absolute deadline. Enforced profiles cannot downgrade. Separately record route/stream closure, credential-session closure, provider cleanup, requested stop and observed termination. Durable runtime termination awaits Compute observation. Local closure proves no remote cancellation. Accepted external effects may stay possibly dispatched/unknown, retaining settlement custody.

## Acceptance and delivery

Run A/B/C through one genuine ordinary Agent/Harness turn and real managed Git child to an owner-approved read-only live GitHub repository. C must see B, separate Agent/revision executor, selected authority/session, truthful assurance, exact authorization/resource, durable acceptance and strongest result/unknown. Pod exec, controller Git and fixture submitters do not pass.

Exercise stale/cross-Agent/revision/session authority, duplicate/unknown dispatch, concurrent turns, revoke before final dispatch, local audit outage, runtime closure, off-Pod denial and secret/reference exclusion. Where replying natively, exercise audience change and unknown/late send without replay.

Qualify receiving and both withdrawal endpoints, renewal loss, delayed positives, blocked consumers and saturation on the same installed artifact. Keep source/database, composed, installed, controlled transport, live-provider and release evidence separate, with exact revisions, dependencies, cleanup and missing proof. These are future acceptance gates, not executed tests.

## Alternatives and follow-ups

A revision bearer or synthetic submitter is useful component evidence but cannot replace authentic requester attribution. Retain the existing owners rather than adding an OBS execution service.

Exact-container origin remains deferred until a stronger same-Pod guarantee is selected. Identity/Compute must prove real caller-to-incarnation receiving custody. Independent physical termination during controller/Compute failure remains later hardening, owned by Compute/trusted runtime supervision. It closes only with trusted expiry and measured observed stop. Neither weakens selected off-Pod protection or traffic withdrawal.

Future durable provider-cleanup recovery belongs to the credential owner and needs protected custody/recovery plus provider-observed outcomes.

<a id="design-and-failure-behavior"></a>
The design and failure behavior are in [admission](#admit-one-operation), [handoffs](#connect-authentic-handoffs) and [closure](#currentness-and-closure).
