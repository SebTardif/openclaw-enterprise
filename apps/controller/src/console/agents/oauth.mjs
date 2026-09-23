import { element, button } from "../dom.mjs";
import { displayDate, message } from "./list.mjs";

const pendingPhases = new Set(["authorizing", "staging"]);
const phases = {
  authorizing: "Waiting for sign-in.",
  staging: "Saving acquired credentials.",
  authenticated: "Sign-in complete. Model access has not been checked.",
  handoff_pending: "Credential delivery to the runtime is pending.",
  ready:
    "Credentials delivered. Retire the current OAuth runtime before signing in again. Verify model access from the deployed runtime.",
  reconnect_required: "Sign in again to restore authentication.",
  cancelled: "Sign-in cancelled.",
  superseded: "Another attempt replaced this sign-in. Refresh its status.",
};
const errors = {
  INVALID_REQUEST: "The sign-in request was rejected. Refresh before trying again.",
  AUTHORIZATION_LOST: "Access to this sign-in was lost. Refresh to check your permissions.",
  OAUTH_FAILED: "Sign-in failed. Refresh its status before trying again.",
  RUNTIME_UNAVAILABLE: "The authentication runtime is unavailable. Ask your operator to check it.",
  CONFLICT: "The authentication state changed. Refresh before trying again.",
  TIMEOUT: "Sign-in timed out. Refresh before starting another attempt.",
};

