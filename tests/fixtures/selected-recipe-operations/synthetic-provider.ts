/**
 * Invented test-only data for generic third-party schema registration. This is
 * not a provider contract, supported endpoint, authentication bridge or runtime.
 */
import { CREDENTIAL_SCHEMA_PRIMITIVES_V1 } from "@openclaw-enterprise/occ";
import type {
  DefinitionRef,
  SchemaRef,
  SchemaRegistration,
  SelectedRecipeOperationRowV1,
} from "@openclaw-enterprise/occ/internal/backend-recipe-operations-v1";

type RegistrationRow = Omit<
  SelectedRecipeOperationRowV1,
  "operationCodec" | "profileCodec" | "canonicalResource"
>;

const definition: DefinitionRef = {
  backendId: "example-archive",
  recipeId: "invented-record-inspection-v1",
  recipeVersion: 1,
  recipeDigest: "sha256:dd7597a96c94b6e9fb2e103866b846f1e9386d75101319a773b043a028a24084",
  contractVersion: "credential-backend-recipe-v1",
  interpreter: CREDENTIAL_SCHEMA_PRIMITIVES_V1.interpreter,
};
const resourceSchema: SchemaRef = {
  namespace: "example-archive",
  name: "invented-record-identity-v1",
  version: 1,
  digest: "sha256:45eec0da85764e815942eb3324f72e01fd6816dcb6d0ea086401e3426e695d46",
};
export const syntheticArchiveResourcePolicyEncodingV1 = {
  prefix: "credential-resource-v1",
  resourceNamespace: "example-archive",
  resourceKind: "document",
  resourceSchema,
} as const;

const operationRegistration: SchemaRegistration = {
  binding: {
    definition,
    role: "operation",
    schema: {
      namespace: "example-archive",
      name: "invented-inspect-record-input-v1",
      version: 1,
      digest: "sha256:71883ae901871a0ce8bb14f952030de99f988b3237141b07f1d193df0093c3cc",
    },
  },
  jsonSchema: {
    type: "object",
    properties: {
      kind: { type: "string", const: "json-read", maxLength: 32 },
      accessProfile: { type: "string", const: "read", maxLength: 16 },
      target: {
        type: "object",
        properties: {
          upstreamInstanceId: { type: "string", minLength: 1, maxLength: 256 },
          canonicalResourceId: { type: "string", minLength: 1, maxLength: 1024 },
          resourceSchema: {
            type: "object",
            properties: {
              namespace: { type: "string", const: resourceSchema.namespace, maxLength: 64 },
              name: { type: "string", const: resourceSchema.name, maxLength: 64 },
              version: { type: "integer", const: 1 },
              digest: { type: "string", const: resourceSchema.digest, maxLength: 71 },
            },
            required: ["namespace", "name", "version", "digest"],
            additionalProperties: false,
          },
        },
        required: ["upstreamInstanceId", "canonicalResourceId", "resourceSchema"],
        additionalProperties: false,
      },
    },
    required: ["kind", "accessProfile", "target"],
    additionalProperties: false,
  },
  maxBytes: 4096,
  maxDepth: 4,
  canonicalization: CREDENTIAL_SCHEMA_PRIMITIVES_V1.canonicalization,
};
const profileRegistration: SchemaRegistration = {
  binding: {
    definition,
    role: "credential-profile",
    schema: {
      namespace: "example-archive",
      name: "invented-catalog-inspector-v1",
      version: 1,
      digest: "sha256:9b6e98b058073f0691459e2c6871e6d6567df56ef908d63b9889d944cf6ca1b6",
    },
  },
  jsonSchema: {
    type: "object",
    properties: {
      accessProfile: { type: "string", const: "read", maxLength: 16 },
      tokenProfile: { type: "string", const: "example-issued-read", maxLength: 48 },
      permissions: {
        type: "object",
        properties: {
          catalog: { type: "string", const: "inspect", maxLength: 16 },
        },
        required: ["catalog"],
        additionalProperties: false,
      },
    },
    required: ["accessProfile", "tokenProfile", "permissions"],
    additionalProperties: false,
  },
  maxBytes: 512,
  maxDepth: 2,
  canonicalization: CREDENTIAL_SCHEMA_PRIMITIVES_V1.canonicalization,
};

export const syntheticArchiveOperationRegistrationsV1: readonly RegistrationRow[] = [
  {
    definition,
    operationRegistration,
    profileRegistration,
    serviceId: "example-archive.documents",
    exactAction: "credential.example-archive.documents.inspect-record.v1",
    operation: {
      operationId: "inspect-record-v1",
      capability: {
        serviceId: "example-archive.documents",
        operationSchema: operationRegistration.binding.schema,
        profileSchema: profileRegistration.binding.schema,
        authenticationCapability: "example-test-issued-token-v1",
        authenticationMode: "protected-material",
        mechanism: {
          name: "token-issuer-v1",
          version: 1,
          digest: "sha256:2a4c695061219d58c3a7fa979fa4f97952c5e03dd3fd08538515f9f651ed292e",
        },
        acquisitionMode: "issued",
        invalidation: "per-credential",
      },
      inputSchema: operationRegistration.binding.schema,
      outputSchema: operationRegistration.binding.schema,
      execution: {
        primitive: {
          name: "example-test-json-read-v1",
          version: 1,
          digest: "sha256:563e7db09032a4a09102e1b0f513ff33ee6a3f2531d97e3837cb2007bfc3f587",
        },
        parameters: {
          method: "GET",
          path: [{ constant: "records" }],
          projection: [
            { from: ["kind"], to: "kind" },
            { from: ["accessProfile"], to: "accessProfile" },
            { from: ["target"], to: "target" },
          ],
        },
      },
      maxRequests: 1,
      maxRequestBytes: 2048,
      maxResponseBytes: 8192,
      deadlineMs: 5000,
    },
  },
];

export function sampleOperationData(opaqueId = "Shelf/Example-Record") {
  return {
    kind: "json-read",
    accessProfile: "read",
    target: {
      upstreamInstanceId: "example-test-archive-instance-A",
      canonicalResourceId: opaqueId,
      resourceSchema: { ...resourceSchema },
    },
  };
}
export function sampleProfileData() {
  return {
    accessProfile: "read",
    tokenProfile: "example-issued-read",
    permissions: { catalog: "inspect" },
  };
}

function freezeData(value: object): void {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object" && !Object.isFrozen(child)) freezeData(child);
  }
  Object.freeze(value);
}
freezeData(syntheticArchiveOperationRegistrationsV1);
freezeData(syntheticArchiveResourcePolicyEncodingV1);
