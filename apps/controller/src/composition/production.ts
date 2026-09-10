import {
  startControllerGitHubReadMediation,
  type ControllerGitHubReadService,
} from "./github-read-mediation.ts";
import { composeSelectedComputeRendererContribution } from "./driver-factories/compute.ts";
import type { KubernetesInstalledRendererDefinitionOwner } from "../drivers/compute/kubernetes/renderer-source.ts";
import pg from "pg";
import type { AuditEvent, ComputeDriver } from "@openclaw-enterprise/contracts";
import {
  validateAuthAccountPrincipalSeed,
  validatePersistedNativeIAMState,
  type AuthPrincipalSeed,
} from "@openclaw-enterprise/iam";
import {
  OpenClawController,
  type ControllerOptions,
  PostgresPlatformState,
  RuntimeServiceTrustService,
} from "@openclaw-enterprise/occ";
import {
  createWorkloadProfilePurposeAccountParticipantV1,
  createWorkloadProfileOperatorAccountParticipantV1,
} from "@openclaw-enterprise/occ/account-authority/workload-profile";
import {
  createWorkloadProfileUseResolverV2,
  createWorkloadProfileCandidateBindingsSourceV2,
  createWorkloadProfileCandidateSourceV2,
  createWorkloadProfileCapabilityAggregatorV2,
  type WorkloadProfileCapabilityContributorsV2,
  type WorkloadProfileCandidateQualifiersV2,
  type WorkloadProfileCandidateRecordsReaderV2,
  type WorkloadProfileSourceEnrollmentV2,
} from "@openclaw-enterprise/occ/workload-profiles/admitted-use";
import type {
  OriginalCredentialCandidateSourceV1,
  OriginalCredentialCaptureConsumerV1,
} from "@openclaw-enterprise/occ/ports/workload-profile-credentials";
import { createAdmittedWorkloadProfileSelectorV2 } from "@openclaw-enterprise/occ/workload-profiles/selection";
import { createWorkloadProfileService } from "@openclaw-enterprise/occ/services/workload-profile/service";
import type { WorkloadProfileServicePort } from "@openclaw-enterprise/occ/services/workload-profile/port";
import { createPostgresControllerAuth } from "../auth/index.ts";
import { createControllerWorkloadProfileSessionSecurityV1 } from "../auth/workload-profile-session-security.ts";
import { createFastifyApp } from "../index.ts";
import { createControllerLifecycleStatusV1 } from "../lifecycle/read-integration-v1.ts";
import type {
  InstallationRuntimeDrivers,
  ServiceAccountDriverFactory,
} from "./installation-config.ts";
import { providerSummariesFromDefinitions } from "./installation-config.ts";
import { initializeServiceAccountDriver } from "./driver-factories/service-account.ts";
import type { OccLogger } from "../logging.ts";
import { resolveApprovedProductionHarness } from "./production-harness.ts";
import type { ControllerWorkspaceFilesAccess } from "../gateway/contracts.ts";
import { createWorkspaceFilesAccess, validateWorkspaceFilesApiKeyPath } from "./workspace-files.ts";

import {
  validateNativeRuntimeServiceProfile,
  type NativeGitHubMediationProfileValidation,
} from "../admission/runtime-authority-profile.ts";
import {
  DEFAULT_RUNTIME_AUTHORITY_BINARY_PATH,
  startRuntimeAuthorityReadback,
} from "./runtime-authority-readback.ts";

/** Original domain owners supplied by trusted process composition. These are
 * existing source ports, not a capability-name registry or admitted records.
 * Every acquired source still recognizes the exact original unit and owns its
 * semantic currentness through terminal cleanup. Compute owns its renderer. */
export interface WorkloadProfileCompositionOwnersV2 {
  readonly installedRenderer?: KubernetesInstalledRendererDefinitionOwner;
  readonly contributors?: Partial<
    Pick<
      WorkloadProfileCapabilityContributorsV2,
      "runtime" | "identity" | "credentials" | "storage"
    >
  >;
  readonly candidateQualifiers?: Partial<WorkloadProfileCandidateQualifiersV2>;
}

