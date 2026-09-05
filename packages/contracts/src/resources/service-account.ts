import type { Scope } from "./scope.ts";

export interface ServiceAccountCredential {
  readonly kind: "api_key" | "access_token" | "oauth_access_token";
  readonly secretRef: {
    readonly name: string;
    readonly key: string;
  };
}

export interface ServiceAccount extends Scope {
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly credential?: ServiceAccountCredential;
}

export interface ServiceAccountRevision {
  readonly id: string;
  readonly credential: ServiceAccountCredential & { readonly kind: "api_key" | "access_token" };
}
