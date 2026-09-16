import type { DefinitionRef, RetainedSchemaValue, SchemaRef } from "./schema.ts";

export type AuthenticationMode = "protected-material" | "workload-transport" | "external-runtime";
export type AcquisitionMode = "issued" | "standing" | "exchange" | "refresh" | "workload";

/** Versioned descriptor; an implemented owner must admit the exact bridge. */
export interface MechanismContractRef<K extends string = string> {
  readonly name: K;
  readonly version: number;
  readonly digest: string;
}

/** Only an explicitly registered tuple can be admitted; descriptors grant no authority. */
export interface OperationCapability {
  readonly serviceId: string;
  readonly operationSchema: SchemaRef;
  readonly profileSchema: SchemaRef;
  readonly authenticationCapability: string;
  readonly authenticationMode: AuthenticationMode;
  readonly mechanism: MechanismContractRef;
  readonly acquisitionMode: AcquisitionMode;
  readonly invalidation: "per-credential" | "expiry-only" | "source-managed";
}

/**
 * Exact external attachment tuple for the runtime-authentication-v1 owner bridge.
 * The standing source remains externally owned; receiver withdrawal does not
 * establish per-credential revocation. Registration and live admission remain
 * required before an owner may attach a receiver; this descriptor grants no authority.
 */
export interface ExternalRuntimeAuthenticationCapabilityV1 extends OperationCapability {
  readonly authenticationMode: "external-runtime";
  readonly mechanism: MechanismContractRef<"runtime-authentication-v1"> & {
    readonly version: 1;
  };
  readonly acquisitionMode: "standing";
  readonly invalidation: "source-managed";
}

export interface BackendCapabilities {
  /** Exact tuples, rather than the Cartesian product of the descriptive indexes below. */
  readonly operationCapabilities: readonly OperationCapability[];
  readonly resourceSchemas: readonly SchemaRef[];
  readonly operationSchemas: readonly SchemaRef[];
  readonly credentialProfiles: readonly SchemaRef[];
  readonly authenticationModes: readonly AuthenticationMode[];
  readonly mechanisms: readonly MechanismContractRef[];
  readonly derivedRequests: "unsupported" | "protected-download-v1";
  readonly acquisitionModes: readonly AcquisitionMode[];
  readonly listResources: boolean;
  readonly invalidation: "per-credential" | "expiry-only" | "source-managed";
  readonly reconciliation: "provider-evidence" | "expiry-evidence-only";
  // token-issuer-v1 requires issued/per-credential semantics. Other descriptors
  // require actual lifecycle bridges before activation; no fake revoker fits them.
}

/** Safe facts; destination, audience, mapping and currentness require core admission. */
export interface ServiceBindingView {
  readonly serviceId: string;
  readonly destinationPolicyId: string;
  readonly audience: string;
  readonly authenticationCapability: string;
  readonly authenticationMode: AuthenticationMode;
  readonly resourceMappingId: string;
  readonly resourceMappingGeneration: string;
}

/** Configuration and discovery confer no access or authenticated principal. */
export interface CredentialConnection {
  readonly connectionId: string;
  readonly namespaceId: string;
  readonly generation: string;
  readonly definition: DefinitionRef;
  /** Verified upstream authority domain, rather than a display URL. */
  readonly upstreamInstanceId: string;
  /** Admitted endpoint, trust, DNS and egress policy. */
  readonly endpointPolicyId: string;
  readonly services: readonly ServiceBindingView[];
  readonly configuration: RetainedSchemaValue;
  // Protected source metadata uses the existing contracts SecretReference and
  // SecretBackendRef; this safe record contains no plaintext bootstrap material.
}

/** Versioned resource data; never hash this object to derive a canonical hold key. */
export interface ResourceIdentity {
  readonly upstreamInstanceId: string;
  readonly resourceSchema: SchemaRef;
  /** Provider-scoped opaque identifier; nested and case-sensitive IDs are valid data. */
  readonly canonicalResourceId: string;
}

/**
 * Sole canonical hold identity. Stable namespace/kind and authority distinguish
 * upstream resources; connection/configuration/key/package/schema revisions are
 * excluded. Core admits equivalence across aliases and upgrades and rejects an
 * unsupported remap instead of resetting outstanding holds or cleanup obligations.
 */
export interface CanonicalCredentialTargetIdentity {
  readonly upstreamInstanceId: string;
  readonly resourceNamespace: string;
  readonly resourceKind: string;
  readonly canonicalResourceId: string;
  readonly credentialAuthorityId: string;
}

export interface CredentialTarget {
  readonly resource: ResourceIdentity;
  readonly holdIdentity: CanonicalCredentialTargetIdentity;
}

export interface CredentialProfileRef {
  readonly schema: SchemaRef;
  readonly selection: RetainedSchemaValue;
  readonly selectionDigest: string;
}

/** Payload within an IAM-authorized OCE envelope using existing Scope/ResourceRef. */
export interface CredentialAccessGrant {
  readonly grantId: string;
  readonly connectionId: string;
  readonly connectionGeneration: string;
  readonly resource: ResourceIdentity;
  /** Explicit service/operation ceiling; service possession does not authorize dispatch. */
  readonly services: readonly ServiceBindingView[];
  readonly operations: RetainedSchemaValue;
  /**
   * Immutable selection: GitHub leases and replacement tokens retain this exact
   * profile, including write-profile metadata/fetch. Owners enforce equality.
   */
  readonly credentialProfile: CredentialProfileRef;
  /** Genuine Work/revision/execution owner record; caller IDs confer no authority. */
  readonly authorityBindingId: string;
  readonly expiresAt: number;
}

/** Provider observations require owner validation; they are not authenticated access. */
export interface CredentialObservation {
  readonly mode: Exclude<AcquisitionMode, "workload">;
  readonly actualScope: RetainedSchemaValue;
  readonly upstreamExpiry:
    { readonly kind: "known"; readonly expiresAt: number } | { readonly kind: "not-established" };
  readonly invalidation: BackendCapabilities["invalidation"];
  readonly upstreamState: "live" | "revoked" | "expired" | "unknown";
  // OCE grant validity, upstream expiry and observed revocation are independent.
  // Closing OCE authority does not establish upstream revocation or destroy a
  // standing source; refresh families retain their original source ownership.
}
