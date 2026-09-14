import { Type } from "typebox";
import { Check } from "typebox/value";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { NamespaceId, SecretReference, Timestamp, ConfigurationGeneration } from "./api/common.ts";

export const RepositoryBindingId = Type.String({
  pattern: "^rb_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const NumericId = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const RepositoryBindingReferenceSchema = Type.Object(
  { kind: Type.Literal("repository_binding"), namespaceId: NamespaceId, id: RepositoryBindingId },
  { additionalProperties: false },
);
export const RepositoryAccessSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    repositories: Type.Array(
      Type.Object(
        {
          bindingRef: RepositoryBindingReferenceSchema,
          repositoryId: NumericId,
          checkoutRef: Type.String({ minLength: 1, maxLength: 256 }),
          readProfile: Type.Literal("checkout"),
          publication: Type.Object(
            { mode: Type.Literal("disabled") },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
      { maxItems: 8 },
    ),
  },
  { additionalProperties: false },
);
export type RepositoryAccess = Type.Static<typeof RepositoryAccessSchema>;
export const RepositoryBindingBody = Type.Object(
  {
    appId: NumericId,
    installationId: NumericId,
    repositoryIds: Type.Array(NumericId, { minItems: 1, maxItems: 32, uniqueItems: true }),
    keySecretRef: SecretReference,
  },
  { additionalProperties: false },
);
export const UpdateRepositoryBindingBody = Type.Object(
  { ...RepositoryBindingBody.properties, expectedGeneration: ConfigurationGeneration },
  { additionalProperties: false },
);
export type RepositoryBindingInput = Type.Static<typeof RepositoryBindingBody>;
export const RepositoryBindingSchema = Type.Object(
  {
    ...RepositoryBindingBody.properties,
    id: RepositoryBindingId,
    namespaceId: NamespaceId,
    generation: ConfigurationGeneration,
    state: Type.Literal("unverified"),
    createdAt: Timestamp,
  },
  { additionalProperties: false },
);
export type RepositoryBinding = Type.Static<typeof RepositoryBindingSchema>;

function validCheckoutRef(value: string): boolean {
  if (/^[0-9a-fA-F]{40}$/.test(value)) return true;
  if (
    !/^refs\/(heads|tags)\/.+/.test(value) ||
    value.length > 256 ||
    /[\x00-\x20\x7f-\x9f~^:?*\[\\]/.test(value) ||
    value.includes("..") ||
    value.includes("@{") ||
    value.endsWith(".")
  )
    return false;
  return value
    .split("/")
    .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}
export function normalizeRepositoryAccess(
  value: unknown = { schemaVersion: 1, repositories: [] },
): RepositoryAccess {
  if (!Check(RepositoryAccessSchema, value)) throw new Error("Repository access draft is invalid.");
  const keys = new Set<string>();
  for (const entry of value.repositories) {
    const key = `${entry.bindingRef.namespaceId}/${entry.bindingRef.id}/${entry.repositoryId}`;
    if (keys.has(key) || !validCheckoutRef(entry.checkoutRef))
      throw new Error(
        "Repository selections must be distinct and use a full commit or qualified Git branch/tag ref.",
      );
    keys.add(key);
  }
  return immutableCopy(value);
}
export function validRepositoryBinding(value: unknown): value is RepositoryBinding {
  return Check(RepositoryBindingSchema, value);
}

export function normalizeRepositoryBinding(value: unknown): RepositoryBindingInput {
  if (!Check(RepositoryBindingBody, value))
    throw new Error("Repository binding descriptor is invalid.");
  return immutableCopy(value);
}
