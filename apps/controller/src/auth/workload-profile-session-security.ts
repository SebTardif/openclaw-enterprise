import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
import type { WorkloadProfileAccountUnit } from "@openclaw-enterprise/occ/services/workload-profile/port";
import type {
  WorkloadProfileRequestLeaseV1,
  WorkloadProfileSessionSecurityLeaseV1,
  WorkloadProfileSessionSecuritySourceV1,
} from "@openclaw-enterprise/occ/account-authority/workload-profile";
import type { ControllerWorkloadProfileRequestCustodyV1 } from "./workload-profile-request.ts";

/** Minimal requested shape for the ORIGINAL profile-owned reader. This local
 * consumer declaration creates no reader/brand/transaction or DB privilege.
 * The original central implementation owns its callable and concrete return
 * declaration; structural fit is not provenance or installed authority. */
export interface ControllerProfileSessionLookupV1 {
  readonly installationId: string;
  readonly accountId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly sessionId: string;
  readonly sessionCredentialDigest: string;
}
export interface ControllerProfileSessionReadLeaseV1 {
  readonly installationId: string;
  readonly accountId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly incarnation: string;
  readonly accountVersion: number;
  readonly state: "provisioning" | "active" | "deleted";
  readonly currentUserId: string | null;
  readonly credentialAccountId: string | null;
  readonly sessionId: string;
  readonly sessionUserId: string;
  readonly sessionCredentialDigest: string;
  readonly expiresAt: string;
  /** Original outer owner/current client, not the completed acquisition IO. */
  assertCurrent(): void;
  /** Local observation only; original owner alone releases actual DB locks. */
  release(): void;
}
export interface ControllerProfileSessionReaderV1 {
  /** Original state recognizes this canonical unit, orders account/session locks
   * before policy, and performs the exact credential match on that SAME client.
   * An unavailable helper/role/session/record supplies no positive lease. */
  lock(
    unit: WorkloadProfileAccountUnit,
    lookup: ControllerProfileSessionLookupV1,
  ): Promise<ControllerProfileSessionReadLeaseV1 | undefined>;
}

const unavailable = () =>
  new DependencyUnavailableError("The current controller session security is unavailable.");
const ref = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 1024;

/** Adapter over original private request membership and actual supplied reader.
 * Neither an unrecognized request lease nor a missing reader is authenticated
 * by these interfaces. It opens no database/client or policy transaction. */
export function createControllerWorkloadProfileSessionSecurityV1(
  options: Readonly<{
    requests: ControllerWorkloadProfileRequestCustodyV1;
    reader?: ControllerProfileSessionReaderV1;
  }>,
): WorkloadProfileSessionSecuritySourceV1 {
  const requests = options.requests;
  const reader = options.reader;
  return Object.freeze<WorkloadProfileSessionSecuritySourceV1>({
    async lock(
      unit,
      request,
      retainCleanup,
    ): Promise<WorkloadProfileSessionSecurityLeaseV1 | undefined> {
      const source = requests.resolveConsumedSession(request, unit);
      if (!source || !reader) throw unavailable();
      const lookup = Object.freeze({
        installationId: source.installationId,
        accountId: source.accountId,
        issuer: source.issuer,
        subject: source.subject,
        sessionId: source.sessionId,
        sessionCredentialDigest: source.sessionCredentialDigest,
      });
      const held = await reader.lock(unit, lookup);
      if (!held) throw unavailable();
      // Capture and transfer release before any other reader getter/currentness
      // check can fail. SQL locks stay with the original transaction regardless.
      const release = held.release;
      if (typeof release !== "function") throw unavailable();
      let released = false;
      retainCleanup(() => {
        if (released) return;
        released = true;
        return Reflect.apply(release, held, []);
      });
      const assertCurrent = held.assertCurrent;
      if (typeof assertCurrent !== "function") throw unavailable();
      const captured = {
        installationId: held.installationId,
        accountId: held.accountId,
        issuer: held.issuer,
        subject: held.subject,
        incarnation: held.incarnation,
        accountVersion: held.accountVersion,
        state: held.state,
        currentUserId: held.currentUserId,
        credentialAccountId: held.credentialAccountId,
        sessionId: held.sessionId,
        sessionUserId: held.sessionUserId,
        sessionCredentialDigest: held.sessionCredentialDigest,
        expiresAt: held.expiresAt,
      };
      if (
        captured.installationId !== lookup.installationId ||
        captured.accountId !== lookup.accountId ||
        captured.issuer !== lookup.issuer ||
        captured.subject !== lookup.subject ||
        captured.state !== "active" ||
        captured.currentUserId !== lookup.accountId ||
        !ref(captured.credentialAccountId) ||
        !ref(captured.incarnation) ||
        !Number.isSafeInteger(captured.accountVersion) ||
        captured.accountVersion < 1 ||
        captured.sessionId !== lookup.sessionId ||
        captured.sessionUserId !== lookup.accountId ||
        captured.sessionCredentialDigest !== lookup.sessionCredentialDigest ||
        !Number.isFinite(Date.parse(captured.expiresAt)) ||
        new Date(captured.expiresAt).toISOString() !== captured.expiresAt
      )
        throw unavailable();
      const expires = Math.min(Date.parse(source.expiresAt), Date.parse(captured.expiresAt));
      const remaining = expires - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) throw unavailable();
      const deadline = process.hrtime.bigint() + BigInt(Math.floor(remaining)) * 1000000n;
      const current = () => {
        if (
          released ||
          unit.signal.aborted ||
          process.hrtime.bigint() >= deadline ||
          Date.now() >= expires
        )
          throw unavailable();
        request.assertCurrent();
        const value = Reflect.apply(assertCurrent, held, []);
        // The outer original account adapter captures/drains malformed async
        // fences. Return the value to that same owner instead of dropping it.
        if (value !== undefined) return value;
        if (unit.signal.aborted) throw unavailable();
      };
      const initial = current();
      if (initial !== undefined) {
        await Promise.resolve(initial).then(
          () => {},
          () => {},
        );
        throw unavailable();
      }
      return Object.freeze({
        principal: source.principal,
        accountRef: source.accountId,
        sessionRef: source.sessionId,
        preparationSessionOrigin: Object.freeze({
          ...lookup,
          accountIncarnation: captured.incarnation,
          accountVersion: captured.accountVersion,
        }),
        expiresAt: new Date(expires).toISOString(),
        assertCurrent: current,
      });
    },
  });
}
