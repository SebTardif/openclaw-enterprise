import { isDeepStrictEqual } from "node:util";
import type { FastifyRequest } from "fastify";
import type { PostgresPlatformState } from "@openclaw-enterprise/occ";
import type { IAMDriver } from "@openclaw-enterprise/contracts/drivers/iam";
import type { AuthenticatedRequestHandleV1 } from "@openclaw-enterprise/contracts/account-authority-v1";
import type { LifecycleReadCallV1 } from "@openclaw-enterprise/occ/lifecycle/ports-v1";
import type { LifecycleStatusReadPortV1 } from "@openclaw-enterprise/occ/lifecycle/handler-ports-v1";
import {
  parseLifecycleStatusReadRequestV1,
  projectLifecycleStatusReadV1,
  type LifecycleStatusReadMethodV1,
  type LifecycleStatusReadResultV1,
} from "@openclaw-enterprise/occ/lifecycle/status-projector-v1";
import {
  AdmissionFailure,
  type AdmittedCaller,
  type AdmissionRequest,
} from "../admission/admission-verifier.ts";
import type { ControllerAdmissionVerifier } from "../auth/index.ts";
import type { RequestContext } from "../http/identity.ts";
import type { LifecycleStatusHttpDependenciesV1 } from "../routes/lifecycle-status.ts";

export interface LifecycleStatusRequestCustodyV1 {
  attachReceiver(receiver: {
    readonly admissions: WeakMap<FastifyRequest, AdmittedCaller>;
    readonly contexts: WeakMap<FastifyRequest, RequestContext>;
    readonly identityAuthorities: WeakMap<FastifyRequest, { driver: IAMDriver; id: string }>;
    readonly resolveRecipient: () => object | undefined;
    readonly selectedIAMDriver: () => IAMDriver;
  }): void;
  beginRequest(request: FastifyRequest): void;
  closeRequest(request: FastifyRequest): void;
}
type Receiver = Parameters<LifecycleStatusRequestCustodyV1["attachReceiver"]>[0];
const operations = {
  readStatus: "getAgentLifecycleStatus",
  readOperation: "getAgentLifecycleOperation",
  listOperations: "listAgentLifecycleOperations",
  readCapability: "getAgentLifecycleCapability",
} as const;
const unavailable = () => new Error("Lifecycle request custody is unavailable.");
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
// Fastify parameter/query objects can have null prototypes. Compare their own
// data fields with a normalized snapshot rather than changing that transport.
const fields = (value: unknown): Record<string, unknown> => ({
  ...(value as Record<string, unknown>),
});

/** Production supplies the actual auth verifier and state owner; only the
 * original Fastify registration attaches its private admission/identity maps.
 * No parsed header, actor ID, cloned handle or request from another app can
 * enter the source. Read custody cannot be consumed by mutation participants. */
