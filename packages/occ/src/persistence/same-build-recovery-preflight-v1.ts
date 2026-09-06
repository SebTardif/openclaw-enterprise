import { createHash } from "node:crypto";
import type {
  CheckpointRefV1,
  ProducerTupleV1,
} from "@openclaw-enterprise/contracts/completed-context-v1";

export type RecoveryComparisonScopeV1 = "producer-tuple" | "checkpoint";
export type RecoveryComparisonResultV1 = Readonly<
  | {
      scope: RecoveryComparisonScopeV1;
      kind: "compatible";
      reasonCode: "exact-descriptor-match";
    }
  | {
      scope: RecoveryComparisonScopeV1;
      kind: "incompatible";
      reasonCode:
        | "missing-descriptor"
        | "invalid-descriptor"
        | "descriptor-mismatch"
        | "canonical-bytes-mismatch";
    }
>;

/** This result cannot represent readiness, permission or a successful restore. */
export type SameBuildRecoveryPreflightResultV1 = Readonly<
  | {
      scope: "same-build-recovery-preflight";
      kind: "incompatible";
      reasonCode:
        | "missing-descriptor"
        | "invalid-descriptor"
        | "descriptor-mismatch"
        | "canonical-bytes-mismatch";
    }
  | {
      scope: "same-build-recovery-preflight";
      kind: "unavailable";
      reasonCode: "native-candidate-descriptor-unavailable";
    }
>;

const tupleFields = [
  "enterpriseCommit",
  "upstreamCommit",
  "codexCommit",
  "codexVersion",
  "gatewayProtocol",
  "nativeStateSchema",
  "nativeAgentSchema",
  "adapterSchema",
  "contextFormat",
  "nativeImportContract",
  "nativeImportAdapterDigest",
  "artifactLedgerRef",
] as const satisfies readonly (keyof ProducerTupleV1)[];
const checkpointFields = [
  "installationRef",
  "namespaceRef",
  "agentRef",
  "conversationRef",
  "turnRef",
  "attemptRef",
  "reservationRef",
  "schemaVersion",
  "checkpointId",
  "completionSequence",
  "parentCheckpointId",
  "contentDigest",
  "byteLength",
  "itemCount",
  "revisionRef",
  "admittedConfigurationDigest",
  "revisionLineageRef",
  "producingGatewayAssignmentRef",
  "producingHarnessAssignmentRef",
  "gatewayStoreBindingRef",
  "workspaceBindingRef",
  "workspaceCompletionRef",
  "producerTuple",
] as const satisfies readonly (keyof CheckpointRefV1)[];

// A new producer field must receive an explicit comparison decision at compilation.
type CompleteKeys<T, K extends readonly (keyof T)[]> =
  Exclude<keyof T, K[number]> extends never ? true : never;
const completeTupleKeys: CompleteKeys<ProducerTupleV1, typeof tupleFields> = true;
const completeCheckpointKeys: CompleteKeys<CheckpointRefV1, typeof checkpointFields> = true;
void completeTupleKeys;
void completeCheckpointKeys;

const digestPattern = /^[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;
const referencePattern = /^[A-Za-z0-9._:/-]{1,200}$/;
const maxSnapshotBytes = 8 * 1024 * 1024;
const maxItems = 16_384;

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): boolean {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

/** These sanity checks reject incomplete comparison inputs. They do not decode,
 * canonicalize or establish the server provenance required of the input values.
 */
function fieldsPresent(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === fields.length &&
    fields.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && "value" in descriptor;
    })
  );
}

function validTuple(value: ProducerTupleV1): boolean {
  if (!fieldsPresent(value, tupleFields)) return false;
  return (
    typeof value.enterpriseCommit === "string" &&
    commitPattern.test(value.enterpriseCommit) &&
    typeof value.upstreamCommit === "string" &&
    commitPattern.test(value.upstreamCommit) &&
    typeof value.codexCommit === "string" &&
    commitPattern.test(value.codexCommit) &&
    value.codexVersion === "0.153.0" &&
    value.gatewayProtocol === 4 &&
    value.nativeStateSchema === 15 &&
    value.nativeAgentSchema === 19 &&
    value.adapterSchema === 1 &&
    value.contextFormat === "completed-context-text-v1" &&
    value.nativeImportContract === 1 &&
    typeof value.nativeImportAdapterDigest === "string" &&
    digestPattern.test(value.nativeImportAdapterDigest) &&
    typeof value.artifactLedgerRef === "string" &&
    referencePattern.test(value.artifactLedgerRef)
  );
}

