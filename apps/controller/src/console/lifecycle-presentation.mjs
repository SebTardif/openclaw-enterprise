import { element } from "./dom.mjs";
import { createViewLifetime } from "./view-lifetime.mjs";

// Fixture-only display adapter. The production console does not import this module.
// TODO: consume the canonical browser projection after lifecycle client/capability cutover.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const validId = (value, prefix = "") =>
  typeof value === "string" && new RegExp(`^${prefix}${UUID}$`).test(value);
const generation = (value) => Number.isSafeInteger(value) && value > 0;
const nullableGeneration = (value) => value === null || generation(value);
const revision = (value) => value === null || validId(value, "rev_");
const timestamp = (value) =>
  value === null ||
  (typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fields = (value, names) =>
  isObject(value) &&
  Object.keys(value).length === names.length &&
  names.every((name) => Object.hasOwn(value, name));
const oneOf = (value, values) => values.includes(value);
const none = (value) => (value === null ? "Not observed" : String(value));
const reasons = Object.freeze({
  NONE: "No reported issue",
  LIFECYCLE_UNINITIALIZED: "Lifecycle uninitialized",
  NOT_OBSERVED: "Not observed",
  NOT_REQUESTED: "Not requested",
  AUTHORITY_DENIED: "Authority denied",
  DEPENDENCY_UNAVAILABLE: "Dependency unavailable",
  PROFILE_UNAVAILABLE: "Profile unavailable",
  PREDECESSOR_UNRESOLVED: "Predecessor unresolved",
  CREATE_OUTCOME_UNKNOWN: "Create outcome unknown",
  AMBIGUOUS_PROVIDER_INSTANCE: "Provider instance ambiguous",
  ROUTE_OUTCOME_UNKNOWN: "Route outcome unknown",
  TERMINATION_UNKNOWN: "Termination unknown",
  CREDENTIAL_OUTCOME_UNKNOWN: "Credential outcome unknown",
  STATE_UNAVAILABLE: "State unavailable",
  RESTORE_OUTCOME_UNKNOWN: "Restore outcome unknown",
  SUPERSEDED: "Superseded",
  RECONCILIATION_EXHAUSTED: "Reconciliation exhausted",
});
const steps = [
  "observe",
  "deny-predecessor",
  "terminate-predecessor",
  "prepare",
  "activate",
  "publish",
  "cleanup",
];
const modes = ["running", "disabled", "stopped"];
const conditionNames = Object.freeze({
  accessDenied: "New access denied",
  routeRemoved: "Route removed",
  executionTerminated: "Execution terminated",
  credentialRevocation: "Credential revocation",
  stateRetention: "State retention",
});
const conditionStates = ["confirmed", "pending", "unknown", "not-requested"];
const observationFields = ["phase", "attempt", "step", "reasonCode", "retryAt"];
const operationFields = [
  "operationRef",
  "kind",
  "revisionSource",
  "lifecycleGeneration",
  "desiredMode",
  "acceptedAt",
];
const statusFields = [
  "namespaceId",
  "agentId",
  "head",
  "requestedRevisionId",
  "selectedRevisionId",
  "servingRevisionId",
  "observedLifecycleGeneration",
  ...observationFields,
  "conditions",
  "serving",
  "stopComplete",
  "retention",
];

function validObservation(value) {
  return (
    oneOf(value.phase, ["pending", "reconciling", "blocked", "converged", "superseded"]) &&
    Number.isSafeInteger(value.attempt) &&
    value.attempt >= 0 &&
    oneOf(value.step, steps) &&
    Object.hasOwn(reasons, value.reasonCode) &&
    timestamp(value.retryAt)
  );
}

function validOperation(value, historical = false) {
  if (!fields(value, historical ? [...operationFields, "requestedRevisionId"] : operationFields))
    return false;
  if (
    !validId(value.operationRef) ||
    !generation(value.lifecycleGeneration) ||
    !timestamp(value.acceptedAt) ||
    value.acceptedAt === null ||
    !oneOf(value.kind, ["deploy", "disable", "stop", "resume"])
  )
    return false;
  const running = value.kind === "deploy" || value.kind === "resume";
  const mode = running ? "running" : value.kind === "disable" ? "disabled" : "stopped";
  if (value.desiredMode !== mode) return false;
  if (value.kind === "deploy" && value.revisionSource !== "saved-draft") return false;
  if (value.kind === "resume" && !oneOf(value.revisionSource, ["saved-draft", "retained"]))
    return false;
  if (!running && value.revisionSource !== null) return false;
  return (
    !historical ||
    (revision(value.requestedRevisionId) && (!running || value.requestedRevisionId !== null))
  );
}

function validStatus(value, scope) {
  if (
    !fields(value, statusFields) ||
    value.namespaceId !== scope.namespaceId ||
    value.agentId !== scope.agentId
  )
    return false;
  if (
    ![value.requestedRevisionId, value.selectedRevisionId, value.servingRevisionId].every(
      revision,
    ) ||
    !nullableGeneration(value.observedLifecycleGeneration) ||
    !validObservation(value) ||
    typeof value.serving !== "boolean" ||
    typeof value.stopComplete !== "boolean" ||
    !oneOf(value.retention, ["retained", "verification-pending", "unknown"])
  )
    return false;
  if (
    value.head !== null &&
    (!fields(value.head, [
      "lifecycleGeneration",
      "desiredMode",
      "requestedRevisionId",
      "operationRef",
    ]) ||
      !generation(value.head.lifecycleGeneration) ||
      !oneOf(value.head.desiredMode, modes) ||
      !validId(value.head.operationRef) ||
      value.head.requestedRevisionId !== value.requestedRevisionId)
  )
    return false;
  if (!fields(value.conditions, Object.keys(conditionNames))) return false;
  return Object.values(value.conditions).every(
    (condition) =>
      fields(condition, ["status", "observedAt", "recordedAt", "reasonCode"]) &&
      oneOf(condition.status, conditionStates) &&
      timestamp(condition.observedAt) &&
      timestamp(condition.recordedAt) &&
      Object.hasOwn(reasons, condition.reasonCode),
  );
}

function operationRows(operation) {
  return [
    ["Operation", operation.operationRef],
    ["Kind", operation.kind],
    ["Accepted generation", String(operation.lifecycleGeneration)],
    ["Desired mode", operation.desiredMode],
    ["Revision source", operation.revisionSource ?? "Not applicable"],
    ["Accepted at", operation.acceptedAt],
  ];
}

function observationRows(observation) {
  return [
    ["Phase", observation.phase],
    ["Attempt", String(observation.attempt)],
    ["Step", observation.step],
    ["Reason", reasons[observation.reasonCode]],
    ["Retry at", none(observation.retryAt)],
  ];
}

const unavailable = () => ({
  title: "Lifecycle preview unavailable",
  rows: [],
  note: "Missing or incompatible fixture projection. No runtime outcome is established.",
});

function statusPreview(data, scope) {
  if (!validStatus(data, scope)) return unavailable();
  const current =
    data.head !== null && data.observedLifecycleGeneration === data.head.lifecycleGeneration;
  let freshness = "Observation unavailable";
  if (data.observedLifecycleGeneration !== null)
    freshness = current
      ? "Generation matches; provider freshness is not established by this preview"
      : "Stale observation; current outcome unknown";
  const rows = [
    ["Requested revision", none(data.requestedRevisionId)],
    ["Selected revision", none(data.selectedRevisionId)],
    ["Serving revision observation", none(data.servingRevisionId)],
    [
      "Requested generation",
      data.head === null ? "No head" : String(data.head.lifecycleGeneration),
    ],
    ["Desired mode", data.head?.desiredMode ?? "No head"],
    ["Observed generation", none(data.observedLifecycleGeneration)],
    ["Observation scope", freshness],
    [
      "Server serving predicate",
      data.serving ? "True in supplied observation" : "False; not proof of termination",
    ],
    [
      "Server stopComplete predicate",
      data.stopComplete ? "True in supplied observation" : "False; completion not confirmed",
    ],
    ...observationRows(data),
    ["Retention", data.retention],
  ];
  for (const [name, label] of Object.entries(conditionNames)) {
    const condition = data.conditions[name];
    rows.push(
      [label, condition.status],
      [`${label} observed at`, none(condition.observedAt)],
      [`${label} recorded at`, none(condition.recordedAt)],
      [`${label} reason`, reasons[condition.reasonCode]],
    );
  }
  return {
    title: "Lifecycle status fixture",
    rows,
    note: "Independent conditions are not combined into serving or stop completion. Original observation times are preserved; this preview does not choose a freshness budget.",
  };
}

function resultPreview(result, scope, capability) {
  if (!isObject(result)) return unavailable();
  const envelope = result.envelope;
  if (result.kind === "interrupted")
    return {
      title: "Outcome unknown",
      rows: [],
      note: "The response was interrupted. No success, rollback or cancellation is established. Inspect authorized historical state before deliberate new intent; do not repeat POST automatically.",
    };
  if (!isObject(envelope)) return unavailable();
  if (result.kind === "error") {
    const messages = {
      UNAUTHENTICATED: [
        "Access expired",
        "Private lifecycle information is hidden. Sign in and recheck current access.",
      ],
      FORBIDDEN: [
        "Access denied",
        "Private lifecycle information is hidden. This operation is not authorized.",
      ],
      NOT_FOUND: ["Resource unavailable", "The requested resource is unavailable in this scope."],
      RESOURCE_CONFLICT: [
        "Lifecycle conflict",
        "The request conflicts with current state. An independently authorized read is required; no current generation is disclosed here.",
      ],
      NAMESPACE_NOT_READY: [
        "Namespace not ready",
        "Deployment is unavailable. This is not a shutdown outcome.",
      ],
      INVALID_REQUEST: [
        "Invalid request",
        "The request was not accepted. Check the supported request contract.",
      ],
      DEPENDENCY_UNAVAILABLE: [
        "Dependency unavailable",
        "The outcome cannot be confirmed here. Do not infer rollback or retry a mutation automatically.",
      ],
      UNKNOWN_OUTCOME: [
        "Outcome unknown",
        "Acceptance remains unknown without exact authorized historical readback. Candidate discovery does not settle it; do not repeat POST automatically.",
      ],
      INTERNAL_ERROR: [
        "Service unavailable",
        "The outcome cannot be confirmed here. Inspect authorized state before deliberate new intent.",
      ],
    };
    const selected =
      isObject(envelope.error) && Object.hasOwn(messages, envelope.error.code)
        ? messages[envelope.error.code]
        : null;
    return selected ? { title: selected[0], rows: [], note: selected[1] } : unavailable();
  }
  if (!fields(envelope, ["data", "meta"]) || !isObject(envelope.meta)) return unavailable();
  const data = envelope.data;
  if (result.kind === "status") return statusPreview(data, scope);
  if (result.kind === "receipt") {
    if (
      fields(data, ["disposition", "operation"]) &&
      data.disposition === "accepted" &&
      validOperation(data.operation)
    ) {
      if (capability === "drain" && !["disable", "stop"].includes(data.operation.kind))
        return unavailable();
      return {
        title: "Operation accepted",
        rows: operationRows(data.operation),
        note: "Admission only. This receipt grants no read access and establishes neither serving, shutdown nor retention. No requested revision is disclosed.",
      };
    }
    if (
      fields(data, ["disposition", "lifecycleGeneration", "desiredMode"]) &&
      data.disposition === "unchanged" &&
      generation(data.lifecycleGeneration) &&
      oneOf(data.desiredMode, ["disabled", "stopped"])
    )
      return {
        title: "Intent unchanged",
        rows: [
          ["Matched generation", String(data.lifecycleGeneration)],
          ["Requested mode", data.desiredMode],
        ],
        note: "No new operation was accepted. Existing work and its unknown outcomes remain; this is not proof of completed shutdown.",
      };
  }
  if (
    result.kind === "discovery" &&
    fields(data, ["operations", "nextAfterGeneration"]) &&
    Array.isArray(data.operations) &&
    data.operations.length <= 100 &&
    data.operations.every((item) => validOperation(item)) &&
    nullableGeneration(data.nextAfterGeneration)
  )
    return {
      title: "Recovery remains ambiguous",
      rows: [["Candidate count", String(data.operations.length)]],
      note: "An empty page, equal contents, timestamps, or candidate count cannot identify a lost request or prove absence. Exact authorized historical readback is required; no candidate is selected and no POST is retried.",
    };
  if (
    result.kind === "history" &&
    validId(result.operationRef) &&
    fields(data, ["operation", "observation"]) &&
    validOperation(data.operation, true) &&
    data.operation.operationRef === result.operationRef &&
    fields(data.observation, [...observationFields, "observedAt", "recordedAt"]) &&
    validObservation(data.observation) &&
    timestamp(data.observation.observedAt) &&
    timestamp(data.observation.recordedAt)
  )
    return {
      title: "Exact historical operation fixture",
      rows: [
        ...operationRows(data.operation),
        ["Requested revision", none(data.operation.requestedRevisionId)],
        ...observationRows(data.observation),
        ["Observed at", none(data.observation.observedAt)],
        ["Recorded at", none(data.observation.recordedAt)],
      ],
      note: "This fixture assumes a separately authorized exact historical read. It establishes no current serving or execution authority, even after head advancement. Cancellation is not rollback.",
    };
  return unavailable();
}

function render(view, model, capability, requestId) {
  const rows = element("dl", { className: "configuration-summary" });
  for (const [label, value] of model.rows)
    rows.append(element("dt", {}, label), element("dd", {}, value));
  view.replaceChildren(
    element(
      "section",
      { className: "agent-card", "aria-label": "Lifecycle fixture preview", role: "status" },
      element("p", { className: "notice" }, "Fixture preview only · no live status or operations"),
      element("h2", {}, model.title),
      element("p", {}, `Capability fixture: ${capability}`),
      rows,
      element("p", {}, model.note),
      validId(requestId, "req_")
        ? element("p", { className: "request-id" }, `Request ID: ${requestId}`)
        : null,
    ),
  );
}

/** Controlled fixture view; tokens coordinate display lifetime, never caller authority. */
export function createLifecyclePresentation(view) {
  const lifetime = createViewLifetime();
  let active = null;
  let disposed = false;
  const capabilities = {
    legacy: "Legacy bodyless admission",
    drain: "Version-aware drain",
    "lifecycle-control-v1": "Live lifecycle-control-v1 (fixture)",
  };
  return {
    begin(scope, capability) {
      if (disposed) return null;
      lifetime.reset();
      const allowed =
        isObject(scope) &&
        validId(scope.namespaceId, "ns_") &&
        validId(scope.agentId, "agt_") &&
        Object.hasOwn(capabilities, capability);
      active = allowed
        ? Object.freeze({
            generation: lifetime.capture(),
            namespaceId: scope.namespaceId,
            agentId: scope.agentId,
            capability,
          })
        : null;
      render(view, unavailable(), allowed ? capabilities[capability] : "Unavailable", null);
      return active;
    },
    present(token, result) {
      if (disposed || token === null || token !== active || !lifetime.isCurrent(token.generation))
        return false;
      active = null;
      const model =
        token.capability === "legacy"
          ? unavailable()
          : resultPreview(result, token, token.capability);
      render(view, model, capabilities[token.capability], result?.envelope?.meta?.requestId);
      return true;
    },
    clearAccess() {
      if (disposed) return;
      lifetime.reset();
      active = null;
      render(
        view,
        {
          title: "Access unavailable",
          rows: [],
          note: "Private preview cleared. Recheck the session and exact scope before another read.",
        },
        "Unavailable",
        null,
      );
    },
    dispose() {
      lifetime.reset();
      active = null;
      disposed = true;
      view.replaceChildren();
    },
  };
}
