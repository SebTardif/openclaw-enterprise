import {
  decodeSecurityEventAppendV1,
  decodeSecurityEventAppendResultV1,
  decodeSecurityEventLookupResultV1,
  SECURITY_DELIVERY_LIMITS_V1,
  type SecurityEventAppendV1,
  type SecurityEventAppendResultV1,
  type SecurityEventLookupResultV1,
  type SecurityEventKeyV1,
} from "./security-event-delivery-codec-v1.ts";

export interface ProvisionalSecurityEventReceiptV1 {
  readonly kind: "Staged";
  readonly key: SecurityEventKeyV1;
  readonly eventDigest: string;
  readonly commitReceiptRef: string;
}
type Refusal = Extract<SecurityEventAppendResultV1, { kind: "RefusedBeforeCommit" }>;
/** Trusted composition, not an authentication callback or arbitrary producer port.
 * transact resolves ONLY after the original outer transaction has acknowledged COMMIT.
 * A rejected/uncertain transaction must reject this promise; never return its callback value.
 * read opens a fresh, exact-authorized transaction after any prior unit has unwound.
 * Both methods own cancellation/join or retained recovery until their promises settle. */
export interface SecurityEventTransactionBoundaryV1 {
  transact(
    request: Readonly<SecurityEventAppendV1>,
    signal: AbortSignal,
  ): Promise<ProvisionalSecurityEventReceiptV1 | Refusal>;
  read(
    request: Readonly<SecurityEventAppendV1>,
    signal: AbortSignal,
  ): Promise<SecurityEventLookupResultV1>;
}
export interface SecurityDeliveryHealthV1 {
  readonly active: number;
  readonly encodedBytes: number;
  readonly outcomes: Readonly<Record<"committed" | "refused" | "unknown", number>>;
  readonly countersSaturated: boolean;
}

