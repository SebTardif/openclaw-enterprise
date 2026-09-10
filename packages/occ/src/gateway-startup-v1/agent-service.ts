import {
  canonicalGatewayStartupValueV1,
  parseGatewayStartupCommandV2,
  type GatewayStartupAcceptedOperationV1,
  type GatewayStartupAuthorityLeaseV1,
  type GatewayStartupCommandBoundsV1,
  type GatewayStartupCommandV2,
  type GatewayStartupInvocationV2,
  type GatewayStartupOwnerUnitV2,
} from "./owner.ts";
import type {
  GatewayStartupControllerParticipantsV2,
  GatewayStartupControllerPolicyV1,
} from "./controller.ts";
import {
  parseGatewayInstallationServiceAssociationV2,
  type GatewayInstallationServiceAssociationV2,
} from "./installation-service.ts";

export type GatewayInstallationServiceCommandV2 = Extract<
  GatewayStartupCommandV2,
  { kind: "consume-startup" | "read-current" | "read-operation" }
>;
/** Original native source identity/connection, with an exact Agent association.
 * The outer transport profile is shared; V1 commands never enter this domain. */
export interface GatewayInstallationNativeLeaseV2 {
  readonly profile: "installation-gateway-startup-v1";
  readonly transport: "owned-child-stdio-installation-gateway-startup-v1";
  readonly association: GatewayInstallationServiceAssociationV2;
  readonly signal: AbortSignal;
  assertCurrent(): undefined;
  close(): Promise<void>;
}
export interface GatewayInstallationNativeSourceV2 {
  inspect(
    proof: object,
    command: GatewayInstallationServiceCommandV2,
    bounds: GatewayStartupCommandBoundsV1,
  ): Promise<GatewayInstallationNativeLeaseV2 | undefined>;
}
export interface GatewayInstallationServiceCurrentnessV2 {
  /** Actual current account, selected IAM, registration and physical process
   * must be acquired by the original same-unit owner; no row alone grants use. */
  consume(
    association: GatewayInstallationServiceAssociationV2,
    command: GatewayInstallationServiceCommandV2,
    bounds: GatewayStartupCommandBoundsV1,
    unit: GatewayStartupOwnerUnitV2,
    io: GatewayStartupAcceptedOperationV1,
    policy: GatewayStartupControllerPolicyV1,
  ): Promise<GatewayStartupAuthorityLeaseV1>;
}
export interface GatewayInstallationServiceEnrollmentV2 {
  readonly invocation: GatewayStartupInvocationV2;
  close(): Promise<void>;
}
const unavailable = () => new Error("Agent Gateway service unavailable");
const canonical = canonicalGatewayStartupValueV1;
function command(value: unknown): GatewayInstallationServiceCommandV2 {
  const result = parseGatewayStartupCommandV2(value);
  if (
    result.kind !== "consume-startup" &&
    result.kind !== "read-current" &&
    result.kind !== "read-operation"
  )
    throw unavailable();
  return result;
}
function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function ref(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw unavailable();
}
type State = {
  command: GatewayInstallationServiceCommandV2;
  commandText: string;
  bounds: GatewayStartupCommandBoundsV1;
  association: GatewayInstallationServiceAssociationV2;
  signal: AbortSignal;
  assertion: () => undefined;
  releaseNative: () => Promise<void>;
  pendingFences: Set<Promise<unknown>>;
  used: boolean;
  closing: boolean;
  heldByPhase: boolean;
  poison?: (error: unknown) => void;
  listener: () => void;
  closed: Promise<void>;
  resolveClosed: () => void;
  rejectClosed: (error: unknown) => void;
  closeTask?: Promise<void>;
};

/**
 * Internal original-owner composition. No profile string or public brand enrolls a caller.
 * The V2 native receiver and original transaction-held account/registration owners
 * supply these ports; a descriptor or V1 context cannot enroll this service.
 */
