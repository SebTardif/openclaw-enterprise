import { randomUUID } from "node:crypto";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { DependencyUnavailableError, ScopeViolationError } from "../../errors.ts";
import type { TransactionQuery } from "../../ports/repository-factory.ts";
import type { WorkClaim } from "../../ports/repositories/work.ts";
import type { PlatformReadOptions } from "../../ports/transaction.ts";
import type {
  RuntimePreparationCurrentUseLeaseV1,
  RuntimePreparationCurrentUseRequestV1,
} from "../../runtime-preparation/current-use.ts";
import type {
  RuntimePreparationCommittedSubmissionV1,
  RuntimePreparationResponseObservationContextV1,
  RuntimePreparationResponseObservationLeaseV1,
  RuntimePreparationResponseObservationSourceV1,
  RuntimePreparationSubmissionOwnerV1,
  RuntimePreparationSubmissionParticipantV1,
} from "../../runtime-preparation/submission-owner.ts";
import type {
  RuntimePreparationDeploymentResponseV1,
  RuntimePreparationSubmissionResultV1,
} from "../../runtime-preparation/submission.ts";
import { requirePreparation, samePreparationValue } from "../../runtime-preparation/types.ts";
import type { WorkloadProfileOwnedOperationV2 } from "../../workload-profiles/admitted-use.ts";

/** Structural participation in the existing State transaction finalizer. This
 * private interface carries no transaction, effect, service or profile authority. */
export interface PostgresRuntimeTransactionParticipantV1 {
  poison(error: unknown): void;
  closeAdmissions(): void;
  drain(): Promise<void>;
  prepareCommit(): Promise<void>;
  assertCommitReady(): void;
  finishTerminal(): Promise<void>;
}

/** Only the original State constructor supplies these bound methods. */
interface SubmissionOwnerBackend {
  currentUse<T>(
    claim: WorkClaim,
    request: RuntimePreparationCurrentUseRequestV1,
    bounds: PlatformReadOptions,
    work: (
      lease: RuntimePreparationCurrentUseLeaseV1,
      io: WorkloadProfileOwnedOperationV2,
    ) => Promise<T>,
  ): Promise<T>;
  response(
    execution: PostgresPreparationResponseExecutionV1,
  ): Promise<RuntimePreparationSubmissionResultV1>;
  isCommitUnknown(error: unknown): boolean;
}

const unknown = (effectRef: string): RuntimePreparationSubmissionResultV1 =>
  Object.freeze({ status: "unknown", effectRef });
const unavailable = (effectRef: string): RuntimePreparationSubmissionResultV1 =>
  Object.freeze({ status: "unavailable", effectRef });
const markerSelect = `SELECT s.*,s.preparation_version::text AS preparation_version,
  to_char(s.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted_at,
  r.namespace_name,r.deployment_name,r.deployment_uid,r.resource_version,
  to_char(r.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at
  FROM occ.runtime_preparation_submissions s
  LEFT JOIN occ.runtime_preparation_submission_responses r USING(effect_ref)
  WHERE s.effect_ref=$1`;

