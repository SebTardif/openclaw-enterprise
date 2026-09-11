import { element, button } from "../dom.mjs";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const id = (value, prefix = "") =>
  typeof value === "string" && new RegExp(`^${prefix}${UUID}$`).test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const fields = (value, names) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === names.length &&
  names.every((name) => Object.hasOwn(value, name));
const fail = () => {
  throw new Error("Deployment inputs or retained state unavailable.");
};
const DRAFT_FIELDS = [
  "configurationId",
  "configurationGeneration",
  "providerId",
  "executionMode",
  "maximumExecutionMs",
  "serviceAccountId",
  "workloadProfileSelection",
];

function validDraft(draft) {
  const selection = draft?.workloadProfileSelection;
  return (
    fields(draft, DRAFT_FIELDS) &&
    id(draft.configurationId, "cfg_") &&
    positive(draft.configurationGeneration) &&
    (draft.providerId === null ||
      (typeof draft.providerId === "string" &&
        draft.providerId.length <= 200 &&
        /^(?!\s)(?!.*\s$)(?!.*[\u0000-\u001f\u007f]).+$/.test(draft.providerId))) &&
    ["embedded", "dedicated"].includes(draft.executionMode) &&
    (draft.maximumExecutionMs === null || positive(draft.maximumExecutionMs)) &&
    id(draft.serviceAccountId, "sa_") &&
    fields(selection, ["manifestRef", "manifestDigest", "admissionRef", "admissionVersion"]) &&
    id(selection.manifestRef) &&
    id(selection.admissionRef) &&
    /^sha256:[0-9a-f]{64}$/.test(selection.manifestDigest) &&
    positive(selection.admissionVersion)
  );
}

function draftOf(agent, configuration) {
  const draft = {
    configurationId: agent.configurationId,
    configurationGeneration: configuration.generation,
    providerId: agent.providerId,
    executionMode: agent.executionMode,
    maximumExecutionMs: agent.maximumExecutionMs,
    serviceAccountId: agent.serviceAccountId,
    workloadProfileSelection: agent.workloadProfileSelection,
  };
  if (!validDraft(draft)) fail();
  const selection = draft.workloadProfileSelection;
  draft.workloadProfileSelection = {
    manifestRef: selection.manifestRef,
    manifestDigest: selection.manifestDigest,
    admissionRef: selection.admissionRef,
    admissionVersion: selection.admissionVersion,
  };
  return draft;
}

// The browser deliberately consumes a bounded projection. It does not import the
// Node-only codecs or turn any operation observation into runtime authority.
function operationOf(data, command, historical) {
  if (
    !fields(data, historical ? ["operation", "observation"] : ["disposition", "operation"]) ||
    (!historical && data.disposition !== "accepted")
  )
    fail();
  const operation = data.operation;
  if (
    !fields(operation, [
      "operationRef",
      "kind",
      "revisionSource",
      "lifecycleGeneration",
      "desiredMode",
      "acceptedAt",
      ...(historical ? ["requestedRevisionId"] : []),
    ]) ||
    operation.operationRef !== command.operationRef ||
    operation.kind !== "deploy" ||
    operation.revisionSource !== "saved-draft" ||
    operation.desiredMode !== "running" ||
    operation.lifecycleGeneration !== (command.expectedLifecycleGeneration ?? 0) + 1 ||
    typeof operation.acceptedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(operation.acceptedAt) ||
    !Number.isFinite(Date.parse(operation.acceptedAt)) ||
    new Date(operation.acceptedAt).toISOString() !== operation.acceptedAt ||
    (historical && !id(operation.requestedRevisionId, "rev_"))
  )
    fail();
  return operation;
}

