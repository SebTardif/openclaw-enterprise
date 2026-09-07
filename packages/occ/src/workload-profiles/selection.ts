import {
  decodeWorkloadProfileSelectionV1,
  decodeWorkloadProfileUseV1,
  type WorkloadProfileSelectionV1,
  type WorkloadProfileRolesV1,
} from "@openclaw-enterprise/contracts/workload-profile-v1";
import { validateRuntimeResourceAccountingV1 } from "@openclaw-enterprise/contracts/runtime-resource-accounting-v1";
import type {
  GatewayStartupOwnerUnitV1,
  GatewayStartupAcceptedOperationV1,
  GatewayStartupOwnerLeaseV1,
} from "../gateway-startup-v1/owner.ts";
import { canonicalizeWorkloadProfileJson, decodeWorkloadProfileJson } from "./canonical.ts";
import {
  deriveWorkloadProfileManifestV2,
  type DerivedWorkloadProfileManifestV2,
} from "./projections.ts";

/** Same selection identity as V1; only the applicability is explicitly versioned. */
export interface WorkloadProfileUseV2 extends WorkloadProfileSelectionV1 {
  readonly schemaVersion: 2;
  readonly component: "gateway-harness-pair";
  readonly installationId: string;
  readonly namespaceId: string;
  readonly canonicalFormat: "oce.workload-profile.canonical-json.v1";
  readonly profileRefs: WorkloadProfileRolesV1;
  readonly admittedConfigurationDigest: string;
}
export interface WorkloadProfileSelectionRequestV2 {
  readonly schemaVersion: 2;
  readonly installationId: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revisionId: string;
  readonly configurationRef: string;
  readonly configurationVersion: number;
  readonly selection: WorkloadProfileSelectionV1;
}
export interface WorkloadProfileAdmissionRecordV2 {
  readonly schemaVersion: 2;
  readonly state: "admitted";
  readonly use: WorkloadProfileUseV2;
  readonly canonicalManifest: string;
  readonly revision: Readonly<{
    id: string;
    agentId: string;
    namespaceId: string;
    workloadProfileUse: WorkloadProfileUseV2;
    configurationRef: string;
    configurationVersion: number;
  }>;
  readonly configuration: Readonly<{
    ref: string;
    version: number;
    admittedConfigurationDigest: string;
  }>;
}
export interface WorkloadProfileSelectionLeaseV2 extends GatewayStartupOwnerLeaseV1 {
  readonly request: WorkloadProfileSelectionRequestV2;
  readonly use: WorkloadProfileUseV2;
  readonly manifest: DerivedWorkloadProfileManifestV2["content"];
  readonly digests: DerivedWorkloadProfileManifestV2["digests"];
}

/** Installed only by the original transaction owner. enroll must verify the
 * exact unit/io and already acquired authority/Installation/channel prefix.
 * These methods borrow its tracked client; they neither commit nor open a unit.
 * readAdmission reads actual immutable admission/revision/configuration rows
 * with withdrawal-conflicting locks, NEVER an inert prepareOperation record. */
export interface WorkloadProfileSelectionStorageV2 {
  enroll(
    request: WorkloadProfileSelectionRequestV2,
    unit: GatewayStartupOwnerUnitV1,
    io: GatewayStartupAcceptedOperationV1,
  ): Promise<
    GatewayStartupOwnerLeaseV1 & {
      lockNamespace(): Promise<Readonly<{ namespaceId: string }>>;
      lockAgent(): Promise<Readonly<{ namespaceId: string; agentId: string }>>;
      readAdmission(): Promise<unknown>;
    }
  >;
}
/** An actual original source/placement/runtime/module/credential participant,
 * not a caller capability list. Unsupported implementations reject permanently;
 * current dependency loss rejects as unavailable. Its lease stays held through
 * the original transaction's terminal cleanup and last synchronous fence.
 * It resolves runtime.implementation to the complete fixed Pod renderer and
 * runtime configuration, verifies every init/helper/readiness/security/mount
 * and accounting mapping, and resolves environment/module definitions including
 * their required capabilities. Parsing a record digest is insufficient.
 * It also verifies the exact original normalized admitted Configuration and
 * resolved binding projection against admittedUse.admittedConfigurationDigest.
 * That projection uses the original admitted-configuration domain/canonical
 * format. Copied digest equality or arbitrary Configuration JSON cannot qualify
 * it. Missing native/reference/store-policy codecs remain unavailable; null,
 * fractional/negative numbers and coercion cannot widen the canonical format.
 * This SQL-unit lease is never later provider-call authority: the original
 * admitted operation retains the association and Compute reacquires its exact
 * current call/target/create-effect lifetime before one claimed submission. */
