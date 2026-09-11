import { createHash } from "node:crypto";
import { types } from "node:util";

/** Publication comparison data is not Work admission, human approval, a State
 * commit witness, or permission to send an upstream request. */
export interface PublicationRepositoryV1 {
  readonly installationId: string;
  readonly githubHost: "github.com";
  readonly appId: string;
  readonly githubInstallationId: string;
  readonly repositoryId: string;
}

/** Supplied by the original Work owner from its held publication operation. */
export interface PublicationWorkBindingV1 {
  readonly installationId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly agentRevisionRef: string;
  readonly workRef: string;
  readonly workRevision: number;
  readonly authorityRef: string;
  readonly authorityRevision: string;
  readonly operationRef: string;
  readonly invocationRef: string;
  readonly requestDigest: string;
  readonly executionBindingDigest: string;
  readonly requesterPrincipalId: string;
}

export type PublicationExpectedTargetV1 =
  Readonly<{ kind: "create" }> | Readonly<{ kind: "existing"; oid: string }>;

export interface PublicationRequestV1 {
  readonly version: 1;
  readonly repository: PublicationRepositoryV1;
  readonly baseBranch: string;
  readonly baseOid: string;
  readonly targetBranch: string;
  readonly expectedTarget: PublicationExpectedTargetV1;
  readonly proposedOid: string;
  readonly draftPullRequest: Readonly<{ title: string; body: string; draft: true }>;
  readonly actions: readonly ["push", "create-draft-pr"];
}

export interface PublicationGraphV1 {
  readonly version: 1;
  readonly objectFormat: "sha1";
  readonly proposedOid: string;
  readonly baseOid: string;
  readonly graphDigest: string;
  readonly objectCount: number;
  readonly rawBytes: number;
  readonly packSha256: string;
  readonly packBytes: number;
}

export interface PublicationCandidateV1 {
  readonly version: 1;
  readonly work: PublicationWorkBindingV1;
  readonly request: PublicationRequestV1;
  readonly graph: PublicationGraphV1;
  readonly actionDigest: string;
}

export interface PublicationApproverPolicyV1 {
  readonly version: 1;
  readonly policyRef: string;
  readonly revision: string;
  readonly approverPrincipalIds: readonly string[];
  readonly allowSelfApproval: boolean;
  readonly approvalLifetimeMs: number;
  readonly rules: readonly Readonly<{
    repository: PublicationRepositoryV1;
    baseBranch: string;
    targetBranches: readonly string[];
    allowCreate: boolean;
  }>[];
  readonly actions: readonly ["push", "create-draft-pr"];
}

export interface PublicationApprovalV1 {
  readonly version: 1;
  readonly approvalRef: string;
  readonly candidateRef: string;
  readonly actionDigest: string;
  readonly approverPrincipalId: string;
  readonly policyRef: string;
  readonly policyRevision: string;
  readonly policyDigest: string;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
}

export interface PublicationCallV1 {
  readonly requestRef: string;
  readonly signal: AbortSignal;
}

/** Factual protected time input. No default or guessed uncertainty is supplied. */
export interface PublicationClockV1 {
  read(): Readonly<{ wallMs: number; uncertaintyMs: number }>;
}

export type PublicationEffectKindV1 = "push" | "create-draft-pr";
export interface PublicationEffectV1 {
  readonly version: 1;
  readonly effectRef: string;
  readonly kind: PublicationEffectKindV1;
  readonly candidateRef: string;
  readonly approvalRef: string;
  readonly actionDigest: string;
  /** A PR effect names the separately confirmed original push effect. */
  readonly confirmedPushEffectRef: string | null;
}

/** Actual response observation, not an atomic branch precondition or a promise
 * that the remote branch will remain at these OIDs after the response. */
export interface PublicationPullRequestObservationV1 {
  readonly number: string;
  readonly url: string;
  readonly repositoryId: string;
  readonly baseBranch: string;
  readonly baseOid: string;
  readonly headBranch: string;
  readonly headOid: string;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
}

export type PublicationEffectOutcomeV1 =
  | Readonly<{ kind: "not-dispatched" }>
  | Readonly<{ kind: "unknown"; pullRequest: PublicationPullRequestObservationV1 | null }>
  | Readonly<{ kind: "rejected"; reason: "expected-old" | "non-fast-forward" | "upstream" }>
  | Readonly<{ kind: "pushed"; ref: string; oldOid: string; newOid: string }>
  /** Only the original attributed create response whose entire observation
   * matches the candidate can be recorded as complete. Preserve mismatches as
   * unknown with the observed PR; an existing matching PR proves no attribution. */
  | Readonly<{ kind: "draft-pr-created"; pullRequest: PublicationPullRequestObservationV1 }>;

