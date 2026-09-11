# Agent application services

[AgentService](../../../packages/occ/src/services/agent/service.ts) owns draft
creation, editing, and authorized Agent and revision reads.
[DeploymentService](../../../packages/occ/src/services/deployment/service.ts) owns
admission, immutable snapshot construction, and retained-admission recovery.
The controller assembles both services with methods selected from the same
Installation-bound mutation runner and resolves selected Drivers when an
operation needs them. Existing controller methods delegate to these services.
The [Agent HTTP handlers](../../../apps/controller/src/routes/agent.ts) use the
current controller lazily; create and update keep mutation, success audit, and
response projection inside the existing outer transaction.

Deployment still commits the revision, runtime intent, admission proof, audit,
and reconciliation work as one unit. A caught admission failure poisons that
unit. If PostgreSQL commit acknowledgement is lost, the HTTP controller waits
for the failed unit to unwind and asks the deployment service to verify the
retained locator through a fresh storage read. Recovery checks the exact
Installation, Agent scope, actor, and request; an unavailable proof remains a
dependency failure. These services add no independent store or runtime worker.

For contributor checks, see [controller service testing](../../testing/controller.md).
