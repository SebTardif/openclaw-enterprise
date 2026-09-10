import type { QueryRepositoryFactoryContext } from "../../ports/repository-factory.ts";
import type { RepositoryWorkPolicyV2 } from "../../lifecycle/repository-work-policy-v2.ts";
import { canonicalRepositoryWorkV2 } from "./repository-work-v2.ts";
import { ScopeViolationError } from "../../errors.ts";

/** Persistence envelope around the ORIGINAL Work-owned policy document. This
 * private repository does not decode policy semantics or authenticate a writer.
 * Its owner has authenticated the operator, retained account + IAM barriers and
 * locked Installation/Namespace/Agent before constructing it. */
export interface RepositoryWorkPolicyStoredV2 {
  readonly installationId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly policyRef: string;
  readonly version: number;
  readonly status: "enabled" | "disabled";
  readonly servicePrincipalId: string;
  readonly repositoryId: string;
  readonly document: RepositoryWorkPolicyV2;
}
export interface RepositoryWorkPolicyChangeStoredV2 {
  readonly operationRef: string;
  readonly requestDigest: string;
  readonly commitRef: string;
  readonly actorId: string;
  readonly expectedVersion: number | null;
  readonly policy: RepositoryWorkPolicyStoredV2;
}
function fail(): never {
  throw new ScopeViolationError("The original repository policy record is unavailable.");
}
function reference(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}(?![\s\S])/.test(value))
    fail();
  return value;
}
function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail();
  return value;
}
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function decode(value: unknown): RepositoryWorkPolicyStoredV2 {
  const data = plain(JSON.parse(canonicalRepositoryWorkV2(value)));
  if (
    Object.keys(data).sort().join(",") !==
    "agentId,document,installationId,namespaceId,policyRef,repositoryId,servicePrincipalId,status,version"
  )
    fail();
  if (data.status !== "enabled" && data.status !== "disabled") fail();
  if (
    typeof data.repositoryId !== "string" ||
    !/^[1-9][0-9]{0,19}(?![\s\S])/.test(data.repositoryId)
  )
    fail();
  const document = parseRepositoryWorkPolicyV2(data.document);
  if (
    !document ||
    document.scope.installationId !== data.installationId ||
    document.scope.namespaceId !== data.namespaceId ||
    document.scope.agentId !== data.agentId ||
    document.policyRef !== data.policyRef ||
    document.version !== data.version ||
    document.status !== data.status ||
    document.servicePrincipalId !== data.servicePrincipalId ||
    document.repository.target.repositoryId !== data.repositoryId
  )
    fail();
  return Object.freeze({
    installationId: reference(data.installationId),
    namespaceId: reference(data.namespaceId),
    agentId: reference(data.agentId),
    policyRef: reference(data.policyRef),
    version: version(data.version),
    status: data.status,
    servicePrincipalId: reference(data.servicePrincipalId),
    repositoryId: data.repositoryId,
    document,
  });
}
const equal = (a: unknown, b: unknown): boolean =>
  canonicalRepositoryWorkV2(a) === canonicalRepositoryWorkV2(b);

/** No pool, auth callback, implicit grant, retry or COMMIT. Exact current-head
 * reads conflict with this repository's immutable-version + head-CAS writer.
 * The caller cannot substitute a policy version for current Work authority. */
