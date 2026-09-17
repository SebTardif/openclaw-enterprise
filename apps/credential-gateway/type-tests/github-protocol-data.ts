// Compiler call-site fixtures for the public DATA seam; native adapters migrate separately.
import {
  createGitHubMetadataOperationV1,
  createGitHubFetchOperationV1,
  createGitHubPrCreateOperationV1,
} from "@openclaw-enterprise/occ";
import type {
  GitHubProtocolRepositoryV1,
  GitHubProtocolOperationV1,
  GitHubFetchOperationV1,
  GitHubPrCreateOperationV1,
  GitHubPushOperationV1,
  GitHubPushResultInputV1,
  GitHubExchangeOutcomeV1,
  GitHubPrCreationResultV1,
  HTTPResult,
  Result,
} from "@openclaw-enterprise/occ";

export function metadataRequestCallSite(repository: GitHubProtocolRepositoryV1, requestId: string) {
  const operation = createGitHubMetadataOperationV1(repository, requestId);
  if (!operation) return null;
  const facts: Extract<GitHubProtocolOperationV1, { kind: "metadata" }> = operation;
  return facts;
}

// The inspector supplies observed framing/encoding/counts and validated decoded bytes.
export function fetchRequestCallSite(
  repository: GitHubProtocolRepositoryV1,
  requestId: string,
  inspected: Parameters<typeof createGitHubFetchOperationV1>[2],
) {
  const operation = createGitHubFetchOperationV1(repository, requestId, inspected);
  if (!operation) return null;
  const nominal: GitHubFetchOperationV1 = operation;
  const facts: GitHubProtocolOperationV1 = nominal;
  if (operation.kind === "fetch") {
    const fetch: Extract<GitHubProtocolOperationV1, { kind: "fetch" }> = operation;
    void fetch;
  } else {
    const discovery: Extract<GitHubProtocolOperationV1, { kind: "fetch-discovery" }> = operation;
    void discovery;
  }
  return facts;
}

// The integrating JSON parser must supply all six normalized fields and explicit defaults.
export function prRequestCallSite(
  repository: GitHubProtocolRepositoryV1,
  requestId: string,
  clientOperationId: string,
  normalized: GitHubPrCreateOperationV1["input"],
) {
  const result = createGitHubPrCreateOperationV1(
    repository,
    requestId,
    clientOperationId,
    normalized,
  );
  if (!result) return null;
  const nominal: GitHubPrCreateOperationV1 = result.operation;
  const facts: Extract<GitHubProtocolOperationV1, { kind: "pull-request-create" }> = nominal;
  const outgoingJson: string = result.canonicalJson;
  return { facts, outgoingJson };
}

// The status reader needs only destination names and capabilities from the parsed push.
export function pushObserverCallSite<T>(
  operation: Extract<GitHubPushOperationV1, { kind: "push" }>,
  observe: (attempted: GitHubPushResultInputV1) => T,
) {
  const input: GitHubPushResultInputV1 = operation;
  return observe(input);
}

export function responseConsumerCallSite(
  result: Result<GitHubPrCreationResultV1>,
  exchange: GitHubExchangeOutcomeV1,
) {
  const http: HTTPResult<GitHubPrCreationResultV1> = result;
  if (http.kind === "ok" && http.value.kind === "created") {
    const replayed: boolean = http.value.replayed;
    const receiptId: string = http.value.receiptId;
    void [replayed, receiptId];
  }
  if (exchange.kind === "unknown") {
    const upload = exchange.upload;
    const refs = exchange.refs;
    const observedPr = exchange.observedPullRequest;
    void [upload, refs, observedPr];
  }
  // @ts-expect-error An observed provider outcome is not the committed HTTP PR result.
  const response: HTTPResult<GitHubPrCreationResultV1> = exchange;
  return http;
}
