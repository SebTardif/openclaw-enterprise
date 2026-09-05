/** Synthetic values only. No external sender, workload or provider is verified. */
export const ids = Object.freeze(
  Object.fromEntries(
    [
      "event",
      "installation",
      "namespace",
      "agent",
      "revision",
      "human",
      "workload",
      "assignment",
      "request",
      "decision",
      "conversation",
      "channel_event",
      "turn",
      "attempt",
      "grant",
      "policy",
      "registration",
      "other_namespace",
      "other_conversation",
      "previous_assignment",
    ].map((name, index) => [
      name,
      `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
    ]),
  ),
);
const slot = { resource: "agent", principal: "human" };
export function fixture(overrides = {}) {
  const audit = {
    schemaVersion: 1,
    id: "event",
    installationId: "installation",
    namespaceId: "namespace",
    occurredAt: "2026-01-01T00:00:00.000Z",
    kind: "mutation",
    source: "occ",
    actorId: "human",
    action: "agents.read",
    outcome: "success",
    requestId: "request",
    admissionDecisionId: "decision",
    resource: { kind: "agent", id: "agent", namespaceId: "namespace" },
  };
  const context = {
    schemaVersion: 1,
    installationId: "installation",
    namespaceId: "namespace",
    resource: { ...audit.resource },
    receivedAt: "2026-01-01T00:00:01.000Z",
    source: "gateway",
    category: "access",
    action: "read",
    decision: "allowed",
    phase: "observed",
    result: "completed",
    reasonCode: "Authorized",
    human: { state: "verified", principalId: "human" },
    workload: {
      state: "verified",
      principalId: "workload",
      assignmentId: "assignment",
      agentId: "agent",
      revisionId: "revision",
      generation: 7,
    },
    correlation: {
      agentId: "agent",
      revisionId: "revision",
      conversationId: "conversation",
      channelEventId: "channel_event",
      turnId: "turn",
      attemptId: "attempt",
      grantId: "grant",
      policyId: "policy",
      registrationId: "registration",
    },
    observation: { observedAt: "2026-01-01T00:00:00.500Z", source: "gateway" },
    // Exact fixture allowlist: a canary with a syntactically valid UUID is still
    // rejected unless this scoped resolver actually knows the raw reference.
    resolveReference(kind, value) {
      if (kind === "assignment" && value === "previous_assignment") return ids.previous_assignment;
      const expected = slot[kind] ?? kind;
      return value === expected ? ids[expected] : undefined;
    },
    ...overrides,
  };
  return { audit, context };
}

export const scenarios = [
  { id: "access-allowed", context: {} },
  {
    id: "access-denied",
    context: { decision: "denied", result: "denied", reasonCode: "AccessDenied" },
  },
  {
    id: "credential-allowed",
    context: {
      source: "credential",
      category: "credential",
      action: "use",
      reasonCode: "CredentialAllowed",
      credential: { destination: "model", mode: "mediated" },
    },
  },
  {
    id: "credential-denied",
    context: {
      source: "credential",
      category: "credential",
      action: "use",
      decision: "denied",
      result: "denied",
      reasonCode: "CredentialDenied",
      credential: { destination: "github", mode: "native" },
    },
  },
  ...[
    ["register", "IdentityRegistered"],
    ["rotate", "IdentityRotated"],
    ["replace", "IdentityReplaced"],
  ].map(([action, reasonCode]) => ({
    id: `identity-${action}`,
    context: {
      source: "identity",
      category: "identity",
      action,
      reasonCode,
      ...(action === "replace"
        ? { previousRuntime: { assignmentId: "previous_assignment", generation: 6 } }
        : {}),
      observation: { observedAt: "2026-01-01T00:00:00.500Z", source: "identity_provider" },
    },
  })),
  {
    id: "stale-generation-denied",
    context: {
      source: "identity",
      category: "identity",
      action: "use",
      decision: "denied",
      result: "denied",
      reasonCode: "StaleGeneration",
      workload: { state: "unresolved" },
    },
  },
  ...["disable", "stop"].flatMap((action) => [
    {
      id: `${action}-requested`,
      context: {
        source: "occ",
        category: "lifecycle",
        action,
        phase: "requested",
        result: "pending",
        reasonCode: "RequestReceived",
        observation: undefined,
      },
    },
    {
      id: `${action}-accepted`,
      context: {
        source: "occ",
        category: "lifecycle",
        action,
        phase: "accepted",
        result: "pending",
        reasonCode: "DurablyAccepted",
        observation: undefined,
      },
    },
    {
      id: `${action}-observed`,
      context: {
        source: "runtime",
        category: "lifecycle",
        action,
        reasonCode: action === "stop" ? "Stopped" : "Disabled",
        observation: { observedAt: "2026-01-01T00:00:00.500Z", source: "runtime" },
      },
    },
  ]),
  {
    id: "stop-unconfirmed",
    context: {
      source: "runtime",
      category: "lifecycle",
      action: "stop",
      phase: "unknown",
      result: "unknown",
      reasonCode: "StopUnconfirmed",
      observation: undefined,
    },
  },
  ...[
    ["requested", "requested", "pending", "RequestReceived", undefined],
    ["accepted", "accepted", "pending", "DurablyAccepted", undefined],
    [
      "confirmed",
      "observed",
      "revoked",
      "ProviderConfirmed",
      { observedAt: "2026-01-01T00:00:00.500Z", source: "credential_provider" },
    ],
    ["unknown", "unknown", "unknown", "Unknown", undefined],
    [
      "expiry",
      "observed",
      "expired",
      "Expired",
      { observedAt: "2026-01-01T00:00:00.500Z", source: "controller" },
    ],
  ].map(([id, phase, result, reasonCode, observation]) => ({
    id: `revoke-${id}`,
    context: {
      source: "credential",
      category: "credential",
      action: "revoke",
      phase,
      result,
      reasonCode,
      observation,
      credential: { destination: "github", mode: "native", expiresAt: "2026-01-01T00:00:00.000Z" },
    },
  })),
  ...[
    ["accepted", "accepted", "pending", "DurablyAccepted"],
    ["queued", "accepted", "queued", "Queued"],
    ["busy", "observed", "busy", "Busy"],
    ["duplicate", "accepted", "duplicate", "Duplicate"],
    ["interrupted", "observed", "interrupted", "Interrupted"],
  ].map(([id, phase, result, reasonCode]) => ({
    id: `turn-${id}`,
    context: {
      category: "dispatch",
      action: "admit",
      phase,
      result,
      reasonCode,
      ...(phase === "accepted" ? { observation: undefined } : {}),
    },
  })),
  {
    id: "confinement-denied",
    context: {
      source: "runtime",
      category: "confinement",
      action: "admit",
      decision: "denied",
      result: "denied",
      reasonCode: "PolicyRejected",
    },
  },
  { id: "management-change", context: { source: "api", category: "management", action: "update" } },
];

export const canaries = Object.freeze([
  "SYNTHETIC_AUTHORIZATION_CANARY",
  "SYNTHETIC_COOKIE_CANARY",
  "SYNTHETIC_TOKEN_CANARY",
  "SYNTHETIC_SVID_CANARY",
  "SYNTHETIC_KEY_CANARY",
  "SYNTHETIC_NESTED_CANARY",
  "SYNTHETIC_URL_USER_CANARY",
  "SYNTHETIC_URL_QUERY_CANARY",
  "SYNTHETIC_URL_PATH_CANARY",
  "SYNTHETIC_EXCEPTION_CANARY",
  "SYNTHETIC_PROVIDER_CANARY",
  "SYNTHETIC_PROMPT_CANARY",
  "SYNTHETIC_TRANSCRIPT_CANARY",
  "SYNTHETIC_TOOL_CANARY",
  "SYNTHETIC_FILE_CANARY",
  "SYNTHETIC_LOG_CANARY",
  "SYNTHETIC_BENIGN_INPUT_FRAGMENT",
]);
export function hostileAudit(audit) {
  const c = canaries;
  let nested = { value: c[5] };
  for (let index = 0; index < 100; index++) nested = { nested };
  return {
    ...audit,
    actor: { principalId: c[0], issuer: c[1], subject: c[2], kind: "principal" },
    decisionReason: c[16],
    reasonCode: c[15],
    details: {
      authorization: `Bearer ${c[0]}`,
      cookie: c[1],
      accessToken: c[2],
      svid: c[3],
      privateKey: c[4],
      nested,
      url: `https://${c[6]}:password@example.invalid/${c[8]}?query=${c[7]}`,
      exception: new Error(c[9]),
      providerBody: c[10],
      prompt: c[11],
      transcript: c[12],
      toolOutput: c[13],
      fileContent: c[14],
      text: `\r\n${c[15]}\u001b[31m`,
      benign: c[16],
    },
    attackerExtension: c.join(":"),
  };
}
