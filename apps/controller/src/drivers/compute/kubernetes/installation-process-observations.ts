import type { AppsV1Api, CoreV1Api, V1ObjectMeta, V1Pod } from "@kubernetes/client-node";
import { numericErrorStatus } from "@openclaw-enterprise/utils";
import type { KubernetesRuntimeUidChain } from "./runtime-observations.ts";

/** Control-plane values only. Neither this shape nor a successful read authenticates
 * an Installation, a caller, or physical process-tree termination. */
export type InstallationObjectIdentity = KubernetesRuntimeUidChain["namespace"];
export type InstallationPodIdentity = KubernetesRuntimeUidChain["pod"];

export interface InstallationObservedRoot {
  readonly namespace: InstallationObjectIdentity;
  readonly deployment: InstallationObjectIdentity;
  readonly generation: number;
  readonly runtimeClassName: string;
}

export interface InstallationApiAncestry {
  readonly root: InstallationObservedRoot;
  readonly replicaSets: readonly InstallationObjectIdentity[];
  readonly pods: readonly {
    readonly replicaSetUid: string;
    readonly identity: InstallationPodIdentity;
    readonly phase: string;
  }[];
  readonly replicaSetListVersion: string;
  readonly podListVersion: string;
}

export interface InstallationApiDescendants {
  readonly root: InstallationObservedRoot;
  readonly replicaSets: readonly InstallationObjectIdentity[];
  readonly pods: readonly {
    readonly replicaSetUid: string;
    readonly identity: InstallationObjectIdentity;
  }[];
  readonly complete: { readonly replicaSets: boolean; readonly pods: boolean };
}

export interface InstallationPlannedContainer {
  readonly kind: "init" | "main";
  readonly name: string;
  readonly image: string;
}

export type InstallationApiObservation =
  | { readonly status: "exact"; readonly ancestry: InstallationApiAncestry }
  | { readonly status: "absent"; readonly at: "namespace" | "deployment" }
  | { readonly status: "ambiguous" }
  | { readonly status: "unavailable" };

export interface InstallationObservationIo {
  clients(): Promise<{
    readonly core: Pick<CoreV1Api, "readNamespace" | "listNamespacedPod">;
    readonly apps: Pick<AppsV1Api, "readNamespacedDeployment" | "listNamespacedReplicaSet">;
  }>;
  request<T>(operation: () => Promise<T>, options?: { readonly mutating?: boolean }): Promise<T>;
  /** Fresh protected original-operation authorization, including after each wait. */
  current(): Promise<void>;
  /** Independent original-effect retention, not a cancellation-scoped cleanup grant. */
  retainDescendants(value: InstallationApiDescendants): Promise<void>;
}

class UnavailableObservation extends Error {}
class AmbiguousObservation extends Error {}

function requireValue(value: unknown): asserts value {
  if (!value) throw new UnavailableObservation("Installation observation is unavailable.");
}

export function installationObjectIdentity(
  metadata: V1ObjectMeta | undefined,
): InstallationObjectIdentity {
  requireValue(metadata);
  requireValue(typeof metadata.name === "string" && metadata.name.length > 0);
  requireValue(typeof metadata.uid === "string" && metadata.uid.length > 0);
  requireValue(typeof metadata.resourceVersion === "string" && metadata.resourceVersion.length > 0);
  return { name: metadata.name, uid: metadata.uid, resourceVersion: metadata.resourceVersion };
}

function sameObject(
  current: InstallationObjectIdentity,
  original: InstallationObjectIdentity,
): void {
  // A create acknowledgment's resourceVersion is historical. The exact UID is
  // immutable; return the current resourceVersion for later conditional requests.
  requireValue(current.name === original.name && current.uid === original.uid);
}

function controlledBy(
  metadata: V1ObjectMeta | undefined,
  parent: InstallationObjectIdentity,
  kind: "Deployment" | "ReplicaSet",
): boolean {
  const references = metadata?.ownerReferences ?? [];
  const matching = references.filter((reference) => reference.uid === parent.uid);
  if (matching.length === 0) return false;
  requireValue(
    matching.length === 1 &&
      references.filter((reference) => reference.controller === true).length === 1,
  );
  const reference = matching[0]!;
  requireValue(
    reference.controller === true &&
      reference.apiVersion === "apps/v1" &&
      reference.kind === kind &&
      reference.name === parent.name,
  );
  return true;
}

