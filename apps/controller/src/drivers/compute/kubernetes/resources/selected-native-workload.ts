import { isDeepStrictEqual } from "node:util";
import type { V1Deployment, V1EnvVar } from "@kubernetes/client-node";
import { immutableCopy } from "@openclaw-enterprise/utils";
import {
  canonicalizeWorkloadProfileJson,
  decodeWorkloadProfileJson,
} from "@openclaw-enterprise/occ/workload-profiles/canonical";
import { deriveWorkloadProfileManifestV2 } from "@openclaw-enterprise/occ/workload-profiles/projections";
import { decodeSelectedNativeDefinitionV1 } from "@openclaw-enterprise/occ/workload-profiles/selected-native-definition";
import type { DerivedWorkloadProfileManifestV2 } from "@openclaw-enterprise/occ/workload-profiles/projections";
type WorkloadProfileManifestContentV2 = DerivedWorkloadProfileManifestV2["content"];
import { manifest, type Ownership } from "./identity.ts";
import {
  normalizeKubernetesResourcePlan,
  type KubernetesResourceContributionMap,
} from "./revision-resource-plan.ts";

type Reference = WorkloadProfileManifestContentV2["containment"]["definition"];
type Binding = "configuration-path" | "state-path" | "bootstrap-socket";

/** Detached operands from original Runtime/environment/storage owners. This is
 * pure construction input, never a qualification result or provider-call lease.
 * An explicit initializer is mandatory: the legacy Node helper is not assumed
 * to exist in a selected native image. Its behavior requires Runtime validation.
 * TODO(selected native launch): connect the actual native configuration and
 * identity launch sources before any production selection of this constructor. */
export interface SelectedNativeWorkloadOperandsV1 {
  readonly target: {
    readonly name: string;
    readonly namespace: string;
    readonly ownership: Ownership;
    readonly serviceAccountName: string;
  };
  readonly runtimeDefinition: Reference;
  readonly environmentDefinition: Reference;
  readonly arguments: Readonly<Partial<Record<Binding, string>>>;
  readonly environment: readonly { readonly name: string; readonly value: string }[];
  readonly initialization: {
    readonly image: string;
    readonly executable: { readonly path: string; readonly contentDigest: string };
    readonly argv: readonly string[];
    readonly environment: readonly { readonly name: string; readonly value: string }[];
  };
  readonly readiness: {
    readonly executable: { readonly path: string; readonly contentDigest: string };
    readonly argv: readonly string[];
    readonly initialDelaySeconds: number;
    readonly periodSeconds: number;
    readonly timeoutSeconds: number;
    readonly failureThreshold: number;
  };
  readonly processIdentity: {
    readonly uid: number;
    readonly gid: number;
    readonly fsGroup: number;
  };
  readonly localStorage: { readonly runtimeHome: string; readonly temporary: string };
  readonly mounts: readonly {
    readonly definition: WorkloadProfileManifestContentV2["launchConfiguration"]["harness"]["mounts"][number];
    readonly claimName: string;
  }[];
  readonly accounting: Readonly<Record<"gateway" | "harness", KubernetesResourceContributionMap>>;
}
export class SelectedNativeWorkloadError extends Error {
  constructor() {
    super("The complete selected native workload operands are unavailable or unsupported.");
    this.name = "SelectedNativeWorkloadError";
  }
}
function requireValue(value: unknown): asserts value {
  if (!value) throw new SelectedNativeWorkloadError();
}
function shape(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  requireValue(value && typeof value === "object" && !Array.isArray(value));
  requireValue(
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)),
  );
}
function path(value: unknown): asserts value is string {
  requireValue(
    typeof value === "string" &&
      value.length <= 1024 &&
      /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value),
  );
  requireValue(value.split("/").every((part) => part !== "." && part !== ".."));
}
function name(value: unknown): asserts value is string {
  requireValue(
    typeof value === "string" &&
      value.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value),
  );
}
function integer(value: unknown, min: number, max: number): void {
  requireValue(Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max);
}
function argv(value: unknown): asserts value is readonly string[] {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= 32);
  requireValue(
    value.every((part) => typeof part === "string" && part.length <= 8192 && !part.includes("\0")),
  );
  path(value[0]);
}
function same(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(immutableCopy(left), immutableCopy(right));
}
function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** Complete fixed Pod shape. Re-decodes all detached data; emits desired objects
 * only. It does not inspect images, certify initializer/probe/config semantics,
 * authenticate sources, select a profile, or contact Kubernetes. */
