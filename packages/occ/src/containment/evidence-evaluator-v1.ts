import { types } from "node:util";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { sha256Hex } from "@openclaw-enterprise/utils";
import {
  decodeContainmentControlInputV1,
  decodeContainmentControlExchangeV1,
} from "@openclaw-enterprise/contracts/containment-controls-codec-v1";
import {
  CONTAINMENT_CONTROLS_LIMITS_V1,
  type ContainmentControlInputV1,
  type ContainmentControlResultV1,
  type ImmutableContainmentControlV1,
} from "@openclaw-enterprise/contracts/containment-controls-v1";
import {
  runtimeEffectEvidenceFreshV1,
  type RuntimeEvidenceProvenanceV1,
} from "@openclaw-enterprise/contracts/runtime-effects-v1";
import {
  parseRuntimeAuthorityV1,
  type ResolveAssignmentRequestV1,
  type ResolveAssignmentResultV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";

/** Pure supplied-evidence comparison. No result authenticates a producer, persists
 * denial, or grants a current purpose. The accepting service owns those checks. */
export const CONTAINMENT_EVIDENCE_LIMITS_V1 = Object.freeze({
  ...CONTAINMENT_CONTROLS_LIMITS_V1,
  maxSubjects: 32,
  maxWatermarksPerSubject: 96,
  maxFindings: 64,
  maxStateBytes: 1_048_576,
  maxStateNodes: 65_536,
});

const limits = CONTAINMENT_EVIDENCE_LIMITS_V1;
const object = <P extends import("typebox").TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const ref = Type.String({ minLength: 1, maxLength: 512 });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const timestamp = Type.String({ minLength: 24, maxLength: 24 });
const clockSchema = object({ now: timestamp, monotonicMs: counter });
const watermarkSchema = object({
  slot: ref,
  producerRef: ref,
  epochRef: Type.Union([Type.Null(), ref]),
  epochVersion: counter,
  version: counter,
  sourceObservedAt: timestamp,
  fingerprint: hash,
});
const subjectSchema = object({
  key: hash,
  assignmentKey: hash,
  watermarks: Type.Array(watermarkSchema, { maxItems: limits.maxWatermarksPerSubject }),
  blocked: Type.Array(ref, { maxItems: limits.maxWatermarksPerSubject, uniqueItems: true }),
});
const stateSchema = object({
  schemaVersion: Type.Literal(1),
  clock: Type.Union([Type.Null(), clockSchema]),
  subjects: Type.Array(subjectSchema, { maxItems: limits.maxSubjects }),
  retiredAssignments: Type.Array(hash, { maxItems: limits.maxSubjects, uniqueItems: true }),
});

/** The accepting owner supplies a trusted clock and retains this state serially
 * with the original evidence. A deserialized state never establishes custody,
 * authenticates an epoch, or replaces the original authority's watermarks. */
export type ContainmentEvidenceClockV1 = Static<typeof clockSchema>;
export type ContainmentEvidenceStateV1 = Static<typeof stateSchema>;
type Watermark = Static<typeof watermarkSchema>;
type Subject = Static<typeof subjectSchema>;
type Immutable<T> = ImmutableContainmentControlV1<T>;

export type ContainmentEvidenceReasonV1 =
  | "invalid-input"
  | "invalid-state"
  | "clock-rollback"
  | "evidence-stale"
  | "evidence-conflict"
  | "evidence-reordered"
  | "producer-changed"
  | "epoch-invalid"
  | "missing-evidence"
  | "policy-mismatch"
  | "control-ineffective"
  | "control-unknown"
  | "authority-denied"
  | "authority-unknown"
  | "purpose-mismatch"
  | "unsupported-purpose"
  | "target-mismatch"
  | "retired-assignment"
  | "recovery-pending"
  | "state-capacity";
export interface ContainmentEvidenceFindingV1 {
  readonly reasonCode: ContainmentEvidenceReasonV1;
  readonly slot: string | null;
  readonly evidenceRef: string | null;
  readonly evidenceVersion: number | null;
}
export interface ContainmentEvidenceEvaluationV1 {
  readonly scope: "comparison-only";
  readonly decision: "satisfied" | "denied" | "unknown";
  readonly subjectKey: string | null;
  readonly findings: readonly ContainmentEvidenceFindingV1[];
  /** Null means invalid retained state; it is never permission to discard history. */
  readonly nextState: Immutable<ContainmentEvidenceStateV1> | null;
}
export interface ContainmentEvidenceEvaluationInputV1 {
  readonly expected: Immutable<ContainmentControlInputV1>;
  readonly observation: Immutable<ContainmentControlResultV1>;
  readonly authorityRequest: Immutable<ResolveAssignmentRequestV1>;
  readonly authorityResult: Immutable<ResolveAssignmentResultV1>;
  readonly clock: ContainmentEvidenceClockV1;
}

function invalid(): never {
  throw new Error("Invalid containment comparison data.");
}
function freeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}
/** Snapshot without getters, proxies, inherited data, symbols or coercion. */
function snapshot(input: unknown, maxBytes: number, maxNodes: number = limits.maxNodes): unknown {
  let remaining = maxNodes;
  let bytes = maxBytes;
  const visit = (value: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > limits.maxDepth) invalid();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) invalid();
      return value;
    }
    if (typeof value === "string") {
      if (/[\ud800-\udfff]/u.test(value)) invalid();
      bytes -= Buffer.byteLength(value);
      if (bytes < 0) invalid();
      return value;
    }
    if (typeof value !== "object" || types.isProxy(value)) invalid();
    const proto = Object.getPrototypeOf(value);
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value)) {
      if (proto !== Array.prototype || value.length > 256 || keys.length !== value.length + 1)
        invalid();
      return Array.from({ length: value.length }, (_, i) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
        return visit(descriptor.value, depth + 1);
      });
    }
    if (proto !== null && proto !== Object.prototype) invalid();
    if (keys.length > limits.maxContainerEntries) invalid();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key))
        invalid();
      visit(key, depth + 1);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
      result[key] = visit(descriptor.value, depth + 1);
    }
    return result;
  };
  const result = visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) invalid();
  return result;
}
function canonical(value: unknown, omitReceipts = false): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, omitReceipts)).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([key]) => !omitReceipts || key !== "receivedAt")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child, omitReceipts)}`)
    .join(",")}}`;
}
function equal(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
function time(value: string): number {
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result) || result < 0 || new Date(result).toISOString() !== value)
    invalid();
  return result;
}
function decodeState(input: unknown): ContainmentEvidenceStateV1 {
  const value = snapshot(input, limits.maxStateBytes, limits.maxStateNodes);
  if (!Check(stateSchema, value)) invalid();
  if (value.clock) time(value.clock.now);
  if (new Set(value.subjects.map((s) => s.key)).size !== value.subjects.length) invalid();
  for (const subject of value.subjects) {
    if (new Set(subject.watermarks.map((m) => m.slot)).size !== subject.watermarks.length)
      invalid();
    for (const mark of subject.watermarks) {
      time(mark.sourceObservedAt);
      if ((mark.epochRef === null) !== (mark.epochVersion === 0)) invalid();
    }
    if (subject.blocked.some((slot) => !subject.watermarks.some((m) => m.slot === slot))) invalid();
  }
  return value;
}
export function emptyContainmentEvidenceStateV1(): Immutable<ContainmentEvidenceStateV1> {
  return freeze({ schemaVersion: 1, clock: null, subjects: [], retiredAssignments: [] });
}

