import {
  decodeCurrentAccountDiagnosticV1,
  decodeResolveAccountRequestV1,
  type AccountSubjectV1,
  type AccountVersionVectorV1,
  type CurrentAccountObservationV1,
  type ResolveAccountRequestV1,
} from "@openclaw-enterprise/contracts/account-authority-v1";
import { immutableCopy } from "@openclaw-enterprise/utils";
import { DependencyUnavailableError } from "../errors.ts";
import type {
  TurnCommandAccountLeaseV1,
  TurnCommandAccountSourceV1,
  TurnCommandAccountUnitV1,
  TurnCommandChannelSnapshotV1,
} from "../ports/turn-command.ts";
import type { TurnCommandOwnedUnitV1, TurnCommandTerminalV1 } from "../ports/turn-command.ts";

export type NativeChannelAccountSubjectV1 = Extract<
  AccountSubjectV1,
  { readonly credentialMode: "native-channel" }
>;

export interface NativeChannelSourceFactsV1 {
  readonly platform: "slack" | "msteams";
  readonly installationId: string;
  readonly channelInstallationRef: string;
  readonly providerTenantRef: string;
  readonly recipientAppRef: string;
  readonly providerSubjectRef: string;
  readonly channelRef: string;
  readonly recipientRef: string;
  readonly sourceInvocationRef: string;
  readonly sourceCredentialVersion: number;
  readonly sourceConfigurationVersion: number;
  readonly expiresAt: string;
}

/** Original verifier retains the authentic invocation, exact recipient/operation
 * association and invalidation. Facts cannot reconstruct that opaque handle. */
export interface NativeChannelInvocationSourceV1<Invocation extends object> {
  inspect(
    invocation: Invocation,
    unit: TurnCommandAccountUnitV1,
  ): Promise<NativeChannelSourceFactsV1 | undefined>;
  /** No acquisition callback IO: valid through the original owner's final fence. */
  assertCurrent(invocation: Invocation, token: TurnCommandOwnedUnitV1): undefined;
}

export interface NativeChannelAccountLocationV1 {
  readonly principalId: string;
  readonly principalIssuer: string;
  readonly principalSubject: string;
  readonly iamDriverId: string;
}

/** Existing account writer facts. A binding never supplies default active state
 * or epoch values; native credential version is the original source's version. */
export interface NativeChannelAccountSecurityFactsV1 {
  readonly accountId: string;
  readonly principalId: string;
  readonly principalIssuer: string;
  readonly principalSubject: string;
  readonly accountState: "active";
  readonly versions: AccountVersionVectorV1;
  readonly selectedIAM: {
    readonly driverId: string;
    readonly revision: number;
  };
  readonly expiresAt: string;
}

export interface NativeChannelAccountSecurityLeaseV1 {
  readonly token: TurnCommandOwnedUnitV1;
  readonly facts: NativeChannelAccountSecurityFactsV1;
  /** Verifies actual original-token ownership and terminal cleanup registration. */
  assertOwned(token: TurnCommandOwnedUnitV1): undefined;
  /** Uses this fresh active callback's IO, never retained acquisition IO. */
  prepareCommit(unit: TurnCommandAccountUnitV1): Promise<void>;
  assertCurrent(): undefined;
}

/** Required BEFORE policy locking: genuine account/security/registration writer
 * exclusion on the same original unit. Acquire calls unit.retainSecurityCleanup
 * BEFORE resolving, so late failure cannot orphan the acquired guard. Only the
 * original central terminal owner invokes cleanup; this participant never does.
 * The writer validates the Installation issuer and canonical local account
 * association. Missing epoch or owner registration capability is unavailable. */
export interface NativeChannelAccountSecuritySourceV1<Invocation extends object> {
  acquire(
    unit: TurnCommandAccountUnitV1,
    location: NativeChannelAccountLocationV1,
    invocation: Invocation,
    source: NativeChannelSourceFactsV1,
  ): Promise<NativeChannelAccountSecurityLeaseV1 | undefined>;
}

export interface NativeChannelCurrentAccountLeaseV1 extends TurnCommandAccountLeaseV1 {
  readonly observation: CurrentAccountObservationV1 & {
    readonly subject: NativeChannelAccountSubjectV1;
  };
}