export function selectedNativeWorkloadV1(
  canonicalManifest: Uint8Array,
  canonicalDefinition: Uint8Array,
  supplied: SelectedNativeWorkloadOperandsV1,
): V1Deployment {
  const selected = deriveWorkloadProfileManifestV2(canonicalManifest).content;
  const definition = decodeSelectedNativeDefinitionV1(canonicalDefinition, canonicalManifest).value;
  const raw = decodeWorkloadProfileJson(canonicalizeWorkloadProfileJson(supplied)).value;
  shape(raw, [
    "target",
    "runtimeDefinition",
    "environmentDefinition",
    "arguments",
    "environment",
    "initialization",
    "readiness",
    "processIdentity",
    "localStorage",
    "mounts",
    "accounting",
  ]);
  const input = raw as unknown as SelectedNativeWorkloadOperandsV1;
  const launch = selected.launchConfiguration;
  name(launch.harness.runtimeClass);
  requireValue(same(input.runtimeDefinition, launch.runtime.implementation));
  requireValue(same(input.environmentDefinition, launch.harness.environmentDefinition));
  shape(input.target, ["name", "namespace", "ownership", "serviceAccountName"]);
  for (const value of [input.target.name, input.target.namespace, input.target.serviceAccountName])
    name(value);
  shape(input.target.ownership, ["namespaceId", "agentId", "servicePrincipalId", "revisionId"]);
  for (const value of Object.values(input.target.ownership))
    requireValue(
      typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/.test(value),
    );
  requireValue(
    input.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments),
  );
  const bindings = new Set<Binding>();
  const applicationArgv = launch.harness.argv.map((part) => {
    if (part.kind === "literal") return part.value;
    bindings.add(part.name);
    const value = input.arguments[part.name];
    path(value);
    return value;
  });
  requireValue(
    Object.keys(input.arguments).length === bindings.size &&
      Object.keys(input.arguments).every((key) => bindings.has(key as Binding)),
  );
  argv(applicationArgv);
  requireValue(applicationArgv[0] === selected.artifactSet.harness.executable.path);
  requireValue(
    typeof selected.artifactSet.harness.reference === "string" &&
      selected.artifactSet.harness.reference.length <= 1024 &&
      /^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/.test(selected.artifactSet.harness.reference),
  );
  requireValue(
    selected.artifactSet.harness.reference.endsWith(
      `@${selected.artifactSet.harness.platformDigest}`,
    ),
  );
  for (const environment of [input.environment, input.initialization.environment]) {
    requireValue(Array.isArray(environment) && environment.length <= 64);
    const environmentNames = new Set<string>();
    for (const entry of environment) {
      shape(entry, ["name", "value"]);
      requireValue(
        typeof entry.name === "string" &&
          /^[A-Z_][A-Z0-9_]{0,127}$/.test(entry.name) &&
          !environmentNames.has(entry.name),
      );
      environmentNames.add(entry.name);
      requireValue(
        typeof entry.value === "string" &&
          entry.value.length <= 8192 &&
          !entry.value.includes("\0"),
      );
      // These historical branches are structurally unsupported. This is not a
      // secret detector; the original environment owner must qualify all values.
      requireValue(
        !/^(?:OPENAI_API_KEY|CODEX_ACCESS_TOKEN|CODEX_CHATGPT_WORKSPACE_ID|APP_SERVER_TOKEN|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SLACK_.*|MSTEAMS_.*)$/.test(
          entry.name,
        ),
      );
    }
  }
  shape(input.initialization, ["image", "executable", "argv", "environment"]);
  shape(input.initialization.executable, ["path", "contentDigest"]);
  requireValue(
    typeof input.initialization.image === "string" &&
      input.initialization.image.length <= 1024 &&
      /^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$/.test(input.initialization.image),
  );
  requireValue(/^sha256:[0-9a-f]{64}$/.test(input.initialization.executable.contentDigest));
  argv(input.initialization.argv);
  requireValue(input.initialization.argv[0] === input.initialization.executable.path);
  shape(input.readiness, [
    "executable",
    "argv",
    "initialDelaySeconds",
    "periodSeconds",
    "timeoutSeconds",
    "failureThreshold",
  ]);
  shape(input.readiness.executable, ["path", "contentDigest"]);
  requireValue(/^sha256:[0-9a-f]{64}$/.test(input.readiness.executable.contentDigest));
  argv(input.readiness.argv);
  requireValue(input.readiness.argv[0] === input.readiness.executable.path);
  integer(input.readiness.initialDelaySeconds, 0, 300);
  integer(input.readiness.periodSeconds, 1, 300);
  integer(input.readiness.timeoutSeconds, 1, 30);
  integer(input.readiness.failureThreshold, 1, 10);
  shape(input.processIdentity, ["uid", "gid", "fsGroup"]);
  for (const value of Object.values(input.processIdentity)) integer(value, 1, 2147483647);
  shape(input.localStorage, ["runtimeHome", "temporary"]);
  path(input.localStorage.runtimeHome);
  path(input.localStorage.temporary);
  requireValue(!overlaps(input.localStorage.runtimeHome, input.localStorage.temporary));
  requireValue(
    Array.isArray(input.mounts) &&
      same(
        input.mounts.map((item) => item.definition),
        launch.harness.mounts,
      ),
  );
  const mountPaths = [input.localStorage.runtimeHome, input.localStorage.temporary];
  for (const [index, item] of input.mounts.entries()) {
    shape(item, ["definition", "claimName"]);
    const mount = launch.harness.mounts[index]!;
    name(item.claimName);
    name(mount.name);
    path(mount.path);
    requireValue(!["runtime-home", "runtime-temporary"].includes(mount.name));
    requireValue(!mountPaths.some((other) => overlaps(other, mount.path)));
    mountPaths.push(mount.path);
  }
  shape(input.accounting, ["gateway", "harness"]);
  for (const value of Object.values(input.accounting))
    shape(value, ["application", "privateStateInit"]);
  const resources = normalizeKubernetesResourcePlan(
    launch.resourceEnvelope.podAndRuntimeAccounting.envelope,
    input.accounting,
  ).harness;
  const ownership = input.target.ownership;
  const labels = {
    "openclaw.dev/workload-role": "agent",
    "openclaw.dev/agent": ownership.agentId!,
    "openclaw.dev/revision": ownership.revisionId!,
  };
  const securityContext = {
    runAsUser: input.processIdentity.uid,
    runAsGroup: input.processIdentity.gid,
    runAsNonRoot: true,
    privileged: false,
    readOnlyRootFilesystem: true,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    seccompProfile: { type: "RuntimeDefault" },
  };
  const home = { name: "runtime-home", mountPath: input.localStorage.runtimeHome, readOnly: false };
  const temporary = {
    name: "runtime-temporary",
    mountPath: input.localStorage.temporary,
    readOnly: false,
  };
  return immutableCopy({
    ...manifest("apps/v1", "Deployment", input.target.name, ownership, input.target.namespace),
    spec: {
      replicas: 1,
      strategy: { type: "Recreate" },
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          runtimeClassName: launch.harness.runtimeClass,
          restartPolicy: "Always",
          terminationGracePeriodSeconds: 30,
          serviceAccountName: input.target.serviceAccountName,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          hostNetwork: false,
          hostPID: false,
          hostIPC: false,
          dnsPolicy: "None",
          dnsConfig: {
            nameservers: [definition.containment.resolver.address],
            searches: [],
            options: [{ name: "ndots", value: "1" }],
          },
          securityContext: {
            fsGroup: input.processIdentity.fsGroup,
            runAsUser: input.processIdentity.uid,
            runAsGroup: input.processIdentity.gid,
            supplementalGroups: [],
            supplementalGroupsPolicy: "Strict",
            runAsNonRoot: true,
            seccompProfile: { type: "RuntimeDefault" },
          },
          volumes: [
            { name: home.name, emptyDir: { sizeLimit: String(resources.runtimeHomeBytes) } },
            { name: temporary.name, emptyDir: { sizeLimit: String(resources.temporaryBytes) } },
            ...input.mounts.map(({ definition: mount, claimName }) => ({
              name: mount.name,
              persistentVolumeClaim: { claimName, readOnly: mount.access === "read-only" },
            })),
          ],
          initContainers: [
            {
              name: "prepare-private-state",
              image: input.initialization.image,
              imagePullPolicy: "IfNotPresent",
              command: [input.initialization.argv[0]!],
              args: input.initialization.argv.slice(1),
              env: input.initialization.environment as V1EnvVar[],
              securityContext,
              resources: resources.privateStateInit,
              volumeMounts: [home, temporary],
            },
          ],
          containers: [
            {
              name: "agent",
              image: selected.artifactSet.harness.reference,
              imagePullPolicy: "IfNotPresent",
              command: [applicationArgv[0]!],
              args: applicationArgv.slice(1),
              env: input.environment as V1EnvVar[],
              securityContext,
              resources: resources.application,
              volumeMounts: [
                home,
                temporary,
                ...input.mounts.map(({ definition: mount }) => ({
                  name: mount.name,
                  mountPath: mount.path,
                  readOnly: mount.access === "read-only",
                })),
              ],
              readinessProbe: {
                exec: { command: [...input.readiness.argv] },
                initialDelaySeconds: input.readiness.initialDelaySeconds,
                periodSeconds: input.readiness.periodSeconds,
                timeoutSeconds: input.readiness.timeoutSeconds,
                failureThreshold: input.readiness.failureThreshold,
              },
            },
          ],
        },
      },
    },
  });
}
