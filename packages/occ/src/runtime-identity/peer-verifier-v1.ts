import {
  decodeRuntimeIdentityV1,
  type RuntimeIdentityFailureV1,
  type RuntimeRegistrationObservationV1,
  type RuntimeWorkloadExpectationV1,
  type RuntimeWorkloadTransportBindingV1,
  type RuntimeWorkloadVerificationResultV1,
  type RuntimeWorkloadVerifierV1,
  type TrustedRuntimeRegistrationReaderV1,
  type VerifiedWorkloadV1,
} from "@openclaw-enterprise/contracts/runtime-identity-v1";
import {
  parseRuntimeAuthorityV1,
  type RuntimeAuthorityCallBoundsV1,
} from "@openclaw-enterprise/contracts/runtime-authority-v1";

/** Installed by the connection owner. This is a callable capability, never a wire
 * message, Peer decoder or request-selected inspection. The owner must recheck
 * maintained native TLS/source/trust and admitted bundle state on every call.
 */
export interface RuntimeNativeConnectionObservationV1<OwnedConnection extends object> {
  readonly connection: OwnedConnection;
  readonly incarnation: object;
  readonly connectionRef: string;
  readonly peerSPIFFEId: string;
  readonly recipientRef: string;
  readonly identityProfileRef: string;
  readonly bundleSetVersion: number;
  readonly peerEvidenceRef: string;
  readonly authenticatedAt: string;
  readonly inspectedAt: string;
  readonly expiresAt: string;
}
export interface RuntimeNativeConnectionInspectorV1<OwnedConnection extends object> {
  inspect(
    connection: OwnedConnection,
    call: RuntimeAuthorityCallBoundsV1,
  ): Promise<
    | {
        readonly kind: "inspected";
        readonly observation: RuntimeNativeConnectionObservationV1<OwnedConnection>;
      }
    | RuntimeIdentityFailureV1
  >;
}
export interface RuntimePeerVerifierOptionsV1<OwnedConnection extends object> {
  readonly native: RuntimeNativeConnectionInspectorV1<OwnedConnection>;
  readonly registration: TrustedRuntimeRegistrationReaderV1<OwnedConnection>;
  /** Trusted construction only. Production defaults use wall and monotonic clocks. */
  readonly clock?: { now(): number; monotonicNow(): number };
}

const verifierRegistrations = new WeakMap<
  object,
  (proof: VerifiedWorkloadV1) => RuntimeRegistrationObservationV1 | undefined
>();
/** Original immutable registration metadata for exact guard correspondence only.
 * It supplies neither a new proof nor a fresh registration/currentness result.
 */
export function getRuntimeWorkloadVerifierRegistrationV1<C>(
  verifier: RuntimeWorkloadVerifierV1<C>,
  proof: VerifiedWorkloadV1,
): RuntimeRegistrationObservationV1 | undefined {
  return verifierRegistrations.get(verifier)?.(proof);
}

const verifierSettlements = new WeakMap<object, (signal: AbortSignal) => Promise<void>>();
/** Local implementation settlement participant for an owning guard. Undefined
 * means this module cannot attest to that verifier's raw-operation ownership.
 * Invoke after starting inspect/verify with the exact original signal.
 */
export function getRuntimeWorkloadVerifierSettlementV1<C>(
  verifier: RuntimeWorkloadVerifierV1<C>,
  signal: AbortSignal,
): Promise<void> | undefined {
  return verifierSettlements.get(verifier)?.(signal);
}

