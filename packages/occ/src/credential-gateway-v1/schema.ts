import type { JSONSchema } from "@openclaw-enterprise/contracts";
import type { LocalHandle, ValidatedSchemaValue } from "./handles.ts";

export interface DefinitionRef {
  readonly backendId: string;
  readonly packageName: string;
  /** Exact installed package version, rather than a version range. */
  readonly packageVersion: string;
  readonly packageIntegrity: string;
  readonly contractVersion: "credential-backend-v1";
}

export interface SchemaRef {
  readonly namespace: string;
  readonly name: string;
  readonly version: number;
  readonly digest: string;
}

/**
 * Bounded, nonsecret data rather than authority or a serialized handle.
 * Owners verify canonical encoding, identity, version and digests on restore.
 * Bearers, signed URLs and reusable download locators are never safe values.
 */
export interface RetainedSchemaValue {
  readonly definition: DefinitionRef;
  readonly role: SchemaRole;
  readonly schema: SchemaRef;
  readonly canonicalJson: string;
  readonly digest: string;
}

/** Candidate data; owners enforce JSON closure, finite numbers and nonsecret content. */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type SchemaRole =
  | "configuration"
  | "resource"
  | "operation"
  | "credential-profile"
  | "observation"
  | "evidence"
  | "locator"
  | "cursor";

export interface SchemaBinding {
  readonly definition: DefinitionRef;
  readonly role: SchemaRole;
  readonly schema: SchemaRef;
}

export interface SchemaRegistration {
  readonly binding: SchemaBinding;
  /** Core admits a closed schema and finite positive limits before invoking the hook. */
  readonly jsonSchema: JSONSchema;
  readonly maxBytes: number;
  readonly maxDepth: number;
  /**
   * Returns ordinary nonsecret data. Core validates before and after this hook,
   * then canonicalizes, copies/freezes and computes digests before issuing a handle.
   */
  validateAndCanonicalize(candidate: JsonValue): JsonValue;
}

/**
 * Core authenticates the exact definition, role and schema for every handle.
 * Same-kind values from another codec require runtime rejection.
 */
export interface RegisteredSchemaCodec extends LocalHandle<"registered-schema-codec"> {
  readonly binding: SchemaBinding;
  validate(input: unknown): ValidatedSchemaValue;
  retain(value: ValidatedSchemaValue): RetainedSchemaValue;
  /** Core also checks encoding, bounds, semantic validity, version and digests. */
  restore(value: RetainedSchemaValue): ValidatedSchemaValue;
}

/** Scoped to admitted installed definitions; core rejects duplicate/incompatible bindings. */
export interface SchemaRegistrationOwner {
  register(registration: SchemaRegistration): RegisteredSchemaCodec;
}