export interface PublicationStatusV1 {
  readonly version: 1;
  readonly candidateRef: string;
  readonly actionDigest: string;
  readonly state:
    | "awaiting-approval"
    | "approved"
    | "publishing"
    | "pushed"
    | "draft-pr-created"
    | "rejected"
    | "cancelled"
    | "unknown";
  readonly push: Readonly<{
    effect: PublicationEffectV1;
    outcome: PublicationEffectOutcomeV1;
  }> | null;
  readonly pullRequest: Readonly<{
    effect: PublicationEffectV1;
    outcome: PublicationEffectOutcomeV1;
  }> | null;
}

export class PublicationRefusalV1 extends Error {
  constructor() {
    super("Repository publication input or original authority is unavailable");
    this.name = "PublicationRefusalV1";
  }
}
export function publicationRefuseV1(): never {
  throw new PublicationRefusalV1();
}

/** Copies only bounded plain own-data JSON. Proxies, accessors and prototypes
 * cannot execute while a comparison record is captured. */
export function publicationSnapshotV1(value: unknown): unknown {
  let nodes = 0;
  let encodedBytes = 0;
  function charge(bytes: number): void {
    encodedBytes += bytes;
    if (encodedBytes > 262144) publicationRefuseV1();
  }
  const seen = new Set<object>();
  function copy(v: unknown, depth: number): unknown {
    if (++nodes > 20000 || depth > 32) publicationRefuseV1();
    if (v === null || typeof v === "boolean") {
      charge(v === false ? 5 : 4);
      return v;
    }
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) publicationRefuseV1();
      charge(String(v).length);
      return v;
    }
    if (typeof v === "string") {
      if (Buffer.byteLength(v) > 131072) publicationRefuseV1();
      charge(Buffer.byteLength(JSON.stringify(v)));
      return v;
    }
    if (!v || typeof v !== "object" || types.isProxy(v) || seen.has(v)) publicationRefuseV1();
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        if (Object.getPrototypeOf(v) !== Array.prototype || v.length > 8192) publicationRefuseV1();
        const keys = Reflect.ownKeys(v);
        if (keys.length !== v.length + 1) publicationRefuseV1();
        const result: unknown[] = [];
        charge(2 + Math.max(0, v.length - 1));
        for (let i = 0; i < v.length; i++) {
          const d = Object.getOwnPropertyDescriptor(v, String(i));
          if (!d || !d.enumerable || !("value" in d)) publicationRefuseV1();
          result.push(copy(d.value, depth + 1));
        }
        return Object.freeze(result);
      }
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
        publicationRefuseV1();
      const result: Record<string, unknown> = Object.create(null);
      charge(2);
      let first = true;
      for (const k of Reflect.ownKeys(v)) {
        if (typeof k !== "string" || k.length > 256) publicationRefuseV1();
        const d = Object.getOwnPropertyDescriptor(v, k);
        if (!d || !d.enumerable || !("value" in d)) publicationRefuseV1();
        charge(Buffer.byteLength(JSON.stringify(k)) + 1 + (first ? 0 : 1));
        first = false;
        result[k] = copy(d.value, depth + 1);
      }
      return Object.freeze(result);
    } finally {
      seen.delete(v);
    }
  }
  const result = copy(value, 0);
  return result;
}

