import { isDeepStrictEqual } from "node:util";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../errors.ts";
import type { QueryRepositoryFactoryContext } from "../ports/repository-factory.ts";
import { parseRootGrantV1, type RootGrantV1 } from "./grant-contract.ts";
import { parseGrantOperationV1, type GrantOperationV1 } from "./operation-contract.ts";
import type { DelegationRepository, DelegationScope, StoredRootGrantV1 } from "./repository.ts";

type Row = Record<string, unknown>;
const conflict = () => new ResourceConflictError("The delegation record or transition conflicts.");
const rootSelect = `SELECT r.*, (SELECT count(*) FROM occ.delegation_operations o
 WHERE (o.installation_id,o.namespace_id,o.agent_id,o.grant_ref)=
 (r.installation_id,r.namespace_id,r.agent_id,r.grant_ref)) AS used_requests,
 (SELECT count(*) FROM occ.delegation_operations o WHERE
 (o.installation_id,o.namespace_id,o.agent_id,o.grant_ref)=
 (r.installation_id,r.namespace_id,r.agent_id,r.grant_ref)
 AND o.status IN ('accepted','dispatched','unknown')) AS active_requests
 FROM occ.delegation_roots r`;
const owner = "installation_id=$1 AND namespace_id=$2 AND agent_id=$3";
function root(row: Row): StoredRootGrantV1 {
  const grant = parseRootGrantV1({ ...(row.root_grant as RootGrantV1), status: row.status });
  const version = Number(row.version),
    usedRequests = Number(row.used_requests),
    activeRequests = Number(row.active_requests);
  if (!grant || ![version, usedRequests, activeRequests].every(Number.isSafeInteger))
    throw new DependencyUnavailableError("The stored delegation root is invalid.");
  return Object.freeze({ grant, version, usedRequests, activeRequests });
}
function operation(row: Row): GrantOperationV1 {
  const parsed = parseGrantOperationV1({
    ...(row.admission as GrantOperationV1),
    status: row.status,
    outcome: row.outcome,
    dispatchedAt: row.dispatched_at,
  });
  if (!parsed) throw new DependencyUnavailableError("The stored delegation operation is invalid.");
  return parsed;
}

