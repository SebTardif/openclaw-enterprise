import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type { Principal } from "@openclaw-enterprise/contracts";
import type { AuthenticatedRequestHandleV1 } from "@openclaw-enterprise/contracts/account-authority-v1";
import type { WorkloadProfileAccountUnit } from "@openclaw-enterprise/occ/services/workload-profile/port";
import type { FastifyRequest } from "fastify";
import type { IAMDriver } from "@openclaw-enterprise/contracts/drivers/iam";
import type { AuthenticatedRequestHandleSourceV1 } from "@openclaw-enterprise/contracts/account-authority-v1";
import type {
  WorkloadProfilePurposeRequestV1,
  WorkloadProfileRequestCustodySourceV1,
  WorkloadProfileRequestLeaseV1,
} from "@openclaw-enterprise/occ/account-authority/workload-profile";
import type { AdmittedCaller } from "../admission/admission-verifier.ts";
import type { RequestContext } from "../http/identity.ts";

/** Private captured facts from this controller's actual BetterAuth verification.
 * These values are not an opaque handle or a current account/security grant. */
export interface ControllerVerifiedSessionV1 {
  readonly installationId: string;
  readonly issuer: string;
  readonly accountId: string;
  readonly sessionId: string;
  readonly sessionUserId: string;
  /** Private discriminator of the actually authenticated bearer; never public. */
  readonly sessionCredentialDigest: string;
  readonly expiresAt: string;
  readonly requestId: string;
  readonly routeId: string;
  readonly method: string;
}

/** Original HTTP composition supplies its existing identity maps and receiver.
 * The session resolver is closed over the real auth verifier's private result;
 * callers cannot enroll a raw header or a parsed identity through this port. */
export interface ControllerWorkloadProfileRequestReceiverV1 {
  readonly admissions: WeakMap<FastifyRequest, AdmittedCaller>;
  readonly contexts: WeakMap<FastifyRequest, RequestContext>;
  readonly identityAuthorities: WeakMap<FastifyRequest, { driver: IAMDriver; id: string }>;
  readonly resolveRecipient: () => object | undefined;
  readonly selectedIAMDriver: () => IAMDriver;
}

/** The existing admission owner calls begin before verifier acquisition and
 * capture only after actual admission and browser-intent validation succeed.
 * Root response/abort teardown closes the original request, never its DB client. */
export interface ControllerWorkloadProfileRequestCustodyV1 {
  /** Attach the original app's maps exactly once after controller construction. */
  attachReceiver(receiver: ControllerWorkloadProfileRequestReceiverV1): void;
  /** Private source membership check for the original session-security consumer. */
  resolveConsumedSession(
    lease: WorkloadProfileRequestLeaseV1,
    unit: WorkloadProfileAccountUnit,
  ): ControllerWorkloadProfileSessionLookupV1 | undefined;
  beginRequest(request: FastifyRequest): void;
  captureAdmission(request: FastifyRequest, admitted: AdmittedCaller): void;
  closeRequest(request: FastifyRequest): void;
  withWorkloadProfileInvocation<T>(
    actualRequest: FastifyRequest,
    exactPurposeAndBinding: WorkloadProfilePurposeRequestV1,
    work: () => Promise<T>,
  ): Promise<T>;
  readonly invocations: AuthenticatedRequestHandleSourceV1;
  readonly requests: WorkloadProfileRequestCustodySourceV1;
}

/** Capture only safe selected values; the auth verifier, not this shape helper,
 * supplies their provenance. Session bearers never leave that verifier. */
export function captureControllerSessionValuesV1(
  value: ControllerVerifiedSessionV1,
): Readonly<ControllerVerifiedSessionV1> {
  const captured = {
    installationId: value.installationId,
    issuer: value.issuer,
    accountId: value.accountId,
    sessionId: value.sessionId,
    sessionUserId: value.sessionUserId,
    sessionCredentialDigest: value.sessionCredentialDigest,
    expiresAt: value.expiresAt,
    requestId: value.requestId,
    routeId: value.routeId,
    method: value.method,
  };
  if (
    Object.values(captured).some(
      (field) => typeof field !== "string" || field.length === 0 || field.length > 1024,
    ) ||
    captured.accountId !== captured.sessionUserId ||
    !/^[0-9a-f]{64}$/.test(captured.sessionCredentialDigest) ||
    captured.issuer !== `occ:installation:${captured.installationId}:better-auth` ||
    !Number.isFinite(Date.parse(captured.expiresAt)) ||
    new Date(captured.expiresAt).toISOString() !== captured.expiresAt
  ) {
    throw new DependencyUnavailableError("The original controller session is unavailable.");
  }
  return Object.freeze(captured);
}

