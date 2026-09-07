import { DependencyUnavailableError, ScopeViolationError } from "../errors.ts";
import {
  ProfileOperationCapacityError,
  ProfileOperationConflictError,
  type WorkloadProfileTransactionGuard,
} from "./repository.ts";
import { types } from "node:util";
import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  WORKLOAD_PROFILE_LIMITS_V1,
  decodeProfileInvalidationRequestV2,
  decodeWorkloadProfileScopeV2,
  decodeWorkloadProfileSelectionV1,
  type ProfileInvalidationRequestV2,
  type WorkloadProfileRolesV1,
  type WorkloadProfileScopeV2,
  type WorkloadProfileSelectionV1,
} from "@openclaw-enterprise/contracts/workload-profile-v1";
import {
  InvalidProfileOperationError,
  decodeStoredProfilePreparationV2,
  normalizeProfilePreparationV2,
  profileActor,
  profileAllocatedIdentities,
  profileInstallation,
  profileLocator,
  profileTimestamp,
  profileUuid,
  type ProfileCapacity,
  type ProfileOperationActor,
  type ProfileOperationLocator,
  type StoredProfilePreparationV2,
} from "./types.ts";
import { canonicalizeWorkloadProfileJson, decodeWorkloadProfileJson } from "./canonical.ts";
import { deriveWorkloadProfileManifestV2 } from "./projections.ts";
import type { WorkloadProfileDefinitionRequestV2 } from "./admitted-use.ts";

export interface WorkloadProfileAdmissionAttributionV2 {
  readonly actor: ProfileOperationActor;
  readonly operationRef: string;
  readonly requestRef: string;
  readonly decisionRef: string;
}
export interface WorkloadProfileTerminalTemplateV2 {
  readonly templateRef: string;
  readonly historyRef: string;
  readonly auditRef: string;
  readonly invalidationRef: string;
}
interface WorkloadProfileAdmissionBaseV2 {
  readonly schemaVersion: 2;
  readonly scope: WorkloadProfileScopeV2;
  readonly selection: WorkloadProfileSelectionV1;
  readonly canonicalFormat: "oce.workload-profile.canonical-json.v1";
  readonly canonicalManifest: string;
  readonly profileRefs: WorkloadProfileRolesV1;
  readonly acceptance: WorkloadProfileAdmissionAttributionV2 & {
    readonly historyRef: string;
    readonly auditRef: string;
    readonly acceptedAt: string;
  };
  readonly terminal: WorkloadProfileTerminalTemplateV2;
}
export interface WorkloadProfileAdmittedHeadV2 extends WorkloadProfileAdmissionBaseV2 {
  readonly state: "admitted";
}
export interface WorkloadProfileWithdrawnHeadV2 extends WorkloadProfileAdmissionBaseV2 {
  readonly state: "withdrawn";
  readonly withdrawal: WorkloadProfileAdmissionAttributionV2 & {
    readonly previousVersion: number;
    readonly reason: "withdrawn" | "replaced";
    readonly acceptedAt: string;
  };
}
export type WorkloadProfileAdmissionHeadV2 =
  WorkloadProfileAdmittedHeadV2 | WorkloadProfileWithdrawnHeadV2;

/** A history entry retains the complete immutable head at its exact version. */
export interface WorkloadProfileAdmissionHistoryV2 {
  readonly schemaVersion: 2;
  readonly historyRef: string;
  readonly head: WorkloadProfileAdmissionHeadV2;
}
export type WorkloadProfileInvalidationV2 = ProfileInvalidationRequestV2;
export type WorkloadProfileAcceptanceOperationV2 = StoredProfilePreparationV2;

/** Owner-bound completion only: the original phase acquires the complete real
 * definition source and retains its lease through final fences and cleanup. */
