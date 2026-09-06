import type {
  RetainedRuntimePreparation,
  RuntimeAuthorityScopeV1,
  RuntimePreparationAttribution,
  RuntimePreparationMutation,
  RuntimePreparationWriteResult,
  StoredRuntimePreparationOperation,
} from "../../runtime-preparation/types.ts";

export interface RuntimePreparationReadRepository {
  findPreparation(
    scope: RuntimeAuthorityScopeV1,
    preparationRef: string,
  ): Promise<RetainedRuntimePreparation | undefined>;
  findOperation(
    scope: RuntimeAuthorityScopeV1,
    operationRef: string,
  ): Promise<StoredRuntimePreparationOperation | undefined>;
  listHistory(
    scope: RuntimeAuthorityScopeV1,
    preparationRef: string,
  ): Promise<readonly StoredRuntimePreparationOperation[]>;
}
export interface RuntimePreparationRepository extends RuntimePreparationReadRepository {
  /** Internal OCC persistence only. Retention neither admits a child nor proves a fence. */
  retain(
    input: RuntimePreparationMutation,
    attribution: RuntimePreparationAttribution,
  ): Promise<RuntimePreparationWriteResult>;
}
