import {
  canonicalRuntimeAuthorityMutationV1,
  type RuntimeAllocation,
  type RuntimeAuthorityScopeV1,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ResourceConflictError, ScopeViolationError } from "../errors.ts";
import type { RuntimePreparationRepository } from "../ports/repositories/runtime-preparation.ts";
import type { RuntimeAssignmentReadRepository } from "../ports/repositories/runtime-assignment.ts";
import type { RuntimeAdmissionReadRepository } from "../ports/repositories/runtime-admission.ts";
import {
  runtimeAllocationTarget,
  type RuntimeAuthorityTransactionGuard,
  type RuntimeAuthorityReadRepository,
} from "../runtime-authority/repository.ts";
import {
  canonicalRuntimePreparation,
  parseRuntimePreparationAttribution,
  parseRuntimePreparationCanonical,
  parseRuntimePreparationMutation,
  requirePreparation,
  runtimePreparationDigest,
  samePreparationValue,
  type RetainedRuntimePreparation,
  type RuntimePreparationMutation,
  type StoredRuntimePreparationOperation,
} from "./types.ts";

export class RuntimePreparationConflictError extends ResourceConflictError {
  constructor() {
    super("The runtime preparation conflicts with retained state.");
  }
}
function conflict(condition: unknown): asserts condition {
  if (!condition) throw new RuntimePreparationConflictError();
}
/** Borrows the existing owner's transaction; no connection, COMMIT or authority operation. */
export interface RuntimePreparationBackend {
  lock(input: RuntimePreparationMutation): Promise<void>;
  allocation(
    scope: RuntimeAuthorityScopeV1,
    assignmentRef: string,
    lock: boolean,
  ): Promise<Readonly<RuntimeAllocation> | undefined>;
  operation(operationRef: string): Promise<StoredRuntimePreparationOperation | undefined>;
  history(preparationRef: string): Promise<readonly StoredRuntimePreparationOperation[]>;
  identity(
    kind: "child" | "binding",
    reference: string,
  ): Promise<StoredRuntimePreparationOperation | undefined>;
  insert(operation: StoredRuntimePreparationOperation): Promise<void>;
}

// Weak keys retain no history after its owning immutable snapshot is released.
// A decoded canonical string cannot change on a frozen stored record.
const decodedRequests = new WeakMap<
  StoredRuntimePreparationOperation,
  RuntimePreparationMutation
>();
export function retainedRuntimePreparationRequest(
  entry: StoredRuntimePreparationOperation,
): RuntimePreparationMutation {
  const prior = decodedRequests.get(entry);
  if (prior) return prior;
  const request = parseRuntimePreparationCanonical(entry.canonicalRequest);
  if (
    Object.isFrozen(entry) &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(entry, "canonicalRequest") ?? {}, "value")
  )
    decodedRequests.set(entry, request);
  return request;
}

export function projectRuntimePreparation(
  history: readonly StoredRuntimePreparationOperation[],
): RetainedRuntimePreparation | undefined {
  const last = history.at(-1);
  if (last === undefined) return undefined;
  let plan: RetainedRuntimePreparation["plan"] | undefined;
  let preparation: RetainedRuntimePreparation["preparation"] | undefined;
  const children: RetainedRuntimePreparation["children"][number][] = [];
  const bindingProposals: RetainedRuntimePreparation["bindingProposals"][number][] = [];
  for (const entry of history) {
    const request = retainedRuntimePreparationRequest(entry);
    if (request.kind === "retain-plan" || request.kind === "supersede-plan") {
      plan = request.plan;
      preparation = request.preparation;
    }
    if (request.kind === "retain-child")
      children.push({
        sequence: entry.retainedChildSequence,
        child: request.child,
        providerWireUtf8: request.providerWireUtf8,
      });
    if (request.kind === "retain-binding")
      bindingProposals.push({
        proposal: request.proposal,
        canonicalProposalJson: canonicalRuntimeAuthorityMutationV1(request.proposal),
        operation: request.operation,
      });
  }
  requirePreparation(plan !== undefined && preparation !== undefined);
  return immutableCopy({
    status: "retained",
    preparationRef: last.preparationRef,
    target: last.target,
    localVersion: last.localVersion,
    retainedChildSequence: last.retainedChildSequence,
    localState: last.localState,
    guard: last.guard,
    plan,
    preparation,
    children,
    bindingProposals,
  });
}

