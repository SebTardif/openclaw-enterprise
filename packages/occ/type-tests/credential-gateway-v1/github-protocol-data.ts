import {
  createGitHubFetchOperationV1,
  createGitHubPrCreateOperationV1,
} from "@openclaw-enterprise/occ";
import type {
  GitHubMetadataRepositoryV1,
  GitHubFetchOperationV1,
  GitHubPrCreateOperationV1,
  GitHubPushResultInputV1,
  GitHubProtocolRepositoryV1,
  GitHubProtocolOperationV1,
  GitHubPushOperationV1,
  PreSubmissionFailure,
  RequestFailure,
  HTTPResult,
  Result,
  BodyEvidence,
  RefResult,
  PullRequestRefObservation,
  SafePullRequest,
  ProviderRefusalStatus,
  GitHubPrCreationResultV1,
  GitHubExchangeOutcomeV1,
  OriginalPrCreationClaimV1,
  RootDeploymentAdmissionV1,
  IamAdmissionEvidence,
  AuthorityBinding,
} from "@openclaw-enterprise/occ";
import type {
  GitHubOperation,
  GitHubRequestId,
  GitHubClientOperationId,
  GitHubBodyDigest,
  GitHubFactsDigest,
  GitHubCreationDigest,
} from "../../src/credential-gateway-v1/github-operations.ts";
import type { LocalHandle, DispatchPermit } from "../../src/credential-gateway-v1/handles.ts";

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

// @ts-expect-error The failure-code convenience alias is not part of the public DATA surface.
import type { FailureCode } from "@openclaw-enterprise/occ";
// @ts-expect-error Digest identity internals stay private.
import type { GitHubPrefixDigest } from "@openclaw-enterprise/occ";

type Assert<T extends true> = T;
type Assignable<A, B> = [A] extends [B] ? true : false;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type OperationKind =
  | "metadata"
  | "fetch-discovery"
  | "fetch"
  | "push-discovery"
  | "push-probe"
  | "push"
  | "pull-request-create";
type OperationMembers = {
  [K in OperationKind]: Extract<GitHubProtocolOperationV1, { readonly kind: K }>;
};
export type AllSevenKinds = Assert<Same<GitHubProtocolOperationV1["kind"], OperationKind>>;
export type NoMissingMember = Assert<
  Same<{ [K in OperationKind]: OperationMembers[K]["kind"] }, { [K in OperationKind]: K }>
>;
export type RepositoryCompatibility = Assert<
  Same<GitHubProtocolRepositoryV1, Readonly<GitHubMetadataRepositoryV1>>
>;
export type ResultCompatibility = Assert<
  Same<Result<SafePullRequest>, HTTPResult<SafePullRequest>>
>;

// Use the original module's brand, including every existing local handle kind.
type HandleKind =
  | "authenticated-access"
  | "retained-credential"
  | "authentication-binding-v1"
  | "admitted-service-binding"
  | "admitted-receiver"
  | "protected-derived-capability"
  | "derived-request"
  | "protected-upstream-response"
  | "dispatch-permit"
  | "receipt-finalization"
  | "bound-credential-operation"
  | "validated-adapter-operation"
  | "validated-schema-value"
  | "admission-condition"
  | "admitted-root-context"
  | "authorized-closure"
  | "admitted-connection"
  | "admitted-credential-selection"
  | "protected-credential-source"
  | "registered-credential-mechanism";
export type FactsCannotSupplyHandles = Assert<
  Same<
    {
      [K in HandleKind]: Assignable<Extract<GitHubProtocolOperationV1, LocalHandle<K>>, never>;
    },
    { [K in HandleKind]: true }
  >
>;

