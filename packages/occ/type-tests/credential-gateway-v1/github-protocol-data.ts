import {
  createGitHubFetchOperationV1,
  createGitHubPrCreateOperationV1,
} from "@openclaw-enterprise/occ";
import type {
  GitHubMetadataRepositoryV1,
  GitHubFetchOperationV1,
  GitHubPrCreateOperationV1,
  GitHubPushResultInputV1,
} from "@openclaw-enterprise/occ";
import type {
  GitHubOperation,
  GitHubRequestId,
  GitHubClientOperationId,
  GitHubBodyDigest,
  GitHubFactsDigest,
  GitHubCreationDigest,
} from "../../src/credential-gateway-v1/github-operations.ts";
import type { DispatchPermit } from "../../src/credential-gateway-v1/handles.ts";

// @ts-expect-error Generic operations remain private.
import type { GitHubOperation as HiddenOperation } from "@openclaw-enterprise/occ";
// @ts-expect-error Generic selections remain private.
import type { GitHubRepositorySelection as HiddenSelection } from "@openclaw-enterprise/occ";
// @ts-expect-error Nominal identity names remain private.
import type { GitHubRequestId as HiddenRequestId } from "@openclaw-enterprise/occ";
// @ts-expect-error The input helper stays private.
import type { CreatePullRequestInput as HiddenPrInput } from "@openclaw-enterprise/occ";
// @ts-expect-error Ref updates stay private.
import type { RefUpdate as HiddenUpdate } from "@openclaw-enterprise/occ";
// @ts-expect-error DATA does not publish an authority factory.
import { createGitHubPushOperationV1 } from "@openclaw-enterprise/occ";

export function protocolDataContract(
  repository: GitHubMetadataRepositoryV1,
  fullPush: Extract<GitHubOperation, { kind: "push" }>,
  fetch: GitHubFetchOperationV1,
  pr: GitHubPrCreateOperationV1,
) {
  const constructedFetch = createGitHubFetchOperationV1(repository, "raw-correlation-input", {
    kind: "fetch",
    decodedBody: new Uint8Array([1]),
    encodedBodyBytes: 1,
    contentEncoding: "identity",
    framing: { kind: "content-length", bytes: 1 },
    expectContinue: false,
  });
  const constructedPr = createGitHubPrCreateOperationV1(repository, "raw-request", "raw-client", {
    title: "Title",
    head: "topic/one",
    base: "main",
    body: "",
    draft: false,
    maintainer_can_modify: false,
  });
  const originalFetch: GitHubOperation = fetch;
  const originalPr: GitHubOperation = pr;
  const request: GitHubRequestId = pr.requestId;
  const client: GitHubClientOperationId = pr.clientOperationId;
  const body: GitHubBodyDigest = pr.bodyDigest;
  const facts: GitHubFactsDigest = pr.factsDigest;
  const creation: GitHubCreationDigest = pr.creationDigest;
  const projection: GitHubPushResultInputV1 = fullPush;
  const minimal: GitHubPushResultInputV1 = {
    kind: "push",
    updates: [{ refName: "refs/heads/topic" }],
    capabilities: ["report-status"],
  };
  if (fetch.kind === "fetch") {
    const post: "POST" = fetch.target.method;
    void post;
  } else {
    const get: "GET" = fetch.target.method;
    void get;
  }
  // @ts-expect-error A projection cannot construct the original operation.
  const forgedOperation: GitHubOperation = minimal;
  // @ts-expect-error A projection cannot construct a permit.
  const forgedPermit: DispatchPermit = minimal;
  // @ts-expect-error Raw strings cannot populate the original request brand.
  const rawRequest: GitHubRequestId = "11111111-1111-4111-8111-111111111111";
  // @ts-expect-error Raw strings cannot replace constructor-computed facts.
  const rawFacts: GitHubFetchOperationV1 = { ...fetch, factsDigest: "a".repeat(64) };
  // @ts-expect-error The request and client identities have the original distinct brands.
  const swappedRequest: GitHubRequestId = client;
  // @ts-expect-error The client and request identities have the original distinct brands.
  const swappedClient: GitHubClientOperationId = request;
  // @ts-expect-error Original body and facts digests are distinct.
  const swappedBody: GitHubBodyDigest = facts;
  // @ts-expect-error Original creation and body digests are distinct.
  const swappedCreation: GitHubCreationDigest = body;
  // @ts-expect-error DATA does not broaden the operation catalog.
  const metadata: GitHubFetchOperationV1 = { ...fetch, kind: "metadata" };
  const wrongHost: GitHubFetchOperationV1 = {
    ...fetch,
    kind: "fetch",
    // @ts-expect-error The fetch host remains literal.
    target: { ...fetch.target, host: "api.github.com", method: "POST" },
  };
  // @ts-expect-error Discovery requires GET.
  const wrongMethod: GitHubFetchOperationV1 = {
    ...fetch,
    kind: "fetch-discovery",
    target: { ...fetch.target, method: "POST" },
  };
  const wrongPrHost: GitHubPrCreateOperationV1 = {
    ...pr,
    target: {
      ...pr.target,
      // @ts-expect-error The PR host remains literal.
      host: "github.com",
    },
  };
  const wrongPrMethod: GitHubPrCreateOperationV1 = {
    ...pr,
    target: {
      ...pr.target,
      // @ts-expect-error The PR method remains literal.
      method: "GET",
    },
  };
  // @ts-expect-error The PR API version remains literal.
  const wrongVersion: GitHubPrCreateOperationV1 = { ...pr, apiVersion: "2022-11-28" };
  const wrongMaintainer: GitHubPrCreateOperationV1["input"] = {
    ...pr.input,
    // @ts-expect-error Maintainer modification cannot be enabled.
    maintainer_can_modify: true,
  };
  // @ts-expect-error The push observer requires a push projection.
  const wrongProjection: GitHubPushResultInputV1 = { ...minimal, kind: "fetch" };
  // @ts-expect-error Constructor results retain readonly identities.
  fetch.requestId = request;
  // @ts-expect-error Retained selections are readonly.
  fetch.target.repository.repositoryId = "43";
  // @ts-expect-error Retained schemas are readonly.
  fetch.target.repository.repository.resourceSchema.digest = "changed";
  // @ts-expect-error Retained paths are readonly.
  fetch.target.repository.repository.canonicalPathSegments.push("extra");
  // @ts-expect-error PR input is readonly.
  pr.input.title = "changed";
  // @ts-expect-error Projection arrays are readonly.
  projection.updates.push({ refName: "refs/heads/other" });
  const first = minimal.updates[0];
  if (first) {
    // @ts-expect-error Projection entries are readonly.
    first.refName = "refs/heads/other";
  }
  // @ts-expect-error Projection capability arrays are readonly.
  minimal.capabilities.push("other");
  void [
    constructedFetch,
    constructedPr,
    originalFetch,
    originalPr,
    request,
    client,
    body,
    facts,
    creation,
  ];
}
