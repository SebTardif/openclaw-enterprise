# PluginDriver

The optional bundled PluginDriver supplies a trusted internal curated-catalog
interface. Shared translators and explicit legacy Compute components retain
native configuration and startup behavior. OCC owns Agent draft metadata,
exact-resource authorization, transactions, and immutable deployment admission.
The Driver does not install Agent packages in OCC.

**Current deployment boundary:** every nonempty saved Agent plugin map receives
HTTP `501` during deployment normalization, before material/candidate insertion
or provider workload work. The missing input is a real immutable workload-profile
binding for plugin artifacts and startup inputs. Driver selection, catalog
membership, and desired policy do not supply that binding. Absent/empty maps add
no plugin material and follow the existing plugin-free admission path.

The [Agent plugin reference](../agent-plugins.md) owns the API and policy vocabulary.
This page distinguishes internal catalog availability from legacy component
mappings and current admitted deployment.

## Selection and catalogs

Select at most one bundled implementation in trusted Installation YAML:

```yaml
drivers:
  plugin:
    id: occ-plugin
    configuration: {}
```

The Codex Driver accepts `configuration: {}` as a valid selection, but its
internal `listCatalog` then refuses because no native catalog reader is
configured. Configure the paired fields to supply that reader:

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
separate, operator-provisioned Codex profile with existing backend authentication.
The optional timeout defaults to 10,000 milliseconds and accepts 1–60,000.
Internal catalog reads start native app-server and use `plugin/list`; native
startup may update that profile's own cache. Do not reuse an operator's ordinary
Codex workspace.

No HTTP plugin inventory endpoint is exposed. An empty configuration permits
constructing the Driver and saving structurally valid Agent drafts; it does not
permit nonempty deployment. A successful configured catalog read also does not
remove the HTTP `501` boundary. Unknown options, arbitrary package selectors,
and external PluginDriver packages are rejected. All other required Installation
Driver selections remain necessary.

| Driver ID      | Implementation        | Internal catalog Harness context | Catalog source                                                                              |
| -------------- | --------------------- | -------------------------------- | ------------------------------------------------------------------------------------------- |
| `occ-plugin`   | `occ/openclaw-plugin` | Embedded OpenClaw                | Bundled catalog, including `occ-plugin:diffs` (`@openclaw/diffs`).                          |
| `codex-plugin` | `occ/codex-plugin`    | Dedicated Codex                  | Native `openai-curated-remote`, projected as `codex-plugin:<plugin>@openai-curated-remote`. |

The bundled OpenClaw catalog pins Diffs `2026.8.2` and npm integrity. The internal
Codex catalog reflects native curated metadata at read time. Linear and Google
Calendar are fixtures, not a production allowlist. API callers cannot select
arbitrary sources or versions. A catalog record is metadata, not proof of the
installed package or a complete immutable image/material set.

No PluginDriver selection is the default. Plugin-free deployment retains its
ordinary prerequisites. Saving desired selections does not require a catalog
read, and saved entries remain readable without their original Driver. SSH
continues to support only plugin-free embedded OpenClaw and rejects a nonempty
revision selection before host effects.

## Native mappings and limits

The table describes **retained translator and explicit legacy component behavior**.
It does not advertise current admitted Kubernetes plugin support. Legacy Docker
can select the separate plugin-aware startup programs; current public deployment
still rejects nonempty maps before that route could be reached. Runtime versions,
credentials, app mapping, and the OpenClaw-to-Codex bridge also constrain any
component result.

| Surface                                       | Legacy component behavior                                                                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenClaw `always` and enable/disable          | Set `plugins.entries.<id>.enabled`; enabled selections receive existing `tools.alsoAllow` plugin grants without removing operator restrictions.                 |
| OpenClaw `never`                              | Disable the selected plugin, blocking its owned execution surfaces.                                                                                             |
| OpenClaw `prompt`, `auto`, reviewer           | Startup failure; no equivalent generic native plugin approval control is implemented.                                                                           |
| Tool/category policy on catalog entries       | Startup failure when current curated entries do not expose reliable per-tool metadata to Enterprise.                                                            |
| Codex catalog LIST                            | Internal configured reader returns native `openai-curated-remote` entries; saved Agent drafts remain a separate read.                                           |
| Codex selected-app `auto`                     | Render native Codex apps/plugins enablement with the selected app `enabled:true`, plus a selected-only OpenClaw Codex bridge entry.                             |
| Codex selected-app `never` or `enabled:false` | Render the resolved install identity while omitting the native app entry and disabling the selected bridge entry so execution remains blocked.                  |
| Codex selected-app `approvalsReviewer`        | Render native app reviewer configuration for the selected app ID with `user` or `auto_review`.                                                                  |
| Codex `always`                                | Set per-plugin `allow_destructive_actions:true`; the bridge accepts supported approvals without prompting. Explicit `auto_review` is unsupported for this mode. |
| Codex `prompt`, category/tool modes           | Startup failure when every-call prompting or reliable tool metadata is unavailable.                                                                             |
| Codex empty desired set                       | Selection helper returns no plugin material; the original no-plugin entrypoint stays unchanged.                                                                 |

