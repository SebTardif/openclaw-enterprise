import type { PostgresPlatformState, RuntimeServiceTrustService } from "@openclaw-enterprise/occ";
import type { DriverSelection } from "@openclaw-enterprise/occ/application/driver-selection";
import {
  createRepositoryWorkNativeExecutionSourceV2,
  type OriginalRepositoryWorkNativeExecutionV2,
  type RepositoryWorkAcceptedExecutionOwnerV2,
} from "@openclaw-enterprise/occ/runtime-authority/repository-work-selected-execution-v2";
import {
  RepositoryWorkOperationOwnerV2,
  type OriginalRepositoryPreparationV2,
  type OriginalCommittedRepositoryReleaseV2,
  type RepositoryWorkPrivateBindingsV2,
  type RepositoryWorkSourcesV2,
} from "@openclaw-enterprise/occ/lifecycle/repository-work-v2";
import type { WorkRepositoryProtocolOptionsV2 } from "@openclaw-enterprise/occ/lifecycle/work-authority-ports-v2";
import type {
  RepositoryWorkNativeSelectedExecutionSourceV2,
  RepositoryWorkSelectedExecutionAdmissionCoreV2,
} from "@openclaw-enterprise/occ/ports/repository-work-selected-execution-v2";
import type {
  GitHubMediationLimits,
  GitHubMediationOperationOwner,
} from "@openclaw-enterprise/occ/github-mediation-v2/ports";
import {
  startGitHubMediationNative,
  type GitHubMediationNativeDeployment,
  type GitHubMediationNativeServiceSession,
  type GitHubMediationNativeServiceSource,
} from "../admission/github-mediation-context.ts";

type Session = GitHubMediationNativeServiceSession;
type State = Pick<PostgresPlatformState, "repositoryWorkSelectedExecutionAdmissionV2">;
type Execution<V extends 2 | 3> = OriginalRepositoryWorkNativeExecutionV2<V>;
type Operations<V extends 2 | 3> = GitHubMediationOperationOwner<
  OriginalRepositoryPreparationV2<V>,
  OriginalCommittedRepositoryReleaseV2<V>,
  V
>;

/** The original Work constructor completes its existing selection/use/observer
 * and fixed custody construction. A core admission Pick is never cast to the
 * full State source. This receiver owns any partially constructed collaborators
 * if create throws. Returning comparison data cannot construct Work sources.
 */
export interface ControllerGitHubReadWorkConstructionV2<
  B extends RepositoryWorkPrivateBindingsV2,
  V extends 2 | 3,
> {
  create(
    input: Readonly<{
      protocolVersion: V;
      native: GitHubMediationNativeServiceSource<V>;
      executions: RepositoryWorkNativeSelectedExecutionSourceV2<Session, Execution<V>, V>;
      admission: RepositoryWorkSelectedExecutionAdmissionCoreV2<Session, V>;
      state: State;
      selection: DriverSelection;
      trust: RuntimeServiceTrustService;
    }>,
  ): Readonly<{
    sources: RepositoryWorkSourcesV2<B, V>;
    release(): Promise<void>;
  }>;
}
export interface ControllerGitHubReadServiceInputV2<
  H,
  B extends RepositoryWorkPrivateBindingsV2,
  V extends 2 | 3,
> {
  readonly deployment: GitHubMediationNativeDeployment &
    Readonly<{
      binaryPath: string;
      serviceIdentityRef: string;
      recipientRef: string;
    }>;
  readonly limits: GitHubMediationLimits;
  readonly accepted: RepositoryWorkAcceptedExecutionOwnerV2<Session, H, V>;
  readonly work: ControllerGitHubReadWorkConstructionV2<B, V>;
}
declare const readService: unique symbol;
export type ControllerGitHubReadService = { readonly [readService]: true };
export interface ControllerGitHubReadStartupContext {
  readonly state: State;
  readonly selection: DriverSelection;
  readonly installationId: string;
  readonly trust: RuntimeServiceTrustService;
}
type Running = Readonly<{ close(): Promise<void> }>;
type NativeInput<V extends 2 | 3> = GitHubMediationNativeDeployment &
  Readonly<{
    binaryPath: string;
    serviceIdentityRef: string;
    installationId: string;
    recipientRef: string;
    trust: RuntimeServiceTrustService;
    limits: GitHubMediationLimits;
    operationsFactory: { create(native: GitHubMediationNativeServiceSource<V>): Operations<V> };
  }>;
