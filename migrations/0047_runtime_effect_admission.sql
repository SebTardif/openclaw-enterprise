-- Canonical closed runtime gate and original same-generation cleanup ownership.
-- Opening execution and authentic fault-service composition remain unavailable.
BEGIN;

CREATE TABLE occ.runtime_effect_gates (
  installation_id text NOT NULL REFERENCES occ.installation(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  preparation_ref text NOT NULL,
  preparation_operation_ref text NOT NULL REFERENCES occ.runtime_preparation_operations(operation_ref) ON DELETE RESTRICT ON UPDATE RESTRICT,
  target jsonb NOT NULL,
  gate_guard jsonb NOT NULL,
  plan jsonb NOT NULL,
  ordinary_admission text NOT NULL DEFAULT 'closed',
  sealer_admission text NOT NULL DEFAULT 'closed',
  last_closure_operation_ref text,
  CONSTRAINT runtime_effect_gates_pk PRIMARY KEY(installation_id,namespace_id,agent_id),
  CONSTRAINT runtime_effect_gates_agent_owner FOREIGN KEY(namespace_id,agent_id)
    REFERENCES occ.agents(namespace_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT runtime_effect_gates_preparation_unique UNIQUE(preparation_operation_ref),
  CONSTRAINT runtime_effect_gates_admission_closed CHECK(ordinary_admission='closed' AND sealer_admission='closed'),
  CONSTRAINT runtime_effect_gates_size CHECK(octet_length(gate_guard::text)<=65536 AND octet_length(plan::text)<=65536)
);

ALTER TABLE occ.runtime_cleanup_responsibilities
  ADD COLUMN fault_request jsonb,
  ADD COLUMN fault_canonical_request text,
  ADD COLUMN fault_closed_guard jsonb,
  ADD COLUMN fault_work jsonb,
  ADD COLUMN fault_audit_id text REFERENCES occ.audit_events(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD COLUMN fault_writer_ref text,
  ADD COLUMN intent_ref text GENERATED ALWAYS AS
    (CASE WHEN origin_kind='lifecycle-protective-v1' THEN origin_operation_ref ELSE fault_request#>>'{guard,intentRef}' END) STORED,
  ADD COLUMN lifecycle_admission_ref text GENERATED ALWAYS AS
    (CASE WHEN origin_kind='lifecycle-protective-v1' THEN origin_operation_ref ELSE NULL END) STORED,
  DROP CONSTRAINT runtime_cleanup_responsibilities_intent_owner,
  DROP CONSTRAINT runtime_cleanup_responsibilities_admission_owner,
  DROP CONSTRAINT runtime_cleanup_responsibilities_origin,
  ADD CONSTRAINT runtime_cleanup_responsibilities_intent_owner
    FOREIGN KEY(namespace_id,agent_id,lifecycle_generation,intent_ref)
    REFERENCES occ.agent_runtime_intents(namespace_id,agent_id,generation,transition_ref) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT runtime_cleanup_responsibilities_admission_owner
    FOREIGN KEY(lifecycle_admission_ref) REFERENCES occ.agent_lifecycle_admissions(operation_ref)
    ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT runtime_cleanup_responsibilities_origin CHECK(
    (origin_operation_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND ((origin_kind='lifecycle-protective-v1' AND fault_request IS NULL
      AND fault_canonical_request IS NULL AND fault_closed_guard IS NULL AND fault_work IS NULL
      AND fault_audit_id IS NULL AND fault_writer_ref IS NULL)
    OR (origin_kind='runtime-fault-v1' AND responsibility_version=1 AND fault_request IS NOT NULL
      AND fault_canonical_request IS NOT NULL AND fault_closed_guard IS NOT NULL AND fault_work IS NOT NULL
      AND fault_audit_id IS NOT NULL AND fault_writer_ref IS NOT NULL AND kind IN ('protective-fence','retained-stop')
      AND intent_ref IS NOT NULL AND predecessor_ref=intent_ref AND predecessor_generation=lifecycle_generation
      AND octet_length(fault_request::text)<=1048576 AND octet_length(fault_canonical_request)<=1048576
      AND octet_length(fault_work::text)<=4096))) IS TRUE);
CREATE UNIQUE INDEX runtime_fault_work_unique ON occ.runtime_cleanup_responsibilities((fault_work->>'workId'))
  WHERE origin_kind='runtime-fault-v1';
CREATE INDEX runtime_fault_pending_owner ON occ.runtime_cleanup_responsibilities(installation_id,namespace_id,agent_id,created_at)
  WHERE origin_kind='runtime-fault-v1';

ALTER TABLE occ.controller_work ADD COLUMN fault_work jsonb;
ALTER TABLE occ.lifecycle_capabilities ADD COLUMN runtime_fault_version smallint
  CHECK(runtime_fault_version IS NULL OR runtime_fault_version=1);
ALTER TABLE occ.controller_work
  DROP CONSTRAINT controller_work_runtime_pair_valid,
  DROP CONSTRAINT controller_work_namespace_target_valid,
  ADD CONSTRAINT controller_work_runtime_pair_valid CHECK(
    (work_schema_version=0 AND handler IS NULL AND fault_work IS NULL AND (
      (runtime_transition_ref IS NULL AND lifecycle_generation IS NULL)
      OR (runtime_transition_ref IS NOT NULL AND lifecycle_generation IS NOT NULL
        AND agent_id IS NOT NULL AND revision_id IS NOT NULL AND namespace_target IS NULL
        AND runtime_transition_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND lifecycle_generation BETWEEN 1 AND 9007199254740991)))
    OR (work_schema_version IN (1,2) AND handler IS NOT NULL
      AND ((work_schema_version=1 AND handler='ReconcileAgentLifecycleV1' AND fault_work IS NULL)
        OR (work_schema_version=2 AND handler='ReconcileRuntimeFaultV1' AND fault_work IS NOT NULL))
      AND runtime_transition_ref IS NOT NULL AND lifecycle_generation IS NOT NULL
      AND agent_id IS NOT NULL AND namespace_target IS NULL
      AND runtime_transition_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND lifecycle_generation BETWEEN 1 AND 9007199254740991)),
  ADD CONSTRAINT controller_work_namespace_target_valid CHECK(
    (work_schema_version=0 AND handler IS NULL AND fault_work IS NULL AND (
      (agent_id IS NULL AND revision_id IS NULL AND namespace_target IN ('ready','deleted') AND namespace_target IS NOT NULL)
      OR (agent_id IS NOT NULL AND revision_id IS NOT NULL AND namespace_target IS NULL)))
    OR (work_schema_version IN (1,2) AND handler IS NOT NULL AND agent_id IS NOT NULL AND namespace_target IS NULL
      AND ((work_schema_version=1 AND handler='ReconcileAgentLifecycleV1' AND fault_work IS NULL)
        OR (work_schema_version=2 AND handler='ReconcileRuntimeFaultV1' AND fault_work IS NOT NULL))));

-- Validator bodies below are generated from the original exported closed schemas.
CREATE FUNCTION occ.runtime_gate_guard_valid_v1(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $function$
  SELECT occ.runtime_preparation_shape(value,$schema${"type":"object","required":["schemaVersion","scope","intentRef","mode","lifecycleGeneration","requestedFenceEpoch","responsibility","gateVersion","planRef","planVersion","planDigest","admittedChildCutoff"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}}},"intentRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"mode":{"enum":["running","stopped","disabled"]},"lifecycleGeneration":{"type":"integer","minimum":1,"maximum":9007199254740991},"requestedFenceEpoch":{"type":"integer","minimum":1,"maximum":9007199254740991},"responsibility":{"type":"object","required":["responsibilityRef","responsibilityVersion","kind"],"properties":{"responsibilityRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"responsibilityVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"kind":{"enum":["preparation","protective-fence","retained-stop"]}},"additionalProperties":false},"gateVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"planRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"planVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"planDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"admittedChildCutoff":{"type":"integer","minimum":0,"maximum":9007199254740991}},"additionalProperties":false}$schema$::jsonb)
$function$;
CREATE FUNCTION occ.runtime_fault_request_valid_v1(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $function$
  SELECT (occ.runtime_preparation_shape(value,$schema${"type":"object","required":["schemaVersion","operation","target","guard","cleanupResponsibility","reasonCode","cause"],"properties":{"schemaVersion":{"type":"number","const":1},"operation":{"type":"object","required":["schemaVersion","scope","operationRef","operationKind","requestDigest"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}}},"operationRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"operationKind":{"type":"string","const":"fault-and-fence"},"requestDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"target":{"type":"object","required":["installationId","namespaceId","agentId","assignmentRef","revisionId","component","lifecycleGeneration","runtimeGeneration","createEffectRef"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"assignmentRef":{"type":"object","required":["schemaVersion","id"],"properties":{"schemaVersion":{"type":"number","const":1},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"revisionId":{"type":"string","pattern":"^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"component":{"enum":["gateway","harness"]},"lifecycleGeneration":{"type":"integer","minimum":1,"maximum":9007199254740991},"runtimeGeneration":{"type":"integer","minimum":1,"maximum":9007199254740991},"createEffectRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"guard":{"type":"object","required":["schemaVersion","scope","intentRef","mode","lifecycleGeneration","requestedFenceEpoch","responsibility","gateVersion","planRef","planVersion","planDigest","admittedChildCutoff"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}}},"intentRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"mode":{"enum":["running","stopped","disabled"]},"lifecycleGeneration":{"type":"integer","minimum":1,"maximum":9007199254740991},"requestedFenceEpoch":{"type":"integer","minimum":1,"maximum":9007199254740991},"responsibility":{"type":"object","required":["responsibilityRef","responsibilityVersion","kind"],"properties":{"responsibilityRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"responsibilityVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"kind":{"enum":["preparation","protective-fence","retained-stop"]}},"additionalProperties":false},"gateVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"planRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"planVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"planDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"admittedChildCutoff":{"type":"integer","minimum":0,"maximum":9007199254740991}},"additionalProperties":false},"cleanupResponsibility":{"type":"object","required":["responsibilityRef","responsibilityVersion","kind"],"properties":{"responsibilityRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"responsibilityVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"kind":{"enum":["preparation","protective-fence","retained-stop"]}},"additionalProperties":false},"reasonCode":{"enum":["denied","unavailable","conflict","capability-unsupported","authority-unavailable","authority-lost","capacity-exhausted","ownership-mismatch","evidence-stale","evidence-incomplete","provider-outcome-unknown","writer-unresolved","source-time-invalid","cancelled","deadline-exceeded","precondition-failed","gate-changed","sealer-closed","domain-invalid","store-mismatch"]},"cause":{"anyOf":[{"type":"object","required":["kind","evidence"],"properties":{"kind":{"type":"string","const":"runtime-evidence"},"evidence":{"anyOf":[{"type":"object","required":["schemaVersion","target","bindingVersion","evidenceVersion","kind","observationRef","providerObservedAt","receivedAt","validUntil","uncertaintyMs","binding","outcome","policyObservedAt","readinessObservedAt"],"properties":{"schemaVersion":{"type":"number","const":1},"target":{"type":"object","required":["installationId","namespaceId","agentId","assignmentRef","revisionId","component","lifecycleGeneration","runtimeGeneration","createEffectRef"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"assignmentRef":{"type":"object","required":["schemaVersion","id"],"properties":{"schemaVersion":{"type":"number","const":1},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"revisionId":{"type":"string","pattern":"^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"component":{"enum":["gateway","harness"]},"lifecycleGeneration":{"type":"integer","minimum":1,"maximum":9007199254740991},"runtimeGeneration":{"type":"integer","minimum":1,"maximum":9007199254740991},"createEffectRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"bindingVersion":{"type":"number","const":1},"evidenceVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"kind":{"type":"string","const":"runtime"},"observationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"providerObservedAt":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"receivedAt":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"validUntil":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"uncertaintyMs":{"type":"integer","minimum":0,"maximum":2000},"binding":{"anyOf":[{"type":"object","required":["schemaVersion","bindingVersion","clusterRef","kubernetesNamespaceUid","podUid","deploymentUid","replicaSetUid","imageDigests","policyRevision","admittedConfigurationDigest","profileDigests","provider","component","runtimeClass","runtimeHandler","runtimeType","platform","isolation","runscSandboxId","runtimeInstanceRef","protectedRestartDiscriminator","runtimeBinaryDigest","runtimeDistributionDigest","runtimeFlagsDigest"],"properties":{"schemaVersion":{"type":"number","const":1},"bindingVersion":{"type":"number","const":1},"clusterRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"kubernetesNamespaceUid":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"podUid":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"deploymentUid":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"replicaSetUid":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"imageDigests":{"type":"array","items":{"type":"object","required":["name","digest"],"properties":{"name":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"digest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"minItems":1,"maxItems":16},"policyRevision":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"admittedConfigurationDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"profileDigests":{"type":"object","required":["provider","runtime","identity"],"properties":{"provider":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"runtime":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"identity":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"provider":{"type":"string","const":"occ/kubernetes-gvisor"},"component":{"type":"string","const":"harness"},"runtimeClass":{"type":"string","const":"oce-gvisor-systrap"},"runtimeHandler":{"type":"string","const":"oce-gvisor-systrap"},"runtimeType":{"type":"string","const":"io.containerd.runsc.v1"},"platform":{"type":"string","const":"systrap"},"isolation":{"type":"string","const":"STRICT"},"runscSandboxId":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"runtimeInstanceRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"protectedRestartDiscriminator":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"runtimeBinaryDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"runtimeDistributionDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"runtimeFlagsDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},{"type":"object","required":["schemaVersion","bindingVersion","clusterRef","kubernetesNamespaceUid","podUid","deploymentUid","replicaSetUid","imageDigests","policyRevision","admittedConfigurationDigest","profileDigests","provider","component","runtimeInstanceRef","protectedRestartDiscriminator","scheduling"],"properties":{"schemaVersion":{"type":"number","const":1},"bindingVersion":{"type":"number","const":1},"clusterRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"kubernetesNamespaceUid":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"podUid":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"deploymentUid":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"replicaSetUid":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"imageDigests":{"type":"array","items":{"type":"object","required":["name","digest"],"properties":{"name":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"digest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"minItems":1,"maxItems":16},"policyRevision":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"admittedConfigurationDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"profileDigests":{"type":"object","required":["provider","runtime","identity"],"properties":{"provider":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"runtime":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"identity":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"provider":{"type":"string","const":"occ/kubernetes-gateway"},"component":{"type":"string","const":"gateway"},"runtimeInstanceRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"protectedRestartDiscriminator":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"scheduling":{"anyOf":[{"type":"object","required":["mode","profileRef"],"properties":{"mode":{"type":"string","const":"default"},"profileRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},{"type":"object","required":["mode","runtimeClass","profileRef"],"properties":{"mode":{"type":"string","const":"runtime-class"},"runtimeClass":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"profileRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false}]}},"additionalProperties":false}]},"outcome":{"anyOf":[{"type":"object","required":["result","reasonCode"],"properties":{"result":{"type":"string","const":"satisfied"},"reasonCode":{"type":"string","const":"conditions-satisfied"}},"additionalProperties":false},{"type":"object","required":["result","reasonCode"],"properties":{"result":{"type":"string","const":"unsatisfied"},"reasonCode":{"enum":["evidence-stale","observation-invalid","agent-disabled","agent-stopped","assignment-replaced","assignment-retired","binding-mismatch","peer-mismatch","component-denied","peer-invalid","peer-untrusted","peer-expired","candidate-only","operation-denied","profile-authority-denied","profile-reference-invalid","profile-invalid","profile-unresolved","version-unsupported","capability-missing","bundle-invalid","bundle-rollback","provider-permission-denied","provider-outcome-unknown"]}},"additionalProperties":false},{"type":"object","required":["result","reasonCode"],"properties":{"result":{"type":"string","const":"unknown"},"reasonCode":{"enum":["evidence-incomplete","lookup-unavailable","provider-outcome-unknown"]}},"additionalProperties":false}]},"policyObservedAt":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"readinessObservedAt":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"}},"additionalProperties":false},{"type":"object","required":["schemaVersion","target","bindingVersion","evidenceVersion","kind","verifierEvidenceRef","registrationId","registrationVersion","identityProfileRef","verifiedAt","receivedAt","expiresAt","uncertaintyMs","outcome"],"properties":{"schemaVersion":{"type":"number","const":1},"target":{"type":"object","required":["installationId","namespaceId","agentId","assignmentRef","revisionId","component","lifecycleGeneration","runtimeGeneration","createEffectRef"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"assignmentRef":{"type":"object","required":["schemaVersion","id"],"properties":{"schemaVersion":{"type":"number","const":1},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"revisionId":{"type":"string","pattern":"^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"component":{"enum":["gateway","harness"]},"lifecycleGeneration":{"type":"integer","minimum":1,"maximum":9007199254740991},"runtimeGeneration":{"type":"integer","minimum":1,"maximum":9007199254740991},"createEffectRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"bindingVersion":{"type":"number","const":1},"evidenceVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"kind":{"type":"string","const":"identity"},"verifierEvidenceRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"registrationId":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"registrationVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"identityProfileRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"verifiedAt":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"receivedAt":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"expiresAt":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"uncertaintyMs":{"type":"integer","minimum":0,"maximum":2000},"outcome":{"anyOf":[{"type":"object","required":["result","reasonCode"],"properties":{"result":{"type":"string","const":"verified"},"reasonCode":{"type":"string","const":"peer-verified"}},"additionalProperties":false},{"type":"object","required":["result","reasonCode"],"properties":{"result":{"type":"string","const":"rejected"},"reasonCode":{"enum":["evidence-stale","observation-invalid","agent-disabled","agent-stopped","assignment-replaced","assignment-retired","binding-mismatch","peer-mismatch","component-denied","peer-invalid","peer-untrusted","peer-expired","candidate-only","operation-denied","profile-authority-denied","profile-reference-invalid","profile-invalid","profile-unresolved","version-unsupported","capability-missing","bundle-invalid","bundle-rollback","provider-permission-denied","provider-outcome-unknown"]}},"additionalProperties":false},{"type":"object","required":["result","reasonCode"],"properties":{"result":{"type":"string","const":"unknown"},"reasonCode":{"enum":["evidence-incomplete","lookup-unavailable"]}},"additionalProperties":false}]}},"additionalProperties":false}]}},"additionalProperties":false},{"type":"object","required":["kind","source","authorityRef","previousVersion","currentVersion","currentnessEvidence","recoveryResponsibilityRef"],"properties":{"kind":{"type":"string","const":"authority-loss"},"source":{"enum":["service","profile","responsibility","authoritative-lease"]},"authorityRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"previousVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"currentVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"currentnessEvidence":{"type":"object","required":["producerRef","producerServiceVersion","producerProfileRef","producerProfileDigest","acceptedPortRef","evidenceRef","evidenceVersion","clock"],"properties":{"producerRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"producerServiceVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"producerProfileRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"producerProfileDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"acceptedPortRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"evidenceRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"evidenceVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"clock":{"type":"object","required":["sourceObservedAt","receivedAt","validUntil","uncertaintyMs"],"properties":{"sourceObservedAt":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"receivedAt":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"validUntil":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"uncertaintyMs":{"type":"integer","minimum":0,"maximum":2000}}}},"additionalProperties":false},"recoveryResponsibilityRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false}]}},"additionalProperties":false}$schema$::jsonb)
    AND value#>'{operation,scope}'=value#>'{guard,scope}'
    AND value#>'{operation,scope}'=jsonb_build_object('installationId',value#>'{target,installationId}',
      'namespaceId',value#>'{target,namespaceId}','agentId',value#>'{target,agentId}')
    AND value#>>'{cleanupResponsibility,kind}' IN ('protective-fence','retained-stop')
    AND (value#>>'{cause,kind}'<>'runtime-evidence' OR value#>'{cause,evidence,target}'=value->'target')
    AND (value#>>'{cause,kind}'<>'authority-loss'
      OR (value#>>'{cause,currentVersion}')::bigint>(value#>>'{cause,previousVersion}')::bigint)) IS TRUE
$function$;
REVOKE ALL ON FUNCTION occ.runtime_gate_guard_valid_v1(jsonb),occ.runtime_fault_request_valid_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.runtime_gate_guard_valid_v1(jsonb),occ.runtime_fault_request_valid_v1(jsonb) TO occ_app;

CREATE FUNCTION occ.require_runtime_effect_gate() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $function$
DECLARE original occ.runtime_preparation_operations%ROWTYPE; request jsonb;
  fault occ.runtime_cleanup_responsibilities%ROWTYPE; intent occ.agent_runtime_intents%ROWTYPE;
  closure occ.agent_lifecycle_admissions%ROWTYPE; expected jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'runtime gate identity is permanently retained' USING ERRCODE='23514'; END IF;
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'runtime gate mutations require READ COMMITTED isolation' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM occ.agents WHERE namespace_id=NEW.namespace_id AND id=NEW.agent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'runtime gate owner is unavailable' USING ERRCODE='23514'; END IF;
  IF NOT occ.runtime_gate_guard_valid_v1(NEW.gate_guard) OR NOT occ.runtime_preparation_plan(NEW.plan)
    OR NEW.gate_guard->'scope' IS DISTINCT FROM jsonb_build_object('installationId',NEW.installation_id,'namespaceId',NEW.namespace_id,'agentId',NEW.agent_id)
    OR NEW.gate_guard->>'planRef' IS DISTINCT FROM NEW.plan->>'planRef'
    OR NEW.gate_guard->'planVersion' IS DISTINCT FROM NEW.plan->'planVersion'
    OR NEW.gate_guard->>'planDigest' IS DISTINCT FROM NEW.plan->>'planDigest'
    OR NEW.gate_guard->'admittedChildCutoff' IS DISTINCT FROM '0'::jsonb THEN
    RAISE EXCEPTION 'runtime gate shape or closed cutoff is invalid' USING ERRCODE='23514';
  END IF;
  SELECT * INTO original FROM occ.runtime_preparation_operations WHERE operation_ref=NEW.preparation_operation_ref;
  request:=original.canonical_request::jsonb;
  IF original.operation_kind IS DISTINCT FROM 'retain-plan' OR original.preparation_ref IS DISTINCT FROM NEW.preparation_ref
    OR original.installation_id IS DISTINCT FROM NEW.installation_id OR original.namespace_id IS DISTINCT FROM NEW.namespace_id
    OR original.agent_id IS DISTINCT FROM NEW.agent_id OR request->'target' IS DISTINCT FROM NEW.target
    OR request->'plan' IS DISTINCT FROM NEW.plan THEN
    RAISE EXCEPTION 'runtime gate requires its exact original preparation' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.last_closure_operation_ref IS NOT NULL OR NEW.gate_guard IS DISTINCT FROM request->'guard'
      OR NOT EXISTS(SELECT 1 FROM occ.agent_runtime_intent_heads h JOIN occ.agent_runtime_intents i ON i.transition_ref=h.transition_ref
        WHERE h.namespace_id=NEW.namespace_id AND h.agent_id=NEW.agent_id
          AND i.transition_ref=NEW.gate_guard->>'intentRef' AND to_jsonb(i.generation)=NEW.gate_guard->'lifecycleGeneration'
          AND i.desired_mode=NEW.gate_guard->>'mode') THEN
      RAISE EXCEPTION 'runtime gate must initialize closed at the exact current intent' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.installation_id,NEW.namespace_id,NEW.agent_id,NEW.preparation_ref,NEW.preparation_operation_ref)
    IS DISTINCT FROM (OLD.installation_id,OLD.namespace_id,OLD.agent_id,OLD.preparation_ref,OLD.preparation_operation_ref)
    OR NEW.target IS DISTINCT FROM OLD.target OR NEW.plan IS DISTINCT FROM OLD.plan
    OR NEW.ordinary_admission IS DISTINCT FROM OLD.ordinary_admission OR NEW.sealer_admission IS DISTINCT FROM OLD.sealer_admission
    OR NEW.last_closure_operation_ref IS NULL OR NEW.last_closure_operation_ref IS NOT DISTINCT FROM OLD.last_closure_operation_ref THEN
    RAISE EXCEPTION 'runtime gate identity or closure conflicts' USING ERRCODE='23514';
  END IF;
  SELECT * INTO fault FROM occ.runtime_cleanup_responsibilities
    WHERE origin_kind='runtime-fault-v1' AND origin_operation_ref=NEW.last_closure_operation_ref
      AND installation_id=NEW.installation_id AND namespace_id=NEW.namespace_id AND agent_id=NEW.agent_id;
  IF FOUND THEN
    IF fault.fault_request->'guard' IS DISTINCT FROM OLD.gate_guard OR fault.fault_closed_guard IS DISTINCT FROM NEW.gate_guard
      OR NOT EXISTS(SELECT 1 FROM occ.agent_runtime_intent_heads h
        WHERE h.namespace_id=NEW.namespace_id AND h.agent_id=NEW.agent_id
          AND h.transition_ref=NEW.gate_guard->>'intentRef' AND to_jsonb(h.generation)=NEW.gate_guard->'lifecycleGeneration') THEN
      RAISE EXCEPTION 'runtime fault closure does not match its exact gate' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO closure FROM occ.agent_lifecycle_admissions WHERE operation_ref=NEW.last_closure_operation_ref;
    SELECT * INTO intent FROM occ.agent_runtime_intents WHERE transition_ref=closure.operation_ref;
    expected:=OLD.gate_guard||jsonb_build_object('intentRef',intent.transition_ref,'mode',intent.desired_mode,
      'lifecycleGeneration',intent.generation,'gateVersion',(OLD.gate_guard->>'gateVersion')::bigint+1,
      'requestedFenceEpoch',(OLD.gate_guard->>'requestedFenceEpoch')::bigint+1,
      'responsibility',jsonb_build_object('responsibilityRef',closure.responsibility_ref,'responsibilityVersion',closure.responsibility_version,
        'kind',CASE closure.kind WHEN 'disable' THEN 'protective-fence' ELSE 'retained-stop' END));
    IF closure.operation_ref IS NULL OR closure.namespace_id IS DISTINCT FROM NEW.namespace_id OR closure.agent_id IS DISTINCT FROM NEW.agent_id
      OR closure.lifecycle_generation<=(OLD.gate_guard->>'lifecycleGeneration')::bigint
      OR NOT EXISTS(SELECT 1 FROM occ.agent_runtime_intent_heads h
        WHERE h.namespace_id=NEW.namespace_id AND h.agent_id=NEW.agent_id
          AND h.transition_ref=closure.operation_ref AND h.generation=closure.lifecycle_generation)
      OR NEW.gate_guard IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'runtime gate closure requires its original protective admission' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER runtime_effect_gate_exact BEFORE INSERT OR UPDATE OR DELETE ON occ.runtime_effect_gates
  FOR EACH ROW EXECUTE FUNCTION occ.require_runtime_effect_gate();

CREATE FUNCTION occ.close_runtime_effect_gate_for_intent() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $function$
DECLARE gate occ.runtime_effect_gates%ROWTYPE; intent occ.agent_runtime_intents%ROWTYPE;
  closure occ.agent_lifecycle_admissions%ROWTYPE; next_guard jsonb;
BEGIN
  SELECT * INTO gate FROM occ.runtime_effect_gates WHERE namespace_id=NEW.namespace_id AND agent_id=NEW.agent_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO intent FROM occ.agent_runtime_intents WHERE transition_ref=NEW.transition_ref;
  SELECT * INTO closure FROM occ.agent_lifecycle_admissions WHERE operation_ref=NEW.transition_ref;
  IF closure.operation_ref IS NULL THEN
    RAISE EXCEPTION 'runtime gate supersession requires an exact retained cleanup owner' USING ERRCODE='23514';
  END IF;
  next_guard:=gate.gate_guard||jsonb_build_object('intentRef',intent.transition_ref,'mode',intent.desired_mode,
    'lifecycleGeneration',intent.generation,'gateVersion',(gate.gate_guard->>'gateVersion')::bigint+1,
    'requestedFenceEpoch',(gate.gate_guard->>'requestedFenceEpoch')::bigint+1,
    'responsibility',jsonb_build_object('responsibilityRef',closure.responsibility_ref,'responsibilityVersion',closure.responsibility_version,
      'kind',CASE closure.kind WHEN 'disable' THEN 'protective-fence' ELSE 'retained-stop' END));
  UPDATE occ.runtime_effect_gates SET gate_guard=next_guard,last_closure_operation_ref=NEW.transition_ref
    WHERE installation_id=gate.installation_id AND namespace_id=gate.namespace_id AND agent_id=gate.agent_id;
  RETURN NEW;
END
$function$;
CREATE TRIGGER runtime_intent_closes_effect_gate AFTER UPDATE ON occ.agent_runtime_intent_heads
  FOR EACH ROW EXECUTE FUNCTION occ.close_runtime_effect_gate_for_intent();

CREATE FUNCTION occ.runtime_fault_complete_v1(operation_ref text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $function$
DECLARE retained occ.runtime_cleanup_responsibilities%ROWTYPE; work occ.controller_work%ROWTYPE;
  gate occ.runtime_effect_gates%ROWTYPE; audit occ.audit_events%ROWTYPE; original jsonb; expected jsonb;
BEGIN
  SELECT * INTO retained FROM occ.runtime_cleanup_responsibilities r
    WHERE r.origin_kind='runtime-fault-v1' AND r.origin_operation_ref=operation_ref;
  IF NOT FOUND THEN RAISE EXCEPTION 'runtime fault responsibility is incomplete' USING ERRCODE='23514'; END IF;
  original:=retained.fault_request;
  expected:=original->'guard'||jsonb_build_object('gateVersion',(original#>>'{guard,gateVersion}')::bigint+1,
    'requestedFenceEpoch',(original#>>'{guard,requestedFenceEpoch}')::bigint+1,'responsibility',original->'cleanupResponsibility');
  IF NOT occ.runtime_fault_request_valid_v1(original)
    OR original#>>'{operation,operationRef}' IS DISTINCT FROM retained.origin_operation_ref
    OR original#>'{operation,scope}' IS DISTINCT FROM jsonb_build_object('installationId',retained.installation_id,'namespaceId',retained.namespace_id,'agentId',retained.agent_id)
    OR original->'cleanupResponsibility' IS DISTINCT FROM jsonb_build_object('responsibilityRef',retained.responsibility_ref,'responsibilityVersion',retained.responsibility_version,'kind',retained.kind)
    OR original#>'{guard,lifecycleGeneration}' IS DISTINCT FROM to_jsonb(retained.lifecycle_generation)
    OR retained.fault_closed_guard IS DISTINCT FROM expected
    OR retained.fault_canonical_request IS DISTINCT FROM occ.runtime_preparation_canonical(
      jsonb_set(original,'{operation}',(original->'operation')-'requestDigest'))
    OR original#>>'{operation,requestDigest}' IS DISTINCT FROM 'sha256:'||encode(sha256(convert_to(retained.fault_canonical_request,'UTF8')),'hex')
    OR jsonb_typeof(retained.fault_work->'workId') IS DISTINCT FROM 'string'
    OR (retained.fault_work->>'workId' ~ '^[A-Za-z0-9._:/-]+$') IS DISTINCT FROM TRUE
    OR char_length(retained.fault_work->>'workId') NOT BETWEEN 1 AND 512
    OR retained.fault_work IS DISTINCT FROM jsonb_build_object('schemaVersion',2,'handler','ReconcileRuntimeFaultV1',
      'installationId',retained.installation_id,'namespaceId',retained.namespace_id,'agentId',retained.agent_id,
      'intentRef',retained.intent_ref,'lifecycleGeneration',retained.lifecycle_generation,
      'operationRef',retained.origin_operation_ref,'requestDigest',original#>'{operation,requestDigest}',
      'responsibilityRef',retained.responsibility_ref,'responsibilityVersion',1,
      'requestedFenceEpoch',expected->'requestedFenceEpoch','gateVersion',expected->'gateVersion','workId',retained.fault_work->'workId') THEN
    RAISE EXCEPTION 'runtime fault exact retained correspondence is invalid' USING ERRCODE='23514';
  END IF;
  SELECT * INTO gate FROM occ.runtime_effect_gates WHERE installation_id=retained.installation_id
    AND namespace_id=retained.namespace_id AND agent_id=retained.agent_id;
  IF gate.preparation_operation_ref IS NULL OR gate.target IS DISTINCT FROM original->'target'
    OR gate.gate_guard IS DISTINCT FROM retained.fault_closed_guard OR gate.last_closure_operation_ref IS DISTINCT FROM retained.origin_operation_ref THEN
    RAISE EXCEPTION 'runtime fault gate closure is incomplete' USING ERRCODE='23514';
  END IF;
  SELECT * INTO work FROM occ.controller_work WHERE idempotency_key=retained.fault_work->>'workId';
  SELECT * INTO audit FROM occ.audit_events WHERE id=retained.fault_audit_id;
  IF work.idempotency_key IS NULL OR work.work_schema_version<>2 OR work.handler IS DISTINCT FROM 'ReconcileRuntimeFaultV1'
    OR work.fault_work IS DISTINCT FROM retained.fault_work OR work.namespace_id IS DISTINCT FROM retained.namespace_id
    OR work.agent_id IS DISTINCT FROM retained.agent_id OR work.runtime_transition_ref IS DISTINCT FROM retained.intent_ref
    OR work.lifecycle_generation IS DISTINCT FROM retained.lifecycle_generation OR work.actor_id IS DISTINCT FROM retained.fault_writer_ref
    OR work.revision_id IS DISTINCT FROM original#>>'{target,revisionId}' OR work.created_at IS DISTINCT FROM retained.created_at
    OR audit.id IS NULL OR audit.actor_id IS DISTINCT FROM retained.fault_writer_ref OR audit.action IS DISTINCT FROM 'runtime.fault.request'
    OR audit.kind IS DISTINCT FROM 'mutation' OR audit.outcome IS DISTINCT FROM 'success'
    OR audit.namespace_id IS DISTINCT FROM retained.namespace_id OR audit.resource_kind IS DISTINCT FROM 'agent'
    OR audit.resource_id IS DISTINCT FROM retained.agent_id OR audit.occurred_at IS DISTINCT FROM retained.created_at
    OR audit.details#>'{__occAuditMetadata,authorization}' IS NOT NULL THEN
    RAISE EXCEPTION 'runtime fault work or independent source audit is incomplete' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM occ.runtime_assignment_allocations a
    WHERE a.installation_id=retained.installation_id AND a.namespace_id=retained.namespace_id AND a.agent_id=retained.agent_id
      AND a.lifecycle_generation<=retained.lifecycle_generation AND NOT EXISTS(
        SELECT 1 FROM occ.runtime_cleanup_responsibility_allocations m
        WHERE m.responsibility_ref=retained.responsibility_ref AND m.responsibility_version=retained.responsibility_version
          AND m.assignment_ref=a.assignment_ref)) THEN
    RAISE EXCEPTION 'runtime fault retained allocation membership is incomplete' USING ERRCODE='23514';
  END IF;
END
$function$;

CREATE OR REPLACE FUNCTION occ.require_lifecycle_admission_complete() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $function$
DECLARE
  original_ref text;
  admission occ.agent_lifecycle_admissions%ROWTYPE;
  intent occ.agent_runtime_intents%ROWTYPE;
  previous occ.agent_runtime_intents%ROWTYPE;
  work occ.controller_work%ROWTYPE;
  responsibility occ.runtime_cleanup_responsibilities%ROWTYPE;
  export_record occ.audit_export_outbox%ROWTYPE;
  audit occ.audit_events%ROWTYPE;
  metadata jsonb;
BEGIN
  IF TG_TABLE_NAME='controller_work' THEN
    IF NEW.work_schema_version=2 THEN
      PERFORM occ.runtime_fault_complete_v1(NEW.fault_work->>'operationRef'); RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME='runtime_cleanup_responsibilities' THEN
    IF NEW.origin_kind='runtime-fault-v1' THEN
      PERFORM occ.runtime_fault_complete_v1(NEW.origin_operation_ref); RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME='runtime_cleanup_responsibility_allocations' THEN
    SELECT * INTO responsibility FROM occ.runtime_cleanup_responsibilities
      WHERE responsibility_ref=NEW.responsibility_ref AND responsibility_version=NEW.responsibility_version;
    IF responsibility.origin_kind='runtime-fault-v1' THEN
      PERFORM occ.runtime_fault_complete_v1(responsibility.origin_operation_ref); RETURN NEW;
    END IF;
  END IF;
  CASE TG_TABLE_NAME
    WHEN 'agent_runtime_intents' THEN
      IF NEW.admission_version=0 THEN RETURN NEW; END IF;
      original_ref:=NEW.transition_ref;
    WHEN 'agent_lifecycle_admissions' THEN original_ref:=NEW.operation_ref;
    WHEN 'controller_work' THEN
      IF NEW.work_schema_version=0 THEN RETURN NEW; END IF;
      original_ref:=NEW.runtime_transition_ref;
    WHEN 'runtime_cleanup_responsibility_allocations' THEN
      SELECT origin_operation_ref INTO original_ref FROM occ.runtime_cleanup_responsibilities
        WHERE responsibility_ref=NEW.responsibility_ref AND responsibility_version=NEW.responsibility_version;
    ELSE original_ref:=NEW.origin_operation_ref;
  END CASE;
  SELECT * INTO admission FROM occ.agent_lifecycle_admissions WHERE operation_ref=original_ref;
  IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle admission is incomplete' USING ERRCODE='23514'; END IF;
  SELECT * INTO intent FROM occ.agent_runtime_intents WHERE transition_ref=original_ref;
  IF NOT FOUND OR intent.admission_version<>1
    OR intent.installation_id IS DISTINCT FROM admission.installation_id
    OR intent.namespace_id IS DISTINCT FROM admission.namespace_id
    OR intent.agent_id IS DISTINCT FROM admission.agent_id
    OR intent.generation IS DISTINCT FROM admission.lifecycle_generation
    OR intent.desired_mode IS DISTINCT FROM (CASE admission.kind WHEN 'disable' THEN 'disabled' ELSE 'stopped' END)
    OR admission.work_id=original_ref
    OR admission.expected_generation IS DISTINCT FROM (CASE WHEN intent.generation=1 THEN NULL ELSE intent.generation-1 END)
    OR NOT EXISTS (SELECT 1 FROM occ.installation WHERE id=intent.installation_id)
    OR NOT EXISTS (SELECT 1 FROM occ.agent_runtime_intent_heads
      WHERE namespace_id=intent.namespace_id AND agent_id=intent.agent_id AND generation>=intent.generation)
  THEN RAISE EXCEPTION 'lifecycle intent association does not match' USING ERRCODE='23514'; END IF;
  SELECT * INTO previous FROM occ.agent_runtime_intents
    WHERE namespace_id=intent.namespace_id AND agent_id=intent.agent_id AND generation=admission.expected_generation;
  IF (admission.expected_generation IS NULL AND (intent.revision_id IS NOT NULL OR intent.generation<>1))
    OR (admission.expected_generation IS NOT NULL AND (
      previous.transition_ref IS NULL OR previous.installation_id IS DISTINCT FROM intent.installation_id
      OR previous.revision_id IS DISTINCT FROM intent.revision_id OR previous.desired_mode=intent.desired_mode
      OR previous.desired_mode='stopped')) THEN
    RAISE EXCEPTION 'lifecycle predecessor correspondence is incomplete' USING ERRCODE='23514';
  END IF;
  SELECT * INTO audit FROM occ.audit_events WHERE id=admission.audit_event_id;
  metadata:=audit.details->'__occAuditMetadata';
  IF audit.id IS NULL OR audit.kind IS DISTINCT FROM 'mutation' OR audit.outcome IS DISTINCT FROM 'success'
    OR audit.action IS DISTINCT FROM 'openclaw.agents.'||admission.kind
    OR audit.namespace_id IS DISTINCT FROM intent.namespace_id OR audit.actor_id IS DISTINCT FROM intent.actor_id
    OR audit.resource_kind IS DISTINCT FROM 'agent' OR audit.resource_id IS DISTINCT FROM intent.agent_id
    OR metadata->'requestId' IS DISTINCT FROM to_jsonb(intent.request_id)
    OR (metadata #> '{actor,principalId}' IS NOT NULL AND metadata #> '{actor,principalId}' IS DISTINCT FROM to_jsonb(intent.actor_id))
    OR (metadata #> '{actor,id}' IS NOT NULL AND metadata #> '{actor,id}' IS DISTINCT FROM to_jsonb(intent.actor_id))
    OR metadata #> '{actor,unresolved}'='true'::jsonb
    OR (metadata->'authorization' IS NOT NULL AND (
      metadata #> '{authorization,principalId}' IS DISTINCT FROM to_jsonb(intent.actor_id)
      OR metadata #> '{authorization,action}' IS DISTINCT FROM '"operate"'::jsonb
      OR metadata #> '{authorization,resource,kind}' IS DISTINCT FROM '"agent"'::jsonb
      OR metadata #> '{authorization,resource,id}' IS DISTINCT FROM to_jsonb(intent.agent_id)
      OR metadata #> '{authorization,resource,namespaceId}' IS DISTINCT FROM to_jsonb(intent.namespace_id)))
  THEN RAISE EXCEPTION 'protective audit attribution does not match' USING ERRCODE='23514'; END IF;
  SELECT * INTO work FROM occ.controller_work WHERE idempotency_key=admission.work_id;
  IF work.idempotency_key IS NULL OR work.work_schema_version<>1 OR work.handler IS DISTINCT FROM 'ReconcileAgentLifecycleV1'
    OR work.namespace_id IS DISTINCT FROM intent.namespace_id OR work.agent_id IS DISTINCT FROM intent.agent_id
    OR work.revision_id IS DISTINCT FROM intent.revision_id OR work.namespace_target IS NOT NULL
    OR work.runtime_transition_ref IS DISTINCT FROM intent.transition_ref OR work.lifecycle_generation IS DISTINCT FROM intent.generation
    OR work.actor_id IS DISTINCT FROM intent.actor_id OR work.created_at IS DISTINCT FROM intent.created_at
  THEN RAISE EXCEPTION 'protective work correspondence is incomplete' USING ERRCODE='23514'; END IF;
  SELECT * INTO responsibility FROM occ.runtime_cleanup_responsibilities
    WHERE responsibility_ref=admission.responsibility_ref AND responsibility_version=admission.responsibility_version;
  IF responsibility.responsibility_ref IS NULL OR responsibility.origin_kind<>'lifecycle-protective-v1'
    OR responsibility.origin_operation_ref IS DISTINCT FROM original_ref
    OR responsibility.installation_id IS DISTINCT FROM intent.installation_id
    OR responsibility.namespace_id IS DISTINCT FROM intent.namespace_id OR responsibility.agent_id IS DISTINCT FROM intent.agent_id
    OR responsibility.lifecycle_generation IS DISTINCT FROM intent.generation
    OR responsibility.kind IS DISTINCT FROM (CASE admission.kind WHEN 'disable' THEN 'protective-fence' ELSE 'retained-stop' END)
    OR responsibility.predecessor_ref IS DISTINCT FROM previous.transition_ref
    OR responsibility.predecessor_generation IS DISTINCT FROM admission.expected_generation
    OR responsibility.created_at IS DISTINCT FROM intent.created_at OR responsibility.inventory_status<>'unresolved'
  THEN RAISE EXCEPTION 'protective cleanup correspondence is incomplete' USING ERRCODE='23514'; END IF;
  -- Membership describes retained allocations under the shared Agent lock. It is
  -- not an inventory of provider effects, a stop proof or a successor release.
  IF EXISTS (SELECT 1 FROM occ.runtime_assignment_allocations a
      WHERE a.namespace_id=intent.namespace_id AND a.agent_id=intent.agent_id
        AND (a.installation_id IS DISTINCT FROM intent.installation_id
          OR responsibility.predecessor_generation IS NULL OR a.lifecycle_generation>responsibility.predecessor_generation
          OR NOT EXISTS (SELECT 1 FROM occ.runtime_cleanup_responsibility_allocations m
            WHERE m.responsibility_ref=responsibility.responsibility_ref AND m.responsibility_version=responsibility.responsibility_version
              AND m.assignment_ref=a.assignment_ref))) THEN
    RAISE EXCEPTION 'retained cleanup allocation membership is incomplete' USING ERRCODE='23514';
  END IF;
  SELECT * INTO export_record FROM occ.audit_export_outbox WHERE audit_event_id=admission.audit_event_id;
  IF export_record.audit_event_id IS NULL OR export_record.installation_id IS DISTINCT FROM intent.installation_id
    OR export_record.namespace_id IS DISTINCT FROM intent.namespace_id OR export_record.origin_kind<>'lifecycle-protective-v1'
    OR export_record.origin_operation_ref IS DISTINCT FROM original_ref OR export_record.state<>'pending'
    OR export_record.created_at IS DISTINCT FROM intent.created_at THEN
    RAISE EXCEPTION 'protective audit export obligation is incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION occ.require_work_runtime_admission() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  admission occ.agent_revision_runtime_admissions%ROWTYPE;
  original_actor text;
BEGIN
  IF NEW.work_schema_version=2 THEN
    IF NEW.state IS DISTINCT FROM 'queued' OR NEW.attempt_count<>0 OR NEW.claim_token IS NOT NULL
      OR NEW.lease_expires_at IS NOT NULL OR NEW.completed_at IS NOT NULL
      OR NEW.created_at IS DISTINCT FROM NEW.updated_at OR NEW.available_at IS DISTINCT FROM NEW.created_at
      OR NOT isfinite(NEW.created_at) OR NOT EXISTS(
        SELECT 1 FROM occ.runtime_cleanup_responsibilities r
        WHERE r.origin_kind='runtime-fault-v1' AND r.fault_work=NEW.fault_work
          AND r.origin_operation_ref=NEW.fault_work->>'operationRef'
          AND r.fault_work->>'workId'=NEW.idempotency_key
          AND r.namespace_id=NEW.namespace_id AND r.agent_id=NEW.agent_id
          AND r.intent_ref=NEW.runtime_transition_ref AND r.lifecycle_generation=NEW.lifecycle_generation
          AND r.fault_writer_ref=NEW.actor_id AND r.created_at=NEW.created_at
          AND r.fault_request#>>'{target,revisionId}'=NEW.revision_id) THEN
      RAISE EXCEPTION 'runtime fault work requires its exact pristine association' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.work_schema_version=1 THEN
    IF NEW.state IS DISTINCT FROM 'queued' OR NEW.attempt_count<>0 OR NEW.claim_token IS NOT NULL
      OR NEW.lease_expires_at IS NOT NULL OR NEW.completed_at IS NOT NULL
      OR NEW.created_at IS DISTINCT FROM NEW.updated_at OR NEW.available_at IS DISTINCT FROM NEW.created_at
      OR NOT isfinite(NEW.created_at) OR NOT EXISTS (
        SELECT 1 FROM occ.agent_lifecycle_admissions a JOIN occ.agent_runtime_intents i ON i.transition_ref=a.operation_ref
        WHERE a.operation_ref=NEW.runtime_transition_ref AND a.work_id=NEW.idempotency_key
          AND a.namespace_id=NEW.namespace_id AND a.agent_id=NEW.agent_id
          AND a.lifecycle_generation=NEW.lifecycle_generation AND i.admission_version=1
          AND i.revision_id IS NOT DISTINCT FROM NEW.revision_id AND i.actor_id=NEW.actor_id
          AND i.created_at=NEW.created_at
      ) THEN RAISE EXCEPTION 'versioned lifecycle work requires its exact pristine association' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.revision_id IS NULL THEN RETURN NEW; END IF;
  PERFORM 1 FROM occ.agents
    WHERE namespace_id = NEW.namespace_id AND id = NEW.agent_id FOR UPDATE;
  SELECT * INTO admission FROM occ.agent_revision_runtime_admissions
    WHERE namespace_id = NEW.namespace_id AND agent_id = NEW.agent_id
      AND revision_id = NEW.revision_id;
  IF NOT FOUND THEN
    IF NEW.runtime_transition_ref IS NOT NULL OR NEW.lifecycle_generation IS NOT NULL THEN
      RAISE EXCEPTION 'paired work requires its exact revision admission' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT actor_id INTO original_actor FROM occ.agent_runtime_intents
    WHERE namespace_id = admission.namespace_id AND agent_id = admission.agent_id
      AND revision_id = admission.revision_id AND transition_ref = admission.runtime_transition_ref
      AND generation = admission.lifecycle_generation;
  IF NOT FOUND
    OR NEW.runtime_transition_ref IS DISTINCT FROM admission.runtime_transition_ref
    OR NEW.lifecycle_generation IS DISTINCT FROM admission.lifecycle_generation
    OR NEW.actor_id IS DISTINCT FROM original_actor THEN
    RAISE EXCEPTION 'work does not match its original revision admission' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION occ.require_lifecycle_work_capability() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $function$
DECLARE marker oid; owner_id text; capability occ.lifecycle_capabilities%ROWTYPE;
BEGIN
  IF OLD.work_schema_version=0 THEN RETURN NEW; END IF;
  -- The marker is provisioned only by a separately accepted operator cutover.
  -- No migration role creation, role membership or caller GUC can supply it.
  marker:=pg_catalog.to_regrole('occ_lifecycle_worker_v1');
  IF marker IS NULL THEN RAISE EXCEPTION 'lifecycle worker capability is unavailable' USING ERRCODE='23514'; END IF;
  IF pg_catalog.pg_has_role(current_user,marker,'USAGE') IS DISTINCT FROM TRUE
    OR pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'lifecycle worker capability is unavailable' USING ERRCODE='23514';
  END IF;
  IF OLD.work_schema_version=2 THEN
    SELECT installation_id INTO owner_id FROM occ.runtime_cleanup_responsibilities
      WHERE origin_kind='runtime-fault-v1' AND fault_work=OLD.fault_work
        AND fault_work->>'workId'=OLD.idempotency_key;
  ELSE
    SELECT installation_id INTO owner_id FROM occ.agent_lifecycle_admissions WHERE operation_ref=OLD.runtime_transition_ref;
  END IF;
  IF owner_id IS NULL THEN RAISE EXCEPTION 'lifecycle work association is unavailable' USING ERRCODE='23514'; END IF;
  -- This statement must finish before the distinct VOLATILE fresh SELECT below.
  -- The operator's mandatory exclusive xact lock serializes withdrawal with use.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('occ.lifecycle-capabilities-v1:'||owner_id,0));
  -- Recheck membership after any wait. Role writers do not share this lock, so
  -- this is a fresh compatibility observation, not atomic role-revocation fencing.
  marker:=pg_catalog.to_regrole('occ_lifecycle_worker_v1');
  IF marker IS NULL THEN RAISE EXCEPTION 'lifecycle worker capability is unavailable' USING ERRCODE='23514'; END IF;
  IF pg_catalog.pg_has_role(current_user,marker,'USAGE') IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'lifecycle worker capability is unavailable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO capability FROM occ.lifecycle_capabilities WHERE installation_id=owner_id;
  IF NOT FOUND OR capability.schema_version IS DISTINCT FROM 1
    OR capability.protocol IS DISTINCT FROM 'lifecycle-control-v1' OR capability.stage IS DISTINCT FROM 'live'
    OR capability.api_version IS DISTINCT FROM 1 OR capability.worker_version IS DISTINCT FROM 1
    OR capability.maintenance_version IS DISTINCT FROM 1 OR capability.receiving_version IS DISTINCT FROM 1
    OR (OLD.work_schema_version=2 AND capability.runtime_fault_version IS DISTINCT FROM 1) THEN
    RAISE EXCEPTION 'lifecycle consumers are not compatible and live' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION occ.runtime_fault_work_immutable_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $function$
BEGIN
  IF NEW.fault_work IS DISTINCT FROM OLD.fault_work THEN
    RAISE EXCEPTION 'runtime fault work association is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.work_schema_version=2 AND (NEW.state IN ('succeeded','failed_permanent') OR NEW.completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'runtime fault termination completion is unsupported' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER runtime_fault_work_retains_responsibility BEFORE UPDATE ON occ.controller_work
  FOR EACH ROW EXECUTE FUNCTION occ.runtime_fault_work_immutable_v1();

REVOKE ALL ON occ.runtime_effect_gates FROM PUBLIC,occ_app;
GRANT SELECT,INSERT,UPDATE ON occ.runtime_effect_gates TO occ_app;
REVOKE ALL ON FUNCTION occ.require_runtime_effect_gate(),occ.close_runtime_effect_gate_for_intent(),
  occ.runtime_fault_complete_v1(text),occ.runtime_fault_work_immutable_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.runtime_fault_complete_v1(text) TO occ_app;
COMMIT;
