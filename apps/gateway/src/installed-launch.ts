import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  gatewayLaunchMaxBytes,
  gatewayLaunchPath,
  gatewayNativeBinaryPath,
} from "@openclaw-enterprise/contracts/hosted-gateway-launch-v1";
import {
  canonicalGatewayStartupValueV1,
  parseGatewayStartupBindingV1,
  parseGatewayStartupBindingV2,
  parseGatewayStartupCommandV1,
  parseGatewayStartupCommandV2,
} from "@openclaw-enterprise/occ/gateway-startup-v1/owner";
import {
  parseGatewayInstallationServiceAssociationV1,
  parseGatewayInstallationServiceAssociationV2,
  type GatewayInstallationServiceEndpointsV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/installation-service";
import {
  decodeHostedHarnessTransportSelectionV1,
  type HostedHarnessTransportSelectionV1,
} from "@openclaw-enterprise/contracts/hosted-harness-transport-v1";
import { nativeBinaryPath, nativeExecutableSha256 } from "./installed-native.mjs";
import type {
  GatewayStartupNativeClientOptionsV1,
  GatewayStartupNativeClientOptionsV2,
} from "./startup-native-client.ts";
import { closedNativeObject, nativeJson } from "./startup-native-wire.ts";
import {
  gatewayStartupOperationProfile,
  gatewayStartupTransportProfile,
} from "./startup-service-source.ts";

export const installedGatewayLaunchPathV1 = gatewayLaunchPath;
/** Serialized expectations from the original protected launch selection. The
 * image fixes the executable path/digest and the local material factory. */
export interface InstalledGatewayLaunchDescriptorV1 extends Omit<
  GatewayStartupNativeClientOptionsV1,
  "binaryPath"
> {
  readonly schemaVersion: 1;
}
export interface InstalledGatewayLaunchSelectionV2 extends GatewayStartupNativeClientOptionsV2 {
  readonly harness: HostedHarnessTransportSelectionV1 | null;
}
export interface InstalledGatewayLaunchDescriptorV2 extends Omit<
  InstalledGatewayLaunchSelectionV2,
  "binaryPath"
> {
  readonly schemaVersion: 2;
}
const unavailable = () => new Error("Hosted gateway launch selection unavailable");
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

function decodeNativeSelectionFields(
  value: Record<string, unknown>,
  installedDigest: string,
  endpoints: GatewayInstallationServiceEndpointsV1,
) {
  const address = value.address;
  if (typeof address !== "string") throw unavailable();
  const endpoint = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/u.exec(address);
  if (
    !endpoint ||
    !isIP(endpoint[1] ?? endpoint[2] ?? "") ||
    String(Number(endpoint[3])) !== endpoint[3] ||
    Number(endpoint[3]) < 1 ||
    Number(endpoint[3]) > 65535 ||
    typeof value.configurationVersion !== "number" ||
    !Number.isSafeInteger(value.configurationVersion) ||
    value.configurationVersion < 1
  )
    throw unavailable();
  const profile = closedNativeObject(value.profile, [
    "schemaVersion",
    "operationPolicy",
    "sourceRef",
    "sourceConfigurationDigest",
    "workloadApiSocketPath",
    "ownSPIFFEId",
    "peerSPIFFEId",
    "recipientRef",
    "recipientSPIFFEId",
    "trustDomain",
    "trustRootsRef",
    "trustBundleSha256",
    "verifierProfileRef",
    "nativeExecutableSha256",
    "transportProfileRef",
    "limits",
  ]);
  if (
    profile.schemaVersion !== 1 ||
    profile.operationPolicy !== gatewayStartupOperationProfile ||
    profile.transportProfileRef !== gatewayStartupTransportProfile ||
    profile.nativeExecutableSha256 !== installedDigest ||
    profile.ownSPIFFEId !== endpoints.gateway.spiffeId ||
    profile.peerSPIFFEId !== endpoints.controller.spiffeId ||
    profile.recipientSPIFFEId !== profile.peerSPIFFEId ||
    profile.recipientRef !== endpoints.transportRecipientRef ||
    endpoints.transportRecipientRef !== endpoints.controller.serviceRef ||
    !isDeepStrictEqual(profile.limits, {
      handshakeTimeoutMs: 3000,
      recheckIntervalMs: 1000,
      maxConnectionAgeMs: 30000,
      maxConnections: 1,
      requestTimeoutMs: 3000,
    })
  )
    throw unavailable();
  return { address, configurationVersion: value.configurationVersion, profile };
}

/** Closed expectation data only. Decoding never authenticates a native peer,
 * installs a factory, authorizes a command or issues a local enrollment. */
export function decodeInstalledGatewayLaunchV1(
  bytes: Uint8Array,
  installedDigest: string,
): GatewayStartupNativeClientOptionsV1 {
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > gatewayLaunchMaxBytes ||
    !/^sha256:[0-9a-f]{64}$/.test(installedDigest)
  )
    throw unavailable();
  const value = closedNativeObject(nativeJson(bytes), [
    "schemaVersion",
    "address",
    "configurationVersion",
    "profile",
    "association",
    "binding",
    "consumeCommand",
  ]);
  if (value.schemaVersion !== 1) throw unavailable();
  const association = parseGatewayInstallationServiceAssociationV1(value.association);
  const binding = parseGatewayStartupBindingV1(value.binding);
  const command = parseGatewayStartupCommandV1(value.consumeCommand);
  const { address, configurationVersion, profile } = decodeNativeSelectionFields(
    value,
    installedDigest,
    association.endpoints,
  );
  if (
    command.kind !== "consume-startup" ||
    !isDeepStrictEqual(command.startup, binding.startup) ||
    !isDeepStrictEqual(association.startup, binding.startup) ||
    !isDeepStrictEqual(association.recipient, command.recipient) ||
    association.createEffectRef !== binding.createEffectRef
  )
    throw unavailable();
  // Maintained SPIFFE/profile validation and actual Source/TLS verification still
  // run in the fixed child. This descriptor cannot choose that child or its hash.
  return freeze({
    binaryPath: nativeBinaryPath,
    address,
    configurationVersion,
    profile,
    association,
    binding,
    consumeCommand: command,
  });
}

