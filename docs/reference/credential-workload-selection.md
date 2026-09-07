# Admitted credential workload selection

The credential subsection binds nonsecret credential selections to an existing admitted workload revision. It does not select a manifest, authenticate an owner, prove a runnable capability or authorize credential use.

## Association and selected values

Import the contract from `@openclaw-enterprise/contracts/credential-workload-selection-v1`. Its closed decoder preserves the existing four-field workload association (`manifestRef`, `manifestDigest`, `admissionRef`, `admissionVersion`), the five provider/runtime/identity/containment/storage role references and `admittedConfigurationDigest`.

A selection contains an exact Installation/Namespace/Agent scope and revision, the existing protected model binding, a repository profile/binding/grant, a protected material-selection record reference/version and one or two configured channel entries. Slack precedes Teams when both are selected. Channel kinds and module IDs are unique; Slack bot and app credentials use different logical references. These entries describe configured consumers, not proof that both channel implementations or suppliers exist.

Model bindings preserve API-key import and rotation ownership separately from trusted-login/workload-federation refresh ownership and access-token/account-context delivery. Repository profiles retain native, mediated and history-isolated mode values; accepting a mode in the value schema implements none of those clients or backends. The existing repository grant parser retains ordered repository IDs, permissions and read-only metadata semantics. Model/repository account, provider, scope and grant relationships must match their existing binding contracts.

Logical secret versions are positive integers. Kubernetes UID/resourceVersion, material fingerprints, token bytes, callback objects and current-authority handles are not fields of this subsection. Protected source owners retain physical source and material correspondence. An ordinary manifest or revision must not contain those sensitive values.

The subsection uses the existing whole-manifest/request maximum of 65,536 encoded bytes. It does not add another 65,536-byte allowance to the enclosing manifest. The bounded object decoder also limits depth, nodes and keys before validation/serialization; it rejects accessors, proxies, custom prototypes, symbols, sparse arrays, cycles/shared object aliases, invalid Unicode and unsupported numeric values. Successful results are detached and deeply immutable. A valid value is data only.

## Controller correspondence

`createAdmittedCredentialWorkloadInspectorV1` captures the actual original owner's fixed credential expectations and real planned startup binding. It returns no inspector if those inputs are invalid or disagree on scope/revision, material-selection record or configured channel modules. The binding must be an actual original planned/retained binding; do not invent startup/create identities to satisfy this function.

The inspector accepts the existing Runtime `selection.resolveLocked` lease type. Runtime alone acquires that lease and holds its original account/selection/lifetime protections. The Controller does not resolve a revision, open a transaction, borrow material or release the lease. Its original synchronous `assertCurrent` fences bracket the comparison; changed selection bytes or invalidation yield unavailable. The selected property must be a data property, and the synchronous guard must be an actual method, not an accessor or async function.

The Runtime-selected startup binding currently carries configuration/profile/revision/module correspondence, but not the new credential subsection or the admitted four-field association and five roles. The original revision/selection owner must pass the genuine subsection from that same admitted revision when wiring this inspector. A caller's JSON cannot provide the missing producer.

The comparison retains two digest domains: `admittedConfigurationDigest` belongs to the admitted complete configuration; `GatewayStartupBindingV1.configDigest` belongs to the actual native configuration binding. It compares each with its captured original counterpart and does not assume they are equal. Likewise the manifest's four-field association is distinct from the startup material-selection record reference/version.

Results are:

| Result                         | Meaning                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `corresponds`                  | Supplied metadata equals the captured credential and Runtime selection. Continue the original owner's remaining validation.                   |
| `mismatch: invalid-selection`  | The admitted subsection is invalid.                                                                                                           |
| `mismatch: admitted-selection` | Admitted credential/association values differ from the captured original expectations.                                                        |
| `mismatch: runtime-selection`  | The held startup selection differs from the fixed original binding.                                                                           |
| `unavailable`                  | The original synchronous guard or selected snapshot cannot be used consistently. Preserve the owner's uncertainty and cleanup responsibility. |

None of these results supplies a readiness decision, identity proof, current permission, delivery permit, issuance claim or cleanup-completion evidence. The inspector does not authenticate matching methods or objects; only the trusted original composition can provide its genuine participant. A synthetic comparison test does not qualify that participant.

## Admission, ownership and limits

The original workload profile/admission owner atomically freezes the credential subsection with the admitted revision and existing operation/work/audit association. It rejects a permanently missing executable/module/mode or mandatory implementation before physical create. A transient outage of a genuinely configured dependency leaves the original admitted intent nonserving. This comparator performs neither lifecycle transition.

The existing create owner remains the only physical creator. Independent Installation service identity, per-Agent assignment/process generation, human/common-grant authority and database login enrollment remain separate. Model/account authority, protected immutable source, native delivery, actual Teams token supplier and full Gateway assembly must be supplied by their existing owners. This change implements no inventory, schema, migration, issuer, refresh loop or recovery-capacity amendment.

The prior material borrower, physical reader and channel codec retain their original bounds and joined-use/late-cleanup rules. In particular, comparison does not release material, settle a pending native write, revive an unknown attempt or transfer a borrowed raw frame view outside its original use.

## Validation scope

The conformance test exercises closed metadata decoding, version/scope/account/grant relationships, selected-role and mode changes, distinct digest domains, mutable input detachment, original guard failure/invalidation, selection changes and preservation of release ownership. Its Runtime lease is explicitly a synthetic boundary double.

Independent producer and consumer fixtures import the public contract subpath. The consumer verifies that selected metadata cannot be assigned to nominal current-authority types and that nested selections remain immutable. Focused source/fixture checks provide no live Kubernetes, credential provider, model, native process or database qualification.
