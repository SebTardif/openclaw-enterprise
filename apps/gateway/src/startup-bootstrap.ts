import type {
  GatewayStartupCloseV1,
  GatewayStartupEnrollmentV1,
} from "@openclaw-enterprise/contracts/gateway-startup-v1";
import {
  createGatewayStartupLocalOwnerV1,
  type GatewayStartupFixedAdapterV1,
  type GatewayStartupLocalGrantV1,
} from "./startup-lifetime.ts";
import type {
  GatewayStartupServiceHandleV1,
  GatewayStartupServiceSourceV1,
} from "./startup-service-source.ts";

type Cleanup = GatewayStartupCloseV1["cleanup"];
type Material = Pick<GatewayStartupLocalGrantV1, "borrowMaterial">;
type State = { readonly handle: GatewayStartupServiceHandleV1; enrolled: boolean };

/**
 * Fixed trusted construction only. The material supplier is the original local
 * recipient's protected producer; these three startup commands carry no material.
 * The public application reader remains unavailable until actual producers are wired.
 */
export function createGatewayStartupBootstrapV1(
  service: GatewayStartupServiceSourceV1,
  material: Material | undefined,
  adapter: GatewayStartupFixedAdapterV1,
) {
  const open = service.open.bind(service);
  const consume = service.consume.bind(service);
  const binding = service.binding.bind(service);
  const signal = service.signal.bind(service);
  const assert = service.assertCurrent.bind(service);
  const recheck = service.recheckCurrent.bind(service);
  const readClaim = service.readClaim.bind(service);
  const release = service.close.bind(service);
  const borrow = material?.borrowMaterial.bind(material);
  const originals = new WeakMap<object, State>();
  const pending = new Set<Promise<unknown>>();
  let attempted = false;
  let stopped = false;
  let attempt: Promise<GatewayStartupEnrollmentV1 | undefined> | undefined;
  let closing: Promise<Cleanup> | undefined;

  const local = createGatewayStartupLocalOwnerV1(
    {
      async enroll(original: object): Promise<GatewayStartupLocalGrantV1 | undefined> {
        const state = originals.get(original);
        if (!state || state.enrolled || stopped || !borrow) return undefined;
        // Consume this same-instance local handoff before yielding, independently of
        // the single already-confirmed durable Runtime claim.
        state.enrolled = true;
        const handle = state.handle;
        try {
          assert(handle);
          const grant: GatewayStartupLocalGrantV1 = Object.freeze({
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
            async borrowMaterial() {
              assert(handle);
              if ((await readClaim(handle)) !== "current")
                throw new Error("Gateway bootstrap unavailable");
              assert(handle);
              // Runtime registers the returned lease before its next fence. If
              // this settles after revocation, its original owner joins cleanup.
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
    enroll(): Promise<GatewayStartupEnrollmentV1 | undefined> {
      if (attempted || stopped || !borrow) return Promise.resolve(undefined);
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
