# Repository draft definitions

This slice implements authenticated Namespace-owned, always-unverified repository
binding definitions and typed Agent repository drafts on the current Agent and
State services. It does not activate repository deployment or introduce a new
selected-profile deployment API. The supported contract lives in
[Repository binding definitions and Agent drafts](../docs/reference/repository-drafts.md).

Bindings use exact IAM resources, signing-Secret operation permission, persisted
immutable ownership, and generation CAS.
PostgreSQL and memory State enforce ownership; PostgreSQL changes and audit events
commit atomically. Agent selection is bounded to eight entries and binding sets to
32 repository IDs. Repository deployment fails before Compute and queue effects;
cleared drafts retain the current deployment implementation.

The authenticated API is the configuration entry point. The normal bootstrap
administrator Role includes binding create/read/update/operate permissions.
No additional startup selector or console editor is required.

Future activation requires actual provider verification of numeric repository
membership, permissions, and checkout resolution, then immutable generation-bound
selection and protected runtime authority. The saved assertions in this slice
cannot substitute for any of those producers.