export function publicationCanonicalV1(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(publicationCanonicalV1).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(o)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + publicationCanonicalV1(o[k]))
        .join(",") +
      "}"
    );
  }
  const result = JSON.stringify(value);
  if (result === undefined) publicationRefuseV1();
  return result;
}
export function publicationDigestV1(domain: string, value: unknown): string {
  return (
    "sha256:" +
    createHash("sha256")
      .update("oce/repository-publication/v1/" + domain + "\0")
      .update(publicationCanonicalV1(value))
      .digest("hex")
  );
}
export function publicationObjectV1(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) publicationRefuseV1();
  const o = value as Record<string, unknown>;
  const actual = Object.keys(o).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((k, i) => k !== expected[i]))
    publicationRefuseV1();
  return o;
}
export function publicationReferenceV1(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9:._/@+-]{0,255}(?![\s\S])/.test(v);
}
export function publicationOidV1(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{40}(?![\s\S])/.test(v) && v !== "0".repeat(40);
}
export function publicationSha256V1(v: unknown): v is string {
  return typeof v === "string" && /^sha256:[0-9a-f]{64}(?![\s\S])/.test(v);
}
export function publicationBranchV1(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*(?![\s\S])/.test(v) &&
    v
      .split("/")
      .every(
        (s) => s.length > 0 && !s.startsWith(".") && !s.endsWith(".") && !s.endsWith(".lock"),
      ) &&
    !v.includes("..")
  );
}
function repository(v: unknown): void {
  const o = publicationObjectV1(v, [
    "installationId",
    "githubHost",
    "appId",
    "githubInstallationId",
    "repositoryId",
  ]);
  if (
    !publicationReferenceV1(o.installationId) ||
    o.githubHost !== "github.com" ||
    [o.appId, o.githubInstallationId, o.repositoryId].some(
      (n) => typeof n !== "string" || !/^[1-9][0-9]{0,19}(?![\s\S])/.test(n),
    )
  )
    publicationRefuseV1();
}
function actions(v: unknown): void {
  if (!Array.isArray(v) || v.length !== 2 || v[0] !== "push" || v[1] !== "create-draft-pr")
    publicationRefuseV1();
}
function request(v: unknown): void {
  const o = publicationObjectV1(v, [
    "version",
    "repository",
    "baseBranch",
    "baseOid",
    "targetBranch",
    "expectedTarget",
    "proposedOid",
    "draftPullRequest",
    "actions",
  ]);
  repository(o.repository);
  actions(o.actions);
  if (
    o.version !== 1 ||
    !publicationBranchV1(o.baseBranch) ||
    !publicationBranchV1(o.targetBranch) ||
    o.baseBranch === o.targetBranch ||
    !publicationOidV1(o.baseOid) ||
    !publicationOidV1(o.proposedOid)
  )
    publicationRefuseV1();
  const expected = o.expectedTarget as Record<string, unknown>;
  publicationObjectV1(expected, expected?.kind === "create" ? ["kind"] : ["kind", "oid"]);
  if (
    expected.kind !== "create" &&
    (expected.kind !== "existing" ||
      !publicationOidV1(expected.oid) ||
      expected.oid === o.proposedOid)
  )
    publicationRefuseV1();
  const pr = publicationObjectV1(o.draftPullRequest, ["title", "body", "draft"]);
  if (
    pr.draft !== true ||
    typeof pr.title !== "string" ||
    Buffer.byteLength(pr.title) < 1 ||
    Buffer.byteLength(pr.title) > 256 ||
    /[\x00-\x1f\x7f]/.test(pr.title) ||
    typeof pr.body !== "string" ||
    Buffer.byteLength(pr.body) > 32768 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(pr.body)
  )
    publicationRefuseV1();
}
export function parsePublicationRequestV1(value: unknown): PublicationRequestV1 {
  const fixed = publicationSnapshotV1(value);
  request(fixed);
  return fixed as PublicationRequestV1;
}
export function parsePublicationWorkBindingV1(value: unknown): PublicationWorkBindingV1 {
  const fixed = publicationSnapshotV1(value);
  const o = publicationObjectV1(fixed, [
    "installationId",
    "namespaceId",
    "agentId",
    "agentRevisionRef",
    "workRef",
    "workRevision",
    "authorityRef",
    "authorityRevision",
    "operationRef",
    "invocationRef",
    "requestDigest",
    "executionBindingDigest",
    "requesterPrincipalId",
  ]);
  for (const k of [
    "installationId",
    "namespaceId",
    "agentId",
    "agentRevisionRef",
    "workRef",
    "authorityRef",
    "authorityRevision",
    "operationRef",
    "invocationRef",
    "requesterPrincipalId",
  ])
    if (!publicationReferenceV1(o[k])) publicationRefuseV1();
  if (
    !Number.isSafeInteger(o.workRevision) ||
    Number(o.workRevision) < 1 ||
    !publicationSha256V1(o.requestDigest) ||
    !publicationSha256V1(o.executionBindingDigest)
  )
    publicationRefuseV1();
  return fixed as PublicationWorkBindingV1;
}
export function parsePublicationGraphV1(value: unknown): PublicationGraphV1 {
  const fixed = publicationSnapshotV1(value);
  const o = publicationObjectV1(fixed, [
    "version",
    "objectFormat",
    "proposedOid",
    "baseOid",
    "graphDigest",
    "objectCount",
    "rawBytes",
    "packSha256",
    "packBytes",
  ]);
  if (
    o.version !== 1 ||
    o.objectFormat !== "sha1" ||
    !publicationOidV1(o.proposedOid) ||
    !publicationOidV1(o.baseOid) ||
    !publicationSha256V1(o.graphDigest) ||
    !publicationSha256V1(o.packSha256) ||
    [o.objectCount, o.rawBytes, o.packBytes].some((n) => !Number.isSafeInteger(n) || Number(n) < 1)
  )
    publicationRefuseV1();
  return fixed as PublicationGraphV1;
}
export function createPublicationCandidateV1(
  work: PublicationWorkBindingV1,
  req: PublicationRequestV1,
  graph: PublicationGraphV1,
): PublicationCandidateV1 {
  const fixed = Object.freeze({
    version: 1 as const,
    work: parsePublicationWorkBindingV1(work),
    request: parsePublicationRequestV1(req),
    graph: parsePublicationGraphV1(graph),
  });
  if (
    fixed.work.installationId !== fixed.request.repository.installationId ||
    fixed.graph.proposedOid !== fixed.request.proposedOid ||
    fixed.graph.baseOid !== fixed.request.baseOid ||
    fixed.work.requestDigest !== publicationDigestV1("request", fixed.request)
  )
    publicationRefuseV1();
  return Object.freeze({ ...fixed, actionDigest: publicationDigestV1("candidate-actions", fixed) });
}
export function parsePublicationCandidateV1(value: unknown): PublicationCandidateV1 {
  const o = publicationObjectV1(publicationSnapshotV1(value), [
    "version",
    "work",
    "request",
    "graph",
    "actionDigest",
  ]);
  const fixed = createPublicationCandidateV1(
    o.work as PublicationWorkBindingV1,
    o.request as PublicationRequestV1,
    o.graph as PublicationGraphV1,
  );
  if (o.version !== 1 || o.actionDigest !== fixed.actionDigest) publicationRefuseV1();
  return fixed;
}
export function parsePublicationApproverPolicyV1(value: unknown): PublicationApproverPolicyV1 {
  const fixed = publicationSnapshotV1(value);
  const o = publicationObjectV1(fixed, [
    "version",
    "policyRef",
    "revision",
    "approverPrincipalIds",
    "allowSelfApproval",
    "approvalLifetimeMs",
    "rules",
    "actions",
  ]);
  actions(o.actions);
  if (
    o.version !== 1 ||
    !publicationReferenceV1(o.policyRef) ||
    !publicationReferenceV1(o.revision) ||
    typeof o.allowSelfApproval !== "boolean" ||
    !Number.isSafeInteger(o.approvalLifetimeMs) ||
    Number(o.approvalLifetimeMs) < 1000 ||
    Number(o.approvalLifetimeMs) > 86400000
  )
    publicationRefuseV1();
  const ids = o.approverPrincipalIds;
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 128 ||
    ids.some((id) => !publicationReferenceV1(id)) ||
    new Set(ids).size !== ids.length
  )
    publicationRefuseV1();
  if (!Array.isArray(o.rules) || o.rules.length < 1 || o.rules.length > 64) publicationRefuseV1();
  for (const rule of o.rules) {
    const r = publicationObjectV1(rule, [
      "repository",
      "baseBranch",
      "targetBranches",
      "allowCreate",
    ]);
    repository(r.repository);
    if (
      !publicationBranchV1(r.baseBranch) ||
      typeof r.allowCreate !== "boolean" ||
      !Array.isArray(r.targetBranches) ||
      r.targetBranches.length < 1 ||
      r.targetBranches.length > 128 ||
      r.targetBranches.some((b) => !publicationBranchV1(b) || b === r.baseBranch) ||
      new Set(r.targetBranches).size !== r.targetBranches.length
    )
      publicationRefuseV1();
  }
  return fixed as PublicationApproverPolicyV1;
}
/** An additional closed local policy check; the original State/IAM owner must
 * independently qualify the actual actor and current policy under its lease. */
