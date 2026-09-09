-- Original profile invalidation closes the same runtime gate and retains cleanup.
-- No execution admission, provider grant, positive profile backfill or new queue.
BEGIN;
ALTER TABLE occ.runtime_effect_gates
 ADD COLUMN revision_id text GENERATED ALWAYS AS (target->>'revisionId') STORED,
 ADD CONSTRAINT runtime_effect_gates_revision_owner FOREIGN KEY(namespace_id,agent_id,revision_id)
 REFERENCES occ.agent_revisions(namespace_id,agent_id,id) ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX runtime_gate_original_revision ON occ.runtime_effect_gates(namespace_id,agent_id,revision_id);
CREATE INDEX runtime_revision_profile_use ON occ.agent_revisions(namespace_id,(admitted_spec#>>'{workload_profile_use,admissionRef}'))
 WHERE admitted_spec->'workload_profile_use' IS NOT NULL;
ALTER TABLE occ.runtime_cleanup_responsibilities
 ADD COLUMN profile_invalidation_ref text,
 ADD COLUMN profile_prior_guard jsonb,
 ADD COLUMN profile_closed_guard jsonb,
 ADD COLUMN profile_work jsonb,
 DROP CONSTRAINT runtime_cleanup_responsibilities_origin,
 DROP CONSTRAINT runtime_cleanup_responsibilities_intent_owner,
 DROP COLUMN intent_ref;
ALTER TABLE occ.runtime_cleanup_responsibilities
 ADD COLUMN intent_ref text GENERATED ALWAYS AS (CASE origin_kind
 WHEN 'lifecycle-protective-v1' THEN origin_operation_ref
 WHEN 'runtime-fault-v1' THEN fault_request#>>'{guard,intentRef}'
 WHEN 'runtime-profile-v1' THEN profile_prior_guard->>'intentRef' END) STORED,
 ADD CONSTRAINT runtime_cleanup_responsibilities_intent_owner FOREIGN KEY(namespace_id,agent_id,lifecycle_generation,intent_ref)
 REFERENCES occ.agent_runtime_intents(namespace_id,agent_id,generation,transition_ref) ON DELETE RESTRICT ON UPDATE RESTRICT,
 ADD CONSTRAINT runtime_cleanup_profile_invalidation_owner FOREIGN KEY(installation_id,profile_invalidation_ref)
 REFERENCES occ.workload_profile_invalidations(installation_id,invalidation_ref) ON DELETE RESTRICT ON UPDATE RESTRICT;


ALTER TABLE occ.runtime_cleanup_responsibilities ADD CONSTRAINT runtime_cleanup_responsibilities_origin CHECK(
    (origin_operation_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND (((profile_invalidation_ref IS NULL AND profile_prior_guard IS NULL AND profile_closed_guard IS NULL AND profile_work IS NULL) AND ((origin_kind='lifecycle-protective-v1' AND fault_request IS NULL
      AND fault_canonical_request IS NULL AND fault_closed_guard IS NULL AND fault_work IS NULL
      AND fault_audit_id IS NULL AND fault_writer_ref IS NULL)
    OR (origin_kind='runtime-fault-v1' AND responsibility_version=1 AND fault_request IS NOT NULL
      AND fault_canonical_request IS NOT NULL AND fault_closed_guard IS NOT NULL AND fault_work IS NOT NULL
      AND fault_audit_id IS NOT NULL AND fault_writer_ref IS NOT NULL AND kind IN ('protective-fence','retained-stop')
      AND intent_ref IS NOT NULL AND predecessor_ref=intent_ref AND predecessor_generation=lifecycle_generation
      AND octet_length(fault_request::text)<=1048576 AND octet_length(fault_canonical_request)<=1048576
      AND octet_length(fault_work::text)<=4096)))
 OR (origin_kind='runtime-profile-v1' AND responsibility_version=1 AND kind='protective-fence'
 AND profile_invalidation_ref IS NOT NULL AND profile_prior_guard IS NOT NULL AND profile_closed_guard IS NOT NULL AND profile_work IS NOT NULL
 AND fault_request IS NULL AND fault_canonical_request IS NULL AND fault_closed_guard IS NULL AND fault_work IS NULL AND fault_audit_id IS NULL AND fault_writer_ref IS NULL
 AND intent_ref IS NOT NULL AND predecessor_ref=intent_ref AND predecessor_generation=lifecycle_generation
 AND octet_length(profile_prior_guard::text)<=65536 AND octet_length(profile_closed_guard::text)<=65536 AND octet_length(profile_work::text)<=4096))) IS TRUE);

CREATE UNIQUE INDEX runtime_profile_closure_source ON occ.runtime_cleanup_responsibilities(installation_id,namespace_id,agent_id,profile_invalidation_ref) WHERE origin_kind='runtime-profile-v1';
CREATE UNIQUE INDEX runtime_profile_work_unique ON occ.runtime_cleanup_responsibilities((profile_work->>'workId')) WHERE origin_kind='runtime-profile-v1';
ALTER TABLE occ.controller_work ADD COLUMN profile_work jsonb;
ALTER TABLE occ.lifecycle_capabilities ADD COLUMN runtime_profile_version smallint CHECK(runtime_profile_version IS NULL OR runtime_profile_version=1);


ALTER TABLE occ.controller_work
  DROP CONSTRAINT controller_work_runtime_pair_valid,
  DROP CONSTRAINT controller_work_namespace_target_valid,
  ADD CONSTRAINT controller_work_runtime_pair_valid CHECK(
    (work_schema_version=0 AND handler IS NULL AND fault_work IS NULL AND profile_work IS NULL AND (
      (runtime_transition_ref IS NULL AND lifecycle_generation IS NULL)
      OR (runtime_transition_ref IS NOT NULL AND lifecycle_generation IS NOT NULL
        AND agent_id IS NOT NULL AND revision_id IS NOT NULL AND namespace_target IS NULL
        AND runtime_transition_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND lifecycle_generation BETWEEN 1 AND 9007199254740991)))
    OR (work_schema_version IN (1,2,3) AND handler IS NOT NULL
      AND ((work_schema_version=1 AND handler='ReconcileAgentLifecycleV1' AND fault_work IS NULL AND profile_work IS NULL)
        OR (work_schema_version=2 AND handler='ReconcileRuntimeFaultV1' AND fault_work IS NOT NULL AND profile_work IS NULL)
        OR (work_schema_version=3 AND handler='ReconcileRuntimeProfileV1' AND fault_work IS NULL AND profile_work IS NOT NULL))
      AND runtime_transition_ref IS NOT NULL AND lifecycle_generation IS NOT NULL
      AND agent_id IS NOT NULL AND namespace_target IS NULL
      AND runtime_transition_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND lifecycle_generation BETWEEN 1 AND 9007199254740991)),
  ADD CONSTRAINT controller_work_namespace_target_valid CHECK(
    (work_schema_version=0 AND handler IS NULL AND fault_work IS NULL AND profile_work IS NULL AND (
      (agent_id IS NULL AND revision_id IS NULL AND namespace_target IN ('ready','deleted') AND namespace_target IS NOT NULL)
      OR (agent_id IS NOT NULL AND revision_id IS NOT NULL AND namespace_target IS NULL)))
    OR (work_schema_version IN (1,2,3) AND handler IS NOT NULL AND agent_id IS NOT NULL AND namespace_target IS NULL
      AND ((work_schema_version=1 AND handler='ReconcileAgentLifecycleV1' AND fault_work IS NULL AND profile_work IS NULL)
        OR (work_schema_version=2 AND handler='ReconcileRuntimeFaultV1' AND fault_work IS NOT NULL AND profile_work IS NULL)
        OR (work_schema_version=3 AND handler='ReconcileRuntimeProfileV1' AND fault_work IS NULL AND profile_work IS NOT NULL))));

CREATE OR REPLACE FUNCTION occ.require_runtime_effect_gate() RETURNS trigger
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
    WHERE origin_kind='runtime-profile-v1' AND origin_operation_ref=NEW.last_closure_operation_ref
      AND installation_id=NEW.installation_id AND namespace_id=NEW.namespace_id AND agent_id=NEW.agent_id;
  IF FOUND THEN
    IF fault.profile_prior_guard IS DISTINCT FROM OLD.gate_guard OR fault.profile_closed_guard IS DISTINCT FROM NEW.gate_guard
      OR NOT EXISTS(SELECT 1 FROM occ.agent_runtime_intent_heads h WHERE h.namespace_id=NEW.namespace_id AND h.agent_id=NEW.agent_id
        AND h.transition_ref=NEW.gate_guard->>'intentRef' AND to_jsonb(h.generation)=NEW.gate_guard->'lifecycleGeneration') THEN
      RAISE EXCEPTION 'runtime profile closure does not match its exact gate' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
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
    IF NEW.work_schema_version=3 THEN PERFORM occ.runtime_profile_complete_v1(NEW.profile_work->>'operationRef'); RETURN NEW; END IF;
    IF NEW.work_schema_version=2 THEN
      PERFORM occ.runtime_fault_complete_v1(NEW.fault_work->>'operationRef'); RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME='runtime_cleanup_responsibilities' THEN
    IF NEW.origin_kind='runtime-profile-v1' THEN PERFORM occ.runtime_profile_complete_v1(NEW.origin_operation_ref); RETURN NEW; END IF;
    IF NEW.origin_kind='runtime-fault-v1' THEN
      PERFORM occ.runtime_fault_complete_v1(NEW.origin_operation_ref); RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME='runtime_cleanup_responsibility_allocations' THEN
    SELECT * INTO responsibility FROM occ.runtime_cleanup_responsibilities
      WHERE responsibility_ref=NEW.responsibility_ref AND responsibility_version=NEW.responsibility_version;
    IF responsibility.origin_kind='runtime-profile-v1' THEN PERFORM occ.runtime_profile_complete_v1(responsibility.origin_operation_ref); RETURN NEW; END IF;
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
  IF NEW.work_schema_version=3 THEN
    IF NEW.state IS DISTINCT FROM 'queued' OR NEW.attempt_count<>0 OR NEW.claim_token IS NOT NULL
      OR NEW.lease_expires_at IS NOT NULL OR NEW.completed_at IS NOT NULL
      OR NEW.created_at IS DISTINCT FROM NEW.updated_at OR NEW.available_at IS DISTINCT FROM NEW.created_at
      OR NOT isfinite(NEW.created_at) OR NOT EXISTS(
        SELECT 1 FROM occ.runtime_cleanup_responsibilities r
        WHERE r.origin_kind='runtime-profile-v1' AND r.profile_work=NEW.profile_work
          AND r.origin_operation_ref=NEW.profile_work->>'operationRef'
          AND r.profile_work->>'workId'=NEW.idempotency_key
          AND r.namespace_id=NEW.namespace_id AND r.agent_id=NEW.agent_id
          AND r.intent_ref=NEW.runtime_transition_ref AND r.lifecycle_generation=NEW.lifecycle_generation
          AND EXISTS(SELECT 1 FROM occ.workload_profile_admissions p WHERE p.installation_id=r.installation_id
            AND p.admission_ref=r.profile_work->>'admissionRef' AND p.record#>>'{withdrawal,actor,principalRef}'=NEW.actor_id) AND r.created_at=NEW.created_at
          AND EXISTS(SELECT 1 FROM occ.runtime_effect_gates g WHERE g.installation_id=r.installation_id AND g.namespace_id=r.namespace_id AND g.agent_id=r.agent_id AND g.revision_id=NEW.revision_id)) THEN
      RAISE EXCEPTION 'runtime profile work requires its exact pristine association' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
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
  IF OLD.work_schema_version=3 THEN
    SELECT installation_id INTO owner_id FROM occ.runtime_cleanup_responsibilities
      WHERE origin_kind='runtime-profile-v1' AND profile_work=OLD.profile_work AND profile_work->>'workId'=OLD.idempotency_key;
  ELSIF OLD.work_schema_version=2 THEN
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
    OR (OLD.work_schema_version=2 AND capability.runtime_fault_version IS DISTINCT FROM 1)
    OR (OLD.work_schema_version=3 AND capability.runtime_profile_version IS DISTINCT FROM 1) THEN
    RAISE EXCEPTION 'lifecycle consumers are not compatible and live' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION occ.runtime_fault_work_immutable_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $function$
BEGIN
  IF NEW.fault_work IS DISTINCT FROM OLD.fault_work OR NEW.profile_work IS DISTINCT FROM OLD.profile_work THEN
    RAISE EXCEPTION 'runtime fault work association is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.work_schema_version IN (2,3) AND (NEW.state IN ('succeeded','failed_permanent') OR NEW.completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'runtime fault termination completion is unsupported' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$function$;

-- Initialization takes the existing capacity prefix before the profile head and
-- Namespace/Agent. Profile management already owns the exclusive capacity prefix.
CREATE FUNCTION occ.lock_runtime_gate_profile_v1(owner_installation text, owner_namespace text, owner_agent text, owner_revision text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $function$
DECLARE use_record jsonb; profile occ.workload_profile_admissions%ROWTYPE;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
   RAISE EXCEPTION 'runtime profile gate requires READ COMMITTED isolation' USING ERRCODE='23514'; END IF;
 SELECT admitted_spec->'workload_profile_use' INTO use_record FROM occ.agent_revisions
 WHERE namespace_id=owner_namespace AND agent_id=owner_agent AND id=owner_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'runtime gate original revision is unavailable' USING ERRCODE='23514'; END IF;
 IF use_record IS NULL THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('workload-profile-capacity:'||owner_installation,0));
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('workload-profile-head:'||owner_installation||':'||(use_record->>'admissionRef'),0));
 SELECT * INTO profile FROM occ.workload_profile_admissions WHERE installation_id=owner_installation
 AND namespace_id=owner_namespace AND admission_ref=use_record->>'admissionRef' FOR SHARE;
 IF profile.state IS DISTINCT FROM 'admitted' OR to_jsonb(profile.admission_version) IS DISTINCT FROM use_record->'admissionVersion'
 OR profile.manifest_ref IS DISTINCT FROM use_record->>'manifestRef' OR profile.manifest_digest IS DISTINCT FROM use_record->>'manifestDigest'
 OR use_record->>'installationId' IS DISTINCT FROM owner_installation OR use_record->>'namespaceId' IS DISTINCT FROM owner_namespace
 OR profile.record->'profileRefs' IS DISTINCT FROM use_record->'profileRefs' THEN
   RAISE EXCEPTION 'runtime gate original profile is unavailable' USING ERRCODE='23514'; END IF;
END
$function$;
CREATE FUNCTION occ.require_runtime_gate_profile_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $function$
BEGIN
 PERFORM occ.lock_runtime_gate_profile_v1(NEW.installation_id,NEW.namespace_id,NEW.agent_id,NEW.target->>'revisionId');
 RETURN NEW;
END
$function$;
CREATE TRIGGER runtime_effect_gate_00_profile_prefix BEFORE INSERT ON occ.runtime_effect_gates
 FOR EACH ROW EXECUTE FUNCTION occ.require_runtime_gate_profile_v1();

CREATE FUNCTION occ.runtime_profile_complete_v1(operation_ref text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $function$
DECLARE retained occ.runtime_cleanup_responsibilities%ROWTYPE; source occ.workload_profile_invalidations%ROWTYPE;
 profile occ.workload_profile_admissions%ROWTYPE; gate occ.runtime_effect_gates%ROWTYPE; work occ.controller_work%ROWTYPE;
 expected jsonb; use_record jsonb;
BEGIN
 SELECT * INTO retained FROM occ.runtime_cleanup_responsibilities r
 WHERE r.origin_kind='runtime-profile-v1' AND r.origin_operation_ref=operation_ref;
 IF NOT FOUND THEN RAISE EXCEPTION 'runtime profile responsibility is incomplete' USING ERRCODE='23514'; END IF;
 SELECT * INTO source FROM occ.workload_profile_invalidations WHERE installation_id=retained.installation_id
 AND invalidation_ref=retained.profile_invalidation_ref;
 SELECT * INTO profile FROM occ.workload_profile_admissions WHERE installation_id=source.installation_id AND admission_ref=source.admission_ref;
 SELECT * INTO gate FROM occ.runtime_effect_gates WHERE installation_id=retained.installation_id
 AND namespace_id=retained.namespace_id AND agent_id=retained.agent_id;
 SELECT admitted_spec->'workload_profile_use' INTO use_record FROM occ.agent_revisions
 WHERE namespace_id=gate.namespace_id AND agent_id=gate.agent_id AND id=gate.revision_id;
 expected:=retained.profile_prior_guard||jsonb_build_object(
 'gateVersion',(retained.profile_prior_guard->>'gateVersion')::bigint+1,
 'requestedFenceEpoch',(retained.profile_prior_guard->>'requestedFenceEpoch')::bigint+1,
 'responsibility',jsonb_build_object('responsibilityRef',retained.responsibility_ref,'responsibilityVersion',1,'kind','protective-fence'));
 IF source.invalidation_ref IS NULL OR source.namespace_id IS DISTINCT FROM retained.namespace_id
 OR NOT occ.runtime_gate_guard_valid_v1(retained.profile_prior_guard) OR NOT occ.runtime_gate_guard_valid_v1(retained.profile_closed_guard)
 OR retained.profile_prior_guard->'scope' IS DISTINCT FROM jsonb_build_object('installationId',retained.installation_id,'namespaceId',retained.namespace_id,'agentId',retained.agent_id)
 OR retained.profile_prior_guard->'lifecycleGeneration' IS DISTINCT FROM to_jsonb(retained.lifecycle_generation)
 OR retained.profile_prior_guard->'admittedChildCutoff' IS DISTINCT FROM '0'::jsonb
 OR retained.profile_closed_guard IS DISTINCT FROM expected OR retained.profile_closed_guard IS DISTINCT FROM gate.gate_guard
 OR gate.last_closure_operation_ref IS DISTINCT FROM retained.origin_operation_ref
 OR profile.state IS DISTINCT FROM 'withdrawn' OR profile.admission_version IS DISTINCT FROM source.admission_version
 OR profile.record#>>'{terminal,invalidationRef}' IS DISTINCT FROM source.invalidation_ref
 OR use_record->>'installationId' IS DISTINCT FROM source.installation_id OR use_record->>'namespaceId' IS DISTINCT FROM source.namespace_id
 OR use_record->>'admissionRef' IS DISTINCT FROM source.admission_ref OR use_record->'admissionVersion' IS DISTINCT FROM source.record->'previousVersion'
 OR use_record->>'manifestRef' IS DISTINCT FROM source.manifest_ref OR use_record->>'manifestDigest' IS DISTINCT FROM source.manifest_digest
 OR use_record->'profileRefs' IS DISTINCT FROM profile.record->'profileRefs'
 OR retained.created_at IS DISTINCT FROM (source.record->>'acceptedAt')::timestamptz
 OR retained.profile_work IS DISTINCT FROM jsonb_build_object('schemaVersion',3,'handler','ReconcileRuntimeProfileV1',
 'installationId',retained.installation_id,'namespaceId',retained.namespace_id,'agentId',retained.agent_id,
 'intentRef',retained.intent_ref,'lifecycleGeneration',retained.lifecycle_generation,'operationRef',retained.origin_operation_ref,
 'invalidationRef',source.invalidation_ref,'admissionRef',source.admission_ref,'previousVersion',1,'currentVersion',2,
 'responsibilityRef',retained.responsibility_ref,'responsibilityVersion',1,'requestedFenceEpoch',expected->'requestedFenceEpoch',
 'gateVersion',expected->'gateVersion','workId','runtime-profile:'||retained.origin_operation_ref) THEN
   RAISE EXCEPTION 'runtime profile exact source correspondence is invalid' USING ERRCODE='23514'; END IF;
 SELECT * INTO work FROM occ.controller_work WHERE idempotency_key=retained.profile_work->>'workId';
 IF work.idempotency_key IS NULL OR work.work_schema_version<>3 OR work.handler IS DISTINCT FROM 'ReconcileRuntimeProfileV1'
 OR work.profile_work IS DISTINCT FROM retained.profile_work OR work.namespace_id IS DISTINCT FROM retained.namespace_id
 OR work.agent_id IS DISTINCT FROM retained.agent_id OR work.revision_id IS DISTINCT FROM gate.revision_id
 OR work.runtime_transition_ref IS DISTINCT FROM retained.intent_ref OR work.lifecycle_generation IS DISTINCT FROM retained.lifecycle_generation
 OR work.actor_id IS DISTINCT FROM profile.record#>>'{withdrawal,actor,principalRef}' OR work.created_at IS DISTINCT FROM retained.created_at THEN
   RAISE EXCEPTION 'runtime profile work association is incomplete' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM occ.runtime_assignment_allocations a WHERE a.installation_id=retained.installation_id
 AND a.namespace_id=retained.namespace_id AND a.agent_id=retained.agent_id AND a.lifecycle_generation<=retained.lifecycle_generation
 AND NOT EXISTS(SELECT 1 FROM occ.runtime_cleanup_responsibility_allocations m WHERE m.responsibility_ref=retained.responsibility_ref
 AND m.responsibility_version=1 AND m.assignment_ref=a.assignment_ref)) THEN
   RAISE EXCEPTION 'runtime profile allocation membership is incomplete' USING ERRCODE='23514'; END IF;
END
$function$;

CREATE FUNCTION occ.close_runtime_gates_for_profile_v1(owner_installation text, invalidation text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $function$
DECLARE source occ.workload_profile_invalidations%ROWTYPE; profile occ.workload_profile_admissions%ROWTYPE;
 gate occ.runtime_effect_gates%ROWTYPE; selected_agent text; operation_ref text; responsibility_ref text;
 next_guard jsonb; work jsonb; recorded_at timestamptz;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
   RAISE EXCEPTION 'runtime profile closure requires READ COMMITTED isolation' USING ERRCODE='23514'; END IF;
 -- Same original capacity prefix for live insertion, exact replay and upgrade.
 PERFORM pg_advisory_xact_lock(hashtextextended('workload-profile-capacity:'||owner_installation,0));
 SELECT * INTO source FROM occ.workload_profile_invalidations
 WHERE installation_id=owner_installation AND invalidation_ref=invalidation;
 IF NOT FOUND THEN RAISE EXCEPTION 'original profile invalidation is unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO profile FROM occ.workload_profile_admissions
 WHERE installation_id=source.installation_id AND admission_ref=source.admission_ref;
 IF profile.state IS DISTINCT FROM 'withdrawn' OR profile.admission_version IS DISTINCT FROM source.admission_version
 OR profile.record#>>'{terminal,invalidationRef}' IS DISTINCT FROM source.invalidation_ref THEN
   RAISE EXCEPTION 'original profile withdrawal differs' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM occ.namespaces WHERE id=source.namespace_id FOR UPDATE;
 -- Original immutable revision/profile association bounds the affected set.
 FOR selected_agent IN SELECT g.agent_id FROM occ.agent_revisions r
 JOIN occ.runtime_effect_gates g ON g.namespace_id=r.namespace_id AND g.agent_id=r.agent_id AND g.revision_id=r.id
 WHERE r.namespace_id=source.namespace_id AND g.installation_id=source.installation_id
 AND r.admitted_spec#>>'{workload_profile_use,admissionRef}'=source.admission_ref
 AND r.admitted_spec#>'{workload_profile_use,admissionVersion}'=source.record->'previousVersion'
 AND r.admitted_spec#>>'{workload_profile_use,installationId}'=source.installation_id
 AND r.admitted_spec#>>'{workload_profile_use,namespaceId}'=source.namespace_id
 AND r.admitted_spec#>>'{workload_profile_use,manifestRef}'=source.manifest_ref
 AND r.admitted_spec#>>'{workload_profile_use,manifestDigest}'=source.manifest_digest
 AND r.admitted_spec#>'{workload_profile_use,profileRefs}'=profile.record->'profileRefs'
 ORDER BY g.agent_id LOOP
   PERFORM 1 FROM occ.agents WHERE namespace_id=source.namespace_id AND id=selected_agent FOR UPDATE;
   SELECT * INTO gate FROM occ.runtime_effect_gates WHERE installation_id=source.installation_id
   AND namespace_id=source.namespace_id AND agent_id=selected_agent FOR UPDATE;
   IF EXISTS(SELECT 1 FROM occ.runtime_cleanup_responsibilities r WHERE r.origin_kind='runtime-profile-v1'
    AND r.installation_id=source.installation_id AND r.namespace_id=source.namespace_id AND r.agent_id=selected_agent
    AND r.profile_invalidation_ref=source.invalidation_ref) THEN CONTINUE; END IF;
   operation_ref:=gen_random_uuid()::text; responsibility_ref:=gen_random_uuid()::text;
   recorded_at:=(source.record->>'acceptedAt')::timestamptz;
   next_guard:=gate.gate_guard||jsonb_build_object('gateVersion',(gate.gate_guard->>'gateVersion')::bigint+1,
    'requestedFenceEpoch',(gate.gate_guard->>'requestedFenceEpoch')::bigint+1,
    'responsibility',jsonb_build_object('responsibilityRef',responsibility_ref,'responsibilityVersion',1,'kind','protective-fence'));
   work:=jsonb_build_object('schemaVersion',3,'handler','ReconcileRuntimeProfileV1',
    'installationId',source.installation_id,'namespaceId',source.namespace_id,'agentId',selected_agent,
    'intentRef',gate.gate_guard->>'intentRef','lifecycleGeneration',gate.gate_guard->'lifecycleGeneration',
    'operationRef',operation_ref,'invalidationRef',source.invalidation_ref,'admissionRef',source.admission_ref,
    'previousVersion',1,'currentVersion',2,'responsibilityRef',responsibility_ref,'responsibilityVersion',1,
    'requestedFenceEpoch',next_guard->'requestedFenceEpoch','gateVersion',next_guard->'gateVersion','workId','runtime-profile:'||operation_ref);
   INSERT INTO occ.runtime_cleanup_responsibilities(responsibility_ref,responsibility_version,origin_kind,origin_operation_ref,
    installation_id,namespace_id,agent_id,lifecycle_generation,kind,predecessor_ref,predecessor_generation,inventory_status,created_at,
    profile_invalidation_ref,profile_prior_guard,profile_closed_guard,profile_work)
   VALUES(responsibility_ref,1,'runtime-profile-v1',operation_ref,source.installation_id,source.namespace_id,selected_agent,
    (gate.gate_guard->>'lifecycleGeneration')::bigint,'protective-fence',gate.gate_guard->>'intentRef',
    (gate.gate_guard->>'lifecycleGeneration')::bigint,'unresolved',recorded_at,source.invalidation_ref,gate.gate_guard,next_guard,work);
   INSERT INTO occ.runtime_cleanup_responsibility_allocations(responsibility_ref,responsibility_version,installation_id,namespace_id,agent_id,assignment_ref)
    SELECT responsibility_ref,1,a.installation_id,a.namespace_id,a.agent_id,a.assignment_ref FROM occ.runtime_assignment_allocations a
    WHERE a.installation_id=source.installation_id AND a.namespace_id=source.namespace_id AND a.agent_id=selected_agent
     AND a.lifecycle_generation<=(gate.gate_guard->>'lifecycleGeneration')::bigint;
   UPDATE occ.runtime_effect_gates SET gate_guard=next_guard,last_closure_operation_ref=operation_ref
    WHERE installation_id=source.installation_id AND namespace_id=source.namespace_id AND agent_id=selected_agent;
   INSERT INTO occ.controller_work(idempotency_key,namespace_id,agent_id,revision_id,actor_id,runtime_transition_ref,lifecycle_generation,
    work_schema_version,handler,profile_work,state,available_at,attempt_count,created_at,updated_at)
   VALUES(work->>'workId',source.namespace_id,selected_agent,gate.revision_id,profile.record#>>'{withdrawal,actor,principalRef}',
    gate.gate_guard->>'intentRef',(gate.gate_guard->>'lifecycleGeneration')::bigint,3,'ReconcileRuntimeProfileV1',work,'queued',recorded_at,0,recorded_at,recorded_at);
 END LOOP;
END
$function$;
CREATE FUNCTION occ.runtime_profile_invalidation_closes_gates_v1() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $function$
BEGIN
 PERFORM occ.close_runtime_gates_for_profile_v1(NEW.installation_id,NEW.invalidation_ref);
 RETURN NEW;
END
$function$;
CREATE TRIGGER runtime_profile_invalidation_closes_gates AFTER INSERT ON occ.workload_profile_invalidations
 FOR EACH ROW EXECUTE FUNCTION occ.runtime_profile_invalidation_closes_gates_v1();

-- Negative catch-up only: source records and admitted revisions remain unchanged.
-- The same source locator makes replay a no-op after later lifecycle closure.
DO $upgrade$
DECLARE source record;
BEGIN
 FOR source IN SELECT i.installation_id,i.invalidation_ref FROM occ.workload_profile_invalidations i
 WHERE EXISTS(SELECT 1 FROM occ.agent_revisions r JOIN occ.runtime_effect_gates g
   ON g.namespace_id=r.namespace_id AND g.agent_id=r.agent_id AND g.revision_id=r.id
   WHERE r.namespace_id=i.namespace_id AND g.installation_id=i.installation_id
     AND r.admitted_spec#>>'{workload_profile_use,admissionRef}'=i.admission_ref
     AND r.admitted_spec#>'{workload_profile_use,admissionVersion}'=i.record->'previousVersion'
     AND r.admitted_spec#>>'{workload_profile_use,manifestRef}'=i.manifest_ref
     AND r.admitted_spec#>>'{workload_profile_use,manifestDigest}'=i.manifest_digest)
 ORDER BY i.installation_id,i.namespace_id,i.admission_ref,i.invalidation_ref LOOP
   PERFORM occ.close_runtime_gates_for_profile_v1(source.installation_id,source.invalidation_ref);
 END LOOP;
END
$upgrade$;
REVOKE ALL ON FUNCTION occ.lock_runtime_gate_profile_v1(text,text,text,text),occ.require_runtime_gate_profile_v1(),
 occ.runtime_profile_complete_v1(text),occ.close_runtime_gates_for_profile_v1(text,text),occ.runtime_profile_invalidation_closes_gates_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.lock_runtime_gate_profile_v1(text,text,text,text),occ.runtime_profile_complete_v1(text),
 occ.close_runtime_gates_for_profile_v1(text,text) TO occ_app;
COMMIT;
