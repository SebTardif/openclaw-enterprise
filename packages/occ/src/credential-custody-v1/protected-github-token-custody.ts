import { createHash, timingSafeEqual } from "node:crypto";
import type { EphemeralTokenHandleV1 } from "@openclaw-enterprise/contracts/credential-storage-v1";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import { repositoryWorkGitReadBindingV3 } from "../lifecycle/repository-work-v2.ts";
import type {
  WorkOriginalOperationV2,
  WorkRepositoryGitReadV3,
} from "../lifecycle/work-authority-ports-v2.ts";
import type {
  RepositoryWorkCommittedV2,
  RepositoryWorkCustodySourceV2,
  RepositoryWorkDispatchV2,
  RepositoryWorkTransactionContextV2,
} from "../ports/repository-work-v2.ts";
import {
  decodeGitHubMediationRequest,
  encodeGitHubMediationMetadata,
  githubMetadataDigest,
  type DispatchOnce,
  type GitHubMediationVersion,
} from "../github-mediation-v2/wire.ts";
import type {
  ProtectedGitHubReleaseBindingV2,
  ProtectedGitHubReleaseOptionsV2,
} from "./protected-github-release.ts";
import {
  canonicalRepositoryInventoryV2,
  parseRepositoryAccessLeaseV2,
  type RepositoryAccessLeaseV2,
} from "../credential-inventory-v1/repository-lease-v2.ts";
import {
  assertGitHubAppBoundsV1,
  assertGitHubAppSynchronousV1,
  snapshotGitHubAppKeyIdentityV1,
  type GitHubAppCallBoundsV1,
  type GitHubAppKeyIdentityV1,
  type GitHubAppMaterialV1,
} from "../github-app-provider-v1/material.ts";
import {
  createGitHubAppProviderV1,
  createGitHubAppRevocationProviderV1,
  snapshotGitHubAppReturnedPermissionsV1,
  type GitHubAppTokenCustodyV1,
  type GitHubAppEndpointV1,
  type GitHubAppProviderAttemptV1,
  type GitHubAppSelectionV1,
  type GitHubAppReturnedPermissionsV1,
} from "../github-app-provider-v1/provider.ts";
import {
  ProtectedGitHubCryptoV1,
  ProtectedGitHubCustodyErrorV1,
} from "./protected-github-crypto.ts";
import { ProtectedGitHubTokenStoreV1 } from "./protected-github-token-store.ts";

export interface ProtectedGitHubTokenIdentityV1 {
  readonly lease: RepositoryAccessLeaseV2;
  readonly key: GitHubAppKeyIdentityV1;
  readonly providerAttemptRef: string;
  readonly tokenRef: string;
  readonly protectedRevocationRef: string;
}
export interface ProtectedGitHubCaptureObservationV1 {
  readonly providerAttemptRef: string;
  readonly expiresAt: string | undefined;
  readonly scopeAccepted: boolean;
  /** Absent only in the original retained format; absence is unavailable
   * observation, never evidence of the requested permission map. */
  readonly returnedPermissions?: GitHubAppReturnedPermissionsV1;
}
export interface ProtectedGitHubRetentionV1 {
  readonly identity: ProtectedGitHubTokenIdentityV1;
  readonly observation: ProtectedGitHubCaptureObservationV1;
  readonly envelopeSHA256: string;
}
interface Captured {
  readonly handle: EphemeralTokenHandleV1;
  encoded: Buffer | undefined;
  raw: Buffer | undefined;
  readonly observation: ProtectedGitHubCaptureObservationV1;
  retained: boolean;
}
function unavailable(): never {
  throw new ProtectedGitHubCustodyErrorV1();
}
const reference = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);

/** Convert only an exact canonical positive decimal; never round provider IDs. */
export function protectedGitHubNumericIdV1(value: string): number {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) unavailable();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || String(number) !== value) unavailable();
  return number;
}

/** One preselected original mint attempt. The original State owner constructs
 * it from its committed claim; construction itself supplies no dispatch/use
 * authority. Retained context is inert authenticated material provenance. */
export class ProtectedGitHubTokenCustodyV1 {
  readonly #identity: ProtectedGitHubTokenIdentityV1;
  readonly #context: string;
  readonly #crypto: ProtectedGitHubCryptoV1;
  readonly #store: ProtectedGitHubTokenStoreV1;
  readonly #clock: () => number;
  readonly #handles = new WeakMap<object, Captured>();
  #captured: Captured | undefined;
  #borrowing = false;
  #providerCreated = false;
  #revokerCreated = false;
  #releaseBound = false;