function validCheckpoint(value: CheckpointRefV1): boolean {
  if (!fieldsPresent(value, checkpointFields)) return false;
  for (const key of checkpointFields) {
    if (
      key === "producerTuple" ||
      key === "parentCheckpointId" ||
      key === "schemaVersion" ||
      key === "completionSequence" ||
      key === "byteLength" ||
      key === "itemCount"
    )
      continue;
    if (typeof value[key] !== "string" || !referencePattern.test(value[key])) return false;
  }
  return (
    value.schemaVersion === 1 &&
    integer(value.completionSequence, 1) &&
    integer(value.byteLength, 1, maxSnapshotBytes) &&
    integer(value.itemCount, 0, maxItems) &&
    (value.parentCheckpointId === null ||
      (typeof value.parentCheckpointId === "string" &&
        referencePattern.test(value.parentCheckpointId))) &&
    digestPattern.test(value.contentDigest) &&
    digestPattern.test(value.admittedConfigurationDigest) &&
    validTuple(value.producerTuple)
  );
}

function incompatible(
  scope: RecoveryComparisonScopeV1,
  reasonCode: Extract<RecoveryComparisonResultV1, { kind: "incompatible" }>["reasonCode"],
): RecoveryComparisonResultV1 {
  return Object.freeze({ scope, kind: "incompatible", reasonCode });
}

/** Compare the actual existing producer value, including its immutable artifact
 * ledger locator. The owner must separately resolve that ledger's complete material
 * digests; this function neither resolves a label nor verifies actual image bytes.
 */
export function compareRecoveryProducerTupleV1(
  expected: ProducerTupleV1 | null,
  candidate: ProducerTupleV1 | null,
): RecoveryComparisonResultV1 {
  if (expected == null || candidate == null)
    return incompatible("producer-tuple", "missing-descriptor");
  if (!validTuple(expected) || !validTuple(candidate))
    return incompatible("producer-tuple", "invalid-descriptor");
  if (tupleFields.some((key) => expected[key] !== candidate[key]))
    return incompatible("producer-tuple", "descriptor-mismatch");
  return Object.freeze({
    scope: "producer-tuple",
    kind: "compatible",
    reasonCode: "exact-descriptor-match",
  });
}

/** Compare an exact expected checkpoint reference with its decoded manifest and
 * unchanged canonical bytes. Caller-owned head selection and original decoding are
 * prerequisites. No checkpoint is selected, parsed, repaired, imported or published.
 */
export function compareRecoveryCheckpointV1(
  expected: CheckpointRefV1 | null,
  checkpoint: CheckpointRefV1 | null,
  canonicalBytes: Uint8Array,
): RecoveryComparisonResultV1 {
  if (expected == null || checkpoint == null)
    return incompatible("checkpoint", "missing-descriptor");
  if (!validCheckpoint(expected) || !validCheckpoint(checkpoint))
    return incompatible("checkpoint", "invalid-descriptor");
  if (
    checkpointFields.some((key) => key !== "producerTuple" && expected[key] !== checkpoint[key]) ||
    compareRecoveryProducerTupleV1(expected.producerTuple, checkpoint.producerTuple).kind !==
      "compatible"
  ) {
    return incompatible("checkpoint", "descriptor-mismatch");
  }
  if (
    !(canonicalBytes instanceof Uint8Array) ||
    canonicalBytes.byteLength !== checkpoint.byteLength ||
    createHash("sha256").update(canonicalBytes).digest("hex") !== checkpoint.contentDigest
  ) {
    return incompatible("checkpoint", "canonical-bytes-mismatch");
  }
  return Object.freeze({
    scope: "checkpoint",
    kind: "compatible",
    reasonCode: "exact-descriptor-match",
  });
}

/** Complete the available descriptor comparisons while preserving the missing
 * native declaration as unavailable. Exact equality alone cannot enable recovery.
 */
export function evaluateSameBuildRecoveryPreflightV1(
  input: Readonly<{
    expectedCheckpoint: CheckpointRefV1 | null;
    checkpoint: CheckpointRefV1 | null;
    candidateTuple: ProducerTupleV1 | null;
    canonicalBytes: Uint8Array;
  }>,
): SameBuildRecoveryPreflightResultV1 {
  const checkpoint = compareRecoveryCheckpointV1(
    input.expectedCheckpoint,
    input.checkpoint,
    input.canonicalBytes,
  );
  if (checkpoint.kind === "incompatible")
    return Object.freeze({
      scope: "same-build-recovery-preflight",
      kind: "incompatible",
      reasonCode: checkpoint.reasonCode,
    });
  const tuple = compareRecoveryProducerTupleV1(
    input.expectedCheckpoint!.producerTuple,
    input.candidateTuple,
  );
  if (tuple.kind === "incompatible")
    return Object.freeze({
      scope: "same-build-recovery-preflight",
      kind: "incompatible",
      reasonCode: tuple.reasonCode,
    });
  // TODO: Bind the original native owner's candidate/capability declaration and
  // accepted predecessor/target replacement contract before enabling full preflight.
  // Do not infer capabilities from method names, official binaries or matching tuples.
  return Object.freeze({
    scope: "same-build-recovery-preflight",
    kind: "unavailable",
    reasonCode: "native-candidate-descriptor-unavailable",
  });
}
