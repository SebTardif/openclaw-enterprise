import type { AuthenticatedRequestHandleV1 } from "@openclaw-enterprise/contracts/account-authority-v1";
import type { Principal } from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { DependencyUnavailableError } from "../errors.ts";
import type {
  WorkloadProfileAccountUnit,
  WorkloadProfileAccountLease,
} from "../services/workload-profile/port.ts";
import type { WorkloadProfileMutationAccountParticipantV2 } from "../workload-profiles/admitted-use.ts";
import type { DeployAgentCommandInput } from "../services/deployment/port.ts";
import type { UpdateAgentInput } from "../services/agent/port.ts";

export type DeploymentBinding = readonly [principalId: string, DeployAgentCommandInput];
export type DraftBinding = readonly [principalId: string, UpdateAgentInput];
export type WorkloadProfilePurposeAccountParticipantV1 =
  WorkloadProfileMutationAccountParticipantV2<DeploymentBinding, DraftBinding>;

/** Only original central custody may bind a recognized transaction/read unit.
 * This source retains the original IO/owner lifetime and accepted-work drain;
 * bind synchronously transfers cleanup through the canonical unit's
 * retainSecurityCleanup exactly once, before returning or any acquisition.
 * This port does not construct or extend the canonical account unit. */
export interface WorkloadProfileAccountOwnerSourceV1 {
  bind(
    unit: WorkloadProfileAccountUnit,
    terminalCleanup: () => void,
  ): WorkloadProfileAccountOwnerLeaseV1;
}

export interface WorkloadProfileAccountOwnerLeaseV1 {
  /** Genuine current bound IO before the six-table policy seal. */
  assertAcquiring(): void;
  /** Original active owner/client lifetime, not the short acquisition callback. */
  assertCurrent(): void;
  /** Original owner drains accepted malformed async fences before cleanup.
   * Retention must be unconditional for work from an already enrolled source,
   * even if cancellation or expiry has meanwhile made authority unavailable. */
  retainAccepted(work: Promise<void>): void;
}

/** Receiver-owned, purpose/binding-specific facts from the original one-use
 * opaque request registry. No raw credential or caller authority is returned. */
export interface WorkloadProfileRequestFactsV1 {
  readonly installationId: string;
  readonly principalId: string;
  readonly accountRef: string;
  readonly sessionRef: string;
  readonly requestId: string;
  readonly admissionDecisionId: string;
  readonly expiresAt: string;
}

export interface WorkloadProfileRequestLeaseV1 {
  readonly facts: WorkloadProfileRequestFactsV1;
  assertCurrent(): void;
}

export type WorkloadProfileAccountPurposeV1 =
  | "workload-profile-deployment"
  | "workload-profile-draft-selection"
  | "workload-profile-deployment-recovery";

/** Same original purpose union and exact immutable command tuples. */
export type WorkloadProfilePurposeRequestV1 = Parameters<
  WorkloadProfilePurposeAccountParticipantV1["consume"]
>[1];

export interface WorkloadProfileRequestCustodySourceV1 {
  /** Authenticate exact original handle, purpose, immutable command and recipient;
   * reject foreign/replayed handles in the ORIGINAL registry, without fallback.
   * Register acquired cleanup before any subsequent getter/await can fail. */
  consume(
    invocation: AuthenticatedRequestHandleV1,
    request: WorkloadProfilePurposeRequestV1,
    unit: WorkloadProfileAccountUnit,
    retainCleanup: (release: () => void) => void,
  ): Promise<WorkloadProfileRequestLeaseV1 | undefined>;
}

/** Genuine same-client account/session/security writer exclusion, acquired
 * before policy. The source recognizes the original unit and request lease;
 * the final fence retains writer/current-session lifetime, not old callback IO.
 * Missing record/session/invalidation producers must return unavailable. */
export interface WorkloadProfileSessionSecuritySourceV1 {
  lock(
    unit: WorkloadProfileAccountUnit,
    request: WorkloadProfileRequestLeaseV1,
    retainCleanup: (release: () => void) => void,
  ): Promise<WorkloadProfileSessionSecurityLeaseV1 | undefined>;
}

export interface WorkloadProfileSessionSecurityLeaseV1 {
  readonly principal: Principal;
  readonly accountRef: string;
  readonly sessionRef: string;
  readonly expiresAt: string;
  assertCurrent(): void;
}