export interface WorkloadProfileCapabilitySourceV2 {
  acquire(
    request: WorkloadProfileSelectionRequestV2,
    manifest: DerivedWorkloadProfileManifestV2["content"],
    admittedUse: WorkloadProfileUseV2,
    unit: GatewayStartupOwnerUnitV1,
    io: GatewayStartupAcceptedOperationV1,
  ): Promise<GatewayStartupOwnerLeaseV1>;
}
export class WorkloadProfileSelectionError extends Error {
  readonly code:
    | "unavailable"
    | "invalid-record"
    | "selection-mismatch"
    | "unsupported-capability"
    | "incomplete-accounting";
  constructor(
    code:
      | "unavailable"
      | "invalid-record"
      | "selection-mismatch"
      | "unsupported-capability"
      | "incomplete-accounting",
  ) {
    super(`Workload profile selection refused: ${code}`);
    this.code = code;
  }
}
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const fail = (code: WorkloadProfileSelectionError["code"]): never => {
  throw new WorkloadProfileSelectionError(code);
};
function snapshot(value: unknown): Record<string, unknown> {
  return decodeWorkloadProfileJson(
    canonicalizeWorkloadProfileJson(value, "operator-envelope"),
    "operator-envelope",
  ).value as Record<string, unknown>;
}
function shape(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    fail("invalid-record");
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,254}$/.test(value))
    fail("invalid-record");
}
function version(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    fail("invalid-record");
}
function selection(value: unknown): WorkloadProfileSelectionV1 {
  const result = decodeWorkloadProfileSelectionV1(value);
  if (result.kind !== "valid") return fail("invalid-record");
  return result.value;
}
function equal(left: unknown, right: unknown): boolean {
  return (
    decoder.decode(canonicalizeWorkloadProfileJson(left)) ===
    decoder.decode(canonicalizeWorkloadProfileJson(right))
  );
}
function use(value: unknown): WorkloadProfileUseV2 {
  shape(value, [
    "schemaVersion",
    "component",
    "installationId",
    "namespaceId",
    "canonicalFormat",
    "manifestRef",
    "manifestDigest",
    "admissionRef",
    "admissionVersion",
    "profileRefs",
    "admittedConfigurationDigest",
  ]);
  if (value.schemaVersion !== 2 || value.component !== "gateway-harness-pair")
    fail("invalid-record");
  // Reuse the original field validators. This temporary validation projection
  // is never returned or persisted as a Harness use or a runtime capability.
  const original = decodeWorkloadProfileUseV1({ ...value, schemaVersion: 1, component: "harness" });
  if (original.kind !== "valid") fail("invalid-record");
  return value as unknown as WorkloadProfileUseV2;
}
function request(input: unknown): WorkloadProfileSelectionRequestV2 {
  const value = snapshot(input);
  shape(value, [
    "schemaVersion",
    "installationId",
    "namespaceId",
    "agentId",
    "revisionId",
    "configurationRef",
    "configurationVersion",
    "selection",
  ]);
  if (value.schemaVersion !== 2) fail("invalid-record");
  for (const name of ["installationId", "namespaceId", "agentId", "revisionId", "configurationRef"])
    identifier(value[name]);
  version(value.configurationVersion);
  selection(value.selection);
  return value as unknown as WorkloadProfileSelectionRequestV2;
}
function correlated(input: unknown, expected: WorkloadProfileSelectionRequestV2) {
  const record = snapshot(input);
  shape(record, [
    "schemaVersion",
    "state",
    "use",
    "canonicalManifest",
    "revision",
    "configuration",
  ]);
  if (
    record.schemaVersion !== 2 ||
    record.state !== "admitted" ||
    typeof record.canonicalManifest !== "string"
  )
    fail("invalid-record");
  const admitted = use(record.use);
  const retainedSelection = {
    manifestRef: admitted.manifestRef,
    manifestDigest: admitted.manifestDigest,
    admissionRef: admitted.admissionRef,
    admissionVersion: admitted.admissionVersion,
  };
  const revision = record.revision;
  const configuration = record.configuration;
  shape(revision, [
    "id",
    "agentId",
    "namespaceId",
    "workloadProfileUse",
    "configurationRef",
    "configurationVersion",
  ]);
  shape(configuration, ["ref", "version", "admittedConfigurationDigest"]);
  use(revision.workloadProfileUse);
  if (
    !equal(retainedSelection, expected.selection) ||
    admitted.installationId !== expected.installationId ||
    admitted.namespaceId !== expected.namespaceId ||
    revision.id !== expected.revisionId ||
    revision.agentId !== expected.agentId ||
    revision.namespaceId !== expected.namespaceId ||
    !equal(admitted, revision.workloadProfileUse) ||
    revision.configurationRef !== expected.configurationRef ||
    revision.configurationVersion !== expected.configurationVersion ||
    configuration.ref !== expected.configurationRef ||
    configuration.version !== expected.configurationVersion ||
    configuration.admittedConfigurationDigest !== admitted.admittedConfigurationDigest
  )
    fail("selection-mismatch");
  const canonicalManifest = record.canonicalManifest;
  if (typeof canonicalManifest !== "string") return fail("invalid-record");
  const derived = deriveWorkloadProfileManifestV2(encoder.encode(canonicalManifest));
  if (
    decoder.decode(derived.canonicalBytes) !== record.canonicalManifest ||
    derived.digests.manifestDigest !== admitted.manifestDigest
  )
    fail("selection-mismatch");
  for (const role of ["provider", "runtime", "identity", "containment", "storage"] as const)
    if (admitted.profileRefs[role].contentDigest !== derived.roleDigests[role])
      fail("selection-mismatch");
  if (
    validateRuntimeResourceAccountingV1(
      derived.content.launchConfiguration.resourceEnvelope.podAndRuntimeAccounting.envelope,
    ).status !== "accounted"
  )
    fail("incomplete-accounting");
  return { admitted, derived };
}
/** Actual selection orchestration. The default has no installed admission or
 * capability producer and refuses before enrolling or issuing any query.
 * The returned lease must be registered by the same owner before another await;
 * its release never releases a SQL lock or commits a transaction. This reads
 * retained revision associations. A first deploy writer may expose its own
 * provisional association in the same unit only after writing it; the original
 * owner's COMMIT still determines whether it exists outside that transaction.
 * configurationVersion denotes original Configuration.generation. A platform
 * deploy unit needs a genuine owner adapter, never a Gateway unit cast. */
