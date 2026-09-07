import { isDeepStrictEqual, types as nodeTypes } from "node:util";
import {
  decodeCredentialWorkloadSelectionV1,
  type CredentialWorkloadSelectionV1,
} from "@openclaw-enterprise/contracts/credential-workload-selection-v1";
import type { GatewayStartupBindingV1 } from "@openclaw-enterprise/contracts/gateway-startup-v1";
import {
  canonicalGatewayStartupValueV1,
  parseGatewayStartupBindingV1,
  type GatewayStartupOwnerParticipantsV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/owner";

/** The original Runtime participant owns acquisition, currentness and release. */
export type CredentialRuntimeSelectionLeaseV1 = Awaited<
  ReturnType<GatewayStartupOwnerParticipantsV1["selection"]["resolveLocked"]>
>;
export type AdmittedCredentialWorkloadComparisonV1 =
  | Readonly<{ kind: "corresponds" }>
  | Readonly<{
      kind: "mismatch";
      reason: "invalid-selection" | "admitted-selection" | "runtime-selection";
    }>
  | Readonly<{ kind: "unavailable" }>;

export interface AdmittedCredentialWorkloadInspectorV1 {
  /** Call inside the original held selection. No acquisition, use, release or authority is returned. */
  inspect(
    original: CredentialRuntimeSelectionLeaseV1,
    admitted: unknown,
  ): AdmittedCredentialWorkloadComparisonV1;
}

function currentMethod(original: object): ((this: object) => unknown) | undefined {
  let at: object | null = original;
  for (let depth = 0; at !== null && depth < 4; depth++) {
    if (nodeTypes.isProxy(at)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(at, "assertCurrent");
    if (descriptor) {
      if (
        !("value" in descriptor) ||
        typeof descriptor.value !== "function" ||
        nodeTypes.isProxy(descriptor.value) ||
        nodeTypes.isAsyncFunction(descriptor.value)
      )
        return undefined;
      return descriptor.value as (this: object) => unknown;
    }
    at = Object.getPrototypeOf(at) as object | null;
  }
  return undefined;
}
function synchronouslyCurrent(method: (this: object) => unknown, original: object): boolean {
  const result = method.call(original);
  if (nodeTypes.isPromise(result)) {
    // Observe malformed native Promise rejection without awaiting or accepting it.
    void Promise.prototype.then.call(result, undefined, () => {});
    return false;
  }
  return result === undefined;
}
function selectedSnapshot(original: object): string {
  const descriptor = Object.getOwnPropertyDescriptor(original, "selected");
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
    throw new Error("Credential selection unavailable");
  return canonicalGatewayStartupValueV1(descriptor.value);
}

function fixedBindingMatches(
  credentials: CredentialWorkloadSelectionV1,
  binding: GatewayStartupBindingV1,
): boolean {
  if (
    credentials.scope.installationId !== binding.startup.installationId ||
    credentials.scope.namespaceId !== binding.namespaceRef ||
    credentials.scope.agentId !== binding.agentRef ||
    credentials.revisionId !== binding.admittedRevisionRef ||
    !isDeepStrictEqual(credentials.materialSelection, binding.selection)
  )
    return false;
  for (const channel of credentials.channels) {
    const selected = binding.modules.filter((module) => module.id === channel.moduleId);
    if (
      selected.length !== 1 ||
      selected[0]?.kind !== "channel" ||
      selected[0].profileRef !== channel.profileRef
    )
      return false;
  }
  return true;
}

/**
 * Trusted composition captures already owner-selected, nonsecret borrower expectations.
 * This is correspondence only: matching data/guard methods do not authenticate an owner,
 * select a manifest, prove capabilities, admit startup or authorize material/model use.
 */
export function createAdmittedCredentialWorkloadInspectorV1(
  expected: unknown,
  originalBinding: GatewayStartupBindingV1,
): AdmittedCredentialWorkloadInspectorV1 | undefined {
  try {
    const decoded = decodeCredentialWorkloadSelectionV1(expected);
    if (decoded.kind === "invalid") return undefined;
    const credentials = decoded.value;
    const binding = parseGatewayStartupBindingV1(originalBinding);
    if (!fixedBindingMatches(credentials, binding)) return undefined;
    const { startup: _startup, createEffectRef: _effect, ...selected } = binding;
    const selectedBytes = canonicalGatewayStartupValueV1(selected);
    return Object.freeze({
      inspect(
        original: CredentialRuntimeSelectionLeaseV1,
        admitted: unknown,
      ): AdmittedCredentialWorkloadComparisonV1 {
        try {
          if (original === null || typeof original !== "object" || nodeTypes.isProxy(original))
            return Object.freeze({ kind: "unavailable" });
          const assertCurrent = currentMethod(original);
          if (!assertCurrent || !synchronouslyCurrent(assertCurrent, original))
            return Object.freeze({ kind: "unavailable" });
          const current = selectedSnapshot(original);
          const actual = decodeCredentialWorkloadSelectionV1(admitted);
          // Neither parsing nor comparison substitutes for this original synchronous fence.
          if (
            !synchronouslyCurrent(assertCurrent, original) ||
            selectedSnapshot(original) !== current
          )
            return Object.freeze({ kind: "unavailable" });
          if (actual.kind === "invalid")
            return Object.freeze({ kind: "mismatch", reason: "invalid-selection" });
          if (!isDeepStrictEqual(actual.value, credentials))
            return Object.freeze({ kind: "mismatch", reason: "admitted-selection" });
          if (current !== selectedBytes)
            return Object.freeze({ kind: "mismatch", reason: "runtime-selection" });
          return Object.freeze({ kind: "corresponds" });
        } catch {
          // Preserve original ownership and uncertainty; do not release or retry its work.
          return Object.freeze({ kind: "unavailable" });
        }
      },
    });
  } catch {
    return undefined;
  }
}
