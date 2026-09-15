import { createHash } from "node:crypto";
import {
  canonicalRuntimeAuthorityMutationV1,
  parseRuntimeAuthorityV1,
  type ExactAuthorityOperationV1,
  type RuntimeAllocation,
  type RuntimeAssignmentRecordV1,
  type RuntimeAssignmentTargetV1,
  type RuntimeAuthorityScopeV1,
  type RuntimeMutationV1,
  type RuntimeMutationResultV1,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { ResourceConflictError, ScopeViolationError } from "../errors.ts";
import type { RuntimeAssignmentReadRepository } from "../ports/repositories/runtime-assignment.ts";

export type RuntimeAuthorityReceipt = Extract<
  RuntimeMutationResultV1,
  { receipt: unknown }
>["receipt"];
/** Internal persistence attribution. This is not a trusted service context or permission. */
export interface RuntimeAuthorityWriteAttribution {
  readonly acceptedServiceIdentityRef: string;
  readonly committedAt: string;
}
export interface StoredRuntimeAuthorityOperation {
  readonly canonicalPayload: string;
  readonly receipt: RuntimeAuthorityReceipt;
}
export interface RuntimeAuthorityReadRepository {
  findAssignment(
    scope: RuntimeAuthorityScopeV1,
    assignmentRef: string,
  ): Promise<RuntimeAssignmentRecordV1 | undefined>;
  findOperation(
    scope: RuntimeAuthorityScopeV1,
    operationRef: string,
  ): Promise<StoredRuntimeAuthorityOperation | undefined>;
}
export interface RuntimeAuthorityRepository extends RuntimeAuthorityReadRepository {
  /** Trusted OCC unit-of-work only. Caller must separately verify context, profile,
   * observation and exact responsibility under the authoritative acceptance guard.
   * Persistence never selects an active runtime or returns purpose eligibility. */
  appendMutation(
    input: RuntimeMutationV1,
    attribution: RuntimeAuthorityWriteAttribution,
  ): Promise<RuntimeMutationResultV1>;
}
export class RuntimeAuthorityConflictError extends ResourceConflictError {
  readonly reasonCode: Extract<RuntimeMutationResultV1, { result: "conflict" }>["reasonCode"];
  constructor(reasonCode: Extract<RuntimeMutationResultV1, { result: "conflict" }>["reasonCode"]) {
    super("The runtime authority mutation conflicts with retained state.");
    this.reasonCode = reasonCode;
  }
}

/** A failed authority admission poisons its enclosing unit, including caught failures. */
export class RuntimeAuthorityTransactionGuard {
  private failure: unknown;
  private failed = false;
  private closed = false;
  private pending: Promise<void> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(
        new ScopeViolationError("The runtime authority transaction is closed."),
      );
    const result = this.pending.then(async () => {
      this.assertCommittable();
      try {
        return await work();
      } catch (error) {
        this.failed = true;
        this.failure = error;
        throw error;
      }
    });
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async finish(): Promise<void> {
    // Close submissions synchronously before draining the accepted queue. A promise
    // continuation cannot append a new mutation while this unit is committing.
    this.closed = true;
    const accepted = this.pending;
    await accepted;
    this.assertCommittable();
  }
  private assertCommittable(): void {
    if (this.failed) throw this.failure;
  }
}

export function runtimeAuthorityDigest(input: RuntimeMutationV1): string {
  return `sha256:${createHash("sha256").update(canonicalRuntimeAuthorityMutationV1(input), "utf8").digest("hex")}`;
}
export function exactRuntimeAuthorityOperation(
  input: RuntimeMutationV1,
): ExactAuthorityOperationV1 {
  return parseRuntimeAuthorityV1("exactOperation", {
    schemaVersion: 1,
    installationId: input.target.installationId,
    namespaceId: input.target.namespaceId,
    agentId: input.target.agentId,
    operationRef: input.operationRef,
    operationKind: input.kind,
    canonicalPayloadDigest: runtimeAuthorityDigest(input),
    requestRef: input.requestRef,
  });
}
export function runtimeAllocationTarget(
  allocation: Readonly<RuntimeAllocation>,
): RuntimeAssignmentTargetV1 {
  return {
    installationId: allocation.installationId,
    namespaceId: allocation.namespaceId,
    agentId: allocation.agentId,
    assignmentRef: { schemaVersion: 1, id: allocation.assignmentRef },
    revisionId: allocation.revisionId,
    component: allocation.component,
    lifecycleGeneration: allocation.lifecycleGeneration,
    runtimeGeneration: allocation.runtimeGeneration,
    createEffectRef: allocation.createEffectRef,
  };
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const left = Object.entries(a).sort(([x], [y]) => x.localeCompare(y));
  const right = Object.entries(b).sort(([x], [y]) => x.localeCompare(y));
  return (
    left.length === right.length &&
    left.every(([key, value], i) => key === right[i]?.[0] && same(value, right[i]?.[1]))
  );
}
export function projectRuntimeAuthority(
  allocation: Readonly<RuntimeAllocation>,
  operations: readonly StoredRuntimeAuthorityOperation[],
): RuntimeAssignmentRecordV1 {
  const bound = operations.find((operation) => operation.receipt.outcome.kind === "bind")?.receipt
    .outcome;
  return parseRuntimeAuthorityV1("assignmentRecord", {
    schemaVersion: 1,
    allocation,
    binding:
      bound?.kind === "bind" ? { status: "bound", instance: bound.binding } : { status: "unbound" },
    authority: {
      state: bound ? "bound" : "allocated",
      assignmentRecordVersion: operations.at(-1)?.receipt.assignmentRecordVersion ?? 1,
    },
  });
}

/** Backend operations are on the existing platform transaction, never another store. */
export interface RuntimeAuthorityBackend {
  lockOperation(operationRef: string): Promise<void>;
  allocation(
    scope: RuntimeAuthorityScopeV1,
    assignmentRef: string,
    lock: boolean,
  ): Promise<Readonly<RuntimeAllocation> | undefined>;
  operations(
    scope: RuntimeAuthorityScopeV1,
    assignmentRef: string,
  ): Promise<readonly StoredRuntimeAuthorityOperation[]>;
  operation(operationRef: string): Promise<StoredRuntimeAuthorityOperation | undefined>;
  insert(operation: StoredRuntimeAuthorityOperation): Promise<void>;
}
export function createRuntimeAuthorityRepository(
  backend: RuntimeAuthorityBackend,
  assignments: RuntimeAssignmentReadRepository,
  guard: RuntimeAuthorityTransactionGuard,
): RuntimeAuthorityRepository {
  async function visible(scope: RuntimeAuthorityScopeV1, assignmentRef: string) {
    const allocation = await backend.allocation(scope, assignmentRef, false);
    return allocation && allocation.installationId === scope.installationId
      ? allocation
      : undefined;
  }
  return {
    findAssignment: async (scope, assignmentRef) => {
      const allocation = await visible(scope, assignmentRef);
      return allocation === undefined
        ? undefined
        : projectRuntimeAuthority(allocation, await backend.operations(scope, assignmentRef));
    },
    findOperation: async (scope, operationRef) => {
      const operation = await backend.operation(operationRef);
      const receipt = operation?.receipt;
      if (
        !receipt ||
        receipt.installationId !== scope.installationId ||
        receipt.namespaceId !== scope.namespaceId ||
        receipt.agentId !== scope.agentId ||
        !(await visible(scope, receipt.assignmentRef.id))
      )
        return undefined;
      return immutableCopy(operation);
    },
    appendMutation: (value, attribution) =>
      guard.run(async () => {
        const input = parseRuntimeAuthorityV1("mutation", value);
        if (attribution === null || typeof attribution !== "object")
          throw new ScopeViolationError(
            "Runtime authority attribution requires exact server-owned fields.",
          );
        const fields = Object.getOwnPropertyDescriptors(attribution);
        if (
          Object.keys(fields).sort().join(",") !== "acceptedServiceIdentityRef,committedAt" ||
          typeof fields.acceptedServiceIdentityRef?.value !== "string" ||
          typeof fields.committedAt?.value !== "string"
        )
          throw new ScopeViolationError(
            "Runtime authority attribution requires exact server-owned fields.",
          );
        const acceptedServiceIdentityRef: string = fields.acceptedServiceIdentityRef.value;
        const committedAt: string = fields.committedAt.value;
        const canonicalPayload = canonicalRuntimeAuthorityMutationV1(input);
        const exact = exactRuntimeAuthorityOperation(input);
        await backend.lockOperation(input.operationRef);
        const allocation = await backend.allocation(
          input.target,
          input.target.assignmentRef.id,
          true,
        );
        if (!allocation || !same(runtimeAllocationTarget(allocation), input.target))
          throw new ScopeViolationError("The runtime authority target is unavailable.");
        // Compare original identity and complete payload before current head/record checks.
        const prior = await backend.operation(input.operationRef);
        if (prior) {
          if (
            prior.canonicalPayload !== canonicalPayload ||
            prior.receipt.acceptedServiceIdentityRef !== acceptedServiceIdentityRef
          )
            throw new RuntimeAuthorityConflictError("operation-payload-mismatch");
          return parseRuntimeAuthorityV1("mutationResult", {
            schemaVersion: 1,
            result: "exact-replay",
            receipt: prior.receipt,
          });
        }
        const operations = await backend.operations(input.target, input.target.assignmentRef.id);
        const record = projectRuntimeAuthority(allocation, operations);
        const nextVersion = record.authority.assignmentRecordVersion + 1;
        if (
          record.authority.assignmentRecordVersion !== input.expectedAssignmentRecordVersion ||
          !Number.isSafeInteger(nextVersion)
        )
          throw new RuntimeAuthorityConflictError("record-version-mismatch");
        const head = await assignments.findRuntimeIntentHead(input.target);
        if (head?.generation !== input.expectedLifecycleGeneration)
          throw new RuntimeAuthorityConflictError("generation-mismatch");
        if (head.desiredMode !== "running" || head.generation !== allocation.lifecycleGeneration)
          throw new RuntimeAuthorityConflictError("generation-mismatch");
        if (record.binding.status === "bound")
          throw new RuntimeAuthorityConflictError("binding-mismatch");
        const outcome: RuntimeAuthorityReceipt["outcome"] = {
          kind: "bind",
          binding: input.binding,
        };
        const { requestRef: _requestRef, ...key } = exact;
        const result = parseRuntimeAuthorityV1("mutationResult", {
          schemaVersion: 1,
          result: "applied",
          receipt: {
            ...key,
            assignmentRef: input.target.assignmentRef,
            acceptedServiceIdentityRef,
            committedAt,
            assignmentRecordVersion: nextVersion,
            outcome,
          },
        });
        if (!("receipt" in result))
          throw new Error("A stored runtime mutation requires a receipt.");
        await backend.insert(immutableCopy({ canonicalPayload, receipt: result.receipt }));
        return result;
      }),
  };
}
