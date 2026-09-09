import { isIP } from "node:net";
import { decodeWorkloadProfileJson, canonicalizeWorkloadProfileJson } from "./canonical.ts";
import { deriveWorkloadProfileManifestV2 } from "./projections.ts";
import type {
  WorkloadProfileDefinitionSourceV2,
  WorkloadProfileOwnedLeaseV2,
} from "./admitted-use.ts";
import type { WorkloadProfileCapabilitySourceV2 } from "./selection.ts";
import type { WorkloadProfileManifestContentV2 } from "./manifest.ts";

type Reference = WorkloadProfileManifestContentV2["containment"]["definition"];
export interface SelectedNativeDestinationV1 {
  readonly address: string;
  readonly port: number;
}
export interface SelectedNativeServiceDefinitionV1 {
  readonly definition: Reference;
  /** Client-facing TLS authority; distinct from the policy-visible destination. */
  readonly authority: string;
  readonly port: 443;
  readonly destination: SelectedNativeDestinationV1;
}
/** Detached construction data. No field reports installed or effective control. */
export interface SelectedNativeDefinitionV1 {
  readonly schemaVersion: 1;
  readonly containment: {
    readonly definition: Reference;
    readonly networkFamily: "IPv4";
    readonly resolver: { readonly address: string; readonly port: 53 };
  };
  readonly modelMediator: SelectedNativeServiceDefinitionV1;
  readonly repositoryIssuer: SelectedNativeServiceDefinitionV1;
  // These owners have not supplied their deployment protocol dictionaries.
  readonly identity: { readonly definition: Reference };
  readonly harnessTransport: { readonly definition: Reference };
}

/** Private receiving dependency of the existing complete contributors. The
 * original owner recognizes its exact enrolled unit/IO, verifies its own digest
 * domain and immutable bytes, and holds withdrawal-conflicting source custody.
 * Definition acceptance has no revision or Use; the second method does.
 * Existing aggregation retains cleanup and rechecks after every await through
 * the original terminal fence. Neither method grants later provider-call use.
 * TODO(selected definition ownership): install the genuine original reader;
 * this interface deliberately has no positive default or registration factory. */
export interface SelectedNativeDefinitionSourceV1 {
  readDefinitionLocked(
    ...args: Parameters<WorkloadProfileDefinitionSourceV2["verifyDefinitionLocked"]>
  ): Promise<WorkloadProfileOwnedLeaseV2 & { readonly canonicalDefinition: Uint8Array }>;
  readRevisionLocked(
    ...args: Parameters<WorkloadProfileCapabilitySourceV2["acquire"]>
  ): Promise<WorkloadProfileOwnedLeaseV2 & { readonly canonicalDefinition: Uint8Array }>;
}

export class SelectedNativeDefinitionError extends Error {
  constructor() {
    super("The selected native deployment definition is invalid or incomplete.");
    this.name = "SelectedNativeDefinitionError";
  }
}
function requireValue(value: unknown): asserts value {
  if (!value) throw new SelectedNativeDefinitionError();
}
function shape(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  requireValue(value && typeof value === "object" && !Array.isArray(value));
  requireValue(
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)),
  );
}
function reference(value: unknown, expected: Reference): void {
  shape(value, ["ref", "version", "contentDigest"]);
  requireValue(
    value.ref === expected.ref &&
      value.version === expected.version &&
      value.contentDigest === expected.contentDigest,
  );
}
export function assertSelectedNativeIPv4V1(value: unknown): asserts value is string {
  requireValue(typeof value === "string" && isIP(value) === 4);
  const octets = value.split(".").map(Number);
  requireValue(
    octets[0]! > 0 &&
      octets[0]! < 224 &&
      octets[0] !== 127 &&
      !(octets[0] === 169 && octets[1] === 254),
  );
}
function service(value: unknown, expected: Reference): void {
  shape(value, ["definition", "authority", "port", "destination"]);
  reference(value.definition, expected);
  requireValue(typeof value.authority === "string" && value.authority.length <= 253);
  requireValue(
    value.authority.includes(".") &&
      isIP(value.authority) === 0 &&
      value.authority
        .split(".")
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
  );
  requireValue(value.port === 443);
  shape(value.destination, ["address", "port"]);
  assertSelectedNativeIPv4V1(value.destination.address);
  requireValue(
    Number.isSafeInteger(value.destination.port) &&
      (value.destination.port as number) > 0 &&
      (value.destination.port as number) <= 65535,
  );
}

/** Exact closed data decoding and V2 reference correspondence only. selectedRecord
 * has no universal content-digest domain; only its original reader can verify
 * actual content identity. This function supplies neither that provenance nor
 * native/identity protocol qualification or current authorization. */
export function decodeSelectedNativeDefinitionV1(
  input: Uint8Array,
  canonicalManifest: Uint8Array,
): { readonly value: SelectedNativeDefinitionV1; readonly canonicalBytes: Uint8Array } {
  const manifest = deriveWorkloadProfileManifestV2(canonicalManifest).content;
  const { value } = decodeWorkloadProfileJson(input);
  shape(value, [
    "schemaVersion",
    "containment",
    "modelMediator",
    "repositoryIssuer",
    "identity",
    "harnessTransport",
  ]);
  requireValue(value.schemaVersion === 1);
  shape(value.containment, ["definition", "networkFamily", "resolver"]);
  reference(value.containment.definition, manifest.containment.definition);
  requireValue(value.containment.networkFamily === "IPv4");
  shape(value.containment.resolver, ["address", "port"]);
  assertSelectedNativeIPv4V1(value.containment.resolver.address);
  requireValue(value.containment.resolver.port === 53);
  service(value.modelMediator, manifest.endpoints.modelMediator);
  service(value.repositoryIssuer, manifest.endpoints.repositoryIssuer);
  for (const role of ["identity", "harnessTransport"] as const) {
    shape(value[role], ["definition"]);
    reference(value[role].definition, manifest.endpoints[role]);
  }
  return Object.freeze({
    value: value as unknown as SelectedNativeDefinitionV1,
    canonicalBytes: canonicalizeWorkloadProfileJson(value),
  });
}
