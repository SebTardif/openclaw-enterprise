import { composeSelectedComputeRendererContribution } from "./driver-factories/compute.ts";
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
import { createWorkloadProfilePurposeAccountParticipantV1, createWorkloadProfileOperatorAccountParticipantV1 } from "@openclaw-enterprise/occ/account-authority/workload-profile";
import { createWorkloadProfileUseResolverV2, createWorkloadProfileCandidateBindingsSourceV2, createWorkloadProfileCandidateSourceV2, createWorkloadProfileCapabilityAggregatorV2 } from "@openclaw-enterprise/occ/workload-profiles/admitted-use";
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

import { validateNativeRuntimeServiceProfile } from "../admission/runtime-authority-profile.ts";
import {
  DEFAULT_RUNTIME_AUTHORITY_BINARY_PATH,
  startRuntimeAuthorityReadback,
} from "./runtime-authority-readback.ts";

export interface ProductionConfig {
  readonly mode: "production";
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
    (sources.length > 0 || config.runtimeAuthorityReadbackConfigPath !== undefined) &&
    config.poolMax === 1
  )
    throw new Error("Runtime service trust requires at least two PostgreSQL connections.");
  const binaryPath = config.runtimeAuthorityBinaryPath ?? DEFAULT_RUNTIME_AUTHORITY_BINARY_PATH;
  let runtimeReadback: Awaited<ReturnType<typeof startRuntimeAuthorityReadback>> | undefined;
  let readbackLive = true;
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

    let workloadProfileService: WorkloadProfileServicePort | undefined;
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
          const candidateContext = state.workloadProfileCandidateContextV2(
            context.selection,
            context.candidateNormalizer,
            context.candidateOperations,
          );
          const renderer = composeSelectedComputeRendererContribution(
            computeDriver,
            context.selection,
            state.workloadProfileSourceEnrollmentV2(context.selection),
          );
          // The genuine renderer/Platform association is now installed. Its
          // independent immutable-definition custodian remains required. Native,
          // identity, credential and storage complete owners are still absent;
          // the one aggregator names these prerequisites and refuses admission.
          const capabilities = createWorkloadProfileCapabilityAggregatorV2({
            ...(renderer === undefined ? {} : { renderer }),
          });
          const bindings = createWorkloadProfileCandidateBindingsSourceV2(candidateContext.records);
          const candidates = createWorkloadProfileCandidateSourceV2(candidateContext.contexts, bindings);
          const selector = createAdmittedWorkloadProfileSelectorV2(
            state.workloadProfileSelectionStorageV2(), capabilities);
          workloadProfileService = createWorkloadProfileService({
            state, selection: context.selection,
            account: createWorkloadProfileOperatorAccountParticipantV1(accountSources),
            definitions: capabilities,
          });
          return {
            enrollment: profile.enrollment,
            candidates: candidateContext.candidates,
            use: createWorkloadProfileUseResolverV2(profile.activeReader, candidates, capabilities, selector),
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
        validateNativeRuntimeServiceProfile(binaryPath, profile, signal),
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
    app.get("/healthz", async () => ({ status: "ok" }));
    app.get("/readyz", async () => {
      if (!readbackLive) throw new Error("Native runtime readback unavailable.");
      await pool.query("SELECT 1");
      return { status: "ready" };
    });
    app.addHook("onClose", async () => {
      try {
        await runtimeReadback?.close();
      } finally {
        await state.close();
      }
    });
    return app;
  } catch (error) {
    try {
      await runtimeReadback?.close();
    } finally {
      await pool.end();
    }
    throw error;
  }
}