export function structuralOperationContract(
  members: OperationMembers,
  fetch: GitHubFetchOperationV1,
  pr: GitHubPrCreateOperationV1,
) {
  const metadataRoute: "api.github.com" = members.metadata.target.host;
  const metadataMethod: "GET" = members.metadata.target.method;
  const discoveryMethod: "GET" = members["fetch-discovery"].target.method;
  const fetchMethod: "POST" = members.fetch.target.method;
  const pushDiscoveryMethod: "GET" = members["push-discovery"].target.method;
  const pushProbeMethod: "POST" = members["push-probe"].target.method;
  const pushMethod: "POST" = members.push.target.method;
  const prRoute: "api.github.com" = members["pull-request-create"].target.host;
  const prMethod: "POST" = members["pull-request-create"].target.method;
  const structuralFetch: GitHubProtocolOperationV1 = fetch;
  const structuralPr: OperationMembers["pull-request-create"] = pr;
  // @ts-expect-error Repository/operation facts cannot supply the original ROOT PR claim.
  const claim: OriginalPrCreationClaimV1 = members["pull-request-create"];
  // @ts-expect-error DATA cannot supply original deployment admission.
  const deployment: RootDeploymentAdmissionV1 = members.metadata;
  // @ts-expect-error DATA cannot supply original IAM evidence.
  const iam: IamAdmissionEvidence = members.fetch;
  // @ts-expect-error DATA cannot supply current Work/IAM authority bindings.
  const authority: AuthorityBinding = members.push;
  const pushFamily: GitHubPushOperationV1 = members.push;
  const pushDiscovery: GitHubPushOperationV1 = members["push-discovery"];
  const pushProbe: GitHubPushOperationV1 = members["push-probe"];
  const observer: GitHubPushResultInputV1 = members.push;
  // @ts-expect-error Structural facts cannot substitute for constructor-refined fetch DATA.
  const nominalFetch: GitHubFetchOperationV1 = members.fetch;
  // @ts-expect-error Structural facts cannot substitute for constructor-refined PR DATA.
  const nominalPr: GitHubPrCreateOperationV1 = members["pull-request-create"];
  // @ts-expect-error Structural DATA cannot supply any original local authority handle.
  const handle: LocalHandle<HandleKind> = members.push;
  // @ts-expect-error Facts are not an original nominal operation.
  const original: GitHubOperation = members.push;
  // @ts-expect-error Fetch is excluded from the push family.
  const wrongFamily: GitHubPushOperationV1 = members.fetch;
  // @ts-expect-error Push commands expose prefix evidence, not a complete body digest.
  members.push.bodyDigest;
  // @ts-expect-error Discovery has no command prefix or PACK requirement.
  members["push-discovery"].requiresPack;
  // @ts-expect-error OIDs do not imply force authority or ancestry.
  members.push.updates[0]?.force;
  // @ts-expect-error Operation facts are readonly.
  members.push.prefixBytes = 0;
  // @ts-expect-error Command arrays are readonly.
  members.push.updates.push({
    refName: "refs/heads/x",
    oldOid: "0",
    newOid: "1",
    change: "create",
  });
  const update = members.push.updates[0];
  if (update) {
    // @ts-expect-error Command entries are readonly.
    update.oldOid = "changed";
  }
  // @ts-expect-error Options remain readonly.
  members.push.pushOptions.push("changed");
  // @ts-expect-error Structural repositories retain the original nested readonly schema.
  members.push.target.repository.repository.resourceSchema.version = 2;
  const wrongProbe: OperationMembers["push-probe"] = {
    ...members["push-probe"],
    // @ts-expect-error GET cannot replace the push-probe POST route.
    target: { ...members["push-probe"].target, method: "GET" },
  };
  // @ts-expect-error SHA-256 object format is not selected for push.
  const wrongFormat: OperationMembers["push"] = { ...members.push, objectFormat: "sha256" };
  void [
    metadataRoute,
    metadataMethod,
    discoveryMethod,
    fetchMethod,
    pushDiscoveryMethod,
    pushProbeMethod,
    pushMethod,
    prRoute,
    prMethod,
    structuralFetch,
    structuralPr,
    pushFamily,
    pushDiscovery,
    pushProbe,
    observer,
  ];
}

