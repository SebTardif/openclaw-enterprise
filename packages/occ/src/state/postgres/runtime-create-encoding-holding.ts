import type { RuntimePreparedChildV1 } from "@openclaw-enterprise/contracts";
import type { RuntimePreparationCommittedSubmissionV1 } from "../../runtime-preparation/submission-owner.ts";
import type { NativeCreateCorrelationFenceLeaseV1 } from "../../runtime-preparation/create-correlation-fence.ts";
import { createHash } from "node:crypto";
import type { ExactCreateEffectV1 } from "@openclaw-enterprise/contracts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { jsonb, text, uuid, type PgSchema } from "drizzle-orm/pg-core";
import {
  DependencyUnavailableError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../errors.ts";
import type { QueryRepositoryFactoryContext } from "../../ports/repository-factory.ts";
import type { RuntimeAuthorityTransactionGuard } from "../../runtime-authority/repository.ts";
import { canonicalRuntimeCreateCorrelationV1 as canonical } from "../../runtime-preparation/create-correlation.ts";
import {
  decodeRuntimePreparationOperation,
  retainedRuntimePreparationRequest,
} from "../../runtime-preparation/repository.ts";
import type { RuntimePreparationDeploymentResponseV1 } from "../../runtime-preparation/submission.ts";

/** Physical name is selected before a Deployment UID exists. Logical owner and
 * conditional UID/RV/epoch remain exact association data, never lock aliases. */
export interface RuntimeCreateEncodingSelectionV1 {
  readonly installationId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly clusterRef: string;
  readonly kubernetesNamespaceUid: string;
  readonly namespace: string;
  readonly name: string;
}
export interface RuntimeCreateEncodingPossibleEffectV1 {
  readonly schemaVersion: 1;
  readonly kind: "possible-effect";
  readonly operationRef: string;
  readonly submissionRef: string;
  readonly selection: RuntimeCreateEncodingSelectionV1;
  readonly childEffectRef: string;
  readonly assignmentRef: string;
  readonly createEffectRef: string;
  readonly expectedUid: string | null;
  readonly expectedResourceVersion: string | null;
  readonly requestedFenceEpoch: number;
  readonly requestDigest: string;
  readonly providerWireDigest: string;
}
export type RuntimeCreateEncodingOutcomeV1 =
  | Readonly<{ status: "unknown" }>
  | Readonly<{ status: "response"; response: RuntimePreparationDeploymentResponseV1 }>;
export interface RuntimeCreateEncodingRetainedOutcomeV1 {
  readonly operationRef: string;
  readonly possibleEffectRef: string;
  readonly outcome: RuntimeCreateEncodingOutcomeV1;
}
export interface RuntimeCreateEncodingRecoveryV1 {
  /** Even empty storage is not a currentness/exclusion proof. Every retained
   * possibility stays unresolved after an SDK response, failure or cancellation. */
  readonly kind: "inert-encoding-recovery";
  readonly possibleEffects: readonly RuntimeCreateEncodingPossibleEffectV1[];
  readonly outcomes: readonly RuntimeCreateEncodingRetainedOutcomeV1[];
  readonly acceptingAuthority: false;
}

/** Exact prepared locators, not invocation or enrollment authority. The original
 * accepting owner binds this entire tuple to the actual conditional SDK request.
 * Selection retains the physical name before UID, cluster and Namespace UID;
 * child retains assignment/create identity, conditional UID/RV and fence epoch. */
export interface RuntimeCreateEncodingConditionalWireTargetV1 {
  readonly committed: RuntimePreparationCommittedSubmissionV1;
  readonly selection: RuntimeCreateEncodingSelectionV1;
  readonly child: RuntimePreparedChildV1;
  readonly providerWireUtf8: string;
}

/** Only the original holding owner may issue/recognize this exact handle.
 * possibleEffect is retained history; copying it cannot recreate the handle. */
export interface RuntimeCreateEncodingMutationHoldV1 {
  readonly possibleEffect: RuntimeCreateEncodingPossibleEffectV1;
  assertCurrent(): undefined;
  /** Close new mutation entry synchronously before the first await, then join
   * accepted local work/cleanup. The owner continues retaining unresolved durable
   * possible-effect membership. Fulfillment is not remote exclusion/resolution. */
  release(): Promise<void>;
}

/** Typed consumer contract, not an installed positive constructor. I is the SAME
 * original accepting owner's privately retained invocation, R its independently
 * produced resolution, and N the original native PreCommitRecognitionV1. None
 * is manufactured here or reconstructed from assertion success or a DTO.
 * Native N remains generic so State neither imports Controller nor duplicates
 * the native-owned declaration. Missing genuine suppliers must keep refusing. */
export interface RuntimeCreateEncodingHoldingV1<
  I extends object,
  R extends object,
  N extends object,
> {
  /** Require real shared all-mutator exclusion plus unresolved membership checks.
   * The borrowed N.assertCurrent lifetime is initial State only; subsequent checks
   * require its original independent native fence AND the retained writer fence. */
  acquireObservation(
    recognition: N,
    effect: ExactCreateEffectV1,
    destination: Readonly<{ namespace: string; uid: string; resourceVersion: string }>,
  ): Promise<NativeCreateCorrelationFenceLeaseV1>;
  /** Return only after definite possible-effect COMMIT and genuine exclusive
   * writer acquisition. An unknown ACK never grants SDK entry. I is returned by
   * the original execution lease for the exact original request/call. */
  beginMutation(
    originalAcceptingInvocation: I,
    conditionalWireTarget: RuntimeCreateEncodingConditionalWireTargetV1,
  ): Promise<RuntimeCreateEncodingMutationHoldV1>;
  /** Recognize the original issued hold even for a late SDK outcome after local
   * release. Response/unknown records never remove possible-effect membership. */
  retainOutcome(
    originalHold: RuntimeCreateEncodingMutationHoldV1,
    SDKresponseOrUnknown: RuntimeCreateEncodingOutcomeV1,
  ): Promise<void>;
  /** Independent original resolution/exclusion only, never cancellation, a joined
   * local Promise, deadline, disconnected DB or an observed response by itself. */
  resolvePossibleEffect(originalIndependentResolution: R): Promise<void>;
}

/** Refusal-only compatibility surface while the original invocation/permission
 * operand is missing. unknown is deliberately not an accepting invocation type.
 * TODO(CTL15 original Compute/native): bind the actual enrolled invocation,
 * all-mutator writer custody and independent resolution before positive methods
 * or their final paired parameter/return types can be installed. */
export interface RuntimeCreateEncodingUnavailableV1 {
  acquireObservation(
    recognition: unknown,
    effect: ExactCreateEffectV1,
    destination: Readonly<{ namespace: string; uid: string; resourceVersion: string }>,
  ): Promise<never>;
  beginMutation(
    originalAcceptingInvocation: unknown,
    conditionalWireTarget: unknown,
  ): Promise<never>;
  retainOutcome(hold: unknown, SDKresponseOrUnknown: unknown): Promise<never>;
  resolvePossibleEffect(originalIndependentResolution: unknown): Promise<never>;
}
const missingWriter = () =>
  new DependencyUnavailableError(
    "The original accepting invocation, complete encoding writer custody and independent resolution source are unavailable.",
  );
export function createUnavailableRuntimeCreateEncodingHoldingV1(): RuntimeCreateEncodingUnavailableV1 {
  const refuse = async (): Promise<never> => {
    throw missingWriter();
  };
  return Object.freeze({
    acquireObservation: refuse,
    beginMutation: refuse,
    retainOutcome: refuse,
    resolvePossibleEffect: refuse,
  });
}

const checksum = (bytes: string) =>
  `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
const unavailable = () =>
  new DependencyUnavailableError("The original possible-effect record is unavailable.");
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 1024 || value.includes("\0"))
    throw unavailable();
  return value;
}
function selection(value: RuntimeCreateEncodingSelectionV1): RuntimeCreateEncodingSelectionV1 {
  const copy = immutableCopy(value);
  if (
    Object.keys(copy).sort().join(",") !==
    "agentId,clusterRef,installationId,kubernetesNamespaceUid,name,namespace,namespaceId"
  )
    throw unavailable();
  for (const entry of Object.values(copy)) string(entry);
  return copy;
}
/** Storage serialization only: no local mutex or lock-key equality is external
 * writer authority. Excluding UID/RV/assignment prevents a replacement or new
 * owner from escaping the physical name's original storage partition. */
export function runtimeCreateEncodingPartitionV1(value: RuntimeCreateEncodingSelectionV1): string {
  const selected = selection(value);
  return [
    selected.installationId,
    selected.clusterRef,
    selected.kubernetesNamespaceUid,
    "apps/v1/Deployment",
    selected.name,
  ]
    .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`)
    .join("|");
}
function decodeBody(rowValue: unknown): unknown {
  const row = object(rowValue);
  const bytes = row.canonical_record;
  if (typeof bytes !== "string" || Buffer.byteLength(bytes, "utf8") > 65536) throw unavailable();
  if (row.record_digest !== checksum(bytes) || canonical(row.record) !== bytes) throw unavailable();
  return immutableCopy(row.record);
}
function possible(rowValue: unknown): RuntimeCreateEncodingPossibleEffectV1 {
  const value = object(decodeBody(rowValue));
  if (value.kind !== "possible-effect" || value.schemaVersion !== 1) throw unavailable();
  selection(value.selection as RuntimeCreateEncodingSelectionV1);
  for (const key of [
    "operationRef",
    "submissionRef",
    "childEffectRef",
    "assignmentRef",
    "createEffectRef",
    "requestDigest",
    "providerWireDigest",
  ])
    string(value[key]);
  if (!Number.isSafeInteger(value.requestedFenceEpoch) || (value.requestedFenceEpoch as number) < 1)
    throw unavailable();
  if ((value.expectedUid === null) !== (value.expectedResourceVersion === null))
    throw unavailable();
  if (value.expectedUid !== null) {
    string(value.expectedUid);
    string(value.expectedResourceVersion);
  }
  return immutableCopy(value) as unknown as RuntimeCreateEncodingPossibleEffectV1;
}

