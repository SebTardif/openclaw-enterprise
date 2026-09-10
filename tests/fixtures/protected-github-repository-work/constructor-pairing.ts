import type {
  GitHubMediationVersion,
  OpenRead,
} from "../../../packages/occ/src/github-mediation-v2/wire.ts";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import {
  createProtectedGitHubRepositorySourcesV2,
  type ProtectedGitHubWorkTokenV2,
} from "../../../packages/occ/src/credential-custody-v1/protected-github-repository-work.ts";
import type { ProtectedGitHubTokenCustodyV1 } from "../../../packages/occ/src/credential-custody-v1/protected-github-token-custody.ts";
import type {
  ProtectedGitHubNativeSourceV2,
  ProtectedGitHubReleaseOptionsV2,
  ProtectedGitHubReleaseBindingV2,
} from "../../../packages/occ/src/credential-custody-v1/protected-github-release.ts";
import type {
  RepositoryWorkSelectionSourceV2,
  RepositoryWorkStatePreparationV2,
} from "../../../packages/occ/src/lifecycle/repository-work-state-v2.ts";
import type {
  RepositoryWorkNativeBindingV2,
  RepositoryWorkSourcesV2,
} from "../../../packages/occ/src/lifecycle/repository-work-v2.ts";
import type { RepositoryWorkCommittedV2 } from "../../../packages/occ/src/ports/repository-work-v2.ts";
import type {
  OriginalRepositoryWorkOriginV2,
  RepositoryWorkNativeSessionSourceV2,
  RepositoryWorkOriginAssignmentSourceV2,
  RepositoryWorkOriginOwnerV2,
  RepositoryWorkOriginNativeRecognizerV2,
} from "../../../packages/occ/src/runtime-authority/repository-work-origin-v2.ts";

/** Compile-only checks against actual exported constructor declarations. These
 * functions are never invoked: their parameters do not construct or enroll
 * native sessions, State assignments, Work preparations or release authority.
 * Concrete controller/native enrollment remains separate integration coverage. */
type Options<
  N extends object,
  A extends object,
  S extends object,
  W extends object,
  V extends GitHubMediationVersion = 2,
> = Parameters<typeof createProtectedGitHubRepositorySourcesV2<N, A, S, W, V>>[0];
type Sources<V extends GitHubMediationVersion = 2> = RepositoryWorkSourcesV2<
  {
    origin: OriginalRepositoryWorkOriginV2<V>;
    preparation: RepositoryWorkStatePreparationV2<V>;
    token: ProtectedGitHubWorkTokenV2;
    commit: RepositoryWorkCommittedV2;
  },
  V
> & { readonly close: () => Promise<void> };

/** Authored declaration cases only: neither native-only recognition nor its
 * binding projection establishes a State readset or release authority. */
export function pairNativeRpcHooks<
  N extends object,
  A extends object,
  S extends object,
  W extends object,
>(
  options: Options<N, A, S, W>,
  sources: Sources,
  runtime: RepositoryWorkOriginOwnerV2<N, A, 2>,
  recognizer: RepositoryWorkOriginNativeRecognizerV2<N, 2>,
  origin: OriginalRepositoryWorkOriginV2<2>,
  raw: N,
  selected: S,
  call: AuthorityCallV1,
): void {
  const refreshed: Promise<RepositoryWorkNativeBindingV2> = sources.native.inspectNative(
    origin,
    call,
  );
  const original: Promise<RepositoryWorkNativeBindingV2> = runtime.inspectNative(origin, call);
  sources.native.assertNativeCurrent(origin, call);
  sources.native.assertCurrent(origin, call);
  const nativeOnly: N = recognizer.recognizeNative(origin, call);
  const fullyCurrent: N = recognizer.recognize(origin, call);
  const handedOff: Promise<void> = options.selection.prepareStateUse(selected, origin, call);
  // @ts-expect-error A raw native Session cannot be used as the original Runtime origin.
  sources.native.inspectNative(raw, call);
  // @ts-expect-error Native correspondence also requires the original Runtime origin.
  recognizer.recognizeNative(raw, call);
  const { prepareStateUse: _handoff, ...missingHandoff } = options.selection;
  // @ts-expect-error State handoff is mandatory, with no fallback to ordinary inspection.
  createProtectedGitHubRepositorySourcesV2<N, A, S, W>({ ...options, selection: missingHandoff });
  const { inspectNative: _inspect, ...missingNativeRpc } = sources.native;
  // @ts-expect-error A synchronous fence cannot replace fresh native RPC authentication.
  const incomplete: Sources = { ...sources, native: missingNativeRpc };
  void [refreshed, original, nativeOnly, fullyCurrent, handedOff, incomplete, _handoff, _inspect];
}

