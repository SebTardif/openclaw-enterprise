export const INTERRUPTION_POINTS = ["before-call", "in-flight", "lost-acknowledgment"] as const;
export type InterruptionPoint = (typeof INTERRUPTION_POINTS)[number];
export type ScenarioMethod = "create" | "observe" | "setRoute";

/** Fixed ordering and finite sample counts are preparation inputs, not execution grants. */
export const SCENARIOS = Object.freeze(
  (["create", "observe", "setRoute"] as const).flatMap((method) =>
    INTERRUPTION_POINTS.map((interruption) =>
      Object.freeze({
        id: `${method}/${interruption}`,
        method,
        interruption,
      }),
    ),
  ),
);
export type Scenario = (typeof SCENARIOS)[number];

/** These descriptors deliberately contain no requests, callbacks or loader paths. */
export const DEFERRED_CASES = Object.freeze([
  Object.freeze({
    id: "gateway-and-harness-replacement",
    status: "unrun",
    executable: false,
    requires: "fresh runtime identity, completed conversation and retained workspace proof",
  }),
  Object.freeze({
    id: "quiet-native-restore",
    status: "unrun",
    executable: false,
    requires: "original persistence and native restore producer acceptance",
  }),
  Object.freeze({
    id: "overlapping-turns-during-update",
    status: "unrun",
    executable: false,
    requires: "original collaboration and lifecycle integration acceptance",
  }),
]);

/** Existing public Driver fixture entrypoint. It is not imported or run by preparation. */
export const RETAINED_LIFECYCLE_FIXTURE = Object.freeze({
  module: "tests/fixtures/kubernetes-lifecycle-collaborators/scenarios.mjs",
  entrypoint: "runScenario",
  selectedCases: Object.freeze([
    "prepare-already-cancelled",
    "prepare-owner-cancellation",
    "prepare-unknown-mutation-effect",
    "prepare-cleanup-failure",
    "activate-ready-revision",
    "deactivate-successor-revision",
  ]),
  status: "unrun",
  reason: "requires original owner allocation; entrypoint constructs the selected Driver",
});
