import { WebSocket, WebSocketServer } from "ws";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "@openclaw-enterprise/occ";
import { acquireAgentOAuth } from "./acquire.ts";

const protocol = "occ.agent-oauth.v1";
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const providerConnectionId = new RegExp(`^pco_${uuid}$`);
const attemptId = new RegExp(`^${uuid}$`);
const path = new RegExp(`^/namespaces/(ns_${uuid})/agents/(agt_${uuid})/oauth/acquire$`);
const timeoutMs = 10_000;

/** @typedef {import("@openclaw-enterprise/occ").AgentOAuthStatus} AgentOAuthStatus */
/**
 * @typedef {object} Admission
 * @property {import("@openclaw-enterprise/occ").OpenClawController} controller
 * @property {string} actorId
 * @property {() => Promise<void>} assertAuthorized Revalidate the exact authenticated session.
 * @property {(error: unknown) => Promise<void>} auditDenial Record exact owner authorization denials after their transaction unwinds.
 * @property {(event: "begin" | "cancel" | "complete" | "interrupted", status: AgentOAuthStatus, writer: {append(event: import("@openclaw-enterprise/contracts").AuditEvent): Promise<void>}) => Promise<void>} audit
 */
/**
 * @typedef {object} Scope
 * @property {string} namespaceId
 * @property {string} agentId
 */

function failureCode(error) {
  if (error instanceof DependencyUnavailableError) {
    return "RUNTIME_UNAVAILABLE";
  }
  if (error instanceof AuthorizationDeniedError) {
    return "AUTHORIZATION_LOST";
  }
  if (error instanceof ResourceConflictError) {
    return "CONFLICT";
  }
  if (error instanceof ScopeViolationError) {
    return "INVALID_REQUEST";
  }
  return "OAUTH_FAILED";
}

async function bounded(operation, signal) {
  signal.throwIfAborted();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  let abort;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        abort = () => reject(new Error("TIMEOUT"));
        deadline.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    deadline.removeEventListener("abort", abort);
  }
}

function frame(data, binary) {
  if (binary) {
    throw new Error("INVALID_REQUEST");
  }
  const value = JSON.parse(data.toString());
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_REQUEST");
  }
  const keys =
    value.type === "begin"
      ? ["type", "providerConnectionId", "expectedGeneration"]
      : value.type === "redirect-url"
        ? ["type", "attemptId", "generation", "url"]
        : value.type === "cancel"
          ? ["type", "attemptId", "generation"]
          : [];
  if (
    !keys.length ||
    keys.length !== Object.keys(value).length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error("INVALID_REQUEST");
  }
  if (value.type === "begin") {
    if (
      typeof value.providerConnectionId !== "string" ||
      !providerConnectionId.test(value.providerConnectionId) ||
      !Number.isSafeInteger(value.expectedGeneration) ||
      value.expectedGeneration < 0
    ) {
      throw new Error("INVALID_REQUEST");
    }
  } else if (
    typeof value.attemptId !== "string" ||
    !attemptId.test(value.attemptId) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    (value.type === "redirect-url" &&
      (typeof value.url !== "string" || Buffer.byteLength(value.url, "utf8") > 8192))
  ) {
    throw new Error("INVALID_REQUEST");
  }
  return value;
}

/**
 * Authentication and native module selection belong to controller composition.
 * The socket carries actor-private challenges and input, never credential bundles.
 * @param {{admit: (request: import("node:http").IncomingMessage, scope: Scope) => Promise<Admission>, selectMethod: (input: Admission & Scope & {providerConnectionId: string}) => Promise<{method: import("@openclaw-enterprise/occ").AgentOAuthMethod, acquire: ReturnType<typeof import("./native-acquisition.mjs").createNativeOAuthAcquisition>}>}} options
 */
