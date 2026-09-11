import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Real TypeScript checks against the actual source and its actual imports. These
// compile-only fixtures create no runtime participant, transaction, permit or effect.
// Original suppliers author their own examples; these are author structural tests.
const source = fileURLToPath(
  new URL("../../packages/occ/src/lifecycle/work-authority-ports-v2.ts", import.meta.url),
);
const prelude = `
import type * as W from "../../packages/occ/src/lifecycle/work-authority-ports-v2.ts";
import type { ExactAttemptV1 } from "@openclaw-enterprise/contracts/completed-context-v1";
import type { ExactDeliveryOperationV1 } from "@openclaw-enterprise/contracts/turn-journal-v1";
// Synthetic parameter markers make return-type inspection usable without
// manufacturing the default-never private participants or invoking any port.
import { RepositoryWorkOperationOwnerV2 } from "../../packages/occ/src/lifecycle/repository-work-v2.ts";
import type { RepositoryWorkSourcesV2, RepositoryWorkLimitsV2, OriginalRepositoryPreparationV2, OriginalCommittedRepositoryReleaseV2 } from "../../packages/occ/src/lifecycle/repository-work-v2.ts";
import { RepositoryWorkStateAdapterV2 } from "../../packages/occ/src/lifecycle/repository-work-state-v2.ts";
import type { RepositoryWorkStateBindingsV2, RepositoryWorkStatePreparationV2, RepositoryWorkSelectionSourceV2, RepositoryWorkTokenBindingV2 } from "../../packages/occ/src/lifecycle/repository-work-state-v2.ts";
import type { RepositoryWorkStateBindingV2, RepositoryWorkCommittedV2 } from "../../packages/occ/src/ports/repository-work-v2.ts";
import type { GitHubMediationOperationOwner } from "../../packages/occ/src/github-mediation-v2/ports.ts";
type RecoveryFixtureBindings = { readonly [K in keyof W.WorkPrivateBindingsV2]: K };
type AdapterBindings<B extends RepositoryWorkStateBindingsV2,V extends W.WorkRepositoryProtocolVersionV2> = {
  origin:B["origin"];preparation:RepositoryWorkStatePreparationV2<V>;token:B["token"];commit:RepositoryWorkCommittedV2;
};
type AdapterNative<V extends W.WorkRepositoryProtocolVersionV2> = RepositoryWorkSourcesV2<AdapterBindings<never,V>,V>["native"];
declare const stateBinding:RepositoryWorkStateBindingV2;
declare const native2:AdapterNative<2>,native3:AdapterNative<3>;
declare const selection2:RepositoryWorkSelectionSourceV2<never,2>,selection3:RepositoryWorkSelectionSourceV2<never,3>;
declare const tokens:RepositoryWorkTokenBindingV2<never>;
`;
const cases = [
  {
    name: "explicit Git use retains exact operation, ordered permissions and request declaration",
    code: `declare const intent: W.WorkRepositoryUseIntentV3;
const version:3=intent.protocolVersion;const operation:"git:read"=intent.repositoryOperation;
const permissions:readonly ["contents:read","metadata:read"]=intent.requiredPermissions;
const body:W.WorkRepositoryGitReadV3=intent.repositoryRequest;
const originalUse:W.WorkRepositoryUseIntentV2=intent;`,
  },
  {
    name: "Git use cannot replace its ordered permission arm",
    reject: true,
    code: `declare const intent:W.WorkRepositoryUseIntentV3;const changed:W.WorkRepositoryUseIntentV3={...intent,requiredPermissions:["metadata:read","contents:read"]};`,
  },
  {
    name: "Git use cannot omit its body declaration",
    reject: true,
    code: `declare const intent:Omit<W.WorkRepositoryUseIntentV3,"repositoryRequest">;const complete:W.WorkRepositoryUseIntentV3=intent;`,
  },
  {
    name: "default metadata owner and explicit Git owner bind their exact broker version",
    code: `declare const two:RepositoryWorkSourcesV2;declare const three:RepositoryWorkSourcesV2<never,3>;declare const limits:RepositoryWorkLimitsV2;
const metadata=new RepositoryWorkOperationOwnerV2(two,limits);
const git=new RepositoryWorkOperationOwnerV2<never,3>(three,limits,{protocolVersion:3});
const b2:GitHubMediationOperationOwner<OriginalRepositoryPreparationV2,OriginalCommittedRepositoryReleaseV2>=metadata;
const b3:GitHubMediationOperationOwner<OriginalRepositoryPreparationV2<3>,OriginalCommittedRepositoryReleaseV2<3>,3>=git;`,
  },
  {
    name: "generic protected assembly forwards fixed options to both original constructors without casts",
    code: `function assemble<B extends RepositoryWorkStateBindingsV2,V extends W.WorkRepositoryProtocolVersionV2>(options:{
  readonly protocolVersion?:V;
  readonly sources:RepositoryWorkSourcesV2<AdapterBindings<B,NoInfer<V>>,NoInfer<V>>;
  readonly limits:RepositoryWorkLimitsV2;
  readonly binding:RepositoryWorkStateBindingV2;
  readonly selection:RepositoryWorkSelectionSourceV2<B,NoInfer<V>>;
  readonly tokens:RepositoryWorkTokenBindingV2<B>;
} & (V extends 2 ? {readonly protocolVersion?:2}:{readonly protocolVersion:3}) & ([W.WorkRepositoryProtocolVersionV2] extends[V]?never:unknown)) {
  const owner=new RepositoryWorkOperationOwnerV2<AdapterBindings<B,V>,V>(options.sources,options.limits,options);
  const adapter=new RepositoryWorkStateAdapterV2<B,V>(options.binding,options.sources.native,options.selection,options.tokens,1000,options);
  const state:RepositoryWorkSourcesV2<AdapterBindings<B,V>,V>["state"]=adapter.state;
  return {owner,state};
}`,
  },
  {
    name: "fixed options alias forwards across an unresolved generic version",
    code: `function forward<V extends W.WorkRepositoryProtocolVersionV2>(sources:RepositoryWorkSourcesV2<never,NoInfer<V>>,limits:RepositoryWorkLimitsV2,options:W.WorkRepositoryProtocolOptionsV2<V>){return new RepositoryWorkOperationOwnerV2<never,V>(sources,limits,options);}`,
  },
  {
    name: "literal options infer Git owner and adapter while omitted adapter options remain metadata",
    code: `declare const three:RepositoryWorkSourcesV2<never,3>;declare const limits:RepositoryWorkLimitsV2;
const owner:RepositoryWorkOperationOwnerV2<never,3>=new RepositoryWorkOperationOwnerV2(three,limits,{protocolVersion:3});
const adapter:RepositoryWorkStateAdapterV2<never,3>=new RepositoryWorkStateAdapterV2(stateBinding,native3,selection3,tokens,1000,{protocolVersion:3});
const metadata:RepositoryWorkStateAdapterV2<never,2>=new RepositoryWorkStateAdapterV2(stateBinding,native2,selection2,tokens,1000);`,
  },
  {
    name: "fixed metadata options retain the V2 constructors",
    code: `declare const two:RepositoryWorkSourcesV2<never,2>;declare const limits:RepositoryWorkLimitsV2;const options:W.WorkRepositoryProtocolOptionsV2<2>={};
const owner:RepositoryWorkOperationOwnerV2<never,2>=new RepositoryWorkOperationOwnerV2(two,limits,options);
const adapter:RepositoryWorkStateAdapterV2<never,2>=new RepositoryWorkStateAdapterV2(stateBinding,native2,selection2,tokens,1000,options);`,
  },
  ...[
    [
      "Git owner refuses empty fixed options",
      `declare const three:RepositoryWorkSourcesV2<never,3>;declare const limits:RepositoryWorkLimitsV2;new RepositoryWorkOperationOwnerV2<never,3>(three,limits,{});`,
    ],
    [
      "Git adapter refuses empty fixed options",
      `new RepositoryWorkStateAdapterV2<never,3>(stateBinding,native3,selection3,tokens,1000,{});`,
    ],
    [
      "Git adapter requires explicit options",
      `new RepositoryWorkStateAdapterV2<never,3>(stateBinding,native3,selection3,tokens,1000);`,
    ],
    [
      "owner sources cannot select Git when options are omitted",
      `declare const three:RepositoryWorkSourcesV2<never,3>;declare const limits:RepositoryWorkLimitsV2;new RepositoryWorkOperationOwnerV2(three,limits);`,
    ],
    [
      "adapter sources cannot select Git when options are omitted",
      `new RepositoryWorkStateAdapterV2(stateBinding,native3,selection3,tokens,1000);`,
    ],
    [
      "fixed Git owner refuses metadata sources",
      `declare const two:RepositoryWorkSourcesV2<never,2>;declare const limits:RepositoryWorkLimitsV2;new RepositoryWorkOperationOwnerV2(two,limits,{protocolVersion:3});`,
    ],
    [
      "fixed Git adapter refuses metadata native source",
      `new RepositoryWorkStateAdapterV2(stateBinding,native2,selection3,tokens,1000,{protocolVersion:3});`,
    ],
    [
      "fixed Git adapter refuses metadata selection source",
      `new RepositoryWorkStateAdapterV2(stateBinding,native3,selection2,tokens,1000,{protocolVersion:3});`,
    ],
    [
      "fixed metadata adapter refuses Git selection source",
      `new RepositoryWorkStateAdapterV2(stateBinding,native2,selection3,tokens,1000,{protocolVersion:2});`,
    ],
    [
      "explicit union adapter cannot select a trusted protocol",
      `declare const native:AdapterNative<2|3>;declare const selection:RepositoryWorkSelectionSourceV2<never,2|3>;declare const version:2|3;new RepositoryWorkStateAdapterV2<never,2|3>(stateBinding,native,selection,tokens,1000,{protocolVersion:version});`,
    ],
    [
      "union-valued owner options cannot widen a metadata source",
      `declare const two:RepositoryWorkSourcesV2<never,2>;declare const limits:RepositoryWorkLimitsV2;declare const version:2|3;new RepositoryWorkOperationOwnerV2(two,limits,{protocolVersion:version});`,
    ],
  ].map(([name, code]) => ({ name, code, reject: true, diagnosticCodes: [2345, 2554, 2769] })),
  {
    name: "Git constructor cannot omit explicit version selection",
    reject: true,
    diagnosticCodes: [2554],
    code: `declare const three:RepositoryWorkSourcesV2<never,3>;declare const limits:RepositoryWorkLimitsV2;new RepositoryWorkOperationOwnerV2<never,3>(three,limits);`,
  },
  {
    name: "runtime-selected union cannot select trusted Work constructor protocol",
    reject: true,
    diagnosticCodes: [2769],
    code: `declare const sources:RepositoryWorkSourcesV2<never,2|3>;declare const limits:RepositoryWorkLimitsV2;declare const version:2|3;new RepositoryWorkOperationOwnerV2<never,2|3>(sources,limits,{protocolVersion:version});`,
  },
  {
    name: "Git owner cannot occupy metadata broker",
    reject: true,
    code: `declare const git:RepositoryWorkOperationOwnerV2<never,3>;const broker:GitHubMediationOperationOwner<OriginalRepositoryPreparationV2,OriginalCommittedRepositoryReleaseV2>=git;`,
  },
  {
    name: "metadata owner cannot occupy Git broker",
    reject: true,
    code: `declare const metadata:RepositoryWorkOperationOwnerV2;const broker:GitHubMediationOperationOwner<OriginalRepositoryPreparationV2<3>,OriginalCommittedRepositoryReleaseV2<3>,3>=metadata;`,
  },
  {
    name: "metadata source cannot be widened to Git source",
    reject: true,
    code: `declare const metadata:RepositoryWorkSourcesV2;const git:RepositoryWorkSourcesV2<never,3>=metadata;`,
  },
  {
    name: "Git issue or renewal cannot replace repository use",
    reject: true,
    code: `declare const use:W.WorkRepositoryUseIntentV3;const issue:W.WorkRepositoryUseIntentV3={...use,operation:"work.repository-token.issue"};const renewal:W.WorkRepositoryUseIntentV3={...use,operation:"work.authority.renew"};`,
  },

  {
    name: "repository use keeps preparation, dispatch and check phases distinct",
    code: `declare const intent: W.WorkRepositoryUseIntentV2;
const operation: "work.repository.use" = intent.operation;
const phase: "preparation" | "dispatch" | "check" = intent.phase;
const policy: W.WorkPolicyIntentV2 = intent;
const serviceOperation: W.WorkServiceOperationV2 = operation;`,
  },
  {
    name: "authority renewal cannot replace repository use",
    reject: true,
    code: `declare const intent: W.WorkRepositoryUseIntentV2;
const replacement: W.WorkRepositoryUseIntentV2 = { ...intent, operation: "work.authority.renew" };`,
  },
  {
    name: "token issuance cannot replace repository use",
    reject: true,
    code: `declare const intent: W.WorkRepositoryUseIntentV2;
const replacement: W.WorkRepositoryUseIntentV2 = { ...intent, operation: "work.repository-token.issue" };`,
  },
  {
    name: "repository policy cannot omit original receiver or full execution",
    reject: true,
    code: `declare const intent: Omit<W.WorkRepositoryUseIntentV2, "receiverRef" | "execution">;
const incomplete: W.WorkRepositoryUseIntentV2 = intent;`,
  },
  {
    name: "repository use does not accept receiver activation phase",
    reject: true,
    code: `declare const intent: W.WorkRepositoryUseIntentV2;
const replacement: W.WorkRepositoryUseIntentV2 = { ...intent, phase: "activation" };`,
  },
  {
    name: "a logical Work identity is not an operation identity",
    reject: true,
    code: `declare const operation: W.WorkOperationRefV2;
const work: W.WorkRefV2 = operation;`,
  },
  {
    name: "a logical Work identity is not an invocation identity",
    reject: true,
    code: `declare const work: W.WorkRefV2;
const invocation: W.WorkInvocationRefV2 = work;`,
  },
  {
    name: "an inert candidate is not an activation release",
    reject: true,
    code: `declare const candidate: W.WorkCandidateRefV2;
const release: W.WorkReleaseRefV2 = candidate;`,
  },
  {
    name: "default native invocation dependency is unavailable",
    reject: true,
    code: `const native: Parameters<W.WorkInvocationComparisonPortV2["consume"]>[1] = {};`,
  },
  {
    name: "default service comparison cannot be manufactured",
    reject: true,
    code: `const service: Parameters<W.WorkAdmissionPortV2["stageAdmissionV2"]>[3] = {};`,
  },
  {
    name: "a copied lineage projection is not a private readset",
    reject: true,
    code: `declare const lineage: W.WorkLineageV2;
const held: Parameters<W.WorkAdmissionPortV2["stageAdmissionV2"]>[1] = lineage;`,
  },
  {
    name: "a scalar attempt ref cannot replace the full original attempt",
    reject: true,
    code: `const attempt: W.WorkExecutionAssociationV2["attempt"] = { attemptRef: "one" };`,
  },
  {
    name: "the full attempt is the existing journal contract",
    code: `declare const original: ExactAttemptV1;
const association: W.WorkExecutionAssociationV2["attempt"] = original;
const originalAgain: ExactAttemptV1 = association;`,
  },
  {
    name: "an attached child cannot omit its entire ancestry",
    reject: true,
    code: `const ancestors: Extract<W.WorkLineageV2, { kind: "attached-child" }>["ancestors"] = [];`,
  },
  {
    name: "a nonexecuting responsibility needs no invented attempt",
    code: `const execution: W.WorkAdmissionCandidateV2["execution"] = { kind: "nonexecuting" };`,
  },
  {
    name: "work and withdrawal revisions are distinct",
    reject: true,
    code: `declare const workRevision: W.WorkRevisionV2;
const withdrawalRevision: W.WorkWithdrawalRevisionV2 = workRevision;`,
  },
  {
    name: "unknown commit is not confirmed history",
    reject: true,
    code: `declare const unknown: Extract<W.WorkCommitResultV2<string, object>, { kind: "commit-unknown" }>;
const committed: Extract<W.WorkCommitResultV2<string, object>, { kind: "committed" }> = unknown;`,
  },
  {
    name: "recovery has a closed outcome family without retry authority",
    reject: true,
    code: `const recovered: W.WorkRecoveryResultV2<string> = { kind: "retry", value: "permit" };`,
  },
  {
    name: "authoritative noncommit remains distinct from unconfirmed",
    code: `declare const expectation: W.WorkRecoveryExpectationV2;
const absent: W.WorkRecoveryResultV2<string> = { kind: "definitively-not-committed", expectation };
const unknown: W.WorkRecoveryResultV2<string> = { kind: "unconfirmed", expectation };`,
  },
  {
    name: "every target retains clock and enforcement allowances",
    reject: true,
    code: `declare const incomplete: Omit<W.WorkWithdrawalConstraintV2, "clockAllowanceMs">;
const complete: W.WorkWithdrawalConstraintV2 = incomplete;`,
  },
  {
    name: "target and profile revisions cannot be omitted",
    reject: true,
    code: `declare const incomplete: Omit<W.WorkWithdrawalConstraintV2, "profile">;
const complete: W.WorkWithdrawalConstraintV2 = incomplete;`,
  },
  {
    name: "external-change anchors require their observation delay contract",
    reject: true,
    code: `const anchor: W.WorkWithdrawalConstraintV2["anchor"] = {
kind: "external-change", anchorContractRef: "original" };`,
  },
  {
    name: "candidate identity cannot be substituted for original activation history",
    reject: true,
    code: `declare const candidate: W.WorkIssueCandidateV2;
const history: W.WorkActivationHistoryV2 = candidate;`,
  },
  {
    name: "complete history cannot collapse to a missing receipt",
    reject: true,
    code: `const history: W.WorkDeliveryStateV2["history"] = null;`,
  },
  {
    name: "submitted delivery requires at least one original attempt record",
    reject: true,
    code: `declare const operation: ExactDeliveryOperationV1;
const history: W.WorkDeliveryStateV2["history"] = { kind: "submitted", operation, attempts: [] };`,
  },
  {
    name: "full delivery operation reuses the existing original type",
    code: `declare const operation: ExactDeliveryOperationV1;
const original: W.WorkDeliveryObservationV2["originalDeliveryOperation"] = operation;`,
  },
  {
    name: "observation cannot request posting authority",
    reject: true,
    code: `const operation: W.WorkDeliveryObservationV2["authorizationOperation"] = "work.delivery.submit";`,
  },
  {
    name: "expired eligibility is representable over an abstract delivery state",
    code: `declare const base: W.WorkDeliveryStateV2;
const expired: W.WorkDeliveryStateV2 = { ...base, postingEligibility: { kind: "expired", boundRef: "original" } };`,
  },
  {
    name: "later withdrawal does not change historical completed closure",
    code: `declare const base: W.WorkDeliveryStateV2;
declare const revision: W.WorkWithdrawalRevisionV2;
const withdrawn: W.WorkDeliveryStateV2 = { ...base,
 historicalClosure: { kind: "closed", closureRef: "original", cause: "completed" },
 postingEligibility: { kind: "withdrawn", revision, withdrawalRef: "later" } };`,
  },
  {
    name: "the existing send episode is required beside the original horizon",
    reject: true,
    code: `declare const incomplete: Omit<W.WorkDeliveryBoundsV2, "episode">;
const complete: W.WorkDeliveryBoundsV2 = incomplete;`,
  },
  {
    name: "V1 sender limits are preserved without choosing a Work duration",
    reject: true,
    code: `const attempts: W.WorkDeliveryBoundsV2["maximumCreateAttempts"] = 4;`,
  },
  {
    name: "admission cannot be relabelled as activation",
    reject: true,
    code: `declare const original: Extract<W.WorkPolicyIntentV2, { phase: "original" }>;
const intent: W.WorkPolicyIntentV2 = { ...original, operation: "work.admit", phase: "activation" };`,
  },
  {
    name: "a current observation participant cannot be replaced by a parsed evidence reference",
    reject: true,
    code: `const comparison: Parameters<W.WorkDeliveryObservationPortV2["appendDeliveryObservationV2"]>[1] = "evidence:original";`,
  },
  {
    name: "child admission has its own current lineage and service path",
    code: `type ChildArgs = Parameters<W.WorkAdmissionPortV2["stageChildAdmissionV2"]>;
const arity: ChildArgs["length"] = 4;
declare const child: ChildArgs[3];
const operation: "work.child.admit" = child.operation;
const lineageKind: "attached-child" = child.lineage.kind;`,
  },
  {
    name: "root admission cannot accept an attached-child candidate",
    reject: true,
    diagnosticCodes: [2322, 2719],
    code: `declare const child: Parameters<W.WorkAdmissionPortV2["stageChildAdmissionV2"]>[3];
const root: Parameters<W.WorkAdmissionPortV2["stageAdmissionV2"]>[4] = child;`,
  },
  {
    name: "general failed, cancelled and completed closure needs no delivery operands",
    code: `declare const original: W.WorkOriginalOperationV2;
declare const work: W.VersionedWorkRefV2;
declare const requiredJoinSet: W.WorkProfileRefV2;
const failed: W.WorkGeneralClosureV2 = {
 kind: "work-closure", original, work, requiredJoinSet,
 closure: { kind: "closed", closureRef: "original-failure", cause: "failed" },
 effectResolutionCutRef: "original-effects", protectedClosureEvidenceRef: "original-evidence" };
const cancelled: W.WorkGeneralClosureV2 = { ...failed,
 closure: { kind: "closed", closureRef: "original-cancellation", cause: "cancelled" } };
const completed: W.WorkGeneralClosureV2 = { ...failed,
 closure: { kind: "closed", closureRef: "original-completion", cause: "completed" } };`,
  },
  {
    name: "general closure retains the exact Work revision",
    reject: true,
    code: `declare const original: W.WorkGeneralClosureV2;
declare const incomplete: Omit<W.VersionedWorkRefV2, "revision">;
const closure: W.WorkGeneralClosureV2 = { ...original, work: incomplete };`,
  },
  {
    name: "general closure retains original operation scope",
    reject: true,
    code: `declare const base: W.WorkGeneralClosureV2;
declare const incomplete: Omit<W.WorkOriginalOperationV2, "scope">;
const closure: W.WorkGeneralClosureV2 = { ...base, original: incomplete };`,
  },
  {
    name: "general closure cannot omit the original join profile",
    reject: true,
    code: `declare const incomplete: Omit<W.WorkGeneralClosureV2, "requiredJoinSet">;
const closure: W.WorkGeneralClosureV2 = incomplete;`,
  },
  {
    name: "general closure cannot omit the original effect cut",
    reject: true,
    code: `declare const incomplete: Omit<W.WorkGeneralClosureV2, "effectResolutionCutRef">;
const closure: W.WorkGeneralClosureV2 = incomplete;`,
  },
  {
    name: "general closure cannot omit its protected evidence reference",
    reject: true,
    code: `declare const incomplete: Omit<W.WorkGeneralClosureV2, "protectedClosureEvidenceRef">;
const closure: W.WorkGeneralClosureV2 = incomplete;`,
  },
  {
    name: "a finite delivery seal is not a general closure record",
    reject: true,
    code: `declare const finite: W.WorkDeliverySealV2;
const general: W.WorkGeneralClosureV2 = finite;`,
  },
  {
    name: "general withdrawal needs no delivery or computation record",
    code: `declare const original: W.WorkOriginalOperationV2;
declare const work: W.VersionedWorkRefV2;
declare const expectedWithdrawalRevision: W.WorkWithdrawalRevisionV2;
const withdrawal: W.WorkGeneralWithdrawalV2 = {
 kind: "work-withdrawal", original, work, originalScopeRef: "original-scope",
 expectedWithdrawalRevision, cause: "security-revocation",
 protectedCauseEvidenceRef: "original-cause" };`,
  },
  {
    name: "general withdrawal cannot omit protected cause evidence",
    reject: true,
    code: `declare const incomplete: Omit<W.WorkGeneralWithdrawalV2, "protectedCauseEvidenceRef">;
const withdrawal: W.WorkGeneralWithdrawalV2 = incomplete;`,
  },
  {
    name: "general withdrawal compares a distinct withdrawal revision",
    reject: true,
    code: `declare const revision: W.WorkRevisionV2;
const expected: W.WorkGeneralWithdrawalV2["expectedWithdrawalRevision"] = revision;`,
  },
  {
    name: "a general later withdrawal is representable beside historical completion",
    code: `declare const withdrawal: W.WorkGeneralWithdrawalV2;
const history: Readonly<{ closure: W.WorkHistoricalClosureV2; laterWithdrawal: W.WorkGeneralWithdrawalV2 }> = {
 closure: { kind: "closed", closureRef: "original", cause: "completed" },
 laterWithdrawal: withdrawal };`,
  },
  {
    name: "a finite delivery withdrawal is not a general withdrawal record",
    reject: true,
    code: `declare const finite: W.WorkDeliveryWithdrawalV2;
const general: W.WorkGeneralWithdrawalV2 = finite;`,
  },
  {
    name: "general staging retains exact records, original unit and staged receipt slots",
    code: `// Synthetic slot markers test declaration mapping, not authentic private custody.
type Slots = { readonly [K in keyof W.WorkPrivateBindingsV2]: K };
type General = W.WorkGeneralLifecyclePortV2<Slots>;
type CloseArgs = Parameters<General["stageSealAndCloseV2"]>;
type WithdrawArgs = Parameters<General["stageWithdrawalV2"]>;
const closeArity: CloseArgs["length"] = 3;
const withdrawArity: WithdrawArgs["length"] = 4;
declare const unit: Parameters<W.WorkAdmissionPortV2["readForMutation"]>[0];
const closeUnit: CloseArgs[0] = unit;
const withdrawUnit: WithdrawArgs[0] = unit;
const closeReadset: CloseArgs[1] = "lineageReadSet";
const withdrawReadset: WithdrawArgs[1] = "lineageReadSet";
const comparison: WithdrawArgs[2] = "withdrawalComparison";
declare const closure: W.WorkGeneralClosureV2;
declare const withdrawal: W.WorkGeneralWithdrawalV2;
const closeInput: CloseArgs[2] = closure;
const withdrawInput: WithdrawArgs[3] = withdrawal;
type Closed = Extract<Awaited<ReturnType<General["stageSealAndCloseV2"]>>, { kind: "provisional" }>;
type Withdrawn = Extract<Awaited<ReturnType<General["stageWithdrawalV2"]>>, { kind: "provisional" }>;
const closedValue: Closed["value"] = closure;
const withdrawnValue: Withdrawn["value"] = withdrawal;
const closeReceipt: Closed["staged"] = "stagedReceipt";
const withdrawalReceipt: Withdrawn["staged"] = "stagedReceipt";`,
  },
  {
    name: "general closure cannot manufacture the default original readset",
    reject: true,
    code: `const readset: Parameters<W.WorkGeneralLifecyclePortV2["stageSealAndCloseV2"]>[1] = {};`,
  },
  {
    name: "general withdrawal cannot manufacture the default current comparison",
    reject: true,
    code: `const comparison: Parameters<W.WorkGeneralLifecyclePortV2["stageWithdrawalV2"]>[2] = {};`,
  },
  {
    name: "default attempt-association recovery dependency is unavailable",
    reject: true,
    code: `const recovery: Parameters<W.WorkAdmissionPortV2["recoverAttemptAssociationAfterUnwind"]>[0] = {};`,
  },
  {
    name: "synthetic slot markers distinguish admission and attempt recovery declarations",
    code: `// These markers are not original producer types or runtime authority objects.
type Slots = { readonly [K in keyof W.WorkPrivateBindingsV2]: K };
type Admission = W.WorkAdmissionPortV2<Slots>;
type AttemptArgs = Parameters<Admission["recoverAttemptAssociationAfterUnwind"]>;
type AdmissionArgs = Parameters<Admission["recoverAfterUnwind"]>;
const arity: AttemptArgs["length"] = 2;
const attemptRecovery: AttemptArgs[0] = "attemptAssociationRecovery";
const admissionRecovery: AdmissionArgs[0] = "originalRecovery";
const attemptRead: AttemptArgs[1] = "freshReadCall";
const admissionRead: AdmissionArgs[1] = "freshReadCall";`,
  },
  {
    name: "an admission recovery slot marker cannot bind attempt recovery",
    reject: true,
    code: `type Slots = { readonly [K in keyof W.WorkPrivateBindingsV2]: K };
type Admission = W.WorkAdmissionPortV2<Slots>;
declare const admission: Parameters<Admission["recoverAfterUnwind"]>[0];
const attempt: Parameters<Admission["recoverAttemptAssociationAfterUnwind"]>[0] = admission;`,
  },
  {
    name: "attempt and admission recovery retain their own fixed confirmed value types",
    code: `type AttemptResult = Awaited<ReturnType<W.WorkAdmissionPortV2<RecoveryFixtureBindings>["recoverAttemptAssociationAfterUnwind"]>>;
type AdmissionResult = Awaited<ReturnType<W.WorkAdmissionPortV2<RecoveryFixtureBindings>["recoverAfterUnwind"]>>;
type AttemptValue = Extract<AttemptResult, { kind: "confirmed-committed" }>["value"];
type AdmissionValue = Extract<AdmissionResult, { kind: "confirmed-committed" }>["value"];
type IsAny<T> = 0 extends (1 & T) ? true : false;
const attemptIsNotAny: IsAny<AttemptValue> = false;
const admissionIsNotAny: IsAny<AdmissionValue> = false;
declare const association: W.WorkExecutionAssociationV2;
declare const admission: W.WorkAdmissionCandidateV2;
const attemptValue: AttemptValue = association;
const associationAgain: W.WorkExecutionAssociationV2 = attemptValue;
const admissionValue: AdmissionValue = admission;
const admissionAgain: W.WorkAdmissionCandidateV2 = admissionValue;`,
  },
  {
    name: "an admission candidate cannot replace a recovered attempt association",
    reject: true,
    code: `type Result = Awaited<ReturnType<W.WorkAdmissionPortV2<RecoveryFixtureBindings>["recoverAttemptAssociationAfterUnwind"]>>;
declare const admission: W.WorkAdmissionCandidateV2;
const association: Extract<Result, { kind: "confirmed-committed" }>["value"] = admission;`,
  },
  {
    name: "unconfirmed attempt recovery is not definitive noncommit",
    reject: true,
    code: `type Result = Awaited<ReturnType<W.WorkAdmissionPortV2<RecoveryFixtureBindings>["recoverAttemptAssociationAfterUnwind"]>>;
declare const unknown: Extract<Result, { kind: "unconfirmed" }>;
const noncommit: Extract<Result, { kind: "definitively-not-committed" }> = unknown;`,
  },
  {
    name: "general sealing requires closed historical outcome data",
    reject: true,
    code: `declare const base: W.WorkGeneralClosureV2;
const open: W.WorkGeneralClosureV2 = { ...base, closure: { kind: "open" } };`,
  },
];