export function createGatewayInstallationServiceAuthorityV2(options: {
  account: GatewayStartupControllerParticipantsV2["authority"];
  native?: GatewayInstallationNativeSourceV2;
  currentness?: GatewayInstallationServiceCurrentnessV2;
}) {
  const account = options.account.consume.bind(options.account);
  const inspect = options.native?.inspect.bind(options.native);
  const consumeCurrent = options.currentness?.consume.bind(options.currentness);
  const invocations = new WeakMap<GatewayStartupInvocationV2, State>();
  const active = new Set<State>();
  const pendingEnrollment = new Set<object>();
  const check = (s: State): undefined => {
    if (s.closing || s.signal.aborted || s.bounds.signal.aborted) throw unavailable();
    const value: unknown = s.assertion();
    if (value !== undefined) {
      const pending = Promise.resolve(value).catch(() => {});
      s.pendingFences.add(pending);
      void pending.then(() => s.pendingFences.delete(pending));
      throw unavailable();
    }
    if (s.closing || s.signal.aborted || s.bounds.signal.aborted) throw unavailable();
    return undefined;
  };
  const finishClose = (s: State): Promise<void> => {
    s.closing = true;
    if (!s.closeTask) {
      s.closeTask = (async () => {
        try {
          while (s.pendingFences.size) await Promise.allSettled([...s.pendingFences]);
          await s.releaseNative();
          s.resolveClosed();
        } catch (error) {
          s.rejectClosed(error);
          throw error;
        } finally {
          s.signal.removeEventListener("abort", s.listener);
          s.bounds.signal.removeEventListener("abort", s.listener);
          active.delete(s);
        }
      })();
      void s.closeTask.catch(() => {});
    }
    return s.closeTask;
  };
  const close = (s: State): Promise<void> => {
    s.closing = true;
    s.poison?.(unavailable());
    // Once admitted, original transaction terminal cleanup owns release, even after revocation.
    if (!s.heldByPhase) void finishClose(s).catch(() => {});
    return s.closed;
  };
  const authority: GatewayStartupControllerParticipantsV2["authority"] = {
    async consume(invocation, suppliedCommand, bounds, unit, io, policy) {
      const s = invocations.get(invocation);
      if (!s) return account(invocation, suppliedCommand, bounds, unit, io, policy);
      if (s.used || s.closing) throw unavailable();
      s.used = true;
      if (
        canonical(suppliedCommand) !== s.commandText ||
        bounds.requestRef !== s.bounds.requestRef ||
        bounds.deadline !== s.bounds.deadline ||
        bounds.signal !== s.bounds.signal ||
        canonical(unit.subject) !== canonical(s.association.startup.subject)
      ) {
        await close(s);
        throw unavailable();
      }
      s.poison = (error) => unit.phase.poison(error);
      s.heldByPhase = true;
      let owned = false;
      try {
        unit.phase.retainCleanup(async () => {
          await finishClose(s);
        });
        owned = true;
        check(s);
        io.assertActive();
        if (!consumeCurrent) throw unavailable();
        const current = await consumeCurrent(s.association, s.command, bounds, unit, io, policy);
        // Currentness resources returned late are registered before the post-await fence.
        let retained = false;
        try {
          unit.phase.retainCleanup(current.release.bind(current));
          retained = true;
          const assertion = current.assertCurrent.bind(current);
          unit.phase.retainCurrentness(assertion);
          const value: unknown = assertion();
          if (value !== undefined) {
            await Promise.resolve(value).catch(() => {});
            throw unavailable();
          }
          check(s);
          io.assertActive();
          return Object.freeze({
            attribution: freeze(JSON.parse(canonical(current.attribution))),
            assertCurrent: () => {
              check(s);
              return undefined;
            },
            async release() {},
          });
        } catch (error) {
          if (!retained) await current.release();
          throw error;
        }
      } catch (error) {
        unit.phase.poison(error);
        if (!owned) {
          s.heldByPhase = false;
          await finishClose(s);
        }
        throw error;
      }
    },
  };
  return Object.freeze({
    authority: Object.freeze(authority),
    async enroll(
      proof: object,
      input: unknown,
      bounds: GatewayStartupCommandBoundsV1,
    ): Promise<GatewayInstallationServiceEnrollmentV2 | undefined> {
      if (!inspect || !consumeCurrent) return undefined;
      let c: GatewayInstallationServiceCommandV2;
      try {
        c = command(input);
        ref(bounds.requestRef);
        if (
          typeof bounds.deadline !== "string" ||
          !Number.isFinite(Date.parse(bounds.deadline)) ||
          !(bounds.signal instanceof AbortSignal) ||
          bounds.signal.aborted
        )
          return undefined;
        bounds = Object.freeze({
          requestRef: bounds.requestRef,
          deadline: bounds.deadline,
          signal: bounds.signal,
        });
      } catch {
        return undefined;
      }
      const holder = {};
      pendingEnrollment.add(holder);
      let lease: GatewayInstallationNativeLeaseV2 | undefined;
      let s: State | undefined;
      try {
        lease = await inspect(proof, c, bounds);
        if (!lease) return undefined;
        const association = parseGatewayInstallationServiceAssociationV2(lease.association);
        if (
          lease.profile !== "installation-gateway-startup-v1" ||
          lease.transport !== "owned-child-stdio-installation-gateway-startup-v1" ||
          !(lease.signal instanceof AbortSignal)
        )
          throw unavailable();
        if (
          association.endpoints.transportRecipientRef !==
            association.endpoints.controller.serviceRef ||
          association.endpoints.gateway.spiffeId === association.endpoints.controller.spiffeId
        )
          throw unavailable();
        const target = c.kind === "read-operation" ? c.operation.startup : c.startup;
        if (
          target
            ? canonical(target) !== canonical(association.startup)
            : c.kind !== "read-operation" ||
              canonical(c.operation.subject) !== canonical(association.startup.subject) ||
              c.operation.operationRef !== association.startup.operationRef ||
              c.operation.operationDigest !== association.startup.operationDigest
        )
          throw unavailable();
        if (
          c.kind !== "read-operation" &&
          canonical(c.recipient) !== canonical(association.recipient)
        )
          throw unavailable();
        let resolveClosed!: () => void;
        let rejectClosed!: (error: unknown) => void;
        const closed = new Promise<void>((resolve, reject) => {
          resolveClosed = resolve;
          rejectClosed = reject;
        });
        void closed.catch(() => {});
        s = {
          command: c,
          commandText: canonical(c),
          bounds: Object.freeze({
            requestRef: bounds.requestRef,
            deadline: bounds.deadline,
            signal: bounds.signal,
          }),
          association,
          signal: lease.signal,
          assertion: lease.assertCurrent.bind(lease),
          releaseNative: lease.close.bind(lease),
          pendingFences: new Set(),
          used: false,
          closing: false,
          heldByPhase: false,
          listener: () => {},
          closed,
          resolveClosed,
          rejectClosed,
        };
        const enrolled = s;
        s.listener = () => {
          void close(enrolled);
        };
        active.add(s);
        s.signal.addEventListener("abort", s.listener, { once: true });
        s.bounds.signal.addEventListener("abort", s.listener, { once: true });
        check(s);
        const invocation = Object.freeze({}) as GatewayStartupInvocationV2;
        invocations.set(invocation, s);
        return Object.freeze({ invocation, close: () => close(enrolled) });
      } catch {
        if (s) {
          await close(s).catch(() => {});
        } else if (lease) {
          try {
            await lease.close();
          } catch {}
        }
        return undefined;
      } finally {
        pendingEnrollment.delete(holder);
      }
    },
  });
}
