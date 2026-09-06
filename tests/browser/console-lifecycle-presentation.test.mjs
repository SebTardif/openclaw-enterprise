import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { createLifecyclePresentation } from "../../apps/controller/src/console/lifecycle-presentation.mjs";

// A recording DOM port exercises the real display module and dom.mjs helper.
// It does not parse HTML, perform layout, or claim Chromium/authenticated API evidence.
class RecordedElement {
  constructor(tag) {
    this.tag = tag;
    this.attributes = {};
    this.children = [];
  }
  setAttribute(key, value) {
    this.attributes[key] = value;
  }
  toggleAttribute(key, enabled) {
    if (enabled) this.attributes[key] = "";
    else delete this.attributes[key];
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = [...children];
  }
  set innerHTML(_) {
    throw new Error("HTML interpolation is not a display port");
  }
  get textContent() {
    return this.children
      .map((child) => (child instanceof RecordedElement ? child.textContent : String(child)))
      .join("\n");
  }
}
const scope = Object.freeze({
  namespaceId: "ns_44444444-4444-4444-8444-444444444444",
  agentId: "agt_55555555-5555-4555-8555-555555555555",
});
const ref = "22222222-2222-4222-8222-222222222222";
const requestId = "req_11111111-1111-4111-8111-111111111111";
const rev = (n) =>
  `rev_${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const observedAt = "2026-01-01T12:00:00.000Z";
const recordedAt = "2026-01-01T12:00:01.000Z";
const envelope = (data) => ({ data, meta: { requestId } });
function observation() {
  return {
    phase: "pending",
    attempt: 0,
    step: "observe",
    reasonCode: "NOT_OBSERVED",
    retryAt: null,
  };
}
function condition(status = "unknown") {
  return {
    status,
    observedAt: null,
    recordedAt: null,
    reasonCode: status === "not-requested" ? "NOT_REQUESTED" : "NOT_OBSERVED",
  };
}
function status() {
  return {
    ...scope,
    head: null,
    requestedRevisionId: null,
    selectedRevisionId: null,
    servingRevisionId: null,
    observedLifecycleGeneration: null,
    ...observation(),
    reasonCode: "LIFECYCLE_UNINITIALIZED",
    conditions: {
      accessDenied: condition(),
      routeRemoved: condition(),
      executionTerminated: condition(),
      credentialRevocation: condition("not-requested"),
      stateRetention: condition(),
    },
    serving: false,
    stopComplete: false,
    retention: "verification-pending",
  };
}
function running() {
  return {
    ...status(),
    head: {
      lifecycleGeneration: 7,
      desiredMode: "running",
      requestedRevisionId: rev(2),
      operationRef: ref,
    },
    requestedRevisionId: rev(2),
    selectedRevisionId: rev(1),
    observedLifecycleGeneration: 6,
  };
}
function operation() {
  return {
    operationRef: ref,
    kind: "deploy",
    revisionSource: "saved-draft",
    lifecycleGeneration: 7,
    desiredMode: "running",
    acceptedAt: observedAt,
  };
}
function nodes(root, tag) {
  return [
    ...(root.tag === tag ? [root] : []),
    ...root.children.filter((x) => x instanceof RecordedElement).flatMap((x) => nodes(x, tag)),
  ];
}
function rows(root) {
  const list = nodes(root, "dl")[0];
  return Object.fromEntries(
    list.children
      .filter((_, i) => i % 2 === 0)
      .map((node, i) => [node.textContent, list.children[i * 2 + 1].textContent]),
  );
}
function preview(t, capability = "lifecycle-control-v1") {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  globalThis.document = { createElement: (tag) => new RecordedElement(tag) };
  globalThis.fetch = () => {
    throw new Error("Presentation must not make network requests");
  };
  t.after(() => {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
  });
  const view = new RecordedElement("main");
  const ui = createLifecyclePresentation(view);
  const show = (kind, data, extra = {}) =>
    ui.present(ui.begin(scope, capability), { kind, envelope: envelope(data), ...extra });
  return { view, ui, show };
}

test("no-head fixture keeps missing observations and independent conditions unknown", (t) => {
  const { view, show } = preview(t);
  show("status", status());
  assert.equal(rows(view)["Requested generation"], "No head");
  assert.equal(rows(view)["Observed generation"], "Not observed");
  assert.equal(rows(view)["Requested revision"], "Not observed");
  assert.equal(rows(view)["Selected revision"], "Not observed");
  assert.equal(rows(view)["Serving revision observation"], "Not observed");
  assert.equal(rows(view)["Execution terminated"], "unknown");
  assert.equal(rows(view)["Credential revocation"], "not-requested");
  assert.match(rows(view)["Server serving predicate"], /not proof of termination/);
  assert.match(view.textContent, /Fixture preview only/);
});

test("requested, selected and historical serving observations never collapse into one revision", (t) => {
  const { view, show } = preview(t);
  const data = running();
  data.servingRevisionId = rev(3);
  data.conditions.routeRemoved = {
    status: "pending",
    observedAt,
    recordedAt,
    reasonCode: "ROUTE_OUTCOME_UNKNOWN",
  };
  show("status", data);
  assert.equal(rows(view)["Requested revision"], rev(2));
  assert.equal(rows(view)["Selected revision"], rev(1));
  assert.equal(rows(view)["Serving revision observation"], rev(3));
  assert.equal(rows(view)["Observed generation"], "6");
  assert.match(rows(view)["Observation scope"], /Stale.*current outcome unknown/);
  assert.equal(rows(view)["Route removed observed at"], observedAt);
  assert.equal(rows(view)["Route removed recorded at"], recordedAt);
  data.observedLifecycleGeneration = 7;
  show("status", data);
  assert.match(
    rows(view)["Observation scope"],
    /Generation matches; provider freshness is not established/,
  );
  assert.equal(rows(view)["Route removed observed at"], observedAt);
});

test("stop completion, credential revocation and retained state stay independent", (t) => {
  const { view, show } = preview(t);
  const data = running();
  data.head.desiredMode = "stopped";
  data.observedLifecycleGeneration = 7;
  data.stopComplete = true;
  data.phase = "converged";
  for (const key of ["accessDenied", "routeRemoved", "executionTerminated"])
    data.conditions[key] = { status: "confirmed", observedAt, recordedAt, reasonCode: "NONE" };
  data.conditions.credentialRevocation = {
    status: "unknown",
    observedAt,
    recordedAt,
    reasonCode: "CREDENTIAL_OUTCOME_UNKNOWN",
  };
  data.conditions.stateRetention = {
    status: "pending",
    observedAt,
    recordedAt,
    reasonCode: "STATE_UNAVAILABLE",
  };
  show("status", data);
  assert.equal(rows(view)["Server stopComplete predicate"], "True in supplied observation");
  assert.equal(rows(view)["Credential revocation"], "unknown");
  assert.equal(rows(view)["State retention"], "pending");
  assert.equal(rows(view).Retention, "verification-pending");
  // Display consumes the supplied predicate, not a client conjunction of conditions.
  data.stopComplete = false;
  show("status", data);
  assert.match(rows(view)["Server stopComplete predicate"], /completion not confirmed/);
});

test("accepted and unchanged receipts reveal only their minimal admission fields", (t) => {
  const { view, show } = preview(t);
  show("receipt", { disposition: "accepted", operation: operation() });
  assert.match(view.textContent, /Operation accepted/);
  assert.equal(rows(view).Operation, ref);
  assert.equal(rows(view)["Requested revision"], undefined);
  assert.match(view.textContent, /Admission only/);
  show("receipt", { disposition: "unchanged", lifecycleGeneration: 7, desiredMode: "stopped" });
  assert.deepEqual(rows(view), { "Matched generation": "7", "Requested mode": "stopped" });
  assert.doesNotMatch(view.textContent, new RegExp(ref));
  assert.match(view.textContent, /No new operation/);
});

test("legacy, drain, live and incompatible capability cases enable no controls", (t) => {
  const { view, ui } = preview(t);
  for (const capability of ["legacy", "drain", "lifecycle-control-v1", null, "future-v2"]) {
    const token = ui.begin(scope, capability);
    ui.present(token, {
      kind: "receipt",
      envelope: envelope({ disposition: "accepted", operation: operation() }),
    });
    assert.equal(nodes(view, "button").length, 0);
    assert.equal(nodes(view, "form").length, 0);
    if (capability === "lifecycle-control-v1") assert.match(view.textContent, /Operation accepted/);
    else assert.match(view.textContent, /preview unavailable/);
  }
  const stop = { ...operation(), kind: "stop", desiredMode: "stopped", revisionSource: null };
  ui.present(ui.begin(scope, "drain"), {
    kind: "receipt",
    envelope: envelope({ disposition: "accepted", operation: stop }),
  });
  assert.match(view.textContent, /Operation accepted/);
  assert.match(view.textContent, /Version-aware drain/);
});

test("closed error classes discard raw diagnostics and unsafe correlation metadata", (t) => {
  const { view, ui } = preview(t);
  for (const [code, title] of [
    ["UNAUTHENTICATED", "Access expired"],
    ["FORBIDDEN", "Access denied"],
    ["NOT_FOUND", "Resource unavailable"],
    ["RESOURCE_CONFLICT", "Lifecycle conflict"],
    ["DEPENDENCY_UNAVAILABLE", "Dependency unavailable"],
    ["UNKNOWN_OUTCOME", "Outcome unknown"],
    ["INTERNAL_ERROR", "Service unavailable"],
    ["UNRECOGNIZED", "Lifecycle preview unavailable"],
  ]) {
    ui.present(ui.begin(scope, "lifecycle-control-v1"), {
      kind: "error",
      envelope: {
        error: {
          code,
          message: "raw-secret-marker<script>bad</script>",
          details: { currentGeneration: 999 },
        },
        meta: { requestId: "req_raw-secret-marker" },
      },
    });
    assert.match(view.textContent, new RegExp(title));
    assert.doesNotMatch(view.textContent, /raw-secret|script|999/);
    assert.deepEqual(rows(view), {});
  }
  ui.present(ui.begin(scope, "lifecycle-control-v1"), {
    kind: "error",
    envelope: { error: { code: "RESOURCE_CONFLICT" }, meta: { requestId } },
  });
  assert.match(view.textContent, new RegExp(requestId));
  assert.match(view.textContent, /no current generation is disclosed/);
});

test("unknown replies and zero, one or multiple discovery candidates never select or retry", (t) => {
  const { view, show, ui } = preview(t);
  ui.present(ui.begin(scope, "lifecycle-control-v1"), { kind: "interrupted" });
  assert.match(view.textContent, /Outcome unknown/);
  assert.match(view.textContent, /do not repeat POST automatically/);
  for (const count of [0, 1, 2]) {
    const operations = Array.from({ length: count }, (_, index) => ({
      ...operation(),
      operationRef: index ? "33333333-3333-4333-8333-333333333333" : ref,
      lifecycleGeneration: 7 + index,
    }));
    show("discovery", { operations, nextAfterGeneration: null });
    assert.equal(rows(view)["Candidate count"], String(count));
    assert.match(view.textContent, /Recovery remains ambiguous/);
    assert.doesNotMatch(view.textContent, new RegExp(ref));
    assert.equal(nodes(view, "button").length, 0);
  }
});

test("known exact historical readback does not become current execution or rollback authority", (t) => {
  const { view, show } = preview(t);
  const data = {
    operation: { ...operation(), requestedRevisionId: rev(1) },
    observation: {
      ...observation(),
      phase: "superseded",
      reasonCode: "SUPERSEDED",
      observedAt,
      recordedAt,
    },
  };
  show("history", data, { operationRef: ref });
  assert.match(view.textContent, /Exact historical operation fixture/);
  assert.equal(rows(view)["Requested revision"], rev(1));
  assert.equal(rows(view).Phase, "superseded");
  assert.equal(rows(view)["Observed at"], observedAt);
  assert.match(view.textContent, /no current serving or execution authority/);
  assert.match(view.textContent, /Cancellation is not rollback/);
  show("history", data, { operationRef: "33333333-3333-4333-8333-333333333333" });
  assert.match(view.textContent, /preview unavailable/);
  show("history", data);
  assert.match(view.textContent, /preview unavailable/);
});

test("scope change, access loss and disposal reject late or duplicate fixture responses", async (t) => {
  const { view, ui } = preview(t);
  const late = ui.begin(scope, "lifecycle-control-v1");
  const newer = ui.begin(scope, "lifecycle-control-v1");
  const result = { kind: "status", envelope: envelope(running()) };
  assert.equal(ui.present(late, result), false);
  assert.equal(ui.present(newer, result), true);
  assert.equal(ui.present(newer, result), false);
  assert.match(view.textContent, new RegExp(rev(2)));
  const pending = ui.begin(scope, "lifecycle-control-v1");
  const gate = Promise.withResolvers();
  const response = gate.promise.then(() => ui.present(pending, result));
  ui.clearAccess();
  gate.resolve();
  assert.equal(await response, false);
  assert.doesNotMatch(view.textContent, new RegExp(rev(2)));
  assert.match(view.textContent, /Access unavailable/);
  const current = ui.begin(scope, "lifecycle-control-v1");
  assert.equal(ui.present(current, result), true);
  assert.equal(
    ui.present(pending, { kind: "error", envelope: { error: { code: "UNAUTHENTICATED" } } }),
    false,
  );
  assert.match(view.textContent, new RegExp(rev(2)));
  ui.dispose();
  assert.equal(view.textContent, "");
  assert.equal(ui.begin(scope, "lifecycle-control-v1"), null);
  assert.equal(ui.present(current, result), false);
});

test("foreign scope and malformed projections stay unavailable rather than exposing fields", (t) => {
  const { view, show } = preview(t);
  const candidates = [
    { ...running(), agentId: "agt_66666666-6666-4666-8666-666666666666" },
    { ...running(), actor: "private-actor-marker" },
    { ...running(), requestedRevisionId: "<script>private-marker</script>" },
    { ...running(), observedLifecycleGeneration: 0 },
    { ...running(), observedLifecycleGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...running(), observedLifecycleGeneration: "7" },
    { ...running(), retention: "purged" },
    { ...running(), reasonCode: "raw-secret-marker" },
    { ...running(), head: { ...running().head, lifecycleGeneration: 0 } },
    {
      ...running(),
      conditions: {
        ...running().conditions,
        accessDenied: { ...condition(), observedAt: "2026-02-30T12:00:00.000Z" },
      },
    },
  ];
  for (const data of candidates) {
    show("status", data);
    assert.match(view.textContent, /preview unavailable/);
    assert.deepEqual(rows(view), {});
    assert.doesNotMatch(view.textContent, /private-|raw-secret|66666666|purged/);
  }
});

test("the preview has no production console import or static serving registration", async () => {
  const root = new URL("../../", import.meta.url);
  for (const path of [
    "apps/controller/src/console/console.mjs",
    "apps/controller/src/console/agents.mjs",
    "apps/controller/src/console/agents/detail.mjs",
    "apps/controller/src/console-assets.ts",
  ])
    assert.doesNotMatch(await readFile(new URL(path, root), "utf8"), /lifecycle-presentation/);
});
