import type { AuthorizationRequest } from "./authorization.ts";
import type { IdentityKind } from "./identity.ts";
import type { ResourceRef, Scope } from "../resources/scope.ts";

export type AuditEventKind = "bootstrap" | "mutation" | "authorization_denial";

export type AuditOutcome = "success" | "denied" | "failure";

export interface AuditEvent extends Scope {
  readonly id: string;
  readonly installationId: string;
  readonly namespaceId?: string;
  readonly occurredAt: string;
  readonly kind: AuditEventKind;
  readonly actorId: string;
  readonly schemaVersion?: number;
  readonly source?: "occ";
  readonly requestId?: string;
  readonly admissionDecisionId?: string;
  readonly actor?: {
    readonly principalId?: string;
    readonly id?: string;
    readonly kind?: IdentityKind;
    readonly issuer?: string;
    readonly subject?: string;
    readonly unresolved?: true;
  };
  readonly action: string;
  readonly resource: ResourceRef;
  readonly iamDriverId?: string;
  readonly authorization?: AuthorizationRequest;
  readonly decisionReason?: string;
  readonly reasonCode?: string;
  readonly outcome: AuditOutcome;
  readonly details?: Readonly<Record<string, unknown>>;
}
