import { createHash } from "node:crypto";

export const clone = (value) => structuredClone(value);
export const resourceKey = (kind, name) => `${kind}:${name}`;
export const apiError = (statusCode) =>
  Object.assign(new Error(`Controlled Kubernetes HTTP ${statusCode}`), { statusCode });

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => {
          if (left < right) return -1;
          return left > right ? 1 : 0;
        })
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function fingerprint(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function recordedRequest(request) {
  const result = clone(request);
  if (request.body?.kind !== undefined) {
    const body = result.body;
    // Keep safety-relevant mutation fields readable and fingerprint the entire manifest.
    result.body = {
      sha256: fingerprint(request.body),
      apiVersion: body.apiVersion,
      kind: body.kind,
      metadata: body.metadata,
      ...(body.spec?.selector === undefined ? {} : { selector: body.spec.selector }),
    };
  }
  return result;
}

/**
 * A controlled SDK boundary, not an API server or a workload runtime. It stores
 * supplied objects and returns supplied status/list observations. It deliberately
 * makes no ownership, immutability, readiness, retry, or lifecycle decisions.
 */
export function controlledClient(resources = [], endpointSlices = { items: [] }) {
  const objects = new Map(
    resources.map((object) => [resourceKey(object.kind, object.metadata.name), clone(object)]),
  );
  const calls = [];
  const order = [];
  const interceptors = new Map();
  const lists = {
    listNamespace: { items: [] },
    listNamespacedNetworkPolicy: { items: [] },
    listNamespacedEndpointSlice: clone(endpointSlices),
  };
  const clients = { core: {}, apps: {}, networking: {}, discovery: {}, objects: {} };
  const invoke = async (method, request, operation, extraArguments = []) => {
    order.push(method);
    calls.push({
      method,
      request: recordedRequest(request),
      ...(extraArguments.length === 0
        ? {}
        : {
            extraArguments: extraArguments.map((value) =>
              value === undefined ? { undefined: true } : clone(value),
            ),
          }),
    });
    const intercept = interceptors.get(method);
    return intercept === undefined ? operation() : intercept(request, operation);
  };
  for (const [group, kinds] of [
    [
      "core",
      [
        "Namespace",
        "ConfigMap",
        "ServiceAccount",
        "Service",
        "ResourceQuota",
        "LimitRange",
        "PersistentVolumeClaim",
      ],
    ],
    ["apps", ["Deployment"]],
    ["networking", ["NetworkPolicy"]],
    ["objects", ["HTTPRoute"]],
  ]) {
    for (const kind of kinds) {
      const suffix = kind === "Namespace" ? kind : `Namespaced${kind}`;
      const read = (request) => {
        const observed = objects.get(resourceKey(kind, request.name));
        if (observed === undefined) throw apiError(404);
        return clone(observed);
      };
      const patch = (request) => {
        const previous = objects.get(resourceKey(kind, request.name));
        const body = clone(request.body);
        objects.set(resourceKey(kind, request.name), {
          ...previous,
          ...body,
          metadata: {
            ...previous?.metadata,
            ...body.metadata,
            labels: { ...previous?.metadata.labels, ...body.metadata.labels },
            annotations: { ...previous?.metadata.annotations, ...body.metadata.annotations },
          },
        });
      };
      const remove = ({ name }) => objects.delete(resourceKey(kind, name));
      if (kind === "HTTPRoute") {
        clients.objects.read = (spec, ...extraArguments) =>
          invoke("readHTTPRoute", spec, () => read({ name: spec.metadata.name }), extraArguments);
        clients.objects.patch = (body, ...extraArguments) => {
          const [pretty, dryRun, fieldManager, force, contentType] = extraArguments;
          const request = { name: body.metadata.name, body, fieldManager, force, contentType };
          return invoke("patchHTTPRoute", request, () => patch(request), extraArguments);
        };
        clients.objects.delete = (spec, ...extraArguments) =>
          invoke(
            "deleteHTTPRoute",
            { spec, body: extraArguments[5] },
            () => remove({ name: spec.metadata.name }),
            extraArguments,
          );
      } else {
        for (const [verb, operation] of [
          ["read", read],
          ["patch", patch],
          ["delete", remove],
        ]) {
          const method = `${verb}${suffix}`;
          clients[group][method] = (request, ...extraArguments) =>
            invoke(method, request, () => operation(request), extraArguments);
        }
      }
    }
  }
  for (const [group, method] of [
    ["core", "listNamespace"],
    ["networking", "listNamespacedNetworkPolicy"],
    ["discovery", "listNamespacedEndpointSlice"],
  ]) {
    clients[group][method] = (request, ...extraArguments) =>
      invoke(method, request, () => clone(lists[method]), extraArguments);
  }
  return { clients, calls, order, objects, lists, interceptors };
}
