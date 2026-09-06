import { randomUUID } from "node:crypto";
import { workloadProfileDigest } from "../../packages/occ/src/workload-profiles/canonical.ts";
import { createMemoryWorkloadProfile } from "../../packages/occ/src/state/memory/workload-profile.ts";
import { WorkloadProfileTransactionGuard } from "../../packages/occ/src/workload-profiles/repository.ts";
import { RepositoryTransactionLifetime } from "../../packages/occ/src/ports/transaction.ts";

/** Lexical storage input only: this is deliberately not a valid workload manifest. */
export function inertProfileRequest(overrides = {}) {
  return {
    schemaVersion: 1,
    operationRef: randomUUID(),
    namespaceId: `ns_${randomUUID()}`,
    component: "harness",
    action: "admit",
    expectedAdmission: null,
    manifest: {
      format: "oce.workload-profile.canonical-json.v1",
      canonicalUtf8: '{"candidate":"unqualified"}',
      manifestDigest: workloadProfileDigest("manifestDigest", { candidate: "unqualified" }),
    },
    ...overrides,
  };
}
export function profileActorFixture() {
  return { accountRef: `account/${randomUUID()}`, principalRef: `principal/${randomUUID()}` };
}
/** Adapter test owner: isolated working snapshots and actual repository lifetime.
 * This does not implement the production account/IAM/platform transaction guard. */
export function profileStorageFixture(namespaceLifecycle = {}) {
  const installationId = `ins_${randomUUID()}`;
  const request = inertProfileRequest();
  const actor = profileActorFixture();
  let snapshot = {
    operations: new Map(),
    capacities: new Map(),
    namespaces: new Map([
      [
        request.namespaceId,
        {
          id: request.namespaceId,
          name: "Profile storage fixture",
          status: "ready",
          createdAt: "2026-09-06T00:00:00.000Z",
          ...namespaceLifecycle,
        },
      ],
    ]),
  };
  let allocations = 0;
  let clockReads = 0;
  let next = Promise.resolve();
  return {
    installationId,
    request,
    actor,
    locator: (
      operationRef = request.operationRef,
      acting = actor,
      installation = installationId,
    ) => ({ installationId: installation, actor: acting, operationRef }),
    get allocations() {
      return allocations;
    },
    get clockReads() {
      return clockReads;
    },
    get snapshot() {
      return structuredClone(snapshot);
    },
    transact(work) {
      const result = next.then(async () => {
        const working = structuredClone(snapshot);
        const lifetime = new RepositoryTransactionLifetime();
        const guard = new WorkloadProfileTransactionGuard();
        const repository = createMemoryWorkloadProfile(
          { scope: { installationId }, transaction: lifetime, snapshot: working },
          guard,
          {
            allocate() {
              allocations++;
              return randomUUID();
            },
          },
          () => {
            clockReads++;
            return "2026-09-06T00:00:00.000Z";
          },
        );
        try {
          const value = await work(repository);
          await guard.finish();
          await lifetime.finish();
          snapshot = working;
          return value;
        } finally {
          lifetime.close();
        }
      });
      next = result.then(
        () => {},
        () => {},
      );
      return result;
    },
  };
}
