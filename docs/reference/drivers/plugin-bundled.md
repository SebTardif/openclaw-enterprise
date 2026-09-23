# Bundled PluginDriver implementations

Use this page to configure the bundled OpenClaw and Codex Plugin Drivers and
check their native policy mappings, preparation behavior, and limitations. The
[PluginDriver base contract](plugin.md) defines the exported interface and the
boundary between OCC, PluginDriver, and Compute. The [Agent plugin reference](../agent-plugins.md)
owns the API and policy vocabulary. Compare implementations in the
[PluginDriver feature matrix](plugin-matrix.md).

## Selection and catalogs

Select at most one bundled implementation in trusted Installation YAML:

```yaml
drivers:
  plugin:
    id: occ-plugin
    configuration: {}
```

Dedicated Codex Agents can use `configuration: {}`: startup resolves selections
with the Agent's projected credentials. An optional catalog reader supports the
Driver's internal `listCatalog` interface:

```yaml
drivers:
  plugin:
    id: codex-plugin
    configuration:
      codexExecutable: /opt/codex/bin/codex
      codexHome: /var/lib/occ/codex-catalog
      requestTimeoutMs: 10000
```

`codexExecutable` and `codexHome` must be supplied together. The home must be a
dedicated, operator-provisioned native Codex profile with existing Codex backend
authentication. The optional timeout defaults to 10,000 milliseconds and accepts
1–60,000. Catalog reads start native app-server and use `plugin/list`; native
startup may update that profile's own cache. Use a separate profile from the
operator's ordinary Codex workspace.

An empty Codex Driver configuration permits Agent writes and deployment without
controller-side catalog discovery. No HTTP plugin inventory endpoint is exposed. Agent startup uses
its own projected credentials to resolve its selections independently of this
reader. Unknown options, arbitrary package selectors, and external PluginDriver
packages are rejected. Existing required Driver selections remain necessary.

| Driver ID      | Implementation        | Agent Harness     | Catalog source                                                                                                   |
| -------------- | --------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `occ-plugin`   | `occ/openclaw-plugin` | Embedded OpenClaw | Bundled OpenClaw catalog, including `occ-plugin:diffs` (`@openclaw/diffs`).                                      |
| `codex-plugin` | `occ/codex-plugin`    | Dedicated Codex   | Existing native Codex `openai-curated-remote` catalog, exposed as `codex-plugin:<plugin>@openai-curated-remote`. |

The OpenClaw catalog is bounded and pins Diffs `2026.8.2` plus npm integrity.
The Codex catalog is discovered from the existing native curated marketplace at
list/read time; Linear and Google Calendar are test fixtures, not production
allowlist entries. API callers cannot choose arbitrary sources or versions.
Startup resolves the current native identity, app mapping, and release metadata
for each requested catalog ID.

Codex app mappings come only from concrete `plugin/read` entries in `detail.apps`.
The Driver ignores `appTemplates` metadata, including materialized app IDs; an
ID listed only in a template receives no policy grant. An app also present in
`detail.apps` receives the selected policy normally. Plugins with no concrete
apps remain unsupported. Template resolution and lifecycle handling are deferred.

No PluginDriver selection is the default. Existing plugin-free deployments
remain permitted. Saving Agent plugin selections does not require catalog
membership validation. Nonempty selections cannot start with a missing,
changed, or Harness-incompatible Driver. Saved entries remain listable without
their original Driver.

SSH Compute currently rejects every nonempty requested plugin map before host
effects. It can run embedded OpenClaw revisions only when their requested plugin
set is empty.

## Native mappings and limits

Native policy takes effect only when the complete requested behavior can be
represented during Agent startup. Unsupported combinations fail or leave the
candidate unready with startup diagnostics; they are not authentication or
installation errors. Runtime versions and the OpenClaw-to-Codex projection also
constrain support: a native Codex setting alone does not prove the effective
Agent thread retains it.

