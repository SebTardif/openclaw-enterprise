import { createHash } from "node:crypto";
import { types } from "node:util";
import type {
  GitHubOperation,
  GitHubRequestId,
  GitHubClientOperationId,
  GitHubBodyDigest,
  GitHubFactsDigest,
  GitHubCreationDigest,
  RefUpdate,
} from "./github-operations.ts";
import type { GitHubMetadataRepositoryV1 } from "./github-metadata.ts";

export type GitHubFetchOperationV1 = GitHubOperation &
  (
    | {
        readonly kind: "fetch-discovery";
        readonly target: {
          readonly repository: GitHubMetadataRepositoryV1;
          readonly host: "github.com";
          readonly method: "GET";
          readonly pathAndQuery: string;
        };
      }
    | {
        readonly kind: "fetch";
        readonly target: {
          readonly repository: GitHubMetadataRepositoryV1;
          readonly host: "github.com";
          readonly method: "POST";
          readonly pathAndQuery: string;
        };
      }
  );

export type GitHubPrCreateOperationV1 = Extract<
  GitHubOperation,
  { readonly kind: "pull-request-create" }
> & {
  readonly target: {
    readonly repository: GitHubMetadataRepositoryV1;
    readonly host: "api.github.com";
    readonly method: "POST";
    readonly pathAndQuery: string;
  };
};

/** Result observation needs destination names and capabilities, never dispatch authority. */
export type GitHubPushResultInputV1 = Readonly<{
  kind: "push";
  updates: readonly Readonly<Pick<RefUpdate, "refName">>[];
  capabilities: readonly string[];
}>;

/** Immutable protocol facts; runtime owners still validate and admit operations. */
export type GitHubProtocolRepositoryV1 = Readonly<GitHubMetadataRepositoryV1>;

interface ProtocolOperationFacts {
  readonly requestId: string;
  readonly factsDigest: string;
}

type ProtocolTarget<H extends "github.com" | "api.github.com", M extends "GET" | "POST"> = {
  readonly repository: GitHubProtocolRepositoryV1;
  readonly host: H;
  readonly method: M;
  readonly pathAndQuery: string;
};

/** Each kind is a separate member so consumers can extract its exact facts. */
export type GitHubProtocolOperationV1 =
  | (ProtocolOperationFacts & {
      readonly kind: "metadata";
      readonly target: ProtocolTarget<"api.github.com", "GET">;
      readonly bodyDigest: string;
    })
  | (ProtocolOperationFacts & {
      readonly kind: "fetch-discovery";
      readonly target: ProtocolTarget<"github.com", "GET">;
      readonly bodyDigest: string;
    })
  | (ProtocolOperationFacts & {
      readonly kind: "fetch";
      readonly target: ProtocolTarget<"github.com", "POST">;
      readonly bodyDigest: string;
    })
  | (ProtocolOperationFacts & {
      readonly kind: "push-discovery";
      readonly target: ProtocolTarget<"github.com", "GET">;
      readonly bodyDigest: string;
    })
  | (ProtocolOperationFacts & {
      readonly kind: "push-probe";
      readonly target: ProtocolTarget<"github.com", "POST">;
      readonly bodyDigest: string;
    })
  | (ProtocolOperationFacts & {
      readonly kind: "push";
      readonly target: ProtocolTarget<"github.com", "POST">;
      readonly objectFormat: "sha1";
      readonly updates: readonly {
        readonly refName: string;
        readonly oldOid: string;
        readonly newOid: string;
        readonly change: "create" | "update" | "delete";
      }[];
      readonly capabilities: readonly string[];
      readonly pushOptions: readonly string[];
      readonly prefixDigest: string;
      readonly prefixBytes: number;
      readonly requiresPack: boolean;
    })
  | (ProtocolOperationFacts & {
      readonly kind: "pull-request-create";
      readonly target: ProtocolTarget<"api.github.com", "POST">;
      readonly clientOperationId: string;
      readonly input: GitHubPrCreateOperationV1["input"];
      readonly apiVersion: "2026-03-10";
      readonly bodyDigest: string;
      readonly creationDigest: string;
    });

