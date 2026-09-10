import type {
  PublicationOriginalsV1,
  PublicationStateSourceV1,
  PublicationCallV1,
} from "../repository-publication-v1/contract.ts";

/** Fixed original DS constructor receives these closures once. A copied use,
 * effect, prepared receiver or call can never pass the private membership map. */
export interface RepositoryPublicationDispatchParticipantV1<B extends PublicationOriginalsV1> {
  inspectEffect(original: B["effect"]): ReturnType<PublicationStateSourceV1<B>["inspectEffect"]>;
  assertUse(original: B["use"], prepared: B["prepared"], call: PublicationCallV1): undefined;
  /** Immediately before the original DS's fixed send; consumes exactly once. */
  consumeUse(original: B["use"], prepared: B["prepared"], call: PublicationCallV1): undefined;
}