const unavailable = () =>
  new DependencyUnavailableError("The current workload profile account is unavailable.");
const reference = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1024;
const purposes: ReadonlySet<string> = new Set([
  "workload-profile-deployment",
  "workload-profile-draft-selection",
  "workload-profile-deployment-recovery",
]);
function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw unavailable();
  return parsed;
}

/** Original-owner composition only. It creates no request registry, session,
 * security writer, transaction or policy grant. Missing actual producers keep
 * every purpose unavailable, including recovery. The original request source
 * verifies the complete immutable command and recipient, not merely its actor.
 * Recovery binds its fresh read owner and never acquires an active profile. */
export function createWorkloadProfilePurposeAccountParticipantV1(
  options: {
    readonly owner?: WorkloadProfileAccountOwnerSourceV1;
    readonly requests?: WorkloadProfileRequestCustodySourceV1;
    readonly security?: WorkloadProfileSessionSecuritySourceV1;
  } = {},
): WorkloadProfilePurposeAccountParticipantV1 {
  const ownerSource = options.owner;
  const requests = options.requests;
  const security = options.security;
  return Object.freeze({
    async consume(
      invocation: AuthenticatedRequestHandleV1,
      input: WorkloadProfilePurposeRequestV1,
      unit: WorkloadProfileAccountUnit,
    ): Promise<WorkloadProfileAccountLease> {
      const releases: Array<() => void> = [];
      const pending = new Set<Promise<void>>();
      let owner: WorkloadProfileAccountOwnerLeaseV1 | undefined;
      let retainAccepted: ((work: Promise<void>) => void) | undefined;
      let closed = false;
      let observationClosed = false;
      let failed = false;
      const sync = (work: () => unknown): void => {
        const value = work();
        if (value === undefined) return;
        // Synchronous refusal is not permission to drop a malformed provider's
        // accepted work. The original owner drains it before terminal cleanup.
        const task = Promise.resolve(value).then(
          () => {},
          () => {},
        );
        pending.add(task);
        void task.then(() => pending.delete(task));
        if (retainAccepted !== undefined) retainAccepted(task);
        throw unavailable();
      };
      const drain = async () => {
        while (pending.size > 0) await Promise.all([...pending]);
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        let cleanupFailed = false;
        for (const release of releases.reverse()) {
          try {
            sync(release);
          } catch {
            cleanupFailed = true;
          }
        }
        if (cleanupFailed) throw unavailable();
      };
      const acquire = async <Lease>(
        work: (retain: (release: () => void) => void) => Promise<Lease>,
      ) => {
        let open = true;
        let count = 0;
        const retain = (release: () => void): void => {
          if (!open || closed || typeof release !== "function") throw unavailable();
          // Capture before checking lifetime. Each acquisition has its own
          // window/count; an old request callback cannot enroll security work.
          releases.push(release);
          count++;
        };
        try {
          return { lease: await work(retain), registered: count > 0 };
        } finally {
          open = false;
        }
      };
      try {
        if (ownerSource === undefined || requests === undefined || security === undefined)
          throw unavailable();
        // Only plain command values are copied; opaque request/unit custody is
        // forwarded by identity. No selected policy or live capability is cloned.
        const request = immutableCopy(input);
        if (
          !request ||
          Object.keys(request).length !== 2 ||
          !purposes.has(request.purpose) ||
          !Array.isArray(request.binding) ||
          request.binding.length !== 2 ||
          !reference(request.binding[0]) ||
          !request.binding[1] ||
          !reference(request.binding[1].namespaceId) ||
          !reference(request.binding[1].agentId)
        )
          throw unavailable();
        owner = ownerSource.bind(unit, cleanup);
        if (closed || owner === undefined) throw unavailable();
        retainAccepted = owner.retainAccepted.bind(owner);
        const assertOwner = owner.assertCurrent.bind(owner);
        const assertAcquiring = owner.assertAcquiring.bind(owner);
        const installationId = unit.installationId;
        const signal = unit.signal;
        if (!reference(installationId) || !signal || typeof signal.aborted !== "boolean")
          throw unavailable();
        const began = performance.now();
        const observedAt = Date.now();
        let expires = Infinity;
        let previousElapsed = 0;
        let assertRequest: (() => void) | undefined;
        let assertSecurity: (() => void) | undefined;
        const current = () => {
          if (closed || observationClosed || failed || signal.aborted) throw unavailable();
          sync(assertOwner);
          const elapsed = performance.now() - began;
          const now = Date.now();
          if (
            !Number.isFinite(elapsed) ||
            elapsed < previousElapsed ||
            !Number.isFinite(now) ||
            now < observedAt ||
            Math.max(now, observedAt + elapsed) >= expires
          )
            throw unavailable();
          previousElapsed = elapsed;
          if (assertRequest !== undefined) sync(assertRequest);
          if (assertSecurity !== undefined) sync(assertSecurity);
          if (closed || observationClosed || failed || signal.aborted) throw unavailable();
          sync(assertOwner);
          const finalNow = Date.now();
          const finalElapsed = performance.now() - began;
          if (
            !Number.isFinite(finalElapsed) ||
            finalElapsed < previousElapsed ||
            !Number.isFinite(finalNow) ||
            finalNow < observedAt ||
            Math.max(finalNow, observedAt + finalElapsed) >= expires
          )
            throw unavailable();
          previousElapsed = finalElapsed;
        };
        const acquiring = () => {
          current();
          sync(assertAcquiring);
        };
        acquiring();
        const consumeRequest = requests.consume.bind(requests);
        const requestAcquisition = await acquire((retain) =>
          consumeRequest(invocation, request, unit, retain),
        );
        acquiring();
        const authenticated = requestAcquisition.lease;
        if (authenticated === undefined || !requestAcquisition.registered) throw unavailable();
        assertRequest = authenticated.assertCurrent.bind(authenticated);
        sync(assertRequest);
        const raw = authenticated.facts;
        const facts: WorkloadProfileRequestFactsV1 = Object.freeze({
          installationId: raw.installationId,
          principalId: raw.principalId,
          accountRef: raw.accountRef,
          sessionRef: raw.sessionRef,
          requestId: raw.requestId,
          admissionDecisionId: raw.admissionDecisionId,
          expiresAt: raw.expiresAt,
        });
        if (
          !Object.values(facts).every(reference) ||
          facts.installationId !== installationId ||
          facts.principalId !== request.binding[0]
        )
          throw unavailable();
        expires = timestamp(facts.expiresAt);
        acquiring();
        const lock = security.lock.bind(security);
        const securityAcquisition = await acquire((retain) => lock(unit, authenticated, retain));
        acquiring();
        const locked = securityAcquisition.lease;
        if (locked === undefined || !securityAcquisition.registered) throw unavailable();
        assertSecurity = locked.assertCurrent.bind(locked);
        sync(assertSecurity);
        const suppliedPrincipal = locked.principal;
        // Canonical Principal has no Installation field. Installation custody
        // is already bound by this original unit and authenticated request facts;
        // the supplied security source verifies that same unit and account.
        // Read each supplied field once. A source getter must not change actor
        // identity between validation and the returned immutable observation.
        const identity = Object.freeze({
          id: suppliedPrincipal.id,
          kind: suppliedPrincipal.kind,
          namespaceId: suppliedPrincipal.namespaceId,
          issuer: suppliedPrincipal.issuer,
          subject: suppliedPrincipal.subject,
        });
        if (
          identity.kind !== "principal" ||
          identity.namespaceId !== undefined ||
          identity.id !== facts.principalId ||
          !reference(identity.issuer) ||
          !reference(identity.subject) ||
          locked.accountRef !== facts.accountRef ||
          locked.sessionRef !== facts.sessionRef
        )
          throw unavailable();
        const principal: Principal = Object.freeze({
          id: identity.id,
          kind: "principal",
          issuer: identity.issuer,
          subject: identity.subject,
        });
        expires = Math.min(expires, timestamp(locked.expiresAt));
        acquiring();
        return Object.freeze({
          principal,
          accountRef: facts.accountRef,
          requestId: facts.requestId,
          admissionDecisionId: facts.admissionDecisionId,
          assertCurrent() {
            try {
              current();
            } catch {
              failed = true;
              throw unavailable();
            }
          },
          release() {
            // Close only this local observation. Transferred request/security
            // cleanup remains exclusively with the original unit terminal.
            observationClosed = true;
          },
        });
      } catch {
        failed = true;
        await drain();
        // Retained guards stay with original terminal cleanup, including a late
        // acquisition failure; this adapter never rolls back or releases early.
        throw unavailable();
      }
    },
  });
}
