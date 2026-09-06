import {
  parseRuntimeEffectsV1,
  parseRuntimeEffectsResponseV1,
  runtimeEffectEvidenceFreshV1,
  type RuntimeObservationInputV1,
  type RuntimeObservationResultV1,
  type RuntimeEvidenceProvenanceV1,
} from "@openclaw-enterprise/contracts/runtime-effects-v1";
import { RUNTIME_AUTHORITY_LIMITS_V1 } from "@openclaw-enterprise/contracts/runtime-resource-accounting-v1";
import { snapshotResourceInput } from "./resources/resource-normalization.ts";

export interface RuntimeResourceDiagnosticInput {
  readonly expected: RuntimeObservationInputV1;
  readonly result: RuntimeObservationResultV1 | null;
  readonly now: string;
  readonly previousEvidenceVersion: number | null;
  readonly maxAgeMs?: number;
  /** Supplied historical outcome only: cancellation after possible submission
   * stays unknown. The projector never initiates or settles an effect. */
  readonly operation: { readonly status: "none" | "not-submitted" | "unknown" };
}
export type RuntimeResourceDiagnosticReason =
  | Exclude<RuntimeObservationResultV1, { status: "complete" }>["reasonCode"]
  | "observation-unavailable"
  | "invalid-diagnostic-input"
  | "evidence-out-of-order"
  | "clock-regression"
  | "profile-observation-only"
  | "profile-mismatch";