export function pairOriginalConstruction<
  N extends object,
  A extends object,
  S extends object,
  W extends object,
>(
  native: RepositoryWorkNativeSessionSourceV2<N, 2> & ProtectedGitHubNativeSourceV2<N, W>,
  assignments: RepositoryWorkOriginAssignmentSourceV2<A, N, 2>,
  remaining: Omit<Options<N, A, S, W>, "native" | "assignments">,
): Sources {
  return createProtectedGitHubRepositorySourcesV2<N, A, S, W>({
    ...remaining,
    native,
    assignments,
  });
}

export function rejectCrossedConstruction<
  N extends object,
  OtherN extends object,
  A extends object,
  S extends object,
  W extends object,
>(
  options: Options<N, A, S, W>,
  otherAssignments: RepositoryWorkOriginAssignmentSourceV2<A, OtherN, 2>,
  runtime: RepositoryWorkOriginOwnerV2<N, A, 2>,
  gitNative: RepositoryWorkNativeSessionSourceV2<N, 3> & ProtectedGitHubNativeSourceV2<N, W, 3>,
  gitAssignments: RepositoryWorkOriginAssignmentSourceV2<A, N, 3>,
  rawSelection: RepositoryWorkSelectionSourceV2<{
    origin: N;
    selection: S;
    token: ProtectedGitHubWorkTokenV2;
  }>,
): void {
  const crossedAssignment = { ...options, assignments: otherAssignments };
  // @ts-expect-error State must consume the same raw native Session type selected at construction.
  createProtectedGitHubRepositorySourcesV2<N, A, S, W>(crossedAssignment);
  const alreadyConstructed = { ...options, native: runtime };
  // @ts-expect-error Runtime returns opaque O and cannot replace the raw native source/prepared writer.
  createProtectedGitHubRepositorySourcesV2<N, A, S, W>(alreadyConstructed);
  const crossedNativeVersion = { ...options, native: gitNative };
  // @ts-expect-error This metadata assembler cannot consume a version 3 native source.
  createProtectedGitHubRepositorySourcesV2<N, A, S, W>(crossedNativeVersion);
  const crossedAssignmentVersion = { ...options, assignments: gitAssignments };
  // @ts-expect-error Version 3 assignment purposes cannot supply the version 2 constructor.
  createProtectedGitHubRepositorySourcesV2<N, A, S, W>(crossedAssignmentVersion);
  const crossedSelection = { ...options, selection: rawSelection };
  // @ts-expect-error Work selection receives the original Runtime origin O, not raw native N.
  createProtectedGitHubRepositorySourcesV2<N, A, S, W>(crossedSelection);
}

export function rejectCrossedOperands<N extends object, W extends object>(
  sources: Sources,
  native: ProtectedGitHubNativeSourceV2<N, W>,
  origin: OriginalRepositoryWorkOriginV2<2>,
  gitOrigin: OriginalRepositoryWorkOriginV2<3>,
  raw: N,
  projected: object,
  call: AuthorityCallV1,
): void {
  sources.native.assertCurrent(origin, call);
  native.assertCurrent(raw, call);
  // @ts-expect-error A borrowed raw Session is not an original Runtime origin.
  sources.native.assertCurrent(raw, call);
  // @ts-expect-error The original Runtime origin cannot be passed to the raw native receiver.
  native.assertCurrent(origin, call);
  // @ts-expect-error Version 3 origin membership cannot satisfy version 2 Work.
  sources.native.assertCurrent(gitOrigin, call);
  // @ts-expect-error Projected metadata cannot supply original Runtime membership.
  sources.native.assertCurrent(projected, call);
  // @ts-expect-error Assembly exposes no native-session recognizer to request-time callers.
  sources.recognizeNative(origin, call);
  // @ts-expect-error The construction-only custody binding cannot be replaced after assembly.
  sources.bindOrigins;
  const closed: Promise<void> = sources.close();
  void closed;
}

/** A Git construction must select version 3 explicitly; it cannot acquire that
 * protocol through inference from a raw source, selection, or request. */