function row(value: unknown): Record<string, unknown> {
  requirePreparation(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function text(value: Record<string, unknown>, key: string, maximum = 1024): string {
  const result = value[key];
  requirePreparation(typeof result === "string" && result.length > 0 && result.length <= maximum);
  return result;
}
function timestamp(value: string): string {
  const time = Date.parse(value);
  requirePreparation(Number.isFinite(time) && new Date(time).toISOString() === value);
  return value;
}
function matchingMarker(
  value: Record<string, unknown>,
  expected: Pick<RuntimePreparationCommittedSubmissionV1, "request" | "child">,
): void {
  const { request, child } = expected;
  requirePreparation(
    value.effect_ref === request.effectRef &&
      value.installation_id === request.selection.installationId &&
      value.namespace_id === request.selection.namespaceId &&
      value.agent_id === request.selection.agentId &&
      value.revision_id === request.selection.revisionId &&
      value.preparation_ref === request.preparationRef &&
      value.preparation_version === String(request.preparationVersion) &&
      value.request_digest === child.effect.requestDigest &&
      value.provider_wire_digest === child.providerWire.bytesDigest,
  );
}
function responseFromRow(
  value: Record<string, unknown>,
  committed: Pick<RuntimePreparationCommittedSubmissionV1, "request" | "child">,
): RuntimePreparationSubmissionResultV1 {
  matchingMarker(value, committed);
  if (value.deployment_uid == null) return unknown(committed.request.effectRef);
  const response = Object.freeze({
    namespace: text(value, "namespace_name", 253),
    name: text(value, "deployment_name", 253),
    uid: text(value, "deployment_uid"),
    resourceVersion: text(value, "resource_version"),
    receivedAt: timestamp(text(value, "received_at")),
  });
  requirePreparation(
    response.name === committed.child.providerTarget.name &&
      (committed.child.predicate.kind !== "expected-object" ||
        response.uid === committed.child.predicate.uid),
  );
  return Object.freeze({ status: "retained", effectRef: committed.request.effectRef, response });
}
async function lockSubmission(query: TransactionQuery, effectRef: string): Promise<void> {
  await query.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('runtime-preparation-submission:'||$1,0))",
    [effectRef],
  );
}

/** Marker acceptance is the only path to this process's captured participant.
 * No stored marker, including an uncertain prior write, remints that invocation. */