/** Called once by the original Controller factory before Agent/Deployment
 * capture. Synchronous assembly captures original owners; acquisition happens
 * later within their existing tracked operations, never during this callback. */
export type WorkloadProfileCompositionOwnerFactoryV2 = (
  context: Parameters<NonNullable<ControllerOptions["workloadProfiles"]>["create"]>[0],
  originals: Readonly<{
    sourceEnrollment: WorkloadProfileSourceEnrollmentV2;
    candidateRecords: WorkloadProfileCandidateRecordsReaderV2;
    consumeCapturedCredentialV1: OriginalCredentialCaptureConsumerV1["consumeCapturedCredentialV1"];
  }>,
) => WorkloadProfileCompositionOwnersV2;

/** Fixed trusted owners, constructed without acquisition. Central captures the
 * original credential source before this assembly receives its borrowed reader.
 * The source remains optional; missing genuine capture cannot qualify a candidate. */
export interface WorkloadProfileCompositionOwnerAssemblyV2 {
  readonly credentialSource?: OriginalCredentialCandidateSourceV1;
  readonly create: WorkloadProfileCompositionOwnerFactoryV2;
}

export interface ProductionConfig {
  readonly mode: "production";
  readonly workloadProfileOwners?: WorkloadProfileCompositionOwnerAssemblyV2;
  readonly host: string;
  readonly databaseUrl: string;
  readonly authSecret: string;
  readonly authBaseURL: string;
  readonly poolMax?: number;
  readonly drivers: InstallationRuntimeDrivers;
  readonly logger?: OccLogger;
  readonly serviceAccountDriverFactory?: ServiceAccountDriverFactory;
  readonly workspaceFilesAccess?: ControllerWorkspaceFilesAccess;
  readonly gatewayApiKeyPath?: string;
  readonly runtimeAuthorityBinaryPath?: string;
  readonly githubMediationProfileValidation?: NativeGitHubMediationProfileValidation;
  readonly githubReadServices?: readonly ControllerGitHubReadService[];
  readonly runtimeAuthorityReadbackConfigPath?: string;
}

