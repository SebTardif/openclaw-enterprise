import type {
  PostgresPlatformState,
  PlatformUnitOfWork as OriginalStateUnit,
} from "@openclaw-enterprise/occ";
import type {
  CredentialCommitOutcomeV1,
  KnownCredentialCommitV1,
  OriginalCredentialStateBinderV1,
  OriginalCredentialUnitV1,
  PlatformUnitOfWork,
} from "@openclaw-enterprise/occ/internal/credential-state-v1";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** Inert consumer in the actual gateway compiler project. Importing the original
 * State contract confers neither installed construction nor admission authority. */
export interface CredentialStateCorrespondenceV1 {
  readonly originalUow: Assert<Equal<PlatformUnitOfWork, OriginalStateUnit>>;
  readonly producer: Assert<
    PostgresPlatformState extends OriginalCredentialStateBinderV1 ? true : false
  >;
  readonly binderInput: Assert<
    Equal<Parameters<PostgresPlatformState["bindCredentialUnitIn"]>, [uow: PlatformUnitOfWork]>
  >;
  readonly binderResult: Assert<
    Equal<ReturnType<PostgresPlatformState["bindCredentialUnitIn"]>, OriginalCredentialUnitV1>
  >;
  readonly recognition: Assert<
    Equal<
      ReturnType<PostgresPlatformState["recognizeCredentialCommit"]>,
      Promise<CredentialCommitOutcomeV1>
    >
  >;
  readonly committedEvidence: Assert<
    Equal<
      Extract<CredentialCommitOutcomeV1, { kind: "committed" }>["evidence"],
      KnownCredentialCommitV1
    >
  >;
  readonly originalOperand: Assert<Equal<OriginalCredentialUnitV1["uow"], PlatformUnitOfWork>>;
}
