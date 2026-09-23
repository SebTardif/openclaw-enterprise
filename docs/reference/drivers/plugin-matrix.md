# PluginDriver feature matrix

Compare `occ-plugin` (`occ/openclaw-plugin`, embedded OpenClaw) with
`codex-plugin` (`occ/codex-plugin`, dedicated Codex) before selecting plugin
policy. This is a source snapshot of OpenClaw Enterprise (OCE), with the commit
and review date below. The [PluginDriver reference](plugin.md) owns Driver
selection and native limits; [Agent plugins](../agent-plugins.md) owns API semantics.

For harness capabilities beyond current translation and the proposed iteration
order, see the [policy translation plan](../../../apps/controller/src/drivers/plugin/policy-support.md)
beside the translator.

The [local docs preview](../../local-preview.md) adds search, category/status
filters, and expandable evidence. A status filter matches either Driver's cell.
GitHub shows the generated table with caveats and source/test links.
Both views use the [same matrix data](../../assets/plugin-driver-matrix.json).
The eight rows focus on plugin discovery and approval policy.
Each **Scope** cell explains what the capability means. Open a Driver status
to see its behavior, caveats, and evidence. Search includes the explanations.

- **Supported**: source provides the scoped behavior.
- **Partial**: a material constraint appears in the cell.
- **Unsupported**: rejected or unavailable through this implementation.
- **Not applicable**: the surface belongs to a different Harness or owner.
- **Unknown**: available evidence cannot establish support.

`prompt_human` and `prompt_auto_review` are display labels for
`approvalMode: prompt` with `approvalsReviewer: user` or `auto_review`,
respectively. The API accepts `always`, `auto`, `never`, and `prompt` as modes;
it does not accept either display label as an `approvalMode` value. Dedicated
Codex translates both combinations; native OpenClaw rejects them. Codex tool
policies inherit the plugin reviewer.