  constructor(options: {
    readonly identity: ProtectedGitHubTokenIdentityV1;
    readonly crypto: ProtectedGitHubCryptoV1;
    readonly store: ProtectedGitHubTokenStoreV1;
    readonly clock: () => number;
  }) {
    try {
      const input = options.identity;
      if (
        !input ||
        Object.keys(input).length !== 5 ||
        !reference(input.providerAttemptRef) ||
        !reference(input.tokenRef) ||
        !reference(input.protectedRevocationRef)
      )
        unavailable();
      this.#identity = Object.freeze({
        lease: parseRepositoryAccessLeaseV2(input.lease),
        key: snapshotGitHubAppKeyIdentityV1(input.key),
        providerAttemptRef: input.providerAttemptRef,
        tokenRef: input.tokenRef,
        protectedRevocationRef: input.protectedRevocationRef,
      });
      for (const value of [
        this.#identity.lease.target.appId,
        this.#identity.lease.target.githubInstallationId,
        this.#identity.lease.target.repositoryId,
      ])
        protectedGitHubNumericIdV1(value);
      this.#context = canonicalRepositoryInventoryV2(this.#identity);
      this.#crypto = options.crypto;
      this.#store = options.store;
      this.#clock = options.clock;
      if (
        !(this.#crypto instanceof ProtectedGitHubCryptoV1) ||
        !(this.#store instanceof ProtectedGitHubTokenStoreV1) ||
        typeof this.#clock !== "function"
      )
        unavailable();
      this.#store.assertSeparateKeySource(this.#crypto);
    } catch {
      unavailable();
    }
  }

  get identity(): ProtectedGitHubTokenIdentityV1 {
    return this.#identity;
  }