test("the callable module exposes no runtime factory or effect path", async () => {
  const exports = await import("../../packages/occ/src/lifecycle/work-authority-ports-v2.ts");
  assert.deepEqual(Object.keys(exports), []);
});

test("actual callable declarations preserve the structural distinctions", async (t) => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const directory = mkdtempSync(join(root, "tests/.work-authority-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixtures = new Map(
    cases.map((item, index) => [join(directory, `consumer-${index}.ts`), prelude + item.code]),
  );
  for (const [file, content] of fixtures) writeFileSync(file, content);
  const project = join(directory, "tsconfig.json");
  writeFileSync(
    project,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        skipLibCheck: true,
        types: ["node"],
      },
      files: [source, ...fixtures.keys()],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "--project",
      project,
      "--pretty",
      "false",
      "--noErrorTruncation",
    ],
    { cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024 },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  // Exit 1 reports the deliberately rejected consumers. A compiler crash or
  // configuration error must not count as a successful negative type check.
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "");
  const diagnostics = result.stdout
    .trim()
    .split(/\n(?=\S)/)
    .map((message) => {
      const match = /^(.+)\(\d+,\d+\): error TS(\d+):/.exec(message);
      assert.ok(match, `Unexpected compiler output: ${message}`);
      return { file: resolve(root, match[1]), code: Number(match[2]), message };
    });
  const format = (items) => items.map((item) => item.message).join("\n");
  const outside = diagnostics.filter((item) => !fixtures.has(item.file));
  assert.equal(outside.length, 0, format(outside));
  for (const [index, file] of [...fixtures.keys()].entries()) {
    const item = cases[index];
    await t.test(item.name, () => {
      const actual = diagnostics.filter((diagnostic) => diagnostic.file === file);
      if (item.reject) {
        assert.ok(actual.length > 0, `Expected a real type refusal: ${item.name}`);
        assert.ok(
          actual.every((diagnostic) =>
            (item.diagnosticCodes ?? [2322, 2739, 2740, 2741]).includes(diagnostic.code),
          ),
          format(actual),
        );
      } else {
        assert.equal(actual.length, 0, format(actual));
      }
    });
  }
});
