import {
  canonicalGatewayStartupValueV1,
  parseGatewayStartupEventV1,
  parseGatewayStartupEventV2,
  parseGatewayStartupSubjectV2,
  type GatewayStartupAcceptedOperationV1,
  type GatewayStartupCommandLocatorV1,
  type GatewayStartupBackendV1,
  type GatewayStartupBackendV2,
  type GatewayStartupHeadV1,
  type GatewayStartupHeadV2,
  type GatewayStartupMutationEventV1,
  type GatewayStartupMutationEventV2,
} from "./owner.ts";
import type {
  GatewayStartupOperationLocatorV1,
  GatewayStartupOperationLocatorV2,
  GatewayStartupSubjectV2,
} from "@openclaw-enterprise/contracts/gateway-startup-v1";

const unavailable = () => new Error("Gateway startup record unavailable");
const equal = (a: unknown, b: unknown) =>
  canonicalGatewayStartupValueV1(a) === canonicalGatewayStartupValueV1(b);
const empty: GatewayStartupHeadV1 = Object.freeze({
  version: 0,
  processGeneration: 0,
  latestOperationRef: null,
  startup: null,
  recordVersion: 0,
  state: "empty",
});
function row(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}
function number(value: unknown): number {
  const result =
    typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value) ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0)
    throw unavailable();
  return result;
}
type Locator = GatewayStartupOperationLocatorV1 | GatewayStartupOperationLocatorV2;
type Event = GatewayStartupMutationEventV1 | GatewayStartupMutationEventV2;
type Head = GatewayStartupHeadV1 | GatewayStartupHeadV2;
type Scope = Readonly<{
  installationId: string;
  version: 1 | 2;
  key: string;
  namespaceRef: string | null;
  agentRef: string | null;
}>;
const scopeColumns = "installation_id,subject_version,subject_key,namespace_ref,agent_ref";
const eventColumns =
  "operation_ref,operation_digest,canonical_command,kind,startup_operation_ref,startup_operation_digest,process_ref,process_generation,create_effect_ref,before_head_version,after_head_version,before_record_version,after_record_version,previous_operation_ref,audit_event_id,record";
const columns = `${scopeColumns},${eventColumns}`;
const scopedWhere =
  "installation_id=$1 AND subject_version=$2 AND subject_key=$3 AND namespace_ref IS NOT DISTINCT FROM $4 AND agent_ref IS NOT DISTINCT FROM $5";
function assertRowScope(r: Record<string, unknown>, scope: Scope): void {
  if (
    r.installation_id !== scope.installationId ||
    number(r.subject_version) !== scope.version ||
    r.subject_key !== scope.key ||
    r.namespace_ref !== scope.namespaceRef ||
    r.agent_ref !== scope.agentRef
  )
    throw unavailable();
}
function assertTarget(target: Locator, scope: Scope): void {
  if (scope.version === 1) {
    if (
      "schemaVersion" in target ||
      !("installationId" in target) ||
      target.installationId !== scope.installationId
    )
      throw unavailable();
  } else {
    if (
      !("schemaVersion" in target) ||
      target.schemaVersion !== 2 ||
      !equal(target.subject, {
        kind: "agent-gateway",
        installationId: scope.installationId,
        namespaceRef: scope.namespaceRef,
        agentRef: scope.agentRef,
      })
    )
      throw unavailable();
  }
}
function assertEventScope(e: Event, scope: Scope): void {
  assertTarget(e.startup, scope);
  if (scope.version === 1) {
    if (
      "schemaVersion" in e ||
      !("installationId" in e.command) ||
      e.command.installationId !== scope.installationId
    )
      throw unavailable();
  } else if (
    !("schemaVersion" in e) ||
    e.schemaVersion !== 2 ||
    !("subject" in e.command) ||
    !equal(e.command.subject, (e.startup as GatewayStartupOperationLocatorV2).subject)
  )
    throw unavailable();
}
function eventFromRow<E extends Event>(
  value: unknown,
  scope: Scope,
  parse: (value: unknown) => E,
): E {
  const r = row(value);
  assertRowScope(r, scope);
  const e = parse(r.record);
  assertEventScope(e, scope);
  if (
    r.operation_ref !== e.command.operationRef ||
    r.operation_digest !== e.command.operationDigest ||
    r.canonical_command !== e.canonicalCommand ||
    r.kind !== e.kind ||
    r.startup_operation_ref !== e.startup.operationRef ||
    r.startup_operation_digest !== e.startup.operationDigest ||
    r.process_ref !== e.startup.processRef ||
    number(r.process_generation) !== e.startup.processGeneration ||
    r.create_effect_ref !== e.createEffectRef ||
    number(r.before_head_version) !== e.beforeHeadVersion ||
    number(r.after_head_version) !== e.afterHeadVersion ||
    number(r.before_record_version) !== e.beforeRecordVersion ||
    number(r.after_record_version) !== e.afterRecordVersion ||
    r.previous_operation_ref !== e.previousOperationRef ||
    r.audit_event_id !== e.auditEventId
  )
    throw unavailable();
  return e;
}
function state(e: Event): Head["state"] {
  return e.kind === "accept-startup"
    ? "accepted"
    : e.kind === "submit-create"
      ? "create-submitted"
      : e.kind === "consume-startup"
        ? "consumed"
        : "withdrawn";
}
/** One borrowed-client implementation for both closed record versions. The
 * original factory fixes the scope/parser; no caller DTO selects authority.
 * Both views require the forward partition schema. Old Installation-only SQL
 * must not coexist with Agent heads after that migration. */
