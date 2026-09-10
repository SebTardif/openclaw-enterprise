import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import type { AuthorityCallV1 } from "@openclaw-enterprise/contracts/runtime-authority-v1";
import type {
  RepositoryWorkAdmissionV2,
  RepositoryWorkCommittedV2,
  RepositoryWorkCommittedMintUseLeaseV2,
  RepositoryWorkInventoryFactsV2,
  RepositoryWorkCustodySourceV2,
  RepositoryWorkDispatchV2,
  RepositoryWorkHeldLeaseV2,
  RepositoryWorkOperationV2,
  RepositoryWorkOriginalSourceV2,
  RepositoryWorkPreparationV2,
  RepositoryWorkReadsetV2,
  RepositoryWorkSourceLeaseV2,
  RepositoryWorkStateBindingV2,
  RepositoryWorkStoreV2,
  RepositoryWorkTransactionContextV2,
} from "../ports/repository-work-v2.ts";
import {
  repositoryTargetDigestV2,
  parseRepositoryTokenMutationV2,
  repositoryInventoryDigestV2,
  type ReserveRepositoryTokenV2,
  type RepositoryInventoryOperationV2,
  type RepositoryTokenMutationV2,
  type RepositoryTokenRecordV2,
  type RepositoryTargetV2,
} from "../credential-inventory-v1/repository-lease-v2.ts";
import {
  decodeGitHubMediationRequest,
  type DispatchRead,
  type OpenRead,
  type GitHubMediationVersion,
} from "../github-mediation-v2/wire.ts";
import type {
  WorkRepositoryProtocolOptionsV2,
  WorkRepositoryProtocolSelectionV2,
} from "./work-authority-ports-v2.ts";
import type { GitHubMediationOutcome } from "../github-mediation-v2/ports.ts";
import type { WorkOriginalOperationV2 } from "./work-authority-ports-v2.ts";
import {
  compareRepositoryWorkCurrentV2,
  repositoryWorkCurrentPolicyArmV2,
  repositoryWorkGitReadBindingV3,
  type RepositoryWorkCurrentV2,
  type RepositoryWorkNativeBindingV2,
  type RepositoryWorkSourcesV2,
} from "./repository-work-v2.ts";
import {
  evaluateRepositoryWorkProtocolPolicyV2,
  type RepositoryWorkPolicyV2,
  type RepositoryWorkPolicyUseV2,
} from "./repository-work-policy-v2.ts";

/** Captured original phase associations. This data does not enroll a selection.
 * In particular existing Work preparation is not a second Work-head admission. */
export interface RepositoryWorkSelectionDataV2<V extends GitHubMediationVersion = 2> {
  readonly current: RepositoryWorkCurrentV2<V>;
  readonly preparation: WorkOriginalOperationV2;
  readonly observation: WorkOriginalOperationV2;
  readonly admission:
    | Readonly<{
        kind: "new";
        original: WorkOriginalOperationV2;
        record: RepositoryWorkAdmissionV2;
      }>
    | Readonly<{ kind: "existing"; originalAdmission: RepositoryWorkOperationV2 }>;
  /** Original native diagnostic (github-native/<connectionId>), never broker nonce. */
  readonly sessionRef: string;
  readonly repositoryTarget: RepositoryTargetV2;
  readonly policyAdmission: RepositoryWorkPolicyUseV2["admitted"];
  readonly workBeganAt: string;
  readonly observationRef: string;
  readonly observationEvidenceRef: string;
}
export interface RepositoryWorkStateBindingsV2 {
  readonly origin: unknown;
  readonly selection: unknown;
  readonly token: unknown;
}
export interface RepositoryWorkHeldPolicyV2 extends RepositoryWorkHeldLeaseV2 {
  /** Actual policy acquired and held by the original State source in this unit. */
  readonly policy: RepositoryWorkPolicyV2;
}
type Missing = { readonly [K in keyof RepositoryWorkStateBindingsV2]: never };

/** Original assignment/admission/current-policy owner. The fixed source must
 * privately recognize S and its relationship to the SAME Runtime origin.
 * No implementation, default admission or synthetic root is supplied here.
 * retainPolicy borrows the real policy participant only in that unit's captured
 * prepareUse phase, after custody and I/N/A locks and before unit operations;
 * retainObservation is distinct post-closure historical responsibility.
 */
export interface RepositoryWorkSelectionSourceV2<
  B extends RepositoryWorkStateBindingsV2 = Missing,
  in out V extends GitHubMediationVersion = 2,
