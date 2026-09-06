import { sql, type SQL } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  primaryKey,
  text,
  type AnyPgColumn,
  type PgSchema,
} from "drizzle-orm/pg-core";
import { WORKLOAD_PROFILE_LIMITS_V1 } from "@openclaw-enterprise/contracts/workload-profile-v1";
import {
  WORKLOAD_PROFILE_DIGEST_DOMAINS,
  WORKLOAD_PROFILE_OPERATOR_DIGEST_DOMAINS,
} from "../../workload-profiles/canonical.ts";
import { PROFILE_ALLOCATION_KINDS } from "../../workload-profiles/types.ts";

/** Namespace ownership follows the existing singleton Installation database.
 * Its Namespace parent has no separate Installation column. */
export interface WorkloadProfileSchemaParents {
  installation: { id: AnyPgColumn };
  namespaces: { id: AnyPgColumn };
}

const uuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const digestPattern = "^sha256:[0-9a-f]{64}$";
const byteLimit = WORKLOAD_PROFILE_LIMITS_V1.canonicalBytes;

function boundedString(value: SQL, maximum: number) {
  return sql`octet_length(${value}) BETWEEN 1 AND ${maximum}`;
}

function digestOf(domain: string, canonical: SQL) {
  return sql`'sha256:' || encode(sha256(convert_to(${domain} || ${canonical}, 'UTF8')), 'hex')`;
}

function selection(value: SQL) {
  return sql`(${value} = jsonb_build_object(
    'manifestRef', ${value}->>'manifestRef', 'manifestDigest', ${value}->>'manifestDigest',
    'admissionRef', ${value}->>'admissionRef', 'admissionVersion', ${value}->'admissionVersion')
    AND ${value}->>'manifestRef' ~ ${uuidPattern}
    AND ${value}->>'manifestDigest' ~ ${digestPattern}
    AND ${value}->>'admissionRef' ~ ${uuidPattern}
    AND jsonb_typeof(${value}->'admissionVersion') = 'number'
    AND (${value}->>'admissionVersion')::numeric BETWEEN 1 AND 9007199254740991
    AND trunc((${value}->>'admissionVersion')::numeric) = (${value}->>'admissionVersion')::numeric)`;
}

/** These tables describe inert preparation only. The shared decoder validates
 * canonical lexical form; no manifest dictionary or current authority is implied. */
