import type {
  PostgresPlatformState,
  PlatformStateStore,
  PlatformUnitOfWork as ControllerUnit,
} from "@openclaw-enterprise/occ";
import type {
  CredentialCommitOutcomeV1,
  OriginalCredentialStateBinderV1,
  OriginalCredentialUnitV1,
  PlatformUnitOfWork,
} from "@openclaw-enterprise/occ/internal/credential-state-v1";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type OriginalControllerUow = Assert<Equal<ControllerUnit, PlatformUnitOfWork>>;

/** Genuine package consumer: State storage and its credential binder remain
 * separate constructor operands. No executable controller workflow is installed. */
export function controllerOriginalStateOperands(producer: PostgresPlatformState): {
  readonly state: PlatformStateStore;
  readonly originalState: OriginalCredentialStateBinderV1;
} {
  return { state: producer, originalState: producer };
}

export async function controllerOriginalParticipant<T>(
  originalState: OriginalCredentialStateBinderV1,
  uow: PlatformUnitOfWork,
  consume: (unit: OriginalCredentialUnitV1) => Promise<T>,
): Promise<T> {
  const unit = originalState.bindCredentialUnitIn(uow);
  return unit.run(() => consume(unit));
}

export function controllerCommitRecognition(
  originalState: OriginalCredentialStateBinderV1,
  original: OriginalCredentialUnitV1,
): Promise<CredentialCommitOutcomeV1> {
  return originalState.recognizeCredentialCommit(original);
}
