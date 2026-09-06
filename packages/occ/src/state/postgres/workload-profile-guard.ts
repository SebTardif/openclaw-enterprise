import { createHash } from "node:crypto";
import type { AuditEvent, Principal, AuthorizationDecision } from "@openclaw-enterprise/contracts";
import type { NativeIAMTransactionView } from "@openclaw-enterprise/iam";
import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  AuthorizationDeniedError,
  DependencyUnavailableError,
  ScopeViolationError,
} from "../../errors.ts";
import { WorkloadProfileTransactionGuard } from "../../workload-profiles/repository.ts";
import {
  profileActor,
  profileUuid,
  type StoredProfilePreparation,
} from "../../workload-profiles/types.ts";
import type { WorkloadProfileRepository } from "../../ports/repositories/workload-profile.ts";
import type { WorkloadProfileAccountUnit } from "../../services/workload-profile/port.ts";

import type {
  GuardedProfileActor,
  GuardedWorkloadProfileUnit,
} from "../../services/workload-profile/port.ts";

interface GuardOwner {
  readonly installationId: string;
  readonly signal: AbortSignal;
  assertActive(): void;
  assertSelection(): void;
  accountQuery: WorkloadProfileAccountUnit["query"];
  lockPolicy(): Promise<void>;
  readonly iam: NativeIAMTransactionView;
  readonly profiles: WorkloadProfileRepository;
  findAudit(id: string): Promise<Readonly<AuditEvent> | undefined>;
  appendAudit(event: AuditEvent): Promise<void>;
}

