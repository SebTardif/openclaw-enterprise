import { createHash } from "node:crypto";
import { RepositoryTransactionLifetime } from "../ports/transaction.ts";
import type {
  GatewayStartupBindingV1,
  GatewayStartupOperationLocatorV1,
  GatewayStartupRecordRefV1,
  GatewayProcessCreateInputV1,
  GatewayProcessCallV1,
  GatewayProcessSubmissionV1,
  GatewayProcessSubmissionOwnerV1,
  GatewayStartupSubjectV2,
  GatewayStartupOperationLocatorV2,
  GatewayStartupBindingV2,
  GatewayProcessCreateInputV2,
  GatewayProcessCallV2,
  GatewayProcessSubmissionV2,
  GatewayProcessSubmissionOwnerV2,
} from "@openclaw-enterprise/contracts/gateway-startup-v1";

import {
  decodeWorkloadProfileSelectionV1,
  decodeWorkloadProfileUseV1,
  type WorkloadProfileSelectionV1,
} from "@openclaw-enterprise/contracts/workload-profile-v1";

export type GatewayStartupQueryV1 = (
  statement: string,
  parameters?: readonly unknown[],
) => Promise<{ rows: unknown[]; rowCount: number | null }>;
export type GatewayStartupCommandLocatorV1 = Readonly<{
  installationId: string;
  operationRef: string;
  operationDigest: string;
  startup: GatewayStartupOperationLocatorV1 | null;
}>;
export type GatewayStartupExpectedHeadV1 = Readonly<{
  version: number;
  startup: GatewayStartupOperationLocatorV1;
  recordVersion: number;
}>;
export type GatewayStartupRecipientBindingV1 = Readonly<{
  recipient: GatewayStartupRecordRefV1;
  process: GatewayStartupRecordRefV1;
  incarnationRef: string;
  observation: GatewayStartupRecordRefV1;
}>;
export type GatewayStartupCommandV1 =
  | Readonly<{
      schemaVersion: 1;
      kind: "accept-startup";
      operationRef: string;
      expectedHead: GatewayStartupExpectedHeadV1 | null;
      selectedDefinition: GatewayStartupRecordRefV1;
      predecessorDisposition: GatewayStartupRecordRefV1;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "submit-create";
      operationRef: string;
      startup: GatewayStartupOperationLocatorV1;
      expectedHead: GatewayStartupExpectedHeadV1;
      input: GatewayProcessCreateInputV1;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "consume-startup";
      operationRef: string;
      startup: GatewayStartupOperationLocatorV1;
      expectedHead: GatewayStartupExpectedHeadV1;
      recipient: GatewayStartupRecipientBindingV1;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "withdraw";
      operationRef: string;
      startup: GatewayStartupOperationLocatorV1;
      expectedHead: GatewayStartupExpectedHeadV1;
      reason: "administrative" | "selection-withdrawn" | "recipient-revoked";
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "read-current";
      startup: GatewayStartupOperationLocatorV1;
      expectedRecordVersion: number;
      recipient: GatewayStartupRecipientBindingV1;
    }>
  | Readonly<{
      schemaVersion: 1;
      kind: "read-operation";
      operation: GatewayStartupCommandLocatorV1;
    }>;
export type GatewayStartupHeadV1 = Readonly<{
  version: number;
  processGeneration: number;
  latestOperationRef: string | null;
  startup: GatewayStartupOperationLocatorV1 | null;
  recordVersion: number;
  state: "empty" | "accepted" | "create-submitted" | "consumed" | "withdrawn";
}>;
export type GatewayStartupAcceptanceV1 = Readonly<{
  binding: GatewayStartupBindingV1;
  predecessor: Readonly<{
    disposition: GatewayStartupRecordRefV1;
    previousStartup: GatewayStartupOperationLocatorV1 | null;
    processOwner: GatewayStartupRecordRefV1;
    settlement: GatewayStartupRecordRefV1;
  }>;
  auditEventId: string;
}>;
export type GatewayStartupMutationEventV1 = Readonly<{
  kind: "accept-startup" | "submit-create" | "consume-startup" | "withdraw";
  command: GatewayStartupCommandLocatorV1;
  canonicalCommand: string;
  beforeHeadVersion: number;
  afterHeadVersion: number;
  beforeRecordVersion: number;
  afterRecordVersion: number;
  previousOperationRef: string | null;
  startup: GatewayStartupOperationLocatorV1;
  createEffectRef: string;
  acceptance: GatewayStartupAcceptanceV1 | null;
  submissionInput: GatewayProcessCreateInputV1 | null;
  recipient: GatewayStartupRecipientBindingV1 | null;
  withdrawalReason: "administrative" | "selection-withdrawn" | "recipient-revoked" | null;
  auditEventId: string;
}>;
export type GatewayStartupCurrentV1 = Readonly<{
  head: GatewayStartupHeadV1;
  acceptance: GatewayStartupAcceptanceV1;
  submission: GatewayStartupMutationEventV1 | null;
  claim: GatewayStartupMutationEventV1 | null;
}>;
export type GatewayStartupOwnerFailureV1 =
  | Readonly<{ kind: "denied" | "unavailable" }>
  | Readonly<{ kind: "recovery-required"; operation: GatewayStartupCommandLocatorV1 }>;
export type GatewayStartupOwnerSuccessV1 =
  | Readonly<{ kind: "accepted"; record: GatewayStartupAcceptanceV1; head: GatewayStartupHeadV1 }>
  | Readonly<{ kind: "submitted"; event: GatewayStartupMutationEventV1 }>
  | Readonly<{ kind: "consumed" | "current"; record: GatewayStartupCurrentV1 }>
  | Readonly<{
      kind: "withdrawn";
      startup: GatewayStartupOperationLocatorV1;
      head: GatewayStartupHeadV1;
    }>
  | Readonly<{ kind: "observed"; operation: GatewayStartupMutationEventV1 }>
  | Readonly<{ kind: "not-observed"; operation: GatewayStartupCommandLocatorV1 }>;
export type GatewayStartupCompletionV1 =
  | Readonly<{ kind: "commit"; provisional: GatewayStartupOwnerSuccessV1 }>
  | Readonly<{ kind: "rollback"; response: GatewayStartupOwnerFailureV1 }>;
/** Physical predecessor custody is separate from the within-subject event chain. */
export type GatewayStartupPredecessorV2 =
  | Readonly<{
      kind: "complete-initial";
      disposition: GatewayStartupRecordRefV1;
      previousStartup: null;
      processOwner: GatewayStartupRecordRefV1;
      settlement: GatewayStartupRecordRefV1;
    }>
  | Readonly<{
      kind: "retired-agent";
      disposition: GatewayStartupRecordRefV1;
      previousStartup: GatewayStartupOperationLocatorV2;
      processOwner: GatewayStartupRecordRefV1;
      settlement: GatewayStartupRecordRefV1;
    }>
  | Readonly<{
      kind: "retired-installation";
      disposition: GatewayStartupRecordRefV1;
      previousStartup: GatewayStartupOperationLocatorV1;
      historicalWithdrawal: GatewayStartupCommandLocatorV1;
      processOwner: GatewayStartupRecordRefV1;
      settlement: GatewayStartupRecordRefV1;
    }>;
export type GatewayStartupCommandLocatorV2 = Readonly<{
  schemaVersion: 2;
  subject: GatewayStartupSubjectV2;
  operationRef: string;
  operationDigest: string;
  startup: GatewayStartupOperationLocatorV2 | null;
}>;
export type GatewayStartupExpectedHeadV2 = Readonly<{
  version: number;
  startup: GatewayStartupOperationLocatorV2;
  recordVersion: number;
}>;
export type GatewayStartupCommandV2 =
  | Readonly<{
      schemaVersion: 2;
      subject: GatewayStartupSubjectV2;
      kind: "accept-startup";
      operationRef: string;
      expectedHead: GatewayStartupExpectedHeadV2 | null;
      selectedDefinition: WorkloadProfileSelectionV1;
      predecessorDisposition: GatewayStartupRecordRefV1;
    }>
  | Readonly<{
      schemaVersion: 2;
      subject: GatewayStartupSubjectV2;
      kind: "submit-create";
      operationRef: string;
      startup: GatewayStartupOperationLocatorV2;
      expectedHead: GatewayStartupExpectedHeadV2;
      input: GatewayProcessCreateInputV2;
    }>
  | Readonly<{
      schemaVersion: 2;
      subject: GatewayStartupSubjectV2;
      kind: "consume-startup";
      operationRef: string;
      startup: GatewayStartupOperationLocatorV2;
      expectedHead: GatewayStartupExpectedHeadV2;
      recipient: GatewayStartupRecipientBindingV1;
    }>
  | Readonly<{
      schemaVersion: 2;
      subject: GatewayStartupSubjectV2;
      kind: "withdraw";
      operationRef: string;
      startup: GatewayStartupOperationLocatorV2;
      expectedHead: GatewayStartupExpectedHeadV2;
      reason: "administrative" | "selection-withdrawn" | "recipient-revoked";
    }>
  | Readonly<{
      schemaVersion: 2;
      subject: GatewayStartupSubjectV2;
      kind: "read-current";
      startup: GatewayStartupOperationLocatorV2;
      expectedRecordVersion: number;
      recipient: GatewayStartupRecipientBindingV1;
    }>
  | Readonly<{
      schemaVersion: 2;
      subject: GatewayStartupSubjectV2;
      kind: "read-operation";
      operation: GatewayStartupCommandLocatorV2;
    }>;
export type GatewayStartupHeadV2 = Readonly<{
  subject: GatewayStartupSubjectV2;
  version: number;
  processGeneration: number;
  latestOperationRef: string | null;
  startup: GatewayStartupOperationLocatorV2 | null;
  recordVersion: number;
  state: "empty" | "accepted" | "create-submitted" | "consumed" | "withdrawn";
}>;
export type GatewayStartupAcceptanceV2 = Readonly<{
  binding: GatewayStartupBindingV2;
  predecessor: GatewayStartupPredecessorV2;
  auditEventId: string;
}>;
export type GatewayStartupMutationEventV2 = Readonly<{
  schemaVersion: 2;
  kind: "accept-startup" | "submit-create" | "consume-startup" | "withdraw";
  command: GatewayStartupCommandLocatorV2;
  canonicalCommand: string;
  beforeHeadVersion: number;
  afterHeadVersion: number;
  beforeRecordVersion: number;
  afterRecordVersion: number;
  previousOperationRef: string | null;
  startup: GatewayStartupOperationLocatorV2;
  createEffectRef: string;
  acceptance: GatewayStartupAcceptanceV2 | null;
  submissionInput: GatewayProcessCreateInputV2 | null;
  recipient: GatewayStartupRecipientBindingV1 | null;
  withdrawalReason: "administrative" | "selection-withdrawn" | "recipient-revoked" | null;
  auditEventId: string;
}>;
export type GatewayStartupCurrentV2 = Readonly<{
  head: GatewayStartupHeadV2;
  acceptance: GatewayStartupAcceptanceV2;
  submission: GatewayStartupMutationEventV2 | null;
  claim: GatewayStartupMutationEventV2 | null;
}>;
export type GatewayStartupOwnerFailureV2 =
  | Readonly<{ kind: "denied" | "unavailable" }>
  | Readonly<{ kind: "recovery-required"; operation: GatewayStartupCommandLocatorV2 }>;
export type GatewayStartupOwnerSuccessV2 =
  | Readonly<{ kind: "accepted"; record: GatewayStartupAcceptanceV2; head: GatewayStartupHeadV2 }>
  | Readonly<{ kind: "submitted"; event: GatewayStartupMutationEventV2 }>
  | Readonly<{ kind: "consumed" | "current"; record: GatewayStartupCurrentV2 }>
  | Readonly<{
      kind: "withdrawn";
      startup: GatewayStartupOperationLocatorV2;
      head: GatewayStartupHeadV2;
    }>
  | Readonly<{ kind: "observed"; operation: GatewayStartupMutationEventV2 }>
  | Readonly<{ kind: "not-observed"; operation: GatewayStartupCommandLocatorV2 }>;
