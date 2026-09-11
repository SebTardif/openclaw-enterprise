import type {
  CoreV1Api,
  NetworkingV1Api,
  KubernetesObject,
  V1ConfigMap,
  V1ObjectMeta,
  V1Secret,
  V1ServiceAccount,
} from "@kubernetes/client-node";
import { asRecord, numericErrorStatus, sha256Hex } from "@openclaw-enterprise/utils";
import { MANAGER, required, ownershipMetadata } from "./resources/identity.ts";
import type { Ownership } from "./resources/identity.ts";

export type KubernetesRecord = Record<string, unknown>;

export type ManagedResourceKind =
  | "Namespace"
  | "ConfigMap"
  | "ServiceAccount"
  | "Service"
  | "ResourceQuota"
  | "LimitRange"
  | "PersistentVolumeClaim"
  | "Deployment"
  | "NetworkPolicy"
  | "HTTPRoute";

export type ReadableResourceKind = ManagedResourceKind | "Pod" | "Secret";

export interface ManagedKubernetesObject<Kind extends ReadableResourceKind = ManagedResourceKind>
  extends
    KubernetesObject,
    Pick<V1ConfigMap, "binaryData" | "data" | "immutable">,
    Pick<V1Secret, "type">,
    Pick<V1ServiceAccount, "automountServiceAccountToken"> {
  readonly apiVersion: string;
  readonly kind: Kind;
  readonly metadata: V1ObjectMeta & { readonly name: string };
  readonly spec?: KubernetesRecord;
  readonly status?: KubernetesRecord;
}

export class OwnershipFailure extends Error {}

export interface KubernetesResourceReader {
  get<Kind extends ReadableResourceKind>(
    kind: Kind,
    name: string,
    namespace?: string,
  ): Promise<ManagedKubernetesObject<Kind> | undefined>;
  getOwned<Kind extends ReadableResourceKind>(
    kind: Kind,
    name: string,
    namespace: string | undefined,
    ownership: Ownership,
  ): Promise<ManagedKubernetesObject<Kind> | undefined>;
}

export interface KubernetesNamespaceDependencies {
  clients(): Promise<{
    readonly core: Pick<CoreV1Api, "listNamespace" | "patchNamespace">;
    readonly networking: Pick<NetworkingV1Api, "listNamespacedNetworkPolicy">;
  }>;
  request<T>(operation: () => Promise<T>, options?: { readonly mutating?: boolean }): Promise<T>;
  get: KubernetesResourceReader["get"];
  patchOptions(): ReturnType<typeof import("@kubernetes/client-node").setHeaderOptions> | undefined;
}

const FIELD_MANAGER = "openclaw-enterprise-compute";
const REQUEST_TIMEOUT_MS = 10_000;

export function kubernetesNamespaceName(namespaceId: string): string {
  const id = required(namespaceId, "Platform Namespace ID");
  const slug =
    id
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 46)
      .replace(/-+$/g, "") || "ns";
  return `oce-${slug}-${sha256Hex(id, 12)}`;
}

function verifiedKubernetesNamespace(
  metadata: V1ObjectMeta | undefined,
  namespaceId: string,
): { readonly name: string; readonly external: boolean } {
  const name = metadata?.name;
  const labels = metadata?.labels;
  const annotations = metadata?.annotations;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    labels?.["openclaw.dev/namespace"] !== namespaceId ||
    annotations?.["openclaw.dev/namespace-id"] !== namespaceId
  ) {
    throw new OwnershipFailure(
      `Refusing an unowned Kubernetes namespace for tenant ${namespaceId}.`,
    );
  }
  const external = annotations["openclaw.dev/namespace-lifecycle"] === "external";
  if (!external) {
    if (
      name !== kubernetesNamespaceName(namespaceId) ||
      labels["app.kubernetes.io/managed-by"] !== MANAGER
    ) {
      throw new OwnershipFailure(
        `Refusing Kubernetes namespace ${name} without external ownership.`,
      );
    }
  } else {
    for (const mode of ["enforce", "audit", "warn"]) {
      if (labels[`pod-security.kubernetes.io/${mode}`] !== "restricted") {
        throw new OwnershipFailure(
          `Existing Kubernetes namespace ${name} requires restricted Pod Security.`,
        );
      }
    }
  }
  return { name, external };
}