export function pairExplicitGitConstruction<
  N extends object,
  A extends object,
  S extends object,
  W extends object,
>(
  native: RepositoryWorkNativeSessionSourceV2<N, 3> & ProtectedGitHubNativeSourceV2<N, W, 3>,
  assignments: RepositoryWorkOriginAssignmentSourceV2<A, N, 3>,
  remaining: Omit<Options<N, A, S, W, 3>, "native" | "assignments" | "protocolVersion">,
): Sources<3> {
  return createProtectedGitHubRepositorySourcesV2({
    ...remaining,
    protocolVersion: 3,
    native,
    assignments,
  });
}

export function pairExplicitMetadataConstruction<
  N extends object,
  A extends object,
  S extends object,
  W extends object,
>(options: Options<N, A, S, W>): Sources<2> {
  return createProtectedGitHubRepositorySourcesV2({ ...options, protocolVersion: 2 });
}

export function rejectProtocolArmMixing<
  N extends object,
  A extends object,
  S extends object,
  W extends object,
>(
  metadata: Options<N, A, S, W, 2>,
  git: Options<N, A, S, W, 3>,
  version: GitHubMediationVersion,
): void {
  const { protocolVersion: _version, ...missingVersion } = git;
  // @ts-expect-error Git sources do not select version 3 when the explicit constructor choice is absent.
  createProtectedGitHubRepositorySourcesV2(missingVersion);
  // @ts-expect-error Even explicit type arguments do not make the required version 3 option optional.
  createProtectedGitHubRepositorySourcesV2<N, A, S, W, 3>(missingVersion);
  // @ts-expect-error Omitting the fifth type parameter selects metadata, not inferred Git.
  createProtectedGitHubRepositorySourcesV2<N, A, S, W>(git);
  const crossedNative = { ...git, native: metadata.native };
  // @ts-expect-error A version 3 construction must capture its own version 3 raw native source.
  createProtectedGitHubRepositorySourcesV2(crossedNative);
  const crossedAssignments = { ...git, assignments: metadata.assignments };
  // @ts-expect-error State metadata assignments cannot supply Git purpose and permission evidence.
  createProtectedGitHubRepositorySourcesV2(crossedAssignments);
  const crossedSelection = { ...git, selection: metadata.selection };
  // @ts-expect-error Metadata Work selection cannot be paired with Git origins and requests.
  createProtectedGitHubRepositorySourcesV2(crossedSelection);
  const crossedMetadataSelection = { ...metadata, selection: git.selection };
  // @ts-expect-error Git selection cannot widen the default metadata constructor arm.
  createProtectedGitHubRepositorySourcesV2(crossedMetadataSelection);
  const ambiguous = { ...git, protocolVersion: version };
  // @ts-expect-error A constructor must choose one protocol; a union is not a selection.
  createProtectedGitHubRepositorySourcesV2(ambiguous);
  // @ts-expect-error Explicit union type arguments cannot bypass the constructor selection rule.
  createProtectedGitHubRepositorySourcesV2<N, A, S, W, 2 | 3>(ambiguous);
  void _version;
}

export function rejectCrossedGitOperands<N extends object, W extends object>(
  metadata: Sources<2>,
  git: Sources<3>,
  rawSource: ProtectedGitHubNativeSourceV2<N, W, 3>,
  raw: N,
  metadataOrigin: OriginalRepositoryWorkOriginV2<2>,
  gitOrigin: OriginalRepositoryWorkOriginV2<3>,
  metadataPreparation: RepositoryWorkStatePreparationV2<2>,
  gitPreparation: RepositoryWorkStatePreparationV2<3>,
  metadataRequest: OpenRead<2>,
  gitRequest: OpenRead<3>,
  call: AuthorityCallV1,
): void {
  const acquired: Promise<OriginalRepositoryWorkOriginV2<3> | undefined> = git.native.acquire(
    gitRequest,
    call,
  );
  const prepared: Promise<RepositoryWorkStatePreparationV2<3> | undefined> = git.state.prepare(
    gitOrigin,
    gitRequest,
    call,
  );
  git.native.assertCurrent(gitOrigin, call);
  // @ts-expect-error Git Work requires original Runtime O, not a borrowed raw native Session.
  git.native.assertCurrent(raw, call);
  // @ts-expect-error Git Runtime O cannot become the native prepared-write Session.
  rawSource.assertCurrent(gitOrigin, call);
  // @ts-expect-error A metadata request cannot drive the Git Work source.
  git.native.acquire(metadataRequest, call);
  // @ts-expect-error A Git request cannot drive the metadata Work source.
  metadata.native.acquire(gitRequest, call);
  // @ts-expect-error Metadata P/O cannot supply the Git custody preparation path.
  git.custody.prepareToken(metadataPreparation, metadataOrigin, call);
  // @ts-expect-error Git P/O cannot supply the metadata custody preparation path.
  metadata.custody.prepareToken(gitPreparation, gitOrigin, call);
  // @ts-expect-error O matching alone cannot make a metadata preparation into Git P.
  git.custody.prepareToken(metadataPreparation, gitOrigin, call);
  // @ts-expect-error P matching alone cannot make a metadata origin into Git O.
  git.custody.prepareToken(gitPreparation, metadataOrigin, call);
  void [acquired, prepared];
}

