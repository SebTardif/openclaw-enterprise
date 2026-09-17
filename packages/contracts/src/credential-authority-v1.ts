import { Type, type Static, type TProperties } from "typebox";
import {
  AgentId,
  ConfigurationGeneration,
  InstallationId,
  NamespaceId,
  ProviderId,
  RequestId,
  SecretId,
  Timestamp,
} from "./api/common.ts";
import { AccountVersionVectorSchemaV1 } from "./account-authority-v1.ts";
import { OriginalCredentialBindingSchemaV1 } from "./credential-inventory-data-v1.ts";

export { OriginalCredentialBindingSchemaV1 };
export type { OriginalCredentialBindingV1 } from "./credential-inventory-data-v1.js";

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
const closed = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const reference = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
});
const digest = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
const versionedReference = closed({ ref: reference, version: ConfigurationGeneration, digest });
const scope = closed({
  installationId: InstallationId,
  namespaceId: NamespaceId,
  agentId: AgentId,
});
const profileFields = {
  schemaVersion: Type.Literal(1),
  scope,
  profile: versionedReference,
  providerId: ProviderId,
  account: versionedReference,
  transport: versionedReference,
};

/** Canonical profiles are DATA; the original accepting owner supplies permission. */
export const CredentialProfileSchemaV1 = Type.Union([
  closed({
    ...profileFields,
    kind: Type.Literal("model"),
    mode: Type.Literal("mediated"),
    modelProfile: versionedReference,
    credentialClass: Type.Enum(["workload-federation", "trusted-login", "api-key"]),
  }),
  closed({
    ...profileFields,
    kind: Type.Literal("repository"),
    mode: Type.Enum(["native", "mediated", "history-isolated"]),
    providerInstallationRef: reference,
    permissionProfile: versionedReference,
    credentialClass: Type.Literal("installation-token"),
  }),
]);
export type CredentialProfileV1 = Immutable<Static<typeof CredentialProfileSchemaV1>>;

export const CredentialAuthorityObservationSchemaV1 = closed({
  schemaVersion: Type.Literal(1),
  original: OriginalCredentialBindingSchemaV1,
  profile: CredentialProfileSchemaV1,
  secretId: SecretId,
  secretVersion: ConfigurationGeneration,
  leaseRef: reference,
  leaseVersion: ConfigurationGeneration,
  leaseNotAfter: Timestamp,
  accountVersions: AccountVersionVectorSchemaV1,
  decisionRef: reference,
  authorityVersion: ConfigurationGeneration,
  invalidationVersion: ConfigurationGeneration,
  dispatchFenceRef: reference,
  comparedAt: Timestamp,
  startNotAfter: Timestamp,
  requestId: RequestId,
  effect: Type.Enum(["model-use", "reserve-issuance", "mint-token", "deliver-token"]),
});
export type CredentialAuthorityObservationV1 = Immutable<
  Static<typeof CredentialAuthorityObservationSchemaV1>
>;

declare const authorityBrand: unique symbol;
declare const mitigationBrand: unique symbol;
declare const managementBrand: unique symbol;
declare const readBrand: unique symbol;

/** Local, invocation-owned identity. Owners must authenticate it and recheck currentness
 * after awaits; a brand or parsed observation grants no permission. */
export interface CurrentCredentialAuthorityHandleV1 {
  readonly [authorityBrand]: true;
}
/** Independently authorized attenuation/revocation responsibility, never new work. */
export interface CredentialMitigationHandleV1 {
  readonly [mitigationBrand]: true;
}
/** Exact credential-management authority, separate from original human turn use. */
export interface CredentialManagementHandleV1 {
  readonly [managementBrand]: true;
}
/** Exact original-service read scope, with no mint or delivery authority. */
export interface CredentialReadHandleV1 {
  readonly [readBrand]: true;
}
export interface CurrentCredentialAuthorityV1 {
  readonly handle: CurrentCredentialAuthorityHandleV1;
  readonly observation: CredentialAuthorityObservationV1;
}
