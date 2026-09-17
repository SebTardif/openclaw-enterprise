# Work Authority Specification

This supporting specification expands [RFC 0036](../0036-turn-bound-delegated-authority.md). It describes proposed behavior, not an implemented or qualified production guarantee.

Logical Work gives service-owned Enterprise Agents scoped authority across messages and model turns. The selected GitHub profile admits one root Work per execution for reads, direct push and minimal same-repository PR creation under an explicit immutable grant. Qualified subordinate helpers share its context, aggregate limits and stop ownership. Continuation across replacement attempts and independently admitted durable children remain later capabilities. OCC records the verified requester, service owner, immutable scope and explicit duration policy with any configured work horizon. Trusted services enforce finite, renewable leases tied to the original Work and exact execution. Invocation permission, service permission and data access remain separate.

The proposal extends [OCE’s IAM and authority model](../../../docs/design/access.md#iam-and-authority). Responsibilities across the series are:

| RFC                                                        | Responsibility                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [0034](../0034-github-app-credentials.md)                  | Provider credential mediation, broker access leases and credential replacement.         |
| [0035](../0035-workload-identity-and-runtime-authority.md) | Execution assignment, enforcement-lease issuance and withdrawal.                        |
| [0036](../0036-turn-bound-delegated-authority.md)          | Logical work admission and closure, bounded renewal authorization and attached lineage. |
| [0037](../0037-persistent-agent-runtime-lifecycle.md)      | Execution, recovery, completed-result delivery and runtime lifecycle.                   |

## Read the specification

- [Work admission and durable records](admission-and-records.md)
- [Operation enforcement and Work lifecycle](enforcement-and-lifecycle.md)
