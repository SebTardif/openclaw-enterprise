import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import * as contract from "../turn-journal-v1/values.mjs";
import { digestJournalAdmissionIdentityV1 } from "../../../packages/contracts/src/turn-journal-v1.ts";
import { seedRuntimeOwner } from "../../conformance/runtime-assignment-store.contract.mjs";
import { channelRecords } from "../../conformance/channel-binding-store.contract.mjs";
import { PostgresPlatformState } from "../../../packages/occ/src/state/postgres-state.ts";
import { TurnJournalStore } from "../../../packages/occ/src/turn-journal/store.ts";

const requireContracts = createRequire(
  new URL("../../../packages/contracts/package.json", import.meta.url),
);
const sdk = await import(
  pathToFileURL(requireContracts.resolve("openclaw/plugin-sdk/channel-inbound")).href
);

export const copy = (value) => structuredClone(value);
export const ref = (prefix) => `${prefix}-${randomUUID()}`;
export const digest = (value = randomUUID()) => createHash("sha256").update(value).digest("hex");
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// These are storage fixtures. The synthetic native envelope and opaque provenance
// owner exercise repository boundaries, not transport authentication, runtime
// authority, native canonical durability, or workspace/no-mutator evidence.
export async function seedJournalOwner(state) {
  const owner = await seedRuntimeOwner(state);
  const { app } = channelRecords(owner);
  await state.transact((unit) => unit.channelBindings.createChannelInstallation(app));
  return { ...owner, channelInstallation: app };
}

