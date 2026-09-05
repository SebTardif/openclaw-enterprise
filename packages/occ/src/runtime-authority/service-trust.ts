import { randomUUID } from "node:crypto";
import type {
  AuditEvent,
  IAMDriver,
  RuntimeServiceTrustConfigurationV1,
} from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../errors.ts";
import {
  assertChannelIAM,
  lookupChannelHuman,
  requireChannelPermission,
  selectedChannelIAM,
} from "../channel-bindings.ts";
import type {
  PlatformReadView,
  PlatformStateStore,
  PlatformUnitOfWork,
} from "../state/platform-state.ts";
import { PostgresCommitOutcomeUnknownError } from "../state/postgres-state.ts";
import { RuntimeAuthorityTransactionGuard } from "./repository.ts";
import type { RuntimeAuthorityCurrentTrustReader } from "./service.ts";
import {
  canonicalRuntimeServiceTrust,
  parseRuntimeAuthoritySource,
  parseRuntimeServiceNativeProfile,
  parseRuntimeServiceTrustRecord,
  parseRuntimeServiceTrustRequest,
  runtimeServiceTrustDigest,
  type CurrentRuntimeServiceTrust,
  type RuntimeAuthoritySource,
  type RuntimeServiceNativeProfile,
  type RuntimeServiceTrustRecord,
  type RuntimeServiceTrustRequest,
  type RuntimeServiceTrustSubjectKind,
  type RuntimeServiceTrustWriteResult,
} from "./service-trust-schema.ts";

export interface RuntimeServiceTrustReadRepository {
  findOperation(
    installationId: string,
    operationRef: string,
  ): Promise<Readonly<RuntimeServiceTrustRecord> | undefined>;
  latest(
    installationId: string,
    kind: RuntimeServiceTrustSubjectKind,
    subjectRef: string,
  ): Promise<Readonly<RuntimeServiceTrustRecord> | undefined>;
}
interface Reservation {
  readonly subjectRef: string;
  readonly recordVersion: number;
  readonly sourceAdmission?: Readonly<Extract<RuntimeServiceTrustRecord, { kind: "source-admit" }>>;
}
export interface RuntimeServiceTrustRepository extends RuntimeServiceTrustReadRepository {
  /** Internal OCC transaction entry. A trusted operator service supplies current authorization
   * and resolved material; persistence never authenticates a body or admits static startup JSON. */
  mutate(
    installationId: string,
    actorId: string,
    input: unknown,
    authorize: () => Promise<void>,
    prepare: (
      request: Readonly<RuntimeServiceTrustRequest>,
      reservation: Reservation,
    ) => Promise<{
      readonly record: Readonly<RuntimeServiceTrustRecord>;
      readonly audit: AuditEvent;
    }>,
  ): Promise<Extract<RuntimeServiceTrustWriteResult, { record: unknown }>>;
}
export interface RuntimeServiceTrustBackend {
  lockOperation(operationRef: string): Promise<void>;
  lockSubject(
    installationId: string,
    kind: RuntimeServiceTrustSubjectKind,
    subjectRef: string,
  ): Promise<void>;
  operation(operationRef: string): Promise<Readonly<RuntimeServiceTrustRecord> | undefined>;
  latest(
    installationId: string,
    kind: RuntimeServiceTrustSubjectKind,
    subjectRef: string,
  ): Promise<Readonly<RuntimeServiceTrustRecord> | undefined>;
  insert(record: Readonly<RuntimeServiceTrustRecord>, audit: AuditEvent): Promise<void>;
}
function conflict(): never {
  throw new ResourceConflictError(
    "The runtime service trust operation conflicts with retained state.",
  );
}
function unavailable(): never {
  throw new DependencyUnavailableError("Runtime service trust is unavailable.");
}
function live(signal: AbortSignal): void {
  if (signal.aborted) unavailable();
}

