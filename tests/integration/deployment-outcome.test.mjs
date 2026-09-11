import assert from "node:assert/strict";
import test from "node:test";

import { deploymentOutcomeFromWork } from "../../packages/occ/src/state/postgres-work-queue.ts";

function work(overrides = {}) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    idempotencyKey: "agent_revision:rev_00000000-0000-4000-8000-000000000000:reconcile",
    namespaceId: "ns_00000000-0000-4000-8000-000000000000",
    agentId: "agt_00000000-0000-4000-8000-000000000000",
    revisionId: "rev_00000000-0000-4000-8000-000000000000",
    actorId: "principal-test",
    state: "queued",
    availableAt: now,
    attemptCount: 0,
    pluginErrors: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("deployment outcome reports queued until a live claim exists", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(deploymentOutcomeFromWork(work(), now).status, "queued");
  assert.equal(
    deploymentOutcomeFromWork(
      work({
        state: "claimed",
        claimToken: "00000000-0000-4000-8000-000000000000",
        leaseExpiresAt: new Date("2025-12-31T23:59:59.000Z"),
      }),
      now,
    ).status,
    "queued",
  );
  assert.equal(
    deploymentOutcomeFromWork(
      work({
        state: "claimed",
        claimToken: "00000000-0000-4000-8000-000000000000",
        leaseExpiresAt: new Date("2026-01-01T00:00:01.000Z"),
      }),
      now,
    ).status,
    "running",
  );
});

test("deployment outcome maps terminal success, failure, and superseded reason", () => {
  const completedAt = new Date("2026-01-01T00:00:01.000Z");

  assert.deepEqual(
    deploymentOutcomeFromWork(
      work({
        state: "succeeded",
        terminalReasonCode: "RECONCILE_SUCCEEDED",
        completedAt,
      }),
    ),
    {
      deploymentId: "rev_00000000-0000-4000-8000-000000000000",
      namespaceId: "ns_00000000-0000-4000-8000-000000000000",
      agentId: "agt_00000000-0000-4000-8000-000000000000",
      status: "succeeded",
      pluginErrors: [],
      error: null,
    },
  );

  assert.deepEqual(
    deploymentOutcomeFromWork(
      work({
        state: "succeeded",
        terminalReasonCode: "REVISION_SUPERSEDED",
        completedAt,
      }),
    ).error,
    {
      code: "REVISION_SUPERSEDED",
      message: "Agent revision was superseded before activation.",
    },
  );

  const failed = deploymentOutcomeFromWork(
    work({
      state: "failed_permanent",
      terminalReasonCode: "MAX_ATTEMPTS_EXHAUSTED",
      completedAt,
    }),
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.error?.code, "MAX_ATTEMPTS_EXHAUSTED");
});

test("deployment outcome retains plugin identity alongside terminal installation failure", () => {
  const pluginErrors = [
    {
      driverId: "codex-plugin",
      pluginId: "codex-plugin:google-calendar@openai-curated-remote",
      code: "PLUGIN_INSTALL_FAILED",
      message: "Plugin installation failed.",
    },
  ];
  const outcome = deploymentOutcomeFromWork(
    work({
      state: "failed_permanent",
      terminalReasonCode: "PLUGIN_INSTALL_FAILED",
      completedAt: new Date("2026-01-01T00:00:01.000Z"),
      pluginErrors,
    }),
  );
  assert.equal(outcome.status, "failed");
  assert.deepEqual(outcome.pluginErrors, pluginErrors);
  assert.deepEqual(outcome.error, {
    code: "PLUGIN_INSTALL_FAILED",
    message: "Plugin installation failed.",
  });
});
