import type { LocalHandle } from "../credential-gateway-v1/handles.ts";
import type { PlatformUnitOfWork } from "./platform-state.ts";

export type { PlatformUnitOfWork } from "./platform-state.ts";

/** Borrowed original State operations; completion stages work, never proves COMMIT. */
export interface OriginalCredentialUnitV1 extends LocalHandle<"original-credential-unit-v1"> {
  readonly uow: PlatformUnitOfWork;
  run<T>(work: () => Promise<T>): Promise<T>;
  query(
    statement: string,
    parameters?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** The original State authenticates this process-local, single-recognition handle. */
export interface KnownCredentialCommitV1 extends LocalHandle<"known-credential-commit-v1"> {}

export type CredentialCommitOutcomeV1 =
  | { readonly kind: "committed"; readonly evidence: KnownCredentialCommitV1 }
  | { readonly kind: "not-committed" }
  | { readonly kind: "unknown"; readonly nextAction: "reconcile-only" };

export interface OriginalCredentialStateBinderV1 {
  bindCredentialUnitIn(uow: PlatformUnitOfWork): OriginalCredentialUnitV1;
  recognizeCredentialCommit(unit: OriginalCredentialUnitV1): Promise<CredentialCommitOutcomeV1>;
}
