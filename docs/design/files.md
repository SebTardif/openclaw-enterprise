# Runtime files and durable state

This chapter owns file and state ownership in the authoritative
[platform target design](../design.md). It defines the direction for
[M1.2 (#76)](https://github.com/openclaw/openclaw-enterprise/issues/76) and
[pre-Agent files (#89)](https://github.com/openclaw/openclaw-enterprise/issues/89),
not shipped behavior. Today, dedicated Kubernetes execution still uses a common
workspace claim, and [workspace-file edits](../flows/workspace-files.md) write
through a reachable gateway to the running workspace.

## Decisions and benefits

Configuration-owned file defaults are copied independently into each Agent at
creation. Subsequent managed-file edits belong to that Agent and take effect only
on deployment. An immutable AgentRevision selects the exact managed contents for
both gateway and Harness before execution.

This separates durable intent from runtime location: saving files needs neither
a running gateway nor access to a tenant filesystem. It supports pre-Agent
configuration and lets dedicated gateway and Harness eventually occupy separate
clusters without changing file ownership. Initial realization may use distinct
namespaces in one cluster; cross-cluster operation is not required now.

Independent copies avoid live inheritance, override precedence, and accidental
changes to sibling Agents. Deployment-bound application reuses revision admission
and activation rather than adding coordinated live updates, between-turn
barriers, or concurrent-edit merging. It intentionally trades immediate updates
and automatic propagation of Configuration changes for a smaller, explicit model.
No separate file-bundle resource, generic synchronization service, or transfer
protocol is selected by this design.

Only dedicated gateways move toward the OCC control-plane runtime target.
Embedded gateway and Harness remain together as untrusted tenant execution;
the same managed-input ownership applies without requiring a network copy between
embedded components. See [runtime placement](workloads.md#openclaw-gateways).

## Managed input lifecycle

1. An authorized caller saves nonsecret file defaults on a same-Namespace
   Configuration, separately from its native runtime configuration. This can
   happen before any Agent exists. OCC owns the durable contents; a runtime
   filesystem is not their source of truth.
2. Agent creation authorizes use of that exact Configuration and atomically
   captures its selected defaults as Agent-owned desired files. A concurrent
   Configuration edit cannot produce a mixed copy. Failure creates neither a
   partially initialized Agent nor an incomplete file set.
3. Later Configuration changes, deletion where otherwise permitted, or changing
   the Agent's Configuration reference do not overwrite the copied files.
   Authorized edits change only that Agent's desired contents. Refreshing defaults,
   inheritance, and bulk propagation are not part of this iteration.
4. Deployment snapshots the Agent's exact desired contents into its immutable
   revision, either as content or durable content references. References must
   remain resolvable for the revision's retained lifetime; mutable Configuration
   pointers, expiring transfer URLs, and runtime paths are not snapshots.
5. Compute preparation materializes the selected inputs for both consumers and
   verifies their versions before activation. A later save does not mutate that
   revision or either running consumer. Redeployment is required to apply it.

Saving reports durable desired state, not runtime application. Reads and the
console must distinguish saved desired contents from the active revision's
contents. This deliberately replaces today's live gateway file-edit semantics;
the implementing API and UI change must make “saved; deployment required” clear.
There is no fallback from unavailable OCC storage to editing the running gateway.

The initial managed filenames remain `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and
`USER.md`, with existing UTF-8, size, and path validation. Absence is distinct from
an intentionally empty file. The implementation must resolve permitted native
defaults consistently before claiming both consumers have the intended inputs.
Adding `BOOTSTRAP.md`, `MEMORY.md`, arbitrary directories, or secrets requires a
separate lifecycle decision; these are not silently included in the file API.

Configuration writes and Agent writes retain their respective exact-resource
authorization. Copying additionally requires authorized access to the source;
possession of a content digest grants no access. Audit records identify actor,
scope, file/version, and outcome without recording content or credentials.

## Ownership and durability

Each category has one authoritative writer, not a shared multiwriter directory.
Runtime files remain scoped to one Namespace and Agent even in an OCC runtime
target.

| Category                                         | Authority and retention                                                                                             | Other consumer's view                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Managed files                                    | OCC holds Configuration defaults, independent Agent desired files, and immutable revision inputs.                   | Gateway and Harness receive the revision's selected contents before execution. Runtime edits never update OCC intent.             |
| Mutable working tree                             | The active Harness owns Agent-private working data, retained across workload replacement.                           | Gateway receives only explicit requested inputs or outputs; it does not mount or mirror the working tree.                         |
| Gateway sessions and conversation records        | Gateway owns durable Agent-private session records.                                                                 | Harness receives only the native execution context or read-only checkpoint needed for a turn; not a live session-directory mount. |
| Harness continuation state                       | Harness owns any nonsecret durable state required by its supported continuation mechanism.                          | Gateway holds only the protocol's opaque continuation references; credentials and whole runtime homes are not copied.             |
| Generated artifacts                              | Harness produces outputs; the designated Agent-scoped artifact destination durably accepts each published artifact. | Gateway consumes validated, immutable published outputs, not a writable mount into the Harness filesystem.                        |
| Bundled and plugin skills                        | Approved runtime image/plugin materialization produces the revision's selected asset set.                           | Harness receives a verified, read-only materialization. Harness output cannot replace trusted gateway code or skills.             |
| Gateway database, private agent state, and media | Gateway owns private durable storage with the filesystem semantics required by its database.                        | No Harness mount or whole-directory transfer. Explicit media inputs and outputs cross as bounded artifacts.                       |

Managed input paths and mutable working data have different replacement rules.
Runtime edits to materialized managed files are local execution changes, not
saved settings, and are not synchronized to the other consumer. Deployment
reapplies its selected managed files without deleting unrelated working data.
Automatic promotion or merging of runtime edits into OCC intent is out of scope.

An Agent's mutable state outlives a revision, but only the active writer may
mutate it. An idle candidate may stage immutable inputs; it must not write the
active revision's working tree or private stores. After verifying staged inputs,
replacement must stop or fence the previous writer and hand over mutable state
before enabling the replacement route. Unverifiable ownership fails closed.
Rolling back configuration does not rewind working data,
sessions, or already published artifacts.

Removing the common PVC does not remove persistence. Gateway SQLite storage must
still support its locking, WAL, and durability requirements; a live database
directory is not a file-transfer bundle. State retention and exact-owner cleanup
must account for both runtime targets and references still needed by retained
revisions. Backup policy, disaster recovery, and live state migration are separate
work, not guarantees supplied by transfer.

## Exchange and failure boundaries

The selected ComputeDriver owns preparation across both targets, using compatible
SandboxDriver materialization where required. No separate GatewayDriver or
FileTransferDriver is introduced. OpenShell may supply a concrete adapter, but
does not own canonical files or exempt transfers from these contracts. Existing
common-PVC mount requirements in either Driver must be replaced explicitly.

Every exchange binds the exact Namespace, Agent, admitted revision, purpose, and
content version. Authorized peers verify a bounded manifest of permitted relative
paths, lengths, and content digests; reject traversal, escaping links, unintended
file types, and over-limit content; and stage before publishing a complete set.
Digest verification provides integrity, not authorization. Returned data remains
untrusted even when transported into the control plane. Transport credentials,
model credentials, and workload identity are never workspace content.

- Failed or partial input transfer leaves the candidate unready, without replacing
  the active revision's files. Activation requires both consumers to confirm the
  exact required inputs. Missing content cannot become an empty/default fallback.
- An interrupted transfer can retry the same scoped immutable content idempotently.
  Lost acknowledgement is reconciled against its version; it does not justify
  replaying an Agent turn or an arbitrary filesystem mutation.
- An output is published only after its destination confirms durable acceptance.
  Transfer failure remains pending or failed, not a successful result with a broken
  artifact link. Unacknowledged output has no implied durability guarantee.
- Storage or ownership failure prevents unsafe activation or state handoff.
  Pre-activation staging failure leaves the previous revision serving where safe;
  failures after handoff begins require exact-owner recovery or traffic denial.

The concrete storage backend, wire protocol, transfer direction, quotas, and
native session exchange adapter are follow-up implementation choices. No choice
may require common namespace DNS, a cross-target PVC, shared Secret references,
or controller-wide credentials in the Harness.

File retention alone does not prove session continuation. The current dedicated
runtime has an [existing-session resume limitation](../reference/harness-execution.md#isolation-and-activation)
after gateway restart. Native continuation support and real replacement tests
are prerequisites for claiming that outcome; sentinel-file visibility is not
equivalent evidence.