export type GatewayStartupCompletionV2 =
  | Readonly<{ kind: "commit"; provisional: GatewayStartupOwnerSuccessV2 }>
  | Readonly<{ kind: "rollback"; response: GatewayStartupOwnerFailureV2 }>;
export type GatewayStartupTerminalV1 =
  "rolled-back" | "commit-rejected" | "commit-unknown" | "committed";
export interface GatewayStartupAcceptedOperationV1 {
  assertActive(): void;
  query: GatewayStartupQueryV1;
  poison(error: unknown): void;
}
const unavailable = () => new Error("Gateway startup owner unavailable");

/** Original transaction owner constructs/binds this phase, never a request caller. */
export class GatewayStartupOwnerPhaseV1<
  Completion extends GatewayStartupCompletionV1 | GatewayStartupCompletionV2 =
    GatewayStartupCompletionV1,
> {
  readonly #lifetime: RepositoryTransactionLifetime;
  readonly #query: GatewayStartupQueryV1;
  readonly #pending = new Set<Promise<unknown>>();
  readonly #fences: (() => undefined)[] = [];
  readonly #cleanup: (() => Promise<void>)[] = [];
  #admitted = false;
  #open = true;
  #active = true;
  #failed = false;
  #failure: unknown;
  #completion: Completion | undefined;
  #finalized = false;
  #dispatched = false;
  #acknowledged = false;
  #terminal: GatewayStartupTerminalV1 | undefined;
  constructor(lifetime: RepositoryTransactionLifetime, query: GatewayStartupQueryV1) {
    this.#lifetime = lifetime;
    this.#query = query;
  }
  poison(error: unknown): void {
    if (!this.#active) return;
    if (!this.#failed) {
      this.#failed = true;
      this.#failure = error;
    }
  }
  #reject(): never {
    const error = unavailable();
    this.poison(error);
    throw error;
  }
  #track<T>(promise: Promise<T>): Promise<T> {
    const owned = promise.then(
      (value) => value,
      (error) => {
        this.poison(error);
        throw error;
      },
    );
    this.#pending.add(owned);
    void owned.then(
      () => this.#pending.delete(owned),
      () => this.#pending.delete(owned),
    );
    return owned;
  }
  runCommand(work: () => Promise<Completion>): Promise<Completion> {
    if (this.#admitted || !this.#open || !this.#active)
      return Promise.reject(this.#caughtRejection());
    this.#admitted = true;
    return this.#lifetime.run(() =>
      this.#track(
        Promise.resolve()
          .then(work)
          .then((result) => {
            if (result.kind !== "commit" && result.kind !== "rollback") this.#reject();
            this.#completion = result;
            return result;
          }),
      ),
    );
  }
  #caughtRejection(): Error {
    const e = unavailable();
    this.poison(e);
    return e;
  }
  runOperation<T>(
    _label: string,
    work: (scope: GatewayStartupAcceptedOperationV1) => Promise<T>,
  ): Promise<T> {
    if (!this.#admitted || !this.#open || !this.#active || this.#failed)
      return Promise.reject(this.#caughtRejection());
    let operationActive = true;
    let acceptingQueries = true;
    const queries = new Set<Promise<unknown>>();
    const assertActive = () => {
      if (!operationActive || !this.#active || this.#failed) this.#reject();
      this.#lifetime.assertActive();
    };
    const scope = Object.freeze({
      assertActive,
      poison: (error: unknown) => this.poison(error),
      query: (statement: string, parameters?: readonly unknown[]) => {
        try {
          if (!acceptingQueries) this.#reject();
          assertActive();
        } catch (error) {
          this.poison(error);
          return Promise.reject(error);
        }
        const query = this.#track(
          Promise.resolve()
            .then(() => {
              assertActive();
              return this.#query(statement, parameters);
            })
            .then((result) => {
              assertActive();
              return result;
            }),
        );
        queries.add(query);
        void query.then(
          () => queries.delete(query),
          () => queries.delete(query),
        );
        return query;
      },
    });
    return this.#track(
      (async () => {
        try {
          return await work(scope);
        } finally {
          acceptingQueries = false;
          while (queries.size) await Promise.allSettled([...queries]);
          operationActive = false;
        }
      })(),
    );
  }
  retainCurrentness(assertion: () => undefined): void {
    if (!this.#open || !this.#active || !this.#admitted || typeof assertion !== "function")
      this.#reject();
    this.#fences.push(assertion);
  }
  retainCleanup(close: () => Promise<void>): void {
    if (!this.#open || !this.#active || !this.#admitted || typeof close !== "function")
      this.#reject();
    this.#cleanup.push(close);
  }
  closeAdmissions(): void {
    this.#open = false;
  }
  async drainAccepted(): Promise<void> {
    this.closeAdmissions();
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }
  finalize(): Completion {
    if (!this.#active || this.#open || this.#pending.size || this.#finalized || !this.#completion)
      this.#reject();
    this.#finalized = true;
    if (this.#failed) throw this.#failure;
    for (const assertion of this.#fences) {
      try {
        const result: unknown = assertion();
        if (result !== undefined) {
          this.#track(Promise.resolve(result));
          this.#reject();
        }
      } catch (error) {
        this.poison(error);
        throw error;
      }
    }
    return this.#completion;
  }
  assertCommitReady(): undefined {
    if (
      !this.#active ||
      !this.#finalized ||
      this.#completion?.kind !== "commit" ||
      this.#failed ||
      this.#pending.size ||
      this.#dispatched
    )
      this.#reject();
    return undefined;
  }
  markCommitDispatched(): void {
    this.assertCommitReady();
    this.#dispatched = true;
  }
  observeCommitAcknowledgement(command: unknown): void {
    if (!this.#active || !this.#dispatched || this.#acknowledged || command !== "COMMIT")
      this.#reject();
    this.#acknowledged = true;
  }
  async finishTerminal(outcome: GatewayStartupTerminalV1): Promise<void> {
    if (this.#terminal !== undefined) throw unavailable();
    if (outcome === "committed" && !this.#acknowledged) this.#reject();
    if (
      (outcome === "rolled-back" && this.#dispatched) ||
      (outcome === "commit-rejected" && (!this.#dispatched || this.#acknowledged)) ||
      (outcome === "commit-unknown" && this.#acknowledged)
    )
      this.#reject();
    this.#terminal = outcome;
    this.closeAdmissions();
    await this.drainAccepted();
    // Keep actual account/selection leases through the caller owner's terminal query/client cleanup.
    let cleanupError: unknown;
    let cleanupFailed = false;
    for (const close of this.#cleanup.splice(0).reverse()) {
      try {
        await close();
      } catch (error) {
        if (!cleanupFailed) {
          cleanupFailed = true;
          cleanupError = error;
        }
      }
    }
    this.#active = false;
    if (cleanupFailed) throw cleanupError;
    if (this.#failed) throw this.#failure;
  }
}

/** Closed canonical data only; no live context, function, credential or signal is serialized. */
export function canonicalGatewayStartupValueV1(value: unknown): string {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > 16384 || depth > 24) throw unavailable();
    if (item === null || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "string") {
      if (item.length > 65536) throw unavailable();
      return JSON.stringify(item);
    }
    if (typeof item === "number" && Number.isSafeInteger(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null || seen.has(item)) throw unavailable();
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw unavailable();
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (Reflect.ownKeys(item).length !== item.length + 1) throw unavailable();
      const values: string[] = [];
      for (let i = 0; i < item.length; i++) {
        const field = Object.getOwnPropertyDescriptor(item, String(i));
        if (!field || !("value" in field) || !field.enumerable) throw unavailable();
        values.push(visit(field.value, depth + 1));
      }
      result = `[${values.join(",")}]`;
    } else {
      const keys = Reflect.ownKeys(item);
      if (keys.some((k) => typeof k !== "string" || k === "__proto__")) throw unavailable();
      result = `{${(keys as string[])
        .sort()
        .map((key) => {
          const field = Object.getOwnPropertyDescriptor(item, key)!;
          if (!("value" in field) || !field.enumerable) throw unavailable();
          return `${JSON.stringify(key)}:${visit(field.value, depth + 1)}`;
        })
        .join(",")}}`;
    }
    seen.delete(item);
    return result;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(result, "utf8") > 262144) throw unavailable();
  return result;
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw unavailable();
}
function ref(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw unavailable();
}
function version(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw unavailable();
}
function recordRef(value: unknown): void {
  exact(value, ["recordRef", "recordVersion"]);
  ref(value.recordRef);
  version(value.recordVersion);
}
function locator(value: unknown): void {
  exact(value, [
    "installationId",
    "processRef",
    "processGeneration",
    "operationRef",
    "operationDigest",
  ]);
  ref(value.installationId);
  ref(value.processRef);
  version(value.processGeneration);
  ref(value.operationRef);
  if (typeof value.operationDigest !== "string" || !/^[0-9a-f]{64}$/u.test(value.operationDigest))
    throw unavailable();
}
function expectedHead(value: unknown): void {
  exact(value, ["version", "startup", "recordVersion"]);
  version(value.version);
  locator(value.startup);
  version(value.recordVersion);
}
function recipient(value: unknown): void {
  exact(value, ["recipient", "process", "incarnationRef", "observation"]);
  recordRef(value.recipient);
  recordRef(value.process);
  ref(value.incarnationRef);
  recordRef(value.observation);
}
export function parseGatewayStartupBindingV1(value: unknown): GatewayStartupBindingV1 {
  const copy: unknown = JSON.parse(canonicalGatewayStartupValueV1(value));
  exact(copy, [
    "startup",
    "createEffectRef",
    "selection",
    "configurationRef",
    "configurationVersion",
    "profileRef",
    "profileVersion",
    "namespaceRef",
    "agentRef",
    "admittedRevisionRef",
    "gatewayAssignmentRef",
    "hostRuntimeGeneration",
    "nativeConfigRef",
    "configDigest",
    "stateOwnership",
    "stateSchemaVersion",
    "agentSchemaVersion",
    "protocolVersion",
    "modules",
    "startupDeadlineMs",
    "shutdownDeadlineMs",
  ]);
  locator(copy.startup);
  recordRef(copy.selection);
  recordRef(copy.stateOwnership);
  for (const key of [
    "createEffectRef",
    "configurationRef",
    "profileRef",
    "namespaceRef",
    "agentRef",
    "admittedRevisionRef",
    "gatewayAssignmentRef",
    "nativeConfigRef",
    "configDigest",
  ])
    ref(copy[key]);
  for (const key of [
    "configurationVersion",
    "profileVersion",
    "hostRuntimeGeneration",
    "stateSchemaVersion",
    "agentSchemaVersion",
    "protocolVersion",
    "startupDeadlineMs",
    "shutdownDeadlineMs",
  ])
    version(copy[key]);
  if (!Array.isArray(copy.modules) || copy.modules.length < 1 || copy.modules.length > 32)
    throw unavailable();
  const ids = new Set<string>();
  for (const module of copy.modules) {
    exact(module, ["id", "kind", "profileRef", "requiredCapabilities"]);
    ref(module.id);
    ref(module.profileRef);
    if (
      !["identity", "channel", "harness", "persistence"].includes(String(module.kind)) ||
      ids.has(module.id)
    )
      throw unavailable();
    ids.add(module.id);
    if (!Array.isArray(module.requiredCapabilities) || module.requiredCapabilities.length > 64)
      throw unavailable();
    const caps = new Set<string>();
    for (const capability of module.requiredCapabilities) {
      ref(capability);
      if (caps.has(capability)) throw unavailable();
      caps.add(capability);
    }
  }
  return freeze(copy) as GatewayStartupBindingV1;
}
function createInput(value: unknown): void {
  exact(value, ["binding", "target", "launchPlan"]);
  parseGatewayStartupBindingV1(value.binding);
  recordRef(value.launchPlan);
  exact(value.target, ["clusterRef", "namespace", "deploymentName"]);
  ref(value.target.clusterRef);
  ref(value.target.deploymentName);
  exact(value.target.namespace, ["name", "uid", "resourceVersion"]);
  for (const field of Object.values(value.target.namespace)) ref(field);
}
function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function parseGatewayStartupCommandV1(value: unknown): GatewayStartupCommandV1 {
  const copy: unknown = JSON.parse(canonicalGatewayStartupValueV1(value));
  if (typeof copy !== "object" || copy === null || Array.isArray(copy)) throw unavailable();
  const c = copy as Record<string, unknown>;
  if (c.schemaVersion !== 1) throw unavailable();
  switch (c.kind) {
    case "accept-startup":
      exact(c, [
        "schemaVersion",
        "kind",
        "operationRef",
        "expectedHead",
        "selectedDefinition",
        "predecessorDisposition",
      ]);
      ref(c.operationRef);
      if (c.expectedHead !== null) expectedHead(c.expectedHead);
      recordRef(c.selectedDefinition);
      recordRef(c.predecessorDisposition);
      break;
    case "submit-create":
      exact(c, ["schemaVersion", "kind", "operationRef", "startup", "expectedHead", "input"]);
      ref(c.operationRef);
      locator(c.startup);
      expectedHead(c.expectedHead);
      createInput(c.input);
      break;
    case "consume-startup":
      exact(c, ["schemaVersion", "kind", "operationRef", "startup", "expectedHead", "recipient"]);
      ref(c.operationRef);
      locator(c.startup);
      expectedHead(c.expectedHead);
      recipient(c.recipient);
      break;
    case "withdraw":
      exact(c, ["schemaVersion", "kind", "operationRef", "startup", "expectedHead", "reason"]);
      ref(c.operationRef);
      locator(c.startup);
      expectedHead(c.expectedHead);
      if (
        !["administrative", "selection-withdrawn", "recipient-revoked"].includes(String(c.reason))
      )
        throw unavailable();
      break;
    case "read-current":
      exact(c, ["schemaVersion", "kind", "startup", "expectedRecordVersion", "recipient"]);
      locator(c.startup);
      version(c.expectedRecordVersion);
      recipient(c.recipient);
      break;
    case "read-operation":
      exact(c, ["schemaVersion", "kind", "operation"]);
      exact(c.operation, ["installationId", "operationRef", "operationDigest", "startup"]);
      ref(c.operation.installationId);
      ref(c.operation.operationRef);
      if (
        typeof c.operation.operationDigest !== "string" ||
        !/^[0-9a-f]{64}$/u.test(c.operation.operationDigest)
      )
        throw unavailable();
      if (c.operation.startup !== null) locator(c.operation.startup);
      break;
    default:
      throw unavailable();
  }
  return freeze(copy) as GatewayStartupCommandV1;
}
export function gatewayStartupCommandDigestV1(command: GatewayStartupCommandV1): string {
  return createHash("sha256")
    .update(
      canonicalGatewayStartupValueV1({
        domain: "oce.installation-gateway.startup-operation.v1",
        command,
      }),
    )
    .digest("hex");
}
export interface GatewayStartupBackendV1 {
  lockHead(io: GatewayStartupAcceptedOperationV1): Promise<GatewayStartupHeadV1>;
  readHead(io: GatewayStartupAcceptedOperationV1): Promise<GatewayStartupHeadV1 | undefined>;
  findOperation(
    io: GatewayStartupAcceptedOperationV1,
    operationRef: string,
  ): Promise<GatewayStartupMutationEventV1 | undefined>;
  readAcceptance(
    io: GatewayStartupAcceptedOperationV1,
    startup: GatewayStartupOperationLocatorV1,
  ): Promise<GatewayStartupAcceptanceV1 | undefined>;
  findSubmission(
    io: GatewayStartupAcceptedOperationV1,
    startup: GatewayStartupOperationLocatorV1,
  ): Promise<GatewayStartupMutationEventV1 | undefined>;
  findClaim(
    io: GatewayStartupAcceptedOperationV1,
    startup: GatewayStartupOperationLocatorV1,
  ): Promise<GatewayStartupMutationEventV1 | undefined>;
  append(
    io: GatewayStartupAcceptedOperationV1,
    event: GatewayStartupMutationEventV1,
  ): Promise<void>;
  advanceHead(
    io: GatewayStartupAcceptedOperationV1,
    expected: GatewayStartupHeadV1,
    event: GatewayStartupMutationEventV1,
  ): Promise<void>;
}
export interface GatewayStartupOwnerLeaseV1 {
  assertCurrent(): undefined;
  release(): Promise<void>;
}
export interface GatewayStartupAuthorityLeaseV1 extends GatewayStartupOwnerLeaseV1 {
  readonly attribution: Readonly<{ actorId: string; requestRef: string; decisionRef: string }>;
}
export interface GatewayStartupCommandBoundsV1 {
  readonly requestRef: string;
  readonly deadline: string;
  readonly signal: AbortSignal;
}
declare const invocationBrand: unique symbol;
export interface GatewayStartupInvocationV1 {
  readonly [invocationBrand]: true;
}
export interface GatewayStartupOwnerUnitV1 {
  readonly installationId: string;
  readonly phase: GatewayStartupOwnerPhaseV1;
  readonly backend: GatewayStartupBackendV1;
  /** Actual private NativeIAM view/context is consumed only by the original account participant. */
  readonly policy: object;
}
export interface GatewayStartupOwnerParticipantsV1 {
  authority: {
    consume(
      invocation: GatewayStartupInvocationV1,
      command: GatewayStartupCommandV1,
      bounds: GatewayStartupCommandBoundsV1,
      unit: GatewayStartupOwnerUnitV1,
      io: GatewayStartupAcceptedOperationV1,
    ): Promise<GatewayStartupAuthorityLeaseV1>;
  };
  selection: {
    resolveLocked(
      command: GatewayStartupCommandV1,
      original: GatewayStartupAcceptanceV1 | undefined,
      unit: GatewayStartupOwnerUnitV1,
      io: GatewayStartupAcceptedOperationV1,
    ): Promise<
      GatewayStartupOwnerLeaseV1 & {
        readonly selected: Omit<GatewayStartupBindingV1, "startup" | "createEffectRef">;
      }
    >;
  };
  process: {
    requireDisposition(
      command: Extract<GatewayStartupCommandV1, { kind: "accept-startup" }>,
      previous: GatewayStartupAcceptanceV1 | undefined,
      unit: GatewayStartupOwnerUnitV1,
      io: GatewayStartupAcceptedOperationV1,
    ): Promise<
      GatewayStartupOwnerLeaseV1 & {
        readonly predecessor: GatewayStartupAcceptanceV1["predecessor"];
      }
    >;
    requireCurrent(
      command: Exclude<GatewayStartupCommandV1, { kind: "accept-startup" | "read-operation" }>,
      acceptance: GatewayStartupAcceptanceV1,
      unit: GatewayStartupOwnerUnitV1,
      io: GatewayStartupAcceptedOperationV1,
    ): Promise<GatewayStartupOwnerLeaseV1>;
  };
  audit: {
    append(
      event: GatewayStartupMutationEventV1,
      attribution: GatewayStartupAuthorityLeaseV1["attribution"],
      unit: GatewayStartupOwnerUnitV1,
      io: GatewayStartupAcceptedOperationV1,
    ): Promise<void>;
  };
  allocate(kind: "process" | "create-effect" | "audit"): string;
}
export type GatewayStartupTransactionResultV1 =
  | Readonly<{ kind: "committed"; response: GatewayStartupOwnerSuccessV1 }>
  | Readonly<{ kind: "rolled-back"; response: GatewayStartupOwnerFailureV1 }>
  | Readonly<{ kind: "unknown" }>;
export interface GatewayStartupTransactionOwnerV1 {
  /** Original owner alone constructs the unit, runs its sole phase admission and settles COMMIT/rollback/cleanup. */
  run(
    command: GatewayStartupCommandV1,
    bounds: GatewayStartupCommandBoundsV1,
    work: (unit: GatewayStartupOwnerUnitV1) => Promise<GatewayStartupCompletionV1>,
  ): Promise<GatewayStartupTransactionResultV1>;
}

export interface GatewayStartupBackendV2 {
  lockHead(io: GatewayStartupAcceptedOperationV1): Promise<GatewayStartupHeadV2>;
  readHead(io: GatewayStartupAcceptedOperationV1): Promise<GatewayStartupHeadV2 | undefined>;
  findOperation(
    io: GatewayStartupAcceptedOperationV1,
    operationRef: string,
  ): Promise<GatewayStartupMutationEventV2 | undefined>;
  readAcceptance(
    io: GatewayStartupAcceptedOperationV1,
    startup: GatewayStartupOperationLocatorV2,
  ): Promise<GatewayStartupAcceptanceV2 | undefined>;
  findSubmission(
    io: GatewayStartupAcceptedOperationV1,
    startup: GatewayStartupOperationLocatorV2,
  ): Promise<GatewayStartupMutationEventV2 | undefined>;
  findClaim(
    io: GatewayStartupAcceptedOperationV1,
    startup: GatewayStartupOperationLocatorV2,
  ): Promise<GatewayStartupMutationEventV2 | undefined>;
  append(
    io: GatewayStartupAcceptedOperationV1,
    event: GatewayStartupMutationEventV2,
  ): Promise<void>;
  advanceHead(
    io: GatewayStartupAcceptedOperationV1,
    expected: GatewayStartupHeadV2,
    event: GatewayStartupMutationEventV2,
  ): Promise<void>;
  /** Authorized immutable V1 evidence only; this read does not prove physical closure. */
  readLegacyRetirement(
    io: GatewayStartupAcceptedOperationV1,
    startup: GatewayStartupOperationLocatorV1,
    withdrawal: GatewayStartupCommandLocatorV1,
  ): Promise<
    | Readonly<{
        acceptance: GatewayStartupAcceptanceV1;
        withdrawal: GatewayStartupMutationEventV1;
      }>
    | undefined
  >;
}
declare const invocationV2Brand: unique symbol;
export interface GatewayStartupInvocationV2 {
  readonly [invocationV2Brand]: true;
}
export interface GatewayStartupOwnerUnitV2 {
  readonly subject: GatewayStartupSubjectV2;
  readonly phase: GatewayStartupOwnerPhaseV1<GatewayStartupCompletionV2>;
  readonly backend: GatewayStartupBackendV2;
  /** Actual private NativeIAM view/context is consumed only by the original account participant. */
  readonly policy: object;
}
export interface GatewayStartupOwnerParticipantsV2 {
  authority: {
    consume(
      invocation: GatewayStartupInvocationV2,
      command: GatewayStartupCommandV2,
      bounds: GatewayStartupCommandBoundsV1,
      unit: GatewayStartupOwnerUnitV2,
      io: GatewayStartupAcceptedOperationV1,
    ): Promise<GatewayStartupAuthorityLeaseV1>;
  };
  selection: {
    resolveLocked(
      command: GatewayStartupCommandV2,
      original: GatewayStartupAcceptanceV2 | undefined,
      unit: GatewayStartupOwnerUnitV2,
      io: GatewayStartupAcceptedOperationV1,
    ): Promise<
      GatewayStartupOwnerLeaseV1 & {
        readonly selected: Omit<GatewayStartupBindingV2, "startup" | "createEffectRef">;
      }
    >;
  };
  process: {
    requireDisposition(
      command: Extract<GatewayStartupCommandV2, { kind: "accept-startup" }>,
      previous: GatewayStartupAcceptanceV2 | undefined,
      unit: GatewayStartupOwnerUnitV2,
      io: GatewayStartupAcceptedOperationV1,
    ): Promise<
      GatewayStartupOwnerLeaseV1 & {
        readonly predecessor: GatewayStartupPredecessorV2;
      }
    >;
    requireCurrent(
      command: Exclude<GatewayStartupCommandV2, { kind: "accept-startup" | "read-operation" }>,
      acceptance: GatewayStartupAcceptanceV2,
      unit: GatewayStartupOwnerUnitV2,
      io: GatewayStartupAcceptedOperationV1,
    ): Promise<GatewayStartupOwnerLeaseV1>;
  };
  audit: {
    append(
      event: GatewayStartupMutationEventV2,
      attribution: GatewayStartupAuthorityLeaseV1["attribution"],
      unit: GatewayStartupOwnerUnitV2,
      io: GatewayStartupAcceptedOperationV1,
    ): Promise<void>;
  };
  allocate(kind: "process" | "create-effect" | "audit"): string;
}
export type GatewayStartupTransactionResultV2 =
  | Readonly<{ kind: "committed"; response: GatewayStartupOwnerSuccessV2 }>
  | Readonly<{ kind: "rolled-back"; response: GatewayStartupOwnerFailureV2 }>
  | Readonly<{ kind: "unknown" }>;
export interface GatewayStartupTransactionOwnerV2 {
  /** Original owner alone constructs the unit, runs its sole phase admission and settles COMMIT/rollback/cleanup. */
  run(
    command: GatewayStartupCommandV2,
    bounds: GatewayStartupCommandBoundsV1,
    work: (unit: GatewayStartupOwnerUnitV2) => Promise<GatewayStartupCompletionV2>,
  ): Promise<GatewayStartupTransactionResultV2>;
}

function equal(a: unknown, b: unknown): boolean {
  return canonicalGatewayStartupValueV1(a) === canonicalGatewayStartupValueV1(b);
}
function failure(kind: "denied" | "unavailable"): GatewayStartupCompletionV1 {
  return Object.freeze({ kind: "rollback", response: Object.freeze({ kind }) });
}
function expectedMatches(
  expected: GatewayStartupExpectedHeadV1 | null,
  head: GatewayStartupHeadV1,
): boolean {
  return expected === null
    ? head.state === "empty" && head.version === 0
    : expected.version === head.version &&
        expected.recordVersion === head.recordVersion &&
        equal(expected.startup, head.startup);
}
function nextHead(event: GatewayStartupMutationEventV1): GatewayStartupHeadV1 {
  const state =
    event.kind === "accept-startup"
      ? "accepted"
      : event.kind === "submit-create"
        ? "create-submitted"
        : event.kind === "consume-startup"
          ? "consumed"
          : "withdrawn";
  return freeze({
    version: event.afterHeadVersion,
    processGeneration: event.startup.processGeneration,
    latestOperationRef: event.command.operationRef,
    startup: event.startup,
    recordVersion: event.afterRecordVersion,
    state,
  });
}

/** No current participant or transaction owner is defaulted into an accepting capability. */
export function createGatewayStartupOwnerV1(options: {
  transaction?: GatewayStartupTransactionOwnerV1;
  participants?: GatewayStartupOwnerParticipantsV1;
}) {
  const transaction = options.transaction;
  const supplied = options.participants;
  const bind = <T extends (...args: never[]) => unknown>(
    object: object | undefined,
    method: T | undefined,
  ): T | undefined => (typeof method === "function" ? (method.bind(object) as T) : undefined);
  const authority = bind(supplied?.authority, supplied?.authority?.consume);
  const selection = bind(supplied?.selection, supplied?.selection?.resolveLocked);
  const disposition = bind(supplied?.process, supplied?.process?.requireDisposition);
  const current = bind(supplied?.process, supplied?.process?.requireCurrent);
  const audit = bind(supplied?.audit, supplied?.audit?.append);
  const allocate = bind(supplied, supplied?.allocate);
  const participants =
    authority && selection && disposition && current && audit && allocate
      ? Object.freeze({
          authority: Object.freeze({ consume: authority }),
          selection: Object.freeze({ resolveLocked: selection }),
          process: Object.freeze({ requireDisposition: disposition, requireCurrent: current }),
          audit: Object.freeze({ append: audit }),
          allocate,
        })
      : undefined;
  const run = transaction?.run.bind(transaction);
  return Object.freeze({
    async execute(
      input: unknown,
      invocation: GatewayStartupInvocationV1,
      bounds: GatewayStartupCommandBoundsV1,
    ): Promise<GatewayStartupOwnerSuccessV1 | GatewayStartupOwnerFailureV1> {
      let command: GatewayStartupCommandV1;
      try {
        command = parseGatewayStartupCommandV1(input);
        ref(bounds.requestRef);
        if (
          typeof bounds.deadline !== "string" ||
          !Number.isFinite(Date.parse(bounds.deadline)) ||
          !(bounds.signal instanceof AbortSignal) ||
          bounds.signal.aborted
        )
          throw unavailable();
        bounds = Object.freeze({
          requestRef: bounds.requestRef,
          deadline: bounds.deadline,
          signal: bounds.signal,
        });
      } catch {
        return Object.freeze({ kind: "denied" });
      }
      if (
        !run ||
        !participants?.authority ||
        !participants.selection ||
        !participants.process ||
        !participants.audit ||
        typeof participants.allocate !== "function"
      )
        return Object.freeze({ kind: "unavailable" });
      const digest = gatewayStartupCommandDigestV1(command);
      let recovery: GatewayStartupCommandLocatorV1 | undefined;
      let provisional: GatewayStartupOwnerSuccessV1 | undefined;
      const result = await run(command, bounds, async (unit) => {
        const phase = unit.phase;
        const backend = unit.backend;
        const io = <T>(
          label: string,
          body: (scope: GatewayStartupAcceptedOperationV1) => Promise<T>,
        ) => phase.runOperation(label, body);
        const retain = async <T extends GatewayStartupOwnerLeaseV1>(lease: T): Promise<T> => {
          const release = lease.release.bind(lease);
          let retained = false;
          try {
            phase.retainCleanup(release);
            retained = true;
            const assertion = lease.assertCurrent.bind(lease);
            phase.retainCurrentness(assertion);
            const value: unknown = assertion();
            if (value !== undefined) {
              // Invalid async fences remain owned inside this accepted operation before failure.
              await Promise.resolve(value).catch(() => {});
              throw unavailable();
            }
          } catch (error) {
            phase.poison(error);
            if (!retained) {
              try {
                await release();
              } catch (cleanupError) {
                phase.poison(cleanupError);
              }
            }
            throw error;
          }
          return lease;
        };
        return phase.runCommand(async () => {
          try {
            ref(unit.installationId);
            const account = await io("account", async (scope) =>
              retain(
                await participants.authority.consume(invocation, command, bounds, unit, scope),
              ),
            );
            if (account.attribution.requestRef !== bounds.requestRef) return failure("denied");
            ref(account.attribution.actorId);
            ref(account.attribution.decisionRef);
            if (bounds.signal.aborted) return failure("unavailable");
            if (command.kind === "read-operation") {
              if (command.operation.installationId !== unit.installationId)
                return failure("denied");
              const event = await io("historical-operation", (scope) =>
                backend.findOperation(scope, command.operation.operationRef),
              );
              if (event && !equal(event.command, command.operation)) return failure("denied");
              provisional = event
                ? freeze({ kind: "observed", operation: event })
                : freeze({ kind: "not-observed", operation: command.operation });
              return { kind: "commit", provisional };
            }
            const startup =
              command.kind === "accept-startup" ? command.expectedHead?.startup : command.startup;
            if (startup && startup.installationId !== unit.installationId) return failure("denied");
            // Only immutable original identity is read here; lower-order mutable head locks come later.
            const original = startup
              ? await io("original-acceptance", (scope) => backend.readAcceptance(scope, startup))
              : undefined;
            if (startup && !original) return failure("unavailable");
            const selection = await io("selection", async (scope) =>
              retain(await participants.selection.resolveLocked(command, original, unit, scope)),
            );
            const head =
              command.kind === "read-current"
                ? await io("current-head", (scope) => backend.readHead(scope))
                : await io("head", (scope) => backend.lockHead(scope));
            if (!head) return failure("unavailable");
            if (command.kind === "read-current") {
              if (
                head.state !== "consumed" ||
                !equal(head.startup, command.startup) ||
                head.recordVersion !== command.expectedRecordVersion ||
                !original
              )
                return failure("denied");
              const {
                startup: _startup,
                createEffectRef: _effect,
                ...expectedSelection
              } = original.binding;
              if (!equal(selection.selected, expectedSelection)) return failure("denied");
              await io("current-process", async (scope) =>
                retain(await participants.process.requireCurrent(command, original, unit, scope)),
              );
              const submission = await io("submission", (scope) =>
                backend.findSubmission(scope, command.startup),
              );
              const claim = await io("claim", (scope) => backend.findClaim(scope, command.startup));
              if (!submission || !claim || !equal(claim.recipient, command.recipient))
                return failure("denied");
              provisional = freeze({
                kind: "current",
                record: { head, acceptance: original, submission, claim },
              });
              return { kind: "commit", provisional };
            }
            recovery = freeze({
              installationId: unit.installationId,
              operationRef: command.operationRef,
              operationDigest: digest,
              startup: command.kind === "accept-startup" ? null : command.startup,
            });
            const prior = await io("original-command", (scope) =>
              backend.findOperation(scope, command.operationRef),
            );
            if (prior) {
              if (
                prior.canonicalCommand !== canonicalGatewayStartupValueV1(command) ||
                !equal(prior.command, recovery)
              )
                return failure("denied");
              return {
                kind: "rollback",
                response: { kind: "recovery-required", operation: recovery },
              };
            }
            if (!expectedMatches(command.expectedHead, head)) return failure("denied");
            if (
              head.version >= Number.MAX_SAFE_INTEGER ||
              head.recordVersion >= Number.MAX_SAFE_INTEGER
            )
              return failure("unavailable");
            let acceptance: GatewayStartupAcceptanceV1 | null = null;
            let target: GatewayStartupOperationLocatorV1;
            let effect: string;
            let recipientBinding: GatewayStartupRecipientBindingV1 | null = null;
            let submissionInput: GatewayProcessCreateInputV1 | null = null;
            let reason: GatewayStartupMutationEventV1["withdrawalReason"] = null;
            let beforeRecord = head.recordVersion;
            let afterRecord = beforeRecord + 1;
            let auditEventId: string;
            if (command.kind === "accept-startup") {
              if (head.state !== "empty" && head.state !== "withdrawn") return failure("denied");
              if (head.processGeneration >= Number.MAX_SAFE_INTEGER) return failure("unavailable");
              const disposition = await io("predecessor-disposition", async (scope) =>
                retain(
                  await participants.process.requireDisposition(command, original, unit, scope),
                ),
              );
              if (
                !equal(disposition.predecessor.disposition, command.predecessorDisposition) ||
                !equal(disposition.predecessor.previousStartup, head.startup)
              )
                return failure("denied");
              if (!equal(selection.selected.selection, command.selectedDefinition))
                return failure("denied");
              const processRef = participants.allocate("process");
              effect = participants.allocate("create-effect");
              ref(processRef);
              ref(effect);
              target = freeze({
                installationId: unit.installationId,
                processRef,
                processGeneration: head.processGeneration + 1,
                operationRef: command.operationRef,
                operationDigest: digest,
              });
              const binding = parseGatewayStartupBindingV1({
                ...selection.selected,
                startup: target,
                createEffectRef: effect,
              });
              if (!equal(binding.selection, command.selectedDefinition)) return failure("denied");
              auditEventId = participants.allocate("audit");
              ref(auditEventId);
              acceptance = freeze({ binding, predecessor: disposition.predecessor, auditEventId });
              beforeRecord = 0;
              afterRecord = 1;
            } else {
              if (
                !original ||
                !equal(head.startup, command.startup) ||
                head.state === "withdrawn" ||
                head.state === "empty"
              )
                return failure("denied");
              const {
                startup: _startup,
                createEffectRef: _effect,
                ...expectedSelection
              } = original.binding;
              if (!equal(selection.selected, expectedSelection)) return failure("denied");
              target = command.startup;
              effect = original.binding.createEffectRef;
              await io("current-process", async (scope) =>
                retain(await participants.process.requireCurrent(command, original, unit, scope)),
              );
              if (command.kind === "submit-create") {
                if (
                  head.state !== "accepted" ||
                  head.recordVersion !== 1 ||
                  !equal(command.input.binding, original.binding) ||
                  (await io("existing-submission", (scope) =>
                    backend.findSubmission(scope, target),
                  ))
                )
                  return failure("denied");
                submissionInput = command.input;
              } else if (command.kind === "consume-startup") {
                if (
                  head.state !== "create-submitted" ||
                  head.recordVersion !== 2 ||
                  (await io("existing-claim", (scope) => backend.findClaim(scope, target)))
                )
                  return failure("denied");
                const submission = await io("retained-submission", (scope) =>
                  backend.findSubmission(scope, target),
                );
                if (!submission) return failure("unavailable");
                recipientBinding = command.recipient;
              } else {
                reason = command.reason;
              }
              auditEventId = participants.allocate("audit");
              ref(auditEventId);
            }
            const event: GatewayStartupMutationEventV1 = freeze({
              kind: command.kind,
              command: recovery,
              canonicalCommand: canonicalGatewayStartupValueV1(command),
              beforeHeadVersion: head.version,
              afterHeadVersion: head.version + 1,
              beforeRecordVersion: beforeRecord,
              afterRecordVersion: afterRecord,
              previousOperationRef: head.latestOperationRef,
              startup: target,
              createEffectRef: effect,
              acceptance,
              submissionInput,
              recipient: recipientBinding,
              withdrawalReason: reason,
              auditEventId,
            });
            await io("mandatory-audit", (scope) =>
              participants.audit.append(event, account.attribution, unit, scope),
            );
            await io("append", (scope) => backend.append(scope, event));
            await io("advance", (scope) => backend.advanceHead(scope, head, event));
            const after = nextHead(event);
            if (command.kind === "accept-startup")
              provisional = freeze({ kind: "accepted", record: acceptance!, head: after });
            else if (command.kind === "submit-create")
              provisional = freeze({ kind: "submitted", event });
            else if (command.kind === "withdraw")
              provisional = freeze({ kind: "withdrawn", startup: target, head: after });
            else {
              const submission = await io("accepted-submission", (scope) =>
                backend.findSubmission(scope, target),
              );
              provisional = freeze({
                kind: "consumed",
                record: {
                  head: after,
                  acceptance: original!,
                  submission: submission ?? null,
                  claim: event,
                },
              });
            }
            if (bounds.signal.aborted) return failure("unavailable");
            return { kind: "commit", provisional };
          } catch (error) {
            phase.poison(error);
            throw error;
          }
        });
      }).catch(() => ({ kind: "unknown" as const }));
      if (result.kind === "committed" && provisional && equal(result.response, provisional))
        return freeze(result.response);
      if (result.kind === "rolled-back") return freeze(result.response);
      return recovery
        ? freeze({ kind: "recovery-required", operation: recovery })
        : freeze({ kind: "unavailable" });
    },
  });
}

export function parseGatewayStartupEventV1(value: unknown): GatewayStartupMutationEventV1 {
  const e: unknown = JSON.parse(canonicalGatewayStartupValueV1(value));
  exact(e, [
    "kind",
    "command",
    "canonicalCommand",
    "beforeHeadVersion",
    "afterHeadVersion",
    "beforeRecordVersion",
    "afterRecordVersion",
    "previousOperationRef",
    "startup",
    "createEffectRef",
    "acceptance",
    "submissionInput",
    "recipient",
    "withdrawalReason",
    "auditEventId",
  ]);
  exact(e.command, ["installationId", "operationRef", "operationDigest", "startup"]);
  locator(e.startup);
  ref(e.createEffectRef);
  ref(e.auditEventId);
  ref(e.command.installationId);
  ref(e.command.operationRef);
  if (e.command.startup !== null) locator(e.command.startup);
  if (e.previousOperationRef !== null) ref(e.previousOperationRef);
  if (typeof e.canonicalCommand !== "string") throw unavailable();
  const command = parseGatewayStartupCommandV1(JSON.parse(e.canonicalCommand));
  if (
    !("operationRef" in command) ||
    command.kind !== e.kind ||
    command.operationRef !== e.command.operationRef ||
    canonicalGatewayStartupValueV1(command) !== e.canonicalCommand ||
    gatewayStartupCommandDigestV1(command) !== e.command.operationDigest
  )
    throw unavailable();
  const target = e.startup as unknown as GatewayStartupOperationLocatorV1;
  if (
    e.command.installationId !== target.installationId ||
    (command.kind === "accept-startup"
      ? e.command.startup !== null
      : !equal(e.command.startup, target))
  )
    throw unavailable();
  for (const key of ["beforeHeadVersion", "beforeRecordVersion"])
    if (!Number.isSafeInteger(e[key]) || (e[key] as number) < 0) throw unavailable();
  version(e.afterHeadVersion);
  version(e.afterRecordVersion);
  if (
    e.afterHeadVersion !== (e.beforeHeadVersion as number) + 1 ||
    (e.previousOperationRef === null) !== (e.beforeHeadVersion === 0)
  )
    throw unavailable();
  if (command.expectedHead === null) {
    if (command.kind !== "accept-startup" || e.beforeHeadVersion !== 0) throw unavailable();
  } else if (
    command.expectedHead.version !== e.beforeHeadVersion ||
    (command.kind !== "accept-startup" &&
      (command.expectedHead.recordVersion !== e.beforeRecordVersion ||
        !equal(command.expectedHead.startup, target)))
  )
    throw unavailable();
  if (e.kind === "accept-startup") {
    exact(e.acceptance, ["binding", "predecessor", "auditEventId"]);
    const binding = parseGatewayStartupBindingV1(e.acceptance.binding);
    exact(e.acceptance.predecessor, [
      "disposition",
      "previousStartup",
      "processOwner",
      "settlement",
    ]);
    for (const k of ["disposition", "processOwner", "settlement"])
      recordRef(e.acceptance.predecessor[k]);
    if (e.acceptance.predecessor.previousStartup !== null)
      locator(e.acceptance.predecessor.previousStartup);
    if (
      command.kind !== "accept-startup" ||
      !equal(binding.selection, command.selectedDefinition) ||
      !equal(e.acceptance.predecessor.disposition, command.predecessorDisposition) ||
      !equal(e.acceptance.predecessor.previousStartup, command.expectedHead?.startup ?? null)
    )
      throw unavailable();
    if (
      e.acceptance.auditEventId !== e.auditEventId ||
      !equal(binding.startup, target) ||
      binding.createEffectRef !== e.createEffectRef ||
      target.operationRef !== e.command.operationRef ||
      target.operationDigest !== e.command.operationDigest ||
      e.beforeRecordVersion !== 0 ||
      e.afterRecordVersion !== 1 ||
      e.submissionInput !== null ||
      e.recipient !== null ||
      e.withdrawalReason !== null
    )
      throw unavailable();
  } else {
    if (
      command.kind === "accept-startup" ||
      e.acceptance !== null ||
      e.afterRecordVersion !== (e.beforeRecordVersion as number) + 1 ||
      !equal(command.startup, target)
    )
      throw unavailable();
    if (e.kind === "submit-create") {
      createInput(e.submissionInput);
      if (
        command.kind !== "submit-create" ||
        !equal(e.submissionInput, command.input) ||
        !equal(command.input.binding.startup, target) ||
        command.input.binding.createEffectRef !== e.createEffectRef ||
        e.beforeRecordVersion !== 1 ||
        e.afterRecordVersion !== 2 ||
        e.recipient !== null ||
        e.withdrawalReason !== null
      )
        throw unavailable();
    } else if (e.kind === "consume-startup") {
      recipient(e.recipient);
      if (
        command.kind !== "consume-startup" ||
        !equal(e.recipient, command.recipient) ||
        e.beforeRecordVersion !== 2 ||
        e.afterRecordVersion !== 3 ||
        e.submissionInput !== null ||
        e.withdrawalReason !== null
      )
        throw unavailable();
    } else if (e.kind === "withdraw") {
      if (
        command.kind !== "withdraw" ||
        e.withdrawalReason !== command.reason ||
        ![1, 2, 3].includes(e.beforeRecordVersion as number) ||
        e.submissionInput !== null ||
        e.recipient !== null
      )
        throw unavailable();
    } else throw unavailable();
  }
  return freeze(e) as unknown as GatewayStartupMutationEventV1;
}

/** Borrowed from the genuine protected process call owner; its lifetime remains with that owner. */
export interface GatewayStartupSubmissionEnrollmentV1 {
  readonly command: Extract<GatewayStartupCommandV1, { kind: "submit-create" }>;
  readonly invocation: GatewayStartupInvocationV1;
  readonly bounds: GatewayStartupCommandBoundsV1;
  assertCurrent(): undefined;
}
export interface GatewayStartupSubmissionSourceV1 {
  /** Authenticate exact call/method/input and recover the original command identity, never allocate a retry. */
  resolve(
    input: GatewayProcessCreateInputV1,
    call: GatewayProcessCallV1,
  ): Promise<GatewayStartupSubmissionEnrollmentV1 | undefined>;
}

/**
 * A ticket exists only after this exact owner's newly committed submit-create.
 * TODO(Installation startup): compose the authentic call source and original transaction owner.
 * Neither public brands, a retained submit row nor an unknown COMMIT creates a ticket.
 */
export function createGatewayStartupSubmissionOwnerV1(
  owner: ReturnType<typeof createGatewayStartupOwnerV1>,
  source?: GatewayStartupSubmissionSourceV1,
): GatewayProcessSubmissionOwnerV1 {
  const execute = owner.execute.bind(owner);
  const resolve = source?.resolve.bind(source);
  const tickets = new WeakMap<
    GatewayProcessSubmissionV1,
    {
      readonly input: string;
      readonly call: GatewayProcessCallV1;
      readonly assertCurrent: () => undefined;
      used: boolean;
    }
  >();
  const assertSynchronous = (assertion: () => undefined) => {
    const value: unknown = assertion();
    if (value !== undefined) {
      void Promise.resolve(value).catch(() => {});
      throw unavailable();
    }
  };
  const provider: GatewayProcessSubmissionOwnerV1 = {
    async claimOriginal(input, call) {
      let captured: GatewayProcessCreateInputV1;
      try {
        captured = JSON.parse(canonicalGatewayStartupValueV1(input));
        createInput(captured);
        freeze(captured);
      } catch {
        return Object.freeze({ kind: "denied" as const });
      }
      if (!resolve) return Object.freeze({ kind: "unavailable" as const });
      try {
        const enrollment = await resolve(captured, call);
        if (!enrollment) return Object.freeze({ kind: "unavailable" as const });
        const assertion = enrollment.assertCurrent.bind(enrollment);
        assertSynchronous(assertion);
        const command = parseGatewayStartupCommandV1(enrollment.command);
        if (
          command.kind !== "submit-create" ||
          !equal(command.input, captured) ||
          !equal(command.startup, captured.binding.startup)
        )
          return Object.freeze({ kind: "denied" as const });
        const result = await execute(command, enrollment.invocation, enrollment.bounds);
        if (result.kind === "recovery-required")
          return freeze({ kind: "unknown" as const, operation: captured.binding.startup });
        if (result.kind === "denied" || result.kind === "unavailable")
          return freeze({ kind: result.kind });
        if (result.kind !== "submitted" || !equal(result.event.submissionInput, captured))
          return freeze({ kind: "unknown" as const, operation: captured.binding.startup });
        assertSynchronous(assertion);
        const ticket = Object.freeze({}) as GatewayProcessSubmissionV1;
        tickets.set(ticket, {
          input: canonicalGatewayStartupValueV1(captured),
          call,
          assertCurrent: assertion,
          used: false,
        });
        return Object.freeze({ kind: "claimed" as const, submission: ticket });
      } catch {
        return freeze({ kind: "unknown" as const, operation: captured.binding.startup });
      }
    },
    consumeSubmission(submission, input, call) {
      const state = tickets.get(submission);
      if (!state || state.used) throw unavailable();
      state.used = true;
      if (state.call !== call || state.input !== canonicalGatewayStartupValueV1(input))
        throw unavailable();
      assertSynchronous(state.assertCurrent);
      return undefined;
    },
  };
  return Object.freeze(provider);
}

function subjectV2(value: unknown): asserts value is GatewayStartupSubjectV2 {
  exact(value, ["kind", "installationId", "namespaceRef", "agentRef"]);
  if (value.kind !== "agent-gateway") throw unavailable();
  ref(value.installationId);
  ref(value.namespaceRef);
  ref(value.agentRef);
}
export function parseGatewayStartupSubjectV2(value: unknown): GatewayStartupSubjectV2 {
  const copy: unknown = JSON.parse(canonicalGatewayStartupValueV1(value));
  subjectV2(copy);
  return freeze(copy);
}
function locatorV2(value: unknown): asserts value is GatewayStartupOperationLocatorV2 {
  exact(value, [
    "schemaVersion",
    "subject",
    "processRef",
    "processGeneration",
    "operationRef",
    "operationDigest",
  ]);
  if (value.schemaVersion !== 2) throw unavailable();
  subjectV2(value.subject);
  ref(value.processRef);
  version(value.processGeneration);
  ref(value.operationRef);
  if (typeof value.operationDigest !== "string" || !/^[0-9a-f]{64}$/u.test(value.operationDigest))
    throw unavailable();
}
function expectedHeadV2(value: unknown): void {
  exact(value, ["version", "startup", "recordVersion"]);
  version(value.version);
  locatorV2(value.startup);
  version(value.recordVersion);
}
function commandLocatorV2(value: unknown): asserts value is GatewayStartupCommandLocatorV2 {
  exact(value, ["schemaVersion", "subject", "operationRef", "operationDigest", "startup"]);
  if (value.schemaVersion !== 2) throw unavailable();
  subjectV2(value.subject);
  ref(value.operationRef);
  if (typeof value.operationDigest !== "string" || !/^[0-9a-f]{64}$/u.test(value.operationDigest))
    throw unavailable();
  if (value.startup !== null) {
    locatorV2(value.startup);
    if (!equal(value.subject, value.startup.subject)) throw unavailable();
  }
}
function selectionV2(value: unknown): void {
  if (decodeWorkloadProfileSelectionV1(value).kind !== "valid") throw unavailable();
}
function predecessorV2(
  value: unknown,
  target: GatewayStartupSubjectV2,
  previous: GatewayStartupOperationLocatorV2 | null,
): asserts value is GatewayStartupPredecessorV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw unavailable();
  const kind = (value as Record<string, unknown>).kind;
  exact(value, [
    "kind",
    "disposition",
    "previousStartup",
    "processOwner",
    "settlement",
    ...(kind === "retired-installation" ? ["historicalWithdrawal"] : []),
  ]);
  for (const k of ["disposition", "processOwner", "settlement"]) recordRef(value[k]);
  if (kind === "complete-initial") {
    if (previous !== null || value.previousStartup !== null) throw unavailable();
  } else if (kind === "retired-agent") {
    locatorV2(value.previousStartup);
    if (
      previous === null ||
      !equal(previous, value.previousStartup) ||
      !equal(value.previousStartup.subject, target)
    )
      throw unavailable();
  } else if (kind === "retired-installation") {
    if (previous !== null) throw unavailable();
    locator(value.previousStartup);
    const old = value.previousStartup as GatewayStartupOperationLocatorV1;
    exact(value.historicalWithdrawal, [
      "installationId",
      "operationRef",
      "operationDigest",
      "startup",
    ]);
    const withdrawal = value.historicalWithdrawal;
    ref(withdrawal.operationRef);
    if (
      old.installationId !== target.installationId ||
      withdrawal.installationId !== target.installationId ||
      !equal(withdrawal.startup, old) ||
      typeof withdrawal.operationDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(withdrawal.operationDigest)
    )
      throw unavailable();
  } else throw unavailable();
}
export function parseGatewayStartupBindingV2(value: unknown): GatewayStartupBindingV2 {
  const copy: unknown = JSON.parse(canonicalGatewayStartupValueV1(value));
  exact(copy, [
    "schemaVersion",
    "profileRefs",
    "admittedConfigurationDigest",
    "startup",
    "createEffectRef",
    "selection",
    "configurationRef",
    "configurationVersion",
    "profileRef",
    "profileVersion",
    "namespaceRef",
    "agentRef",
    "admittedRevisionRef",
    "gatewayAssignmentRef",
    "hostRuntimeGeneration",
    "nativeConfigRef",
    "configDigest",
    "stateOwnership",
    "stateSchemaVersion",
    "agentSchemaVersion",
    "protocolVersion",
    "modules",
    "startupDeadlineMs",
    "shutdownDeadlineMs",
  ]);
  if (copy.schemaVersion !== 2) throw unavailable();
  locatorV2(copy.startup);
  selectionV2(copy.selection);
  if (
    copy.namespaceRef !== copy.startup.subject.namespaceRef ||
    copy.agentRef !== copy.startup.subject.agentRef
  )
    throw unavailable();
  // Validate the shared original role/scope grammar only; no V1 use or authority is issued.
  if (
    decodeWorkloadProfileUseV1({
      schemaVersion: 1,
      component: "harness",
      installationId: copy.startup.subject.installationId,
      namespaceId: copy.namespaceRef,
      canonicalFormat: "oce.workload-profile.canonical-json.v1",
      ...(copy.selection as WorkloadProfileSelectionV1),
      profileRefs: copy.profileRefs,
      admittedConfigurationDigest: copy.admittedConfigurationDigest,
    }).kind !== "valid"
  )
    throw unavailable();
  recordRef(copy.stateOwnership);
  for (const key of [
    "createEffectRef",
    "configurationRef",
    "profileRef",
    "namespaceRef",
    "agentRef",
    "admittedRevisionRef",
    "gatewayAssignmentRef",
    "nativeConfigRef",
    "configDigest",
  ])
    ref(copy[key]);
  for (const key of [
    "configurationVersion",
    "profileVersion",
    "hostRuntimeGeneration",
    "stateSchemaVersion",
    "agentSchemaVersion",
    "protocolVersion",
    "startupDeadlineMs",
    "shutdownDeadlineMs",
  ])
    version(copy[key]);
  if (!Array.isArray(copy.modules) || copy.modules.length < 1 || copy.modules.length > 32)
    throw unavailable();
  const ids = new Set<string>();
  for (const module of copy.modules) {
    exact(module, ["id", "kind", "profileRef", "requiredCapabilities"]);
    ref(module.id);
    ref(module.profileRef);
    if (
      !["identity", "channel", "harness", "persistence"].includes(String(module.kind)) ||
      ids.has(module.id)
    )
      throw unavailable();
    ids.add(module.id);
    if (!Array.isArray(module.requiredCapabilities) || module.requiredCapabilities.length > 64)
      throw unavailable();
    const caps = new Set<string>();
    for (const capability of module.requiredCapabilities) {
      ref(capability);
      if (caps.has(capability)) throw unavailable();
      caps.add(capability);
    }
  }
  return freeze(copy) as GatewayStartupBindingV2;
}
function createInputV2(value: unknown): void {
  exact(value, ["binding", "target", "launchPlan"]);
  parseGatewayStartupBindingV2(value.binding);
  recordRef(value.launchPlan);
  exact(value.target, ["clusterRef", "namespace", "deploymentName"]);
  ref(value.target.clusterRef);
  ref(value.target.deploymentName);
  exact(value.target.namespace, ["name", "uid", "resourceVersion"]);
  for (const field of Object.values(value.target.namespace)) ref(field);
}
export function parseGatewayStartupCommandV2(value: unknown): GatewayStartupCommandV2 {
  const copy: unknown = JSON.parse(canonicalGatewayStartupValueV1(value));
  if (typeof copy !== "object" || copy === null || Array.isArray(copy)) throw unavailable();
  const c = copy as Record<string, unknown>;
  if (c.schemaVersion !== 2) throw unavailable();
  subjectV2(c.subject);
  switch (c.kind) {
    case "accept-startup":
      exact(c, [
        "schemaVersion",
        "subject",
        "kind",
        "operationRef",
        "expectedHead",
        "selectedDefinition",
        "predecessorDisposition",
      ]);
      ref(c.operationRef);
      if (c.expectedHead !== null) expectedHeadV2(c.expectedHead);
      selectionV2(c.selectedDefinition);
      recordRef(c.predecessorDisposition);
      break;
    case "submit-create":
      exact(c, [
        "schemaVersion",
        "subject",
        "kind",
        "operationRef",
        "startup",
        "expectedHead",
        "input",
      ]);
      ref(c.operationRef);
      locatorV2(c.startup);
      expectedHeadV2(c.expectedHead);
      createInputV2(c.input);
      break;
    case "consume-startup":
      exact(c, [
        "schemaVersion",
        "subject",
        "kind",
        "operationRef",
        "startup",
        "expectedHead",
        "recipient",
      ]);
      ref(c.operationRef);
      locatorV2(c.startup);
      expectedHeadV2(c.expectedHead);
      recipient(c.recipient);
      break;
    case "withdraw":
      exact(c, [
        "schemaVersion",
        "subject",
        "kind",
        "operationRef",
        "startup",
        "expectedHead",
        "reason",
      ]);
      ref(c.operationRef);
      locatorV2(c.startup);
      expectedHeadV2(c.expectedHead);
      if (
        !["administrative", "selection-withdrawn", "recipient-revoked"].includes(String(c.reason))
      )
        throw unavailable();
      break;
    case "read-current":
      exact(c, [
        "schemaVersion",
        "subject",
        "kind",
        "startup",
        "expectedRecordVersion",
        "recipient",
      ]);
      locatorV2(c.startup);
      version(c.expectedRecordVersion);
      recipient(c.recipient);
      break;
    case "read-operation":
      exact(c, ["schemaVersion", "subject", "kind", "operation"]);
      commandLocatorV2(c.operation);
      if (!equal(c.operation.subject, c.subject)) throw unavailable();
      break;
    default:
      throw unavailable();
  }
  const checked = copy as GatewayStartupCommandV2;
  if ("startup" in checked && !equal(checked.startup.subject, checked.subject)) throw unavailable();
  if (
    "expectedHead" in checked &&
    checked.expectedHead &&
    !equal(checked.expectedHead.startup.subject, checked.subject)
  )
    throw unavailable();
  if (
    checked.kind === "submit-create" &&
    (!equal(checked.input.binding.startup, checked.startup) ||
      !equal(checked.expectedHead.startup, checked.startup))
  )
    throw unavailable();
  return freeze(checked);
}
export function gatewayStartupCommandDigestV2(command: GatewayStartupCommandV2): string {
  return createHash("sha256")
    .update(
      canonicalGatewayStartupValueV1({
        domain: "oce.agent-gateway.startup-operation.v2",
        command,
      }),
    )
    .digest("hex");
}

export function parseGatewayStartupEventV2(value: unknown): GatewayStartupMutationEventV2 {
  const e: unknown = JSON.parse(canonicalGatewayStartupValueV1(value));
  exact(e, [
    "schemaVersion",
    "kind",
    "command",
    "canonicalCommand",
    "beforeHeadVersion",
    "afterHeadVersion",
    "beforeRecordVersion",
    "afterRecordVersion",
    "previousOperationRef",
    "startup",
    "createEffectRef",
    "acceptance",
    "submissionInput",
    "recipient",
    "withdrawalReason",
    "auditEventId",
  ]);
  if (e.schemaVersion !== 2) throw unavailable();
  commandLocatorV2(e.command);
  locatorV2(e.startup);
  ref(e.createEffectRef);
  ref(e.auditEventId);
  ref(e.command.operationRef);
  if (e.command.startup !== null) locatorV2(e.command.startup);
  if (e.previousOperationRef !== null) ref(e.previousOperationRef);
  if (typeof e.canonicalCommand !== "string") throw unavailable();
  const command = parseGatewayStartupCommandV2(JSON.parse(e.canonicalCommand));
  if (
    !("operationRef" in command) ||
    command.kind !== e.kind ||
    command.operationRef !== e.command.operationRef ||
    canonicalGatewayStartupValueV1(command) !== e.canonicalCommand ||
    gatewayStartupCommandDigestV2(command) !== e.command.operationDigest
  )
    throw unavailable();
  const target = e.startup as unknown as GatewayStartupOperationLocatorV2;
  if (
    !equal(e.command.subject, target.subject) ||
    !equal(command.subject, target.subject) ||
    (command.kind === "accept-startup"
      ? e.command.startup !== null
      : !equal(e.command.startup, target))
  )
    throw unavailable();
  for (const key of ["beforeHeadVersion", "beforeRecordVersion"])
    if (!Number.isSafeInteger(e[key]) || (e[key] as number) < 0) throw unavailable();
  version(e.afterHeadVersion);
  version(e.afterRecordVersion);
  if (
    e.afterHeadVersion !== (e.beforeHeadVersion as number) + 1 ||
    (e.previousOperationRef === null) !== (e.beforeHeadVersion === 0)
  )
    throw unavailable();
  if (command.expectedHead === null) {
    if (command.kind !== "accept-startup" || e.beforeHeadVersion !== 0) throw unavailable();
  } else if (
    command.expectedHead.version !== e.beforeHeadVersion ||
    (command.kind !== "accept-startup" &&
      (command.expectedHead.recordVersion !== e.beforeRecordVersion ||
        !equal(command.expectedHead.startup, target)))
  )
    throw unavailable();
  if (e.kind === "accept-startup") {
    exact(e.acceptance, ["binding", "predecessor", "auditEventId"]);
    const binding = parseGatewayStartupBindingV2(e.acceptance.binding);
    if (command.kind !== "accept-startup") throw unavailable();
    predecessorV2(e.acceptance.predecessor, target.subject, command.expectedHead?.startup ?? null);
    if (
      command.kind !== "accept-startup" ||
      !equal(binding.selection, command.selectedDefinition) ||
      !equal(e.acceptance.predecessor.disposition, command.predecessorDisposition)
    )
      throw unavailable();
    if (
      e.acceptance.auditEventId !== e.auditEventId ||
      !equal(binding.startup, target) ||
      binding.createEffectRef !== e.createEffectRef ||
      target.operationRef !== e.command.operationRef ||
      target.operationDigest !== e.command.operationDigest ||
      e.beforeRecordVersion !== 0 ||
      e.afterRecordVersion !== 1 ||
      e.submissionInput !== null ||
      e.recipient !== null ||
      e.withdrawalReason !== null
    )
      throw unavailable();
  } else {
    if (
      command.kind === "accept-startup" ||
      e.acceptance !== null ||
      e.afterRecordVersion !== (e.beforeRecordVersion as number) + 1 ||
      !equal(command.startup, target)
    )
      throw unavailable();
    if (e.kind === "submit-create") {
      createInputV2(e.submissionInput);
      if (
        command.kind !== "submit-create" ||
        !equal(e.submissionInput, command.input) ||
        !equal(command.input.binding.startup, target) ||
        command.input.binding.createEffectRef !== e.createEffectRef ||
        e.beforeRecordVersion !== 1 ||
        e.afterRecordVersion !== 2 ||
        e.recipient !== null ||
        e.withdrawalReason !== null
      )
        throw unavailable();
    } else if (e.kind === "consume-startup") {
      recipient(e.recipient);
      if (
        command.kind !== "consume-startup" ||
        !equal(e.recipient, command.recipient) ||
        e.beforeRecordVersion !== 2 ||
        e.afterRecordVersion !== 3 ||
        e.submissionInput !== null ||
        e.withdrawalReason !== null
      )
        throw unavailable();
    } else if (e.kind === "withdraw") {
      if (
        command.kind !== "withdraw" ||
        e.withdrawalReason !== command.reason ||
        ![1, 2, 3].includes(e.beforeRecordVersion as number) ||
        e.submissionInput !== null ||
        e.recipient !== null
      )
        throw unavailable();
    } else throw unavailable();
  }
  return freeze(e) as unknown as GatewayStartupMutationEventV2;
}

function failureV2(kind: "denied" | "unavailable"): GatewayStartupCompletionV2 {
  return Object.freeze({ kind: "rollback", response: Object.freeze({ kind }) });
}
function expectedMatchesV2(
  expected: GatewayStartupExpectedHeadV2 | null,
  head: GatewayStartupHeadV2,
): boolean {
  return expected === null
    ? head.state === "empty" && head.version === 0
    : expected.version === head.version &&
        expected.recordVersion === head.recordVersion &&
        equal(expected.startup, head.startup);
}
function nextHeadV2(event: GatewayStartupMutationEventV2): GatewayStartupHeadV2 {
  const state =
    event.kind === "accept-startup"
      ? "accepted"
      : event.kind === "submit-create"
        ? "create-submitted"
        : event.kind === "consume-startup"
          ? "consumed"
          : "withdrawn";
  return freeze({
    subject: event.command.subject,
    version: event.afterHeadVersion,
    processGeneration: event.startup.processGeneration,
    latestOperationRef: event.command.operationRef,
    startup: event.startup,
    recordVersion: event.afterRecordVersion,
    state,
  });
}

/** No current participant or transaction owner is defaulted into an accepting capability. */
export function createGatewayStartupOwnerV2(options: {
  transaction?: GatewayStartupTransactionOwnerV2;
  participants?: GatewayStartupOwnerParticipantsV2;
}) {
  const transaction = options.transaction;
  const supplied = options.participants;
  const bind = <T extends (...args: never[]) => unknown>(
    object: object | undefined,
    method: T | undefined,
  ): T | undefined => (typeof method === "function" ? (method.bind(object) as T) : undefined);
  const authority = bind(supplied?.authority, supplied?.authority?.consume);
  const selection = bind(supplied?.selection, supplied?.selection?.resolveLocked);
  const disposition = bind(supplied?.process, supplied?.process?.requireDisposition);
  const current = bind(supplied?.process, supplied?.process?.requireCurrent);
  const audit = bind(supplied?.audit, supplied?.audit?.append);
  const allocate = bind(supplied, supplied?.allocate);
  const participants =
    authority && selection && disposition && current && audit && allocate
      ? Object.freeze({
          authority: Object.freeze({ consume: authority }),
          selection: Object.freeze({ resolveLocked: selection }),
          process: Object.freeze({ requireDisposition: disposition, requireCurrent: current }),
          audit: Object.freeze({ append: audit }),
          allocate,
        })
      : undefined;
  const run = transaction?.run.bind(transaction);
  return Object.freeze({
    async execute(
      input: unknown,
      invocation: GatewayStartupInvocationV2,
      bounds: GatewayStartupCommandBoundsV1,
    ): Promise<GatewayStartupOwnerSuccessV2 | GatewayStartupOwnerFailureV2> {
      let command: GatewayStartupCommandV2;
      try {
        command = parseGatewayStartupCommandV2(input);
        ref(bounds.requestRef);
        if (
          typeof bounds.deadline !== "string" ||
          !Number.isFinite(Date.parse(bounds.deadline)) ||
          !(bounds.signal instanceof AbortSignal) ||
          bounds.signal.aborted
        )
          throw unavailable();
        bounds = Object.freeze({
          requestRef: bounds.requestRef,
          deadline: bounds.deadline,
          signal: bounds.signal,
        });
      } catch {
        return Object.freeze({ kind: "denied" });
      }
      if (
        !run ||
        !participants?.authority ||
        !participants.selection ||
        !participants.process ||
        !participants.audit ||
        typeof participants.allocate !== "function"
      )
        return Object.freeze({ kind: "unavailable" });
      const digest = gatewayStartupCommandDigestV2(command);
      let recovery: GatewayStartupCommandLocatorV2 | undefined;
      let provisional: GatewayStartupOwnerSuccessV2 | undefined;
      const result = await run(command, bounds, async (unit) => {
        const phase = unit.phase;
        const backend = unit.backend;
        const io = <T>(
          label: string,
          body: (scope: GatewayStartupAcceptedOperationV1) => Promise<T>,
        ) => phase.runOperation(label, body);
        const retain = async <T extends GatewayStartupOwnerLeaseV1>(lease: T): Promise<T> => {
          const release = lease.release.bind(lease);
          let retained = false;
          try {
            phase.retainCleanup(release);
            retained = true;
            const assertion = lease.assertCurrent.bind(lease);
            phase.retainCurrentness(assertion);
            const value: unknown = assertion();
            if (value !== undefined) {
              // Invalid async fences remain owned inside this accepted operation before failure.
              await Promise.resolve(value).catch(() => {});
              throw unavailable();
            }
          } catch (error) {
            phase.poison(error);
            if (!retained) {
              try {
                await release();
              } catch (cleanupError) {
                phase.poison(cleanupError);
              }
            }
            throw error;
          }
          return lease;
        };
        return phase.runCommand(async () => {
          try {
            subjectV2(unit.subject);
            if (!equal(unit.subject, command.subject)) return failureV2("denied");
            const account = await io("account", async (scope) =>
              retain(
                await participants.authority.consume(invocation, command, bounds, unit, scope),
              ),
            );
            if (account.attribution.requestRef !== bounds.requestRef) return failureV2("denied");
            ref(account.attribution.actorId);
            ref(account.attribution.decisionRef);
            if (bounds.signal.aborted) return failureV2("unavailable");
            if (command.kind === "read-operation") {
              if (!equal(command.operation.subject, unit.subject)) return failureV2("denied");
              const event = await io("historical-operation", (scope) =>
                backend.findOperation(scope, command.operation.operationRef),
              );
              if (event && !equal(event.command, command.operation)) return failureV2("denied");
              provisional = event
                ? freeze({ kind: "observed", operation: event })
                : freeze({ kind: "not-observed", operation: command.operation });
              return { kind: "commit", provisional };
            }
            const startup =
              command.kind === "accept-startup" ? command.expectedHead?.startup : command.startup;
            if (startup && !equal(startup.subject, unit.subject)) return failureV2("denied");
            // Only immutable original identity is read here; lower-order mutable head locks come later.
            const original = startup
              ? await io("original-acceptance", (scope) => backend.readAcceptance(scope, startup))
              : undefined;
            if (startup && !original) return failureV2("unavailable");
            const selection = await io("selection", async (scope) =>
              retain(await participants.selection.resolveLocked(command, original, unit, scope)),
            );
            const head =
              command.kind === "read-current"
                ? await io("current-head", (scope) => backend.readHead(scope))
                : await io("head", (scope) => backend.lockHead(scope));
            if (!head || !equal(head.subject, unit.subject)) return failureV2("unavailable");
            if (command.kind === "read-current") {
              if (
                head.state !== "consumed" ||
                !equal(head.startup, command.startup) ||
                head.recordVersion !== command.expectedRecordVersion ||
                !original
              )
                return failureV2("denied");
              const {
                startup: _startup,
                createEffectRef: _effect,
                ...expectedSelection
              } = original.binding;
              if (!equal(selection.selected, expectedSelection)) return failureV2("denied");
              await io("current-process", async (scope) =>
                retain(await participants.process.requireCurrent(command, original, unit, scope)),
              );
              const submission = await io("submission", (scope) =>
                backend.findSubmission(scope, command.startup),
              );
              const claim = await io("claim", (scope) => backend.findClaim(scope, command.startup));
              if (
                !submission ||
                !claim ||
                submission.previousOperationRef !== original.binding.startup.operationRef ||
                claim.previousOperationRef !== submission.command.operationRef ||
                !equal(claim.recipient, command.recipient)
              )
                return failureV2("denied");
              provisional = freeze({
                kind: "current",
                record: { head, acceptance: original, submission, claim },
              });
              return { kind: "commit", provisional };
            }
            recovery = freeze({
              schemaVersion: 2,
              subject: unit.subject,
              operationRef: command.operationRef,
              operationDigest: digest,
              startup: command.kind === "accept-startup" ? null : command.startup,
            });
            const prior = await io("original-command", (scope) =>
              backend.findOperation(scope, command.operationRef),
            );
            if (prior) {
              if (
                prior.canonicalCommand !== canonicalGatewayStartupValueV1(command) ||
                !equal(prior.command, recovery)
              )
                return failureV2("denied");
              return {
                kind: "rollback",
                response: { kind: "recovery-required", operation: recovery },
              };
            }
            if (!expectedMatchesV2(command.expectedHead, head)) return failureV2("denied");
            if (
              head.version >= Number.MAX_SAFE_INTEGER ||
              head.recordVersion >= Number.MAX_SAFE_INTEGER
            )
              return failureV2("unavailable");
            let acceptance: GatewayStartupAcceptanceV2 | null = null;
            let target: GatewayStartupOperationLocatorV2;
            let effect: string;
            let recipientBinding: GatewayStartupRecipientBindingV1 | null = null;
            let submissionInput: GatewayProcessCreateInputV2 | null = null;
            let reason: GatewayStartupMutationEventV2["withdrawalReason"] = null;
            let beforeRecord = head.recordVersion;
            let afterRecord = beforeRecord + 1;
            let auditEventId: string;
            if (command.kind === "accept-startup") {
              if (head.state !== "empty" && head.state !== "withdrawn") return failureV2("denied");
              if (head.processGeneration >= Number.MAX_SAFE_INTEGER)
                return failureV2("unavailable");
              const disposition = await io("predecessor-disposition", async (scope) =>
                retain(
                  await participants.process.requireDisposition(command, original, unit, scope),
                ),
              );
              if (!equal(disposition.predecessor.disposition, command.predecessorDisposition))
                return failureV2("denied");
              predecessorV2(disposition.predecessor, unit.subject, head.startup);
              if (disposition.predecessor.kind === "retired-installation") {
                const bridge = disposition.predecessor;
                const historical = await io("historical-retirement", (scope) =>
                  backend.readLegacyRetirement(
                    scope,
                    bridge.previousStartup,
                    bridge.historicalWithdrawal,
                  ),
                );
                if (
                  !historical ||
                  historical.acceptance.binding.namespaceRef !== unit.subject.namespaceRef ||
                  historical.acceptance.binding.agentRef !== unit.subject.agentRef ||
                  !equal(historical.acceptance.binding.startup, bridge.previousStartup) ||
                  historical.withdrawal.kind !== "withdraw" ||
                  !equal(historical.withdrawal.command, bridge.historicalWithdrawal) ||
                  !equal(historical.withdrawal.startup, bridge.previousStartup)
                )
                  return failureV2("denied");
              }
              if (!equal(selection.selected.selection, command.selectedDefinition))
                return failureV2("denied");
              const processRef = participants.allocate("process");
              effect = participants.allocate("create-effect");
              ref(processRef);
              ref(effect);
              target = freeze({
                schemaVersion: 2,
                subject: unit.subject,
                processRef,
                processGeneration: head.processGeneration + 1,
                operationRef: command.operationRef,
                operationDigest: digest,
              });
              const binding = parseGatewayStartupBindingV2({
                ...selection.selected,
                startup: target,
                createEffectRef: effect,
              });
              if (!equal(binding.selection, command.selectedDefinition)) return failureV2("denied");
              auditEventId = participants.allocate("audit");
              ref(auditEventId);
              acceptance = freeze({ binding, predecessor: disposition.predecessor, auditEventId });
              beforeRecord = 0;
              afterRecord = 1;
            } else {
              if (
                !original ||
                !equal(head.startup, command.startup) ||
                head.state === "withdrawn" ||
                head.state === "empty"
              )
                return failureV2("denied");
              const {
                startup: _startup,
                createEffectRef: _effect,
                ...expectedSelection
              } = original.binding;
              if (!equal(selection.selected, expectedSelection)) return failureV2("denied");
              target = command.startup;
              effect = original.binding.createEffectRef;
              await io("current-process", async (scope) =>
                retain(await participants.process.requireCurrent(command, original, unit, scope)),
              );
              if (command.kind === "submit-create") {
                if (
                  head.state !== "accepted" ||
                  head.recordVersion !== 1 ||
                  !equal(command.input.binding, original.binding) ||
                  (await io("existing-submission", (scope) =>
                    backend.findSubmission(scope, target),
                  ))
                )
                  return failureV2("denied");
                submissionInput = command.input;
              } else if (command.kind === "consume-startup") {
                if (
                  head.state !== "create-submitted" ||
                  head.recordVersion !== 2 ||
                  (await io("existing-claim", (scope) => backend.findClaim(scope, target)))
                )
                  return failureV2("denied");
                const submission = await io("retained-submission", (scope) =>
                  backend.findSubmission(scope, target),
                );
                if (!submission) return failureV2("unavailable");
                recipientBinding = command.recipient;
              } else {
                reason = command.reason;
              }
              auditEventId = participants.allocate("audit");
              ref(auditEventId);
            }
            const event: GatewayStartupMutationEventV2 = parseGatewayStartupEventV2({
              schemaVersion: 2,
              kind: command.kind,
              command: recovery,
              canonicalCommand: canonicalGatewayStartupValueV1(command),
              beforeHeadVersion: head.version,
              afterHeadVersion: head.version + 1,
              beforeRecordVersion: beforeRecord,
              afterRecordVersion: afterRecord,
              previousOperationRef: head.latestOperationRef,
              startup: target,
              createEffectRef: effect,
              acceptance,
              submissionInput,
              recipient: recipientBinding,
              withdrawalReason: reason,
              auditEventId,
            });
            await io("mandatory-audit", (scope) =>
              participants.audit.append(event, account.attribution, unit, scope),
            );
            await io("append", (scope) => backend.append(scope, event));
            await io("advance", (scope) => backend.advanceHead(scope, head, event));
            const after = nextHeadV2(event);
            if (command.kind === "accept-startup")
              provisional = freeze({ kind: "accepted", record: acceptance!, head: after });
            else if (command.kind === "submit-create")
              provisional = freeze({ kind: "submitted", event });
            else if (command.kind === "withdraw")
              provisional = freeze({ kind: "withdrawn", startup: target, head: after });
            else {
              const submission = await io("accepted-submission", (scope) =>
                backend.findSubmission(scope, target),
              );
              provisional = freeze({
                kind: "consumed",
                record: {
                  head: after,
                  acceptance: original!,
                  submission: submission ?? null,
                  claim: event,
                },
              });
            }
            if (bounds.signal.aborted) return failureV2("unavailable");
            return { kind: "commit", provisional };
          } catch (error) {
            phase.poison(error);
            throw error;
          }
        });
      }).catch(() => ({ kind: "unknown" as const }));
      if (result.kind === "committed" && provisional && equal(result.response, provisional))
        return freeze(result.response);
      if (result.kind === "rolled-back") return freeze(result.response);
      return recovery
        ? freeze({ kind: "recovery-required", operation: recovery })
        : freeze({ kind: "unavailable" });
    },
  });
}

/** Borrowed from the genuine protected process call owner; its lifetime remains with that owner. */
export interface GatewayStartupSubmissionEnrollmentV2 {
  readonly command: Extract<GatewayStartupCommandV2, { kind: "submit-create" }>;
  readonly invocation: GatewayStartupInvocationV2;
  readonly bounds: GatewayStartupCommandBoundsV1;
  assertCurrent(): undefined;
  /** Register before evaluating a fence. The original call owner closes and joins
   * this work at terminal settlement, including a failed synchronous dispatch fence. */
  registerDrain(drain: () => Promise<void>): undefined;
}
export interface GatewayStartupSubmissionSourceV2 {
  resolve(
    input: GatewayProcessCreateInputV2,
    call: GatewayProcessCallV2,
  ): Promise<GatewayStartupSubmissionEnrollmentV2 | undefined>;
}
/** A separate V2 ticket follows only the exact newly committed submission. The
 * original call owner authenticates enrollment and owns registered work drains;
 * history/readback/unknown COMMIT cannot mint a ticket. No V1 call is relabelled. */
export function createGatewayStartupSubmissionOwnerV2(
  owner: ReturnType<typeof createGatewayStartupOwnerV2>,
  source?: GatewayStartupSubmissionSourceV2,
): GatewayProcessSubmissionOwnerV2 {
  const execute = owner.execute.bind(owner),
    resolve = source?.resolve.bind(source);
  const tickets = new WeakMap<
    GatewayProcessSubmissionV2,
    { input: string; call: GatewayProcessCallV2; assertCurrent: () => undefined; used: boolean }
  >();
  return Object.freeze({
    async claimOriginal(input: GatewayProcessCreateInputV2, call: GatewayProcessCallV2) {
      let captured: GatewayProcessCreateInputV2;
      try {
        captured = JSON.parse(canonicalGatewayStartupValueV1(input));
        createInputV2(captured);
        freeze(captured);
      } catch {
        return Object.freeze({ kind: "denied" as const });
      }
      if (!resolve) return Object.freeze({ kind: "unavailable" as const });
      const pending = new Set<Promise<unknown>>();
      let closed = false;
      const settle = async () => {
        while (pending.size) await Promise.allSettled([...pending]);
      };
      const drain = async () => {
        closed = true;
        await settle();
      };
      try {
        const enrollment = await resolve(captured, call);
        if (!enrollment) return Object.freeze({ kind: "unavailable" as const });
        const assertion = enrollment.assertCurrent.bind(enrollment);
        const register = enrollment.registerDrain.bind(enrollment);
        const registration: unknown = register(drain);
        if (registration !== undefined) {
          await Promise.resolve(registration).catch(() => {});
          throw unavailable();
        }
        let failed = false;
        const assertCurrent = (): undefined => {
          if (closed || failed) throw unavailable();
          try {
            const value: unknown = assertion();
            if (value !== undefined) {
              const work = Promise.resolve(value);
              pending.add(work);
              void work.then(
                () => pending.delete(work),
                () => pending.delete(work),
              );
              throw unavailable();
            }
          } catch (error) {
            failed = true;
            throw error;
          }
          return undefined;
        };
        assertCurrent();
        const command = parseGatewayStartupCommandV2(enrollment.command);
        if (
          command.kind !== "submit-create" ||
          !equal(command.input, captured) ||
          !equal(command.startup, captured.binding.startup)
        )
          return Object.freeze({ kind: "denied" as const });
        const result = await execute(command, enrollment.invocation, enrollment.bounds);
        if (result.kind === "recovery-required")
          return freeze({ kind: "unknown" as const, operation: captured.binding.startup });
        if (result.kind === "denied" || result.kind === "unavailable")
          return freeze({ kind: result.kind });
        if (result.kind !== "submitted" || !equal(result.event.submissionInput, captured))
          return freeze({ kind: "unknown" as const, operation: captured.binding.startup });
        assertCurrent();
        const ticket = Object.freeze({}) as GatewayProcessSubmissionV2;
        tickets.set(ticket, {
          input: canonicalGatewayStartupValueV1(captured),
          call,
          assertCurrent,
          used: false,
        });
        return Object.freeze({ kind: "claimed" as const, submission: ticket });
      } catch {
        await settle();
        return freeze({ kind: "unknown" as const, operation: captured.binding.startup });
      }
    },
    consumeSubmission(
      submission: GatewayProcessSubmissionV2,
      input: GatewayProcessCreateInputV2,
      call: GatewayProcessCallV2,
    ): undefined {
      const state = tickets.get(submission);
      if (!state || state.used) throw unavailable();
      state.used = true;
      if (state.call !== call || state.input !== canonicalGatewayStartupValueV1(input))
        throw unavailable();
      state.assertCurrent();
      return undefined;
    },
  });
}
