import { isDeepStrictEqual } from "node:util";
import {
  canonicalGatewayStartupValueV1,
  gatewayStartupCommandDigestV1,
  parseGatewayStartupCommandV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/owner";
import type {
  GatewayStartupAcceptedOperationV1,
  GatewayStartupCommandBoundsV1,
  GatewayStartupCommandV1,
  GatewayStartupOwnerLeaseV1,
  GatewayStartupOwnerUnitV1,
  GatewayStartupRecipientBindingV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/owner";
import type {
  GatewayProcessObservationResultV1,
  GatewayStartupBindingV1,
  GatewayStartupRecordRefV1,
} from "@openclaw-enterprise/contracts/gateway-startup-v1";

import type {
  GatewayInstallationServiceAssociationV1,
  GatewayInstallationServiceEndpointsV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/installation-service";

type Command = Extract<
  GatewayStartupCommandV1,
  { kind: "consume-startup" | "read-current" | "read-operation" }
>;
type Selector = Readonly<{ type: string; value: string }>;
type Timed = Readonly<{ observedAtMs: number; expiresAtMs: number }>;
type Lease<T> = GatewayStartupOwnerLeaseV1 & Readonly<{ value: T }>;

export type InstallationServiceRegistrationEntryV1 = Readonly<{
  entryId: string;
  spiffeId: string;
  parentId: string;
  selectors: readonly Selector[];
}>;
export type InstallationServiceProcessIdentityV1 = Readonly<{
  clusterRef: string;
  namespaceUid: string;
  deploymentUid: string;
  replicaSetUid: string;
  podUid: string;
  nodeName: string;
  runtimeClassName: string | null;
  containerName: string;
  executionIncarnationRef: string;
  recipientIncarnationRef: string;
}>;
/** Protected registry selection, supplied by its actual current writer. Values alone are not a grant. */
export type InstallationServiceRegistrationSelectionV1 = Readonly<{
  binding: GatewayStartupBindingV1;
  recipient: GatewayStartupRecipientBindingV1;
  registration: GatewayStartupRecordRefV1;
  /** Immutable original Source-configuration record and version. */
  source: GatewayStartupRecordRefV1;
  endpoints: GatewayInstallationServiceEndpointsV1;
  entry: InstallationServiceRegistrationEntryV1;
  controllerSpiffeId: string;
  process: InstallationServiceProcessIdentityV1;
  maximumObservationAgeMs: number;
  clockUncertaintyMs: number;
}>;
export type InstallationServiceNativeInspectionV1 = Readonly<{
  /** The original native association sourceConfiguration record/version. */
  source: GatewayStartupRecordRefV1;
  gatewaySpiffeId: string;
  controllerSpiffeId: string;
  commandDigest: string;
  operationProfile: "installation-gateway-startup-v1";
  transportProfile: "owned-child-stdio-installation-gateway-startup-v1";
  expiresAtMs: number;
  signal: AbortSignal;
  assertCurrent(): undefined;
}>;

/**
 * Ports are installed by the original trusted native/registration/Compute owners.
 * This module supplies no inspector, registrar, current writer or execution observer.
 */
export interface InstallationServiceRegistrationParticipantsV1 {
  native: {
    inspectOriginal(
      original: object,
      command: Command,
      bounds: GatewayStartupCommandBoundsV1,
    ): InstallationServiceNativeInspectionV1 | undefined;
  };
  registry: {
    acquire(
      native: InstallationServiceNativeInspectionV1,
      command: Command,
      bounds: GatewayStartupCommandBoundsV1,
      unit: GatewayStartupOwnerUnitV1,
      io: GatewayStartupAcceptedOperationV1,
    ): Promise<Lease<InstallationServiceRegistrationSelectionV1>>;
  };
  registrar: {
    acquire(
      selection: InstallationServiceRegistrationSelectionV1,
      bounds: GatewayStartupCommandBoundsV1,
    ): Promise<
      Lease<
        Timed &
          Readonly<{
            registration: GatewayStartupRecordRefV1;
            /** Complete relevant set for this exact SPIFFE identity, not one convenient entry. */
            entries: readonly InstallationServiceRegistrationEntryV1[];
            coverage: "complete";
          }>
      >
    >;
  };
  process: {
    acquire(
      selection: InstallationServiceRegistrationSelectionV1,
      command: Command,
      bounds: GatewayStartupCommandBoundsV1,
      unit: GatewayStartupOwnerUnitV1,
      io: GatewayStartupAcceptedOperationV1,
    ): Promise<
      Lease<
        Timed &
          Readonly<{
            observation: GatewayProcessObservationResultV1;
            /** Independently protected execution observation, not a label or derived PID value. */
            identity: InstallationServiceProcessIdentityV1;
            executionObservation: Timed;
          }>
      >
    >;
  };
}

const unavailable = () => new Error("Installation service registration unavailable");
function snapshot<T>(value: T): T {
  // The original closed canonical-data helper rejects getters/prototypes/cycles/oversize.
  return JSON.parse(canonicalGatewayStartupValueV1(value)) as T;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
/** Closed configuration snapshot only; this helper creates no invocation or current grant. */
function captureAssociation(value: GatewayInstallationServiceAssociationV1) {
  try {
    const result = snapshot(value);
    const exact = (object: unknown, keys: readonly string[]) => {
      if (
        !object ||
        typeof object !== "object" ||
        Array.isArray(object) ||
        Object.keys(object).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(object, key))
      )
        throw unavailable();
    };
    const ref = (text: unknown) => {
      if (
        typeof text !== "string" ||
        text.length < 1 ||
        text.length > 512 ||
        /[\u0000-\u001f\u007f]/u.test(text)
      )
        throw unavailable();
    };
    exact(result, [
      "startup",
      "createEffectRef",
      "recipient",
      "registration",
      "sourceConfiguration",
      "endpoints",
    ]);
    // Validation projection only: it is never dispatched or enrolled.
    parseGatewayStartupCommandV1({
      schemaVersion: 1,
      kind: "read-current",
      startup: result.startup,
      expectedRecordVersion: 1,
      recipient: result.recipient,
    });
    ref(result.createEffectRef);
    for (const record of [result.registration, result.sourceConfiguration]) {
      exact(record, ["recordRef", "recordVersion"]);
      ref(record.recordRef);
      if (!Number.isSafeInteger(record.recordVersion) || record.recordVersion < 1)
        throw unavailable();
    }
    exact(result.endpoints, ["gateway", "controller", "transportRecipientRef"]);
    for (const endpoint of [result.endpoints.gateway, result.endpoints.controller]) {
      exact(endpoint, ["serviceRef", "spiffeId"]);
      ref(endpoint.serviceRef);
      ref(endpoint.spiffeId);
    }
    ref(result.endpoints.transportRecipientRef);
    if (result.endpoints.transportRecipientRef !== result.endpoints.controller.serviceRef)
      throw unavailable();
    return deepFreeze(result);
  } catch {
    throw unavailable();
  }
}

function exactEntry(value: InstallationServiceRegistrationEntryV1) {
  for (const item of [value.entryId, value.spiffeId, value.parentId]) {
    if (typeof item !== "string" || !item.length || item.length > 2048) throw unavailable();
  }
  if (!Array.isArray(value.selectors) || !value.selectors.length || value.selectors.length > 64)
    throw unavailable();
  const selectors = value.selectors
    .map((selector) => {
      if (
        Object.keys(selector).sort().join() !== "type,value" ||
        typeof selector.type !== "string" ||
        !selector.type.length ||
        selector.type.length > 128 ||
        typeof selector.value !== "string" ||
        !selector.value.length ||
        selector.value.length > 2048
      )
        throw unavailable();
      return [selector.type, selector.value];
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (new Set(selectors.map((v) => JSON.stringify(v))).size !== selectors.length)
    throw unavailable();
  return { entryId: value.entryId, spiffeId: value.spiffeId, parentId: value.parentId, selectors };
}
function commandBinding(
  command: Command,
  selection: InstallationServiceRegistrationSelectionV1,
): void {
  const startup = command.kind === "read-operation" ? command.operation.startup : command.startup;
  if (!startup || !isDeepStrictEqual(startup, selection.binding.startup)) throw unavailable();
  if (
    command.kind !== "read-operation" &&
    !isDeepStrictEqual(command.recipient, selection.recipient)
  )
    throw unavailable();
  if (
    command.kind === "read-operation" &&
    command.operation.installationId !== selection.binding.startup.installationId
  )
    throw unavailable();
}
function processBinding(
  selection: InstallationServiceRegistrationSelectionV1,
  value: Timed &
    Readonly<{
      observation: GatewayProcessObservationResultV1;
      identity: InstallationServiceProcessIdentityV1;
      executionObservation: Timed;
    }>,
): void {
  const result = value.observation;
  if (
    result.kind !== "observed" ||
    !isDeepStrictEqual(result.original.binding, selection.binding) ||
    !isDeepStrictEqual(value.identity, selection.process) ||
    Date.parse(result.observedAt) !== value.observedAtMs
  )
    throw unavailable();
  const p = selection.process,
    c = result.chain;
  if (
    result.original.target.clusterRef !== p.clusterRef ||
    c.namespace.uid !== p.namespaceUid ||
    c.deployment.uid !== p.deploymentUid ||
    c.replicaSet.uid !== p.replicaSetUid ||
    c.pod.uid !== p.podUid ||
    c.pod.nodeName !== p.nodeName ||
    c.pod.runtimeClassName !== p.runtimeClassName ||
    c.pod.containers.filter((v) => v.kind === "main" && v.name === p.containerName).length !== 1 ||
    p.recipientIncarnationRef !== selection.recipient.incarnationRef ||
    typeof p.executionIncarnationRef !== "string" ||
    !p.executionIncarnationRef.length
  )
    throw unavailable();
}

/**
 * Acquire within the original Runtime unit/io protocol. No new transaction,
 * account fallback, positive observation cache, native invocation or lock order.
 */
export function createInstallationServiceRegistrationReaderV1(
  participants: InstallationServiceRegistrationParticipantsV1 | undefined,
  expectedAssociation: GatewayInstallationServiceAssociationV1 | undefined,
) {
  // Fixed constructor configuration is rechecked against real current selection
  // in the original transaction; it cannot establish current authority alone.
  const expected =
    expectedAssociation === undefined ? undefined : captureAssociation(expectedAssociation);
  const inspect = participants?.native.inspectOriginal.bind(participants.native);
  const registry = participants?.registry.acquire.bind(participants.registry);
  const registrar = participants?.registrar.acquire.bind(participants.registrar);
  const process = participants?.process.acquire.bind(participants.process);
  const active = new Set<object>();

  return Object.freeze({
    async acquire(
      original: object,
      input: Command,
      bounds: GatewayStartupCommandBoundsV1,
      unit: GatewayStartupOwnerUnitV1,
      io: GatewayStartupAcceptedOperationV1,
    ): Promise<GatewayStartupOwnerLeaseV1> {
      try {
        if (!inspect || !registry || !registrar || !process || !expected) throw unavailable();
        const parsed = parseGatewayStartupCommandV1(input);
        if (
          parsed.kind !== "consume-startup" &&
          parsed.kind !== "read-current" &&
          parsed.kind !== "read-operation"
        )
          throw unavailable();
        const command: Command = parsed;
        const deadline = Date.parse(bounds.deadline);
        if (
          !(bounds.signal instanceof AbortSignal) ||
          bounds.signal.aborted ||
          !Number.isFinite(deadline) ||
          deadline <= Date.now()
        )
          throw unavailable();
        const native = inspect(original, command, bounds);
        if (native && typeof native === "object" && "then" in native) {
          // A synchronous original inspector cannot be replaced by an async result.
          // Observe and join a rejected impostor before returning a sanitized denial.
          await Promise.resolve(native).catch(() => undefined);
          throw unavailable();
        }
        if (
          !native ||
          !(native.signal instanceof AbortSignal) ||
          native.operationProfile !== "installation-gateway-startup-v1" ||
          native.transportProfile !== "owned-child-stdio-installation-gateway-startup-v1" ||
          native.commandDigest !== gatewayStartupCommandDigestV1(command) ||
          !Number.isSafeInteger(native.expiresAtMs)
        )
          throw unavailable();
        const pending = new Set<Promise<unknown>>();
        const releases: (() => Promise<void>)[] = [];
        const fences: (() => undefined)[] = [];
        const timed: Timed[] = [];
        let selection: InstallationServiceRegistrationSelectionV1 | undefined;
        let releasing: Promise<void> | undefined;
        let acquisition: Promise<void> | undefined;
        let stopped = false;
        let handedOff = false;
        const token = {};
        active.add(token);
        const fence = (work: () => undefined) => {
          const result: unknown = work();
          if (result !== undefined) {
            const p = Promise.resolve(result).catch(() => undefined);
            pending.add(p);
            void p.then(() => pending.delete(p));
            throw unavailable();
          }
        };
        const fresh = (time: Timed, now: number) => {
          if (!selection) throw unavailable();
          if (
            !Number.isSafeInteger(time.observedAtMs) ||
            !Number.isSafeInteger(time.expiresAtMs) ||
            time.observedAtMs > now + selection.clockUncertaintyMs ||
            time.expiresAtMs < time.observedAtMs ||
            time.expiresAtMs > time.observedAtMs + selection.maximumObservationAgeMs ||
            now + selection.clockUncertaintyMs >= time.expiresAtMs ||
            now - time.observedAtMs + selection.clockUncertaintyMs >
              selection.maximumObservationAgeMs
          )
            throw unavailable();
        };
        const assert = (): undefined => {
          const now = Date.now();
          if (
            stopped ||
            bounds.signal.aborted ||
            native.signal.aborted ||
            now >= deadline ||
            now >= native.expiresAtMs
          )
            throw unavailable();
          // The query scope ends with acquisition. Retained native/provider
          // leases remain current through the original phase terminal cleanup.
          if (!handedOff) io.assertActive();
          fence(() => native.assertCurrent());
          for (const check of fences) fence(check);
          for (const time of timed) fresh(time, now);
          if (bounds.signal.aborted || native.signal.aborted) throw unavailable();
          return undefined;
        };
        const adopt = <T>(lease: Lease<T>): T => {
          // Retain release before validating the value or running a post-await fence.
          releases.push(lease.release.bind(lease));
          fences.push(lease.assertCurrent.bind(lease));
          const value = deepFreeze(snapshot(lease.value));
          assert();
          return value;
        };
        const release = (): Promise<void> => {
          stopped = true;
          if (!releasing)
            releasing = (async () => {
              await acquisition?.catch(() => undefined);
              while (pending.size) await Promise.allSettled([...pending]);
              let failed = false;
              for (const close of releases.reverse()) {
                try {
                  await close();
                } catch {
                  failed = true;
                }
              }
              bounds.signal.removeEventListener("abort", onAbort);
              native.signal.removeEventListener("abort", onAbort);
              active.delete(token);
              if (failed) throw unavailable();
            })();
          void releasing.catch(() => undefined);
          return releasing;
        };
        const onAbort = () => {
          stopped = true;
          // Failed acquisition owns its late results. After handoff, Runtime
          // alone releases the retained lease at its actual terminal boundary.
          if (!handedOff) void release();
        };
        bounds.signal.addEventListener("abort", onAbort, { once: true });
        native.signal.addEventListener("abort", onAbort, { once: true });
        acquisition = Promise.resolve().then(async () => {
          assert();
          selection = adopt(await registry(native, command, bounds, unit, io));
          if (
            !Number.isSafeInteger(selection.maximumObservationAgeMs) ||
            selection.maximumObservationAgeMs < 1 ||
            selection.maximumObservationAgeMs > 30000 ||
            !Number.isSafeInteger(selection.clockUncertaintyMs) ||
            selection.clockUncertaintyMs < 0 ||
            selection.clockUncertaintyMs >= selection.maximumObservationAgeMs ||
            selection.binding.startup.installationId !== unit.installationId ||
            selection.entry.spiffeId !== native.gatewaySpiffeId ||
            selection.controllerSpiffeId !== native.controllerSpiffeId ||
            !isDeepStrictEqual(selection.source, native.source)
          )
            throw unavailable();
          const currentAssociation = captureAssociation({
            startup: selection.binding.startup,
            createEffectRef: selection.binding.createEffectRef,
            recipient: selection.recipient,
            registration: selection.registration,
            sourceConfiguration: selection.source,
            endpoints: selection.endpoints,
          });
          if (
            !isDeepStrictEqual(currentAssociation, expected) ||
            selection.endpoints.gateway.spiffeId !== native.gatewaySpiffeId ||
            selection.endpoints.controller.spiffeId !== native.controllerSpiffeId
          )
            throw unavailable();
          commandBinding(command, selection);
          const entry = adopt(await registrar(selection, bounds));
          timed.push(entry);
          assert();
          if (
            entry.coverage !== "complete" ||
            entry.entries.length !== 1 ||
            !isDeepStrictEqual(entry.registration, selection.registration) ||
            !isDeepStrictEqual(exactEntry(entry.entries[0]!), exactEntry(selection.entry))
          )
            throw unavailable();
          const observed = adopt(await process(selection, command, bounds, unit, io));
          timed.push(observed, observed.executionObservation);
          assert();
          processBinding(selection, observed);
          assert();
        });
        void acquisition.catch(() => undefined);
        try {
          await acquisition;
          assert();
          handedOff = true;
          return Object.freeze({
            assertCurrent: (): undefined => {
              try {
                return assert();
              } catch {
                onAbort();
                throw unavailable();
              }
            },
            release,
          });
        } catch {
          await release();
          throw unavailable();
        }
      } catch {
        throw unavailable();
      }
    },
  });
}