function podIdentity(
  pod: V1Pod,
  runtimeClassName: string,
  selected: readonly InstallationPlannedContainer[],
): InstallationPodIdentity {
  const identity = installationObjectIdentity(pod.metadata);
  requireValue(pod.spec && typeof pod.spec.nodeName === "string" && pod.spec.nodeName.length > 0);
  requireValue(pod.spec.runtimeClassName === runtimeClassName);
  requireValue(
    (pod.spec.ephemeralContainers?.length ?? 0) === 0 &&
      (pod.status?.ephemeralContainerStatuses?.length ?? 0) === 0,
  );
  const containers: InstallationPodIdentity["containers"][number][] = [];
  const names = new Set<string>();
  for (const [kind, specs, statuses] of [
    ["init", pod.spec.initContainers ?? [], pod.status?.initContainerStatuses ?? []],
    ["main", pod.spec.containers, pod.status?.containerStatuses ?? []],
  ] as const) {
    const planned = selected.filter((container) => container.kind === kind);
    requireValue(
      Array.isArray(specs) &&
        Array.isArray(statuses) &&
        specs.length <= 16 &&
        specs.length === statuses.length &&
        specs.length === planned.length,
    );
    for (const spec of specs) {
      requireValue(typeof spec.name === "string" && spec.name.length > 0 && !names.has(spec.name));
      names.add(spec.name);
      requireValue(
        planned.filter(
          (container) => container.name === spec.name && container.image === spec.image,
        ).length === 1,
      );
      const matches = statuses.filter((status) => status.name === spec.name);
      requireValue(matches.length === 1);
      const status = matches[0]!;
      requireValue(
        typeof status.containerID === "string" &&
          status.containerID.length > 0 &&
          typeof status.imageID === "string" &&
          status.imageID.length > 0 &&
          Number.isSafeInteger(status.restartCount) &&
          status.restartCount >= 0,
      );
      const started = status.state?.running?.startedAt ?? status.state?.terminated?.startedAt;
      const startedAt = started === undefined ? null : new Date(started).toISOString();
      containers.push({
        kind,
        name: spec.name,
        containerId: status.containerID,
        imageId: status.imageID,
        restartCount: status.restartCount,
        startedAt,
      });
    }
  }
  requireValue(containers.some(({ kind }) => kind === "main"));
  return { ...identity, nodeName: pod.spec.nodeName, runtimeClassName, containers };
}

const maximumChildren = 64;

function completeList(
  list: {
    readonly kind?: string;
    readonly apiVersion?: string;
    readonly items: readonly unknown[];
    readonly metadata?: {
      readonly resourceVersion?: string;
      readonly _continue?: string;
      readonly remainingItemCount?: number;
    };
  },
  kind: "ReplicaSetList" | "PodList",
  apiVersion: "apps/v1" | "v1",
): string {
  requireValue(Array.isArray(list.items) && list.items.length <= maximumChildren);
  requireValue(
    (list.kind === undefined || list.kind === kind) &&
      (list.apiVersion === undefined || list.apiVersion === apiVersion),
  );
  requireValue(
    list.metadata &&
      typeof list.metadata.resourceVersion === "string" &&
      list.metadata.resourceVersion.length > 0,
  );
  requireValue(list.metadata._continue === undefined || list.metadata._continue === "");
  requireValue(!("continue" in list.metadata) || list.metadata.continue === "");
  requireValue(
    list.metadata.remainingItemCount === undefined || list.metadata.remainingItemCount === 0,
  );
  return list.metadata.resourceVersion;
}

/** This read retains every attributable Pod, including terminal Pods. It never
 * chooses a convenient live descendant or translates API absence into settlement. */