function createScopedBackend<E extends Event, H extends Head, L extends Locator>(
  scope: Scope,
  parse: (value: unknown) => E,
  emptyHead: H,
  headFromEvent: (event: E) => H,
) {
  const values = [
    scope.installationId,
    scope.version,
    scope.key,
    scope.namespaceRef,
    scope.agentRef,
  ];
  const find = async (
    io: GatewayStartupAcceptedOperationV1,
    operationRef: string,
  ): Promise<E | undefined> => {
    const result = await io.query(
      `SELECT ${columns} FROM occ.gateway_startup_operations WHERE ${scopedWhere} AND operation_ref=$6`,
      [...values, operationRef],
    );
    if (result.rows.length > 1) throw unavailable();
    return result.rows[0] === undefined ? undefined : eventFromRow(result.rows[0], scope, parse);
  };
  const readHead = async (
    io: GatewayStartupAcceptedOperationV1,
    lock: boolean,
  ): Promise<H | undefined> => {
    const result = await io.query(
      `SELECT ${scopeColumns},head_version,process_generation,latest_operation_ref,startup_operation_ref,record_version,state FROM occ.gateway_startup_heads WHERE ${scopedWhere} ${lock ? "FOR UPDATE" : "FOR SHARE"}`,
      values,
    );
    if (result.rows.length > 1) throw unavailable();
    if (!result.rows.length) return undefined;
    const r = row(result.rows[0]);
    assertRowScope(r, scope);
    const v = number(r.head_version),
      generation = number(r.process_generation),
      recordVersion = number(r.record_version);
    if (v === 0) {
      if (
        generation !== 0 ||
        recordVersion !== 0 ||
        r.latest_operation_ref !== null ||
        r.startup_operation_ref !== null ||
        r.state !== "empty"
      )
        throw unavailable();
      return emptyHead;
    }
    if (typeof r.latest_operation_ref !== "string") throw unavailable();
    const e = await find(io, r.latest_operation_ref);
    if (
      !e ||
      e.afterHeadVersion !== v ||
      e.afterRecordVersion !== recordVersion ||
      e.startup.processGeneration !== generation ||
      e.startup.operationRef !== r.startup_operation_ref ||
      state(e) !== r.state
    )
      throw unavailable();
    return headFromEvent(e);
  };
  const findVariant = async (
    io: GatewayStartupAcceptedOperationV1,
    target: L,
    kind: "submit-create" | "consume-startup",
  ): Promise<E | undefined> => {
    assertTarget(target, scope);
    const result = await io.query(
      `SELECT ${columns} FROM occ.gateway_startup_operations WHERE ${scopedWhere} AND startup_operation_ref=$6 AND kind=$7`,
      [...values, target.operationRef, kind],
    );
    if (result.rows.length > 1) throw unavailable();
    if (!result.rows.length) return undefined;
    const e = eventFromRow(result.rows[0], scope, parse);
    if (e.kind !== kind || !equal(e.startup, target)) throw unavailable();
    return e;
  };
  return Object.freeze({
    async lockHead(io: GatewayStartupAcceptedOperationV1): Promise<H> {
      const inserted = await io.query(
        `INSERT INTO occ.gateway_startup_heads(${scopeColumns},head_version,process_generation,latest_operation_ref,startup_operation_ref,record_version,state) VALUES($1,$2,$3,$4,$5,0,0,NULL,NULL,0,'empty') ON CONFLICT(installation_id,subject_key) DO NOTHING`,
        values,
      );
      if (inserted.rowCount !== 0 && inserted.rowCount !== 1) throw unavailable();
      const head = await readHead(io, true);
      if (!head) throw unavailable();
      return head;
    },
    readHead: (io: GatewayStartupAcceptedOperationV1) => readHead(io, false),
    findOperation: find,
    async readAcceptance(
      io: GatewayStartupAcceptedOperationV1,
      target: L,
    ): Promise<NonNullable<E["acceptance"]> | undefined> {
      assertTarget(target, scope);
      const e = await find(io, target.operationRef);
      if (!e) return undefined;
      if (e.kind !== "accept-startup" || !e.acceptance || !equal(e.startup, target))
        throw unavailable();
      return e.acceptance as NonNullable<E["acceptance"]>;
    },
    findSubmission: (io: GatewayStartupAcceptedOperationV1, target: L) =>
      findVariant(io, target, "submit-create"),
    findClaim: (io: GatewayStartupAcceptedOperationV1, target: L) =>
      findVariant(io, target, "consume-startup"),
    async append(io: GatewayStartupAcceptedOperationV1, input: E): Promise<void> {
      const e = parse(input);
      assertEventScope(e, scope);
      const parameters = [
        ...values,
        e.command.operationRef,
        e.command.operationDigest,
        e.canonicalCommand,
        e.kind,
        e.startup.operationRef,
        e.startup.operationDigest,
        e.startup.processRef,
        e.startup.processGeneration,
        e.createEffectRef,
        e.beforeHeadVersion,
        e.afterHeadVersion,
        e.beforeRecordVersion,
        e.afterRecordVersion,
        e.previousOperationRef,
        e.auditEventId,
        canonicalGatewayStartupValueV1(e),
      ];
      const placeholders = parameters
        .map((_, i) => `$${i + 1}${i === parameters.length - 1 ? "::jsonb" : ""}`)
        .join(",");
      const result = await io.query(
        `INSERT INTO occ.gateway_startup_operations(${columns}) VALUES(${placeholders})`,
        parameters,
      );
      if (result.rowCount !== 1) throw unavailable();
    },
    async advanceHead(io: GatewayStartupAcceptedOperationV1, expected: H, input: E): Promise<void> {
      const e = parse(input);
      assertEventScope(e, scope);
      if (
        (scope.version === 2 &&
          (!("subject" in expected) ||
            !equal(expected.subject, (e.startup as GatewayStartupOperationLocatorV2).subject))) ||
        (scope.version === 1 && "subject" in expected) ||
        e.beforeHeadVersion !== expected.version ||
        e.previousOperationRef !== expected.latestOperationRef
      )
        throw unavailable();
      const result = await io.query(
        `UPDATE occ.gateway_startup_heads SET head_version=$6,process_generation=$7,latest_operation_ref=$8,startup_operation_ref=$9,record_version=$10,state=$11 WHERE ${scopedWhere} AND head_version=$12 AND process_generation=$13 AND latest_operation_ref IS NOT DISTINCT FROM $14 AND startup_operation_ref IS NOT DISTINCT FROM $15 AND record_version=$16 AND state=$17 RETURNING head_version`,
        [
          ...values,
          e.afterHeadVersion,
          e.startup.processGeneration,
          e.command.operationRef,
          e.startup.operationRef,
          e.afterRecordVersion,
          state(e),
          expected.version,
          expected.processGeneration,
          expected.latestOperationRef,
          expected.startup?.operationRef ?? null,
          expected.recordVersion,
          expected.state,
        ],
      );
      if (
        result.rowCount !== 1 ||
        result.rows.length !== 1 ||
        number(row(result.rows[0]).head_version) !== e.afterHeadVersion
      )
        throw unavailable();
    },
  });
}
function headV1(e: GatewayStartupMutationEventV1): GatewayStartupHeadV1 {
  return Object.freeze({
    version: e.afterHeadVersion,
    processGeneration: e.startup.processGeneration,
    latestOperationRef: e.command.operationRef,
    startup: e.startup,
    recordVersion: e.afterRecordVersion,
    state: state(e),
  });
}
function headV2(e: GatewayStartupMutationEventV2): GatewayStartupHeadV2 {
  return Object.freeze({ ...headV1Fields(e), startup: e.startup, subject: e.command.subject });
}
function headV1Fields(e: Event) {
  return {
    version: e.afterHeadVersion,
    processGeneration: e.startup.processGeneration,
    latestOperationRef: e.command.operationRef,
    startup: e.startup,
    recordVersion: e.afterRecordVersion,
    state: state(e),
  };
}
/** Original historical API and JSON remain V1; its physical rows use the legacy partition. */
export function createPostgresGatewayStartupV1(installationId: string): GatewayStartupBackendV1 {
  if (!installationId) throw unavailable();
  return createScopedBackend<
    GatewayStartupMutationEventV1,
    GatewayStartupHeadV1,
    GatewayStartupOperationLocatorV1
  >(
    { installationId, version: 1, key: "installation-v1", namespaceRef: null, agentRef: null },
    parseGatewayStartupEventV1,
    empty,
    headV1,
  );
}
export function createPostgresGatewayStartupV2(
  input: GatewayStartupSubjectV2,
): GatewayStartupBackendV2 {
  const subject = parseGatewayStartupSubjectV2(input);
  const backend = createScopedBackend<
    GatewayStartupMutationEventV2,
    GatewayStartupHeadV2,
    GatewayStartupOperationLocatorV2
  >(
    {
      installationId: subject.installationId,
      version: 2,
      key: `agent-v2:${subject.agentRef}`,
      namespaceRef: subject.namespaceRef,
      agentRef: subject.agentRef,
    },
    parseGatewayStartupEventV2,
    Object.freeze({ ...empty, startup: null, subject }),
    headV2,
  );
  const legacy = createPostgresGatewayStartupV1(subject.installationId);
  return Object.freeze({
    ...backend,
    async readLegacyRetirement(
      io: GatewayStartupAcceptedOperationV1,
      startup: GatewayStartupOperationLocatorV1,
      withdrawal: GatewayStartupCommandLocatorV1,
    ) {
      if (
        startup.installationId !== subject.installationId ||
        withdrawal.installationId !== subject.installationId ||
        !equal(withdrawal.startup, startup)
      )
        throw unavailable();
      const accepted = await legacy.findOperation(io, startup.operationRef);
      const ended = await legacy.findOperation(io, withdrawal.operationRef);
      if (!accepted || !ended) return undefined;
      if (
        accepted.kind !== "accept-startup" ||
        !accepted.acceptance ||
        !equal(accepted.startup, startup) ||
        ended.kind !== "withdraw" ||
        !equal(ended.command, withdrawal) ||
        !equal(ended.startup, startup) ||
        accepted.createEffectRef !== ended.createEffectRef ||
        accepted.acceptance.binding.namespaceRef !== subject.namespaceRef ||
        accepted.acceptance.binding.agentRef !== subject.agentRef
      )
        throw unavailable();
      return Object.freeze({ acceptance: accepted.acceptance, withdrawal: ended });
    },
  });
}