export async function resolveKubernetesNamespace(
  client: Pick<CoreV1Api, "listNamespace">,
  namespaceId: string,
): Promise<{ readonly name: string; readonly external: boolean }> {
  const observed = await client.listNamespace({
    labelSelector: `openclaw.dev/namespace=${namespaceId}`,
    timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
  });
  if (!Array.isArray(observed?.items)) {
    throw new OwnershipFailure("Kubernetes namespace discovery returned invalid resources.");
  }
  if (observed.items.length > 1) {
    throw new OwnershipFailure(`Multiple Kubernetes namespaces claim tenant ${namespaceId}.`);
  }
  if (observed.items.length === 0) {
    return { name: kubernetesNamespaceName(namespaceId), external: false };
  }
  const namespace = observed.items[0];
  const placement = verifiedKubernetesNamespace(namespace?.metadata, namespaceId);
  if (
    placement.external &&
    (namespace?.status?.phase !== "Active" || namespace.metadata?.deletionTimestamp !== undefined)
  ) {
    throw new OwnershipFailure(`Existing Kubernetes namespace ${placement.name} must be active.`);
  }
  return placement;
}

export function verifyOwnership(
  object: ManagedKubernetesObject<ReadableResourceKind>,
  ownership: Ownership,
): void {
  const expected = ownershipMetadata(ownership);
  for (const [key, value] of Object.entries(expected.labels)) {
    if (object.metadata.labels?.[key] !== value) {
      throw new OwnershipFailure(
        `Refusing unowned Kubernetes ${object.kind} ${object.metadata.name}.`,
      );
    }
  }
  for (const [key, value] of Object.entries(expected.annotations)) {
    if (object.metadata.annotations?.[key] !== value) {
      throw new OwnershipFailure(
        `Refusing unowned Kubernetes ${object.kind} ${object.metadata.name}.`,
      );
    }
  }
}

export function verifyNamespaceOwnership(
  namespace: ManagedKubernetesObject<"Namespace">,
  ownership: Ownership,
  external: boolean,
): void {
  const observed = verifiedKubernetesNamespace(namespace.metadata, ownership.namespaceId);
  if (observed.external !== external) {
    throw new OwnershipFailure(
      `Refusing changed Kubernetes Namespace ownership for ${namespace.metadata.name}.`,
    );
  }
  if (!external) verifyOwnership(namespace, ownership);
}

export class KubernetesOwnership {
  private readonly dependencies: KubernetesNamespaceDependencies;
  private readonly membershipLabels: () => Record<string, string>;

  constructor(
    dependencies: KubernetesNamespaceDependencies,
    membershipLabels: () => Record<string, string>,
  ) {
    this.dependencies = dependencies;
    this.membershipLabels = membershipLabels;
  }

  async resolveNamespace(
    namespaceId: string,
  ): Promise<{ readonly name: string; readonly external: boolean }> {
    const clients = await this.dependencies.clients();
    return this.dependencies.request(() => resolveKubernetesNamespace(clients.core, namespaceId));
  }

  verifyAdoptableNamespace(
    namespace: ManagedKubernetesObject<"Namespace">,
    ownership: Ownership,
  ): boolean {
    const labels = namespace.metadata.labels ?? {};
    const annotations = namespace.metadata.annotations ?? {};
    if (annotations["openclaw.dev/namespace-lifecycle"] !== "external") {
      throw new OwnershipFailure(
        `Existing Kubernetes namespace ${namespace.metadata.name} requires external ownership.`,
      );
    }
    for (const mode of ["enforce", "audit", "warn"]) {
      if (labels[`pod-security.kubernetes.io/${mode}`] !== "restricted") {
        throw new OwnershipFailure(
          `Existing Kubernetes namespace ${namespace.metadata.name} requires restricted Pod Security.`,
        );
      }
    }
    const existingLabel = labels["openclaw.dev/namespace"];
    const existingId = annotations["openclaw.dev/namespace-id"];
    if (
      (existingLabel !== undefined && existingLabel !== ownership.namespaceId) ||
      (existingId !== undefined && existingId !== ownership.namespaceId)
    ) {
      throw new OwnershipFailure(
        `Existing Kubernetes namespace ${namespace.metadata.name} belongs to another tenant.`,
      );
    }
    const requiredLabels = this.membershipLabels();
    const hasGatewayMembership = Object.entries(requiredLabels).every(
      ([key, value]) => labels[key] === value,
    );
    return (
      existingLabel === ownership.namespaceId &&
      existingId === ownership.namespaceId &&
      hasGatewayMembership
    );
  }