/** A bounded local adapter. No HTTP service, grant, exporter or autonomous retry loop. */
export function createSecurityEventDeliveryV1(boundary: SecurityEventTransactionBoundaryV1) {
  const owners = new Map<string, number>();
  const keys = new Set<string>();
  const outcomes = { committed: 0, refused: 0, unknown: 0 };
  let encodedBytes = 0;
  let countersSaturated = false;
  function count(name: keyof typeof outcomes) {
    if (outcomes[name] === Number.MAX_SAFE_INTEGER) countersSaturated = true;
    else outcomes[name]++;
  }
  async function execute(
    requestUtf8: string,
    owner: string,
    signal: AbortSignal,
    lookup: boolean,
  ): Promise<SecurityEventAppendResultV1 | SecurityEventLookupResultV1> {
    const request = decodeSecurityEventAppendV1(requestUtf8);
    // Owner is a bounded server-selected Agent or authorized non-Agent service UUID.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(owner))
      throw new TypeError("Security delivery owner unavailable.");
    const id = `${request.key.installationId}/${request.key.eventId}`;
    const unknown = (
      code: "Interrupted" | "Deadline" | "StorageUnknown" | "ReadbackUnavailable",
    ) => ({
      kind: lookup ? ("Unknown" as const) : ("CommitUnknown" as const),
      key: request.key,
      code,
    });
    const bytes = Buffer.byteLength(requestUtf8, "utf8");
    if (signal.aborted || keys.has(id)) {
      count("unknown");
      return unknown(signal.aborted ? "Interrupted" : "StorageUnknown");
    }
    if (
      keys.size >= SECURITY_DELIVERY_LIMITS_V1.globalInFlight ||
      (owners.get(owner) ?? 0) >= SECURITY_DELIVERY_LIMITS_V1.ownerInFlight ||
      encodedBytes + bytes > SECURITY_DELIVERY_LIMITS_V1.inFlightBytes
    ) {
      count(lookup ? "unknown" : "refused");
      return lookup
        ? unknown("ReadbackUnavailable")
        : { kind: "RefusedBeforeCommit", key: request.key, code: "Capacity" };
    }
    keys.add(id);
    owners.set(owner, (owners.get(owner) ?? 0) + 1);
    encodedBytes += bytes;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    const timeout = new Promise<SecurityEventAppendResultV1 | SecurityEventLookupResultV1>(
      (resolve) => {
        onAbort = () => {
          controller.abort();
          resolve(unknown("Interrupted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
        timer = setTimeout(() => {
          controller.abort();
          resolve(unknown("Deadline"));
        }, SECURITY_DELIVERY_LIMITS_V1.deadlineMs);
      },
    );
    const operation = (async (): Promise<
      SecurityEventAppendResultV1 | SecurityEventLookupResultV1
    > => {
      try {
        if (controller.signal.aborted) return unknown("Interrupted");
        let result: SecurityEventAppendResultV1 | SecurityEventLookupResultV1;
        if (lookup)
          result = decodeSecurityEventLookupResultV1(
            JSON.stringify(await boundary.read(request, controller.signal)),
          );
        else {
          const staged = await boundary.transact(request, controller.signal);
          if (staged.kind !== "Staged" && staged.kind !== "RefusedBeforeCommit")
            return unknown("StorageUnknown");
          // The owner promise, not its nested callback, has now completed.
          result = decodeSecurityEventAppendResultV1(
            JSON.stringify(staged.kind === "Staged" ? { ...staged, kind: "Committed" } : staged),
          );
        }
        if (
          result.key.installationId !== request.key.installationId ||
          result.key.eventId !== request.key.eventId ||
          (result.kind === "Committed" && result.eventDigest !== request.eventDigest)
        )
          return unknown("StorageUnknown");
        return result;
      } catch {
        return unknown(lookup ? "ReadbackUnavailable" : "StorageUnknown");
      } finally {
        // A deadline never frees a slot while the owner's work could still run.
        keys.delete(id);
        encodedBytes -= bytes;
        const remaining = (owners.get(owner) ?? 1) - 1;
        if (remaining === 0) owners.delete(owner);
        else owners.set(owner, remaining);
      }
    })();
    try {
      const result = await Promise.race([operation, timeout]);
      count(
        result.kind === "Committed"
          ? "committed"
          : result.kind === "RefusedBeforeCommit"
            ? "refused"
            : "unknown",
      );
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
  return Object.freeze({
    append: (
      frame: string,
      owner: string,
      signal: AbortSignal,
    ): Promise<SecurityEventAppendResultV1> =>
      execute(frame, owner, signal, false) as Promise<SecurityEventAppendResultV1>,
    lookup: (
      frame: string,
      owner: string,
      signal: AbortSignal,
    ): Promise<SecurityEventLookupResultV1> =>
      execute(frame, owner, signal, true) as Promise<SecurityEventLookupResultV1>,
    health: (): SecurityDeliveryHealthV1 =>
      Object.freeze({
        active: keys.size,
        encodedBytes,
        outcomes: Object.freeze({ ...outcomes }),
        countersSaturated,
      }),
  });
}

/** Decisions consume persisted round reservations. This function allocates no
 * new attempt and its output grants no permission to replay an external effect. */
export function securityEventRecoveryDecisionV1(
  completedRounds: number,
  last: SecurityEventLookupResultV1,
) {
  if (
    !Number.isSafeInteger(completedRounds) ||
    completedRounds < 0 ||
    completedRounds > SECURITY_DELIVERY_LIMITS_V1.recoveryRounds
  )
    throw new TypeError("Security delivery recovery state unavailable.");
  if (last.kind === "Committed")
    return Object.freeze({ action: "RecordTransfer" as const, receipt: last });
  if (last.kind === "Conflict" || completedRounds === SECURITY_DELIVERY_LIMITS_V1.recoveryRounds)
    return Object.freeze({ action: "RetainForRepair" as const });
  const delayMs =
    completedRounds === 0 ? 0 : SECURITY_DELIVERY_LIMITS_V1.recoveryDelaysMs[completedRounds - 1]!;
  return Object.freeze({
    action:
      last.kind === "AbsentFenced"
        ? ("ReserveIdenticalAttempt" as const)
        : ("ReserveExactReadback" as const),
    delayMs,
  });
}