export function resultDataContract(
  pullRequest: SafePullRequest,
  upload: BodyEvidence,
  ref: RefResult,
) {
  const observation: PullRequestRefObservation = pullRequest.head;
  const refusalStatuses: readonly ProviderRefusalStatus[] = [400, 401, 403, 404, 410, 422, 429];
  const failures: readonly RequestFailure[] = [
    { status: 401, code: "unauthenticated" },
    { status: 403, code: "closed" },
    { status: 403, code: "forbidden" },
    { status: 400, code: "unsupported-request" },
    { status: 415, code: "unsupported-request" },
    { status: 413, code: "limit-exceeded" },
    { status: 431, code: "limit-exceeded" },
    { status: 429, code: "limit-exceeded" },
    { status: 408, code: "deadline" },
    { status: 503, code: "unavailable" },
    { status: 503, code: "indeterminate" },
    { status: 409, code: "operation-id-conflict" },
  ];
  const beforeSend: PreSubmissionFailure = { status: 503, code: "unavailable" };
  const error: HTTPResult<SafePullRequest> = { kind: "error", ...beforeSend };
  const recordedError: Result<SafePullRequest> = {
    kind: "error",
    receiptId: "receipt",
    status: 409,
    code: "operation-id-conflict",
  };
  const receipt: GitHubPrCreationResultV1 = {
    kind: "created",
    operationId: "operation",
    receiptId: "receipt",
    pullRequest,
    replayed: false,
  };
  const prStates: readonly GitHubPrCreationResultV1[] = [
    receipt,
    { kind: "in-progress", operationId: "operation", receiptId: "receipt" },
    { kind: "unknown", operationId: "operation", receiptId: "receipt" },
    { kind: "not-submitted", operationId: "operation", receiptId: "receipt", ...beforeSend },
    {
      kind: "refused",
      operationId: "operation",
      receiptId: "receipt",
      status: 422,
      code: "provider-refused",
    },
  ];
  const observedPr: GitHubExchangeOutcomeV1 = { kind: "pr-created", status: 201, pullRequest };
  const outcomes: readonly GitHubExchangeOutcomeV1[] = [
    { kind: "not-submitted", ...beforeSend },
    { kind: "local-probe" },
    { kind: "read-complete", status: 200, responseBytes: 1 },
    { kind: "provider-rejected", status: 500 },
    observedPr,
    {
      kind: "push-report",
      status: 200,
      unpack: "unknown",
      refs: [ref],
      upload,
      reportComplete: false,
    },
    { kind: "unknown", stage: "submission" },
    { kind: "unknown", stage: "upload", upload },
    { kind: "unknown", stage: "response", refs: [ref] },
    { kind: "unknown", stage: "receipt-commit", observedPullRequest: pullRequest },
  ];
  const minimalRef: RefResult = { requestedRef: "refs/heads/topic", status: "unknown" };
  const fullRef: RefResult = {
    ...minimalRef,
    reportedRef: "refs/heads/topic",
    reportedOldOid: "old",
    reportedNewOid: "new",
    reportedForcedUpdate: false,
  };
  const partial: BodyEvidence = { ...upload, coverage: "partial" };
  // @ts-expect-error Provider 201 observation is not a committed receipt result.
  const uncommitted: GitHubPrCreationResultV1 = observedPr;
  // @ts-expect-error Created receipt requires replay and receipt identities.
  const missingReceipt: GitHubPrCreationResultV1 = {
    kind: "created",
    pullRequest,
    operationId: "operation",
  };
  // @ts-expect-error Unknown commit is not definite non-submission.
  const indeterminateBeforeSend: PreSubmissionFailure = { status: 503, code: "indeterminate" };
  // @ts-expect-error Request identity conflict is not a pre-submission classification.
  const conflictBeforeSend: PreSubmissionFailure = { status: 409, code: "operation-id-conflict" };
  // @ts-expect-error Status and code are paired, rather than independent unions.
  const wrongUnauthorized: RequestFailure = { status: 403, code: "unauthenticated" };
  // @ts-expect-error Limit errors cannot use the unsupported-body status.
  const wrongLimit: RequestFailure = { status: 400, code: "limit-exceeded" };
  // @ts-expect-error Conflict uses exactly 409.
  const wrongConflict: RequestFailure = { status: 503, code: "operation-id-conflict" };
  const wrongNonSubmission: GitHubExchangeOutcomeV1 = {
    kind: "not-submitted",
    status: 503,
    // @ts-expect-error Definite non-submission cannot claim an unknown commit.
    code: "indeterminate",
  };
  const wrongRefusal: GitHubPrCreationResultV1 = {
    kind: "refused",
    operationId: "o",
    receiptId: "r",
    // @ts-expect-error Provider refusal statuses are finite.
    status: 500,
    code: "provider-refused",
  };
  const wrongCreatedStatus: GitHubExchangeOutcomeV1 = {
    kind: "pr-created",
    // @ts-expect-error PR observation requires exactly 201.
    status: 200,
    pullRequest,
  };
  // @ts-expect-error Safe PR state remains open.
  const closed: SafePullRequest = { ...pullRequest, state: "closed" };
  // @ts-expect-error Forbidden responses use 403.
  const wrongForbidden: RequestFailure = { status: 401, code: "forbidden" };
  // @ts-expect-error Closed responses use 403.
  const wrongClosed: RequestFailure = { status: 503, code: "closed" };
  // @ts-expect-error Unsupported requests use 400 or 415.
  const wrongUnsupported: RequestFailure = { status: 413, code: "unsupported-request" };
  // @ts-expect-error Deadline responses use 408.
  const wrongDeadline: RequestFailure = { status: 503, code: "deadline" };
  // @ts-expect-error Unavailability uses 503.
  const wrongUnavailable: RequestFailure = { status: 408, code: "unavailable" };
  // @ts-expect-error Indeterminate responses use 503.
  const wrongIndeterminate: RequestFailure = { status: 409, code: "indeterminate" };
  // @ts-expect-error Optional reported ref is absent or string, never undefined.
  const undefinedReportedRef: RefResult = { ...minimalRef, reportedRef: undefined };
  // @ts-expect-error Optional reported old OID is absent or string, never undefined.
  const undefinedOldOid: RefResult = { ...minimalRef, reportedOldOid: undefined };
  // @ts-expect-error Optional reported new OID is absent or string, never undefined.
  const undefinedNewOid: RefResult = { ...minimalRef, reportedNewOid: undefined };
  // @ts-expect-error Optional receipt means absent or string, never present undefined.
  const undefinedReceipt: HTTPResult<never> = {
    kind: "error",
    status: 503,
    code: "unavailable",
    receiptId: undefined,
  };
  // @ts-expect-error Optional report fields preserve exact presence.
  const undefinedRef: RefResult = { ...minimalRef, reportedForcedUpdate: undefined };
  // @ts-expect-error Unknown upload is absent or complete evidence, never undefined.
  const undefinedUpload: GitHubExchangeOutcomeV1 = {
    kind: "unknown",
    stage: "upload",
    upload: undefined,
  };
  // @ts-expect-error Unknown refs are absent or an array, never undefined.
  const undefinedRefs: GitHubExchangeOutcomeV1 = {
    kind: "unknown",
    stage: "response",
    refs: undefined,
  };
  // @ts-expect-error Observed PR is absent or a safe observation, never undefined.
  const undefinedPr: GitHubExchangeOutcomeV1 = {
    kind: "unknown",
    stage: "receipt-commit",
    observedPullRequest: undefined,
  };
  // @ts-expect-error Nested provider observation is readonly.
  pullRequest.head.sha = "changed";
  // @ts-expect-error Safe PR properties are readonly.
  pullRequest.draft = true;
  // @ts-expect-error Upload evidence is readonly.
  upload.coverage = "complete";
  // @ts-expect-error Report fields are readonly.
  ref.reportedForcedUpdate = true;
  const report: Extract<GitHubExchangeOutcomeV1, { kind: "push-report" }> = {
    kind: "push-report",
    status: 200,
    unpack: "unknown",
    refs: [ref],
    upload,
    reportComplete: false,
  };
  // @ts-expect-error Reports retain readonly arrays.
  report.refs.push(minimalRef);
  // @ts-expect-error HTTP result envelopes are readonly.
  recordedError.receiptId = "changed";
  // @ts-expect-error Receipt identities are readonly.
  receipt.receiptId = "changed";
  void [
    observation,
    refusalStatuses,
    failures,
    beforeSend,
    error,
    recordedError,
    prStates,
    outcomes,
    minimalRef,
    fullRef,
    partial,
  ];
}