// Detect duplicate object keys before JSON.parse discards them. General saved
// Configuration values may contain signed/fractional numbers; command fields
// still require positive safe integers separately.
function parseJson(text, integerOnly) {
  let at = 0,
    nodes = 0;
  const ws = () => {
    while (/[\x20\x09\x0a\x0d]/.test(text[at] ?? "!")) at++;
  };
  const string = () => {
    const start = at++;
    while (at < text.length) {
      const ch = text[at++];
      if (ch === "\\") at++;
      else if (ch === '"') return JSON.parse(text.slice(start, at));
    }
    fail();
  };
  const value = (depth) => {
    if (depth > 20 || ++nodes > 4096) fail();
    ws();
    if (text[at] === '"') return void string();
    if (text[at] === "{" || text[at] === "[") {
      const object = text[at++] === "{",
        close = object ? "}" : "]",
        keys = new Set();
      let count = 0;
      ws();
      if (text[at] === close) {
        at++;
        return;
      }
      for (;;) {
        if (++count > 128) fail();
        ws();
        if (object) {
          if (text[at] !== '"') fail();
          const key = string();
          if (keys.has(key)) fail();
          keys.add(key);
          ws();
          if (text[at++] !== ":") fail();
        }
        value(depth + 1);
        ws();
        if (text[at] === close) {
          at++;
          return;
        }
        if (text[at++] !== ",") fail();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      text.slice(at),
    );
    if (!token) fail();
    if (integerOnly && !/^(?:true|false|null|0|[1-9][0-9]*)$/.test(token[0])) fail();
    at += token[0].length;
  };
  value(0);
  ws();
  if (at !== text.length) fail();
  return JSON.parse(text);
}

async function readJson(context, path, method = "GET", body) {
  if (!context.isCurrent()) fail();
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.any([
      ...(context.signal ? [context.signal] : []),
      AbortSignal.timeout(15000),
    ]),
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  });
  if (response.status === 401 && context.isCurrent()) context.onExpired();
  if (
    response.status !== (method === "POST" ? 202 : 200) ||
    !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
  )
    fail();
  const reader = response.body.getReader(),
    chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65536) fail();
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const payload = parseJson(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    path.includes("/lifecycle") || method === "POST",
  );
  if (
    !context.isCurrent() ||
    !fields(payload, ["data", "meta"]) ||
    !fields(payload.meta, ["requestId"]) ||
    !id(payload.meta.requestId, "req_")
  )
    fail();
  return payload.data;
}

function openLedger() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("oce-lifecycle-deploy-v2", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("active");
      request.result.createObjectStore("history");
    };
    request.onerror = () => reject(new Error("Deployment retention unavailable."));
    request.onblocked = () => reject(new Error("Deployment retention unavailable."));
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function ledger(action, key, record) {
  const database = await openLedger();
  try {
    return await new Promise((resolve, reject) => {
      const reading = action === "read" || action === "readReceipt";
      const transaction = database.transaction(
        ["active", "history"],
        reading ? "readonly" : "readwrite",
        { durability: "strict" },
      );
      if (!reading && transaction.durability !== "strict") {
        transaction.abort();
        reject(new Error("Strict retention unavailable."));
        return;
      }
      let result;
      const active = transaction.objectStore("active"),
        history = transaction.objectStore("history");
      transaction.onabort = transaction.onerror = () =>
        reject(new Error("Deployment retention unavailable or already reserved."));
      transaction.oncomplete = () => resolve(result);
      if (action === "reserve") {
        // add, never put: one transaction elects the only tab permitted to send.
        history.add(record, JSON.stringify([key, record.command.operationRef]));
        active.add(record, key);
      } else if (action === "receipt") {
        history.add(record, JSON.stringify([key, record.operationRef, "receipt"]));
      } else if (action === "readReceipt") {
        const request = history.get(JSON.stringify([key, record.command.operationRef, "receipt"]));
        request.onsuccess = () => {
          result = request.result;
        };
      } else {
        const request = active.get(key);
        request.onsuccess = () => {
          result = request.result;
          if (action === "release") {
            if (!result || result.body !== record.body) transaction.abort();
            else active.delete(key); // Immutable history is never removed.
          }
        };
      }
    });
  } finally {
    database.close();
  }
}

