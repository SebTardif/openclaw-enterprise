import { REGISTRY_DIGEST, registry } from "../../../scripts/release-evidence/registry.mjs";
import { VERSION, digest } from "../../../scripts/release-evidence/evidence.mjs";

// Synthetic input identities exercise the harness only, never a product gate.
export const inputs = {
  source: "a".repeat(40),
  images: [{ name: "synthetic", digest: digest("synthetic-image") }],
  configuration: digest("synthetic-configuration"),
  tuple: digest("synthetic-tuple"),
  harness: digest("synthetic-harness"),
  registry: REGISTRY_DIGEST,
};
export function fixture({
  caseId = "r9-stop",
  outcome = "pass",
  runId = "run-one",
  executionClass = "unit",
} = {}) {
  const definition = registry().cases.find((item) => item.id === caseId);
  const startedAt = "2026-01-01T00:00:00.000Z";
  const endedAt = "2026-01-01T00:00:01.000Z";
  const assertions = definition.assertions.map(({ id }) => ({
    id,
    outcome,
    observed: outcome !== "unrun",
    reasonCode: "synthetic-observation",
    artifacts: outcome === "unrun" ? [] : ["observations"],
  }));
  return {
    metadata: {
      version: VERSION,
      runId,
      supersedes: null,
      caseId,
      requirement: definition.requirement,
      fixture: { id: definition.fixture.id, version: "synthetic-v1" },
      executor: "synthetic-test",
      channel: definition.channel,
      profile: definition.profile,
      executionClass,
      steps: [
        { kind: "command", value: "node --test tests/integration/release-evidence.test.mjs" },
      ],
      startedAt,
      endedAt,
      inputs: structuredClone(inputs),
      assertions,
      securityEvents: { adapterVersion: "pending", status: "pending", required: 0, observed: 0 },
    },
    observations: {
      version: "release-observations/v1",
      observations: definition.assertions.map(({ id }) => ({
        assertionId: id,
        outcome,
        observedAt: endedAt,
        correlation: "b".repeat(32),
        reasonCode: "synthetic-observation",
      })),
    },
  };
}