export function journalValues(owner, options = {}) {
  const now = options.now ?? Date.now();
  const context = {
    installationRef: owner.installation.id,
    namespaceRef: owner.namespace.id,
    agentRef: owner.agent.id,
    conversationRef: options.conversationRef ?? ref("conversation"),
  };
  const scope = {
    installationId: context.installationRef,
    namespaceId: context.namespaceRef,
    agentId: context.agentRef,
  };
  const attempt = {
    ...context,
    turnRef: ref("turn"),
    attemptRef: ref("attempt"),
    reservationRef: ref("reservation"),
  };
  const reservation = {
    schemaVersion: 1,
    scope,
    reservationRef: attempt.reservationRef,
    reservationVersion: 1,
  };
  const workspace = {
    schemaVersion: 1,
    scope,
    logicalStoreRef: ref("workspace"),
    bindingRef: ref("store-binding"),
    bindingVersion: 1,
  };
  const head = options.head ?? {
    context,
    headVersion: 1,
    completionSequence: 0,
    checkpointId: null,
    creationRef: ref("creation"),
  };
  const timestamp = new Date(now).toISOString();
  const nativeTimestamp = timestamp.replace(/Z$/, "000Z");
  const envelope = {
    schemaVersion: 1,
    adapterProfileRef: "slack-private-mentioned-v1",
    platform: "slack",
    installationRef: context.installationRef,
    channelInstallationRef:
      options.channelInstallationRef ??
      owner.channelInstallation?.id ??
      ref("channel-installation"),
    providerTenantRef: owner.channelInstallation?.providerTenantRef ?? "storage-tenant",
    recipientAppRef: owner.channelInstallation?.recipientAppRef ?? "storage-app",
    sender: { kind: "human", providerSubjectRef: ref("subject") },
    event: {
      providerEventRef: ref("event"),
      eventKind: "app_mention",
      occurredAt: nativeTimestamp,
      eventDigest: "0".repeat(64),
    },
    message: {
      providerMessageRef: ref("message"),
      logicalMessageKey: "0".repeat(64),
      contentDigest: digest(),
    },
    nativeConversation: {
      channelRef: ref("channel"),
      scope: "slack-private-channel",
      rootThreadRef: ref("thread"),
    },
    replyBindingCandidateRef: ref("reply-candidate"),
    contentRef: ref("content"),
    receivedAt: nativeTimestamp,
    verifiedAt: nativeTimestamp,
    verifierEvidenceRef: ref("verification"),
    deliveryRef: ref("transport"),
  };
  envelope.message.logicalMessageKey = sdk.hostedChannelLogicalMessageKeyV1(envelope);
  envelope.event.eventDigest = sdk.digestHostedChannelEventV1(envelope);
  const receipt = {
    ...copy(contract.receipt),
    receiptRef: ref("receipt"),
    eventKey: sdk.hostedChannelEventKeyV1(envelope),
    logicalMessageKey: envelope.message.logicalMessageKey,
    eventDigest: envelope.event.eventDigest,
    contentDigest: envelope.message.contentDigest,
  };
  const locator = {
    schemaVersion: 1,
    installationRef: context.installationRef,
    channelInstallationRef: envelope.channelInstallationRef,
    eventKey: receipt.eventKey,
    logicalMessageKey: receipt.logicalMessageKey,
  };
  const identity = {
    ...copy(contract.identity),
    locator,
    receipt,
    context,
    workspace,
    principalRef: ref("principal"),
    providerSubjectRef: envelope.sender.providerSubjectRef,
    externalIdentityBindingRef: ref("identity-binding"),
    routeKey: sdk.hostedChannelRouteKeyV1(envelope),
    commonGrantRef: ref("grant"),
    replyDestinationRef: ref("destination"),
    admittedRevisionRef: owner.revision.id,
    gatewayAssignment: { schemaVersion: 1, id: randomUUID() },
    harnessAssignment: { schemaVersion: 1, id: randomUUID() },
    contentRef: envelope.contentRef,
  };
  const observation = {
    envelope,
    identity,
    expectedHead: head,
    reservation,
    attempt,
    decisionRef: ref("decision"),
    auditIntentRef: ref("audit"),
  };
  const binding = {
    attempt,
    identity,
    reservation,
    expectedHead: head,
    dispatchOperationRef: ref("dispatch"),
    authorityDecisionRef: ref("authority"),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  const consumption = {
    schemaVersion: 1,
    attempt,
    operationRef: ref("consume"),
    claimantRef: ref("claimant"),
    requestDigest: digest(),
  };
  const allocation = {
    schemaVersion: 1,
    attempt,
    operationRef: ref("allocate"),
    checkpointId: ref("checkpoint"),
    expectedHead: head,
  };
  const checkpoint = {
    ...copy(contract.checkpoint),
    ...attempt,
    checkpointId: allocation.checkpointId,
    completionSequence: head.completionSequence + 1,
    parentCheckpointId: head.checkpointId,
    revisionRef: owner.revision.id,
    admittedConfigurationDigest: identity.admittedConfigurationDigest,
    producingGatewayAssignmentRef: identity.gatewayAssignment.id,
    producingHarnessAssignmentRef: identity.harnessAssignment.id,
    workspaceBindingRef: workspace.bindingRef,
    workspaceCompletionRef: ref("workspace-completion"),
  };
  const completionOperation = {
    schemaVersion: 1,
    attempt,
    operationRef: ref("complete"),
    checkpointId: allocation.checkpointId,
    expectedCompletionSequence: head.completionSequence,
    expectedAttemptVersion: 3,
    requestDigest: digest(),
  };
  const delivery = {
    ...copy(contract.deliveryOperation),
    attempt,
    operationRef: ref("delivery"),
    outcomeVersion: 4,
    replyDestinationRef: identity.replyDestinationRef,
  };
  const completion = {
    operation: completionOperation,
    allocation,
    canonical: {
      kind: "verified",
      checkpointRef: checkpoint,
      verificationReceiptRef: ref("canonical-verification"),
    },
    nativeTerminalEvidenceRef: ref("native-terminal"),
    workspaceCompletionRef: checkpoint.workspaceCompletionRef,
    noMutatorEvidenceRef: ref("no-mutator"),
    gatewayAssignment: identity.gatewayAssignment,
    harnessAssignment: identity.harnessAssignment,
    reservation,
    pendingDelivery: delivery,
  };
  const release = {
    ...copy(contract.release),
    attempt,
    reservation,
    workspace,
    releaseOperationRef: ref("release"),
    expectedAttemptVersion: 4,
  };
  const outcome = {
    ...copy(contract.outcome),
    attempt,
    operationRef: ref("outcome"),
    expectedAttemptVersion: 3,
    requestDigest: digest(),
  };
  const cancellation = {
    schemaVersion: 1,
    attempt,
    operationRef: ref("cancel"),
    requesterPrincipalRef: ref("requester"),
    originalPrincipalRef: identity.principalRef,
    expectedAttemptVersion: 1,
    requestDigest: digest(),
  };
  const rejected = {
    schemaVersion: 1,
    envelope,
    receipt,
    decision: { kind: "denied", reason: "not-current" },
    decisionRef: ref("denied-decision"),
    auditIntentRef: ref("denied-audit"),
    decidedAt: timestamp,
  };
  const nonTurn = {
    ...copy(contract.nonTurn),
    installationRef: context.installationRef,
    channelInstallationRef: locator.channelInstallationRef,
    providerTenantRef: envelope.providerTenantRef,
    recipientAppRef: envelope.recipientAppRef,
    eventKey: digest(),
    eventDigest: digest(),
    logicalMessage: { kind: "related-only", logicalMessageKey: locator.logicalMessageKey },
  };
  return {
    owner,
    now,
    context,
    scope,
    attempt,
    reservation,
    workspace,
    head,
    envelope,
    receipt,
    locator,
    identity,
    observation,
    binding,
    consumption,
    allocation,
    checkpoint,
    completionOperation,
    delivery,
    completion,
    release,
    outcome,
    cancellation,
    rejected,
    nonTurn,
  };
}

export function eventLookup(values) {
  const locator = values.identity?.locator ?? values.locator;
  return {
    schemaVersion: 1,
    kind: "event",
    installationRef: locator.installationRef,
    channelInstallationRef: locator.channelInstallationRef,
    eventKey: locator.eventKey,
  };
}
export function logicalLookup(values) {
  const locator = values.identity?.locator ?? values.locator;
  return {
    schemaVersion: 1,
    kind: "logical-message",
    installationRef: locator.installationRef,
    channelInstallationRef: locator.channelInstallationRef,
    logicalMessageKey: locator.logicalMessageKey,
  };
}
export function incomingLookup(identity) {
  return {
    locator: identity.locator,
    incomingEventDigest: identity.receipt.eventDigest,
    incomingContentDigest: identity.receipt.contentDigest,
    incomingIdentityDigest: digestJournalAdmissionIdentityV1(identity),
  };
}

export function changedIncoming(values, change) {
  const next = copy(values);
  change(next);
  next.envelope.message.logicalMessageKey = sdk.hostedChannelLogicalMessageKeyV1(next.envelope);
  next.envelope.event.eventDigest = sdk.digestHostedChannelEventV1(next.envelope);
  Object.assign(next.receipt, {
    receiptRef: ref("receipt"),
    eventKey: sdk.hostedChannelEventKeyV1(next.envelope),
    logicalMessageKey: next.envelope.message.logicalMessageKey,
    eventDigest: next.envelope.event.eventDigest,
    contentDigest: next.envelope.message.contentDigest,
  });
  Object.assign(next.locator, {
    eventKey: next.receipt.eventKey,
    logicalMessageKey: next.receipt.logicalMessageKey,
  });
  next.identity.providerSubjectRef = next.envelope.sender.providerSubjectRef;
  next.identity.routeKey = sdk.hostedChannelRouteKeyV1(next.envelope);
  next.observation.decisionRef = ref("decision");
  next.observation.auditIntentRef = ref("audit");
  next.rejected.decisionRef = ref("rejected-decision");
  next.rejected.auditIntentRef = ref("rejected-audit");
  return next;
}

export function journalHarness(pool, options = {}) {
  const provenance = options.provenance ?? storageProvenance(options);
  const state = new PostgresPlatformState(pool, { turnJournal: provenance.options });
  const store = new TurnJournalStore({
    state,
    clock: provenance.clock,
    initiation: options.initiation ?? provenance.initiation,
  });
  const call = provenance.call();
  return {
    pool,
    state,
    store,
    provenance,
    call,
    issue: (kind, value) => provenance.issue(kind, value),
    read: (work, exactCall = call) => store.read(work, exactCall),
    write: (work, exactCall = call) => store.transact(ref("transaction"), work, exactCall),
    mutate: (work) => state.transact((unit) => work(unit.turnJournal)),
  };
}

export function storageProvenance(options = {}) {
  const handles = new WeakMap();
  const calls = new WeakSet();
  const revoked = new WeakSet();
  const gates = new Map();
  const inspections = [];
  let allowed = true;
  const now = options.now ?? (() => Date.now());
  const clock = { now: () => new Date(now()), monotonicMilliseconds: () => performance.now() };
  const validCall = (call) =>
    calls.has(call.context) &&
    !call.signal.aborted &&
    Date.parse(call.deadline) > now() &&
    call.recipientRef === "storage-journal";
  const inspect = (kind) => async (handle, call) => {
    inspections.push(kind);
    const stored = handles.get(handle);
    if (!validCall(call) || !allowed || revoked.has(handle) || stored?.kind !== kind)
      return { kind: "denied" };
    if (gates.has(kind)) await gates.get(kind);
    if (!validCall(call) || !allowed || revoked.has(handle)) return { kind: "denied" };
    return copy(stored.value);
  };
  const admission = { inspect: inspect("admission"), inspectRejected: inspect("rejected") };
  const nonTurn = { inspectNonTurn: inspect("nonTurn") };
  const evidence = {
    inspectDispatch: inspect("dispatch"),
    inspectConsumption: inspect("consumption"),
    inspectCompletion: inspect("completion"),
    inspectRelease: inspect("release"),
    inspectOutcome: inspect("outcome"),
    inspectDelivery: inspect("delivery"),
    inspectCancellation: inspect("cancellation"),
  };
  const authorization = {
    authorize: async (_request, call) =>
      validCall(call) && allowed ? { kind: "authorized" } : { kind: "denied" },
  };
  return {
    options: {
      bind: () => ({
        admission,
        nonTurn,
        evidence,
        authorization,
      }),
      canonicalRouteKey: sdk.hostedChannelRouteKeyV1,
      capacity: {
        maxOwnersPerInstallation: 10_000,
        maxIncomingLinksPerInstallation: 20_000,
        maxAttemptsPerInstallation: 10_000,
        ...options.capacity,
      },
    },
    clock,
    initiation: {
      async assertCurrent(_view, record, operation, call) {
        if (
          !validCall(call) ||
          !allowed ||
          !isDeepStrictEqual(copy(record.consumption?.operation), copy(operation))
        )
          throw new Error("Storage fixture authority unavailable.");
        return { expiresAt: new Date(now() + 5_000).toISOString(), signal: call.signal };
      },
    },
    inspections,
    call(overrides = {}) {
      const context = Object.freeze({});
      calls.add(context);
      return {
        context,
        requestRef: ref("request"),
        recipientRef: "storage-journal",
        deadline: new Date(now() + 30_000).toISOString(),
        signal: new AbortController().signal,
        ...overrides,
      };
    },
    issue(kind, value) {
      const handle = Object.freeze({});
      handles.set(handle, { kind, value: copy(value) });
      return handle;
    },
    revoke(handle) {
      revoked.add(handle);
    },
    setAllowed(value) {
      allowed = value;
    },
    hold(kind, promise) {
      gates.set(kind, promise);
    },
    unhold(kind) {
      gates.delete(kind);
    },
  };
}