export function runtimeServiceTrustAuditMatches(
  record: RuntimeServiceTrustRecord,
  audit: AuditEvent,
): boolean {
  return (
    audit.id === record.auditId &&
    audit.installationId === record.installationId &&
    audit.namespaceId === undefined &&
    audit.actorId === record.actorId &&
    audit.actor?.principalId === record.actorId &&
    audit.kind === "mutation" &&
    audit.outcome === "success" &&
    audit.source === "occ" &&
    audit.schemaVersion === 1 &&
    audit.occurredAt === record.committedAt &&
    audit.action === `openclaw.runtime-service-trust.${record.kind}` &&
    audit.resource.kind === "installation" &&
    audit.resource.id === record.installationId &&
    audit.resource.namespaceId === undefined &&
    audit.authorization?.principalId === record.actorId &&
    audit.authorization.action === "administer" &&
    audit.authorization.resource.kind === "installation" &&
    audit.authorization.resource.id === record.installationId &&
    audit.authorization.resource.namespaceId === undefined &&
    typeof audit.iamDriverId === "string" &&
    audit.iamDriverId.length > 0 &&
    audit.details?.operationRef === record.operationRef &&
    audit.details.subjectRef === record.subjectRef &&
    audit.details.recordVersion === record.recordVersion &&
    audit.details.requestDigest === record.requestDigest
  );
}
export function createRuntimeServiceTrustRepository(
  backend: RuntimeServiceTrustBackend,
  view: Pick<PlatformReadView, "installations" | "agents" | "namespaces">,
  guard: RuntimeAuthorityTransactionGuard,
): RuntimeServiceTrustRepository {
  const initialized = async (installationId: string) => {
    if ((await view.installations.getInstallation())?.id !== installationId) unavailable();
  };
  return {
    findOperation: async (installationId, operationRef) => {
      await initialized(installationId);
      const record = await backend.operation(operationRef);
      return record?.installationId === installationId ? immutableCopy(record) : undefined;
    },
    latest: async (installationId, kind, subjectRef) => {
      await initialized(installationId);
      return backend.latest(installationId, kind, subjectRef);
    },
    mutate: (installationId, actorId, value, authorize, prepare) =>
      guard.run(async () => {
        const request = parseRuntimeServiceTrustRequest(value);
        await authorize();
        await initialized(installationId);
        await backend.lockOperation(request.operationRef);
        const prior = await backend.operation(request.operationRef);
        const canonicalRequest = canonicalRuntimeServiceTrust(request);
        if (prior) {
          if (
            prior.installationId !== installationId ||
            prior.actorId !== actorId ||
            prior.canonicalRequest !== canonicalRequest
          )
            conflict();
          await authorize();
          return { result: "exact-replay", record: immutableCopy(prior) };
        }
        // Lookup precedes UUID creation, deployment-source resolution and native validation.
        const subjectKind = request.kind.startsWith("source-") ? "source" : "service";
        const subjectRef =
          request.kind === "source-admit" || request.kind === "source-withdraw"
            ? request.sourceRef
            : (request.serviceIdentityRef ?? `runtime-service/${randomUUID()}`);
        let sourceAdmission:
          Extract<RuntimeServiceTrustRecord, { kind: "source-admit" }> | undefined;
        if (request.kind === "service-admit") {
          await backend.lockSubject(installationId, "source", request.sourceRef);
          const current = await backend.latest(installationId, "source", request.sourceRef);
          if (current?.kind !== "source-admit") conflict();
          sourceAdmission = current;
        }
        await backend.lockSubject(installationId, subjectKind, subjectRef);
        const before = await backend.latest(installationId, subjectKind, subjectRef);
        if (
          (before?.recordVersion ?? null) !== request.expectedVersion ||
          (before?.recordVersion ?? 0) >= Number.MAX_SAFE_INTEGER
        )
          conflict();
        if (request.kind === "service-admit") {
          const namespace = await view.namespaces.findNamespace(request.namespaceId);
          const agent = await view.agents.findAgent(request.namespaceId, request.agentId);
          if (!namespace || !agent || agent.namespaceId !== request.namespaceId)
            throw new ScopeViolationError("The exact service scope is unavailable.");
        }
        const reservation: Reservation = {
          subjectRef,
          recordVersion: (before?.recordVersion ?? 0) + 1,
          ...(sourceAdmission === undefined ? {} : { sourceAdmission }),
        };
        const prepared = await prepare(request, reservation);
        const record = parseRuntimeServiceTrustRecord(prepared.record);
        if (
          record.installationId !== installationId ||
          record.actorId !== actorId ||
          record.subjectRef !== subjectRef ||
          record.subjectKind !== subjectKind ||
          record.recordVersion !== reservation.recordVersion ||
          record.canonicalRequest !== canonicalRequest ||
          !runtimeServiceTrustAuditMatches(record, prepared.audit)
        )
          throw new ScopeViolationError("The service trust admission attribution is invalid.");
        if (
          record.kind === "service-admit" &&
          (record.sourceOperationRef !== sourceAdmission?.operationRef ||
            record.sourceRecordVersion !== sourceAdmission.recordVersion ||
            record.profile.sourceConfigurationDigest !== sourceAdmission.sourceConfigurationDigest)
        )
          conflict();
        await backend.insert(record, prepared.audit);
        return { result: "applied", record: immutableCopy(record) };
      }),
  };
}

