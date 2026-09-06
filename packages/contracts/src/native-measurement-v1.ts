import { Type, type Static, type TProperties } from "typebox";

/** Finite measurement definitions only; decoding never establishes runtime evidence. */
export const NATIVE_MEASUREMENT_VERSION_V1 = "native-measurement-v1" as const;
export const NATIVE_MEASUREMENT_LIMITS_V1 = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 16,
  maxNodes: 100_000,
  maxEntries: 8_192,
  maxSamplesPerCase: 4_096,
  maxTotalSamples: 1_024,
  maxCycles: 100,
  maxSamplesPerCycle: 100,
});

export const NATIVE_MEASUREMENT_CASES_V1 = Object.freeze([
  "startup-ready",
  "transport-ack",
  "admitted-turn-ack",
  "completed-result",
  "status",
  "busy",
  "shutdown",
  "reconnect-ready",
  "cancel-ack",
  "cancel-settlement",
  "writer-termination",
  "reconnect-retention",
  "cancel-retention",
  "model-service",
] as const);
export type NativeMeasurementCaseIdV1 = (typeof NATIVE_MEASUREMENT_CASES_V1)[number];

/** These are observer endpoints, not new native events or permission-bearing receipts. */
export const NATIVE_MEASUREMENT_ENDPOINTS_V1 = Object.freeze({
  "startup-ready": ["observer-gateway-launch-requested", "same-gateway-readiness-observed"],
  "transport-ack": [
    "observer-provider-transport-request-submitted",
    "provider-transport-ack-observed",
  ],
  "admitted-turn-ack": [
    "observer-gateway-turn-request-submitted",
    "canonical-admitted-attempt-ack-observed",
  ],
  "completed-result": [
    "native-completed-result-received",
    "checkpoint-gated-provider-create-confirmed",
  ],
  status: ["observer-protected-status-request-submitted", "authorized-status-response-observed"],
  busy: ["observer-overlap-request-submitted", "busy-response-observed"],
  shutdown: ["observer-gateway-shutdown-requested", "same-gateway-process-exit-observed"],
  "reconnect-ready": [
    "observer-harness-disconnect-observed",
    "original-attempt-reconciliation-complete",
  ],
  "cancel-ack": ["observer-protected-cancel-request-submitted", "native-interrupt-ack-observed"],
  "cancel-settlement": [
    "observer-protected-cancel-request-submitted",
    "trusted-original-attempt-settlement-observed",
  ],
  "writer-termination": [
    "observer-exact-writer-stop-requested",
    "physical-writer-termination-observed",
  ],
  "reconnect-retention": [
    "settled-pre-reconnect-baseline",
    "settled-post-reconnect-resource-observation",
  ],
  "cancel-retention": ["settled-pre-cancel-baseline", "settled-post-cancel-resource-observation"],
  "model-service": ["observer-model-request-submitted", "model-response-complete"],
} satisfies Record<NativeMeasurementCaseIdV1, readonly [string, string]>);

/** Preserved protocol/admission ceilings. Budgets never modify these values. */
export const NATIVE_MEASUREMENT_PRESERVED_V1 = Object.freeze({
  harness: Object.freeze({
    connectMs: 5000,
    sendMs: 5000,
    cancelMs: 3000,
    subscribeMs: 30000,
    reconnectMs: 5000,
    reconnectAttempts: 3,
    maxFrameBytes: 262144,
    maxInputBytes: 65536,
    maxEvents: 128,
    maxEventBytes: 1048576,
    maxAttempts: 64,
    maxSubscriptions: 16,
  }),
  native: Object.freeze({
    rawFrameBytes: 262144,
    inputUtf8Bytes: 65536,
    metadataBytes: 16384,
    referenceUtf8Bytes: 1024,
    attachments: 0,
    attachmentBytes: 0,
    executableConcurrency: 1,
    executableQueue: 0,
    pendingReceipts: 32,
    pendingDeadlineMs: 30000,
    turnDeadlineMs: 900000,
    outputCaptureBytes: 262144,
    completedTextUtf8Bytes: 3200,
    completedBodyBytes: 8192,
    noticeTextUtf8Bytes: 512,
    noticeBodyBytes: 2048,
    sensitiveChannelStreaming: false,
  }),
  authority: Object.freeze({
    effectPermitMs: 5000,
    lookupMs: 3000,
    evidenceAgeMs: 15000,
    clockUncertaintyMs: 2000,
    activeRecheckMs: 5000,
    audienceLookupMs: 5000,
    audienceAgeMs: 5000,
    audienceHumans: 100,
    preparationMs: 900000,
    providerRequestMs: 10000,
    gracefulStopMs: 30000,
    observationEpisodeMs: 120000,
  }),
});

