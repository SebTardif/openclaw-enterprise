import { DependencyUnavailableError } from "../../errors.ts";
import type { WorkloadProfileServicePort } from "./port.ts";

/** Storage availability never stands in for actual current human authorization. */
export function createWorkloadProfileService(): WorkloadProfileServicePort {
  const unavailable = async (): Promise<never> => {
    throw new DependencyUnavailableError("Workload profile authority is unavailable.");
  };
  // TODO: connect the maintained one-use guarded-human transaction before prepare
  // or retained reads. Active acceptance additionally requires the closed manifest
  // decoder and actual allocation/preparation/bind current-use and invalidation
  // consumers. Remove these denials only when those real compositions are present;
  // a structural handle, storage adapter, observation or startup flag is insufficient.
  return Object.freeze({
    prepare: unavailable,
    accept: unavailable,
    withdraw: unavailable,
    readOperation: unavailable,
    readProfile: unavailable,
  });
}
