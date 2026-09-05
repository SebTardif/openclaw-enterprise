import type { Driver } from "./base.ts";
import type { AgentRevision } from "../resources/agent.ts";
import type { OpenClawConfigurationDocument } from "../resources/configuration.ts";
import type { Namespace } from "../resources/namespace.ts";

export const SANDBOX_FACETS = Object.freeze(["networking", "filesystem", "process"] as const);

export type SandboxFacet = (typeof SANDBOX_FACETS)[number];

export function isSandboxFacet(value: unknown): value is SandboxFacet {
  return typeof value === "string" && SANDBOX_FACETS.some((facet) => facet === value);
}

export type KubernetesNamespacedResource = Readonly<Record<string, unknown>>;

export interface SandboxWorkspaceMount {
  readonly claimName: string;
  readonly subPath: string;
  readonly mountPath: string;
  readonly readOnly: boolean;
}

export type SandboxEnvironmentVariable =
  | { readonly name: string; readonly value: string }
  | {
      readonly name: string;
      readonly valueFrom: {
        readonly secretKeyRef: { readonly name: string; readonly key: string };
      };
    };

export interface HarnessWorkloadRequirements {
  readonly image: string;
  readonly command: readonly string[];
  readonly serviceAccountName: string;
  readonly serviceAccountToken: {
    readonly audience: string;
    readonly expirationSeconds: number;
    readonly mountPath: string;
    readonly path: string;
    readonly readOnly: true;
  };
  readonly workspaceMounts: readonly SandboxWorkspaceMount[];
  readonly environment: readonly SandboxEnvironmentVariable[];
  readonly labels: Readonly<Record<string, string>>;
}

export interface SandboxResourceRef {
  readonly namespaceName: string;
  readonly resourceName: string;
  readonly agentId: string;
  readonly revisionId: string;
}

export interface SandboxNamespaceContext {
  readonly namespace: Readonly<Namespace>;
  readonly kubernetes: unknown;
  readonly signal: AbortSignal;
}

export interface SandboxHarnessContext extends SandboxNamespaceContext {
  readonly revision: Readonly<AgentRevision>;
  readonly requirements: HarnessWorkloadRequirements;
}

export interface SandboxDriver extends Driver {
  readonly capability: "sandbox";
  /** One or more distinct containment facets implemented by this driver. */
  readonly facets: readonly SandboxFacet[];
  configureAgent?(
    configuration: Readonly<OpenClawConfigurationDocument>,
  ): OpenClawConfigurationDocument;
  ensureNamespace?(context: SandboxNamespaceContext): Promise<void>;
  provisionHarness?(context: SandboxHarnessContext): Promise<SandboxResourceRef>;
  cleanup(
    context: SandboxNamespaceContext & { readonly revision?: Readonly<AgentRevision> },
  ): Promise<void>;
}
