import type {
  AgentRevision as RootAgentRevision,
  SecretBindings as RootSecretBindings,
} from "@openclaw-enterprise/contracts";
import type { AgentRevision } from "@openclaw-enterprise/contracts/resources/agent";
import type { Configuration } from "@openclaw-enterprise/contracts/resources/configuration";
import type { SecretBindings } from "@openclaw-enterprise/contracts/resources/secret";
import type { Installation } from "@openclaw-enterprise/contracts/resources/installation";
import type { Namespace } from "@openclaw-enterprise/contracts/resources/namespace";
import type { ServiceAccount } from "@openclaw-enterprise/contracts/resources/service-account";
import type { Identity } from "@openclaw-enterprise/contracts/identity/identity";
import type { AuthorizationRequest } from "@openclaw-enterprise/contracts/identity/authorization";
import type { AuditEvent } from "@openclaw-enterprise/contracts/identity/audit";
import type { AuditEventFactory } from "../../../packages/audit/src/index.ts";
import { produceRevision } from "./producer.ts";

type Implements<Contract, Implementation extends Contract> = Implementation;

export type ConsumerResources = {
  readonly installation: Installation;
  readonly namespace: Namespace;
  readonly serviceAccount: ServiceAccount;
  readonly identity: Identity;
  readonly authorization: AuthorizationRequest;
  readonly audit: Implements<AuditEvent, ReturnType<AuditEventFactory["create"]>>;
};

// Both package entrypoints accept the same immutable revision and Secret types.
export function consumeRevision(
  configuration: Configuration,
  bindings?: RootSecretBindings,
): RootAgentRevision {
  const leafBindings: SecretBindings | undefined = bindings;
  const revision: AgentRevision = produceRevision(configuration, leafBindings);
  return revision;
}