export type WorkloadProfileDefinitionQualifierV2 = (
  request: WorkloadProfileDefinitionRequestV2,
) => Promise<undefined>;
export interface WorkloadProfileAcceptanceResultV2 {
  readonly history: WorkloadProfileAdmissionHistoryV2;
  readonly action: "admit" | "replace";
}
export interface WorkloadProfileAdmissionRepositoryV2 {
  accept(
    locator: ProfileOperationLocator,
    attribution: WorkloadProfileAdmissionAttributionV2,
    qualifyDefinition?: WorkloadProfileDefinitionQualifierV2,
  ): Promise<WorkloadProfileAcceptanceResultV2>;
  withdraw(
    namespaceId: string,
    expected: WorkloadProfileSelectionV1,
    attribution: WorkloadProfileAdmissionAttributionV2,
  ): Promise<WorkloadProfileAdmissionHistoryV2>;
  readProfile(
    namespaceId: string,
    admissionRef: string,
  ): Promise<WorkloadProfileAdmissionHeadV2 | undefined>;
}

/** Original transaction-owned storage only. Implementations mirror the exact
 * closed codecs and constraints. No method opens/commits a transaction, evaluates
 * IAM, issues capability, or treats inert preparation as an admitted head. */
export interface WorkloadProfileAdmissionBackendV2 {
  installationId(): string;
  lockCapacity(): Promise<void>;
  capacity(): Promise<ProfileCapacity>;
  lockOperation(locator: ProfileOperationLocator): Promise<void>;
  namespaceExists(namespaceId: string): Promise<boolean>;
  operation(locator: ProfileOperationLocator): Promise<unknown | undefined>;
  lockHeads(
    namespaceId: string,
    admissionRefs: readonly string[],
    mode: "share" | "update",
  ): Promise<void>;
  head(namespaceId: string, admissionRef: string): Promise<unknown | undefined>;
  /** Immutable PRIMARY command history: admitted history for admit/replace,
   * terminal history for standalone withdrawal. Never return today's head or
   * replacement's secondary old-admission withdrawal as the primary result. */
  acceptedOperation(locator: ProfileOperationLocator): Promise<unknown | undefined>;
  insertAdmission(
    head: WorkloadProfileAdmittedHeadV2,
    history: WorkloadProfileAdmissionHistoryV2,
  ): Promise<void>;
  withdrawAdmission(
    expected: WorkloadProfileAdmittedHeadV2,
    head: WorkloadProfileWithdrawnHeadV2,
    history: WorkloadProfileAdmissionHistoryV2,
    invalidation: WorkloadProfileInvalidationV2,
  ): Promise<void>;
  updateCapacity(expected: ProfileCapacity, next: ProfileCapacity): Promise<void>;
  appendAudit(
    attribution: WorkloadProfileAdmissionAttributionV2,
    history: WorkloadProfileAdmissionHistoryV2,
  ): Promise<void>;
}

const roles = ["provider", "runtime", "identity", "containment", "storage"] as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
function invalid(): never {
  throw new InvalidProfileOperationError();
}
function fields(
  input: unknown,
  names: readonly string[],
): asserts input is Record<string, unknown> {
  if (!input || typeof input !== "object" || types.isProxy(input) || Array.isArray(input))
    invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== names.length ||
    keys.some((key) => typeof key !== "string" || !names.includes(key))
  )
    invalid();
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(input)))
    if (!descriptor.enumerable || !("value" in descriptor)) invalid();
}
function opaque(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    encoder.encode(value).byteLength > 1024 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    invalid();
  // Original canonical scalar validation, without inventing a UUID grammar for
  // request/decision IDs owned by the account participant.
  canonicalizeWorkloadProfileJson(value, "operator-envelope");
}
function scope(input: unknown): WorkloadProfileScopeV2 {
  const decoded = decodeWorkloadProfileScopeV2(input);
  if (decoded.kind !== "valid") invalid();
  return decoded.value;
}
export function decodeWorkloadProfileAdmissionAttributionV2(
  input: unknown,
): WorkloadProfileAdmissionAttributionV2 {
  fields(input, ["actor", "operationRef", "requestRef", "decisionRef"]);
  profileUuid(input.operationRef);
  opaque(input.requestRef);
  opaque(input.decisionRef);
  return immutableCopy({
    actor: profileActor(input.actor),
    operationRef: input.operationRef,
    requestRef: input.requestRef,
    decisionRef: input.decisionRef,
  });
}
function attribution(input: Record<string, unknown>): WorkloadProfileAdmissionAttributionV2 {
  return decodeWorkloadProfileAdmissionAttributionV2({
    actor: input.actor,
    operationRef: input.operationRef,
    requestRef: input.requestRef,
    decisionRef: input.decisionRef,
  });
}
function retainedIds(head: WorkloadProfileAdmissionHeadV2) {
  return profileAllocatedIdentities({
    manifestRef: head.selection.manifestRef,
    admissionRef: head.selection.admissionRef,
    providerRef: head.profileRefs.provider.ref,
    runtimeRef: head.profileRefs.runtime.ref,
    identityRef: head.profileRefs.identity.ref,
    containmentRef: head.profileRefs.containment.ref,
    storageRef: head.profileRefs.storage.ref,
    historyRef: head.acceptance.historyRef,
    auditRef: head.acceptance.auditRef,
    terminalTemplateRef: head.terminal.templateRef,
    terminalHistoryRef: head.terminal.historyRef,
    terminalAuditRef: head.terminal.auditRef,
    terminalInvalidationRef: head.terminal.invalidationRef,
  });
}

