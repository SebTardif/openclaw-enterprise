import { AsyncLocalStorage } from "node:async_hooks";
import {
  canonicalRuntimeAuthorityMutationV1,
  parseRuntimeMutationResultV1,
  type AuthorityCallV1,
  type BindRuntimeV1,
  type BindingResultV1,
  type RuntimeAuthorityVerifiedServiceV1,
} from "@openclaw-enterprise/contracts";
import { ScopeViolationError, DependencyUnavailableError } from "../../errors.ts";
import type { PlatformUnitOfWork } from "../../ports/platform-unit-of-work.ts";
import type { TransactionQuery } from "../../ports/repository-factory.ts";
import type {
  RuntimeInitialBindingLeaseV1,
  RuntimeInitialBindingSourceV1,
  RuntimeInitialBindingSourceContextV1,
  RuntimeInitialBindingUnitV1,
} from "../../runtime-authority/initial-binding.ts";
import {
  exactRuntimeAuthorityOperation,
  RuntimeAuthorityConflictError,
} from "../../runtime-authority/repository.ts";
import {
  samePreparationValue,
  type RetainedRuntimePreparation,
} from "../../runtime-preparation/types.ts";
import { lockRuntimeBindingPreparationLocatorV1 } from "./runtime-preparation.ts";

interface CapturedLease {
  readonly release: () => Promise<void>;
  current?: () => undefined;
}

/** Private owner control on the original PostgreSQL checkout. No method here
 * authenticates a service or substitutes stored data for independent proofs. */
export class PostgresInitialBindingExecutionV1 {
  readonly #pending = new Set<Promise<unknown>>();
  readonly #leases = new Map<RuntimeInitialBindingLeaseV1, CapturedLease>();
  readonly #operation = new AsyncLocalStorage<object>();
  #tail: Promise<void> = Promise.resolve();
  #accepting = true;
  #queryOpen = true;
  #active = true;
  #failed = false;
  #failure: unknown;
  #prepared = false;
  #checking = false;
  #assertOwner: (() => void) | undefined;
  #prepareSource: (() => Promise<void>) | undefined;
  #terminal: Promise<void> | undefined;
  readonly #began = performance.now();
  readonly #deadline: number;
  readonly #remaining: number;
  readonly request: BindRuntimeV1;
  readonly service: RuntimeAuthorityVerifiedServiceV1;
  readonly call: AuthorityCallV1;
  readonly source: RuntimeInitialBindingSourceV1;

  constructor(
    request: BindRuntimeV1,
    service: RuntimeAuthorityVerifiedServiceV1,
    call: AuthorityCallV1,
    source: RuntimeInitialBindingSourceV1,
  ) {
    this.request = request;
    this.service = service;
    this.call = call;
    this.source = source;
    this.#deadline = Math.min(Date.parse(call.deadline), Date.parse(service.expiresAt));
    this.#remaining = Math.min(3000, this.#deadline - Date.now());
    this.assertCurrent();
  }

  get timeoutMs(): number {
    return this.#remaining;
  }

  poison(error: unknown): void {
    if (!this.#failed) {
      this.#failed = true;
      this.#failure = error;
    }
  }

  private reject(error: unknown): never {
    this.poison(error);
    throw this.#failure;
  }