export interface RuntimeResourceDiagnosticClock {
  readonly kind:
    | "observation"
    | "owner-chain"
    | "execution-correspondence"
    | "delivered-profile"
    | "effective-profile";
  readonly evidenceVersion: number;
  readonly sourceObservedAt: string;
  readonly receivedAt: string;
  readonly validUntil: string;
  readonly uncertaintyMs: number;
  readonly ageMs: number | null;
}
export interface RuntimeResourceDiagnostics {
  readonly status: "observed" | "unavailable" | "invalid" | "stale" | "out-of-order";
  readonly phase:
    | "runtime-observed"
    | "observation-unavailable"
    | "observation-invalid"
    | "observation-incomplete"
    | "observation-ambiguous"
    | "observation-unknown";
  readonly reason: RuntimeResourceDiagnosticReason;
  readonly observationStatus: RuntimeObservationResultV1["status"] | null;
  readonly component: "gateway" | "harness" | null;
  readonly ageMs: number | null;
  readonly clocks: readonly RuntimeResourceDiagnosticClock[];
  readonly profiles: {
    readonly desired: { readonly version: number; readonly digest: string };
    readonly delivered: { readonly version: number; readonly digest: string };
    readonly effective: { readonly version: number; readonly digest: string };
    readonly match: boolean;
  } | null;
  readonly effectOutcome: "none" | "not-submitted" | "unknown";
  readonly effectiveResources: "unavailable";
  readonly authority: "none";
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function invalid(): never {
  throw new Error("Invalid resource diagnostic input.");
}
const initial = (): RuntimeResourceDiagnostics => ({
  status: "invalid",
  phase: "observation-invalid",
  reason: "invalid-diagnostic-input",
  observationStatus: null,
  component: null,
  ageMs: null,
  clocks: [],
  profiles: null,
  effectOutcome: "unknown",
  effectiveResources: "unavailable",
  authority: "none",
});
/** A closed pure data projection. Original IFC request/result correlation and
 * freshness checks remain canonical; no observation or accepting authority is
 * manufactured from a successful parse or caller-supplied evaluation time. */
export function projectRuntimeResourceDiagnostics(
  input: RuntimeResourceDiagnosticInput,
): RuntimeResourceDiagnostics {
  try {
    const raw = snapshotResourceInput(input) as RuntimeResourceDiagnosticInput;
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).some(
        (key) =>
          ![
            "expected",
            "result",
            "now",
            "previousEvidenceVersion",
            "maxAgeMs",
            "operation",
          ].includes(key),
      ) ||
      typeof raw.now !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw.now)
    )
      invalid();
    const now = Date.parse(raw.now);
    if (!Number.isFinite(now) || new Date(now).toISOString() !== raw.now) invalid();
    const prior = raw.previousEvidenceVersion;
    if (prior !== null && (!Number.isSafeInteger(prior) || prior < 1)) invalid();
    const maxAge =
      raw.maxAgeMs === undefined ? RUNTIME_AUTHORITY_LIMITS_V1.observationMaxAgeMs : raw.maxAgeMs;
    if (
      !Number.isSafeInteger(maxAge) ||
      maxAge < 0 ||
      maxAge > RUNTIME_AUTHORITY_LIMITS_V1.observationMaxAgeMs
    )
      invalid();
    if (
      !raw.operation ||
      typeof raw.operation !== "object" ||
      Array.isArray(raw.operation) ||
      Object.keys(raw.operation).length !== 1 ||
      !["none", "not-submitted", "unknown"].includes(raw.operation.status)
    )
      invalid();
    const expected = parseRuntimeEffectsV1("observationInput", raw.expected);
    const base = {
      ...initial(),
      component: expected.target.component,
      effectOutcome: raw.operation.status,
    };
    if (raw.result === null)
      return frozen({
        ...base,
        status: "unavailable",
        phase: "observation-unavailable",
        reason: "observation-unavailable",
      });
    const result = parseRuntimeEffectsResponseV1("observe", expected, raw.result);
    if (result.status !== "complete") {
      let phase: RuntimeResourceDiagnostics["phase"] = "observation-incomplete";
      if (result.status === "ambiguous") phase = "observation-ambiguous";
      if (result.status === "unknown") phase = "observation-unknown";
      return frozen({
        ...base,
        status: "unavailable",
        phase,
        reason: result.reasonCode,
        observationStatus: result.status,
      });
    }
    const evidence: readonly [
      RuntimeResourceDiagnosticClock["kind"],
      RuntimeEvidenceProvenanceV1,
    ][] = [
      ["observation", result.observation],
      ["owner-chain", result.ownerChainEvidence],
      ["execution-correspondence", result.executionCorrespondenceEvidence],
      ["delivered-profile", result.profile.delivered.evidence],
      ["effective-profile", result.profile.effective.evidence],
    ];
    const clocks = evidence.map(([kind, value]): RuntimeResourceDiagnosticClock => ({
      kind,
      evidenceVersion: value.evidenceVersion,
      ...value.clock,
      ageMs:
        now >= Date.parse(value.clock.sourceObservedAt)
          ? now - Date.parse(value.clock.sourceObservedAt)
          : null,
    }));
    const { desired, delivered, effective } = result.profile;
    const profileMatch =
      desired.profileRef === delivered.profileRef &&
      desired.profileRef === effective.profileRef &&
      desired.version === delivered.version &&
      desired.version === effective.version &&
      desired.digest === delivered.digest &&
      desired.digest === effective.digest;
    const profiles = {
      desired: { version: desired.version, digest: desired.digest },
      delivered: { version: delivered.version, digest: delivered.digest },
      effective: { version: effective.version, digest: effective.digest },
      match: profileMatch,
    };
    const details = {
      ...base,
      observationStatus: result.status,
      phase: "runtime-observed" as const,
      clocks,
      ageMs: clocks[0]!.ageMs,
      profiles,
    };
    if (clocks.some((clock) => clock.ageMs === null || Date.parse(clock.receivedAt) > now))
      return frozen({ ...details, status: "stale", reason: "clock-regression" });
    if (prior !== null && result.observation.evidenceVersion <= prior)
      return frozen({ ...details, status: "out-of-order", reason: "evidence-out-of-order" });
    if (
      evidence.some(
        ([kind, value]) =>
          !runtimeEffectEvidenceFreshV1(
            value,
            raw.now,
            kind === "observation" ? prior : null,
            maxAge,
          ),
      )
    )
      return frozen({ ...details, status: "stale", reason: "evidence-stale" });
    return frozen({
      ...details,
      status: "observed",
      reason: profileMatch ? "profile-observation-only" : "profile-mismatch",
    });
  } catch {
    return frozen(initial());
  }
}