export function createPostgresRepositoryWorkPolicyV2(
  context: QueryRepositoryFactoryContext,
  originalScope: Readonly<{ installationId: string; namespaceId: string; agentId: string }>,
  originalCommitRef: string,
) {
  const scope = Object.freeze({
    installationId: reference(originalScope.installationId),
    namespaceId: reference(originalScope.namespaceId),
    agentId: reference(originalScope.agentId),
  });
  const commitRef = reference(originalCommitRef);
  const keys = [scope.installationId, scope.namespaceId, scope.agentId];
  const where = "installation_id=$1 AND namespace_id=$2 AND agent_id=$3";
  const active = () => {
    context.transaction.assertActive();
    if (
      context.scope.installationId !== scope.installationId ||
      context.scope.namespaceId !== scope.namespaceId
    )
      fail();
  };
  const query = async (statement: string, values: readonly unknown[]) => {
    active();
    const result = await context.query.query(statement, values);
    active();
    if (!Number.isSafeInteger(result.rowCount) || result.rowCount !== result.rows.length) fail();
    return result;
  };
  const row = (value: unknown): RepositoryWorkPolicyStoredV2 => {
    const found = plain(value);
    if (
      Object.keys(found).join(",") !== "canonical_document" ||
      typeof found.canonical_document !== "string"
    )
      fail();
    const data = JSON.parse(found.canonical_document);
    if (canonicalRepositoryWorkV2(data) !== found.canonical_document) fail();
    const result = decode(data);
    if (
      result.installationId !== scope.installationId ||
      result.namespaceId !== scope.namespaceId ||
      result.agentId !== scope.agentId
    )
      fail();
    return result;
  };
  const find = async (policyRef: string): Promise<RepositoryWorkPolicyStoredV2 | undefined> => {
    const result = await query(
      `SELECT v.canonical_document FROM occ.repository_work_policy_heads_v2 h JOIN occ.repository_work_policy_versions_v2 v USING (installation_id,namespace_id,agent_id,policy_ref,version) WHERE h.installation_id=$1 AND h.namespace_id=$2 AND h.agent_id=$3 AND h.policy_ref=$4 FOR SHARE OF h`,
      [...keys, reference(policyRef)],
    );
    if (result.rows.length > 1) fail();
    if (!result.rows.length) return undefined;
    const found = row(result.rows[0]);
    if (found.policyRef !== policyRef) fail();
    return found;
  };
  const readOperation = async (
    operationRef: string,
  ): Promise<RepositoryWorkPolicyChangeStoredV2 | undefined> => {
    const result = await query(
      `SELECT canonical_document FROM occ.repository_work_policy_operations_v2 WHERE ${where} AND operation_ref=$4`,
      [...keys, reference(operationRef)],
    );
    if (result.rows.length > 1) fail();
    if (!result.rows.length) return undefined;
    const found = plain(result.rows[0]);
    if (typeof found.canonical_document !== "string") fail();
    const value = plain(JSON.parse(found.canonical_document));
    if (
      canonicalRepositoryWorkV2(value) !== found.canonical_document ||
      value.operationRef !== operationRef ||
      typeof value.requestDigest !== "string" ||
      !/^sha256:[a-f0-9]{64}(?![\s\S])/.test(value.requestDigest)
    )
      fail();
    const policy = decode(value.policy);
    if (
      policy.installationId !== scope.installationId ||
      policy.namespaceId !== scope.namespaceId ||
      policy.agentId !== scope.agentId
    )
      fail();
    return Object.freeze({
      operationRef,
      requestDigest: value.requestDigest,
      commitRef: reference(value.commitRef),
      actorId: reference(value.actorId),
      expectedVersion: value.expectedVersion === null ? null : version(value.expectedVersion),
      policy,
    });
  };
  return Object.freeze({
    find,
    readOperation,
    async change(
      input: RepositoryWorkPolicyChangeStoredV2,
    ): Promise<"staged" | "existing" | "conflict"> {
      const copied = plain(JSON.parse(canonicalRepositoryWorkV2(input)));
      const policy = decode(copied.policy);
      const operationRef = reference(copied.operationRef),
        actorId = reference(copied.actorId);
      if (
        copied.commitRef !== commitRef ||
        typeof copied.requestDigest !== "string" ||
        !/^sha256:[a-f0-9]{64}(?![\s\S])/.test(copied.requestDigest)
      )
        fail();
      const expected = copied.expectedVersion === null ? null : version(copied.expectedVersion);
      if (
        policy.version !== (expected === null ? 1 : expected + 1) ||
        policy.installationId !== scope.installationId ||
        policy.namespaceId !== scope.namespaceId ||
        policy.agentId !== scope.agentId
      )
        fail();
      const value: RepositoryWorkPolicyChangeStoredV2 = {
        operationRef,
        requestDigest: copied.requestDigest,
        commitRef,
        actorId,
        expectedVersion: expected,
        policy,
      };
      const previousOperation = await readOperation(operationRef);
      if (previousOperation) {
        const { commitRef: _old, ...previous } = previousOperation;
        const { commitRef: _current, ...requested } = value;
        return equal(previous, requested) ? "existing" : "conflict";
      }
      const head = await find(policy.policyRef);
      if (expected === null ? head !== undefined : head === undefined || head.version !== expected)
        return "conflict";
      if (
        head &&
        (head.servicePrincipalId !== policy.servicePrincipalId ||
          head.repositoryId !== policy.repositoryId)
      )
        return "conflict";
      const inserted = await query(
        "INSERT INTO occ.repository_work_policy_versions_v2 (installation_id,namespace_id,agent_id,policy_ref,version,status,service_principal_id,repository_id,canonical_document) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING canonical_document",
        [
          ...keys,
          policy.policyRef,
          policy.version,
          policy.status,
          policy.servicePrincipalId,
          policy.repositoryId,
          canonicalRepositoryWorkV2(policy),
        ],
      );
      if (inserted.rows.length !== 1 || !equal(row(inserted.rows[0]), policy)) fail();
      const changed =
        expected === null
          ? await query(
              "INSERT INTO occ.repository_work_policy_heads_v2 (installation_id,namespace_id,agent_id,policy_ref,version,service_principal_id,repository_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING policy_ref",
              [
                ...keys,
                policy.policyRef,
                policy.version,
                policy.servicePrincipalId,
                policy.repositoryId,
              ],
            )
          : await query(
              `UPDATE occ.repository_work_policy_heads_v2 SET version=$5 WHERE ${where} AND policy_ref=$4 AND version=$6 RETURNING policy_ref`,
              [...keys, policy.policyRef, policy.version, expected],
            );
      if (changed.rows.length !== 1 || plain(changed.rows[0]).policy_ref !== policy.policyRef)
        fail();
      const retained = await query(
        "INSERT INTO occ.repository_work_policy_operations_v2 (installation_id,namespace_id,agent_id,operation_ref,request_digest,commit_ref,policy_ref,policy_version,canonical_document) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING canonical_document",
        [
          ...keys,
          operationRef,
          value.requestDigest,
          commitRef,
          policy.policyRef,
          policy.version,
          canonicalRepositoryWorkV2(value),
        ],
      );
      if (
        retained.rows.length !== 1 ||
        plain(retained.rows[0]).canonical_document !== canonicalRepositoryWorkV2(value)
      )
        fail();
      return "staged";
    },
  });
}

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { parseRepositoryWorkPolicyV2 } from "../../lifecycle/repository-work-policy-v2.ts";
import type { NativeIAMTransactionView } from "@openclaw-enterprise/iam";
import type { AuditEvent } from "@openclaw-enterprise/contracts/identity/audit";
import type { RepositoryWorkExecutionV2 } from "./repository-work-v2.ts";
import type {
  RepositoryWorkPolicyAccountUnitV2,
  RepositoryWorkPolicyAccountLeaseV2,
  RepositoryWorkPolicyBindingV2,
  RepositoryWorkPolicyStoreV2,
  RepositoryWorkPolicyResultV2,
  RepositoryWorkPolicyOperatorRequestV2,
} from "../../ports/repository-work-v2.ts";

