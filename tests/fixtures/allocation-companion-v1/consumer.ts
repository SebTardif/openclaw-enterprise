import type {
  AssertionCompanionV1,
  ProducerReceiptV1,
  AcceptanceDigestV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-v1";
import {
  decodeAssertionCompanionV1,
  decodeProducerReceiptV1,
  bindProducerReceiptV1,
  digestAcceptanceBytesV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-codec-v1";
import {
  readAllocationRunV1,
  type AllocationRunInputV1,
} from "../../../scripts/release-evidence/allocation-companion-v1/reader.ts";
import {
  buildAllocationReportV1,
  encodeAllocationReportV1,
} from "../../../scripts/release-evidence/allocation-companion-v1/report.ts";

export function consumeOriginalBytes(
  input: AllocationRunInputV1,
  companion: Uint8Array,
  receipt: Uint8Array,
) {
  const decodedCompanion = decodeAssertionCompanionV1(companion);
  const decodedReceipt = decodeProducerReceiptV1(receipt);
  const joined = bindProducerReceiptV1(companion, receipt);
  const identity: AcceptanceDigestV1<"input"> = digestAcceptanceBytesV1("input", input.selection);
  if (decodedCompanion.ok && decodedReceipt.ok) {
    const leaf: AssertionCompanionV1["leaf"]["id"] = decodedCompanion.value.leaf.id;
    const outcome: ProducerReceiptV1["outcome"] = decodedReceipt.value.outcome;
    const authentication: "unverified" = decodedReceipt.authentication;
    const report = buildAllocationReportV1(input);
    return {
      identity,
      leaf,
      outcome,
      authentication,
      joined,
      read: readAllocationRunV1(input),
      bytes: encodeAllocationReportV1(report),
    };
  }
  return { identity, joined };
}
