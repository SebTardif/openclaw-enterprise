import type {
  GatewayMaterialBundleLeaseV1,
  GatewayMaterialEncodedPayloadV1,
  GatewayMaterialReadScopeV1,
  GatewayMaterialSelectedSourceV1,
} from "@openclaw-enterprise/occ/gateway-startup-v1/material-delivery";
import {
  GatewayChannelMaterialUnavailableV1,
  GATEWAY_CHANNEL_MATERIAL_LIMITS_V1,
  encodeGatewayChannelMaterialIntoV1,
  gatewayChannelMaterialEncodedLengthV1,
} from "@openclaw-enterprise/utils/gateway-channel-material";
import {
  createGatewayPhysicalMaterialSourceV1,
  type GatewayPhysicalMaterialBindingV1,
} from "./gateway-material-source.ts";
import type {
  GatewayKubernetesMaterialResultV1,
  GatewayKubernetesMaterialSelectionV1,
} from "./kubernetes-gateway-material.ts";

export type GatewayMaterialDeliveryReaderV1 = Readonly<{
  read(
    selection: GatewayKubernetesMaterialSelectionV1,
    signal: AbortSignal,
  ): Promise<GatewayKubernetesMaterialResultV1>;
}>;

function unavailable(): never {
  throw new GatewayChannelMaterialUnavailableV1();
}

function sync(check: () => unknown): undefined {
  const result = check();
  if (result instanceof Promise) void result.catch(() => undefined);
  if (result !== undefined) unavailable();
  return undefined;
}

function remaining(read: () => unknown): number {
  const result = read();
  if (result instanceof Promise) void result.catch(() => undefined);
  if (typeof result !== "number" || !Number.isFinite(result) || result <= 0) unavailable();
  return result;
}

/**
 * Fixed trusted Controller composition, inside the SAME original withCurrent
 * callback. The actual owner supplies the selected binding, consumed/current
 * association, initial-attempt acceptance, policy and audit/COMMIT obligations.
 * JSON equality below checks retained data correspondence, never authority.
 *
 * One outstanding source/borrow/cleanup, zero queue. Local scope membership
 * prevents duplicate local use only; it is not durable or cross-process replay
 * protection. The original accepting owner must reject a repeated/unknown
 * initial Slack attempt even through a fresh scope or requestRef. A distinct
 * later Teams invocation needs its qualified supplier and original authority;
 * this implementation returns unavailable for that use without reading.
 *
 * One physical backing plus one native-owned frame at the Controller TS
 * endpoint, at most 64KiB. The complete four-endpoint transport has separate
 * accounting (at most eight allocations/256KiB); this adapter does not create,
 * account for, erase or prove release of foreign Go/OS/TLS copies.
 */
