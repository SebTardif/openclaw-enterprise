import type { GatewayMaterialRuntimeOwnerV1 } from "./startup-material.ts";
import type { GatewayStartupCloseV1 } from "@openclaw-enterprise/contracts/gateway-startup-v1";
import {
  createGatewayStartupLocalOwnerV2,
  type GatewayStartupLocalGrantV2,
} from "./startup-agent-lifetime.ts";
import type {
  GatewayStartupServiceHandleV2,
  GatewayStartupServiceSourceV2,
} from "./startup-agent-service-source.ts";

import type { GatewayStartupEnrollmentV2 } from "@openclaw-enterprise/contracts/gateway-startup-local-v2";
import type { GatewayStartupFixedAdapterV1 } from "./startup-lifetime.ts";

type Cleanup = GatewayStartupCloseV1["cleanup"];
type Material = Pick<GatewayStartupLocalGrantV2, "borrowMaterial">;
/** Fixed original assembler; no caller-selected Source, registration or material refs. */
export interface GatewayStartupConfirmedMaterialFactoryV2 {
  bind(
    source: GatewayStartupServiceSourceV2,
    parent: GatewayStartupServiceHandleV2,
    runtime: GatewayMaterialRuntimeOwnerV1,
  ): Promise<Material & Readonly<{ close(): Promise<Cleanup> }>>;
}
type State = { readonly handle: GatewayStartupServiceHandleV2; enrolled: boolean };

/**
 * Fixed trusted construction only. The material supplier is the original local
 * recipient's protected producer; these three startup commands carry no material.
 * The public application reader remains unavailable until actual producers are wired.
 */
export function createGatewayStartupBootstrapV2(
  service: GatewayStartupServiceSourceV2,
  confirmedMaterial: GatewayStartupConfirmedMaterialFactoryV2,
  adapter: GatewayStartupFixedAdapterV1,
) {
  const open = service.open.bind(service);
  const consume = service.consume.bind(service);
  const binding = service.binding.bind(service);
  const signal = service.signal.bind(service);
  const assert = service.assertCurrent.bind(service);
  const recheck = service.recheckCurrent.bind(service);
  const readClaim = service.readClaim.bind(service);
  const remainingSourceMs = service.remainingSourceMs.bind(service);
  const releaseSource = service.close.bind(service);
  const bindMaterial = confirmedMaterial.bind.bind(confirmedMaterial);
  let borrow: Material["borrowMaterial"] | undefined;
  let materialAcquisition: Promise<void> | undefined;
  let materialReturned = false;
  let releaseMaterial: (() => Promise<Cleanup>) | undefined;
  let releasedMaterial: Promise<Cleanup> | undefined;
  let released: Promise<Cleanup> | undefined;
  const release = (): Promise<Cleanup> => {
    if (!released) {
      const sourceClose = releaseSource();
      released = (async () => {
        await materialAcquisition?.catch(() => undefined);
        if (releaseMaterial)
          releasedMaterial ??= Promise.resolve()
            .then(releaseMaterial)
            .then(
              (value) => (value === "finished" || value === "failed" ? value : "unknown"),
              () => "unknown",
            );
        const sourceResult = await sourceClose;
        const materialResult =
          (await releasedMaterial) ?? (materialReturned ? "unknown" : "finished");
        if (sourceResult === "unknown" || materialResult === "unknown") return "unknown";
        return sourceResult === "failed" || materialResult === "failed" ? "failed" : "finished";
      })();
    }
    return released;
  };
  const originals = new WeakMap<object, State>();
  const pending = new Set<Promise<unknown>>();
  let attempted = false;
  let stopped = false;
  let attempt: Promise<GatewayStartupEnrollmentV2 | undefined> | undefined;
  let closing: Promise<Cleanup> | undefined;

  const local = createGatewayStartupLocalOwnerV2(
    {
      async enroll(original: object): Promise<GatewayStartupLocalGrantV2 | undefined> {
        const state = originals.get(original);
        if (!state || state.enrolled || stopped) return undefined;
        // Consume this same-instance local handoff before yielding, independently of
        // the single already-confirmed durable Runtime claim.
        state.enrolled = true;
        const handle = state.handle;
        try {
          assert(handle);
          const grant: GatewayStartupLocalGrantV2 = Object.freeze({
            binding: binding(handle),
            signal: signal(handle),
            async recheckCurrent() {
              await recheck(handle);
              if ((await readClaim(handle)) !== "current") {
                void release();
                throw new Error("Gateway bootstrap unavailable");
              }
              assert(handle);
            },
            assertCurrent: () => assert(handle),
            readClaim: () => readClaim(handle),
            remainingSourceMs: () => remainingSourceMs(handle),
            bindMaterial(runtime: GatewayMaterialRuntimeOwnerV1) {
              if (materialAcquisition)
                return Promise.reject(new Error("Gateway bootstrap unavailable"));
              // Local State already owns this exact consumer parent. Binding is
              // still after the sole confirmed consume and before enrollment.
              materialAcquisition = Promise.resolve().then(async () => {
                assert(handle);
                const bound = await bindMaterial(service, handle, runtime);
                materialReturned = true;
                releaseMaterial = bound.close.bind(bound);
                const originalBorrow = bound.borrowMaterial.bind(bound);
                assert(handle);
                if (stopped) throw new Error("Gateway bootstrap unavailable");
                borrow = originalBorrow;
              });
              return materialAcquisition;
            },
            async borrowMaterial() {
              assert(handle);
              if ((await readClaim(handle)) !== "current")
                throw new Error("Gateway bootstrap unavailable");
              assert(handle);
              // Runtime registers the returned lease before its next fence. If
              // this settles after revocation, its original owner joins cleanup.
              if (!borrow) throw new Error("Gateway bootstrap unavailable");
              return await borrow();
            },
            close: release,
          });
          return grant;
        } catch {
          await release();
          return undefined;
        }
      },
    },
    adapter,
  );

  return Object.freeze({
    enroll(): Promise<GatewayStartupEnrollmentV2 | undefined> {
      if (attempted || stopped) return Promise.resolve(undefined);
      attempted = true;
      attempt = Promise.resolve().then(async () => {
        try {
          if (stopped) return undefined;
          const handle = await open();
          if (!handle || stopped) {
            await release();
            return undefined;
          }
          assert(handle);
          const result = await consume(handle);
          // Unknown COMMIT and all nonconfirmed outcomes grant neither local
          // enrollment nor a second consume, even if later readback finds a record.
          if (result.kind !== "confirmed" || stopped) {
            await release();
            return undefined;
          }
          assert(handle);
          const original = Object.freeze({});
          originals.set(original, { handle, enrolled: false });
          const enrollment = await local.enroll(original);
          if (!enrollment || stopped) {
            await release();
            return undefined;
          }
          assert(handle);
          return enrollment;
        } catch {
          await release();
          return undefined;
        }
      });
      pending.add(attempt);
      void attempt.then(
        () => pending.delete(attempt!),
        () => pending.delete(attempt!),
      );
      return attempt;
    },
    close(): Promise<Cleanup> {
      stopped = true;
      if (!closing) {
        // Initiate Source shutdown before joining an in-flight local enrollment.
        const sourceClose = release();
        closing = (async () => {
          while (pending.size) await Promise.allSettled([...pending]);
          return await sourceClose;
        })();
        void closing.catch(() => undefined);
      }
      return closing;
    },
  });
}
