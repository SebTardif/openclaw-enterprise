import { DependencyUnavailableError } from "../errors.ts";
import type {
  NativeChannelAccountLocationV1,
  NativeChannelAccountSecurityFactsV1,
  NativeChannelAccountSecurityLeaseV1,
  NativeChannelAccountSecuritySourceV1,
  NativeChannelSourceFactsV1,
} from "./native-channel.ts";

/** Canonical manual-account state. Only the original transactional writer may
 * create or advance it; consumers never infer active state or initial versions. */
export interface LocalAccountSecurityRecordV1 {
  readonly installationId: string;
  readonly accountId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly incarnation: string;
  readonly state: "provisioning" | "active" | "deleted";
  readonly accountVersion: number;
  readonly currentUserId: string | null;
  readonly credentialAccountId: string | null;
}

export interface LocalAccountSecurityLookupV1 {
  readonly installationId: string;
  readonly accountId: string;
  readonly issuer: string;
  readonly subject: string;
}

/** The original database owner captures the genuine command token and tracked
 * query context. Preparing runs inside that owner's newly active callback;
 * the retained final fence never uses expired acquisition-callback IO. */
export interface LocalAccountSecurityRecordLeaseV1 {
  readonly record: LocalAccountSecurityRecordV1;
  prepareCommit(): Promise<void>;
  assertCurrent(): undefined;
  /** Closes this observation only. Database locks belong to the original
   * transaction and remain held until its actual terminal. */
  release(): void;
}

/** Bound by the original owner to one genuine command, not a raw query or a
 * caller-supplied token. Lock takes the Installation shared advisory prefix
 * before the retained record lock, before policy; it never tuple-locks a user
 * or credential parent. Missing records are unavailable, never backfilled. */
export interface LocalAccountSecurityRecordReaderV1 {
  lock(
    lookup: LocalAccountSecurityLookupV1,
  ): Promise<LocalAccountSecurityRecordLeaseV1 | undefined>;
}

type AccountUnit = Parameters<NativeChannelAccountSecuritySourceV1<object>["acquire"]>[0];
type AccountToken = AccountUnit["token"];
type Terminal = Parameters<Parameters<AccountUnit["retainSecurityCleanup"]>[0]>[0];

/** Each value still needs its original authority/invalidation producer. This
 * account record supplies none of these six independent domains. */
export interface LocalAccountOtherDomainFactsV1 {
  readonly versions: Omit<NativeChannelAccountSecurityFactsV1["versions"], "account">;
  readonly selectedIAM: NativeChannelAccountSecurityFactsV1["selectedIAM"];
  readonly expiresAt: string;
}

export interface LocalAccountOtherDomainLeaseV1 {
  readonly token: AccountToken;
  readonly facts: LocalAccountOtherDomainFactsV1;
  assertOwned(token: AccountToken): undefined;
  prepareCommit(unit: AccountUnit): Promise<void>;
  assertCurrent(): undefined;
}

export interface LocalAccountOtherDomainSourceV1<Invocation extends object> {
  /** Register each acquired original guard before returning or allowing an
   * acquisition failure to escape. The central owner alone invokes cleanup;
   * this callback enrolls into its single already-retained security cleanup. */
  acquire(
    unit: AccountUnit,
    location: NativeChannelAccountLocationV1,
    invocation: Invocation,
    source: NativeChannelSourceFactsV1,
    retainCleanup: (release: (outcome: Terminal) => Promise<void>) => void,
  ): Promise<LocalAccountOtherDomainLeaseV1 | undefined>;
}

const recordKeys = [
  "installationId",
  "accountId",
  "issuer",
  "subject",
  "incarnation",
  "state",
  "accountVersion",
  "currentUserId",
  "credentialAccountId",
] as const;
const domainKeys = [
  "installation",
  "credential",
  "grants",
  "iamPolicy",
  "semanticMapping",
  "driverSelection",
] as const;
const unavailable = () =>
  new DependencyUnavailableError("The current local account security is unavailable.");
const reference = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value);
const version = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function timestamp(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw unavailable();
  return time;
}

function activeRecord(
  value: LocalAccountSecurityRecordV1,
  lookup: LocalAccountSecurityLookupV1,
): Readonly<LocalAccountSecurityRecordV1> | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).length !== recordKeys.length ||
    !recordKeys.every((key) => Object.hasOwn(value, key)) ||
    value.state !== "active" ||
    value.installationId !== lookup.installationId ||
    value.accountId !== lookup.accountId ||
    value.issuer !== lookup.issuer ||
    value.subject !== lookup.subject ||
    value.currentUserId !== lookup.accountId ||
    !reference(value.incarnation) ||
    !reference(value.credentialAccountId) ||
    !version(value.accountVersion)
  ) {
    return undefined;
  }
  return Object.freeze({
    installationId: value.installationId,
    accountId: value.accountId,
    issuer: value.issuer,
    subject: value.subject,
    incarnation: value.incarnation,
    state: value.state,
    accountVersion: value.accountVersion,
    currentUserId: value.currentUserId,
    credentialAccountId: value.credentialAccountId,
  });
}

