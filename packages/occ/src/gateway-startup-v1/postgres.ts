import {
  canonicalGatewayStartupValueV1,
  parseGatewayStartupEventV1,
  type GatewayStartupAcceptedOperationV1,
  type GatewayStartupBackendV1,
  type GatewayStartupHeadV1,
  type GatewayStartupMutationEventV1,
} from "./owner.ts";
import type { GatewayStartupOperationLocatorV1 } from "@openclaw-enterprise/contracts/gateway-startup-v1";

const unavailable = () => new Error("Gateway startup record unavailable");
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
function eventFromRow(value: unknown, installationId: string): GatewayStartupMutationEventV1 {
  const r = row(value);
  const e = parseGatewayStartupEventV1(r.record);
  if (
    e.command.installationId !== installationId ||
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
const columns =
  "operation_ref,operation_digest,canonical_command,kind,startup_operation_ref,startup_operation_digest,process_ref,process_generation,create_effect_ref,before_head_version,after_head_version,before_record_version,after_record_version,previous_operation_ref,audit_event_id,record";

/** Borrows the original client's tracked scope; creates no pool or transaction. */
export function createPostgresGatewayStartupV1(installationId: string): GatewayStartupBackendV1 {
  if (!installationId) throw unavailable();
  const find = async (io: GatewayStartupAcceptedOperationV1, operationRef: string) => {
    const result = await io.query(
      `SELECT ${columns} FROM occ.gateway_startup_operations WHERE installation_id=$1 AND operation_ref=$2`,
      [installationId, operationRef],
    );
    if (result.rows.length > 1) throw unavailable();
    return result.rows[0] === undefined ? undefined : eventFromRow(result.rows[0], installationId);
  };
  const readHead = async (
    io: GatewayStartupAcceptedOperationV1,
    lock: boolean,
  ): Promise<GatewayStartupHeadV1 | undefined> => {
    const result = await io.query(
      `SELECT head_version,process_generation,latest_operation_ref,startup_operation_ref,record_version,state FROM occ.gateway_startup_heads WHERE installation_id=$1 ${lock ? "FOR UPDATE" : "FOR SHARE"}`,
      [installationId],
    );
    if (result.rows.length > 1) throw unavailable();
    if (!result.rows.length) return undefined;
    const r = row(result.rows[0]);
    const v = number(r.head_version);
    const generation = number(r.process_generation);
    const recordVersion = number(r.record_version);
    if (v === 0) {
      if (
        generation !== 0 ||
        recordVersion !== 0 ||
        r.latest_operation_ref !== null ||
        r.startup_operation_ref !== null ||
        r.state !== "empty"
      )
        throw unavailable();
      return empty;
    }
    if (typeof r.latest_operation_ref !== "string") throw unavailable();
    const e = await find(io, r.latest_operation_ref);
    if (
      !e ||
      e.afterHeadVersion !== v ||
      e.afterRecordVersion !== recordVersion ||
      e.startup.processGeneration !== generation ||
      e.startup.operationRef !== r.startup_operation_ref
    )
      throw unavailable();
    const state =
      e.kind === "accept-startup"
        ? "accepted"
        : e.kind === "submit-create"
          ? "create-submitted"
          : e.kind === "consume-startup"
            ? "consumed"
            : "withdrawn";
    if (state !== r.state) throw unavailable();
    return Object.freeze({
      version: v,
      processGeneration: generation,
      latestOperationRef: e.command.operationRef,
      startup: e.startup,
      recordVersion,
      state,
    });
  };
  const findVariant = async (
    io: GatewayStartupAcceptedOperationV1,
    target: GatewayStartupOperationLocatorV1,
    kind: "submit-create" | "consume-startup",
  ) => {
    if (target.installationId !== installationId) throw unavailable();
    const result = await io.query(
      `SELECT ${columns} FROM occ.gateway_startup_operations WHERE installation_id=$1 AND startup_operation_ref=$2 AND kind=$3`,
      [installationId, target.operationRef, kind],
    );
    if (result.rows.length > 1) throw unavailable();
    if (!result.rows.length) return undefined;
    const e = eventFromRow(result.rows[0], installationId);
    if (canonicalGatewayStartupValueV1(e.startup) !== canonicalGatewayStartupValueV1(target))
      throw unavailable();
    return e;
  };
  const backend: GatewayStartupBackendV1 = {
    async lockHead(io) {
      await io.query(
        "INSERT INTO occ.gateway_startup_heads(installation_id,head_version,process_generation,latest_operation_ref,startup_operation_ref,record_version,state) VALUES($1,0,0,NULL,NULL,0,'empty') ON CONFLICT(installation_id) DO NOTHING",
        [installationId],
      );
      const result = await readHead(io, true);
      if (!result) throw unavailable();
      return result;
    },
    readHead: (io) => readHead(io, false),
    findOperation: find,
    async readAcceptance(io, target) {
      if (target.installationId !== installationId) throw unavailable();
      const e = await find(io, target.operationRef);
      if (!e) return undefined;
      if (
        e.kind !== "accept-startup" ||
        !e.acceptance ||
        canonicalGatewayStartupValueV1(e.startup) !== canonicalGatewayStartupValueV1(target)
      )
        throw unavailable();
      return e.acceptance;
    },
    findSubmission: (io, target) => findVariant(io, target, "submit-create"),
    findClaim: (io, target) => findVariant(io, target, "consume-startup"),
    async append(io, input) {
      const e = parseGatewayStartupEventV1(input);
      if (e.command.installationId !== installationId) throw unavailable();
      const result = await io.query(
        "INSERT INTO occ.gateway_startup_operations(installation_id,operation_ref,operation_digest,canonical_command,kind,startup_operation_ref,startup_operation_digest,process_ref,process_generation,create_effect_ref,before_head_version,after_head_version,before_record_version,after_record_version,previous_operation_ref,audit_event_id,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)",
        [
          installationId,
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
        ],
      );
      if (result.rowCount !== 1) throw unavailable();
    },
    async advanceHead(io, expected, input) {
      const e = parseGatewayStartupEventV1(input);
      if (
        e.command.installationId !== installationId ||
        e.beforeHeadVersion !== expected.version ||
        e.previousOperationRef !== expected.latestOperationRef
      )
        throw unavailable();
      const state =
        e.kind === "accept-startup"
          ? "accepted"
          : e.kind === "submit-create"
            ? "create-submitted"
            : e.kind === "consume-startup"
              ? "consumed"
              : "withdrawn";
      const result = await io.query(
        "UPDATE occ.gateway_startup_heads SET head_version=$2,process_generation=$3,latest_operation_ref=$4,startup_operation_ref=$5,record_version=$6,state=$7 WHERE installation_id=$1 AND head_version=$8 AND process_generation=$9 AND latest_operation_ref IS NOT DISTINCT FROM $10 AND startup_operation_ref IS NOT DISTINCT FROM $11 AND record_version=$12 AND state=$13 RETURNING head_version",
        [
          installationId,
          e.afterHeadVersion,
          e.startup.processGeneration,
          e.command.operationRef,
          e.startup.operationRef,
          e.afterRecordVersion,
          state,
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
  };
  return Object.freeze(backend);
}