export function publicationPolicyAllowsV1(
  policy: PublicationApproverPolicyV1,
  candidate: PublicationCandidateV1,
  principalId: string,
): boolean {
  return (
    policy.approverPrincipalIds.includes(principalId) &&
    (policy.allowSelfApproval || principalId !== candidate.work.requesterPrincipalId) &&
    policy.rules.some(
      (r) =>
        publicationCanonicalV1(r.repository) ===
          publicationCanonicalV1(candidate.request.repository) &&
        r.baseBranch === candidate.request.baseBranch &&
        r.targetBranches.includes(candidate.request.targetBranch) &&
        (candidate.request.expectedTarget.kind === "existing" || r.allowCreate),
    )
  );
}

declare const captureBrand: unique symbol;
/** Issued and recognized only by the concrete Git object custodian. It proves
 * retained bytes, never approval. Persisted graph digests can recover bytes. */
export interface GitObjectCaptureV1 {
  readonly [captureBrand]: true;
}

/** Every operand remains privately recognized by its original producer. All release/finalizer methods are idempotent and join original resource retirement; failures may be retried on the same operand without a new effect. A type
 * parameter, copied record, or database reference cannot construct an operand. */
export interface PublicationOriginalsV1 {
  readonly actor: object;
  readonly publisher: object;
  readonly work: object;
  readonly candidate: object;
  readonly approval: object;
  readonly effect: object;
  readonly use: object;
  readonly prepared: object;
  readonly outcome: object;
}
export type PublicationCommitV1<T extends object> =
  | Readonly<{ kind: "committed"; original: T }>
  | Readonly<{ kind: "unknown"; reference: string }>
  | Readonly<{ kind: "refused" }>;
