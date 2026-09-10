import { immutableCopy } from "@openclaw-enterprise/utils";
import { normalizeSecretBindings } from "@openclaw-enterprise/contracts/secret-bindings";
import type { Configuration } from "@openclaw-enterprise/contracts/resources/configuration";
import type { Secret, SecretBindings } from "@openclaw-enterprise/contracts/resources/secret";
import type { ConfigurationOwnership } from "../../ports/repositories/configuration.ts";
import type { DriverCapability } from "@openclaw-enterprise/contracts/drivers/base";
import type { DriverSelection, DriverFor } from "../../application/driver-selection.ts";
import type {
  DeploymentCandidateOperationsV2,
  DeploymentCandidateOriginalOperationsV2,
  DeploymentCandidateOperandsV2,
  DeploymentCandidateResultV2,
} from "../../ports/workload-profile-candidate.ts";
import type {
  WorkloadProfileDeploymentUnitV2,
  WorkloadProfileCandidateRecordsV2,
} from "../../workload-profiles/admitted-use.ts";
import { canonicalizeWorkloadProfileJson } from "../../workload-profiles/canonical.ts";
import { ScopeViolationError } from "../../errors.ts";
import type {
  CapturedCredentialLeaseV1,
  CapturedCredentialViewV1,
} from "../../ports/workload-profile-credentials.ts";

/** This private holder is retained on the original unit before acquisition.
 * It owns the returned cleanup even if cancellation or a later getter fails.
 * Source currentness uses the owner lifetime, never the short acquisition IO. */
export function makeCapturedCredentialObservationV1(owner: {
  assertOwner(): void;
  track<Value>(work: () => Promise<Value>): Promise<Value>;
  poison(error: unknown): never;
}) {
  let started = false;
  let ready = false;
  let closed = false;
  let checking = false;
  let failed = false;
  let first: unknown;
  let facts: CapturedCredentialViewV1["facts"] | undefined;
  let factsSnapshot: CapturedCredentialViewV1["facts"] | undefined;
  let sourceCurrent: (() => unknown) | undefined;
  let sourceRelease: (() => Promise<void>) | undefined;
  let terminal: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  const fail = (error: unknown): never => {
    if (!failed) {
      failed = true;
      first = error;
    }
    try {
      owner.poison(first);
    } finally {
      throw first;
    }
  };
  const track = <Value>(work: () => Promise<Value>): Promise<Value> => {
    const task = owner.track(work);
    const joined = task.then(
      () => {},
      (error) => {
        try {
          fail(error);
        } catch {
          /* original failure is retained by both owners */
        }
      },
    );
    pending.add(joined);
    void joined.then(() => pending.delete(joined));
    return task;
  };
  const assertCurrent = (): undefined => {
    if (checking)
      return fail(new ScopeViolationError("Credential currentness cannot reenter itself."));
    checking = true;
    try {
      if (failed) throw first;
      if (closed) throw new ScopeViolationError("The captured credential observation is closed.");
      owner.assertOwner();
      const returned = sourceCurrent?.();
      if (returned !== undefined) {
        // Retain malformed asynchronous assertions before refusing them.
        if (returned !== null && (typeof returned === "object" || typeof returned === "function")) {
          const settlement = Promise.resolve(returned);
          void track(async () => {
            await settlement;
          }).catch(() => {});
        }
        throw new ScopeViolationError("Credential currentness must settle synchronously.");
      }
      owner.assertOwner();
      if (factsSnapshot !== undefined && !sameCandidateDataV2(facts, factsSnapshot))
        throw new ScopeViolationError("The captured credential facts changed.");
      if (failed) throw first;
      return undefined;
    } catch (error) {
      return fail(error);
    } finally {
      checking = false;
    }
  };
  const release = (): Promise<void> => {
    if (terminal !== undefined) return terminal;
    terminal = Promise.resolve().then(async () => {
      closed = true;
      while (pending.size) await Promise.allSettled([...pending]);
      try {
        await sourceRelease?.();
      } catch (error) {
        if (!failed) {
          failed = true;
          first = error;
        }
      }
      while (pending.size) await Promise.allSettled([...pending]);
      if (failed) throw first;
    });
    return terminal;
  };
  return Object.freeze({
    lease: Object.freeze({ assertCurrent, release }),
    acquire(work: () => Promise<CapturedCredentialLeaseV1>): Promise<void> {
      try {
        assertCurrent();
        if (started) throw new ScopeViolationError("The credential capture is already consumed.");
        started = true;
        return track(async () => {
          const source = await work();
          // Cleanup transfer precedes owner checks and every later result getter.
          // The outer unit already owns this holder and joins entered acquisition.
          if (source === null || typeof source !== "object")
            throw new ScopeViolationError("The original credential observation is unavailable.");
          const release = source.release;
          if (typeof release !== "function")
            throw new ScopeViolationError("The credential cleanup is unavailable.");
          sourceRelease = () => Reflect.apply(release, source, []);
          assertCurrent();
          const current = source.assertCurrent;
          if (typeof current !== "function")
            throw new ScopeViolationError("The credential currentness is unavailable.");
          sourceCurrent = () => Reflect.apply(current, source, []);
          assertCurrent();
          facts = source.facts;
          if (facts === undefined || facts === null || typeof facts !== "object")
            throw new ScopeViolationError("The captured credential facts are unavailable.");
          // The original supplier's private policy recognizes this exact object.
          // A detached snapshot detects changes but never replaces its identity.
          factsSnapshot = immutableCopy(facts);
          assertCurrent();
          ready = true;
        });
      } catch (error) {
        try {
          return Promise.reject(fail(error));
        } catch (failure) {
          const rejected = Promise.reject<void>(failure);
          void rejected.catch(() => {});
          return rejected;
        }
      }
    },
    borrow(): CapturedCredentialViewV1 {
      assertCurrent();
      if (!ready || facts === undefined)
        return fail(new ScopeViolationError("The original credential capture has not completed."));
      return Object.freeze({ facts, assertCurrent });
    },
  });
}

