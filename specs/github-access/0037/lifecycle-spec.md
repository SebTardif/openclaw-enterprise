# Persistent Agent and runtime lifecycle specification

This supporting specification contains the detailed requirements of
[RFC 0037](../0037-persistent-agent-runtime-lifecycle.md). It extends
[OCE’s Agent deployment](../../../docs/design/workloads.md#agent-deployment)
with a runtime baseline for mediated reads, direct push and minimal PR creation,
and later durable lifecycle intent, completed-state recovery, single-writer
handoff, and separately reported
outcomes. These are proposed requirements, not claims of implemented runtime
behavior. [RFC 0034](../0034-github-app-credentials.md) owns gateway operations
and credential profiles; approved-candidate publication remains future scope.

Work can outlive a process, but restart is not transparent continuation:
credentials change, writes remain unfinished, and provider operations may have
completed. Persisted stop intent, denied requests, process termination, and
credential cleanup are separate facts. If completed-state recovery is selected,
its first profile preserves Agent identity, completed context, files, and effect
receipts on compatible same-build, same-cluster retained storage. It does not
restore authority or replay interrupted actions.

## Read the specification

- [Runtime ownership, admission and writer exclusion](runtime-contract.md)
- [Recovery, stop and lifecycle qualification](recovery-and-qualification.md)
