import { randomUUID } from "node:crypto";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import { CREDENTIAL_STORAGE_LIMITS_V1 } from "@openclaw-enterprise/contracts/credential-storage-v1";
import {
  canonicalRepositoryInventoryV2,
  parseRepositoryTokenMutationV2,
  repositoryInventoryDigestV2,
  type RepositoryInventoryOperationV2,
  type RepositoryTokenMutationV2,
  type RepositoryTokenRecordV2,
  type ReserveRepositoryTokenV2,
} from "../credential-inventory-v1/repository-lease-v2.ts";
import {
  decodeGitHubMediationRequest,
  type GitHubMediationVersion,
  type OpenRead,
} from "../github-mediation-v2/wire.ts";
import {
  snapshotGitHubAppKeyIdentityV1,
  type GitHubAppKeyIdentityV1,
  type GitHubAppMaterialV1,
} from "../github-app-provider-v1/material.ts";
import type {
  GitHubAppEndpointV1,
  GitHubAppMintResultV1,
  GitHubAppRevokeResultV1,
} from "../github-app-provider-v1/provider.ts";
import {
  RepositoryWorkStateAdapterV2,
  type RepositoryWorkInventoryResponsibilityV2,
  type RepositoryWorkInventoryResultV2,
  type RepositoryWorkSelectionSourceV2,
  type RepositoryWorkStatePreparationV2,
} from "../lifecycle/repository-work-state-v2.ts";
import {
  repositoryWorkCurrentPolicyArmV2,
  repositoryWorkGitReadBindingV3,
  type RepositoryWorkCurrentV2,
  type RepositoryWorkNativeBindingV2,
  type RepositoryWorkSourcesV2,
} from "../lifecycle/repository-work-v2.ts";
import type {
  RepositoryWorkCommittedV2,
  RepositoryWorkCustodySourceV2,
  RepositoryWorkCustodyLeaseV2,
  RepositoryWorkInventoryFactsV2,
  RepositoryWorkStateBindingV2,
} from "../ports/repository-work-v2.ts";
import {
  ProtectedGitHubCryptoV1,
  ProtectedGitHubCustodyErrorV1,
} from "./protected-github-crypto.ts";
import type {
  ProtectedGitHubNativeSourceV2,
  ProtectedGitHubReleaseBindingV2,
} from "./protected-github-release.ts";
import {
  ProtectedGitHubTokenCustodyV1,
  type ProtectedGitHubRetentionV1,
} from "./protected-github-token-custody.ts";
import { ProtectedGitHubTokenStoreV1 } from "./protected-github-token-store.ts";
import type { CustodyClockV1 } from "./ports.ts";
import {
  RepositoryWorkOriginOwnerV2,
  type OriginalRepositoryWorkOriginV2,
  type RepositoryWorkNativeSessionSourceV2,
  type RepositoryWorkOriginAssignmentSourceV2,
  type RepositoryWorkOriginLimitsV2,
  type RepositoryWorkOriginNativeRecognizerV2,
} from "../runtime-authority/repository-work-origin-v2.ts";
import type { RuntimeServiceTrustService } from "../runtime-authority/service-trust.ts";
import type { WorkRepositoryGitReadV3 } from "../lifecycle/work-authority-ports-v2.ts";

declare const tokenBrand: unique symbol;
export type ProtectedGitHubWorkTokenV2 = { readonly [tokenBrand]: true };
type Bindings<S, V extends GitHubMediationVersion> = {
  origin: OriginalRepositoryWorkOriginV2<V>;
  selection: S;
  token: ProtectedGitHubWorkTokenV2;
};
type WorkBindings<V extends GitHubMediationVersion> = {
  origin: OriginalRepositoryWorkOriginV2<V>;
  preparation: RepositoryWorkStatePreparationV2<V>;
  token: ProtectedGitHubWorkTokenV2;
  commit: RepositoryWorkCommittedV2;
};
const same = (a: unknown, b: unknown) =>
  canonicalRepositoryInventoryV2(a) === canonicalRepositoryInventoryV2(b);
function fail(): never {
  throw new ProtectedGitHubCustodyErrorV1();
}

/** Construction pairs the ORIGINAL State/Work/native owners with one explicitly
 * selected protected App source. Private maps correlate operands; only those
 * original owners grant authority. No operation-enrollment or token-byte API is
 * returned. A reservation for another App binding is refused. */
export function createProtectedGitHubRepositorySourcesV2<
  N extends object,
  A extends object,
  S extends object,
  W extends object,
  V extends GitHubMediationVersion = 2,