function otherFacts(
  value: LocalAccountOtherDomainFactsV1,
  location: NativeChannelAccountLocationV1,
  source: NativeChannelSourceFactsV1,
): Readonly<LocalAccountOtherDomainFactsV1> {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.versions !== "object" ||
    value.versions === null ||
    Object.keys(value.versions).length !== domainKeys.length ||
    !domainKeys.every((key) => version(value.versions[key])) ||
    value.versions.credential !== source.sourceCredentialVersion ||
    value.selectedIAM?.driverId !== location.iamDriverId ||
    value.selectedIAM.revision !== value.versions.driverSelection
  ) {
    throw unavailable();
  }
  timestamp(value.expiresAt);
  return Object.freeze({
    versions: Object.freeze({
      installation: value.versions.installation,
      credential: value.versions.credential,
      grants: value.versions.grants,
      iamPolicy: value.versions.iamPolicy,
      semanticMapping: value.versions.semanticMapping,
      driverSelection: value.versions.driverSelection,
    }),
    selectedIAM: Object.freeze({
      driverId: value.selectedIAM.driverId,
      revision: value.selectedIAM.revision,
    }),
    expiresAt: value.expiresAt,
  });
}

function sameRecord(a: LocalAccountSecurityRecordV1, b: LocalAccountSecurityRecordV1): boolean {
  return recordKeys.every((key) => a[key] === b[key]);
}

function sameDomains(
  a: LocalAccountOtherDomainFactsV1,
  b: LocalAccountOtherDomainFactsV1,
): boolean {
  return (
    domainKeys.every((key) => a.versions[key] === b.versions[key]) &&
    a.selectedIAM.driverId === b.selectedIAM.driverId &&
    a.selectedIAM.revision === b.selectedIAM.revision &&
    a.expiresAt === b.expiresAt
  );
}

/** One original command's account-security composition. The bound reader owns
 * actual database exclusion; supplied original providers own every other domain.
 * Missing producers are unavailable. Neither records nor controlled port tests
 * make this an installed authority or a substitute for writer/privilege proof. */