| Surface                                                             | Translation and limits                                                                                                                                                           |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native OpenClaw plugin `always`, `never`, enable/disable            | Set plugin enablement and compose tool grants with existing restrictions. `never` disables the plugin.                                                                           |
| Native OpenClaw `prompt`, `auto`, reviewer, tool/category overrides | Rejected at startup; this Driver remains plugin-level only.                                                                                                                      |
| Codex plugin and per-tool `always`                                  | Emit native `approval_mode: "approve"`; no added approval, including when the app reviewer is `auto_review`.                                                                     |
| Codex plugin and per-tool `auto` / `prompt`                         | Emit native `auto` / `prompt`: annotation and remembered-approval behavior, or review of every call. Requires policy preservation through the OpenClaw bridge.                   |
| Codex `never`                                                       | Deny by default; an explicit allowed tool/category exception can remain enabled. Explicit plugin disablement and installation failure remain terminal.                           |
| Codex `approvalsReviewer`                                           | Emit app-level `user` or `auto_review`; per-tool policies inherit it. Omission inherits native reviewer settings.                                                                |
| Codex tool/category overrides                                       | Discover authenticated tool metadata after install; compile effective modes into native per-tool enablement and approval settings. Missing or ambiguous identities fail startup. |
| Codex empty desired set                                             | Apply a plugin-free native configuration; no remote install RPC runs.                                                                                                            |

Codex tool discovery reads paginated `mcpServerStatus/list` with
`detail: "toolsAndAuthOnly"`. Each raw `tool.name` must belong to a concrete
selected app through `_meta.connector_id`; display names and inferred prefixes
are not tool identities. The public controller catalog remains `tools:null`.
This authenticated inventory belongs to the Agent runtime, not OCC.

Explicit tool mode wins over the stricter applicable category, then the plugin
default. A tool is a write unless `readOnlyHint` is explicitly true; it is
potentially destructive unless `destructiveHint` is explicitly false. Missing
annotations are conservative. Explicit plugin/tool disablement and failed
installation cannot be undone by a mode override. Native managed policy and
other runtime restrictions still apply.

For a selection with tool/category overrides, the translator sets
`default_tools_enabled:false` and writes an effective entry for every observed
tool in its selected apps. This is the authenticated inventory available at
startup, not a complete provider inventory. Requests for tools outside the
observed app mapping fail startup. Codex also falls back to a tool's display
title when looking up app policy: a new tool with a title equal to an enabled
policy key can inherit that grant. The disabled default therefore does not
guarantee denial of every unobserved tool. Exact future-tool protection requires
a Codex runtime change; the next startup only recompiles the then-observed
inventory.

The Codex boundary remains concrete hosted apps. Marketplace visibility does
not admit arbitrary skills, hooks, standalone MCP servers, scheduled tasks, or
template-only app identities. The bridge keeps `allow_all_plugins:false`, sets
`codexPlugins.enabled:true`, and writes one entry per selected plugin.

