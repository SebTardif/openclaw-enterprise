import { DependencyUnavailableError } from "../errors.ts";

/** COMMIT was submitted but its outcome needs exact retained-state readback. */
export class PostgresCommitOutcomeUnknownError extends DependencyUnavailableError {
  constructor() {
    super("The PostgreSQL transaction commit outcome is unknown.");
    this.name = "PostgresCommitOutcomeUnknownError";
  }
}
