import {
  parseRuntimeAuthorityV1,
  type AuthorityCallV1,
  type ResolveAssignmentRequestV1,
  type RuntimeAssignmentAuthorityV1,
  type RuntimeAuthorityTrustedContextV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type {
  RuntimeIdentityPurposeGuardV1,
  RuntimeIdentityLimitsV1,
  RuntimeIdentityStreamV1,
  RuntimeWorkloadDiagnosticV1,
  TrustedRuntimeRegistrationReaderV1,
  VerifiedWorkloadV1,
} from "@openclaw-enterprise/contracts/runtime-identity-v1";
import {
  createRuntimeWorkloadVerifierV1,
  type RuntimeNativeConnectionInspectorV1,
} from "../../../packages/occ/src/runtime-identity/peer-verifier-v1.ts";
import {
  createRuntimeIdentityPurposeGuardV1,
  type RuntimeIdentityClockV1,
} from "../../../packages/occ/src/runtime-identity/purpose-guard-v1.ts";
import { fixtureIdentityLimits } from "../runtime-identity-v1/verifier-producer.ts";
import * as vectors from "../runtime-authority-v1/vectors.mjs";

/** Test-only deterministic dependency timing. These are no live profile, registry,
 * authority producer, sandbox attestation or native final-hop qualification. */
export class ControlledClock implements RuntimeIdentityClockV1 {
  wall = Date.parse(vectors.now);
  mono = 0;
  #next = 0;
  #timers = new Map<number, { at: number; callback: () => void }>();
  now() {
    return this.wall;
  }
  monotonicNow() {
    return this.mono;
  }
  schedule(callback: () => void, delayMs: number) {
    const id = ++this.#next;
    this.#timers.set(id, { at: this.mono + delayMs, callback });
    return () => {
      this.#timers.delete(id);
    };
  }
  advance(ms: number, wallMs = ms) {
    const end = this.mono + ms;
    const wallEnd = this.wall + wallMs;
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, timer] = due;
      this.wall += timer.at - this.mono;
      this.mono = timer.at;
      this.#timers.delete(id);
      timer.callback();
    }
    this.mono = end;
    this.wall = wallEnd;
  }
  get timerCount() {
    return this.#timers.size;
  }
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export async function flush() {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}

