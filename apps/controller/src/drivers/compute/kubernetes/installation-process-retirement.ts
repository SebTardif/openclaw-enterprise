import type { AppsV1Api, CoreV1Api } from "@kubernetes/client-node";
import type {
  GatewayProcessCallV1,
  GatewayProcessDispositionResultV1,
  GatewayProcessObjectV1,
  GatewayProcessRetirementInputV1,
  GatewayProcessRetirementResultV1,
  GatewayStartupOperationLocatorV1,
  GatewayStartupRecordRefV1,
} from "@openclaw-enterprise/contracts/gateway-startup-v1";
import { isDeepStrictEqual } from "node:util";
import { installationObjectIdentity } from "./installation-process-observations.ts";

/** Accepting fences are synchronous. Observing an accidental asynchronous
 * rejection prevents an unhandled failure; it never grants the guarded effect. */
export function requireInstallationFence(result: unknown): void {
  if (result === undefined) return;
  void Promise.resolve(result).catch(() => undefined);
  throw new Error("Installation process fence is unavailable.");
}

export interface InstallationCleanupResponsibility {
  readonly original: GatewayProcessObjectV1;
  readonly responsibility: GatewayStartupRecordRefV1;
  readonly policy: {
    readonly gracePeriodSeconds: number;
    readonly propagationPolicy: "Foreground";
  };
  /** The original cleanup owner rechecks its separate, current claim. */
  recheckCurrent(): Promise<void>;
  assertCurrent(): undefined;
  /** Must retain possible deletion independently of the requesting call's lifetime. */
  retainRequest(outcome: "acknowledged" | "unknown"): Promise<void>;
}

/** A selected protected reader authenticates a live original physical receipt;
 * this adapter does not implement a node/runtime observer or an authority issuer. */
export interface InstallationSettlementReader {
  readCurrent(
    locator: GatewayStartupOperationLocatorV1,
    call: GatewayProcessCallV1,
  ): Promise<
    | {
        readonly operation: GatewayStartupOperationLocatorV1;
        readonly disposition: "complete-initial" | "retired";
        readonly receipt: GatewayStartupRecordRefV1;
        /** Exact process tree, every applicable ancestry, and the original submission
         * fence's complete late-create closure belong to the authenticated source. */
        assertCurrent(): undefined;
        recheckCurrent(): Promise<void>;
      }
    | undefined
  >;
}

export interface InstallationRetirementIo {
  clients(): Promise<{
    readonly core: Pick<CoreV1Api, "readNamespace">;
    readonly apps: Pick<AppsV1Api, "readNamespacedDeployment" | "deleteNamespacedDeployment">;
  }>;
  request<T>(operation: () => Promise<T>, options?: { readonly mutating?: boolean }): Promise<T>;
  current(): Promise<void>;
  assertCurrent(): undefined;
  retain(work: Promise<unknown>): void;
}

/** Exact conditional API retirement. Even a successful response reports unknown
 * physical termination; neither 404 nor an acknowledged delete releases ownership. */
export async function retireInstallationProcess(
  io: InstallationRetirementIo,
  input: GatewayProcessRetirementInputV1,
  cleanup: InstallationCleanupResponsibility,
): Promise<GatewayProcessRetirementResultV1> {
  const operation = input.original.binding.startup;
  let submitted = false;
  try {
    if (
      !isDeepStrictEqual(cleanup.original, input.original) ||
      !isDeepStrictEqual(cleanup.responsibility, input.responsibility) ||
      cleanup.policy.propagationPolicy !== "Foreground" ||
      !Number.isSafeInteger(cleanup.policy.gracePeriodSeconds) ||
      cleanup.policy.gracePeriodSeconds < 0
    ) {
      return { kind: "unavailable" };
    }
    await io.current();
    await cleanup.recheckCurrent();
    const clients = await io.clients();
    await io.current();
    await cleanup.recheckCurrent();
    const assertCurrent = () => {
      requireInstallationFence(io.assertCurrent());
      requireInstallationFence(cleanup.assertCurrent());
      requireInstallationFence(io.assertCurrent());
    };
    const namespace = await io.request(() => {
      assertCurrent();
      return clients.core.readNamespace({ name: input.original.target.namespace.name });
    });
    await io.current();
    await cleanup.recheckCurrent();
    const ns = installationObjectIdentity(namespace.metadata);
    if (
      namespace.kind !== "Namespace" ||
      namespace.apiVersion !== "v1" ||
      ns.name !== input.original.target.namespace.name ||
      ns.uid !== input.original.target.namespace.uid
    ) {
      return { kind: "unavailable" };
    }
    const deployment = await io.request(() => {
      assertCurrent();
      return clients.apps.readNamespacedDeployment({
        name: input.original.deployment.name,
        namespace: ns.name,
      });
    });
    await io.current();
    await cleanup.recheckCurrent();
    const identity = installationObjectIdentity(deployment.metadata);
    if (
      deployment.kind !== "Deployment" ||
      deployment.apiVersion !== "apps/v1" ||
      deployment.metadata?.namespace !== ns.name ||
      identity.name !== input.original.deployment.name ||
      identity.uid !== input.original.deployment.uid ||
      deployment.metadata?.generation !== input.original.controllerGeneration
    ) {
      return { kind: "unavailable" };
    }
    // Retain before dispatch. This continuation is independent of call cancellation.
    const pending = Promise.resolve().then(async () => {
      try {
        await io.request(
          () => {
            assertCurrent();
            submitted = true;
            return clients.apps.deleteNamespacedDeployment({
              name: identity.name,
              namespace: ns.name,
              body: {
                preconditions: { uid: identity.uid, resourceVersion: identity.resourceVersion },
                gracePeriodSeconds: cleanup.policy.gracePeriodSeconds,
                propagationPolicy: cleanup.policy.propagationPolicy,
              },
            });
          },
          { mutating: true },
        );
        await cleanup.retainRequest("acknowledged");
      } catch (error) {
        if (submitted) await cleanup.retainRequest("unknown");
        throw error;
      }
    });
    io.retain(pending);
    await pending;
    await io.current();
    await cleanup.recheckCurrent();
    return {
      kind: "requested",
      original: input.original,
      responsibility: input.responsibility,
      termination: "unknown",
    };
  } catch {
    return submitted ? { kind: "unknown", operation } : { kind: "unavailable" };
  }
}

export async function readInstallationDisposition(
  reader: InstallationSettlementReader,
  locator: GatewayStartupOperationLocatorV1,
  call: GatewayProcessCallV1,
  current: () => Promise<void>,
): Promise<GatewayProcessDispositionResultV1> {
  try {
    await current();
    const result = await reader.readCurrent(locator, call);
    if (
      result === undefined ||
      !isDeepStrictEqual(result.operation, locator) ||
      (result.disposition !== "complete-initial" && result.disposition !== "retired") ||
      typeof result.receipt.recordRef !== "string" ||
      result.receipt.recordRef.length === 0 ||
      !Number.isSafeInteger(result.receipt.recordVersion) ||
      result.receipt.recordVersion < 1
    ) {
      return { kind: "unavailable" };
    }
    await result.recheckCurrent();
    await current();
    requireInstallationFence(result.assertCurrent());
    return {
      kind: "verified-disposition",
      operation: locator,
      disposition: result.disposition,
      receipt: result.receipt,
    };
  } catch {
    return { kind: "unavailable" };
  }
}
