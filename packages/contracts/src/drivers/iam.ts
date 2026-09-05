import type { Driver } from "./base.ts";
import type { AuthorizationDecision, AuthorizationRequest } from "../identity/authorization.ts";
import type { Identity, IdentityLookup } from "../identity/identity.ts";

export interface IAMDriver extends Driver {
  readonly capability: "iam";
  lookupIdentity(input: IdentityLookup): Promise<Identity | undefined>;
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
}
