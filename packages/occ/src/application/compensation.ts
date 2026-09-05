import { AsyncLocalStorage } from "node:async_hooks";
import { DependencyUnavailableError } from "../errors.ts";

export type Compensation = () => Promise<void>;

/** Driver effects belong to the outer resource transaction that admitted them. */
export class MutationCompensations {
  private readonly current = new AsyncLocalStorage<Compensation[]>();

  run<T>(compensations: Compensation[], work: () => Promise<T>): Promise<T> {
    return this.current.run(compensations, work);
  }

  register(compensation: Compensation, hasTransaction: boolean): void {
    const compensations = this.current.getStore();
    if (compensations === undefined || !hasTransaction)
      throw new DependencyUnavailableError("The platform mutation transaction is unavailable.");
    compensations.push(compensation);
  }

  async rollback(compensations: Compensation[]): Promise<void> {
    let failed = false;
    for (const compensation of compensations.reverse()) {
      try {
        await compensation();
      } catch {
        failed = true;
      }
    }
    if (failed)
      throw new DependencyUnavailableError(
        "A Driver could not roll back a failed resource mutation.",
      );
  }
}