export function decodeRuntimePreparationOperation(
  input: unknown,
): StoredRuntimePreparationOperation {
  canonicalRuntimePreparation(input, 2 * 1_048_576);
  requirePreparation(input !== null && typeof input === "object" && !Array.isArray(input));
  const value = input as StoredRuntimePreparationOperation;
  requirePreparation(
    Object.keys(value).sort().join(",") ===
      [
        "schemaVersion",
        "operationRef",
        "preparationRef",
        "target",
        "kind",
        "localVersion",
        "retainedChildSequence",
        "localState",
        "guard",
        "canonicalRequest",
        "requestDigest",
        "attribution",
      ]
        .sort()
        .join(","),
  );
  const request = parseRuntimePreparationCanonical(value.canonicalRequest);
  requirePreparation(
    value.schemaVersion === 1 &&
      value.operationRef === request.operationRef &&
      value.preparationRef === request.preparationRef &&
      value.kind === request.kind &&
      samePreparationValue(value.target, request.target),
  );
  requirePreparation(value.requestDigest === runtimePreparationDigest(value.canonicalRequest));
  requirePreparation(
    Number.isSafeInteger(value.localVersion) &&
      value.localVersion >= 1 &&
      Number.isSafeInteger(value.retainedChildSequence) &&
      value.retainedChildSequence >= 0 &&
      value.retainedChildSequence <= 256,
  );
  requirePreparation(value.localVersion === (request.expectedVersion ?? 0) + 1);
  requirePreparation(value.localState === (request.kind === "close" ? request.reason : "open"));
  requirePreparation(
    samePreparationValue(
      value.guard,
      request.kind === "supersede-plan" ? request.nextGuard : request.guard,
    ),
  );
  parseRuntimePreparationAttribution(value.attribution);
  const result = immutableCopy(value);
  decodedRequests.set(result, request);
  return result;
}

