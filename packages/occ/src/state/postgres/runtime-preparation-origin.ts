import { ScopeViolationError } from "../../errors.ts";
import { canonicalLifecycleDeployCommandV2 } from "@openclaw-enterprise/contracts/lifecycle-deploy-v2";
import type { DeployAgentCommandInput } from "../../services/deployment/port.ts";
import type { WorkloadProfileOwnedOperationV2 } from "../../workload-profiles/admitted-use.ts";
import { parseRuntimePreparationSessionOriginV1 } from "../../runtime-preparation/origin.ts";
import type { RuntimePreparationSessionOriginV1 } from "../../runtime-preparation/origin.ts";

/** Called only by the original enrolled first-admission owner after its actual
 * revision/intent/audit/work insertion. Never used for a historical replay. */
export async function retainRuntimePreparationOriginV1(
  io: WorkloadProfileOwnedOperationV2,
  input: Readonly<{
    deployment: DeployAgentCommandInput;
    revisionId: string;
    principalId: string;
    accountRef: string;
    requestId: string;
    admissionDecisionId: string;
    origin: RuntimePreparationSessionOriginV1;
  }>,
): Promise<void> {
  const origin = parseRuntimePreparationSessionOriginV1(input.origin);
  if (origin.accountId !== input.accountRef)
    throw new ScopeViolationError("The preparation admission account differs.");
  io.assertActive();
  const result = await io.query(
    `INSERT INTO occ.runtime_preparation_admission_origins
       (installation_id,namespace_id,agent_id,revision_id,intent_ref,
        lifecycle_generation,actor_id,request_id,session_origin,admission_decision_id)
     SELECT intent.installation_id,admission.namespace_id,admission.agent_id,
            admission.revision_id,admission.runtime_transition_ref,
            admission.lifecycle_generation,intent.actor_id,intent.request_id,$8::jsonb,$10
       FROM occ.agent_revision_runtime_admissions admission
       JOIN occ.agent_runtime_intents intent
         ON intent.namespace_id=admission.namespace_id AND intent.agent_id=admission.agent_id
        AND intent.transition_ref=admission.runtime_transition_ref
        AND intent.generation=admission.lifecycle_generation
      WHERE intent.installation_id=$1 AND admission.namespace_id=$2
        AND admission.agent_id=$3 AND admission.revision_id=$4
        AND admission.runtime_transition_ref=$5 AND admission.deploy_actor_id=$6
        AND intent.actor_id=$6 AND intent.request_id=$7
        AND intent.desired_mode='running' AND intent.revision_id=admission.revision_id
        AND admission.deploy_canonical=$9`,
    [
      origin.installationId,
      input.deployment.namespaceId,
      input.deployment.agentId,
      input.revisionId,
      input.deployment.command.operationRef,
      input.principalId,
      input.requestId,
      JSON.stringify(origin),
      canonicalLifecycleDeployCommandV2(
        {
          installationId: origin.installationId,
          namespaceId: input.deployment.namespaceId,
          agentId: input.deployment.agentId,
        },
        input.deployment.command,
      ),
      input.admissionDecisionId,
    ],
  );
  io.assertActive();
  if (result.rowCount !== 1)
    throw new ScopeViolationError("The original preparation admission association is unavailable.");
}
