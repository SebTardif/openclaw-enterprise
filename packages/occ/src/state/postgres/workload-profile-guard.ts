import { AsyncLocalStorage } from "node:async_hooks";
import type {
  WorkloadProfileDefinitionSourceV2,
  WorkloadProfileDefinitionUnitV2,
  WorkloadProfileOwnedLeaseV2,
  WorkloadProfileOwnedOperationV2,
} from "../../workload-profiles/admitted-use.ts";
import { decodeWorkloadProfileWithdrawV2 } from "@openclaw-enterprise/contracts/workload-profile-v1";
import { createHash } from "node:crypto";
import type {
  AuditEvent,
  Principal,
  AuthorizationDecision,
  AuthorizationRequest,
} from "@openclaw-enterprise/contracts";
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
  assertOwnerActive(): void;
  query: WorkloadProfileAccountUnit["query"];
  resolveNamespace(admissionRef: string): Promise<string | undefined>;
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
  const definitionIO = new AsyncLocalStorage<{ active: boolean; pending: Set<Promise<unknown>> }>();
  const definitions = new WeakMap<
    WorkloadProfileDefinitionUnitV2,
    WorkloadProfileOwnedOperationV2
  >();
  const retained = new WeakSet<object>();
  const cleanup: Array<() => Promise<void>> = [];
  let releasePromise: Promise<void> | undefined;
  interface PolicyResult {
    readonly actor: GuardedProfileActor;
    readonly attribution: ReturnType<typeof profileActor>;
    readonly principal: Principal;
    readonly request: AuthorizationRequest;
    readonly administer: AuthorizationDecision;
    readonly readDecision: AuthorizationDecision | undefined;
  }
  let authorized: PolicyResult | undefined;
  let failed = false;
  let failureValue: unknown;
  const poison = (error: unknown) => {
    if (!failed) {
      failed = true;
      failureValue = error;
    }
  };
  const observeMalformed = (value: unknown) => {
    // A nominally synchronous fence returning any value is invalid. Join an
    // illicit thenable before cleanup so caught asynchronous failures cannot escape.
    if (value !== undefined) {
      const error = new DependencyUnavailableError(
        "A profile currentness fence did not settle synchronously.",
      );
      poison(error);
      if (value !== null && (typeof value === "object" || typeof value === "function")) {
        const joined = Promise.resolve(value).then(
          () => {},
          (reason) => {
            poison(reason);
          },
        );
        malformed.add(joined);
        void joined.then(() => malformed.delete(joined));
      }
      throw error;
    }
  };
  const malformed = new Set<Promise<void>>();
  let accepting = true;
  let submitted = false;
  let sealed = false;
  const assertCurrent = () => {
    owner.assertOwnerActive();
    if (failed) throw failureValue;
    operations.assertCurrent();
    accountQueries.assertCurrent();
    owner.assertSelection();
    if (owner.signal.aborted) throw new DependencyUnavailableError("The profile unit expired.");
    for (const check of assertions) {
      try {
        observeMalformed(check());
      } catch (error) {
        poison(error);
        throw error;
      }
    }
  };
  const assertUsable = () => {
    owner.assertActive();
    assertCurrent();
  };
  const failure = <T>(): Promise<T> =>
    operations.run(async () => {
      throw new ScopeViolationError("The guarded profile phase is closed or already used.");
    });
  const policy = async (
    input: GuardedProfileActor,
    read: boolean,
    requests?: readonly Omit<AuthorizationRequest, "principalId">[],
  ): Promise<PolicyResult> => {
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
    await accountQueries.finish();
    assertUsable();
    await owner.lockPolicy();
    assertUsable();
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
    if (requests !== undefined) {
      if (requests.length === 0) throw new AuthorizationDeniedError();
      const checks: Array<{ request: AuthorizationRequest; decision: AuthorizationDecision }> = [];
      for (const target of requests) {
        const request = { ...target, principalId: principal.id };
        const decision = await owner.iam.authorize(request);
        assertUsable();
        if (!decision.allowed) throw new AuthorizationDeniedError();
        checks.push({ request, decision });
      }
      const first = checks[0]!;
      return {
        actor,
        attribution,
        principal,
        request: first.request,
        administer: first.decision,
        readDecision: undefined,
      };
    }
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
    authorized = { actor, attribution, principal, request, administer, readDecision };
    return authorized;
  };
  const submit = <T>(work: () => Promise<T>): Promise<T> => {
    if (!accepting || submitted) return failure();
    submitted = true;
    sealed = true;
    return operations.run(work);
  };
  const retain = (lease: WorkloadProfileOwnedLeaseV2): undefined => {
    const io = definitionIO.getStore();
    try {
      if (!io?.active || lease === null || typeof lease !== "object" || retained.has(lease))
        throw new ScopeViolationError("The exact profile definition enrollment is unavailable.");
      // Capture and own cleanup before any later getter or currentness call.
      const release = lease.release;
      if (typeof release !== "function")
        throw new DependencyUnavailableError("The definition cleanup is unavailable.");
      retained.add(lease);
      cleanup.push(() => Reflect.apply(release, lease, []));
      const check = lease.assertCurrent;
      if (typeof check !== "function")
        throw new DependencyUnavailableError("The definition fence is unavailable.");
      const retainedCheck = () => Reflect.apply(check, lease, []);
      assertions.push(retainedCheck);
      observeMalformed(retainedCheck());
      return undefined;
    } catch (error) {
      poison(error);
      throw error;
    }
  };
  const withOwnedIO = async <Value>(
    work: (io: WorkloadProfileOwnedOperationV2) => Promise<Value>,
  ): Promise<Value> => {
    const token = { active: true, pending: new Set<Promise<unknown>>() };
    const assertIO = () => {
      if (!token.active || definitionIO.getStore() !== token)
        throw new ScopeViolationError("The profile definition operation has expired.");
      assertUsable();
    };
    const io: WorkloadProfileOwnedOperationV2 = Object.freeze({
      assertActive: assertIO,
      poison,
      query: (statement: string, parameters?: readonly unknown[]) => {
        let result: Promise<{ rows: unknown[]; rowCount: number | null }>;
        try {
          assertIO();
          result = Promise.resolve(owner.query(statement, parameters)).then((value) => {
            assertIO();
            return value;
          });
        } catch (error) {
          result = Promise.reject(error);
        }
        const joined = result.then(
          () => {},
          (error) => {
            poison(error);
          },
        );
        token.pending.add(joined);
        void joined.then(() => token.pending.delete(joined));
        return result;
      },
    });
    return definitionIO.run(token, async () => {
      try {
        assertIO();
        const result = await work(io);
        while (token.pending.size) await Promise.allSettled([...token.pending]);
        assertIO();
        return result;
      } catch (error) {
        poison(error);
        throw error;
      } finally {
        while (token.pending.size) await Promise.allSettled([...token.pending]);
        token.active = false;
      }
    });
  };
  const qualify = async (
    source: WorkloadProfileDefinitionSourceV2 | undefined,
    request: Parameters<WorkloadProfileDefinitionSourceV2["verifyDefinitionLocked"]>[0],
    operationRef: string,
  ): Promise<undefined> =>
    withOwnedIO(async (io) => {
      if (!source || typeof source.verifyDefinitionLocked !== "function")
        throw new DependencyUnavailableError(
          "The original profile definition source is unavailable.",
        );
      const definition: WorkloadProfileDefinitionUnitV2 = Object.freeze({
        kind: "profile-definition",
        installationId: owner.installationId,
        namespaceId: request.scope.namespaceId,
        operationRef,
        account: unit.account,
        signal: owner.signal,
        retain,
      });
      definitions.set(definition, io);
      try {
        const lease = await source.verifyDefinitionLocked(request, definition, io);
        if (!retained.has(lease)) retain(lease);
        return undefined;
      } finally {
        definitions.delete(definition);
      }
    });
  const unit: GuardedWorkloadProfileUnit = Object.freeze<GuardedWorkloadProfileUnit>({
    account: Object.freeze({
      installationId: owner.installationId,
      signal: owner.signal,
      retainSecurityCleanup: (release: () => void): undefined => {
        try {
          if (!accepting || sealed || typeof release !== "function")
            throw new ScopeViolationError("The account security cleanup owner is unavailable.");
          cleanup.push(async () => {
            observeMalformed(release());
          });
          return undefined;
        } catch (error) {
          poison(error);
          throw error;
        }
      },
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
        observeMalformed(check());
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
    accept: (operationRef, actor, source) =>
      submit(async () => {
        profileUuid(operationRef);
        const current = await policy(actor, false);
        const result = await owner.profiles.accept(
          { installationId: owner.installationId, actor: current.attribution, operationRef },
          {
            actor: current.attribution,
            operationRef,
            requestRef: current.actor.requestId,
            decisionRef: current.actor.admissionDecisionId,
          },
          (request) => qualify(source, request, operationRef),
        );
        assertUsable();
        return result;
      }),
    withdraw: (admissionRef, input, actor) => {
      // Snapshot the closed command before the first queued policy wait.
      const decoded = decodeWorkloadProfileWithdrawV2(input);
      return submit(async () => {
        profileUuid(admissionRef);
        if (
          decoded.kind !== "valid" ||
          decoded.value.expectedAdmission.admissionRef !== admissionRef
        )
          throw new ScopeViolationError("The profile withdrawal command is invalid.");
        const current = await policy(actor, false);
        const namespaceId = await owner.resolveNamespace(admissionRef);
        assertUsable();
        if (namespaceId === undefined)
          throw new ScopeViolationError("The original profile admission is unavailable.");
        const result = await owner.profiles.withdraw(namespaceId, decoded.value.expectedAdmission, {
          actor: current.attribution,
          operationRef: decoded.value.operationRef,
          requestRef: current.actor.requestId,
          decisionRef: current.actor.admissionDecisionId,
        });
        assertUsable();
        return result;
      });
    },
    readProfile: (admissionRef, actor) =>
      submit(async () => {
        profileUuid(admissionRef);
        await policy(actor, true);
        const namespaceId = await owner.resolveNamespace(admissionRef);
        assertUsable();
        if (namespaceId === undefined) return undefined;
        const result = await owner.profiles.readProfile(namespaceId, admissionRef);
        assertUsable();
        return result;
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
    bindDefinitionSource(
      definition: WorkloadProfileDefinitionUnitV2,
      io: WorkloadProfileOwnedOperationV2,
    ) {
      if (definitions.get(definition) !== io || !definitionIO.getStore()?.active)
        throw new ScopeViolationError("The original profile definition unit is unavailable.");
      io.assertActive();
      // Do not call assertCurrent here: it traverses the leases retained by this
      // very owner and would recursively call the returned source fence.
      return Object.freeze({
        assertCurrent(): undefined {
          owner.assertOwnerActive();
          owner.assertSelection();
          if (owner.signal.aborted)
            throw new DependencyUnavailableError("The profile definition owner expired.");
          if (failed) throw failureValue;
          return undefined;
        },
      });
    },
    bindAccountOwner(terminalCleanup: () => void) {
      unit.account.retainSecurityCleanup(terminalCleanup);
      return Object.freeze({
        assertAcquiring() {
          if (!accepting || sealed)
            throw new ScopeViolationError("The account acquisition is closed.");
          owner.assertActive();
          owner.assertOwnerActive();
          owner.assertSelection();
          if (failed) throw failureValue;
        },
        assertCurrent() {
          owner.assertOwnerActive();
          owner.assertSelection();
          if (owner.signal.aborted)
            throw new DependencyUnavailableError("The account owner expired.");
          if (failed) throw failureValue;
        },
        retainAccepted(work: Promise<void>) {
          const joined = Promise.resolve(work).then(
            () => {},
            (error) => {
              poison(error);
            },
          );
          malformed.add(joined);
          void joined.then(() => malformed.delete(joined));
        },
      });
    },
    runMutation<Value>(
      actor: GuardedProfileActor,
      requests: readonly Omit<AuthorizationRequest, "principalId">[],
      work: (
        io: WorkloadProfileOwnedOperationV2,
        retain: (lease: WorkloadProfileOwnedLeaseV2) => undefined,
      ) => Promise<Value>,
    ) {
      const captured = immutableCopy(actor);
      const targets = immutableCopy(requests);
      return submit(async () => {
        await policy(captured, false, targets);
        return withOwnedIO((io) => work(io, retain));
      });
    },
    poison,
    assertCurrent,
    assertOperationActive() {
      const operation = definitionIO.getStore();
      if (!operation?.active) {
        const error = new ScopeViolationError("The original profile operation is unavailable.");
        poison(error);
        throw error;
      }
      assertUsable();
    },
    assertSettled() {
      operations.assertCurrent();
      accountQueries.assertCurrent();
      if (failed) throw failureValue;
    },
    decorateAudit(event: AuditEvent): AuditEvent {
      assertUsable();
      const current = authorized;
      if (
        !current ||
        event.actorId !== current.principal.id ||
        event.requestId !== current.actor.requestId ||
        event.admissionDecisionId !== current.actor.admissionDecisionId ||
        event.details?.accountRef !== current.attribution.accountRef
      )
        throw new ScopeViolationError(
          "The admission audit is outside the original authorized operation.",
        );
      return immutableCopy({
        ...event,
        actor: {
          principalId: current.principal.id,
          kind: "principal",
          issuer: current.principal.issuer,
          subject: current.principal.subject,
        },
        iamDriverId: current.administer.driverId,
        authorization: current.request,
        details: {
          ...event.details,
          checks: [{ request: current.request, decision: current.administer }],
        },
      });
    },
    release() {
      if (releasePromise !== undefined) return releasePromise;
      releasePromise = Promise.resolve().then(async () => {
        let rejected = false;
        let first: unknown;
        for (const release of [...cleanup].reverse()) {
          try {
            await release();
          } catch (error) {
            if (!rejected) {
              rejected = true;
              first = error;
            }
          }
          // Malformed synchronous cleanup can still start asynchronous work.
          // Join that accepted work before releasing the next terminal lease.
          while (malformed.size) await Promise.allSettled([...malformed]);
        }
        if (rejected) throw first;
        if (failed) throw failureValue;
      });
      return releasePromise;
    },
    async finish() {
      accepting = false;
      sealed = true;
      const drained = await Promise.allSettled([operations.finish(), accountQueries.finish()]);
      for (const result of drained) if (result.status === "rejected") throw result.reason;
      while (malformed.size) await Promise.allSettled([...malformed]);
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
