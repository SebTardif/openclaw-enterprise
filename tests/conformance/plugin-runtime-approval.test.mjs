import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import {
  createPluginRuntimeTranslator,
  PLUGIN_RUNTIME_TRANSLATOR_SOURCE,
} from "../../apps/controller/src/drivers/plugin/runtime-translator.ts";

const nativeId = "fixture@openai-curated-remote";
const pluginId = `codex-plugin:${nativeId}`;
const detail = {
  plugin: {
    summary: { id: nativeId, remotePluginId: "fixture", version: "1.0.0" },
    apps: [{ id: "fixture_app" }],
    skills: [],
    hooks: [],
    mcpServers: [],
    appTemplates: [],
  },
};

for (const [name, translator] of [
  ["controller", createPluginRuntimeTranslator()],
  ["serialized Agent startup", vm.runInNewContext(`(${PLUGIN_RUNTIME_TRANSLATOR_SOURCE})()`)],
]) {
  test(`${name} translates every-call review without changing reviewer selection`, () => {
    for (const approvalsReviewer of [undefined, "user", "auto_review"]) {
      const selection = {
        [pluginId]: { enabled: true, approvalMode: "prompt", approvalsReviewer },
      };
      const artifact = translator.codexRuntimeArtifact(selection, [detail]);
      assert.deepEqual(JSON.parse(JSON.stringify(artifact.configuration.apps)), {
        _default: { enabled: false },
        fixture_app: {
          enabled: true,
          default_tools_approval_mode: "prompt",
          ...(approvalsReviewer === undefined ? {} : { approvals_reviewer: approvalsReviewer }),
        },
      });
      // The bridge delegates to native review; destructive-only ask would force a human reviewer.
      assert.equal(
        translator.codexOpenClawConfiguration(selection).plugins.entries.codex.config.codexPlugins
          .plugins.fixture.allow_destructive_actions,
        "auto",
      );
    }
  });

  test(`${name} rejects conflicting review triggers for a shared native app`, () => {
    const sibling = {
      plugin: {
        ...detail.plugin,
        summary: {
          ...detail.plugin.summary,
          id: "sibling@openai-curated-remote",
          remotePluginId: "sibling",
        },
      },
    };
    assert.throws(
      () =>
        translator.codexRuntimeArtifact(
          {
            [pluginId]: { enabled: true, approvalMode: "prompt", approvalsReviewer: "user" },
            "codex-plugin:sibling@openai-curated-remote": {
              enabled: true,
              approvalMode: "auto",
              approvalsReviewer: "user",
            },
          },
          [detail, sibling],
        ),
      /conflicting approval policy/,
    );
  });
}
