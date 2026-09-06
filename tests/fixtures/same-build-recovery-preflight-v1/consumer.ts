import type {
  CheckpointRefV1,
  ProducerTupleV1,
} from "@openclaw-enterprise/contracts/completed-context-v1";
import {
  compareRecoveryProducerTupleV1,
  compareRecoveryCheckpointV1,
  evaluateSameBuildRecoveryPreflightV1,
} from "@openclaw-enterprise/occ/persistence/same-build-recovery-preflight-v1";

export function consume(
  expected: CheckpointRefV1,
  decoded: CheckpointRefV1,
  candidate: ProducerTupleV1,
  bytes: Uint8Array,
): string {
  const tuple = compareRecoveryProducerTupleV1(expected.producerTuple, candidate);
  const checkpoint = compareRecoveryCheckpointV1(expected, decoded, bytes);
  const preflight = evaluateSameBuildRecoveryPreflightV1({
    expectedCheckpoint: expected,
    checkpoint: decoded,
    candidateTuple: candidate,
    canonicalBytes: bytes,
  });
  // @ts-expect-error Inert comparisons have no authorization or ready property.
  const ready: boolean = preflight.ready;
  void ready;
  // This fails if any result variant ever admits a compatible full preflight.
  const noFullSuccess: Extract<
    ReturnType<typeof evaluateSameBuildRecoveryPreflightV1>["kind"],
    "compatible"
  > extends never
    ? true
    : false = true;
  void noFullSuccess;
  // @ts-expect-error A tuple omitting the material artifact ledger is not a producer tuple.
  compareRecoveryProducerTupleV1(expected.producerTuple, { codexVersion: "0.153.0" });
  return `${tuple.kind}/${checkpoint.kind}/${preflight.kind}`;
}
