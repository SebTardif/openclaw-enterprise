import { createHash } from "node:crypto";
import type {
  GitHubOperation,
  GitHubRepositorySelection,
  GitHubRequestId,
  GitHubFactsDigest,
  GitHubBodyDigest,
} from "./github-operations.ts";

export type GitHubMetadataRepositoryV1 = Pick<
  GitHubRepositorySelection,
  | "repository"
  | "appId"
  | "installationId"
  | "repositoryId"
  | "canonicalOwner"
  | "canonicalName"
  | "bindingGeneration"
>;

export type GitHubMetadataOperationV1 = GitHubOperation & {
  readonly kind: "metadata";
  readonly target: {
    readonly repository: GitHubMetadataRepositoryV1;
    readonly host: "api.github.com";
    readonly method: "GET";
    readonly pathAndQuery: string;
  };
};

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
const DECIMAL = /^[1-9][0-9]{0,15}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function segment(value: unknown): value is string {
  return typeof value === "string" && SEGMENT.test(value) && value !== "." && value !== "..";
}

function decimal(value: unknown): value is string {
  if (typeof value !== "string" || !DECIMAL.test(value)) return false;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === value;
}

// These refinements describe validated/computed DATA, never authorization.
function requestIdentity(value: unknown): value is GitHubRequestId {
  return typeof value === "string" && UUID.test(value);
}

function bodyHash(value: string): value is GitHubBodyDigest {
  return SHA256.test(value);
}

function factsHash(value: string): value is GitHubFactsDigest {
  return SHA256.test(value);
}

/** Own one validated snapshot. Every required caller property is read once. */
function snapshotRepository(
  input: Readonly<GitHubMetadataRepositoryV1>,
): Readonly<GitHubMetadataRepositoryV1> | null {
  if (input === null || typeof input !== "object") return null;
  const {
    appId,
    installationId,
    repositoryId,
    canonicalOwner,
    canonicalName,
    bindingGeneration,
    repository: resource,
  } = input;
  if (
    !decimal(appId) ||
    !decimal(installationId) ||
    !decimal(repositoryId) ||
    !segment(canonicalOwner) ||
    !segment(canonicalName) ||
    !text(bindingGeneration) ||
    resource === null ||
    typeof resource !== "object"
  )
    return null;
  const {
    upstreamInstanceId,
    canonicalResourceId,
    resourceSchema: schema,
    canonicalPathSegments: segments,
  } = resource;
  if (
    !text(upstreamInstanceId) ||
    !text(canonicalResourceId) ||
    schema === null ||
    typeof schema !== "object" ||
    !Array.isArray(segments)
  )
    return null;
  const length = segments.length;
  const owner = segments[0];
  const nameSegment = segments[1];
  if (length !== 2 || owner !== canonicalOwner || nameSegment !== canonicalName) return null;
  const { namespace, name, version, digest } = schema;
  if (
    !text(namespace) ||
    !text(name) ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !text(digest)
  )
    return null;
  return Object.freeze({
    appId,
    installationId,
    repositoryId,
    canonicalOwner,
    canonicalName,
    bindingGeneration,
    repository: Object.freeze({
      upstreamInstanceId,
      canonicalResourceId,
      resourceSchema: Object.freeze({ namespace, name, version, digest }),
      canonicalPathSegments: Object.freeze([canonicalOwner, canonicalName]),
    }),
  });
}

/**
 * Construct immutable candidate metadata DATA. This performs no HTTP inspection,
 * schema admission, authority decision, credential acquisition or dispatch.
 */
export function createGitHubMetadataOperationV1(
  repository: Readonly<GitHubMetadataRepositoryV1>,
  requestId: string,
): Readonly<GitHubMetadataOperationV1> | null {
  try {
    if (!requestIdentity(requestId)) return null;
    const selected = snapshotRepository(repository);
    if (!selected) return null;
    const target = Object.freeze({
      repository: selected,
      host: "api.github.com" as const,
      method: "GET" as const,
      pathAndQuery: `/repos/${selected.canonicalOwner}/${selected.canonicalName}`,
    });
    const bodyDigest = createHash("sha256").update(new Uint8Array()).digest("hex");
    if (!bodyHash(bodyDigest)) return null;
    // Preserve the original owner's complete positional encoding and field order.
    const facts = JSON.stringify([
      "oce.github-metadata-facts.v1",
      requestId,
      "metadata",
      target.host,
      target.method,
      target.pathAndQuery,
      selected.appId,
      selected.installationId,
      selected.repositoryId,
      selected.canonicalOwner,
      selected.canonicalName,
      selected.bindingGeneration,
      selected.repository.upstreamInstanceId,
      selected.repository.canonicalResourceId,
      selected.repository.canonicalPathSegments,
      selected.repository.resourceSchema.namespace,
      selected.repository.resourceSchema.name,
      selected.repository.resourceSchema.version,
      selected.repository.resourceSchema.digest,
      ["body", 0, bodyDigest],
      ["content-encoding", "identity"],
      ["trailers", false],
    ]);
    const factsDigest = createHash("sha256").update(facts).digest("hex");
    if (!factsHash(factsDigest)) return null;
    return Object.freeze({ kind: "metadata", requestId, target, bodyDigest, factsDigest });
  } catch {
    return null;
  }
}