export function createControllerLifecycleStatusV1(options: {
  readonly installationId: string;
  readonly state: PostgresPlatformState;
  readonly verifier: ControllerAdmissionVerifier;
}): LifecycleStatusHttpDependenciesV1 {
  const { installationId, state, verifier } = options;
  let receiver: Receiver | undefined;
  type Request = {
    readonly request: FastifyRequest;
    readonly abort: AbortController;
    readonly deadline: bigint;
    readonly wallDeadline: number;
    readonly expiryChecks: (() => void)[];
    readonly expiryTimers: ReturnType<typeof setTimeout>[];
    readonly detach: () => void;
    closed: boolean;
    issued: boolean;
  };
  type Invocation = {
    readonly request: Request;
    readonly call: LifecycleReadCallV1;
    readonly admitted: AdmittedCaller;
    readonly admittedValues: AdmittedCaller;
    readonly context: RequestContext;
    readonly contextValues: Omit<RequestContext, "operation">;
    readonly authority: { driver: IAMDriver; id: string };
    readonly driver: IAMDriver;
    readonly driverId: string;
    readonly recipient: object;
    readonly admission: AdmissionRequest;
    readonly params: unknown;
    readonly query: unknown;
    used: boolean;
  };
  const requests = new WeakMap<FastifyRequest, Request | undefined>();
  const handles = new WeakMap<AuthenticatedRequestHandleV1, Invocation>();
  function closeRequest(request: FastifyRequest): void {
    const owned = requests.get(request);
    if (!requests.has(request)) requests.set(request, undefined);
    if (!owned || owned.closed) return;
    owned.closed = true;
    owned.abort.abort();
    owned.detach();
  }
  function assertRequest(owned: Request): void {
    if (
      !receiver ||
      owned.closed ||
      owned.abort.signal.aborted ||
      owned.request.raw.aborted ||
      process.hrtime.bigint() >= owned.deadline ||
      Date.now() >= owned.wallDeadline
    )
      throw unavailable();
    for (const check of owned.expiryChecks) check();
  }
  function assertInvocation(owned: Invocation): void {
    assertRequest(owned.request);
    const request = owned.request.request;
    if (
      !receiver ||
      receiver.resolveRecipient() !== owned.recipient ||
      receiver.admissions.get(request) !== owned.admitted ||
      receiver.contexts.get(request) !== owned.context ||
      receiver.identityAuthorities.get(request) !== owned.authority ||
      receiver.selectedIAMDriver() !== owned.driver ||
      owned.driver.id !== owned.driverId ||
      owned.authority.driver !== owned.driver ||
      owned.authority.id !== owned.driverId ||
      request.id !== owned.admission.requestId ||
      request.method !== "GET" ||
      owned.context.operation.operationId !== owned.admission.routeId ||
      !isDeepStrictEqual(owned.admitted, owned.admittedValues) ||
      owned.context.actorId !== owned.contextValues.actorId ||
      owned.context.issuer !== owned.contextValues.issuer ||
      owned.context.subject !== owned.contextValues.subject ||
      owned.context.admissionDecisionId !== owned.contextValues.admissionDecisionId ||
      !isDeepStrictEqual(fields(request.params), owned.params) ||
      !isDeepStrictEqual(fields(request.query), owned.query) ||
      !isDeepStrictEqual(fields(request.headers), owned.admission.headers)
    )
      throw unavailable();
  }
  function retainExpiry(
    owned: Request,
    expiry: { assertUnexpired(): void; remainingMs(): number },
  ): void {
    assertRequest(owned);
    const remaining = Math.min(30_000, expiry.remainingMs());
    if (remaining < 1)
      throw new AdmissionFailure(401, "UNAUTHENTICATED", "Authentication expired.");
    owned.expiryChecks.push(expiry.assertUnexpired);
    const timer = setTimeout(() => closeRequest(owned.request), remaining);
    timer.unref();
    owned.expiryTimers.push(timer);
  }
  async function authorize(owned: Invocation): Promise<void> {
    assertInvocation(owned);
    // Original credentials are private copies of this verified request only.
    // The real verifier rechecks primary-store sessions with cookie cache and
    // refresh disabled, or the exact service-key path (never cookie fallback).
    const expiry = await verifier.verifyLifecycleReadV1(owned.admission);
    const admitted = expiry.admitted;
    assertInvocation(owned);
    retainExpiry(owned.request, expiry);
    if (
      admitted.method !== owned.admitted.method ||
      !isDeepStrictEqual(admitted.externalIdentity, owned.admitted.externalIdentity) ||
      !isDeepStrictEqual(admitted.admittedScope, owned.admitted.admittedScope)
    )
      throw new AdmissionFailure(401, "UNAUTHENTICATED", "The current request identity changed.");
    const identity = await owned.driver.lookupIdentity(
      admitted.method === "api_key"
        ? {
            servicePrincipalId: admitted.externalIdentity.subject,
            ...(admitted.admittedScope.namespaceId === undefined
              ? {}
              : { namespaceId: admitted.admittedScope.namespaceId }),
          }
        : { issuer: admitted.externalIdentity.issuer, subject: admitted.externalIdentity.subject },
    );
    assertInvocation(owned);
    if (
      !identity ||
      identity.id !== owned.context.actorId ||
      (admitted.method === "api_key"
        ? identity.kind !== "service_principal" ||
          identity.agentId !== undefined ||
          identity.namespaceId !== admitted.admittedScope.namespaceId
        : identity.kind !== "principal" ||
          identity.issuer !== admitted.externalIdentity.issuer ||
          identity.subject !== admitted.externalIdentity.subject)
    )
      throw new AdmissionFailure(
        403,
        "FORBIDDEN",
        "The current exact Agent read is not authorized.",
      );
    const scope = owned.params as { namespaceId: string; agentId: string };
    const decision = await owned.driver.authorize({
      principalId: identity.id,
      action: "read",
      resource: { kind: "agent", namespaceId: scope.namespaceId, id: scope.agentId },
    });
    assertInvocation(owned);
    if (
      !decision ||
      typeof decision.allowed !== "boolean" ||
      decision.driverId !== owned.driverId ||
      !decision.evidence ||
      (decision.evidence.identityId !== undefined && !text(decision.evidence.identityId)) ||
      !["groupIds", "bindingIds", "roleIds", "restrictionIds"].every((key) => {
        const entries = decision.evidence[key as keyof typeof decision.evidence];
        return Array.isArray(entries) && entries.every(text);
      })
    )
      throw unavailable();
    if (!decision.allowed)
      throw new AdmissionFailure(
        403,
        "FORBIDDEN",
        "The current exact Agent read is not authorized.",
      );
  }
  async function read<K extends LifecycleStatusReadMethodV1>(
    method: K,
    input: unknown,
    call: LifecycleReadCallV1,
  ): Promise<LifecycleStatusReadResultV1<K>> {
    try {
      const request = parseLifecycleStatusReadRequestV1(method, input);
      const owned = handles.get(call.authenticated);
      if (!owned || owned.used || owned.call !== call || call.signal !== owned.request.abort.signal)
        throw unavailable();
      owned.used = true;
      assertInvocation(owned);
      const params = owned.params as {
        namespaceId: string;
        agentId: string;
        operationRef?: string;
      };
      const query = owned.query as { limit?: string; afterGeneration?: string };
      if (
        owned.admission.routeId !== operations[method] ||
        request.namespaceId !== params.namespaceId ||
        request.agentId !== params.agentId ||
        (method === "readOperation" &&
          parseLifecycleStatusReadRequestV1("readOperation", request).operationRef !==
            params.operationRef) ||
        (method === "listOperations" &&
          !isDeepStrictEqual(fields(request), {
            schemaVersion: 1,
            namespaceId: params.namespaceId,
            agentId: params.agentId,
            limit: query.limit === undefined ? 20 : Number(query.limit),
            afterGeneration:
              query.afterGeneration === undefined ? null : Number(query.afterGeneration),
          }))
      )
        throw unavailable();
      await authorize(owned);
      const remainingMs = Math.floor(
        Number(owned.request.deadline - process.hrtime.bigint()) / 1_000_000,
      );
      const value = await state.readLifecycleStatusV1(installationId, method, request, {
        signal: call.signal,
        timeoutMs: Math.min(3000, remainingMs),
      });
      assertInvocation(owned);
      // Recheck after the complete bounded transaction, including its cleanup.
      // Retained bytes never bypass revocation, current policy or new page checks.
      await authorize(owned);
      return projectLifecycleStatusReadV1(
        method,
        request,
        value === undefined ? { kind: "rejected", code: "NOT_FOUND" } : { kind: "read", value },
      );
    } catch (error) {
      if (error instanceof AdmissionFailure)
        return {
          kind: "rejected",
          code: error.code === "UNAUTHENTICATED" ? "UNAUTHENTICATED" : "NOT_FOUND",
        };
      return { kind: "unavailable" };
    }
  }
  const source = Object.freeze<LifecycleStatusReadPortV1>({
    readStatus: (request, call) => read("readStatus", request, call),
    readOperation: (request, call) => read("readOperation", request, call),
    listOperations: (request, call) => read("listOperations", request, call),
    readCapability: (request, call) => read("readCapability", request, call),
  });
  return Object.freeze<LifecycleStatusHttpDependenciesV1>({
    source,
    requests: Object.freeze<LifecycleStatusRequestCustodyV1>({
      attachReceiver(value) {
        if (receiver) throw unavailable();
        receiver = Object.freeze({ ...value });
      },
      beginRequest(request) {
        if (!receiver || requests.has(request)) throw unavailable();
        const abort = new AbortController();
        const deadline = process.hrtime.bigint() + 30_000_000_000n;
        const wallDeadline = Date.now() + 30_000;
        const close = () => closeRequest(request);
        const timer = setTimeout(close, 30_000);
        timer.unref();
        const expiryTimers: ReturnType<typeof setTimeout>[] = [];
        requests.set(request, {
          request,
          abort,
          deadline,
          wallDeadline,
          closed: false,
          issued: false,
          expiryChecks: [],
          expiryTimers,
          detach() {
            clearTimeout(timer);
            for (const expiryTimer of expiryTimers) clearTimeout(expiryTimer);
            request.raw.removeListener("aborted", close);
          },
        });
        request.raw.once("aborted", close);
      },
      closeRequest,
    }),
    async resolveReadCall(request) {
      const owned = requests.get(request);
      if (!owned || owned.issued || !receiver) return undefined;
      assertRequest(owned);
      const admitted = receiver.admissions.get(request);
      const context = receiver.contexts.get(request);
      const authority = receiver.identityAuthorities.get(request);
      const recipient = receiver.resolveRecipient();
      if (
        !admitted ||
        !context ||
        !authority ||
        !recipient ||
        !Object.values(operations).some(
          (operation) => operation === context.operation.operationId,
        ) ||
        request.method !== "GET" ||
        (admitted.method !== "session" && admitted.method !== "api_key") ||
        admitted.admittedScope.installationId !== installationId ||
        context.admissionDecisionId !== admitted.decisionId ||
        context.issuer !== admitted.externalIdentity.issuer ||
        context.subject !== admitted.externalIdentity.subject
      )
        return undefined;
      const params = structuredClone(fields(request.params)) as {
        namespaceId: string;
        agentId: string;
      };
      if (
        admitted.admittedScope.namespaceId !== undefined &&
        admitted.admittedScope.namespaceId !== params.namespaceId
      )
        return undefined;
      // Consume the ORIGINAL verifier's expiry as well as later rechecks: a
      // concurrent refresh never renews this already-admitted request's ceiling.
      retainExpiry(owned, verifier.consumeLifecycleReadExpiryV1(admitted));
      const admission: AdmissionRequest = Object.freeze({
        requestId: request.id,
        method: request.method,
        routeId: context.operation.operationId,
        requestedScope: Object.freeze({ installationId, namespaceId: params.namespaceId }),
        transport: Object.freeze({
          remoteAddress: request.raw.socket.remoteAddress ?? "127.0.0.1",
          ...(request.raw.socket.localAddress === undefined
            ? {}
            : { localAddress: request.raw.socket.localAddress }),
          trustProxy: false,
        }),
        ...(typeof request.headers.authorization === "string"
          ? { authorizationHeader: request.headers.authorization }
          : {}),
        headers: structuredClone({ ...request.headers }),
      });
      const handle = Object.freeze({}) as AuthenticatedRequestHandleV1;
      const call = Object.freeze({ authenticated: handle, signal: owned.abort.signal });
      owned.issued = true;
      const invocation: Invocation = {
        request: owned,
        call,
        admitted,
        admittedValues: structuredClone(admitted),
        context,
        contextValues: {
          actorId: context.actorId,
          issuer: context.issuer,
          subject: context.subject,
          admissionDecisionId: context.admissionDecisionId,
        },
        authority,
        driver: authority.driver,
        driverId: authority.id,
        recipient,
        admission,
        params,
        query: structuredClone(fields(request.query)),
        used: false,
      };
      handles.set(handle, invocation);
      assertInvocation(invocation);
      return call;
    },
  });
}
