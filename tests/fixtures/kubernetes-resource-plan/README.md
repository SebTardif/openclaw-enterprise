# Kubernetes resource-plan fixtures

These fixtures exercise immutable resource selection through the production
Kubernetes resource builder and selected Compute Driver. Resource accounting
uses the canonical versioned contract. Synthetic supplied quantities do not
establish production admission or effective resource allocation.

The builder consumer must cover the application and `prepare-private-state`
containers separately. Missing init resources, conflicting applicable defaults,
insufficient configured caps and tampered derived values are refused by the
actual renderer. Complete explicit container resources prevent LimitRange
defaults from supplying fields. The cap comparison is only a necessary declared
demand check; it supplies no current usage or namespace-placement evidence.

Public Driver tests exercise required-resource-mode refusal before client
initialization or hooks, including activation's runtime-disabled shortcut. There
is no positive protected association, injected owner implementation or request-
capturing Kubernetes client in these fixtures. The pre-aborted operation test
covers the existing entry guard before Driver execution. No cluster, runtime,
identity, effective metering, effect admission or physical termination evidence
is produced. The strict compiler fixture imports actual production source and
canonical contracts.
