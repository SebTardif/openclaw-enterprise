import type {
  PublicationOriginalsV1,
  PublicationCallV1,
  PublicationCandidateV1,
  PublicationEffectV1,
} from "../repository-publication-v1/contract.ts";

/** State-issued preparation membership. This is not credential issue/release or
 * current Work authority; only the fixed constructor recognizes the original. */
export interface RepositoryPublicationNativePreparationV1 {
  readonly kind: "original-publication-native-preparation";
}
export interface RepositoryPublicationNativePreparationBindingV1<B extends PublicationOriginalsV1> {
  readonly publisher: B["publisher"];
  readonly originalEffect: B["effect"];
  readonly originalCandidate: B["candidate"];
  readonly originalApproval: B["approval"];
  readonly call: PublicationCallV1;
  readonly receiver: object;
  readonly candidate: PublicationCandidateV1;
  readonly effect: PublicationEffectV1;
  readonly actionDigest: string;
  readonly operationRef: string;
  readonly commitRef: string;
}
export interface RepositoryPublicationNativePreparationLeaseV1<B extends PublicationOriginalsV1> {
  readonly original: RepositoryPublicationNativePreparationV1;
  inspect(): RepositoryPublicationNativePreparationBindingV1<B>;
  assertCurrent(): undefined;
  /** Completion ownership only. Register actually entered native work before
   * an outward refusal. This gives no SQL, send, credential or current-use right. */
  joinAccepted(pending: Promise<unknown>): undefined;
  /** Invalidates permission immediately and joins entered completion. Native
   * custody calls this after physical retirement and original outcome handoff;
   * Promise settlement alone is not a certificate of physical retirement. */
  release(): Promise<void>;
}
export interface RepositoryPublicationNativePreparationSourceV1<B extends PublicationOriginalsV1> {
  /** Pins the SAME committed claim's independent observer, without a second SQL
   * readset. No retry, copied actor, refreshed call, or receiver substitution. */
  retainNativePreparation(
    publisher: B["publisher"],
    originalEffect: B["effect"],
    call: PublicationCallV1,
    receiver: object,
  ): RepositoryPublicationNativePreparationLeaseV1<B> | undefined;
  /** Fixed native/custody construction recognizes exactly this original pin.
   * Inspection data or dispatcher membership never substitutes for it. */
  recognizePreparation(
    original: RepositoryPublicationNativePreparationV1,
    publisher: B["publisher"],
    originalEffect: B["effect"],
    call: PublicationCallV1,
    receiver: object,
  ): undefined;
}
