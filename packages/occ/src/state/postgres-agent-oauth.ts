import type { AgentOAuthAttempt } from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { DependencyUnavailableError, ScopeViolationError } from "../errors.ts";
import type { AgentOAuthRepository } from "../ports/agent-oauth.ts";
import type { PostgresQueryClient } from "./postgres-work-queue.ts";
import { validAgentOAuthAttempt } from "./agent-oauth-state.ts";

const columns = `namespace_id, agent_id, connection_id, generation, attempt_id, actor_id,
  provider_id, method_id, profile_id, phase, deadline_at, secret_driver_id, secret_identity, staged_secret,
  storage_uid, failure_code, created_at, updated_at, provider_connection_id`;

function fromRow(value: unknown): Readonly<AgentOAuthAttempt> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DependencyUnavailableError("Persisted Agent OAuth metadata is invalid.");
  }
  const row = value as Record<string, unknown>;
  const timestamp = (key: string) => (row[key] instanceof Date ? row[key].toISOString() : row[key]);
  const attempt = {
    namespaceId: row.namespace_id,
    agentId: row.agent_id,
    providerConnectionId: row.provider_connection_id,
    connectionId: row.connection_id,
    generation: Number(row.generation),
    attemptId: row.attempt_id,
    actorId: row.actor_id,
    providerId: row.provider_id,
    methodId: row.method_id,
    profileId: row.profile_id,
    secretDriverId: row.secret_driver_id,
    phase: row.phase,
    deadlineAt: timestamp("deadline_at"),
    secretIdentity: row.secret_identity,
    stagedSecret: row.staged_secret,
    storageUid: row.storage_uid,
    failureCode: row.failure_code,
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  };
  if (!validAgentOAuthAttempt(attempt)) {
    throw new DependencyUnavailableError("Persisted Agent OAuth metadata is invalid.");
  }
  return immutableCopy(attempt);
}

export function postgresAgentOAuth(client: PostgresQueryClient): AgentOAuthRepository {
  return {
    latest: async (namespaceId, agentId) => {
      const result = await client.query(
        `SELECT ${columns} FROM occ.agent_oauth_attempts WHERE namespace_id = $1 AND agent_id = $2 ORDER BY generation DESC LIMIT 1`,
        [namespaceId, agentId],
      );
      return result.rows[0] === undefined ? undefined : fromRow(result.rows[0]);
    },
    find: async (namespaceId, agentId, generation) => {
      const result = await client.query(
        `SELECT ${columns} FROM occ.agent_oauth_attempts WHERE namespace_id = $1 AND agent_id = $2 AND generation = $3`,
        [namespaceId, agentId, generation],
      );
      return result.rows[0] === undefined ? undefined : fromRow(result.rows[0]);
    },
    list: async (namespaceId, agentId) => {
      const result = await client.query(
        `SELECT ${columns} FROM occ.agent_oauth_attempts WHERE namespace_id = $1 AND agent_id = $2 ORDER BY generation`,
        [namespaceId, agentId],
      );
      return Object.freeze(result.rows.map(fromRow));
    },
    create: async (attempt) => {
      // Reject extra fields before projection, so credentials cannot disappear into an unchecked caller shape.
      if (!validAgentOAuthAttempt(attempt)) {
        throw new ScopeViolationError("The Agent OAuth attempt is invalid.");
      }
      const result = await client.query(
        `INSERT INTO occ.agent_oauth_attempts (${columns}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING ${columns}`,
        [
          attempt.namespaceId,
          attempt.agentId,
          attempt.connectionId,
          attempt.generation,
          attempt.attemptId,
          attempt.actorId,
          attempt.providerId,
          attempt.methodId,
          attempt.profileId,
          attempt.phase,
          attempt.deadlineAt,
          attempt.secretDriverId,
          JSON.stringify(attempt.secretIdentity),
          attempt.stagedSecret === null ? null : JSON.stringify(attempt.stagedSecret),
          attempt.storageUid,
          attempt.failureCode,
          attempt.createdAt,
          attempt.updatedAt,
          attempt.providerConnectionId,
        ],
      );
      return fromRow(result.rows[0]);
    },
    update: async (input) => {
      const result = await client.query(
        `UPDATE occ.agent_oauth_attempts SET phase=$5, updated_at=$6,
        staged_secret=CASE WHEN $7::boolean THEN $8::jsonb ELSE staged_secret END,
        storage_uid=CASE WHEN $9::boolean THEN $10::text ELSE storage_uid END,
        failure_code=CASE WHEN $11::boolean THEN $12::text ELSE failure_code END
        WHERE namespace_id=$1 AND agent_id=$2 AND generation=$3 AND phase=$4 RETURNING ${columns}`,
        [
          input.namespaceId,
          input.agentId,
          input.generation,
          input.expectedPhase,
          input.phase,
          input.updatedAt,
          input.stagedSecret !== undefined,
          input.stagedSecret == null ? null : JSON.stringify(input.stagedSecret),
          input.storageUid !== undefined,
          input.storageUid ?? null,
          input.failureCode !== undefined,
          input.failureCode ?? null,
        ],
      );
      return result.rows[0] === undefined ? undefined : fromRow(result.rows[0]);
    },
    delete: async (namespaceId, agentId) => {
      await client.query(
        "DELETE FROM occ.agent_oauth_attempts WHERE namespace_id=$1 AND agent_id=$2",
        [namespaceId, agentId],
      );
    },
  };
}
