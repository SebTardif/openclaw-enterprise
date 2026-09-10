import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Real TypeScript checks against the actual source and its actual imports. These
// in-memory fixtures create no runtime participant, transaction, permit or effect.
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
type RecoveryFixtureBindings = { readonly [K in keyof W.WorkPrivateBindingsV2]: K };
`;
const cases = [
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
  const fixtures = new Map(
    cases.map((item, index) => [
      fileURLToPath(new URL(`./__work_authority_structural_${index}.ts`, import.meta.url)),
      prelude + item.code,
    ]),
  );
  const options = {
    strict: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    types: ["node"],
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    fixtures.has(name)
      ? ts.createSourceFile(name, fixtures.get(name), languageVersion, true)
      : originalGetSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([source, ...fixtures.keys()], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const format = (items) =>
    ts.formatDiagnostics(items, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    });
  const outside = diagnostics.filter((item) => !item.file || !fixtures.has(item.file.fileName));
  assert.equal(outside.length, 0, format(outside));
  for (const [index, file] of [...fixtures.keys()].entries()) {
    const item = cases[index];
    await t.test(item.name, () => {
      const actual = diagnostics.filter((diagnostic) => diagnostic.file?.fileName === file);
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
