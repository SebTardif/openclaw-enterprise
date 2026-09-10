import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const virtualPath = resolve(root, "tests/conformance/runtime-preparation-submission.consumer.ts");

// Compile a real consuming module against the actual canonical declarations.
// No owner, service credential, SDK response or authority is fabricated, and
// none of the declared calls executes. Expected errors bind the distinctions
// that callers must preserve instead of matching source text or field counts.
const consumer = `
import type {
  AuthorityCallV1, ExactCleanupV1, ExactEffectLocatorV1, ResolveAssignmentRequestV1,
  RuntimeEffectsV1, RuntimeEffectResultV1, RuntimeFenceRequestV1,
} from "../../packages/contracts/src/index.ts";
import type { DriverSelection } from "../../packages/occ/src/application/driver-selection.ts";
import type { WorkClaim } from "../../packages/occ/src/ports/repositories/work.ts";
import type { PlatformReadOptions } from "../../packages/occ/src/ports/transaction.ts";
import type { WorkloadProfileCapabilitySourceV2 } from "../../packages/occ/src/workload-profiles/selection.ts";
import type { RetainedRuntimePreparation } from "../../packages/occ/src/runtime-preparation/types.ts";
import type { RuntimePreparationCurrentUseLeaseV1 } from "../../packages/occ/src/runtime-preparation/current-use.ts";
import type { RuntimePreparationDeploymentResponseV1, RuntimePreparationSubmissionResultV1 } from "../../packages/occ/src/runtime-preparation/submission.ts";
import type {
  RuntimePreparationSubmissionFactoryV1, RuntimePreparationSubmissionParticipantV1,
  RuntimePreparationCommittedSubmissionV1, RuntimePreparationRetainResponseV1,
  RuntimePreparationResponseObservationSourceV1, RuntimePreparationResponseObservationContextV1,
  RuntimePreparationResponseObservationLeaseV1,
} from "../../packages/occ/src/runtime-preparation/submission-owner.ts";
import type {
  LifecycleEffectGuard, LifecycleWorkerGuardContext,
} from "../../apps/controller/src/worker/lifecycle-effect-guard.ts";

declare const factory: RuntimePreparationSubmissionFactoryV1;
declare const selection: DriverSelection;
declare const participant: RuntimePreparationSubmissionParticipantV1;
declare const responseSource: RuntimePreparationResponseObservationSourceV1;
declare const capabilities: WorkloadProfileCapabilitySourceV2;
declare const claim: WorkClaim;
declare const bounds: PlatformReadOptions;
declare const local: RuntimePreparationCurrentUseLeaseV1;
declare const committed: RuntimePreparationCommittedSubmissionV1;
declare const retainResponse: RuntimePreparationRetainResponseV1;
declare const response: RuntimePreparationDeploymentResponseV1;
declare const observationContext: RuntimePreparationResponseObservationContextV1;
declare const observationCall: AuthorityCallV1;

const completeOriginal: RetainedRuntimePreparation = local.preparation;
const originalPlan: RetainedRuntimePreparation["plan"] = completeOriginal.plan;
const allOriginalChildren: RetainedRuntimePreparation["children"] = completeOriginal.children;
const owner = factory.runtimePreparationSubmissionOwnerV1(selection, participant, responseSource, capabilities);
const pending: Promise<RuntimePreparationSubmissionResultV1> = owner.submit(claim, local.request, bounds);
const invoke: Promise<void> = participant.invoke(committed, retainResponse);
const observed: Promise<RuntimePreparationSubmissionResultV1> = retainResponse(response, observationCall);
async function originalObservation() {
  const held = await responseSource.acquire(observationContext, committed, response, observationCall);
  const synchronous: undefined = held.assertCurrent();
  await held.prepareCommit();
  await held.release();
  return synchronous;
}

// @ts-expect-error A SQL-local current-use lease is not a committed submission.
participant.invoke(local, retainResponse);
// @ts-expect-error An inert committed snapshot does not expose transaction IO.
committed.query("SELECT 1");
// @ts-expect-error A committed marker has no current-use capability method.
committed.assertCurrent();
// @ts-expect-error Fresh complete capability acquisition is a mandatory factory input.
factory.runtimePreparationSubmissionOwnerV1(selection, participant, responseSource);
// @ts-expect-error A queue key without its exact claim token does not identify a claim.
owner.submit({ idempotencyKey: claim.idempotencyKey }, local.request, bounds);
// @ts-expect-error Response data alone cannot supply its fresh observation call.
retainResponse(response);
// @ts-expect-error An authenticated call is not the original response transaction context.
responseSource.acquire(observationCall, committed, response, observationCall);
// @ts-expect-error Delayed currentness cannot satisfy the final synchronous fence.
const delayed: RuntimePreparationResponseObservationLeaseV1["assertCurrent"] = async () => undefined;
// @ts-expect-error A submission record/result is not an observed RuntimeEffects result.
const effectResult: Promise<RuntimeEffectResultV1> = pending;

declare const effects: RuntimeEffectsV1;
declare const workerGuard: LifecycleEffectGuard;
declare const workerContext: LifecycleWorkerGuardContext;
declare const freshCleanupCall: AuthorityCallV1;
declare const exactCleanup: ExactCleanupV1;
declare const cleanupAuthority: Extract<ResolveAssignmentRequestV1, { purpose: "cleanup" }>;
declare const exactEffect: ExactEffectLocatorV1;
declare const fence: RuntimeFenceRequestV1;
declare const route: Parameters<RuntimeEffectsV1["setRoute"]>[0];
declare const create: Parameters<RuntimeEffectsV1["create"]>[0];

const running = workerGuard.run(workerContext, committed.child.request);
const cleanup = workerGuard.cleanup(workerContext.original, exactCleanup, cleanupAuthority, freshCleanupCall);
const readOriginal = workerGuard.readOriginal(exactEffect, freshCleanupCall);
const effectOperations = [
  effects.create(create, workerContext.call),
  effects.setRoute(route, workerContext.call),
  effects.stopRetainingState(exactCleanup, freshCleanupCall),
  effects.readEffect(exactEffect, freshCleanupCall),
  effects.advanceFence(fence, freshCleanupCall),
  effects.readFence(fence, freshCleanupCall),
];
// @ts-expect-error Submission ownership does not implement the effects/fence authority.
owner.advanceFence(fence, freshCleanupCall);
// @ts-expect-error The marker alone is not a complete original lifecycle worker context.
workerGuard.run(committed, committed.child.request);
// @ts-expect-error Cleanup requires a separate current authority call.
workerGuard.cleanup(workerContext.original, exactCleanup, cleanupAuthority);

void [originalPlan, allOriginalChildren, invoke, observed, originalObservation,
  running, cleanup, readOriginal, effectOperations];
`;