Saving valid policy does not prove native enforcement. Support describes the
scoped implementation, not production certification or a successful model turn.
Test links identify coverage; no live runtime was exercised for this review.
The [plugin testing guide](../../testing/plugins.md#current-proof-notes) records
older runtime results and current prerequisites. Preserving Codex app policy
requires OpenClaw #151260 and a compatible image; the new tool/category path has
not been proved through a real Agent turn. The controller catalog remains
`tools:null`; dedicated Codex discovers authenticated tool metadata inside the
Agent during startup. Translation covers that observed inventory. Pinned Codex
can match future tools by display title to an enabled policy key, so disabled
defaults do not guarantee denial of every future tool; exact protection needs a
Codex runtime change. Upstream capabilities alone do not establish OCE support.

<!-- plugin-matrix:start -->

<!-- Generated from docs/assets/plugin-driver-matrix.json; run node scripts/generate-plugin-matrix.mjs. -->

Reviewed 2026-09-23 at [dev/stevenlee/codex-plugin-tool-policies](https://github.com/openclaw/openclaw-enterprise/tree/dev/stevenlee/codex-plugin-tool-policies).

<!-- prettier-ignore -->
| Capability | Scope | occ-plugin (embedded OpenClaw) | codex-plugin (dedicated Codex) |
| --- | --- | --- | --- |
| LIST/QUERY plugins | Discover available plugins through the controller catalog and HTTP inventory. Whether OCC and API clients can list available plugins. Agent reads show saved selections; they do not query the available catalog. | **✓ Partial.** Internal listCatalog returns the bundled Diffs catalog. No HTTP plugin inventory or catalog-query endpoint is exposed.<br>Source: [apps/controller/src/drivers/plugin/index.ts:144-147](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/apps/controller/src/drivers/plugin/index.ts#L144-L147)<br>Test coverage: [tests/conformance/plugin-driver.test.mjs:151-162](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-driver.test.mjs#L151-L162) | **✓ Partial.** Internal listCatalog requires paired codexExecutable/codexHome and a ChatGPT-backed profile. No HTTP plugin inventory or catalog-query endpoint is exposed.<br>Source: [apps/controller/src/drivers/plugin/index.ts:150-178](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/apps/controller/src/drivers/plugin/index.ts#L150-L178)<br>Test coverage: [tests/conformance/plugin-driver.test.mjs:212-268](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-driver.test.mjs#L212-L268) |
| approval mode: always | Run without a plugin approval prompt. Request plugin calls without asking for approval. Other platform permissions and workload restrictions still apply. | **✓ Supported.** Enable the selected plugin without a plugin approval step; other native restrictions still apply.<br>Source: [apps/controller/src/drivers/plugin/runtime-translator.ts:630-681](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/apps/controller/src/drivers/plugin/runtime-translator.ts#L630-L681)<br>Test coverage: [tests/conformance/plugin-driver.test.mjs:165-182](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-driver.test.mjs#L165-L182) | **✓ Supported.** Translate to native approve, including with auto_review; approval mode decides whether review is needed. Other runtime restrictions still apply.<br>Source: [apps/controller/src/drivers/plugin/runtime-translator.ts:565-629](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/apps/controller/src/drivers/plugin/runtime-translator.ts#L565-L629)<br>Test coverage: [tests/conformance/plugin-driver.test.mjs:351-391](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-driver.test.mjs#L351-L391) |
| approval mode: auto | Use native automatic approval semantics. Let the native runtime decide when approval is needed. This does not mean approve every call automatically. | **— Unsupported.** No equivalent generic native OpenClaw plugin approval control; startup rejects auto.<br>Source: [apps/controller/src/drivers/plugin/runtime-translator.ts:630-681](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/apps/controller/src/drivers/plugin/runtime-translator.ts#L630-L681)<br>Test coverage: [tests/conformance/plugin-driver.test.mjs:184-195](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-driver.test.mjs#L184-L195) | **✓ Supported.** Translate to native auto. Codex annotations and remembered approvals decide whether review is needed; plugin reviewer selection is inherited by tools.<br>Source: [apps/controller/src/drivers/plugin/runtime-translator.ts:565-629](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/apps/controller/src/drivers/plugin/runtime-translator.ts#L565-L629)<br>Test coverage: [tests/conformance/plugin-driver.test.mjs:283-325](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-driver.test.mjs#L283-L325) |
| approval mode: never | Block selected-plugin execution. Prevent the Agent from executing the selected plugin, even if the package remains installed. | **✓ Supported.** Disable the selected plugin; its package remains installed.<br>Source: [apps/controller/src/drivers/plugin/runtime-translator.ts:630-681](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/apps/controller/src/drivers/plugin/runtime-translator.ts#L630-L681)<br>Test coverage: [tests/conformance/plugin-driver.test.mjs:165-182](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-driver.test.mjs#L165-L182) | **✓ Supported.** Default-deny calls while allowing explicit tool/category exceptions. Explicit enabled:false remains terminal. enabled:true can still install the plugin; Agent policy governs execution.<br>Source: [apps/controller/src/drivers/plugin/runtime-translator.ts:565-629](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/apps/controller/src/drivers/plugin/runtime-translator.ts#L565-L629)<br>Test coverage: [tests/conformance/plugin-driver.test.mjs:351-391](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-driver.test.mjs#L351-L391), [tests/conformance/plugin-driver.test.mjs:542-585](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-driver.test.mjs#L542-L585) |
| approval mode: prompt_human | Review every plugin call using a human user. Display label for approvalMode: prompt with approvalsReviewer: user. The request asks for review before every call; this label is not an API enum value. | **— Unsupported.** Every-call prompting and explicit reviewer selection are unsupported; startup rejects this policy.<br>Source: [apps/controller/src/drivers/plugin/runtime-translator.ts:630-681](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/apps/controller/src/drivers/plugin/runtime-translator.ts#L630-L681)<br>Test coverage: [tests/conformance/plugin-driver.test.mjs:184-195](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-driver.test.mjs#L184-L195) | **✓ Partial.** Translate native prompt with app reviewer user, inherited by tool policies. Final Agent enforcement requires a compatible OpenClaw bridge and image; real reviewed-call proof is pending.<br>Source: [apps/controller/src/drivers/plugin/runtime-translator.ts:565-629](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/apps/controller/src/drivers/plugin/runtime-translator.ts#L565-L629)<br>Test coverage: [tests/conformance/plugin-driver.test.mjs:494-541](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-driver.test.mjs#L494-L541) |
| approval mode: prompt_auto_review | Review every plugin call using the native automatic reviewer. Display label for approvalMode: prompt with approvalsReviewer: auto_review. The request asks for review before every call; this label is not an API enum value. | **— Unsupported.** Every-call prompting and explicit reviewer selection are unsupported; startup rejects this policy.<br>Source: [apps/controller/src/drivers/plugin/runtime-translator.ts:630-681](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/apps/controller/src/drivers/plugin/runtime-translator.ts#L630-L681)<br>Test coverage: [tests/conformance/plugin-driver.test.mjs:184-195](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-driver.test.mjs#L184-L195) | **✓ Partial.** Translate native prompt with app reviewer auto_review, inherited by tool policies. Final Agent enforcement requires a compatible OpenClaw bridge and image; real reviewed-call proof is pending.<br>Source: [apps/controller/src/drivers/plugin/runtime-translator.ts:565-629](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/apps/controller/src/drivers/plugin/runtime-translator.ts#L565-L629)<br>Test coverage: [tests/conformance/plugin-driver.test.mjs:494-541](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-driver.test.mjs#L494-L541) |
| Destructive-action and write overrides | Override write/destructive-action policy. Set different approval rules for write operations or destructive actions across a plugin. Enforcement needs reliable action classifications. | **— Unsupported.** Both destructiveActions and writes are rejected at startup.<br>Source: [apps/controller/src/drivers/plugin/runtime-translator.ts:630-681](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/apps/controller/src/drivers/plugin/runtime-translator.ts#L630-L681)<br>Test coverage: [tests/conformance/plugin-driver.test.mjs:184-195](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-driver.test.mjs#L184-L195) | **✓ Partial.** Compile categories for observed authenticated tools; missing annotations are conservative. Requires bridge preservation. Native title fallback prevents an unconditional future-tool denial guarantee; real Agent proof is pending.<br>Source: [apps/controller/src/drivers/plugin/runtime-translator.ts:404-490](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/apps/controller/src/drivers/plugin/runtime-translator.ts#L404-L490), [apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts:912-939](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts#L912-L939)<br>Test coverage: [tests/conformance/plugin-driver.test.mjs:494-541](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-driver.test.mjs#L494-L541), [tests/conformance/plugin-compute.test.mjs:624-695](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-compute.test.mjs#L624-L695) |
| Per-tool enablement and approval overrides | Override individual tool policy. Enable, disable, or set approval rules for individual tools inside a plugin, instead of using only the plugin-wide policy. | **— Unsupported.** Any tools map is rejected at startup; catalog tools is null.<br>Source: [apps/controller/src/drivers/plugin/runtime-translator.ts:630-681](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/apps/controller/src/drivers/plugin/runtime-translator.ts#L630-L681)<br>Test coverage: [tests/conformance/plugin-driver.test.mjs:184-195](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-driver.test.mjs#L184-L195) | **✓ Partial.** Translate raw tool enablement and all modes; explicit mode overrides categories/default. Requires authenticated ownership and bridge preservation. Native title fallback limits future-tool isolation; real Agent proof is pending.<br>Source: [apps/controller/src/drivers/plugin/runtime-translator.ts:404-490](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/apps/controller/src/drivers/plugin/runtime-translator.ts#L404-L490), [apps/controller/src/drivers/plugin/runtime-translator.ts:565-629](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/apps/controller/src/drivers/plugin/runtime-translator.ts#L565-L629)<br>Test coverage: [tests/conformance/plugin-driver.test.mjs:494-541](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-driver.test.mjs#L494-L541), [tests/conformance/plugin-driver.test.mjs:542-585](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-driver.test.mjs#L542-L585), [tests/conformance/plugin-driver.test.mjs:586-638](https://github.com/openclaw/openclaw-enterprise/blob/dev/stevenlee/codex-plugin-tool-policies/tests/conformance/plugin-driver.test.mjs#L586-L638) |

<!-- plugin-matrix:end -->

## Update this snapshot

Edit `docs/assets/plugin-driver-matrix.json` after reading the current reference,
implementation, and focused tests. Set `baseline` to the reviewed full commit,
update `reviewedAt`, and verify each source range at that commit. Keep native
enforcement separate from API acceptance and preserve proof limitations.

From the repository root, regenerate and validate:

```sh
node scripts/generate-plugin-matrix.mjs
node scripts/generate-plugin-matrix.mjs --check
pnpm docs:check
pnpm docs:build
```

Follow [local preview](../../local-preview.md) to open
`/reference/drivers/plugin-matrix/`. Contributor test and runtime prerequisites
remain in the [plugin testing guide](../../testing/plugins.md).
