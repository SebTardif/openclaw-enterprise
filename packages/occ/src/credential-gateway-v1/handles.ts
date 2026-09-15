export interface Bounds {
  readonly signal: AbortSignal;
  /** Absolute deadline in epoch milliseconds; owners enforce expiry. */
  readonly deadline: number;
}

/** Compile-time kind separation; runtime owners authenticate and enforce single use. */
declare const owner: unique symbol;
export type LocalHandle<K extends string> = { readonly [owner]: K };
export type AuthenticatedAccess = LocalHandle<"authenticated-access">;
export type RetainedCredential = LocalHandle<"retained-credential">;
export type CoreAuthenticationBinding = LocalHandle<"authentication-binding-v1">;
export type AdmittedServiceBinding = LocalHandle<"admitted-service-binding">;
export type AdmittedReceiver = LocalHandle<"admitted-receiver">;
export type ProtectedDerivedCapability = LocalHandle<"protected-derived-capability">;
export type DerivedRequest = LocalHandle<"derived-request">;
export type ProtectedUpstreamResponse = LocalHandle<"protected-upstream-response">;
export type DispatchPermit = LocalHandle<"dispatch-permit">;
export type ReceiptFinalization = LocalHandle<"receipt-finalization">;
export type BoundCredentialOperation = LocalHandle<"bound-credential-operation">;
export type ValidatedAdapterOperation = LocalHandle<"validated-adapter-operation">;
export type ValidatedSchemaValue = LocalHandle<"validated-schema-value">;
export type AdmissionCondition = LocalHandle<"admission-condition">;
export type AdmittedRootContext = LocalHandle<"admitted-root-context">;
export type AuthorizedClosure = LocalHandle<"authorized-closure">;
export type AdmittedConnection = LocalHandle<"admitted-connection">;
export type AdmittedCredentialSelection = LocalHandle<"admitted-credential-selection">;
export type ProtectedCredentialSource = LocalHandle<"protected-credential-source">;
export type RegisteredCredentialMechanism = LocalHandle<"registered-credential-mechanism">;