  #observation(input: ProtectedGitHubCaptureObservationV1): ProtectedGitHubCaptureObservationV1 {
    if (
      !input ||
      (Object.keys(input).length !== 3 && Object.keys(input).length !== 4) ||
      Object.keys(input).some(
        (k) =>
          !["providerAttemptRef", "expiresAt", "scopeAccepted", "returnedPermissions"].includes(k),
      ) ||
      input.providerAttemptRef !== this.#identity.providerAttemptRef ||
      typeof input.scopeAccepted !== "boolean" ||
      (input.expiresAt !== undefined &&
        (typeof input.expiresAt !== "string" ||
          !Number.isFinite(Date.parse(input.expiresAt)) ||
          new Date(input.expiresAt).toISOString() !== input.expiresAt))
    )
      unavailable();
    if (
      Object.hasOwn(input, "returnedPermissions") &&
      canonicalRepositoryInventoryV2(input.returnedPermissions) !==
        canonicalRepositoryInventoryV2(
          snapshotGitHubAppReturnedPermissionsV1(input.returnedPermissions),
        )
    )
      unavailable();
    return Object.freeze({
      providerAttemptRef: input.providerAttemptRef,
      expiresAt: input.expiresAt,
      scopeAccepted: input.scopeAccepted,
      ...(Object.hasOwn(input, "returnedPermissions")
        ? { returnedPermissions: snapshotGitHubAppReturnedPermissionsV1(input.returnedPermissions) }
        : {}),
    });
  }

  #observationContext(observation: ProtectedGitHubCaptureObservationV1): string {
    return canonicalRepositoryInventoryV2({
      providerAttemptRef: observation.providerAttemptRef,
      expiresAt: observation.expiresAt ?? null,
      scopeAccepted: observation.scopeAccepted,
      ...(observation.returnedPermissions === undefined
        ? {}
        : { returnedPermissions: observation.returnedPermissions }),
    });
  }

  #decode(encoded: Buffer): { bytes: Buffer; observation: ProtectedGitHubCaptureObservationV1 } {
    try {
      if (encoded.length < 1 || encoded.length > 98304) unavailable();
      const packet: unknown = JSON.parse(encoded.toString("utf8"));
      if (!packet || typeof packet !== "object" || Array.isArray(packet)) unavailable();
      const p = packet as Record<string, unknown>;
      if (
        Object.keys(p).length !== 3 ||
        (p.schemaVersion !== 1 && p.schemaVersion !== 2) ||
        typeof p.envelope !== "string" ||
        !p.observation ||
        typeof p.observation !== "object" ||
        Array.isArray(p.observation)
      )
        unavailable();
      const o = p.observation as Record<string, unknown>;
      if (
        Object.keys(o).length !== (p.schemaVersion === 1 ? 3 : 4) ||
        Object.hasOwn(o, "returnedPermissions") !== (p.schemaVersion === 2)
      )
        unavailable();
      const observation = this.#observation({
        providerAttemptRef: o.providerAttemptRef as string,
        expiresAt: o.expiresAt === null ? undefined : (o.expiresAt as string),
        scopeAccepted: o.scopeAccepted as boolean,
        ...(p.schemaVersion === 2
          ? { returnedPermissions: o.returnedPermissions as GitHubAppReturnedPermissionsV1 }
          : {}),
      });
      const envelope = Buffer.from(p.envelope, "base64");
      if (envelope.toString("base64") !== p.envelope) unavailable();
      try {
        const bytes = this.#crypto.open(
          "github-installation-token-v1",
          [this.#context, this.#observationContext(observation)],
          envelope,
        );
        if (bytes.length > 16384 || bytes.some((byte) => byte < 0x21 || byte > 0x7e)) {
          bytes.fill(0);
          unavailable();
        }
        return { bytes, observation };
      } finally {
        envelope.fill(0);
      }
    } catch {
      unavailable();
    }
  }

  #adopt(
    encoded: Buffer,
    observation: ProtectedGitHubCaptureObservationV1,
    retained: boolean,
  ): Captured {
    const handle = Object.freeze({}) as EphemeralTokenHandleV1;
    const captured: Captured = {
      handle,
      encoded: Buffer.from(encoded),
      raw: undefined,
      observation,
      retained,
    };
    this.#handles.set(handle, captured);
    this.#captured = captured;
    return captured;
  }

  #flush(captured: Captured): void {
    if (captured.encoded === undefined) {
      if (captured.raw === undefined) unavailable();
      const envelope = this.#crypto.seal(
        "github-installation-token-v1",
        [this.#context, this.#observationContext(captured.observation)],
        captured.raw,
      );
      try {
        captured.encoded = Buffer.from(
          JSON.stringify({
            schemaVersion: captured.observation.returnedPermissions === undefined ? 1 : 2,
            observation: JSON.parse(this.#observationContext(captured.observation)),
            envelope: envelope.toString("base64"),
          }),
        );
        captured.raw.fill(0);
        captured.raw = undefined;
      } finally {
        envelope.fill(0);
      }
    }
    const previous = this.#store.read(this.#context);
    if (previous !== undefined) {
      try {
        if (!previous.equals(captured.encoded)) {
          const old = this.#decode(previous);
          let current:
            { bytes: Buffer; observation: ProtectedGitHubCaptureObservationV1 } | undefined;
          try {
            current = this.#decode(captured.encoded);
            if (
              old.bytes.length !== current.bytes.length ||
              !timingSafeEqual(old.bytes, current.bytes) ||
              this.#observationContext(old.observation) !==
                this.#observationContext(current.observation)
            )
              unavailable();
            // Lost-return readback adopts the exact original ciphertext; it never
            // creates a replacement token/reference or another provider attempt.
            captured.encoded.fill(0);
            captured.encoded = Buffer.from(previous);
          } finally {
            old.bytes.fill(0);
            current?.bytes.fill(0);
          }
        }
      } finally {
        previous.fill(0);
      }
    }
    this.#store.retain(this.#context, captured.encoded);
    captured.retained = true;
  }

  /** Provider-owned bytes are copied synchronously before it wipes its buffer.
   * Retention is attempted immediately. A key/storage outage keeps this bounded
   * protected-process copy for the original cleanup owner to retry; no successful
   * metadata acceptance can be inferred until retain returns its durable receipt.
   * Request cancellation is deliberately not a retention lifetime. */
  capture(bytes: Uint8Array, input: ProtectedGitHubCaptureObservationV1): EphemeralTokenHandleV1 {
    try {
      const observation = this.#observation(input);
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.length < 1 ||
        bytes.length > 16384 ||
        bytes.some((byte) => byte < 0x21 || byte > 0x7e)
      )
        unavailable();
      if (this.#captured !== undefined) {
        const previous = this.#captured;
        const existing =
          previous.raw ??
          (previous.encoded === undefined ? unavailable() : this.#decode(previous.encoded).bytes);
        try {
          if (
            existing.length !== bytes.length ||
            !timingSafeEqual(existing, bytes) ||
            this.#observationContext(previous.observation) !== this.#observationContext(observation)
          )
            unavailable();
          return previous.handle;
        } finally {
          if (existing !== previous.raw) existing.fill(0);
        }
      }
      const handle = Object.freeze({}) as EphemeralTokenHandleV1;
      const captured: Captured = {
        handle,
        encoded: undefined,
        raw: Buffer.from(bytes),
        observation,
        retained: false,
      };
      this.#handles.set(handle, captured);
      this.#captured = captured;
      try {
        this.#flush(captured);
      } catch {
        /* retained process responsibility; durable acceptance remains unavailable */
      }
      return handle;
    } catch {
      unavailable();
    }
  }

  /** Authenticated original-context readback, including captures whose provider
   * result returned unknown before the late callback returned its handle. */
  recover(): EphemeralTokenHandleV1 | undefined {
    if (this.#captured !== undefined) return this.#captured.handle;
    const encoded = this.#store.read(this.#context);
    if (encoded === undefined) return undefined;
    try {
      const decoded = this.#decode(encoded);
      try {
        return this.#adopt(encoded, decoded.observation, true).handle;
      } finally {
        decoded.bytes.fill(0);
      }
    } finally {
      encoded.fill(0);
    }
  }

  retain(handle: EphemeralTokenHandleV1): ProtectedGitHubRetentionV1 {
    try {
      if (!handle || typeof handle !== "object") unavailable();
      const captured = this.#handles.get(handle);
      if (captured === undefined) unavailable();
      this.#flush(captured);
      if (captured.encoded === undefined) unavailable();
      return Object.freeze({
        identity: this.#identity,
        observation: captured.observation,
        envelopeSHA256: createHash("sha256").update(captured.encoded).digest("hex"),
      });
    } catch {
      unavailable();
    }
  }

  /** Pairs this original retained token with the actual native service source.
   * The original State participant authenticates enrollment and COMMIT. Work
   * receives this fixed write operation, never a decrypted token or borrower. */
  async bindCommittedReleaseV2<
    N extends object,
    W extends object,
    V extends GitHubMediationVersion = 2,
  >(options: ProtectedGitHubReleaseOptionsV2<N, W, V>): Promise<ProtectedGitHubReleaseBindingV2> {
    if (this.#releaseBound) unavailable();
    this.#releaseBound = true;
    const custody = this;
    const identity = this.#identity;
    const protocolVersion = options.protocolVersion === undefined ? 2 : options.protocolVersion;
    if (protocolVersion !== 2 && protocolVersion !== 3) unavailable();
    const opening = structuredClone(options.opening);
    if (
      opening.version !== protocolVersion ||
      opening.request_ref !== options.call.requestRef ||
      opening.request_sha256 !== identity.lease.original.requestDigest
    )
      unavailable();
    let repositoryRequest: WorkRepositoryGitReadV3 | undefined;
    const encodedOpening = new TextEncoder().encode(JSON.stringify(opening));
    if (protocolVersion === 3) {
      const decoded = decodeGitHubMediationRequest(encodedOpening, 3);
      if (decoded?.method !== "open-read") unavailable();
      repositoryRequest = repositoryWorkGitReadBindingV3(decoded);
    } else {
      const decoded = decodeGitHubMediationRequest(encodedOpening, 2);
      if (
        decoded?.method !== "open-read" ||
        decoded.request_sha256 !==
          githubMetadataDigest(decoded.repository_owner, decoded.repository_name)
      )
        unavailable();
    }
    const requestedPermissions =
      protocolVersion === 3
        ? Object.freeze({ contents: "read", metadata: "read" })
        : Object.freeze({ metadata: "read" });
    const native = options.native;
    const session = options.originalSession;
    const participant = options.participant;
    const inspect = native.inspect.bind(native);
    const nativeCurrent = native.assertCurrent.bind(native);
    const prepareWrite = native.prepareCommittedToken.bind(native);
    const writePrepared = native.writePreparedCommittedToken.bind(native);
    const assertOriginal = participant.assertOriginal.bind(participant);
    const inventoryFor = participant.inventory.bind(participant);
    const recognize = participant.recognizeCommittedRelease.bind(participant);
    const acquireUse = participant.acquireCommittedRelease.bind(participant);
    const bindingCall = Object.freeze({ ...options.call });
    const observed = await inspect(session, bindingCall);
    assertGitHubAppSynchronousV1(() => nativeCurrent(session, bindingCall));
    const sessionRef = observed.sessionRef;
    if (!reference(sessionRef)) unavailable();
    // This diagnostic is available at native acquisition. The broker generates
    // its distinct wire session_ref only after the original preparation returns.
    const receiverRef = identity.lease.execution.receiverRef;
    const same = (a: unknown, b: unknown): boolean =>
      canonicalRepositoryInventoryV2(a) === canonicalRepositoryInventoryV2(b);
    let staged:
      | Readonly<{
          dispatch: RepositoryWorkDispatchV2;
          handle: EphemeralTokenHandleV1;
          retained: ProtectedGitHubRetentionV1;
        }>
      | undefined;
    let writeStarted = false;
    const current = (call: AuthorityCallV1, retained?: ProtectedGitHubRetentionV1): undefined => {
      const now = custody.#clock();
      if (
        call.signal.aborted ||
        !Number.isSafeInteger(now) ||
        !Number.isFinite(Date.parse(call.deadline)) ||
        now >= Date.parse(call.deadline) ||
        call.recipientRef !== receiverRef
      )
        unavailable();
      assertGitHubAppSynchronousV1(() => nativeCurrent(session, call));
      if (
        retained !== undefined &&
        (!retained.observation.scopeAccepted ||
          retained.observation.expiresAt === undefined ||
          now >= Date.parse(identity.lease.notAfter) ||
          now >= Date.parse(retained.observation.expiresAt))
      )
        unavailable();
      return undefined;
    };
    const source: RepositoryWorkCustodySourceV2 = Object.freeze({
      async acquire(
        context: RepositoryWorkTransactionContextV2,
        original: WorkOriginalOperationV2,
        inputCall: AuthorityCallV1,
      ) {
        const call = Object.freeze({ ...inputCall });
        assertOriginal(context, original, call);
        let active = true;
        let releaseStarted = false;
        let local: typeof staged;
        const assertCurrent = (): undefined => {
          const now = custody.#clock();
          if (
            !active ||
            call.signal.aborted ||
            !Number.isSafeInteger(now) ||
            !Number.isFinite(Date.parse(call.deadline)) ||
            now >= Date.parse(call.deadline)
          )
            unavailable();
          // Admission, preparation and retained observation have their original
          // Work owner. A closed native request must not erase cleanup authority.
          if (releaseStarted) current(call, local?.retained);
          return undefined;
        };
        return Object.freeze({
          receiver: native,
          session,
          receiverRef,
          sessionRef,
          assertCurrent,
          async stageRelease(input: RepositoryWorkDispatchV2) {
            assertOriginal(context, original, call);
            assertCurrent();
            if (releaseStarted) unavailable();
            releaseStarted = true;
            await inspect(session, call);
            assertCurrent();
            const inventory = inventoryFor(context);
            const record = await inventory.findRecord(input.inventoryRecordRef);
            assertCurrent();
            if (
              !record ||
              record.state !== "outstanding" ||
              record.disposition !== "current-check-required" ||
              record.inventoryVersion !== input.inventoryVersion
            )
              unavailable();
            const lease = await inventory.findLease(input.accessLeaseRef);
            assertCurrent();
            const mintClaim = await inventory.findMintClaim(input.inventoryRecordRef);
            assertCurrent();
            const handle = custody.recover();
            if (handle === undefined) unavailable();
            const retained = custody.retain(handle);
            if (
              !retained.observation.scopeAccepted ||
              !same(retained.observation.returnedPermissions, requestedPermissions) ||
              retained.observation.expiresAt === undefined ||
              !same(lease, identity.lease) ||
              !same(record.issuance.lease, identity.lease) ||
              record.issuance.bindingRef !== identity.key.bindingRef ||
              !same(record.issuance.requestedPermissions, requestedPermissions) ||
              !same(record.returnedPermissions, requestedPermissions) ||
              !same(input.repositoryRequest, repositoryRequest) ||
              (protocolVersion === 2 && Object.hasOwn(input, "repositoryRequest")) ||
              mintClaim === undefined ||
              mintClaim.recordRef !== record.target.recordRef ||
              mintClaim.issuanceOperationRef !== record.target.issuanceOperationRef ||
              mintClaim.issuanceIntentDigest !== record.target.intentDigest ||
              mintClaim.providerAttemptRef !== identity.providerAttemptRef ||
              !same(mintClaim.custodyIdentity, identity) ||
              !same(input.repositoryTarget, identity.lease.target) ||
              input.workRef !== identity.lease.work.workRef ||
              input.workRevision !== identity.lease.work.revision ||
              input.receiverRef !== receiverRef ||
              input.sessionRef !== sessionRef ||
              input.accessLeaseRef !== identity.lease.accessLeaseRef ||
              input.requestDigest !== identity.lease.original.requestDigest ||
              record.tokenRef !== identity.tokenRef ||
              record.protectedRevocationRef !== identity.protectedRevocationRef ||
              record.providerAttemptRef !== identity.providerAttemptRef ||
              record.expiry.kind !== "provider-expiry" ||
              record.expiry.expiresAt !== retained.observation.expiresAt ||
              !same(original, identity.lease.original)
            )
              unavailable();
            const dispatch = Object.freeze({
              ...input,
              repositoryTarget: Object.freeze({ ...identity.lease.target }),
              ...(repositoryRequest === undefined ? {} : { repositoryRequest }),
            });
            local = Object.freeze({ dispatch, handle, retained });
            if (
              staged !== undefined &&
              (!same(staged.dispatch, local.dispatch) || !same(staged.retained, local.retained))
            )
              unavailable();
            staged = local;
            assertCurrent();
          },
          async prepareCommit() {
            assertCurrent();
            if (releaseStarted) {
              await inspect(session, call);
              assertCurrent();
              if (local === undefined || !same(custody.retain(local.handle), local.retained))
                unavailable();
              assertCurrent();
            }
          },
          async release() {
            active = false;
            // Only this transaction lease ends. Ciphertext and original native
            // lifetime remain owned by the original settlement participants.
          },
        });
      },
    });
    return Object.freeze({
      source,
      async writeCommitted(
        commit: RepositoryWorkCommittedV2,
        input: Uint8Array,
        inputCall: AuthorityCallV1,
      ) {
        if (writeStarted || staged === undefined) unavailable();
        if (!(input instanceof Uint8Array) || input.length < 1 || input.length > 16384)
          unavailable();
        const metadata = Buffer.from(input);
        const call = Object.freeze({ ...inputCall });
        const selected = staged;
        let response: DispatchOnce<GitHubMediationVersion>;
        try {
          response = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(metadata),
          ) as DispatchOnce<GitHubMediationVersion>;
          if (
            !response ||
            response.ok !== true ||
            response.phase !== "dispatch-once" ||
            !Buffer.from(encodeGitHubMediationMetadata(response)).equals(metadata)
          )
            unavailable();
        } catch {
          unavailable();
        }
        const committed = recognize(commit, selected.dispatch.releaseRef, native, session);
        if (
          !same(committed.dispatch, selected.dispatch) ||
          response.version !== protocolVersion ||
          !same(committed.dispatch.repositoryRequest, repositoryRequest) ||
          response.release_ref !== committed.dispatch.releaseRef ||
          response.effect_ref !== committed.dispatch.preparationOperationRef ||
          response.request_sha256 !== committed.dispatch.requestDigest ||
          response.dns_binding_ref !== committed.dispatch.dnsBindingRef ||
          response.valid_until_ms > Date.parse(identity.lease.notAfter) ||
          selected.retained.observation.expiresAt === undefined ||
          response.valid_until_ms > Date.parse(selected.retained.observation.expiresAt)
        )
          unavailable();
        current(call, selected.retained);
        writeStarted = true;
        // Refresh latest-exchange membership before native preparation. The
        // broker's transport inspection is a separate owner operation.
        await inspect(session, call);
        current(call, selected.retained);
        const prepared = await prepareWrite(session, metadata, call);
        const use = await acquireUse(commit, call, native, session);
        if (use === undefined) unavailable();
        let bytes: Buffer | undefined;
        let borrowed = false;
        try {
          if (!same(use.committed, committed) || custody.#borrowing) unavailable();
          custody.#borrowing = true;
          borrowed = true;
          assertGitHubAppSynchronousV1(() => use.assertCurrent());
          current(call, selected.retained);
          if (!same(custody.retain(selected.handle), selected.retained)) unavailable();
          const captured = custody.#handles.get(selected.handle);
          if (captured?.encoded === undefined) unavailable();
          bytes = custody.#decode(captured.encoded).bytes;
          current(call, selected.retained);
          assertGitHubAppSynchronousV1(() => use.beginSubmittedUse());
          // The actual native method copies and submits synchronously. There is
          // no asynchronous gap between the final original State fence and write.
          const written = writePrepared(prepared, bytes, call);
          bytes.fill(0);
          bytes = undefined;
          await written;
        } finally {
          bytes?.fill(0);
          if (borrowed) custody.#borrowing = false;
          // A cancellation timeout is not proof of stopped delivery. The actual
          // native promise must settle before this held State use is released.
          await use.release();
        }
      },
    });
  }

  /** This purpose-limited interface is installed only on the existing provider.
   * User-operation release has a separate original committed-release sink. */
  #providerCustody(): GitHubAppTokenCustodyV1 {
    return Object.freeze({
      capture: this.capture.bind(this),
      withRevocationToken: async <T>(
        handle: EphemeralTokenHandleV1,
        bounds: GitHubAppCallBoundsV1,
        consume: (bytes: Uint8Array) => Promise<T>,
      ): Promise<T> => {
        if (this.#borrowing) unavailable();
        this.#borrowing = true;
        let bytes: Buffer | undefined;
        try {
          assertGitHubAppBoundsV1(bounds, this.#clock());
          this.retain(handle);
          const captured = this.#handles.get(handle);
          if (!captured) unavailable();
          if (captured.encoded === undefined) unavailable();
          bytes = this.#decode(captured.encoded).bytes;
          assertGitHubAppBoundsV1(bounds, this.#clock());
          return await consume(bytes);
        } catch {
          unavailable();
        } finally {
          bytes?.fill(0);
          this.#borrowing = false;
        }
      },
    });
  }

  /** Constructs the existing provider with its fixed custody privately. The
   * returned provider has mint/revoke methods only; no raw-byte consumer escapes.
   * The original operation owner still supplies its genuine dispatch assertion. */
  createProvider(options: {
    readonly material: GitHubAppMaterialV1;
    readonly repositoryFullName: string;
    readonly permissions: GitHubAppSelectionV1["permissions"];
    readonly assertDispatchCurrent: (attempt: Readonly<GitHubAppProviderAttemptV1>) => void;
    readonly endpoint: GitHubAppEndpointV1;
  }): ReturnType<typeof createGitHubAppProviderV1> {
    if (this.#providerCreated) unavailable();
    this.#providerCreated = true;
    const assertion = options.assertDispatchCurrent;
    return createGitHubAppProviderV1({
      selection: {
        key: this.#identity.key,
        installationId: protectedGitHubNumericIdV1(
          this.#identity.lease.target.githubInstallationId,
        ),
        repositories: [
          {
            id: protectedGitHubNumericIdV1(this.#identity.lease.target.repositoryId),
            fullName: options.repositoryFullName,
          },
        ],
        permissions: options.permissions,
      },
      material: options.material,
      custody: this.#providerCustody(),
      clock: this.#clock,
      endpoint: options.endpoint,
      assertDispatchCurrent: (attempt) => {
        if (attempt.providerAttemptRef !== this.#identity.providerAttemptRef) unavailable();
        assertGitHubAppSynchronousV1(() => assertion(attempt));
      },
    });
  }

  createRevocationProvider(options: {
    readonly providerAttemptRef: string;
    readonly assertRevocationCurrent: (attempt: Readonly<GitHubAppProviderAttemptV1>) => void;
    readonly endpoint: GitHubAppEndpointV1;
  }): ReturnType<typeof createGitHubAppRevocationProviderV1> {
    if (this.#revokerCreated || !reference(options.providerAttemptRef)) unavailable();
    this.#revokerCreated = true;
    const providerAttemptRef = options.providerAttemptRef;
    const assertion = options.assertRevocationCurrent;
    return createGitHubAppRevocationProviderV1({
      custody: this.#providerCustody(),
      clock: this.#clock,
      endpoint: options.endpoint,
      assertDispatchCurrent: (attempt) => {
        if (attempt.providerAttemptRef !== providerAttemptRef) unavailable();
        assertGitHubAppSynchronousV1(() => assertion(attempt));
      },
    });
  }
}
