import type {
  AuthorityCallV1,
  RuntimeAuthorityVerifiedServiceV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type {
  VersionedWorkRefV2,
  WorkExecutionAssociationV2,
  WorkInstantV2,
  WorkOriginalOperationV2,
} from "../lifecycle/work-authority-ports-v2.ts";
import type {
  DispatchRead,
  GitHubMediationTimes,
  GitHubMediationVersion,
  OpenRead,
  Refused,
} from "./wire.ts";

/** Original native accepting owner only. Inspection must recognize its private
 * call context and the digest of the exact metadata received on that connection.
 * Startup pins the actual admitted metadata-v2 or Git-read-v3 service profile
 * corresponding to its broker instance; a caller-selected version is no grant.
 * Neither decoded metadata nor a service name can construct a context. */
export interface GitHubMediationTransportOwner {
  inspect(
    call: AuthorityCallV1,
    metadataSha256: string,
  ): Promise<RuntimeAuthorityVerifiedServiceV1 | undefined>;
  writeMetadata(metadata: Uint8Array, call: AuthorityCallV1): Promise<void>;
  close(call: AuthorityCallV1): Promise<void>;
}

/** These are the existing Work owner's diagnostic types. Their private prepared
 * operand is authenticated separately by that owner's runtime recognizer. */
export type GitHubMediationOriginalWork = Readonly<{
  original: WorkOriginalOperationV2;
  work: VersionedWorkRefV2;
  execution: WorkExecutionAssociationV2;
  originalHorizon: WorkInstantV2;
}>;
export type GitHubMediationPreparation<P> = GitHubMediationOriginalWork &
  Readonly<{
    kind: "prepared";
    preparation: P;
    workBindingSha256: string;
    dnsBindingRef: string;
    upstreamIpv4: string;
    times: GitHubMediationTimes;
  }>;
export type GitHubMediationRefusal = Readonly<{
  kind: "refused";
  code: Refused["code"];
}>;
export type GitHubMediationRelease<R> =
  | Readonly<{
      kind: "released";
      release: R;
      releaseRef: string;
      times: GitHubMediationTimes;
    }>
  | Readonly<{ kind: "not-released"; code: Refused["code"] }>
  | Readonly<{ kind: "unknown" }>;
export type GitHubMediationOutcome = "not-dispatched" | "completed" | "unknown";

/** Actual original authority/inventory/custody composition. No default owner or
 * positive handle constructor exists. Bind P/R to the original implementation's
 * privately recognized preparation and committed release types, never DTOs.
 *
 * prepare resolves current protected origin, immutable original Work, exact
 * repository scope and DNS preparation. dispatch rechecks original authority
 * after preparation/mint and commits distinct dispatch/release responsibility
 * under the original closure-conflicting transaction, before any socket write.
 * Unknown COMMIT permits original readback only. No provider I/O occurs inside
 * the transaction. Every operation must bound and settle its accepted work.
 * The version parameter defaults to the exact metadata owner. Version 3 must
 * explicitly recognize original Git read authority (contents:read plus
 * metadata:read), its admitted profile and the retained outgoing body binding.
 * Discovery/upload-pack rounds retain original Work without renewing its horizon;
 * each round is a distinct repository-use effect, separate from token issuance.
 */
export interface GitHubMediationOperationOwner<
  P = never,
  R = never,
  V extends GitHubMediationVersion = 2,
> {
  // Function properties preserve strict parameter variance across profile types;
  // a metadata-only owner cannot first widen to a union and then become Git.
  prepare: (
    request: OpenRead<V>,
    call: AuthorityCallV1,
  ) => Promise<GitHubMediationPreparation<P> | GitHubMediationRefusal>;
  dispatch: (
    preparation: P,
    request: DispatchRead<V>,
    call: AuthorityCallV1,
  ) => Promise<GitHubMediationRelease<R>>;
  check(
    preparation: P,
    release: R,
    call: AuthorityCallV1,
  ): Promise<Readonly<{ kind: "current"; times: GitHubMediationTimes }> | GitHubMediationRefusal>;
  /** Use-specific custody borrows recorded token bytes and writes only to its
   * fixed, original authenticated native exchange. The owner recognizes R and
   * validates the exact metadata/receiver before use. It accepts no arbitrary
   * sink or callback and never returns a token-bearing object. */
  writeRelease(release: R, metadata: Uint8Array, call: AuthorityCallV1): Promise<void>;
  /** Retained original responsibility survives native closure and cancellation.
   * It records exposure separately from business submission and cannot grant,
   * remint, resend or replace the original operation. Cleanup is bounded by the
   * original owner and is joined even when the public call was cancelled. */
  settle(
    preparation: P,
    release: R | undefined,
    outcome: GitHubMediationOutcome,
  ): Promise<"recorded" | "unavailable">;
}

export interface GitHubMediationLimits {
  readonly maximumSessions: number;
  readonly maximumCallMilliseconds: number;
  readonly maximumOperationMilliseconds: number;
  readonly maximumLeaseMilliseconds: number;
  readonly clockAllowanceMilliseconds: number;
}
