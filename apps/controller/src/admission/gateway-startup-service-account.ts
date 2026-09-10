import { randomUUID } from "node:crypto";
import { DependencyUnavailableError } from "@openclaw-enterprise/occ";
import type { GatewayStartupControllerParticipantsV2 } from "@openclaw-enterprise/occ/gateway-startup-v1/controller";
import type { GatewayStartupAccountBindingReaderV1 } from "@openclaw-enterprise/occ/gateway-startup-v1/account-binding";
import type { GatewayInstallationServiceCurrentnessV2 } from "@openclaw-enterprise/occ/gateway-startup-v1/agent-service";
import {
  canonicalGatewayStartupValueV1,
  parseGatewayStartupCommandV2,
} from "@openclaw-enterprise/occ/gateway-startup-v1/owner";
import { parseGatewayInstallationServiceAssociationV2 } from "@openclaw-enterprise/occ/gateway-startup-v1/installation-service";
import type { GatewayStartupRegistrationNativeV2 } from "./gateway-startup-service-context.ts";
import type { createInstallationServiceRegistrationReaderV2 } from "./installation-service-registration.ts";

const unavailable = () =>
  new DependencyUnavailableError("The current Agent Gateway service account is unavailable.");
const same = (left: unknown, right: unknown) =>
  canonicalGatewayStartupValueV1(left) === canonicalGatewayStartupValueV1(right);

/** Original Controller composition only. The native receiver supplies private
 * call membership; the existing State reader locks the account retained by the
 * accepted startup. Neither one replaces the independent registration/process
 * reader or the selected IAM decision in the SAME original SQL unit. */