export interface NativeChannelAccountSourceV1 extends TurnCommandAccountSourceV1 {
  consume(unit: TurnCommandAccountUnitV1): Promise<NativeChannelCurrentAccountLeaseV1 | undefined>;
}

type CompleteBindings = {
  readonly [Key in keyof TurnCommandChannelSnapshotV1]: NonNullable<
    TurnCommandChannelSnapshotV1[Key]
  >;
};

const unavailable = () =>
  new DependencyUnavailableError("The current native account authority is unavailable.");

function sameValues(left: object, right: object): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Reflect.get(left, key) === Reflect.get(right, key))
  );
}

function sameSecurity(
  left: NativeChannelAccountSecurityFactsV1,
  right: NativeChannelAccountSecurityFactsV1,
): boolean {
  const { versions: a, selectedIAM: b, ...c } = left;
  const { versions: x, selectedIAM: y, ...z } = right;
  return sameValues(a, x) && sameValues(b, y) && sameValues(c, z);
}

function exactTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw unavailable();
  return parsed;
}

function synchronousFence(work: () => unknown, pending: Set<Promise<void>>): void {
  const result = work();
  if (result === undefined) return;
  // Refuse immediately, but retain malformed async work through the original
  // owner's awaited consume/preparation/release before writer cleanup. Handling
  // settlement here also prevents a provider rejection exposing a raw error.
  const settled = Promise.resolve(result).then(
    () => {},
    () => {},
  );
  pending.add(settled);
  void settled.then(() => pending.delete(settled));
  throw unavailable();
}

function matchingBindings(
  value: TurnCommandChannelSnapshotV1,
  source: NativeChannelSourceFactsV1,
  unit: TurnCommandAccountUnitV1,
): value is CompleteBindings {
  const { parent, human, agent } = value;
  return (
    parent !== undefined &&
    human !== undefined &&
    agent !== undefined &&
    parent.id === source.channelInstallationRef &&
    parent.installationId === unit.identity.installationId &&
    parent.platform === source.platform &&
    parent.providerTenantRef === source.providerTenantRef &&
    parent.recipientAppRef === source.recipientAppRef &&
    parent.status === "enabled" &&
    human.installationId === parent.installationId &&
    human.channelInstallationId === parent.id &&
    human.providerSubjectRef === source.providerSubjectRef &&
    human.status === "enabled" &&
    agent.installationId === parent.installationId &&
    agent.channelInstallationId === parent.id &&
    agent.channelRef === source.channelRef &&
    agent.namespaceId === unit.identity.namespaceId &&
    agent.agentId === unit.identity.agentId &&
    agent.status === "enabled" &&
    agent.scopeKind ===
      (source.platform === "slack" ? "slack-private-channel" : "msteams-standard-channel")
  );
}

function unchangedBindings(before: CompleteBindings, after: CompleteBindings): boolean {
  return (
    sameValues(before.parent, after.parent) &&
    sameValues(before.human, after.human) &&
    sameValues(before.agent, after.agent)
  );
}

/**
 * Original-owner composition, not a public request constructor. Producers must
 * authenticate the invocation and owned unit in their actual private custody.
 * The result is a guarded account observation, never an IAM allow/effect permit.
 *
 * TODO(native account composition): install the real account/security epoch
 * writer, native verifier and ordered same-client adapter. Missing producers
 * keep consumption unavailable; channel metadata alone never suffices.
 */