export function createDeploymentPanel({ context, path, agent, configuration }) {
  const scope = {
    origin: location.origin,
    accountId: context.accountId,
    namespaceId: context.namespaceId,
    agentId: agent.id,
  };
  const key = JSON.stringify(scope);
  const expectedPath = `/namespaces/${encodeURIComponent(scope.namespaceId)}/agents/${encodeURIComponent(scope.agentId)}`;
  const status = element("p", { className: "muted", role: "status" });
  const retainedDetails = element("div");
  let retained = null,
    busy = true,
    unavailable = false;
  const deploy = button("Deploy saved draft", () => void submit());
  const read = button("Read original deployment", () => void recover(false));
  const another = button("Prepare another deployment", () => void recover(true));
  const section = element(
    "section",
    { className: "agent-card", "aria-label": "Deployment" },
    element("h2", {}, "Deploy saved draft"),
    element(
      "p",
      {},
      "Deployment requires a saved ServiceAccount and workload profile selection. Acceptance creates deployment intent; it does not confirm serving or runtime health.",
    ),
    deploy,
    read,
    another,
    status,
    retainedDetails,
    element(
      "p",
      { className: "muted" },
      "If durable browser storage is unavailable, use the operator deployment procedure and scripts/occ-deploy.mjs to retain the exact command before sending it once. Preserve existing browser records; never clear an uncertain request to retry.",
    ),
  );

  function gate() {
    if (!agent.serviceAccountId || !agent.workloadProfileSelection)
      return "Save an applicable ServiceAccount and workload profile selection through the Agent API before deploying.";
    try {
      draftOf(agent, configuration);
    } catch {
      return "Saved deployment inputs are incomplete or unsupported. Refresh after an operator saves valid inputs.";
    }
    return null;
  }
  function controls() {
    if (!context.isCurrent()) return;
    deploy.disabled = busy || unavailable || Boolean(retained) || Boolean(gate());
    read.hidden = another.hidden = !retained;
    read.disabled = another.disabled = busy || unavailable;
  }
  function validateRecord(record) {
    const command = record?.command;
    if (
      !fields(record, ["scope", "command", "body"]) ||
      JSON.stringify(record.scope) !== key ||
      !fields(command, [
        "schemaVersion",
        "operationRef",
        "expectedLifecycleGeneration",
        "revisionSource",
        "expectedDraft",
      ]) ||
      command.schemaVersion !== 2 ||
      !id(command.operationRef) ||
      command.revisionSource !== "saved-draft" ||
      !(
        command.expectedLifecycleGeneration === null ||
        (positive(command.expectedLifecycleGeneration) &&
          command.expectedLifecycleGeneration < Number.MAX_SAFE_INTEGER)
      ) ||
      !validDraft(command.expectedDraft) ||
      record.body !== JSON.stringify(command)
    )
      fail();
    return record;
  }
  function showRetained() {
    if (!context.isCurrent()) return;
    retainedDetails.replaceChildren(
      ...(retained
        ? [
            element(
              "p",
              { className: "resource-id" },
              `Original operation: ${retained.command.operationRef}`,
            ),
            element(
              "details",
              {},
              element("summary", {}, "Retained original command and scope"),
              element("pre", { tabindex: "0" }, JSON.stringify(retained, null, 2)),
            ),
          ]
        : []),
    );
  }
  async function checkAccount() {
    const session = await readJson(context, "/api/auth/session");
    if (session?.user?.id !== scope.accountId) {
      if (context.isCurrent()) context.onExpired();
      fail();
    }
  }
  async function initialize() {
    try {
      if (
        path !== expectedPath ||
        !id(scope.namespaceId, "ns_") ||
        !id(scope.agentId, "agt_") ||
        typeof scope.accountId !== "string" ||
        !scope.accountId ||
        !globalThis.indexedDB ||
        !globalThis.crypto?.randomUUID ||
        !navigator.storage?.persisted ||
        !navigator.storage?.persist
      )
        fail();
      const existing = await ledger("read", key);
      if (!context.isCurrent()) return;
      retained = existing ? validateRecord(existing) : null;
      status.textContent = retained
        ? "An original command is retained. Read its exact operation before preparing any new intent. It will never be sent again."
        : (gate() ?? "Ready to check the saved draft and retain one deployment command.");
      showRetained();
    } catch {
      if (!context.isCurrent()) return;
      unavailable = true;
      status.textContent =
        gate() ??
        "Durable deployment retention is unavailable. Use the operator deployment procedure.";
    } finally {
      if (context.isCurrent()) {
        busy = false;
        controls();
      }
    }
  }
  async function submit() {
    if (busy || unavailable || retained || gate() || !context.isCurrent()) return;
    busy = true;
    controls();
    let reserved = false;
    try {
      status.textContent = "Checking durable storage and the saved draft…";
      if (!(await navigator.storage.persisted()) && !(await navigator.storage.persist())) fail();
      if (!context.isCurrent()) return;
      await checkAccount();
      const freshAgent = await readJson(context, path);
      if (
        freshAgent.id !== scope.agentId ||
        freshAgent.namespaceId !== scope.namespaceId ||
        freshAgent.configurationId !== configuration.id
      )
        fail();
      const freshConfiguration = await readJson(
        context,
        `/namespaces/${scope.namespaceId}/configurations/${encodeURIComponent(freshAgent.configurationId)}`,
      );
      if (
        freshConfiguration.id !== configuration.id ||
        freshConfiguration.namespaceId !== scope.namespaceId
      )
        fail();
      const draft = draftOf(freshAgent, freshConfiguration);
      if (JSON.stringify(draft) !== JSON.stringify(draftOf(agent, configuration))) fail();
      const lifecycle = await readJson(context, `${path}/lifecycle`);
      if (
        lifecycle.namespaceId !== scope.namespaceId ||
        lifecycle.agentId !== scope.agentId ||
        !(
          lifecycle.head === null ||
          (fields(lifecycle.head, [
            "lifecycleGeneration",
            "desiredMode",
            "requestedRevisionId",
            "operationRef",
          ]) &&
            positive(lifecycle.head.lifecycleGeneration) &&
            lifecycle.head.lifecycleGeneration < Number.MAX_SAFE_INTEGER &&
            ["running", "disabled", "stopped"].includes(lifecycle.head.desiredMode) &&
            id(lifecycle.head.operationRef) &&
            (lifecycle.head.requestedRevisionId === null ||
              id(lifecycle.head.requestedRevisionId, "rev_")))
        )
      )
        fail();
      const command = {
        schemaVersion: 2,
        operationRef: crypto.randomUUID(),
        expectedLifecycleGeneration:
          lifecycle.head === null ? null : lifecycle.head.lifecycleGeneration,
        revisionSource: "saved-draft",
        expectedDraft: draft,
      };
      const original = validateRecord({ scope, command, body: JSON.stringify(command) });
      await checkAccount();
      if (!context.isCurrent()) return;
      await ledger("reserve", key, original);
      reserved = true;
      retained = original;
      // A crash or navigation here deliberately consumes send permission, just
      // like the CLI may-have-sent marker. Recovery never guesses that POST failed.
      if (!context.isCurrent()) return;
      await checkAccount();
      showRetained();
      status.textContent = "Original command retained. Submitting once…";
      const receipt = operationOf(
        await readJson(context, `${path}/deploy`, "POST", original.body),
        command,
        false,
      );
      await ledger("receipt", key, receipt);
      if (context.isCurrent())
        status.textContent =
          "Deployment accepted (HTTP 202). This is an admission receipt, not a revision or runtime success. Read the original operation for its history.";
    } catch {
      if (!context.isCurrent()) return;
      // Another tab may have won reservation. Reload its original identity; do
      // not replace it or manufacture a second operation on any error path.
      try {
        const existing = await ledger("read", key);
        if (existing) retained = validateRecord(existing);
      } catch {
        unavailable = true;
      }
      if (!context.isCurrent()) return;
      showRetained();
      status.textContent =
        reserved || retained
          ? "Deployment outcome unresolved. Preserve the original command and use its exact authorized operation read. No POST will be retried."
          : "Deployment was not submitted. Durable storage or fresh saved inputs are unavailable or changed. Refresh or use the operator deployment procedure.";
    } finally {
      if (context.isCurrent()) {
        busy = false;
        controls();
      }
    }
  }
  async function recover(prepareAnother) {
    if (busy || unavailable || !retained || !context.isCurrent()) return;
    busy = true;
    controls();
    const original = retained;
    try {
      status.textContent = "Reading the original operation with current authorization…";
      await checkAccount();
      const operation = operationOf(
        await readJson(context, `${path}/lifecycle/operations/${original.command.operationRef}`),
        original.command,
        true,
      );
      await checkAccount();
      const receipt = await ledger("readReceipt", key, original);
      if (receipt) {
        operationOf({ disposition: "accepted", operation: receipt }, original.command, false);
        if (Object.keys(receipt).some((field) => operation[field] !== receipt[field])) fail();
      }
      if (!context.isCurrent()) return;
      if (prepareAnother) {
        await ledger("release", key, original);
        if (!context.isCurrent()) return;
        retained = null;
        showRetained();
        status.textContent =
          "The original operation is confirmed as accepted; its command remains in browser history. A new deployment requires a separate click and fresh saved-input checks.";
      } else
        status.textContent = `Original deployment accepted at ${operation.acceptedAt}, generation ${operation.lifecycleGeneration}; requested revision ${operation.requestedRevisionId}. Historical read only: current serving, cutover, and termination are not established.`;
    } catch {
      if (context.isCurrent())
        status.textContent =
          "Original operation unavailable or unresolved. Preserve its command. No new deployment is enabled and no POST is retried.";
    } finally {
      if (context.isCurrent()) {
        busy = false;
        controls();
      }
    }
  }
  controls();
  const ready = initialize();
  return { section, ready, refreshReadiness: controls };
}