/** Closed retained data only. Re-derive original canonical domains; no current
 * authority, revision Use/H, physical target or capability is manufactured. */
export function decodeWorkloadProfileAdmissionHeadV2(
  input: unknown,
): WorkloadProfileAdmissionHeadV2 {
  if (!input || typeof input !== "object" || types.isProxy(input)) invalid();
  const stateDescriptor = Object.getOwnPropertyDescriptor(input, "state");
  if (!stateDescriptor || !("value" in stateDescriptor)) invalid();
  const state: unknown = stateDescriptor.value;
  if (state !== "admitted" && state !== "withdrawn") invalid();
  fields(input, [
    "schemaVersion",
    "scope",
    "selection",
    "canonicalFormat",
    "canonicalManifest",
    "profileRefs",
    "acceptance",
    "terminal",
    "state",
    ...(state === "withdrawn" ? ["withdrawal"] : []),
  ]);
  if (
    input.schemaVersion !== 2 ||
    input.canonicalFormat !== "oce.workload-profile.canonical-json.v1" ||
    typeof input.canonicalManifest !== "string"
  )
    invalid();
  const selectedScope = scope(input.scope);
  const selection = decodeWorkloadProfileSelectionV1(input.selection);
  if (selection.kind !== "valid") invalid();
  const derived = deriveWorkloadProfileManifestV2(encoder.encode(input.canonicalManifest));
  if (
    decoder.decode(derived.canonicalBytes) !== input.canonicalManifest ||
    derived.digests.manifestDigest !== selection.value.manifestDigest
  )
    invalid();
  fields(input.profileRefs, roles);
  const profileRefs = {} as Record<(typeof roles)[number], WorkloadProfileRolesV1["provider"]>;
  for (const role of roles) {
    const item = input.profileRefs[role];
    fields(item, ["ref", "version", "contentDigest"]);
    profileUuid(item.ref);
    // These roles are allocated with a new immutable admission; no role update
    // transition or independent role-version sequence exists in this domain.
    if (item.version !== 1 || item.contentDigest !== derived.roleDigests[role]) invalid();
    profileRefs[role] = { ref: item.ref, version: 1, contentDigest: derived.roleDigests[role] };
  }
  fields(input.acceptance, [
    "actor",
    "operationRef",
    "requestRef",
    "decisionRef",
    "historyRef",
    "auditRef",
    "acceptedAt",
  ]);
  const accepted = attribution(input.acceptance);
  profileUuid(input.acceptance.historyRef);
  profileUuid(input.acceptance.auditRef);
  profileTimestamp(input.acceptance.acceptedAt);
  fields(input.terminal, ["templateRef", "historyRef", "auditRef", "invalidationRef"]);
  for (const ref of Object.values(input.terminal)) profileUuid(ref);
  const base = {
    schemaVersion: 2 as const,
    scope: selectedScope,
    selection: selection.value,
    canonicalFormat: "oce.workload-profile.canonical-json.v1" as const,
    canonicalManifest: input.canonicalManifest,
    profileRefs,
    acceptance: {
      ...accepted,
      historyRef: input.acceptance.historyRef,
      auditRef: input.acceptance.auditRef,
      acceptedAt: input.acceptance.acceptedAt,
    },
    terminal: {
      templateRef: input.terminal.templateRef as string,
      historyRef: input.terminal.historyRef as string,
      auditRef: input.terminal.auditRef as string,
      invalidationRef: input.terminal.invalidationRef as string,
    },
  };
  let head: WorkloadProfileAdmissionHeadV2;
  if (state === "admitted") {
    if (selection.value.admissionVersion !== 1) invalid();
    head = { ...base, state };
  } else {
    fields(input.withdrawal, [
      "actor",
      "operationRef",
      "requestRef",
      "decisionRef",
      "previousVersion",
      "reason",
      "acceptedAt",
    ]);
    const withdrawn = attribution(input.withdrawal);
    profileTimestamp(input.withdrawal.acceptedAt);
    if (
      input.withdrawal.previousVersion !== 1 ||
      selection.value.admissionVersion !== 2 ||
      (input.withdrawal.reason !== "withdrawn" && input.withdrawal.reason !== "replaced") ||
      input.withdrawal.acceptedAt < base.acceptance.acceptedAt
    )
      invalid();
    head = {
      ...base,
      state,
      withdrawal: {
        ...withdrawn,
        previousVersion: 1,
        reason: input.withdrawal.reason,
        acceptedAt: input.withdrawal.acceptedAt,
      },
    };
  }
  retainedIds(head);
  return immutableCopy(head);
}