export async function composeProduction(config: ProductionConfig) {
  if (config.mode !== "production")
    throw new Error("Production OCC composition requires explicit production mode.");
  const {
    installation,
    computeDriver,
    configurationDriver,
    secretDriver,
    sandboxDriver,
    createIAMDriver,
  } = config.drivers;
  if (
    (installation.drivers.service_account === undefined) !==
    (config.serviceAccountDriverFactory === undefined)
  ) {
    throw new Error(
      "The selected ServiceAccount Driver requires API-only PostgreSQL initialization.",
    );
  }

  const sources = installation.runtimeAuthoritySources ?? [];
  if (
    (sources.length > 0 ||
      config.runtimeAuthorityReadbackConfigPath !== undefined ||
      (config.githubReadServices?.length ?? 0) > 0) &&
    config.poolMax === 1
  )
    throw new Error("Runtime service trust requires at least two PostgreSQL connections.");
  const binaryPath = config.runtimeAuthorityBinaryPath ?? DEFAULT_RUNTIME_AUTHORITY_BINARY_PATH;
  let runtimeReadback: Awaited<ReturnType<typeof startRuntimeAuthorityReadback>> | undefined;
  let readbackLive = true;
  let githubReads: Awaited<ReturnType<typeof startControllerGitHubReadMediation>> | undefined;
  const closeNativeReads = async () => {
    const results = await Promise.allSettled([githubReads?.close(), runtimeReadback?.close()]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Native read cleanup failed.");
  };
  const driverId = installation.drivers.iam.id;
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 250,
    ...(config.poolMax === undefined ? {} : { max: config.poolMax }),
  });

  try {
    const state = new PostgresPlatformState(pool);
    const persistedInstallation = await state.loadInstallation();
    if (persistedInstallation === undefined) {
      throw new Error("The singleton Installation must be bootstrapped before production startup.");
    }
    const auth = await createPostgresControllerAuth({
      mode: config.mode,
      installationId: persistedInstallation.id,
      secret: config.authSecret,
      baseURL: config.authBaseURL,
      pool,
    });
    // Construct the original stable source before the controller. Every later
    // recovery purpose keeps this originating request's remaining ceiling.
    const workloadProfileRequests = auth.admissionVerifier.createWorkloadProfileRequestCustodyV1({
      maxRequestLifetimeMs: 30_000,
    });

    const iamState = await state.loadNativeIAMState(persistedInstallation.id);
    validatePersistedNativeIAMState(iamState);
    const iamDriver = createIAMDriver(state);
    const provisionAuthAccount = async (seed: AuthPrincipalSeed, auditEvent: AuditEvent) => {
      const current = await state.loadNativeIAMState(persistedInstallation.id);
      validateAuthAccountPrincipalSeed(seed, current, persistedInstallation.id);
      await state.appendNativeIAMPrincipal(seed, auditEvent);
    };

    const principal = iamState.identities.find((identity) => identity.kind === "principal");
    if (
      principal === undefined ||
      principal.kind !== "principal" ||
      principal.issuer.trim().length === 0 ||
      principal.subject.trim().length === 0
    ) {
      throw new Error("Production startup requires at least one persisted IAM Principal.");
    }

    const resolved = await iamDriver.lookupIdentity({
      issuer: principal.issuer,
      subject: principal.subject,
    });
    if (!resolved || resolved.kind !== "principal" || resolved.id !== principal.id)
      throw new Error("The persisted IAM Principal cannot be resolved uniquely.");

    const preflight = (
      computeDriver as ComputeDriver & {
        readonly preflight?: () => Promise<void>;
      }
    ).preflight;
    if (preflight !== undefined && typeof preflight !== "function") {
      throw new Error("The selected Compute Driver exposes an invalid production preflight.");
    }
    if (
      config.drivers.installation.drivers.compute.package === undefined &&
      preflight === undefined
    ) {
      throw new Error("The bundled Kubernetes Compute Driver requires production preflight.");
    }
    if (preflight !== undefined) await preflight.call(computeDriver);

    const workloadProfileAssembly = config.workloadProfileOwners;
    const ownerCreate = workloadProfileAssembly?.create;
    if (workloadProfileAssembly !== undefined && typeof ownerCreate !== "function")
      throw new Error("Workload profile owner assembly requires an original create method.");
    const createWorkloadProfileOwners = ownerCreate?.bind(workloadProfileAssembly);
    let workloadProfileService: WorkloadProfileServicePort | undefined;
    let githubReadSelection:
      | Parameters<NonNullable<ControllerOptions["workloadProfiles"]>["create"]>[0]["selection"]
      | undefined;
    const controller = new OpenClawController(persistedInstallation, {
      state,
      reservedChannelInstallationCreate: Object.freeze<
        NonNullable<ControllerOptions["reservedChannelInstallationCreate"]>
      >({
        state,
        create: (prepared, currentness) =>
          state.transact((unit) =>
            unit.channelBindings.createReservedChannelInstallation(prepared, currentness),
          ),
      }),
      workloadProfiles: {
        invocations: workloadProfileRequests.invocations,
        create(context) {
          if (context.state !== state || context.installation.id !== persistedInstallation.id)
            throw new Error("The workload profile factory requires the original controller state.");
          if (githubReadSelection !== undefined && githubReadSelection !== context.selection)
            throw new Error("Repository reads require the original controller DriverSelection.");
          githubReadSelection = context.selection;
          const security = createControllerWorkloadProfileSessionSecurityV1({
            requests: workloadProfileRequests,
            reader: state.workloadProfileSessionSecurityV1(),
          });
          const accountSources = {
            owner: state.workloadProfileAccountOwnerV1(),
            requests: workloadProfileRequests.requests,
            security,
          };
          const account = createWorkloadProfilePurposeAccountParticipantV1(accountSources);
          const profile = state.workloadProfileMutationEnrollmentV2(context.selection, account);
          const sourceEnrollment = state.workloadProfileSourceEnrollmentV2(context.selection);
          const credentialSource = workloadProfileAssembly?.credentialSource;
          const candidateContext = state.workloadProfileCandidateContextV2(
            context.selection,
            context.candidateNormalizer,
            context.candidateOperations,
            credentialSource,
          );
          const owners = createWorkloadProfileOwners?.(
            context,
            Object.freeze({
              sourceEnrollment,
              candidateRecords: candidateContext.records,
              consumeCapturedCredentialV1: candidateContext.consumeCapturedCredentialV1,
            }),
          );
          if (owners instanceof Promise) {
            void owners.catch(() => {});
            throw new Error("Workload profile owner composition must be synchronous.");
          }
          if (
            owners !== undefined &&
            (owners === null || typeof owners !== "object" || "then" in owners)
          )
            throw new Error(
              "Workload profile owner composition must return original source ports.",
            );
          const supplied = owners?.contributors;
          const runtime = supplied?.runtime;
          const identity = supplied?.identity;
          const credentials = supplied?.credentials;
          const storage = supplied?.storage;
          // Receive Compute's original capability once. The installed custodian
          // authenticates immutable artifacts and operands; this factory does
          // not infer them from the manifest or construct a second capability.
          const renderer = composeSelectedComputeRendererContribution(
            computeDriver,
            context.selection,
            sourceEnrollment,
            owners?.installedRenderer,
          );
          // TODO: install each genuine original domain supplier in the
          // process owner factory. Missing contributors remain explicit refusal;
          // configured records or a partial renderer cannot replace them.
          const capabilities = createWorkloadProfileCapabilityAggregatorV2({
            ...(renderer === undefined ? {} : { renderer }),
            ...(runtime === undefined ? {} : { runtime }),
            ...(identity === undefined ? {} : { identity }),
            ...(credentials === undefined ? {} : { credentials }),
            ...(storage === undefined ? {} : { storage }),
          });
          const bindings = createWorkloadProfileCandidateBindingsSourceV2(
            candidateContext.records,
            owners?.candidateQualifiers,
          );
          const candidates = createWorkloadProfileCandidateSourceV2(
            candidateContext.contexts,
            bindings,
          );
          const selector = createAdmittedWorkloadProfileSelectorV2(
            state.workloadProfileSelectionStorageV2(),
            capabilities,
          );
          workloadProfileService = createWorkloadProfileService({
            state,
            selection: context.selection,
            account: createWorkloadProfileOperatorAccountParticipantV1(accountSources),
            definitions: capabilities,
          });
          return {
            enrollment: profile.enrollment,
            candidates: candidateContext.candidates,
            use: createWorkloadProfileUseResolverV2(
              profile.activeReader,
              candidates,
              capabilities,
              selector,
            ),
          };
        },
      },
      recordOperations: true,
      providers: installation.provider,
      loggingLevel: config.drivers.installation.logging.level,
    });
    controller.registerDriver(iamDriver);
    if (controller.selectDriver("iam", driverId) !== iamDriver)
      throw new Error("The server-owned IAM Driver was not selected correctly.");
    controller.registerDriver(computeDriver);
    if (controller.selectDriver("compute", computeDriver.id) !== computeDriver)
      throw new Error("The configured Compute Driver was not selected correctly.");
    controller.registerDriver(secretDriver);
    if (controller.selectDriver("secret", secretDriver.id) !== secretDriver) {
      throw new Error("The configured Secret Driver was not selected correctly.");
    }
    if (sandboxDriver !== undefined) {
      controller.registerDriver(sandboxDriver);
      if (controller.selectDriver("sandbox", sandboxDriver.id) !== sandboxDriver) {
        throw new Error("The configured Sandbox Driver was not selected correctly.");
      }
    }
    controller.registerDriver(configurationDriver);
    if (controller.selectDriver("configuration", configurationDriver.id) !== configurationDriver) {
      throw new Error("The configured Configuration Driver was not selected correctly.");
    }
    if (config.serviceAccountDriverFactory !== undefined)
      initializeServiceAccountDriver(config.serviceAccountDriverFactory, controller, state);
    await controller.validateProviderConfiguration();

    let workspaceFilesAccess = config.workspaceFilesAccess;
    if (workspaceFilesAccess === undefined && config.gatewayApiKeyPath !== undefined) {
      const gatewayApiKeyPath = config.gatewayApiKeyPath;
      await validateWorkspaceFilesApiKeyPath(gatewayApiKeyPath);
      workspaceFilesAccess = createWorkspaceFilesAccess(computeDriver, gatewayApiKeyPath);
    }

    const runtimeServiceTrust = new RuntimeServiceTrustService({
      installationId: persistedInstallation.id,
      state,
      iam: () => controller.selectedDriver("iam"),
      sources,
      validateProfile: (profile, signal) =>
        validateNativeRuntimeServiceProfile(
          binaryPath,
          profile,
          signal,
          config.githubMediationProfileValidation,
        ),
    });
    if (workloadProfileService === undefined)
      throw new Error("The original workload profile composition was not constructed.");
    const app = createFastifyApp({
      lifecycleStatus: createControllerLifecycleStatusV1({
        installationId: persistedInstallation.id,
        state,
        verifier: auth.admissionVerifier,
      }),
      workloadProfileService,
      workloadProfileRequests,
      runtimeServiceTrust,
      controller,
      iamDriver,
      computeDriver,
      configurationDriver,
      secretDriver,
      publicOrigin: config.authBaseURL,
      ...(sandboxDriver === undefined ? {} : { sandboxDriver }),
      resolveHarness: resolveApprovedProductionHarness,
      auditSink: state.auditSink,
      providerSummaries: providerSummariesFromDefinitions(installation.provider),
      auth,
      ...(config.logger === undefined ? {} : { logger: config.logger }),
      provisionAuthAccount,
      development: {
        enabled: false,
        installationId: persistedInstallation.id,
      },
      maxBodyBytes: 64 * 1024,
      ...(workspaceFilesAccess === undefined ? {} : { workspaceFilesAccess }),
    });
    if (config.runtimeAuthorityReadbackConfigPath !== undefined) {
      runtimeReadback = await startRuntimeAuthorityReadback({
        state,
        computeDriver,
        installationId: persistedInstallation.id,
        trust: runtimeServiceTrust,
        configPath: config.runtimeAuthorityReadbackConfigPath,
        binaryPath,
      });
      runtimeReadback.closed.then(
        () => {
          readbackLive = false;
        },
        () => {
          readbackLive = false;
        },
      );
    }
    if (config.githubReadServices !== undefined) {
      if (githubReadSelection === undefined)
        throw new Error("Repository reads require the original controller DriverSelection.");
      githubReads = await startControllerGitHubReadMediation(config.githubReadServices, {
        state,
        selection: githubReadSelection,
        installationId: persistedInstallation.id,
        trust: runtimeServiceTrust,
      });
    }
    app.get("/healthz", async () => ({ status: "ok" }));
    app.get("/readyz", async () => {
      if (!readbackLive) throw new Error("Native runtime readback unavailable.");
      await pool.query("SELECT 1");
      return { status: "ready" };
    });
    app.addHook("onClose", async () => {
      try {
        await closeNativeReads();
      } finally {
        await state.close();
      }
    });
    return app;
  } catch (error) {
    try {
      await closeNativeReads();
    } finally {
      await pool.end();
    }
    throw error;
  }
}