type FailureCode = RuntimeIdentityFailureV1["reasonCode"];
const transportCodes = new Set<FailureCode>([
  "cancelled",
  "deadline-exceeded",
  "connection-closed",
  "transport-unavailable",
  "protocol-invalid",
  "buffer-exhausted",
  "cleanup-unsettled",
]);
function failure(reasonCode: FailureCode, requestRef: string): RuntimeIdentityFailureV1 {
  if (transportCodes.has(reasonCode)) {
    return Object.freeze({
      schemaVersion: 1,
      kind: "transport-failure",
      reasonCode,
      requestRef,
    }) as RuntimeIdentityFailureV1;
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "verification-failure",
    reasonCode,
    requestRef,
  }) as RuntimeIdentityFailureV1;
}
function canonicalTime(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw "observation-invalid";
  return time;
}
function ref(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9._:/-]{1,200}$/.test(value);
}
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}
function snapshotExpectation(expected: RuntimeWorkloadExpectationV1): RuntimeWorkloadExpectationV1 {
  const limits = decodeRuntimeIdentityV1("limits", expected.limits);
  if (limits.kind !== "valid" || !ref(expected.recipientRef) || !ref(expected.identityProfileRef))
    throw "profile-invalid";
  // Server configuration is copied before any await. Exact target keys and values
  // are subsequently compared with the decoded canonical allocation.
  const target = structuredClone(expected.target);
  Object.freeze(target.assignmentRef);
  Object.freeze(target);
  return Object.freeze({
    target,
    limits: limits.value,
    expectedPeerSPIFFEId: expected.expectedPeerSPIFFEId,
    recipientRef: expected.recipientRef,
    identityProfileRef: expected.identityProfileRef,
  });
}

/** Actual local adapter. There is deliberately no default native or registration
 * producer. The accepting service installs the real protected native final hop.
 * Neither dependency's structural observations are independently accepted as proof.
 */
