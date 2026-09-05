import type { Scope } from "../resources/scope.ts";

export type IdentityKind = "principal" | "service_principal";

export interface Principal extends Scope {
  readonly id: string;
  readonly kind: "principal";
  readonly namespaceId?: never;
  readonly issuer: string;
  readonly subject: string;
}

export interface ServicePrincipal extends Scope {
  readonly id: string;
  readonly kind: "service_principal";
  readonly namespaceId?: string;
  readonly agentId?: string;
}

export type Identity = Principal | ServicePrincipal;

export interface Group extends Scope {
  readonly id: string;
  readonly namespaceId?: string;
  readonly name: string;
}

export interface GroupMembership extends Scope {
  readonly namespaceId?: string;
  readonly groupId: string;
  readonly principalId: string;
}

export type IdentityLookup = Scope &
  (
    | { readonly issuer: string; readonly subject: string; readonly servicePrincipalId?: never }
    // Supplied only after credential verification or authorized credential management.
    | { readonly servicePrincipalId: string; readonly issuer?: never; readonly subject?: never }
  );
