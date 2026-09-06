import { isDeepStrictEqual } from "node:util";
import {
  parseRepositoryPreparationV1,
  parsePreparationReceiptExchangeV1,
} from "@openclaw-enterprise/contracts/repository-preparation-codec-v1";
import type {
  RepositoryPreparationCredentialPortV1,
  RepositoryPreparationReceiptPortV1,
  RuntimeEffectClockV1,
} from "@openclaw-enterprise/contracts/repository-preparation-v1";

/** Compile-only boundary example. Every protected owner, authority and clock is
 * injected; this module registers no service and creates no capability or Job.
 * The owner remains responsible for actual caller authentication, cancellation,
 * durable intent/inventory/audit and currentness at each effect/release boundary.
 */
export function checkedReservationProducer(
  owner: RepositoryPreparationCredentialPortV1,
): Pick<RepositoryPreparationCredentialPortV1, "reserveIssuanceV1"> {
  return {
    async reserveIssuanceV1(input, authority, bounds) {
      const request = parseRepositoryPreparationV1("reserve", input);
      // The actual accepting owner checks the opaque authority before/after await.
      // A parsed subject or observation must never replace that owner or handle.
      const result = await owner.reserveIssuanceV1(request, authority, bounds);
      parseRepositoryPreparationV1("exchangeUnion", {
        purpose: "candidate-repository-preparation",
        request,
        result,
      });
      return parseRepositoryPreparationV1("reservationResult", result);
    },
  };
}

/** This wrapper preserves the live producer's handle outside the JSON boundary.
 * A complete diagnostic is never sufficient to construct one. No exception is
 * translated into success, no old observation receives a new source timestamp,
 * and no unknown result causes a submission or another provider attempt.
 */
export function checkedReceiptProducer(
  owner: RepositoryPreparationReceiptPortV1,
  trustedEvaluationClock: () => RuntimeEffectClockV1,
): RepositoryPreparationReceiptPortV1 {
  return {
    async readReceiptV1(input, call) {
      const request = parseRepositoryPreparationV1("checkoutRequest", input);
      const result = await owner.readReceiptV1(request, call);
      if (result.status !== "complete") {
        const diagnostic = parsePreparationReceiptExchangeV1(
          request,
          result,
          trustedEvaluationClock(),
        );
        if (diagnostic.status === "complete") {
          throw new Error("Preparation diagnostic changed result kind.");
        }
        return diagnostic;
      }
      // The sole producer authenticates the actual handle and rechecks currentness
      // after the read's await. Parser checks cannot implement this step.
      const current = await owner.assertCurrentReceiptV1(request, result, call);
      const diagnostic = parsePreparationReceiptExchangeV1(
        request,
        current,
        trustedEvaluationClock(),
      );
      if (diagnostic.status !== "complete") return diagnostic;
      const original = parseRepositoryPreparationV1("checkoutReceipt", result.receipt);
      if (!isDeepStrictEqual(original, diagnostic.receipt)) {
        throw new Error("Preparation receipt changed during currentness check.");
      }
      // There is no await after the final owner check and value comparison.
      return { ...diagnostic, handle: result.handle };
    },
    async assertCurrentReceiptV1(input, result, call) {
      const request = parseRepositoryPreparationV1("checkoutRequest", input);
      const current = await owner.assertCurrentReceiptV1(request, result, call);
      return parsePreparationReceiptExchangeV1(request, current, trustedEvaluationClock());
    },
  };
}