export async function controlledFixture(
  context: RuntimeAuthorityTrustedContextV1,
  patch: Partial<RuntimeIdentityLimitsV1> = {},
) {
  const clock = new ControlledClock();
  const abort = new AbortController();
  const connection = Object.freeze({ name: "original-owned-test-connection" });
  const state: {
    incarnation: object;
    nativeGate: Promise<void> | undefined;
    resolveGate: Promise<void> | undefined;
    registrationGate: Promise<void> | undefined;
    response: unknown;
    registrationWithdrawn: boolean;
    freshSourceTimes: boolean;
  } = {
    incarnation: Object.freeze({ attempt: 1 }),
    nativeGate: undefined,
    resolveGate: undefined,
    registrationGate: undefined,
    response: vectors.current(),
    registrationWithdrawn: false,
    freshSourceTimes: true,
  };
  const limits = {
    ...fixtureIdentityLimits,
    maxPendingChecks: 8,
    streamRecheckMs: 100,
    identityHealthPollMs: 100,
    identityHealthMaxAgeMs: 500,
    streamCloseDeadlineMs: 30,
    ...patch,
  };
  const target = parseRuntimeAuthorityV1("resolveResult", vectors.current());
  if (target.result !== "current") throw new Error("Invalid controlled target.");
  const assignment = parseRuntimeAuthorityV1("assignmentRecord", {
    schemaVersion: 1,
    allocation: {
      ...vectors.scope,
      providerProfileRef: "provider/example",
      runtimeProfileRef: "runtime/example",
      identityProfileRef: "identity/example",
      assignmentRef: vectors.id(4),
      createEffectRef: vectors.id(6),
      revisionId: `rev_${vectors.id(5)}`,
      servicePrincipalId: `service-agent-${vectors.scope.agentId}`,
      lifecycleGeneration: 1,
      component: "harness",
      runtimeGeneration: 1,
      bindingCondition: "unbound",
      createdAt: vectors.now,
    },
    binding: { status: "bound", instance: vectors.binding() },
    authority: { state: "bound", assignmentRecordVersion: 2 },
  });
  const nativeCalls: unknown[] = [];
  const resolverCalls: { request: ResolveAssignmentRequestV1; call: AuthorityCallV1 }[] = [];
  const native: RuntimeNativeConnectionInspectorV1<typeof connection> = {
    async inspect(owned, call) {
      nativeCalls.push({ connection: owned, call });
      if (state.nativeGate) await state.nativeGate;
      return {
        kind: "inspected",
        observation: {
          connection: owned,
          incarnation: state.incarnation,
          connectionRef: "connection/test",
          peerSPIFFEId: "spiffe://example.org/runtime/test/harness",
          recipientRef: "recipient/test",
          identityProfileRef: "identity/example",
          bundleSetVersion: 1,
          peerEvidenceRef: "peer/test",
          authenticatedAt: vectors.now,
          inspectedAt: new Date(clock.now()).toISOString(),
          expiresAt: "2026-01-01T00:01:00.000Z",
        },
      };
    },
  };
  const registration: TrustedRuntimeRegistrationReaderV1<typeof connection> = {
    async resolve() {
      if (state.registrationGate) await state.registrationGate;
      if (state.registrationWithdrawn)
        return {
          schemaVersion: 1,
          kind: "verification-failure",
          reasonCode: "lookup-unavailable",
          requestRef: "request/example",
        };
      return {
        kind: "observed",
        observation: {
          assignment,
          spiffeId: "spiffe://example.org/runtime/test/harness",
          registrationId: "registration/example",
          registrationVersion: 1,
          identityProfileRef: "identity/example",
          bundleSetVersion: 1,
          sourceEvidenceRef: "registration/test",
          observedAt: new Date(clock.now()).toISOString(),
          validUntil: vectors.until,
        },
      };
    },
  };
  const authority: Pick<RuntimeAssignmentAuthorityV1, "resolve"> = {
    async resolve(request, call) {
      resolverCalls.push({ request, call });
      if (state.resolveGate) await state.resolveGate;
      const value = structuredClone(state.response);
      if (state.freshSourceTimes) {
        const stamp = (node: unknown): void => {
          if (!node || typeof node !== "object") return;
          const record = node as Record<string, unknown>;
          for (const key of ["evaluatedAt", "sourceObservedAt", "receivedAt"])
            if (key in record) record[key] = new Date(clock.now()).toISOString();
          for (const child of Object.values(record)) stamp(child);
        };
        stamp(value);
      }
      return parseRuntimeAuthorityV1("resolveResult", value);
    },
  };
  const verifier = createRuntimeWorkloadVerifierV1({ native, registration, clock });
  const call: AuthorityCallV1 = Object.freeze({
    context,
    signal: abort.signal,
    requestRef: "request/example",
    recipientRef: "recipient/test",
    deadline: vectors.until,
  });
  const expected = {
    target: target.snapshot.target,
    expectedPeerSPIFFEId: "spiffe://example.org/runtime/test/harness",
    recipientRef: call.recipientRef,
    identityProfileRef: "identity/example",
    limits,
  };
  const verified = await verifier.verify(connection, expected, call);
  if (verified.kind !== "verified")
    throw new Error(`Controlled verifier failed: ${verified.reasonCode}`);
  const guard: RuntimeIdentityPurposeGuardV1 = createRuntimeIdentityPurposeGuardV1({
    verifier,
    authority,
    limits,
    clock,
  });
  const request = parseRuntimeAuthorityV1("resolveRequest", vectors.resolveRequest());
  return {
    clock,
    abort,
    connection,
    state,
    limits,
    call,
    expected,
    request,
    proof: verified.proof,
    native,
    registration,
    verifier,
    authority,
    guard,
    nativeCalls,
    resolverCalls,
  };
}

/** Uncalled strict public consumer: accepted ports and actual implementation imports only. */
export async function consume(
  guard: RuntimeIdentityPurposeGuardV1,
  proof: VerifiedWorkloadV1,
  request: ResolveAssignmentRequestV1,
  call: AuthorityCallV1,
  limits: RuntimeIdentityLimitsV1,
) {
  const checked = await guard.check(proof, request, call);
  const opened = await guard.openStream(proof, request, call, limits);
  if (opened.kind === "opened") {
    const stream: RuntimeIdentityStreamV1 = opened.stream;
    stream.invalidate("watch-gap");
    await stream.close();
  }
  return checked;
}
export function rejectShortcuts(
  guard: RuntimeIdentityPurposeGuardV1,
  diagnostic: RuntimeWorkloadDiagnosticV1,
  request: ResolveAssignmentRequestV1,
  call: AuthorityCallV1,
) {
  // @ts-expect-error A diagnostic is not a verifier-owned proof.
  void guard.check(diagnostic, request, call);
  // @ts-expect-error Call custody and its original context cannot be omitted.
  void guard.check(diagnostic, request, { signal: call.signal });
  // @ts-expect-error A readiness observation cannot be relabelled as a serving result.
  const purpose: Extract<
    Awaited<ReturnType<RuntimeAssignmentAuthorityV1["resolve"]>>,
    { result: "current" }
  >["purpose"] = "readiness-probe";
  return purpose;
}
