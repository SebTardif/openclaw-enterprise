import { decodeWorkloadProfileSelectionV1 } from "@openclaw-enterprise/contracts/workload-profile-v1";
import type { ServiceAccountRevision } from "@openclaw-enterprise/contracts/resources/service-account";
import { admitLoggingConfiguration } from "@openclaw-enterprise/contracts/logging";
import { immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  DependencyUnavailableError,
  NamespaceNotReadyError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../errors.ts";
import {
  assertConfiguredProvider,
  validateServiceAccountProviderBinding,
} from "../../providers.ts";
import {
  authorizeConfigurationBindings,
  configurationBindings,
  exactConfiguration,
} from "../configuration/service.ts";
import { validExecutionMode, validateModelBinding } from "../agent/model-binding.ts";
import { frozenRevision, frozenValues, resolveConfiguredHarnessId } from "./configuration.ts";
import type { DeploymentServiceOptions } from "./port.ts";
import type {
  DeploymentCandidateNormalizerV2,
  DeploymentCandidateOperationsV2,
} from "../../ports/workload-profile-candidate.ts";

/** Captures original dependencies without selecting Drivers or performing work.
 * The original caller supplies repository/Driver operations for this invocation;
 * their shape and the returned candidate are not a grant of authority. */
export function createDeploymentCandidateNormalizerV2(
  options: Pick<
    DeploymentServiceOptions,
    "authorization" | "providers" | "loggingLevel" | "configurationOperation" | "secretOperation"
  >,
): DeploymentCandidateNormalizerV2 {
  return async ([principalId, input, command], resolveHarness, operations) => {
    const state = operations.repositories;
    const compareGeneration = Object.hasOwn(input, "expectedLifecycleGeneration");
    const expectedGeneration = input.expectedLifecycleGeneration;
    if (!isNonEmptyString(input.namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    const namespace = await state.namespaces.lockNamespace(input.namespaceId);
    if (!namespace)
      throw new ScopeViolationError(
        "The Namespace does not belong to the server-owned Installation.",
      );
    const agent = await state.agents.findAgent(namespace.id, input.agentId);
    if (!agent)
      throw new ScopeViolationError(
        "The Agent does not belong to the exact Installation and Namespace.",
      );
    await options.authorization.authorize(principalId, "deploy", {
      kind: "agent",
      id: agent.id,
      namespaceId: namespace.id,
    });
    if (namespace.status !== "ready") throw new NamespaceNotReadyError();
    if (typeof resolveHarness !== "function")
      throw new DependencyUnavailableError("The selected Harness descriptor is unavailable.");

    let compute: ReturnType<DeploymentCandidateOperationsV2["drivers"]["compute"]>;
    try {
      compute = operations.drivers.compute();
    } catch {
      throw new DependencyUnavailableError("The selected compute Driver is unavailable.");
    }
    const sandbox = operations.drivers.sandbox();

    const lockedAgent = await state.agents.lockAgent(namespace.id, agent.id);
    if (!lockedAgent || !isNonEmptyString(lockedAgent.servicePrincipalId))
      throw new ScopeViolationError(
        "The Agent or its service principal does not belong to the exact Namespace.",
      );
    if (command !== undefined) {
      const expected = command.expectedDraft;
      const selected = decodeWorkloadProfileSelectionV1(lockedAgent.workloadProfileSelection);
      if (
        selected.kind !== "valid" ||
        lockedAgent.configurationId !== expected.configurationId ||
        lockedAgent.providerId !== expected.providerId ||
        lockedAgent.executionMode !== expected.executionMode ||
        lockedAgent.maximumExecutionMs !== expected.maximumExecutionMs ||
        (lockedAgent.serviceAccountId ?? null) !== expected.serviceAccountId ||
        selected.value.manifestRef !== expected.workloadProfileSelection.manifestRef ||
        selected.value.manifestDigest !== expected.workloadProfileSelection.manifestDigest ||
        selected.value.admissionRef !== expected.workloadProfileSelection.admissionRef ||
        selected.value.admissionVersion !== expected.workloadProfileSelection.admissionVersion
      )
        throw new ResourceConflictError(
          "The saved Agent draft does not match the retained command.",
        );
    }
    const scope = { namespaceId: namespace.id, agentId: lockedAgent.id };
    const head = await state.runtimeAssignments.findRuntimeIntentHead(scope);
    if (compareGeneration && expectedGeneration !== (head?.generation ?? null))
      throw new ResourceConflictError("The lifecycle generation does not match.");
    if (head !== undefined && head.desiredMode !== "running")
      throw new ResourceConflictError("Deploy cannot resume a disabled or stopped Agent.");
    if (head?.generation === Number.MAX_SAFE_INTEGER)
      throw new ResourceConflictError("The lifecycle generation is exhausted.");
    const providerId = lockedAgent.providerId === undefined ? null : lockedAgent.providerId;
    assertConfiguredProvider(options.providers, providerId, "Provider");
    if (sandbox !== undefined && lockedAgent.executionMode !== "dedicated")
      throw new ScopeViolationError(
        "The selected Sandbox Driver supports only dedicated Harness execution.",
      );
    if (command !== undefined && lockedAgent.serviceAccountId === undefined)
      throw new ScopeViolationError(
        "A selected workload profile requires an actual ServiceAccount.",
      );
    let serviceAccount: ServiceAccountRevision | undefined;
    if (lockedAgent.serviceAccountId !== undefined) {
      await options.authorization.authorize(principalId, "read", {
        kind: "service_account",
        id: lockedAgent.serviceAccountId,
        namespaceId: namespace.id,
      });
      const account = await state.serviceAccounts.lockServiceAccount(
        namespace.id,
        lockedAgent.serviceAccountId,
      );
      if (account === undefined)
        throw new ScopeViolationError("The ServiceAccount does not belong to the exact Namespace.");
      const credential = account.credential;
      if (credential === undefined)
        throw new ResourceConflictError("The associated ServiceAccount has no credential.");
      if (credential.kind !== "api_key" && credential.kind !== "access_token")
        throw new ResourceConflictError(
          "OAuth ServiceAccount credentials are not supported for deployment.",
        );
      if (credential.kind === "access_token") {
        validateServiceAccountProviderBinding(
          options.providers,
          providerId,
          await state.serviceAccounts.findServiceAccountProviderBinding(namespace.id, account.id),
        );
      }
      serviceAccount = immutableCopy({
        id: account.id,
        credential: { kind: credential.kind, secretRef: credential.secretRef },
      });
    }
    await options.authorization.authorize(principalId, "read", {
      kind: "configuration",
      id: lockedAgent.configurationId,
      namespaceId: namespace.id,
    });
    const metadata = await state.configurations.lockConfiguration(
      namespace.id,
      lockedAgent.configurationId,
    );
    if (!metadata || metadata.kind !== "agent")
      throw new ScopeViolationError(
        "The Agent Configuration must belong to the exact Namespace and configure an Agent.",
      );
    if (
      command !== undefined &&
      metadata.generation !== command.expectedDraft.configurationGeneration
    )
      throw new ResourceConflictError(
        "The saved Configuration generation does not match the retained command.",
      );
    const secretBindings = configurationBindings(metadata.secretBindings);
    const sources = await authorizeConfigurationBindings(
      state,
      principalId,
      namespace.id,
      secretBindings,
      {
        authorize: (actorId, action, resource) =>
          options.authorization.authorize(actorId, action, resource),
      },
      (expectedId) => {
        operations.drivers.secret(expectedId);
      },
    );
    validateModelBinding(secretBindings, lockedAgent.executionMode, lockedAgent.serviceAccountId);
    const secretDriver =
      Object.keys(secretBindings).length === 0 ? undefined : operations.drivers.secret();
    for (const secret of sources) {
      await options.authorization.authorize(lockedAgent.servicePrincipalId, "operate", {
        kind: "secret",
        id: secret.id,
        namespaceId: namespace.id,
      });
      const resolved = await options.secretOperation(() => secretDriver!.resolve(secret));
      if (
        Object.keys(secret.backendRef).some(
          (key) =>
            resolved[key as keyof typeof resolved] !==
            secret.backendRef[key as keyof typeof secret.backendRef],
        )
      )
        throw new DependencyUnavailableError("The Secret backend identity changed.");
    }
    const configurationDriver = operations.drivers.configuration();
    const configuration = exactConfiguration(
      await options.configurationOperation(() =>
        configurationDriver.read({ id: metadata.id, namespaceId: namespace.id }),
      ),
      metadata,
    );
    const sandboxConfiguration =
      sandbox?.configureAgent !== undefined
        ? frozenValues(sandbox.configureAgent(frozenValues(configuration.values)))
        : configuration.values;
    const admittedConfiguration = frozenValues(
      admitLoggingConfiguration(sandboxConfiguration, options.loggingLevel),
    );
    await configurationDriver.validate({ ...configuration, values: admittedConfiguration });
    if (!validExecutionMode(lockedAgent.executionMode))
      throw new ScopeViolationError("The persisted Agent Harness execution mode is invalid.");
    const configuredHarnessId = resolveConfiguredHarnessId(admittedConfiguration);
    const approvedHarness = resolveHarness(configuredHarnessId, lockedAgent.executionMode);
    if (
      approvedHarness === undefined ||
      !isNonEmptyString(approvedHarness.id) ||
      !isNonEmptyString(approvedHarness.version)
    ) {
      throw new DependencyUnavailableError("The selected Harness runtime is not approved.");
    }
    if (approvedHarness.id !== configuredHarnessId)
      throw new ScopeViolationError("The approved Harness does not match the native runtime.");
    if (
      (approvedHarness.id === "openclaw" && lockedAgent.executionMode !== "embedded") ||
      (approvedHarness.id === "codex" && lockedAgent.executionMode !== "dedicated") ||
      (approvedHarness.id !== "openclaw" && approvedHarness.id !== "codex")
    ) {
      throw new ScopeViolationError("The selected Harness does not support this execution mode.");
    }
    if (
      serviceAccount?.credential.kind === "access_token" &&
      (approvedHarness.id !== "codex" || lockedAgent.executionMode !== "dedicated")
    ) {
      throw new ResourceConflictError(
        "ServiceAccount access-token credentials require the dedicated Codex Harness.",
      );
    }
    const previous = await state.revisions.listRevisions(namespace.id, lockedAgent.id);
    const candidate = frozenRevision({
      id: operations.nextRevisionId(),
      namespaceId: namespace.id,
      agentId: lockedAgent.id,
      revision: previous.length + 1,
      maximumExecutionMs: lockedAgent.maximumExecutionMs,
      providerId,
      configurationId: configuration.id,
      configurationKind: configuration.kind,
      configurationGeneration: configuration.generation,
      configuration: admittedConfiguration,
      harness: {
        id: approvedHarness.id,
        version: approvedHarness.version,
        mode: lockedAgent.executionMode,
      },
      compute: { id: compute.id, implementation: compute.implementation },
      ...(sandbox === undefined ? {} : { sandboxDriverId: sandbox.id }),
      ...(secretDriver === undefined ? {} : { secretDriverId: secretDriver.id }),
      ...(secretDriver !== undefined || command !== undefined ? { secretBindings } : {}),
      ...(serviceAccount === undefined ? {} : { serviceAccount }),
      servicePrincipalId: lockedAgent.servicePrincipalId,
      createdAt: operations.now(),
    });
    return { candidate, namespace, lockedAgent, head, providerId };
  };
}