/** The lower binder captures the same explicit version and immutable opening.
 * These are declaration checks, not a historical State receipt or live release. */
export function pairLowerMetadataRelease<N extends object, W extends object>(
  custody: ProtectedGitHubTokenCustodyV1,
  options: ProtectedGitHubReleaseOptionsV2<N, W>,
): Promise<ProtectedGitHubReleaseBindingV2> {
  return custody.bindCommittedReleaseV2(options);
}

export function pairLowerGitRelease<N extends object, W extends object>(
  custody: ProtectedGitHubTokenCustodyV1,
  native: ProtectedGitHubNativeSourceV2<N, W, 3>,
  opening: OpenRead<3>,
  remaining: Omit<
    ProtectedGitHubReleaseOptionsV2<N, W, 3>,
    "native" | "opening" | "protocolVersion"
  >,
): Promise<ProtectedGitHubReleaseBindingV2> {
  return custody.bindCommittedReleaseV2({ ...remaining, protocolVersion: 3, native, opening });
}

export function rejectLowerReleaseProtocolMixing<N extends object, W extends object>(
  custody: ProtectedGitHubTokenCustodyV1,
  metadata: ProtectedGitHubReleaseOptionsV2<N, W, 2>,
  git: ProtectedGitHubReleaseOptionsV2<N, W, 3>,
  version: GitHubMediationVersion,
): void {
  const { protocolVersion: _version, ...missingVersion } = git;
  // @ts-expect-error Native/opening evidence cannot infer Git when the explicit version is missing.
  custody.bindCommittedReleaseV2(missingVersion);
  // @ts-expect-error A type argument cannot replace the mandatory version 3 construction option.
  custody.bindCommittedReleaseV2<N, W, 3>(missingVersion);
  // @ts-expect-error The lower binder's omitted version parameter defaults to metadata.
  custody.bindCommittedReleaseV2<N, W>(git);
  const crossedNative = { ...git, native: metadata.native };
  // @ts-expect-error The actual acquire(OpenRead<V>) port couples the native source to the selected version.
  custody.bindCommittedReleaseV2(crossedNative);
  const crossedGitOpening = { ...git, opening: metadata.opening };
  // @ts-expect-error A metadata opening cannot bind a version 3 release.
  custody.bindCommittedReleaseV2(crossedGitOpening);
  const crossedMetadataOpening = { ...metadata, opening: git.opening };
  // @ts-expect-error A Git opening cannot widen the default metadata release arm.
  custody.bindCommittedReleaseV2(crossedMetadataOpening);
  const { opening: _opening, ...missingOpening } = metadata;
  // @ts-expect-error Metadata also requires the original opening; there is no unbound release fallback.
  custody.bindCommittedReleaseV2(missingOpening);
  const ambiguous = { ...git, protocolVersion: version };
  // @ts-expect-error An ambiguous union cannot select a lower release protocol.
  custody.bindCommittedReleaseV2(ambiguous);
  // @ts-expect-error Explicit union arguments cannot bypass the lower binder's closed protocol arms.
  custody.bindCommittedReleaseV2<N, W, 2 | 3>(ambiguous);
  // @ts-expect-error The native interface carries version in acquire, not solely a phantom type argument.
  const crossedPort: ProtectedGitHubNativeSourceV2<N, W, 3> = metadata.native;
  void [_version, _opening, crossedPort];
}
