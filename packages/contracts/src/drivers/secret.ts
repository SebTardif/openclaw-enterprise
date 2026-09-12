import type { Driver } from "./base.ts";
import type { Secret, SecretBackendRef, SecretIdentity } from "../resources/secret.ts";

export interface SecretDriver extends Driver {
  readonly capability: "secret";
  create(identity: SecretIdentity, value: string): Promise<SecretBackendRef>;
  update(secret: Secret, value: string): Promise<void>;
  delete(secret: Secret): Promise<void>;
  /** Verify live exact ownership and return only safe projection identity. */
  resolve(secret: Secret): Promise<SecretBackendRef>;
}