export type GitHubPushOperationV1 = Extract<
  GitHubProtocolOperationV1,
  { readonly kind: "push-discovery" | "push-probe" | "push" }
>;

export type PreSubmissionFailure =
  | { readonly status: 401; readonly code: "unauthenticated" }
  | { readonly status: 403; readonly code: "closed" | "forbidden" }
  | { readonly status: 400 | 415; readonly code: "unsupported-request" }
  | { readonly status: 413 | 431 | 429; readonly code: "limit-exceeded" }
  | { readonly status: 408; readonly code: "deadline" }
  | { readonly status: 503; readonly code: "unavailable" };

export type RequestFailure =
  | PreSubmissionFailure
  | { readonly status: 503; readonly code: "indeterminate" }
  | { readonly status: 409; readonly code: "operation-id-conflict" };

export type HTTPResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | ({ readonly kind: "error"; readonly receiptId?: string } & RequestFailure);

export type Result<T> = HTTPResult<T>;

export interface BodyEvidence {
  readonly decodedBytes: number;
  readonly wireBytes: number;
  readonly sha256: string;
  readonly coverage: "complete" | "partial";
}

export interface RefResult {
  readonly requestedRef: string;
  readonly status: "ok" | "rejected" | "unknown";
  readonly reportedRef?: string;
  readonly reportedOldOid?: string;
  readonly reportedNewOid?: string;
  readonly reportedForcedUpdate?: boolean;
}

export interface PullRequestRefObservation {
  readonly repositoryId: string;
  readonly ref: string;
  readonly sha: string;
}

export interface SafePullRequest {
  readonly id: string;
  readonly number: number;
  readonly url: string;
  readonly state: "open";
  readonly draft: boolean;
  readonly head: PullRequestRefObservation;
  readonly base: PullRequestRefObservation;
}

export type ProviderRefusalStatus = 400 | 401 | 403 | 404 | 410 | 422 | 429;

/** Receipt DATA is distinct from the provider's pr-created observation. */
export type GitHubPrCreationResultV1 =
  | {
      readonly kind: "created";
      readonly operationId: string;
      readonly receiptId: string;
      readonly pullRequest: SafePullRequest;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "in-progress" | "unknown";
      readonly operationId: string;
      readonly receiptId: string;
    }
  | ({
      readonly kind: "not-submitted";
      readonly operationId: string;
      readonly receiptId: string;
    } & PreSubmissionFailure)
  | {
      readonly kind: "refused";
      readonly operationId: string;
      readonly receiptId: string;
      readonly status: ProviderRefusalStatus;
      readonly code: "provider-refused";
    };

export type GitHubExchangeOutcomeV1 =
  | ({ readonly kind: "not-submitted" } & PreSubmissionFailure)
  | { readonly kind: "local-probe" }
  | {
      readonly kind: "read-complete";
      readonly status: number;
      readonly responseBytes: number;
    }
  | { readonly kind: "provider-rejected"; readonly status: number }
  | { readonly kind: "pr-created"; readonly status: 201; readonly pullRequest: SafePullRequest }
  | {
      readonly kind: "push-report";
      readonly status: number;
      readonly unpack: "ok" | "rejected" | "unknown";
      readonly refs: readonly RefResult[];
      readonly upload: BodyEvidence;
      readonly reportComplete: boolean;
    }
  | {
      readonly kind: "unknown";
      readonly stage: "submission" | "upload" | "response" | "receipt-commit";
      readonly upload?: BodyEvidence;
      readonly refs?: readonly RefResult[];
      readonly observedPullRequest?: SafePullRequest;
    };

// Reject trailing newlines and other suffixes that the $ anchor alone permits.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/;
const SHA256 = /^[0-9a-f]{64}$(?![\s\S])/;
const DECIMAL = /^[1-9][0-9]{0,31}$(?![\s\S])/;
const BODY_LIMIT = 1048576;

