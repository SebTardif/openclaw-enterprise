import {
  CREDENTIAL_STORAGE_LIMITS_V1,
  parseCredentialStorageV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import type {
  AffectedTokenQueryV1,
  ClaimRevocationV1,
  CredentialStorageCallBoundsV1,
  EphemeralTokenHandleV1,
  ExactCredentialOperationV1,
  InventoryWriteResultV1,
  MintOutcomeV1,
  OutstandingTokenInventoryPortV1,
  ReserveIssuanceV1,
  RevocationOutcomeV1,
  CredentialStorageSchemaNameV1,
} from "@openclaw-enterprise/contracts/credential-storage-v1";
import type {
  CurrentCredentialAuthorityV1,
  CredentialMitigationHandleV1,
  CredentialReadHandleV1,
} from "@openclaw-enterprise/contracts/credential-authority-v1";
import type {
  CredentialInventoryTransactionV1,
  CredentialInventoryTransactionOwnerV1,
  CredentialInventoryAcceptingOwnerV1,
  CredentialInventoryMintClaimPortV1,
  InventoryMutationV1,
  MintClaimInputV1,
  MintClaimResultV1,
} from "./ports.ts";
import {
  inventoryIntentDigestV1,
  reserveInventoryV1,
  claimInventoryMintV1,
  recordInventoryMintV1,
  claimInventoryRevocationV1,
  recordInventoryRevocationV1,
  listInventoryAffectedV1,
  readInventoryOperationV1,
} from "./transactions.ts";

export interface CredentialInventoryDependenciesV1 {
  readonly transactions: CredentialInventoryTransactionOwnerV1;
  readonly acceptingOwner: CredentialInventoryAcceptingOwnerV1;
  /** Trusted wall clock; not caller/provider time. */
  readonly clock: { read(): { readonly now: number; readonly uncertaintyMs: number } };
}
type MutationSchema =
  "reserve" | "namedUse" | "mintOutcome" | "claimRevocation" | "revocationOutcome";
type MutationResult =
  | Awaited<ReturnType<typeof reserveInventoryV1>>
  | InventoryWriteResultV1
  | Awaited<ReturnType<typeof claimInventoryRevocationV1>>
  | MintClaimResultV1;
const denied = { kind: "denied", reason: "invalid-input" } as const;
const unavailable = { kind: "unavailable", reason: "inventory-unavailable" } as const;

function callTime(
  deps: CredentialInventoryDependenciesV1,
  input: { createdAt: string; deadline: string },
  bounds: CredentialStorageCallBoundsV1,
) {
  const clock = deps.clock.read();
  if (
    !Number.isSafeInteger(clock.now) ||
    !Number.isSafeInteger(clock.uncertaintyMs) ||
    clock.uncertaintyMs < 0 ||
    clock.uncertaintyMs > CREDENTIAL_STORAGE_LIMITS_V1.maxClockUncertaintyMs
  )
    throw new Error("Credential clock unavailable.");
  const remaining = Date.parse(input.deadline) - clock.now - clock.uncertaintyMs;
  if (
    bounds.signal.aborted ||
    remaining <= 0 ||
    Date.parse(input.createdAt) > clock.now + clock.uncertaintyMs
  )
    throw new Error("Credential call unavailable.");
  return {
    ...clock,
    bounds: {
      signal: AbortSignal.any([
        bounds.signal,
        AbortSignal.timeout(Math.min(remaining, CREDENTIAL_STORAGE_LIMITS_V1.maxCallMs)),
      ]),
    },
  };
}
function stamp(result: MutationResult, acknowledgedAt: string): MutationResult {
  if (
    !Number.isFinite(Date.parse(acknowledgedAt)) ||
    new Date(acknowledgedAt).toISOString() !== acknowledgedAt
  )
    throw new Error("Commit acknowledgment unavailable.");
  return "receipt" in result && result.receipt.committedAt === ""
    ? { ...result, receipt: { ...result.receipt, committedAt: acknowledgedAt } }
    : result;
}
function validateResult(
  result: MutationResult,
  schema: CredentialStorageSchemaNameV1 | undefined,
): MutationResult {
  if (schema === undefined) return result; // Internal mint-claim metadata has no public codec.
  if (result.kind === "claimed" && "token" in result) {
    const { token, ...diagnostic } = result;
    return { ...parseCredentialStorageV1("claimResult", diagnostic), token } as MutationResult;
  }
  return parseCredentialStorageV1(schema, result) as MutationResult;
}
/** Trusted composition only: dependencies are actual accepting/transaction owners,
 * never a parsed profile or capability assertion. No provider callback lives here. */
export function createCredentialInventoryV1(
  deps: CredentialInventoryDependenciesV1,
): OutstandingTokenInventoryPortV1 & CredentialInventoryMintClaimPortV1 {
  async function mutate<I extends InventoryMutationV1, R extends MutationResult>(
    schema: MutationSchema,
    resultSchema: CredentialStorageSchemaNameV1 | undefined,
    raw: I,
    bounds: CredentialStorageCallBoundsV1,
    accept: (input: I, tx: CredentialInventoryTransactionV1) => Promise<boolean>,
    transition: (tx: CredentialInventoryTransactionV1, input: I, now: number) => Promise<R>,
  ): Promise<R> {
    let input: I;
    let time: ReturnType<typeof callTime>;
    try {
      const parsed = parseCredentialStorageV1(schema, raw);
      if (schema === "namedUse" && (!("purpose" in parsed) || parsed.purpose !== "repository-mint"))
        return denied as R;
      input = parsed as I;
      time = callTime(deps, input, bounds);
      if ("observedAt" in input && Date.parse(input.observedAt) > time.now + time.uncertaintyMs)
        return denied as R;
    } catch {
      return denied as R;
    }
    const unknown = {
      kind: "commit-unknown",
      operationRef: input.operationRef,
      intentDigest: inventoryIntentDigestV1(input),
      nextAction: "exact-readback-only",
    } as const;
    try {
      const outcome = await deps.transactions.run(input.scope, time.bounds, async (tx) => {
        tx.assertActive();
        if (!(await accept(input, tx))) return { kind: "denied", reason: "authority-denied" } as R;
        // Currentness may have awaited a remote dependency; bounds still govern.
        const current = callTime(deps, input, time.bounds);
        // Provider evidence cannot remove uncertainty from the accepting clock.
        // Preserve the original metadata/digest while checking both lower bounds.
        if (
          "outcome" in input &&
          (input.outcome === "expired" || input.outcome === "unknown-expired") &&
          current.now - Math.max(input.uncertaintyMs, current.uncertaintyMs) <
            Date.parse(input.expiry.expiresAt)
        )
          return { kind: "conflict", reason: "version-conflict" } as R;
        const result = await transition(tx, input, current.now);
        tx.assertActive();
        return result;
      });
      if (outcome.kind === "commit-unknown") return unknown as R;
      if (outcome.kind === "unavailable") return unavailable as R;
      return validateResult(stamp(outcome.value, outcome.acknowledgedAt), resultSchema) as R;
    } catch {
      // A buggy/transport-rejecting owner may already have committed. Conservatively
      // retain exact readback; never translate an unclassified failure to rollback.
      return unknown as R;
    }
  }
  const api: OutstandingTokenInventoryPortV1 & CredentialInventoryMintClaimPortV1 = {
    reserveIssuanceV1: (
      input: ReserveIssuanceV1,
      authority: CurrentCredentialAuthorityV1,
      bounds,
    ) =>
      mutate(
        "reserve",
        "reservationResult",
        input,
        bounds,
        (parsed, tx) => deps.acceptingOwner.acceptCurrent(parsed, authority, tx),
        reserveInventoryV1,
      ),
    claimProviderMintV1: (
      input: MintClaimInputV1,
      authority: CurrentCredentialAuthorityV1,
      bounds,
    ) =>
      mutate(
        "namedUse",
        undefined,
        input,
        bounds,
        (parsed, tx) => deps.acceptingOwner.acceptCurrent(parsed, authority, tx),
        claimInventoryMintV1,
      ),
    recordMintOutcomeV1: ((
      input: MintOutcomeV1,
      responsibility: CredentialMitigationHandleV1,
      material: EphemeralTokenHandleV1 | undefined,
      bounds: CredentialStorageCallBoundsV1,
    ) =>
      mutate(
        "mintOutcome",
        "writeResult",
        input,
        bounds,
        (parsed, tx) => deps.acceptingOwner.acceptMitigation(parsed, responsibility, tx),
        (tx, parsed, now) => recordInventoryMintV1(tx, parsed, material, now),
      )) as OutstandingTokenInventoryPortV1["recordMintOutcomeV1"],
    claimRevocationV1: (
      input: ClaimRevocationV1,
      responsibility: CredentialMitigationHandleV1,
      bounds,
    ) =>
      mutate(
        "claimRevocation",
        "claimResult",
        input,
        bounds,
        (parsed, tx) => deps.acceptingOwner.acceptMitigation(parsed, responsibility, tx),
        claimInventoryRevocationV1,
      ),
    recordRevocationV1: (
      input: RevocationOutcomeV1,
      responsibility: CredentialMitigationHandleV1,
      bounds,
    ) =>
      mutate(
        "revocationOutcome",
        "writeResult",
        input,
        bounds,
        (parsed, tx) => deps.acceptingOwner.acceptMitigation(parsed, responsibility, tx),
        recordInventoryRevocationV1,
      ),
    async listAffectedV1(raw: AffectedTokenQueryV1, authority: CredentialReadHandleV1, bounds) {
      try {
        const input = parseCredentialStorageV1("affectedQuery", raw);
        const time = callTime(deps, input, bounds);
        const outcome = await deps.transactions.run(input.scope, time.bounds, async (tx) => {
          tx.assertActive();
          if (!(await deps.acceptingOwner.acceptRead(input, authority, tx)))
            return { kind: "denied", reason: "scope-hidden" } as const;
          const current = callTime(deps, input, time.bounds);
          return listInventoryAffectedV1(tx, input, current.now, current.uncertaintyMs);
        });
        return outcome.kind === "committed"
          ? parseCredentialStorageV1("affectedPage", outcome.value)
          : unavailable;
      } catch {
        return unavailable;
      }
    },
    async readOperationV1(
      raw: ExactCredentialOperationV1,
      authority: CredentialReadHandleV1,
      bounds,
    ) {
      try {
        const input = parseCredentialStorageV1("readOperation", raw);
        const time = callTime(deps, input, bounds);
        const outcome = await deps.transactions.run(input.scope, time.bounds, async (tx) => {
          tx.assertActive();
          if (!(await deps.acceptingOwner.acceptRead(input, authority, tx)))
            return { kind: "not-visible" } as const;
          callTime(deps, input, time.bounds);
          return readInventoryOperationV1(tx, input);
        });
        return outcome.kind === "committed"
          ? parseCredentialStorageV1("operationResult", outcome.value)
          : { kind: "unavailable", nextAction: "exact-readback-only" };
      } catch {
        return { kind: "unavailable", nextAction: "exact-readback-only" };
      }
    },
    // TODO: Enable delivery only after the actual accepting owner supplies the
    // current-authority, custody and known-outer-commit release composition.
    async deliverRecordedTokenV1() {
      return { kind: "unavailable", reason: "authority-unavailable" };
    },
  };
  return Object.freeze(api);
}
