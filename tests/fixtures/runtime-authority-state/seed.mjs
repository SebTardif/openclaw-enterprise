import { randomUUID } from "node:crypto";
import {
  seedRuntimeOwner,
  profiles,
  attribution,
} from "../../conformance/runtime-assignment-store.contract.mjs";
import { bindRequest } from "../runtime-authority-v1/vectors.mjs";
import { runtimeAllocationTarget } from "../../../packages/occ/src/runtime-authority/repository.ts";

// Persistence values only. This fixture does not authenticate a service, observe runsc,
// grant a preparation/cleanup responsibility, select a runtime or implement a verifier.
export const writer = {
  acceptedServiceIdentityRef: "service/test-observer",
  committedAt: "2026-09-05T08:00:00.000Z",
};
export async function seedAuthority(store) {
  const owner = await seedRuntimeOwner(store);
  const allocation = await store.transact(async (unit) => {
    await unit.runtimeAssignments.initializeRuntimeIntent(
      owner.scope,
      owner.revision.id,
      randomUUID(),
      attribution,
    );
    return unit.runtimeAssignments.allocateUnboundRuntime(
      owner.scope,
      1,
      "harness",
      0,
      randomUUID(),
      profiles,
    );
  });
  const target = runtimeAllocationTarget(allocation);
  const bind = {
    ...bindRequest(),
    operationRef: randomUUID(),
    target,
    responsibilityRef: randomUUID(),
  };
  return {
    ...owner,
    allocation,
    target,
    bind,
    append: (request, actor = writer) =>
      store.transact((unit) => unit.runtimeAuthority.appendMutation(request, actor)),
    record: () =>
      store.read((unit) => unit.runtimeAuthority.findAssignment(target, allocation.assignmentRef)),
    operation: (ref) => store.read((unit) => unit.runtimeAuthority.findOperation(target, ref)),
    stop: () =>
      store.transact((unit) =>
        unit.runtimeAssignments.advanceRuntimeIntent(
          owner.scope,
          1,
          { desiredMode: "stopped", revisionId: owner.revision.id },
          randomUUID(),
          attribution,
        ),
      ),
  };
}
