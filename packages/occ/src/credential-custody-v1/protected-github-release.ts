import type { GitHubMediationVersion, OpenRead } from "../github-mediation-v2/wire.ts";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type {
  RepositoryWorkCommittedV2,
  RepositoryWorkCustodySourceV2,
  RepositoryWorkStateParticipantV2,
} from "../ports/repository-work-v2.ts";

/** The constructor-held original native service source supplies these methods.
 * Its object is the receiver identity and N is its privately enrolled session.
 * No receiver constructor, arbitrary address or byte-consumer callback exists. */
export interface ProtectedGitHubNativeSourceV2<
  N extends object,
  W extends object,
  in out V extends GitHubMediationVersion = 2,
> {
  readonly acquire: (request: OpenRead<V>, call: AuthorityCallV1) => Promise<N | undefined>;
  inspect(original: N, call: AuthorityCallV1): Promise<Readonly<{ sessionRef: string }>>;
  assertCurrent(original: N, call: AuthorityCallV1): void;
  prepareCommittedToken(original: N, metadata: Uint8Array, call: AuthorityCallV1): Promise<W>;
  /** The actual native implementation initiates its fixed write synchronously.
   * Its promise settles only at the original written ACK or proved retirement. */
  writePreparedCommittedToken(prepared: W, token: Uint8Array, call: AuthorityCallV1): Promise<void>;
}

export type ProtectedGitHubReleaseOptionsV2<
  N extends object,
  W extends object,
  V extends GitHubMediationVersion = 2,
> = {
  readonly protocolVersion?: V;
  readonly opening: OpenRead<NoInfer<V>>;
  readonly participant: RepositoryWorkStateParticipantV2;
  readonly native: ProtectedGitHubNativeSourceV2<N, W, NoInfer<V>>;
  readonly originalSession: N;
  readonly call: AuthorityCallV1;
} & (V extends 2 ? Readonly<{ protocolVersion?: 2 }> : Readonly<{ protocolVersion: 3 }>) &
  ([GitHubMediationVersion] extends [V] ? never : unknown);

export interface ProtectedGitHubReleaseBindingV2 {
  readonly source: RepositoryWorkCustodySourceV2;
  writeCommitted(
    commit: RepositoryWorkCommittedV2,
    metadata: Uint8Array,
    call: AuthorityCallV1,
  ): Promise<void>;
}