const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const uint = (max = Number.MAX_SAFE_INTEGER) => Type.Integer({ minimum: 0, maximum: max });
const positive = (max = Number.MAX_SAFE_INTEGER) => Type.Integer({ minimum: 1, maximum: max });
const ref = Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:/-]+$" });
const digest = Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" });
const commit = Type.String({ minLength: 40, maxLength: 40, pattern: "^[0-9a-f]{40}$" });
const caseId = Type.Enum(NATIVE_MEASUREMENT_CASES_V1);
const evidenceKind = Type.Enum(["fixture", "source", "installed", "actual-provider"]);
const pin = Type.Union([
  object({ state: Type.Literal("known"), digest }),
  object({ state: Type.Literal("unknown") }),
]);
const pair = object({ request: positive(), limit: positive() });
const storage = Type.Union([
  object({ state: Type.Literal("selected"), values: pair }),
  object({ state: Type.Literal("unselected") }),
]);
const envelope = object({ cpuMillicores: pair, memoryBytes: pair, ephemeralStorageBytes: storage });
const roles = object({ gateway: envelope, harness: envelope, privateStateInit: envelope });
const resourceProfile = object({
  candidate: object({
    state: Type.Literal("unselected"),
    requestLimitMeaning: Type.Literal("unselected"),
    gatewayCpuMillicores: positive(),
    gatewayMemoryBytes: positive(),
    nativeCpuMillicores: positive(),
    nativeMemoryBytes: positive(),
  }),
  expectation: Type.Union([
    object({ state: Type.Literal("unselected") }),
    object({ state: Type.Literal("selected"), profileDigest: digest, roles }),
  ]),
  observed: Type.Union([
    object({ state: Type.Literal("unknown") }),
    object({
      state: Type.Literal("observed"),
      effectiveConfigurationDigest: digest,
      bindingDigest: digest,
      nativeMappingDigest: digest,
      roles,
    }),
  ]),
});
const decision = Type.Union([
  object({ state: Type.Literal("selected"), decisionDigest: digest }),
  object({ state: Type.Literal("unselected") }),
]);

/** Exact closed ProducerTupleV1 value shape. Extra artifact identities are siblings,
 * never additions to that existing format. This leaf loads no native implementation. */
export const NativeMeasurementSubjectSchemaV1 = object({
  producer: object({
    enterpriseCommit: commit,
    upstreamCommit: commit,
    codexCommit: commit,
    codexVersion: Type.Literal("0.153.0"),
    gatewayProtocol: Type.Literal(4),
    nativeStateSchema: Type.Literal(15),
    nativeAgentSchema: Type.Literal(19),
    adapterSchema: Type.Literal(1),
    contextFormat: Type.Literal("completed-context-text-v1"),
    nativeImportContract: Type.Literal(1),
    nativeImportAdapterDigest: digest,
    artifactLedgerRef: ref,
  }),
  artifacts: object({
    declarations: pin,
    exports: pin,
    package: pin,
    dependencyClosure: pin,
    nativeExecutable: pin,
    gatewayImage: pin,
    effectiveConfiguration: pin,
    capabilities: pin,
    toolchain: pin,
    producerReceipt: pin,
  }),
  generatedClients: Type.Union([
    object({ state: Type.Literal("unselected") }),
    object({
      state: Type.Literal("selected"),
      schemaDigest: digest,
      compilerDigest: digest,
      pluginDigest: digest,
      descriptorDigest: digest,
      configurationDigest: digest,
      clients: Type.Array(
        object({
          language: Type.Enum(["go", "typescript"]),
          packageDigest: digest,
          exportsDigest: digest,
          runtimeDigest: digest,
        }),
        { minItems: 1, maxItems: 2 },
      ),
    }),
  ]),
});
export type NativeMeasurementSubjectV1 = Static<typeof NativeMeasurementSubjectSchemaV1>;

const resources = object({
  rssBytes: uint(),
  fileDescriptors: uint(),
  sockets: uint(),
  listeners: uint(),
  timers: uint(),
  childProcesses: uint(),
});
const tolerance = Type.Union([
  object({ state: Type.Literal("unselected") }),
  object({
    state: Type.Literal("selected"),
    maximumGrowth: resources,
    settleWindowUs: positive(120_000_000),
  }),
]);
const latencyBudget = Type.Union([
  object({ state: Type.Literal("unselected") }),
  object({
    state: Type.Literal("selected"),
    p95Us: positive(900_000_000),
    maxUs: positive(900_000_000),
  }),
]);
const caseDefinition = object({
  id: caseId,
  applicability: Type.Enum(["required", "not-applicable"]),
  cycles: positive(NATIVE_MEASUREMENT_LIMITS_V1.maxCycles),
  warmupPerCycle: uint(NATIVE_MEASUREMENT_LIMITS_V1.maxSamplesPerCycle),
  samplesPerCycle: positive(NATIVE_MEASUREMENT_LIMITS_V1.maxSamplesPerCycle),
  latencyBudget,
  resourceTolerance: tolerance,
});

