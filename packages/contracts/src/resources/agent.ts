import { immutableCopy } from "@openclaw-enterprise/utils";
import type { ProviderRef } from "../drivers/provider.ts";
import type { ConfigurationKind, OpenClawConfigurationDocument } from "./configuration.ts";
import type { Scope } from "./scope.ts";
import type { SecretBindings } from "./secret.ts";
import type { ServiceAccountRevision } from "./service-account.ts";

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
  readonly servicePrincipalId: string;
  readonly activeRevisionId?: string;
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
  readonly serviceAccount?: ServiceAccountRevision;
  readonly servicePrincipalId: string;
  readonly createdAt: string;
}

export function freezeAgentRevision(revision: AgentRevision): Readonly<AgentRevision> {
  return Object.freeze({
    ...revision,
    configuration: immutableCopy(revision.configuration),
    ...(revision.secretBindings === undefined
      ? {}
      : { secretBindings: immutableCopy(revision.secretBindings) }),
    harness: Object.freeze({ ...revision.harness }),
    compute: Object.freeze({ ...revision.compute }),
    ...(revision.serviceAccount === undefined
      ? {}
      : { serviceAccount: immutableCopy(revision.serviceAccount) }),
  });
}