/** One pure, finite transition over original supplied evidence. The caller must
 * independently establish the complete admitted requirements, producer authenticity,
 * current purpose/account/turn/resource authority and protected state/clock custody.
 * Satisfied means only that these supplied values agree within their stated bounds. */
export function evaluateContainmentEvidenceV1(
  input: ContainmentEvidenceEvaluationInputV1,
  previous: Immutable<ContainmentEvidenceStateV1>,
): ContainmentEvidenceEvaluationV1 {
  let state: ContainmentEvidenceStateV1;
  const result = (
    decision: ContainmentEvidenceEvaluationV1["decision"],
    findings: ContainmentEvidenceFindingV1[],
    nextState: ContainmentEvidenceStateV1 | null,
    subjectKey: string | null = null,
  ): ContainmentEvidenceEvaluationV1 =>
    freeze({
      scope: "comparison-only",
      decision,
      findings,
      nextState,
      subjectKey,
    });
  const finding = (reasonCode: ContainmentEvidenceReasonV1): ContainmentEvidenceFindingV1 => ({
    reasonCode,
    slot: null,
    evidenceRef: null,
    evidenceVersion: null,
  });
  try {
    state = decodeState(previous);
  } catch {
    return result("unknown", [finding("invalid-state")], null);
  }
  let value: ContainmentEvidenceEvaluationInputV1;
  let expected: ContainmentControlInputV1;
  let observation: ContainmentControlResultV1;
  let authorityRequest: ResolveAssignmentRequestV1;
  let authority: ResolveAssignmentResultV1;
  let now: number;
  try {
    value = snapshot(input, 4 * limits.maxInputBytes) as ContainmentEvidenceEvaluationInputV1;
    if (
      !equal(Object.keys(value).sort(), [
        "authorityRequest",
        "authorityResult",
        "clock",
        "expected",
        "observation",
      ])
    )
      invalid();
    const decodedInput = decodeContainmentControlInputV1(value.expected);
    if (decodedInput.kind !== "valid") invalid();
    const decoded = decodeContainmentControlExchangeV1(decodedInput.value, value.observation);
    if (decoded.kind !== "valid") invalid();
    expected = decodedInput.value as ContainmentControlInputV1;
    observation = decoded.value as ContainmentControlResultV1;
    authorityRequest = parseRuntimeAuthorityV1("resolveRequest", value.authorityRequest);
    authority = parseRuntimeAuthorityV1("resolveResult", value.authorityResult);
    if (!Check(clockSchema, value.clock)) invalid();
    now = time(value.clock.now);
  } catch {
    return result("unknown", [finding("invalid-input")], state);
  }
  try {
    if (
      state.clock &&
      (now < time(state.clock.now) || value.clock.monotonicMs < state.clock.monotonicMs)
    )
      return result("unknown", [finding("clock-rollback")], state);
    const target = expected.runtime.target;
    const assignmentKey = sha256Hex(
      canonical({
        installationId: target.installationId,
        namespaceId: target.namespaceId,
        agentId: target.agentId,
        assignmentRef: target.assignmentRef,
      }),
    );
    const subjectKey = sha256Hex(
      canonical({
        target,
        binding: expected.runtime.binding,
        profile: expected.containmentProfile,
        controls: [...expected.requiredControls].sort((a, b) => (a.control < b.control ? -1 : 1)),
      }),
    );
    const existing = state.subjects.find((s) => s.key === subjectKey);
    const subject: Subject = existing ?? {
      key: subjectKey,
      assignmentKey,
      watermarks: [],
      blocked: [],
    };
    const findings: ContainmentEvidenceFindingV1[] = [];
    const marks = new Map(subject.watermarks.map((m) => [m.slot, m]));
    const advanced = new Set<string>();
    const failures = new Set<string>();
    let denied = false;
    let ordered = true;
    let fresh = true;
    let terminal = false;
    const add = (
      reasonCode: ContainmentEvidenceReasonV1,
      slot: string | null = null,
      reference: string | null = null,
      version: number | null = null,
      explicit = false,
    ) => {
      findings.push({ reasonCode, slot, evidenceRef: reference, evidenceVersion: version });
      denied ||= explicit;
    };
    const fail = (reason: ContainmentEvidenceReasonV1, slot: string, explicit = false) => {
      add(reason, slot, null, null, explicit);
      failures.add(slot);
    };
    const freshClock = (source: string, until: string, uncertainty: number): boolean =>
      uncertainty <= expected.maxUncertaintyMs &&
      time(source) <= now + uncertainty &&
      now - time(source) + uncertainty <= expected.maxAgeMs &&
      now + uncertainty <= time(until);
    const remember = (
      slot: string,
      producerRef: string,
      epoch: { epochRef: string; epochVersion: number } | null,
      version: number,
      sourceObservedAt: string,
      content: unknown,
    ) => {
      const mark: Watermark = {
        slot,
        producerRef,
        epochRef: epoch?.epochRef ?? null,
        epochVersion: epoch?.epochVersion ?? 0,
        version,
        sourceObservedAt,
        fingerprint: sha256Hex(canonical(content, true)),
      };
      const prior = marks.get(slot);
      let reason: ContainmentEvidenceReasonV1 | null = null;
      if (prior) {
        if (prior.producerRef !== producerRef) reason = "producer-changed";
        else if (mark.epochVersion < prior.epochVersion) reason = "evidence-reordered";
        else if ((mark.epochVersion === prior.epochVersion) !== (mark.epochRef === prior.epochRef))
          reason = "epoch-invalid";
        else if (time(sourceObservedAt) < time(prior.sourceObservedAt))
          reason = "evidence-reordered";
        else if (mark.epochVersion === prior.epochVersion && version < prior.version)
          reason = "evidence-reordered";
        else if (
          mark.epochVersion === prior.epochVersion &&
          version === prior.version &&
          mark.fingerprint !== prior.fingerprint
        )
          reason = "evidence-conflict";
        if (!reason && (mark.epochVersion > prior.epochVersion || version > prior.version))
          advanced.add(slot);
      } else advanced.add(slot);
      if (reason) {
        add(reason, slot, null, version, true);
        ordered = false;
      } else marks.set(slot, mark);
    };
    const provenance = (
      slot: string,
      evidence: RuntimeEvidenceProvenanceV1,
      epoch: { epochRef: string; epochVersion: number } | null = null,
      content: unknown = evidence,
    ) => {
      if (
        !runtimeEffectEvidenceFreshV1(evidence, value.clock.now, null, expected.maxAgeMs) ||
        evidence.clock.uncertaintyMs > expected.maxUncertaintyMs
      ) {
        add("evidence-stale", slot, evidence.evidenceRef, evidence.evidenceVersion);
        fresh = false;
      }
      remember(
        slot,
        evidence.producerRef,
        epoch,
        evidence.evidenceVersion,
        evidence.clock.sourceObservedAt,
        content,
      );
    };

    if (state.retiredAssignments.includes(assignmentKey))
      add("retired-assignment", null, null, null, true);
    if (
      authority.requestRef !== authorityRequest.requestRef ||
      ("purpose" in authority && authority.purpose !== authorityRequest.purpose)
    )
      add("purpose-mismatch", null, null, null, true);
    if (
      !["installationId", "namespaceId", "agentId", "assignmentRef"].every((key) =>
        equal(
          authorityRequest[key as keyof typeof authorityRequest],
          target[key as keyof typeof target],
        ),
      )
    )
      add("target-mismatch", null, null, null, true);
    if (["cleanup", "completed-context-restore"].includes(authorityRequest.purpose))
      add("unsupported-purpose", null, null, null, true);
    // Correlation failures have no usable original authority and cannot advance state.
    if (
      findings.some((f) =>
        ["purpose-mismatch", "target-mismatch", "unsupported-purpose"].includes(f.reasonCode),
      )
    )
      return result("denied", findings, state, subjectKey);
    const authoritySlot = `authority:${authorityRequest.purpose}`;
    if (
      time(authority.evaluatedAt) > now ||
      now - time(authority.evaluatedAt) > expected.maxAgeMs ||
      ("validUntil" in authority && now > time(authority.validUntil))
    ) {
      add("evidence-stale", authoritySlot);
      fresh = false;
    }
    const { requestRef: _requestRef, ...authorityProof } = authority;
    remember(
      authoritySlot,
      "original-runtime-authority",
      null,
      time(authority.evaluatedAt) + 1,
      authority.evaluatedAt,
      authorityProof,
    );
    if (
      authority.result === "current" ||
      (authority.result === "candidate-eligible" && "snapshot" in authority)
    ) {
      if (
        !equal(authority.snapshot.target, target) ||
        !equal(authority.snapshot.binding, expected.runtime.binding)
      )
        add("target-mismatch", authoritySlot, null, null, true);
      if (
        "identityEvidence" in authority &&
        authority.identityEvidence.identityProfileRef !== authority.snapshot.identityProfileRef
      )
        add("target-mismatch", `${authoritySlot}:identity-profile`, null, null, true);
      if (
        authority.purpose === "readiness-probe" &&
        authority.peerIdentityEvidence.identityProfileRef !== authority.peer.identityProfileRef
      )
        add("target-mismatch", `${authoritySlot}:peer-identity-profile`, null, null, true);
      if (authority.result === "candidate-eligible") {
        if (
          !("operationRef" in authorityRequest) ||
          authorityRequest.operationRef !== authority.operationRef ||
          authorityRequest.expectedResponsibilityVersion !== authority.responsibilityVersion
        )
          add("purpose-mismatch", authoritySlot, null, null, true);
      }
      // Compare every original source clock in this purpose branch, including both
      // readiness identities. This traversal cannot create or relax a branch.
      const sources = (node: unknown, slot: string): void => {
        if (node === null || typeof node !== "object") return;
        const record = node as Record<string, unknown>;
        if ("sourceObservedAt" in record) {
          const source = record as {
            reference: string;
            version: number;
            sourceObservedAt: string;
            validUntil: string;
            uncertaintyMs: number;
          };
          if (!freshClock(source.sourceObservedAt, source.validUntil, source.uncertaintyMs)) {
            add("evidence-stale", slot, source.reference, source.version);
            fresh = false;
          }
          remember(
            slot,
            "original-runtime-authority",
            null,
            source.version,
            source.sourceObservedAt,
            source,
          );
        } else for (const [key, child] of Object.entries(record)) sources(child, `${slot}:${key}`);
      };
      sources(authority, authoritySlot);
      remember(
        `${authoritySlot}:assignment`,
        "original-runtime-authority",
        null,
        authority.snapshot.assignmentRecordVersion,
        "1970-01-01T00:00:00.000Z",
        authority.snapshot,
      );
      if (authority.result === "current")
        remember(
          `${authoritySlot}:selection`,
          "original-runtime-authority",
          null,
          authority.selectionVersion,
          "1970-01-01T00:00:00.000Z",
          { target, lifecycleGeneration: authority.lifecycleGeneration },
        );
    } else {
      const explicit = authority.result === "not-current" || authority.result === "not-visible";
      fail(explicit ? "authority-denied" : "authority-unknown", authoritySlot, explicit);
      terminal =
        authority.result === "not-current" &&
        ["assignment-retired", "assignment-replaced"].includes(authority.reasonCode);
    }
    if (findings.some((f) => ["target-mismatch", "purpose-mismatch"].includes(f.reasonCode)))
      return result("denied", findings, state, subjectKey);
    // A current, correlated original retirement survives stale observer evidence.
    // It is still comparison state; only the original sink writes durable denial.
    const retainRetirement = terminal && ordered && fresh;
    if (observation.status !== "observed") add("missing-evidence");
    else {
      const { input: _runtimeInput, ...runtimeProof } = observation.runtimeObservation;
      provenance("projection", observation.observation, observation.cursor, {
        observation: observation.observation,
        cursor: observation.cursor,
        runtime: runtimeProof,
        controls: [...observation.controls].sort((a, b) => (a.control < b.control ? -1 : 1)),
      });
      const runtime = observation.runtimeObservation;
      if (runtime.status !== "complete") fail("missing-evidence", "projection");
      else {
        provenance("runtime:observation", runtime.observation, null, runtimeProof);
        provenance("runtime:owner-chain", runtime.ownerChainEvidence);
        provenance("runtime:execution", runtime.executionCorrespondenceEvidence);
        provenance(
          "runtime:delivered",
          runtime.profile.delivered.evidence,
          null,
          runtime.profile.delivered,
        );
        provenance(
          "runtime:effective",
          runtime.profile.effective.evidence,
          null,
          runtime.profile.effective,
        );
        const { evidence: _deliveredEvidence, ...delivered } = runtime.profile.delivered;
        const { evidence: _effectiveEvidence, ...effective } = runtime.profile.effective;
        if (
          !equal(runtime.profile.desired, delivered) ||
          !equal(runtime.profile.desired, effective) ||
          runtime.profile.desired.digest !== expected.runtime.binding.profileDigests.runtime ||
          ("snapshot" in authority &&
            runtime.profile.desired.profileRef !== authority.snapshot.runtimeProfileRef)
        )
          fail("policy-mismatch", "runtime:observation", true);
        const needsIdentity = authorityRequest.purpose !== "identity-registration";
        const identity = runtime.identityEvidence;
        if (
          needsIdentity &&
          (!identity || identity.kind !== "identity" || identity.outcome.result !== "verified")
        )
          fail("missing-evidence", "runtime:observation");
        if (identity) {
          const source =
            identity.kind === "identity" ? identity.verifiedAt : identity.providerObservedAt;
          const until = identity.kind === "identity" ? identity.expiresAt : identity.validUntil;
          const sourceTimes =
            identity.kind === "identity"
              ? [source]
              : [source, identity.policyObservedAt, identity.readinessObservedAt];
          if (sourceTimes.some((at) => !freshClock(at, until, identity.uncertaintyMs))) {
            add("evidence-stale", "runtime:identity", null, identity.evidenceVersion);
            fresh = false;
          }
          remember(
            "runtime:identity",
            "original-runtime-identity",
            null,
            identity.evidenceVersion,
            source,
            identity,
          );
          if (
            needsIdentity &&
            "identityEvidence" in authority &&
            identity.kind === "identity" &&
            (identity.registrationId !== authority.identityEvidence.registrationId ||
              identity.registrationVersion !== authority.identityEvidence.registrationVersion ||
              identity.identityProfileRef !== authority.identityEvidence.identityProfileRef)
          )
            fail("target-mismatch", "runtime:identity", true);
        }
      }
      const epochs = new Map<string, string>();
      for (const control of observation.controls) {
        const slot = `control:${control.control}`;
        const epoch = canonical(control.sourceEpoch);
        if (
          epochs.has(control.source.producerRef) &&
          epochs.get(control.source.producerRef) !== epoch
        ) {
          add("epoch-invalid", slot, null, null, true);
          ordered = false;
        }
        epochs.set(control.source.producerRef, epoch);
        provenance(slot, control.source, control.sourceEpoch, control);
        for (const stage of ["delivered", "effective"] as const) {
          const value = control[stage];
          if (value) provenance(`${slot}:${stage}`, value.evidence, control.sourceEpoch, value);
          else fail("missing-evidence", slot);
        }
        if (control.outcome !== "effective")
          fail(
            control.outcome === "ineffective" ? "control-ineffective" : "control-unknown",
            slot,
            control.outcome === "ineffective",
          );
      }
    }
    for (const slot of subject.blocked) {
      if (slot.startsWith("authority:") && slot !== authoritySlot) {
        failures.add(slot);
        continue;
      }
      if (!advanced.has(slot)) {
        failures.add(slot);
        add("recovery-pending", slot, null, null, true);
      }
    }
    if (
      (!existing && state.subjects.length >= limits.maxSubjects) ||
      marks.size > limits.maxWatermarksPerSubject ||
      (terminal &&
        !state.retiredAssignments.includes(assignmentKey) &&
        state.retiredAssignments.length >= limits.maxSubjects) ||
      findings.length > limits.maxFindings
    )
      return result("unknown", [finding("state-capacity")], state, subjectKey);
    // No malformed, stale or reordered source can advance a protected watermark.
    // A rejected exchange still denies this attempt; the owner retains its denial
    // through the original fault path, never by interpreting a comparison as a grant.
    if (!ordered || !fresh) {
      const retained =
        retainRetirement && !state.retiredAssignments.includes(assignmentKey)
          ? { ...state, retiredAssignments: [...state.retiredAssignments, assignmentKey] }
          : state;
      return result(denied ? "denied" : "unknown", findings, retained, subjectKey);
    }
    const next: ContainmentEvidenceStateV1 = {
      schemaVersion: 1,
      clock: { ...value.clock },
      subjects: state.subjects
        .filter((s) => s.key !== subjectKey)
        .concat({
          ...subject,
          watermarks: [...marks.values()].sort((a, b) => (a.slot < b.slot ? -1 : 1)),
          blocked: [...failures].filter((slot) => marks.has(slot)).sort(),
        }),
      retiredAssignments:
        terminal && !state.retiredAssignments.includes(assignmentKey)
          ? [...state.retiredAssignments, assignmentKey]
          : state.retiredAssignments,
    };
    try {
      decodeState(next);
    } catch {
      return result("unknown", [finding("state-capacity")], state, subjectKey);
    }
    return result(
      denied ? "denied" : findings.length ? "unknown" : "satisfied",
      findings,
      next,
      subjectKey,
    );
  } catch {
    return result("unknown", [finding("invalid-input")], state);
  }
}