Native metadata and exact policy representability must be checked by the legacy
component. Unknown per-tool metadata is `tools:null`; unsupported tool/category
policy refuses translation. The requested trigger/reviewer semantics remain in
[the API vocabulary](../agent-plugins.md#approval-policy). A native setting alone
does not prove effective Agent behavior or qualify an immutable profile.

The historical `rust-v0.149.0` inspection did not establish a general selected-only
gate for every remote plugin skill and MCP surface. Retained curated-app helpers
use the existing OpenClaw Codex bridge with `allow_all_plugins:false` and one entry
per selected plugin. Historical bridge/native tests retain their original scope;
they are not current admission or arbitrary account-plugin support.

The current selection helper emits no runtime object for absent or valid empty
selections. Compute does not write a new baseline `config.toml`, enable features,
or inject a new program into the fixed renderer for that case. Existing installed
runtime behavior remains the original constructor's responsibility.

## Legacy component preparation and security

Historical revision snapshots and explicit legacy component inputs carry desired
IDs/policies and Driver identity. The legacy Docker path resolves native metadata
and applies nonsecret configuration within its own private runtime. It uses
separate plugin-aware exports from
[the maintained runtime module](../../../apps/controller/src/drivers/compute/runtime/runtime-entrypoints.ts).
The original fixed Kubernetes startup/readiness exports stay unchanged.

The OpenClaw helper installs the exact supported package version, refreshes native
registry state, and checks plugin ID, package name, runtime/install version,
recorded integrity, and containment of runtime source in the install path.
The Codex helper discovers and reads native metadata, writes the selected app and
bridge configuration, installs, rereads identity/version/app mapping, and checks
effective configuration before component readiness. Codex owns its private cache
layout; Enterprise does not parse its private cache records as proof.

These startup operations can resolve current catalog metadata on a later retry;
they do not establish immutable admission material. Old Kubernetes replacement or
egress-policy narratives describe historical source, not the current profile
path. Current Kubernetes refuses nonempty revision selections before provider
work and retains its original ConfigMap ownership, material comparison, target,
prepared holding, and cleanup checks.

Raw Configuration conflicting with fields owned by the translator remains an
error in that legacy component. OpenClaw selected entries and Codex
`values.plugins.entries.codex.config.codexPlugins` cannot become authority by
being copied from caller configuration. Credentials retain their original
Harness/ServiceAccount custody. No catalog query, package listing, rendered
bridge configuration, or direct MCP call proves admitted Agent behavior.

Agent approval policy remains separate from platform IAM and containment. These
components add no permission, sandbox, egress, filesystem, or OAuth authority.
Existing workload and managed policies remain mandatory. In a legacy native
installation, disabled or `never` selections may still be installed at account
scope while Agent-local policy blocks execution; Agent enablement is not
account-wide installation management.

## Source and verification

- [Bundled implementations](../../../apps/controller/src/drivers/plugin/index.ts).
- [Trusted selection](../../../apps/controller/src/composition/installation-config.ts).
- [Current candidate normalization](../../../packages/occ/src/services/deployment/candidate-normalization.ts).
- [Agent plugin flow](../../flows/agent-plugins.md).
- [Testing guide](../../testing/plugins.md) and [original proof requirements](../../../specs/16-plugin-driver.md#verification).

Source and contract tests can qualify these component interfaces and the current
refusal. They do not supply the missing immutable plugin binding or establish
live behavior for a new admitted deployment. Historical native results remain
scoped to their recorded source/runtime/account; this documentation change adds
no execution result.
