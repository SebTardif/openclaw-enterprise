import {
  parseRuntimeAuthorityV1,
  parseRuntimeEffectsResponseV1,
  parseRuntimeEffectsV1,
  parseRuntimeFenceCompletionV1,
  runtimeEffectEvidenceFreshV1,
  type AuthorityCallV1,
  type DurableCleanupRequestStateV1,
  type ExactRuntimeFaultOperationV1,
  type ExactRuntimeFaultV1,
  type RuntimeAuthorityContextFactoryV1,
  type RuntimeAuthorityVerifiedServiceV1,
  type RuntimeEffectAdmissionV1,
  type RuntimeFenceCompletionProposalV1,
  type RuntimeFenceStateV1,
  type RuntimeGateGuardV1,
  type RuntimeGateStateV1,
  type RuntimePreparedChildV1,
  type RuntimeChildAdmissionResultV1,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type { TransactionQuery } from "../ports/repository-factory.ts";
import { PostgresCommitOutcomeUnknownError } from "../ports/transaction-errors.ts";
import { decodeRuntimePreparationOperation, projectRuntimePreparation } from "./repository.ts";
import {
  runtimePreparationDigest,
  samePreparationValue,
  type RetainedRuntimePreparation,
  type StoredRuntimePreparationOperation,
} from "./types.ts";

export type RuntimeEffectAdmissionInvocationV1 =
  | { readonly method: "readGate"; readonly input: RuntimeGateGuardV1 }
  | { readonly method: "admitChild"; readonly input: RuntimePreparedChildV1 }
  | { readonly method: "completeFence"; readonly input: RuntimeFenceCompletionProposalV1 }
  | { readonly method: "recordFaultAndRequestStop"; readonly input: ExactRuntimeFaultV1 }
  | { readonly method: "readRequest"; readonly input: ExactRuntimeFaultOperationV1 };
export type RuntimeEffectAdmissionResultV1 =
  | RuntimeGateStateV1
  | RuntimeChildAdmissionResultV1
  | RuntimeFenceStateV1
  | DurableCleanupRequestStateV1;

/** Original reads on ONE accepting unit. History is the complete original
 * preparation history, not a caller-selected prefix. Neither this projection
 * nor an observed/open gate authenticates its reader or grants an SDK permit. */
export interface RuntimeEffectAdmissionRetainedV1 {
  readonly preparation: RetainedRuntimePreparation;
  readonly history: readonly StoredRuntimePreparationOperation[];
  readonly gate: RuntimeGateStateV1;
}

export interface RuntimeEffectAdmissionLeaseV1 {
  assertCurrent(): undefined;
  prepareCommit(): Promise<void>;
  release(): Promise<void>;
}
export interface RuntimeEffectAdmissionSourceContextV1 {
  readonly installationId: string;
  readonly query: TransactionQuery;
  assertActive(): undefined;
  retain(lease: RuntimeEffectAdmissionLeaseV1): undefined;
}
export interface RuntimeEffectAdmissionSourceLeaseV1 extends RuntimeEffectAdmissionLeaseV1 {
  /** Recognize the original owner's exact read objects, retained responsibility,
   * operation, full history/cutoff and service/profile/renderer/proof sources.
   * For faults, qualify independent recovery authority even after affected
   * service/profile loss. For readRequest, qualify exact historical read rights
   * without requiring an open preparation, old claim or active profile. */
  qualifyRetained(retained: RuntimeEffectAdmissionRetainedV1): Promise<void>;
  qualifyRequest(operation: ExactRuntimeFaultOperationV1): Promise<void>;
}
/** Required original source, not an implementation or a public registration API.
 * acquire must recognize this actual owner context, untouched transport token,
 * exact native operation/request bytes and current service registry. Existing
 * bind/discover/observe purposes do not authorize these five operations. Register
 * acquired cleanup before any later await; return query-free retained checks
 * through final COMMIT/unknown acknowledgement and original owner cleanup. */
export interface RuntimeEffectAdmissionSourceV1 {
  acquire(
    context: RuntimeEffectAdmissionSourceContextV1,
    invocation: RuntimeEffectAdmissionInvocationV1,
    service: RuntimeAuthorityVerifiedServiceV1,
    call: AuthorityCallV1,
  ): Promise<RuntimeEffectAdmissionSourceLeaseV1>;
}

/** Every operation captures the original invocation. No method accepts a new
 * request, transaction, attribution or proof from the work callback. A missing
 * operation is unavailable; closed-gate storage is not an admitChild fallback. */
export interface RuntimeEffectAdmissionUnitV1 {
  acquireCurrent(): Promise<RuntimeEffectAdmissionSourceLeaseV1>;
  retain(lease: RuntimeEffectAdmissionLeaseV1): undefined;
  assertCurrent(): undefined;
  readRetained(): Promise<RuntimeEffectAdmissionRetainedV1 | undefined>;
  admitChild?(): Promise<RuntimeChildAdmissionResultV1>;
  completeFence?(): Promise<RuntimeFenceStateV1>;
  recordFaultAndRequestStop?(): Promise<DurableCleanupRequestStateV1>;
  readRequest?(): Promise<DurableCleanupRequestStateV1>;
}
/** Original State owns enrollment, exact operation serialization, preparation
 * before Agent lock order, caught-failure poisoning and all accepted work. It
 * acquires the genuine source before any protected reads and invokes work once.
 * Its unchanged finalizer drains prepareCommit then synchronously checks every
 * retained lease immediately before raw COMMIT. Callback/actual write results
 * must agree for negative as well as positive tags. Terminal uncertainty is
 * returned as exact commit-unknown or PostgresCommitOutcomeUnknownError.
 * The owner settles its transaction AND retained cleanup before returning.
 * No concrete owner/source or new persistence implementation is supplied here. */
export interface RuntimeEffectAdmissionOwnerV1 {
  run(
    invocation: RuntimeEffectAdmissionInvocationV1,
    service: RuntimeAuthorityVerifiedServiceV1,
    call: AuthorityCallV1,
    work: (unit: RuntimeEffectAdmissionUnitV1) => Promise<RuntimeEffectAdmissionResultV1>,
  ): Promise<RuntimeEffectAdmissionResultV1>;
}
export interface RuntimePreparationEffectAdmissionOptionsV1 {
  readonly installationId: string;
  readonly recipientRef: string;
  readonly clock: { now(): Date; monotonicMilliseconds(): number };
  readonly contextFactory?: Pick<RuntimeAuthorityContextFactoryV1<unknown>, "inspect">;
  readonly owner?: RuntimeEffectAdmissionOwnerV1;
}

function requireOriginal(value: unknown): asserts value {
  if (!value) throw new Error("The original runtime effect admission is unavailable.");
}
function unsupportedInvocation(_invocation: never): never {
  throw new Error("The original runtime effect admission method is unavailable.");
}
function expectedGuard(
  invocation: RuntimeEffectAdmissionInvocationV1,
): RuntimeGateGuardV1 | undefined {
  switch (invocation.method) {
    case "readGate":
      return invocation.input;
    case "admitChild":
      return invocation.input.guard;
    case "completeFence":
      return invocation.input.request.guard;
    case "recordFaultAndRequestStop":
      return invocation.input.guard;
    case "readRequest":
      return undefined;
    default:
      return unsupportedInvocation(invocation);
  }
}
function refused(
  invocation: RuntimeEffectAdmissionInvocationV1,
  unknown = false,
): RuntimeEffectAdmissionResultV1 {
  const status = unknown ? "commit-unknown" : "unavailable";
  switch (invocation.method) {
    case "readGate":
      return { status: "unavailable", reasonCode: "authority-unavailable" };
    case "admitChild":
      return { status, effect: invocation.input.effect };
    case "completeFence":
      return {
        schemaVersion: 1,
        status,
        request: invocation.input.request,
        reasonCode: "authority-unavailable",
      };
    case "recordFaultAndRequestStop":
      return {
        status,
        operation: invocation.input.operation,
        reasonCode: "authority-unavailable",
      };
    case "readRequest":
      return {
        status: "unavailable",
        operation: invocation.input,
        reasonCode: "authority-unavailable",
      };
    default:
      return unsupportedInvocation(invocation);
  }
}

function closedDataRecord(
  value: unknown,
  names: readonly string[],
): asserts value is Record<string, unknown> {
  requireOriginal(value !== null && typeof value === "object" && !Array.isArray(value));
  requireOriginal([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireOriginal(Reflect.ownKeys(value).length === names.length);
  requireOriginal(
    names.every((name) => {
      const descriptor = descriptors[name];
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    }),
  );
}
function denseDataArray<T>(value: readonly T[], maximum?: number): void {
  requireOriginal(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
  requireOriginal(maximum === undefined || value.length <= maximum);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireOriginal(Reflect.ownKeys(value).length === value.length + 1);
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    requireOriginal(descriptor && descriptor.enumerable && "value" in descriptor);
  }
}
function requireSamePreparation(
  value: RetainedRuntimePreparation,
  expected: RetainedRuntimePreparation,
): void {
  closedDataRecord(value, [
    "status",
    "preparationRef",
    "target",
    "localVersion",
    "retainedChildSequence",
    "localState",
    "guard",
    "plan",
    "preparation",
    "children",
    "bindingProposals",
  ]);
  const { children, bindingProposals, ...header } = value;
  const {
    children: originalChildren,
    bindingProposals: originalBindings,
    ...originalHeader
  } = expected;
  requireOriginal(samePreparationValue(header, originalHeader));
  // These are the original repository cardinalities. Each child/proposal is
  // compared separately; their combined history is not a mutation request.
  denseDataArray(children, 256);
  denseDataArray(bindingProposals, 1);
  requireOriginal(
    children.length === originalChildren.length &&
      bindingProposals.length === originalBindings.length,
  );
  children.forEach((child, index) =>
    requireOriginal(samePreparationValue(child, originalChildren[index])),
  );
  bindingProposals.forEach((proposal, index) =>
    requireOriginal(samePreparationValue(proposal, originalBindings[index])),
  );
}
function requireSameRetained(
  value: RuntimeEffectAdmissionRetainedV1,
  expected: RuntimeEffectAdmissionRetainedV1,
): void {
  closedDataRecord(value, ["preparation", "history", "gate"]);
  requireSamePreparation(value.preparation, expected.preparation);
  denseDataArray(value.history);
  requireOriginal(value.history.length === expected.history.length);
  value.history.forEach((entry, index) => {
    // The original decoder enforces its row and canonical request limits.
    // Compare the canonical string directly, rather than escaping the whole
    // row again under the smaller single-mutation canonicalization limit.
    const { canonicalRequest, ...fields } = decodeRuntimePreparationOperation(entry);
    const { canonicalRequest: originalRequest, ...originalFields } = expected.history[index]!;
    requireOriginal(
      canonicalRequest === originalRequest && samePreparationValue(fields, originalFields),
    );
  });
  requireOriginal(
    samePreparationValue(parseRuntimeEffectsV1("gateState", value.gate), expected.gate),
  );
}
function correspondingRetained(
  invocation: RuntimeEffectAdmissionInvocationV1,
  retained: RuntimeEffectAdmissionRetainedV1,
): RuntimeEffectAdmissionRetainedV1 {
  // Validate original bounded components without serializing or capping the
  // aggregate history. Canonical comparisons preserve null-prototype data joins.
  closedDataRecord(retained, ["preparation", "history", "gate"]);
  denseDataArray(retained.history);
  const history = retained.history.map(decodeRuntimePreparationOperation);
  const projected = projectRuntimePreparation(history);
  requireOriginal(projected);
  requireSamePreparation(retained.preparation, projected);
  const snapshot = Object.freeze({
    preparation: projected,
    history: Object.freeze(history),
    gate: parseRuntimeEffectsV1("gateState", retained.gate),
  });
  const preparation = snapshot.preparation;
  const guard = expectedGuard(invocation);
  requireOriginal(guard);
  const gate = parseRuntimeEffectsV1("gateState", snapshot.gate);
  requireOriginal(gate.status === "observed" && samePreparationValue(gate.guard, guard));
  requireOriginal(samePreparationValue(gate.plan, preparation.plan));
  requireOriginal(
    samePreparationValue(guard.scope, {
      installationId: preparation.target.installationId,
      namespaceId: preparation.target.namespaceId,
      agentId: preparation.target.agentId,
    }),
  );
  for (const child of gate.children) {
    const original = preparation.children.filter(
      (entry) => entry.child.effect.effectRef === child.effect.effectRef,
    );
    requireOriginal(original.length === 1 && samePreparationValue(original[0]!.child, child));
  }
  if (invocation.method === "admitChild") {
    const child = invocation.input;
    const original = preparation.children.filter(
      (entry) => entry.child.effect.effectRef === child.effect.effectRef,
    );
    requireOriginal(original.length === 1 && samePreparationValue(original[0]!.child, child));
    const wire = original[0]!.providerWireUtf8;
    requireOriginal(
      Buffer.byteLength(wire, "utf8") === child.providerWire.byteLength &&
        runtimePreparationDigest(wire) === child.providerWire.bytesDigest,
    );
    requireOriginal(
      samePreparationValue(child.effect.target, preparation.target) &&
        samePreparationValue(child.request.plan, preparation.plan),
    );
    requireOriginal(gate.authority === "current");
    if (
      child.request.kind === "create" ||
      (child.request.kind === "set-route" && child.request.desiredRoute.kind === "active")
    ) {
      requireOriginal(
        preparation.localState === "open" &&
          gate.ordinaryAdmission === "open" &&
          gate.guard.mode === "running",
      );
    } else requireOriginal(gate.sealerAdmission === "open" && gate.ordinaryAdmission === "closed");
    if (child.request.kind === "create")
      requireOriginal(samePreparationValue(child.request.preparation, preparation.preparation));
  }
  if (invocation.method === "completeFence") parseRuntimeFenceCompletionV1(gate, invocation.input);
  if (invocation.method === "recordFaultAndRequestStop")
    requireOriginal(samePreparationValue(invocation.input.target, preparation.target));
  return snapshot;
}

/** Canonical Runtime consumer only. It does not implement RuntimeEffectsV1 or
 * invoke a provider. A returned admission/read receipt never becomes a live SDK
 * permission. TODO(first native Agent): compose the original closed native
 * purpose/registry source and State's operation-specific accepting owner; the
 * currently installed closed-gate repository cannot supply those operations. */
export class RuntimePreparationEffectAdmissionV1 implements RuntimeEffectAdmissionV1 {
  readonly #installationId: string;
  readonly #recipientRef: string;
  readonly #now: () => Date;
  readonly #monotonic: () => number;
  readonly #inspect: RuntimeAuthorityContextFactoryV1<unknown>["inspect"] | undefined;
  readonly #run: RuntimeEffectAdmissionOwnerV1["run"] | undefined;
  readonly #pending = new Set<Promise<unknown>>();

  constructor(options: RuntimePreparationEffectAdmissionOptionsV1) {
    this.#installationId = options.installationId;
    this.#recipientRef = options.recipientRef;
    const clock = options.clock,
      factory = options.contextFactory,
      owner = options.owner;
    this.#now = clock.now.bind(clock);
    this.#monotonic = clock.monotonicMilliseconds.bind(clock);
    this.#inspect = factory?.inspect.bind(factory);
    this.#run = owner?.run.bind(owner);
  }
  /** The original transport cleanup can join accepted work after public abort. */
  async joinPending(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }
  private async invoke<R extends RuntimeEffectAdmissionResultV1>(
    invocation: RuntimeEffectAdmissionInvocationV1,
    originalCall: AuthorityCallV1,
    parse: (value: unknown) => R,
  ): Promise<R> {
    invocation = Object.freeze(invocation);
    const run = this.#run,
      inspect = this.#inspect;
    if (!run || !inspect) return parse(refused(invocation));
    const call = Object.freeze({
      requestRef: originalCall.requestRef,
      recipientRef: originalCall.recipientRef,
      deadline: originalCall.deadline,
      signal: originalCall.signal,
      context: originalCall.context,
    });
    const began = this.#monotonic();
    let failed = false,
      failure: unknown,
      mutatingEntered = false,
      entered = false,
      expired = false;
    let completed: R | undefined;
    const pending = new Set<Promise<unknown>>();
    const noteFailure = (error: unknown) => {
      if (!failed) {
        failed = true;
        failure = error;
      }
    };
    const poison = (error: unknown): never => {
      noteFailure(error);
      throw error;
    };
    const track = <T>(work: () => PromiseLike<T> | T): Promise<T> => {
      const promise = Promise.resolve().then(work);
      pending.add(promise);
      this.#pending.add(promise);
      void promise.then(
        () => {
          pending.delete(promise);
          this.#pending.delete(promise);
        },
        (error: unknown) => {
          noteFailure(error);
          pending.delete(promise);
          this.#pending.delete(promise);
        },
      );
      return promise;
    };
    const bounds = () => {
      if (failed) throw failure;
      const elapsed = this.#monotonic() - began,
        deadline = Date.parse(call.deadline);
      requireOriginal(
        !expired &&
          !call.signal.aborted &&
          call.recipientRef === this.#recipientRef &&
          Number.isFinite(deadline) &&
          this.#now().getTime() < deadline &&
          Number.isFinite(elapsed) &&
          elapsed >= 0 &&
          elapsed < 3000,
      );
    };
    // This whole promise remains owned after the public boundary settles. The
    // original context/signal identities are preserved; expiry independently
    // poisons our retained fence and prevents any later operation from starting.
    const execute = async (): Promise<R> => {
      try {
        bounds();
        const verified = await track(() => {
          bounds();
          return inspect(call.context, call);
        });
        bounds();
        requireOriginal(verified);
        // Preserve the original opaque token. Cloning it destroys native custody.
        const transportBinding = verified.transportBinding;
        const service = Object.freeze({
          configuration: immutableCopy(
            parseRuntimeAuthorityV1("serviceTrust", verified.configuration),
          ),
          authenticatedAt: verified.authenticatedAt,
          expiresAt: verified.expiresAt,
          peerEvidenceRef: verified.peerEvidenceRef,
          transportBinding,
        });
        const scope =
          expectedGuard(invocation)?.scope ??
          (invocation.method === "readRequest" ? invocation.input.scope : undefined);
        const allowed = service.configuration.allowedScope;
        requireOriginal(
          scope &&
            scope.installationId === this.#installationId &&
            service.configuration.installationId === this.#installationId &&
            service.configuration.permittedRecipientRef === call.recipientRef &&
            allowed.kind === "agent" &&
            samePreparationValue(
              {
                installationId: allowed.installationId,
                namespaceId: allowed.namespaceId,
                agentId: allowed.agentId,
              },
              scope,
            ),
        );
        requireOriginal(
          Number.isFinite(Date.parse(service.authenticatedAt)) &&
            Date.parse(service.authenticatedAt) <= this.#now().getTime() &&
            Date.parse(service.expiresAt) > this.#now().getTime(),
        );
        const terminal = await track(() => {
          bounds();
          return run(invocation, service, call, (unit) =>
            track(async () => {
              requireOriginal(!entered);
              entered = true;
              bounds();
              const acquire = unit.acquireCurrent.bind(unit),
                retain = unit.retain.bind(unit),
                unitCurrent = unit.assertCurrent.bind(unit);
              const acquired = await track(() => {
                bounds();
                return acquire();
              });
              // Own cleanup before reading any further acquired getter or awaiting
              // qualification. The wrapper is idempotent even if retain throws late.
              const release = acquired.release.bind(acquired);
              let transferred = false;
              const leasePending = new Set<Promise<unknown>>();
              const leaseTrack = <T>(work: () => PromiseLike<T> | T): Promise<T> => {
                const promise = track(work);
                leasePending.add(promise);
                void promise.then(
                  () => leasePending.delete(promise),
                  () => leasePending.delete(promise),
                );
                return promise;
              };
              const leaseSynchronous = (work: () => unknown): undefined => {
                try {
                  const value = work();
                  if (value !== undefined) {
                    void leaseTrack(() => Promise.resolve(value));
                    throw new Error("Effect admission currentness must be synchronous.");
                  }
                  return undefined;
                } catch (error) {
                  return poison(error);
                }
              };
              let releasePromise: Promise<void> | undefined;
              let current: (() => undefined) | undefined;
              let prepare: (() => Promise<void>) | undefined;
              const guarded: RuntimeEffectAdmissionLeaseV1 = Object.freeze({
                assertCurrent: () => {
                  try {
                    bounds();
                    requireOriginal(!releasePromise && current);
                    leaseSynchronous(current);
                    bounds();
                    return undefined;
                  } catch (error) {
                    return poison(error);
                  }
                },
                prepareCommit: async () => {
                  try {
                    guarded.assertCurrent();
                    requireOriginal(prepare);
                    const prepareCurrent = prepare;
                    await leaseTrack(() => {
                      guarded.assertCurrent();
                      return prepareCurrent();
                    });
                    guarded.assertCurrent();
                  } catch (error) {
                    return poison(error);
                  }
                },
                release: () => {
                  if (!releasePromise)
                    releasePromise = Promise.resolve()
                      .then(async () => {
                        // Do not release beneath a malformed asynchronous currentness
                        // call, even when its caller caught the immediate refusal.
                        while (leasePending.size) await Promise.allSettled([...leasePending]);
                        await release();
                      })
                      .catch((error: unknown) => poison(error));
                  return releasePromise;
                },
              });
              try {
                // Cleanup is already locally owned. Capture a usable currentness
                // fence before handing it to an owner that may assert in retain().
                current = acquired.assertCurrent.bind(acquired);
                prepare = acquired.prepareCommit.bind(acquired);
                leaseSynchronous(() => retain(guarded));
                transferred = true;
                const qualify = acquired.qualifyRetained.bind(acquired),
                  qualifyRequest = acquired.qualifyRequest.bind(acquired);
                const check = () => {
                  guarded.assertCurrent();
                  leaseSynchronous(unitCurrent);
                  guarded.assertCurrent();
                };
                check();
                if (invocation.method === "readRequest") {
                  const read = unit.readRequest?.bind(unit);
                  requireOriginal(read);
                  await leaseTrack(() => {
                    check();
                    return qualifyRequest(invocation.input);
                  });
                  check();
                  completed = parse(
                    await track(() => {
                      check();
                      return read();
                    }),
                  );
                  check();
                  return completed;
                }
                const read = unit.readRetained.bind(unit);
                const original = await track(() => {
                  check();
                  return read();
                });
                check();
                requireOriginal(original);
                const retained = correspondingRetained(invocation, original);
                if (invocation.method !== "recordFaultAndRequestStop") {
                  requireOriginal(
                    retained.gate.status === "observed" &&
                      runtimeEffectEvidenceFreshV1(
                        retained.gate.evidence,
                        this.#now().toISOString(),
                        null,
                      ),
                  );
                }
                // The source consumes original owner objects; no guarded lease or
                // copied DTO is passed as a replacement enrollment token.
                await leaseTrack(() => {
                  check();
                  return qualify(original);
                });
                check();
                requireSameRetained(original, retained);
                const result = await (async () => {
                  switch (invocation.method) {
                    case "readGate":
                      return retained.gate;
                    case "admitChild": {
                      const apply = unit.admitChild?.bind(unit);
                      requireOriginal(apply);
                      return track(() => {
                        check();
                        mutatingEntered = true;
                        return apply();
                      });
                    }
                    case "completeFence": {
                      const apply = unit.completeFence?.bind(unit);
                      requireOriginal(apply);
                      return track(() => {
                        check();
                        mutatingEntered = true;
                        return apply();
                      });
                    }
                    case "recordFaultAndRequestStop": {
                      const apply = unit.recordFaultAndRequestStop?.bind(unit);
                      requireOriginal(apply);
                      return track(() => {
                        check();
                        mutatingEntered = true;
                        return apply();
                      });
                    }
                    default:
                      return unsupportedInvocation(invocation);
                  }
                })();
                completed = parse(result);
                check();
                return completed;
              } catch (error) {
                noteFailure(error);
                // Once transferred, the original owner retains authority through its
                // rollback/COMMIT-unknown terminal and then releases. Only failed
                // transfers are still this callback's local cleanup obligation.
                if (!transferred) {
                  try {
                    await guarded.release();
                  } catch {
                    /* Preserve the original failure. */
                  }
                }
                return poison(error);
              }
            }),
          );
        });
        const result = parse(terminal);
        if (result.status === "commit-unknown") return result;
        if (failed) throw failure;
        requireOriginal(entered && completed && samePreparationValue(result, completed));
        return result;
      } catch (error) {
        return parse(
          refused(
            invocation,
            mutatingEntered || error instanceof PostgresCommitOutcomeUnknownError,
          ),
        );
      } finally {
        while (pending.size) await Promise.allSettled([...pending]);
      }
    };
    let resolveBoundary: ((result: RuntimeEffectAdmissionResultV1) => void) | undefined;
    const boundary = new Promise<RuntimeEffectAdmissionResultV1>((resolve) => {
      resolveBoundary = resolve;
    });
    const expire = () => {
      if (expired) return;
      expired = true;
      noteFailure(new Error("Runtime effect admission call expired or was aborted."));
      resolveBoundary!(refused(invocation, mutatingEntered));
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      bounds();
      call.signal.addEventListener("abort", expire, { once: true });
      timer = setTimeout(
        expire,
        Math.max(
          0,
          Math.min(
            3000 - (this.#monotonic() - began),
            Date.parse(call.deadline) - this.#now().getTime(),
          ),
        ),
      );
      if (call.signal.aborted) expire();
      // Publish complete ownership before invoking any original callback. Only
      // this promise, including its drain/terminal cleanup, removes itself.
      const owned = Promise.resolve().then(execute);
      this.#pending.add(owned);
      void owned.then(
        () => this.#pending.delete(owned),
        () => this.#pending.delete(owned),
      );
      return await Promise.race([owned, boundary.then(parse)]);
    } catch (error) {
      return parse(
        refused(invocation, mutatingEntered || error instanceof PostgresCommitOutcomeUnknownError),
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      call.signal.removeEventListener("abort", expire);
    }
  }
  readGate(input: RuntimeGateGuardV1, call: AuthorityCallV1): Promise<RuntimeGateStateV1> {
    const request = parseRuntimeEffectsV1("gateGuard", input);
    return this.invoke({ method: "readGate", input: request }, call, (value) => {
      const result = parseRuntimeEffectsV1("gateState", value);
      if (result.status === "observed")
        requireOriginal(samePreparationValue(result.guard, request));
      return result;
    });
  }
  admitChild(
    input: RuntimePreparedChildV1,
    call: AuthorityCallV1,
  ): Promise<RuntimeChildAdmissionResultV1> {
    const request = parseRuntimeEffectsV1("preparedChild", input);
    return this.invoke({ method: "admitChild", input: request }, call, (value) =>
      parseRuntimeEffectsResponseV1("admitChild", request, value),
    );
  }
  completeFence(
    input: RuntimeFenceCompletionProposalV1,
    call: AuthorityCallV1,
  ): Promise<RuntimeFenceStateV1> {
    const request = parseRuntimeEffectsV1("fenceCompletion", input);
    return this.invoke({ method: "completeFence", input: request }, call, (value) => {
      const result = parseRuntimeEffectsResponseV1("readFence", request.request, value);
      if (result.status === "established")
        requireOriginal(
          samePreparationValue(result.targets, request.targets) &&
            samePreparationValue(result.children, request.children),
        );
      return result;
    });
  }
  recordFaultAndRequestStop(
    input: ExactRuntimeFaultV1,
    call: AuthorityCallV1,
  ): Promise<DurableCleanupRequestStateV1> {
    const request = parseRuntimeEffectsV1("fault", input);
    return this.invoke({ method: "recordFaultAndRequestStop", input: request }, call, (value) =>
      parseRuntimeEffectsResponseV1("recordFaultAndRequestStop", request, value),
    );
  }
  readRequest(
    input: ExactRuntimeFaultOperationV1,
    call: AuthorityCallV1,
  ): Promise<DurableCleanupRequestStateV1> {
    const request = parseRuntimeEffectsV1("faultOperation", input);
    return this.invoke({ method: "readRequest", input: request }, call, (value) =>
      parseRuntimeEffectsResponseV1("readRequest", request, value),
    );
  }
}
