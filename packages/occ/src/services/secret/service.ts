import type { Secret, SecretMetadata } from "@openclaw-enterprise/contracts/resources/secret";
import type { Namespace } from "@openclaw-enterprise/contracts/resources/namespace";
import { immutableCopy, isNonEmptyString } from "@openclaw-enterprise/utils";
import type {
  NamespaceReadRepository,
  NamespaceRepository,
} from "../../ports/repositories/namespace.ts";
import {
  NamespaceNotReadyError,
  ResourceConflictError,
  ScopeViolationError,
} from "../../errors.ts";
import type {
  CreateSecretInput,
  UpdateSecretInput,
  SecretServiceOptions,
  SecretServicePort,
} from "./port.ts";

function validName(value: unknown): value is string {
  return isNonEmptyString(value) && value.length <= 200;
}

/** Secret policy uses the composition owner's transaction, Driver and sanitized operation boundary. */
export class SecretService implements SecretServicePort {
  private readonly options: SecretServiceOptions;

  constructor(options: SecretServiceOptions) {
    this.options = options;
  }

  async createSecret(
    principalId: string,
    input: CreateSecretInput,
  ): Promise<Readonly<SecretMetadata>> {
    this.validateSecretValue(input.value);
    if (!validName(input.name)) throw new ScopeViolationError("The Secret name is invalid.");
    return this.options.repositories.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      await this.options.authorization.authorize(principalId, "create", {
        kind: "secret",
        id: namespace.id,
        namespaceId: namespace.id,
      });
      if (namespace.status !== "ready") throw new NamespaceNotReadyError();
      const driver = this.options.secretDriver();
      const identity = {
        id: this.options.createId(),
        namespaceId: namespace.id,
        name: input.name,
      };
      const backendRef = await this.options.secretOperation(() =>
        driver.create(identity, input.value),
      );
      const secret: Secret = {
        ...identity,
        driverId: driver.id,
        backendRef,
        createdAt: this.options.now(),
      };
      // Compensate only a known failed OCC transaction, never an unknown COMMIT outcome.
      this.options.repositories.registerRollback(() =>
        this.options.secretOperation(() => driver.delete(secret)),
      );
      await state.secrets.createSecret(secret);
      return this.secretMetadata(secret);
    });
  }

  async readSecret(
    principalId: string,
    namespaceId: string,
    secretId: string,
  ): Promise<Readonly<SecretMetadata>> {
    await this.options.authorization.authorize(principalId, "read", {
      kind: "secret",
      id: secretId,
      namespaceId,
    });
    return this.options.repositories.read(async (state) => {
      await this.exactNamespace(state, namespaceId);
      const secret = await state.secrets.findSecret(namespaceId, secretId);
      if (!secret)
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      return this.secretMetadata(secret);
    });
  }

  async updateSecret(
    principalId: string,
    input: UpdateSecretInput,
  ): Promise<Readonly<SecretMetadata>> {
    this.validateSecretValue(input.value);
    return this.options.repositories.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, input.namespaceId);
      await this.options.authorization.authorize(principalId, "update", {
        kind: "secret",
        id: input.secretId,
        namespaceId: namespace.id,
      });
      if (namespace.status !== "ready") throw new NamespaceNotReadyError();
      const secret = await state.secrets.lockSecret(namespace.id, input.secretId);
      if (!secret)
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      const driver = this.options.secretDriver(secret.driverId);
      // No prior value is read or retained for rollback. Success means stored, not delivered.
      await this.options.secretOperation(() => driver.update(secret, input.value));
      return this.secretMetadata(secret);
    });
  }

  async deleteSecret(principalId: string, namespaceId: string, secretId: string): Promise<void> {
    return this.options.repositories.mutate(async (state) => {
      const namespace = await this.lockNamespace(state, namespaceId);
      await this.options.authorization.authorize(principalId, "delete", {
        kind: "secret",
        id: secretId,
        namespaceId: namespace.id,
      });
      const secret = await state.secrets.lockSecret(namespace.id, secretId);
      if (!secret)
        throw new ScopeViolationError("The Secret does not belong to the exact Namespace.");
      if (await state.secrets.hasReferences(namespace.id, secret.id))
        throw new ResourceConflictError(
          "A Configuration, active revision, or pending deployment still references the Secret.",
        );
      const driver = this.options.secretDriver(secret.driverId);
      await this.options.secretOperation(() => driver.delete(secret));
      if (!(await state.secrets.deleteSecret(namespace.id, secret.id)))
        throw new ResourceConflictError("The Secret changed during deletion.");
    });
  }

  private validateSecretValue(value: unknown): asserts value is string {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\u0000") ||
      /[\uD800-\uDFFF]/u.test(value) ||
      Buffer.byteLength(value, "utf8") > 65_536
    )
      throw new ScopeViolationError(
        "The Secret value must be nonempty UTF-8, without NUL, and at most 65536 bytes.",
      );
  }

  private secretMetadata(secret: Secret): Readonly<SecretMetadata> {
    return immutableCopy({
      id: secret.id,
      namespaceId: secret.namespaceId,
      name: secret.name,
      ref: { kind: "secret", namespaceId: secret.namespaceId, id: secret.id },
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

  private async lockNamespace(
    state: { readonly namespaces: Pick<NamespaceRepository, "lockNamespace"> },
    namespaceId: string,
  ): Promise<Readonly<Namespace>> {
    if (!isNonEmptyString(namespaceId))
      throw new ScopeViolationError("The exact Namespace identity is missing.");
    const namespace = await state.namespaces.lockNamespace(namespaceId);
    if (!namespace)
      throw new ScopeViolationError(
        "The Namespace does not belong to the server-owned Installation.",
      );
    return namespace;
  }
}