/** Server-bound human session attribution, not a serialized service authority context. */
export interface RuntimeServiceTrustOperatorContext {
  readonly actorId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly requestId: string;
  readonly admissionDecisionId: string;
}
export interface RuntimeServiceTrustServiceOptions {
  readonly installationId: string;
  readonly state: PlatformStateStore;
  readonly iam: () => IAMDriver;
  readonly sources: readonly RuntimeAuthoritySource[];
  /** Actual bounded native maintained-parser adapter; absence never admits a service. */
  readonly validateProfile: (
    profile: Readonly<RuntimeServiceNativeProfile>,
    signal: AbortSignal,
  ) => Promise<void>;
}
export class RuntimeServiceTrustService implements RuntimeAuthorityCurrentTrustReader {
  private readonly options: RuntimeServiceTrustServiceOptions;
  private readonly sources: ReadonlyMap<string, Readonly<RuntimeAuthoritySource>>;
  constructor(options: RuntimeServiceTrustServiceOptions) {
    this.options = options;
    const sources = options.sources.map((source) => parseRuntimeAuthoritySource(source));
    if (new Set(sources.map((source) => source.sourceRef)).size !== sources.length)
      throw new ScopeViolationError("Runtime authority source refs must be unique.");
    this.sources = new Map(sources.map((source) => [source.sourceRef, source]));
  }
  private async administrator(context: RuntimeServiceTrustOperatorContext, signal: AbortSignal) {
    live(signal);
    if (
      ![
        context.actorId,
        context.issuer,
        context.subject,
        context.requestId,
        context.admissionDecisionId,
      ].every((value) => typeof value === "string" && value.length > 0 && value.length <= 200)
    )
      throw new AuthorizationDeniedError();
    const driver = selectedChannelIAM(this.options);
    const principal = await lookupChannelHuman(this.options, driver, {
      issuer: context.issuer,
      subject: context.subject,
    });
    if (principal.id !== context.actorId || principal.namespaceId !== undefined)
      throw new AuthorizationDeniedError();
    const check = await requireChannelPermission(
      this.options,
      driver,
      context.actorId,
      "administer",
      { kind: "installation", id: this.options.installationId },
    );
    assertChannelIAM(this.options, driver, driver.id);
    live(signal);
    return check;
  }
  async apply(
    input: unknown,
    context: RuntimeServiceTrustOperatorContext,
    signal: AbortSignal,
  ): Promise<RuntimeServiceTrustWriteResult> {
    const request = parseRuntimeServiceTrustRequest(input);
    try {
      return await this.options.state.transact((unit) =>
        this.applyInTransaction(unit, request, context, signal),
      );
    } catch (error) {
      if (error instanceof PostgresCommitOutcomeUnknownError)
        return {
          result: "commit-unknown",
          operationRef: request.operationRef,
          nextAction: "exact-readback-only",
        };
      throw error;
    }
  }
  async applyInTransaction(
    unit: PlatformUnitOfWork,
    input: unknown,
    context: RuntimeServiceTrustOperatorContext,
    signal: AbortSignal,
  ): Promise<Extract<RuntimeServiceTrustWriteResult, { record: unknown }>> {
    return unit.runtimeServiceTrust.mutate(
      this.options.installationId,
      context.actorId,
      input,
      async () => {
        await this.administrator(context, signal);
      },
      async (request, reservation) => {
        live(signal);
        const canonicalRequest = canonicalRuntimeServiceTrust(request);
        const base = {
          schemaVersion: 1 as const,
          installationId: this.options.installationId,
          operationRef: request.operationRef,
          subjectRef: reservation.subjectRef,
          recordVersion: reservation.recordVersion,
          canonicalRequest,
          requestDigest: runtimeServiceTrustDigest(request),
          actorId: context.actorId,
          auditId: `aud_${randomUUID()}`,
          committedAt: new Date().toISOString(),
        };
        let record: RuntimeServiceTrustRecord;
        if (request.kind === "source-admit") {
          const source = this.sources.get(request.sourceRef);
          if (!source) unavailable();
          record = {
            ...base,
            kind: request.kind,
            subjectKind: "source",
            source,
            sourceConfigurationDigest: runtimeServiceTrustDigest(source),
          };
        } else if (request.kind === "source-withdraw")
          record = { ...base, kind: request.kind, subjectKind: "source" };
        else if (request.kind === "service-withdraw")
          record = { ...base, kind: request.kind, subjectKind: "service" };
        else {
          const source = this.sources.get(request.sourceRef);
          const admitted = reservation.sourceAdmission;
          if (
            !source ||
            !admitted ||
            runtimeServiceTrustDigest(source) !== admitted.sourceConfigurationDigest
          )
            unavailable();
          const profile = parseRuntimeServiceNativeProfile({
            ...source,
            operationPolicy: "read-operation-only-v1",
            peerSPIFFEId: request.peerSPIFFEId,
            sourceConfigurationDigest: admitted.sourceConfigurationDigest,
          });
          try {
            await this.options.validateProfile(profile, signal);
          } catch {
            unavailable();
          }
          live(signal);
          const configuration: RuntimeServiceTrustConfigurationV1 = {
            schemaVersion: 1,
            installationId: this.options.installationId,
            configurationVersion: reservation.recordVersion,
            serviceIdentityRef: reservation.subjectRef,
            serviceTrustProfileRef: `runtime-service-profile/${randomUUID()}`,
            serviceTrustProfileDigest: runtimeServiceTrustDigest(profile),
            trustRootsRef: source.trustRootsRef,
            verifierProfileRef: source.verifierProfileRef,
            permittedRecipientRef: source.recipientRef,
            role: "lifecycle-authority",
            allowedScope: {
              kind: "agent",
              installationId: this.options.installationId,
              namespaceId: request.namespaceId,
              agentId: request.agentId,
            },
          };
          record = {
            ...base,
            kind: request.kind,
            subjectKind: "service",
            sourceOperationRef: admitted.operationRef,
            sourceRecordVersion: admitted.recordVersion,
            profile,
            configuration,
          };
        }
        const check = await this.administrator(context, signal);
        const audit: AuditEvent = {
          id: record.auditId,
          installationId: record.installationId,
          occurredAt: record.committedAt,
          kind: "mutation",
          actorId: context.actorId,
          source: "occ",
          schemaVersion: 1,
          requestId: context.requestId,
          admissionDecisionId: context.admissionDecisionId,
          actor: { principalId: context.actorId, issuer: context.issuer, subject: context.subject },
          action: `openclaw.runtime-service-trust.${record.kind}`,
          resource: { kind: "installation", id: record.installationId },
          outcome: "success",
          iamDriverId: check.decision.driverId,
          authorization: check.request,
          details: {
            operationRef: record.operationRef,
            subjectRef: record.subjectRef,
            recordVersion: record.recordVersion,
            requestDigest: record.requestDigest,
            checks: [{ request: check.request, decision: check.decision }],
          },
        };
        return { record, audit };
      },
    );
  }
  async recover(
    operationRef: string,
    context: RuntimeServiceTrustOperatorContext,
    signal: AbortSignal,
  ): Promise<Readonly<RuntimeServiceTrustRecord> | undefined> {
    await this.administrator(context, signal);
    const record = await this.options.state.read(
      (view) => view.runtimeServiceTrust.findOperation(this.options.installationId, operationRef),
      { signal, timeoutMs: 3000 },
    );
    await this.administrator(context, signal);
    return record?.actorId === context.actorId ? record : undefined;
  }
  async readCurrentRecord(
    serviceIdentityRef: string,
    signal: AbortSignal,
  ): Promise<Readonly<CurrentRuntimeServiceTrust> | undefined> {
    live(signal);
    const result = await this.options.state.read(
      async (view) => {
        const admission = await view.runtimeServiceTrust.latest(
          this.options.installationId,
          "service",
          serviceIdentityRef,
        );
        if (admission?.kind !== "service-admit") return undefined;
        const sourceAdmission = await view.runtimeServiceTrust.latest(
          this.options.installationId,
          "source",
          admission.profile.sourceRef,
        );
        if (
          sourceAdmission?.kind !== "source-admit" ||
          sourceAdmission.operationRef !== admission.sourceOperationRef ||
          sourceAdmission.recordVersion !== admission.sourceRecordVersion
        )
          return undefined;
        const source = this.sources.get(admission.profile.sourceRef);
        if (
          !source ||
          runtimeServiceTrustDigest(source) !== sourceAdmission.sourceConfigurationDigest ||
          sourceAdmission.sourceConfigurationDigest !== admission.profile.sourceConfigurationDigest
        )
          return undefined;
        parseRuntimeServiceTrustRecord(admission);
        parseRuntimeServiceTrustRecord(sourceAdmission);
        return immutableCopy({ admission, sourceAdmission });
      },
      { signal, timeoutMs: 3000 },
    );
    live(signal);
    return result;
  }
  async readCurrent(
    serviceIdentityRef: string,
    signal: AbortSignal,
  ): Promise<Readonly<RuntimeServiceTrustConfigurationV1> | undefined> {
    return (await this.readCurrentRecord(serviceIdentityRef, signal))?.admission.configuration;
  }
}