export type PublicationEffectClaimV1<T extends object, C extends object> =
  | PublicationCommitV1<T>
  | Readonly<{ kind: "existing"; candidate: C; status: PublicationStatusV1 }>;

/** The original Work owner supplies the publication-specific operation and
 * current held Work/authority revision. This is not the read-profile adapter. */
export interface PublicationWorkSourceV1<B extends PublicationOriginalsV1> {
  acquire(
    actor: B["actor"],
    request: PublicationRequestV1,
    call: PublicationCallV1,
  ): Promise<B["work"] | undefined>;
  inspect(original: B["work"], call: PublicationCallV1): PublicationWorkBindingV1;
  assertCurrent(original: B["work"], call: PublicationCallV1): undefined;
  release(original: B["work"]): Promise<void>;
}

export interface PublicationApprovalLeaseV1<B extends PublicationOriginalsV1> {
  readonly candidate: B["candidate"];
  readonly principalId: string;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
  assertCurrent(): undefined;
  /** Original State repeats current IAM/policy/candidate checks and creates the
   * approval only after acknowledged outer COMMIT. Unknown supplies no approval. */
  commit(): Promise<PublicationCommitV1<B["approval"]>>;
  release(): Promise<void>;
}

export interface PublicationUseLeaseV1<B extends PublicationOriginalsV1> {
  readonly original: B["use"];
  readonly candidate: B["candidate"];
  readonly approval: B["approval"];
  readonly effect: B["effect"];
  assertCurrent(): undefined;
  /** Synchronous final fence immediately before fixed DS submission. Held
   * authority is retained until the original submission actually drains. */
  beginSubmittedUse(): undefined;
  release(): Promise<void>;
}

/** Implemented by the original State/IAM owner, using its actual
 * private participants and existing transaction infrastructure. Construction
 * must pair the original Work, Git-capture and DS outcome recognizers once.
 * No implementation or permissive default is supplied by these declarations. */
