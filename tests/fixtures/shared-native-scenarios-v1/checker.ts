/** Synthetic observation checks only; this module never invokes a native SDK. */
export const SCENARIOS = [
  "same-thread-follow-up",
  "different-thread-follow-up",
  "same-thread-overlap",
  "different-thread-overlap",
  "sticky-busy-retry",
  "duplicate-replay",
  "changed-payload-conflict",
  "immutable-output-binding",
] as const;

export const REQUIRED_CASE_IDS = [
  ...["slack", "msteams"].flatMap((platform) =>
    SCENARIOS.map((scenario) => `${platform}/${scenario}`),
  ),
  "cross-platform/slack-first",
  "cross-platform/msteams-first",
  "slack/logical-twin-message-first",
  "slack/logical-twin-mention-first",
] as const;

export const LIMITS = Object.freeze({
  packetBytes: 1_048_576,
  cases: 32,
  observationsPerCase: 64,
  observations: 2048,
  depth: 16,
  referenceBytes: 256,
  findings: 256,
});

export type Finding = Readonly<{ caseId: string | null; code: string; path: string }>;
export type Report = Readonly<{
  evidenceKind: "synthetic-dispatched-committed-trace";
  runtimeQualified: false;
  evidenceAuthenticated: false;
  expected: number;
  discovered: number;
  supplied: number;
  consistent: number;
  inconsistent: number;
  incomplete: number;
  unrun: number;
  findings: readonly Finding[];
  findingsTruncated: boolean;
}>;

const wellFormed = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};

/** Parse bounded JSON without reading files, resolving paths, or running input. */
export function parseScenarioJson(text: string): unknown {
  if (Buffer.byteLength(text, "utf8") > LIMITS.packetBytes)
    throw new RangeError("packet byte bound");
  let offset = 0;
  const ws = () => {
    while (/[ \n\r\t]/u.test(text[offset] ?? "!")) offset++;
  };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const char = text[offset++];
      if (char === "\\") offset++;
      else if (char === '"') {
        const value: unknown = JSON.parse(text.slice(start, offset));
        if (typeof value !== "string" || !wellFormed(value)) throw new SyntaxError("Unicode");
        return value;
      }
    }
    throw new SyntaxError("string");
  };
  const value = (depth: number): unknown => {
    if (depth > LIMITS.depth) throw new RangeError("packet depth bound");
    ws();
    const char = text[offset];
    if (char === '"') return string();
    if (char === "{" || char === "[") {
      offset++;
      ws();
      const object = char === "{";
      const end = object ? "}" : "]";
      const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const array: unknown[] = [];
      if (text[offset] === end) {
        offset++;
        return object ? record : array;
      }
      for (;;) {
        if (object) {
          ws();
          if (text[offset] !== '"') throw new SyntaxError("key");
          const key = string();
          ws();
          if (Object.hasOwn(record, key) || text[offset++] !== ":")
            throw new SyntaxError("duplicate key or colon");
          record[key] = value(depth + 1);
        } else array.push(value(depth + 1));
        ws();
        const separator = text[offset++];
        if (separator === end) return object ? record : array;
        if (separator !== ",") throw new SyntaxError("separator");
      }
    }
    for (const [token, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (text.startsWith(token, offset)) {
        offset += token.length;
        return result;
      }
    }
    const token = /^-?(?:0|[1-9][0-9]*)/u.exec(text.slice(offset))?.[0];
    if (!token) throw new SyntaxError("value");
    offset += token.length;
    const number = Number(token);
    if (!Number.isSafeInteger(number)) throw new RangeError("integer");
    return number;
  };
  const parsed = value(0);
  ws();
  if (offset !== text.length) throw new SyntaxError("trailing input");
  return parsed;
}