/** Original constructor-only unit control. It is never a public enrollment API. */
export interface RepositoryWorkPolicySessionControlV2 {
  assertAcquiring(): void;
  assertCurrent(): undefined;
  retainCurrentness(check: () => undefined): void;
  retainCleanup(release: () => void): void;
  retainAccepted(work: Promise<void>): void;
  poison(error: unknown): void;
}
interface PolicyBackend {
  readonly context: QueryRepositoryFactoryContext;
  /** This is the original State-created view of its SAME private IAM token. */
  readonly iam: NativeIAMTransactionView;
  registerAccountUnit(
    unit: RepositoryWorkPolicyAccountUnitV2,
    control: RepositoryWorkPolicySessionControlV2,
  ): () => void;
  lockIAM(): Promise<void>;
  appendAudit(event: AuditEvent): Promise<void>;
}
export type RepositoryWorkPolicyEnterV2 = <T>(
  scope: Readonly<{ installationId: string; namespaceId: string; agentId: string }>,
  bounds: Readonly<{ signal: AbortSignal; timeoutMs: number }>,
  execution: RepositoryWorkExecutionV2,
  bind: (backend: PolicyBackend) => Promise<T>,
) => Promise<T>;
interface PolicyEnrollment {
  readonly unit: RepositoryWorkPolicyAccountUnitV2;
  readonly phase: RepositoryWorkExecutionV2["phase"];
  readonly backend: PolicyBackend;
  readonly releases: (() => void)[];
  readonly accepted: Set<Promise<void>>;
  readonly currentness: (() => undefined)[];
  active: boolean;
  acquiring: boolean;
  checking: boolean;
  ownerBound: boolean;
  assertAccount?: () => void;
}

/** Fixed operator operation. Account verification remains the SAME separately
 * composed request/session owner. The original State callback supplies real IAM
 * membership, SQL and the final synchronous COMMIT fence, not an allow callback. */