export async function observeInstallationApi(
  io: InstallationObservationIo,
  expected: InstallationObservedRoot,
  selected: readonly InstallationPlannedContainer[],
): Promise<InstallationApiObservation> {
  try {
    await io.current();
    const clients = await io.clients();
    await io.current();
    let namespace;
    try {
      namespace = await io.request(() =>
        clients.core.readNamespace({ name: expected.namespace.name }),
      );
    } catch (error) {
      await io.current();
      if (numericErrorStatus(error) === 404) return { status: "absent", at: "namespace" };
      throw error;
    }
    await io.current();
    requireValue(namespace.apiVersion === "v1" && namespace.kind === "Namespace");
    const namespaceIdentity = installationObjectIdentity(namespace.metadata);
    sameObject(namespaceIdentity, expected.namespace);
    let deployment;
    try {
      deployment = await io.request(() =>
        clients.apps.readNamespacedDeployment({
          name: expected.deployment.name,
          namespace: expected.namespace.name,
        }),
      );
    } catch (error) {
      await io.current();
      if (numericErrorStatus(error) === 404) return { status: "absent", at: "deployment" };
      throw error;
    }
    await io.current();
    requireValue(
      deployment.apiVersion === "apps/v1" &&
        deployment.kind === "Deployment" &&
        deployment.metadata?.namespace === namespaceIdentity.name,
    );
    const deploymentIdentity = installationObjectIdentity(deployment.metadata);
    sameObject(deploymentIdentity, expected.deployment);
    requireValue(
      Number.isSafeInteger(expected.generation) &&
        expected.generation > 0 &&
        deployment.metadata?.generation === expected.generation &&
        deployment.spec?.template.spec?.runtimeClassName === expected.runtimeClassName,
    );
    const root = {
      namespace: namespaceIdentity,
      deployment: deploymentIdentity,
      generation: expected.generation,
      runtimeClassName: expected.runtimeClassName,
    };
    const descendants: InstallationObjectIdentity[] = [];
    const observedPods: InstallationApiAncestry["pods"][number][] = [];
    const knownPods: InstallationApiDescendants["pods"][number][] = [];
    const replicaSets = await io.request(() =>
      clients.apps.listNamespacedReplicaSet({
        namespace: namespaceIdentity.name,
        limit: maximumChildren + 1,
      }),
    );
    requireValue(
      Array.isArray(replicaSets.items) && replicaSets.items.length <= maximumChildren + 1,
    );
    for (const replicaSet of replicaSets.items) {
      if (!controlledBy(replicaSet.metadata, deploymentIdentity, "Deployment")) continue;
      requireValue(replicaSet.metadata?.namespace === namespaceIdentity.name);
      descendants.push(installationObjectIdentity(replicaSet.metadata));
    }
    // Retain the received identities before checking call cancellation or list
    // completeness. A partial receipt never claims there are no other descendants.
    await io.retainDescendants({
      root,
      replicaSets: descendants,
      pods: [],
      complete: { replicaSets: false, pods: false },
    });
    await io.current();
    const replicaSetListVersion = completeList(replicaSets, "ReplicaSetList", "apps/v1");
    const pods = await io.request(() =>
      clients.core.listNamespacedPod({
        namespace: namespaceIdentity.name,
        limit: maximumChildren + 1,
      }),
    );
    requireValue(Array.isArray(pods.items) && pods.items.length <= maximumChildren + 1);
    // Capture attributable object identities before demanding container readiness.
    // Missing container data or competing Pods must not discard late cleanup targets.
    for (const identity of descendants) {
      for (const pod of pods.items) {
        if (controlledBy(pod.metadata, identity, "ReplicaSet")) {
          requireValue(pod.metadata?.namespace === namespaceIdentity.name);
          knownPods.push({
            replicaSetUid: identity.uid,
            identity: installationObjectIdentity(pod.metadata),
          });
        }
      }
    }
    await io.retainDescendants({
      root,
      replicaSets: descendants,
      pods: knownPods,
      complete: { replicaSets: true, pods: false },
    });
    await io.current();
    const podListVersion = completeList(pods, "PodList", "v1");
    await io.retainDescendants({
      root,
      replicaSets: descendants,
      pods: knownPods,
      complete: { replicaSets: true, pods: true },
    });
    await io.current();
    const seenUids = new Set<string>();
    for (const replicaSet of replicaSets.items) {
      if (!controlledBy(replicaSet.metadata, deploymentIdentity, "Deployment")) continue;
      requireValue(
        replicaSet.metadata?.namespace === namespaceIdentity.name &&
          (replicaSet.kind === undefined || replicaSet.kind === "ReplicaSet") &&
          (replicaSet.apiVersion === undefined || replicaSet.apiVersion === "apps/v1"),
      );
      const identity = installationObjectIdentity(replicaSet.metadata);
      requireValue(!seenUids.has(identity.uid));
      seenUids.add(identity.uid);
      for (const pod of pods.items) {
        if (!controlledBy(pod.metadata, identity, "ReplicaSet")) continue;
        requireValue(
          pod.metadata?.namespace === namespaceIdentity.name &&
            (pod.kind === undefined || pod.kind === "Pod") &&
            (pod.apiVersion === undefined || pod.apiVersion === "v1"),
        );
        requireValue(typeof pod.status?.phase === "string" && pod.status.phase.length > 0);
        const podValue = podIdentity(pod, expected.runtimeClassName, selected);
        requireValue(!seenUids.has(podValue.uid));
        seenUids.add(podValue.uid);
        observedPods.push({
          replicaSetUid: identity.uid,
          identity: podValue,
          phase: pod.status.phase,
        });
      }
    }
    if (
      observedPods.filter(({ phase }) => phase !== "Succeeded" && phase !== "Failed").length > 1
    ) {
      throw new AmbiguousObservation();
    }
    requireValue(observedPods.length > 0);
    await io.current();
    return {
      status: "exact",
      ancestry: {
        root,
        replicaSets: descendants,
        pods: observedPods,
        replicaSetListVersion,
        podListVersion,
      },
    };
  } catch (error) {
    return { status: error instanceof AmbiguousObservation ? "ambiguous" : "unavailable" };
  }
}