export function sameCandidateDataV2(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalizeWorkloadProfileJson(left, "operator-envelope")).equals(
    Buffer.from(canonicalizeWorkloadProfileJson(right, "operator-envelope")),
  );
}

type Repositories = DeploymentCandidateOperationsV2["repositories"];
type ResultOf<
  Group extends keyof Repositories,
  Method extends keyof Repositories[Group],
> = Repositories[Group][Method] extends (...args: never[]) => Promise<infer Value> ? Value : never;
export interface CandidateObservedConfigurationV2 extends Pick<
  WorkloadProfileCandidateRecordsV2,
  "agent" | "serviceAccount" | "providerBinding" | "secrets"
> {
  readonly metadata: Readonly<ConfigurationOwnership>;
  readonly validated: Readonly<Configuration>;
  readonly secretBindings: SecretBindings;
}
interface CandidateOperationOwnerV2 {
  readonly unit: WorkloadProfileDeploymentUnitV2;
  readonly selection: DriverSelection;
  readonly operands: DeploymentCandidateOperandsV2;
  readonly original: DeploymentCandidateOriginalOperationsV2;
  assertAcquiring(): void;
  assertOwner(): void;
  track<Value>(work: () => Promise<Value>): Promise<Value>;
  poison(error: unknown): never;
}

/** Construction is deliberately inert. No supplied object property is read until
 * the state has installed its slot and transferred this closure's cleanup. */
