import type { RepositoryBinding } from "@openclaw-enterprise/contracts";

export interface RepositoryBindingReadRepository {
  findBinding(
    namespaceId: string,
    bindingId: string,
  ): Promise<Readonly<RepositoryBinding> | undefined>;
}

export interface RepositoryBindingRepository extends RepositoryBindingReadRepository {
  createBinding(binding: RepositoryBinding): Promise<Readonly<RepositoryBinding>>;
  updateBinding(
    binding: RepositoryBinding,
    expectedGeneration: number,
  ): Promise<Readonly<RepositoryBinding> | undefined>;
}