The [API policy vocabulary](../agent-plugins.md#approval-policy) separates when
review is required from who reviews it. Native Codex `approve` skips the review
step; an app-level `auto_review` reviewer does not add one. `prompt` requires an
effective approval posture that cannot bypass review through full access.
The OpenClaw bridge must preserve the compiled app/tool settings:
[OpenClaw #151260](https://github.com/openclaw/openclaw/pull/151260) and a
compatible runtime image remain prerequisites. The overlapping plugin-level
prompt work in [OCE #227](https://github.com/openclaw/openclaw-enterprise/pull/227)
is pending. Emitted configuration and fixture checks do not establish normal
Agent execution; see the [runtime proof notes](../../testing/plugins.md#current-proof-notes).

Dedicated Codex starts without user plugins/apps, including when no PluginDriver
is selected. Compute writes the safe baseline into the Agent's isolated
`CODEX_HOME`, with native plugin loading and remote plugin loading disabled.
When a supported curated Codex app is selected, startup reads native catalog
detail, writes the selected app entry with `enabled:true`, and applies the
selected-only OpenClaw bridge configuration during native preparation. The
Driver's optional internal catalog reader remains available; the required OpenClaw Codex
transport plugin is separate infrastructure. Operator plugin directories and
configuration are never imported.

The Driver rejects conflicting raw Configuration for its managed fields rather
than silently overwriting it. For OpenClaw, this includes an existing selected
plugin entry in `values.plugins.entries` whose JSON differs from the managed entry.
For Codex, a differing
`values.plugins.entries.codex.config.codexPlugins` bridge selection conflicts
with Driver ownership. Identical managed entries are accepted. An enabled native
plugin entry also conflicts with `plugins.enabled:false`, a matching
`plugins.deny` entry, or a nonempty `plugins.allow` that excludes it. This includes
the Codex transport plugin required by selected Codex apps. Disabled and `never`
OpenClaw selections can remain denied. Gateway startup rejects these conflicts
before OpenClaw package installation or starting the Gateway; Agent writes still
save structurally valid desired state. Native configuration outside managed
fields, including tool denies and profiles, is retained.

## Preparation and security

Revision plugin state carries only requested IDs/policies and selected Driver
identity. Compute resolves current native metadata and applies the resulting
nonsecret configuration inside the exact revision workload before readiness. Codex installation is verified through native API metadata and effective configuration. Codex owns its private cache layout and integrity; Enterprise does not parse its cache records or version directories.
Package files/configuration are revision-private. In Kubernetes, the native
installation registry remains in the persistent Agent-owned OpenClaw state
database. Existing embedded-gateway preparation leaves a different active
revision running; activation replaces it with a `Recreate` Deployment. The new
process installs only after the old gateway stops. This uses the existing
serialized lifecycle, with no database copy or plugin-specific coordinator.
Docker keeps native state in the replacement container's private temporary home.

OpenClaw preparation installs the supported exact npm version with
`plugins install --no-enable`, preserving plugin allow/deny lists and entry
settings. It refreshes the native registry, reapplies the requested policy to its
private writable configuration, and checks plugin ID, package name,
runtime/install version, recorded integrity, and that the runtime source resolves
within the resolved install path. This requires an OpenClaw runtime that supports
`--no-enable`; the currently pinned `2026.9.1` image must be updated before this
preparation path can ship. There is no fallback to installation that changes policy.
Identity, integrity, or effective-policy verification failure prevents the
replacement gateway from starting. A confirmed installation rejection can instead
disable that optional selection and produce a warning. The previous revision
record remains stored, but the worker does not restore the old active pointer:
it retains the candidate pointer and retries. This does not promise uninterrupted
availability or automatic rollback during replacement. Retries reuse the
requested IDs/policies and may resolve the current curated release at that
later startup.
Codex preparation writes native Codex configuration and, for supported curated
Codex apps, applies the separate OpenClaw Codex bridge configuration with
`allow_all_plugins:false` and one entry per selected plugin. Compute owns the native
installation and readiness path; the PluginDriver only translates requested state
after native discovery.

During native installation, the runtime preserves the admitted plugin map key
for each selected operation. Only two typed native observations become
attributed plugin warnings: a matching selected install failure, or a
successful Codex install response with nonempty apps that still need
authentication. The startup result includes only `{pluginId, code}` with
`PLUGIN_INSTALL_FAILED` or `PLUGIN_AUTH_REQUIRED`; it does not emit native text,
command output, credentials, or deployment IDs. Errors from discovery,
configuration, policy translation, transport, signals, cancellation, malformed
responses, or unknown exceptions remain ordinary startup failures.

Credentials use the existing Harness/ServiceAccount path at runtime. A direct
MCP call, package listing, or rendered bridge configuration cannot prove native
Agent behavior; contributor fixture setup and proof notes live in
[Agent plugin testing](../../testing/plugins.md).

Agent plugin approval is separate from platform IAM and workload containment.
This Driver adds no sandbox, egress grant, filesystem grant, approval service,
OAuth interface, or permission hook. Existing workload and managed policies
remain mandatory. Package preparation preserves other Agents' state and does
not write the shared native registry while the prior gateway is running.

## Source and verification

- [Bundled implementations](../../../apps/controller/src/drivers/plugin/index.ts).
- [Trusted selection](../../../apps/controller/src/composition/installation-config.ts).
- [Agent plugin runtime flow](../../flows/agent-plugins.md).
- [Deployment guide](../../guides/deploy.md), [testing guide](../../testing/plugins.md), and [implementation proof requirements](../../../specs/16-plugin-driver.md#verification).

Source and contract tests do not establish compatibility with every runtime
image. Native proof requires the testing guide's opt-in real-runtime lane.

Explicitly disabled Codex selections skip installation; existing installations
are not uninstalled. A `never` default with `enabled:true` can still install the
selection, while its effective policy blocks calls without an allowed exception.
Native remote installation can enable a plugin on the credential’s account.
Agent enablement governs local execution, not account-wide installation state.
