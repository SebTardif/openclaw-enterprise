import type {
  GitHubMediationNativeServiceSession,
  GitHubMediationNativeServiceSource,
} from "../../../apps/controller/src/admission/github-mediation-context.ts";
import type { RepositoryWorkSourcesV2 } from "../../../packages/occ/src/lifecycle/repository-work-v2.ts";
import {
  RepositoryWorkOriginOwnerV2,
  type OriginalRepositoryWorkOriginV2,
  type RepositoryWorkOriginAssignmentSourceV2,
  type RepositoryWorkOriginLimitsV2,
  type RepositoryWorkOriginNativeCustodyV2,
  type RepositoryWorkOriginNativeRecognizerV2,
} from "@openclaw-enterprise/occ/runtime-authority/repository-work-origin-v2";
import type { RuntimeServiceTrustService } from "../../../packages/occ/src/runtime-authority/service-trust.ts";

/** Compile-only correspondence to actual original constructor declarations.
 * No source is fabricated, no admission is executed, and this is not installed
 * production assembly. The concrete State assignment source remains required. */
export function pairOriginalConstructors<Assignment>(
  native: GitHubMediationNativeServiceSource,
  assignments: RepositoryWorkOriginAssignmentSourceV2<
    Assignment,
    GitHubMediationNativeServiceSession
  >,
  trust: RuntimeServiceTrustService,
  limits: RepositoryWorkOriginLimitsV2,
): RepositoryWorkSourcesV2<{
  origin: OriginalRepositoryWorkOriginV2;
  preparation: never;
  token: never;
  commit: never;
}>["native"] {
  return new RepositoryWorkOriginOwnerV2({ native, assignments, trust, limits });
}

export function rejectMetadataOrigin(metadata: object): void {
  // @ts-expect-error Projected metadata has no original Runtime membership.
  const origin: OriginalRepositoryWorkOriginV2 = metadata;
  void origin;
}

export function pairOriginalGitConstructors<Assignment>(
  native: GitHubMediationNativeServiceSource<3>,
  assignments: RepositoryWorkOriginAssignmentSourceV2<
    Assignment,
    GitHubMediationNativeServiceSession,
    3
  >,
  trust: RuntimeServiceTrustService,
  limits: RepositoryWorkOriginLimitsV2,
): RepositoryWorkOriginOwnerV2<GitHubMediationNativeServiceSession, Assignment, 3> {
  return new RepositoryWorkOriginOwnerV2({
    protocolVersion: 3,
    native,
    assignments,
    trust,
    limits,
  });
}

export function rejectCrossedOriginalConstructors<Assignment>(
  native: GitHubMediationNativeServiceSource,
  gitNative: GitHubMediationNativeServiceSource<3>,
  assignments: RepositoryWorkOriginAssignmentSourceV2<
    Assignment,
    GitHubMediationNativeServiceSession
  >,
  gitAssignments: RepositoryWorkOriginAssignmentSourceV2<
    Assignment,
    GitHubMediationNativeServiceSession,
    3
  >,
  trust: RuntimeServiceTrustService,
  limits: RepositoryWorkOriginLimitsV2,
  origin: OriginalRepositoryWorkOriginV2,
  gitOrigin: OriginalRepositoryWorkOriginV2<3>,
  version: 2 | 3,
): void {
  const crossedNative = {
    protocolVersion: 3 as const,
    native,
    assignments: gitAssignments,
    trust,
    limits,
  };
  // @ts-expect-error A metadata native source cannot be selected as the Git source.
  new RepositoryWorkOriginOwnerV2(crossedNative);
  const crossedAssignment = {
    protocolVersion: 3 as const,
    native: gitNative,
    assignments,
    trust,
    limits,
  };
  // @ts-expect-error Metadata assignment recognition cannot supply Git permissions.
  new RepositoryWorkOriginOwnerV2(crossedAssignment);
  const inferred = { native: gitNative, assignments: gitAssignments, trust, limits };
  // @ts-expect-error Git selection must be explicit, not inferred from source or request.
  new RepositoryWorkOriginOwnerV2(inferred);
  const ambiguous = {
    protocolVersion: version,
    native: gitNative,
    assignments: gitAssignments,
    trust,
    limits,
  };
  // @ts-expect-error One original construction cannot select a version union.
  new RepositoryWorkOriginOwnerV2(ambiguous);
  // @ts-expect-error An original Git origin cannot become a metadata origin.
  const metadataOrigin: OriginalRepositoryWorkOriginV2 = gitOrigin;
  // @ts-expect-error An original metadata origin cannot become a Git origin.
  const crossedOrigin: OriginalRepositoryWorkOriginV2<3> = origin;
  // @ts-expect-error The opaque original handle cannot widen its version.
  const ambiguousOrigin: OriginalRepositoryWorkOriginV2<2 | 3> = gitOrigin;
  void [metadataOrigin, crossedOrigin, ambiguousOrigin];
}