export function createPostgresRepositoryWorkPolicyBindingV2(
  enter: RepositoryWorkPolicyEnterV2,
  createPhase: () => RepositoryWorkExecutionV2["phase"],
): RepositoryWorkPolicyBindingV2 {
  const units = new WeakMap<object, PolicyEnrollment>();
  const ambient = new AsyncLocalStorage<PolicyEnrollment>();
  let bound = false;
  const poison = (entry: PolicyEnrollment, error: unknown): never => {
    entry.phase.poison(error);
    throw error;
  };
  const check = (entry: PolicyEnrollment, acquiring = false) => {
    if (
      !entry.active ||
      (acquiring && (entry.checking || !entry.acquiring || ambient.getStore() !== entry))
    )
      return poison(
        entry,
        new ScopeViolationError("The original policy account unit is unavailable."),
      );
    entry.phase.assertActive();
  };
  const observe = (entry: PolicyEnrollment, result: unknown) => {
    const pending = Promise.resolve(result).then(
      () => {},
      (error) => entry.phase.poison(error),
    );
    entry.accepted.add(pending);
    void pending.then(() => entry.accepted.delete(pending));
  };
  const fence = (entry: PolicyEnrollment) => {
    check(entry);
    if (entry.checking) fail();
    entry.checking = true;
    try {
      entry.backend.iam.assertCurrent();
      for (const assertion of entry.currentness) {
        const result: unknown = assertion();
        if (result !== undefined) {
          observe(entry, result);
          fail();
        }
      }
      const assertion = entry.assertAccount;
      if (!assertion) fail();
      const result: unknown = assertion();
      if (result !== undefined) {
        observe(entry, result);
        fail();
      }
      entry.phase.assertActive();
    } catch (error) {
      entry.phase.poison(error);
      throw error;
    } finally {
      entry.checking = false;
    }
  };
  return Object.freeze<RepositoryWorkPolicyBindingV2>({
    accountOwner: Object.freeze({
      bind(unit: RepositoryWorkPolicyAccountUnitV2, terminalCleanup: () => void) {
        const entry = units.get(unit);
        if (!entry) {
          const current = ambient.getStore();
          if (current)
            poison(current, new ScopeViolationError("A copied policy account unit cannot enroll."));
          fail();
        }
        if (entry.ownerBound || typeof terminalCleanup !== "function")
          poison(entry, new ScopeViolationError("The policy account owner is already bound."));
        check(entry, true);
        entry.ownerBound = true;
        entry.releases.push(terminalCleanup);
        return Object.freeze({
          assertAcquiring() {
            check(entry, true);
          },
          assertCurrent() {
            check(entry);
          },
          retainAccepted(work: Promise<void>) {
            // Transfer work from this already enrolled owner even after authority
            // has closed. Terminal cleanup always joins its accepted acquisitions.
            if (!entry.active) fail();
            observe(entry, work);
          },
        });
      },
    }),
    bindOriginalAccount(account) {
      if (bound) fail();
      const consume = account?.consume;
      if (typeof consume !== "function") fail();
      bound = true;
      return Object.freeze<RepositoryWorkPolicyStoreV2>({
        async mutate(invocation, input, bounds) {
          if (ambient.getStore()) {
            ambient
              .getStore()
              ?.phase.poison(new ScopeViolationError("Policy transactions cannot nest."));
            return { kind: "unavailable" };
          }
          let canonical: string;
          let policy: ReturnType<typeof parseRepositoryWorkPolicyV2>;
          try {
            canonical = canonicalRepositoryWorkV2(input);
            policy = parseRepositoryWorkPolicyV2(input.policy);
          } catch {
            return { kind: "unavailable" };
          }
          if (
            !policy ||
            !reference(input.operationRef) ||
            !(
              input.expectedVersion === null ||
              (Number.isSafeInteger(input.expectedVersion) && input.expectedVersion > 0)
            ) ||
            policy.version !== (input.expectedVersion === null ? 1 : input.expectedVersion + 1) ||
            bounds.signal.aborted ||
            !Number.isSafeInteger(bounds.timeoutMs) ||
            bounds.timeoutMs <= 0 ||
            bounds.timeoutMs > 3000
          )
            return { kind: "unavailable" };
          const command = Object.freeze({
            operationRef: input.operationRef,
            expectedVersion: input.expectedVersion,
            policy,
          });
          if (canonicalRepositoryWorkV2(command) !== canonical) return { kind: "unavailable" };
          const request: RepositoryWorkPolicyOperatorRequestV2 = Object.freeze({
            purpose: "repository-work-policy-operator",
            binding: Object.freeze({
              method: "mutate",
              operationRef: command.operationRef,
              canonicalInput: canonical,
            }),
          });
          const commitRef = randomUUID(),
            phase = createPhase();
          let entry: PolicyEnrollment | undefined,
            acknowledged = false,
            failed = false;
          let result: RepositoryWorkPolicyResultV2 = { kind: "unavailable" };
          const execution: RepositoryWorkExecutionV2 = {
            phase,
            commitRef,
            disposition: "not-sent",
            establishedNoCommit: false,
            async prepareCommit() {
              const current = entry;
              if (!current) fail();
              while (current.accepted.size) await Promise.all([...current.accepted]);
              fence(current);
            },
            assertCommitReady() {
              if (!entry || entry.accepted.size) fail();
              fence(entry);
            },
            observeAcknowledgment() {
              acknowledged = true;
            },
            close() {
              if (entry) entry.acquiring = false;
            },
          };
          try {
            await enter(policy.scope, bounds, execution, async (backend) => {
              const unit = Object.freeze<RepositoryWorkPolicyAccountUnitV2>({
                installationId: policy.scope.installationId,
                signal: bounds.signal,
                retainSecurityCleanup(release) {
                  if (!entry || typeof release !== "function") fail();
                  check(entry, true);
                  entry.releases.push(release);
                  return undefined;
                },
                async query(statement, parameters) {
                  if (!entry) fail();
                  check(entry, true);
                  phase.assertOperationActive();
                  const value = await backend.context.query.query(statement, parameters);
                  check(entry, true);
                  return { rows: [...value.rows], rowCount: value.rowCount };
                },
              });
              const current: PolicyEnrollment = {
                unit,
                phase,
                backend,
                releases: [],
                accepted: new Set(),
                currentness: [],
                active: true,
                acquiring: true,
                checking: false,
                ownerBound: false,
              };
              entry = current;
              units.set(unit, current);
              current.releases.push(
                backend.registerAccountUnit(
                  unit,
                  Object.freeze<RepositoryWorkPolicySessionControlV2>({
                    assertAcquiring() {
                      check(current, true);
                      if (!current.ownerBound) fail();
                    },
                    assertCurrent() {
                      check(current);
                      if (!current.ownerBound) fail();
                      return undefined;
                    },
                    retainCurrentness(assertion) {
                      check(current, true);
                      if (typeof assertion !== "function") fail();
                      current.currentness.push(assertion);
                    },
                    retainCleanup(release) {
                      check(current, true);
                      if (typeof release !== "function") fail();
                      current.releases.push(release);
                    },
                    retainAccepted(work) {
                      if (!current.active) fail();
                      observe(current, work);
                    },
                    poison(error) {
                      current.phase.poison(error);
                    },
                  }),
                ),
              );
              const repository = createPostgresRepositoryWorkPolicyV2(
                backend.context,
                policy.scope,
                commitRef,
              );
              return ambient.run(current, () =>
                phase.runTransition(async () => {
                  let attribution:
                    | Readonly<{
                        actorId: string;
                        accountRef: string;
                        requestId: string;
                        admissionDecisionId: string;
                      }>
                    | undefined;
                  await phase.runAcceptance(async () => {
                    const lease: RepositoryWorkPolicyAccountLeaseV2 = await Reflect.apply(
                      consume,
                      account,
                      [invocation, request, unit],
                    );
                    const release = lease?.release;
                    if (typeof release !== "function") fail();
                    current.releases.push(() => Reflect.apply(release, lease, []));
                    const assertion = lease.assertCurrent;
                    if (!current.ownerBound || typeof assertion !== "function") fail();
                    current.assertAccount = () => Reflect.apply(assertion, lease, []);
                    const principal = lease.principal;
                    const kind = principal.kind,
                      actorId = reference(principal.id);
                    if (kind !== "principal") fail();
                    attribution = Object.freeze({
                      actorId,
                      accountRef: reference(lease.accountRef),
                      requestId: reference(lease.requestId),
                      admissionDecisionId: reference(lease.admissionDecisionId),
                    });
                    fence(current);
                    current.acquiring = false;
                    await backend.lockIAM();
                    fence(current);
                    return true;
                  });
                  await phase.runOperation(async () => {
                    if (!attribution) fail();
                    const { actorId, accountRef, requestId, admissionDecisionId } = attribution;
                    const authorization = {
                      principalId: actorId,
                      action: "administer" as const,
                      resource: {
                        kind: "agent" as const,
                        id: policy.scope.agentId,
                        namespaceId: policy.scope.namespaceId,
                      },
                    };
                    const decision = await backend.iam.authorize(authorization);
                    fence(current);
                    if (!decision.allowed) {
                      result = { kind: "denied" };
                      return;
                    }
                    const service = await backend.iam.lookupIdentity({
                      servicePrincipalId: policy.servicePrincipalId,
                      namespaceId: policy.scope.namespaceId,
                    });
                    fence(current);
                    if (
                      service?.kind !== "service_principal" ||
                      service.namespaceId !== policy.scope.namespaceId ||
                      service.agentId !== policy.scope.agentId
                    )
                      fail();
                    for (const [statement, parameters, expected] of [
                      [
                        "SELECT id FROM occ.installation WHERE id=$1 FOR NO KEY UPDATE",
                        [policy.scope.installationId],
                        policy.scope.installationId,
                      ],
                      [
                        "SELECT id FROM occ.namespaces WHERE id=$1 FOR NO KEY UPDATE",
                        [policy.scope.namespaceId],
                        policy.scope.namespaceId,
                      ],
                      [
                        "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR NO KEY UPDATE",
                        [policy.scope.namespaceId, policy.scope.agentId],
                        policy.scope.agentId,
                      ],
                    ] as const) {
                      const found = await backend.context.query.query(statement, parameters);
                      if (
                        found.rowCount !== 1 ||
                        found.rows.length !== 1 ||
                        plain(found.rows[0]).id !== expected
                      )
                        fail();
                      fence(current);
                    }
                    const stored: RepositoryWorkPolicyStoredV2 = {
                      ...policy.scope,
                      policyRef: policy.policyRef,
                      version: policy.version,
                      status: policy.status,
                      servicePrincipalId: policy.servicePrincipalId,
                      repositoryId: policy.repository.target.repositoryId,
                      document: policy,
                    };
                    const outcome = await repository.change({
                      operationRef: command.operationRef,
                      requestDigest: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
                      commitRef,
                      actorId,
                      expectedVersion: command.expectedVersion,
                      policy: stored,
                    });
                    fence(current);
                    if (outcome === "conflict") {
                      result = { kind: "conflict" };
                      return;
                    }
                    if (outcome === "staged")
                      await backend.appendAudit({
                        id: randomUUID(),
                        occurredAt: new Date().toISOString(),
                        installationId: policy.scope.installationId,
                        namespaceId: policy.scope.namespaceId,
                        kind: "mutation",
                        actorId,
                        actor: { principalId: actorId, kind: "principal" },
                        action: "work.repository.policy.mutate",
                        resource: authorization.resource,
                        outcome: "success",
                        source: "occ",
                        schemaVersion: 1,
                        requestId,
                        admissionDecisionId,
                        iamDriverId: decision.driverId,
                        authorization,
                        details: {
                          accountRef,
                          operationRef: command.operationRef,
                          commitRef,
                          policyRef: policy.policyRef,
                          policyVersion: policy.version,
                          previousVersion: command.expectedVersion,
                        },
                      });
                    const operation = await repository.readOperation(command.operationRef);
                    fence(current);
                    if (!operation || !equal(operation.policy, stored)) fail();
                    result = {
                      kind: "committed",
                      operationRef: command.operationRef,
                      commitRef: operation.commitRef,
                      policy,
                    };
                  });
                }),
              );
            });
          } catch {
            failed = true;
          } finally {
            if (entry) {
              while (entry.accepted.size) await Promise.all([...entry.accepted]);
              entry.active = false;
              units.delete(entry.unit);
              for (const release of [...entry.releases].reverse()) {
                try {
                  const unexpected: unknown = release();
                  if (unexpected !== undefined) {
                    await Promise.resolve(unexpected);
                    failed = true;
                  }
                } catch {
                  failed = true;
                }
              }
            }
          }
          if (failed || !acknowledged)
            return execution.disposition !== "not-sent" && !execution.establishedNoCommit
              ? { kind: "unknown", operationRef: command.operationRef }
              : { kind: "unavailable" };
          return result;
        },
      });
    },
  });
}