const SDK = Object.freeze({
  packageLayoutInventorySha256: "3f81368161e39059ec00f90dd91325d2c9e2c6c3017dfa608d54f3c6af9cb0c8",
  dependencyLockSha256: "25baebd8225a0faa174e3d2eb498af3904b7254acc4629cb6ef870a1db6d5ea7",
  declarationPreparationManifestSha256:
    "ce24dfc7ef291600ff7c0ef75d0e1b659ad9cdd01ee011ac0cc654658ce38137",
  publicDeclarations: [
    {
      subpath: "openclaw/plugin-sdk/channel-inbound",
      exportTarget: "dist/plugin-sdk/channel-inbound.d.ts",
      sha256: "b7d8fc8074b0dfbfd48c56634e56535a4ea4d2897fd7dcef3c058b28230bb558",
    },
    {
      subpath: "openclaw/plugin-sdk/slack-hosted",
      exportTarget: "dist/plugin-sdk/slack-hosted.d.ts",
      sha256: "f76e4c5516876b1244e8e8bd05426357f072d663a5a21e12f789ff3d2f283775",
    },
    {
      subpath: "openclaw/plugin-sdk/msteams-hosted",
      exportTarget: "dist/plugin-sdk/msteams-hosted.d.ts",
      sha256: "619404d1736a08c15344aef1829c38cfe4b230c71f61beaa4a919aa6f7e75654",
    },
    {
      subpath: "openclaw/plugin-sdk/codex-hosted-harness",
      exportTarget: "dist/plugin-sdk/codex-hosted-harness.d.ts",
      sha256: "3e1a5c9ab6d10b640733d9ba0b0696b411d42c23779d27a2da3997c1e654e12b",
    },
  ],
  sourceCommit: "ae2265c60527ad07174250131ebbf65dec9401a6",
  sourceTree: "a56670c31976631023940663e3cb6200c2cca644",
  archiveSha256: "e2a5aeceba22e2bf5d5cfa9b8f6a47dc07c2ce08445c799874fe40d5f90d25d7",
  packageManifestSha256: "1982353788165755597459e657fe96e53380afd48cfb5610dca52ae3e3b7dd9d",
  profileSha256: "b7aceebe86f243f3554b3c1660f76fe5b02d88465d60a7b669c2ada5cdbec006",
});
const BINDING_REFS = [
  "receiptRef",
  "turnRef",
  "attemptRef",
  "principalRef",
  "namespaceRef",
  "agentRef",
  "conversationRef",
  "admittedRevisionRef",
  "assignmentRef",
  "replyBindingRef",
] as const;
const BINDING_NUMBERS = [
  "runtimeGeneration",
  "replyBindingVersion",
  "bindingVersion",
  "policyVersion",
  "expectedCompletionSequence",
] as const;
export type Binding = Readonly<
  Record<(typeof BINDING_REFS)[number], string> & Record<(typeof BINDING_NUMBERS)[number], number>
>;
type Platform = "slack" | "msteams";
type Disposition = "accepted" | "busy" | "duplicate" | "conflict";
type Turn = Readonly<{
  inputPath: "mentioned-text";
  id: string;
  platform: Platform;
  actorRef: string;
  threadRef: string;
  eventRef: string;
  eventKind: "message" | "app_mention";
  logicalMessageRef: string;
  payloadRef: string;
  disposition: Disposition;
  ownerTurnId: string | null;
  binding: Binding | null;
}>;
type Scenario = Readonly<{ id: string; turns: readonly Turn[] }>;
type JsonObject = Record<string, unknown>;
const isObject = (v: unknown): v is JsonObject =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const ref = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  wellFormed(v) &&
  Buffer.byteLength(v) <= LIMITS.referenceBytes &&
  !/[\x00-\x1f\x7f-\x9f]/u.test(v);
