import {
  type RuntimeResourceAccountingEnvelopeV1,
  type RuntimeResourceAccountingResultV1,
  type RuntimeResourceAccountingV1,
  type RuntimeResourceObservationV1,
  type RuntimeResourceVectorV1,
  type RuntimeWorkloadAccountingV1,
} from "@openclaw-enterprise/contracts/runtime-resource-accounting-v1";

/** These failures are checked by tsc and are never executed as a fixture. */
export function rejectMutation(
  envelope: RuntimeResourceAccountingEnvelopeV1,
  workload: RuntimeWorkloadAccountingV1,
  vector: RuntimeResourceVectorV1,
  result: RuntimeResourceAccountingResultV1,
): void {
  // @ts-expect-error Parsed envelope identity is immutable.
  envelope.envelopeVersion = 2;
  // @ts-expect-error Nested quantities are immutable too.
  vector.memoryBytes.limit = 1;
  // @ts-expect-error Contribution arrays cannot be extended after parsing.
  workload.contributions.push(workload.contributions[0]!);
  if (workload.phases.status === "supplied") {
    // @ts-expect-error Nested phase membership cannot be changed.
    workload.phases.value[0]!.active.push("another-process");
  }
  // @ts-expect-error A consumer cannot rewrite diagnostics.
  result.issues.push({ code: "missing-budget", path: "repositoryPreparation" });
  // @ts-expect-error Computed totals are immutable.
  result.totals.harness = null;
}

export function rejectUnsupportedClaims(
  envelope: RuntimeResourceAccountingEnvelopeV1,
  observation: RuntimeResourceObservationV1,
  port: RuntimeResourceAccountingV1,
): void {
  const inherited: RuntimeResourceAccountingEnvelopeV1["repositoryPreparation"] = {
    // @ts-expect-error Job inputs have no Harness fallback tag.
    status: "inherit-harness",
    ownerRef: "job-owner",
  };
  // @ts-expect-error A supplied workload requires its actual owned value.
  const missingValue: RuntimeResourceAccountingEnvelopeV1["repositoryPreparation"] = {
    status: "supplied",
    ownerRef: "job-owner",
  };
  const effective: RuntimeResourceAccountingEnvelopeV1["effectiveResources"] = {
    // @ts-expect-error Accounting does not supply an effective metering producer.
    status: "supplied",
    reason: "producer-port-unavailable",
  };
  // @ts-expect-error Complete accounting cannot establish admission authority.
  const admitted: "admitted" = port.validate(envelope).evidence;
  // @ts-expect-error Only existing named deadline purposes are accepted.
  port.deadlineBudget("unbounded", 1000, 1000);
  if (envelope.repositoryPreparation.status === "unavailable") {
    // @ts-expect-error Unavailable producer values cannot be read as supplied.
    void envelope.repositoryPreparation.value;
  }
  if (observation.status === "complete") {
    // @ts-expect-error Existing IFC observations retain observation-only eligibility.
    const authority: "admitted" = observation.eligibility;
    void authority;
  }
  void inherited;
  void missingValue;
  void effective;
  void admitted;
}
