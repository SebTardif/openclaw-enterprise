import {
  decodeCredentialWorkloadSelectionV1,
  type CredentialWorkloadSelectionV1,
} from "@openclaw-enterprise/contracts/credential-workload-selection-v1";
import {
  canonicalGatewayStartupValueV1,
  parseGatewayStartupSubjectV2,
  type GatewayStartupAcceptedOperationV1,
  type GatewayStartupOwnerParticipantsV2,
  type GatewayStartupOwnerUnitV2,
} from "../gateway-startup-v1/owner.ts";
import type {
  WorkloadProfileSelectionLeaseV2,
  WorkloadProfileSelectionRequestV2,
} from "./selection.ts";

export type GatewayCredentialSelectionBaseV2 = Awaited<
  ReturnType<GatewayStartupOwnerParticipantsV2["selection"]["resolveLocked"]>
>;

/** Private input to the original selected resolver. The original state owner
 * verifies its existing unit/selection-operation association and tracked query.
 * The original selected-storage enrollment must bind the held lease/request;
 * structural held values or assertCurrent methods never create that enrollment.
 * TODO: install that genuine storage/resolver join before selected credential use.
 */
export interface ProtectedRevisionCredentialReaderV1 {
  readLocked(
    request: WorkloadProfileSelectionRequestV2,
    held: WorkloadProfileSelectionLeaseV2,
    unit: GatewayStartupOwnerUnitV2,
    io: GatewayStartupAcceptedOperationV1,
  ): Promise<unknown>;
}

/** One acquired original composition. Its release owns BOTH the complete
 * Gateway selection and underlying workload lease, exactly once. The original
 * CRD V2 inspector is bound to independently protected expectations by this
 * owner; it must inspect the supplied guarded view so its currentness calls
 * use the enclosing Runtime drain. It throws unless that inspector corresponds.
 */
export type GatewayCredentialSelectionInputV2 = GatewayCredentialSelectionBaseV2 &
  Readonly<{
    workload: WorkloadProfileSelectionLeaseV2;
    assertCredentialCorrespondence(
      record: CredentialWorkloadSelectionV1,
      guarded: GatewayCredentialSelectionBaseV2,
    ): undefined;
  }>;
export interface GatewayCredentialSelectionSourceV2 {
  resolveLocked(
    ...args: Parameters<GatewayStartupOwnerParticipantsV2["selection"]["resolveLocked"]>
  ): Promise<GatewayCredentialSelectionInputV2>;
}
export type RuntimeCredentialSelectionLeaseV2 = GatewayCredentialSelectionBaseV2 &
  Readonly<{
    /** Private correspondence only. Never serialize inside selected or a public result. */
    credentialWorkloadSelection: CredentialWorkloadSelectionV1;
  }>;
export interface RuntimeCredentialSelectionResolverV2 {
  /** The private central owner appends its operation-bound reader to the four
   * existing arguments. The public Gateway participant remains unchanged. */
  resolveLocked(
    ...args: [
      ...Parameters<GatewayStartupOwnerParticipantsV2["selection"]["resolveLocked"]>,
      reader: ProtectedRevisionCredentialReaderV1,
    ]
  ): Promise<RuntimeCredentialSelectionLeaseV2>;
}

export class CredentialWorkloadRecordError extends Error {
  constructor() {
    super("The protected revision credential selection is unavailable.");
    this.name = "CredentialWorkloadRecordError";
  }
}
function unavailable(): never {
  throw new CredentialWorkloadRecordError();
}

// The original selector preserves null-prototype canonical records. Compare
// their closed data, retaining the canonical serializer's descriptor checks.
function sameData(left: unknown, right: unknown): boolean {
  return canonicalGatewayStartupValueV1(left) === canonicalGatewayStartupValueV1(right);
}

/** Pure, detached full-record correspondence. This grants no current authority,
 * acquires no lease and is never a substitute for the enclosing owner's fences.
 */
export function projectCredentialWorkloadSelectionV1(
  held: WorkloadProfileSelectionLeaseV2,
  stored: unknown,
): CredentialWorkloadSelectionV1 {
  const decoded = decodeCredentialWorkloadSelectionV1(stored);
  if (decoded.kind !== "valid") return unavailable();
  const { request, use } = held;
  const selection = {
    manifestRef: use.manifestRef,
    manifestDigest: use.manifestDigest,
    admissionRef: use.admissionRef,
    admissionVersion: use.admissionVersion,
  };
  const record = decoded.value;
  if (
    request.schemaVersion !== 2 ||
    use.schemaVersion !== 2 ||
    use.component !== "gateway-harness-pair" ||
    use.installationId !== request.installationId ||
    use.namespaceId !== request.namespaceId ||
    !sameData(request.selection, selection) ||
    !sameData(record.scope, {
      installationId: request.installationId,
      namespaceId: request.namespaceId,
      agentId: request.agentId,
    }) ||
    record.revisionId !== request.revisionId ||
    !sameData(record.association.selection, selection) ||
    !sameData(record.association.profileRefs, use.profileRefs) ||
    record.association.admittedConfigurationDigest !== use.admittedConfigurationDigest
  )
    return unavailable();
  return record;
}

