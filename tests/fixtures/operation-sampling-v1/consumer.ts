import type {
  AcceptanceDigestV1,
  ProducerReceiptV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-v1";
import {
  bindProducerReceiptV1,
  decodeProducerReceiptV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-codec-v1";
import {
  adaptSampleJournalV1,
  type JournalReceiptDeclarationV1,
} from "../../../scripts/release-evidence/operation-sampling-v1/sampling.ts";
import { adaptInstallerJournalV1 } from "../../../scripts/release-evidence/operation-sampling-v1/installer.ts";

/** A separate strict consumer uses actual exported decoders and domain-specific identities. */
export function consumeSample(
  planBytes: Uint8Array,
  journalBytes: Uint8Array,
  companionBytes: Uint8Array,
  attemptId: string,
  declaration: JournalReceiptDeclarationV1,
) {
  const adapted = adaptSampleJournalV1({
    planBytes,
    journalBytes,
    companionBytes,
    attemptId,
    declaration,
  });
  if (!adapted.ok) return adapted;
  const result: AcceptanceDigestV1<"result"> = adapted.journalResult;
  const evidence: AcceptanceDigestV1<"evidence"> = adapted.journalEvidence;
  return { binding: bindProducerReceiptV1(companionBytes, adapted.receiptBytes), result, evidence };
}
export function consumeInstaller(
  journalBytes: Uint8Array,
  companionBytes: Uint8Array,
  attemptId: string,
  declaration: JournalReceiptDeclarationV1,
) {
  const adapted = adaptInstallerJournalV1({ journalBytes, companionBytes, attemptId, declaration });
  if (!adapted.ok) return adapted;
  const receipt = decodeProducerReceiptV1(adapted.receiptBytes);
  return receipt;
}
function typeBoundaries(
  result: AcceptanceDigestV1<"result">,
  execution: ProducerReceiptV1["execution"],
) {
  // @ts-expect-error Result bytes cannot occupy the evidence digest domain.
  const evidence: AcceptanceDigestV1<"evidence"> = result;
  if (execution.state === "end-unavailable") {
    // @ts-expect-error The current unavailable-end branch has no invented duration.
    const duration: number = execution.monotonicDurationMs;
    return [evidence, duration];
  }
  return [];
}
void typeBoundaries;
