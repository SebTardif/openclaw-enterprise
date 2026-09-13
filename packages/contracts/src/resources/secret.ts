import type { ResourceRef } from "./scope.ts";
import {
  SecretReference as SecretReferenceSchema,
  SecretBinding as SecretBindingSchema,
  SecretBindings as SecretBindingsSchema,
} from "../api/common.ts";

// Local declarations merge the schema values with their resource types during declaration emit.
export const SecretReference = SecretReferenceSchema;
export const SecretBinding = SecretBindingSchema;
export const SecretBindings = SecretBindingsSchema;

/** Secret material is never part of an OCC resource or revision. */
export interface SecretReference extends ResourceRef {
  readonly kind: "secret";
  readonly namespaceId: string;
}

export interface SecretIdentity {
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
}

/** Backend identity is internal OCC metadata, not a public selector. */
export interface SecretBackendRef {
  readonly namespaceName: string;
  readonly name: string;
  readonly key: string;
  readonly uid: string;
}

export interface Secret extends SecretIdentity {
  readonly driverId: string;
  readonly backendRef: SecretBackendRef;
  readonly createdAt: string;
}

export interface SecretMetadata extends SecretIdentity {
  readonly ref: SecretReference;
}

export interface SecretBinding {
  readonly source: SecretReference;
  readonly delivery?: { readonly type: "env" };
}

export type SecretBindings = Readonly<Record<string, SecretBinding>>;

/** Prepared from authoritative OCC metadata; never persisted in AgentRevision. */
export interface SecretEnvironmentProjection {
  readonly name: string;
  readonly secretId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly backendRef: SecretBackendRef;
}
