import {
  canonicalRuntimeAuthorityMutationV1,
  parseRuntimeAuthorityV1,
  parseRuntimeMutationResultV1,
  type AuthorityCallV1,
  type BindRuntimeV1,
  type BindingResultV1,
  type RuntimeAuthorityVerifiedServiceV1,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type { TransactionQuery } from "../ports/repository-factory.ts";
import { PostgresCommitOutcomeUnknownError } from "../ports/transaction-errors.ts";
import {
  samePreparationValue,
  type RetainedRuntimePreparation,
} from "../runtime-preparation/types.ts";
import { exactRuntimeAuthorityOperation } from "./repository.ts";

export type RuntimeInitialBindingProposalV1 =
  RetainedRuntimePreparation["bindingProposals"][number];

export interface RuntimeInitialBindingLeaseV1 {
  assertCurrent(): undefined;
  release(): Promise<void>;
}

/** This is the original transaction owner's actual acquisition context. A
 * copied context, query function or Installation identifier cannot enroll it.
 * The source must capture retained fences that outlive this short query scope. */
export interface RuntimeInitialBindingSourceContextV1 {
  readonly installationId: string;
  readonly query: TransactionQuery;
  assertActive(): undefined;
  retain(lease: RuntimeInitialBindingLeaseV1): undefined;
}

/** Independent source/service/request custody is acquired before replay or
 * preparation locks. Fresh qualification additionally owns the complete
 * profile, preparation/responsibility and referenced observation proofs. */
export interface RuntimeInitialBindingSourceLeaseV1 extends RuntimeInitialBindingLeaseV1 {
  prepareCommit(): Promise<void>;
  qualifyPreparation(
    preparation: RetainedRuntimePreparation,
    retainedProposal: RuntimeInitialBindingProposalV1,
  ): Promise<void>;
}

export interface RuntimeInitialBindingSourceV1 {
  acquire(
    context: RuntimeInitialBindingSourceContextV1,
    request: BindRuntimeV1,
    service: RuntimeAuthorityVerifiedServiceV1,
    call: AuthorityCallV1,
  ): Promise<RuntimeInitialBindingSourceLeaseV1>;
}

/** Captured-request methods supplied only by the original accepting owner.
 * readPreparationLocator scope-checks the existing binding_operation_ref and
 * takes its preparation hold before Agent; findPreparation delegates to the
 * existing public repository on that same unit. append captures the original
 * request and server-owned attribution and requires completed source proofs. */
export interface RuntimeInitialBindingUnitV1 {
  readReplay(): Promise<BindingResultV1 | undefined>;
  readPreparationLocator(): Promise<Readonly<{ preparationRef: string }> | undefined>;
  findPreparation(preparationRef: string): Promise<RetainedRuntimePreparation | undefined>;
  requireCurrentProofs(
    preparation: RetainedRuntimePreparation,
    retainedProposal: RuntimeInitialBindingProposalV1,
  ): Promise<void>;
  append(): Promise<BindingResultV1>;
  assertCurrent(): undefined;
  retain(lease: RuntimeInitialBindingLeaseV1): undefined;
}

/** No default owner or proof source exists. The genuine owner recognizes its
 * source/context, rejects missing source before checkout, invokes work once,
 * poisons caught failures, joins accepted work, and checks retained currentness
 * synchronously immediately before its raw COMMIT. It returns only after the
 * original transaction and cleanup settle. A possibly committed failure must
 * retain PostgresCommitOutcomeUnknownError or the exact commit-unknown result. */
export interface RuntimeInitialBindingOwnerV1 {
  run(
    request: BindRuntimeV1,
    service: RuntimeAuthorityVerifiedServiceV1,
    call: AuthorityCallV1,
    work: (unit: RuntimeInitialBindingUnitV1) => Promise<BindingResultV1>,
  ): Promise<BindingResultV1>;
}

function unavailable(): BindingResultV1 {
  return { schemaVersion: 1, result: "rejected-before-effect", reasonCode: "lookup-unavailable" };
}

function requireOriginal(condition: unknown): asserts condition {
  if (!condition) throw new Error("The original initial binding is unavailable.");
}

function correspondingResult(
  input: BindingResultV1,
  request: BindRuntimeV1,
  service: RuntimeAuthorityVerifiedServiceV1,
): BindingResultV1 {
  const result = parseRuntimeMutationResultV1("bind", input);
  const operation = exactRuntimeAuthorityOperation(request);
  if (result.result === "commit-unknown") {
    requireOriginal(samePreparationValue(result.operation, operation));
  } else if (result.result === "applied" || result.result === "exact-replay") {
    const receipt = result.receipt;
    for (const key of [
      "installationId",
      "namespaceId",
      "agentId",
      "operationRef",
      "operationKind",
      "canonicalPayloadDigest",
    ] as const)
      requireOriginal(receipt[key] === operation[key]);
    requireOriginal(
      receipt.acceptedServiceIdentityRef === service.configuration.serviceIdentityRef &&
        samePreparationValue(receipt.assignmentRef, request.target.assignmentRef) &&
        receipt.assignmentRecordVersion === request.expectedAssignmentRecordVersion + 1 &&
        receipt.outcome.kind === "bind" &&
        samePreparationValue(receipt.outcome.binding, request.binding),
    );
  }
  return result;
}

/** Compare genuine retained inputs within the owner's actual transaction. Data
 * equality is necessary correspondence; only requireCurrentProofs and the
 * original owner's final fence can qualify a fresh append. No nested store
 * transaction, native observation or new preparation is performed here. */
export async function acceptInitialRuntimeBindingV1(
  owner: RuntimeInitialBindingOwnerV1,
  input: BindRuntimeV1,
  originalService: RuntimeAuthorityVerifiedServiceV1,
  originalCall: AuthorityCallV1,
): Promise<BindingResultV1> {
  const request = parseRuntimeAuthorityV1("bind", immutableCopy(input));
  // Copy data only. The native inspector's transport token is an opaque
  // identity also recognized by the source owner; cloning it loses custody.
  const service: RuntimeAuthorityVerifiedServiceV1 = Object.freeze({
    configuration: immutableCopy(originalService.configuration),
    authenticatedAt: originalService.authenticatedAt,
    expiresAt: originalService.expiresAt,
    peerEvidenceRef: originalService.peerEvidenceRef,
    transportBinding: originalService.transportBinding,
  });
  const call = Object.freeze({
    context: originalCall.context,
    requestRef: originalCall.requestRef,
    recipientRef: originalCall.recipientRef,
    deadline: originalCall.deadline,
    signal: originalCall.signal,
  });
  const operation = exactRuntimeAuthorityOperation(request);
  const unknown = (): BindingResultV1 =>
    parseRuntimeMutationResultV1("bind", {
      schemaVersion: 1,
      result: "commit-unknown",
      operation,
      nextAction: "exact-readback-only",
    });
  let invoked = false;
  let failed = false;
  let failure: unknown;
  let completed: BindingResultV1 | undefined;
  let appendEntered = false;
  const reject = (error: unknown): never => {
    if (!failed) {
      failed = true;
      failure = error;
    }
    throw failure;
  };
  try {
    requireOriginal(
      call.requestRef === request.requestRef &&
        !call.signal.aborted &&
        service.configuration.installationId === request.target.installationId &&
        service.configuration.permittedRecipientRef === call.recipientRef &&
        service.configuration.role === "lifecycle-authority" &&
        service.configuration.allowedScope.kind === "agent" &&
        service.configuration.allowedScope.installationId === request.target.installationId &&
        service.configuration.allowedScope.namespaceId === request.target.namespaceId &&
        service.configuration.allowedScope.agentId === request.target.agentId &&
        request.target.component === "harness" &&
        request.binding.provider === "occ/kubernetes-gvisor" &&
        request.expectedBindingVersion === null,
    );
    const result = await owner.run(request, service, call, async (unit) => {
      if (invoked) return reject(new Error("The original binding callback was already entered."));
      invoked = true;
      const pending = new Set<Promise<unknown>>();
      try {
        const current = unit.assertCurrent.bind(unit);
        const replay = unit.readReplay.bind(unit);
        const locator = unit.readPreparationLocator.bind(unit);
        const read = unit.findPreparation.bind(unit);
        const qualify = unit.requireCurrentProofs.bind(unit);
        const append = unit.append.bind(unit);
        const check = (): void => {
          if (failed) throw failure;
          requireOriginal(!call.signal.aborted);
          const observed: unknown = current();
          if (observed !== undefined) {
            const drain = Promise.resolve(observed);
            pending.add(drain);
            drain.then(
              () => pending.delete(drain),
              () => pending.delete(drain),
            );
            reject(new Error("Initial binding currentness must be synchronous."));
          }
        };
        check();
        const prior = await replay();
        check();
        if (prior !== undefined) {
          const replayed = correspondingResult(prior, request, service);
          requireOriginal(replayed.result === "exact-replay");
          completed = replayed;
          return replayed;
        }
        const located = await locator();
        check();
        requireOriginal(located !== undefined);
        const preparationRef = located.preparationRef;
        requireOriginal(typeof preparationRef === "string");
        const preparation = await read(preparationRef);
        check();
        requireOriginal(
          preparation !== undefined &&
            preparation.preparationRef === preparationRef &&
            preparation.localState === "open" &&
            samePreparationValue(preparation.target, request.target),
        );
        const matches = preparation.bindingProposals.filter(
          (entry) => entry.operation.operationRef === request.operationRef,
        );
        requireOriginal(matches.length === 1);
        const retained = matches[0]!;
        requireOriginal(
          retained.proposal.requestRef === request.requestRef &&
            samePreparationValue(retained.proposal, request) &&
            retained.canonicalProposalJson === canonicalRuntimeAuthorityMutationV1(request) &&
            samePreparationValue(retained.operation, operation),
        );
        await qualify(preparation, retained);
        check();
        appendEntered = true;
        const appended = correspondingResult(await append(), request, service);
        check();
        completed = appended;
        return appended;
      } catch (error) {
        return reject(error);
      } finally {
        while (pending.size) await Promise.allSettled([...pending]);
      }
    });
    const settled = correspondingResult(result, request, service);
    // The owner alone observes the transaction's terminal outcome. Its exact
    // uncertainty cannot become a definite rejection through a callback error.
    if (settled.result === "commit-unknown") return settled;
    if (failed) throw failure;
    if (settled.result === "applied" || settled.result === "exact-replay") {
      requireOriginal(completed !== undefined && samePreparationValue(settled, completed));
    }
    return settled;
  } catch (error) {
    if (error instanceof PostgresCommitOutcomeUnknownError) return unknown();
    // An invalid positive/result after append cannot establish definite rollback.
    // Genuine owners classify uncertain COMMIT explicitly; this also prevents a
    // malformed owner response from being reported as safe to submit again.
    if (appendEntered && completed !== undefined) return unknown();
    return unavailable();
  }
}