/** One original selection operation, using its privately supplied reader.
 * TODO: compose the genuine selected source/storage and original CRD inspector
 * in the central accepting owner. No default producer is installed by this leaf.
 */
export function createCredentialWorkloadSelectionResolverV2(
  source?: GatewayCredentialSelectionSourceV2,
): RuntimeCredentialSelectionResolverV2 {
  const acquire = source?.resolveLocked?.bind(source);
  return Object.freeze({
    async resolveLocked(
      ...args: Parameters<RuntimeCredentialSelectionResolverV2["resolveLocked"]>
    ): Promise<RuntimeCredentialSelectionLeaseV2> {
      const [command, original, unit, io, reader] = args;
      const pending = new Set<Promise<unknown>>();
      const checks: (() => unknown)[] = [];
      let close: (() => Promise<void>) | undefined;
      let releasePromise: Promise<void> | undefined;
      let closed = false;
      let failed = false;
      let failure: unknown;
      const poison = (error: unknown): void => {
        if (!failed) {
          failed = true;
          failure = error;
        }
        io.poison(error);
      };
      const synchronous = (work: () => unknown): void => {
        const value = work();
        if (value !== undefined) {
          const work = Promise.resolve(value);
          pending.add(work);
          void work.then(
            () => pending.delete(work),
            () => pending.delete(work),
          );
          unavailable();
        }
      };
      const release = (): Promise<void> => {
        if (releasePromise) return releasePromise;
        closed = true;
        // Publish the terminal promise before any original cleanup can reenter.
        releasePromise = Promise.resolve().then(async () => {
          while (pending.size) await Promise.allSettled([...pending]);
          // The one original acquired composition owns every underlying lease.
          // Await its actual outcome, including rejection with undefined.
          await close?.();
        });
        return releasePromise;
      };
      const assertCurrent = (): undefined => {
        if (failed) throw failure;
        if (closed) return unavailable();
        try {
          const subject = parseGatewayStartupSubjectV2(unit.subject);
          if (!sameData(subject, command.subject)) unavailable();
          for (const check of checks) synchronous(check);
        } catch (error) {
          poison(error);
          throw error;
        }
        return undefined;
      };
      const assertAcquiring = (): void => {
        synchronous(() => io.assertActive());
        assertCurrent();
      };
      try {
        assertAcquiring();
        const read = reader?.readLocked?.bind(reader);
        if (!acquire || !read) unavailable();
        const acquired = await acquire(command, original, unit, io);
        // Capture known cleanup before every other acquired property or await.
        const cleanup = acquired.release;
        if (typeof cleanup !== "function") unavailable();
        close = cleanup.bind(acquired);
        const current = acquired.assertCurrent;
        if (typeof current !== "function") unavailable();
        checks.push(current.bind(acquired));
        assertAcquiring();

        const held = acquired.workload;
        const heldCurrent = held.assertCurrent;
        if (typeof heldCurrent !== "function") unavailable();
        checks.push(heldCurrent.bind(held));
        const compare = acquired.assertCredentialCorrespondence;
        if (typeof compare !== "function") unavailable();
        const assertCorrespondence = compare.bind(acquired);
        const request = held.request;
        const selected = acquired.selected;
        const requestBytes = canonicalGatewayStartupValueV1(request);
        const useBytes = canonicalGatewayStartupValueV1(held.use);
        const selectedBytes = canonicalGatewayStartupValueV1(selected);
        checks.push(() => {
          if (
            canonicalGatewayStartupValueV1(held.request) !== requestBytes ||
            canonicalGatewayStartupValueV1(held.use) !== useBytes ||
            canonicalGatewayStartupValueV1(acquired.selected) !== selectedBytes ||
            request.installationId !== unit.subject.installationId ||
            request.namespaceId !== unit.subject.namespaceRef ||
            request.agentId !== unit.subject.agentRef
          )
            unavailable();
          return undefined;
        });
        assertAcquiring();

        const stored = await read(request, held, unit, io);
        assertAcquiring();
        const record = projectCredentialWorkloadSelectionV1(held, stored);
        if (
          selected.schemaVersion !== 2 ||
          selected.namespaceRef !== request.namespaceId ||
          selected.agentRef !== request.agentId ||
          selected.admittedRevisionRef !== request.revisionId ||
          selected.configurationRef !== request.configurationRef ||
          selected.configurationVersion !== request.configurationVersion ||
          !sameData(selected.selection, record.association.selection) ||
          !sameData(selected.profileRefs, record.association.profileRefs) ||
          selected.admittedConfigurationDigest !== record.association.admittedConfigurationDigest
        )
          unavailable();
        const result = Object.freeze({
          selected,
          credentialWorkloadSelection: record,
          assertCurrent,
          release,
        });
        synchronous(() => assertCorrespondence(record, result));
        assertAcquiring();
        return result;
      } catch (error) {
        poison(error);
        try {
          await release();
        } catch (cleanupError) {
          poison(cleanupError);
        }
        throw error;
      }
    },
  });
}
