import type { PluginDesiredState, PluginRevisionState } from "../plugins.ts";
import { immutableCopy } from "@openclaw-enterprise/utils";
import type { ProviderRef } from "../drivers/provider.ts";
import type { ConfigurationKind, OpenClawConfigurationDocument } from "./configuration.ts";
import type { Scope } from "./scope.ts";
import type { SecretBindings } from "./secret.ts";
import type { ServiceAccountRevision } from "./service-account.ts";
import type { WorkloadProfileSelectionV1, WorkloadProfileUseV2 } from "../workload-profile-v1.ts";

export const HARNESS_EXECUTION_MODES = Object.freeze(["embedded", "dedicated"] as const);

export type HarnessExecutionMode = (typeof HARNESS_EXECUTION_MODES)[number];

export interface Agent extends Scope {
  readonly id: string;
  readonly namespaceId: string;
  readonly name: string;
  readonly configurationId: string;
  readonly providerId: ProviderRef;
  readonly serviceAccountId?: string;
  readonly executionMode: HarnessExecutionMode;
  readonly plugins?: PluginDesiredState;
  readonly maximumExecutionMs: number | null;
  readonly servicePrincipalId: string;
  readonly activeRevisionId?: string;
  readonly workloadProfileSelection?: WorkloadProfileSelectionV1;
  readonly createdAt: string;
}

export interface HarnessDescriptor {
  readonly id: string;
  readonly version: string;
}

export interface RevisionHarnessDescriptor extends HarnessDescriptor {
  readonly mode: HarnessExecutionMode;
}

export interface AgentRevision extends Scope {
  readonly id: string;
  readonly namespaceId: string;
  readonly agentId: string;
  readonly revision: number;
  /** Absent only on historical revisions whose execution policy is unavailable. */
  readonly maximumExecutionMs?: number | null;
  readonly providerId: ProviderRef;
  readonly configurationId: string;
  readonly configurationKind: ConfigurationKind;
  readonly configurationGeneration: number;
  readonly configuration: OpenClawConfigurationDocument;
  readonly harness: RevisionHarnessDescriptor;
  readonly compute: {
    readonly id: string;
    readonly implementation: string;
  };
  readonly sandboxDriverId?: string;
  readonly secretDriverId?: string;
  readonly secretBindings?: SecretBindings;
  readonly plugins?: PluginRevisionState;
  readonly serviceAccount?: ServiceAccountRevision;
  readonly servicePrincipalId: string;
  readonly workloadProfileUse?: WorkloadProfileUseV2;
  readonly createdAt: string;
}

export function freezeAgentRevision(revision: AgentRevision): Readonly<AgentRevision> {
  return Object.freeze({
    ...revision,
    configuration: immutableCopy(revision.configuration),
    ...(revision.secretBindings === undefined
      ? {}
      : { secretBindings: immutableCopy(revision.secretBindings) }),
    ...(revision.plugins === undefined ? {} : { plugins: immutableCopy(revision.plugins) }),
    harness: Object.freeze({ ...revision.harness }),
    compute: Object.freeze({ ...revision.compute }),
    ...(revision.serviceAccount === undefined
      ? {}
      : { serviceAccount: immutableCopy(revision.serviceAccount) }),
    ...(revision.workloadProfileUse === undefined
      ? {}
      : { workloadProfileUse: immutableCopy(revision.workloadProfileUse) }),
  });
}