export function createRuntimeWorkloadVerifierV1<OwnedConnection extends object>(
  options: RuntimePeerVerifierOptionsV1<OwnedConnection>,
): RuntimeWorkloadVerifierV1<OwnedConnection> {
  // Capture methods and receivers once; replacing a public dependency property
  // later cannot replace this verifier's original authority participant.
  const inspectNative = options.native.inspect.bind(options.native);
  const resolveRegistration = options.registration.resolve.bind(options.registration);
  const now = options.clock ? options.clock.now.bind(options.clock) : Date.now;
  const monotonicNow = options.clock
    ? options.clock.monotonicNow.bind(options.clock)
    : performance.now.bind(performance);
  type Native = RuntimeNativeConnectionObservationV1<OwnedConnection>;
  type Owned = {
    connection: OwnedConnection;
    expected: RuntimeWorkloadExpectationV1;
    native: Native;
    registration: RuntimeRegistrationObservationV1;
    proof: VerifiedWorkloadV1;
    expiresMono: number;
    terminal?: FailureCode;
  };
  const proofs = new WeakMap<VerifiedWorkloadV1, Owned>();
  const connections = new WeakMap<
    OwnedConnection,
    {
      native: Native;
      binding: string;
      allocation: string;
      transportBinding: RuntimeWorkloadTransportBindingV1;
      recordVersion: number;
    }
  >();
  const operations = new WeakMap<AbortSignal, Set<Promise<void>>>();
  let pending = 0;

  function sanitized(
    value: unknown,
    requestRef: string,
    fallback: FailureCode,
  ): RuntimeIdentityFailureV1 {
    const decoded = decodeRuntimeIdentityV1("failure", value);
    if (decoded.kind !== "valid" || decoded.value.requestRef !== requestRef)
      return failure(fallback, requestRef);
    return decoded.value;
  }
  function compareNative(a: Native, b: Native): void {
    if (
      a.connection !== b.connection ||
      a.incarnation !== b.incarnation ||
      a.connectionRef !== b.connectionRef ||
      a.peerSPIFFEId !== b.peerSPIFFEId ||
      a.recipientRef !== b.recipientRef ||
      a.peerEvidenceRef !== b.peerEvidenceRef ||
      a.authenticatedAt !== b.authenticatedAt ||
      a.expiresAt !== b.expiresAt
    )
      throw "binding-mismatch";
    if (a.identityProfileRef !== b.identityProfileRef) throw "profile-reference-invalid";
    if (a.bundleSetVersion !== b.bundleSetVersion) throw "bundle-invalid";
  }

  async function perform(
    connection: OwnedConnection,
    expectedInput: RuntimeWorkloadExpectationV1,
    input: RuntimeAuthorityCallBoundsV1,
    owned?: Owned,
  ): Promise<RuntimeWorkloadVerificationResultV1> {
    let requestRef = "request/invalid";
    let release = () => {};
    try {
      if (!ref(input.requestRef)) throw "protocol-invalid";
      requestRef = input.requestRef;
      const expected = owned ? owned.expected : snapshotExpectation(expectedInput);
      if (input.recipientRef !== expected.recipientRef) throw "peer-mismatch";
      const started = now(),
        startedMono = monotonicNow();
      const duration = Math.min(
        canonicalTime(input.deadline) - started,
        expected.limits.assignmentDeadlineMs,
        owned ? owned.expiresMono - startedMono : Infinity,
      );
      if (!Number.isFinite(started) || !Number.isFinite(startedMono) || !Number.isFinite(duration))
        throw "observation-invalid";
      const controller = new AbortController();
      const originalSignal = input.signal;
      if (!(originalSignal instanceof AbortSignal)) throw "protocol-invalid";
      if (originalSignal.aborted) throw "cancelled";
      if (duration <= 0) throw "deadline-exceeded";
      if (pending >= expected.limits.maxPendingChecks) throw "buffer-exhausted";
      pending++;
      let terminal: RuntimeIdentityFailureV1 | undefined;
      let end!: (value: RuntimeIdentityFailureV1) => void;
      const stopped = new Promise<RuntimeIdentityFailureV1>((resolve) => {
        end = resolve;
      });
      const stop = (code: FailureCode) => {
        if (!terminal) {
          terminal = failure(code, requestRef);
          controller.abort();
          end(terminal);
        }
      };
      const cancel = () => stop("cancelled");
      originalSignal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => stop("deadline-exceeded"), Math.min(duration, 2_147_483_647));
      release = () => {
        clearTimeout(timer);
        originalSignal.removeEventListener("abort", cancel);
      };
      const call = Object.freeze({
        requestRef,
        recipientRef: expected.recipientRef,
        deadline: new Date(started + duration).toISOString(),
        signal: controller.signal,
      });
      const check = () => {
        if (originalSignal.aborted) stop("cancelled");
        if (now() >= started + duration || monotonicNow() >= startedMono + duration)
          stop("deadline-exceeded");
        if (owned?.terminal) stop(owned.terminal);
        if (terminal) throw terminal.reasonCode;
      };
      const native = async (): Promise<Native> => {
        check();
        const before = now();
        const result = await inspectNative(connection, call);
        check();
        if (result.kind !== "inspected")
          throw sanitized(result, requestRef, "transport-unavailable").reasonCode;
        const value = Object.freeze({ ...result.observation });
        if (
          value.connection !== connection ||
          typeof value.incarnation !== "object" ||
          value.incarnation === null
        )
          throw "binding-mismatch";
        if (
          value.peerSPIFFEId !== expected.expectedPeerSPIFFEId ||
          value.recipientRef !== expected.recipientRef
        )
          throw "peer-mismatch";
        if (value.identityProfileRef !== expected.identityProfileRef)
          throw "profile-reference-invalid";
        const inspectedAt = canonicalTime(value.inspectedAt),
          authenticatedAt = canonicalTime(value.authenticatedAt);
        const wall = now(),
          skew = expected.limits.clockSkewAllowanceMs;
        if (
          inspectedAt < before - skew ||
          inspectedAt > wall + skew ||
          authenticatedAt > inspectedAt + skew ||
          wall - inspectedAt > expected.limits.identityHealthMaxAgeMs
        )
          throw "evidence-stale";
        if (
          canonicalTime(value.expiresAt) <= wall ||
          authenticatedAt + expected.limits.connectionMaxAgeMs <= wall
        )
          throw "peer-expired";
        // The existing bounded decoder validates diagnostic strings and counters;
        // only the original callable/connection custody can establish provenance.
        const shape = decodeRuntimeIdentityV1("workloadDiagnostic", {
          schemaVersion: 1,
          spiffeId: value.peerSPIFFEId,
          component: expected.target.component,
          assignmentRef: expected.target.assignmentRef,
          bindingVersion: 1,
          identityProfileRef: value.identityProfileRef,
          registrationId: "registration/shape-check",
          registrationVersion: 1,
          bundleSetVersion: value.bundleSetVersion,
          verifiedAt: value.authenticatedAt,
          expiresAt: value.expiresAt,
          peerEvidenceRef: value.peerEvidenceRef,
          recipientRef: value.recipientRef,
          connectionRef: value.connectionRef,
        });
        if (shape.kind !== "valid") throw "observation-invalid";
        return value;
      };
      const work = async (): Promise<RuntimeWorkloadVerificationResultV1> => {
        try {
          const first = await native();
          if (owned) compareNative(owned.native, first);
          const connectionState = connections.get(connection);
          if (connectionState) compareNative(connectionState.native, first);
          const resolveStarted = now();
          const result = await resolveRegistration(connection, expected, call);
          check();
          if (result.kind !== "observed")
            return sanitized(result, requestRef, "lookup-unavailable");
          const observation = result.observation;
          const assignment = parseRuntimeAuthorityV1("assignmentRecord", observation.assignment);
          const registration: RuntimeRegistrationObservationV1 = Object.freeze({
            assignment,
            spiffeId: observation.spiffeId,
            registrationId: observation.registrationId,
            registrationVersion: observation.registrationVersion,
            identityProfileRef: observation.identityProfileRef,
            bundleSetVersion: observation.bundleSetVersion,
            sourceEvidenceRef: observation.sourceEvidenceRef,
            observedAt: observation.observedAt,
            validUntil: observation.validUntil,
          });
          const a = assignment.allocation;
          const exactTarget = {
            installationId: a.installationId,
            namespaceId: a.namespaceId,
            agentId: a.agentId,
            assignmentRef: { schemaVersion: 1, id: a.assignmentRef },
            revisionId: a.revisionId,
            component: a.component,
            lifecycleGeneration: a.lifecycleGeneration,
            runtimeGeneration: a.runtimeGeneration,
            createEffectRef: a.createEffectRef,
          };
          if (
            stable(expected.target) !== stable(exactTarget) ||
            assignment.binding.status !== "bound"
          )
            throw "binding-mismatch";
          if (assignment.binding.instance.component !== a.component) throw "component-denied";
          if (
            a.identityProfileRef !== expected.identityProfileRef ||
            registration.identityProfileRef !== expected.identityProfileRef
          )
            throw "profile-reference-invalid";
          if (registration.spiffeId !== first.peerSPIFFEId) throw "peer-mismatch";
          if (registration.bundleSetVersion !== first.bundleSetVersion) throw "bundle-invalid";
          if (
            !ref(registration.registrationId) ||
            !ref(registration.sourceEvidenceRef) ||
            !Number.isSafeInteger(registration.registrationVersion) ||
            registration.registrationVersion < 1
          )
            throw "observation-invalid";
          const observedAt = canonicalTime(registration.observedAt),
            validUntil = canonicalTime(registration.validUntil);
          const wall = now(),
            skew = expected.limits.clockSkewAllowanceMs;
          if (
            observedAt < resolveStarted - skew ||
            observedAt > wall + skew ||
            observedAt >= validUntil ||
            wall - observedAt > expected.limits.identityEvidenceMaxAgeMs ||
            validUntil <= wall
          )
            throw "evidence-stale";
          if (
            connectionState &&
            (connectionState.binding !== stable(assignment.binding) ||
              connectionState.allocation !== stable(assignment.allocation) ||
              assignment.authority.assignmentRecordVersion < connectionState.recordVersion)
          )
            throw "binding-mismatch";
          if (owned) {
            const previous = owned.registration;
            // Authority state/version may advance (including retirement). Identity
            // verification preserves the original immutable allocation and binding.
            if (
              stable(previous.assignment.allocation) !== stable(assignment.allocation) ||
              stable(previous.assignment.binding) !== stable(assignment.binding) ||
              assignment.authority.assignmentRecordVersion <
                previous.assignment.authority.assignmentRecordVersion ||
              registration.registrationId !== previous.registrationId ||
              registration.registrationVersion !== previous.registrationVersion
            )
              throw "binding-mismatch";
          }
          const last = await native();
          compareNative(first, last);
          check();
          const expiry = Math.min(
            canonicalTime(last.expiresAt),
            validUntil,
            canonicalTime(last.authenticatedAt) + expected.limits.connectionMaxAgeMs,
            canonicalTime(last.authenticatedAt) + expected.limits.svidLifetimeMs,
          );
          if (expiry <= now()) throw "peer-expired";
          if (connectionState) {
            if (assignment.authority.assignmentRecordVersion < connectionState.recordVersion)
              throw "binding-mismatch";
            connectionState.recordVersion = assignment.authority.assignmentRecordVersion;
          }
          if (owned) {
            if (validUntil < canonicalTime(owned.proof.expiresAt)) throw "evidence-stale";
            if (
              now() >= canonicalTime(owned.proof.expiresAt) ||
              monotonicNow() >= owned.expiresMono
            )
              throw "peer-expired";
            return { kind: "verified", proof: owned.proof };
          }
          let state = connections.get(connection);
          if (state) {
            compareNative(state.native, last);
            if (
              state.binding !== stable(assignment.binding) ||
              state.allocation !== stable(assignment.allocation) ||
              assignment.authority.assignmentRecordVersion < state.recordVersion
            )
              throw "binding-mismatch";
            // Another initial verification may have installed this state while
            // our native/registration checks awaited. Advance its high-water
            // version in this final synchronous branch before publishing proof.
            state.recordVersion = assignment.authority.assignmentRecordVersion;
          } else {
            state = {
              native: last,
              binding: stable(assignment.binding),
              allocation: stable(assignment.allocation),
              recordVersion: assignment.authority.assignmentRecordVersion,
              transportBinding: Object.freeze(
                Object.create(null),
              ) as RuntimeWorkloadTransportBindingV1,
            };
            connections.set(connection, state);
          }
          const transportBinding = state.transportBinding;
          const proof = Object.freeze({
            schemaVersion: 1,
            spiffeId: last.peerSPIFFEId,
            component: a.component,
            assignmentRef: Object.freeze({ schemaVersion: 1, id: a.assignmentRef }),
            bindingVersion: 1,
            identityProfileRef: registration.identityProfileRef,
            registrationId: registration.registrationId,
            registrationVersion: registration.registrationVersion,
            bundleSetVersion: registration.bundleSetVersion,
            verifiedAt: last.authenticatedAt,
            expiresAt: new Date(expiry).toISOString(),
            peerEvidenceRef: last.peerEvidenceRef,
            recipientRef: last.recipientRef,
            connectionRef: last.connectionRef,
            transportBinding,
          }) as VerifiedWorkloadV1;
          proofs.set(proof, {
            connection,
            expected,
            native: last,
            registration,
            proof,
            expiresMono: startedMono + Math.max(0, expiry - started),
          });
          return { kind: "verified", proof };
        } catch (error) {
          if (typeof error === "string") {
            const decoded = decodeRuntimeIdentityV1(
              "failure",
              failure(error as FailureCode, requestRef),
            );
            if (decoded.kind === "valid") return decoded.value;
          }
          return failure("observation-invalid", requestRef);
        } finally {
          // A timeout returns denial promptly but cannot free unsettled dependency
          // capacity or claim that the borrowed native operation stopped.
          pending--;
        }
      };
      const running = work();
      const settlement = running.then(
        () => {},
        () => {},
      );
      let active = operations.get(originalSignal);
      if (!active) {
        active = new Set();
        operations.set(originalSignal, active);
      }
      active.add(settlement);
      void settlement.then(() => {
        active.delete(settlement);
      });
      return await Promise.race([running, stopped]);
    } catch (error) {
      if (typeof error === "string") {
        const decoded = decodeRuntimeIdentityV1(
          "failure",
          failure(error as FailureCode, requestRef),
        );
        if (decoded.kind === "valid") return decoded.value;
      }
      return failure("observation-invalid", requestRef);
    } finally {
      release();
    }
  }
  const verifier: RuntimeWorkloadVerifierV1<OwnedConnection> = Object.freeze({
    verify(
      connection: OwnedConnection,
      expected: RuntimeWorkloadExpectationV1,
      call: RuntimeAuthorityCallBoundsV1,
    ) {
      return perform(connection, expected, call);
    },
    async inspect(proof: VerifiedWorkloadV1, call: RuntimeAuthorityCallBoundsV1) {
      const requestRef = ref(call.requestRef) ? call.requestRef : "request/invalid";
      const owned = proofs.get(proof);
      if (!owned) return failure("binding-mismatch", requestRef);
      if (owned.terminal) return failure(owned.terminal, requestRef);
      const result = await perform(owned.connection, owned.expected, call, owned);
      if (result.kind !== "verified") owned.terminal = result.reasonCode;
      if (owned.terminal) return failure(owned.terminal, requestRef);
      return result;
    },
  });
  verifierRegistrations.set(verifier, (proof) => proofs.get(proof)?.registration);
  verifierSettlements.set(verifier, async (signal) => {
    let active = operations.get(signal);
    while (active && active.size > 0) {
      await Promise.all([...active]);
      active = operations.get(signal);
    }
  });
  return verifier;
}