function requestIdentity(value: unknown): value is GitHubRequestId {
  return typeof value === "string" && UUID.test(value);
}
function clientIdentity(value: unknown): value is GitHubClientOperationId {
  return typeof value === "string" && UUID.test(value);
}
function bodyHash(value: string): value is GitHubBodyDigest {
  return SHA256.test(value);
}
function factsHash(value: string): value is GitHubFactsDigest {
  return SHA256.test(value);
}
function creationHash(value: string): value is GitHubCreationDigest {
  return SHA256.test(value);
}
function boundedText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function decimal(value: unknown): value is string {
  return typeof value === "string" && DECIMAL.test(value);
}

/** Snapshot protocol identifiers without changing the metadata constructor's numeric domain. */
function snapshotRepository(
  input: Readonly<GitHubMetadataRepositoryV1>,
  fetch: boolean,
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
    typeof canonicalOwner !== "string" ||
    !/^[A-Za-z0-9-]{1,39}$(?![\s\S])/.test(canonicalOwner) ||
    typeof canonicalName !== "string" ||
    !/^[A-Za-z0-9._-]{1,100}$(?![\s\S])/.test(canonicalName) ||
    canonicalName === "." ||
    canonicalName === ".." ||
    !boundedText(bindingGeneration) ||
    resource === null ||
    typeof resource !== "object"
  )
    return null;
  const {
    upstreamInstanceId,
    canonicalResourceId,
    canonicalPathSegments: segments,
    resourceSchema: schema,
  } = resource;
  if (
    !boundedText(upstreamInstanceId) ||
    !boundedText(canonicalResourceId) ||
    !Array.isArray(segments) ||
    schema === null ||
    typeof schema !== "object"
  )
    return null;
  const length = segments.length;
  const owner = segments[0];
  const nameSegment = segments[1];
  if (length !== 2 || owner !== canonicalOwner || nameSegment !== canonicalName) return null;
  const { namespace, name, version, digest } = schema;
  if (
    !boundedText(namespace) ||
    !boundedText(name) ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !boundedText(digest) ||
    (fetch && !SHA256.test(digest))
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
      canonicalPathSegments: Object.freeze([canonicalOwner, canonicalName]),
      resourceSchema: Object.freeze({ namespace, name, version, digest }),
    }),
  });
}

function nativeGetter(prototype: object, name: string): (this: unknown) => unknown {
  const getter = Object.getOwnPropertyDescriptor(prototype, name)?.get;
  if (!getter) throw new Error("Required native byte storage accessor is unavailable.");
  return getter;
}
const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
const nativeBuffer = nativeGetter(typedArrayPrototype, "buffer");
const nativeOffset = nativeGetter(typedArrayPrototype, "byteOffset");
const nativeLength = nativeGetter(typedArrayPrototype, "byteLength");
const nativeResizable = nativeGetter(ArrayBuffer.prototype, "resizable");
const nativeDetached = nativeGetter(ArrayBuffer.prototype, "detached");
const nativeSet = Uint8Array.prototype.set;

/** Invoke native accessors and copy storage without executing caller byte-copy hooks. */
function copyBytes(input: Uint8Array): Uint8Array | null {
  if (!types.isUint8Array(input) || types.isProxy(input)) return null;
  const buffer = nativeBuffer.call(input);
  if (
    !types.isArrayBuffer(buffer) ||
    types.isProxy(buffer) ||
    nativeResizable.call(buffer) !== false ||
    nativeDetached.call(buffer) !== false
  )
    return null;
  const offset = nativeOffset.call(input);
  const length = nativeLength.call(input);
  if (
    typeof offset !== "number" ||
    typeof length !== "number" ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    length > BODY_LIMIT
  )
    return null;
  const owned = new Uint8Array(length);
  nativeSet.call(owned, new Uint8Array(buffer, offset, length));
  return owned;
}
function count(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= BODY_LIMIT
  );
}

/**
 * Construct bounded immutable fetch DATA. The native inspector still owns packet
 * parsing, gzip verification, EOF, trailers, cancellation and request authority.
 */
