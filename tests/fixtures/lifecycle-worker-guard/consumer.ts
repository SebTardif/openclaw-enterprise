import {
  LifecycleEffectGuard,
  lifecycleEffectAfterClaimLoss,
  type LifecycleWorkerGuardContext,
} from "../../../apps/controller/src/worker/lifecycle-effect-guard.ts";

// Compiler-only consumption; declared capabilities provide no runtime authority.
declare const options: ConstructorParameters<typeof LifecycleEffectGuard>[0];
declare const context: LifecycleWorkerGuardContext;
declare const effect: Parameters<LifecycleEffectGuard["run"]>[1];
declare const cleanup: Parameters<LifecycleEffectGuard["cleanup"]>[1];
declare const authority: Parameters<LifecycleEffectGuard["cleanup"]>[2];
const guard = new LifecycleEffectGuard(options);
void guard.run(context, effect);
void guard.cleanup(context.original, cleanup, authority, context.call);
void guard.readOriginal(effect.effect, context.call);
void lifecycleEffectAfterClaimLoss(new options.WorkClaimLostError());

// Running cancellation must retain a real AbortSignal.
// @ts-expect-error A name-shaped value is not an AbortSignal.
void guard.run({ ...context, signal: { aborted: false } }, effect);
// Cleanup cannot acquire running authority from a worker context alone.
// @ts-expect-error Cleanup requires its independently scoped authority request.
void guard.cleanup(context.original, cleanup, context, context.call);
// Recovery accepts a locator, never a newly selected request.
// @ts-expect-error Full requests are not exact effect locators.
void guard.readOriginal(effect, context.call);
