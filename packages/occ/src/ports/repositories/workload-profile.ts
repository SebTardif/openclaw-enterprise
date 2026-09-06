import type {
  ProfileOperationActor,
  ProfileOperationLocator,
  StoredProfilePreparation,
} from "../../workload-profiles/types.ts";

export interface WorkloadProfileReadRepository {
  /** Exact original-actor internal read. The service still requires current read authority. */
  findOperation(locator: ProfileOperationLocator): Promise<StoredProfilePreparation | undefined>;
}
export interface WorkloadProfileRepository extends WorkloadProfileReadRepository {
  /** Trusted transaction storage only. Does not authorize, admit, or make content usable. */
  prepareOperation(input: unknown, actor: ProfileOperationActor): Promise<StoredProfilePreparation>;
}
