import { AsyncLocalStorage } from "node:async_hooks";
import type { PlatformReadView } from "../ports/platform-read-view.ts";
import type { PlatformUnitOfWork } from "../ports/platform-unit-of-work.ts";

export type RepositorySelection<View> = {
  readonly [Key in keyof View]?: readonly (keyof View[Key])[];
};

export type SelectedRepositories<View, Selection extends RepositorySelection<View>> = {
  readonly [Key in keyof Selection & keyof View]: Pick<
    View[Key],
    Selection[Key] extends readonly (infer Method)[] ? Method & keyof View[Key] : never
  >;
};

export interface MutationRepositorySelection<
  Read extends RepositorySelection<PlatformReadView>,
  Mutation extends RepositorySelection<PlatformUnitOfWork>,
> {
  readonly read: Read;
  readonly mutate: Mutation;
}

/** An operation receives only its declared repositories, bound to the owning unit. */
export interface MutationRepositoryOperations<
  Read extends RepositorySelection<PlatformReadView>,
  Mutation extends RepositorySelection<PlatformUnitOfWork>,
> {
  read<T>(work: (state: SelectedRepositories<PlatformReadView, Read>) => Promise<T>): Promise<T>;
  mutate<T>(
    work: (state: SelectedRepositories<PlatformUnitOfWork, Mutation>) => Promise<T>,
  ): Promise<T>;
  registerRollback(rollback: () => Promise<void>): void;
}

export function copyRepositorySelection<View, Selection extends RepositorySelection<View>>(
  selection: Selection,
): Selection {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(selection).map(([key, methods]) => [
        key,
        Object.freeze([...(methods as readonly PropertyKey[])]),
      ]),
    ),
  ) as Selection;
}

export function selectRepositories<View, Selection extends RepositorySelection<View>>(
  view: View,
  selection: Selection,
): SelectedRepositories<View, Selection> {
  const entries = Object.keys(selection).map((key) => {
    const repository = view[key as keyof View];
    const methods = selection[key as keyof Selection] as readonly (keyof typeof repository)[];
    const projection = Object.fromEntries(
      methods.map((name) => {
        const method = repository[name];
        if (typeof method !== "function") throw new TypeError("A repository method is required.");
        return [name, (...args: unknown[]) => Reflect.apply(method, repository, args)];
      }),
    );
    return [key, Object.freeze(projection)];
  });
  return Object.freeze(Object.fromEntries(entries)) as SelectedRepositories<View, Selection>;
}

/** One ambient unit and its admission failure, isolated per coordinator. */
export class MutationContext {
  private readonly transaction = new AsyncLocalStorage<PlatformUnitOfWork>();
  private readonly failedAdmissions = new WeakMap<
    PlatformUnitOfWork,
    { readonly error: unknown }
  >();

  current(): PlatformUnitOfWork | undefined {
    return this.transaction.getStore();
  }

  run<T>(state: PlatformUnitOfWork, work: () => Promise<T>): Promise<T> {
    return this.transaction.run(state, work);
  }

  poisonAdmission(error: unknown): void {
    const active = this.current();
    if (active !== undefined) this.failedAdmissions.set(active, { error });
  }

  assertAdmissionSucceeded(state: PlatformUnitOfWork): void {
    const failedAdmission = this.failedAdmissions.get(state);
    if (failedAdmission !== undefined) throw failedAdmission.error;
  }
}
