ALTER TABLE occ.agent_runtime_intents
  ADD CONSTRAINT runtime_intents_admission_identity_unique
  UNIQUE (namespace_id, agent_id, revision_id, transition_ref, generation);
--> statement-breakpoint
CREATE TABLE occ.agent_revision_runtime_admissions (
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  revision_id text PRIMARY KEY,
  runtime_transition_ref text NOT NULL UNIQUE,
  lifecycle_generation bigint NOT NULL,
  audit_event_id text NOT NULL UNIQUE REFERENCES occ.audit_events(id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT revision_runtime_admissions_work_identity_unique
    UNIQUE (namespace_id, agent_id, revision_id, runtime_transition_ref, lifecycle_generation),
  CONSTRAINT revision_runtime_admissions_intent_owner
    FOREIGN KEY (namespace_id, agent_id, revision_id, runtime_transition_ref, lifecycle_generation)
    REFERENCES occ.agent_runtime_intents(namespace_id, agent_id, revision_id, transition_ref, generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
ALTER TABLE occ.controller_work
  ADD COLUMN runtime_transition_ref text,
  ADD COLUMN lifecycle_generation bigint,
  ADD CONSTRAINT controller_work_runtime_pair_valid CHECK (
    (runtime_transition_ref IS NULL AND lifecycle_generation IS NULL)
    OR (runtime_transition_ref IS NOT NULL AND lifecycle_generation IS NOT NULL
      AND agent_id IS NOT NULL AND revision_id IS NOT NULL AND namespace_target IS NULL
      AND runtime_transition_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND lifecycle_generation BETWEEN 1 AND 9007199254740991)
  ),
  ADD CONSTRAINT controller_work_runtime_admission_owner
    FOREIGN KEY (namespace_id, agent_id, revision_id, runtime_transition_ref, lifecycle_generation)
    REFERENCES occ.agent_revision_runtime_admissions
      (namespace_id, agent_id, revision_id, runtime_transition_ref, lifecycle_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT;
--> statement-breakpoint
CREATE FUNCTION occ.require_revision_runtime_admission_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  intent occ.agent_runtime_intents%ROWTYPE;
  audit occ.audit_events%ROWTYPE;
  metadata jsonb;
BEGIN
  -- Serialize association creation with work insertion for this immutable owner.
  PERFORM 1 FROM occ.agents
    WHERE namespace_id = NEW.namespace_id AND id = NEW.agent_id FOR UPDATE;
  SELECT * INTO intent FROM occ.agent_runtime_intents
    WHERE namespace_id = NEW.namespace_id AND agent_id = NEW.agent_id
      AND revision_id = NEW.revision_id AND transition_ref = NEW.runtime_transition_ref
      AND generation = NEW.lifecycle_generation;
  IF NOT FOUND OR intent.desired_mode IS DISTINCT FROM 'running' THEN
    RAISE EXCEPTION 'revision admission requires its exact running intent' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO audit FROM occ.audit_events WHERE id = NEW.audit_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revision admission requires its exact success audit' USING ERRCODE = '23514';
  END IF;
  metadata := audit.details->'__occAuditMetadata';
  IF audit.kind IS DISTINCT FROM 'mutation'
    OR audit.outcome IS DISTINCT FROM 'success'
    OR audit.action IS DISTINCT FROM 'openclaw.agents.deploy'
    OR audit.namespace_id IS DISTINCT FROM intent.namespace_id
    OR audit.actor_id IS DISTINCT FROM intent.actor_id
    OR audit.resource_kind IS DISTINCT FROM 'agent_revision'
    OR audit.resource_id IS DISTINCT FROM intent.revision_id
    OR metadata->'requestId' IS DISTINCT FROM to_jsonb(intent.request_id)
    OR (metadata #> '{actor,principalId}' IS NOT NULL
      AND metadata #> '{actor,principalId}' IS DISTINCT FROM to_jsonb(intent.actor_id))
    OR (metadata #> '{actor,id}' IS NOT NULL
      AND metadata #> '{actor,id}' IS DISTINCT FROM to_jsonb(intent.actor_id))
    OR metadata #> '{actor,unresolved}' = 'true'::jsonb
    OR (metadata->'authorization' IS NOT NULL AND (
      metadata #> '{authorization,principalId}' IS DISTINCT FROM to_jsonb(intent.actor_id)
      OR metadata #> '{authorization,action}' IS DISTINCT FROM '"deploy"'::jsonb
      OR metadata #> '{authorization,resource,kind}' IS DISTINCT FROM '"agent"'::jsonb
      OR metadata #> '{authorization,resource,id}' IS DISTINCT FROM to_jsonb(intent.agent_id)
      OR metadata #> '{authorization,resource,namespaceId}' IS DISTINCT FROM to_jsonb(intent.namespace_id)
    )) THEN
    RAISE EXCEPTION 'revision admission audit attribution does not match' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER revision_runtime_admission_requires_audit
BEFORE INSERT ON occ.agent_revision_runtime_admissions
FOR EACH ROW EXECUTE FUNCTION occ.require_revision_runtime_admission_audit();
--> statement-breakpoint
CREATE FUNCTION occ.require_work_runtime_admission() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  admission occ.agent_revision_runtime_admissions%ROWTYPE;
  original_actor text;
BEGIN
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
$$;
--> statement-breakpoint
CREATE TRIGGER controller_work_requires_runtime_admission
BEFORE INSERT ON occ.controller_work
FOR EACH ROW EXECUTE FUNCTION occ.require_work_runtime_admission();
--> statement-breakpoint
CREATE FUNCTION occ.require_admission_original_work() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE original_actor text;
BEGIN
  SELECT actor_id INTO original_actor FROM occ.agent_runtime_intents
    WHERE namespace_id = NEW.namespace_id AND agent_id = NEW.agent_id
      AND revision_id = NEW.revision_id AND transition_ref = NEW.runtime_transition_ref
      AND generation = NEW.lifecycle_generation;
  -- Admission is inserted before work in the canonical unit. Check only at its
  -- commit, and retain this proof regardless of later work state or head changes.
  IF NOT EXISTS (
    SELECT 1 FROM occ.controller_work
    WHERE idempotency_key = 'agent_revision:' || NEW.revision_id || ':reconcile'
      AND namespace_id = NEW.namespace_id AND agent_id = NEW.agent_id
      AND revision_id = NEW.revision_id AND namespace_target IS NULL
      AND runtime_transition_ref = NEW.runtime_transition_ref
      AND lifecycle_generation = NEW.lifecycle_generation AND actor_id = original_actor
  ) OR EXISTS (
    SELECT 1 FROM occ.controller_work
    WHERE namespace_id = NEW.namespace_id AND agent_id = NEW.agent_id AND revision_id = NEW.revision_id
      AND (runtime_transition_ref IS DISTINCT FROM NEW.runtime_transition_ref
        OR lifecycle_generation IS DISTINCT FROM NEW.lifecycle_generation
        OR actor_id IS DISTINCT FROM original_actor)
  ) THEN
    RAISE EXCEPTION 'revision admission requires its original work in the same unit' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER revision_runtime_admission_requires_original_work
AFTER INSERT ON occ.agent_revision_runtime_admissions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION occ.require_admission_original_work();
--> statement-breakpoint
CREATE TRIGGER revision_runtime_admissions_are_immutable
BEFORE UPDATE OR DELETE ON occ.agent_revision_runtime_admissions
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER controller_work_owner_and_identity_are_immutable
BEFORE UPDATE OF idempotency_key, namespace_id, agent_id, revision_id, actor_id, namespace_target
ON occ.controller_work FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER controller_work_runtime_identity_is_immutable
BEFORE UPDATE OF runtime_transition_ref, lifecycle_generation ON occ.controller_work
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER controller_work_cannot_be_deleted
BEFORE DELETE ON occ.controller_work
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
REVOKE ALL ON occ.agent_revision_runtime_admissions FROM PUBLIC, occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.require_revision_runtime_admission_audit(),
  occ.require_work_runtime_admission(), occ.require_admission_original_work() FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.agent_revision_runtime_admissions TO occ_app;