/** Canonical Agent/V2 expectations from the original retained allocation.
 * The complete subject, registration and optional Harness metadata stay data;
 * original native/current selection and material owners authorize their use. */
export function decodeInstalledGatewayLaunchV2(
  bytes: Uint8Array,
  installedDigest: string,
): InstalledGatewayLaunchSelectionV2 {
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > gatewayLaunchMaxBytes ||
    !/^sha256:[0-9a-f]{64}$/.test(installedDigest)
  )
    throw unavailable();
  const value = closedNativeObject(nativeJson(bytes), [
    "schemaVersion",
    "address",
    "configurationVersion",
    "profile",
    "association",
    "binding",
    "consumeCommand",
    "harness",
  ]);
  if (
    value.schemaVersion !== 2 ||
    !Buffer.from(bytes).equals(Buffer.from(canonicalGatewayStartupValueV1(value)))
  )
    throw unavailable();
  const association = parseGatewayInstallationServiceAssociationV2(value.association);
  const binding = parseGatewayStartupBindingV2(value.binding);
  const command = parseGatewayStartupCommandV2(value.consumeCommand);
  const { address, configurationVersion, profile } = decodeNativeSelectionFields(
    value,
    installedDigest,
    association.endpoints,
  );
  if (
    command.kind !== "consume-startup" ||
    !isDeepStrictEqual(command.subject, binding.startup.subject) ||
    !isDeepStrictEqual(command.startup, binding.startup) ||
    !isDeepStrictEqual(association.startup, binding.startup) ||
    !isDeepStrictEqual(association.recipient, command.recipient) ||
    association.createEffectRef !== binding.createEffectRef
  )
    throw unavailable();
  let harness: HostedHarnessTransportSelectionV1 | null = null;
  if (value.harness !== null) {
    harness = decodeHostedHarnessTransportSelectionV1(value.harness);
    const assignment = harness.assignment;
    if (
      assignment.installationRef !== binding.startup.subject.installationId ||
      assignment.namespaceRef !== binding.namespaceRef ||
      assignment.agentRef !== binding.agentRef ||
      assignment.revisionRef !== binding.admittedRevisionRef ||
      assignment.gatewayAssignmentRef !== binding.gatewayAssignmentRef ||
      assignment.runtimeGeneration !== binding.hostRuntimeGeneration
    )
      throw unavailable();
  }
  return freeze({
    binaryPath: nativeBinaryPath,
    address,
    configurationVersion,
    profile,
    association,
    binding,
    consumeCommand: command,
    harness,
  });
}

let captured = false;
/** The installed entrypoint captures one root-owned immutable mount. Parent
 * directory checks assume the original privileged deployment owner is trusted;
 * they cannot defeat a privileged concurrent filesystem replacement. Every
 * opened descriptor/read/close is joined before this promise settles. */
export function captureInstalledGatewayLaunchV1(
  signal: AbortSignal,
): Promise<GatewayStartupNativeClientOptionsV1> {
  return captureInstalledLaunch(signal, decodeInstalledGatewayLaunchV1);
}
export function captureInstalledGatewayLaunchV2(
  signal: AbortSignal,
): Promise<InstalledGatewayLaunchSelectionV2> {
  return captureInstalledLaunch(signal, decodeInstalledGatewayLaunchV2);
}
async function captureInstalledLaunch<Selection>(
  signal: AbortSignal,
  decode: (bytes: Uint8Array, installedDigest: string) => Selection,
): Promise<Selection> {
  if (captured) throw unavailable();
  captured = true;
  if (
    !(signal instanceof AbortSignal) ||
    typeof nativeExecutableSha256 !== "string" ||
    nativeBinaryPath !== gatewayNativeBinaryPath
  )
    throw unavailable();
  signal.throwIfAborted();
  let parent = dirname(installedGatewayLaunchPathV1);
  for (;;) {
    const metadata = await lstat(parent);
    signal.throwIfAborted();
    if (!metadata.isDirectory() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0)
      throw unavailable();
    if (parent === "/") break;
    parent = dirname(parent);
  }
  const file = await open(
    installedGatewayLaunchPathV1,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let selection: Selection | undefined;
  try {
    signal.throwIfAborted();
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.uid !== 0 ||
      (before.mode & 0o777) !== 0o440 ||
      before.size < 1 ||
      before.size > gatewayLaunchMaxBytes ||
      before.nlink !== 1
    )
      throw unavailable();
    const bytes = Buffer.alloc(before.size);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const read = await file.read(bytes, offset, bytes.length - offset, offset);
        if (read.bytesRead < 1) throw unavailable();
        offset += read.bytesRead;
      }
      const after = await file.stat();
      signal.throwIfAborted();
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.ctimeMs !== after.ctimeMs ||
        before.mtimeMs !== after.mtimeMs ||
        before.uid !== after.uid ||
        before.mode !== after.mode ||
        before.nlink !== after.nlink
      )
        throw unavailable();
      selection = decode(bytes, nativeExecutableSha256);
    } finally {
      bytes.fill(0);
    }
  } finally {
    await file.close();
  }
  signal.throwIfAborted();
  if (selection === undefined) throw unavailable();
  return selection;
}