const positive = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => same(v, b[i]));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]))
  );
};
const closed = (v: unknown, keys: readonly string[]): v is JsonObject =>
  isObject(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const binding = (v: unknown): v is Binding =>
  closed(v, [...BINDING_REFS, ...BINDING_NUMBERS]) &&
  BINDING_REFS.every((k) => ref(v[k])) &&
  BINDING_NUMBERS.every((k) => positive(v[k]));
const turn = (v: unknown): v is Turn =>
  closed(v, [
    "inputPath",
    "id",
    "platform",
    "actorRef",
    "threadRef",
    "eventRef",
    "eventKind",
    "logicalMessageRef",
    "payloadRef",
    "disposition",
    "ownerTurnId",
    "binding",
  ]) &&
  v.inputPath === "mentioned-text" &&
  ["id", "actorRef", "threadRef", "eventRef", "logicalMessageRef", "payloadRef"].every((k) =>
    ref(v[k]),
  ) &&
  (v.platform === "slack" || v.platform === "msteams") &&
  (v.eventKind === "message" || v.eventKind === "app_mention") &&
  ["accepted", "busy", "duplicate", "conflict"].includes(String(v.disposition)) &&
  (v.ownerTurnId === null || ref(v.ownerTurnId)) &&
  (v.disposition === "accepted" ? binding(v.binding) : v.binding === null);
const KINDS = [
  "admission",
  "dispatch",
  "context",
  "model",
  "tool",
  "output",
  "native-completion",
  "occ-checkpoint",
  "writer-end",
] as const;
type Kind = (typeof KINDS)[number];
const detailValid = (kind: Kind, d: unknown): boolean => {
  switch (kind) {
    case "admission":
      return (
        closed(d, ["disposition", "ownerTurnId"]) &&
        ["accepted", "busy", "duplicate", "conflict"].includes(String(d.disposition)) &&
        (d.ownerTurnId === null || ref(d.ownerTurnId))
      );
    case "dispatch":
      return closed(d, ["workspaceRef"]) && d.workspaceRef === "synthetic-shared-workspace";
    case "context":
      return (
        closed(d, ["transcriptRef", "payloadRefs"]) &&
        ref(d.transcriptRef) &&
        Array.isArray(d.payloadRefs) &&
        d.payloadRefs.length > 0 &&
        d.payloadRefs.length <= 8 &&
        d.payloadRefs.every(ref)
      );
    case "model":
    case "tool":
      return closed(d, ["payloadRef"]) && ref(d.payloadRef);
    case "output":
      return (
        closed(d, [
          "platform",
          "threadRef",
          "replyBindingRef",
          "replyBindingVersion",
          "outcome",
          "deliveryAttemptRef",
          "providerMessageRef",
        ]) &&
        (d.platform === "slack" || d.platform === "msteams") &&
        ref(d.threadRef) &&
        ref(d.replyBindingRef) &&
        positive(d.replyBindingVersion) &&
        (d.outcome === "delivered" || d.outcome === "unknown") &&
        ref(d.deliveryAttemptRef) &&
        (d.outcome === "delivered" ? ref(d.providerMessageRef) : d.providerMessageRef === null)
      );
    case "native-completion":
      return (
        closed(d, ["state", "checkpoint"]) &&
        d.state === "completed" &&
        d.checkpoint === "unverified"
      );
    case "occ-checkpoint":
      return (
        closed(d, ["origin", "checkpointRef", "completionSequence"]) &&
        d.origin === "occ-checkpoint-observation" &&
        ref(d.checkpointRef) &&
        positive(d.completionSequence)
      );
    case "writer-end":
      return closed(d, ["origin"]) && d.origin === "synthetic-writer-interval-end";
  }
};

/** Checks only the supplied synthetic scenario packet. No claim authenticates its producer. */
export function checkScenarioPacket(
  manifestText: string,
  casesText: string,
  tracesText: string,
): Report {
  const findings: Finding[] = [];
  let findingsTruncated = false;
  const inconsistentIds = new Set<string>();
  const incompleteIds = new Set<string>();
  let packetInvalid = false;
  const add = (caseId: string | null, code: string, path: string, missing = false): void => {
    if (caseId === null) packetInvalid = true;
    else (missing ? incompleteIds : inconsistentIds).add(caseId);
    if (findings.length < LIMITS.findings) findings.push({ caseId, code, path });
    else findingsTruncated = true;
  };
  let discovered = 0;
  let supplied = 0;
  let presentIds = new Set<string>();
  const result = (): Report => {
    const expected = REQUIRED_CASE_IDS.length;
    const inconsistent = packetInvalid
      ? presentIds.size
      : [...presentIds].filter((id) => inconsistentIds.has(id)).length;
    const incomplete = packetInvalid
      ? 0
      : [...presentIds].filter((id) => !inconsistentIds.has(id) && incompleteIds.has(id)).length;
    return {
      evidenceKind: "synthetic-dispatched-committed-trace",
      runtimeQualified: false,
      evidenceAuthenticated: false,
      expected,
      discovered,
      supplied,
      consistent: presentIds.size - inconsistent - incomplete,
      inconsistent,
      incomplete,
      unrun: expected - presentIds.size,
      findings,
      findingsTruncated,
    };
  };
  let m: unknown, c: unknown, t: unknown;
  try {
    if (
      [manifestText, casesText, tracesText].reduce((n, s) => n + Buffer.byteLength(s), 0) >
      LIMITS.packetBytes
    )
      throw new RangeError("packet");
    m = parseScenarioJson(manifestText);
    c = parseScenarioJson(casesText);
    t = parseScenarioJson(tracesText);
  } catch {
    add(null, "invalid-json-or-bound", "packet");
    return result();
  }
  if (
    !closed(m, [
      "schema",
      "evidenceKind",
      "runtimeQualified",
      "evidenceAuthenticated",
      "selectedSdk",
      "requiredCaseIds",
      "substitutions",
      "unrunPaths",
    ]) ||
    m.schema !== "oce.shared-native-scenarios/v1" ||
    m.evidenceKind !== "synthetic-dispatched-committed-trace" ||
    m.runtimeQualified !== false ||
    m.evidenceAuthenticated !== false ||
    !same(m.requiredCaseIds, REQUIRED_CASE_IDS) ||
    !same(m.selectedSdk, SDK) ||
    !Array.isArray(m.substitutions) ||
    m.substitutions.length === 0 ||
    !m.substitutions.every(ref) ||
    !Array.isArray(m.unrunPaths) ||
    m.unrunPaths.length === 0 ||
    !m.unrunPaths.every(ref)
  )
    add(null, "manifest-identity-or-shape", "manifest");
  if (
    !closed(c, ["schema", "cases"]) ||
    c.schema !== "oce.shared-native-cases/v1" ||
    !Array.isArray(c.cases) ||
    c.cases.length > LIMITS.cases
  ) {
    add(null, "invalid-case-catalog", "cases");
    return result();
  }
  if (
    !closed(t, ["schema", "cases"]) ||
    t.schema !== "oce.shared-native-traces/v1" ||
    !Array.isArray(t.cases) ||
    t.cases.length > LIMITS.cases
  ) {
    add(null, "invalid-trace-catalog", "traces");
    return result();
  }
  const catalog = new Map<string, Scenario>();
  for (const row of c.cases) {
    if (
      !closed(row, ["id", "turns"]) ||
      !ref(row.id) ||
      !Array.isArray(row.turns) ||
      row.turns.length < 2 ||
      row.turns.length > 3 ||
      !row.turns.every(turn)
    ) {
      add(null, "invalid-case-shape", "cases");
      continue;
    }
    if (!REQUIRED_CASE_IDS.includes(row.id)) {
      add(null, "foreign-case", "cases");
      continue;
    }
    if (catalog.has(row.id)) {
      add(row.id, "duplicate-case-definition", "cases");
      continue;
    }
    const scenario = row as unknown as Scenario;
    catalog.set(scenario.id, scenario);
    validateScenario(scenario, add);
  }
  for (const id of REQUIRED_CASE_IDS)
    if (!catalog.has(id)) add(null, "missing-case-definition", id);
  discovered = t.cases.length;
  let observationCount = 0;
  const suppliedRows = new Map<string, JsonObject>();
  for (const row of t.cases) {
    if (
      !closed(row, ["caseId", "observations"]) ||
      !ref(row.caseId) ||
      !Array.isArray(row.observations) ||
      row.observations.length > LIMITS.observationsPerCase
    ) {
      add(null, "invalid-trace-shape", "traces");
      continue;
    }
    observationCount += row.observations.length;
    if (!REQUIRED_CASE_IDS.includes(row.caseId)) {
      add(null, "foreign-trace-case", "traces");
      continue;
    }
    if (suppliedRows.has(row.caseId)) {
      add(row.caseId, "duplicate-trace-case", "traces");
      continue;
    }
    suppliedRows.set(row.caseId, row);
  }
  presentIds = new Set(suppliedRows.keys());
  supplied = presentIds.size;
  if (observationCount > LIMITS.observations) {
    add(null, "aggregate-observation-bound", "traces");
    return result();
  }
  for (const id of REQUIRED_CASE_IDS) {
    const row = suppliedRows.get(id),
      scenario = catalog.get(id);
    if (!row) {
      add(id, "missing-trace-case", id, true);
      continue;
    }
    if (!scenario) continue;
    validateTrace(scenario, row.observations as unknown[], add);
  }
  return result();
}

type Add = (id: string | null, code: string, path: string, missing?: boolean) => void;
function validateScenario(s: Scenario, add: Add): void {
  const fail = (code: string) => add(s.id, code, "cases");
  const [a, b, c] = s.turns;
  if (!a || !b) return;
  if (new Set(s.turns.map((x) => x.id)).size !== s.turns.length) fail("duplicate-turn-id");
  const sticky = s.id.endsWith("sticky-busy-retry");
  const cross = s.id.startsWith("cross-platform/");
  const twin = s.id.includes("logical-twin-");
  const replay = s.id.endsWith("duplicate-replay") || twin;
  const conflict = s.id.endsWith("changed-payload-conflict");
  const overlap = s.id.endsWith("overlap") || cross || sticky;
  if (s.turns.length !== (sticky || cross ? 3 : 2)) fail("scenario-turn-count");
  if (a.disposition !== "accepted" || a.ownerTurnId !== null) fail("scenario-first-admission");
  const expectedB = replay ? "duplicate" : conflict ? "conflict" : overlap ? "busy" : "accepted";
  if (b.disposition !== expectedB) fail("scenario-second-disposition");
  if (b.ownerTurnId !== (replay || conflict ? a.id : null)) fail("scenario-owner-label");
  if (!cross && s.turns.some((x) => x.platform !== a.platform)) fail("scenario-platform");
  if (!cross && !s.id.startsWith(a.platform + "/")) fail("scenario-platform-label");
  if (
    cross &&
    (a.platform === b.platform ||
      a.platform !== (s.id.endsWith("slack-first") ? "slack" : "msteams") ||
      !c ||
      c.platform !== b.platform ||
      c.actorRef !== b.actorRef ||
      c.threadRef !== b.threadRef ||
      c.eventRef === a.eventRef ||
      c.eventRef === b.eventRef ||
      c.payloadRef === a.payloadRef ||
      c.payloadRef === b.payloadRef ||
      c.logicalMessageRef === a.logicalMessageRef ||
      c.disposition !== "accepted" ||
      c.ownerTurnId !== null ||
      c.logicalMessageRef === b.logicalMessageRef)
  )
    fail("cross-platform-sequence");
  const differentThread =
    s.id.includes("different-thread") || s.id.endsWith("immutable-output-binding");
  if (!cross && (differentThread ? a.threadRef === b.threadRef : a.threadRef !== b.threadRef))
    fail("scenario-thread-relationship");
  if (replay || conflict) {
    if (
      a.actorRef !== b.actorRef ||
      a.logicalMessageRef !== b.logicalMessageRef ||
      a.threadRef !== b.threadRef ||
      (conflict ? a.payloadRef === b.payloadRef : a.payloadRef !== b.payloadRef)
    )
      fail("scenario-replay-relationship");
    if (
      twin
        ? a.eventRef === b.eventRef || a.eventKind === b.eventKind
        : a.eventRef !== b.eventRef || a.eventKind !== b.eventKind
    )
      fail("scenario-event-relationship");
    if (twin && a.eventKind !== (s.id.endsWith("message-first") ? "message" : "app_mention"))
      fail("logical-twin-order");
  } else if (
    a.actorRef === b.actorRef ||
    a.logicalMessageRef === b.logicalMessageRef ||
    a.payloadRef === b.payloadRef
  )
    fail("scenario-distinct-humans");
  if (
    sticky &&
    (!c ||
      c.disposition !== "duplicate" ||
      c.ownerTurnId !== b.id ||
      c.actorRef !== b.actorRef ||
      c.threadRef !== b.threadRef ||
      c.logicalMessageRef !== b.logicalMessageRef ||
      c.eventRef !== b.eventRef ||
      c.eventKind !== b.eventKind ||
      c.payloadRef !== b.payloadRef)
  )
    fail("sticky-busy-owner");
  const attempts = new Set<string>();
  const receipts = new Set<string>();
  const acceptedTurns = new Set<string>();
  const conversations = new Map<string, string>();
  for (const x of s.turns) {
    if (x.binding) {
      if (
        x.binding.principalRef !== x.actorRef ||
        x.binding.agentRef !== "synthetic-shared-agent" ||
        x.binding.namespaceRef !== "synthetic-namespace"
      )
        fail("scenario-attribution");
      if (attempts.has(x.binding.attemptRef)) fail("reused-attempt");
      attempts.add(x.binding.attemptRef);
      if (receipts.has(x.binding.receiptRef)) fail("reused-accepted-receipt");
      receipts.add(x.binding.receiptRef);
      if (acceptedTurns.has(x.binding.turnRef)) fail("reused-accepted-turn");
      acceptedTurns.add(x.binding.turnRef);
      const scope = JSON.stringify([x.platform, x.threadRef]);
      const existingScope = conversations.get(x.binding.conversationRef);
      if (existingScope !== undefined && existingScope !== scope) fail("conversation-scope-alias");
      for (const [conversation, observedScope] of conversations)
        if (observedScope === scope && conversation !== x.binding.conversationRef)
          fail("same-thread-conversation-split");
      conversations.set(x.binding.conversationRef, scope);
    }
  }
}

function validateTrace(s: Scenario, observations: unknown[], add: Add): void {
  const turns = new Map(s.turns.map((x) => [x.id, x]));
  const seen = new Map(s.turns.map((x) => [x.id, new Set<Kind>()]));
  const admissionOrder = new Map<string, number>();
  const endOrder = new Map<string, number>();
  const priorContext = new Set<string>();
  let active: string | null = null;
  let previousSequence = 0;
  const fail = (code: string, path: string, missing = false) => add(s.id, code, path, missing);
  for (const [index, raw] of observations.entries()) {
    const path = `${s.id}/observations/${index}`;
    if (
      !closed(raw, ["sequence", "kind", "turnId", "binding", "detail"]) ||
      !positive(raw.sequence) ||
      !ref(raw.turnId) ||
      !KINDS.includes(raw.kind as Kind) ||
      !detailValid(raw.kind as Kind, raw.detail)
    ) {
      fail("invalid-observation", path);
      continue;
    }
    if (raw.sequence <= previousSequence) fail("nonmonotonic-sequence", path);
    previousSequence = raw.sequence;
    const x = turns.get(raw.turnId);
    if (!x) {
      fail("foreign-turn", path);
      continue;
    }
    const state = seen.get(x.id)!;
    const kind = raw.kind as Kind;
    const detail = raw.detail as JsonObject;
    if (!same(raw.binding, x.binding)) fail("binding-substitution", path);
    if (state.has(kind))
      fail(kind === "output" ? "output-replay-without-proof" : "duplicate-observation", path);
    if (kind === "admission") {
      if (state.size > 0) fail("late-admission", path);
      if (detail.disposition !== x.disposition || detail.ownerTurnId !== x.ownerTurnId)
        fail("admission-label-substitution", path);
      if (x.ownerTurnId && !admissionOrder.has(x.ownerTurnId)) fail("owner-not-yet-observed", path);
      admissionOrder.set(x.id, raw.sequence);
    } else {
      if (!state.has("admission")) fail("missing-prior-admission", path);
      if (x.disposition !== "accepted") fail("suppressed-turn-effect", path);
      if (kind === "dispatch") {
        if (active !== null) fail("concurrent-workspace-writers", path);
        active = x.id;
      } else {
        if (!state.has("dispatch") || active !== x.id)
          fail("effect-outside-dispatched-interval", path);
        if (kind !== "context" && !state.has("context")) fail("missing-prior-context", path);
        if (kind === "context") {
          const payloads = detail.payloadRefs as string[];
          if (
            detail.transcriptRef !== x.binding?.conversationRef ||
            payloads.filter((p) => p === x.payloadRef).length !== 1 ||
            new Set(payloads).size !== payloads.length
          )
            fail("context-binding", path);
          for (const payload of payloads) {
            if (payload === x.payloadRef) continue;
            const origin = s.turns.find(
              (z) =>
                z.payloadRef === payload && z.disposition === "accepted" && priorContext.has(z.id),
            );
            if (
              !origin ||
              origin.platform !== x.platform ||
              origin.threadRef !== x.threadRef ||
              origin.binding?.conversationRef !== x.binding?.conversationRef
            )
              fail("suppressed-or-foreign-context", path);
          }
          const expectedPayloads = s.turns
            .filter(
              (z) =>
                priorContext.has(z.id) && z.platform === x.platform && z.threadRef === x.threadRef,
            )
            .map((z) => z.payloadRef);
          expectedPayloads.push(x.payloadRef);
          if (!same(payloads, expectedPayloads)) fail("context-history-omission-or-order", path);
          priorContext.add(x.id);
        }
        if ((kind === "model" || kind === "tool") && detail.payloadRef !== x.payloadRef)
          fail("model-tool-payload-substitution", path);
        if (kind === "tool" && !state.has("model")) fail("tool-before-model", path);
        if (kind === "output") {
          if (!state.has("model") || !state.has("tool")) fail("output-before-work", path);
          if (
            s.id.endsWith("immutable-output-binding") &&
            x === s.turns[0] &&
            detail.outcome !== "unknown"
          )
            fail("unknown-output-promoted", path);
          if (
            detail.platform !== x.platform ||
            detail.threadRef !== x.threadRef ||
            detail.replyBindingRef !== x.binding?.replyBindingRef ||
            detail.replyBindingVersion !== x.binding?.replyBindingVersion
          )
            fail("output-redirection", path);
        }
        if (kind === "native-completion" && (!state.has("model") || !state.has("tool")))
          fail("completion-before-work", path);
        if (kind === "occ-checkpoint") {
          if (!state.has("native-completion")) fail("checkpoint-without-native-observation", path);
          if (detail.completionSequence !== x.binding?.expectedCompletionSequence)
            fail("checkpoint-sequence-substitution", path);
        }
        if (kind === "writer-end") {
          active = null;
          endOrder.set(x.id, raw.sequence);
        }
      }
    }
    state.add(kind);
  }
  for (const x of s.turns) {
    const state = seen.get(x.id)!;
    for (const required of x.disposition === "accepted" ? KINDS : (["admission"] as const))
      if (!state.has(required)) fail(`missing-${required}`, x.id, true);
  }
  if (active !== null) fail("writer-interval-unclosed", active, true);
  const [a, b, c] = s.turns;
  if (!a || !b) return;
  const secondAt = admissionOrder.get(b.id),
    firstEnd = endOrder.get(a.id),
    firstDispatch = observations.find(
      (v) => isObject(v) && v.kind === "dispatch" && v.turnId === a.id,
    );
  if (b.disposition === "busy") {
    if (
      secondAt === undefined ||
      firstEnd === undefined ||
      !isObject(firstDispatch) ||
      typeof firstDispatch.sequence !== "number"
    )
      fail("missing-overlap-observation", b.id, true);
    else if (!(firstDispatch.sequence < secondAt && secondAt < firstEnd))
      fail("busy-not-during-observed-writer", b.id);
  }
  if (
    b.disposition === "accepted" &&
    (secondAt === undefined || firstEnd === undefined || secondAt <= firstEnd)
  )
    fail("follow-up-before-writer-end", b.id);
  if (c) {
    const thirdAt = admissionOrder.get(c.id);
    if (thirdAt === undefined || firstEnd === undefined || thirdAt <= firstEnd)
      fail("retry-or-follow-up-before-idle", c.id);
  }
}