  async verifyUniqueExistingNamespace(name: string, ownership: Ownership): Promise<void> {
    const clients = await this.dependencies.clients();
    const observed = await this.dependencies.request(() =>
      clients.core.listNamespace({
        labelSelector: `openclaw.dev/namespace=${ownership.namespaceId}`,
        timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
      }),
    );
    if (
      !Array.isArray(observed?.items) ||
      observed.items.length > 1 ||
      (observed.items.length === 1 && observed.items[0]?.metadata?.name !== name)
    ) {
      throw new OwnershipFailure(
        `Another Kubernetes namespace already claims tenant ${ownership.namespaceId}.`,
      );
    }
  }

  async claimExistingNamespace(
    namespace: ManagedKubernetesObject<"Namespace">,
    ownership: Ownership,
  ): Promise<void> {
    if (this.verifyAdoptableNamespace(namespace, ownership)) return;
    const resourceVersion = namespace.metadata.resourceVersion;
    if (typeof resourceVersion !== "string" || resourceVersion.length === 0) {
      throw new OwnershipFailure(
        `Existing Kubernetes namespace ${namespace.metadata.name} requires a resource version.`,
      );
    }
    const clients = await this.dependencies.clients();
    try {
      await this.dependencies.request(
        () =>
          clients.core.patchNamespace(
            {
              name: namespace.metadata.name,
              body: {
                apiVersion: "v1",
                kind: "Namespace",
                metadata: {
                  name: namespace.metadata.name,
                  resourceVersion,
                  labels: {
                    "openclaw.dev/namespace": ownership.namespaceId,
                    ...this.membershipLabels(),
                  },
                  annotations: { "openclaw.dev/namespace-id": ownership.namespaceId },
                },
              },
              fieldManager: FIELD_MANAGER,
              force: false,
            },
            this.dependencies.patchOptions(),
          ),
        { mutating: true },
      );
    } catch (error) {
      if (numericErrorStatus(error) !== 409) throw error;
      const current = await this.dependencies.get("Namespace", namespace.metadata.name);
      if (current === undefined) {
        throw new OwnershipFailure(
          `Existing Kubernetes namespace ${namespace.metadata.name} does not exist.`,
        );
      }
      if (!this.verifyAdoptableNamespace(current, ownership)) throw error;
    }
    const current = await this.dependencies.get("Namespace", namespace.metadata.name);
    if (current === undefined) {
      throw new OwnershipFailure(
        `Existing Kubernetes namespace ${namespace.metadata.name} does not exist.`,
      );
    }
    verifyNamespaceOwnership(current, ownership, true);
  }

  async verifyExistingNetworkPolicies(namespace: string, ownership: Ownership): Promise<void> {
    const clients = await this.dependencies.clients();
    const observed = asRecord(
      await this.dependencies.request(() =>
        clients.networking.listNamespacedNetworkPolicy({
          namespace,
          timeoutSeconds: Math.ceil(REQUEST_TIMEOUT_MS / 1000),
        }),
      ),
    );
    if (!Array.isArray(observed?.items)) {
      throw new OwnershipFailure(
        `The existing Kubernetes namespace ${namespace} returned invalid NetworkPolicies.`,
      );
    }
    for (const item of observed.items) {
      const policy = asRecord(item);
      const metadata = asRecord(policy?.metadata);
      if (
        policy === undefined ||
        metadata === undefined ||
        typeof metadata.name !== "string" ||
        metadata.name.length === 0 ||
        metadata.namespace !== namespace ||
        (policy.kind !== undefined && policy.kind !== "NetworkPolicy")
      ) {
        throw new OwnershipFailure(
          `The existing Kubernetes namespace ${namespace} returned an invalid NetworkPolicy.`,
        );
      }
      verifyOwnership(
        {
          ...policy,
          apiVersion: typeof policy.apiVersion === "string" ? policy.apiVersion : "v1",
          kind: "NetworkPolicy",
          metadata: { ...metadata, name: metadata.name },
        } as ManagedKubernetesObject<"NetworkPolicy">,
        ownership,
      );
    }
  }

  async getOwned<Kind extends ReadableResourceKind>(
    kind: Kind,
    name: string,
    namespace: string | undefined,
    ownership: Ownership,
  ): Promise<ManagedKubernetesObject<Kind> | undefined> {
    const object = await this.dependencies.get(kind, name, namespace);
    if (object !== undefined) verifyOwnership(object, ownership);
    return object;
  }
}
