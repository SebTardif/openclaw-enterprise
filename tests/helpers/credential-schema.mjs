import { createHash } from "node:crypto";
import { CREDENTIAL_SCHEMA_PRIMITIVES_V1 as primitives } from "../../packages/occ/src/credential-broker-v1/schema-primitives.ts";

// Independent wire-vector construction: never call the production JSON/digest helpers.
// Keep literal expected strings/digests in the tests to check this vocabulary too.
export const canonical = (value) =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? "[" + value.map(canonical).join(",") + "]"
      : "{" +
        Object.keys(value)
          .sort()
          .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
          .join(",") +
        "}";
export const digest = (domain, payload) =>
  "sha256:" +
  createHash("sha256")
    .update(domain + "\0" + payload, "utf8")
    .digest("hex");
export const schemaDigest = (
  jsonSchema,
  maxBytes,
  maxDepth,
  canonicalization = primitives.canonicalization,
) =>
  digest(
    "oce-schema-recipe-v1",
    canonical({
      canonicalization,
      jsonSchema,
      maxBytes,
      maxDepth,
      profile: "oce-closed-draft7-v1",
    }),
  );
export function definitionFor(backendId = "github") {
  return {
    backendId,
    recipeId: "example-recipe",
    recipeVersion: 1,
    recipeDigest: "sha256:" + "a".repeat(64),
    contractVersion: "credential-backend-recipe-v1",
    interpreter: { ...primitives.interpreter },
  };
}
export function schemaRecipe(
  jsonSchema,
  {
    definition = definitionFor(),
    role = "operation",
    name = "facts",
    maxBytes = 1024,
    maxDepth = 8,
    canonicalization = primitives.canonicalization,
    ...overrides
  } = {},
) {
  return {
    binding: {
      definition: structuredClone(definition),
      role,
      schema: {
        namespace: definition.backendId,
        name,
        version: 1,
        digest: schemaDigest(jsonSchema, maxBytes, maxDepth, canonicalization),
      },
    },
    jsonSchema,
    maxBytes,
    maxDepth,
    canonicalization,
    ...overrides,
  };
}
export function retainedDigest(binding, canonicalJson) {
  // Literal payload key order is contractual, including full recipe/interpreter identity.
  return digest(
    "oce-schema-value-v1",
    '{"canonicalJson":' +
      JSON.stringify(canonicalJson) +
      ',"definition":' +
      canonical(binding.definition) +
      ',"role":' +
      JSON.stringify(binding.role) +
      ',"schema":' +
      canonical(binding.schema) +
      "}",
  );
}
export const objectSchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 5 },
    count: { type: "integer", minimum: 1, maximum: 3 },
    items: { type: "array", items: { type: "boolean" }, minItems: 1, maxItems: 2 },
  },
  required: ["name", "count", "items"],
  additionalProperties: false,
};

// Ajv switches additional-property strategies above eight fields and ignores
// declared __proto__ schemas. Cover both sides at every supported nesting position.
export function* protoCases() {
  for (const count of [8, 9])
    for (const required of [false, true]) {
      for (const placement of ["root", "nested-object", "array-item-object"]) {
        const properties = Object.fromEntries(
          Array.from({ length: count }, (_, i) => ["p" + i, { type: "boolean" }]),
        );
        const ordinary = Object.fromEntries(Object.keys(properties).map((key) => [key, true]));
        const leaf = (fields) => ({
          type: "object",
          properties: fields,
          ...(required ? { required: Object.keys(fields) } : {}),
          additionalProperties: false,
        });
        const placeSchema = (schema) =>
          placement === "root"
            ? schema
            : {
                type: "object",
                properties: {
                  payload:
                    placement === "nested-object"
                      ? schema
                      : { type: "array", items: schema, maxItems: 1 },
                },
                required: ["payload"],
                additionalProperties: false,
              };
        const placeValue = (value) =>
          placement === "root"
            ? value
            : { payload: placement === "nested-object" ? value : [value] };
        // Computed keys/JSON.parse create own data; literal __proto__ setter syntax would miss the regression.
        const forbiddenProperties = {
          ...properties,
          ["__proto__"]: { type: "integer", minimum: 1 },
        };
        const invalidLeaf = JSON.parse(canonical({ ...ordinary, ["__proto__"]: "INVALID-STRING" }));
        yield {
          name: `${placement}, ${count} ordinary fields, ${required ? "required" : "optional"}`,
          schema: placeSchema(leaf(properties)),
          forbidden: placeSchema(leaf(forbiddenProperties)),
          forbiddenProperties,
          good: placeValue(ordinary),
          invalid: placeValue(invalidLeaf),
          invalidLeaf,
        };
      }
    }
}