/** Inert repository on the original State transaction, never a mutation permit.
 * State caches one instance per original unit; a SHARE read cannot be upgraded
 * through a second handle. The original authority guard poisons caught failures
 * and drains accepted work before COMMIT. No pool/transaction control is exposed. */
export function createPostgresRuntimeCreateEncodingMembershipV1(
  context: QueryRepositoryFactoryContext,
  guard: RuntimeAuthorityTransactionGuard,
) {
  const assertActive = context.transaction.assertActive.bind(context.transaction);
  const execute = context.query.query.bind(context.query);
  const installationId = context.scope.installationId;
  let held: { partition: string; mode: "shared" | "exclusive" } | undefined;
  const query = async (statement: string, parameters: readonly unknown[] = []) => {
    assertActive();
    const result = await execute(statement, parameters);
    assertActive();
    return result.rows;
  };
  const lock = async (value: RuntimeCreateEncodingSelectionV1, mode: "shared" | "exclusive") => {
    const selected = selection(value);
    if (selected.installationId !== installationId)
      throw new ScopeViolationError("The original Installation differs.");
    const partition = runtimeCreateEncodingPartitionV1(selected);
    if (held) {
      if (held.partition !== partition || (held.mode === "shared" && mode === "exclusive"))
        throw new ScopeViolationError(
          "Encoding storage cannot change partitions or upgrade an observation lock.",
        );
      return selected;
    }
    held = { partition, mode };
    await query(
      `SELECT ${mode === "shared" ? "pg_advisory_xact_lock_shared" : "pg_advisory_xact_lock"}(hashtextextended('runtime-create-encoding:'||$1,0))`,
      [partition],
    );
    return selected;
  };
  const one = (rows: readonly unknown[]) => {
    if (rows.length > 1) throw unavailable();
    return rows[0];
  };
  const findPossible = async (operationRef: string) => {
    const row = one(
      await query(
        "SELECT canonical_record,record_digest,record FROM occ.runtime_create_encoding_possible_effects WHERE installation_id=$1 AND operation_ref=$2::uuid",
        [installationId, operationRef],
      ),
    );
    return row === undefined ? undefined : possible(row);
  };
  return Object.freeze({
    retainPossibleEffect(
      input: Readonly<{
        operationRef: string;
        submissionRef: string;
        selection: RuntimeCreateEncodingSelectionV1;
      }>,
    ) {
      return guard.run(async () => {
        const request = immutableCopy(input);
        const selected = await lock(request.selection, "exclusive");
        const prior = await findPossible(request.operationRef);
        if (prior) {
          if (
            prior.submissionRef !== request.submissionRef ||
            canonical(prior.selection) !== canonical(selected)
          )
            throw new ResourceConflictError("Possible-effect replay differs.");
          return Object.freeze({ status: "exact-replay" as const, record: prior });
        }
        const source = one(
          await query(
            `SELECT s.effect_ref,s.request_digest,s.provider_wire_digest,p.record
          FROM occ.runtime_preparation_submissions s JOIN occ.runtime_preparation_operations p ON p.child_effect_ref=s.effect_ref
          WHERE s.submission_ref=$1::uuid AND s.installation_id=$2 AND s.namespace_id=$3 AND s.agent_id=$4`,
            [request.submissionRef, installationId, selected.namespaceId, selected.agentId],
          ),
        );
        if (!source) throw unavailable();
        const row = object(source);
        const operation = decodeRuntimePreparationOperation(row.record);
        const retained = retainedRuntimePreparationRequest(operation);
        if (
          retained.kind !== "retain-child" ||
          retained.child.request.kind !== "create" ||
          retained.child.providerTarget.apiKind !== "Deployment"
        )
          throw unavailable();
        const child = retained.child;
        if (
          child.providerTarget.name !== selected.name ||
          child.effect.effectRef !== row.effect_ref ||
          operation.target.installationId !== installationId ||
          operation.target.namespaceId !== selected.namespaceId ||
          operation.target.agentId !== selected.agentId
        )
          throw unavailable();
        const record: RuntimeCreateEncodingPossibleEffectV1 = immutableCopy({
          schemaVersion: 1,
          kind: "possible-effect",
          operationRef: request.operationRef,
          submissionRef: request.submissionRef,
          selection: selected,
          childEffectRef: child.effect.effectRef,
          assignmentRef: child.providerTarget.ownerAssignmentRef.id,
          createEffectRef: child.providerTarget.ownerCreateEffectRef,
          expectedUid: child.predicate.kind === "expected-object" ? child.predicate.uid : null,
          expectedResourceVersion:
            child.predicate.kind === "expected-object" ? child.predicate.resourceVersion : null,
          requestedFenceEpoch: child.guard.requestedFenceEpoch,
          requestDigest: string(row.request_digest),
          providerWireDigest: string(row.provider_wire_digest),
        });
        const bytes = canonical(record);
        const inserted = one(
          await query(
            `INSERT INTO occ.runtime_create_encoding_possible_effects
          (operation_ref,submission_ref,installation_id,namespace_id,agent_id,cluster_ref,namespace_uid,namespace_name,object_name,child_effect_ref,canonical_record,record_digest,record)
          VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING canonical_record,record_digest,record`,
            [
              record.operationRef,
              record.submissionRef,
              installationId,
              selected.namespaceId,
              selected.agentId,
              selected.clusterRef,
              selected.kubernetesNamespaceUid,
              selected.namespace,
              selected.name,
              record.childEffectRef,
              bytes,
              checksum(bytes),
              JSON.stringify(record),
            ],
          ),
        );
        if (!inserted || canonical(possible(inserted)) !== bytes) throw unavailable();
        // This result is provisional until the ORIGINAL State transaction has
        // definitely committed. Even definite persistence grants no SDK entry.
        return Object.freeze({ status: "retained" as const, record });
      });
    },
    retainOutcome(input: RuntimeCreateEncodingRetainedOutcomeV1) {
      return guard.run(async () => {
        const record = immutableCopy(input);
        const parent = await findPossible(record.possibleEffectRef);
        if (!parent) throw unavailable();
        await lock(parent.selection, "exclusive");
        const bytes = canonical(record);
        const prior = one(
          await query(
            "SELECT canonical_record,record_digest,record FROM occ.runtime_create_encoding_outcomes WHERE operation_ref=$1::uuid",
            [record.operationRef],
          ),
        );
        if (prior) {
          if (canonical(decodeBody(prior)) !== bytes)
            throw new ResourceConflictError("Possible-effect outcome replay differs.");
          return Object.freeze({ status: "exact-replay" as const, record });
        }
        const inserted = one(
          await query(
            `INSERT INTO occ.runtime_create_encoding_outcomes
          (operation_ref,possible_effect_ref,canonical_record,record_digest,record)
          VALUES($1::uuid,$2::uuid,$3,$4,$5::jsonb) RETURNING canonical_record,record_digest,record`,
            [
              record.operationRef,
              record.possibleEffectRef,
              bytes,
              checksum(bytes),
              JSON.stringify(record),
            ],
          ),
        );
        if (!inserted || canonical(decodeBody(inserted)) !== bytes) throw unavailable();
        // Response and unknown are both historical observations. Neither clears
        // the parent possibility nor proves no delayed server-side mutation.
        return Object.freeze({ status: "retained" as const, record });
      });
    },
    recoverPossibleEffects(
      value: RuntimeCreateEncodingSelectionV1,
    ): Promise<RuntimeCreateEncodingRecoveryV1> {
      return guard.run(async () => {
        const selected = await lock(value, "shared");
        const parameters = [
          installationId,
          selected.clusterRef,
          selected.kubernetesNamespaceUid,
          selected.name,
        ];
        const records = (
          await query(
            `SELECT canonical_record,record_digest,record FROM occ.runtime_create_encoding_possible_effects
          WHERE installation_id=$1 AND cluster_ref=$2 AND namespace_uid=$3 AND object_name=$4 ORDER BY operation_ref`,
            parameters,
          )
        ).map(possible);
        const outcomes = (
          await query(
            `SELECT o.canonical_record,o.record_digest,o.record FROM occ.runtime_create_encoding_outcomes o
          JOIN occ.runtime_create_encoding_possible_effects p ON p.operation_ref=o.possible_effect_ref
          WHERE p.installation_id=$1 AND p.cluster_ref=$2 AND p.namespace_uid=$3 AND p.object_name=$4 ORDER BY o.operation_ref`,
            parameters,
          )
        ).map((row) => decodeBody(row) as RuntimeCreateEncodingRetainedOutcomeV1);
        return immutableCopy({
          kind: "inert-encoding-recovery",
          possibleEffects: records,
          outcomes,
          acceptingAuthority: false,
        });
      });
    },
  });
}