export function createWorkloadProfileTables(
  schema: PgSchema,
  parents: WorkloadProfileSchemaParents,
) {
  const workloadProfileCapacity = schema.table(
    "workload_profile_capacity",
    {
      installationId: text("installation_id")
        .primaryKey()
        .references(() => parents.installation.id, { onUpdate: "restrict", onDelete: "restrict" }),
      ordinaryOperations: integer("ordinary_operations").notNull().default(0),
      pendingOrdinaryOperations: integer("pending_ordinary_operations").notNull().default(0),
      terminalSlots: integer("terminal_slots").notNull().default(0),
    },
    (table) => [
      check(
        "workload_profile_capacity_bounds",
        sql`
        ${table.ordinaryOperations} BETWEEN 0 AND ${WORKLOAD_PROFILE_LIMITS_V1.operationAndTerminalSlots}
        AND ${table.pendingOrdinaryOperations} BETWEEN 0 AND ${WORKLOAD_PROFILE_LIMITS_V1.pendingOrdinaryOperations}
        AND ${table.terminalSlots} BETWEEN 0 AND ${WORKLOAD_PROFILE_LIMITS_V1.operationAndTerminalSlots}
        AND ${table.pendingOrdinaryOperations} <= ${table.ordinaryOperations}
        AND ${table.ordinaryOperations}::bigint + ${table.terminalSlots}::bigint <= ${WORKLOAD_PROFILE_LIMITS_V1.operationAndTerminalSlots}`,
      ),
    ],
  );
  const workloadProfileOperations = schema.table(
    "workload_profile_operations",
    {
      installationId: text("installation_id")
        .notNull()
        .references(() => parents.installation.id, { onUpdate: "restrict", onDelete: "restrict" }),
      namespaceId: text("namespace_id")
        .notNull()
        .references(() => parents.namespaces.id, { onUpdate: "restrict", onDelete: "restrict" }),
      principalRef: text("principal_ref").notNull(),
      accountRef: text("account_ref").notNull(),
      operationRef: text("operation_ref").notNull(),
      record: jsonb("record").notNull(),
    },
    (table) => {
      const record = sql`${table.record}`;
      const allocated = sql`(${record}->'allocated')`;
      const intentText = sql`(${record}->>'canonicalClientIntent')`;
      const operationText = sql`(${record}->>'canonicalOperation')`;
      const intent = sql`(${intentText}::jsonb)`;
      const manifest = sql`(${intent}->'manifest')`;
      const expected = sql`(${intent}->'expectedAdmission')`;
      const allocationFields = sql.join(
        PROFILE_ALLOCATION_KINDS.map((key) => sql`${key}, ${allocated}->>${key}`),
        sql`, `,
      );
      const allocationChecks = PROFILE_ALLOCATION_KINDS.map(
        (key) => sql`${allocated}->>${key} ~ ${uuidPattern}`,
      );
      for (let index = 0; index < PROFILE_ALLOCATION_KINDS.length; index++)
        for (const other of PROFILE_ALLOCATION_KINDS.slice(index + 1))
          allocationChecks.push(
            sql`${allocated}->>${PROFILE_ALLOCATION_KINDS[index]!} <> ${allocated}->>${other}`,
          );
      return [
        // Account changes conflict with the original operation; they never create
        // a second allocation namespace under the same principal and operation.
        primaryKey({
          name: "workload_profile_operations_pk",
          columns: [table.installationId, table.principalRef, table.operationRef],
        }),
        check("workload_profile_operation_ref", sql`${table.operationRef} ~ ${uuidPattern}`),
        check(
          "workload_profile_actor",
          sql`
          ${boundedString(sql`${table.accountRef}`, 1024)}
          AND ${boundedString(sql`${table.principalRef}`, 1024)}
          AND ${table.accountRef} !~ ('[[:cntrl:]' || chr(127) || '-' || chr(159) || ']')
          AND ${table.principalRef} !~ ('[[:cntrl:]' || chr(127) || '-' || chr(159) || ']')`,
        ),
        check(
          "workload_profile_record_shape",
          sql`(
          ${record} = jsonb_build_object(
            'schemaVersion', 1, 'kind', 'inert-profile-preparation',
            'scope', jsonb_build_object('installationId', ${table.installationId},
              'namespaceId', ${table.namespaceId}, 'component', 'harness'),
            'actor', jsonb_build_object('principalRef', ${table.principalRef}, 'accountRef', ${table.accountRef}),
            'operationRef', ${table.operationRef}, 'action', ${record}->>'action',
            'canonicalClientIntent', ${intentText}, 'clientIntentDigest', ${record}->>'clientIntentDigest',
            'allocated', ${allocated}, 'canonicalOperation', ${operationText},
            'operationDigest', ${record}->>'operationDigest', 'preparedAt', ${record}->>'preparedAt')
          AND ${record}->>'action' IN ('admit', 'replace')
          AND ${record}->>'preparedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'
          AND octet_length(${record}::text) BETWEEN 1 AND ${4 * byteLimit + 8192}
          AND ${boundedString(intentText, byteLimit)}
          AND ${boundedString(operationText, byteLimit)}
          AND ${record}->>'clientIntentDigest' ~ ${digestPattern}
          AND ${record}->>'operationDigest' ~ ${digestPattern}
        ) IS TRUE`,
        ),
        check(
          "workload_profile_prepared_at",
          sql`(
          make_date(
            CASE substring(${record}->>'preparedAt', 1, 4)::integer WHEN 0 THEN -1
              ELSE substring(${record}->>'preparedAt', 1, 4)::integer END,
            substring(${record}->>'preparedAt', 6, 2)::integer,
            substring(${record}->>'preparedAt', 9, 2)::integer) IS NOT NULL
          AND substring(${record}->>'preparedAt', 12, 2)::integer BETWEEN 0 AND 23
          AND substring(${record}->>'preparedAt', 15, 2)::integer BETWEEN 0 AND 59
          AND substring(${record}->>'preparedAt', 18, 2)::integer BETWEEN 0 AND 59
        ) IS TRUE`,
        ),
        check(
          "workload_profile_allocations",
          sql`(
          ${allocated} = jsonb_build_object(${allocationFields})
          AND ${sql.join(allocationChecks, sql` AND `)}
        ) IS TRUE`,
        ),
        check(
          "workload_profile_intent",
          sql`(
          ${intent} = jsonb_build_object('schemaVersion', 1, 'operationRef', ${table.operationRef},
            'namespaceId', ${table.namespaceId}, 'component', 'harness',
            'action', ${record}->>'action', 'expectedAdmission', ${expected}, 'manifest', ${manifest})
          AND CASE ${record}->>'action' WHEN 'admit' THEN ${expected} = 'null'::jsonb
            ELSE ${selection(expected)} END
          AND ${manifest} = jsonb_build_object('format', 'oce.workload-profile.canonical-json.v1',
            'canonicalUtf8', ${manifest}->>'canonicalUtf8', 'manifestDigest', ${manifest}->>'manifestDigest')
          AND ${boundedString(sql`(${manifest}->>'canonicalUtf8')`, byteLimit)}
          AND ${manifest}->>'manifestDigest' = ${digestOf(WORKLOAD_PROFILE_DIGEST_DOMAINS.manifestDigest, sql`(${manifest}->>'canonicalUtf8')`)}
          AND ${record}->>'clientIntentDigest' = ${digestOf(WORKLOAD_PROFILE_OPERATOR_DIGEST_DOMAINS.clientIntentDigest, intentText)}
        ) IS TRUE`,
        ),
        check(
          "workload_profile_operation_envelope",
          sql`(
          ${operationText}::jsonb = jsonb_build_object('schemaVersion', 1,
            'kind', 'inert-profile-preparation', 'scope', ${record}->'scope', 'actor', ${record}->'actor',
            'operationRef', ${table.operationRef}, 'action', ${record}->>'action',
            'clientIntentDigest', ${record}->>'clientIntentDigest', 'allocated', ${allocated},
            'preparedAt', ${record}->>'preparedAt')
          AND ${record}->>'operationDigest' = ${digestOf(WORKLOAD_PROFILE_OPERATOR_DIGEST_DOMAINS.operationDigest, operationText)}
        ) IS TRUE`,
        ),
      ];
    },
  );
  return { workloadProfileCapacity, workloadProfileOperations };
}

export type WorkloadProfileTables = ReturnType<typeof createWorkloadProfileTables>;
