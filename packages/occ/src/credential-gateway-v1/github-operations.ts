import type { ResourceIdentity } from "./connection.ts";
import type { GitHubAppSelectionV1 } from "../github-app-provider-v1/provider.ts";

export type AccessProfile = "read" | "read-write";
/**
 * Admission defaults an absent access profile to read. A read-write grant retains
 * repository-write-v1 for metadata/fetch and replacement tokens too; operation
 * kind never selects another profile. Separate preparation remains read-only.
 */
export type TokenProfile = "repository-read-v1" | "repository-write-v1";
export type GitHubHost = "github.com" | "api.github.com";

// Nominal data identities prevent accidental category swaps, not forgery or
// admission. Runtime owners validate UUIDs, canonical versioned encodings,
// schemas, numeric bounds, hashes and Git refs; these types confer no authority.
declare const githubDataIdentity: unique symbol;
type GitHubDataIdentity<K extends string> = string & {
  readonly [githubDataIdentity]: K;
};
export type GitHubAccessId = GitHubDataIdentity<"access-id">;
export type GitHubRequestId = GitHubDataIdentity<"request-id">;
export type GitHubClientOperationId = GitHubDataIdentity<"client-operation-id">;
export type GitHubDispatchId = GitHubDataIdentity<"dispatch-id">;
export type GitHubFactsDigest = GitHubDataIdentity<"facts-digest">;
export type GitHubBodyDigest = GitHubDataIdentity<"body-digest">;
export type GitHubPrefixDigest = GitHubDataIdentity<"prefix-digest">;
export type GitHubCreationDigest = GitHubDataIdentity<"creation-digest">;

export interface RepositoryIdentity extends ResourceIdentity {
  /** Adapter-owned case and namespace rules. */
  readonly canonicalPathSegments: readonly string[];
}

export interface GitHubRepositorySelection {
  readonly repository: RepositoryIdentity;
  readonly appId: string;
  readonly installationId: string;
  /** GitHub numeric ID serialized without precision loss. */
  readonly repositoryId: string;
  readonly canonicalOwner: string;
  readonly canonicalName: string;
  readonly bindingGeneration: string;
}

/** Additive access input; enrollment and current Work/IAM admission remain required. */
export interface GitHubRepositoryAccessV1 {
  readonly schemaVersion: 1;
  readonly repositories: readonly {
    readonly repository: GitHubRepositorySelection;
    readonly accessProfile?: AccessProfile;
  }[];
}

/** Exact write profile; existing read-only issuer selections remain unchanged. */
export interface GitHubRepositoryWriteSelectionV1 {
  readonly key: GitHubAppSelectionV1["key"];
  readonly installationId: GitHubAppSelectionV1["installationId"];
  readonly repositories: GitHubAppSelectionV1["repositories"];
  readonly permissions: Readonly<{
    metadata: "read";
    contents: "write";
    pull_requests: "write";
  }>;
}

export interface CanonicalTarget {
  readonly repository: GitHubRepositorySelection;
  readonly host: GitHubHost;
  readonly method: "GET" | "POST";
  /** Constructed from admitted selection and the operation catalog. */
  readonly pathAndQuery: string;
}

export interface RefUpdate {
  /** Full destination ref; never assumed to be a source branch. */
  readonly refName: string;
  readonly oldOid: string;
  readonly newOid: string;
  readonly change: "create" | "update" | "delete";
  // OIDs do not prove ancestry, so no inferred force field exists.
}

interface CommonOperation {
  readonly requestId: GitHubRequestId;
  readonly target: CanonicalTarget;
  /** Versioned canonical encoding includes validated header semantics. */
  readonly factsDigest: GitHubFactsDigest;
}

export interface CreatePullRequestInput {
  /** Distinct, unqualified branches in the same admitted repository. */
  readonly head: string;
  readonly base: string;
  readonly title: string;
  /** Defaulted and bounded by the adapter; never log this payload. */
  readonly body: string;
  readonly draft: boolean;
  /** Adapter-fixed, rather than caller-selected. */
  readonly maintainer_can_modify: false;
}

export type GitHubOperation =
  | (CommonOperation & {
      readonly kind: "metadata" | "fetch-discovery" | "fetch";
      /** Entire validated decoded body, including empty. */
      readonly bodyDigest: GitHubBodyDigest;
    })
  | (CommonOperation & {
      readonly kind: "push-discovery" | "push-probe";
      readonly bodyDigest: GitHubBodyDigest;
    })
  | (CommonOperation & {
      readonly kind: "push";
      readonly objectFormat: "sha1";
      readonly updates: readonly RefUpdate[];
      readonly capabilities: readonly string[];
      readonly pushOptions: readonly string[];
      readonly prefixDigest: GitHubPrefixDigest;
      readonly prefixBytes: number;
      readonly requiresPack: boolean;
    })
  | (CommonOperation & {
      readonly kind: "pull-request-create";
      /** Runtime-validated UUIDv4 deduplication key, never authority. */
      readonly clientOperationId: GitHubClientOperationId;
      readonly input: CreatePullRequestInput;
      readonly apiVersion: "2026-03-10";
      /** Exact canonical outgoing JSON bytes. */
      readonly bodyDigest: GitHubBodyDigest;
      /** Stable route/body/profile encoding, excluding HTTP request/fresh auth identity. */
      readonly creationDigest: GitHubCreationDigest;
      // No preflight resolved OIDs or push-provenance assertion in this MVP.
    });
