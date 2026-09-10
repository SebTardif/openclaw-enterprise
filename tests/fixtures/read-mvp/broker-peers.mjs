import { createHash } from "node:crypto";
import { GitHubMediationService } from "../../../packages/occ/src/github-mediation-v2/service.ts";
import { githubGitReadDigest } from "../../../packages/occ/src/github-mediation-v2/wire.ts";
import { trust } from "../runtime-authority-v1/vectors.mjs";

export const metadataBytes = (value) => new TextEncoder().encode(JSON.stringify(value));
export const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// Request construction uses the maintained wire digest. Independent digest
// vectors belong to github-mediation-v2.test.mjs; this fixture tests no hashing rule.
export function readRequest({
  operation = "discovery",
  body = new Uint8Array(0),
  owner = "example",
  name = "project",
  requestRef = "0123456789abcdef0123456789abcdef",
} = {}) {
  const bodySha256 = sha256(body);
  return Object.freeze({
    version: 3,
    sequence: 1,
    request_ref: requestRef,
    method: "open-read",
    attachment_ref: "attachment/read-mvp",
    repository_owner: owner,
    repository_name: name,
    git_operation: operation,
    git_protocol: "version=2",
    body_bytes: body.byteLength,
    body_sha256: bodySha256,
    request_sha256: githubGitReadDigest(owner, name, operation, body.byteLength, bodySha256),
  });
}

export function bindingFrom(reply) {
  const { version, request_ref, session_ref, effect_ref, work_binding_sha256, request_sha256 } =
    reply;
  return { version, request_ref, session_ref, effect_ref, work_binding_sha256, request_sha256 };
}

// A gate delays one selected owner response. It has no authorization or retry logic.
export function deferredGate() {
  let enter;
  let resolve;
  const entered = new Promise((done) => {
    enter = done;
  });
  const released = new Promise((done) => {
    resolve = done;
  });
  return {
    entered,
    resolve,
    async wait(value) {
      enter(value);
      await released;
    },
  };
}

/** Component-port fixture only: real V3 broker and wire codec, controlled native
 * transport observation and operation-owner responses. Opaque objects below are
 * mock operands, never real Work, repository authority, committed custody, TLS,
 * or token bytes. The fixture records calls and supplies inputs; only the broker
 * decides sequence, identity currentness, release routing and settlement timing.
 *
 * steps[name](fixture, ...portArguments) replaces a response at that declared
 * port before service construction. No product method is patched. A test that
 * delays a step must register its gate with hold() so cleanup cannot leave it open.
 */
