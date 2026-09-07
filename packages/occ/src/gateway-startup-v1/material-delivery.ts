import { performance } from "node:perf_hooks";
import { Buffer } from "node:buffer";
import type {
  GatewayMaterialDeliveryRequestV1,
  GatewayMaterialDeliveryHeaderV1,
  GatewayMaterialDeliveryOutcomeV1,
  GatewayMaterialDisclosurePermitV1,
} from "@openclaw-enterprise/contracts/gateway-material-delivery-v1";
import {
  canonicalGatewayStartupValueV1,
  parseGatewayStartupBindingV1,
  parseGatewayStartupCommandV1,
  parseGatewayStartupEventV1,
  type GatewayStartupCommandBoundsV1,
  type GatewayStartupCurrentV1,
} from "./owner.ts";
import type { GatewayInstallationServiceAssociationV1 } from "./installation-service.ts";

export interface GatewayMaterialNativeLeaseV1 {
  readonly profile: "installation-channel-material-v1";
  readonly transport: "owned-child-stdio-installation-channel-material-v1";
  readonly association: GatewayInstallationServiceAssociationV1;
  readonly signal: AbortSignal;
  assertCurrent(): undefined;
  remainingMs(): number;
  /** The fixed native writer must synchronously consume the exact permit before any bytes. */
  disclose(
    header: GatewayMaterialDeliveryHeaderV1,
    payload: GatewayMaterialEncodedPayloadV1,
    permit: GatewayMaterialDisclosurePermitV1,
  ): Promise<void>;
  close(): Promise<void>;
}
export interface GatewayMaterialNativeSourceV1 {
  inspect(
    proof: object,
    request: GatewayMaterialDeliveryRequestV1,
    bounds: GatewayStartupCommandBoundsV1,
  ): Promise<GatewayMaterialNativeLeaseV1 | undefined>;
}
export interface GatewayMaterialReadScopeV1<TSelected> {
  /** Original protected current owner supplies this record and holds its applicable locks/leases. */
  readonly current: GatewayStartupCurrentV1;
  readonly selected: TSelected;
  readonly signal: AbortSignal;
  assertCurrent(): undefined;
  recheckCurrent(): Promise<void>;
  remainingMs(): number;
  /** Completes required original metadata-only audit/transaction disposition before disclosure. */
  confirmDisclosure(): Promise<void>;
}
export interface GatewayMaterialDeliveryCurrentOwnerV1<TSelected> {
  /**
   * Fixed trusted composition. Before entering work, the original accepting owner must
   * admit the exact initial Slack attempt or distinct qualified Teams invocation;
   * an unknown/replayed original attempt cannot be repaired with a new requestRef.
   * This port supplies no durable producer or cross-process replay protection itself.
   * Its signal/current lease inherits original call, startup and Source invalidation.
   */
  withCurrent(
    request: GatewayMaterialDeliveryRequestV1,
    native: GatewayMaterialNativeLeaseV1,
    bounds: GatewayStartupCommandBoundsV1,
    work: (
      scope: GatewayMaterialReadScopeV1<TSelected>,
    ) => Promise<GatewayMaterialDeliveryOutcomeV1>,
  ): Promise<GatewayMaterialDeliveryOutcomeV1>;
}
export interface GatewayMaterialEncodedPayloadV1 {
  /** Exact encoded size including the original closed CRD codec overhead. */
  readonly byteLength: number;
  /** Actual live source backing allocation, not just the length of selected views. */
  readonly backingByteLength: number;
  /** Original CRD encoder borrows this exact native-owned target; no payload allocator. */
  encodeInto(target: Uint8Array): undefined;
}
export interface GatewayMaterialBundleLeaseV1 {
  readonly signal: AbortSignal;
  assertCurrent(): undefined;
  remainingMs(): number;
  /** Only fulfilled undefined after real encoded use settles permits known source cleanup. */
  withEncodedPayload(
    work: (payload: GatewayMaterialEncodedPayloadV1) => Promise<void>,
  ): Promise<void>;
  release(): Promise<void>;
}
export interface GatewayMaterialSelectedSourceV1<TSelected> {
  /** The SAME original held scope supplies current authority, selection and remaining lifetime. */
  readSelected(
    scope: GatewayMaterialReadScopeV1<TSelected>,
    use: GatewayMaterialDeliveryRequestV1["use"],
  ): Promise<GatewayMaterialBundleLeaseV1>;
}
const canonical = canonicalGatewayStartupValueV1;
const resizableBuffer = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const unavailable = () => new Error("Gateway material delivery unavailable");
const outcome = (
  kind: GatewayMaterialDeliveryOutcomeV1["kind"],
): GatewayMaterialDeliveryOutcomeV1 => Object.freeze({ kind });
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw unavailable();
}
function ref(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw unavailable();
}
function version(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw unavailable();
}
function record(value: unknown): void {
  exact(value, ["recordRef", "recordVersion"]);
  ref(value.recordRef);
  version(value.recordVersion);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const field of Object.values(value)) freeze(field);
    Object.freeze(value);
  }
  return value;
}
function equal(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** Reuses original locator/record grammar. This metadata parser issues no current authority. */
export function parseGatewayMaterialDeliveryRequestV1(
  value: unknown,
): GatewayMaterialDeliveryRequestV1 {
  const text = canonical(value);
  if (Buffer.byteLength(text, "utf8") > 2048) throw unavailable();
  const request: unknown = JSON.parse(text);
  exact(request, [
    "schemaVersion",
    "purpose",
    "use",
    "startup",
    "selection",
    "consumedClaim",
    "recipient",
  ]);
  if (
    request.schemaVersion !== 1 ||
    request.purpose !== "read-selected-channel-material" ||
    (request.use !== "startup-slack-pair" && request.use !== "teams-invocation-token")
  )
    throw unavailable();
  record(request.selection);
  record(request.recipient);
  exact(request.consumedClaim, ["operationRef", "operationDigest", "afterRecordVersion"]);
  ref(request.consumedClaim.operationRef);
  version(request.consumedClaim.afterRecordVersion);
  if (
    typeof request.consumedClaim.operationDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(request.consumedClaim.operationDigest)
  )
    throw unavailable();
  // A validation-only projection; it is never enrolled or submitted as a startup command.
  parseGatewayStartupCommandV1({
    schemaVersion: 1,
    kind: "read-operation",
    operation: {
      installationId: (request.startup as { installationId?: unknown })?.installationId,
      operationRef: request.consumedClaim.operationRef,
      operationDigest: request.consumedClaim.operationDigest,
      startup: request.startup,
    },
  });
  return freeze(request) as unknown as GatewayMaterialDeliveryRequestV1;
}

function association(
  value: unknown,
  request: GatewayMaterialDeliveryRequestV1,
): GatewayInstallationServiceAssociationV1 {
  const copy: unknown = JSON.parse(canonical(value));
  exact(copy, [
    "startup",
    "createEffectRef",
    "recipient",
    "registration",
    "sourceConfiguration",
    "endpoints",
  ]);
  ref(copy.createEffectRef);
  record(copy.registration);
  record(copy.sourceConfiguration);
  parseGatewayStartupCommandV1({
    schemaVersion: 1,
    kind: "read-current",
    startup: copy.startup,
    expectedRecordVersion: request.consumedClaim.afterRecordVersion,
    recipient: copy.recipient,
  });
  exact(copy.endpoints, ["gateway", "controller", "transportRecipientRef"]);
  ref(copy.endpoints.transportRecipientRef);
  for (const endpoint of [copy.endpoints.gateway, copy.endpoints.controller]) {
    exact(endpoint, ["serviceRef", "spiffeId"]);
    ref(endpoint.serviceRef);
    ref(endpoint.spiffeId);
  }
  if (
    !equal(copy.startup, request.startup) ||
    !equal((copy.recipient as { recipient: unknown }).recipient, request.recipient)
  )
    throw unavailable();
  return freeze(copy) as unknown as GatewayInstallationServiceAssociationV1;
}
function correlate(
  currentValue: GatewayStartupCurrentV1,
  request: GatewayMaterialDeliveryRequestV1,
  native: GatewayInstallationServiceAssociationV1,
): void {
  const current: unknown = JSON.parse(canonical(currentValue));
  exact(current, ["head", "acceptance", "submission", "claim"]);
  exact(current.head, [
    "version",
    "processGeneration",
    "latestOperationRef",
    "startup",
    "recordVersion",
    "state",
  ]);
  exact(current.acceptance, ["binding", "predecessor", "auditEventId"]);
  const binding = parseGatewayStartupBindingV1(current.acceptance.binding);
  ref(current.acceptance.auditEventId);
  exact(current.acceptance.predecessor, [
    "disposition",
    "previousStartup",
    "processOwner",
    "settlement",
  ]);
  for (const key of ["disposition", "processOwner", "settlement"])
    record(current.acceptance.predecessor[key]);
  const previous = current.acceptance.predecessor.previousStartup;
  if (previous === null) {
    if (binding.startup.processGeneration !== 1) throw unavailable();
  } else {
    // Validate the original locator vocabulary without reconstructing an absent acceptance event.
    const parsed = parseGatewayStartupCommandV1({
      schemaVersion: 1,
      kind: "read-operation",
      operation: {
        installationId: (previous as { installationId?: unknown })?.installationId,
        operationRef: (previous as { operationRef?: unknown })?.operationRef,
        operationDigest: (previous as { operationDigest?: unknown })?.operationDigest,
        startup: previous,
      },
    });
    if (
      parsed.kind !== "read-operation" ||
      !parsed.operation.startup ||
      parsed.operation.startup.installationId !== binding.startup.installationId ||
      parsed.operation.startup.processGeneration !== binding.startup.processGeneration - 1
    )
      throw unavailable();
  }
  const claim = parseGatewayStartupEventV1(current.claim);
  const submission = parseGatewayStartupEventV1(current.submission);
  if (
    current.head.state !== "consumed" ||
    claim.kind !== "consume-startup" ||
    submission.kind !== "submit-create" ||
    !equal(binding.startup, request.startup) ||
    !equal(binding.selection, request.selection) ||
    binding.createEffectRef !== native.createEffectRef ||
    !equal(current.head.startup, request.startup) ||
    current.head.processGeneration !== request.startup.processGeneration ||
    current.head.version !== claim.afterHeadVersion ||
    current.head.recordVersion !== claim.afterRecordVersion ||
    current.head.latestOperationRef !== claim.command.operationRef ||
    claim.command.operationRef !== request.consumedClaim.operationRef ||
    claim.command.operationDigest !== request.consumedClaim.operationDigest ||
    claim.afterRecordVersion !== request.consumedClaim.afterRecordVersion ||
    !equal(claim.startup, request.startup) ||
    !equal(claim.recipient, native.recipient) ||
    claim.createEffectRef !== binding.createEffectRef ||
    submission.createEffectRef !== binding.createEffectRef ||
    !equal(submission.startup, request.startup) ||
    !equal(submission.submissionInput?.binding, binding) ||
    submission.previousOperationRef !== binding.startup.operationRef ||
    claim.previousOperationRef !== submission.command.operationRef ||
    claim.beforeHeadVersion !== submission.afterHeadVersion ||
    claim.beforeRecordVersion !== submission.afterRecordVersion
  )
    throw unavailable();
}

type Disclosure = {
  native: GatewayMaterialNativeLeaseV1;
  header: GatewayMaterialDeliveryHeaderV1;
  payload: GatewayMaterialEncodedPayloadV1;
  confirm: () => Promise<void>;
  confirming: boolean;
  confirmed: boolean;
  pending: Set<Promise<void>>;
  encoded: boolean;
  check: () => void;
  poison: () => void;
  used: boolean;
  open: boolean;
};

/**
 * Internal fixed composition. Missing original participants have no accepting fallback.
 * TODO(material delivery): bind the original central current reader, native profile and CRD source.
 */
export function createGatewayMaterialDeliveryV1<TSelected>(options: {
  native?: GatewayMaterialNativeSourceV1;
  current?: GatewayMaterialDeliveryCurrentOwnerV1<TSelected>;
  source?: GatewayMaterialSelectedSourceV1<TSelected>;
}) {
  const inspect = options.native?.inspect.bind(options.native);
  const withCurrent = options.current?.withCurrent.bind(options.current);
  const readSelected = options.source?.readSelected.bind(options.source);
  const permits = new WeakMap<GatewayMaterialDisclosurePermitV1, Disclosure>();
  const proofs = new WeakSet<object>();
  let closing = false;
  let active: { abort: () => void; settled: Promise<void> } | undefined;
  let closeTask: Promise<void> | undefined;

  function lookupDisclosure(
    permit: GatewayMaterialDisclosurePermitV1,
    native: GatewayMaterialNativeLeaseV1,
    header: GatewayMaterialDeliveryHeaderV1,
    payload: GatewayMaterialEncodedPayloadV1,
  ): Disclosure {
    const entry = permits.get(permit);
    if (
      !entry ||
      !entry.open ||
      entry.used ||
      entry.native !== native ||
      entry.header !== header ||
      entry.payload !== payload
    ) {
      entry?.poison();
      throw unavailable();
    }
    try {
      entry.check();
    } catch {
      entry.poison();
      throw unavailable();
    }
    return entry;
  }
  function confirmDisclosure(
    permit: GatewayMaterialDisclosurePermitV1,
    native: GatewayMaterialNativeLeaseV1,
    header: GatewayMaterialDeliveryHeaderV1,
    payload: GatewayMaterialEncodedPayloadV1,
  ): Promise<void> {
    const entry = lookupDisclosure(permit, native, header, payload);
    if (!entry.encoded || entry.confirming || entry.confirmed) {
      entry.poison();
      throw unavailable();
    }
    entry.confirming = true;
    const task = (async () => {
      try {
        await entry.confirm();
        entry.check();
        entry.confirmed = true;
      } catch {
        entry.poison();
        throw unavailable();
      }
    })();
    entry.pending.add(task);
    void task.catch(() => {}).finally(() => entry.pending.delete(task));
    return task;
  }
  function consumeDisclosure(
    permit: GatewayMaterialDisclosurePermitV1,
    native: GatewayMaterialNativeLeaseV1,
    header: GatewayMaterialDeliveryHeaderV1,
    payload: GatewayMaterialEncodedPayloadV1,
  ): undefined {
    const entry = lookupDisclosure(permit, native, header, payload);
    if (!entry.encoded || !entry.confirmed) {
      entry.poison();
      throw unavailable();
    }
    entry.used = true;
    return undefined;
  }

  async function execute(
    input: unknown,
    proof: object,
    suppliedBounds: GatewayStartupCommandBoundsV1,
  ): Promise<GatewayMaterialDeliveryOutcomeV1> {
    let request: GatewayMaterialDeliveryRequestV1;
    let bounds: GatewayStartupCommandBoundsV1;
    let end: number;
    try {
      request = parseGatewayMaterialDeliveryRequestV1(input);
      ref(suppliedBounds.requestRef);
      const deadline = suppliedBounds.deadline;
      if (
        typeof deadline !== "string" ||
        !Number.isFinite(Date.parse(deadline)) ||
        !(suppliedBounds.signal instanceof AbortSignal) ||
        suppliedBounds.signal.aborted ||
        !proof ||
        typeof proof !== "object"
      )
        throw unavailable();
      end = Math.min(5000, Date.parse(deadline) - Date.now());
      if (end <= 0) throw unavailable();
      bounds = Object.freeze({
        requestRef: suppliedBounds.requestRef,
        deadline,
        signal: suppliedBounds.signal,
      });
    } catch {
      return outcome("denied");
    }
    if (closing || active || !inspect || !withCurrent || !readSelected)
      return outcome("unavailable");
    if (proofs.has(proof)) return outcome("denied");
    proofs.add(proof);
    const controller = new AbortController();
    const fences = new Set<Promise<unknown>>();
    const checks: (() => void)[] = [];
    const removals: (() => void)[] = [];
    let monoEnd = performance.now() + end;
    let failed = false;
    let disclosureStarted = false;
    let disclosureFinished = false;
    let terminal = false;
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const abort = () => {
      if (!terminal) {
        failed = true;
        controller.abort();
        stop();
      }
    };
    const poison = () => {
      failed = true;
      controller.abort();
      if (!terminal) stop();
    };
    const timeout = () => {
      abort();
      stop();
    };
    active = { abort, settled };
    let timer = setTimeout(timeout, end);
    function check() {
      if (
        failed ||
        closing ||
        controller.signal.aborted ||
        bounds.signal.aborted ||
        Date.now() >= Date.parse(bounds.deadline) ||
        performance.now() >= monoEnd
      ) {
        abort();
        throw unavailable();
      }
      for (const assert of checks) assert();
      if (
        failed ||
        controller.signal.aborted ||
        bounds.signal.aborted ||
        performance.now() >= monoEnd ||
        Date.now() >= Date.parse(bounds.deadline)
      ) {
        abort();
        throw unavailable();
      }
    }
    function observe(value: unknown) {
      const pending = Promise.resolve(value).catch(() => {});
      fences.add(pending);
      void pending.then(() => fences.delete(pending));
    }
    function sync(method: () => unknown) {
      let result: unknown;
      try {
        result = method();
      } catch {
        abort();
        throw unavailable();
      }
      if (result !== undefined) {
        observe(result);
        abort();
        throw unavailable();
      }
    }
    function remaining(method: () => unknown) {
      const value = method();
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        observe(value);
        abort();
        throw unavailable();
      }
      monoEnd = Math.min(monoEnd, performance.now() + value);
      clearTimeout(timer);
      timer = setTimeout(timeout, Math.max(0, monoEnd - performance.now()));
    }
    function watch(signal: AbortSignal) {
      if (!(signal instanceof AbortSignal)) throw unavailable();
      signal.addEventListener("abort", abort, { once: true });
      removals.push(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    }
    async function drainFences() {
      while (fences.size) await Promise.allSettled([...fences]);
    }
    const task = (async (): Promise<GatewayMaterialDeliveryOutcomeV1> => {
      let closeNative: (() => Promise<void>) | undefined;
      try {
        watch(bounds.signal);
        check();
        const native = await inspect(proof, request, bounds);
        if (!native || typeof native !== "object") throw unavailable();
        const close = native.close;
        if (typeof close !== "function") throw unavailable();
        closeNative = close.bind(native);
        const nativeAssert = native.assertCurrent.bind(native);
        const nativeRemaining = native.remainingMs.bind(native);
        const disclose = native.disclose.bind(native);
        if (
          native.profile !== "installation-channel-material-v1" ||
          native.transport !== "owned-child-stdio-installation-channel-material-v1"
        )
          throw unavailable();
        const associated = association(native.association, request);
        watch(native.signal);
        checks.push(() => {
          sync(nativeAssert);
          remaining(nativeRemaining);
        });
        check();
        let entered = false;
        let completed: GatewayMaterialDeliveryOutcomeV1 | undefined;
        let callbackOpen = true;
        let workTask: Promise<GatewayMaterialDeliveryOutcomeV1> | undefined;
        let workSettled = false;
        const work = async (scope: GatewayMaterialReadScopeV1<TSelected>) => {
          let releaseBundle: (() => Promise<void>) | undefined;
          let permitState: Disclosure | undefined;
          try {
            check();
            const scopeAssert = scope.assertCurrent.bind(scope);
            const scopeRemaining = scope.remainingMs.bind(scope);
            const recheck = scope.recheckCurrent.bind(scope);
            const confirm = scope.confirmDisclosure.bind(scope);
            watch(scope.signal);
            checks.push(() => {
              sync(scopeAssert);
              remaining(scopeRemaining);
            });
            correlate(scope.current, request, associated);
            check();
            if ((await recheck()) !== undefined) throw unavailable();
            check();
            const bundle = await readSelected(scope, request.use);
            if (!bundle || typeof bundle !== "object") throw unavailable();
            const release = bundle.release;
            if (typeof release !== "function") throw unavailable();
            releaseBundle = release.bind(bundle);
            const bundleAssert = bundle.assertCurrent.bind(bundle);
            const bundleRemaining = bundle.remainingMs.bind(bundle);
            const withEncodedPayload = bundle.withEncodedPayload.bind(bundle);
            watch(bundle.signal);
            checks.push(() => {
              sync(bundleAssert);
              remaining(bundleRemaining);
            });
            check();
            let encodingOpen = true,
              encodingEntered = false,
              encodingSettled = false;
            let encodingTask: Promise<void> | undefined;
            try {
              const encodingResult = await withEncodedPayload((originalPayload) => {
                if (!encodingOpen || encodingEntered) {
                  poison();
                  return Promise.reject(unavailable());
                }
                encodingEntered = true;
                encodingTask = (async () => {
                  try {
                    check();
                    const byteLength = originalPayload.byteLength;
                    const backingByteLength = originalPayload.backingByteLength;
                    const encode = originalPayload.encodeInto.bind(originalPayload);
                    if (
                      !Number.isSafeInteger(byteLength) ||
                      byteLength < 1 ||
                      byteLength > 28672 ||
                      !Number.isSafeInteger(backingByteLength) ||
                      backingByteLength < 1 ||
                      backingByteLength > 32768
                    )
                      throw unavailable();
                    const header: GatewayMaterialDeliveryHeaderV1 = Object.freeze({
                      schemaVersion: 1,
                      purpose: "read-selected-channel-material",
                      use: request.use,
                      requestRef: bounds.requestRef,
                      kind: "selected-bundle",
                    });
                    if (Buffer.byteLength(canonical(header), "utf8") > 2048) throw unavailable();
                    const permit = Object.freeze({}) as GatewayMaterialDisclosurePermitV1;
                    const payload: GatewayMaterialEncodedPayloadV1 = Object.freeze({
                      byteLength,
                      backingByteLength,
                      encodeInto(target: Uint8Array): undefined {
                        try {
                          if (
                            !permitState?.open ||
                            permitState.encoded ||
                            permitState.confirming ||
                            !(target instanceof Uint8Array) ||
                            !(target.buffer instanceof ArrayBuffer) ||
                            resizableBuffer?.call(target.buffer) === true ||
                            target.byteLength !== byteLength ||
                            target.buffer.byteLength > 32768 ||
                            target.buffer.byteLength + backingByteLength > 65536
                          )
                            throw unavailable();
                          check();
                          sync(() => encode(target));
                          check();
                          permitState.encoded = true;
                          return undefined;
                        } catch {
                          poison();
                          throw unavailable();
                        }
                      },
                    });
                    permitState = {
                      native,
                      header,
                      payload,
                      check,
                      poison,
                      used: false,
                      open: true,
                      encoded: false,
                      confirming: false,
                      confirmed: false,
                      pending: new Set(),
                      confirm: async () => {
                        check();
                        if ((await recheck()) !== undefined) throw unavailable();
                        check();
                        if ((await confirm()) !== undefined) throw unavailable();
                        check();
                      },
                    };
                    permits.set(permit, permitState);
                    check();
                    disclosureStarted = true;
                    if ((await disclose(header, payload, permit)) !== undefined)
                      throw unavailable();
                    check();
                    if (!permitState.used) throw unavailable();
                    disclosureFinished = true;
                    terminal = true;
                  } catch {
                    poison();
                    throw unavailable();
                  } finally {
                    if (permitState) {
                      permitState.open = false;
                      await Promise.allSettled([...permitState.pending]);
                    }
                    await drainFences();
                  }
                })().finally(() => {
                  encodingSettled = true;
                });
                void encodingTask.catch(() => {});
                return encodingTask;
              });
              if (encodingResult !== undefined || !encodingEntered || !disclosureFinished)
                throw unavailable();
            } finally {
              encodingOpen = false;
              if (encodingTask && !encodingSettled) poison();
              if (encodingTask) await encodingTask;
            }
            if (failed) throw unavailable();
            completed = outcome("delivered");
            return completed;
          } catch {
            poison();
            throw unavailable();
          } finally {
            if (permitState) permitState.open = false;
            await drainFences();
            if (releaseBundle && (await releaseBundle()) !== undefined) throw unavailable();
          }
        };
        let returned: GatewayMaterialDeliveryOutcomeV1;
        try {
          returned = await withCurrent(request, native, bounds, (scope) => {
            if (entered || !callbackOpen) {
              poison();
              return Promise.reject(unavailable());
            }
            entered = true;
            workTask = work(scope).finally(() => {
              workSettled = true;
            });
            void workTask.catch(() => {});
            return workTask;
          });
        } finally {
          callbackOpen = false;
          // A returned/caught/unawaited callback cannot outlive this owned scope.
          if (workTask && !workSettled) poison();
          if (workTask) await workTask.catch(() => {});
        }
        if (!entered || !completed || returned !== completed || !disclosureFinished || failed)
          throw unavailable();
        return completed;
      } catch {
        return outcome(disclosureStarted ? "recovery-required" : "unavailable");
      } finally {
        await drainFences();
        if (closeNative && (await closeNative()) !== undefined) throw unavailable();
      }
    })();
    const owned = task
      .catch(() => outcome(disclosureStarted ? "recovery-required" : "unavailable"))
      .finally(() => {
        clearTimeout(timer);
        for (const remove of removals) remove();
        active = undefined;
        settle();
      });
    // Refusal may return while cleanup is pending; the occupied slot and close() retain that work.
    return Promise.race([
      owned,
      stopped.then(() => outcome(disclosureStarted ? "recovery-required" : "unavailable")),
    ]);
  }
  function close(): Promise<void> {
    if (!closeTask) {
      closing = true;
      const pending = active;
      pending?.abort();
      closeTask = pending?.settled ?? Promise.resolve();
    }
    return closeTask;
  }
  return Object.freeze({ execute, confirmDisclosure, consumeDisclosure, close });
}
