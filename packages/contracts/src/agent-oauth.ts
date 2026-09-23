import type { Secret, SecretIdentity } from "./index.ts";

export type AgentOAuthPhase =
  | "authorizing"
  | "staging"
  | "authenticated"
  | "handoff_pending"
  | "ready"
  | "reconnect_required"
  | "cancelled"
  | "superseded";

export type AgentOAuthFailureCode =
  | "OAUTH_FAILED"
  | "OAUTH_EXPIRED"
  | "OAUTH_CANCELLED"
  | "CREDENTIAL_STAGING_FAILED"
  | "NATIVE_STORE_MISSING"
  | "NATIVE_IMPORT_FAILED"
  | "MODEL_ACCESS_DENIED"
  | "RUNTIME_UNSUPPORTED";

/** Private custody metadata. Credentials use Secret storage; private challenges are never stored here. */
export interface AgentOAuthAttempt {
  readonly namespaceId: string;
  readonly agentId: string;
  /** Provenance remains available for custody cleanup after unused setup metadata is deleted. */
  readonly providerConnectionId: string;
  readonly connectionId: string;
  readonly generation: number;
  readonly attemptId: string;
  readonly actorId: string;
  readonly providerId: string;
  readonly methodId: string;
  readonly profileId: string;
  readonly phase: AgentOAuthPhase;
  readonly deadlineAt: string;
  readonly secretDriverId: string;
  readonly secretIdentity: SecretIdentity;
  readonly stagedSecret: Secret | null;
  readonly storageUid: string | null;
  readonly failureCode: AgentOAuthFailureCode | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
