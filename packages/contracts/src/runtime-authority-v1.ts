/**
 * Local contract for an Agent execution's initial binding and exact operation readback.
 * Schemas describe records; parsers validate and freeze them; canonicalization gives
 * persistence a stable payload to compare on replay. The OCC repository owns state
 * transitions and transactions. Callers must separately establish permission and
 * observation provenance. See docs/reference/runtime-authority/contract.md.
 */
import { type TSchema } from "typebox";
import { Check } from "typebox/value";
import {
  RuntimeAuthoritySchemasV1,
  type BindingResultV1,
  type RuntimeAuthoritySchemaNameV1,
  type RuntimeAuthorityValueV1,
  type RuntimeMutationV1,
} from "./runtime-authority-v1/schemas.ts";
import {
  canonicalJson,
  freezeJsonData,
  parseJson,
  reject,
  RuntimeAuthorityValidationError,
  snapshotJsonData,
} from "./runtime-authority-v1/json.ts";
import { validateRuntimeAuthority } from "./runtime-authority-v1/validation.ts";

export * from "./runtime-authority-v1/schemas.ts";

/** Decode an object at the persistence boundary without retaining caller-owned data. */
export function parseRuntimeAuthorityV1<K extends RuntimeAuthoritySchemaNameV1>(
  kind: K,
  input: unknown,
): RuntimeAuthorityValueV1<K> {
  try {
    if (!Object.hasOwn(RuntimeAuthoritySchemasV1, kind)) reject("unsupported schema kind");
    const snapshot = snapshotJsonData(input);
    if (!Check(RuntimeAuthoritySchemasV1[kind] as TSchema, snapshot))
      reject(`value does not match the ${kind} schema`);
    const value = snapshot as RuntimeAuthorityValueV1<K>;
    validateRuntimeAuthority(kind, value);
    return freezeJsonData(value);
  } catch (error) {
    if (error instanceof RuntimeAuthorityValidationError) throw error;
    return reject();
  }
}

/**
 * Decode raw JSON before duplicate keys or rounded numeric literals can be lost.
 * The current repositories use the object parser; this decoder has contract tests
 * and does not expose an HTTP endpoint or perform admission.
 */
export function parseRuntimeAuthorityJsonV1<K extends RuntimeAuthoritySchemaNameV1>(
  kind: K,
  input: string,
): RuntimeAuthorityValueV1<K> {
  try {
    return parseRuntimeAuthorityV1(kind, parseJson(input));
  } catch (error) {
    if (error instanceof RuntimeAuthorityValidationError) throw error;
    return reject("malformed JSON");
  }
}

type MutationResults = {
  bind: BindingResultV1;
};

/** Method-specific decoding rejects a well-formed receipt for another mutation method. */
export function parseRuntimeMutationResultV1<K extends keyof MutationResults>(
  method: K,
  input: unknown,
): MutationResults[K] {
  if (method !== "bind") reject("unsupported mutation method");
  const result = parseRuntimeAuthorityV1("mutationResult", input);
  if ("receipt" in result && result.receipt.operationKind !== method)
    reject("receipt operation kind must match the mutation method");
  if (result.result === "commit-unknown" && result.operation.operationKind !== method)
    reject("readback operation kind must match the mutation method");
  return result as MutationResults[K];
}

/**
 * Return the exact UTF-8 payload the repository hashes with SHA-256 for replay.
 * Only request correlation is excluded; operation ID, expected versions and effect
 * data remain. Equality neither retries an effect nor authorizes an operation.
 */
export function canonicalRuntimeAuthorityMutationV1(input: RuntimeMutationV1): string {
  const { requestRef: _requestRef, ...payload } = parseRuntimeAuthorityV1("mutation", input);
  return canonicalJson(payload);
}

/** One original service-context identity, supplied by the selected trusted runtime owner.
 * This nominal type prevents accidental DATA use; it does not authenticate a transport.
 */
declare const trustedRuntimeService: unique symbol;
export interface RuntimeAuthorityTrustedContextV1 {
  readonly [trustedRuntimeService]: true;
  readonly schemaVersion: 1;
}

export interface RuntimeAuthorityCallBoundsV1 {
  readonly requestRef: string;
  readonly recipientRef: string;
  /** Absolute canonical UTC cutoff. The owner also applies its trusted monotonic clock;
   * authority lookup must finish within the remaining deadline and lookupMaxMs.
   */
  readonly deadline: string;
  readonly signal: AbortSignal;
}

export interface AuthorityCallV1 extends RuntimeAuthorityCallBoundsV1 {
  readonly context: RuntimeAuthorityTrustedContextV1;
}