/** Custody construction keeps opaque Work O distinct from original native N. */
export function pairOriginalGitCustody<Assignment>(
  native: GitHubMediationNativeServiceSource<3>,
  assignments: RepositoryWorkOriginAssignmentSourceV2<
    Assignment,
    GitHubMediationNativeServiceSession,
    3
  >,
  nativeCustody: RepositoryWorkOriginNativeCustodyV2<GitHubMediationNativeServiceSession, 3>,
  trust: RuntimeServiceTrustService,
  limits: RepositoryWorkOriginLimitsV2,
): RepositoryWorkOriginOwnerV2<GitHubMediationNativeServiceSession, Assignment, 3> {
  return new RepositoryWorkOriginOwnerV2({
    protocolVersion: 3,
    native,
    assignments,
    nativeCustody,
    trust,
    limits,
  });
}
export function rejectCrossedCustody(
  metadata: RepositoryWorkOriginNativeCustodyV2<GitHubMediationNativeServiceSession>,
  git: RepositoryWorkOriginNativeRecognizerV2<GitHubMediationNativeServiceSession, 3>,
  metadataOrigin: OriginalRepositoryWorkOriginV2,
  call: Parameters<typeof git.recognize>[1],
): void {
  // @ts-expect-error Metadata custody cannot consume a Git origin recognizer.
  const crossed: RepositoryWorkOriginNativeCustodyV2<GitHubMediationNativeServiceSession, 3> =
    metadata;
  // @ts-expect-error An opaque Runtime origin is not the retained native Session.
  const session: GitHubMediationNativeServiceSession = metadataOrigin;
  // @ts-expect-error Git custody recognition requires its original Git origin.
  git.recognize(metadataOrigin, call);
  void [crossed, session];
}

/** Original Work captures this method with its Runtime receiver; its native
 * port extension and SQL phase remain original Work-owned implementation. */
export function captureOriginalGitNativeHandoff<Assignment>(
  owner: RepositoryWorkOriginOwnerV2<GitHubMediationNativeServiceSession, Assignment, 3>,
): Readonly<
  Pick<
    RepositoryWorkOriginOwnerV2<GitHubMediationNativeServiceSession, Assignment, 3>,
    "assertNativeCurrent"
  >
> {
  return Object.freeze({ assertNativeCurrent: owner.assertNativeCurrent.bind(owner) });
}

export function rejectCrossedNativeHandoff<Assignment>(
  owner: RepositoryWorkOriginOwnerV2<GitHubMediationNativeServiceSession, Assignment, 3>,
  metadata: OriginalRepositoryWorkOriginV2,
  call: Parameters<typeof owner.assertNativeCurrent>[1],
): void {
  // @ts-expect-error Native-only handoff still requires the original selected Git origin.
  owner.assertNativeCurrent(metadata, call);
}
