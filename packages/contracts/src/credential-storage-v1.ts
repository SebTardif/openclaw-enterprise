import { Type, type Static } from "typebox";
import { ConfigurationGeneration, SecretId } from "./api/common.ts";
import {
  CredentialProfileSchemaV1,
  OriginalCredentialBindingSchemaV1,
} from "./credential-authority-v1.ts";

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
const closed = { additionalProperties: false } as const;
const reference = OriginalCredentialBindingSchemaV1.properties.turnRef;
const versionedReference = OriginalCredentialBindingSchemaV1.properties.commonGrant;

/** Original protected Secret correspondence; references contain no credential bytes. */
export const CredentialSecretBindingSchemaV1 = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    scope: OriginalCredentialBindingSchemaV1.properties.scope,
    bindingRef: reference,
    bindingVersion: ConfigurationGeneration,
    secretId: SecretId,
    secretVersion: ConfigurationGeneration,
    providerId: CredentialProfileSchemaV1.anyOf[0].properties.providerId,
    account: versionedReference,
    driverId: reference,
    backendBindingRef: reference,
  },
  closed,
);
export type CredentialSecretBindingV1 = Immutable<Static<typeof CredentialSecretBindingSchemaV1>>;

/** Original repository and permission DATA operands; no inventory or issuance owner. */
export const CredentialRepositoryGrantSchemaV1 = Type.Object(
  {
    providerInstallationRef: reference,
    repositoryIds: Type.Array(Type.String({ pattern: "^[1-9][0-9]{0,19}$" }), {
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
    }),
    permissions: Type.Array(
      Type.Object(
        {
          name: Type.Enum(["metadata", "contents", "issues", "pull_requests"]),
          access: Type.Enum(["read", "write"]),
        },
        closed,
      ),
      { minItems: 1, maxItems: 8, uniqueItems: true },
    ),
    permissionProfile: versionedReference,
  },
  closed,
);
export type CredentialRepositoryGrantV1 = Immutable<
  Static<typeof CredentialRepositoryGrantSchemaV1>
>;

/** Opaque reference owned and authenticated by protected token custody. It has
 * no byte accessor or serialized form. Type branding alone is not authority;
 * custody must authenticate the original handle before consuming its token. */
declare const tokenBrand: unique symbol;
export interface EphemeralTokenHandleV1 {
  readonly [tokenBrand]: true;
}
