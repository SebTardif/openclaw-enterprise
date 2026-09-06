import {
  ACCEPTANCE_LEAVES_V1,
  type AcceptanceLeafIdV1,
  type ProducerReceiptV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-v1";
import { digestAcceptanceBytesV1 } from "@openclaw-enterprise/contracts/acceptance-companion-codec-v1";
import {
  encode,
  syntheticCompanion,
  syntheticReceipt,
} from "../acceptance-companion-v1/producer.ts";
import type {
  AllocationAttemptV1,
  AllocationRunInputV1,
  SelectedAllocationRunV1,
} from "../../../scripts/release-evidence/allocation-companion-v1/reader.ts";
export { encode };

/** Fictional selected inputs and source-class declarations; no execution takes place. */
export function fixture(
  ids: readonly AcceptanceLeafIdV1[] = Object.keys(ACCEPTANCE_LEAVES_V1) as AcceptanceLeafIdV1[],
): AllocationRunInputV1 {
  const companions = ids.map((id) => {
    const value = syntheticCompanion(id);
    value.companionId = `synthetic-${id}`;
    return value;
  });
  const reference = companions[0] ?? syntheticCompanion();
  const companionBytes = companions.map(encode);
  const receipts = companionBytes.map((bytes, index) => {
    const value = syntheticReceipt(bytes);
    value.receiptId = `synthetic-receipt-${index}`;
    if (value.execution.state === "observed")
      value.execution.executorRef = `synthetic-executor-${index}`;
    return value;
  });
  const selected: SelectedAllocationRunV1 = {
    schemaVersion: "selected-allocation-run/v1",
    source: "synthetic",
    runId: reference.runId,
    inputManifest: reference.inputManifest,
    demonstrationInputs: reference.demonstrationInputs,
    limits: reference.limits,
    tuple: reference.tuple,
    handoffs: reference.handoffs,
    plans: companions.map((companion, index) => ({
      leafId: companion.leaf.id,
      companion: digestAcceptanceBytesV1("companion", companionBytes[index]!),
      procedure: companion.procedure,
      procedureReview: digestAcceptanceBytesV1("review", encode({ synthetic: "procedure-review" })),
    })),
  };
  return {
    selection: encode(selected),
    companions: companionBytes,
    receipts: receipts.map(encode),
    attempts: receipts.map((receipt, index) =>
      encode(attempt(receipt, `synthetic-attempt-${index}`)),
    ),
    artifacts: [],
  };
}
export function attempt(receipt: ProducerReceiptV1, id: string): AllocationAttemptV1 {
  return {
    schemaVersion: "allocation-attempt/v1",
    attemptId: id,
    originalAttemptId: null,
    runId: receipt.runId,
    inputManifest: receipt.inputManifest,
    execution: structuredClone(receipt.execution),
    receiptIds: [receipt.receiptId],
  };
}