function auditId(record: StoredProfilePreparation): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "workload-profile-preparation-audit/v1",
        record.scope.installationId,
        record.actor.principalRef,
        record.operationRef,
      ]),
    )
    .digest();
  digest[6] = (digest[6]! & 15) | 64;
  digest[8] = (digest[8]! & 63) | 128;
  const h = digest.subarray(0, 16).toString("hex");
  return `aud_${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The actual owner provides one connection and drains this object before commit.
 * No account authority is created here. The future authentic participant uses
 * account queries before the policy seal; public storage tests exercise only the
 * internal policy/storage unit, not human authentication or active admission. */
export function createGuardedWorkloadProfileUnit(owner: GuardOwner) {
  const operations = new WorkloadProfileTransactionGuard();
  const accountQueries = new WorkloadProfileTransactionGuard();
  const assertions: Array<() => void> = [];
  let accepting = true;
  let submitted = false;
  let sealed = false;
  const assertCurrent = () => {
    owner.assertSelection();
    if (owner.signal.aborted) throw new DependencyUnavailableError("The profile unit expired.");
    for (const check of assertions) check();
  };
  const assertUsable = () => {
    owner.assertActive();
    assertCurrent();
  };
  const failure = <T>(): Promise<T> =>
    operations.run(async () => {
      throw new ScopeViolationError("The guarded profile phase is closed or already used.");
    });
  const policy = async (input: GuardedProfileActor, read: boolean) => {
    await accountQueries.finish();
    assertUsable();
    await owner.lockPolicy();
    assertUsable();
    const actor = immutableCopy({
      principal: input.principal,
      accountRef: input.accountRef,
      requestId: input.requestId,
      admissionDecisionId: input.admissionDecisionId,
    });
    const attribution = profileActor({
      accountRef: actor.accountRef,
      principalRef: actor.principal.id,
    });
    if (
      actor.principal.kind !== "principal" ||
      actor.principal.namespaceId !== undefined ||
      typeof actor.requestId !== "string" ||
      actor.requestId.length === 0 ||
      actor.requestId.length > 1024 ||
      typeof actor.admissionDecisionId !== "string" ||
      actor.admissionDecisionId.length === 0 ||
      actor.admissionDecisionId.length > 1024
    )
      throw new AuthorizationDeniedError();
    const principal = await owner.iam.lookupIdentity({
      issuer: actor.principal.issuer,
      subject: actor.principal.subject,
    });
    assertUsable();
    if (
      principal?.kind !== "principal" ||
      principal.namespaceId !== undefined ||
      principal.id !== actor.principal.id
    )
      throw new AuthorizationDeniedError();
    const request = {
      principalId: principal.id,
      action: "administer" as const,
      resource: { kind: "installation" as const, id: owner.installationId },
    };
    const administer = await owner.iam.authorize(request);
    assertUsable();
    const registration = administer.evidence.channelAdministration;
    if (
      !administer.allowed ||
      registration?.installationId !== owner.installationId ||
      registration.schemaVersion !== 1 ||
      registration.mappings.length === 0
    )
      throw new AuthorizationDeniedError();
    let readDecision: AuthorizationDecision | undefined;
    if (read) {
      readDecision = await owner.iam.authorize({ ...request, action: "read" });
      assertUsable();
      if (!readDecision.allowed) throw new AuthorizationDeniedError();
    }
    return { actor, attribution, principal, request, administer, readDecision };
  };
  const submit = <T>(work: () => Promise<T>): Promise<T> => {
    if (!accepting || submitted) return failure();
    submitted = true;
    sealed = true;
    return operations.run(work);
  };
  const unit: GuardedWorkloadProfileUnit = Object.freeze({
    account: Object.freeze({
      installationId: owner.installationId,
      signal: owner.signal,
      query: (statement: string, parameters?: readonly unknown[]) => {
        if (!accepting || sealed) return failure<{ rows: unknown[]; rowCount: number | null }>();
        return accountQueries.run(async () => {
          assertUsable();
          const result = await owner.accountQuery(statement, parameters);
          assertUsable();
          return result;
        });
      },
    }),
    retainCurrentness: (check: () => void) => {
      try {
        if (!accepting || sealed || typeof check !== "function")
          throw new ScopeViolationError("The profile currentness participant is closed.");
        check();
      } catch (error) {
        void operations
          .run(async () => {
            throw error;
          })
          .catch(() => {});
        throw error;
      }
      assertions.push(check);
    },
    prepare: (input: unknown, actor: GuardedProfileActor) =>
      submit(async () => {
        const current = await policy(actor, false);
        const record = await owner.profiles.prepareOperation(input, current.attribution);
        assertUsable();
        // Preparation has a separate audit identity; all reserved future admission
        // and terminal identities in the immutable bundle remain untouched.
        const id = auditId(record);
        const prior = await owner.findAudit(id);
        assertUsable();
        if (prior !== undefined) {
          if (
            prior.actorId !== current.principal.id ||
            prior.actor?.issuer !== current.principal.issuer ||
            prior.actor?.subject !== current.principal.subject ||
            prior.installationId !== owner.installationId ||
            prior.action !== "openclaw.workload-profile.prepare" ||
            prior.kind !== "mutation" ||
            prior.outcome !== "success" ||
            prior.resource.kind !== "installation" ||
            prior.resource.id !== owner.installationId ||
            prior.namespaceId !== undefined ||
            prior.details?.operationRef !== record.operationRef ||
            prior.details?.operationDigest !== record.operationDigest ||
            prior.details?.accountRef !== record.actor.accountRef
          )
            throw new DependencyUnavailableError("The retained profile audit does not correspond.");
        } else {
          await owner.appendAudit({
            id,
            installationId: owner.installationId,
            occurredAt: new Date().toISOString(),
            kind: "mutation",
            actorId: current.principal.id,
            schemaVersion: 1,
            source: "occ",
            requestId: current.actor.requestId,
            admissionDecisionId: current.actor.admissionDecisionId,
            actor: {
              principalId: current.principal.id,
              kind: "principal",
              issuer: current.principal.issuer,
              subject: current.principal.subject,
            },
            action: "openclaw.workload-profile.prepare",
            resource: current.request.resource,
            iamDriverId: current.administer.driverId,
            authorization: current.request,
            outcome: "success",
            details: {
              operationRef: record.operationRef,
              operationDigest: record.operationDigest,
              accountRef: record.actor.accountRef,
              checks: [{ request: current.request, decision: current.administer }],
            },
          });
          assertUsable();
        }
        return record;
      }),
    readOperation: (operationRef: string, actor: GuardedProfileActor) =>
      submit(async () => {
        profileUuid(operationRef);
        const current = await policy(actor, true);
        const record = await owner.profiles.findOperation({
          installationId: owner.installationId,
          actor: current.attribution,
          operationRef,
        });
        assertUsable();
        return record;
      }),
  });
  return Object.freeze({
    unit,
    assertCurrent,
    async finish() {
      accepting = false;
      sealed = true;
      const drained = await Promise.allSettled([operations.finish(), accountQueries.finish()]);
      for (const result of drained) if (result.status === "rejected") throw result.reason;
      if (!submitted)
        throw new ScopeViolationError("The guarded profile unit performed no operation.");
      assertUsable();
    },
    close() {
      accepting = false;
      sealed = true;
    },
  });
}
