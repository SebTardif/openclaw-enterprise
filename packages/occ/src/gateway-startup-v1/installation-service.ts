import {
  canonicalGatewayStartupValueV1,
  parseGatewayStartupCommandV1,
  type GatewayStartupAcceptedOperationV1,
  type GatewayStartupAuthorityLeaseV1,
  type GatewayStartupCommandBoundsV1,
  type GatewayStartupCommandV1,
  type GatewayStartupInvocationV1,
  type GatewayStartupOwnerParticipantsV1,
  type GatewayStartupOwnerUnitV1,
  type GatewayStartupRecipientBindingV1,
} from "./owner.ts";
import type {
  GatewayStartupOperationLocatorV1,
  GatewayStartupRecordRefV1,
} from "@openclaw-enterprise/contracts/gateway-startup-v1";

export type GatewayInstallationServiceCommandV1 = Extract<
  GatewayStartupCommandV1,
  { kind: "consume-startup" | "read-current" | "read-operation" }
>;
export type GatewayInstallationServiceEndpointsV1 = Readonly<{
  gateway: Readonly<{ serviceRef: string; spiffeId: string }>;
  controller: Readonly<{ serviceRef: string; spiffeId: string }>;
  /** Transport recipient is the Controller, separately from the local Gateway recipient. */
  transportRecipientRef: string;
}>;
export type GatewayInstallationServiceAssociationV1 = Readonly<{
  startup: GatewayStartupOperationLocatorV1;
  createEffectRef: string;
  recipient: GatewayStartupRecipientBindingV1;
  registration: GatewayStartupRecordRefV1;
  sourceConfiguration: GatewayStartupRecordRefV1;
  endpoints: GatewayInstallationServiceEndpointsV1;
}>;
export interface GatewayInstallationNativeLeaseV1 {
  readonly profile: "installation-gateway-startup-v1";
  readonly transport: "owned-child-stdio-installation-gateway-startup-v1";
  readonly association: GatewayInstallationServiceAssociationV1;
  readonly signal: AbortSignal;
  /** Actual original authentication/connection deadline; not a wall-clock substitute. */
  assertCurrent(): undefined;
  close(): Promise<void>;
}
export interface GatewayInstallationNativeSourceV1 {
  /** Verify actual private server context, exact call/body and fixed endpoint selections. */
  inspect(
    proof: object,
    command: GatewayInstallationServiceCommandV1,
    bounds: GatewayStartupCommandBoundsV1,
  ): Promise<GatewayInstallationNativeLeaseV1 | undefined>;
}
export interface GatewayInstallationServiceCurrentnessV1 {
  /** Join the original owner unit: actual registration/process/selection/account predicates and separate historical policy. */
  consume(
    association: GatewayInstallationServiceAssociationV1,
    command: GatewayInstallationServiceCommandV1,
    bounds: GatewayStartupCommandBoundsV1,
    unit: GatewayStartupOwnerUnitV1,
    io: GatewayStartupAcceptedOperationV1,
  ): Promise<GatewayStartupAuthorityLeaseV1>;
}
export interface GatewayInstallationServiceEnrollmentV1 {
  readonly invocation: GatewayStartupInvocationV1;
  /** Joins accepted work and every borrowed native/currentness lease; never means physical termination. */
  close(): Promise<void>;
}
const unavailable = () => new Error("Installation Gateway service unavailable");
const canonical = canonicalGatewayStartupValueV1;
function command(value: unknown): GatewayInstallationServiceCommandV1 {
  const c = parseGatewayStartupCommandV1(value);
  if (c.kind !== "consume-startup" && c.kind !== "read-current" && c.kind !== "read-operation")
    throw unavailable();
  return c;
}
function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw unavailable();
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
function record(value: unknown): void {
  exact(value, ["recordRef", "recordVersion"]);
  ref(value.recordRef);
  if (!Number.isSafeInteger(value.recordVersion) || (value.recordVersion as number) < 1)
    throw unavailable();
}
function parseAssociation(value: unknown): GatewayInstallationServiceAssociationV1 {
  const copy: unknown = JSON.parse(canonical(value));
  exact(copy, [
    "startup",
    "createEffectRef",
    "recipient",
    "registration",
    "sourceConfiguration",
    "endpoints",
  ]);
  // Reuse the original closed locator/recipient grammar. This validation-only
  // projection is never submitted, enrolled, or treated as an original command.
  parseGatewayStartupCommandV1({
    schemaVersion: 1,
    kind: "read-current",
    startup: copy.startup,
    expectedRecordVersion: 1,
    recipient: copy.recipient,
  });
  ref(copy.createEffectRef);
  record(copy.registration);
  record(copy.sourceConfiguration);
  exact(copy.endpoints, ["gateway", "controller", "transportRecipientRef"]);
  for (const endpoint of [copy.endpoints.gateway, copy.endpoints.controller]) {
    exact(endpoint, ["serviceRef", "spiffeId"]);
    ref(endpoint.serviceRef);
    ref(endpoint.spiffeId);
  }
  ref(copy.endpoints.transportRecipientRef);
  return freeze(copy) as GatewayInstallationServiceAssociationV1;
}
type State = {
  command: GatewayInstallationServiceCommandV1;
  commandText: string;
  bounds: GatewayStartupCommandBoundsV1;
  association: GatewayInstallationServiceAssociationV1;
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
 * TODO(Installation startup): supply original native and transaction-held currentness producers.
 */
export function createGatewayInstallationServiceAuthorityV1(options: {
  account: GatewayStartupOwnerParticipantsV1["authority"];
  native?: GatewayInstallationNativeSourceV1;
  currentness?: GatewayInstallationServiceCurrentnessV1;
}) {
  const account = options.account.consume.bind(options.account);
  const inspect = options.native?.inspect.bind(options.native);
  const consumeCurrent = options.currentness?.consume.bind(options.currentness);
  const invocations = new WeakMap<GatewayStartupInvocationV1, State>();
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
  const authority: GatewayStartupOwnerParticipantsV1["authority"] = {
    async consume(invocation, suppliedCommand, bounds, unit, io) {
      const s = invocations.get(invocation);
      if (!s) return account(invocation, suppliedCommand, bounds, unit, io);
      if (s.used || s.closing) throw unavailable();
      s.used = true;
      if (
        canonical(suppliedCommand) !== s.commandText ||
        bounds.requestRef !== s.bounds.requestRef ||
        bounds.deadline !== s.bounds.deadline ||
        bounds.signal !== s.bounds.signal ||
        unit.installationId !== s.association.startup.installationId
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
        const current = await consumeCurrent(s.association, s.command, bounds, unit, io);
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
    ): Promise<GatewayInstallationServiceEnrollmentV1 | undefined> {
      if (!inspect || !consumeCurrent) return undefined;
      let c: GatewayInstallationServiceCommandV1;
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
      let lease: GatewayInstallationNativeLeaseV1 | undefined;
      let s: State | undefined;
      try {
        lease = await inspect(proof, c, bounds);
        if (!lease) return undefined;
        const association = parseAssociation(lease.association);
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
              c.operation.installationId !== association.startup.installationId ||
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
        const invocation = Object.freeze({}) as GatewayStartupInvocationV1;
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