export function createGitHubFetchOperationV1(
  repository: Readonly<GitHubMetadataRepositoryV1>,
  requestId: string,
  input: Readonly<{
    kind: "fetch-discovery" | "fetch";
    decodedBody: Uint8Array;
    encodedBodyBytes: number;
    contentEncoding: "identity" | "gzip";
    framing:
      | Readonly<{ kind: "none" }>
      | Readonly<{ kind: "content-length"; bytes: number }>
      | Readonly<{ kind: "chunked" }>;
    expectContinue: boolean;
  }>,
): Readonly<GitHubFetchOperationV1> | null {
  try {
    if (!requestIdentity(requestId) || input === null || typeof input !== "object") return null;
    const { kind, decodedBody, encodedBodyBytes, contentEncoding, framing, expectContinue } = input;
    if (
      (kind !== "fetch-discovery" && kind !== "fetch") ||
      !count(encodedBodyBytes) ||
      (contentEncoding !== "identity" && contentEncoding !== "gzip") ||
      typeof expectContinue !== "boolean" ||
      framing === null ||
      typeof framing !== "object"
    )
      return null;
    const framingKind = framing.kind;
    if (framingKind !== "none" && framingKind !== "content-length" && framingKind !== "chunked")
      return null;
    const framingBytes = framingKind === "content-length" ? framing.bytes : null;
    if (
      framingKind === "content-length" &&
      (!count(framingBytes) || framingBytes !== encodedBodyBytes)
    )
      return null;
    const owned = copyBytes(decodedBody);
    if (!owned || (contentEncoding === "identity" && owned.byteLength !== encodedBodyBytes))
      return null;
    if (
      kind === "fetch-discovery"
        ? owned.byteLength !== 0 ||
          encodedBodyBytes !== 0 ||
          contentEncoding !== "identity" ||
          expectContinue ||
          framingKind === "chunked"
        : owned.byteLength === 0 || framingKind === "none"
    )
      return null;
    const selected = snapshotRepository(repository, true);
    if (!selected) return null;
    const method = kind === "fetch-discovery" ? "GET" : "POST";
    const pathAndQuery =
      kind === "fetch-discovery"
        ? `/${selected.canonicalOwner}/${selected.canonicalName}.git/info/refs?service=git-upload-pack`
        : `/${selected.canonicalOwner}/${selected.canonicalName}.git/git-upload-pack`;
    const bodyDigest = createHash("sha256").update(owned).digest("hex");
    if (!bodyHash(bodyDigest)) return null;
    const r = selected.repository;
    const s = r.resourceSchema;
    const factsDigest = createHash("sha256")
      .update(
        JSON.stringify([
          "oce.github.git-read.request.v1",
          requestId,
          kind,
          r.upstreamInstanceId,
          s.namespace,
          s.name,
          s.version,
          s.digest,
          r.canonicalResourceId,
          r.canonicalPathSegments,
          selected.appId,
          selected.installationId,
          selected.repositoryId,
          selected.canonicalOwner,
          selected.canonicalName,
          selected.bindingGeneration,
          "github.com",
          method,
          pathAndQuery,
          "version=2",
          contentEncoding,
          framingKind,
          framingBytes,
          expectContinue,
          encodedBodyBytes,
          owned.byteLength,
          bodyDigest,
        ]),
        "utf8",
      )
      .digest("hex");
    if (!factsHash(factsDigest)) return null;
    if (kind === "fetch-discovery") {
      return Object.freeze({
        kind,
        requestId,
        bodyDigest,
        factsDigest,
        target: Object.freeze({
          repository: selected,
          host: "github.com",
          method: "GET",
          pathAndQuery,
        }),
      });
    }
    return Object.freeze({
      kind,
      requestId,
      bodyDigest,
      factsDigest,
      target: Object.freeze({
        repository: selected,
        host: "github.com",
        method: "POST",
        pathAndQuery,
      }),
    });
  } catch {
    return null;
  }
}