export const NativeMeasurementProfileSchemaV1 = object({
  format: Type.Literal("native-measurement-profile-v1"),
  revision: positive(),
  decision,
  evidenceKind,
  subject: NativeMeasurementSubjectSchemaV1,
  resourceProfile,
  clock: object({
    kind: Type.Literal("single-observer-monotonic"),
    unit: Type.Literal("microseconds"),
    originRef: ref,
    resolutionUs: positive(1_000_000),
  }),
  workload: object({
    workloadDigest: digest,
    channel: Type.Enum(["slack", "teams"]),
    agents: Type.Literal(1),
    participants: Type.Literal(2),
    threads: Type.Literal(2),
    executableConcurrency: Type.Literal(1),
    executableQueue: Type.Literal(0),
    inputUtf8Bytes: positive(65536),
    resultUtf8Bytes: positive(3200),
    outputCaptureBytes: positive(262144),
    attachments: Type.Literal(0),
    tokenStreaming: Type.Literal(false),
    model: Type.Enum(["none", "fixture", "actual-provider"]),
  }),
  cases: Type.Array(caseDefinition, {
    minItems: NATIVE_MEASUREMENT_CASES_V1.length,
    maxItems: NATIVE_MEASUREMENT_CASES_V1.length,
  }),
});
export type NativeMeasurementProfileV1 = Static<typeof NativeMeasurementProfileSchemaV1>;

const sampleKey = { cycle: uint(99), phase: Type.Enum(["warmup", "measured"]), index: uint(99) };
const sampled = {
  ...sampleKey,
  clockOriginRef: ref,
  startUs: uint(),
  endUs: uint(),
  evidenceRef: ref,
  workload: object({
    inputUtf8Bytes: uint(),
    resultUtf8Bytes: uint(),
    outputCaptureBytes: uint(),
    overflow: Type.Boolean(),
  }),
};
const sample = Type.Union([
  object({
    ...sampled,
    state: Type.Literal("latency"),
    endpoint: Type.Literal("observed"),
    domainOutcome: Type.Enum(["confirmed", "unknown"]),
  }),
  object({
    ...sampled,
    state: Type.Literal("resources"),
    settlement: Type.Literal("observed"),
    before: resources,
    after: resources,
    settledAtUs: uint(),
  }),
  object({ ...sampleKey, state: Type.Literal("missing"), reason: Type.Literal("not-recorded") }),
  object({
    ...sampleKey,
    state: Type.Literal("unknown"),
    reason: Type.Enum([
      "settlement-unknown",
      "clock-unavailable",
      "resource-observation-unavailable",
    ]),
  }),
]);
const record = Type.Union([
  object({
    id: caseId,
    state: Type.Literal("samples"),
    samples: Type.Array(sample, { maxItems: NATIVE_MEASUREMENT_LIMITS_V1.maxSamplesPerCase }),
  }),
  object({
    id: caseId,
    state: Type.Literal("blocked"),
    reason: Type.Literal("dependency-unavailable"),
  }),
  object({
    id: caseId,
    state: Type.Literal("skip"),
    reason: Type.Enum(["not-applicable", "operator-skipped"]),
  }),
  object({
    id: caseId,
    state: Type.Literal("unknown"),
    reason: Type.Literal("settlement-unknown"),
  }),
]);
export const NativeMeasurementResultsSchemaV1 = object({
  format: Type.Literal("native-measurement-results-v1"),
  profileDigest: digest,
  subject: NativeMeasurementSubjectSchemaV1,
  evidenceKind,
  discovered: Type.Array(caseId, { maxItems: NATIVE_MEASUREMENT_CASES_V1.length }),
  selected: Type.Array(caseId, { maxItems: NATIVE_MEASUREMENT_CASES_V1.length }),
  records: Type.Array(record, { maxItems: NATIVE_MEASUREMENT_CASES_V1.length }),
});
export type NativeMeasurementResultsV1 = Static<typeof NativeMeasurementResultsSchemaV1>;
export type NativeMeasurementOutcomeV1 =
  "pass" | "fail" | "skip" | "unselected" | "blocked" | "missing" | "unknown";
export type NativeMeasurementCaseResultV1 = Readonly<{
  id: NativeMeasurementCaseIdV1;
  outcome: NativeMeasurementOutcomeV1;
  expectedSamples: number;
  observedSamples: number;
  missingSamples: number;
  unknownSamples: number;
  warmupSamples: number;
  domainUnknownSamples: number;
  distributionUs: Readonly<{ p50: number; p95: number; p99: number; max: number }> | null;
}>;
export type NativeMeasurementEvaluationV1 = Readonly<{
  format: "native-measurement-evaluation-v1";
  evidenceKind: NativeMeasurementResultsV1["evidenceKind"];
  verdict: "pass" | "fail" | "incomplete";
  counts: Readonly<
    Record<NativeMeasurementOutcomeV1 | "expected" | "discovered" | "selected", number>
  >;
  cases: readonly NativeMeasurementCaseResultV1[];
  evidenceAuthenticated: false;
  runtimeQualified: false;
}>;
export type NativeMeasurementDecodeV1<T> =
  Readonly<{ kind: "valid"; value: T }> | Readonly<{ kind: "invalid"; reason: "invalid-input" }>;