export function decodeWorkloadProfileAdmissionHistoryV2(
  input: unknown,
): WorkloadProfileAdmissionHistoryV2 {
  fields(input, ["schemaVersion", "historyRef", "head"]);
  if (input.schemaVersion !== 2) invalid();
  profileUuid(input.historyRef);
  const head = decodeWorkloadProfileAdmissionHeadV2(input.head);
  if (
    input.historyRef !==
    (head.state === "admitted" ? head.acceptance.historyRef : head.terminal.historyRef)
  )
    invalid();
  return immutableCopy({ schemaVersion: 2, historyRef: input.historyRef, head });
}
export function workloadProfileAdmissionHistoryV2(
  input: WorkloadProfileAdmissionHeadV2,
): WorkloadProfileAdmissionHistoryV2 {
  const head = decodeWorkloadProfileAdmissionHeadV2(input);
  return decodeWorkloadProfileAdmissionHistoryV2({
    schemaVersion: 2,
    historyRef: head.state === "admitted" ? head.acceptance.historyRef : head.terminal.historyRef,
    head,
  });
}
export function createWorkloadProfileAdmittedHeadV2(
  input: StoredProfilePreparationV2,
  inputAttribution: WorkloadProfileAdmissionAttributionV2,
  acceptedAt: string,
): WorkloadProfileAdmittedHeadV2 {
  const prepared = decodeStoredProfilePreparationV2(input);
  const accepted = decodeWorkloadProfileAdmissionAttributionV2(inputAttribution);
  profileTimestamp(acceptedAt);
  if (
    acceptedAt < prepared.preparedAt ||
    accepted.operationRef !== prepared.operationRef ||
    accepted.actor.accountRef !== prepared.actor.accountRef ||
    accepted.actor.principalRef !== prepared.actor.principalRef
  )
    invalid();
  const normalized = normalizeProfilePreparationV2(
    decodeWorkloadProfileJson(encoder.encode(prepared.canonicalClientIntent), "operator-envelope")
      .value,
  );
  const derived = deriveWorkloadProfileManifestV2(
    encoder.encode(normalized.request.manifest.canonicalUtf8),
  );
  const profileRefs = {} as Record<(typeof roles)[number], WorkloadProfileRolesV1["provider"]>;
  for (const role of roles)
    profileRefs[role] = {
      ref: prepared.allocated[`${role}Ref`],
      version: 1,
      contentDigest: derived.roleDigests[role],
    };
  const head = decodeWorkloadProfileAdmissionHeadV2({
    schemaVersion: 2,
    scope: prepared.scope,
    selection: {
      manifestRef: prepared.allocated.manifestRef,
      manifestDigest: derived.digests.manifestDigest,
      admissionRef: prepared.allocated.admissionRef,
      admissionVersion: 1,
    },
    canonicalFormat: normalized.request.manifest.format,
    canonicalManifest: normalized.request.manifest.canonicalUtf8,
    profileRefs,
    acceptance: {
      ...accepted,
      historyRef: prepared.allocated.historyRef,
      auditRef: prepared.allocated.auditRef,
      acceptedAt,
    },
    terminal: {
      templateRef: prepared.allocated.terminalTemplateRef,
      historyRef: prepared.allocated.terminalHistoryRef,
      auditRef: prepared.allocated.terminalAuditRef,
      invalidationRef: prepared.allocated.terminalInvalidationRef,
    },
    state: "admitted",
  });
  if (head.state !== "admitted") invalid();
  return head;
}
export function assertWorkloadProfileAcceptanceHistoryV2(
  history: WorkloadProfileAdmissionHistoryV2,
  input: StoredProfilePreparationV2,
): void {
  const prepared = decodeStoredProfilePreparationV2(input);
  const actual = decodeWorkloadProfileAdmissionHistoryV2(history);
  if (actual.head.state !== "admitted") invalid();
  const accepted = actual.head.acceptance;
  const expected = createWorkloadProfileAdmittedHeadV2(
    prepared,
    {
      actor: accepted.actor,
      operationRef: accepted.operationRef,
      requestRef: accepted.requestRef,
      decisionRef: accepted.decisionRef,
    },
    accepted.acceptedAt,
  );
  const ids = retainedIds(actual.head);
  for (const kind of Object.keys(prepared.allocated) as Array<keyof typeof prepared.allocated>)
    if (ids[kind] !== prepared.allocated[kind]) invalid();
  if (
    actual.head.scope.installationId !== expected.scope.installationId ||
    actual.head.scope.namespaceId !== expected.scope.namespaceId ||
    actual.head.canonicalManifest !== expected.canonicalManifest ||
    actual.head.selection.manifestDigest !== expected.selection.manifestDigest
  )
    invalid();
}
export function withdrawWorkloadProfileAdmissionV2(
  input: WorkloadProfileAdmittedHeadV2,
  inputAttribution: WorkloadProfileAdmissionAttributionV2,
  reason: "withdrawn" | "replaced",
  acceptedAt: string,
): WorkloadProfileWithdrawnHeadV2 {
  const current = decodeWorkloadProfileAdmissionHeadV2(input);
  if (
    current.state !== "admitted" ||
    current.selection.admissionVersion === Number.MAX_SAFE_INTEGER
  )
    invalid();
  const withdrawal = decodeWorkloadProfileAdmissionAttributionV2(inputAttribution);
  const head = decodeWorkloadProfileAdmissionHeadV2({
    ...current,
    state: "withdrawn",
    selection: { ...current.selection, admissionVersion: current.selection.admissionVersion + 1 },
    withdrawal: {
      ...withdrawal,
      previousVersion: current.selection.admissionVersion,
      reason,
      acceptedAt,
    },
  });
  if (head.state !== "withdrawn") invalid();
  return head;
}
export function workloadProfileInvalidationV2(
  input: WorkloadProfileWithdrawnHeadV2,
): WorkloadProfileInvalidationV2 {
  const head = decodeWorkloadProfileAdmissionHeadV2(input);
  if (head.state !== "withdrawn") invalid();
  const decoded = decodeProfileInvalidationRequestV2({
    schemaVersion: 2,
    kind: "profile-admission-invalidated",
    requestRef: head.terminal.invalidationRef,
    operationRef: head.withdrawal.operationRef,
    ...head.scope,
    manifestRef: head.selection.manifestRef,
    manifestDigest: head.selection.manifestDigest,
    admissionRef: head.selection.admissionRef,
    previousVersion: head.withdrawal.previousVersion,
    currentVersion: head.selection.admissionVersion,
    reason: head.withdrawal.reason,
    acceptedAt: head.withdrawal.acceptedAt,
  });
  if (decoded.kind !== "valid") invalid();
  return decoded.value;
}