export function createPostgresPreparationSubmissionOwnerV1(
  backend: SubmissionOwnerBackend,
  participant: RuntimePreparationSubmissionParticipantV1,
  responseSource: RuntimePreparationResponseObservationSourceV1,
): RuntimePreparationSubmissionOwnerV1 {
  const invoke = participant.invoke.bind(participant);
  const acquire = responseSource.acquire.bind(responseSource);
  const source: RuntimePreparationResponseObservationSourceV1 = Object.freeze({ acquire });
  return Object.freeze({
    submit: async (
      claim: WorkClaim,
      input: RuntimePreparationCurrentUseRequestV1,
      suppliedBounds: PlatformReadOptions,
    ) => {
      const request = immutableCopy(input);
      const originalClaim = immutableCopy(claim);
      const bounds = Object.freeze({
        signal: suppliedBounds.signal,
        timeoutMs: suppliedBounds.timeoutMs,
      });
      let accepted:
        | Readonly<{ kind: "new"; committed: RuntimePreparationCommittedSubmissionV1 }>
        | Readonly<{ kind: "existing"; result: RuntimePreparationSubmissionResultV1 }>;
      try {
        accepted = await backend.currentUse(originalClaim, request, bounds, async (lease, io) => {
          lease.assertCurrent();
          requirePreparation(
            samePreparationValue(lease.request, request) &&
              lease.child.request.kind === "create" &&
              lease.child.providerTarget.apiKind === "Deployment" &&
              lease.child.effect.effectRef === request.effectRef &&
              lease.preparation.preparationRef === request.preparationRef &&
              lease.preparation.localVersion === request.preparationVersion &&
              lease.preparation.children.some(
                (entry) =>
                  samePreparationValue(entry.child, lease.child) &&
                  entry.providerWireUtf8 === lease.providerWireUtf8,
              ),
          );
          await lockSubmission(io, request.effectRef);
          const prior = await io.query(markerSelect, [request.effectRef]);
          lease.assertCurrent();
          requirePreparation(prior.rows.length <= 1);
          if (prior.rows.length)
            return {
              kind: "existing" as const,
              result: responseFromRow(row(prior.rows[0]), lease),
            };
          const submissionRef = randomUUID();
          const scope = request.selection;
          const inserted = await io.query(
            `INSERT INTO occ.runtime_preparation_submissions
            (effect_ref,submission_ref,installation_id,namespace_id,agent_id,revision_id,preparation_ref,
             preparation_version,request_digest,provider_wire_digest,submitted_at)
            VALUES($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,date_trunc('milliseconds',clock_timestamp()))
            ON CONFLICT(effect_ref) DO NOTHING RETURNING submission_ref::text,
            to_char(submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS submitted_at`,
            [
              request.effectRef,
              submissionRef,
              scope.installationId,
              scope.namespaceId,
              scope.agentId,
              scope.revisionId,
              request.preparationRef,
              request.preparationVersion,
              lease.child.effect.requestDigest,
              lease.child.providerWire.bytesDigest,
            ],
          );
          lease.assertCurrent();
          requirePreparation(inserted.rows.length <= 1);
          if (!inserted.rows.length) {
            const existing = await io.query(markerSelect, [request.effectRef]);
            lease.assertCurrent();
            requirePreparation(existing.rows.length === 1);
            return {
              kind: "existing" as const,
              result: responseFromRow(row(existing.rows[0]), lease),
            };
          }
          const marker = row(inserted.rows[0]);
          requirePreparation(marker.submission_ref === submissionRef);
          const committed: RuntimePreparationCommittedSubmissionV1 = immutableCopy({
            submissionRef,
            submittedAt: timestamp(text(marker, "submitted_at")),
            claim: originalClaim,
            request,
            preparation: lease.preparation,
            child: lease.child,
            providerWireUtf8: lease.providerWireUtf8,
          });
          return { kind: "new" as const, committed };
        });
      } catch (error) {
        return backend.isCommitUnknown(error)
          ? unknown(request.effectRef)
          : unavailable(request.effectRef);
      }
      // The original transaction promise includes its COMMIT acknowledgement and
      // terminal cleanup. No callback is reachable from either failure branch.
      if (accepted.kind === "existing") return accepted.result;
      const committed = accepted.committed;
      const pending = new Set<Promise<RuntimePreparationSubmissionResultV1>>();
      let retained: RuntimePreparationSubmissionResultV1 | undefined;
      const retainResponse = (
        originalResponse: RuntimePreparationDeploymentResponseV1,
        call: AuthorityCallV1,
      ): Promise<RuntimePreparationSubmissionResultV1> => {
        // Preserve the original response and call identities until the genuine
        // observation source consumes them; not even a response getter runs here.
        const operation = (async () => {
          try {
            const execution = new PostgresPreparationResponseExecutionV1(
              committed,
              originalResponse,
              call,
              source,
            );
            const result = await backend.response(execution);
            if (result.status === "retained") retained = result;
            return result;
          } catch (error) {
            return backend.isCommitUnknown(error)
              ? unknown(request.effectRef)
              : unavailable(request.effectRef);
          }
        })();
        pending.add(operation);
        void operation.then(
          () => pending.delete(operation),
          () => pending.delete(operation),
        );
        return operation;
      };
      try {
        await invoke(committed, retainResponse);
      } catch {
        /* A possible submission remains unknown until authentic evidence is retained. */
      }
      while (pending.size) await Promise.allSettled([...pending]);
      // The original captured closure stays usable for genuine late observation;
      // it never invokes again, and it does not retain the old profile unit.
      return retained ?? unknown(request.effectRef);
    },
  });
}

interface CapturedObservation {
  release: () => Promise<void>;
  current?: () => undefined;
  prepare?: () => Promise<void>;
}

/** Independent response transaction participant. It uses the same State-owned
 * finalizer hooks; it cannot carry live worker/profile authority past COMMIT. */
export class PostgresPreparationResponseExecutionV1 implements PostgresRuntimeTransactionParticipantV1 {
  readonly #pending = new Set<Promise<unknown>>();
  readonly #leases = new Map<RuntimePreparationResponseObservationLeaseV1, CapturedObservation>();
  readonly #began = performance.now();
  readonly #deadline: number;
  readonly timeoutMs: number;
  #failed = false;
  #failure: unknown;
  #active = true;
  #queryOpen = true;
  #accepting = true;
  #prepared = false;
  #checking = false;
  #acquired = false;
  #assertOwner: (() => void) | undefined;
  #terminal: Promise<void> | undefined;