export function createRuntimePreparationRepository(
  backend: RuntimePreparationBackend,
  assignments: RuntimeAssignmentReadRepository,
  admissions: RuntimeAdmissionReadRepository,
  authority: RuntimeAuthorityReadRepository,
  guard: RuntimeAuthorityTransactionGuard,
): RuntimePreparationRepository {
  const visible = async (
    scope: RuntimeAuthorityScopeV1,
    entry: StoredRuntimePreparationOperation | undefined,
  ) => {
    if (
      !entry ||
      entry.target.installationId !== scope.installationId ||
      entry.target.namespaceId !== scope.namespaceId ||
      entry.target.agentId !== scope.agentId
    )
      return false;
    return (await backend.allocation(scope, entry.target.assignmentRef.id, false)) !== undefined;
  };
  return Object.freeze<RuntimePreparationRepository>({
    findOperation: async (scope, operationRef) => {
      const entry = await backend.operation(operationRef);
      return (await visible(scope, entry)) ? immutableCopy(entry!) : undefined;
    },
    listHistory: async (scope, preparationRef) => {
      const entries = await backend.history(preparationRef);
      return (await visible(scope, entries[0])) ? immutableCopy(entries) : Object.freeze([]);
    },
    findPreparation: async (scope, preparationRef) => {
      const entries = await backend.history(preparationRef);
      return (await visible(scope, entries[0])) ? projectRuntimePreparation(entries) : undefined;
    },
    retain: (input, attribution) =>
      guard.run(async () => {
        const request = parseRuntimePreparationMutation(input);
        const writer = parseRuntimePreparationAttribution(attribution);
        const canonicalRequest = canonicalRuntimePreparation(request);
        await backend.lock(request);
        const allocation = await backend.allocation(
          request.target,
          request.target.assignmentRef.id,
          true,
        );
        if (
          !allocation ||
          !samePreparationValue(runtimeAllocationTarget(allocation), request.target)
        )
          throw new ScopeViolationError("The runtime preparation owner is unavailable.");
        const prior = await backend.operation(request.operationRef);
        if (prior) {
          conflict(
            prior.canonicalRequest === canonicalRequest &&
              samePreparationValue(prior.attribution, writer),
          );
          // Original attribution/time is retained; replay is before current head and version checks.
          return immutableCopy({ status: "exact-replay", operation: prior } as const);
        }
        const history = await backend.history(request.preparationRef);
        const previous = projectRuntimePreparation(history);
        const head = await assignments.findRuntimeIntentHead(request.target);
        conflict(
          head &&
            head.installationId === request.target.installationId &&
            head.transitionRef === request.currentIntent.intentRef &&
            head.desiredMode === request.currentIntent.mode &&
            head.generation === request.currentIntent.lifecycleGeneration,
        );
        conflict(
          (previous?.localVersion ?? null) === request.expectedVersion &&
            Number.isSafeInteger((request.expectedVersion ?? 0) + 1),
        );
        if (previous)
          conflict(
            samePreparationValue(previous.target, request.target) &&
              samePreparationValue(previous.guard, request.guard) &&
              previous.localState === "open",
          );
        if (request.kind !== "close") {
          conflict(
            head.desiredMode === "running" &&
              head.generation === request.target.lifecycleGeneration &&
              head.revisionId === request.target.revisionId,
          );
          const selected = request.kind === "supersede-plan" ? request.nextGuard : request.guard;
          conflict(
            selected.intentRef === head.transitionRef &&
              selected.mode === head.desiredMode &&
              selected.lifecycleGeneration === head.generation,
          );
        }
        if (request.kind === "retain-plan" || request.kind === "supersede-plan") {
          for (const { target } of request.plan.targets) {
            const planned = await backend.allocation(
              request.target,
              target.ownerAssignmentRef.id,
              false,
            );
            conflict(planned && planned.createEffectRef === target.ownerCreateEffectRef);
          }
        }
        if (request.kind === "retain-plan") {
          conflict(previous === undefined && request.guard.admittedChildCutoff === 0);
          const assignment = await authority.findAssignment(
            request.target,
            request.target.assignmentRef.id,
          );
          conflict(
            assignment?.binding.status === "unbound" && assignment.authority.state === "allocated",
          );
          const admission = await admissions.findRevisionAdmission(
            request.target,
            request.target.revisionId,
          );
          const admittedIntent =
            admission &&
            (await assignments.findRuntimeIntent(request.target, admission.runtimeTransitionRef));
          const admittedRevision =
            admittedIntent &&
            (await admissions.findCommittedAdmission(request.target, admittedIntent.transitionRef, {
              actorId: admittedIntent.actorId,
              requestId: admittedIntent.requestId,
            }));
          conflict(admittedRevision?.id === request.target.revisionId);
        } else {
          conflict(previous !== undefined);
          if (request.kind === "retain-child") {
            conflict(
              previous.retainedChildSequence < 256 &&
                samePreparationValue(request.child.request.plan, previous.plan),
            );
            if (request.child.request.kind === "create")
              conflict(
                samePreparationValue(request.child.request.preparation, previous.preparation),
              );
            conflict(
              request.child.effect.responsibility.kind === "preparation" &&
                samePreparationValue(
                  request.child.effect.responsibility,
                  previous.guard.responsibility,
                ),
            );
            conflict(
              (await backend.identity("child", request.child.effect.effectRef)) === undefined,
            );
          } else if (request.kind === "retain-binding") {
            const assignment = await authority.findAssignment(
              request.target,
              request.target.assignmentRef.id,
            );
            conflict(
              assignment?.binding.status === "unbound" &&
                assignment.authority.state === "allocated",
            );
            conflict(
              request.proposal.expectedAssignmentRecordVersion ===
                assignment.authority.assignmentRecordVersion,
            );
            conflict(
              previous.bindingProposals.length === 0 &&
                (await backend.identity("binding", request.operation.operationRef)) === undefined,
            );
            conflict(request.proposal.expectedLifecycleGeneration === head.generation);
            conflict(
              request.proposal.expectedBindingVersion === null &&
                previous.children.some(
                  ({ child }) =>
                    child.request.kind === "create" &&
                    child.request.action === "materialize" &&
                    child.predicate.kind === "expected-object" &&
                    samePreparationValue(child.guard, previous.guard) &&
                    child.predicate.uid === request.proposal.binding.deploymentUid &&
                    child.providerTarget.clusterRef === request.proposal.binding.clusterRef &&
                    child.providerTarget.kubernetesNamespaceUid ===
                      request.proposal.binding.kubernetesNamespaceUid &&
                    child.request.admittedRuntime.provider === request.proposal.binding.provider &&
                    child.request.admittedRuntime.runtimeProfileRef ===
                      allocation.runtimeProfileRef &&
                    child.request.admittedRuntime.runtimeProfileDigest ===
                      request.proposal.binding.profileDigests.runtime &&
                    child.request.admittedRuntime.configurationDigest ===
                      request.proposal.binding.admittedConfigurationDigest,
                ),
            );
          } else if (request.kind === "supersede-plan") {
            conflict(
              request.nextGuard.gateVersion === previous.guard.gateVersion + 1 &&
                request.nextGuard.requestedFenceEpoch >= previous.guard.requestedFenceEpoch &&
                request.nextGuard.responsibility.responsibilityRef ===
                  previous.guard.responsibility.responsibilityRef &&
                request.nextGuard.responsibility.responsibilityVersion >=
                  previous.guard.responsibility.responsibilityVersion &&
                request.nextGuard.planRef === previous.guard.planRef &&
                request.nextGuard.planVersion === previous.guard.planVersion + 1,
            );
            conflict(
              samePreparationValue(request.preparation, previous.preparation) ||
                request.preparation.preparationVersion ===
                  previous.preparation.preparationVersion + 1,
            );
            // Retention cannot fabricate an admitted cutoff, sealer completion or successor grant.
            conflict(request.nextGuard.admittedChildCutoff === previous.guard.admittedChildCutoff);
          }
        }
        const operation = decodeRuntimePreparationOperation({
          schemaVersion: 1,
          operationRef: request.operationRef,
          preparationRef: request.preparationRef,
          target: request.target,
          kind: request.kind,
          localVersion: (request.expectedVersion ?? 0) + 1,
          retainedChildSequence:
            (previous?.retainedChildSequence ?? 0) + (request.kind === "retain-child" ? 1 : 0),
          localState: request.kind === "close" ? request.reason : "open",
          guard: request.kind === "supersede-plan" ? request.nextGuard : request.guard,
          canonicalRequest,
          requestDigest: runtimePreparationDigest(canonicalRequest),
          attribution: writer,
        });
        await backend.insert(operation);
        return immutableCopy({ status: "retained", operation } as const);
      }),
  });
}
