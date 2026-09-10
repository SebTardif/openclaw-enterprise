# Plugin implementation DevBox continuation

Status: intermediary implementation, not release-ready. The user approved
simplifying specs23–26, implementation by subagents in separate worktrees, and
pushing this work for continuation on a leased DevBox.

## Branches and integration

Repository: `https://github.com/openclaw/openclaw-enterprise.git`.
Accepted specs commit: `090c90df4e5882970d931b6baa8d30919ec66a46`.
Implementation base: `277ed179f716b661ef72eaa283c74944a53a60d6`.

| Branch suffix under `dev/kevinlin/` | Purpose | Checkpoint |
| --- | --- | --- |
| `plugin-deployment-spec-swarm` | Combined integration and this handoff | Includes catalog, selection, initial runtime, composition through `d11dffe` |
| `plugin-catalog` | Shared contracts, generator, catalog loader | `b1dc2f410e38c8007b13592856613eb89e1e285a` |
| `plugin-selection-api` | Catalog API, selection persistence, revision snapshot | `c394596c5edbd969293d87c584b0ab6b64c9af7a` |
| `plugin-native-runtime` | Kubernetes native preparation | `6224ca15b13779a97d9fb1813c1eb630b0c35bd1` |
| `agent-deployment-status` | Durable errors, worker callback, status API | `932d784` |

Fetch and preserve every branch. Continue integration on the combined branch.
Already-integrated commits have different cherry-pick SHAs; compare patches.
Pending catalog commit: `b1dc2f410e38c8007b13592856613eb89e1e285a`.
Pending runtime commits: `fa943cb36fdb768d2943c073033724ec7988b013`
and `6224ca15b13779a97d9fb1813c1eb630b0c35bd1`.
The status branch is not yet integrated. Resolve shared contract, API, OCC,
fixture, documentation, and migration journal conflicts with both behaviors intact.
Migration0016 owns selections;0017 owns outcomes.0015 belongs to unrelated work
on the original machine and is not part of these branches; journal ordering
needs deliberate integration. Do not import unrelated canonical checkout changes.

## Contract to retain

- Required `GET /plugins?driverId=codex`; Installation administration authority.
- `plugins:[{driverId,pluginId}]` is optional Agent creation input, at most32
  unique identities. Agent collection create authority plus catalog authority
  for nonempty selections; namespace-create authority is insufficient.
- Deploy revalidates catalog and stores immutable server-resolved
  `selectedPlugins` snapshots. Native RPC `pluginName` is `remotePluginId`,
  not display `pluginName` or opaque catalog ID.
- `deploymentId` is the revision ID. Deploy returns202 with
  `{deploymentId,revision}`. Status reads the original reconcile job;
  running requires a live lease, superseded internal success is public failure,
  and plugin errors remain independent of terminal success/failure.
- Queue row is the durable plugin-failure owner. Compute uses
  `failedPluginIdentities` and awaited `reportPluginInstallFailure(identity)`.
  Validate tuple and live claim, persist before acknowledging cleanup.
- Native plugins initially target bundled Kubernetes dedicated Codex only.
  Candidate stays nonserving until exclusion and policy proof succeeds.
  Preserve native per-call approvals and denied tools; no remote uninstall.
- Console spec27 is a separate unapproved feature. Only adapting the existing
  deploy response consumer belongs here.

## Open review findings: resolve before acceptance

### Catalog and selection

1. Integrate the loader correction accepting schema-valid, reviewed empty
   bundled artifacts. Generator still requires an expected marketplace to be
   present; an absent collection is never an intentionally empty collection.
   Remove development-only `allowEmptyInventory:true` from composition; the
   updated loader has no such option.
2. HTTP `/plugins` reads mutable app options while OCC retains a copied map.
   Use one authoritative retained, validated catalog owner. Malformed or
   unavailable catalog produces sanitized503, independently of other startup.
3. Nonempty plugin Agent create checks dedicated mode/Compute but not the
   Configuration-resolved Harness. Resolve it after exact read authorization
   and reject unsupported Harness before persistence. Check Agent updates too.
