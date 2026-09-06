import type { PreparationJobIdentityV1 } from "@openclaw-enterprise/contracts/preparation-job-v1";
import { parsePreparationJobV1 } from "@openclaw-enterprise/contracts/preparation-job-codec-v1";

// Registration applicability data for the original identity owner. Parsing does
// not register an identity, authenticate a peer or create an assignment/SVID.
export function inspectPreparationIdentity(input: unknown): PreparationJobIdentityV1 {
  return parsePreparationJobV1("identity", input);
}
export function lineage(identity: PreparationJobIdentityV1) {
  return {
    purpose: identity.purpose,
    preparation: identity.target.preparation.preparationRef,
    incarnation: identity.target.preparation.incarnationRef,
    jobUid: identity.pod.jobUid,
    podUid: identity.pod.podUid,
    nodeUid: identity.execution.nodeUid,
    execution: identity.execution.executionRef,
    generation: identity.execution.executionGeneration,
  };
}