  private assertOwner(): void {
    if (this.#failed) throw this.#failure;
    if (
      !this.#active ||
      this.call.signal.aborted ||
      !Number.isFinite(this.#remaining) ||
      this.#remaining <= 0 ||
      Date.now() >= this.#deadline ||
      performance.now() - this.#began >= this.#remaining
    )
      this.reject(new DependencyUnavailableError("The initial binding owner is unavailable."));
    try {
      this.#assertOwner?.();
    } catch (error) {
      this.reject(error);
    }
  }

  assertCurrent = (): undefined => {
    this.assertOwner();
    if (this.#checking)
      return this.reject(new ScopeViolationError("Binding currentness reentered."));
    this.#checking = true;
    try {
      for (const lease of this.#leases.values()) {
        if (lease.current === undefined) continue;
        const observed: unknown = lease.current();
        if (observed !== undefined) {
          this.observe(Promise.resolve(observed));
          this.reject(new ScopeViolationError("Binding currentness must be synchronous."));
        }
      }
      this.assertOwner();
      return undefined;
    } catch (error) {
      return this.reject(error);
    } finally {
      this.#checking = false;
    }
  };

  private observe<T>(work: Promise<T>): Promise<T> {
    const result = work.catch((error: unknown) => this.reject(error));
    this.#pending.add(result);
    void result.then(
      () => this.#pending.delete(result),
      () => this.#pending.delete(result),
    );
    return result;
  }

  retain = (lease: RuntimeInitialBindingLeaseV1): undefined => {
    try {
      if (!this.#active || !this.#queryOpen)
        throw new ScopeViolationError("Binding lease enrollment is closed.");
      if (!this.#leases.has(lease)) {
        // Transfer cleanup before touching any subsequent source getter.
        const captured: CapturedLease = { release: lease.release.bind(lease) };
        this.#leases.set(lease, captured);
        captured.current = lease.assertCurrent.bind(lease);
      }
      this.assertCurrent();
      return undefined;
    } catch (error) {
      return this.reject(error);
    }
  };

  private run<T>(work: () => Promise<T>): Promise<T> {
    if (!this.#accepting || this.#operation.getStore() !== undefined) {
      const error = new ScopeViolationError("Initial binding admission is closed.");
      this.poison(error);
      const rejected = Promise.reject<T>(this.#failure);
      this.observe(rejected);
      return rejected;
    }
    const result = this.#tail.then(() =>
      this.#operation.run(Object.freeze({}), async () => {
        this.assertCurrent();
        const value = await work();
        this.assertCurrent();
        return value;
      }),
    );
    const accepted = this.observe(result);
    this.#tail = accepted.then(
      () => {},
      () => {},
    );
    return accepted;
  }

  async invoke(
    platform: PlatformUnitOfWork,
    originalQuery: TransactionQuery,
    installationId: string,
    assertOwner: () => void,
    work: (unit: RuntimeInitialBindingUnitV1) => Promise<BindingResultV1>,
  ): Promise<BindingResultV1> {
    if (this.#assertOwner !== undefined)
      return this.reject(new ScopeViolationError("The initial binding owner was already entered."));
    this.#assertOwner = assertOwner;
    this.assertCurrent();
    if (
      installationId !== this.request.target.installationId ||
      this.service.configuration.installationId !== installationId
    )
      return this.reject(
        new ScopeViolationError("The initial binding Installation is unavailable."),
      );
    const query: TransactionQuery = Object.freeze({
      query: (statement: string, parameters?: readonly unknown[]) => {
        try {
          this.assertOwner();
          if (!this.#queryOpen) throw new ScopeViolationError("Binding source IO is closed.");
          return this.observe(
            (async () => {
              const result = await originalQuery.query(statement, parameters);
              this.assertOwner();
              return result;
            })(),
          );
        } catch (error) {
          this.poison(error);
          return this.observe(Promise.reject(error));
        }
      },
    });
    const context: RuntimeInitialBindingSourceContextV1 = Object.freeze({
      installationId,
      query,
      assertActive: () => {
        this.assertOwner();
        return undefined;
      },
      retain: this.retain,
    });
    // The genuine service/request source acquires before operation/preparation locks.
    const acquired = await this.observe(
      this.source.acquire(context, this.request, this.service, this.call),
    );
    this.retain(acquired);
    this.#prepareSource = acquired.prepareCommit.bind(acquired);
    const qualify = acquired.qualifyPreparation.bind(acquired);
    this.assertCurrent();
    await query.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('runtime-authority-operation:' || $1, 0))",
      [this.request.operationRef],
    );
    let replayRead = false;
    let prior: BindingResultV1 | undefined;
    let locator: Readonly<{ preparationRef: string }> | undefined;
    let located = false;
    let preparation: RetainedRuntimePreparation | undefined;
    let qualified = false;
    let appended = false;
    let resultFromStore: BindingResultV1 | undefined;
    const unit: RuntimeInitialBindingUnitV1 = {
      assertCurrent: this.assertCurrent,
      retain: this.retain,
      readReplay: () =>
        this.run(async () => {
          if (replayRead) return prior;
          replayRead = true;
          const stored = await platform.runtimeAuthority.findOperation(
            this.request.target,
            this.request.operationRef,
          );
          if (stored === undefined) return undefined;
          if (
            stored.canonicalPayload !== canonicalRuntimeAuthorityMutationV1(this.request) ||
            stored.receipt.acceptedServiceIdentityRef !==
              this.service.configuration.serviceIdentityRef
          )
            throw new RuntimeAuthorityConflictError("operation-payload-mismatch");
          prior = parseRuntimeMutationResultV1("bind", {
            schemaVersion: 1,
            result: "exact-replay",
            receipt: stored.receipt,
          });
          resultFromStore = prior;
          return prior;
        }),
      readPreparationLocator: () =>
        this.run(async () => {
          if (!replayRead || prior !== undefined || located)
            throw new ScopeViolationError("The fresh binding preparation is unavailable.");
          located = true;
          locator = await lockRuntimeBindingPreparationLocatorV1(
            {
              scope: { installationId },
              query,
              transaction: { assertActive: () => this.assertCurrent() },
            },
            this.request,
          );
          if (locator !== undefined) {
            // Preparation holders always precede the existing Agent authority lock.
            await query.query(
              "SELECT id FROM occ.agents WHERE namespace_id=$1 AND id=$2 FOR UPDATE",
              [this.request.target.namespaceId, this.request.target.agentId],
            );
          }
          return locator;
        }),
      findPreparation: (preparationRef) =>
        this.run(async () => {
          if (
            locator === undefined ||
            locator.preparationRef !== preparationRef ||
            preparation !== undefined
          )
            throw new ScopeViolationError("The original preparation hold is unavailable.");
          preparation = await platform.runtimePreparation.findPreparation(
            this.request.target,
            preparationRef,
          );
          return preparation;
        }),
      requireCurrentProofs: (originalPreparation, retainedProposal) =>
        this.run(async () => {
          if (
            qualified ||
            preparation === undefined ||
            originalPreparation !== preparation ||
            !preparation.bindingProposals.includes(retainedProposal) ||
            preparation.localState !== "open" ||
            !samePreparationValue(preparation.target, this.request.target) ||
            retainedProposal.proposal.requestRef !== this.request.requestRef ||
            !samePreparationValue(retainedProposal.proposal, this.request) ||
            retainedProposal.canonicalProposalJson !==
              canonicalRuntimeAuthorityMutationV1(this.request) ||
            !samePreparationValue(
              retainedProposal.operation,
              exactRuntimeAuthorityOperation(this.request),
            )
          )
            throw new ScopeViolationError("The original retained binding proposal is unavailable.");
          await qualify(preparation, retainedProposal);
          this.assertCurrent();
          qualified = true;
        }),
      append: () =>
        this.run(async () => {
          if (!qualified || appended || prior !== undefined)
            throw new ScopeViolationError("Fresh binding proofs are unavailable.");
          appended = true;
          resultFromStore = parseRuntimeMutationResultV1(
            "bind",
            await platform.runtimeAuthority.appendMutation(this.request, {
              acceptedServiceIdentityRef: this.service.configuration.serviceIdentityRef,
              committedAt: new Date().toISOString(),
            }),
          );
          return resultFromStore;
        }),
    };
    Object.freeze(unit);
    try {
      const result = await work(unit);
      await this.drain();
      this.assertCurrent();
      if (
        (appended || result.result === "applied" || result.result === "exact-replay") &&
        (resultFromStore === undefined || !samePreparationValue(result, resultFromStore))
      )
        throw new ScopeViolationError("The binding result lacks its original store association.");
      return parseRuntimeMutationResultV1("bind", result);
    } catch (error) {
      return this.reject(error);
    }
  }

  closeAdmissions(): void {
    this.#accepting = false;
  }

  async drain(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }

  async prepareCommit(): Promise<void> {
    this.closeAdmissions();
    await this.drain();
    this.assertCurrent();
    if (this.#prepareSource === undefined || this.#prepared)
      return this.reject(
        new ScopeViolationError("The binding source was not acquired exactly once."),
      );
    try {
      await this.observe(this.#prepareSource());
      await this.drain();
      this.assertCurrent();
      this.#queryOpen = false;
      this.#prepared = true;
    } catch (error) {
      this.reject(error);
    }
  }

  assertCommitReady(): void {
    this.assertCurrent();
    if (!this.#prepared || this.#accepting || this.#queryOpen || this.#pending.size)
      this.reject(new ScopeViolationError("The binding commit fence is incomplete."));
  }

  finishTerminal(): Promise<void> {
    if (this.#terminal !== undefined) return this.#terminal;
    this.closeAdmissions();
    this.#queryOpen = false;
    this.#active = false;
    // Publish the promise before any participant cleanup can reenter.
    this.#terminal = Promise.resolve().then(async () => {
      let failed = false;
      let failure: unknown;
      await this.drain();
      for (const lease of [...this.#leases.values()].reverse()) {
        try {
          await lease.release();
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
        await this.drain();
      }
      if (this.#failed) throw this.#failure;
      if (failed) throw failure;
    });
    return this.#terminal;
  }
}