export interface PublicationStateSourceV1<B extends PublicationOriginalsV1> {
  prepareCandidate(
    work: B["work"],
    candidate: PublicationCandidateV1,
    capture: GitObjectCaptureV1,
    call: PublicationCallV1,
  ): Promise<PublicationCommitV1<B["candidate"]>>;
  inspectCandidate(
    original: B["candidate"],
  ): Readonly<{ candidateRef: string; candidate: PublicationCandidateV1 }>;
  acquireApproval(
    actor: B["actor"],
    candidateRef: string,
    policy: PublicationApproverPolicyV1,
    call: PublicationCallV1,
  ): Promise<PublicationApprovalLeaseV1<B> | undefined>;
  inspectApproval(original: B["approval"]): PublicationApprovalV1;
  /** No recovered or existing claim is returned as a fresh execution operand.
   * PR claims require the separately known-recorded exact push confirmation. */
  claimEffect(
    publisher: B["publisher"],
    candidateRef: string,
    approvalRef: string,
    kind: PublicationEffectKindV1,
    policy: PublicationApproverPolicyV1,
    call: PublicationCallV1,
  ): Promise<PublicationEffectClaimV1<B["effect"], B["candidate"]>>;
  inspectEffect(
    original: B["effect"],
  ): Readonly<{ effect: PublicationEffectV1; candidate: B["candidate"]; approval: B["approval"] }>;
  /** Reacquire current Work/IAM/approval/repository controls after DS preparation;
   * recognize the exact private DS prepared receiver, not a request DTO. */
  acquireUse(
    original: B["effect"],
    prepared: B["prepared"],
    call: PublicationCallV1,
  ): Promise<PublicationUseLeaseV1<B> | undefined>;
  /** Uses the independently retained original effect observer after caller
   * cancellation; it recognizes the exact original DS outcome object. Before
   * asynchronous recording, synchronously enroll custody of that exact offered
   * outcome under this observer. Failure or unknown acknowledgement cannot drop
   * the offered observation; releaseEffect joins its durable accounting. */
  recordOutcome(original: B["effect"], outcome: B["outcome"]): Promise<"committed" | "unknown">;
  /** Permitted only when the original State submission latch was never entered. */
  recordNotSubmitted(original: B["effect"]): Promise<"committed" | "unknown">;
  /** Retains the original submitted claim as uncertain, including any exact
   * original attributed outcome whose inspection/matching/drain failed. Before
   * asynchronous recording, synchronously enroll custody of every non-null
   * offered outcome under the original observer, including on failed or unknown
   * acknowledgement. The original DS recognizer supplies that evidence; null
   * means no result was obtained. Never downgrade a known recorded outcome or
   * permit retry. Generic unknown status alone cannot replace exact observation
   * custody; releaseEffect joins its durable accounting. */
  recordUncertain(
    original: B["effect"],
    observed: B["outcome"] | null,
  ): Promise<"committed" | "unknown">;
  /** Exact durable status/readback through the original observer; no execution
   * witness or automatic replay is produced by recovery. */
  statusForEffect(original: B["effect"]): Promise<PublicationStatusV1>;
  readStatus(
    actor: B["actor"],
    candidateRef: string,
    call: PublicationCallV1,
  ): Promise<PublicationStatusV1>;
  /** Idempotently joins the original observer. Every enrolled exact observation
   * must be durably accounted or transferred to this owner's actual durable
   * recovery ownership before retirement. Failed/unknown record acknowledgement
   * cannot retire or drop it. This is the existing effect journal's responsibility,
   * not another upstream submission or a parallel observation journal. */
  releaseEffect(original: B["effect"]): Promise<void>;
}

export interface PublicationSubmissionV1<O extends object> {
  readonly result: Promise<O>;
  /** Resolves only after actual acknowledgement or physical retirement. An
   * outward timeout/cancellation alone cannot settle this promise. */
  readonly drained: Promise<void>;
}

/** Implemented by the existing protected DS/native dispatcher. These methods
 * allow no caller URL, arbitrary HTTP body, credential accessor or sink. The
 * constructor pairs original State effect/use and capture recognizers once. */
export interface PublicationDispatcherV1<B extends PublicationOriginalsV1> {
  preparePush(
    publisher: B["publisher"],
    effect: B["effect"],
    candidate: PublicationCandidateV1,
    capture: GitObjectCaptureV1,
    call: PublicationCallV1,
  ): Promise<B["prepared"] | undefined>;
  prepareDraftPullRequest(
    publisher: B["publisher"],
    effect: B["effect"],
    candidate: PublicationCandidateV1,
    call: PublicationCallV1,
  ): Promise<B["prepared"] | undefined>;
  inspectPrepared(
    original: B["prepared"],
  ): Readonly<{ effectRef: string; actionDigest: string; kind: PublicationEffectKindV1 }>;
  /** Must synchronously validate original operands and submit the fixed native
   * request before returning. Once submission is possible it MUST return its
   * original result/drain ticket even if the caller has already cancelled. */
  submit(original: B["prepared"], use: B["use"]): PublicationSubmissionV1<B["outcome"]>;
  inspectOutcome(
    original: B["outcome"],
  ): Readonly<{ effectRef: string; actionDigest: string; outcome: PublicationEffectOutcomeV1 }>;
  /** Joins any original submitted work even if a malformed ticket or exception
   * prevented the caller from obtaining result/drained. Never a timeout shortcut.
   * Separately issued original outcomes remain recognized after this release
   * until the original State observer's observation-custody transfer completes;
   * retiring a prepared request cannot invalidate an offered outcome. */
  releasePrepared(original: B["prepared"]): Promise<void>;
}