4. Add real PostgreSQL JSONB read/write, revision snapshot, duplicate/malformed
   constraint tests. Existing selection tests are Fastify/in-memory coverage.

### Deployment status

1. In-memory `deployments.findDeployment` incorrectly requires a recorded
   operation when `recordOperations:false`. Any admitted revision remains
   queued with no worker; PostgreSQL must still use its real original job.
2. Update remaining `/deploy` consumers that treat `data` as the revision:
   `postgres-platform-state-kubernetes.test.mjs`,
   `production-tui-k3d-real.test.mjs`, `postgres-bootstrap-failures.test.mjs`,
   `kubernetes-compute-real.test.mjs`, and remaining
   `tests/helpers/harness-topology-k3d-real.mjs` callers. Use `data.revision`
   and assert `data.deploymentId === data.revision.id`.
3. SQL0017 must require JSON string identities. Text extraction and length
   checks alone can accept null/numeric/boolean values via SQL null semantics.
4. Add real queue/API PostgreSQL coverage for live-claim reporting, tuple
   validation, retries, complete/fail/superseded terminal writes, preservation,
   constraints/grants and exact GET status. Mapper-only tests do not prove this.

### Native runtime

1. Integrate canonical required `selectedPlugins` and `failedPluginIdentities`
   fixes; remove temporary shadow interfaces and optional compatibility paths.
2. Ensure newly reported failures remain excluded through activation and
   maintenance. Worker context reuse must not replay stale initial exclusions.
3. Re-read exact Pod immediately before exec; bind observed UID, owner labels,
   readiness and deletion state. Delete remains UID-preconditioned. Assess
   cancellation, outstanding RPCs and Pod replacement races explicitly.
4. Replace serialized substring absence checks with exact pinned response
   schemas, workspace scope, paging exhaustion, plugin capability attribution,
   native policy/enablement and collision checks. Missing/malformed/ambiguous
   evidence must fail closed. Current tests primarily prove mocked ordering.
5. Crucial pinned source gap: `plugin/installed` may return local-only success
   when remote installed-plugin fetch fails. Empty results alone do not prove
   failed plugins cannot reappear through backend synchronization. Establish a
   supported effective exclusion mechanism and proof; do not claim graceful
   success from this response alone. If unsupported, report the exact remaining
   capability boundary rather than weakening isolation or fabricating proof.
6. A reviewer called native `plugin/install` backend mutation a conflict with
   candidate privacy. Reconcile against the CURRENT accepted spec, which
   explicitly requests that RPC under the Agent identity; the prohibition on
   changing backend installed state is in the after-error cleanup paragraph.
   Separate authorized install effects from forbidden compensating cleanup.

## Verification and runtime evidence

Before implementation: typecheck, workspace, OpenAPI, formatting passed;
ordinary integration194 passed/85 environment skips; real PostgreSQL31
passed/12 environment skips. These are baseline results only.
Catalog focused tests and early typechecks passed. Selection API cases passed
in a combined focused run before disk pressure interrupted further testing.
Status mapper3 tests passed; its API suite had the known in-memory status
failure. Final combined checks have NOT passed.

No release inventory.json exists. Host Codex0.147 was rejected by the generator;
a disposable image binary was verified0.152.1 before Docker became unavailable.
Generate from actual pinned `plugin/list`, review intended marketplace
completeness/redistribution and safe field projection; do not invent IDs or
publish an unexplained empty result. Raw account captures/credentials stay private.
Official pinned source: `openai/codex` tag `rust-v0.152.1`, notably
`codex-rs/app-server/src/request_processors/plugins.rs` and app-server protocol.

The old host filled its disk; all pending work was preserved. Continue setup,
tests, strict review fixes and real proof on the leased DevBox. Use separate
implementation worktrees/subagents, preserve unrelated work, and never run
`npm run precommit`. Do not copy credentials or manually refresh Codex tokens.
Read repository instructions and relevant skills on the destination first.
