# Plugin policy support and translation plan

Use this matrix when extending [runtime-translator.ts](runtime-translator.ts).
The [Agent plugin reference](../../../../../docs/reference/agent-plugins.md#approval-policy)
owns policy semantics; the [Driver feature matrix](../../../../../docs/reference/drivers/plugin-matrix.md)
records the product surface. This page separates translation support from harness
capabilities and the work still needed to verify deployment behavior.

Reviewed 2026-09-23 for the Codex tool-policy change based on OCE `7b60db6c`,
against OpenClaw `096f145632` and pinned Codex `0.156.0` (`476ac1aae3`).
The [runtime image](../../../../../deploy/runtime/Dockerfile) still pins
OpenClaw `2026.9.1`. Codex policy preservation requires a compatible bridge and
image; native OpenClaw installation separately requires `plugins install --no-enable`. Source and fixture evidence do not establish either packaged
runtime compatibility or a real Agent turn.

## Plugin policies

Each Agent selects plugins. Each plugin has its own defaults and may contain
policy overrides for individual tools:

```text
Agent.plugins[pluginId]
  enabled
  approvalMode
  approvalsReviewer
  writes
  destructiveActions
  tools[toolName]
    enabled
    approvalMode
```

The tables describe OCE translation in this implementation, including
[PR #340](https://github.com/openclaw/openclaw-enterprise/pull/340).
**Translated** means accepted and emitted; **Inherited** means resolved from
plugin policy; **Rejected** means the requested policy is unsupported by the
translator. Translation does not establish live deployment enforcement.

Codex scope is concrete hosted apps from `plugin/read` in the curated
marketplace. Native OpenClaw scope is the admitted catalog, currently Diffs.
The runtime prerequisites above apply to all translated rows.

### Plugin level: `plugins[pluginId]`

These fields control the plugin and provide defaults for its tools.
`writes` and `destructiveActions` belong here: each selects an approval mode
for a category of tools within this plugin.

| Policy                                               | Meaning                                      | Codex translation                                             | Native OpenClaw translation             |
| ---------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| `enabled: true / false`                              | Enable or disable the plugin                 | Translated; `false` blocks every tool                         | Translated; `false` disables the plugin |
| `approvalMode: always`                               | Default to no added approval                 | Translated to `approve`                                       | Translated                              |
| `approvalMode: never`                                | Default to denying calls                     | Translated; explicit tool/category exceptions can allow calls | Translated by disabling the plugin      |
| `approvalMode: auto`                                 | Let the runtime decide when review is needed | Translated                                                    | Rejected                                |
| `approvalMode: prompt`                               | Request review for every call                | Translated; bridge preservation required                      | Rejected                                |
| `approvalsReviewer: user`                            | Use human review when review is required     | Translated; inherited by tools                                | Rejected                                |
| `approvalsReviewer: auto_review`                     | Use automatic review when review is required | Translated; inherited by tools                                | Rejected                                |
| `writes: always / never / auto / prompt`             | Set the mode for write tools                 | Translated from tool annotations                              | Rejected; classifications unavailable   |
| `destructiveActions: always / never / auto / prompt` | Set the mode for destructive tools           | Translated from tool annotations                              | Rejected; classifications unavailable   |

`auto` selects **when** review is needed; `auto_review` selects **who** reviews.
Codex accepts `always` with either reviewer: native `approve` skips the added
review, subject to managed requirements. An omitted plugin reviewer inherits
native settings.

### Tool level within a plugin: `plugins[pluginId].tools[toolName]`

A tool entry overrides policy for one tool in its parent plugin. It contains
`enabled`, `approvalMode`, or both. Native OpenClaw tool-level translation is
deferred; its translator currently rejects any `tools` map.

| Policy                 | Meaning                                                       | Codex translation                               | Native OpenClaw translation            |
| ---------------------- | ------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------- |
| `enabled: false`       | Disable this tool regardless of its approval mode             | Translated                                      | Rejected; deferred                     |
| `enabled: true`        | Permit availability subject to the effective approval policy  | Translated; does not override `never` by itself | Rejected; deferred                     |
| `approvalMode: always` | Override category/default mode with no added approval         | Translated to `approve`                         | Rejected; deferred                     |
| `approvalMode: never`  | Deny this tool                                                | Translated by disabling the tool                | Rejected; deferred                     |
| `approvalMode: auto`   | Override category/default mode with runtime-selected review   | Translated                                      | Rejected; deferred                     |
| `approvalMode: prompt` | Override category/default mode with every-call review         | Translated; bridge preservation required        | Rejected; deferred                     |
| `approvalMode` omitted | Use the stricter applicable category, then the plugin default | Inherited; resolved by the translator           | Rejected when a tool entry is supplied |

Tools inherit the plugin reviewer. There is no tool-level `approvalsReviewer`,
`writes`, or `destructiveActions` field. An omitted tool `enabled` does not
add a disable, but inherited `never` still denies the tool. A tool override
cannot re-enable an explicitly disabled plugin or bypass installation failure.

[OpenClaw #151260](https://github.com/openclaw/openclaw/pull/151260) and a
compatible runtime image remain prerequisites for preserving the translated
app policy in the final Codex thread. The pending
[OCE #227](https://github.com/openclaw/openclaw-enterprise/pull/227) overlaps
plugin-level `prompt` translation. The source support above does not claim that
these changes have landed or that a reviewed tool call has completed.

## Codex tool discovery and compilation

The public controller catalog still returns `tools:null`. Startup discovers
tools inside the authenticated Agent runtime after installation, using all pages
of `mcpServerStatus/list` with `detail: toolsAndAuthOnly`. It joins raw tool
`name` and `_meta.connector_id` to concrete selected `plugin/read.apps` IDs.
Display names, titles, and template-only app metadata are not policy identities.
Unknown requested tool IDs, ambiguous identities, failed discovery, or a selected
app without authenticated tool inventory prevent readiness.

For each observed tool, compilation applies:

1. Explicit plugin/tool disablement and installation failure block execution.
2. An explicit tool approval mode overrides category and plugin defaults.
3. Otherwise the stricter applicable category wins: `never > prompt > auto > always`.
4. Otherwise the plugin approval mode applies.

A tool belongs to `writes` unless `readOnlyHint` is exactly `true`, and to
`destructiveActions` unless `destructiveHint` is exactly `false`. Missing
annotations therefore receive conservative category treatment. This classification
is separate from Codex's native `auto` review predicate.

Each selected app with tool/category policy receives `default_tools_enabled:false`
and explicit settings for its observed tools. This is an authenticated inventory
snapshot, not a complete provider tool inventory. Native server filters and
authentication can limit discovery; existing runtime and managed restrictions
still apply to enabled tools.

Pinned Codex falls back from a raw tool name to its display title when looking
up app tool policy. A future tool whose title matches an enabled policy key can
therefore inherit that policy despite the disabled default. OCE cannot guarantee
denial of every unobserved or future tool with these settings. Exact future-tool
protection requires a Codex runtime change; none is included here. The next
runtime preparation rediscovers inventory and recompiles observed tool policy.

Startup verifies installation identity and effective configuration before
readiness. The [testing guide](../../../../../docs/testing/plugins.md#current-proof-notes)
separates translator/startup fixture coverage from the real deployment test.

## Other tool surfaces

These are harness surfaces, not additional OCE `Agent.plugins` implementations.
A JSON argument schema or model-provider choice does not establish policy support.

| Surface                                 | Existing harness controls                                                                               | Additional OCE-style coverage                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Native MCP servers in Codex             | Server/tool filters, default and per-tool approval modes, annotation-based review, human/model reviewer | Translate policy and metadata. Non-app MCP uses the thread reviewer. OC projection exposes only part of the native Codex surface. |
| MCP tools in embedded OC                | Include/exclude filters, shared before-tool-call gate, MCP annotations                                  | Integrate human approval and category translation; generic model review needs runtime work.                                       |
| OC tools exposed as Codex dynamic tools | Host execution callbacks; MCP bridge has host-side approval handling                                    | Enforce at the host boundary. Dynamic tools do not inherit native Codex app/MCP policy.                                           |
| OC shell `exec` on gateway/node         | Dedicated deny/allowlist/ask/auto/full modes, human approval, shell model reviewer                      | Adapt shell semantics; these are not generic plugin controls. `ask` reviews allowlist misses, not every call.                     |
| Other OC built-in tools                 | Tool allow/deny and shared policy hooks                                                                 | Reuse human approval transport; supply category metadata and integrate a general automatic reviewer.                              |

## Remaining work, easier first

Native OpenClaw remains plugin-level by decision.
[OCE #312](https://github.com/openclaw/openclaw-enterprise/pull/312) and
[OCE #313](https://github.com/openclaw/openclaw-enterprise/pull/313) are open and deferred;
their native per-tool changes are not included here. The following is a future
ordering, not approval to add configuration or storage contracts.

1. **Verify Codex deployment behavior.** Finish bridge preservation and the
   compatible image, then run the existing real Agent scenario for observed
   tool/category policy. Exact future-tool protection additionally needs a Codex
   runtime change to prevent title fallback from granting a new tool. Human/model
   review interactions still need real proof.
2. **If native per-tool work resumes, establish trusted identities.** Existing
   allow/deny controls can support enablement and `always`/`never`, but policy
   tool names also share a namespace with plugin owners. Reject ambiguous
   partial denials; preserve operator denies and optional-tool grants.
3. **Integrate native human prompting.** Reuse trusted policy hooks and existing
   approval delivery/wait/resolve APIs. Bind approval to the final executed
   arguments and revalidate live run authority after awaited work. Ordinary
   hooks can rewrite arguments after the trusted-policy stage, so transport
   reuse alone does not establish that guarantee.
4. **Add native category metadata.** Manifest `sideEffecting` does not establish
   read-only or destructive classification. Supply reliable classifications
   before translating category policy; do not infer them from tool names.
5. **Add native `auto` and automatic review.** Define review triggers and
   remembered grants separately from reviewer selection. Extend the hardened
   reviewer beyond its current shell/board-widget requests with bounded native
   tool input, strict decisions, cancellation, timeout, and completion checks.
   A raw model completion is insufficient.

The [native policy proposal](../../../../../specs/35-native-plugin-tool-policy.md)
remains a proposal; it does not authorize its configuration or persistence design.

## Evidence and maintenance

- OCE: [translator](runtime-translator.ts),
  [startup](../compute/kubernetes/runtime-entrypoints.ts),
  [API schema](../../../../../packages/contracts/src/api/resources.ts), and
  [runtime proof notes](../../../../../docs/testing/plugins.md).
- Pinned Codex: [app/tool policy precedence](https://github.com/openai/codex/blob/476ac1aae33835e6e4c2d311c254b9b6ce9b2f4c/codex-rs/connectors/src/app_tool_policy.rs#L178-L240),
  [app/tool settings](https://github.com/openai/codex/blob/476ac1aae33835e6e4c2d311c254b9b6ce9b2f4c/codex-rs/config/src/types.rs#L451-L535),
  [approval short circuit](https://github.com/openai/codex/blob/476ac1aae33835e6e4c2d311c254b9b6ce9b2f4c/codex-rs/core/src/mcp_tool_call.rs#L1478-L1503),
  [annotation predicate](https://github.com/openai/codex/blob/476ac1aae33835e6e4c2d311c254b9b6ce9b2f4c/codex-rs/core/src/mcp_tool_call.rs#L2420-L2450), and
  [reviewer scope](https://github.com/openai/codex/blob/476ac1aae33835e6e4c2d311c254b9b6ce9b2f4c/codex-rs/core/src/connectors.rs#L514-L550).
- OpenClaw: [trusted policy registration](https://github.com/openclaw/openclaw/blob/096f14563272950e3c54fc0dc9554e7529d7b222/src/plugins/host-hooks.ts),
  [tool metadata](https://github.com/openclaw/openclaw/blob/096f14563272950e3c54fc0dc9554e7529d7b222/src/plugins/manifest-types.ts),
  [policy/hook ordering](https://github.com/openclaw/openclaw/blob/096f14563272950e3c54fc0dc9554e7529d7b222/src/agents/agent-tools.before-tool-call.policy.ts),
  [model reviewer](https://github.com/openclaw/openclaw/blob/096f14563272950e3c54fc0dc9554e7529d7b222/src/agents/exec-auto-reviewer.ts), and
  [Codex policy projection](https://github.com/openclaw/openclaw/blob/096f14563272950e3c54fc0dc9554e7529d7b222/extensions/codex/src/app-server/plugin-thread-config.ts).

Update this page, the owning product reference, and feature matrix together.
Record real deployment proof in the testing guide; do not infer it from emitted
configuration or an upstream merge.