export function createNativeChannelAccountSourceV1<Invocation extends object>(options: {
  readonly invocation: Invocation;
  readonly request: ResolveAccountRequestV1;
  readonly recipientRef: string;
  readonly invocationSource?: NativeChannelInvocationSourceV1<Invocation>;
  readonly accountSecurity?: NativeChannelAccountSecuritySourceV1<Invocation>;
}): NativeChannelAccountSourceV1 {
  const invocation = options.invocation;
  const request = decodeResolveAccountRequestV1(options.request);
  const recipientRef = options.recipientRef;
  const sourceOwner = options.invocationSource;
  const accountOwner = options.accountSecurity;
  return Object.freeze({
    async consume(unit: TurnCommandAccountUnitV1) {
      const pendingFences = new Set<Promise<void>>();
      const sync = (work: () => unknown) => synchronousFence(work, pendingFences);
      const drainFences = async () => {
        while (pendingFences.size > 0) await Promise.all([...pendingFences]);
      };
      if (request.kind !== "valid" || sourceOwner === undefined || accountOwner === undefined) {
        return undefined;
      }
      try {
        const inspectSource = sourceOwner.inspect.bind(sourceOwner);
        const assertSource = sourceOwner.assertCurrent.bind(sourceOwner);
        const acquire = accountOwner.acquire.bind(accountOwner);
        const originalRequest = request.value;
        const originalIdentity = immutableCopy(unit.identity);
        const token = unit.token;
        const signal = unit.bounds.signal;
        const deadline = unit.bounds.deadline;
        const began = performance.now();
        const observedAt = Date.now();
        const requestedDeadline = exactTime(originalRequest.deadline);
        const ownerDeadline = exactTime(deadline);
        let expires = Math.min(requestedDeadline, ownerDeadline);
        let released = false;
        if (
          originalRequest.installationId !== originalIdentity.installationId ||
          requestedDeadline > ownerDeadline ||
          exactTime(originalRequest.createdAt) > observedAt ||
          typeof recipientRef !== "string" ||
          recipientRef.length === 0
        ) {
          return undefined;
        }
        const assertLifetime = () => {
          const elapsed = performance.now() - began;
          if (
            released ||
            signal.aborted ||
            !Number.isFinite(elapsed) ||
            elapsed < 0 ||
            elapsed >= expires - observedAt ||
            Date.now() >= expires
          ) {
            throw unavailable();
          }
        };
        const assertIO = (current: TurnCommandAccountUnitV1) => {
          sync(() => current.assertActive());
          if (
            current.token !== token ||
            current.bounds.signal !== signal ||
            current.bounds.deadline !== deadline ||
            !sameValues(originalIdentity, current.identity) ||
            token.installationId !== originalIdentity.installationId ||
            token.namespaceId !== originalIdentity.namespaceId ||
            token.agentId !== originalIdentity.agentId ||
            token.operationRef !== originalIdentity.operationRef
          ) {
            throw unavailable();
          }
          assertLifetime();
        };
        assertIO(unit);
        const first = await inspectSource(invocation, unit);
        assertIO(unit);
        if (first === undefined) return undefined;
        const source = immutableCopy(first);
        expires = Math.min(expires, exactTime(source.expiresAt));
        assertLifetime();
        if (
          source.installationId !== originalIdentity.installationId ||
          source.recipientRef !== recipientRef ||
          (source.platform !== "slack" && source.platform !== "msteams")
        ) {
          return undefined;
        }
        sync(() => assertSource(invocation, token));
        const locator = Object.freeze({
          parentId: source.channelInstallationRef,
          providerSubjectRef: source.providerSubjectRef,
          channelRef: source.channelRef,
        });
        const located = await unit.locateChannel(locator);
        assertIO(unit);
        if (!matchingBindings(located, source, unit)) return undefined;
        const before = immutableCopy(located);
        const location = Object.freeze({
          principalId: before.human.principalId,
          principalIssuer: before.human.principalIssuer,
          principalSubject: before.human.principalSubject,
          iamDriverId: before.human.iamDriverId,
        });
        // The writer owns early-failure cleanup once this acquisition has succeeded.
        const security = await acquire(unit, location, invocation, source);
        assertIO(unit);
        if (security === undefined) return undefined;
        const facts = immutableCopy(security.facts);
        const assertOwned = security.assertOwned.bind(security);
        const assertSecurity = security.assertCurrent.bind(security);
        const prepareSecurity = security.prepareCommit.bind(security);
        const assertCurrent = (): undefined => {
          try {
            assertLifetime();
            if (security.token !== token || !sameSecurity(facts, security.facts)) {
              throw unavailable();
            }
            sync(() => assertOwned(token));
            sync(assertSecurity);
            sync(() => assertSource(invocation, token));
            return undefined;
          } catch {
            throw unavailable();
          }
        };
        assertCurrent();
        if (
          facts.accountState !== "active" ||
          facts.principalId !== location.principalId ||
          facts.principalIssuer !== location.principalIssuer ||
          facts.principalSubject !== location.principalSubject ||
          facts.accountId !== location.principalSubject ||
          facts.selectedIAM.driverId !== location.iamDriverId ||
          facts.versions.credential !== source.sourceCredentialVersion
        ) {
          return undefined;
        }
        expires = Math.min(expires, exactTime(facts.expiresAt));
        assertCurrent();
        await unit.lockPolicy();
        assertIO(unit);
        assertCurrent();
        sync(() => unit.iam.assertCurrent());
        // Compares actual versions after the barrier; never refreshes captured facts.
        await prepareSecurity(unit);
        assertIO(unit);
        assertCurrent();
        const identity = await unit.iam.lookupIdentity({
          issuer: location.principalIssuer,
          subject: location.principalSubject,
        });
        assertIO(unit);
        assertCurrent();
        if (identity?.kind !== "principal" || identity.id !== location.principalId)
          return undefined;
        const reloaded = await unit.lockParentsAndReload();
        assertIO(unit);
        assertCurrent();
        if (!matchingBindings(reloaded, source, unit) || !unchangedBindings(before, reloaded)) {
          return undefined;
        }
        const subject: NativeChannelAccountSubjectV1 = {
          principalKind: "principal",
          credentialMode: "native-channel",
          principalId: identity.id,
          accountId: facts.accountId,
          accountState: facts.accountState,
          selectedIAM: facts.selectedIAM,
          nativeChannel: {
            channelInstallationRef: reloaded.parent.id,
            channelInstallationVersion: reloaded.parent.version,
            externalBindingRef: reloaded.human.id,
            externalBindingVersion: reloaded.human.version,
            sourceInvocationRef: source.sourceInvocationRef,
            sourceCredentialVersion: source.sourceCredentialVersion,
            sourceConfigurationVersion: source.sourceConfigurationVersion,
            expiresAt: source.expiresAt,
          },
        };
        const decoded = decodeCurrentAccountDiagnosticV1({
          kind: "current",
          observation: {
            schemaVersion: 1,
            requestId: originalRequest.requestId,
            installationId: originalIdentity.installationId,
            currentnessProfile: originalRequest.currentnessProfile,
            scope: "account-and-selected-iam-only",
            evaluatedAt: new Date(observedAt).toISOString(),
            validUntil: new Date(expires).toISOString(),
            subject,
            versions: facts.versions,
          },
        });
        if (decoded.kind !== "valid" || decoded.value.kind !== "current") return undefined;
        const observation = immutableCopy({ ...decoded.value.observation, subject });
        let terminal: TurnCommandTerminalV1 | undefined;
        let releaseWork: Promise<void> | undefined;
        assertCurrent();
        return Object.freeze({
          observation,
          assertCurrent,
          async prepareCommit(currentUnit: TurnCommandAccountUnitV1) {
            try {
              assertIO(currentUnit);
              assertCurrent();
              await prepareSecurity(currentUnit);
              assertIO(currentUnit);
              assertCurrent();
              const currentSource = await inspectSource(invocation, currentUnit);
              assertIO(currentUnit);
              assertCurrent();
              if (currentSource === undefined || !sameValues(source, currentSource)) {
                throw unavailable();
              }
              const currentBindings = await currentUnit.readLockedChannel();
              assertIO(currentUnit);
              assertCurrent();
              if (
                !matchingBindings(currentBindings, source, currentUnit) ||
                !unchangedBindings(before, currentBindings)
              ) {
                throw unavailable();
              }
              sync(() => currentUnit.iam.assertCurrent());
            } catch {
              await drainFences();
              throw unavailable();
            }
          },
          release(outcome: TurnCommandTerminalV1) {
            if (releaseWork !== undefined) {
              return outcome === terminal ? releaseWork : Promise.reject(unavailable());
            }
            if (
              !["rolled-back", "commit-rejected", "commit-unknown", "committed"].includes(outcome)
            ) {
              return Promise.reject(unavailable());
            }
            terminal = outcome;
            released = true;
            // Account cleanup only closes this local observation. The original
            // central owner retains and releases its registered writer guard.
            releaseWork = drainFences();
            return releaseWork;
          },
        });
      } catch {
        // Acquisition is still original-owner work, even if no lease was returned.
        await drainFences();
        // Original verifier/database errors can contain secrets; expose no cause.
        throw unavailable();
      }
    },
  });
}