export function makeTrackedCandidateOperations(owner: CandidateOperationOwnerV2) {
  let closed = false;
  let sealed = false;
  let busy = false;
  let checking = false;
  let failed = false;
  let first: unknown;
  const pending = new Set<Promise<void>>();
  const contributors: Array<() => void> = [];
  let namespace: DeploymentCandidateResultV2["namespace"] | undefined;
  let foundAgent: ResultOf<"agents", "findAgent">;
  let agent: DeploymentCandidateResultV2["lockedAgent"] | undefined;
  let head: DeploymentCandidateResultV2["head"];
  let headRead = false;
  let account: ResultOf<"serviceAccounts", "lockServiceAccount">;
  let providerBindingRead = false;
  let providerBinding: ResultOf<"serviceAccounts", "findServiceAccountProviderBinding">;
  let metadata: Readonly<ConfigurationOwnership> | undefined;
  let bindings: SecretBindings | undefined;
  const lockedSecrets: Readonly<Secret>[] = [];
  const resolvedSecrets: string[] = [];
  let readConfiguration: Readonly<Configuration> | undefined;
  let validated: Readonly<Configuration> | undefined;
  let sandboxConfigured = false;
  let previous: ResultOf<"revisions", "listRevisions"> | undefined;
  let revisionId: string | undefined;
  let createdAt: string | undefined;
  let compute: ReturnType<DeploymentCandidateOperationsV2["drivers"]["compute"]> | undefined;
  let sandboxRead = false;
  let sandbox: ReturnType<DeploymentCandidateOperationsV2["drivers"]["sandbox"]>;
  let secret: ReturnType<DeploymentCandidateOperationsV2["drivers"]["secret"]> | undefined;
  let configuration:
    ReturnType<DeploymentCandidateOperationsV2["drivers"]["configuration"]> | undefined;

  const fail = (error: unknown): never => {
    if (!failed) {
      failed = true;
      first = error;
    }
    try {
      owner.poison(first);
    } finally {
      throw first;
    }
  };
  const require = (condition: unknown, message: string): void => {
    if (!condition) throw new ScopeViolationError(message);
  };
  const assertCurrent = (): undefined => {
    if (checking)
      return fail(new ScopeViolationError("Candidate currentness cannot reenter itself."));
    checking = true;
    try {
      if (failed) throw first;
      require(!closed, "The candidate operation observation is closed.");
      owner.assertOwner();
      for (const check of contributors) check();
      owner.assertOwner();
      if (failed) throw first;
      return undefined;
    } catch (error) {
      return fail(error);
    } finally {
      checking = false;
    }
  };
  const assertCalling = (): void => {
    assertCurrent();
    require(!sealed, "The normalization has already completed.");
    owner.assertAcquiring();
  };
  const call = <Value>(work: () => Promise<Value>): Promise<Value> => {
    let reserved = false;
    try {
      require(!busy, "Candidate normalization operations must be sequenced.");
      busy = true;
      reserved = true;
      assertCalling();
      const task = owner.track(async () => {
        try {
          assertCalling();
          const value = await work();
          assertCalling();
          return value;
        } catch (error) {
          return fail(error);
        } finally {
          busy = false;
        }
      });
      const joined = task.then(
        () => {},
        () => {},
      );
      pending.add(joined);
      void joined.then(() => pending.delete(joined));
      return task;
    } catch (error) {
      if (reserved) busy = false;
      try {
        return Promise.reject(fail(error));
      } catch (failure) {
        const rejected = Promise.reject<Value>(failure);
        void rejected.catch(() => {});
        return rejected;
      }
    }
  };
  const sync = <Value>(work: () => Value): Value => {
    let reserved = false;
    try {
      require(!busy, "Candidate normalization operations must be sequenced.");
      busy = true;
      reserved = true;
      assertCalling();
      const value = work();
      const then =
        value !== null && (typeof value === "object" || typeof value === "function")
          ? Reflect.get(value, "then")
          : undefined;
      if (typeof then === "function") {
        // A synchronous Driver contract can still return malformed asynchronous
        // work. Capture its settlement before refusing, so terminal cleanup
        // retains contributors and no detached rejection escapes observation.
        const returned = new Promise<unknown>((resolve, reject) => {
          Reflect.apply(then, value, [resolve, reject]);
        });
        const task = owner.track(async () => {
          await returned;
        });
        const joined = task.then(
          () => {},
          () => {},
        );
        pending.add(joined);
        void joined.then(() => pending.delete(joined));
        throw new ScopeViolationError(
          "A synchronous candidate operation returned asynchronous work.",
        );
      }
      assertCalling();
      return value;
    } catch (error) {
      return fail(error);
    } finally {
      if (reserved) busy = false;
    }
  };
  const expected = () => {
    const [, input, command] = owner.operands;
    require(command !== undefined, "An original deployment command is required.");
    return { input, command: command! };
  };
  const exactScope = (namespaceId: string, agentId?: string): void => {
    const { input } = expected();
    require(namespaceId === input.namespaceId &&
      (agentId === undefined ||
        agentId === input.agentId), "A candidate operation changed its authenticated scope.");
  };
  const bind = <ObjectType extends object, Key extends keyof ObjectType>(
    object: ObjectType,
    key: Key,
  ): ObjectType[Key] => {
    const method = object[key];
    require(typeof method === "function", "An original candidate operation is unavailable.");
    contributors.push(() =>
      require(object[key] === method, "An original candidate operation changed."),
    );
    return method;
  };
  const hold = <Capability extends DriverCapability>(
    capability: Capability,
    driver: DriverFor<Capability> | undefined,
  ): void => {
    const acquired = owner.selection.acquireGuardedSelection(capability, driver);
    // Transfer cleanup before reading any further Driver fields/methods.
    try {
      owner.unit.retain({
        assertCurrent: () => {
          acquired.assertCurrent();
          return undefined;
        },
        release: async () => acquired.release(),
      });
    } catch (error) {
      // retain can reject before transfer or after its immediate fence. Release
      // is idempotent, so both paths keep cleanup and the original failure.
      acquired.release();
      throw error;
    }
    contributors.push(() => acquired.assertCurrent());
  };
  const secretsComplete = (): boolean =>
    bindings !== undefined && lockedSecrets.length === Object.keys(bindings).length;
  const resolutionComplete = (): boolean => {
    const unique = [...new Set(lockedSecrets.map((value) => value.id))];
    return secretsComplete() && sameCandidateDataV2(resolvedSecrets, unique);
  };
  const operations = Object.freeze<DeploymentCandidateOperationsV2>({
    repositories: Object.freeze<Repositories>({
      namespaces: Object.freeze<Repositories["namespaces"]>({
        lockNamespace: (id, options) =>
          call(async () => {
            exactScope(id);
            require(namespace === undefined &&
              !foundAgent &&
              !agent &&
              options === undefined, "Namespace must be the first original candidate lock.");
            const source = owner.unit.platform.namespaces;
            const result = await bind(source, "lockNamespace").call(source, id);
            require(result?.id === id &&
              result.deletedAt === undefined, "The original Namespace lock is unavailable.");
            namespace = immutableCopy(result!);
            return result;
          }),
      }),
      agents: Object.freeze<Repositories["agents"]>({
        findAgent: (ns, id) =>
          call(async () => {
            exactScope(ns, id);
            require(namespace &&
              !foundAgent &&
              !agent, "The original Namespace must precede Agent lookup.");
            const source = owner.unit.platform.agents;
            const result = await bind(source, "findAgent").call(source, ns, id);
            require(result?.namespaceId === ns &&
              result.id === id, "The original Agent lookup is unavailable.");
            foundAgent = immutableCopy(result!);
            return result;
          }),
        lockAgent: (ns, id) =>
          call(async () => {
            exactScope(ns, id);
            require(foundAgent &&
              compute &&
              sandboxRead &&
              !agent, "Original Driver selection must precede the Agent lock.");
            const source = owner.unit.platform.agents;
            const result = await bind(source, "lockAgent").call(source, ns, id);
            const draft = expected().command.expectedDraft;
            require(result?.namespaceId === ns &&
              result.id === id &&
              result.configurationId === draft.configurationId &&
              result.providerId === draft.providerId &&
              result.executionMode === draft.executionMode &&
              result.maximumExecutionMs === draft.maximumExecutionMs &&
              (result.serviceAccountId ?? null) === draft.serviceAccountId &&
              sameCandidateDataV2(
                result.workloadProfileSelection,
                draft.workloadProfileSelection,
              ), "The locked Agent differs from the original draft.");
            agent = immutableCopy(result!);
            return result;
          }),
      }),
      runtimeAssignments: Object.freeze<Repositories["runtimeAssignments"]>({
        findRuntimeIntentHead: (scope) =>
          call(async () => {
            exactScope(scope.namespaceId, scope.agentId);
            require(agent &&
              !headRead &&
              !account &&
              !metadata, "The lifecycle head must follow the Agent lock.");
            const source = owner.unit.platform.runtimeAssignments;
            const result = await bind(source, "findRuntimeIntentHead").call(source, scope);
            headRead = true;
            head = result === undefined ? undefined : immutableCopy(result);
            return result;
          }),
      }),
      serviceAccounts: Object.freeze<Repositories["serviceAccounts"]>({
        lockServiceAccount: (ns, id) =>
          call(async () => {
            exactScope(ns);
            require(headRead &&
              agent?.serviceAccountId === id &&
              !account &&
              !metadata, "The original ServiceAccount must precede Configuration.");
            const source = owner.unit.platform.serviceAccounts;
            const result = await bind(source, "lockServiceAccount").call(source, ns, id);
            require(result?.namespaceId === ns &&
              result.id === id, "The selected ServiceAccount is unavailable.");
            account = immutableCopy(result!);
            return result;
          }),
        findServiceAccountProviderBinding: (ns, id) =>
          call(async () => {
            exactScope(ns);
            require(account?.id === id &&
              account.credential?.kind === "access_token" &&
              !providerBindingRead &&
              !metadata, "The original provider binding lookup is out of order.");
            const source = owner.unit.platform.serviceAccounts;
            const result = await bind(source, "findServiceAccountProviderBinding").call(
              source,
              ns,
              id,
            );
            providerBindingRead = true;
            providerBinding = result === undefined ? undefined : immutableCopy(result);
            return result;
          }),
      }),
      configurations: Object.freeze<Repositories["configurations"]>({
        lockConfiguration: (ns, id) =>
          call(async () => {
            exactScope(ns);
            require(account &&
              agent?.configurationId === id &&
              !metadata &&
              (account.credential?.kind !== "access_token" ||
                providerBindingRead), "An actual ServiceAccount must precede Configuration.");
            const source = owner.unit.platform.configurations;
            const result = await bind(source, "lockConfiguration").call(source, ns, id);
            require(result?.namespaceId === ns &&
              result.id === id &&
              result.kind === "agent" &&
              result.generation ===
                expected().command.expectedDraft
                  .configurationGeneration, "The locked Configuration changed.");
            metadata = immutableCopy(result!);
            bindings = normalizeSecretBindings(result!.secretBindings);
            return result;
          }),
      }),
      secrets: Object.freeze<Repositories["secrets"]>({
        lockSecret: (ns, id) =>
          call(async () => {
            exactScope(ns);
            const next = bindings && Object.values(bindings)[lockedSecrets.length]?.source;
            require(metadata &&
              next?.namespaceId === ns &&
              next.id === id &&
              !configuration, "Secret locks must follow the original binding order.");
            const source = owner.unit.platform.secrets;
            const result = await bind(source, "lockSecret").call(source, ns, id);
            require(result?.namespaceId === ns &&
              result.id === id, "The referenced Secret is unavailable.");
            lockedSecrets.push(immutableCopy(result!));
            return result;
          }),
      }),
      revisions: Object.freeze<Repositories["revisions"]>({
        listRevisions: (ns, id) =>
          call(async () => {
            exactScope(ns, id);
            require(validated &&
              previous === undefined, "Revision history must follow Configuration validation.");
            const source = owner.unit.platform.revisions;
            const result = await bind(source, "listRevisions").call(source, ns, id);
            require(result.every(
              (value) => value.namespaceId === ns && value.agentId === id,
            ), "Revision history has a different owner.");
            previous = immutableCopy(result);
            return result;
          }),
      }),
    }),
    drivers: Object.freeze<DeploymentCandidateOperationsV2["drivers"]>({
      compute: () =>
        sync(() => {
          require(foundAgent && !compute && !agent, "Compute selection is out of order.");
          const driver = owner.selection.selectedDriver("compute");
          hold("compute", driver);
          const id = driver.id,
            implementation = driver.implementation;
          contributors.push(() =>
            require(driver.id === id &&
              driver.implementation === implementation, "The Compute identity changed."),
          );
          compute = Object.freeze({ id, implementation });
          return compute;
        }),
      sandbox: () =>
        sync(() => {
          require(compute && !sandboxRead && !agent, "Sandbox selection is out of order.");
          const driver = owner.selection.sandboxDriver();
          hold("sandbox", driver);
          sandboxRead = true;
          if (driver === undefined) return undefined;
          const id = driver.id,
            configure = driver.configureAgent;
          contributors.push(() =>
            require(driver.id === id &&
              driver.configureAgent === configure, "The Sandbox contribution changed."),
          );
          sandbox = Object.freeze({
            id,
            ...(configure === undefined
              ? {}
              : {
                  configureAgent: (values: Parameters<NonNullable<typeof configure>>[0]) =>
                    sync(() => {
                      require(readConfiguration &&
                        !sandboxConfigured &&
                        !validated, "Sandbox normalization is out of order.");
                      require(sameCandidateDataV2(
                        values,
                        readConfiguration!.values,
                      ), "Sandbox input differs from the original Configuration read.");
                      const result = configure.call(driver, values);
                      sandboxConfigured = true;
                      return result;
                    }),
                }),
          });
          return sandbox;
        }),
      secret: (expectedId) =>
        sync(() => {
          require(metadata &&
            lockedSecrets.length > 0 &&
            !configuration, "Secret selection requires an actual referenced Secret.");
          if (!secret) {
            const driver = owner.selection.secretDriver(expectedId);
            hold("secret", driver);
            const id = driver.id,
              resolve = driver.resolve;
            contributors.push(() =>
              require(driver.id === id &&
                driver.resolve === resolve, "The Secret contribution changed."),
            );
            secret = Object.freeze<
              ReturnType<DeploymentCandidateOperationsV2["drivers"]["secret"]>
            >({
              id,
              resolve: (value) =>
                call(async () => {
                  const unique = [
                    ...new Map(lockedSecrets.map((item) => [item.id, item])).values(),
                  ];
                  const next = unique[resolvedSecrets.length];
                  require(secretsComplete() &&
                    next &&
                    sameCandidateDataV2(value, next) &&
                    next.driverId === id &&
                    !configuration, "Secret resolution differs from the original locked binding.");
                  const result = await resolve.call(driver, value);
                  require(sameCandidateDataV2(
                    result,
                    next!.backendRef,
                  ), "The resolved Secret backend changed.");
                  resolvedSecrets.push(next!.id);
                  return result;
                }),
            });
          }
          require(expectedId === undefined ||
            (secret.id === expectedId &&
              lockedSecrets.at(-1)?.driverId ===
                expectedId), "The selected Secret Driver does not own the locked Secret.");
          return secret;
        }),
      configuration: () =>
        sync(() => {
          require(metadata &&
            resolutionComplete() &&
            !configuration, "Configuration lookup must follow Secret resolution.");
          const driver = owner.selection.configurationDriver();
          hold("configuration", driver);
          const read = driver.read,
            validate = driver.validate;
          contributors.push(() =>
            require(driver.read === read &&
              driver.validate === validate, "The Configuration contribution changed."),
          );
          configuration = Object.freeze<
            ReturnType<DeploymentCandidateOperationsV2["drivers"]["configuration"]>
          >({
            read: (reference) =>
              call(async () => {
                require(metadata &&
                  !readConfiguration &&
                  reference.id === metadata.id &&
                  reference.namespaceId ===
                    metadata.namespaceId, "Configuration read differs from the original lock.");
                const result = await read.call(driver, reference);
                require(result.id === metadata!.id &&
                  result.namespaceId === metadata!.namespaceId &&
                  result.kind === metadata!.kind &&
                  result.generation === metadata!.generation &&
                  result.createdAt === metadata!.createdAt, "Configuration ownership changed.");
                readConfiguration = immutableCopy(result);
                return result;
              }),
            validate: (value) =>
              call(async () => {
                require(readConfiguration &&
                  metadata &&
                  !validated &&
                  (sandbox?.configureAgent === undefined ||
                    sandboxConfigured), "Configuration validation must follow original read and normalization.");
                require(value.id === metadata!.id &&
                  value.namespaceId === metadata!.namespaceId &&
                  value.kind === "agent" &&
                  value.generation === metadata!.generation &&
                  value.createdAt === metadata!.createdAt &&
                  sameCandidateDataV2(
                    normalizeSecretBindings(value.secretBindings),
                    bindings,
                  ), "Validated Configuration ownership changed.");
                const captured = immutableCopy(value);
                await validate.call(driver, value);
                require(sameCandidateDataV2(
                  value,
                  captured,
                ), "Configuration changed during validation.");
                validated = captured;
              }),
          });
          return configuration;
        }),
    }),
    nextRevisionId: () =>
      sync(() => {
        require(previous !== undefined &&
          revisionId ===
            undefined, "Revision identity may be allocated only once after validation.");
        const original = owner.original;
        const createId = bind(original, "createId");
        revisionId = createId.call(original);
        require(typeof revisionId === "string" &&
          revisionId.length > 0, "Revision identity is unavailable.");
        return revisionId;
      }),
    now: () =>
      sync(() => {
        require(revisionId !== undefined &&
          createdAt === undefined, "Candidate time may be allocated only once after identity.");
        const original = owner.original;
        const now = bind(original, "now");
        createdAt = now.call(original);
        require(typeof createdAt === "string" &&
          Number.isFinite(Date.parse(createdAt)), "Candidate time is unavailable.");
        return createdAt;
      }),
  });
  return Object.freeze({
    operations,
    assertCurrent,
    finish(result: DeploymentCandidateResultV2): CandidateObservedConfigurationV2 {
      try {
        assertCalling();
        require(!busy &&
          pending.size === 0, "The original normalizer returned before accepted work completed.");
        require(namespace &&
          agent &&
          account &&
          metadata &&
          validated &&
          previous &&
          revisionId &&
          createdAt &&
          compute &&
          sandboxRead &&
          resolutionComplete(), "The original normalizer did not complete its required operations.");
        const candidate = result.candidate;
        const candidateBindings = candidate.secretBindings;
        if (candidateBindings === undefined)
          throw new ScopeViolationError(
            "The candidate differs from actual original normalization observations.",
          );
        require(candidate.workloadProfileUse === undefined &&
          !Array.isArray(candidateBindings) &&
          sameCandidateDataV2(candidateBindings, bindings) &&
          sameCandidateDataV2(result.namespace, namespace) &&
          sameCandidateDataV2(result.lockedAgent, agent) &&
          (result.head === undefined
            ? head === undefined
            : sameCandidateDataV2(result.head, head)) &&
          result.providerId === agent!.providerId &&
          candidate.providerId === result.providerId &&
          candidate.id === revisionId &&
          candidate.createdAt === createdAt &&
          candidate.namespaceId === namespace!.id &&
          candidate.agentId === agent!.id &&
          candidate.revision === previous!.length + 1 &&
          candidate.configurationId === metadata!.id &&
          candidate.configurationGeneration === metadata!.generation &&
          candidate.configurationKind === "agent" &&
          sameCandidateDataV2(candidate.configuration, validated!.values) &&
          candidate.servicePrincipalId === agent!.servicePrincipalId &&
          candidate.harness.mode === agent!.executionMode &&
          candidate.maximumExecutionMs === agent!.maximumExecutionMs &&
          sameCandidateDataV2(candidate.compute, compute) &&
          candidate.sandboxDriverId === sandbox?.id &&
          candidate.secretDriverId === secret?.id &&
          candidate.serviceAccount?.id === account!.id &&
          sameCandidateDataV2(
            candidate.serviceAccount.credential,
            account!.credential,
          ), "The candidate differs from actual original normalization observations.");
        sealed = true;
        return Object.freeze({
          metadata: metadata!,
          validated: validated!,
          secretBindings: candidateBindings,
          agent: Object.freeze({
            id: agent!.id,
            namespaceId: agent!.namespaceId,
            servicePrincipalId: agent!.servicePrincipalId,
            ...(agent!.serviceAccountId === undefined
              ? {}
              : { serviceAccountId: agent!.serviceAccountId }),
            providerId: agent!.providerId,
          }),
          serviceAccount: account!,
          providerBinding,
          secrets: Object.freeze([...lockedSecrets]),
        });
      } catch (error) {
        return fail(error);
      }
    },
    release: async () => {
      closed = true;
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  });
}