function namespace(value: string): string {
  if (typeof value !== "string" || !value.startsWith("ns_"))
    throw new InvalidProfileOperationError();
  profileUuid(value.slice(3));
  return value;
}
function selection(input: unknown): WorkloadProfileSelectionV1 {
  const decoded = decodeWorkloadProfileSelectionV1(input);
  if (decoded.kind !== "valid") throw new InvalidProfileOperationError();
  return decoded.value;
}
function sameSelection(
  left: WorkloadProfileSelectionV1,
  right: WorkloadProfileSelectionV1,
): boolean {
  return (
    left.manifestRef === right.manifestRef &&
    left.manifestDigest === right.manifestDigest &&
    left.admissionRef === right.admissionRef &&
    left.admissionVersion === right.admissionVersion
  );
}
function sameActor(
  left: WorkloadProfileAdmissionAttributionV2["actor"],
  right: WorkloadProfileAdmissionAttributionV2["actor"],
): boolean {
  return left.accountRef === right.accountRef && left.principalRef === right.principalRef;
}
function capacity(value: ProfileCapacity): ProfileCapacity {
  canonicalizeWorkloadProfileJson(value, "operator-envelope");
  if (
    Object.keys(value).length !== 3 ||
    !["ordinaryOperations", "pendingOrdinaryOperations", "terminalSlots"].every((key) =>
      Object.hasOwn(value, key),
    )
  )
    throw new ProfileOperationCapacityError();
  for (const count of [
    value.ordinaryOperations,
    value.pendingOrdinaryOperations,
    value.terminalSlots,
  ])
    if (!Number.isSafeInteger(count) || count < 0) throw new ProfileOperationCapacityError();
  if (
    value.pendingOrdinaryOperations > value.ordinaryOperations ||
    value.pendingOrdinaryOperations > WORKLOAD_PROFILE_LIMITS_V1.pendingOrdinaryOperations ||
    value.ordinaryOperations + value.terminalSlots >
      WORKLOAD_PROFILE_LIMITS_V1.operationAndTerminalSlots
  )
    throw new ProfileOperationCapacityError();
  return immutableCopy(value);
}
function owns(
  head: WorkloadProfileAdmissionHeadV2,
  installationId: string,
  namespaceId: string,
): void {
  if (head.scope.installationId !== installationId || head.scope.namespaceId !== namespaceId)
    throw new ProfileOperationConflictError();
}
function active(
  input: unknown,
  expected: WorkloadProfileSelectionV1,
  installationId: string,
  namespaceId: string,
): WorkloadProfileAdmittedHeadV2 {
  if (input === undefined) throw new ProfileOperationConflictError();
  const head = decodeWorkloadProfileAdmissionHeadV2(input);
  owns(head, installationId, namespaceId);
  if (head.state !== "admitted" || !sameSelection(head.selection, expected))
    throw new ProfileOperationConflictError();
  return head;
}