  readonly committed: RuntimePreparationCommittedSubmissionV1;
  readonly originalResponse: RuntimePreparationDeploymentResponseV1;
  readonly call: AuthorityCallV1;
  readonly source: RuntimePreparationResponseObservationSourceV1;
  constructor(
    committed: RuntimePreparationCommittedSubmissionV1,
    originalResponse: RuntimePreparationDeploymentResponseV1,
    call: AuthorityCallV1,
    source: RuntimePreparationResponseObservationSourceV1,
  ) {
    this.committed = committed;
    this.originalResponse = originalResponse;
    this.call = call;
    this.source = source;
    this.#deadline = Date.parse(call.deadline);
    this.timeoutMs = Math.min(3000, this.#deadline - Date.now());
    this.assertOwner();
  }
  poison(error: unknown): void {
    if (!this.#failed) {
      this.#failed = true;
      this.#failure = error;
    }
  }
  private reject(error: unknown): never {
    this.poison(error);
    throw this.#failure;
  }
  private assertOwner(): void {
    if (this.#failed) throw this.#failure;
    if (
      !this.#active ||
      this.call.signal.aborted ||
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      Date.now() >= this.#deadline ||
      performance.now() - this.#began >= this.timeoutMs
    )
      this.reject(new DependencyUnavailableError("The response observation owner is unavailable."));
    try {
      this.#assertOwner?.();
    } catch (error) {
      this.reject(error);
    }
  }
  private observe<T>(promise: Promise<T>): Promise<T> {
    const result = promise.catch((error: unknown) => this.reject(error));
    this.#pending.add(result);
    void result.then(
      () => this.#pending.delete(result),
      () => this.#pending.delete(result),
    );
    return result;
  }
  assertCurrent = (): undefined => {
    this.assertOwner();
    if (this.#checking)
      return this.reject(new ScopeViolationError("Response currentness reentered."));
    this.#checking = true;
    try {
      for (const lease of this.#leases.values()) {
        if (!lease.current) continue;
        const result: unknown = lease.current();
        if (result !== undefined) {
          this.observe(Promise.resolve(result));
          this.reject(new ScopeViolationError("Response currentness must be synchronous."));
        }
      }
      this.assertOwner();
      return undefined;
    } catch (error) {
      return this.reject(error);
    } finally {
      this.#checking = false;
    }
  };
  private captureAcceptedLease(lease: RuntimePreparationResponseObservationLeaseV1): void {
    // Accepted acquisition may finish after cancellation closed new admissions.
    // Transfer its cleanup before observing the latched currentness failure.
    if (!this.#active || !this.#queryOpen)
      throw new ScopeViolationError("Response cleanup ownership is closed.");
    if (!this.#leases.has(lease)) {
      const captured: CapturedObservation = { release: lease.release.bind(lease) };
      this.#leases.set(lease, captured);
      captured.current = lease.assertCurrent.bind(lease);
      captured.prepare = lease.prepareCommit.bind(lease);
    }
  }
  retain = (lease: RuntimePreparationResponseObservationLeaseV1): undefined => {
    try {
      if (!this.#active || !this.#accepting)
        throw new ScopeViolationError("Response enrollment is closed.");
      this.captureAcceptedLease(lease);
      this.assertCurrent();
      return undefined;
    } catch (error) {
      return this.reject(error);
    }
  };
  async invoke(
    originalQuery: TransactionQuery,
    installationId: string,
    assertOwner: () => void,
  ): Promise<RuntimePreparationSubmissionResultV1> {
    if (this.#assertOwner !== undefined)
      return this.reject(new ScopeViolationError("The response owner was already entered."));
    this.#assertOwner = assertOwner;
    this.assertCurrent();
    requirePreparation(installationId === this.committed.request.selection.installationId);
    const query: TransactionQuery = Object.freeze({
      query: (statement: string, parameters?: readonly unknown[]) => {
        try {
          this.assertOwner();
          if (!this.#queryOpen) throw new ScopeViolationError("Response source IO is closed.");
          return this.observe(
            (async () => {
              const result = await originalQuery.query(statement, parameters);
              this.assertOwner();
              return result;
            })(),
          );
        } catch (error) {
          this.poison(error);
          return this.observe(Promise.reject(error));
        }
      },
    });
    const context: RuntimePreparationResponseObservationContextV1 = Object.freeze({
      installationId,
      query,
      assertActive: () => {
        this.assertOwner();
        return undefined;
      },
      retain: this.retain,
    });
    const acquired = await this.observe(
      this.source.acquire(context, this.committed, this.originalResponse, this.call),
    );
    this.captureAcceptedLease(acquired);
    this.assertCurrent();
    this.#acquired = true;
    // Authority recognizes the original native result before this first copy.
    const response = immutableCopy(this.originalResponse);
    requirePreparation(
      Object.keys(response).sort().join(",") === "name,namespace,receivedAt,resourceVersion,uid",
    );
    for (const key of ["namespace", "name", "uid", "resourceVersion"] as const) {
      requirePreparation(
        typeof response[key] === "string" &&
          response[key].length > 0 &&
          response[key].length <= (key === "namespace" || key === "name" ? 253 : 1024),
      );
    }
    timestamp(response.receivedAt);
    // The SDK host and database have independent clocks. Original observation
    // custody and the exact marker establish association; wall-clock order does not.
    requirePreparation(
      response.name === this.committed.child.providerTarget.name &&
        (this.committed.child.predicate.kind !== "expected-object" ||
          response.uid === this.committed.child.predicate.uid),
    );
    this.assertCurrent();
    await lockSubmission(query, this.committed.request.effectRef);
    const original = await query.query(markerSelect, [this.committed.request.effectRef]);
    requirePreparation(original.rows.length === 1);
    const marker = row(original.rows[0]);
    matchingMarker(marker, this.committed);
    requirePreparation(
      marker.submission_ref === this.committed.submissionRef &&
        marker.submitted_at === this.committed.submittedAt,
    );
    const existing = responseFromRow(marker, this.committed);
    if (existing.status === "retained") {
      requirePreparation(samePreparationValue(existing.response, response));
      this.assertCurrent();
      return existing;
    }
    await query.query(
      `INSERT INTO occ.runtime_preparation_submission_responses
      (effect_ref,namespace_name,deployment_name,deployment_uid,resource_version,received_at)
      VALUES($1,$2,$3,$4,$5,$6::timestamptz) ON CONFLICT(effect_ref) DO NOTHING`,
      [
        this.committed.request.effectRef,
        response.namespace,
        response.name,
        response.uid,
        response.resourceVersion,
        response.receivedAt,
      ],
    );
    const after = await query.query(markerSelect, [this.committed.request.effectRef]);
    requirePreparation(after.rows.length === 1);
    const retained = responseFromRow(row(after.rows[0]), this.committed);
    requirePreparation(
      retained.status === "retained" && samePreparationValue(retained.response, response),
    );
    this.assertCurrent();
    return retained;
  }
  closeAdmissions(): void {
    this.#accepting = false;
  }
  async drain(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }
  async prepareCommit(): Promise<void> {
    this.closeAdmissions();
    await this.drain();
    this.assertCurrent();
    if (!this.#acquired || this.#prepared)
      return this.reject(new ScopeViolationError("The response source is unavailable."));
    for (const lease of this.#leases.values()) {
      if (lease.prepare === undefined)
        return this.reject(new ScopeViolationError("Response preparation is incomplete."));
      await this.observe(lease.prepare());
      await this.drain();
      this.assertCurrent();
    }
    this.#queryOpen = false;
    this.#prepared = true;
  }
  assertCommitReady(): void {
    this.assertCurrent();
    if (!this.#prepared || this.#accepting || this.#queryOpen || this.#pending.size)
      this.reject(new ScopeViolationError("The response commit fence is incomplete."));
  }
  finishTerminal(): Promise<void> {
    if (this.#terminal) return this.#terminal;
    this.closeAdmissions();
    this.#queryOpen = false;
    this.#active = false;
    this.#terminal = Promise.resolve().then(async () => {
      let failed = false;
      let failure: unknown;
      await this.drain();
      for (const lease of [...this.#leases.values()].reverse()) {
        try {
          await lease.release();
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
        await this.drain();
      }
      if (this.#failed) throw this.#failure;
      if (failed) throw failure;
    });
    return this.#terminal;
  }
}
