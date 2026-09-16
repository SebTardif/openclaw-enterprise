import type { JSONSchema } from "@openclaw-enterprise/contracts";
import type { LocalHandle, ValidatedSchemaValue } from "./handles.ts";

/** Data identity of an exact reviewed implementation installed by trusted core. */
export interface PrimitiveRef {
  readonly name: string;
  readonly version: number;
  readonly digest: string;
}

export interface DefinitionRef {
  readonly backendId: string;
  readonly recipeId: string;
  readonly recipeVersion: number;
  readonly recipeDigest: string;
  readonly contractVersion: "credential-backend-recipe-v1";
  readonly interpreter: PrimitiveRef;
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
  /** Core admits a closed schema and finite positive limits before interpretation. */
  readonly jsonSchema: JSONSchema;
  readonly maxBytes: number;
  readonly maxDepth: number;
  /** Data only: the core selects the exact reviewed installed implementation. */
  readonly canonicalization: PrimitiveRef;
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