export function createAgentOAuthPanel(context, path, providerConnectionId) {
  const section = element("section", {
    className: "agent-card",
    "aria-label": "Model provider sign-in",
  });
  const state = element("p", { role: "status" });
  const feedback = element("p", { className: "error", role: "alert" });
  const instructions = element("div");
  const start = button("Sign in", begin, { className: "primary", disabled: true });
  const cancel = button("Cancel sign-in", cancelAttempt, { disabled: true });
  const refresh = button("Refresh sign-in status", () => {
    feedback.textContent = "";
    void loadStatus();
  });
  section.append(
    element("h2", {}, "Model provider sign-in"),
    element(
      "p",
      { className: "hint" },
      "This sign-in belongs to this Agent. Leaving this tab cancels an unfinished attempt. Completed authentication survives navigation.",
    ),
    state,
    instructions,
    feedback,
    element("div", { className: "form-actions" }, start, cancel, refresh),
  );
  let status = null;
  let loaded = false;
  let busy = false;
  let socket = null;
  let readGeneration = 0;
  let instructionAttempt = null;

  const current = () => context.isCurrent() && !context.signal.aborted;
  const matches = (frame) =>
    status && frame.attemptId === status.attemptId && frame.generation === status.generation;
  function clearInstructions() {
    instructions.querySelectorAll("input").forEach((input) => {
      input.value = "";
    });
    instructions.replaceChildren();
    instructionAttempt = null;
  }
  function render() {
    const selected = status?.providerConnectionId === providerConnectionId;
    state.textContent = !loaded
      ? busy
        ? "Loading sign-in status…"
        : "Sign-in status unavailable."
      : !status
        ? "Not signed in."
        : `${selected ? "" : "Another provider connection: "}${phases[status.phase] ?? "Refresh to check authentication."}`;
    if (status?.deadlineAt && pendingPhases.has(status.phase)) {
      state.append(` Complete before ${displayDate(status.deadlineAt)}.`);
    }
    if (status?.failureCode && status.failureCode !== "OAUTH_CANCELLED") {
      state.append(` ${errors[status.failureCode] ?? "Authentication requires attention."}`);
    }
    start.textContent =
      selected && ["authenticated", "ready", "reconnect_required"].includes(status.phase)
        ? "Sign in again"
        : "Sign in";
    start.disabled =
      !loaded ||
      busy ||
      socket !== null ||
      pendingPhases.has(status?.phase) ||
      ["handoff_pending", "ready"].includes(status?.phase);
    cancel.disabled = !loaded || busy || !pendingPhases.has(status?.phase);
    refresh.disabled = busy;
  }
  function applyStatus(next) {
    status = next;
    loaded = true;
    if (!pendingPhases.has(status?.phase) || (instructionAttempt && !matches(instructionAttempt))) {
      clearInstructions();
    }
    render();
  }
  async function loadStatus() {
    if (!current()) {
      return;
    }
    const generation = ++readGeneration;
    busy = true;
    render();
    try {
      const next = await context.request(`${path}/oauth`, { signal: context.signal });
      if (current() && generation === readGeneration) {
        applyStatus(next);
      }
    } catch (error) {
      if (!current() || generation !== readGeneration) {
        return;
      }
      loaded = false;
      if (error.status === 401) {
        context.onExpired();
      } else {
        feedback.textContent = `Sign-in status unavailable. ${message(error)}`;
      }
    } finally {
      if (current() && generation === readGeneration) {
        busy = false;
        render();
      }
    }
  }
  function closeSocket() {
    const active = socket;
    socket = null;
    active?.close();
  }
  function showInstructions(frame) {
    if (!matches(frame) || !pendingPhases.has(status.phase)) {
      return;
    }
    clearInstructions();
    instructionAttempt = { attemptId: frame.attemptId, generation: frame.generation };
    const value = frame.instructions;
    const target = new URL(
      value.kind === "device-code" ? value.verificationUrl : value.authorizationUrl,
    );
    if (!["https:", "http:"].includes(target.protocol)) {
      throw new Error("Invalid authorization URL");
    }
    instructions.append(
      element(
        "a",
        { href: target.href, target: "_blank", rel: "noopener noreferrer" },
        "Open provider sign-in",
      ),
    );
    if (value.kind === "device-code") {
      instructions.append(
        element("p", {}, "Enter this code: ", element("code", {}, value.userCode)),
        element("p", { className: "hint" }, `Expires in ${value.expiresInMinutes} minutes.`),
      );
      return;
    }
    const input = element("input", {
      id: "oauth-redirect-url",
      type: "password",
      autocomplete: "off",
      spellcheck: "false",
      maxlength: "8192",
      required: true,
    });
    const submit = element("button", { type: "submit" }, "Submit redirect URL");
    const form = element(
      "form",
      {},
      element("label", { for: input.id }, "Redirect URL"),
      input,
      submit,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (
        !current() ||
        !matches(frame) ||
        socket?.readyState !== WebSocket.OPEN ||
        !form.reportValidity()
      ) {
        return;
      }
      socket.send(
        JSON.stringify({
          type: "redirect-url",
          attemptId: frame.attemptId,
          generation: frame.generation,
          url: input.value,
        }),
      );
      input.value = "";
      submit.disabled = true;
    });
    instructions.append(
      element(
        "p",
        { className: "hint" },
        "After signing in, paste the full URL from your browser’s address bar. The localhost page may not load.",
      ),
      form,
    );
  }
  function begin() {
    if (!current() || start.disabled) {
      return;
    }
    feedback.textContent = "";
    clearInstructions();
    ++readGeneration;
    const expectedGeneration = status?.generation ?? 0;
    const url = new URL(`${path}/oauth/acquire`, location.origin);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let terminalStatusReceived = false;
    const active = new WebSocket(url, "occ.agent-oauth.v1");
    socket = active;
    render();
    active.addEventListener("open", () => {
      if (current() && socket === active) {
        active.send(JSON.stringify({ type: "begin", providerConnectionId, expectedGeneration }));
      }
    });
    active.addEventListener("message", (event) => {
      if (!current() || socket !== active) {
        return;
      }
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === "status") {
          ++readGeneration;
          busy = false;
          terminalStatusReceived = !pendingPhases.has(frame.status.phase);
          applyStatus(frame.status);
        } else if (frame.type === "instructions") {
          showInstructions(frame);
        } else if (frame.type === "error") {
          feedback.textContent = errors[frame.code] ?? "Sign-in failed. Refresh its status.";
          clearInstructions();
          closeSocket();
          void loadStatus();
        }
      } catch {
        feedback.textContent = "Sign-in returned an invalid response. Refresh its status.";
        clearInstructions();
        closeSocket();
        void loadStatus();
      }
    });
    active.addEventListener("close", () => {
      if (!current() || socket !== active) {
        return;
      }
      socket = null;
      clearInstructions();
      if (!terminalStatusReceived) {
        feedback.textContent =
          "The sign-in connection failed or closed before completion. Check access and the refreshed status before trying again.";
      }
      void loadStatus();
    });
  }
  async function cancelAttempt() {
    if (!current() || cancel.disabled) {
      return;
    }
    const attempt = status;
    clearInstructions();
    feedback.textContent = "";
    busy = true;
    render();
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "cancel",
          attemptId: attempt.attemptId,
          generation: attempt.generation,
        }),
      );
      return;
    }
    const generation = ++readGeneration;
    try {
      await context.request(
        `${path}/oauth/attempts/${encodeURIComponent(attempt.attemptId)}/cancel`,
        {
          method: "POST",
          signal: context.signal,
          body: { connectionId: attempt.connectionId, generation: attempt.generation },
        },
      );
      if (current() && generation === readGeneration) {
        await loadStatus();
      }
    } catch (error) {
      if (!current() || generation !== readGeneration) {
        return;
      }
      if (error.status === 401) {
        context.onExpired();
      } else {
        feedback.textContent = message(error, true);
        await loadStatus();
      }
    }
  }
  context.signal.addEventListener(
    "abort",
    () => {
      ++readGeneration;
      clearInstructions();
      closeSocket();
    },
    { once: true },
  );
  render();
  void loadStatus();
  return section;
}
