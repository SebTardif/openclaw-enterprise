import type {
  AuthorityCallV1,
  AuthorityOperationStateV1,
  BindRuntimeV1,
  BindingResultV1,
  EvidenceResultV1,
  ExactAuthorityOperationV1,
  ResolveAssignmentRequestV1,
  ResolveAssignmentResultV1,
  RetireAssignmentV1,
  RetirementResultV1,
  RuntimeAssignmentAuthorityV1,
  RuntimeAuthorityContextFactoryV1,
  RuntimeEvidenceInputV1,
} from "../../../packages/contracts/src/index.ts";
import type { RuntimeAssignmentReadRepository } from "../../../packages/occ/src/state/platform-state.ts";

/** Compilation fixture only: missing real authority dependencies always deny.
 * No fixture context factory, registration, storage writer or positive provider is supplied.
 */
export class UnavailableProducer implements RuntimeAssignmentAuthorityV1 {
  constructor(
    private readonly contexts: RuntimeAuthorityContextFactoryV1<unknown>,
    readonly existingAllocationRepository: RuntimeAssignmentReadRepository,
  ) {}

  private async rejection(call: AuthorityCallV1) {
    return {
      schemaVersion: 1,
      result: "rejected-before-effect",
      reasonCode:
        (await this.contexts.inspect(call.context, call)) === undefined
          ? "scope-hidden"
          : "lookup-unavailable",
    } as const;
  }
  async bind(_input: BindRuntimeV1, call: AuthorityCallV1): Promise<BindingResultV1> {
    return this.rejection(call);
  }
  async recordEvidence(
    _input: RuntimeEvidenceInputV1,
    call: AuthorityCallV1,
  ): Promise<EvidenceResultV1> {
    return this.rejection(call);
  }
  async retire(_input: RetireAssignmentV1, call: AuthorityCallV1): Promise<RetirementResultV1> {
    return this.rejection(call);
  }
  async resolve(
    input: ResolveAssignmentRequestV1,
    call: AuthorityCallV1,
  ): Promise<ResolveAssignmentResultV1> {
    const permittedContext = (await this.contexts.inspect(call.context, call)) !== undefined;
    return permittedContext
      ? {
          schemaVersion: 1,
          result: "unavailable",
          reasonCode: "lookup-unavailable",
          evaluatedAt: new Date().toISOString(),
          requestRef: input.requestRef,
        }
      : {
          schemaVersion: 1,
          result: "not-visible",
          reasonCode: "scope-hidden",
          evaluatedAt: new Date().toISOString(),
          requestRef: input.requestRef,
        };
  }
  async readOperation(
    _input: ExactAuthorityOperationV1,
    call: AuthorityCallV1,
  ): Promise<AuthorityOperationStateV1> {
    return (await this.contexts.inspect(call.context, call)) === undefined
      ? { schemaVersion: 1, result: "not-visible", reasonCode: "scope-hidden" }
      : { schemaVersion: 1, result: "unavailable", nextAction: "exact-readback-only" };
  }
}