export function createControllerGatewayStartupServiceCurrentnessV2(
  options: Readonly<{
    account: GatewayStartupAccountBindingReaderV1;
    driverSelection: GatewayStartupControllerParticipantsV2["driverSelection"];
    native: GatewayStartupRegistrationNativeV2;
    registration: ReturnType<typeof createInstallationServiceRegistrationReaderV2>;
  }>,
): GatewayInstallationServiceCurrentnessV2 {
  const lockAccount = options.account.lock.bind(options.account);
  const originalFor = options.native.originalFor.bind(options.native);
  const inspectOriginal = options.native.inspectOriginal.bind(options.native);
  const acquireRegistration = options.registration.acquire.bind(options.registration);
  const selection = options.driverSelection;
  const selectedIAM = selection.selectedDriver("iam");
  return Object.freeze<GatewayInstallationServiceCurrentnessV2>({
    async consume(association, input, bounds, unit, io, policy) {
      try {
        const command = parseGatewayStartupCommandV2(input);
        const expected = parseGatewayInstallationServiceAssociationV2(association);
        if (
          command.kind !== "consume-startup" &&
          command.kind !== "read-current" &&
          command.kind !== "read-operation"
        )
          throw unavailable();
        const startup =
          command.kind === "read-operation" ? command.operation.startup : command.startup;
        const remaining = Date.parse(bounds.deadline) - Date.now();
        if (
          !startup ||
          !same(startup, expected.startup) ||
          !same(command.subject, unit.subject) ||
          !same(startup.subject, unit.subject) ||
          (command.kind !== "read-operation" && !same(command.recipient, expected.recipient)) ||
          !(bounds.signal instanceof AbortSignal) ||
          bounds.signal.aborted ||
          !Number.isSafeInteger(remaining) ||
          remaining < 1 ||
          remaining > 3000
        )
          throw unavailable();
        const original = originalFor(command, bounds);
        if (original && typeof original === "object" && "then" in original) {
          await Promise.resolve(original).catch(() => {});
          throw unavailable();
        }
        if (!original) throw unavailable();
        const native = inspectOriginal(original, command, bounds);
        if (native && typeof native === "object" && "then" in native) {
          await Promise.resolve(native).catch(() => {});
          throw unavailable();
        }
        if (!native) throw unavailable();
        const deadline = process.hrtime.bigint() + BigInt(remaining) * 1000000n;
        const selected = selection.acquireGuardedSelection("iam", selectedIAM);
        let released = false;
        let releaseTask: Promise<void> | undefined;
        const pendingFences = new Set<Promise<unknown>>();
        const release = (): Promise<void> => {
          released = true;
          return (releaseTask ??= (async () => {
            try {
              while (pendingFences.size) await Promise.allSettled([...pendingFences]);
            } finally {
              selected.release();
            }
          })());
        };
        let retained = false;
        try {
          unit.phase.retainCleanup(release);
          retained = true;
        } finally {
          if (!retained) await release();
        }
        const current = (): undefined => {
          if (
            released ||
            bounds.signal.aborted ||
            native.signal.aborted ||
            Date.now() >= Date.parse(bounds.deadline) ||
            process.hrtime.bigint() >= deadline
          )
            throw unavailable();
          const currentOriginal = originalFor(command, bounds);
          if (currentOriginal && typeof currentOriginal === "object" && "then" in currentOriginal) {
            const pending = Promise.resolve(currentOriginal).catch(() => {});
            pendingFences.add(pending);
            void pending.then(() => pendingFences.delete(pending));
            throw unavailable();
          }
          if (currentOriginal !== original) throw unavailable();
          selected.assertCurrent();
          return native.assertCurrent();
        };
        unit.phase.retainCurrentness(current);
        const check = async () => {
          const value: unknown = current();
          if (value !== undefined) {
            await Promise.resolve(value).catch(() => {});
            throw unavailable();
          }
          io.assertActive();
        };
        await check();
        const held = await lockAccount(unit, io, bounds);
        if (!held) throw unavailable();
        let accountRetained = false;
        try {
          unit.phase.retainCleanup(async () => held.release());
          accountRetained = true;
          unit.phase.retainCurrentness(held.assertCurrent.bind(held));
        } finally {
          if (!accountRetained) held.release();
        }
        const account = held.account;
        if (
          account.installationId !== unit.subject.installationId ||
          account.state !== "active" ||
          account.currentUserId !== account.accountId ||
          account.subject !== account.accountId ||
          account.issuer !== `occ:installation:${unit.subject.installationId}:better-auth` ||
          !held.principalId
        )
          throw unavailable();
        const checkAccount = async () => {
          await check();
          const value: unknown = held.assertCurrent();
          if (value !== undefined) {
            await Promise.resolve(value).catch(() => {});
            throw unavailable();
          }
          await check();
        };
        await checkAccount();
        await policy.lockPolicy();
        await checkAccount();
        const principal = await policy.iam.lookupIdentity({
          issuer: account.issuer,
          subject: account.subject,
        });
        await checkAccount();
        if (
          !principal ||
          principal.kind !== "principal" ||
          principal.namespaceId !== undefined ||
          principal.id !== held.principalId ||
          principal.issuer !== account.issuer ||
          principal.subject !== account.subject
        )
          throw unavailable();
        const decision = await policy.iam.authorize({
          principalId: principal.id,
          action: "administer",
          resource: { kind: "installation", id: unit.subject.installationId },
        });
        await checkAccount();
        if (
          decision.allowed !== true ||
          decision.driverId !== selected.registration?.id ||
          decision.evidence.identityId !== principal.id ||
          ![
            decision.evidence.groupIds,
            decision.evidence.bindingIds,
            decision.evidence.roleIds,
            decision.evidence.restrictionIds,
          ].every(
            (values) =>
              Array.isArray(values) &&
              values.every((value) => typeof value === "string" && value.length > 0),
          )
        )
          throw unavailable();
        const registration = await acquireRegistration(original, command, bounds, unit, io);
        let registrationRetained = false;
        try {
          unit.phase.retainCleanup(registration.release.bind(registration));
          registrationRetained = true;
          unit.phase.retainCurrentness(registration.assertCurrent.bind(registration));
        } finally {
          if (!registrationRetained) await registration.release();
        }
        await checkAccount();
        const checked: unknown = registration.assertCurrent();
        if (checked !== undefined) {
          await Promise.resolve(checked).catch(() => {});
          throw unavailable();
        }
        await checkAccount();
        return Object.freeze({
          attribution: Object.freeze({
            actorId: principal.id,
            requestRef: bounds.requestRef,
            decisionRef: `gateway_service_iam_${randomUUID()}`,
          }),
          assertCurrent: current,
          release,
        });
      } catch (error) {
        io.poison(error);
        throw error;
      }
    },
  });
}