export function createLocalAccountSecuritySourceV1<Invocation extends object>(options: {
  readonly reader?: LocalAccountSecurityRecordReaderV1;
  readonly otherDomains?: LocalAccountOtherDomainSourceV1<Invocation>;
}): NativeChannelAccountSecuritySourceV1<Invocation> {
  const reader = options.reader;
  const otherDomains = options.otherDomains;
  let started = false;
  return Object.freeze({
    async acquire(
      unit: AccountUnit,
      location: NativeChannelAccountLocationV1,
      invocation: Invocation,
      source: NativeChannelSourceFactsV1,
    ): Promise<NativeChannelAccountSecurityLeaseV1 | undefined> {
      if (reader === undefined || otherDomains === undefined) return undefined;
      if (started) throw unavailable();
      started = true;
      const pending = new Set<Promise<void>>();
      const releases: Array<(outcome: Terminal) => Promise<void>> = [];
      let closed = false;
      let acceptingCleanup = false;
      let cleanupWork: Promise<void> | undefined;
      const drain = async () => {
        while (pending.size > 0) await Promise.all([...pending]);
      };
      const sync = (work: () => unknown) => {
        const result = work();
        if (result === undefined) return;
        const settled = Promise.resolve(result).then(
          () => {},
          () => {},
        );
        pending.add(settled);
        void settled.then(() => pending.delete(settled));
        throw unavailable();
      };
      try {
        unit.assertActive();
        const token = unit.token;
        const identity = Object.freeze({ ...unit.identity });
        const signal = unit.bounds.signal;
        const deadline = unit.bounds.deadline;
        const observedAt = Date.now();
        const began = performance.now();
        let expires = Math.min(timestamp(deadline), timestamp(source.expiresAt));
        const assertLifetime = () => {
          const elapsed = performance.now() - began;
          if (
            closed ||
            signal.aborted ||
            !Number.isFinite(elapsed) ||
            elapsed < 0 ||
            elapsed >= expires - observedAt ||
            Date.now() >= expires
          ) {
            throw unavailable();
          }
        };
        const assertCallback = (current: AccountUnit) => {
          assertLifetime();
          if (
            current.token !== token ||
            current.bounds.signal !== signal ||
            current.bounds.deadline !== deadline ||
            current.identity.installationId !== identity.installationId ||
            current.identity.namespaceId !== identity.namespaceId ||
            current.identity.agentId !== identity.agentId ||
            current.identity.operationRef !== identity.operationRef
          ) {
            throw unavailable();
          }
          current.assertActive();
        };
        if (
          source.installationId !== identity.installationId ||
          !reference(location.principalId) ||
          !reference(location.principalSubject) ||
          !reference(location.iamDriverId) ||
          location.principalIssuer !==
            "occ:installation:" + identity.installationId + ":better-auth"
        ) {
          return undefined;
        }
        const lookup = Object.freeze({
          installationId: identity.installationId,
          accountId: location.principalSubject,
          issuer: location.principalIssuer,
          subject: location.principalSubject,
        });
        // Registration precedes acquisition. Central retains it even if any
        // subsequent callback, getter or acquisition fails.
        unit.retainSecurityCleanup((outcome) => {
          if (cleanupWork !== undefined) return cleanupWork;
          closed = true;
          acceptingCleanup = false;
          cleanupWork = (async () => {
            await drain();
            let failed = false;
            for (const release of [...releases].reverse()) {
              try {
                await release(outcome);
              } catch {
                failed = true;
              }
            }
            if (failed) throw unavailable();
          })();
          return cleanupWork;
        });
        assertCallback(unit);
        const local = await reader.lock(lookup);
        if (local !== undefined) {
          const releaseLocal = local.release.bind(local);
          releases.push(async () => {
            await releaseLocal();
          });
        }
        assertCallback(unit);
        if (local === undefined) return undefined;
        const prepareLocal = local.prepareCommit.bind(local);
        const assertLocal = local.assertCurrent.bind(local);
        const record = activeRecord(local.record, lookup);
        if (record === undefined) return undefined;
        sync(assertLocal);
        let registeredOther = 0;
        acceptingCleanup = true;
        let other: LocalAccountOtherDomainLeaseV1 | undefined;
        try {
          other = await otherDomains.acquire(unit, location, invocation, source, (release) => {
            if (!acceptingCleanup || typeof release !== "function") throw unavailable();
            // A guard acquired by this still-awaited provider belongs to the
            // original terminal even if abort/expiry just invalidated its use.
            // Retain cleanup before propagating that lifetime failure.
            releases.push(release);
            registeredOther += 1;
            assertCallback(unit);
          });
        } finally {
          acceptingCleanup = false;
        }
        assertCallback(unit);
        if (other === undefined) return undefined;
        if (registeredOther === 0 || other.token !== token) throw unavailable();
        const prepareOther = other.prepareCommit.bind(other);
        const assertOther = other.assertCurrent.bind(other);
        const assertOwnedOther = other.assertOwned.bind(other);
        const domains = otherFacts(other.facts, location, source);
        expires = Math.min(expires, timestamp(domains.expiresAt));
        const assertCurrent = () => {
          assertLifetime();
          sync(assertLocal);
          sync(() => assertOwnedOther(token));
          sync(assertOther);
          assertLifetime();
        };
        assertCurrent();
        const facts: NativeChannelAccountSecurityFactsV1 = Object.freeze({
          accountId: record.accountId,
          principalId: location.principalId,
          principalIssuer: record.issuer,
          principalSubject: record.subject,
          accountState: "active",
          versions: Object.freeze({ ...domains.versions, account: record.accountVersion }),
          selectedIAM: domains.selectedIAM,
          expiresAt: new Date(expires).toISOString(),
        });
        return Object.freeze({
          token,
          facts,
          assertOwned(current: AccountToken) {
            if (current !== token) throw unavailable();
            assertCurrent();
            return undefined;
          },
          assertCurrent() {
            assertCurrent();
            return undefined;
          },
          async prepareCommit(current: AccountUnit) {
            try {
              assertCallback(current);
              assertCurrent();
              await prepareLocal();
              assertCallback(current);
              const latest = activeRecord(local.record, lookup);
              if (latest === undefined || !sameRecord(record, latest)) throw unavailable();
              await prepareOther(current);
              assertCallback(current);
              if (!sameDomains(domains, otherFacts(other.facts, location, source)))
                throw unavailable();
              assertCurrent();
            } catch {
              await drain();
              throw unavailable();
            }
          },
        });
      } catch {
        await drain();
        throw unavailable();
      }
    },
  });
}
