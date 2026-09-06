import {
  CONTAINMENT_ADMISSION_FIELD_PATHS_V1,
  type ContainmentAdmissionInputV1,
  type ContainmentAdmissionResultV1,
  type ContainmentRawJsonValueV1,
  type ContainmentRawObjectV1,
} from "@openclaw-enterprise/contracts/containment-admission-v1";

type Json = ContainmentRawJsonValueV1;
type Raw = ContainmentRawObjectV1;
export type Finding = ContainmentAdmissionResultV1["findings"][number];
type Document = ContainmentAdmissionInputV1["actual"];
type Rule = {
  fields?: Readonly<Record<string, Rule>>;
  required?: readonly string[];
  item?: Rule;
  map?: Rule;
  test?: (value: Json) => boolean;
  exclusive?: readonly string[];
  optionalExclusive?: boolean;
  unique?: string | true;
  minimum?: number;
  raw?: true;
  refine?: (value: Raw) => boolean;
};
const object = (fields: Record<string, Rule>, required: readonly string[] = []): Rule => ({
  fields,
  required,
});
const array = (item: Rule, unique?: string | true, minimum = 0): Rule => ({
  item,
  minimum,
  ...(unique === undefined ? {} : { unique }),
});
const string: Rule = { test: (v) => typeof v === "string" };
const text: Rule = { test: (v) => typeof v === "string" && v.length > 0 };
const boolean: Rule = { test: (v) => typeof v === "boolean" };
const integer: Rule = { test: (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 };
const positive: Rule = { test: (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0 };
const one = (...values: Json[]): Rule => ({ test: (v) => values.includes(v) });
const strings = array(text, true);
const map = (value: Rule): Rule => ({ map: value });
const raw: Rule = { raw: true };
const nullableTime: Rule = { test: (v) => v === null || typeof v === "string" };
const quantity: Rule = {
  test: (v) =>
    typeof v === "string" &&
    /^(0|[1-9][0-9]*)(\.[0-9]+)?(m|Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/.test(v),
};
const numericPort: Rule = {
  test: (v) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535,
};
const port: Rule = {
  test: (v) =>
    typeof v === "number"
      ? Number.isInteger(v) && v >= 1 && v <= 65535
      : typeof v === "string" && /^[a-z][a-z0-9-]{0,14}$/.test(v),
};
const percent: Rule = {
  test: (v) =>
    typeof v === "number"
      ? Number.isSafeInteger(v) && v >= 0
      : typeof v === "string" && /^(100|[0-9]{1,2})%$/.test(v),
};
const enumSelector = object(
  {
    key: text,
    operator: one("In", "NotIn", "Exists", "DoesNotExist", "Gt", "Lt"),
    values: strings,
  },
  ["key", "operator"],
);
const labelExpression = object(
  { key: text, operator: one("In", "NotIn", "Exists", "DoesNotExist"), values: strings },
  ["key", "operator"],
);
function selectorValues(value: Raw): boolean {
  const values = value.values;
  if (value.operator === "Exists" || value.operator === "DoesNotExist")
    return values === undefined || (Array.isArray(values) && values.length === 0);
  if (!Array.isArray(values) || values.length === 0) return false;
  if (value.operator === "Gt" || value.operator === "Lt")
    return values.length === 1 && typeof values[0] === "string" && /^-?[0-9]+$/.test(values[0]);
  return true;
}
enumSelector.refine = selectorValues;
labelExpression.refine = selectorValues;
const labelSelector = object({
  matchLabels: map(string),
  matchExpressions: array(labelExpression),
});
const owner = object(
  {
    apiVersion: text,
    kind: text,
    name: text,
    uid: text,
    controller: boolean,
    blockOwnerDeletion: boolean,
  },
  ["apiVersion", "kind", "name", "uid"],
);
const metadata = object(
  {
    name: text,
    generateName: text,
    namespace: text,
    uid: text,
    resourceVersion: text,
    generation: integer,
    labels: map(string),
    annotations: map(string),
    ownerReferences: array(owner, "uid"),
    finalizers: strings,
    creationTimestamp: raw,
    managedFields: raw,
    deletionTimestamp: nullableTime,
    deletionGracePeriodSeconds: integer,
  },
  ["labels", "annotations"],
);
const objectMetadata: Rule = { ...metadata, required: ["labels", "annotations", "namespace"] };
const selector = object({ name: text, key: text, optional: boolean }, ["name", "key"]);
const fieldRef = object({ apiVersion: text, fieldPath: text }, ["fieldPath"]);
const resourceRef = object({ containerName: text, resource: text, divisor: quantity }, [
  "resource",
]);
const valueFrom: Rule = {
  ...object({
    fieldRef,
    resourceFieldRef: resourceRef,
    configMapKeyRef: selector,
    secretKeyRef: selector,
  }),
  exclusive: ["fieldRef", "resourceFieldRef", "configMapKeyRef", "secretKeyRef"],
};
const env: Rule = {
  ...object({ name: text, value: string, valueFrom }, ["name"]),
  exclusive: ["value", "valueFrom"],
};
const namedSource = object({ name: text, optional: boolean }, ["name"]);
const envFrom: Rule = {
  ...object({ prefix: string, configMapRef: namedSource, secretRef: namedSource }),
  exclusive: ["configMapRef", "secretRef"],
};
const seccomp = object({ type: one("RuntimeDefault", "Localhost"), localhostProfile: text }, [
  "type",
]);
seccomp.refine = (value) =>
  value.type === "Localhost"
    ? typeof value.localhostProfile === "string" && value.localhostProfile.length > 0
    : !Object.hasOwn(value, "localhostProfile");
const security = object(
  {
    runAsUser: integer,
    runAsGroup: integer,
    runAsNonRoot: boolean,
    allowPrivilegeEscalation: boolean,
    privileged: boolean,
    readOnlyRootFilesystem: boolean,
    capabilities: object({ add: strings, drop: strings }, ["drop"]),
    seccompProfile: seccomp,
    appArmorProfile: seccomp,
    procMount: one("Default"),
  },
  ["allowPrivilegeEscalation", "readOnlyRootFilesystem", "capabilities"],
);
const podSecurity = object(
  {
    runAsUser: integer,
    runAsGroup: integer,
    runAsNonRoot: boolean,
    fsGroup: integer,
    supplementalGroups: array(integer, true),
    supplementalGroupsPolicy: one("Strict", "Merge"),
    fsGroupChangePolicy: one("Always", "OnRootMismatch"),
    seccompProfile: seccomp,
    appArmorProfile: seccomp,
    sysctls: array(object({ name: text, value: string }, ["name", "value"]), "name"),
  },
  ["runAsUser", "runAsGroup", "runAsNonRoot", "fsGroup", "supplementalGroups", "seccompProfile"],
);
const budget = object({ cpu: quantity, memory: quantity, "ephemeral-storage": quantity }, [
  "cpu",
  "memory",
  "ephemeral-storage",
]);
const optionalBudget = object({ cpu: quantity, memory: quantity, "ephemeral-storage": quantity });
const resources = object({ requests: budget, limits: budget }, ["requests", "limits"]);
const podResources = object({ requests: optionalBudget, limits: optionalBudget });
const header = object({ name: text, value: string }, ["name", "value"]);
const exec = object({ command: array(string, undefined, 1) }, ["command"]);
const http = object(
  { host: string, path: string, port, scheme: one("HTTP", "HTTPS"), httpHeaders: array(header) },
  ["port"],
);
const tcp = object({ host: string, port }, ["port"]);
const grpc = object({ port: numericPort, service: string }, ["port"]);
const handlerFields = { exec, httpGet: http, tcpSocket: tcp, grpc };
const probe: Rule = {
  ...object({
    ...handlerFields,
    initialDelaySeconds: integer,
    timeoutSeconds: positive,
    periodSeconds: positive,
    successThreshold: positive,
    failureThreshold: positive,
    terminationGracePeriodSeconds: integer,
  }),
  required: [
    "initialDelaySeconds",
    "timeoutSeconds",
    "periodSeconds",
    "successThreshold",
    "failureThreshold",
  ],
  exclusive: ["exec", "httpGet", "tcpSocket", "grpc"],
};
const hook: Rule = {
  ...object({
    exec,
    httpGet: http,
    tcpSocket: tcp,
    sleep: object({ seconds: integer }, ["seconds"]),
  }),
  exclusive: ["exec", "httpGet", "tcpSocket", "sleep"],
};
const lifecycle = object({ postStart: hook, preStop: hook });
const mode: Rule = {
  test: (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 511,
};
const keyPath = object({ key: text, path: text, mode }, ["key", "path"]);
const downwardItem: Rule = {
  ...object({ path: text, mode, fieldRef, resourceFieldRef: resourceRef }, ["path"]),
  exclusive: ["fieldRef", "resourceFieldRef"],
};
const projection: Rule = {
  ...object({
    secret: object({ name: text, items: array(keyPath, "path"), optional: boolean }, ["name"]),
    configMap: object({ name: text, items: array(keyPath, "path"), optional: boolean }, ["name"]),
    downwardAPI: object({ items: array(downwardItem, "path") }, ["items"]),
    serviceAccountToken: object({ audience: text, expirationSeconds: positive, path: text }, [
      "audience",
      "expirationSeconds",
      "path",
    ]),
  }),
  exclusive: ["secret", "configMap", "downwardAPI", "serviceAccountToken"],
};
const volume: Rule = {
  ...object(
    {
      name: text,
      emptyDir: object({ medium: one("", "Memory"), sizeLimit: quantity }, ["sizeLimit"]),
      persistentVolumeClaim: object({ claimName: text, readOnly: boolean }, ["claimName"]),
      projected: object({ sources: array(projection, undefined, 1), defaultMode: mode }, [
        "sources",
        "defaultMode",
      ]),
      configMap: object(
        { name: text, items: array(keyPath, "path"), defaultMode: mode, optional: boolean },
        ["name", "defaultMode"],
      ),
      secret: object(
        { secretName: text, items: array(keyPath, "path"), defaultMode: mode, optional: boolean },
        ["secretName", "defaultMode"],
      ),
      downwardAPI: object({ items: array(downwardItem, "path"), defaultMode: mode }, [
        "items",
        "defaultMode",
      ]),
    },
    ["name"],
  ),
  exclusive: [
    "emptyDir",
    "persistentVolumeClaim",
    "projected",
    "configMap",
    "secret",
    "downwardAPI",
  ],
};
const mount = object(
  {
    name: text,
    mountPath: text,
    readOnly: boolean,
    subPath: string,
    subPathExpr: string,
    mountPropagation: one("None", "HostToContainer", "Bidirectional"),
    recursiveReadOnly: one("Disabled", "IfPossible", "Enabled"),
  },
  ["name", "mountPath", "readOnly"],
);
const container = object(
  {
    name: text,
    image: {
      test: (v) =>
        typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(v),
    },
    imagePullPolicy: one("Always", "IfNotPresent", "Never"),
    command: array(string, undefined, 1),
    args: array(string),
    workingDir: text,
    env: array(env, "name"),
    envFrom: array(envFrom),
    securityContext: security,
    volumeMounts: array(mount, "mountPath"),
    resources,
    ports: array(
      object(
        {
          name: text,
          containerPort: numericPort,
          hostPort: numericPort,
          hostIP: text,
          protocol: one("TCP", "UDP", "SCTP"),
        },
        ["containerPort"],
      ),
      "containerPort",
    ),
    livenessProbe: probe,
    readinessProbe: probe,
    startupProbe: probe,
    lifecycle,
    stdin: boolean,
    stdinOnce: boolean,
    tty: boolean,
    terminationMessagePath: text,
    terminationMessagePolicy: one("File", "FallbackToLogsOnError"),
    restartPolicy: one("Always"),
    targetContainerName: text,
  },
  [
    "name",
    "image",
    "imagePullPolicy",
    "command",
    "args",
    "env",
    "envFrom",
    "securityContext",
    "volumeMounts",
    "resources",
  ],
);
const nodeTerm = object({
  matchExpressions: array(enumSelector),
  matchFields: array(enumSelector),
});
const podTerm = object(
  {
    labelSelector,
    namespaceSelector: labelSelector,
    namespaces: strings,
    topologyKey: text,
    matchLabelKeys: strings,
    mismatchLabelKeys: strings,
  },
  ["topologyKey"],
);
const podAffinity = object({
  requiredDuringSchedulingIgnoredDuringExecution: array(podTerm),
  preferredDuringSchedulingIgnoredDuringExecution: array(
    object({ weight: positive, podAffinityTerm: podTerm }, ["weight", "podAffinityTerm"]),
  ),
});
const affinity = object({
  nodeAffinity: object({
    requiredDuringSchedulingIgnoredDuringExecution: object(
      { nodeSelectorTerms: array(nodeTerm, undefined, 1) },
      ["nodeSelectorTerms"],
    ),
    preferredDuringSchedulingIgnoredDuringExecution: array(
      object({ weight: positive, preference: nodeTerm }, ["weight", "preference"]),
    ),
  }),
  podAffinity,
  podAntiAffinity: podAffinity,
});
const dns = object(
  {
    nameservers: strings,
    searches: strings,
    options: array(object({ name: text, value: string }, ["name"]), "name"),
  },
  ["nameservers", "searches", "options"],
);
const podSpec = object(
  {
    containers: array(container, "name", 1),
    initContainers: array(container, "name"),
    ephemeralContainers: array(container, "name"),
    securityContext: podSecurity,
    serviceAccountName: text,
    automountServiceAccountToken: boolean,
    volumes: array(volume, "name"),
    resources: podResources,
    overhead: optionalBudget,
    dnsPolicy: one("None", "Default", "ClusterFirst", "ClusterFirstWithHostNet"),
    dnsConfig: dns,
    hostAliases: array(object({ ip: text, hostnames: strings }, ["ip", "hostnames"]), "ip"),
    hostname: text,
    subdomain: text,
    setHostnameAsFQDN: boolean,
    enableServiceLinks: boolean,
    restartPolicy: one("Always", "OnFailure", "Never"),
    terminationGracePeriodSeconds: integer,
    activeDeadlineSeconds: positive,
    runtimeClassName: text,
    nodeName: text,
    nodeSelector: map(string),
    affinity,
    tolerations: array(
      object({
        key: string,
        operator: one("Exists", "Equal"),
        value: string,
        effect: one("", "NoSchedule", "PreferNoSchedule", "NoExecute"),
        tolerationSeconds: integer,
      }),
    ),
    schedulerName: text,
    priority: integer,
    priorityClassName: text,
    preemptionPolicy: one("Never", "PreemptLowerPriority"),
    topologySpreadConstraints: array(
      object(
        {
          maxSkew: positive,
          topologyKey: text,
          whenUnsatisfiable: one("DoNotSchedule", "ScheduleAnyway"),
          labelSelector,
          minDomains: positive,
          nodeAffinityPolicy: one("Honor", "Ignore"),
          nodeTaintsPolicy: one("Honor", "Ignore"),
          matchLabelKeys: strings,
        },
        ["maxSkew", "topologyKey", "whenUnsatisfiable"],
      ),
    ),
    hostNetwork: boolean,
    hostPID: boolean,
    hostIPC: boolean,
    hostUsers: boolean,
    shareProcessNamespace: boolean,
    imagePullSecrets: array(object({ name: text }, ["name"]), "name"),
  },
  [
    "containers",
    "initContainers",
    "ephemeralContainers",
    "securityContext",
    "serviceAccountName",
    "automountServiceAccountToken",
    "volumes",
    "dnsPolicy",
    "dnsConfig",
    "hostAliases",
    "enableServiceLinks",
    "restartPolicy",
    "terminationGracePeriodSeconds",
    "runtimeClassName",
    "nodeSelector",
    "affinity",
    "tolerations",
    "hostNetwork",
    "hostPID",
    "hostIPC",
  ],
);
const condition = object(
  {
    type: text,
    status: one("True", "False", "Unknown"),
    lastProbeTime: nullableTime,
    lastTransitionTime: nullableTime,
    reason: string,
    message: string,
    observedGeneration: integer,
  },
  ["type", "status"],
);
const state: Rule = {
  ...object({
    waiting: object({ reason: string, message: string }),
    running: object({ startedAt: nullableTime }),
    terminated: object(
      {
        exitCode: integer,
        signal: integer,
        reason: string,
        message: string,
        startedAt: nullableTime,
        finishedAt: nullableTime,
        containerID: string,
      },
      ["exitCode"],
    ),
  }),
  exclusive: ["waiting", "running", "terminated"],
};
const status = object({
  phase: one("Pending", "Running", "Succeeded", "Failed", "Unknown"),
  message: string,
  reason: string,
  nominatedNodeName: string,
  qosClass: one("Guaranteed", "Burstable", "BestEffort"),
  startTime: nullableTime,
  hostIP: string,
  podIP: string,
  hostIPs: array(object({ ip: text }, ["ip"])),
  podIPs: array(object({ ip: text }, ["ip"])),
  conditions: array(condition, "type"),
  observedGeneration: integer,
  ...Object.fromEntries(
    ["containerStatuses", "initContainerStatuses", "ephemeralContainerStatuses"].map((name) => [
      name,
      array(
        object(
          {
            name: text,
            state,
            lastState: { ...state, optionalExclusive: true },
            ready: boolean,
            restartCount: integer,
            image: text,
            imageID: string,
            containerID: string,
            started: boolean,
            allocatedResources: optionalBudget,
            resources: podResources,
          },
          ["name", "ready", "restartCount", "image", "imageID"],
        ),
        "name",
      ),
    ]),
  ),
});
const documentRule = object(
  {
    pod: object(
      { apiVersion: one("v1"), kind: one("Pod"), metadata: objectMetadata, spec: podSpec, status },
      ["apiVersion", "kind", "metadata", "spec"],
    ),
    controller: object(
      {
        apiVersion: one("apps/v1"),
        kind: one("Deployment"),
        metadata: objectMetadata,
        spec: object(
          {
            replicas: integer,
            selector: labelSelector,
            strategy: object(
              {
                type: one("RollingUpdate", "Recreate"),
                rollingUpdate: object({ maxSurge: percent, maxUnavailable: percent }, [
                  "maxSurge",
                  "maxUnavailable",
                ]),
              },
              ["type"],
            ),
            template: object({ metadata, spec: podSpec }, ["metadata", "spec"]),
            minReadySeconds: integer,
            revisionHistoryLimit: integer,
            paused: boolean,
            progressDeadlineSeconds: positive,
          },
          ["replicas", "selector", "strategy", "template"],
        ),
        status: object({
          observedGeneration: integer,
          replicas: integer,
          updatedReplicas: integer,
          readyReplicas: integer,
          availableReplicas: integer,
          unavailableReplicas: integer,
          collisionCount: integer,
          conditions: array(condition, "type"),
        }),
      },
      ["apiVersion", "kind", "metadata", "spec"],
    ),
  },
  ["pod", "controller"],
);

function isObject(value: Json | undefined): value is Raw {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function safePath(path: string): Finding["fieldPath"] {
  // Only fixed source-controlled paths leave this module. Input keys never do.
  const match = CONTAINMENT_ADMISSION_FIELD_PATHS_V1.find((p) => p === path);
  if (match) return match;
  if (path.startsWith("controller.spec.template")) return "controller.spec.template";
  for (const p of [...CONTAINMENT_ADMISSION_FIELD_PATHS_V1].sort((a, b) => b.length - a.length)) {
    const prefix = p.endsWith(".*") ? p.slice(0, -1) : p;
    if (
      prefix !== "$" &&
      (path.startsWith(prefix + ".") ||
        path.startsWith(prefix + "[") ||
        (p.endsWith(".*") && path.startsWith(prefix)))
    )
      return p;
  }
  for (const role of ["initContainers", "ephemeralContainers"] as const)
    if (path.startsWith(`pod.spec.${role}[*]`)) return `pod.spec.${role}[*]`;
  return "unknown-field";
}
function issue(findings: Finding[], reasonCode: Finding["reasonCode"], path: string): void {
  findings.push({ reasonCode, fieldPath: safePath(path) });
}
function inspect(rule: Rule, value: Json, path: string, findings: Finding[]): void {
  if (rule.raw) return;
  if (rule.test) {
    if (!rule.test(value)) issue(findings, "unsupported-value", path);
    return;
  }
  if (rule.item) {
    if (!Array.isArray(value)) {
      issue(findings, "unsupported-value", path);
      return;
    }
    if (value.length < (rule.minimum ?? 0)) issue(findings, "required-field-absent", path);
    const seen = new Set<Json>();
    for (const item of value) {
      inspect(rule.item, item, path + "[*]", findings);
      if (rule.unique) {
        let identity: Json | undefined = item;
        if (rule.unique !== true) identity = isObject(item) ? item[rule.unique] : undefined;
        if (identity !== undefined) {
          if (seen.has(identity)) issue(findings, "unsupported-value", path);
          seen.add(identity);
        }
      }
    }
    return;
  }
  if (!isObject(value)) {
    issue(findings, "unsupported-value", path);
    return;
  }
  if (rule.map) {
    for (const item of Object.values(value)) inspect(rule.map, item, path + ".*", findings);
    return;
  }
  if (rule.refine && !rule.refine(value)) issue(findings, "unsupported-value", path);
  const fields = rule.fields ?? {};
  for (const key of rule.required ?? [])
    if (!Object.hasOwn(value, key)) issue(findings, "required-field-absent", path + "." + key);
  if (rule.exclusive) {
    const count = rule.exclusive.filter((key) => Object.hasOwn(value, key)).length;
    if (count > 1 || (count === 0 && !rule.optionalExclusive))
      issue(findings, "unsupported-value", path);
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key)) {
      issue(findings, "unsupported-field", path + "." + key);
      continue;
    }
    inspect(fields[key]!, value[key]!, path ? path + "." + key : key, findings);
  }
}
function associations(spec: Raw, path: string, findings: Finding[]): void {
  const volumes = Array.isArray(spec.volumes) ? spec.volumes.filter(isObject) : [];
  const names = new Set(volumes.map((v) => v.name));
  const allNames = new Set<Json>();
  for (const role of ["containers", "initContainers", "ephemeralContainers"]) {
    const containers = spec[role];
    if (!Array.isArray(containers)) continue;
    for (const c of containers) {
      if (!isObject(c)) continue;
      const base = `${path}.${role}[*]`;
      if (c.name !== undefined) {
        if (allNames.has(c.name)) issue(findings, "unsupported-value", base);
        allNames.add(c.name);
      }
      if (Array.isArray(c.volumeMounts))
        for (const m of c.volumeMounts) {
          if (!isObject(m)) continue;
          if (!names.has(m.name)) issue(findings, "unsupported-value", base + ".volumeMounts[*]");
          if (Object.hasOwn(m, "subPath") && Object.hasOwn(m, "subPathExpr"))
            issue(findings, "unsupported-value", base + ".volumeMounts[*]");
        }
    }
  }
}
function referenceAssociations(spec: Raw, path: string, findings: Finding[]): void {
  const containers = ["containers", "initContainers", "ephemeralContainers"].flatMap((role) =>
    Array.isArray(spec[role]) ? spec[role].filter(isObject) : [],
  );
  const names = new Set(containers.map((c) => c.name));
  const sources = (value: Json, pointer: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) sources(item, pointer + "[*]");
      return;
    }
    if (!isObject(value)) return;
    if (
      isObject(value.resourceFieldRef) &&
      Object.hasOwn(value.resourceFieldRef, "containerName") &&
      !names.has(value.resourceFieldRef.containerName)
    )
      issue(findings, "unsupported-value", pointer);
    for (const [key, item] of Object.entries(value)) sources(item, pointer + "." + key);
  };
  sources(spec, path);
  for (const role of ["containers", "initContainers", "ephemeralContainers"]) {
    const list = spec[role];
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      if (!isObject(c)) continue;
      const ports = new Set<Json>();
      if (Array.isArray(c.ports))
        for (const port of c.ports) {
          if (!isObject(port) || port.name === undefined) continue;
          if (ports.has(port.name)) issue(findings, "unsupported-value", `${path}.${role}[*]`);
          ports.add(port.name);
        }
      const handlers: { value: Json | undefined; pointer: string }[] = [
        "readinessProbe",
        "livenessProbe",
        "startupProbe",
      ].map((key) => ({ value: c[key], pointer: `${path}.${role}[*].${key}` }));
      if (isObject(c.lifecycle))
        for (const key of ["postStart", "preStop"])
          handlers.push({ value: c.lifecycle[key], pointer: `${path}.${role}[*].lifecycle` });
      for (const handler of handlers)
        if (isObject(handler.value))
          for (const kind of ["httpGet", "tcpSocket"]) {
            const action = handler.value[kind];
            if (isObject(action) && typeof action.port === "string" && !ports.has(action.port))
              issue(findings, "unsupported-value", handler.pointer);
          }
    }
  }
}
function selectorAssociation(document: Document, findings: Finding[]): void {
  const cs = document.controller.spec;
  if (!isObject(cs) || !isObject(cs.selector) || !isObject(cs.template)) return;
  // This selected Deployment policy supports literal matchLabels. Expression
  // selectors remain unsupported here; affinity expressions are compared above.
  if (Array.isArray(cs.selector.matchExpressions) && cs.selector.matchExpressions.length > 0)
    issue(findings, "unsupported-value", "controller.spec.template");
  if (!isObject(cs.selector.matchLabels) || Object.keys(cs.selector.matchLabels).length === 0) {
    issue(findings, "required-field-absent", "controller.spec.template");
    return;
  }
  for (const meta of [document.pod.metadata, cs.template.metadata]) {
    if (!isObject(meta) || !isObject(meta.labels)) continue;
    for (const [key, value] of Object.entries(cs.selector.matchLabels))
      if (meta.labels[key] !== value)
        issue(findings, "unsupported-value", "controller.spec.template");
  }
}
function statusAssociations(document: Document, findings: Finding[]): void {
  if (!isObject(document.pod.status) || !isObject(document.pod.spec)) return;
  for (const [statusRole, specRole] of [
    ["containerStatuses", "containers"],
    ["initContainerStatuses", "initContainers"],
    ["ephemeralContainerStatuses", "ephemeralContainers"],
  ]) {
    if (!statusRole || !specRole) continue;
    const statuses = document.pod.status[statusRole],
      containers = document.pod.spec[specRole];
    if (!Array.isArray(statuses) || !Array.isArray(containers)) continue;
    const expected = new Set(containers.filter(isObject).map((c) => c.name));
    if (
      statuses.length !== expected.size ||
      statuses.some((x) => !isObject(x) || !expected.has(x.name))
    )
      issue(findings, "unsupported-value", "pod.status");
  }
}
/** Finite raw-field support and static completeness only, not profile authority. */
export function inspectDocument(
  document: Document,
  binding: ContainmentAdmissionInputV1["binding"],
): Finding[] {
  const findings: Finding[] = [];
  inspect(documentRule, document, "", findings);
  for (const [key, object] of [
    ["pod", document.pod],
    ["controller", document.controller],
  ] as const)
    if (
      isObject(object.metadata) &&
      !Object.hasOwn(object.metadata, "name") &&
      !Object.hasOwn(object.metadata, "generateName")
    )
      issue(findings, "required-field-absent", key);
  if (
    isObject(document.pod.metadata) &&
    isObject(document.controller.metadata) &&
    document.pod.metadata.namespace !== document.controller.metadata.namespace
  )
    issue(findings, "unsupported-value", "controller.metadata.namespace");
  selectorAssociation(document, findings);
  statusAssociations(document, findings);
  if (binding.subject.stage === "observed") {
    for (const [key, object] of [
      ["pod", document.pod],
      ["controller", document.controller],
    ] as const)
      if (!isObject(object.metadata) || !Object.hasOwn(object.metadata, "name"))
        issue(findings, "required-field-absent", key);
    const observation = binding.subject.observation;
    if (
      observation.status === "complete" &&
      isObject(document.controller.metadata) &&
      document.controller.metadata.name !== observation.object.target.name
    )
      issue(findings, "unsupported-value", "controller.metadata.name");
  }
  if (isObject(document.pod.spec)) associations(document.pod.spec, "pod.spec", findings);
  if (isObject(document.pod.spec)) referenceAssociations(document.pod.spec, "pod.spec", findings);
  const cs = document.controller.spec;
  if (isObject(cs)) {
    if (isObject(cs.strategy)) {
      const rolling = Object.hasOwn(cs.strategy, "rollingUpdate");
      if ((cs.strategy.type === "RollingUpdate") !== rolling)
        issue(
          findings,
          rolling ? "unsupported-value" : "required-field-absent",
          "controller.spec.strategy",
        );
    }
    if (isObject(cs.template) && isObject(cs.template.spec)) {
      associations(cs.template.spec, "controller.spec.template.spec", findings);
      referenceAssociations(cs.template.spec, "controller.spec.template.spec", findings);
      if (isObject(document.pod.spec))
        for (const role of ["containers", "initContainers", "ephemeralContainers"]) {
          const a = document.pod.spec[role],
            b = cs.template.spec[role];
          if (
            Array.isArray(a) &&
            Array.isArray(b) &&
            !same(
              a.map((x) => (isObject(x) ? (x.name ?? null) : null)),
              b.map((x) => (isObject(x) ? (x.name ?? null) : null)),
            )
          )
            issue(findings, "unsupported-value", "controller.spec.template");
        }
    }
  }
  return findings;
}
function same(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => same(v, b[i]!));
  if (!isObject(a) || !isObject(b)) return false;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((k) => Object.hasOwn(b, k) && same(a[k]!, b[k]!))
  );
}
/** Exact comparison views; raw trees and immutable profile domains are untouched. */
export function compareDocuments(
  actual: Document,
  expected: Document,
  exclusions: readonly string[],
): Finding[] {
  const findings: Finding[] = [];
  const compare = (a: Json, b: Json, path: string, diagnosticPath: string): void => {
    if (exclusions.includes(diagnosticPath)) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) issue(findings, "field-mismatch", path);
      for (let n = 0; n < Math.min(a.length, b.length); n++)
        compare(a[n]!, b[n]!, path + "[*]", diagnosticPath + "[*]");
      return;
    }
    if (isObject(a) && isObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const next = path ? path + "." + key : key;
        const diagnostic = diagnosticPath ? diagnosticPath + "." + key : key;
        if (exclusions.includes(diagnostic)) continue;
        if (!Object.hasOwn(a, key)) issue(findings, "required-field-absent", next);
        else if (!Object.hasOwn(b, key)) issue(findings, "field-mismatch", next);
        else compare(a[key]!, b[key]!, next, diagnostic);
      }
      return;
    }
    if (a !== b) issue(findings, "field-mismatch", path);
  };
  compare(actual, expected, "", "");
  return findings;
}