type Definition = {
  readonly version: 2 | 3;
  readonly listenPath: string;
  readonly serviceIdentityRef: string;
  used: boolean;
  start(context: ControllerGitHubReadStartupContext): Promise<Running>;
};
const definitions = new WeakMap<ControllerGitHubReadService, Definition>();
const unavailable = () => new Error("Original GitHub read composition unavailable.");
function method<T extends object, K extends keyof T>(owner: T, key: K): T[K] {
  const value = owner?.[key];
  if (typeof value !== "function") throw unavailable();
  return value.bind(owner) as T[K];
}

function define<H, B extends RepositoryWorkPrivateBindingsV2, V extends 2 | 3>(
  input: ControllerGitHubReadServiceInputV2<H, B, V>,
  version: V,
  protocol: WorkRepositoryProtocolOptionsV2<V>,
  startNative: (input: NativeInput<V>) => Promise<Running>,
): ControllerGitHubReadService {
  const deployment = Object.freeze({
    binaryPath: input.deployment.binaryPath,
    serviceIdentityRef: input.deployment.serviceIdentityRef,
    recipientRef: input.deployment.recipientRef,
    listenPath: input.deployment.listenPath,
    peerUid: input.deployment.peerUid,
    trustedAncestorUids: Object.freeze([...input.deployment.trustedAncestorUids]),
  });
  const limits = Object.freeze({ ...input.limits });
  if (
    !Number.isSafeInteger(limits.maximumSessions) ||
    limits.maximumSessions < 1 ||
    limits.maximumSessions > 128 ||
    !Number.isSafeInteger(limits.maximumCallMilliseconds) ||
    limits.maximumCallMilliseconds < 1 ||
    limits.maximumCallMilliseconds > 3000
  )
    throw unavailable();
  const accepted = Object.freeze({
    acquire: method(input.accepted, "acquire"),
    retain: method(input.accepted, "retain"),
  });
  const createWork = method(input.work, "create");
  const definition: Definition = {
    version,
    listenPath: deployment.listenPath,
    serviceIdentityRef: deployment.serviceIdentityRef,
    used: false,
    async start(context) {
      const createAdmission = method(context.state, "repositoryWorkSelectedExecutionAdmissionV2");
      let native: Running | undefined;
      let executions:
        ReturnType<typeof createRepositoryWorkNativeExecutionSourceV2<Session, H, V>> | undefined;
      let operationOwner: RepositoryWorkOperationOwnerV2<B, V> | undefined;
      let releaseWork: (() => Promise<void>) | undefined;
      let started = false;
      let closed = false;
      let closing: Promise<void> | undefined;
      const close = (): Promise<void> => {
        if (!closing) {
          closed = true;
          closing = (async () => {
            const errors: unknown[] = [];
            // Work stops accepting first, then joins its P/R and provider duties.
            // The native owner retains final transport closure. All cleanup is
            // attempted before State's process-level owner may close its pool.
            for (const release of [
              operationOwner?.stop.bind(operationOwner),
              native?.close.bind(native),
              releaseWork,
              executions?.close.bind(executions),
            ]) {
              try {
                await release?.();
              } catch (error) {
                errors.push(error);
              }
            }
            if (errors.length) throw new AggregateError(errors, "GitHub read cleanup failed.");
          })();
        }
        return closing;
      };
      try {
        native = await startNative({
          ...deployment,
          installationId: context.installationId,
          trust: context.trust,
          limits,
          operationsFactory: Object.freeze({
            create(source) {
              if (started || closed) throw unavailable();
              started = true;
              executions = createRepositoryWorkNativeExecutionSourceV2({
                protocolVersion: version,
                native: source,
                accepted,
                trust: context.trust,
                limits: {
                  maximumBorrows: limits.maximumSessions,
                  maximumCallMilliseconds: limits.maximumCallMilliseconds,
                  clockAllowanceMilliseconds: limits.clockAllowanceMilliseconds,
                },
              });
              const admission = createAdmission(context.selection, {
                protocolVersion: version,
                maximumAdmissions: limits.maximumSessions,
                native: source,
                executions,
              });
              const work = createWork(
                Object.freeze({
                  protocolVersion: version,
                  native: source,
                  executions,
                  admission,
                  state: context.state,
                  selection: context.selection,
                  trust: context.trust,
                }),
              );
              // Take cleanup before observing the returned sources or invoking
              // their constructors. A throwing source getter cannot lose custody.
              releaseWork = method(work, "release");
              operationOwner = new RepositoryWorkOperationOwnerV2<B, V>(
                work.sources,
                {
                  maximumPreparations: limits.maximumSessions,
                  maximumOperationMilliseconds: limits.maximumOperationMilliseconds,
                  maximumLeaseMilliseconds: limits.maximumLeaseMilliseconds,
                  clockAllowanceMilliseconds: limits.clockAllowanceMilliseconds,
                },
                protocol,
              );
              return operationOwner;
            },
          }),
        });
        if (!started || closed) throw unavailable();
        return Object.freeze({ close });
      } catch (error) {
        try {
          await close();
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], "GitHub read startup failed.");
        }
        throw error;
      }
    },
  };
  const handle = Object.freeze({}) as ControllerGitHubReadService;
  definitions.set(handle, definition);
  return handle;
}