/** The paired unnumbered migration supplies all association/digest/immutability
 * constraints. Registration grants no accepting invocation or resolution role. */
export function createRuntimeCreateEncodingHoldingTablesV1(schema: PgSchema) {
  const possibleEffects = schema.table("runtime_create_encoding_possible_effects", {
    operationRef: uuid("operation_ref").primaryKey(),
    submissionRef: uuid("submission_ref").notNull().unique(),
    installationId: text("installation_id").notNull(),
    namespaceId: text("namespace_id").notNull(),
    agentId: text("agent_id").notNull(),
    clusterRef: text("cluster_ref").notNull(),
    namespaceUid: text("namespace_uid").notNull(),
    namespaceName: text("namespace_name").notNull(),
    objectName: text("object_name").notNull(),
    childEffectRef: text("child_effect_ref").notNull().unique(),
    canonicalRecord: text("canonical_record").notNull(),
    recordDigest: text("record_digest").notNull(),
    record: jsonb("record").$type<unknown>().notNull(),
  });
  const outcomes = schema.table("runtime_create_encoding_outcomes", {
    operationRef: uuid("operation_ref").primaryKey(),
    possibleEffectRef: uuid("possible_effect_ref")
      .notNull()
      .references(() => possibleEffects.operationRef, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    canonicalRecord: text("canonical_record").notNull(),
    recordDigest: text("record_digest").notNull(),
    record: jsonb("record").$type<unknown>().notNull(),
  });
  return {
    runtimeCreateEncodingPossibleEffects: possibleEffects,
    runtimeCreateEncodingOutcomes: outcomes,
  };
}