/** One original guard admission encompasses all borrowed backend operations.
 * Responses remain provisional until the outer owner commits and releases its
 * client. This repository cannot enroll/authenticate callers or commit itself. */
export function createWorkloadProfileAdmissionRepositoryV2(
  backend: WorkloadProfileAdmissionBackendV2,
  guard: WorkloadProfileTransactionGuard,
  now: () => string = () => new Date().toISOString(),
): WorkloadProfileAdmissionRepositoryV2 {
  const installation = (): string => {
    const id = backend.installationId();
    profileInstallation(id);
    return id;
  };
  // Capture public data before the guard's first queued microtask. A capture
  // failure is still admitted as a rejection so catching it poisons this unit.
  const run = <Input, Output>(
    capture: () => Input,
    work: (input: Input) => Promise<Output>,
  ): Promise<Output> => {
    let input: Input;
    let failed = false;
    let failure: unknown;
    try {
      input = capture();
    } catch (error) {
      failed = true;
      failure = error;
    }
    return guard.run(async () => {
      if (failed) throw failure;
      return work(input!);
    });
  };
  const persistWithdrawal = async (
    expected: WorkloadProfileAdmittedHeadV2,
    head: WorkloadProfileWithdrawnHeadV2,
  ) => {
    const history = workloadProfileAdmissionHistoryV2(head);
    await backend.withdrawAdmission(expected, head, history, workloadProfileInvalidationV2(head));
    await backend.appendAudit(head.withdrawal, history);
    return history;
  };
  const repository: WorkloadProfileAdmissionRepositoryV2 = {
    accept: (input, inputAttribution, qualifyDefinition) =>
      run(
        () => {
          const locator = profileLocator(input);
          const attribution = decodeWorkloadProfileAdmissionAttributionV2(inputAttribution);
          if (
            locator.operationRef !== attribution.operationRef ||
            !sameActor(locator.actor, attribution.actor)
          )
            throw new ProfileOperationConflictError();
          return { locator, attribution, qualifyDefinition };
        },
        async ({ locator, attribution, qualifyDefinition }) => {
          const installationId = installation();
          if (locator.installationId !== installationId) throw new ProfileOperationConflictError();
          await backend.lockCapacity();
          await backend.lockOperation(locator);
          const stored = await backend.operation(locator);
          if (stored === undefined)
            throw new ScopeViolationError("The original profile preparation is unavailable.");
          const prepared = decodeStoredProfilePreparationV2(stored);
          if (
            prepared.scope.installationId !== installationId ||
            prepared.operationRef !== locator.operationRef ||
            !sameActor(prepared.actor, locator.actor)
          )
            throw new ProfileOperationConflictError();
          const retained = await backend.acceptedOperation(locator);
          if (retained !== undefined) {
            const history = decodeWorkloadProfileAdmissionHistoryV2(retained);
            assertWorkloadProfileAcceptanceHistoryV2(history, prepared);
            // Already-authorized historical replay never reacquires a current head,
            // requalifies definitions, rewrites attribution or allocates anything.
            return immutableCopy({ history, action: prepared.action });
          }
          if (!(await backend.namespaceExists(prepared.scope.namespaceId)))
            throw new ProfileOperationConflictError();
          const currentCapacity = capacity(await backend.capacity());
          const normalized = normalizeProfilePreparationV2(
            decodeWorkloadProfileJson(
              encoder.encode(prepared.canonicalClientIntent),
              "operator-envelope",
            ).value,
          );
          const previous = normalized.request.expectedAdmission;
          if (previous?.admissionRef === prepared.allocated.admissionRef)
            throw new ProfileOperationConflictError();
          const refs = [
            prepared.allocated.admissionRef,
            ...(previous === null ? [] : [previous.admissionRef]),
          ].sort();
          await backend.lockHeads(prepared.scope.namespaceId, refs, "update");
          if (
            (await backend.head(prepared.scope.namespaceId, prepared.allocated.admissionRef)) !==
            undefined
          )
            throw new ProfileOperationConflictError();
          const replaced =
            previous === null
              ? undefined
              : active(
                  await backend.head(prepared.scope.namespaceId, previous.admissionRef),
                  previous,
                  installationId,
                  prepared.scope.namespaceId,
                );
          if (
            currentCapacity.pendingOrdinaryOperations === 0 ||
            (replaced !== undefined && currentCapacity.terminalSlots === 0)
          )
            throw new ProfileOperationCapacityError();
          const nextCapacity = capacity({
            ordinaryOperations:
              currentCapacity.ordinaryOperations + (replaced === undefined ? 0 : 1),
            pendingOrdinaryOperations: currentCapacity.pendingOrdinaryOperations - 1,
            terminalSlots: currentCapacity.terminalSlots + (replaced === undefined ? 1 : 0),
          });
          if (typeof qualifyDefinition !== "function")
            throw new DependencyUnavailableError(
              "The original profile definition source is unavailable.",
            );
          const manifest = deriveWorkloadProfileManifestV2(
            encoder.encode(normalized.request.manifest.canonicalUtf8),
          );
          const selected = selection({
            manifestRef: prepared.allocated.manifestRef,
            manifestDigest: manifest.digests.manifestDigest,
            admissionRef: prepared.allocated.admissionRef,
            admissionVersion: 1,
          });
          const result = await qualifyDefinition(
            Object.freeze({ scope: prepared.scope, selection: selected, manifest }),
          );
          if (result !== undefined)
            throw new DependencyUnavailableError(
              "The profile definition continuation did not settle exactly.",
            );
          const acceptedAt = now();
          const head = createWorkloadProfileAdmittedHeadV2(prepared, attribution, acceptedAt);
          const history = workloadProfileAdmissionHistoryV2(head);
          if (replaced !== undefined)
            await persistWithdrawal(
              replaced,
              withdrawWorkloadProfileAdmissionV2(replaced, attribution, "replaced", acceptedAt),
            );
          await backend.insertAdmission(head, history);
          await backend.appendAudit(attribution, history);
          await backend.updateCapacity(currentCapacity, nextCapacity);
          return immutableCopy({ history, action: prepared.action });
        },
      ),
    withdraw: (inputNamespace, inputExpected, inputAttribution) =>
      run(
        () => ({
          namespaceId: namespace(inputNamespace),
          expected: selection(inputExpected),
          attribution: decodeWorkloadProfileAdmissionAttributionV2(inputAttribution),
        }),
        async ({ namespaceId, expected, attribution }) => {
          const installationId = installation();
          const locator = profileLocator({
            installationId,
            actor: attribution.actor,
            operationRef: attribution.operationRef,
          });
          await backend.lockCapacity();
          await backend.lockOperation(locator);
          const retained = await backend.acceptedOperation(locator);
          if (retained !== undefined) {
            const history = decodeWorkloadProfileAdmissionHistoryV2(retained);
            const head = history.head;
            owns(head, installationId, namespaceId);
            if (
              head.state !== "withdrawn" ||
              head.withdrawal.reason !== "withdrawn" ||
              head.withdrawal.operationRef !== attribution.operationRef ||
              !sameActor(head.withdrawal.actor, attribution.actor) ||
              !sameSelection(
                { ...head.selection, admissionVersion: head.withdrawal.previousVersion },
                expected,
              )
            )
              throw new ProfileOperationConflictError();
            return history;
          }
          // A withdrawal command cannot adopt an actor's ordinary pending operation.
          if ((await backend.operation(locator)) !== undefined)
            throw new ProfileOperationConflictError();
          if (!(await backend.namespaceExists(namespaceId)))
            throw new ProfileOperationConflictError();
          const currentCapacity = capacity(await backend.capacity());
          await backend.lockHeads(namespaceId, [expected.admissionRef], "update");
          const previous = active(
            await backend.head(namespaceId, expected.admissionRef),
            expected,
            installationId,
            namespaceId,
          );
          if (currentCapacity.terminalSlots === 0) throw new ProfileOperationCapacityError();
          const nextCapacity = capacity({
            ordinaryOperations: currentCapacity.ordinaryOperations + 1,
            pendingOrdinaryOperations: currentCapacity.pendingOrdinaryOperations,
            terminalSlots: currentCapacity.terminalSlots - 1,
          });
          const head = withdrawWorkloadProfileAdmissionV2(
            previous,
            attribution,
            "withdrawn",
            now(),
          );
          const history = await persistWithdrawal(previous, head);
          await backend.updateCapacity(currentCapacity, nextCapacity);
          return history;
        },
      ),
    readProfile: (inputNamespace, inputAdmission) =>
      run(
        () => {
          const namespaceId = namespace(inputNamespace);
          profileUuid(inputAdmission);
          return { namespaceId, admissionRef: inputAdmission };
        },
        async ({ namespaceId, admissionRef }) => {
          const installationId = installation();
          if (!(await backend.namespaceExists(namespaceId))) return undefined;
          await backend.lockHeads(namespaceId, [admissionRef], "share");
          const stored = await backend.head(namespaceId, admissionRef);
          if (stored === undefined) return undefined;
          const head = decodeWorkloadProfileAdmissionHeadV2(stored);
          owns(head, installationId, namespaceId);
          if (head.selection.admissionRef !== admissionRef)
            throw new ProfileOperationConflictError();
          return head;
        },
      ),
  };
  return Object.freeze(repository);
}
