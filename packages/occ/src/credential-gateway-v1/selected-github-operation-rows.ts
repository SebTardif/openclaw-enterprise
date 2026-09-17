import type { JSONSchema } from "@openclaw-enterprise/contracts";
import type { AccessProfile, GitHubOperation } from "./github-operations.ts";
import type { DefinitionRef, SchemaRef, SchemaRegistration } from "./schema.ts";
import type { SelectedRecipeOperationRegistrationV1 } from "./selected-recipe-operations-contract.ts";
import { CREDENTIAL_SCHEMA_PRIMITIVES_V1 } from "../credential-broker-v1/schema-primitives.ts";

type RegistrationRow = SelectedRecipeOperationRegistrationV1;

const definition: DefinitionRef = Object.freeze({
  backendId: "github",
  recipeId: "github-selected-repository-v1",
  recipeVersion: 1,
  recipeDigest: "sha256:fb20fb847438972c6b8d6cc0e0dfb9c90f4ee54315ef3d4cab0afd5ea8c729c4",
  contractVersion: "credential-backend-recipe-v1",
  interpreter: CREDENTIAL_SCHEMA_PRIMITIVES_V1.interpreter,
});
const resourceSchema: SchemaRef = Object.freeze({
  namespace: "github",
  name: "repository-resource-v1",
  version: 1,
  digest: "sha256:12e7cc6320d39b6f8a25298ad16fbc47b80674aea44d5e8d67a1bf9544ac3008",
});
/** Stable policy identity; schema version/digest are checked before encoding. */
export const githubResourcePolicyEncodingV1 = Object.freeze({
  prefix: "credential-resource-v1",
  resourceNamespace: "github",
  resourceKind: "repository",
  resourceSchema,
});
const resourceJsonSchema: JSONSchema = {
  type: "object",
  properties: {
    upstreamInstanceId: {
      type: "string",
      minLength: 1,
      maxLength: 256,
    },
    canonicalResourceId: {
      type: "string",
      minLength: 1,
      maxLength: 1024,
    },
    resourceSchema: {
      type: "object",
      properties: {
        namespace: {
          type: "string",
          const: "github",
          maxLength: 256,
        },
        name: {
          type: "string",
          const: "repository-resource-v1",
          maxLength: 256,
        },
        version: {
          type: "integer",
          const: 1,
        },
        digest: {
          type: "string",
          const: "sha256:12e7cc6320d39b6f8a25298ad16fbc47b80674aea44d5e8d67a1bf9544ac3008",
          maxLength: 256,
        },
      },
      required: ["namespace", "name", "version", "digest"],
      additionalProperties: false,
    },
  },
  required: ["upstreamInstanceId", "canonicalResourceId", "resourceSchema"],
  additionalProperties: false,
};
const readProfile: SchemaRegistration = {
  binding: {
    definition: definition,
    role: "credential-profile",
    schema: {
      namespace: "github",
      name: "repository-read-v1",
      version: 1,
      digest: "sha256:f94883ca2ba4ca28d91b3cbf1a46f6a9352e5157d94e258ce2471b5a75ef63e5",
    },
  },
  jsonSchema: {
    type: "object",
    properties: {
      accessProfile: {
        type: "string",
        const: "read",
        maxLength: 32,
      },
      tokenProfile: {
        type: "string",
        const: "repository-read-v1",
        maxLength: 64,
      },
      permissions: {
        type: "object",
        properties: {
          metadata: {
            type: "string",
            const: "read",
            maxLength: 16,
          },
          contents: {
            type: "string",
            const: "read",
            maxLength: 16,
          },
        },
        required: ["metadata", "contents"],
        additionalProperties: false,
      },
    },
    required: ["accessProfile", "tokenProfile", "permissions"],
    additionalProperties: false,
  },
  maxBytes: 1024,
  maxDepth: 2,
  canonicalization: CREDENTIAL_SCHEMA_PRIMITIVES_V1.canonicalization,
};
const writeProfile: SchemaRegistration = {
  binding: {
    definition: definition,
    role: "credential-profile",
    schema: {
      namespace: "github",
      name: "repository-write-v1",
      version: 1,
      digest: "sha256:7956a4fe0cf0e1f649cee63857476d513307b093e11abd9aaceb5617a0d11950",
    },
  },
  jsonSchema: {
    type: "object",
    properties: {
      accessProfile: {
        type: "string",
        const: "read-write",
        maxLength: 32,
      },
      tokenProfile: {
        type: "string",
        const: "repository-write-v1",
        maxLength: 64,
      },
      permissions: {
        type: "object",
        properties: {
          metadata: {
            type: "string",
            const: "read",
            maxLength: 16,
          },
          contents: {
            type: "string",
            const: "write",
            maxLength: 16,
          },
          pull_requests: {
            type: "string",
            const: "write",
            maxLength: 16,
          },
        },
        required: ["metadata", "contents", "pull_requests"],
        additionalProperties: false,
      },
    },
    required: ["accessProfile", "tokenProfile", "permissions"],
    additionalProperties: false,
  },
  maxBytes: 1024,
  maxDepth: 2,
  canonicalization: CREDENTIAL_SCHEMA_PRIMITIVES_V1.canonicalization,
};
const executionPrimitive = Object.freeze({
  name: "github-operation-v1",
  version: 1,
  digest: "sha256:9a0b6e51c6672341de444d20c342dc890ca3a46a00633751290471337ded7654",
});
/** Fixed catalog assembly only. No registration, interpretation or dispatch occurs here. */
function row(
  kind: GitHubOperation["kind"],
  accessProfile: AccessProfile,
  schemaDigest: string,
): RegistrationRow {
  const profileRegistration = accessProfile === "read" ? readProfile : writeProfile;
  const operationRegistration: SchemaRegistration = {
    binding: {
      definition,
      role: "operation",
      schema: {
        namespace: "github",
        name: `${kind}-${accessProfile}-v1`,
        version: 1,
        digest: schemaDigest,
      },
    },
    jsonSchema: {
      type: "object",
      properties: {
        kind: { type: "string", const: kind, maxLength: 64 },
        accessProfile: { type: "string", const: accessProfile, maxLength: 32 },
        resource: resourceJsonSchema,
      },
      required: ["kind", "accessProfile", "resource"],
      additionalProperties: false,
    },
    maxBytes: 4096,
    maxDepth: 4,
    canonicalization: CREDENTIAL_SCHEMA_PRIMITIVES_V1.canonicalization,
  };
  const serviceId = "github.repository";
  return {
    definition,
    operationRegistration,
    profileRegistration,
    serviceId,
    exactAction: `credential.github.repository.${kind}.v1`,
    operation: {
      operationId: `${kind}-${accessProfile}-v1`,
      capability: {
        serviceId,
        operationSchema: operationRegistration.binding.schema,
        profileSchema: profileRegistration.binding.schema,
        authenticationCapability: "github-app-installation-token-v1",
        authenticationMode: "protected-material",
        mechanism: { name: "token-issuer-v1", version: 1, digest: executionPrimitive.digest },
        acquisitionMode: "issued",
        invalidation: "per-credential",
      },
      inputSchema: operationRegistration.binding.schema,
      outputSchema: operationRegistration.binding.schema,
      execution: { primitive: executionPrimitive, parameters: { kind, accessProfile } },
      maxRequests: 1,
      maxRequestBytes: 8388608,
      maxResponseBytes: 8388608,
      deadlineMs: 30000,
    },
  };
}
/** Finite original-owner DATA. Read-write metadata/fetch retain the write profile. */
export const githubOperationRegistrationsV1: readonly RegistrationRow[] = [
  row(
    "metadata",
    "read",
    "sha256:b18b33ec2b08e8a6dcb477d99fb349b68406e52b1353aac75e10b0fc854f976f",
  ),
  row(
    "fetch-discovery",
    "read",
    "sha256:e4a56f21dd120bd9acb36fa1f200a9c827de579cdc14c6600381c2cd994cc7d6",
  ),
  row("fetch", "read", "sha256:77fa80666b88099e443c6dbd3ea35f59bc5335c7027c6fc441fb55adf843693f"),
  row(
    "metadata",
    "read-write",
    "sha256:d34bc6a0020dc1a12d851b15622d54f4deceb7fcded69974a5ffdd420d8b0c7c",
  ),
  row(
    "fetch-discovery",
    "read-write",
    "sha256:2c22ede201e5194c75f19b5c892805294b26c854504e9e5264cf58f8f17c85b8",
  ),
  row(
    "fetch",
    "read-write",
    "sha256:66606cbd934696a9c953cd428e624e46446c8b873b23664bbf5ba54b0c64b5e9",
  ),
  row(
    "push-discovery",
    "read-write",
    "sha256:dd3e0c21bee4254c984c5893afb60edf0abebf8ac70148aa58b22cce99afb2cf",
  ),
  row(
    "push-probe",
    "read-write",
    "sha256:71500f5d7b8ffb92d63f5aa51e42a26fe7ef30d6da62891e35ce67ecd519ff4b",
  ),
  row(
    "push",
    "read-write",
    "sha256:fd224fdc16c27143fccaea6f79582a48b8e434dbea0b1843bebceb3623254a6f",
  ),
  row(
    "pull-request-create",
    "read-write",
    "sha256:22aed913c185157a164b9a9aae6b24ba2d2174665865f61dfb325f7c11d97707",
  ),
];
function freezeData(value: object): void {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object" && !Object.isFrozen(child)) freezeData(child);
  }
  Object.freeze(value);
}
freezeData(githubOperationRegistrationsV1);