export function createAdmittedWorkloadProfileSelectorV2(
  storage?: WorkloadProfileSelectionStorageV2,
  capabilities?: WorkloadProfileCapabilitySourceV2,
) {
  const enroll = storage?.enroll?.bind(storage);
  const acquire = capabilities?.acquire?.bind(capabilities);
  return Object.freeze({
    async resolveLocked(
      input: unknown,
      unit: GatewayStartupOwnerUnitV1,
      io: GatewayStartupAcceptedOperationV1,
    ): Promise<WorkloadProfileSelectionLeaseV2> {
      if (!enroll || !acquire) return fail("unavailable");
      const expected = request(input);
      const checks: (() => undefined)[] = [];
      const releases: (() => Promise<void>)[] = [];
      const pendingFences = new Set<Promise<unknown>>();
      let closed = false;
      let fenceFailed = false;
      let fenceFailure: unknown;
      let releasePromise: Promise<void> | undefined;
      const synchronous = (work: () => unknown): void => {
        const value = work();
        if (value !== undefined) {
          // A mistaken async assertion still owns work. Deny it now, but keep
          // the acquired leases until this exact invocation has settled.
          const pending = Promise.resolve(value);
          pendingFences.add(pending);
          void pending.then(
            () => pendingFences.delete(pending),
            () => pendingFences.delete(pending),
          );
          fail("unavailable");
        }
      };
      const release = (): Promise<void> => {
        if (releasePromise) return releasePromise;
        closed = true;
        releasePromise = (async () => {
          while (pendingFences.size) await Promise.allSettled([...pendingFences]);
          let failed = false;
          let failure: unknown;
          for (const close of releases.reverse()) {
            try {
              await close();
            } catch (error) {
              if (!failed) {
                failed = true;
                failure = error;
              }
            }
          }
          if (failed) throw failure;
        })();
        return releasePromise;
      };
      const assertCurrent = (): undefined => {
        if (closed || unit.installationId !== expected.installationId) fail("unavailable");
        if (fenceFailed) throw fenceFailure;
        try {
          for (const check of checks) synchronous(check);
        } catch (error) {
          fenceFailed = true;
          fenceFailure = error;
          throw error;
        }
        return undefined;
      };
      const assertAcquiring = (): void => {
        // Original operation IO ends when the selection read settles. Only the
        // enrolled original owner leases survive for later operations/COMMIT.
        synchronous(() => io.assertActive());
        assertCurrent();
      };
      const retain = <T extends GatewayStartupOwnerLeaseV1>(lease: T): T => {
        // Register the acquired cleanup before reading any other handle property.
        const close = lease.release;
        if (typeof close !== "function") fail("unavailable");
        releases.push(close.bind(lease));
        const check = lease.assertCurrent;
        if (typeof check !== "function") fail("unavailable");
        checks.push(check.bind(lease));
        assertAcquiring();
        return lease;
      };
      try {
        assertAcquiring();
        const held = retain(await enroll(expected, unit, io));
        const lockNamespace = held.lockNamespace.bind(held);
        const lockAgent = held.lockAgent.bind(held);
        const readAdmission = held.readAdmission.bind(held);
        const namespace = snapshot(await lockNamespace());
        assertAcquiring();
        shape(namespace, ["namespaceId"]);
        if (namespace.namespaceId !== expected.namespaceId) fail("selection-mismatch");
        const agent = snapshot(await lockAgent());
        assertAcquiring();
        // Draft selection edits do not withdraw the immutable revision's use.
        shape(agent, ["namespaceId", "agentId"]);
        if (agent.namespaceId !== expected.namespaceId || agent.agentId !== expected.agentId)
          fail("selection-mismatch");
        const original = await readAdmission();
        assertAcquiring();
        const { admitted, derived } = correlated(original, expected);
        retain(await acquire(expected, derived.content, admitted, unit, io));
        assertAcquiring();
        return Object.freeze({
          request: expected,
          use: admitted,
          manifest: derived.content,
          digests: derived.digests,
          assertCurrent,
          release,
        });
      } catch (error) {
        io.poison(error);
        try {
          await release();
        } catch (cleanupError) {
          io.poison(cleanupError);
        }
        throw error;
      }
    },
  });
}