export function parsePublicationApprovalV1(value: unknown): PublicationApprovalV1 {
  const fixed = publicationSnapshotV1(value);
  const o = publicationObjectV1(fixed, [
    "version",
    "approvalRef",
    "candidateRef",
    "actionDigest",
    "approverPrincipalId",
    "policyRef",
    "policyRevision",
    "policyDigest",
    "approvedAtMs",
    "expiresAtMs",
  ]);
  if (
    o.version !== 1 ||
    [o.approvalRef, o.candidateRef, o.approverPrincipalId, o.policyRef, o.policyRevision].some(
      (r) => !publicationReferenceV1(r),
    ) ||
    !publicationSha256V1(o.actionDigest) ||
    !publicationSha256V1(o.policyDigest) ||
    !Number.isSafeInteger(o.approvedAtMs) ||
    !Number.isSafeInteger(o.expiresAtMs) ||
    Number(o.approvedAtMs) < 0 ||
    Number(o.expiresAtMs) <= Number(o.approvedAtMs)
  )
    publicationRefuseV1();
  return fixed as PublicationApprovalV1;
}
export function parsePublicationEffectV1(value: unknown): PublicationEffectV1 {
  const fixed = publicationSnapshotV1(value);
  const o = publicationObjectV1(fixed, [
    "version",
    "effectRef",
    "kind",
    "candidateRef",
    "approvalRef",
    "actionDigest",
    "confirmedPushEffectRef",
  ]);
  if (
    o.version !== 1 ||
    [o.effectRef, o.candidateRef, o.approvalRef].some((r) => !publicationReferenceV1(r)) ||
    !publicationSha256V1(o.actionDigest) ||
    (o.kind === "push"
      ? o.confirmedPushEffectRef !== null
      : o.kind !== "create-draft-pr" ||
        !publicationReferenceV1(o.confirmedPushEffectRef) ||
        o.confirmedPushEffectRef === o.effectRef)
  )
    publicationRefuseV1();
  return fixed as PublicationEffectV1;
}
function pullRequestObservation(value: unknown): PublicationPullRequestObservationV1 {
  const o = publicationObjectV1(value, [
    "number",
    "url",
    "repositoryId",
    "baseBranch",
    "baseOid",
    "headBranch",
    "headOid",
    "title",
    "body",
    "draft",
  ]);
  if (
    [o.number, o.repositoryId].some(
      (n) => typeof n !== "string" || !/^[1-9][0-9]{0,19}(?![\s\S])/.test(n),
    ) ||
    typeof o.url !== "string" ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*(?![\s\S])/.test(
      o.url,
    ) ||
    !o.url.endsWith("/" + String(o.number)) ||
    !publicationBranchV1(o.baseBranch) ||
    !publicationBranchV1(o.headBranch) ||
    !publicationOidV1(o.baseOid) ||
    !publicationOidV1(o.headOid) ||
    typeof o.title !== "string" ||
    Buffer.byteLength(o.title) > 256 ||
    typeof o.body !== "string" ||
    Buffer.byteLength(o.body) > 32768 ||
    typeof o.draft !== "boolean"
  )
    publicationRefuseV1();
  return o as unknown as PublicationPullRequestObservationV1;
}
export function parsePublicationEffectOutcomeV1(value: unknown): PublicationEffectOutcomeV1 {
  const fixed = publicationSnapshotV1(value);
  if (!fixed || typeof fixed !== "object" || Array.isArray(fixed)) publicationRefuseV1();
  const o = fixed as Record<string, unknown>;
  if (o.kind === "not-dispatched") publicationObjectV1(o, ["kind"]);
  else if (o.kind === "unknown") {
    publicationObjectV1(o, ["kind", "pullRequest"]);
    if (o.pullRequest !== null) pullRequestObservation(o.pullRequest);
  } else if (o.kind === "rejected") {
    publicationObjectV1(o, ["kind", "reason"]);
    if (
      typeof o.reason !== "string" ||
      !["expected-old", "non-fast-forward", "upstream"].includes(o.reason)
    )
      publicationRefuseV1();
  } else if (o.kind === "pushed") {
    publicationObjectV1(o, ["kind", "ref", "oldOid", "newOid"]);
    if (
      typeof o.ref !== "string" ||
      !o.ref.startsWith("refs/heads/") ||
      !publicationBranchV1(o.ref.slice(11)) ||
      (o.oldOid !== "0".repeat(40) && !publicationOidV1(o.oldOid)) ||
      !publicationOidV1(o.newOid)
    )
      publicationRefuseV1();
  } else if (o.kind === "draft-pr-created") {
    publicationObjectV1(o, ["kind", "pullRequest"]);
    pullRequestObservation(o.pullRequest);
  } else publicationRefuseV1();
  return fixed as PublicationEffectOutcomeV1;
}
/** Checks exact response correspondence, not atomic remote branch stability. */
export function publicationOutcomeMatchesV1(
  candidate: PublicationCandidateV1,
  effect: PublicationEffectV1,
  outcome: PublicationEffectOutcomeV1,
): boolean {
  if (effect.actionDigest !== candidate.actionDigest) return false;
  if (outcome.kind === "pushed")
    return (
      effect.kind === "push" &&
      outcome.ref === "refs/heads/" + candidate.request.targetBranch &&
      outcome.newOid === candidate.request.proposedOid &&
      outcome.oldOid ===
        (candidate.request.expectedTarget.kind === "create"
          ? "0".repeat(40)
          : candidate.request.expectedTarget.oid)
    );
  if (outcome.kind === "draft-pr-created") {
    const p = outcome.pullRequest;
    return (
      effect.kind === "create-draft-pr" &&
      p.repositoryId === candidate.request.repository.repositoryId &&
      p.baseBranch === candidate.request.baseBranch &&
      p.baseOid === candidate.request.baseOid &&
      p.headBranch === candidate.request.targetBranch &&
      p.headOid === candidate.request.proposedOid &&
      p.title === candidate.request.draftPullRequest.title &&
      p.body === candidate.request.draftPullRequest.body &&
      p.draft
    );
  }
  return (
    outcome.kind !== "unknown" || outcome.pullRequest === null || effect.kind === "create-draft-pr"
  );
}
export function parsePublicationStatusV1(value: unknown): PublicationStatusV1 {
  const fixed = publicationSnapshotV1(value);
  const o = publicationObjectV1(fixed, [
    "version",
    "candidateRef",
    "actionDigest",
    "state",
    "push",
    "pullRequest",
  ]);
  if (
    o.version !== 1 ||
    !publicationReferenceV1(o.candidateRef) ||
    !publicationSha256V1(o.actionDigest) ||
    ![
      "awaiting-approval",
      "approved",
      "publishing",
      "pushed",
      "draft-pr-created",
      "rejected",
      "cancelled",
      "unknown",
    ].includes(typeof o.state === "string" ? o.state : "")
  )
    publicationRefuseV1();
  for (const key of ["push", "pullRequest"] as const)
    if (o[key] !== null) {
      const e = publicationObjectV1(o[key], ["effect", "outcome"]);
      const effect = parsePublicationEffectV1(e.effect);
      parsePublicationEffectOutcomeV1(e.outcome);
      if (
        effect.candidateRef !== o.candidateRef ||
        effect.actionDigest !== o.actionDigest ||
        effect.kind !== (key === "push" ? "push" : "create-draft-pr")
      )
        publicationRefuseV1();
    }
  const status = fixed as PublicationStatusV1;
  const push = status.push;
  const pr = status.pullRequest;
  if (
    push?.outcome.kind === "draft-pr-created" ||
    (push?.outcome.kind === "unknown" && push.outcome.pullRequest !== null) ||
    pr?.outcome.kind === "pushed"
  )
    publicationRefuseV1();
  if (
    pr &&
    (!push ||
      push.outcome.kind !== "pushed" ||
      pr.effect.confirmedPushEffectRef !== push.effect.effectRef ||
      pr.effect.approvalRef !== push.effect.approvalRef ||
      pr.effect.effectRef === push.effect.effectRef)
  )
    publicationRefuseV1();
  if ((status.state === "awaiting-approval" || status.state === "approved") && (push || pr))
    publicationRefuseV1();
  if (
    status.state === "draft-pr-created" &&
    (push?.outcome.kind !== "pushed" || pr?.outcome.kind !== "draft-pr-created")
  )
    publicationRefuseV1();
  if (
    status.state === "pushed" &&
    (push?.outcome.kind !== "pushed" ||
      (pr && pr.outcome.kind !== "rejected" && pr.outcome.kind !== "not-dispatched"))
  )
    publicationRefuseV1();
  if (pr?.outcome.kind === "draft-pr-created" && status.state !== "draft-pr-created")
    publicationRefuseV1();
  if (
    pr?.outcome.kind === "draft-pr-created" &&
    (push?.outcome.kind !== "pushed" ||
      pr.outcome.pullRequest.headOid !== push.outcome.newOid ||
      "refs/heads/" + pr.outcome.pullRequest.headBranch !== push.outcome.ref)
  )
    publicationRefuseV1();
  if (
    status.state === "publishing" &&
    (!push || (pr ? pr.outcome.kind !== "unknown" : push.outcome.kind !== "unknown"))
  )
    publicationRefuseV1();
  if (
    (status.state === "rejected" || status.state === "cancelled") &&
    (pr || (push && push.outcome.kind !== "rejected" && push.outcome.kind !== "not-dispatched"))
  )
    publicationRefuseV1();
  if (
    status.state === "unknown" &&
    (pr ? pr.outcome.kind !== "unknown" : push !== null && push.outcome.kind !== "unknown")
  )
    publicationRefuseV1();
  return status;
}
