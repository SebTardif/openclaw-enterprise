import type {
  ComputeDriver,
  NamespaceDeleteResult,
  NamespaceEnsureResult,
} from "@openclaw-enterprise/contracts/drivers/compute";
import type { Namespace } from "@openclaw-enterprise/contracts/resources/namespace";
import type { ResourceRef } from "@openclaw-enterprise/contracts/resources/scope";
import { isNonEmptyString } from "@openclaw-enterprise/utils";
import {
  DependencyUnavailableError,
  NamespaceNotEmptyError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../errors.ts";
import type { NamespaceReadRepository } from "../../ports/repositories/namespace.ts";
import type { PlatformOperation } from "../../ports/repositories/work.ts";
import type {
  CreateNamespaceInput,
  NamespaceMutationState,
  NamespaceServiceOptions,
  NamespaceServicePort,
} from "./port.ts";

/** Namespace application policy shares the composition owner's mutation and authority ports. */
export class NamespaceService implements NamespaceServicePort {
  private readonly options: NamespaceServiceOptions;

  constructor(options: NamespaceServiceOptions) {
    this.options = options;
  }

  async listNamespaces(principalId: string): Promise<readonly Readonly<Namespace>[]> {
    this.options.authorization.authorizationAuthority(principalId);
    return this.options.repositories.read(async (state) => {
      const readable: Readonly<Namespace>[] = [];
      for (const namespace of await state.namespaces.listNamespaces()) {
        if (
          await this.options.authorization.canRead(principalId, {
            kind: "namespace",
            id: namespace.id,
            namespaceId: namespace.id,
          })
        )
          readable.push(namespace);
      }
      return Object.freeze(readable);
    });
  }

  async getNamespace(principalId: string, namespaceId: string): Promise<Readonly<Namespace>> {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    await this.options.authorization.authorize(principalId, "read", {
      kind: "namespace",
      id: namespaceId,
      namespaceId,
    });
    return this.options.repositories.read(async (state) => this.exactNamespace(state, namespaceId));
  }

  async createNamespace(
    principalId: string,
    input: CreateNamespaceInput,
  ): Promise<Readonly<Namespace>> {
    if (!isNonEmptyString(input.name) || input.name.length > 200)
      throw new ScopeViolationError("The Namespace name is invalid.");
    return this.options.repositories.mutate(async (state) => {
      const target: ResourceRef = {
        kind: "namespace",
        id: this.options.installationId,
      };
      await this.options.authorization.authorize(principalId, "create", target);
      if (input.existingNamespace !== undefined) {
        await this.options.authorization.authorize(principalId, "administer", {
          kind: "installation",
          id: this.options.installationId,
        });
        let compute: ComputeDriver;
        try {
          compute = this.options.computeDriver();
        } catch {
          throw new ResourceConflictError(
            "Existing namespace adoption requires the bundled Kubernetes Compute Driver.",
          );
        }
        if (
          compute.implementation !== "occ/kubernetes" &&
          compute.implementation !== "kubernetes-local"
        )
          throw new ResourceConflictError(
            "Existing namespace adoption requires the bundled Kubernetes Compute Driver.",
          );
      }
      const namespace = await state.namespaces.createNamespace({
        id: this.options.createId(),
        name: input.name,
        ...(input.existingNamespace === undefined
          ? {}
          : { existingNamespace: input.existingNamespace }),
        status: "provisioning",
        createdAt: this.options.now(),
      });
      await this.record(state, {
        kind: "namespace",
        action: "reconcile",
        target: "ready",
        namespaceId: namespace.id,
        resourceId: namespace.id,
        actorId: principalId,
      });
      return namespace;
    });
  }

  /**
   * Begin logical deletion of one exact, authorized, empty Namespace.
   * Driver effects remain deferred to handleNamespaceLifecycle().
   */
  async deleteNamespace(principalId: string, namespaceId: string): Promise<Readonly<Namespace>> {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    return this.options.repositories.mutate(async (state) => {
      const namespace = await state.namespaces.lockNamespace(namespaceId);
      if (!namespace)
        throw new ScopeViolationError(
          "The Namespace does not belong to the server-owned Installation.",
        );
      await this.options.authorization.authorize(principalId, "delete", {
        kind: "namespace",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      if (namespace.status === "deleting") return namespace;
      if (await state.namespaces.hasAgents(namespace.id)) throw new NamespaceNotEmptyError();
      if (await state.namespaces.hasConfigurations(namespace.id))
        throw new NamespaceNotEmptyError();
      if (await state.namespaces.hasSecrets(namespace.id)) throw new NamespaceNotEmptyError();
      if (await state.namespaces.hasServiceAccounts(namespace.id))
        throw new NamespaceNotEmptyError();
      const deleting = await state.namespaces.transitionNamespaceStatus(
        namespace.id,
        ["provisioning", "ready", "failed"],
        "deleting",
      );
      if (!deleting)
        throw new ResourceConflictError("The Namespace lifecycle changed during deletion.");
      await this.record(state, {
        kind: "namespace",
        action: "reconcile",
        target: "deleted",
        namespaceId: deleting.id,
        resourceId: deleting.id,
        actorId: principalId,
      });
      return deleting;
    });
  }

  /**
   * Execute one deterministic Namespace lifecycle attempt for a claimed work item.
   * This is a reusable conformance harness, not a polling production worker.
   */
  async handleNamespaceLifecycle(
    actorId: string,
    namespaceId: string,
    target: "ready" | "deleted",
  ): Promise<Readonly<Namespace> | undefined> {
    if (!isNonEmptyString(actorId))
      throw new ScopeViolationError("The lifecycle actor is missing.");
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    if (target !== "ready" && target !== "deleted")
      throw new ScopeViolationError("The Namespace lifecycle target is invalid.");
    const namespace = await this.options.repositories.mutate((state) =>
      state.namespaces.lockNamespace(namespaceId, {
        includeDeleted: true,
      }),
    );
    if (!namespace || namespace.deletedAt !== undefined) return undefined;
    if (target === "ready" && namespace.status !== "provisioning") return namespace;
    if (target === "deleted" && namespace.status !== "deleting") return namespace;

    let compute: ComputeDriver;
    try {
      compute = this.options.computeDriver();
    } catch {
      await this.recordLifecycleResult(actorId, namespace, undefined, "failure", {
        failure: "compute_driver_unavailable",
      });
      throw new DependencyUnavailableError("The selected compute Driver is unavailable.");
    }

    if (target === "deleted") {
      let result;
      try {
        result = await compute.deleteNamespace(namespace);
      } catch {
        await this.recordLifecycleResult(actorId, namespace, compute, "failure", {
          failure: "unavailable",
        });
        throw new DependencyUnavailableError("The compute Driver could not delete the Namespace.");
      }
      try {
        this.validateDeleteResult(result, namespace);
      } catch (error) {
        await this.recordLifecycleResult(actorId, namespace, compute, "failure", {
          failure: "invalid_driver_result",
        });
        throw error;
      }
      const deleted = result.namespaceDeleted && result.failure === undefined;
      return this.options.repositories.mutate(async (state) => {
        const current = await state.namespaces.lockNamespace(namespace.id, {
          includeDeleted: true,
        });
        if (!current || current.deletedAt !== undefined) return undefined;
        if (current.status !== "deleting") return current;
        const updated = deleted
          ? await state.namespaces.markNamespaceDeleted(current.id, this.options.now())
          : current;
        await this.appendLifecycleAudit(
          state,
          actorId,
          current,
          compute,
          deleted ? "success" : "failure",
          {
            namespaceDeleted: result.namespaceDeleted,
            ...(result.failure === undefined ? {} : { failure: result.failure }),
          },
        );
        return updated;
      });
    }

    let result;
    try {
      result = await compute.ensureNamespace(namespace);
    } catch {
      await this.recordLifecycleResult(actorId, namespace, compute, "failure", {
        failure: "unavailable",
      });
      throw new DependencyUnavailableError("The compute Driver could not ensure the Namespace.");
    }
    try {
      this.validateEnsureResult(result, namespace);
    } catch (error) {
      await this.recordLifecycleResult(actorId, namespace, compute, "failure", {
        failure: "invalid_driver_result",
      });
      throw error;
    }
    const ready = result.namespaceReady && result.failure === undefined;
    return this.options.repositories.mutate(async (state) => {
      const current = await state.namespaces.lockNamespace(namespace.id);
      if (!current) return undefined;
      if (current.status !== "provisioning") return current;
      const next = ready ? "ready" : result.failure === "permanent" ? "failed" : "provisioning";
      const updated =
        next === current.status
          ? current
          : await state.namespaces.transitionNamespaceStatus(current.id, current.status, next);
      await this.appendLifecycleAudit(
        state,
        actorId,
        current,
        compute,
        ready ? "success" : "failure",
        {
          namespaceReady: result.namespaceReady,
          ...(result.failure === undefined ? {} : { failure: result.failure }),
        },
      );
      return updated ?? current;
    });
  }

  private async exactNamespace(
    state: { readonly namespaces: Pick<NamespaceReadRepository, "findNamespace"> },
    namespaceId: string,
  ): Promise<Readonly<Namespace>> {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    const namespace = await state.namespaces.findNamespace(namespaceId);
    if (!namespace)
      throw new ScopeViolationError(
        "The Namespace does not belong to the server-owned Installation.",
      );
    return namespace;
  }

  private validateLifecycleScope(result: unknown, namespace: Readonly<Namespace>): void {
    const candidate = result as {
      readonly namespaceId?: unknown;
    };
    if (!candidate || candidate.namespaceId !== namespace.id)
      throw new DependencyUnavailableError(
        "The compute Driver returned lifecycle evidence for another Namespace.",
      );
  }

  private validateEnsureResult(
    result: unknown,
    namespace: Readonly<Namespace>,
  ): asserts result is NamespaceEnsureResult {
    this.validateLifecycleScope(result, namespace);
    const candidate = result as Partial<NamespaceEnsureResult>;
    if (
      typeof candidate.namespaceReady !== "boolean" ||
      (candidate.failure !== undefined &&
        candidate.failure !== "retryable" &&
        candidate.failure !== "permanent")
    )
      throw new DependencyUnavailableError(
        "The compute Driver returned invalid Namespace readiness evidence.",
      );
  }

  private validateDeleteResult(
    result: unknown,
    namespace: Readonly<Namespace>,
  ): asserts result is NamespaceDeleteResult {
    this.validateLifecycleScope(result, namespace);
    const candidate = result as Partial<NamespaceDeleteResult>;
    if (
      typeof candidate.namespaceDeleted !== "boolean" ||
      (candidate.failure !== undefined &&
        candidate.failure !== "retryable" &&
        candidate.failure !== "permanent")
    )
      throw new DependencyUnavailableError(
        "The compute Driver returned invalid Namespace deletion evidence.",
      );
  }

  private async recordLifecycleResult(
    actorId: string,
    namespace: Readonly<Namespace>,
    compute: ComputeDriver | undefined,
    outcome: "success" | "failure",
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.options.repositories.mutate((state) =>
      this.appendLifecycleAudit(state, actorId, namespace, compute, outcome, details),
    );
  }

  private async appendLifecycleAudit(
    state: NamespaceMutationState,
    actorId: string,
    namespace: Readonly<Namespace>,
    compute: ComputeDriver | undefined,
    outcome: "success" | "failure",
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    let iamDriverId: string | undefined;
    try {
      iamDriverId = this.options.iamDriverId();
    } catch {
      iamDriverId = undefined;
    }
    await state.audit.append({
      id: this.options.createAuditId(),
      installationId: this.options.installationId,
      namespaceId: namespace.id,
      occurredAt: this.options.now(),
      kind: "mutation",
      actorId,
      source: "occ",
      action:
        namespace.status === "deleting"
          ? "openclaw.namespaces.lifecycle.delete"
          : "openclaw.namespaces.lifecycle.ensure",
      resource: {
        kind: "namespace",
        id: namespace.id,
        namespaceId: namespace.id,
      },
      ...(iamDriverId === undefined ? {} : { iamDriverId }),
      outcome,
      details: Object.freeze({
        ...(compute === undefined ? {} : { computeDriverId: compute.id }),
        ...details,
      }),
    });
  }

  private async record(state: NamespaceMutationState, operation: PlatformOperation): Promise<void> {
    if (this.options.recordOperations) await state.operations.append(operation);
  }
}