/** Storage only. Current workload, turn, policy, audit and external effects belong to accepting owners. */
export function createPostgresDelegationRepository(
  context: QueryRepositoryFactoryContext,
): DelegationRepository {
  let tail: Promise<unknown> = Promise.resolve();
  // Complete methods sharing one connection must not interleave read/replay/write decisions.
  function run<T>(scope: DelegationScope, work: (key: string[]) => Promise<T>): Promise<T> {
    const next = tail.then(async () => {
      context.transaction.assertActive();
      if (scope.installationId !== context.scope.installationId)
        throw new ScopeViolationError("The delegation Installation does not match.");
      const result = await work([scope.installationId, scope.namespaceId, scope.agentId]);
      context.transaction.assertActive();
      return result;
    });
    tail = next.catch(() => {});
    return next;
  }
  async function query(statement: string, parameters: readonly unknown[]): Promise<Row[]> {
    context.transaction.assertActive();
    return (await context.query.query(statement, parameters)).rows as Row[];
  }
  async function lock(key: string[]) {
    await query("SELECT id FROM occ.namespaces WHERE id=$1 FOR UPDATE", [key[1]]);
    const rows = await query(
      "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR UPDATE",
      key.slice(1),
    );
    if (!rows.length) throw conflict();
  }
  async function findRoot(key: string[], grantRef: string) {
    return (await query(`${rootSelect} WHERE r.${owner} AND grant_ref=$4`, [...key, grantRef]))[0];
  }
  async function findOperation(key: string[], grantRef: string, operationRef: string) {
    return (
      await query(
        `SELECT * FROM occ.delegation_operations WHERE ${owner} AND grant_ref=$4 AND operation_ref=$5`,
        [...key, grantRef, operationRef],
      )
    )[0];
  }
  return Object.freeze({
    findByContext: (scope, ref) =>
      run(scope, async (key) => {
        const row = (
          await query(`${rootSelect} WHERE r.${owner} AND mediation_context_ref=$4`, [...key, ref])
        )[0];
        return row ? root(row) : undefined;
      }),
    findOperation: (scope, grantRef, operationRef) =>
      run(scope, async (key) => {
        const row = await findOperation(key, grantRef, operationRef);
        return row ? operation(row) : undefined;
      }),
    insertRoot: (input) => {
      const grant = parseRootGrantV1(input);
      if (!grant) return Promise.reject(conflict());
      return run(grant.holder, async (key) => {
        await lock(key);
        const old = await findRoot(key, grant.grantRef);
        if (old) {
          if (!isDeepStrictEqual(old.root_grant, grant)) throw conflict();
          return root(old);
        }
        await query(
          `INSERT INTO occ.delegation_roots (installation_id,namespace_id,agent_id,grant_ref,mediation_context_ref,root_grant,status,version)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,1)`,
          [...key, grant.grantRef, grant.mediationContextRef, JSON.stringify(grant), grant.status],
        );
        return root((await findRoot(key, grant.grantRef))!);
      });
    },
    retireRoot: (scope, grantRef, expectedVersion, status) =>
      run(scope, async (key) => {
        await lock(key);
        const rows = await query(
          `UPDATE occ.delegation_roots SET status=$5,version=version+1 WHERE ${owner} AND grant_ref=$4 AND version=$6 RETURNING grant_ref`,
          [...key, grantRef, status, expectedVersion],
        );
        if (!rows.length) throw conflict();
        return root((await findRoot(key, grantRef))!);
      }),
    acceptOperation: (scope, expectedVersion, input) => {
      const parsed = parseGrantOperationV1(input);
      if (!parsed || parsed.status !== "accepted" || parsed.dispatchedAt !== null)
        return Promise.reject(conflict());
      return run(scope, async (key) => {
        await lock(key);
        const old = await findOperation(key, parsed.grantRef, parsed.operationRef);
        if (old) {
          if (!isDeepStrictEqual(old.admission, parsed)) throw conflict();
          return { result: "duplicate", operation: operation(old) } as const;
        }
        const rows = await query(
          `INSERT INTO occ.delegation_operations
          (installation_id,namespace_id,agent_id,grant_ref,operation_ref,admission,status,outcome,dispatched_at,root_version,version)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,'accepted',NULL,NULL,$7,1) RETURNING *`,
          [...key, parsed.grantRef, parsed.operationRef, JSON.stringify(parsed), expectedVersion],
        );
        return { result: "accepted", operation: operation(rows[0]!) } as const;
      });
    },
    dispatchOperation: (scope, grantRef, operationRef, requestDigest, expectedVersion) =>
      run(scope, async (key) => {
        await lock(key);
        const old = await findOperation(key, grantRef, operationRef);
        if (!old || (old.admission as GrantOperationV1).requestDigest !== requestDigest)
          throw conflict();
        if (old.status !== "accepted")
          return { result: "already-consumed", operation: operation(old) } as const;
        // The trigger supplies the clock timestamp AFTER obtaining the same owner locks.
        const rows = await query(
          `UPDATE occ.delegation_operations SET status='dispatched',root_version=$6,version=version+1 WHERE ${owner} AND grant_ref=$4 AND operation_ref=$5 RETURNING *`,
          [...key, grantRef, operationRef, expectedVersion],
        );
        return { result: "dispatched", operation: operation(rows[0]!) } as const;
      }),
    finishOperation: (scope, grantRef, operationRef, completion) =>
      run(scope, async (key) => {
        await lock(key);
        const old = await findOperation(key, grantRef, operationRef);
        if (!old) throw conflict();
        if (old.status === completion.status && old.outcome === completion.outcome)
          return operation(old);
        const rows = await query(
          `UPDATE occ.delegation_operations SET status=$6,outcome=$7,version=version+1 WHERE ${owner} AND grant_ref=$4 AND operation_ref=$5 RETURNING *`,
          [...key, grantRef, operationRef, completion.status, completion.outcome],
        );
        return operation(rows[0]!);
      }),
  } satisfies DelegationRepository);
}