export function createAgentOAuthSocketServer({ admit, selectMethod }) {
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: 16_384,
    perMessageDeflate: false,
    closeTimeout: 1000,
    handleProtocols: () => protocol,
  });
  const pending = new Map();
  const sessions = new Set();
  const tasks = new Set();
  let closing = false;
  const track = (promise) => {
    tasks.add(promise);
    void promise.finally(() => tasks.delete(promise)).catch(() => {});
    return promise;
  };

  function session(socket, context, scope) {
    const abort = new AbortController();
    let selected;
    let began = false;
    let completed = false;
    let stopped = false;
    let explicitCancel = false;
    let redirect;
    let assertAttempt;
    let checking = false;
    const send = (value) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(value));
      }
    };
    const stop = (code) => {
      if (stopped || completed) {
        return;
      }
      stopped = true;
      abort.abort();
      redirect?.reject(new Error("OAuth input closed."));
      if (code) {
        send({ type: "error", code });
      }
      if (!began) {
        socket.close(1008);
      }
    };
    const current = async () => {
      abort.signal.throwIfAborted();
      try {
        await bounded(context.assertAuthorized, abort.signal);
        if (assertAttempt) {
          await bounded(assertAttempt, abort.signal);
        }
        abort.signal.throwIfAborted();
      } catch (error) {
        stop("AUTHORIZATION_LOST");
        await context.auditDenial(error);
        throw error;
      }
    };
    const firstMessage = setTimeout(() => stop("TIMEOUT"), timeoutMs);
    const interval = setInterval(() => {
      if (checking || stopped || completed) {
        return;
      }
      checking = true;
      void track(
        current()
          .catch(() => {})
          .finally(() => {
            checking = false;
          }),
      );
    }, 5000);
    const control = { stop };
    sessions.add(control);
    socket.once("close", () => {
      stop();
      clearTimeout(firstMessage);
      clearInterval(interval);
      sessions.delete(control);
    });
    socket.on("error", () => stop("INVALID_REQUEST"));

    const cancel = async (event) =>
      context.controller.transact(async (unit) => {
        const status = await context.controller.agentOAuth.cancel(
          context.actorId,
          scope.namespaceId,
          scope.agentId,
          selected.attemptId,
          selected.generation,
        );
        await context.audit(event, status, unit.audit);
        return status;
      });

    async function begin(message) {
      try {
        await current();
        const native = await bounded(
          () =>
            selectMethod({
              ...context,
              ...scope,
              providerConnectionId: message.providerConnectionId,
            }),
          abort.signal,
        );
        await current();
        selected = await context.controller.transact(async (unit) => {
          const status = await context.controller.agentOAuth.begin(
            context.actorId,
            scope.namespaceId,
            scope.agentId,
            native.method,
            message.expectedGeneration,
            message.providerConnectionId,
          );
          await context.audit("begin", status, unit.audit);
          return status;
        });
        await current();
        send({ type: "status", status: selected });
        const status = await acquireAgentOAuth({
          ...scope,
          controller: context.controller,
          actorId: context.actorId,
          selected,
          signal: abort.signal,
          assertSession: current,
          acquire: async (options) => {
            assertAttempt = options.assertCurrent;
            await native.acquire({
              ...options,
              assertCurrent: current,
              stage: async (envelope) => {
                await current();
                try {
                  await options.stage(envelope);
                } catch (error) {
                  await context.auditDenial(error);
                  throw error;
                }
                await current();
              },
            });
          },
          onInstructions: async (instructions) => {
            await current();
            if (instructions.kind === "browser") {
              if (redirect) {
                throw new Error("Duplicate browser instructions.");
              }
              redirect = { ...Promise.withResolvers(), accepting: true };
              void redirect.promise.catch(() => {});
            }
            send({
              type: "instructions",
              attemptId: selected.attemptId,
              generation: selected.generation,
              instructions,
            });
          },
          requestRedirect: () => {
            if (!redirect) {
              throw new Error("No browser input is pending.");
            }
            return redirect.promise;
          },
        });
        await current();
        await context.controller.transact(async (unit) => {
          await assertAttempt();
          await context.audit("complete", status, unit.audit);
        });
        await current();
        completed = true;
        send({ type: "status", status });
      } catch (error) {
        await context.auditDenial(error);
        if (!stopped) {
          send({ type: "error", code: failureCode(error) });
        }
      } finally {
        clearTimeout(firstMessage);
        clearInterval(interval);
        redirect?.reject(new Error("OAuth input closed."));
        if (!completed && selected) {
          // Disconnect, cancellation and audit failure must close retained native
          // authority. Cleanup retains the durable staging identity on unknown writes.
          abort.abort();
          try {
            const status = await cancel(explicitCancel ? "cancel" : "interrupted");
            await bounded(context.assertAuthorized, new AbortController().signal);
            send({ type: "status", status });
          } catch {
            /* Closed authority may no longer administer the Agent. */
          }
        }
        stopped = true;
        socket.close(completed ? 1000 : 1008);
      }
    }

    socket.on("message", (data, binary) => {
      if (stopped || completed) {
        return;
      }
      let message;
      try {
        message = frame(data, binary);
      } catch {
        stop("INVALID_REQUEST");
        return;
      }
      if (message.type === "begin") {
        if (began) {
          stop("INVALID_REQUEST");
          return;
        }
        began = true;
        clearTimeout(firstMessage);
        void track(begin(message));
        return;
      }
      if (
        !selected ||
        message.attemptId !== selected.attemptId ||
        message.generation !== selected.generation
      ) {
        stop("INVALID_REQUEST");
        return;
      }
      if (message.type === "redirect-url") {
        if (!redirect?.accepting) {
          stop("INVALID_REQUEST");
          return;
        }
        redirect.accepting = false;
        void track(
          current()
            .then(() => redirect.resolve(message.url))
            .catch(() => {}),
        );
      } else {
        void track(
          current()
            .then(() => {
              explicitCancel = true;
              stop();
            })
            .catch(() => {}),
        );
      }
    });
  }

  return {
    /** @param {import("node:http").IncomingMessage} request @param {import("node:stream").Duplex} socket @param {Buffer} head */
    async upgrade(request, socket, head) {
      const scope = path.exec(request.url ?? "");
      if (closing || !scope || request.headers["sec-websocket-protocol"] !== protocol) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const abort = new AbortController();
      pending.set(socket, abort);
      const closed = () => abort.abort();
      socket.once("close", closed);
      socket.once("error", closed);
      try {
        const selected = { namespaceId: scope[1], agentId: scope[2] };
        const context = await bounded(() => admit(request, selected), abort.signal);
        await bounded(context.assertAuthorized, abort.signal);
        if (closing || socket.destroyed || abort.signal.aborted) {
          return;
        }
        server.handleUpgrade(request, socket, head, (websocket) =>
          session(websocket, context, selected),
        );
      } catch {
        if (!socket.destroyed) {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        }
      } finally {
        pending.delete(socket);
        socket.off("close", closed);
        socket.off("error", closed);
      }
    },
    async close() {
      closing = true;
      for (const [socket, abort] of pending) {
        abort.abort();
        socket.destroy();
      }
      for (const session of sessions) {
        session.stop();
      }
      for (const socket of server.clients) {
        socket.close(1001);
      }
      await Promise.allSettled([...tasks]);
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