/** A captured locator, not a database/current-security grant. Only an original
 * consumed request lease can resolve it through this custody object. */
export interface ControllerWorkloadProfileSessionLookupV1 {
  readonly installationId: string;
  readonly accountId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly sessionId: string;
  readonly sessionCredentialDigest: string;
  readonly expiresAt: string;
  readonly principal: Principal;
}

const unavailable = () =>
  new DependencyUnavailableError("The authenticated workload profile request is unavailable.");
const allowedPurposes = new Set([
  "workload-profile-deployment",
  "workload-profile-draft-selection",
  "workload-profile-deployment-recovery",
]);

/** Created once by the original auth verifier before controller construction.
 * The stable sources can be captured by ControllerOptions at that point; all
 * calls fail closed until the original HTTP receiver attaches its existing maps.
 * The private verifier callback is supplied only by the original auth module.
 * There is no public raw-header/identity constructor or alternate issuer. */
export function createControllerWorkloadProfileRequestCustodyV1(
  options: Readonly<{ installationId: string; maxRequestLifetimeMs: number }>,
  takeVerifiedSession: (
    admitted: AdmittedCaller,
  ) => Readonly<ControllerVerifiedSessionV1> | undefined,
): ControllerWorkloadProfileRequestCustodyV1 {
  const installationId = options.installationId;
  const maxMs = options.maxRequestLifetimeMs;
  if (
    typeof installationId !== "string" ||
    installationId.length === 0 ||
    installationId.length > 1024 ||
    !Number.isSafeInteger(maxMs) ||
    maxMs < 1 ||
    maxMs > 120000 ||
    typeof takeVerifiedSession !== "function"
  )
    throw unavailable();
  let receiver: ControllerWorkloadProfileRequestReceiverV1 | undefined;
  type RequestRecord = {
    readonly request: FastifyRequest;
    readonly signal: AbortController;
    readonly deadline: bigint;
    readonly began: bigint;
    readonly observedAt: number;
    readonly expiresAt: number;
    readonly purposes: Set<string>;
    readonly detach: () => void;
    closed: boolean;
    captured: boolean;
    admitted?: AdmittedCaller;
    session?: Readonly<ControllerVerifiedSessionV1>;
    sessionDeadline?: bigint;
  };
  type Invocation = {
    readonly request: RequestRecord;
    readonly context: RequestContext;
    readonly authority: Readonly<{ driver: IAMDriver; id: string }>;
    readonly authorityRecord: { driver: IAMDriver; id: string };
    readonly deadline: bigint;
    readonly recipient: object;
    readonly purpose: WorkloadProfilePurposeRequestV1;
    readonly principal: Principal;
    readonly handle: AuthenticatedRequestHandleV1;
    readonly expiresAt: string;
    readonly requestId: string;
    readonly decisionId: string;
    active: boolean;
    used: boolean;
  };
  // undefined is a closed-before-begin marker in this SAME custody map.
  // A response close racing admission can never create fresh custody later.
  const records = new WeakMap<FastifyRequest, RequestRecord | undefined>();
  const handles = new WeakMap<AuthenticatedRequestHandleV1, Invocation>();
  const consumed = new WeakMap<
    WorkloadProfileRequestLeaseV1,
    { invocation: Invocation; unit: WorkloadProfileAccountUnit; active: boolean }
  >();
  const ambient = new AsyncLocalStorage<Invocation>();
  function assertRequest(record: RequestRecord): void {
    if (
      !receiver ||
      record.closed ||
      record.signal.signal.aborted ||
      record.request.raw.aborted ||
      process.hrtime.bigint() >= record.deadline ||
      Date.now() >= record.expiresAt
    )
      throw unavailable();
  }
  function assertInvocation(value: Invocation): void {
    assertRequest(value.request);
    if (
      !value.active ||
      !receiver ||
      receiver.resolveRecipient() !== value.recipient ||
      receiver.admissions.get(value.request.request) !== value.request.admitted ||
      receiver.contexts.get(value.request.request) !== value.context ||
      receiver.identityAuthorities.get(value.request.request) !== value.authorityRecord ||
      value.authorityRecord.driver !== value.authority.driver ||
      value.authorityRecord.id !== value.authority.id ||
      receiver.selectedIAMDriver() !== value.authority.driver ||
      value.authority.driver.id !== value.authority.id ||
      value.context.actorId !== value.principal.id ||
      value.context.issuer !== value.principal.issuer ||
      value.context.subject !== value.principal.subject ||
      value.context.admissionDecisionId !== value.decisionId ||
      value.request.request.id !== value.requestId ||
      value.request.request.method !== value.request.session?.method ||
      value.context.operation.operationId !== value.request.session?.routeId ||
      process.hrtime.bigint() >= value.deadline ||
      Date.now() >= Date.parse(value.expiresAt)
    )
      throw unavailable();
  }
  function closeRequest(request: FastifyRequest): void {
    if (!records.has(request)) {
      records.set(request, undefined);
      return;
    }
    const record = records.get(request);
    if (!record || record.closed) return;
    record.closed = true;
    record.signal.abort();
    record.detach();
  }
  const invocations: AuthenticatedRequestHandleSourceV1 = Object.freeze({
    async forCurrentInvocation() {
      const invocation = ambient.getStore();
      if (!invocation || invocation.used) throw unavailable();
      assertInvocation(invocation);
      return invocation.handle;
    },
  });
  const requests: WorkloadProfileRequestCustodySourceV1 =
    Object.freeze<WorkloadProfileRequestCustodySourceV1>({
      async consume(handle, purpose, unit, retainCleanup) {
        const invocation = handles.get(handle);
        if (!invocation || invocation.used || ambient.getStore() !== invocation)
          throw unavailable();
        // Consume once even when a later field or registration fails.
        invocation.used = true;
        let held = true;
        const release = () => {
          held = false;
        };
        retainCleanup(release);
        assertInvocation(invocation);
        const captured = immutableCopy(purpose);
        if (
          !isDeepStrictEqual(captured, invocation.purpose) ||
          unit.installationId !== installationId ||
          unit.signal.aborted
        )
          throw unavailable();
        const session = invocation.request.session;
        if (!session) throw unavailable();
        let lease: WorkloadProfileRequestLeaseV1;
        const assertCurrent = () => {
          if (!held || unit.signal.aborted) throw unavailable();
          assertInvocation(invocation);
        };
        lease = Object.freeze({
          facts: Object.freeze({
            installationId,
            principalId: invocation.principal.id,
            accountRef: session.accountId,
            sessionRef: session.sessionId,
            requestId: invocation.requestId,
            admissionDecisionId: invocation.decisionId,
            expiresAt: invocation.expiresAt,
          }),
          assertCurrent,
        });
        consumed.set(lease, { invocation, unit, active: true });
        assertCurrent();
        return lease;
      },
    });
  return Object.freeze({
    attachReceiver(input: ControllerWorkloadProfileRequestReceiverV1) {
      if (receiver) throw unavailable();
      const captured = {
        admissions: input.admissions,
        contexts: input.contexts,
        identityAuthorities: input.identityAuthorities,
        resolveRecipient: input.resolveRecipient,
        selectedIAMDriver: input.selectedIAMDriver,
      };
      // Reject look-alike maps; original app composition passes its actual maps.
      const probe = {};
      WeakMap.prototype.has.call(captured.admissions, probe);
      WeakMap.prototype.has.call(captured.contexts, probe);
      WeakMap.prototype.has.call(captured.identityAuthorities, probe);
      if (
        typeof captured.resolveRecipient !== "function" ||
        typeof captured.selectedIAMDriver !== "function"
      )
        throw unavailable();
      receiver = Object.freeze(captured);
    },
    beginRequest(request: FastifyRequest) {
      if (!receiver || records.has(request)) throw unavailable();
      const abort = new AbortController();
      const now = Date.now();
      const began = process.hrtime.bigint();
      const onAbort = () => closeRequest(request);
      const timer = setTimeout(onAbort, maxMs);
      timer.unref();
      const record: RequestRecord = {
        request,
        signal: abort,
        began,
        observedAt: now,
        deadline: began + BigInt(maxMs) * 1000000n,
        expiresAt: now + maxMs,
        purposes: new Set(),
        closed: false,
        captured: false,
        detach: () => {
          clearTimeout(timer);
          request.raw.removeListener("aborted", onAbort);
        },
      };
      records.set(request, record);
      try {
        request.raw.once("aborted", onAbort);
        assertRequest(record);
      } catch (error) {
        closeRequest(request);
        throw error;
      }
    },
    captureAdmission(request: FastifyRequest, admitted: AdmittedCaller) {
      const record = records.get(request);
      if (!record || record.captured || receiver?.admissions.get(request) !== admitted)
        throw unavailable();
      record.captured = true;
      record.admitted = admitted;
      // Ordinary service-key operations remain ordinary operations. They receive
      // no human workload-profile proof and can never enter this producer.
      if (admitted.method !== "session") return;
      const supplied = takeVerifiedSession(admitted);
      if (!supplied) return;
      const session = captureControllerSessionValuesV1(supplied);
      assertRequest(record);
      if (
        session.installationId !== installationId ||
        session.requestId !== request.id ||
        session.method !== request.method ||
        session.issuer !== admitted.externalIdentity.issuer ||
        session.accountId !== admitted.externalIdentity.subject ||
        Date.now() >= Date.parse(session.expiresAt)
      )
        throw unavailable();
      // Anchor session expiry once to the ORIGINAL request observations. A wall
      // clock rollback during verification or before recovery cannot renew it.
      const sessionExpiry = Date.parse(session.expiresAt);
      const captureNow = Date.now();
      const captureMonotonic = process.hrtime.bigint();
      const originalBound =
        record.began +
        BigInt(Math.max(0, Math.floor(sessionExpiry - record.observedAt))) * 1000000n;
      const captureBound =
        captureMonotonic + BigInt(Math.max(0, Math.floor(sessionExpiry - captureNow))) * 1000000n;
      const sessionBound = originalBound < captureBound ? originalBound : captureBound;
      const deadline = sessionBound < record.deadline ? sessionBound : record.deadline;
      if (captureMonotonic >= deadline || captureNow >= sessionExpiry) throw unavailable();
      record.sessionDeadline = deadline;
      record.session = session;
    },
    closeRequest,
    async withWorkloadProfileInvocation<T>(
      request: FastifyRequest,
      input: WorkloadProfilePurposeRequestV1,
      work: () => Promise<T>,
    ): Promise<T> {
      const purpose = immutableCopy(input);
      const record = records.get(request);
      if (
        !record ||
        !record.session ||
        record.sessionDeadline === undefined ||
        !record.admitted ||
        !receiver ||
        ambient.getStore() ||
        !allowedPurposes.has(purpose.purpose) ||
        !Array.isArray(purpose.binding) ||
        purpose.binding.length !== 2 ||
        record.purposes.has(purpose.purpose) ||
        typeof work !== "function"
      )
        throw unavailable();
      assertRequest(record);
      const context = receiver.contexts.get(request);
      const authority = receiver.identityAuthorities.get(request);
      const recipient = receiver.resolveRecipient();
      if (
        !context ||
        !authority ||
        !recipient ||
        context.actorId !== purpose.binding[0] ||
        context.issuer !== record.session.issuer ||
        context.subject !== record.session.accountId ||
        context.admissionDecisionId !== record.admitted.decisionId ||
        context.operation.operationId !== record.session.routeId
      )
        throw unavailable();
      const expectedOperation =
        purpose.purpose === "workload-profile-draft-selection" ? "updateAgent" : "deployAgent";
      if (context.operation.operationId !== expectedOperation) throw unavailable();
      record.purposes.add(purpose.purpose);
      const handle = Object.freeze({}) as AuthenticatedRequestHandleV1;
      const expiry = Math.min(record.expiresAt, Date.parse(record.session.expiresAt));
      const invocation: Invocation = {
        request: record,
        context,
        authority: Object.freeze({ driver: authority.driver, id: authority.id }),
        authorityRecord: authority,
        deadline: record.sessionDeadline,
        recipient,
        purpose,
        principal: Object.freeze({
          kind: "principal",
          id: context.actorId,
          issuer: record.session.issuer,
          subject: record.session.accountId,
        }),
        handle,
        expiresAt: new Date(expiry).toISOString(),
        requestId: request.id,
        decisionId: record.admitted.decisionId,
        active: true,
        used: false,
      };
      handles.set(handle, invocation);
      try {
        assertInvocation(invocation);
        return await ambient.run(invocation, work);
      } finally {
        invocation.active = false;
      }
    },
    invocations,
    requests,
    resolveConsumedSession(lease: WorkloadProfileRequestLeaseV1, unit: WorkloadProfileAccountUnit) {
      const captured = consumed.get(lease);
      if (!captured || captured.unit !== unit || !captured.active) return undefined;
      lease.assertCurrent();
      const invocation = captured.invocation;
      const session = invocation.request.session;
      if (!session) return undefined;
      return Object.freeze({
        installationId,
        accountId: session.accountId,
        issuer: session.issuer,
        subject: session.accountId,
        sessionId: session.sessionId,
        sessionCredentialDigest: session.sessionCredentialDigest,
        expiresAt: invocation.expiresAt,
        principal: invocation.principal,
      });
    },
  });
}
