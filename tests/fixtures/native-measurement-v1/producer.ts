import type {
  NativeMeasurementProfileV1,
  NativeMeasurementResultsV1,
} from "@openclaw-enterprise/contracts/native-measurement-v1";
import { nativeMeasurementProfileDigestV1 } from "@openclaw-enterprise/contracts/native-measurement-codec-v1";

/** Definition fixture only. Independently supplied expectations are never derived from results. */
export function produceFixture(profile: NativeMeasurementProfileV1): NativeMeasurementResultsV1 {
  if (profile.evidenceKind !== "fixture") throw new Error("fixture-only");
  const pin = nativeMeasurementProfileDigestV1(profile);
  if (pin.kind !== "valid") throw new Error("invalid-profile");
  return {
    format: "native-measurement-results-v1",
    profileDigest: pin.value,
    subject: structuredClone(profile.subject),
    evidenceKind: "fixture",
    discovered: profile.cases.map((c) => c.id),
    selected: profile.cases.map((c) => c.id),
    records: profile.cases.map((c) => {
      if (c.applicability === "not-applicable")
        return { id: c.id, state: "skip", reason: "not-applicable" };
      const samples: Extract<
        NativeMeasurementResultsV1["records"][number],
        { state: "samples" }
      >["samples"] = [];
      for (let cycle = 0; cycle < c.cycles; cycle++) {
        for (const phase of ["warmup", "measured"] as const) {
          for (
            let index = 0;
            index < (phase === "warmup" ? c.warmupPerCycle : c.samplesPerCycle);
            index++
          ) {
            const common = {
              cycle,
              phase,
              index,
              startUs: 1_000_000,
              endUs: 1_001_000,
              clockOriginRef: profile.clock.originRef,
              evidenceRef: `fixture:${c.id}/${cycle}/${phase}/${index}`,
              workload: {
                inputUtf8Bytes: profile.workload.inputUtf8Bytes,
                resultUtf8Bytes: profile.workload.resultUtf8Bytes,
                outputCaptureBytes: 4096,
                overflow: false,
              },
            };
            if (c.id === "cancel-retention" || c.id === "reconnect-retention") {
              const resources = {
                rssBytes: 4096,
                fileDescriptors: 2,
                sockets: 1,
                listeners: 1,
                timers: 1,
                childProcesses: 1,
              };
              samples.push({
                ...common,
                state: "resources",
                settlement: "observed",
                before: { ...resources },
                after: { ...resources },
                settledAtUs: 1_000_500,
              });
            } else
              samples.push({
                ...common,
                state: "latency",
                endpoint: "observed",
                domainOutcome: "confirmed",
              });
          }
        }
      }
      return { id: c.id, state: "samples", samples };
    }),
  };
}
// Compile-time contract rejection supplements runtime negative vectors.
// @ts-expect-error Existing tuple stays closed at version 0.153.0.
const unsupportedNative: NativeMeasurementProfileV1["subject"]["producer"]["codexVersion"] =
  "latest";
void unsupportedNative;
