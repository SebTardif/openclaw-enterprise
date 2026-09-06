import { createHash } from "node:crypto";
import {
  CREDENTIAL_STORAGE_LIMITS_V1 as limits,
  canonicalCredentialStorageRequestV1,
  parseCredentialStorageV1,
  type BindingMutationResultV1,
  type CredentialCachePartitionV1,
  type CredentialMaterialHandleV1,
  type CredentialStorageCallBoundsV1,
  type CredentialUseResultV1,
  type NamedCredentialUseV1,
  type ProtectedCredentialPortV1,
  type RotateCredentialBindingV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import { parseCredentialBackendProfileV1 } from "@openclaw-enterprise/contracts/credential-backend-profile-v1";
import type {
  CurrentCredentialAuthorityV1,
  CredentialManagementHandleV1,
} from "@openclaw-enterprise/contracts/credential-authority-v1";
import { createBoundedCredentialMaterialCacheV1, custodyEqualV1 } from "./cache.ts";
import { resolveNamedCustodyProjectionV1 } from "./backend.ts";
import {
  CredentialCustodyErrorV1,
  custodyFailureFromErrorV1,
  type NamedCredentialCustodyDependenciesV1,
} from "./ports.ts";

export interface NamedCredentialCustodyV1 extends ProtectedCredentialPortV1 {
  close(): void;
  invalidate(binding: CredentialCachePartitionV1["binding"]): void;
  inspect(): Readonly<{
    entries: number;
    reservedBytes: number;
    busy: number;
    closed: boolean;
    calls: number;
  }>;
}
const unavailable = Object.freeze({ kind: "unavailable", reason: "secret-unavailable" } as const);
const invalid = Object.freeze({ kind: "denied", reason: "invalid-input" } as const);
const expired = Object.freeze({ kind: "denied", reason: "expired" } as const);
const capacity = Object.freeze({
  kind: "capacity-exhausted",
  reason: "capacity-exhausted",
} as const);

/** Local trusted composition only. Unprovided owners remain closed. The fixed
 * callback sees only its real protected adapter's opaque minimum-material handle.
 * Repository mint is withheld pending journal + current-effect owner composition. */
export function createNamedCredentialCustodyV1(
  inputDependencies: NamedCredentialCustodyDependenciesV1,
): NamedCredentialCustodyV1 {
  const profile = parseCredentialBackendProfileV1(inputDependencies.profile);
  const deps = Object.freeze({ ...inputDependencies, profile });
  const consumers = new Set(deps.consumers);
  if (
    consumers.size < 1 ||
    consumers.size > limits.maxMaterialCacheEntries ||
    [...consumers].some((consumer) => typeof consumer !== "function")
  )
    throw new CredentialCustodyErrorV1(invalid);
  const cache = createBoundedCredentialMaterialCacheV1(deps.clock);
  let closed = false;
  let calls = 0;
  function capable(operation: "model" | "rotation"): boolean {
    return (
      !closed &&
      !cache.inspect().closed &&
      deps.custody?.kind === "protected-immutable-custody" &&
      profile.custody.kind === "external-protected-adapter" &&
      custodyEqualV1(deps.custody.adapter, profile.custody.adapter) &&
      (
        [
          "externalCustody",
          "authenticatedExactNamedAccess",
          "versionedReadAndRotation",
          "protectedEncryptionAndKeyCustody",
        ] as const
      ).every((name) => profile.capabilities[name].status === "supported") &&
      profile.capabilities.auditCoupling.status === "supported" &&
      (operation === "model" ||
        (
          [
            "durableCompareAndSet",
            "exactUnknownOperationReadback",
            "restartCompleteAffectedSnapshots",
          ] as const
        ).every((name) => profile.capabilities[name].status === "supported"))
    );
  }
  function bound(
    request: NamedCredentialUseV1 | RotateCredentialBindingV1,
    caller: CredentialStorageCallBoundsV1,
  ): CredentialStorageCallBoundsV1 {
    const now = cache.readClock();
    if (Date.parse(request.createdAt) > now.wallMs + now.uncertaintyMs)
      throw new CredentialCustodyErrorV1(expired);
    const remaining = Math.min(
      limits.maxCallMs,
      Date.parse(request.deadline) - now.wallMs - now.uncertaintyMs,
    );
    if (remaining <= 0 || caller.signal.aborted) throw new CredentialCustodyErrorV1(expired);
    return { signal: AbortSignal.any([caller.signal, AbortSignal.timeout(remaining)]) };
  }
  async function bounded<T>(
    bounds: CredentialStorageCallBoundsV1,
    run: () => Promise<T>,
    onAbort: () => T,
  ): Promise<T> {
    let abort: (() => void) | undefined;
    const aborted = new Promise<T>((resolve) => {
      abort = () => resolve(onAbort());
      if (bounds.signal.aborted) abort();
      else bounds.signal.addEventListener("abort", abort, { once: true });
    });
    const work = run().finally(() => {
      calls--;
      if (abort) bounds.signal.removeEventListener("abort", abort);
    });
    // Pending owners retain their charge until settlement; no unbounded retries.
    return Promise.race([work, aborted]);
  }
  return Object.freeze({
    async withNamedCredentialV1<T>(
      raw: NamedCredentialUseV1,
      authority: CurrentCredentialAuthorityV1,
      consume: (material: CredentialMaterialHandleV1) => Promise<T>,
      caller: CredentialStorageCallBoundsV1,
    ): Promise<CredentialUseResultV1<T>> {
      let request: NamedCredentialUseV1;
      try {
        request = parseCredentialStorageV1("namedUse", raw);
      } catch {
        return invalid;
      }
      if (request.purpose === "repository-mint")
        return { kind: "unavailable", reason: "inventory-unavailable" };
      if (!capable("model") || !deps.useOwner || !deps.custody) return unavailable;
      if (!consumers.has(consume)) return { kind: "denied", reason: "authority-denied" };
      if (calls >= limits.maxMaterialCacheEntries) return capacity;
      let bounds: CredentialStorageCallBoundsV1;
      try {
        bounds = bound(request, caller);
      } catch {
        return expired;
      }
      calls++;
      let effectEntered = false;
      let active = true;
      const unknown = (): CredentialUseResultV1<T> => ({
        kind: "effect-unknown",
        reason: "provider-outcome-unknown",
        operationRef: request.operationRef,
        nextAction: "exact-readback-only",
      });
      const modelRequest = request;
      return bounded(
        bounds,
        async () => {
          try {
            const partition = parseCredentialStorageV1("cachePartition", {
              schemaVersion: 1,
              purpose: modelRequest.purpose,
              scope: modelRequest.scope,
              profile: modelRequest.profile,
              binding: modelRequest.binding,
              modelBinding: modelRequest.modelBinding,
            });
            let projection = await resolveNamedCustodyProjectionV1(deps, partition, bounds);
            const outcome = await cache.withMaterial(
              partition,
              () => deps.custody!.readMinimumInvocation(projection, bounds),
              async (handle, assertCurrent) => {
                // Warm and cold material both repeat the actual metadata checks.
                projection = await resolveNamedCustodyProjectionV1(deps, partition, bounds);
                let callbackActive = true;
                let localResult: { value: T } | undefined;
                let effectSettlement: Promise<T> | undefined;
                try {
                  const result = await deps.useOwner!.withCurrentModelUse(
                    modelRequest,
                    authority,
                    async () => {
                      if (!active || !callbackActive || effectEntered || bounds.signal.aborted)
                        throw new CredentialCustodyErrorV1(expired);
                      assertCurrent();
                      effectEntered = true;
                      effectSettlement = consume(handle);
                      const value = await effectSettlement;
                      localResult = { value };
                      return value;
                    },
                    bounds,
                  );
                  if (result.kind === "used") {
                    if (
                      !effectEntered ||
                      !localResult ||
                      result.operationRef !== modelRequest.operationRef ||
                      result.audit.eventRef !== modelRequest.originalAuditRef
                    )
                      throw new CredentialCustodyErrorV1();
                    const diagnostic = parseCredentialStorageV1("useResult", {
                      kind: result.kind,
                      operationRef: result.operationRef,
                      audit: result.audit,
                    });
                    if (diagnostic.kind !== "used") throw new CredentialCustodyErrorV1();
                    return { ...diagnostic, value: localResult.value };
                  }
                  if (result.kind === "effect-unknown") return unknown();
                  const diagnostic = parseCredentialStorageV1("useResult", result);
                  if (effectEntered) return unknown();
                  if (diagnostic.kind === "used" || diagnostic.kind === "effect-unknown")
                    return unknown();
                  return diagnostic;
                } finally {
                  callbackActive = false;
                  // A broken owner that returns before its callback settles must
                  // not shorten protected material lifetime or free its charge.
                  if (effectSettlement) await effectSettlement.catch(() => undefined);
                }
              },
              bounds,
            );
            if (!active || bounds.signal.aborted) return effectEntered ? unknown() : expired;
            return outcome;
          } catch (error) {
            if (effectEntered) return unknown();
            return custodyFailureFromErrorV1(error);
          } finally {
            active = false;
          }
        },
        () => {
          active = false;
          return effectEntered ? unknown() : expired;
        },
      );
    },
    async rotateBindingV1(
      raw: RotateCredentialBindingV1,
      authority: CredentialManagementHandleV1,
      caller: CredentialStorageCallBoundsV1,
    ): Promise<BindingMutationResultV1> {
      let request: RotateCredentialBindingV1;
      try {
        request = parseCredentialStorageV1("rotate", raw);
      } catch {
        return invalid;
      }
      if (!capable("rotation") || !deps.rotationOwner || !deps.custody) return unavailable;
      if (calls >= limits.maxMaterialCacheEntries) return capacity;
      let bounds: CredentialStorageCallBoundsV1;
      try {
        bounds = bound(request, caller);
      } catch {
        return expired;
      }
      calls++;
      let commitEntered = false;
      const unknown = (): BindingMutationResultV1 => ({
        kind: "commit-unknown",
        operationRef: request.operationRef,
        intentDigest:
          "sha256:" +
          createHash("sha256")
            .update(canonicalCredentialStorageRequestV1("rotate", request))
            .digest("hex"),
        nextAction: "exact-readback-only",
      });
      return bounded(
        bounds,
        async () => {
          try {
            if (!(await deps.rotationOwner!.checkManagement(request, authority, bounds)))
              return { kind: "denied", reason: "authority-denied" };
            if (bounds.signal.aborted) return expired;
            if (!(await deps.custody!.confirmStagedVersion(request, bounds))) return unavailable;
            if (bounds.signal.aborted) return expired;
            // Fence locally before CAS, including an unknown commit or other replica.
            cache.invalidate(request.expectedBinding);
            commitEntered = true;
            const result = parseCredentialStorageV1(
              "rotationResult",
              await deps.rotationOwner!.commitStagedRotation(request, authority, bounds),
            );
            cache.invalidate(request.expectedBinding);
            if (
              result.kind === "rotated" &&
              (!custodyEqualV1(result.binding, request.replacement) ||
                result.invalidationVersion !== request.expectedInvalidationVersion + 1 ||
                result.receipt.operationRef !== request.operationRef ||
                result.audit.eventRef !== request.originalAuditRef ||
                result.audit.commitRef !== result.receipt.commitRef ||
                result.receipt.intentDigest !==
                  "sha256:" +
                    createHash("sha256")
                      .update(canonicalCredentialStorageRequestV1("rotate", request))
                      .digest("hex"))
            )
              return unknown();
            if (result.kind === "commit-unknown") return unknown();
            return result;
          } catch {
            return commitEntered ? unknown() : unavailable;
          }
        },
        () => {
          cache.invalidate(request.expectedBinding);
          return commitEntered ? unknown() : expired;
        },
      );
    },
    close(): void {
      closed = true;
      cache.close();
    },
    invalidate: cache.invalidate,
    inspect: () => Object.freeze({ ...cache.inspect(), calls }),
  });
}