export function createGatewayMaterialDeliverySourceV1(
  reader: GatewayMaterialDeliveryReaderV1,
): GatewayMaterialSelectedSourceV1<GatewayPhysicalMaterialBindingV1> &
  Readonly<{ close(): Promise<"finished" | "unknown"> }> {
  const read = reader.read.bind(reader);
  const usedScopes = new WeakSet<object>();
  type PhysicalSource = ReturnType<typeof createGatewayPhysicalMaterialSourceV1>;
  let active: { source: PhysicalSource; release: () => Promise<void> } | undefined;
  let closed = false;
  let occupied = false;
  let closeTask: Promise<"finished" | "unknown"> | undefined;

  async function readSelected(
    scope: GatewayMaterialReadScopeV1<GatewayPhysicalMaterialBindingV1>,
    use: "startup-slack-pair" | "teams-invocation-token",
  ): Promise<GatewayMaterialBundleLeaseV1> {
    if (
      closed ||
      occupied ||
      active !== undefined ||
      use !== "startup-slack-pair" ||
      !scope ||
      typeof scope !== "object" ||
      usedScopes.has(scope)
    )
      unavailable();
    usedScopes.add(scope);
    occupied = true;
    let source: PhysicalSource;
    try {
      if (
        !(scope.signal instanceof AbortSignal) ||
        typeof scope.assertCurrent !== "function" ||
        typeof scope.remainingMs !== "function"
      )
        unavailable();
      const signal = scope.signal;
      const selected = scope.selected;
      const selectedBytes = JSON.stringify(selected);
      const assert = scope.assertCurrent.bind(scope);
      const readRemaining = scope.remainingMs.bind(scope);
      let expectedBinding = "";
      function current(binding: GatewayPhysicalMaterialBindingV1): undefined {
        sync(assert);
        if (
          closed ||
          signal.aborted ||
          scope.signal !== signal ||
          scope.selected !== selected ||
          JSON.stringify(scope.selected) !== selectedBytes ||
          JSON.stringify(binding) !== expectedBinding
        )
          unavailable();
        sync(assert);
        return undefined;
      }
      source = createGatewayPhysicalMaterialSourceV1(
        {
          signal,
          assertConsumedCurrent: current,
          // Both readers inherit the SAME already-minimized owner remainder.
          // Neither is a provider-expiry assertion or a fresh token lifetime.
          remainingStartupMs: () => remaining(readRemaining),
          remainingSourceMs: () => remaining(readRemaining),
        },
        selected,
        { read },
      );
      expectedBinding = JSON.stringify(source.binding);
    } catch {
      occupied = false;
      return unavailable();
    }

    let releaseTask: Promise<void> | undefined;
    const entry = {
      source,
      release(): Promise<void> {
        if (releaseTask !== undefined) return releaseTask;
        // Publish the unique task before any owner callback can reenter.
        let finish!: () => void;
        let fail!: (error: unknown) => void;
        releaseTask = new Promise<void>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
        void releaseTask.catch(() => undefined);
        void (async () => {
          try {
            if ((await source.close()) !== "finished") unavailable();
            if (active === entry) {
              active = undefined;
              occupied = false;
            }
            finish();
          } catch {
            // Retain entry/source on unknown cleanup. No successor read may
            // reuse the occupied slot or replace its still-owned material.
            fail(new GatewayChannelMaterialUnavailableV1());
          }
        })();
        return releaseTask;
      },
    };
    active = entry;
    let physical: Awaited<ReturnType<PhysicalSource["acquire"]>>;
    try {
      physical = await source.acquire();
    } catch {
      // A deadline may refuse acquisition before the read settles; release
      // still joins that original late read. No detached cleanup is forgotten.
      await entry.release();
      return unavailable();
    }
    let borrowed = false;
    const lease: GatewayMaterialBundleLeaseV1 = Object.freeze({
      signal: physical.signal,
      assertCurrent: physical.assertCurrent,
      remainingMs: physical.remainingMs,
      async withEncodedPayload(
        work: (payload: GatewayMaterialEncodedPayloadV1) => Promise<void>,
      ): Promise<void> {
        if (borrowed || releaseTask !== undefined || typeof work !== "function") unavailable();
        borrowed = true;
        let knownPreflightFailure = false;
        try {
          await physical.withMaterial(async (values) => {
            let byteLength: number;
            try {
              physical.assertCurrent();
              byteLength = gatewayChannelMaterialEncodedLengthV1({
                use: "startup-slack-pair",
                botToken: values.botToken,
                appToken: values.appToken,
              });
              physical.assertCurrent();
            } catch {
              // No consumer or encoder has escaped. This exact preflight
              // failure is known no-use; join the borrow, then report refusal.
              knownPreflightFailure = true;
              return undefined;
            }
            let open = true;
            let encoded = false;
            let failed = false;
            const payload: GatewayMaterialEncodedPayloadV1 = Object.freeze({
              byteLength,
              backingByteLength: byteLength - GATEWAY_CHANNEL_MATERIAL_LIMITS_V1.headerBytes,
              encodeInto(target: Uint8Array): undefined {
                try {
                  if (!open || encoded || failed) unavailable();
                  physical.assertCurrent();
                  encodeGatewayChannelMaterialIntoV1(
                    { use: "startup-slack-pair", ...values },
                    target,
                  );
                  encoded = true;
                  physical.assertCurrent();
                  return undefined;
                } catch {
                  failed = true;
                  return unavailable();
                }
              },
            });
            try {
              const pending = work(payload);
              if (!(pending instanceof Promise)) unavailable();
              const result = await pending;
              if (result !== undefined || !encoded || failed) unavailable();
              return undefined;
            } catch {
              // Throw/reject/non-undefined or swallowed encoder failure is
              // unknown consumer settlement. Do not fulfill the physical borrow.
              return unavailable();
            } finally {
              // A retained callback cannot encode after its original borrow.
              open = false;
            }
          });
          if (knownPreflightFailure) unavailable();
        } catch {
          return unavailable();
        }
      },
      release: entry.release,
    });
    return lease;
  }

  function close(): Promise<"finished" | "unknown"> {
    if (closeTask !== undefined) return closeTask;
    closed = true;
    const entry = active;
    closeTask =
      entry === undefined
        ? Promise.resolve("finished")
        : entry.release().then(
            () => "finished" as const,
            () => "unknown" as const,
          );
    return closeTask;
  }
  return Object.freeze({ readSelected, close });
}