>(
  options: {
    readonly protocolVersion?: V;
    readonly binding: RepositoryWorkStateBindingV2;
    readonly native: RepositoryWorkNativeSessionSourceV2<N, NoInfer<V>> &
      ProtectedGitHubNativeSourceV2<N, W, NoInfer<V>>;
    readonly assignments: RepositoryWorkOriginAssignmentSourceV2<A, N, NoInfer<V>>;
    readonly trust: RuntimeServiceTrustService;
    readonly originLimits: RepositoryWorkOriginLimitsV2;
    readonly selection: RepositoryWorkSelectionSourceV2<Bindings<S, NoInfer<V>>, NoInfer<V>>;
    readonly key: GitHubAppKeyIdentityV1;
    readonly material: GitHubAppMaterialV1;
    readonly crypto: ProtectedGitHubCryptoV1;
    readonly store: ProtectedGitHubTokenStoreV1;
    readonly endpoint: GitHubAppEndpointV1;
    readonly transactionMilliseconds: number;
    readonly maximumResponsibilities: number;
    readonly clock: CustodyClockV1;
  } & (V extends 2 ? { readonly protocolVersion?: 2 } : { readonly protocolVersion: 3 }) &
    ([GitHubMediationVersion] extends [V] ? never : unknown),
): RepositoryWorkSourcesV2<WorkBindings<V>, V> & { readonly close: () => Promise<void> } {
  type Origin = OriginalRepositoryWorkOriginV2<V>;
  options = { ...options };
  Object.freeze(options);
  const selectedVersion = options.protocolVersion;
  const protocolVersion = selectedVersion === undefined ? 2 : selectedVersion;
  if (protocolVersion !== 2 && protocolVersion !== 3) fail();
  const permissions = Object.freeze(
    protocolVersion === 3
      ? { contents: "read" as const, metadata: "read" as const }
      : { metadata: "read" as const },
  );
  const key = snapshotGitHubAppKeyIdentityV1(options.key),
    binding = options.binding;
  const material = options.material,
    crypto = options.crypto,
    store = options.store;
  const endpoint = Object.freeze({ ...options.endpoint });
  const fixedSelection = options.selection;
  const sourcePrepareStateUse = fixedSelection.prepareStateUse.bind(fixedSelection);
  const sourceAcquire = fixedSelection.acquire.bind(fixedSelection);
  const sourceInspect = fixedSelection.inspect.bind(fixedSelection);
  const sourceInventory = fixedSelection.acquireInventory?.bind(fixedSelection);
  const sourcePolicy = fixedSelection.retainPolicy.bind(fixedSelection);
  const sourceObservation = fixedSelection.retainObservation.bind(fixedSelection);
  const sourceObservationCall = fixedSelection.observationCall.bind(fixedSelection);
  const sourceRelease = fixedSelection.release.bind(fixedSelection);
  const transactionMilliseconds = options.transactionMilliseconds;
  const readClock = options.clock.read.bind(options.clock);
  const nativeRelease = options.native;
  const releaseInspect = nativeRelease.inspect.bind(nativeRelease);
  const releaseCurrent = nativeRelease.assertCurrent.bind(nativeRelease);
  const originalReleaseMethods = [
    nativeRelease.inspect,
    nativeRelease.assertCurrent,
    nativeRelease.prepareCommittedToken,
    nativeRelease.writePreparedCommittedToken,
  ];
  const assertOriginal = binding.participant.assertOriginal.bind(binding.participant);
  const maximum = options.maximumResponsibilities;
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 4096 ||
    !(crypto instanceof ProtectedGitHubCryptoV1) ||
    !(store instanceof ProtectedGitHubTokenStoreV1) ||
    !Number.isSafeInteger(transactionMilliseconds) ||
    transactionMilliseconds <= 0 ||
    transactionMilliseconds > 3000
  )
    fail();
  store.assertSeparateKeySource(crypto);

  // Only the original Runtime constructor can supply this recognizer. It is
  // captured once before requests; neither it nor a rebinding API escapes.
  let originsBound = false;
  let originRecognizers: Readonly<RepositoryWorkOriginNativeRecognizerV2<N, V>> | undefined;
  const originOwner = new RepositoryWorkOriginOwnerV2<N, A, V>({
    ...options,
    trust: options.trust,
    native: nativeRelease,
    assignments: options.assignments,
    limits: options.originLimits,
    nativeCustody: Object.freeze({
      bindOrigins(recognizer: RepositoryWorkOriginNativeRecognizerV2<N, V>): undefined {
        if (originsBound) fail();
        originsBound = true;
        originRecognizers = Object.freeze({
          recognize: recognizer.recognize.bind(recognizer),
          recognizeNative: recognizer.recognizeNative.bind(recognizer),
        });
        return undefined;
      },
    }),
  });
  const { recognize, recognizeNative } = originRecognizers ?? fail();
  const fixedNative = Object.freeze({
    acquire: originOwner.acquire.bind(originOwner),
    inspect: originOwner.inspect.bind(originOwner),
    inspectNative: originOwner.inspectNative.bind(originOwner),
    assertNativeCurrent: originOwner.assertNativeCurrent.bind(originOwner),
    assertCurrent: originOwner.assertCurrent.bind(originOwner),
    release: originOwner.release.bind(originOwner),
  });
  let closing = false;
  let closed: Promise<void> | undefined;
  const pendingCalls = new Set<Promise<unknown>>();
  function track<T>(promise: Promise<T>): Promise<T> {
    pendingCalls.add(promise);
    return promise.finally(() => pendingCalls.delete(promise));
  }

  type Session = {
    readonly origin: Origin;
    readonly nativeSession: N;
    readonly request: OpenRead<V>;
    readonly repositoryRequest?: WorkRepositoryGitReadV3;
    current?: RepositoryWorkCurrentV2<V>;
    readonly binding: RepositoryWorkNativeBindingV2;
    readonly diagnostic: string;
    readonly originalKeys: Set<string>;
    selection?: S;
    released: boolean;
    entry?: Entry;
  };
  type Phase = {
    readonly entry: Entry;
    readonly input: RepositoryTokenMutationV2;
    readonly retained?: ProtectedGitHubRetentionV1;
  };
  type Entry = {
    readonly session: Session;
    readonly responsibility: RepositoryWorkInventoryResponsibilityV2;
    readonly reservation: ReserveRepositoryTokenV2;
    readonly custody: ProtectedGitHubTokenCustodyV1;
    readonly release: ProtectedGitHubReleaseBindingV2;
    readonly releaseRef: string;
    readonly pending: Promise<unknown>;
    record?: RepositoryTokenRecordV2;
    result?: GitHubAppMintResultV1;
    cleanupResult?: GitHubAppRevokeResultV1;
    cleanupObservedAt?: string;
    cleanupEvidenceRef?: string;
    cleanupClaim?: Readonly<{
      claimRef: string;
      claimVersion: number;
      providerAttemptRef: string;
      revocationOperationRef: string;
    }>;
    claimKnown: boolean;
    claimRecorded: boolean;
    providerInvoked: boolean;
    unknownRecorded: boolean;
    materialCommitted: boolean;
    readonly uncertain: Set<string>;
    returned: boolean;
    finishing?: Promise<void>;
  };
  const sessions = new WeakMap<object, Session>();
  const contexts = new WeakMap<object, Map<string, Session>>();
  const phases = new Map<string, Phase>();
  const business = new Map<string, Entry>();
  const originalSessions = new Map<string, Session>();
  const tokens = new WeakMap<object, Entry>();
  const entries = new Set<Entry>();
  let acquiring = 0;
  const clock = Object.freeze({
    read() {
      const sample = readClock();
      if (
        !Number.isSafeInteger(sample.wallMs) ||
        !Number.isFinite(sample.monotonicMs) ||
        !Number.isSafeInteger(sample.uncertaintyMs) ||
        sample.uncertaintyMs < 0 ||
        sample.uncertaintyMs > 2000
      )
        fail();
      return Object.freeze({
        now: sample.wallMs,
        uncertaintyMs: sample.uncertaintyMs,
      });
    },
  });
  const now = () => clock.read().now;
  const instant = () => new Date(now()).toISOString();
  const currentSession = (origin: Origin): Session => sessions.get(origin) ?? fail();
  const native: RepositoryWorkSourcesV2<WorkBindings<V>, V>["native"] = Object.freeze({
    acquire(request: OpenRead<V>, call: AuthorityCallV1) {
      if (closing || request.version !== protocolVersion) fail();
      const capturedRequest = structuredClone(request);
      Object.freeze(capturedRequest);
      let repositoryRequest: WorkRepositoryGitReadV3 | undefined;
      if (protocolVersion === 3) {
        const decoded = decodeGitHubMediationRequest(
          new TextEncoder().encode(JSON.stringify(capturedRequest)),
          3,
        );
        if (decoded?.method !== "open-read") fail();
        repositoryRequest = repositoryWorkGitReadBindingV3(decoded);
      }
      return track(
        (async () => {
          const origin = await fixedNative.acquire(capturedRequest, call);
          if (origin === undefined) return undefined;
          let adopted = false;
          try {
            const observed = await fixedNative.inspect(origin, call);
            const nativeSession = recognize(origin, call);
            const diagnostic = await releaseInspect(nativeSession, call);
            fixedNative.assertCurrent(origin, call);
            releaseCurrent(nativeSession, call);
            if (recognize(origin, call) !== nativeSession) fail();
            if (
              closing ||
              sessions.has(origin) ||
              observed.context !== call.context ||
              observed.receiverRef !== call.recipientRef
            )
              fail();
            let byRequest = contexts.get(call.context);
            if (!byRequest) {
              byRequest = new Map();
              contexts.set(call.context, byRequest);
            }
            if (byRequest.has(call.requestRef)) fail();
            const held: Session = {
              origin,
              nativeSession,
              request: capturedRequest,
              ...(repositoryRequest === undefined ? {} : { repositoryRequest }),
              binding: observed,
              diagnostic: diagnostic.sessionRef,
              originalKeys: new Set(),
              released: false,
            };
            sessions.set(origin, held);
            byRequest.set(call.requestRef, held);
            adopted = true;
            return origin;
          } finally {
            if (!adopted) await fixedNative.release(origin);
          }
        })(),
      );
    },
    inspect: fixedNative.inspect,
    inspectNative(origin: Origin, call: AuthorityCallV1) {
      const held = currentSession(origin);
      if (closing || held.released) fail();
      return track(
        fixedNative.inspectNative(origin, call).then((observed) => {
          // This boundary authenticates the next original native Exchange while
          // State's readset may be retired. It cannot refresh State authority.
          if (
            closing ||
            held.released ||
            recognizeNative(origin, call) !== held.nativeSession ||
            observed.context !== held.binding.context ||
            observed.transportBinding !== held.binding.transportBinding ||
            observed.receiverRef !== held.binding.receiverRef ||
            observed.attachmentRef !== held.binding.attachmentRef ||
            !same(observed.execution, held.binding.execution) ||
            !same(observed.service, held.binding.service)
          )
            fail();
          return observed;
        }),
      );
    },
    assertNativeCurrent: fixedNative.assertNativeCurrent,
    assertCurrent: fixedNative.assertCurrent,
    async release(origin: Origin) {
      const held = currentSession(origin);
      if (held.released) return;
      held.released = true;
      try {
        if (held.entry && !held.entry.returned) await finish(held.entry);
      } finally {
        contexts.get(held.binding.context)?.delete(held.request.request_ref);
        for (const key of held.originalKeys)
          if (originalSessions.get(key) === held) originalSessions.delete(key);
        await fixedNative.release(origin);
      }
    },
  });
  const selection = Object.freeze<RepositoryWorkSelectionSourceV2<Bindings<S, V>, V>>({
    ...(sourceInventory ? { acquireInventory: sourceInventory } : {}),
    async acquire(origin: Origin, request: OpenRead<V>, call: AuthorityCallV1) {
      const held = currentSession(origin);
      const selected = await sourceAcquire(origin, request, call);
      if (selected !== undefined) {
        if (held.selection !== undefined) fail();
        held.selection = selected;
      }
      return selected;
    },
    async inspect(selected, origin, call) {
      const data = await sourceInspect(selected, origin, call),
        held = currentSession(origin);
      if (held.selection !== selected) fail();
      const current = structuredClone(data.current);
      if (
        current.original.requestDigest !== held.request.request_sha256 ||
        current.repository.owner !== held.request.repository_owner ||
        current.repository.name !== held.request.repository_name ||
        !same(
          repositoryWorkCurrentPolicyArmV2(current),
          protocolVersion === 3
            ? {
                repositoryOperation: "git:read",
                requiredPermissions: ["contents:read", "metadata:read"],
              }
            : { permission: "metadata:read" },
        ) ||
        !same(current.repositoryRequest, held.repositoryRequest) ||
        (protocolVersion === 2 && Object.hasOwn(current, "repositoryRequest"))
      )
        fail();
      Object.freeze(current);
      held.current = current;
      for (const original of [
        data.preparation,
        data.current.original,
        data.observation,
        ...(data.admission.kind === "new" ? [data.admission.original] : []),
      ]) {
        const key = canonicalRepositoryInventoryV2(original),
          old = originalSessions.get(key);
        if (old && old !== held) fail();
        if (held.originalKeys.size >= 4 && !held.originalKeys.has(key)) fail();
        held.originalKeys.add(key);
        originalSessions.set(key, held);
      }
      return data;
    },
    prepareStateUse: sourcePrepareStateUse,
    retainPolicy: sourcePolicy,
    retainObservation: sourceObservation,
    observationCall: sourceObservationCall,
    release: sourceRelease,
  });

  function recordMatches(entry: Entry, record: RepositoryTokenRecordV2): void {
    if (
      !same(record.issuance, entry.reservation) ||
      record.target.issuanceOperationRef !== entry.reservation.operationRef ||
      record.target.intentDigest !== repositoryInventoryDigestV2(entry.reservation)
    )
      fail();
  }
  function qualify(phase: Phase, facts: RepositoryWorkInventoryFactsV2): void {
    const { entry, input } = phase;
    if (!same(input, facts.input)) fail();
    if (input.method === "reserveRepositoryToken") {
      if (
        !same(input, entry.reservation) ||
        facts.record !== undefined ||
        facts.mintClaim !== undefined
      )
        fail();
      return;
    }
    const record = facts.record ?? fail();
    recordMatches(entry, record);
    if (
      !same(input.target, record.target) ||
      input.expectedInventoryVersion !== record.inventoryVersion
    )
      fail();
    if (input.method === "claimRepositoryMint") {
      if (
        record.state !== "reserved" ||
        facts.mintClaim !== undefined ||
        !same(input.custodyIdentity, entry.custody.identity)
      )
        fail();
    } else {
      if (
        input.method === "resolveRepositoryToken" &&
        input.outcome === "definitely-not-dispatched"
      ) {
        if (record.state !== "reserved" || facts.mintClaim !== undefined || entry.providerInvoked)
          fail();
        return;
      }
      const claim = facts.mintClaim ?? fail();
      if (
        !same(claim.custodyIdentity, entry.custody.identity) ||
        claim.recordRef !== record.target.recordRef ||
        claim.issuanceOperationRef !== record.target.issuanceOperationRef ||
        claim.issuanceIntentDigest !== record.target.intentDigest
      )
        fail();
      if (input.method === "recordRepositoryMint") {
        if (input.providerAttemptRef !== entry.custody.identity.providerAttemptRef) fail();
        if (input.outcome === "accepted") {
          const handle = entry.custody.recover() ?? fail(),
            retained = entry.custody.retain(handle);
          if (
            !phase.retained ||
            !same(retained, phase.retained) ||
            input.tokenRef !== retained.identity.tokenRef ||
            input.protectedRevocationRef !== retained.identity.protectedRevocationRef ||
            !same(
              input.returnedPermissions,
              retained.observation.returnedPermissions ?? { kind: "unavailable" },
            ) ||
            input.scopeAccepted !== retained.observation.scopeAccepted ||
            !same(input.expiry, expiry(retained, input.createdAt))
          )
            fail();
        } else if (
          input.outcome === "definitely-rejected"
            ? entry.result?.kind !== "rejected"
            : input.outcome === "definitely-not-dispatched"
              ? entry.result?.kind !== "not-dispatched" &&
                !(entry.claimRecorded && !entry.providerInvoked)
              : entry.result?.kind !== "unknown"
        )
          fail();
      } else if (
        input.method === "claimRepositoryRevocation" ||
        input.method === "recordRepositoryRevocation"
      ) {
        const handle = entry.custody.recover() ?? fail(),
          retained = entry.custody.retain(handle);
        if (
          !phase.retained ||
          !same(phase.retained, retained) ||
          record.state !== "outstanding" ||
          record.disposition !== "mitigation-only" ||
          input.tokenRef !== retained.identity.tokenRef ||
          input.protectedRevocationRef !== retained.identity.protectedRevocationRef
        )
          fail();
        if (input.method === "recordRepositoryRevocation") {
          const result = entry.cleanupResult ?? fail(),
            cleanup = facts.revocationClaim ?? fail();
          if (
            result.providerAttemptRef !== input.providerAttemptRef ||
            result.kind !== input.outcome ||
            cleanup.claimRef !== input.claimRef ||
            cleanup.claimVersion !== input.claimVersion ||
            cleanup.providerAttemptRef !== input.providerAttemptRef ||
            cleanup.input.revocationOperationRef !== input.revocationOperationRef
          )
            fail();
        }
      } else if (input.method === "resolveRepositoryToken" && input.outcome === "expired") {
        const time = clock.read();
        if (
          record.expiry.kind !== "provider-expiry" ||
          !same(record.expiry, input.expiry) ||
          input.uncertaintyMs !== time.uncertaintyMs ||
          time.now - time.uncertaintyMs < Date.parse(input.expiry.expiresAt)
        )
          fail();
      } else if (input.method !== "retireRepositoryToken") fail();
    }
  }

  const source = Object.freeze<RepositoryWorkCustodySourceV2>({
    async acquire(context, original, call) {
      assertOriginal(context, original, call);
      const phase = phases.get(original.operationRef),
        entry = phase?.entry ?? business.get(original.operationRef);
      const held =
        entry?.session ??
        originalSessions.get(canonicalRepositoryInventoryV2(original)) ??
        contexts.get(call.context)?.get(call.requestRef) ??
        fail();
      const delegate = entry
        ? await entry.release.source.acquire(context, original, call)
        : undefined;
      let active = true;
      const assertCurrent = (): undefined => {
        if (!active || call.signal.aborted || now() >= Date.parse(call.deadline)) fail();
        if (delegate) delegate.assertCurrent();
        return undefined;
      };
      return Object.freeze<RepositoryWorkCustodyLeaseV2>({
        receiver: nativeRelease,
        session: held.nativeSession,
        receiverRef: held.binding.receiverRef,
        sessionRef: held.diagnostic,
        inventoryClock: clock,
        assertCurrent,
        async qualifyInventory(facts) {
          assertOriginal(context, original, call);
          assertCurrent();
          qualify(phase ?? fail(), facts);
        },
        async qualifyInventoryRead(operation) {
          assertOriginal(context, original, call);
          assertCurrent();
          const own = phase ?? fail();
          if (operation !== undefined) {
            if (
              !same(operation.input, own.input) ||
              operation.digest !== repositoryInventoryDigestV2(own.input)
            )
              fail();
            recordMatches(own.entry, operation.record);
          }
        },
        async qualifyMintUse(operation, record) {
          assertOriginal(context, original, call);
          assertCurrent();
          const own = phase ?? fail();
          if (
            own.input.method !== "claimRepositoryMint" ||
            !same(operation.input, own.input) ||
            !same(own.input.custodyIdentity, own.entry.custody.identity) ||
            record.state !== "mint-unknown" ||
            record.providerAttemptRef !== own.entry.custody.identity.providerAttemptRef ||
            !same(operation.record, record)
          )
            fail();
          recordMatches(own.entry, record);
        },
        async stageRelease(dispatch) {
          assertCurrent();
          await (delegate ?? fail()).stageRelease(dispatch);
        },
        async qualifyRevocationUse(operation, record) {
          assertOriginal(context, original, call);
          assertCurrent();
          const own = phase ?? fail(),
            custody = own.entry.custody;
          if (
            own.input.method !== "claimRepositoryRevocation" ||
            !same(operation.input, own.input) ||
            !same(operation.record, record) ||
            record.state !== "outstanding" ||
            record.disposition !== "mitigation-only" ||
            record.revocation?.state !== "claimed" ||
            record.tokenRef !== custody.identity.tokenRef ||
            record.protectedRevocationRef !== custody.identity.protectedRevocationRef
          )
            fail();
          recordMatches(own.entry, record);
          const retained = custody.retain(custody.recover() ?? fail());
          if (!own.retained || !same(retained, own.retained)) fail();
        },
        async prepareCommit() {
          assertCurrent();
          if (phase?.retained) {
            const handle = phase.entry.custody.recover() ?? fail();
            if (!same(phase.entry.custody.retain(handle), phase.retained)) fail();
          }
          if (delegate) await delegate.prepareCommit();
          assertCurrent();
        },
        async release() {
          active = false;
          if (delegate) await delegate.release();
        },
      });
    },
  });
  const adapter = new RepositoryWorkStateAdapterV2<Bindings<S, V>, V>(
    binding,
    native,
    selection,
    {
      source,
      inspect(token, selected) {
        const entry = tokens.get(token) ?? fail(),
          record = entry.record ?? fail();
        if (
          !entry.returned ||
          selected !== entry.session.selection ||
          record.state !== "outstanding" ||
          record.disposition !== "current-check-required"
        )
          fail();
        return Object.freeze({
          accessLeaseRef: entry.reservation.lease.accessLeaseRef,
          inventoryRecordRef: record.target.recordRef,
          inventoryVersion: record.inventoryVersion,
          releaseRef: entry.releaseRef,
          repositoryTarget: entry.reservation.lease.target,
          receiver: nativeRelease,
          session: entry.session.nativeSession,
        });
      },
    },
    transactionMilliseconds,
    options,
  );
  // A returned original P remains Work's responsibility through its actual
  // outcome settlement. Shutdown cannot invent that outcome or drop a late P.
  const preparations = new Map<
    RepositoryWorkStatePreparationV2<V>,
    {
      readonly drained: Promise<void>;
      readonly resolve: () => void;
    }
  >();
  const committedPreparations = new WeakMap<
    RepositoryWorkCommittedV2,
    RepositoryWorkStatePreparationV2<V>
  >();
  const originalState = adapter.state;
  const prepareState = originalState.prepare.bind(originalState);
  const readPreparation = originalState.readPreparationOriginal.bind(originalState);
  const readState = originalState.readCurrent.bind(originalState);
  const commitState = originalState.commitDispatch.bind(originalState);
  const inspectCommit = originalState.inspectCommitted.bind(originalState);
  const settleState = originalState.settle.bind(originalState);
  const state: RepositoryWorkSourcesV2<WorkBindings<V>, V>["state"] = Object.freeze({
    prepare(origin, request, call) {
      if (closing) fail();
      return track(
        (async () => {
          const preparation = await prepareState(origin, request, call);
          if (preparation !== undefined && !preparations.has(preparation)) {
            let resolve!: () => void;
            const drained = new Promise<void>((done) => {
              resolve = done;
            });
            preparations.set(preparation, { drained, resolve });
          }
          // Even when close began during acquisition, return the actual P to its
          // original Work caller so that caller can settle its actual outcome.
          return preparation;
        })(),
      );
    },
    readPreparationOriginal(...args) {
      if (closing) fail();
      return track(readPreparation(...args));
    },
    readCurrent(...args) {
      if (closing) fail();
      return track(readState(...args));
    },
    commitDispatch(...args) {
      if (closing) fail();
      return track(
        commitState(...args).then((result) => {
          if (result.kind === "committed") committedPreparations.set(result.receipt, args[0]);
          return result;
        }),
      );
    },
    inspectCommitted: inspectCommit,
    settle(preparation, receipt, outcome) {
      if (receipt !== undefined && committedPreparations.get(receipt) !== preparation) fail();
      // Original Work may settle while closing; this wrapper grants no outcome
      // or receipt and always calls the actual privately recognizing State owner.
      return track(
        settleState(preparation, receipt, outcome).finally(() => {
          const held = preparations.get(preparation);
          held?.resolve();
          preparations.delete(preparation);
        }),
      );
    },
  });
  const inventory = adapter.inventory;
  async function recover(entry: Entry, operationRef: string): Promise<void> {
    const phase = phases.get(operationRef) ?? fail();
    if (phase.entry !== entry) fail();
    const read = await inventory.recover(entry.responsibility, operationRef);
    if (read.kind === "unavailable") return;
    if (read.kind === "recorded") {
      recordMatches(entry, read.operation.record);
      if (
        !same(read.operation.input, phase.input) ||
        read.operation.digest !== repositoryInventoryDigestV2(phase.input)
      )
        fail();
      if (!entry.record || read.operation.record.inventoryVersion >= entry.record.inventoryVersion)
        entry.record = read.operation.record;
      if (phase.input.method === "claimRepositoryMint") entry.claimRecorded = true;
      if (phase.input.method === "recordRepositoryMint" && phase.input.outcome === "unknown")
        entry.unknownRecorded = true;
    }
    entry.uncertain.delete(operationRef);
  }
  const transition = async (
    entry: Entry,
    input: RepositoryTokenMutationV2,
    call?: AuthorityCallV1,
    retained?: ProtectedGitHubRetentionV1,
  ): Promise<RepositoryWorkInventoryResultV2> => {
    const parsed = parseRepositoryTokenMutationV2(input);
    if (phases.has(parsed.operationRef)) fail();
    if ([...phases.values()].filter((p) => p.entry === entry).length >= 128) fail();
    phases.set(parsed.operationRef, { entry, input: parsed, ...(retained ? { retained } : {}) });
    const result = await inventory.transition(entry.responsibility, parsed, call);
    if (result.kind === "unknown") {
      entry.uncertain.add(parsed.operationRef);
      try {
        await recover(entry, parsed.operationRef);
      } catch {
        /* original responsibility remains retained */
      }
    }
    if (result.kind === "committed" || result.kind === "existing") {
      recordMatches(entry, result.operation.record);
      entry.record = result.operation.record;
    }
    return result;
  };
  function base(entry: Entry) {
    const record = entry.record ?? fail();
    return {
      schemaVersion: 2 as const,
      createdAt: instant(),
      operationRef: randomUUID(),
      scope: entry.reservation.scope,
      target: record.target,
      expectedInventoryVersion: record.inventoryVersion,
    };
  }
  function expiry(retained?: ProtectedGitHubRetentionV1, observedAt?: string) {
    return retained?.observation.expiresAt === undefined
      ? { kind: "expiry-unproven" as const }
      : {
          kind: "provider-expiry" as const,
          expiresAt: retained.observation.expiresAt,
          observedAt: observedAt ?? fail(),
          evidenceRef: `github-retained/${retained.envelopeSHA256}`,
        };
  }
  async function recordMint(entry: Entry): Promise<void> {
    const result = entry.result;
    if (entry.record?.state !== "mint-unknown" || entry.uncertain.size) return;
    const common = () => ({
      ...base(entry),
      method: "recordRepositoryMint" as const,
      providerAttemptRef: entry.custody.identity.providerAttemptRef,
      evidenceRef: randomUUID(),
    });
    if (!result) {
      if (!entry.claimRecorded || entry.providerInvoked) fail();
      await transition(entry, { ...common(), outcome: "definitely-not-dispatched" });
      return;
    }
    if (result.kind !== "minted" && !(result.kind === "unknown" && entry.unknownRecorded)) {
      const input =
        result.kind === "rejected"
          ? { ...common(), outcome: "definitely-rejected" as const }
          : result.kind === "not-dispatched"
            ? { ...common(), outcome: "definitely-not-dispatched" as const }
            : { ...common(), outcome: "unknown" as const, expiry: expiry() };
      const observed = await transition(entry, input);
      if (observed.kind !== "committed") return;
      if (result.kind === "unknown") entry.unknownRecorded = true;
    }
    const handle = entry.custody.recover();
    if (handle === undefined || entry.record?.state !== "mint-unknown") return;
    const retained = entry.custody.retain(handle);
    const accepted = common();
    const recorded = await transition(
      entry,
      {
        ...accepted,
        outcome: "accepted",
        tokenRef: retained.identity.tokenRef,
        protectedRevocationRef: retained.identity.protectedRevocationRef,
        expiry: expiry(retained, accepted.createdAt),
        returnedPermissions: retained.observation.returnedPermissions ?? { kind: "unavailable" },
        scopeAccepted: retained.observation.scopeAccepted,
      },
      undefined,
      retained,
    );
    if (recorded.kind === "committed") entry.materialCommitted = true;
  }
  async function cleanupPass(entry: Entry): Promise<void> {
    for (const ref of entry.uncertain) await recover(entry, ref);
    if (entry.uncertain.size) return;
    if (entry.record?.state === "reserved" && !entry.providerInvoked)
      await transition(entry, {
        ...base(entry),
        method: "resolveRepositoryToken",
        outcome: "definitely-not-dispatched",
        evidenceRef: randomUUID(),
      });
    if (entry.record?.state === "mint-unknown") await recordMint(entry);
    if (entry.uncertain.size) return;
    if (entry.record?.state === "outstanding" && entry.record.expiry.kind === "provider-expiry") {
      const time = clock.read();
      if (time.now - time.uncertaintyMs >= Date.parse(entry.record.expiry.expiresAt)) {
        await transition(entry, {
          ...base(entry),
          method: "resolveRepositoryToken",
          outcome: "expired",
          expiry: entry.record.expiry,
          uncertaintyMs: time.uncertaintyMs,
          evidenceRef: randomUUID(),
        });
        return;
      }
    }
    if (
      entry.record?.state === "outstanding" &&
      entry.record.disposition === "current-check-required"
    )
      await transition(entry, {
        ...base(entry),
        method: "retireRepositoryToken",
        evidenceRef: randomUUID(),
      });
    if (entry.record?.state === "outstanding" && entry.record.disposition === "mitigation-only") {
      const handle = entry.custody.recover() ?? fail(),
        retained = entry.custody.retain(handle);
      if (
        entry.cleanupResult &&
        entry.cleanupClaim &&
        entry.record.revocation &&
        (entry.cleanupResult.kind === "confirmed" ||
          (entry.record.revocation.state === "claimed" &&
            entry.record.revocation.claimRef === entry.cleanupClaim.claimRef &&
            entry.record.revocation.claimVersion === entry.cleanupClaim.claimVersion)) &&
        entry.cleanupResult.providerAttemptRef === entry.record.revocation.providerAttemptRef
      ) {
        await recordCleanup(entry, retained);
        if (
          entry.uncertain.size ||
          entry.record.state !== "outstanding" ||
          entry.record.revocation?.state === "claimed"
        )
          return;
      }
      const old = entry.record.revocation;
      if (old?.state === "confirmed") return;
      if (old?.state === "claimed") {
        const time = clock.read();
        if (time.now - time.uncertaintyMs < Date.parse(old.claimNotAfter)) return;
      }
      const claimed = await transition(
        entry,
        {
          ...base(entry),
          method: "claimRepositoryRevocation",
          tokenRef: retained.identity.tokenRef,
          protectedRevocationRef: retained.identity.protectedRevocationRef,
          revocationOperationRef: old?.revocationOperationRef ?? randomUUID(),
          expectedRevocationVersion: old?.version ?? 0,
          previousAttempt: old
            ? {
                kind: "reconcile",
                providerAttemptRef: old.providerAttemptRef,
                providerOutcome: old.state === "claimed" ? "unknown" : old.state,
              }
            : { kind: "none" },
        },
        undefined,
        retained,
      );
      if (claimed.kind !== "committed" || !claimed.cleanupClaim) return;
      const use = await inventory.acquireRevocation(entry.responsibility, claimed.cleanupClaim);
      if (!use) return;
      let provider:
        ReturnType<ProtectedGitHubTokenCustodyV1["createRevocationProvider"]> | undefined;
      let result: GitHubAppRevokeResultV1 | undefined,
        submitted = false;
      try {
        const record = use.operation.record,
          cleanup = record.revocation;
        if (
          record.state !== "outstanding" ||
          !cleanup ||
          cleanup.state !== "claimed" ||
          !same(record, entry.record)
        )
          fail();
        const revocationCustody = new ProtectedGitHubTokenCustodyV1({
          identity: entry.custody.identity,
          crypto,
          store,
          clock: now,
        });
        const revokeHandle = revocationCustody.recover() ?? fail();
        if (!same(revocationCustody.retain(revokeHandle), retained)) fail();
        provider = revocationCustody.createRevocationProvider({
          endpoint,
          providerAttemptRef: cleanup.providerAttemptRef,
          assertRevocationCurrent() {
            use.assertCurrent();
            if (!submitted) {
              use.beginSubmittedUse();
              submitted = true;
            }
          },
        });
        result = await provider.revoke(
          {
            providerAttemptRef: cleanup.providerAttemptRef,
            bounds: { signal: use.call.signal, deadline: Date.parse(use.call.deadline) },
          },
          revokeHandle,
        );
        entry.cleanupResult = result;
        entry.cleanupObservedAt = instant();
        entry.cleanupEvidenceRef = randomUUID();
        entry.cleanupClaim = Object.freeze({
          claimRef: cleanup.claimRef,
          claimVersion: cleanup.claimVersion,
          providerAttemptRef: cleanup.providerAttemptRef,
          revocationOperationRef: cleanup.revocationOperationRef,
        });
      } finally {
        try {
          if (provider && result) await provider.settleAttempt(result);
        } finally {
          await use.release();
        }
      }
      await recordCleanup(entry, retained);
    }
  }
  async function recordCleanup(entry: Entry, retained: ProtectedGitHubRetentionV1): Promise<void> {
    const cleanup = entry.cleanupClaim,
      observed = entry.cleanupResult;
    if (!cleanup || !observed) return;
    await transition(
      entry,
      {
        ...base(entry),
        method: "recordRepositoryRevocation",
        tokenRef: retained.identity.tokenRef,
        protectedRevocationRef: retained.identity.protectedRevocationRef,
        revocationOperationRef: cleanup.revocationOperationRef,
        claimRef: cleanup.claimRef,
        claimVersion: cleanup.claimVersion,
        providerAttemptRef: cleanup.providerAttemptRef,
        outcome: observed.kind,
        observedAt: entry.cleanupObservedAt ?? fail(),
        evidenceRef: entry.cleanupEvidenceRef ?? fail(),
      },
      undefined,
      retained,
    );
  }
  async function finish(entry: Entry): Promise<void> {
    if (entry.finishing) return entry.finishing;
    entry.finishing = Promise.resolve().then(async () => {
      await entry.pending.catch(() => {});
      // An unavailable readback is retained responsibility, not absence. Every
      // retry reenters the original observer; no user call or permission renews.
      for (;;) {
        try {
          await cleanupPass(entry);
        } catch {
          /* retain original uncertainty and ciphertext */
        }
        if (
          !entry.uncertain.size &&
          (!entry.record ||
            entry.record.state === "not-issued" ||
            entry.record.state === "resolved-without-token")
        )
          break;
        await new Promise<void>((resolve) =>
          setTimeout(resolve, CREDENTIAL_STORAGE_LIMITS_V1.revokeLaterRetryMinIntervalMs),
        );
      }
      {
        try {
          await inventory.release(entry.responsibility);
        } finally {
          entries.delete(entry);
          if (business.get(entry.reservation.lease.original.operationRef) === entry)
            business.delete(entry.reservation.lease.original.operationRef);
          for (const [ref, phase] of phases) if (phase.entry === entry) phases.delete(ref);
        }
      }
    });
    return entry.finishing;
  }
  return Object.freeze({
    close(): Promise<void> {
      if (closed) return closed;
      closing = true;
      // Runtime alone retires its original raw sessions. Already submitted
      // provider/native work and retained mitigation keep their joined owners.
      closed = (async () => {
        const drains = await Promise.allSettled([originOwner.close(), ...pendingCalls]);
        await Promise.all([...preparations.values()].map((held) => held.drained));
        await Promise.allSettled([...pendingCalls]);
        await Promise.all([...entries].map(finish));
        if (drains.some((result) => result.status === "rejected")) fail();
      })();
      return closed;
    },
    native,
    state,
    custody: Object.freeze({
      prepareToken(
        preparation: RepositoryWorkStatePreparationV2<V>,
        origin: Origin,
        call: AuthorityCallV1,
      ) {
        const held = currentSession(origin);
        if (
          closing ||
          held.released ||
          held.entry ||
          entries.size + acquiring >= maximum ||
          !held.selection
        )
          fail();
        acquiring++;
        let charged = true;
        let responsibility: RepositoryWorkInventoryResponsibilityV2 | undefined;
        let entry: Entry | undefined;
        const pending = Promise.resolve()
          .then(async () => {
            responsibility = await inventory.acquire(preparation, origin, call);
            if (responsibility === undefined) return undefined;
            const reservation = inventory.reservation(responsibility);
            const current = held.current ?? fail();
            if (
              reservation.bindingRef !== key.bindingRef ||
              !same(reservation.requestedPermissions, permissions) ||
              !same(reservation.lease.original, current.original) ||
              !same(reservation.lease.work, current.work) ||
              !same(reservation.lease.execution, current.execution) ||
              reservation.lease.target.repositoryId !== current.repository.id ||
              reservation.lease.original.requestDigest !== held.request.request_sha256 ||
              !same(current.repositoryRequest, held.repositoryRequest)
            )
              fail();
            const custody = new ProtectedGitHubTokenCustodyV1({
              identity: {
                lease: reservation.lease,
                key,
                providerAttemptRef: randomUUID(),
                tokenRef: randomUUID(),
                protectedRevocationRef: randomUUID(),
              },
              crypto,
              store,
              clock: now,
            });
            if (
              [
                nativeRelease.inspect,
                nativeRelease.assertCurrent,
                nativeRelease.prepareCommittedToken,
                nativeRelease.writePreparedCommittedToken,
              ].some((method, i) => method !== originalReleaseMethods[i])
            )
              fail();
            const release = await custody.bindCommittedReleaseV2<N, W, V>({
              ...options,
              opening: held.request,
              participant: binding.participant,
              native: nativeRelease,
              originalSession: held.nativeSession,
              call,
            });
            entry = {
              session: held,
              responsibility,
              reservation,
              custody,
              release,
              releaseRef: randomUUID(),
              pending,
              claimKnown: false,
              claimRecorded: false,
              providerInvoked: false,
              unknownRecorded: false,
              materialCommitted: false,
              uncertain: new Set(),
              returned: false,
            };
            held.entry = entry;
            entries.add(entry);
            acquiring--;
            charged = false;
            if (business.has(reservation.lease.original.operationRef)) fail();
            business.set(reservation.lease.original.operationRef, entry);
            const reserved = await transition(entry, reservation, call);
            if (reserved.kind !== "committed") return undefined;
            const claimed = await transition(
              entry,
              {
                ...base(entry),
                method: "claimRepositoryMint",
                providerAttemptRef: custody.identity.providerAttemptRef,
                custodyIdentity: custody.identity,
              },
              call,
            );
            if (claimed.kind !== "committed" || !claimed.claim) return undefined;
            entry.claimKnown = true;
            entry.claimRecorded = true;
            const use = await inventory.acquireMint(responsibility, claimed.claim, call);
            if (use === undefined) return undefined;
            let provider: ReturnType<ProtectedGitHubTokenCustodyV1["createProvider"]> | undefined;
            let result: GitHubAppMintResultV1 | undefined,
              submitted = false;
            try {
              provider = custody.createProvider({
                material,
                endpoint,
                repositoryFullName: `${held.request.repository_owner}/${held.request.repository_name}`,
                permissions: reservation.requestedPermissions,
                assertDispatchCurrent() {
                  use.assertCurrent();
                  if (!submitted) {
                    use.beginSubmittedUse();
                    submitted = true;
                  }
                },
              });
              entry.providerInvoked = true;
              result = await provider.mint({
                providerAttemptRef: custody.identity.providerAttemptRef,
                bounds: { signal: call.signal, deadline: Date.parse(call.deadline) },
              });
              entry.result = result;
            } finally {
              try {
                if (provider && result) await provider.settleAttempt(result);
              } finally {
                await use.release();
              }
            }
            if (!entry.result) return undefined;
            await recordMint(entry);
            if (
              entry.result.kind !== "minted" ||
              !entry.materialCommitted ||
              entry.record?.state !== "outstanding" ||
              entry.record.disposition !== "current-check-required"
            )
              return undefined;
            fixedNative.assertCurrent(origin, call);
            releaseCurrent(held.nativeSession, call);
            if (recognize(origin, call) !== held.nativeSession) fail();
            const token = Object.freeze({}) as ProtectedGitHubWorkTokenV2;
            tokens.set(token, entry);
            entry.returned = true;
            return token;
          })
          .finally(async () => {
            if (entry?.claimRecorded && !entry.providerInvoked && !entry.result)
              await recordMint(entry);
          });
        return track(
          pending.finally(async () => {
            if (charged) acquiring--;
            if (!entry && responsibility) await inventory.release(responsibility);
            else if (entry && !entry.returned) await finish(entry);
          }),
        );
      },
      writeCommitted(
        commit: RepositoryWorkCommittedV2,
        metadata: Uint8Array,
        call: AuthorityCallV1,
      ) {
        // The participant first recognizes the original receipt inside each fixed
        // binder. Metadata never selects a ciphertext/token reference.
        const held = contexts.get(call.context)?.get(call.requestRef),
          entry = held?.entry;
        if (closing || !entry || !entry.returned) fail();
        return track(entry.release.writeCommitted(commit, metadata, call));
      },
      async settleToken(token: ProtectedGitHubWorkTokenV2) {
        await finish(tokens.get(token) ?? fail());
      },
    }),
  });
}