> {
  /** Original State selection retains a separate inventory responsibility before
   * any provider attempt. Omission refuses issuance, without changing Work use. */
  acquireInventory?(
    selection: B["selection"],
    origin: B["origin"],
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkInventorySelectionV2 | undefined>;
  readonly acquire: (
    origin: B["origin"],
    request: OpenRead<V>,
    call: AuthorityCallV1,
  ) => Promise<B["selection"] | undefined>;
  inspect(
    selection: B["selection"],
    origin: B["origin"],
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkSelectionDataV2<V>>;
  /** Retire the original initial SQL readset before a Work transaction starts.
   * Later fresh-use enrollment carries no old readset and grants no authority. */
  prepareStateUse(
    selection: B["selection"],
    origin: B["origin"],
    call: AuthorityCallV1,
  ): Promise<void>;
  retainPolicy(
    context: RepositoryWorkTransactionContextV2,
    selection: B["selection"],
    original: WorkOriginalOperationV2,
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkHeldPolicyV2>;
  retainObservation(
    context: RepositoryWorkTransactionContextV2,
    selection: B["selection"],
    original: WorkOriginalOperationV2,
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkHeldLeaseV2>;
  /** Original retained cleanup authority supplies this bounded call. The adapter
   * cannot renew the cancelled live call or create a replacement context. */
  observationCall(selection: B["selection"]): Promise<AuthorityCallV1>;
  release(selection: B["selection"]): Promise<void>;
}

/** Construction-paired State selection, not a caller-supplied authorization
 * callback. Its originals are issued for these exact immutable mutations. The
 * issue lease includes actual token-issue authority in addition to Work policy;
 * the observer owns separate post-closure responsibility and bounded calls. */
export interface RepositoryWorkInventorySelectionV2 {
  readonly reservation: Readonly<{
    original: WorkOriginalOperationV2;
    input: ReserveRepositoryTokenV2;
  }>;
  selectOperation(
    input: RepositoryTokenMutationV2,
    call: AuthorityCallV1,
  ): Promise<WorkOriginalOperationV2>;
  retainIssue(
    context: RepositoryWorkTransactionContextV2,
    original: WorkOriginalOperationV2,
    input: RepositoryTokenMutationV2,
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkHeldLeaseV2>;
  retainObservation(
    context: RepositoryWorkTransactionContextV2,
    original: WorkOriginalOperationV2,
    input: RepositoryTokenMutationV2,
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkHeldLeaseV2>;
  observationCall(): Promise<AuthorityCallV1>;
  release(): Promise<void>;
}
declare const inventoryResponsibility: unique symbol,
  inventoryClaim: unique symbol,
  inventoryCleanupClaim: unique symbol;
export type RepositoryWorkInventoryResponsibilityV2 = { readonly [inventoryResponsibility]: true };
export type RepositoryWorkInventoryClaimV2 = { readonly [inventoryClaim]: true };
export type RepositoryWorkInventoryCleanupClaimV2 = { readonly [inventoryCleanupClaim]: true };
export interface RepositoryWorkInventoryRevocationUseV2 {
  readonly operation: RepositoryInventoryOperationV2;
  /** Actual independently retained observer call, not a renewed user call. */
  readonly call: AuthorityCallV1;
  assertCurrent(): undefined;
  beginSubmittedUse(): undefined;
  release(): Promise<void>;
}
export type RepositoryWorkInventoryResultV2 =
  | Readonly<{
      kind: "committed";
      operation: RepositoryInventoryOperationV2;
      claim?: RepositoryWorkInventoryClaimV2;
      cleanupClaim?: RepositoryWorkInventoryCleanupClaimV2;
    }>
  | Readonly<{
      kind: "existing";
      operation: RepositoryInventoryOperationV2;
      nextAction: "reconcile-only";
    }>
  | Readonly<{ kind: "unknown"; operationRef: string }>
  | Readonly<{ kind: "not-committed" | "conflict" | "capacity" | "target-held" | "expired" }>;
/** Only the fixed custody producer receives this port. No transaction body,
 * enrollment function, raw inventory participant or credential bytes escape. */
export interface RepositoryWorkInventoryPortV2<
  B extends RepositoryWorkStateBindingsV2 = Missing,
  V extends GitHubMediationVersion = 2,
> {
  acquire(
    preparation: RepositoryWorkStatePreparationV2<V>,
    origin: B["origin"],
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkInventoryResponsibilityV2 | undefined>;
  reservation(responsibility: RepositoryWorkInventoryResponsibilityV2): ReserveRepositoryTokenV2;
  transition(
    responsibility: RepositoryWorkInventoryResponsibilityV2,
    input: RepositoryTokenMutationV2,
    call?: AuthorityCallV1,
  ): Promise<RepositoryWorkInventoryResultV2>;
  recover(
    responsibility: RepositoryWorkInventoryResponsibilityV2,
    operationRef: string,
  ): Promise<
    | Readonly<{ kind: "recorded"; operation: RepositoryInventoryOperationV2 }>
    | Readonly<{ kind: "absent" | "unavailable" }>
  >;
  acquireMint(
    responsibility: RepositoryWorkInventoryResponsibilityV2,
    claim: RepositoryWorkInventoryClaimV2,
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkCommittedMintUseLeaseV2 | undefined>;
  acquireRevocation(
    responsibility: RepositoryWorkInventoryResponsibilityV2,
    claim: RepositoryWorkInventoryCleanupClaimV2,
  ): Promise<RepositoryWorkInventoryRevocationUseV2 | undefined>;
  release(responsibility: RepositoryWorkInventoryResponsibilityV2): Promise<void>;
}

/** The custody owner fixes the private token/operation association around this
 * exact State run. Its stageRelease still re-recognizes material in the borrowed
 * original inventory unit. The projection below never carries token bytes. */
export interface RepositoryWorkTokenBindingV2<B extends RepositoryWorkStateBindingsV2 = Missing> {
  readonly source: RepositoryWorkCustodySourceV2;
  inspect(
    token: B["token"],
    selection: B["selection"],
  ): Readonly<{
    accessLeaseRef: string;
    inventoryRecordRef: string;
    inventoryVersion: number;
    releaseRef: string;
    repositoryTarget: RepositoryTargetV2;
    receiver: object;
    session: object;
  }>;
}
declare const prepared: unique symbol;
export type RepositoryWorkStatePreparationV2<V extends GitHubMediationVersion = 2> = {
  readonly [prepared]: (version: V) => V;
};
type Bindings<B extends RepositoryWorkStateBindingsV2, V extends GitHubMediationVersion> = {
  origin: B["origin"];
  preparation: RepositoryWorkStatePreparationV2<V>;
  token: B["token"];
  commit: RepositoryWorkCommittedV2;
};
type SelectionOriginals = Readonly<{
  preparation: WorkOriginalOperationV2;
  dispatch: WorkOriginalOperationV2;
  observation: WorkOriginalOperationV2;
  admission?: WorkOriginalOperationV2;
}>;
type Entry<B extends RepositoryWorkStateBindingsV2, V extends GitHubMediationVersion> = {
  readonly origin: B["origin"];
  readonly selection: B["selection"];
  readonly request: OpenRead<V>;
  readonly data: RepositoryWorkSelectionDataV2<V>;
  /** Original privately issued objects; data above is comparison-only. */
  readonly originals: SelectionOriginals;
  readonly native: RepositoryWorkNativeBindingV2;
  current: RepositoryWorkCurrentV2<V>;
  active: boolean;
  settling: boolean;
  dispatchEntered: boolean;
  dispatch?: RepositoryWorkDispatchV2;
  /** Detached actual inbound wire binding; original native prepared exchange
   * independently authenticates the same nonce and complete metadata. */
  brokerDispatch?: DispatchRead<V>;
  commit?: RepositoryWorkCommittedV2;
  token?: B["token"];
  receiver?: object;
  session?: object;
  joined?: Promise<"recorded" | "unavailable">;
  inventory?: Inventory<B, V>;
  selectionRelease?: Promise<void>;
  readonly nativePending: Set<Promise<void>>;
  useFailed?: boolean;
};
type InventoryPhase = {
  original: WorkOriginalOperationV2;
  originalData: WorkOriginalOperationV2;
  input: RepositoryTokenMutationV2;
  digest: string;
};
type Inventory<B extends RepositoryWorkStateBindingsV2, V extends GitHubMediationVersion> = {
  entry: Entry<B, V>;
  handle: RepositoryWorkInventoryResponsibilityV2;
  source?: RepositoryWorkInventorySelectionV2;
  reservation?: ReserveRepositoryTokenV2;
  phases: Map<string, InventoryPhase>;
  pending: Set<Promise<unknown>>;
  closing: boolean;
  released: boolean;
  opening?: Promise<RepositoryWorkInventoryResponsibilityV2 | undefined>;
  joined?: Promise<void>;
};
type Run<B extends RepositoryWorkStateBindingsV2, V extends GitHubMediationVersion> = {
  readonly entry: Entry<B, V>;
  readonly original: WorkOriginalOperationV2;
  readonly mode:
    | "admission"
    | "preparation"
    | "current"
    | "dispatch"
    | "observation"
    | "inventory-issue"
    | "inventory-observation";
  live: boolean;
};
function fail(): never {
  throw new Error("Original repository Work State binding unavailable.");
}

// Closed, bounded data copy; no authority is obtained by parsing the projection.
function snapshot<T>(input: T): T {
  let nodes = 0;
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 8192 || depth > 24) return fail();
    if (v === null || typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0)) return v;
    if (!v || typeof v !== "object" || types.isProxy(v)) return fail();
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null && proto !== Array.prototype) return fail();
    const array = Array.isArray(v),
      descriptors = Object.getOwnPropertyDescriptors(v);
    const keys = Reflect.ownKeys(descriptors).filter((k) => !(array && k === "length"));
    if (array && keys.length !== v.length) return fail();
    const out = array ? [] : Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string" || key === "__proto__") return fail();
      const d = descriptors[key];
      if (!d || !("value" in d) || !d.enumerable) return fail();
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || +key >= v.length)) return fail();
      Object.defineProperty(out, key, { value: visit(d.value, depth + 1), enumerable: true });
    }
    return Object.freeze(out);
  };
  const result = visit(input, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > 131072) return fail();
  return result as T;
}
const key = (v: unknown): string => {
  const encode = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(encode)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, encode((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(encode(snapshot(v)));
};
const equal = (a: unknown, b: unknown): boolean => key(a) === key(b);
const liveMutation = (input: RepositoryTokenMutationV2): boolean =>
  input.method === "reserveRepositoryToken" || input.method === "claimRepositoryMint";
function own(input: object, name: string): unknown {
  if (!input || typeof input !== "object" || types.isProxy(input)) return fail();
  const descriptor = Object.getOwnPropertyDescriptor(input, name);
  return descriptor && "value" in descriptor ? descriptor.value : fail();
}

/** Compares genuine State-acquired rows with the original selected expectation.
 * The state participant authenticates the readset; this function does not. */
export function compareRepositoryWorkStateReadsetV2<V extends GitHubMediationVersion = 2>(
  readset: RepositoryWorkReadsetV2,
  expected: RepositoryWorkCurrentV2<V>,
): void {
  const rows = snapshot(readset),
    chain = [...expected.lineage.ancestors, expected.lineage.own];
  const scope = expected.original.scope;
  if (
    !equal(rows.scope, {
      installationId: scope.installationRef,
      namespaceId: scope.namespaceRef,
      agentId: scope.agentRef,
      revisionRef: scope.revisionRef,
    }) ||
    rows.lineage.length !== chain.length ||
    rows.lineage.length < 1
  )
    fail();
  for (let i = 0; i < chain.length; i++) {
    const row = rows.lineage[i]!,
      wanted = chain[i]!;
    if (
      !equal(row.scope, rows.scope) ||
      row.workRef !== wanted.work.workRef ||
      row.revision !== wanted.work.revision ||
      row.withdrawalRevision !== wanted.withdrawalRevision ||
      row.state !== wanted.state ||
      row.state !== "open" ||
      row.originalHorizon !== wanted.originalHorizon ||
      row.rootWorkRef !== expected.lineage.rootWorkRef ||
      row.parentWorkRef !== (i === 0 ? null : rows.lineage[i - 1]!.workRef)
    )
      fail();
  }
  const own = rows.lineage.at(-1)!;
  if (!equal(own.execution, expected.execution) || !equal(own.policy, expected.policy)) fail();
}

/** Bind the record that will be committed to the same selected Work used by
 * policy qualification. This runs before admission opens a transaction: later
 * preparation refusal cannot undo an already acknowledged admission. */
function compareAdmission<V extends GitHubMediationVersion = 2>(
  candidate: RepositoryWorkAdmissionV2,
  current: RepositoryWorkCurrentV2<V>,
): void {
  const record = candidate.record,
    own = current.lineage.own;
  if (
    !equal(record.scope, {
      installationId: current.original.scope.installationRef,
      namespaceId: current.original.scope.namespaceRef,
      agentId: current.original.scope.agentRef,
      revisionRef: current.original.scope.revisionRef,
    }) ||
    record.workRef !== current.work.workRef ||
    record.revision !== current.work.revision ||
    record.withdrawalRevision !== own.withdrawalRevision ||
    record.state !== own.state ||
    record.state !== "open" ||
    record.parentWorkRef !== current.lineage.parentWorkRef ||
    record.rootWorkRef !== current.lineage.rootWorkRef ||
    record.originalHorizon !== own.originalHorizon ||
    record.originalHorizon !== current.originalHorizon ||
    !equal(record.execution, current.execution) ||
    !equal(record.policy, current.policy)
  )
    fail();
}

/** Actual Work-side transaction adapter. Store creation uses the one original
 * State binding and captures both original sources once. It does not instantiate
 * a database, provide missing selection authority or authorize from a callback.
 */
export class RepositoryWorkStateAdapterV2<
  B extends RepositoryWorkStateBindingsV2 = Missing,
  V extends GitHubMediationVersion = 2,
> {
  readonly state: RepositoryWorkSourcesV2<Bindings<B, V>, V>["state"];
  readonly inventory: RepositoryWorkInventoryPortV2<B, V>;
  private readonly entries = new WeakMap<object, Entry<B, V>>();
  private readonly commits = new WeakMap<object, Entry<B, V>>();
  private readonly activeRun = new AsyncLocalStorage<Run<B, V>>();
  private readonly operations = new WeakMap<
    object,
    {
      entry: Entry<B, V>;
      mode: Run<B, V>["mode"];
      originalData: WorkOriginalOperationV2;
      inventory?: Inventory<B, V>;
      phase?: InventoryPhase;
    }
  >();
  private readonly inventories = new WeakMap<object, Inventory<B, V>>();
  private readonly inventoryClaims = new WeakMap<
    object,
    {
      inventory: Inventory<B, V>;
      phase: InventoryPhase;
      commit: RepositoryWorkCommittedV2;
      used: boolean;
    }
  >();
  private readonly inventoryCleanupClaims = new WeakMap<
    object,
    {
      inventory: Inventory<B, V>;
      phase: InventoryPhase;
      commit: RepositoryWorkCommittedV2;
      used: boolean;
    }
  >();
  private readonly transactionMilliseconds: number;
  private readonly protocolVersion: V;
  private readonly versionIdentity: (version: V) => V;
  private readonly store: RepositoryWorkStoreV2;
  private readonly selection: RepositoryWorkSelectionSourceV2<B, V>;
  private readonly native: RepositoryWorkSourcesV2<Bindings<B, V>, V>["native"];
  private readonly tokens: RepositoryWorkTokenBindingV2<B>;
  private readonly recognize: RepositoryWorkStateBindingV2["participant"]["recognizeCommittedRelease"];
  private readonly recognizeInventory: RepositoryWorkStateBindingV2["participant"]["recognizeCommittedInventory"];
  private readonly acquireCommittedMint: RepositoryWorkStateBindingV2["participant"]["acquireCommittedMint"];
  private readonly acquireCommittedRevocation: RepositoryWorkStateBindingV2["participant"]["acquireCommittedRevocation"];

  constructor(
    binding: RepositoryWorkStateBindingV2,
    native: RepositoryWorkSourcesV2<Bindings<B, NoInfer<V>>, NoInfer<V>>["native"],
    selection: RepositoryWorkSelectionSourceV2<B, NoInfer<V>>,
    tokens: RepositoryWorkTokenBindingV2<B>,
    transactionMilliseconds: number,
    options: WorkRepositoryProtocolOptionsV2<V>,
  );
  constructor(
    binding: RepositoryWorkStateBindingV2,
    native: RepositoryWorkSourcesV2<Bindings<B, NoInfer<V>>, NoInfer<V>>["native"],
    selection: RepositoryWorkSelectionSourceV2<B, NoInfer<V>>,
    tokens: RepositoryWorkTokenBindingV2<B>,
    transactionMilliseconds: number,
    ...protocol: WorkRepositoryProtocolSelectionV2<V>
  );
  constructor(
    binding: RepositoryWorkStateBindingV2,
    native: RepositoryWorkSourcesV2<Bindings<B, V>, V>["native"],
    selection: RepositoryWorkSelectionSourceV2<B, V>,
    tokens: RepositoryWorkTokenBindingV2<B>,
    transactionMilliseconds: number,
    options?: { readonly protocolVersion?: GitHubMediationVersion },
  ) {
    const version = options?.protocolVersion ?? 2;
    if (version !== 2 && version !== 3) fail();
    this.protocolVersion = version as V;
    this.versionIdentity = (value: V) => value;
    if (
      !Number.isSafeInteger(transactionMilliseconds) ||
      transactionMilliseconds <= 0 ||
      transactionMilliseconds > 3000
    )
      fail();
    this.transactionMilliseconds = transactionMilliseconds;
    this.native = Object.freeze({
      acquire: native.acquire.bind(native),
      inspect: native.inspect.bind(native),
      inspectNative: native.inspectNative.bind(native),
      assertNativeCurrent: native.assertNativeCurrent.bind(native),
      assertCurrent: native.assertCurrent.bind(native),
      release: native.release.bind(native),
    });
    const acquireInventory = selection.acquireInventory;
    this.selection = Object.freeze({
      ...(acquireInventory ? { acquireInventory: acquireInventory.bind(selection) } : {}),
      acquire: selection.acquire.bind(selection),
      inspect: selection.inspect.bind(selection),
      prepareStateUse: selection.prepareStateUse.bind(selection),
      retainPolicy: selection.retainPolicy.bind(selection),
      retainObservation: selection.retainObservation.bind(selection),
      observationCall: selection.observationCall.bind(selection),
      release: selection.release.bind(selection),
    });
    this.tokens = Object.freeze({ source: tokens.source, inspect: tokens.inspect.bind(tokens) });
    const participant = binding.participant,
      assertOriginal = participant.assertOriginal.bind(participant);
    this.recognize = participant.recognizeCommittedRelease.bind(participant);
    this.recognizeInventory = participant.recognizeCommittedInventory.bind(participant);
    this.acquireCommittedMint = participant.acquireCommittedMint.bind(participant);
    this.acquireCommittedRevocation = participant.acquireCommittedRevocation.bind(participant);
    this.store = binding.bindOriginalSources(
      Object.freeze<RepositoryWorkOriginalSourceV2>({
        acquire: async (context, original, call) => {
          // Capture the original State receiver before entering source callbacks.
          // A refused asynchronous assertion must join the transaction itself,
          // before rollback or any dependent participant can retire.
          const joinAccepted = context.joinAccepted.bind(context);
          assertOriginal(context, original, call);
          const member = this.operations.get(original);
          if (!member || (member.inventory ? member.inventory.released : !member.entry.active))
            fail();
          if (!equal(original, member.originalData)) fail();
          const active = this.activeRun.getStore();
          // Fresh committed-use acquisition is initiated by the original State
          // witness, outside an adapter run. The exact original operation remains
          // privately recognized until settlement; no caller data is enrolled.
          if (
            active &&
            (!active.live || active.original !== original || active.entry !== member.entry)
          )
            fail();
          const mode = active?.mode ?? member.mode;
          const entry = member.entry;
          const historical = mode === "observation" || mode === "inventory-observation";
          const inventory = member.inventory,
            phase = member.phase;
          if (entry.settling && !historical) fail();
          if (inventory && (!phase || !inventory.source)) fail();
          let live = true;
          let sourceReady = false;
          let completed = false;
          let completion: Promise<void> | undefined;
          let joinedRelease: Promise<void> | undefined;
          let checkPrefix: (() => undefined) | undefined;
          let checkPolicy: (() => undefined) | undefined;
          let policy: RepositoryWorkPolicyV2 | undefined;
          const pending = new Set<Promise<unknown>>();
          const tracked = <T>(work: Promise<T>): Promise<T> => {
            pending.add(work);
            void work.then(
              () => pending.delete(work),
              () => pending.delete(work),
            );
            return work;
          };
          const sync = (value: unknown): void => {
            if (value === undefined) return;
            live = false;
            const entered = tracked(Promise.resolve(value));
            joinAccepted(entered);
            fail();
          };
          const current = (): undefined => {
            if (!live) fail();
            if ((entry.settling || entry.useFailed) && !historical) fail();
            if (inventory && (inventory.closing || inventory.released)) fail();
            if (!equal(original, member.originalData)) fail();
            if (checkPrefix) sync(checkPrefix());
            if (
              call.signal.aborted ||
              !Number.isFinite(Date.parse(call.deadline)) ||
              Date.parse(call.deadline) <= Date.now()
            )
              fail();
            if (completed && !historical) {
              if (!checkPolicy || !policy) fail();
              sync(checkPolicy());
              const decision = evaluateRepositoryWorkProtocolPolicyV2(
                policy,
                {
                  scope: entry.current.original.scope,
                  service: entry.current.service,
                  execution: entry.current.execution,
                  admitted: entry.data.policyAdmission,
                  repository: {
                    target: entry.data.repositoryTarget,
                    owner: entry.current.repository.owner,
                    name: entry.current.repository.name,
                    profile: entry.current.repository.profile,
                  },
                  operation: this.protocolVersion === 3 ? "git:read" : "metadata:read",
                  workBeganAt: entry.data.workBeganAt,
                  originalHorizon: entry.current.originalHorizon,
                  now: new Date().toISOString(),
                },
                this.protocolVersion,
                repositoryWorkCurrentPolicyArmV2(entry.current),
              );
              if (decision.kind !== "matches") fail();
              if (call.signal.aborted) fail();
            }
            if (!historical) {
              // No State readset exists during acquisition. Full currentness
              // becomes required only after retainPolicy completes in this unit.
              sync(
                completed
                  ? this.native.assertCurrent(entry.origin, call)
                  : this.native.assertNativeCurrent(entry.origin, call),
              );
              if (call.signal.aborted) fail();
            }
            if (!equal(original, member.originalData)) fail();
            return undefined;
          };
          const qualifiedCurrent = (): undefined => {
            if (!completed) fail();
            return current();
          };
          const lease = Object.freeze<RepositoryWorkSourceLeaseV2>({
            actorId: entry.data.current.service.id,
            assertCurrent: current,
            prepareUse: () => {
              // State captures this method once. Fresh committed-use reentry
              // acquires a new original source lease, never reuses completion.
              if (completion || !sourceReady) {
                live = false;
                fail();
              }
              completion = tracked(
                Promise.resolve()
                  .then(async () => {
                    current();
                    if (!historical) {
                      const held = await this.selection.retainPolicy(
                        context,
                        entry.selection,
                        original,
                        call,
                      );
                      // Transfer even a late acquisition before observing any
                      // policy/currentness getter. The original State joins release.
                      context.retain(held);
                      checkPolicy = held.assertCurrent.bind(held);
                      policy = snapshot(own(held, "policy")) as RepositoryWorkPolicyV2;
                    }
                    current();
                    completed = true;
                    qualifiedCurrent();
                  })
                  .catch((error: unknown) => {
                    live = false;
                    throw error;
                  }),
              );
              return completion;
            },
            prepareCommit: async () => {
              qualifiedCurrent();
            }, // State prepares the separately retained original lease once.
            release: () => {
              live = false;
              return (joinedRelease ??= Promise.resolve().then(async () => {
                while (pending.size) await Promise.allSettled([...pending]);
              }));
            },
            qualifyReadset: async (rows) => {
              qualifiedCurrent();
              compareRepositoryWorkStateReadsetV2(rows, entry.current);
              qualifiedCurrent();
            },
            qualifyAdmission: async (candidate) => {
              qualifiedCurrent();
              if (
                mode !== "admission" ||
                entry.data.admission.kind !== "new" ||
                !equal(candidate, entry.data.admission.record)
              )
                fail();
              compareAdmission(candidate, entry.current);
              qualifiedCurrent();
            },
            qualifyClosure: async () => fail(), // Repository use grants no independent Work closure.
            qualifyObservation: async (operation, observation) => {
              qualifiedCurrent();
              if (
                mode !== "observation" ||
                operation.operationRef !== entry.data.current.original.operationRef ||
                operation.kind !== "dispatch" ||
                operation.requestDigest !== entry.data.current.original.requestDigest ||
                observation.dispatchOperationRef !== operation.operationRef ||
                observation.observationRef !== entry.data.observationRef ||
                observation.evidenceRef !== entry.data.observationEvidenceRef
              )
                fail();
              qualifiedCurrent();
            },
            qualifyInventory: async (facts) => {
              qualifiedCurrent();
              if (!inventory || !phase) fail();
              this.qualifyInventoryFacts(inventory, phase, facts);
              if (liveMutation(phase.input)) {
                if (mode !== "inventory-issue" || !facts.readset) fail();
                compareRepositoryWorkStateReadsetV2(facts.readset, entry.current);
              } else if (mode !== "inventory-observation") fail();
              qualifiedCurrent();
            },
            qualifyInventoryRead: async (operation) => {
              qualifiedCurrent();
              if (!inventory || !phase) fail();
              if (operation) this.qualifyInventoryOperation(inventory, phase, operation);
              qualifiedCurrent();
            },
            qualifyMintUse: async (operation, record, rows) => {
              qualifiedCurrent();
              if (
                !inventory ||
                !phase ||
                mode !== "inventory-issue" ||
                phase.input.method !== "claimRepositoryMint"
              )
                fail();
              this.qualifyInventoryOperation(inventory, phase, operation);
              this.qualifyInventoryRecord(inventory, record);
              if (
                !equal(record, operation.record) ||
                record.state !== "mint-unknown" ||
                record.providerAttemptRef !== phase.input.providerAttemptRef
              )
                fail();
              compareRepositoryWorkStateReadsetV2(rows, entry.current);
              qualifiedCurrent();
            },
            qualifyRevocationUse: async (operation, record) => {
              qualifiedCurrent();
              if (
                !inventory ||
                !phase ||
                mode !== "inventory-observation" ||
                phase.input.method !== "claimRepositoryRevocation"
              )
                fail();
              this.qualifyInventoryOperation(inventory, phase, operation);
              this.qualifyInventoryRecord(inventory, record);
              if (
                !equal(record, operation.record) ||
                record.state !== "outstanding" ||
                record.revocation?.state !== "claimed" ||
                record.revocation.revocationOperationRef !== phase.input.revocationOperationRef ||
                record.tokenRef !== phase.input.tokenRef ||
                record.protectedRevocationRef !== phase.input.protectedRevocationRef
              )
                fail();
              qualifiedCurrent();
            },
          });
          // Register the source's join before any entered prefix acquisition or
          // currentness callback. State deduplicates this exact retained lease.
          context.retain(lease);
          try {
            if (!historical) {
              const enrollment = tracked(this.enrollNative(entry, call));
              joinAccepted(enrollment);
              await enrollment;
            }
            if (!historical && !active) {
              // Original State may reenter through a known committed witness.
              // Adapter runs retire the initial readset before store.run; no
              // later native inspection reopens it. This fresh enrollment is
              // owned by the entered State acquisition and creates no readset.
              current();
              await this.selection.prepareStateUse(entry.selection, entry.origin, call);
              current();
            }
            let prefix: RepositoryWorkHeldLeaseV2 | undefined;
            if (mode === "inventory-observation") {
              prefix = await inventory!.source!.retainObservation(
                context,
                original,
                phase!.input,
                call,
              );
            } else if (mode === "observation") {
              prefix = await this.selection.retainObservation(
                context,
                entry.selection,
                original,
                call,
              );
            } else if (mode === "inventory-issue") {
              prefix = await inventory!.source!.retainIssue(context, original, phase!.input, call);
            }
            if (historical || mode === "inventory-issue") {
              if (!prefix || typeof prefix !== "object") fail();
              context.retain(prefix);
              checkPrefix = prefix.assertCurrent.bind(prefix);
            }
            current();
            sourceReady = true;
          } catch (error) {
            live = false;
            throw error;
          }
          return lease;
        },
      }),
      this.tokens.source,
    );
    this.state = Object.freeze({
      prepare: this.prepare.bind(this),
      readPreparationOriginal: this.readPreparationOriginal.bind(this),
      readCurrent: this.readCurrent.bind(this),
      commitDispatch: this.commitDispatch.bind(this),
      inspectCommitted: this.inspectCommitted.bind(this),
      settle: this.settle.bind(this),
    });
    this.inventory = Object.freeze({
      acquire: this.openInventory.bind(this),
      reservation: (i: RepositoryWorkInventoryResponsibilityV2) =>
        this.inventoryMember(i).reservation!,
      transition: this.transitionInventory.bind(this),
      recover: this.recoverInventory.bind(this),
      acquireMint: this.mintInventory.bind(this),
      acquireRevocation: this.revokeInventory.bind(this),
      release: this.releaseInventory.bind(this),
    });
  }
  private releaseSelection(entry: Entry<B, V>): Promise<void> {
    return (entry.selectionRelease ??= Promise.resolve().then(() =>
      this.selection.release(entry.selection),
    ));
  }
  private inventoryMember(handle: RepositoryWorkInventoryResponsibilityV2): Inventory<B, V> {
    const scope = this.inventories.get(handle);
    if (!scope || scope.closing || scope.released || !scope.source || !scope.reservation) fail();
    return scope;
  }
  private trackedInventory<T>(scope: Inventory<B, V>, body: () => Promise<T>): Promise<T> {
    const result = Promise.resolve().then(body);
    scope.pending.add(result);
    void result.finally(() => scope.pending.delete(result)).catch(() => {});
    return result;
  }
  private inventoryOriginal(
    scope: Inventory<B, V>,
    original: WorkOriginalOperationV2,
    input: RepositoryTokenMutationV2,
  ): void {
    const expected = scope.entry.data.current.original;
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(original.operationRef) ||
      original.operationRef !== input.operationRef ||
      !equal(original.scope, expected.scope) ||
      original.invocationRef !== expected.invocationRef ||
      original.requestDigest !== expected.requestDigest ||
      !equal(input.scope, {
        installationId: expected.scope.installationRef,
        namespaceId: expected.scope.namespaceRef,
        agentId: expected.scope.agentRef,
      }) ||
      [
        scope.entry.data.preparation,
        expected,
        scope.entry.data.observation,
        ...(scope.entry.data.admission.kind === "new" ? [scope.entry.data.admission.original] : []),
      ].some((o) => o.operationRef === original.operationRef)
    )
      fail();
  }
  private liveInventory(scope: Inventory<B, V>, call: AuthorityCallV1): void {
    const entry = scope.entry;
    if (entry.settling || entry.useFailed || !entry.active || scope.closing || scope.released)
      fail();
    this.bounds(call);
    if (
      call.context !== entry.native.context ||
      call.recipientRef !== entry.native.receiverRef ||
      call.requestRef !== entry.request.request_ref
    )
      fail();
    const checked = this.native.assertNativeCurrent(entry.origin, call);
    if (checked !== undefined) {
      entry.useFailed = true;
      const joined = Promise.resolve(checked);
      scope.pending.add(joined);
      void joined.finally(() => scope.pending.delete(joined)).catch(() => {});
      fail();
    }
  }
  private async openInventory(
    p: RepositoryWorkStatePreparationV2<V>,
    origin: B["origin"],
    call: AuthorityCallV1,
  ) {
    const entry = this.original(p, origin);
    if (!this.selection.acquireInventory) return undefined;
    if (entry.inventory) fail(); // An original responsibility is acquired once, including refused acquisition.
    const scope: Inventory<B, V> = {
      entry,
      handle: Object.freeze({}) as RepositoryWorkInventoryResponsibilityV2,
      phases: new Map(),
      pending: new Set(),
      closing: false,
      released: false,
    };
    entry.inventory = scope;
    this.inventories.set(scope.handle, scope);
    scope.opening = this.trackedInventory(scope, async () => {
      let release: (() => Promise<void>) | undefined;
      try {
        await this.enrollNative(entry, call);
        this.liveInventory(scope, call);
        const source = await this.selection.acquireInventory!(entry.selection, origin, call);
        if (!source) return undefined;
        // Take cleanup before reading reservation data or any later method getter.
        release = source.release.bind(source);
        const offered = source.reservation;
        const original = own(offered, "original") as WorkOriginalOperationV2;
        snapshot(original); // Refuse accessors; retain the actual State-issued object.
        const input = parseRepositoryTokenMutationV2(own(offered, "input"));
        if (input.method !== "reserveRepositoryToken") fail();
        const reservation = Object.freeze({ original, input });
        const fixed = Object.freeze({
          reservation,
          selectOperation: source.selectOperation.bind(source),
          retainIssue: source.retainIssue.bind(source),
          retainObservation: source.retainObservation.bind(source),
          observationCall: source.observationCall.bind(source),
          release,
        });
        this.inventoryOriginal(scope, reservation.original, input);
        const access = input.lease,
          current = entry.current;
        if (
          !equal(access.original, current.original) ||
          !equal(access.work, current.work) ||
          !equal(access.execution, current.execution) ||
          !equal(access.target, entry.data.repositoryTarget) ||
          !equal(input.permissionProfile, current.repository.profile) ||
          !equal(
            input.requestedPermissions,
            this.protocolVersion === 3
              ? { contents: "read", metadata: "read" }
              : { metadata: "read" },
          ) ||
          Date.parse(access.notAfter) > Date.parse(current.originalHorizon) ||
          Date.parse(input.deadline) > Date.parse(access.notAfter) ||
          Date.parse(access.createdAt) < Date.parse(entry.data.workBeganAt)
        )
          fail();
        this.liveInventory(scope, call);
        scope.source = fixed;
        scope.reservation = input;
        return scope.handle;
      } catch {
        return undefined;
      } finally {
        if (!scope.source) {
          scope.closing = true;
          // The opening promise owns any unexpected asynchronous assertion;
          // exclude only itself when joining the refused acquisition.
          while ([...scope.pending].some((work) => work !== scope.opening))
            await Promise.allSettled([...scope.pending].filter((work) => work !== scope.opening));
          try {
            if (release) await release();
          } finally {
            scope.released = true;
            if (!entry.active) await this.releaseSelection(entry);
          }
        }
      }
    });
    return scope.opening;
  }
  private qualifyInventoryRecord(scope: Inventory<B, V>, record: RepositoryTokenRecordV2): void {
    if (
      !equal(record.issuance, scope.reservation) ||
      record.target.issuanceOperationRef !== scope.reservation!.operationRef ||
      record.target.intentDigest !== repositoryInventoryDigestV2(scope.reservation)
    )
      fail();
  }
  private qualifyInventoryOperation(
    scope: Inventory<B, V>,
    phase: InventoryPhase,
    operation: RepositoryInventoryOperationV2,
  ): void {
    if (!equal(operation.input, phase.input) || operation.digest !== phase.digest) fail();
    this.qualifyInventoryRecord(scope, operation.record);
  }
  private qualifyInventoryFacts(
    scope: Inventory<B, V>,
    phase: InventoryPhase,
    facts: RepositoryWorkInventoryFactsV2,
  ): void {
    if (
      !equal(facts.input, phase.input) ||
      repositoryInventoryDigestV2(facts.input) !== phase.digest
    )
      fail();
    const input = phase.input;
    if (input.method === "reserveRepositoryToken") {
      if (
        !equal(input, scope.reservation) ||
        facts.record !== undefined ||
        facts.mintClaim !== undefined
      )
        fail();
      return;
    }
    const record = facts.record;
    if (!record) fail();
    this.qualifyInventoryRecord(scope, record);
    if (
      !equal(input.target, record.target) ||
      input.expectedInventoryVersion !== record.inventoryVersion
    )
      fail();
    if (input.method === "claimRepositoryMint") {
      if (
        record.state !== "reserved" ||
        facts.mintClaim !== undefined ||
        !equal(input.custodyIdentity.lease, scope.reservation!.lease) ||
        input.custodyIdentity.key.bindingRef !== scope.reservation!.bindingRef ||
        input.custodyIdentity.providerAttemptRef !== input.providerAttemptRef
      )
        fail();
    } else if ("providerAttemptRef" in record && record.providerAttemptRef !== null) {
      const claim = facts.mintClaim;
      if (
        !claim ||
        claim.providerAttemptRef !== record.providerAttemptRef ||
        claim.recordRef !== record.target.recordRef ||
        claim.issuanceIntentDigest !== record.target.intentDigest ||
        claim.issuanceOperationRef !== scope.reservation!.operationRef
      )
        fail();
      if (
        input.method === "recordRepositoryMint" &&
        input.providerAttemptRef !== record.providerAttemptRef
      )
        fail();
    }
    // Protected material/returned evidence/revocation are independently qualified
    // by the original custody source in this same State unit, not by these data.
  }
  private async transitionInventory(
    handle: RepositoryWorkInventoryResponsibilityV2,
    raw: RepositoryTokenMutationV2,
    liveCall?: AuthorityCallV1,
  ): Promise<RepositoryWorkInventoryResultV2> {
    const scope = this.inventoryMember(handle);
    const input = parseRepositoryTokenMutationV2(raw);
    return this.trackedInventory(scope, async () => {
      const live = liveMutation(input);
      const call = live ? (liveCall ?? fail()) : await scope.source!.observationCall();
      if (live) {
        await this.enrollNative(scope.entry, call);
        this.liveInventory(scope, call);
      } else this.bounds(call);
      // Reserve is the fixed original selected input. All other phase originals
      // come from the same original State selection, never from the caller.
      const original =
        input.method === "reserveRepositoryToken"
          ? scope.source!.reservation.original
          : await scope.source!.selectOperation(input, call);
      const originalData = snapshot(original);
      this.inventoryOriginal(scope, originalData, input);
      if (
        this.operations.has(original) ||
        scope.phases.has(original.operationRef) ||
        scope.phases.size >= 128
      )
        fail();
      if (input.method === "reserveRepositoryToken" && !equal(input, scope.reservation)) fail();
      const phase: InventoryPhase = {
        original,
        originalData,
        input,
        digest: repositoryInventoryDigestV2(input),
      };
      scope.phases.set(original.operationRef, phase);
      const mode = live ? "inventory-issue" : "inventory-observation";
      this.operations.set(original, {
        entry: scope.entry,
        mode,
        originalData: phase.originalData,
        inventory: scope,
        phase,
      });
      const result = await this.run(scope.entry, original, call, mode, async (unit) => {
        if (live) {
          const rows = await unit.readForMutation(
            scope.entry.current.work,
            scope.entry.current.execution,
          );
          compareRepositoryWorkStateReadsetV2(rows, scope.entry.current);
        }
        return unit.stageRepositoryInventory(input);
      });
      if (result.kind === "unknown")
        return { kind: "unknown", operationRef: original.operationRef };
      if (result.kind === "not-committed") return { kind: "not-committed" };
      const transition = result.value;
      if (transition.kind !== "staged") return transition;
      const operation = this.recognizeInventory(result.commit, original);
      this.qualifyInventoryOperation(scope, phase, operation);
      if (!equal(operation, transition.operation)) fail();
      if (input.method === "claimRepositoryRevocation") {
        const cleanupClaim = Object.freeze({}) as RepositoryWorkInventoryCleanupClaimV2;
        this.inventoryCleanupClaims.set(cleanupClaim, {
          inventory: scope,
          phase,
          commit: result.commit,
          used: false,
        });
        return { kind: "committed", operation, cleanupClaim };
      }
      if (input.method !== "claimRepositoryMint") return { kind: "committed", operation };
      const claim = Object.freeze({}) as RepositoryWorkInventoryClaimV2;
      this.inventoryClaims.set(claim, {
        inventory: scope,
        phase,
        commit: result.commit,
        used: false,
      });
      return { kind: "committed", operation, claim };
    });
  }
  private async recoverInventory(
    handle: RepositoryWorkInventoryResponsibilityV2,
    operationRef: string,
  ) {
    const scope = this.inventoryMember(handle),
      phase = scope.phases.get(operationRef);
    if (!phase) fail();
    return this.trackedInventory(scope, async () => {
      const call = await scope.source!.observationCall();
      const result = await this.run(
        scope.entry,
        phase.original,
        call,
        "inventory-observation",
        (unit) => unit.readRepositoryInventoryOperation(),
      );
      if (result.kind !== "committed") return { kind: "unavailable" as const };
      if (!result.value) return { kind: "absent" as const };
      this.qualifyInventoryOperation(scope, phase, result.value);
      return { kind: "recorded" as const, operation: result.value };
    });
  }
  private async mintInventory(
    handle: RepositoryWorkInventoryResponsibilityV2,
    claim: RepositoryWorkInventoryClaimV2,
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkCommittedMintUseLeaseV2 | undefined> {
    const scope = this.inventoryMember(handle),
      member = this.inventoryClaims.get(claim);
    if (!member || member.inventory !== scope || member.used) fail();
    member.used = true;
    return this.trackedInventory(scope, async () => {
      await this.enrollNative(scope.entry, call);
      this.liveInventory(scope, call);
      const lease = await this.acquireCommittedMint(member.commit, call);
      if (!lease) return undefined;
      const release = lease.release.bind(lease);
      let accepted = false;
      try {
        const operation = snapshot(lease.operation),
          check = lease.assertCurrent.bind(lease),
          begin = lease.beginSubmittedUse.bind(lease);
        this.qualifyInventoryOperation(scope, member.phase, operation);
        this.liveInventory(scope, call);
        let done: () => void = () => {};
        const drain = new Promise<void>((resolve) => {
          done = resolve;
        });
        scope.pending.add(drain);
        let joined: Promise<void> | undefined;
        const result = Object.freeze({
          operation,
          assertCurrent: check,
          beginSubmittedUse: begin,
          release: () =>
            (joined ??= Promise.resolve()
              .then(release)
              .finally(() => {
                scope.pending.delete(drain);
                done();
              })),
        });
        accepted = true;
        return result;
      } finally {
        if (!accepted) await release();
      }
    });
  }
  private async revokeInventory(
    handle: RepositoryWorkInventoryResponsibilityV2,
    claim: RepositoryWorkInventoryCleanupClaimV2,
  ): Promise<RepositoryWorkInventoryRevocationUseV2 | undefined> {
    const scope = this.inventoryMember(handle),
      member = this.inventoryCleanupClaims.get(claim);
    if (!member || member.inventory !== scope || member.used) fail();
    member.used = true;
    return this.trackedInventory(scope, async () => {
      const call = await scope.source!.observationCall();
      this.bounds(call);
      const fixedCall = {
        context: call.context,
        signal: call.signal,
        requestRef: call.requestRef,
        recipientRef: call.recipientRef,
        deadline: call.deadline,
      };
      const checkCall = () => {
        if (
          scope.closing ||
          scope.released ||
          Object.entries(fixedCall).some(([k, v]) => call[k as keyof AuthorityCallV1] !== v)
        )
          fail();
        this.bounds(call);
      };
      checkCall();
      const lease = await this.acquireCommittedRevocation(member.commit, call);
      if (!lease) return undefined;
      const release = lease.release.bind(lease);
      let accepted = false;
      try {
        const operation = snapshot(lease.operation),
          current = lease.assertCurrent.bind(lease),
          begin = lease.beginSubmittedUse.bind(lease);
        this.qualifyInventoryOperation(scope, member.phase, operation);
        checkCall();
        let done: () => void = () => {};
        const drain = new Promise<void>((resolve) => {
          done = resolve;
        });
        scope.pending.add(drain);
        let joined: Promise<void> | undefined;
        const synchronous = (check: () => undefined): undefined => {
          checkCall();
          const result = check();
          if (result !== undefined) {
            const unexpected = Promise.resolve(result);
            scope.pending.add(unexpected);
            void unexpected.finally(() => scope.pending.delete(unexpected)).catch(() => {});
            fail();
          }
          checkCall();
          return undefined;
        };
        accepted = true;
        return Object.freeze({
          operation,
          call,
          assertCurrent: () => synchronous(current),
          beginSubmittedUse: () => synchronous(begin),
          release: () =>
            (joined ??= Promise.resolve()
              .then(release)
              .finally(() => {
                scope.pending.delete(drain);
                done();
              })),
        });
      } finally {
        if (!accepted) await release();
      }
    });
  }
  private releaseInventory(handle: RepositoryWorkInventoryResponsibilityV2): Promise<void> {
    const scope = this.inventories.get(handle);
    if (!scope) return Promise.reject(new Error("Original inventory responsibility unavailable."));
    if (scope.joined) return scope.joined;
    scope.closing = true;
    scope.joined = Promise.resolve().then(async () => {
      while (scope.pending.size) await Promise.allSettled([...scope.pending]);
      for (const phase of scope.phases.values()) this.operations.delete(phase.original);
      try {
        if (scope.source) await scope.source.release();
      } finally {
        scope.released = true;
        if (!scope.entry.active) await this.releaseSelection(scope.entry);
      }
    });
    return scope.joined;
  }
  private nativeBinding(raw: RepositoryWorkNativeBindingV2): RepositoryWorkNativeBindingV2 {
    return Object.freeze({
      context: own(raw, "context") as RepositoryWorkNativeBindingV2["context"],
      transportBinding: own(raw, "transportBinding") as object,
      attachmentRef: own(raw, "attachmentRef") as string,
      receiverRef: own(raw, "receiverRef") as string,
      execution: snapshot(own(raw, "execution") as RepositoryWorkNativeBindingV2["execution"]),
      service: snapshot(own(raw, "service") as RepositoryWorkNativeBindingV2["service"]),
    });
  }
  private async inspectNative(
    origin: B["origin"],
    retained: RepositoryWorkNativeBindingV2,
    request: OpenRead<V>,
    call: AuthorityCallV1,
  ): Promise<void> {
    const fields = ["context", "signal", "requestRef", "recipientRef", "deadline"] as const;
    const before = fields.map((name) => own(call, name));
    this.bounds(call);
    const native = this.nativeBinding(await this.native.inspectNative(origin, call));
    if (fields.some((name, i) => own(call, name) !== before[i])) fail();
    this.bounds(call);
    if (
      native.context !== call.context ||
      native.receiverRef !== call.recipientRef ||
      call.requestRef !== request.request_ref ||
      native.attachmentRef !== request.attachment_ref ||
      !native.transportBinding ||
      typeof native.transportBinding !== "object" ||
      native.context !== retained.context ||
      native.transportBinding !== retained.transportBinding ||
      native.attachmentRef !== retained.attachmentRef ||
      native.receiverRef !== retained.receiverRef ||
      !equal(native.execution, retained.execution) ||
      !equal(native.service, retained.service)
    )
      fail();
  }
  private enrollNative(entry: Entry<B, V>, call: AuthorityCallV1): Promise<void> {
    // Register ownership before entering even a synchronous supplier callback.
    // Settlement invalidates new entry immediately, then joins this actual work.
    const pending = Promise.resolve().then(async () => {
      if (!entry.active || entry.settling || entry.useFailed) fail();
      try {
        await this.inspectNative(entry.origin, entry.native, entry.request, call);
        if (!entry.active || entry.settling || entry.useFailed) fail();
      } catch (error) {
        entry.useFailed = true;
        throw error;
      }
    });
    entry.nativePending.add(pending);
    void pending.then(
      () => entry.nativePending.delete(pending),
      () => entry.nativePending.delete(pending),
    );
    return pending;
  }
  private bounds(call: AuthorityCallV1) {
    const remaining = Date.parse(call.deadline) - Date.now();
    if (call.signal.aborted || !Number.isFinite(remaining) || remaining <= 0) fail();
    return { signal: call.signal, timeoutMs: Math.min(remaining, this.transactionMilliseconds) };
  }
  private async enrolled<T>(
    entry: Entry<B, V>,
    original: WorkOriginalOperationV2,
    mode: Run<B, V>["mode"],
    body: () => Promise<T>,
  ): Promise<T> {
    const run: Run<B, V> = { entry, original, mode, live: true };
    try {
      return await this.activeRun.run(run, body);
    } finally {
      run.live = false;
    }
  }
  private run<T>(
    entry: Entry<B, V>,
    original: WorkOriginalOperationV2,
    call: AuthorityCallV1,
    mode: Run<B, V>["mode"],
    body: (unit: Parameters<Parameters<RepositoryWorkStoreV2["run"]>[3]>[0]) => Promise<T>,
  ) {
    return this.enrolled(entry, original, mode, async () => {
      if (mode !== "observation" && mode !== "inventory-observation") {
        // This runs before opening State's transaction or acquiring custody.
        // No full State fence is permitted across the original readset gap.
        try {
          if (entry.useFailed) fail();
          await this.enrollNative(entry, call);
          for (const after of [false, true]) {
            if (after) await this.selection.prepareStateUse(entry.selection, entry.origin, call);
            const checked: unknown = this.native.assertNativeCurrent(entry.origin, call);
            if (checked !== undefined) {
              entry.useFailed = true;
              await Promise.allSettled([Promise.resolve(checked)]);
              fail();
            }
            this.bounds(call);
          }
        } catch (error) {
          entry.useFailed = true;
          throw error;
        }
      }
      return this.store.run(original, call, this.bounds(call), body);
    });
  }
  private original(p: RepositoryWorkStatePreparationV2<V>, origin?: B["origin"]): Entry<B, V> {
    const entry = this.entries.get(p);
    if (
      !entry ||
      !entry.active ||
      entry.settling ||
      (origin !== undefined && entry.origin !== origin)
    )
      fail();
    return entry;
  }
  private selectionOriginals(data: RepositoryWorkSelectionDataV2<V>): SelectionOriginals {
    const current = own(data, "current") as RepositoryWorkCurrentV2<V>;
    const admission = own(data, "admission") as RepositoryWorkSelectionDataV2<V>["admission"];
    return Object.freeze({
      preparation: own(data, "preparation") as WorkOriginalOperationV2,
      dispatch: own(current, "original") as WorkOriginalOperationV2,
      observation: own(data, "observation") as WorkOriginalOperationV2,
      ...(own(admission, "kind") === "new"
        ? { admission: own(admission, "original") as WorkOriginalOperationV2 }
        : {}),
    });
  }
  private async prepare(
    origin: B["origin"],
    request: OpenRead<V>,
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkStatePreparationV2<V> | undefined> {
    const captured = snapshot(request);
    const decoded = decodeGitHubMediationRequest(
      new TextEncoder().encode(JSON.stringify(captured)),
      this.protocolVersion,
    );
    if (decoded?.method !== "open-read" || captured.version !== this.protocolVersion) fail();
    request = captured;
    // Preserve initial full inspection; refresh the actual native RPC before
    // selection acquisition can use its first native/cutoff-dependent fence.
    const native = this.nativeBinding(await this.native.inspect(origin, call));
    await this.inspectNative(origin, native, request, call);
    const selection = await this.selection.acquire(origin, request, call);
    if (selection === undefined) return undefined;
    let accepted = false;
    try {
      const supplied = await this.selection.inspect(selection, origin, call);
      const originals = this.selectionOriginals(supplied);
      const raw = snapshot(supplied);
      const current = compareRepositoryWorkCurrentV2(
        raw.current,
        request,
        native,
        Date.now(),
        this.protocolVersion,
      );
      repositoryTargetDigestV2({ ...raw.repositoryTarget });
      const originalData = [
        raw.preparation,
        raw.current.original,
        raw.observation,
        ...(raw.admission.kind === "new" ? [raw.admission.original] : []),
      ];
      if (
        new Set(originalData.map((o) => o.operationRef)).size !== originalData.length ||
        originalData.some(
          (o) =>
            !equal(o.scope, current.original.scope) ||
            o.requestDigest !== current.original.requestDigest ||
            o.invocationRef !== current.original.invocationRef,
        ) ||
        !/^github-native\/[a-f0-9]{32}(?![\s\S])/.test(raw.sessionRef) ||
        raw.repositoryTarget.installationId !== current.original.scope.installationRef ||
        raw.repositoryTarget.repositoryId !== current.repository.id
      )
        fail();
      if (raw.admission.kind === "new") compareAdmission(raw.admission.record, current);
      const entry: Entry<B, V> = {
        origin,
        selection,
        request: snapshot(request),
        data: raw,
        originals,
        native,
        nativePending: new Set(),
        current,
        active: true,
        settling: false,
        dispatchEntered: false,
      };
      this.operations.set(originals.preparation, {
        entry,
        mode: "preparation",
        originalData: raw.preparation,
      });
      this.operations.set(originals.dispatch, {
        entry,
        mode: "dispatch",
        originalData: raw.current.original,
      });
      this.operations.set(originals.observation, {
        entry,
        mode: "observation",
        originalData: raw.observation,
      });
      try {
        if (raw.admission.kind === "new") {
          const admission = raw.admission;
          this.operations.set(originals.admission!, {
            entry,
            mode: "admission",
            originalData: admission.original,
          });
          const admitted = await this.run(entry, originals.admission!, call, "admission", (unit) =>
            unit.stageAdmission(admission.record),
          );
          if (admitted.kind !== "committed") return undefined;
        } else if (
          raw.admission.originalAdmission.kind !== "admission" ||
          !equal(raw.admission.originalAdmission.scope, {
            installationId: current.original.scope.installationRef,
            namespaceId: current.original.scope.namespaceRef,
            agentId: current.original.scope.agentRef,
            revisionRef: current.original.scope.revisionRef,
          })
        )
          fail();
        const preparation: RepositoryWorkPreparationV2 = snapshot({
          workRef: current.work.workRef,
          workRevision: current.work.revision,
          requestDigest: current.original.requestDigest,
          receiverRef: current.execution.receiverRef,
          sessionRef: raw.sessionRef,
          dnsBindingRef: current.dnsBindingRef,
          repositoryTarget: { ...raw.repositoryTarget },
          ...(this.protocolVersion === 3
            ? { repositoryRequest: repositoryWorkGitReadBindingV3(request as OpenRead<3>) }
            : {}),
        });
        const result = await this.run(
          entry,
          originals.preparation,
          call,
          "preparation",
          async (unit) => {
            const rows = await unit.readForMutation(current.work, current.execution);
            compareRepositoryWorkStateReadsetV2(rows, current);
            await unit.stagePreparation(preparation);
            unit.assertCurrent();
          },
        );
        if (result.kind !== "committed") return undefined;
        const p = Object.freeze({}) as RepositoryWorkStatePreparationV2<V>;
        this.entries.set(p, entry);
        accepted = true;
        return p;
      } finally {
        if (!accepted) {
          entry.active = false;
          for (const original of Object.values(originals)) this.operations.delete(original);
        }
      }
    } finally {
      if (!accepted) await this.selection.release(selection);
    }
  }
  private async readPreparationOriginal(
    p: RepositoryWorkStatePreparationV2<V>,
    origin: B["origin"],
    call: AuthorityCallV1,
  ): Promise<WorkOriginalOperationV2> {
    const entry = this.original(p, origin);
    this.bounds(call);
    if (
      call.context !== entry.native.context ||
      call.recipientRef !== entry.native.receiverRef ||
      call.requestRef !== entry.request.request_ref
    )
      fail();
    // Fixed recorded data from the privately recognized acknowledged P. This
    // read does not create a transaction, witness or new authority.
    return entry.data.preparation;
  }
  private async readCurrent(
    p: RepositoryWorkStatePreparationV2<V>,
    origin: B["origin"],
    call: AuthorityCallV1,
  ): Promise<RepositoryWorkCurrentV2<V>> {
    const entry = this.original(p, origin);
    await this.enrollNative(entry, call);
    const supplied = await this.selection.inspect(entry.selection, origin, call);
    const originals = this.selectionOriginals(supplied);
    if (
      originals.preparation !== entry.originals.preparation ||
      originals.dispatch !== entry.originals.dispatch ||
      originals.observation !== entry.originals.observation ||
      originals.admission !== entry.originals.admission
    )
      fail();
    const selected = snapshot(supplied);
    // Runtime.inspect owns initial assignment acquisition and must not reopen
    // it between units. Current policy/rows are qualified inside prepareUse.
    const native = entry.native,
      current = compareRepositoryWorkCurrentV2(
        selected.current,
        entry.request,
        native,
        Date.now(),
        this.protocolVersion,
      );
    const { validUntil: _a, ...before } = entry.data.current,
      { validUntil: _b, ...after } = current;
    const { current: _initial, ...fixedBefore } = entry.data,
      { current: _selected, ...fixedAfter } = selected;
    if (!equal(before, after) || !equal(fixedBefore, fixedAfter)) fail();
    entry.current = current;
    const result = await this.run(
      entry,
      entry.originals.dispatch,
      call,
      "current",
      async (unit) => {
        const rows = await unit.readForMutation(current.work, current.execution);
        compareRepositoryWorkStateReadsetV2(rows, current);
        unit.assertCurrent();
      },
    );
    if (result.kind !== "committed") fail();
    return current;
  }
  private async commitDispatch(
    p: RepositoryWorkStatePreparationV2<V>,
    origin: B["origin"],
    token: B["token"],
    request: DispatchRead<V>,
    expected: RepositoryWorkCurrentV2<V>,
    call: AuthorityCallV1,
  ) {
    const entry = this.original(p, origin);
    if (entry.dispatchEntered || !equal(entry.current, expected)) fail();
    const wire = snapshot(request);
    const decoded = decodeGitHubMediationRequest(
      new TextEncoder().encode(JSON.stringify(wire)),
      this.protocolVersion,
    );
    if (
      decoded?.method !== "dispatch-read" ||
      wire.version !== this.protocolVersion ||
      !/^[a-f0-9]{32}(?![\s\S])/.test(wire.session_ref) ||
      wire.effect_ref !== entry.data.preparation.operationRef ||
      wire.request_ref !== entry.request.request_ref ||
      wire.request_sha256 !== entry.data.current.original.requestDigest ||
      wire.dns_binding_ref !== expected.dnsBindingRef
    )
      fail();
    await this.enrollNative(entry, call);
    const supplied = this.tokens.inspect(token, entry.selection);
    const receiver = own(supplied, "receiver"),
      session = own(supplied, "session");
    if (!receiver || typeof receiver !== "object" || !session || typeof session !== "object")
      fail();
    const material = snapshot({
      accessLeaseRef: own(supplied, "accessLeaseRef"),
      inventoryRecordRef: own(supplied, "inventoryRecordRef"),
      inventoryVersion: own(supplied, "inventoryVersion"),
      releaseRef: own(supplied, "releaseRef"),
      repositoryTarget: own(supplied, "repositoryTarget"),
    });
    if (!equal(material.repositoryTarget, entry.data.repositoryTarget)) fail();
    const dispatch: RepositoryWorkDispatchV2 = snapshot({
      accessLeaseRef: material.accessLeaseRef as string,
      inventoryRecordRef: material.inventoryRecordRef as string,
      inventoryVersion: material.inventoryVersion as number,
      releaseRef: material.releaseRef as string,
      preparationOperationRef: entry.data.preparation.operationRef,
      workRef: expected.work.workRef,
      workRevision: expected.work.revision,
      requestDigest: expected.original.requestDigest,
      receiverRef: expected.execution.receiverRef,
      sessionRef: entry.data.sessionRef,
      dnsBindingRef: wire.dns_binding_ref,
      repositoryTarget: { ...entry.data.repositoryTarget },
      ...(this.protocolVersion === 3
        ? { repositoryRequest: repositoryWorkGitReadBindingV3(entry.request as OpenRead<3>) }
        : {}),
    });
    entry.dispatch = dispatch;
    entry.brokerDispatch = wire;
    entry.token = token;
    entry.receiver = receiver;
    entry.session = session;
    entry.dispatchEntered = true;
    const result = await this.run(
      entry,
      entry.originals.dispatch,
      call,
      "dispatch",
      async (unit) => {
        const rows = await unit.readForMutation(expected.work, expected.execution);
        compareRepositoryWorkStateReadsetV2(rows, expected);
        await unit.stageDispatchAndRelease(dispatch);
        unit.assertCurrent();
      },
    );
    if (result.kind !== "committed")
      return result.kind === "unknown"
        ? { kind: "unknown" as const }
        : { kind: "not-committed" as const };
    entry.commit = result.commit;
    this.commits.set(result.commit, entry);
    const recognized = this.recognize(result.commit, dispatch.releaseRef, receiver, session);
    if (
      !equal(recognized.dispatch, dispatch) ||
      recognized.operationRef !== expected.original.operationRef
    )
      fail();
    return { kind: "committed" as const, receipt: result.commit };
  }
  private inspectCommitted(
    receipt: RepositoryWorkCommittedV2,
    p: RepositoryWorkStatePreparationV2<V>,
    token: B["token"],
  ): Readonly<{ releaseRef: string }> {
    const entry = this.original(p);
    if (
      this.commits.get(receipt) !== entry ||
      entry.token !== token ||
      entry.commit !== receipt ||
      !entry.dispatch ||
      !entry.brokerDispatch ||
      entry.brokerDispatch.effect_ref !== entry.dispatch.preparationOperationRef ||
      entry.dispatch.sessionRef !== entry.data.sessionRef
    )
      fail();
    const known = this.recognize(
      receipt,
      entry.dispatch.releaseRef,
      entry.receiver!,
      entry.session!,
    );
    if (
      !equal(known.dispatch, entry.dispatch) ||
      known.operationRef !== entry.data.current.original.operationRef
    )
      fail();
    return Object.freeze({ releaseRef: entry.dispatch.releaseRef });
  }
  private settle(
    p: RepositoryWorkStatePreparationV2<V>,
    receipt: RepositoryWorkCommittedV2 | undefined,
    outcome: GitHubMediationOutcome,
  ): Promise<"recorded" | "unavailable"> {
    const entry = this.entries.get(p);
    if (!entry || (receipt !== undefined && entry.commit !== receipt))
      return Promise.resolve("unavailable");
    if (entry.joined) return entry.joined;
    entry.settling = true;
    entry.joined = Promise.resolve().then(async () => {
      let result: "recorded" | "unavailable" = "unavailable";
      try {
        while (entry.nativePending.size) await Promise.allSettled([...entry.nativePending]);
        if (!entry.dispatchEntered) result = "recorded";
        else {
          const call = await this.selection.observationCall(entry.selection);
          const recovered = await this.enrolled(
            entry,
            entry.originals.dispatch,
            "observation",
            () => this.store.recoverAfterUnwind(entry.originals.dispatch, call, this.bounds(call)),
          );
          if (
            recovered.kind === "recorded" &&
            recovered.operation.kind === "dispatch" &&
            recovered.operation.operationRef === entry.data.current.original.operationRef &&
            recovered.operation.requestDigest === entry.data.current.original.requestDigest &&
            equal(recovered.operation.document, entry.dispatch)
          ) {
            const observed = await this.run(
              entry,
              entry.originals.observation,
              call,
              "observation",
              async (unit) => {
                await unit.appendObservation({
                  observationRef: entry.data.observationRef,
                  dispatchOperationRef: entry.data.current.original.operationRef,
                  outcome,
                  evidenceRef: entry.data.observationEvidenceRef,
                });
                unit.assertCurrent();
              },
            );
            if (observed.kind === "committed") result = "recorded";
          }
        }
      } catch {
        /* No absence/noncommit inference; original durable owner retains uncertainty. */
      } finally {
        entry.active = false;
        for (const original of Object.values(entry.originals)) this.operations.delete(original);
        try {
          // Inventory owns its independent observer/mitigation exchange until
          // custody joins the original provider attempt and releases it. Work
          // settlement invalidates new issuance without deleting that enrollment.
          if (!entry.inventory || entry.inventory.released) await this.releaseSelection(entry);
        } catch {
          result = "unavailable";
        }
      }
      return result;
    });
    return entry.joined;
  }
}