/** Separate literal constructors prevent metadata sources being widened to Git
 * read or publication by a request or configuration value. */
export function defineControllerGitHubMetadataReadV2<H, B extends RepositoryWorkPrivateBindingsV2>(
  input: ControllerGitHubReadServiceInputV2<H, B, 2>,
): ControllerGitHubReadService {
  return define(input, 2, { protocolVersion: 2 }, (options) =>
    startGitHubMediationNative<
      OriginalRepositoryPreparationV2<2>,
      OriginalCommittedRepositoryReleaseV2<2>,
      2
    >({ ...options, protocolVersion: 2 }),
  );
}
export function defineControllerGitHubGitReadV3<H, B extends RepositoryWorkPrivateBindingsV2>(
  input: ControllerGitHubReadServiceInputV2<H, B, 3>,
): ControllerGitHubReadService {
  return define(input, 3, { protocolVersion: 3 }, (options) =>
    startGitHubMediationNative<
      OriginalRepositoryPreparationV2<3>,
      OriginalCommittedRepositoryReleaseV2<3>,
      3
    >({ ...options, protocolVersion: 3 }),
  );
}

export async function startControllerGitHubReadMediation(
  services: readonly ControllerGitHubReadService[],
  input: ControllerGitHubReadStartupContext,
): Promise<Running> {
  if (!Array.isArray(services) || services.length > 2) throw unavailable();
  const selected = services.map((service) => definitions.get(service));
  if (selected.some((value) => !value || value.used)) throw unavailable();
  const versions = new Set(),
    paths = new Set(),
    identities = new Set();
  for (const value of selected) {
    if (
      !value ||
      versions.has(value.version) ||
      paths.has(value.listenPath) ||
      identities.has(value.serviceIdentityRef)
    )
      throw unavailable();
    versions.add(value.version);
    paths.add(value.listenPath);
    identities.add(value.serviceIdentityRef);
  }
  const context = Object.freeze({
    state: input.state,
    selection: input.selection,
    installationId: input.installationId,
    trust: input.trust,
  });
  // Reserve the entire selected set before the first startup wait. A concurrent
  // composition cannot claim a later definition while an earlier child starts.
  for (const value of selected) value!.used = true;
  const running: Running[] = [];
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const results = await Promise.allSettled(
        [...running].reverse().map((owner) => owner.close()),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) throw new AggregateError(errors, "GitHub read service cleanup failed.");
    })());
  try {
    for (const value of selected) {
      running.push(await value!.start(context));
    }
    return Object.freeze({ close });
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "GitHub read service startup failed.");
    }
    throw error;
  }
}