function scalarText(value: unknown, maximumBytes: number): value is string {
  if (
    typeof value !== "string" ||
    value.length > maximumBytes ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  )
    return false;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function branch(value: string): boolean {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 1024 ||
    value === "@" ||
    value.startsWith("-") ||
    value.startsWith("refs/") ||
    /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(value) ||
    /[\u0000-\u0020\u007f~^:?*\[\\]/.test(value) ||
    value.includes("..") ||
    value.includes("@{") ||
    value.endsWith(".")
  )
    return false;
  return value
    .split("/")
    .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

/**
 * Construct normalized PR DATA and exact outgoing JSON. Parsing/defaults and
 * 400/413 mapping belong to the request adapter; grants and dispatch remain separate.
 */
export function createGitHubPrCreateOperationV1(
  repository: Readonly<GitHubMetadataRepositoryV1>,
  requestId: string,
  clientOperationId: string,
  input: Readonly<GitHubPrCreateOperationV1["input"]>,
): Readonly<{ operation: Readonly<GitHubPrCreateOperationV1>; canonicalJson: string }> | null {
  try {
    if (
      !requestIdentity(requestId) ||
      !clientIdentity(clientOperationId) ||
      input === null ||
      typeof input !== "object"
    )
      return null;
    const { title, head, base, body, draft, maintainer_can_modify } = input;
    if (
      !scalarText(title, 256) ||
      title.length === 0 ||
      /[\r\n\u0000]/.test(title) ||
      !scalarText(head, 1024) ||
      !scalarText(base, 1024) ||
      head === base ||
      !branch(head) ||
      !branch(base) ||
      !scalarText(body, 61440) ||
      typeof draft !== "boolean" ||
      maintainer_can_modify !== false
    )
      return null;
    const normalized: Readonly<GitHubPrCreateOperationV1["input"]> = Object.freeze({
      title,
      head,
      base,
      body,
      draft,
      maintainer_can_modify,
    });
    const canonicalJson = JSON.stringify(normalized);
    if (Buffer.byteLength(canonicalJson, "utf8") > 65536) return null;
    const selected = snapshotRepository(repository, false);
    if (!selected) return null;
    const target = Object.freeze({
      repository: selected,
      host: "api.github.com",
      method: "POST",
      pathAndQuery: `/repos/${selected.canonicalOwner}/${selected.canonicalName}/pulls`,
    });
    const bodyDigest = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
    const creationDigest = createHash("sha256")
      .update(
        JSON.stringify([
          "oce.github.pr-create.v1",
          target.method,
          target.host,
          target.pathAndQuery,
          selected.repositoryId,
          "repository-write-v1",
          "2026-03-10",
          canonicalJson,
        ]),
        "utf8",
      )
      .digest("hex");
    if (!bodyHash(bodyDigest) || !creationHash(creationDigest)) return null;
    const r = selected.repository;
    const s = r.resourceSchema;
    const factsDigest = createHash("sha256")
      .update(
        JSON.stringify([
          "oce.github.pr-create.facts.v1",
          requestId,
          clientOperationId,
          r.upstreamInstanceId,
          [s.namespace, s.name, s.version, s.digest],
          r.canonicalResourceId,
          r.canonicalPathSegments,
          selected.appId,
          selected.installationId,
          selected.repositoryId,
          selected.canonicalOwner,
          selected.canonicalName,
          selected.bindingGeneration,
          target.method,
          target.host,
          target.pathAndQuery,
          "2026-03-10",
          "repository-write-v1",
          creationDigest,
          bodyDigest,
        ]),
        "utf8",
      )
      .digest("hex");
    if (!factsHash(factsDigest)) return null;
    const operation: Readonly<GitHubPrCreateOperationV1> = Object.freeze({
      kind: "pull-request-create",
      requestId,
      clientOperationId,
      input: normalized,
      target,
      apiVersion: "2026-03-10",
      bodyDigest,
      creationDigest,
      factsDigest,
    });
    return Object.freeze({ operation, canonicalJson });
  } catch {
    return null;
  }
}
