export type NamespaceStatus = "provisioning" | "ready" | "failed" | "deleting";

export interface Namespace {
  readonly id: string;
  readonly name: string;
  readonly existingNamespace?: string;
  readonly status: NamespaceStatus;
  readonly createdAt: string;
}
