# Repository business-use policy

`RepositoryWorkPolicyV2` describes the administrator-managed policy for one
service principal and one stable GitHub repository in an Installation, Namespace
and Agent. It is separate from token issuance, human manual-policy templates and
permission to administer the Agent.

The policy contains its reference, version, enabled/disabled state, exact scope,
service principal, GitHub host/App/installation/repository identifiers, repository
owner/name and profile revision, execution profile, permitted operations and
explicit time bounds. There is no built-in policy duration or automatic grant.

`metadata:read` permits only repository metadata reads. An explicit `git:read`
operation also requires `contents:read`; it retains `metadata:read`. Neither
operation permits publication or transparent writes. Declaring a Git read policy
does not install the transport or business operation that consumes it.

## Management and acquisition

The original State owner authenticates the operator, checks current Native IAM
`administer` on the exact Agent, applies version comparison and records the policy
change and audit in its transaction. The broker cannot mutate policy or select an
arbitrary policy record for a request.

The State selection source derives the current policy from the genuine admitted
execution and service/repository association. It lends a `RepositoryWorkHeldPolicyV2`
to the Work adapter in the same original State transaction. That lease contains
the actual policy document and retains currentness through the final synchronous
COMMIT check. A parser result or affirmative callback does not establish this
ownership.

## Original admission and fresh context

The admitted execution retains the policy reference, version, canonical digest,
complete execution association and original Work horizon. The evaluator requires
all of them to match the current held policy and execution. A policy change cannot
renew the eligibility of an old execution: the result is `fresh-context-required`.
New authority is applied through a new gVisor execution context. Historical Work,
dispatch, credential exposure and cleanup records remain retained.

The complete execution association includes the original attempt, assignment,
incarnation, generation, receiver, protected origin, profile and predecessor
termination evidence when present. The policy also compares actual service/scope,
repository target and profiles. Work begins within the policy interval, remains
within its configured maximum duration and keeps the exact admitted horizon.

## Data APIs and validation

- `parseRepositoryWorkPolicyV2` copies bounded data and rejects unknown fields,
  accessors, proxies, cycles, non-finite values, invalid identifiers and unselected
  operations. It returns immutable policy data or `undefined`.
- `repositoryWorkPolicyDigestV2` hashes canonical, key-sorted policy data. It does
  not normalize repository names, identifiers or policy values.
- `evaluateRepositoryWorkPolicyV2` returns comparison data or a closed refusal.
  It creates no private membership, transaction, execution or authority handle.
- `repositoryWorkPolicyArmMatchesV2` checks the constructor-selected V2 metadata
  arm or V3 Git arm with its exact ordered permissions. Unknown and crossed
  fields refuse.
- `evaluateRepositoryWorkProtocolPolicyV2` joins that arm to the existing policy
  evaluator for exactly the selected operation. A policy allowing both operations
  still returns only metadata permission to a V2 use.

The focused tests exercise these data semantics and the Work adapter's use of the
held policy. They do not replace real operator authentication, policy persistence,
State locks, execution admission or a complete repository flow.

The current Work policy projection keeps the original service, repository ID,
profile and `work.repository.use` purpose. V2 adds `permission: "metadata:read"`.
V3 instead adds `repositoryOperation: "git:read"` and the ordered
`requiredPermissions: ["contents:read", "metadata:read"]`. This data must equal
the original locked Work record and independently held current policy; it is not
a new token-issuance grant. Git policies retain the existing metadata operation
in their permitted operation list. Renewal and issuance remain separate rights.
