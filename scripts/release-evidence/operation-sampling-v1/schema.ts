import { createHash } from "node:crypto";
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { Check } from "typebox/value";
import {
  ACCEPTANCE_ALLOCATION_SHA256_V1,
  ACCEPTANCE_CLASSES_V1,
  ACCEPTANCE_LEAVES_V1,
  ProducerReceiptSchemaV1,
  type AcceptanceDigestV1,
} from "@openclaw-enterprise/contracts/acceptance-companion-v1";

/** Consumer-local formats. Neither these schemas nor their hashes authenticate evidence. */
export const SAMPLING_LIMITS_V1 = Object.freeze({
  maxBytes: 4_194_304,
  maxDepth: 24,
  maxNodes: 131_072,
  maxContainerEntries: 2_048,
  maxRequirements: 128,
  maxSamples: 512,
  maxAttempts: 1_024,
  maxSteps: 256,
  maxClockMs: 604_800_000,
});
export const SELECTED_P6_SHA256_V1 =
  "93abd3f8d226c7e4da1f123d152437d592aa94018c45d193e14d9381e8f3d0a3";
const closed = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const values = <T extends string>(items: readonly T[]) => Type.Enum(items);
const id = Type.String({ minLength: 1, maxLength: 96, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$" });
const text = Type.String({ minLength: 1, maxLength: 4_096 });
const sha = Type.String({ pattern: "^[0-9a-f]{64}$", minLength: 64, maxLength: 64 });
const integer = (maximum: number = SAMPLING_LIMITS_V1.maxClockMs) =>
  Type.Integer({ minimum: 0, maximum });
const missing = closed({ state: Type.Literal("missing") });
const nullable = <T extends TSchema>(schema: T) => Type.Union([Type.Null(), schema]);
const digest = <D extends string>(domain: D) =>
  closed({
    domain: Type.Literal(domain),
    sha256: sha,
    byteLength: Type.Integer({ minimum: 1, maximum: 1_073_741_824 }),
  });
const list = <T extends TSchema>(schema: T, maximum: number) =>
  Type.Array(schema, { maxItems: maximum });
const timestamp = Type.String({
  minLength: 24,
  maxLength: 24,
  pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
});
const leafId = Type.Enum(
  Object.keys(ACCEPTANCE_LEAVES_V1) as (keyof typeof ACCEPTANCE_LEAVES_V1)[],
);
const channel = values(["none", "slack", "teams"] as const);
const purpose = values(["cold-install", "replacement", "none"] as const);
const source = values(["synthetic", "live"] as const);
const refOrMissing = <D extends string>(domain: D) =>
  Type.Union([missing, closed({ state: Type.Literal("present"), digest: digest(domain) })]);
const inputs = closed({
  inputManifest: digest("input"),
  limits: digest("limits"),
  tuple: digest("tuple"),
  procedure: digest("procedure"),
  procedureReview: refOrMissing("review"),
  demonstrationInputs: Type.Tuple([
    digest("demonstration"),
    digest("demonstration"),
    digest("demonstration"),
    digest("demonstration"),
  ]),
});
const clock = Type.Union([
  missing,
  closed({
    state: Type.Literal("available"),
    clockRef: id,
    observedAt: timestamp,
    uncertaintyMs: integer(86_400_000),
    monotonic: Type.Union([
      missing,
      closed({
        state: Type.Literal("available"),
        clockRef: id,
        ticksMs: integer(Number.MAX_SAFE_INTEGER),
      }),
    ]),
  }),
]);
const observation = closed({
  state: values(["confirmed", "denied", "unknown", "unobserved"] as const),
  clock,
  evidence: refOrMissing("evidence"),
});
const outcome = values(["pass", "fail", "unknown", "blocked", "skipped", "unrun"] as const);
const execution = Type.Union([
  closed({ state: Type.Literal("not-launched"), evidence: digest("evidence") }),
  closed({ state: Type.Literal("launch-unknown") }),
  closed({
    state: Type.Literal("launched"),
    executionClass: values(ACCEPTANCE_CLASSES_V1),
    executorRef: nullable(id),
    tool: refOrMissing("tool"),
    started: clock,
    ended: clock,
    interval: Type.Union([
      missing,
      closed({ state: Type.Literal("available"), clockRef: id, durationMs: integer() }),
    ]),
    capture: ProducerReceiptSchemaV1.properties.execution.anyOf[1].properties.capture,
  }),
]);
const scope = {
  operationId: id,
  conditionId: nullable(id),
  variantId: id,
  variantKind: values(["baseline", "negative", "outage", "restart"] as const),
  channel,
  purpose,
  leafId,
};
const requirement = closed({
  requirementId: id,
  kind: values(["runtime-operation", "native-story", "timed-condition", "negative"] as const),
  ...scope,
  requiredCount: Type.Integer({ minimum: 1, maximum: SAMPLING_LIMITS_V1.maxSamples }),
  freshness: Type.Literal("fresh-seed"),
  measurements: list(
    closed({
      metricId: id,
      meaning: values(["hard-bound", "observation-limit"] as const),
      maximumMs: integer(),
    }),
    16,
  ),
  denialBoundaryIds: list(id, 32),
});
const slot = closed({
  sampleId: id,
  attemptId: id,
  requirementId: id,
  storyId: nullable(id),
  seed: digest("input"),
});
export const OperationSamplingPlanSchemaV1 = closed({
  schemaVersion: Type.Literal("operation-sampling-plan/v1"),
  schemaDigest: sha,
  planId: id,
  runId: id,
  source,
  selection: closed({
    allocationSha256: Type.Literal(ACCEPTANCE_ALLOCATION_SHA256_V1),
    p6DispositionSha256: Type.Literal(SELECTED_P6_SHA256_V1),
    localDenialTargetMs: Type.Literal(60_000),
    providerObservationLimitMs: Type.Literal(120_000),
  }),
  inputs,
  requirementsEvidence: digest("input"),
  requirements: Type.Array(requirement, {
    minItems: 1,
    maxItems: SAMPLING_LIMITS_V1.maxRequirements,
  }),
  expected: Type.Array(slot, { minItems: 1, maxItems: SAMPLING_LIMITS_V1.maxSamples }),
});
const attempt = closed({
  attemptId: id,
  sampleId: id,
  requirementId: id,
  storyId: nullable(id),
  originalAttemptId: id,
  supersedesAttemptId: nullable(id),
  kind: values(["fresh", "retry", "probe"] as const),
  ...scope,
  parentCaseId: id,
  parentAssertionId: id,
  producerRef: id,
  seed: digest("input"),
  freshnessEvidence: refOrMissing("evidence"),
  captureReferences: list(digest("evidence"), 64),
  outcome,
  collection: values(["received", "rejected", "missing"] as const),
  accepted: Type.Boolean(),
  execution,
  turns: list(
    closed({
      turnId: id,
      participant: values(["A", "B"] as const),
      actorRef: id,
      outcome,
      evidence: refOrMissing("evidence"),
    }),
    64,
  ),
  clocks: closed({ requestReceived: clock, authenticatedAcceptance: clock, durableCommit: clock }),
  commitState: values(["confirmed", "failed", "unknown", "unobserved"] as const),
  boundaries: list(
    closed({ boundaryId: id, lastAllow: clock, firstDeny: clock, denial: observation }),
    32,
  ),
  stream: observation,
  cancellationAck: observation,
  physicalTermination: observation,
  nativeTerminal: observation,
  tokens: list(
    closed({ tokenRef: id, issued: clock, revocation: observation, expiry: observation }),
    64,
  ),
  measurements: list(
    closed({
      metricId: id,
      subjectRef: id,
      started: clock,
      ended: clock,
      evidence: refOrMissing("evidence"),
    }),
    16,
  ),
  observationsLimit: closed({
    providerEpisodeMs: Type.Literal(120_000),
    physicalEpisodeMs: integer(),
    elapsed: Type.Boolean(),
  }),
  omissions: list(text, 64),
});
export const OperationSampleJournalSchemaV1 = closed({
  schemaVersion: Type.Literal("operation-sample-journal/v1"),
  schemaDigest: sha,
  journalId: id,
  runId: id,
  source,
  plan: digest("input"),
  inputs,
  attempts: list(attempt, SAMPLING_LIMITS_V1.maxAttempts),
  omissions: list(text, 128),
});
const step = closed({
  stepId: id,
  order: Type.Integer({ minimum: 1, maximum: SAMPLING_LIMITS_V1.maxSteps }),
  instruction: Type.Union([
    closed({
      kind: Type.Literal("command"),
      executable: text,
      arguments: list(Type.String({ maxLength: 4_096 }), 64),
      directory: text,
    }),
    closed({ kind: Type.Literal("manual"), instruction: text }),
  ]),
  inputs: list(digest("input"), 64),
});
export const IndependentInstallerJournalSchemaV1 = closed({
  schemaVersion: Type.Literal("independent-installer-journal/v1"),
  schemaDigest: sha,
  journalId: id,
  runId: id,
  source,
  inputs,
  leafId,
  purpose: values(["cold-install", "replacement"] as const),
  packageReferences: list(digest("input"), 64),
  installer: closed({
    actorRef: id,
    authorRefs: list(id, 64),
    independence: values(["declared-independent", "not-independent", "unknown"] as const),
    declaration: refOrMissing("evidence"),
    independenceEvidence: refOrMissing("evidence"),
  }),
  prerequisites: list(
    closed({ prerequisiteId: id, description: text, outcome, evidence: refOrMissing("evidence") }),
    128,
  ),
  steps: list(step, SAMPLING_LIMITS_V1.maxSteps),
  attempts: list(
    closed({
      attemptId: id,
      originalAttemptId: id,
      supersedesAttemptId: nullable(id),
      outcome,
      execution,
      steps: list(
        closed({
          stepId: id,
          actorRef: id,
          state: values(["completed", "failed", "unknown", "skipped", "unrun"] as const),
          exitCode: nullable(Type.Integer({ minimum: -2_147_483_648, maximum: 2_147_483_647 })),
          capture: refOrMissing("evidence"),
        }),
        SAMPLING_LIMITS_V1.maxSteps,
      ),
    }),
    128,
  ),
  interventions: list(
    closed({
      interventionId: id,
      attemptId: id,
      stepId: nullable(id),
      actorRef: id,
      visibility: values(["documented", "private", "unknown"] as const),
      description: text,
      evidence: refOrMissing("evidence"),
    }),
    128,
  ),
  resources: list(
    closed({
      resourceRef: id,
      state: values(["retained", "cleaned", "unknown"] as const),
      cleanupOwnerRef: nullable(id),
      evidence: refOrMissing("evidence"),
    }),
    256,
  ),
  omissions: list(text, 128),
});
export type SamplingPlanV1 = Static<typeof OperationSamplingPlanSchemaV1>;
export type SampleJournalV1 = Static<typeof OperationSampleJournalSchemaV1>;
export type InstallerJournalV1 = Static<typeof IndependentInstallerJournalSchemaV1>;
export type SampleAttemptV1 = SampleJournalV1["attempts"][number];
export type SamplingClockV1 = Static<typeof clock>;
export type SamplingExecutionV1 = Static<typeof execution>;
export type SamplingInputsV1 = Static<typeof inputs>;
export type SamplingFailureV1 = Readonly<{ ok: false; code: string }>;
export type SamplingDecodedV1<T> = Readonly<{
  ok: true;
  value: T;
  originalBytes: () => Uint8Array;
  authentication: "unverified";
}>;
export type SamplingResultV1<T> = SamplingFailureV1 | SamplingDecodedV1<T>;
export const encodeSamplingV1 = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const SAMPLING_SCHEMA_DIGESTS_V1 = Object.freeze({
  plan: hash(encodeSamplingV1(OperationSamplingPlanSchemaV1)),
  sample: hash(encodeSamplingV1(OperationSampleJournalSchemaV1)),
  installer: hash(encodeSamplingV1(IndependentInstallerJournalSchemaV1)),
});
export function sameDigestV1(a: AcceptanceDigestV1, b: AcceptanceDigestV1): boolean {
  return a.domain === b.domain && a.sha256 === b.sha256 && a.byteLength === b.byteLength;
}
export function sameInputsV1(a: SamplingInputsV1, b: SamplingInputsV1): boolean {
  if (a.procedureReview.state !== b.procedureReview.state) return false;
  if (
    a.procedureReview.state === "present" &&
    b.procedureReview.state === "present" &&
    !sameDigestV1(a.procedureReview.digest, b.procedureReview.digest)
  )
    return false;
  return (
    ["inputManifest", "limits", "tuple", "procedure"].every((key) => {
      const k = key as "inputManifest" | "limits" | "tuple" | "procedure";
      return sameDigestV1(a[k], b[k]);
    }) &&
    a.demonstrationInputs.every((item, index) => sameDigestV1(item, b.demonstrationInputs[index]!))
  );
}
export function failSamplingV1(code: string): SamplingFailureV1 {
  return Object.freeze({ ok: false, code });
}
export function sameSamplingClockV1(a: SamplingClockV1, b: SamplingClockV1): boolean {
  if (a.state === "missing" || b.state === "missing") return a.state === b.state;
  if (
    a.clockRef !== b.clockRef ||
    a.observedAt !== b.observedAt ||
    a.uncertaintyMs !== b.uncertaintyMs ||
    a.monotonic.state !== b.monotonic.state
  )
    return false;
  return (
    a.monotonic.state === "missing" ||
    (b.monotonic.state === "available" &&
      a.monotonic.clockRef === b.monotonic.clockRef &&
      a.monotonic.ticksMs === b.monotonic.ticksMs)
  );
}
export function uniqueSamplingV1(items: readonly string[]): boolean {
  return new Set(items).size === items.length;
}

// Scan before JSON.parse: duplicate names, depth, aggregate size and lossy numbers are rejected.
function parse(bytes: Uint8Array): unknown {
  const input = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  let at = 0;
  let nodes = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(input[at] ?? "x")) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < input.length) {
      const character = input[at++];
      if (character === "\\") at++;
      else if (character === '"') return JSON.parse(input.slice(start, at)) as string;
    }
    throw new Error("invalid-json");
  };
  const value = (depth: number): void => {
    if (++nodes > SAMPLING_LIMITS_V1.maxNodes || depth > SAMPLING_LIMITS_V1.maxDepth)
      throw new Error("limit-exceeded");
    whitespace();
    const start = input[at];
    if (start === '"') {
      string();
      return;
    }
    if (start === "{" || start === "[") {
      const end = start === "{" ? "}" : "]";
      const names = new Set<string>();
      at++;
      whitespace();
      if (input[at] === end) {
        at++;
        return;
      }
      let count = 0;
      while (at < input.length) {
        if (++count > SAMPLING_LIMITS_V1.maxContainerEntries) throw new Error("limit-exceeded");
        whitespace();
        if (start === "{") {
          if (input[at] !== '"') throw new Error("invalid-json");
          const name = string();
          if (names.has(name)) throw new Error("duplicate-key");
          names.add(name);
          whitespace();
          if (input[at++] !== ":") throw new Error("invalid-json");
        }
        value(depth + 1);
        whitespace();
        const separator = input[at++];
        if (separator === end) return;
        if (separator !== ",") throw new Error("invalid-json");
      }
      throw new Error("invalid-json");
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      input.slice(at),
    )?.[0];
    if (!token) throw new Error("invalid-json");
    if (
      /^-?[0-9]/.test(token) &&
      (!/^-?(?:0|[1-9][0-9]*)$/.test(token) || !Number.isSafeInteger(Number(token)))
    )
      throw new Error("invalid-number");
    at += token.length;
  };
  value(0);
  whitespace();
  if (at !== input.length) throw new Error("invalid-json");
  return JSON.parse(input) as unknown;
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}
function validateClocks(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (
        key === "observedAt" &&
        typeof child === "string" &&
        (!Number.isFinite(Date.parse(child)) || new Date(child).toISOString() !== child)
      )
        throw new Error("invalid-clock");
      validateClocks(child);
    }
  }
}
export function decodeSamplingRecordV1<T>(
  input: unknown,
  schema: TSchema,
  schemaDigest: string,
): SamplingResultV1<T> {
  try {
    if (
      !(input instanceof Uint8Array) ||
      input.constructor !== Uint8Array ||
      !(input.buffer instanceof ArrayBuffer) ||
      input.byteLength === 0
    )
      return failSamplingV1("invalid-input");
    if (input.byteLength > SAMPLING_LIMITS_V1.maxBytes) return failSamplingV1("too-large");
    const bytes = new Uint8Array(input);
    const parsed = parse(bytes);
    if (!Check(schema, parsed)) return failSamplingV1("invalid-shape");
    if ((parsed as { schemaDigest: string }).schemaDigest !== schemaDigest)
      return failSamplingV1("schema-mismatch");
    validateClocks(parsed);
    freeze(parsed);
    return Object.freeze({
      ok: true,
      value: parsed as T,
      originalBytes: () => bytes.slice(),
      authentication: "unverified" as const,
    });
  } catch (error) {
    const allowed = [
      "limit-exceeded",
      "duplicate-key",
      "invalid-number",
      "invalid-clock",
      "invalid-json",
    ];
    return failSamplingV1(
      error instanceof Error && allowed.includes(error.message) ? error.message : "invalid-input",
    );
  }
}
for (const schema of [
  OperationSamplingPlanSchemaV1,
  OperationSampleJournalSchemaV1,
  IndependentInstallerJournalSchemaV1,
])
  freeze(schema);
