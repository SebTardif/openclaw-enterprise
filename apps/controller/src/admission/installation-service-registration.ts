import { createHash } from "node:crypto";
import { parseGatewayMaterialDeliveryRequestV1 } from "@openclaw-enterprise/occ/gateway-startup-v1/material-delivery";
import type { GatewayMaterialDeliveryRequestV1 } from "@openclaw-enterprise/contracts/gateway-material-delivery-v1";
import { isDeepStrictEqual } from "node:util";
import {
  canonicalGatewayStartupValueV1,
  gatewayStartupCommandDigestV1,
  gatewayStartupCommandDigestV2,
  parseGatewayStartupCommandV1,
  parseGatewayStartupCommandV2,
} from "@openclaw-enterprise/occ/gateway-startup-v1/owner";
import type {
  GatewayStartupAcceptedOperationV1,
  GatewayStartupCommandBoundsV1,
  GatewayStartupCommandV1,
  GatewayStartupCommandV2,
  GatewayStartupOwnerLeaseV1,
  GatewayStartupOwnerUnitV1,
  GatewayStartupOwnerUnitV2,
  GatewayStartupRecipientBindingV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/owner";
import type {
  GatewayProcessObservationResultV1,
  GatewayProcessObservationResultV2,
  GatewayStartupBindingV1,
  GatewayStartupBindingV2,
  GatewayStartupRecordRefV1,
} from "@openclaw-enterprise/contracts/gateway-startup-v1";

import {
  parseGatewayInstallationServiceAssociationV2,
  type GatewayInstallationServiceAssociationV2,
  type GatewayInstallationServiceAssociationV1,
  type GatewayInstallationServiceEndpointsV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/installation-service";

type Command = Extract<
  GatewayStartupCommandV1,
  { kind: "consume-startup" | "read-current" | "read-operation" }
>;
type CommandV2 = Extract<
  GatewayStartupCommandV2,
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
/** Actual native child configuration, distinct from a selected registry record. */
export type InstallationServiceNativeConfigurationV1 = Readonly<{
  sourceRef: string;
  configurationVersion: number;
  sourceConfigurationDigest: string;
}>;
/** Protected registry selection, supplied by its actual current writer. Values alone are not a grant. */
export type InstallationServiceRegistrationSelectionV1 = Readonly<{
  binding: GatewayStartupBindingV1;
  recipient: GatewayStartupRecipientBindingV1;
  registration: GatewayStartupRecordRefV1;
  /** Immutable original Source-configuration record and version. */
  source: GatewayStartupRecordRefV1;
  /** Exact native tuple mapped to source by the same protected current writer. */
  nativeConfiguration: InstallationServiceNativeConfigurationV1;
  endpoints: GatewayInstallationServiceEndpointsV1;
  entry: InstallationServiceRegistrationEntryV1;
  controllerSpiffeId: string;
  process: InstallationServiceProcessIdentityV1;
  maximumObservationAgeMs: number;
  clockUncertaintyMs: number;
}>;
export type InstallationServiceRegistrationSelectionV2 = Omit<
  InstallationServiceRegistrationSelectionV1,
  "binding"
> &
  Readonly<{ binding: GatewayStartupBindingV2 }>;
type RegistrationSelection =
  InstallationServiceRegistrationSelectionV1 | InstallationServiceRegistrationSelectionV2;
type RegistrationUnit = GatewayStartupOwnerUnitV1 | GatewayStartupOwnerUnitV2;
type ProcessObservation = GatewayProcessObservationResultV1 | GatewayProcessObservationResultV2;
export type InstallationServiceNativeInspectionV1 = Readonly<{
  /** Expected association metadata only; it is not observed native authority. */
  expectedSourceConfiguration: GatewayStartupRecordRefV1;
  /** Original child/profile/bootstrap tuple, maintained by the native fence. */
  nativeConfiguration: InstallationServiceNativeConfigurationV1;
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
type NativeEvidence = Omit<
  InstallationServiceNativeInspectionV1,
  "commandDigest" | "operationProfile" | "transportProfile"
>;

/** Dedicated original material child evidence; old startup proofs do not select it. */
export type InstallationServiceMaterialNativeInspectionV1 = NativeEvidence &
  Readonly<{
    requestDigest: string;
    operationProfile: "installation-channel-material-v1";
    transportProfile: "owned-child-stdio-installation-channel-material-v1";
  }>;
/** Same protected current registry writer, with the exact selected material use and claim. */
export type InstallationServiceMaterialSelectionV1 = InstallationServiceRegistrationSelectionV1 &
  Readonly<{
    material: Readonly<{
      purpose: "read-selected-channel-material";
      use: GatewayMaterialDeliveryRequestV1["use"];
      consumedClaim: GatewayMaterialDeliveryRequestV1["consumedClaim"];
    }>;
  }>;

interface RegistrationParticipants<
  C,
  N extends NativeEvidence,
  S extends RegistrationSelection,
  U extends RegistrationUnit = GatewayStartupOwnerUnitV1,
  O extends ProcessObservation = GatewayProcessObservationResultV1,
> {
  native: {
    inspectOriginal(
      original: object,
      command: C,
      bounds: GatewayStartupCommandBoundsV1,
    ): N | undefined;
  };
  registry: {
    acquire(
      native: N,
      command: C,
      bounds: GatewayStartupCommandBoundsV1,
      unit: U,
      io: GatewayStartupAcceptedOperationV1,
    ): Promise<Lease<S>>;
  };
  registrar: {
    acquire(
      selection: S,
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
      selection: S,
      command: C,
      bounds: GatewayStartupCommandBoundsV1,
      unit: U,
      io: GatewayStartupAcceptedOperationV1,
    ): Promise<
      Lease<
        Timed &
          Readonly<{
            observation: O;
            /** Independently protected execution observation, not a label or derived PID value. */
            identity: InstallationServiceProcessIdentityV1;
            executionObservation: Timed;
          }>
      >
    >;
  };
}

export type InstallationServiceRegistrationParticipantsV1 = RegistrationParticipants<
  Command,
  InstallationServiceNativeInspectionV1,
  InstallationServiceRegistrationSelectionV1
>;
export type InstallationServiceMaterialRegistrationParticipantsV1 = RegistrationParticipants<
  GatewayMaterialDeliveryRequestV1,
  InstallationServiceMaterialNativeInspectionV1,
  InstallationServiceMaterialSelectionV1
>;

export type InstallationServiceRegistrationParticipantsV2 = RegistrationParticipants<
  CommandV2,
  InstallationServiceNativeInspectionV1,
  InstallationServiceRegistrationSelectionV2,
  GatewayStartupOwnerUnitV2,
  GatewayProcessObservationResultV2
>;

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
function captureAssociationV1(value: GatewayInstallationServiceAssociationV1) {
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

function captureNativeConfiguration(value: InstallationServiceNativeConfigurationV1) {
  const result = snapshot(value);
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).sort().join() !==
      "configurationVersion,sourceConfigurationDigest,sourceRef" ||
    typeof result.sourceRef !== "string" ||
    result.sourceRef.length < 1 ||
    result.sourceRef.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(result.sourceRef) ||
    !Number.isSafeInteger(result.configurationVersion) ||
    result.configurationVersion < 1 ||
    typeof result.sourceConfigurationDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(result.sourceConfigurationDigest)
  )
    throw unavailable();
  return deepFreeze(result);
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
function captureAssociation(
  value: Readonly<
    Omit<GatewayInstallationServiceAssociationV1, "startup"> & {
      startup:
        | GatewayInstallationServiceAssociationV1["startup"]
        | GatewayInstallationServiceAssociationV2["startup"];
    }
  >,
) {
  try {
    // Reject accessors/prototypes before selecting the closed locator grammar.
    const captured = snapshot(value);
    if ("subject" in captured.startup)
      return parseGatewayInstallationServiceAssociationV2(captured);
    return captureAssociationV1({ ...captured, startup: captured.startup });
  } catch {
    throw unavailable();
  }
}
function processBinding(
  selection: RegistrationSelection,
  value: Timed &
    Readonly<{
      observation: ProcessObservation;
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
function createRegistrationReader<
  C,
  N extends NativeEvidence,
  S extends RegistrationSelection,
  U extends RegistrationUnit = GatewayStartupOwnerUnitV1,
  O extends ProcessObservation = GatewayProcessObservationResultV1,
>(
  participants: RegistrationParticipants<C, N, S, U, O> | undefined,
  expectedAssociation:
    GatewayInstallationServiceAssociationV1 | GatewayInstallationServiceAssociationV2 | undefined,
  rules: Readonly<{
    parse(input: C): C;
    nativeMatches(native: N, command: C): boolean;
    commandBinding(command: C, selection: S): void;
    unitBinding(selection: S, unit: U): boolean;
    maximumCallMs?: number;
  }>,
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
      input: C,
      bounds: GatewayStartupCommandBoundsV1,
      unit: U,
      io: GatewayStartupAcceptedOperationV1,
    ): Promise<GatewayStartupOwnerLeaseV1> {
      try {
        if (!inspect || !registry || !registrar || !process || !expected) throw unavailable();
        const command = rules.parse(input);
        const deadline = Date.parse(bounds.deadline);
        if (
          !(bounds.signal instanceof AbortSignal) ||
          bounds.signal.aborted ||
          !Number.isFinite(deadline) ||
          deadline <= Date.now() ||
          (rules.maximumCallMs !== undefined && deadline - Date.now() > rules.maximumCallMs)
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
          !rules.nativeMatches(native, command) ||
          !Number.isSafeInteger(native.expiresAtMs)
        )
          throw unavailable();
        // The native producer must bind this tuple to its actual original child.
        // The registry later supplies the independent authoritative record mapping.
        const nativeConfiguration = captureNativeConfiguration(native.nativeConfiguration);
        const expectedSourceConfiguration = deepFreeze(
          snapshot(native.expectedSourceConfiguration),
        );
        const pending = new Set<Promise<unknown>>();
        const releases: (() => Promise<void>)[] = [];
        const fences: (() => undefined)[] = [];
        const timed: Timed[] = [];
        let selection: S | undefined;
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
          if (!rules.nativeMatches(native, command)) throw unavailable();
          if (
            !isDeepStrictEqual(
              captureNativeConfiguration(native.nativeConfiguration),
              nativeConfiguration,
            ) ||
            !isDeepStrictEqual(native.expectedSourceConfiguration, expectedSourceConfiguration)
          )
            throw unavailable();
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
            !rules.unitBinding(selection, unit) ||
            selection.entry.spiffeId !== native.gatewaySpiffeId ||
            selection.controllerSpiffeId !== native.controllerSpiffeId ||
            !isDeepStrictEqual(selection.source, expectedSourceConfiguration) ||
            !isDeepStrictEqual(
              captureNativeConfiguration(selection.nativeConfiguration),
              nativeConfiguration,
            )
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
          rules.commandBinding(command, selection);
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

/** Original startup-only profile; none of its three commands carries material. */
export function createInstallationServiceRegistrationReaderV1(
  participants: InstallationServiceRegistrationParticipantsV1 | undefined,
  expectedAssociation: GatewayInstallationServiceAssociationV1 | undefined,
) {
  return createRegistrationReader<
    Command,
    InstallationServiceNativeInspectionV1,
    InstallationServiceRegistrationSelectionV1
  >(participants, expectedAssociation, {
    parse(input): Command {
      const parsed = parseGatewayStartupCommandV1(input);
      if (
        parsed.kind !== "consume-startup" &&
        parsed.kind !== "read-current" &&
        parsed.kind !== "read-operation"
      )
        throw unavailable();
      return parsed;
    },
    nativeMatches: (native, command) =>
      native.operationProfile === "installation-gateway-startup-v1" &&
      native.transportProfile === "owned-child-stdio-installation-gateway-startup-v1" &&
      native.commandDigest === gatewayStartupCommandDigestV1(command),
    commandBinding,
    unitBinding: (selection, unit) =>
      selection.binding.startup.installationId === unit.installationId,
  });
}

/**
 * Separate selected material purpose, within the SAME original unit/io and lease
 * lifecycle. This does not create a current owner, registration, native proof or
 * durable attempt disposition; missing authentic participants remain unavailable.
 */
export function createInstallationServiceMaterialRegistrationReaderV1(
  participants: InstallationServiceMaterialRegistrationParticipantsV1 | undefined,
  expectedAssociation: GatewayInstallationServiceAssociationV1 | undefined,
) {
  return createRegistrationReader<
    GatewayMaterialDeliveryRequestV1,
    InstallationServiceMaterialNativeInspectionV1,
    InstallationServiceMaterialSelectionV1
  >(participants, expectedAssociation, {
    parse: parseGatewayMaterialDeliveryRequestV1,
    unitBinding: (selection, unit) =>
      selection.binding.startup.installationId === unit.installationId,
    maximumCallMs: 5000,
    nativeMatches: (native, request) =>
      native.operationProfile === "installation-channel-material-v1" &&
      native.transportProfile === "owned-child-stdio-installation-channel-material-v1" &&
      native.requestDigest ===
        createHash("sha256").update(canonicalGatewayStartupValueV1(request)).digest("hex"),
    commandBinding(request, selection) {
      if (
        !isDeepStrictEqual(request.startup, selection.binding.startup) ||
        !isDeepStrictEqual(request.selection, selection.binding.selection) ||
        !isDeepStrictEqual(request.recipient, selection.recipient.recipient) ||
        !selection.material ||
        Object.keys(selection.material).sort().join() !== "consumedClaim,purpose,use" ||
        selection.material.purpose !== request.purpose ||
        selection.material.use !== request.use ||
        !isDeepStrictEqual(selection.material.consumedClaim, request.consumedClaim)
      )
        throw unavailable();
    },
  });
}

/** Agent-scoped startup registration uses the same original native/registrar/
 * physical observation lifecycle, with V2 command, binding and unit correspondence. */
export function createInstallationServiceRegistrationReaderV2(
  participants: InstallationServiceRegistrationParticipantsV2 | undefined,
  expectedAssociation: GatewayInstallationServiceAssociationV2 | undefined,
) {
  return createRegistrationReader<
    CommandV2,
    InstallationServiceNativeInspectionV1,
    InstallationServiceRegistrationSelectionV2,
    GatewayStartupOwnerUnitV2,
    GatewayProcessObservationResultV2
  >(participants, expectedAssociation, {
    parse(input): CommandV2 {
      const parsed = parseGatewayStartupCommandV2(input);
      if (
        parsed.kind !== "consume-startup" &&
        parsed.kind !== "read-current" &&
        parsed.kind !== "read-operation"
      )
        throw unavailable();
      return parsed;
    },
    nativeMatches: (native, command) =>
      native.operationProfile === "installation-gateway-startup-v1" &&
      native.transportProfile === "owned-child-stdio-installation-gateway-startup-v1" &&
      native.commandDigest === gatewayStartupCommandDigestV2(command),
    unitBinding: (selection, unit) =>
      isDeepStrictEqual(selection.binding.startup.subject, unit.subject),
    commandBinding(command, selection) {
      const startup =
        command.kind === "read-operation" ? command.operation.startup : command.startup;
      if (
        !startup ||
        !isDeepStrictEqual(startup, selection.binding.startup) ||
        !isDeepStrictEqual(command.subject, selection.binding.startup.subject) ||
        (command.kind !== "read-operation" &&
          !isDeepStrictEqual(command.recipient, selection.recipient))
      )
        throw unavailable();
    },
  });
}