export function createBrokerPeers(t, { request = readRequest(), steps = {}, limits = {} } = {}) {
  const began = Date.now();
  const operationUntil = began + 20_000;
  const controller = new AbortController();
  const call = Object.freeze({
    context: Object.freeze({}),
    requestRef: request.request_ref,
    recipientRef: "recipient/read-mvp-broker",
    deadline: new Date(began + 25_000).toISOString(),
    signal: controller.signal,
  });
  const vector = trust();
  const scope = {
    installationRef: vector.installationId,
    namespaceRef: vector.allowedScope.namespaceId,
    agentRef: vector.allowedScope.agentId,
  };
  const peer = {
    observation: {
      configuration: {
        ...vector,
        role: "repository-issuer",
        permittedRecipientRef: call.recipientRef,
      },
      authenticatedAt: new Date(began - 100).toISOString(),
      expiresAt: new Date(began + 30_000).toISOString(),
      peerEvidenceRef: "evidence/controlled-read-mvp",
      transportBinding: Object.freeze({}),
    },
  };
  const preparation = Object.freeze({ mockOperand: "preparation" });
  const release = Object.freeze({ mockOperand: "release" });
  const events = [];
  const replies = [];
  const releaseWrites = [];
  const holds = new Set();
  const f = {
    request,
    call,
    controller,
    peer,
    preparation,
    release,
    events,
    replies,
    releaseWrites,
    times: () => ({
      server_time_ms: Date.now(),
      valid_until_ms: Math.min(Date.now() + 5_000, operationUntil),
      operation_until_ms: operationUntil,
    }),
    prepared: () => ({
      kind: "prepared",
      preparation,
      original: {
        operationRef: "effect/read-mvp",
        requestDigest: request.request_sha256,
        invocationRef: "invocation/read-mvp",
        scope: { ...scope, revisionRef: "rev_00000000-0000-4000-8000-000000000005" },
      },
      work: { workRef: "work/read-mvp", revision: 1 },
      execution: {
        attempt: {
          ...scope,
          conversationRef: "conversation/read-mvp",
          turnRef: "turn/read-mvp",
          attemptRef: "attempt/read-mvp",
          reservationRef: "reservation/read-mvp",
        },
        assignmentRef: "assignment/read-mvp",
        assignmentVersion: "1",
        executionIncarnationRef: "incarnation/read-mvp",
        executionGeneration: "1",
        receiverRef: "receiver/read-mvp",
        protectedOriginRef: "origin/read-mvp",
        executionProfile: { ref: "profile/read-mvp", revision: "1" },
        predecessor: { kind: "none" },
      },
      originalHorizon: new Date(operationUntil).toISOString(),
      workBindingSha256: `sha256:${"b".repeat(64)}`,
      dnsBindingRef: "dns/read-mvp",
      // A public address is required by the real wire grammar; no socket is opened.
      upstreamIpv4: "140.82.114.5",
      times: f.times(),
    }),
    released: () => ({
      kind: "released",
      release,
      releaseRef: "release/read-mvp",
      times: f.times(),
    }),
    hold(gate) {
      holds.add(gate);
      return gate;
    },
  };
  const invoke = (name, fallback, ...args) =>
    Object.hasOwn(steps, name) ? steps[name](f, ...args) : fallback();
  const transport = {
    async inspect(input, metadataSha256) {
      events.push({ kind: "inspect", call: input, metadataSha256 });
      return invoke("inspect", () => peer.observation, input, metadataSha256);
    },
    async writeMetadata(bytes, input) {
      const reply = JSON.parse(new TextDecoder().decode(bytes));
      events.push({ kind: "writeMetadata", call: input, reply });
      replies.push(reply);
      return invoke("writeMetadata", () => undefined, bytes, input);
    },
    async close(input) {
      events.push({ kind: "close", call: input });
      return invoke("close", () => undefined, input);
    },
  };
  const operations = {
    async prepare(input, inputCall) {
      events.push({ kind: "prepare", request: input, call: inputCall });
      return invoke("prepare", () => f.prepared(), input, inputCall);
    },
    async dispatch(inputPreparation, input, inputCall) {
      events.push({
        kind: "dispatch",
        preparation: inputPreparation,
        request: input,
        call: inputCall,
      });
      return invoke("dispatch", () => f.released(), inputPreparation, input, inputCall);
    },
    async check(inputPreparation, inputRelease, inputCall) {
      events.push({
        kind: "check",
        preparation: inputPreparation,
        release: inputRelease,
        call: inputCall,
      });
      return invoke(
        "check",
        () => ({ kind: "current", times: f.times() }),
        inputPreparation,
        inputRelease,
        inputCall,
      );
    },
    async writeRelease(inputRelease, bytes, inputCall) {
      const reply = JSON.parse(new TextDecoder().decode(bytes));
      events.push({ kind: "writeRelease", release: inputRelease, reply, call: inputCall });
      releaseWrites.push({
        release: inputRelease,
        reply,
        bytes: Uint8Array.from(bytes),
        call: inputCall,
      });
      return invoke("writeRelease", () => undefined, inputRelease, bytes, inputCall);
    },
    async settle(inputPreparation, inputRelease, outcome) {
      events.push({
        kind: "settle",
        preparation: inputPreparation,
        release: inputRelease,
        outcome,
      });
      return invoke("settle", () => "recorded", inputPreparation, inputRelease, outcome);
    },
  };
  f.service = new GitHubMediationService({
    protocolVersion: 3,
    transport,
    operations,
    limits: {
      maximumSessions: 2,
      maximumCallMilliseconds: 5_000,
      maximumOperationMilliseconds: 25_000,
      maximumLeaseMilliseconds: 6_000,
      clockAllowanceMilliseconds: 100,
      ...limits,
    },
  });
  f.send = (value, inputCall = call) => f.service.handle(metadataBytes(value), inputCall);
  t.after(async () => {
    controller.abort();
    for (const gate of holds) gate.resolve();
    await f.service.stop();
  });
  return f;
}