test("submission declaration preserves complete preparation, authority separation and original lifecycle consumers", () => {
  // Use the repository's real compiler configuration and resolution. A missing
  // genuine dependency or an uncomposed required State member is an actual
  // failure, not an excuse to replace declarations or skip their diagnostics.
  const configPath = resolve(root, "tsconfig.base.json");
  const config = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, "utf8"));
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    root,
    {
      noEmit: true,
      composite: false,
      declaration: false,
      strict: true,
      allowImportingTsExtensions: true,
      rewriteRelativeImportExtensions: false,
    },
    configPath,
  );
  // Inherit the workspace's declaration-library policy. This still checks the
  // real source declarations and every expected-error boundary below; it does
  // not add a separate, unbounded check of third-party declaration libraries.
  assert.equal(
    parsed.errors.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (name) => name,
      getNewLine: () => "\n",
    }),
  );
  const host = ts.createCompilerHost(parsed.options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  const source = host.getSourceFile.bind(host);
  host.fileExists = (name) => name === virtualPath || exists(name);
  host.readFile = (name) => (name === virtualPath ? consumer : read(name));
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === virtualPath
      ? ts.createSourceFile(name, consumer, languageVersion, true)
      : source(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([virtualPath], parsed.options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (name) => name,
      getNewLine: () => "\n",
    }),
  );
});
