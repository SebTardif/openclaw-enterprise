ALTER TABLE occ.agent_runtime_intents
  ADD COLUMN "admission_version" smallint NOT NULL DEFAULT 0,
  ALTER COLUMN revision_id DROP NOT NULL,
  ADD CONSTRAINT "runtime_intents_admission_version_valid" CHECK (("admission_version" = 0 AND "revision_id" IS NOT NULL)
        OR ("admission_version" = 1 AND "desired_mode" IN ('disabled', 'stopped')));
--> statement-breakpoint
ALTER TABLE occ.controller_work
  ADD COLUMN "work_schema_version" smallint NOT NULL DEFAULT 0,
  ADD COLUMN "handler" text,
  ADD COLUMN "legacy_runtime_transition_ref" text GENERATED ALWAYS AS (CASE WHEN work_schema_version = 0 THEN runtime_transition_ref ELSE NULL END) STORED,
  ADD COLUMN "lifecycle_operation_ref" text GENERATED ALWAYS AS (CASE WHEN work_schema_version = 1 THEN runtime_transition_ref ELSE NULL END) STORED;
--> statement-breakpoint
CREATE TABLE occ."agent_lifecycle_admissions" (
  "operation_ref" text PRIMARY KEY,
  "installation_id" text NOT NULL,
  "namespace_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "lifecycle_generation" bigint NOT NULL,
  "kind" text NOT NULL,
  "expected_generation" bigint,
  "canonical_request" jsonb NOT NULL,
  "audit_event_id" text NOT NULL,
  "work_id" text NOT NULL,
  "responsibility_ref" text NOT NULL,
  "responsibility_version" bigint NOT NULL,
  CONSTRAINT "lifecycle_admissions_intent_identity_unique" UNIQUE ("namespace_id", "agent_id", "lifecycle_generation", "operation_ref"),
  CONSTRAINT "lifecycle_admissions_audit_unique" UNIQUE ("audit_event_id"),
  CONSTRAINT "lifecycle_admissions_work_unique" UNIQUE ("work_id"),
  CONSTRAINT "lifecycle_admissions_responsibility_unique" UNIQUE ("responsibility_ref", "responsibility_version"),
  CONSTRAINT "lifecycle_admissions_intent_owner" FOREIGN KEY ("namespace_id", "agent_id", "lifecycle_generation", "operation_ref") REFERENCES occ."agent_runtime_intents" ("namespace_id", "agent_id", "generation", "transition_ref") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "lifecycle_admissions_installation_owner" FOREIGN KEY ("installation_id") REFERENCES occ."installation" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "lifecycle_admissions_audit_owner" FOREIGN KEY ("audit_event_id") REFERENCES occ."audit_events" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "lifecycle_admissions_operation_ref" CHECK ("operation_ref" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "lifecycle_admissions_generation" CHECK ("lifecycle_generation" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "lifecycle_admissions_kind" CHECK ("kind" IN ('disable', 'stop')),
  CONSTRAINT "lifecycle_admissions_expected_generation" CHECK ("expected_generation" IS NULL OR "expected_generation" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "lifecycle_admissions_request" CHECK (("canonical_request" = jsonb_build_object(
          'schemaVersion', 1,
          'kind', "kind",
          'namespaceId', "namespace_id",
          'agentId', "agent_id",
          'expectedLifecycleGeneration', "expected_generation")
          AND octet_length("canonical_request"::text) BETWEEN 1 AND 65536
        ) IS TRUE),
  CONSTRAINT "lifecycle_admissions_work_id" CHECK (char_length("work_id") BETWEEN 1 AND 512
          AND btrim("work_id", U&'\0009\000a\000b\000c\000d\0020\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff') = "work_id"
          AND "work_id" !~ ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || ']')),
  CONSTRAINT "lifecycle_admissions_responsibility_ref" CHECK ("responsibility_ref" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "lifecycle_admissions_responsibility_version" CHECK ("responsibility_version" = 1)
);
--> statement-breakpoint
CREATE TABLE occ."runtime_cleanup_responsibilities" (
  "responsibility_ref" text NOT NULL,
  "responsibility_version" bigint NOT NULL,
  "origin_kind" text NOT NULL,
  "origin_operation_ref" text NOT NULL,
  "installation_id" text NOT NULL,
  "namespace_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "lifecycle_generation" bigint NOT NULL,
  "kind" text NOT NULL,
  "predecessor_ref" text,
  "predecessor_generation" bigint,
  "inventory_status" text NOT NULL DEFAULT 'unresolved',
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "runtime_cleanup_responsibilities_pk" PRIMARY KEY ("responsibility_ref", "responsibility_version"),
  CONSTRAINT "runtime_cleanup_responsibilities_origin_unique" UNIQUE ("origin_kind", "origin_operation_ref", "responsibility_version"),
  CONSTRAINT "runtime_cleanup_responsibilities_owner_unique" UNIQUE ("installation_id", "namespace_id", "agent_id", "responsibility_ref", "responsibility_version"),
  CONSTRAINT "runtime_cleanup_responsibilities_intent_owner" FOREIGN KEY ("namespace_id", "agent_id", "lifecycle_generation", "origin_operation_ref") REFERENCES occ."agent_runtime_intents" ("namespace_id", "agent_id", "generation", "transition_ref") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "runtime_cleanup_responsibilities_predecessor_owner" FOREIGN KEY ("namespace_id", "agent_id", "predecessor_generation", "predecessor_ref") REFERENCES occ."agent_runtime_intents" ("namespace_id", "agent_id", "generation", "transition_ref") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "runtime_cleanup_responsibilities_installation_owner" FOREIGN KEY ("installation_id") REFERENCES occ."installation" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "runtime_cleanup_responsibilities_ref" CHECK ("responsibility_ref" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "runtime_cleanup_responsibilities_version" CHECK ("responsibility_version" = 1),
  CONSTRAINT "runtime_cleanup_responsibilities_origin" CHECK ("origin_kind" = 'lifecycle-protective-v1' AND "origin_operation_ref" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "runtime_cleanup_responsibilities_generation" CHECK ("lifecycle_generation" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "runtime_cleanup_responsibilities_kind" CHECK ("kind" IN ('protective-fence', 'retained-stop')),
  CONSTRAINT "runtime_cleanup_responsibilities_predecessor" CHECK ((("predecessor_ref" IS NULL AND "predecessor_generation" IS NULL)
          OR ("predecessor_ref" IS NOT NULL AND "predecessor_generation" IS NOT NULL
            AND "predecessor_ref" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            AND "predecessor_generation" BETWEEN 1 AND 9007199254740991)) IS TRUE),
  CONSTRAINT "runtime_cleanup_responsibilities_inventory" CHECK ("inventory_status" = 'unresolved'),
  CONSTRAINT "runtime_cleanup_responsibilities_created_at" CHECK (isfinite("created_at"))
);
--> statement-breakpoint
CREATE TABLE occ."runtime_cleanup_responsibility_allocations" (
  "responsibility_ref" text NOT NULL,
  "responsibility_version" bigint NOT NULL,
  "installation_id" text NOT NULL,
  "namespace_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "assignment_ref" text NOT NULL,
  CONSTRAINT "runtime_cleanup_responsibility_allocations_pk" PRIMARY KEY ("responsibility_ref", "responsibility_version", "assignment_ref"),
  CONSTRAINT "runtime_cleanup_allocations_responsibility_owner" FOREIGN KEY ("installation_id", "namespace_id", "agent_id", "responsibility_ref", "responsibility_version") REFERENCES occ."runtime_cleanup_responsibilities" ("installation_id", "namespace_id", "agent_id", "responsibility_ref", "responsibility_version") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "runtime_cleanup_allocations_assignment_owner" FOREIGN KEY ("installation_id", "namespace_id", "agent_id", "assignment_ref") REFERENCES occ."runtime_assignment_allocations" ("installation_id", "namespace_id", "agent_id", "assignment_ref") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "runtime_cleanup_allocations_references" CHECK ("responsibility_ref" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND "assignment_ref" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "runtime_cleanup_allocations_version" CHECK ("responsibility_version" = 1)
);
--> statement-breakpoint
CREATE TABLE occ."audit_export_outbox" (
  "audit_event_id" text PRIMARY KEY,
  "installation_id" text NOT NULL,
  "namespace_id" text NOT NULL,
  "origin_kind" text NOT NULL,
  "origin_operation_ref" text NOT NULL,
  "state" text NOT NULL DEFAULT 'pending',
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "audit_export_outbox_origin_unique" UNIQUE ("origin_kind", "origin_operation_ref"),
  CONSTRAINT "audit_export_outbox_audit_owner" FOREIGN KEY ("audit_event_id") REFERENCES occ."audit_events" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "audit_export_outbox_installation_owner" FOREIGN KEY ("installation_id") REFERENCES occ."installation" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "audit_export_outbox_intent_owner" FOREIGN KEY ("origin_operation_ref") REFERENCES occ."agent_runtime_intents" ("transition_ref") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "audit_export_outbox_origin" CHECK ("origin_kind" = 'lifecycle-protective-v1' AND "origin_operation_ref" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT "audit_export_outbox_state" CHECK ("state" = 'pending'),
  CONSTRAINT "audit_export_outbox_created_at" CHECK (isfinite("created_at"))
);
--> statement-breakpoint
CREATE TABLE occ."lifecycle_capabilities" (
  "installation_id" text PRIMARY KEY,
  "schema_version" smallint NOT NULL DEFAULT 1,
  "protocol" text NOT NULL DEFAULT 'lifecycle-control-v1',
  "stage" text NOT NULL DEFAULT 'legacy',
  "capability_version" bigint NOT NULL DEFAULT 1,
  "api_version" smallint,
  "worker_version" smallint,
  "maintenance_version" smallint,
  "receiving_version" smallint,
  CONSTRAINT "lifecycle_capabilities_installation_owner" FOREIGN KEY ("installation_id") REFERENCES occ."installation" ("id") ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT "lifecycle_capabilities_schema_version" CHECK ("schema_version" = 1),
  CONSTRAINT "lifecycle_capabilities_protocol" CHECK ("protocol" = 'lifecycle-control-v1'),
  CONSTRAINT "lifecycle_capabilities_stage" CHECK ("stage" IN ('legacy', 'drain', 'live')),
  CONSTRAINT "lifecycle_capabilities_version" CHECK ("capability_version" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "lifecycle_capabilities_consumer_versions" CHECK (("api_version" IS NULL OR "api_version" = 1)
          AND ("worker_version" IS NULL OR "worker_version" = 1)
          AND ("maintenance_version" IS NULL OR "maintenance_version" = 1)
          AND ("receiving_version" IS NULL OR "receiving_version" = 1)),
  CONSTRAINT "lifecycle_capabilities_stage_consumers" CHECK ((("stage" = 'legacy'
          OR ("api_version" = 1 AND "worker_version" = 1 AND "receiving_version" = 1))
          AND ("stage" <> 'live' OR "maintenance_version" = 1)) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE occ."agent_lifecycle_admissions" ADD CONSTRAINT "lifecycle_admissions_work_owner" FOREIGN KEY ("work_id") REFERENCES occ."controller_work" ("idempotency_key") ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE occ."agent_lifecycle_admissions" ADD CONSTRAINT "lifecycle_admissions_responsibility_owner" FOREIGN KEY ("responsibility_ref", "responsibility_version") REFERENCES occ."runtime_cleanup_responsibilities" ("responsibility_ref", "responsibility_version") ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE occ."agent_lifecycle_admissions" ADD CONSTRAINT "lifecycle_admissions_export_owner" FOREIGN KEY ("audit_event_id") REFERENCES occ."audit_export_outbox" ("audit_event_id") ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE occ."runtime_cleanup_responsibilities" ADD CONSTRAINT "runtime_cleanup_responsibilities_admission_owner" FOREIGN KEY ("origin_operation_ref") REFERENCES occ."agent_lifecycle_admissions" ("operation_ref") ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE occ.controller_work
  DROP CONSTRAINT controller_work_runtime_pair_valid,
  DROP CONSTRAINT controller_work_namespace_target_valid,
  DROP CONSTRAINT controller_work_runtime_admission_owner,
  ADD CONSTRAINT "controller_work_runtime_admission_owner" FOREIGN KEY ("namespace_id", "agent_id", "revision_id", "legacy_runtime_transition_ref", "lifecycle_generation") REFERENCES occ."agent_revision_runtime_admissions" ("namespace_id", "agent_id", "revision_id", "runtime_transition_ref", "lifecycle_generation") ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "controller_work_lifecycle_admission_owner" FOREIGN KEY ("namespace_id", "agent_id", "lifecycle_generation", "lifecycle_operation_ref") REFERENCES occ."agent_lifecycle_admissions" ("namespace_id", "agent_id", "lifecycle_generation", "operation_ref") ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD CONSTRAINT "controller_work_runtime_pair_valid" CHECK (("work_schema_version" = 0 AND "handler" IS NULL AND (
          ("runtime_transition_ref" IS NULL AND "lifecycle_generation" IS NULL)
          OR ("runtime_transition_ref" IS NOT NULL AND "lifecycle_generation" IS NOT NULL
            AND "agent_id" IS NOT NULL AND "revision_id" IS NOT NULL
            AND "namespace_target" IS NULL
            AND "runtime_transition_ref" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            AND "lifecycle_generation" BETWEEN 1 AND 9007199254740991)))
        OR ("work_schema_version" = 1 AND "handler" IS NOT NULL
          AND "handler" = 'ReconcileAgentLifecycleV1'
          AND "runtime_transition_ref" IS NOT NULL AND "lifecycle_generation" IS NOT NULL
          AND "agent_id" IS NOT NULL
          AND "namespace_target" IS NULL
          AND "runtime_transition_ref" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND "lifecycle_generation" BETWEEN 1 AND 9007199254740991)),
  ADD CONSTRAINT "controller_work_namespace_target_valid" CHECK (("work_schema_version" = 0 AND "handler" IS NULL AND (
          ("agent_id" IS NULL AND "revision_id" IS NULL
            AND "namespace_target" IS NOT NULL
            AND "namespace_target" IN ('ready', 'deleted'))
          OR ("agent_id" IS NOT NULL AND "revision_id" IS NOT NULL
            AND "namespace_target" IS NULL)))
        OR ("work_schema_version" = 1 AND "handler" IS NOT NULL
          AND "handler" = 'ReconcileAgentLifecycleV1'
          AND "agent_id" IS NOT NULL AND "namespace_target" IS NULL));
--> statement-breakpoint
CREATE FUNCTION occ.require_lifecycle_intent_lineage() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE previous occ.agent_runtime_intents%ROWTYPE;
BEGIN
  -- All old and new intent writers share the original Namespace, then Agent lock.
  PERFORM 1 FROM occ.namespaces WHERE id=NEW.namespace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle Namespace is unavailable' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM occ.agents WHERE namespace_id=NEW.namespace_id AND id=NEW.agent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lifecycle Agent is unavailable' USING ERRCODE='23514'; END IF;
  SELECT i.* INTO previous FROM occ.agent_runtime_intent_heads h
    JOIN occ.agent_runtime_intents i ON i.transition_ref=h.transition_ref
    WHERE h.namespace_id=NEW.namespace_id AND h.agent_id=NEW.agent_id;
  IF NEW.admission_version=0 THEN
    IF previous.admission_version=1 THEN
      RAISE EXCEPTION 'legacy intent cannot supersede protective intent' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF previous.transition_ref IS NULL THEN
    IF NEW.generation<>1 OR NEW.revision_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM occ.agent_runtime_intents WHERE namespace_id=NEW.namespace_id AND agent_id=NEW.agent_id
    ) OR EXISTS (
      SELECT 1 FROM occ.runtime_assignment_allocations WHERE namespace_id=NEW.namespace_id AND agent_id=NEW.agent_id
    ) THEN
      RAISE EXCEPTION 'first protective intent requires unselected original lineage' USING ERRCODE='23514';
    END IF;
  ELSIF previous.installation_id IS DISTINCT FROM NEW.installation_id
    OR NEW.generation IS DISTINCT FROM previous.generation+1
    OR NEW.revision_id IS DISTINCT FROM previous.revision_id
    OR previous.desired_mode=NEW.desired_mode OR previous.desired_mode='stopped' THEN
    RAISE EXCEPTION 'protective intent does not preserve its original predecessor' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER runtime_intent_requires_lifecycle_lineage
BEFORE INSERT ON occ.agent_runtime_intents
FOR EACH ROW EXECUTE FUNCTION occ.require_lifecycle_intent_lineage();
--> statement-breakpoint
CREATE FUNCTION occ.require_lifecycle_head_lineage() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE old_version smallint; new_version smallint;
BEGIN
  IF TG_OP='UPDATE' THEN
    SELECT admission_version INTO old_version FROM occ.agent_runtime_intents WHERE transition_ref=OLD.transition_ref;
    SELECT admission_version INTO new_version FROM occ.agent_runtime_intents WHERE transition_ref=NEW.transition_ref;
    -- A legacy row retained before protective admission cannot later bypass the
    -- intent INSERT guard by advancing only its head.
    IF old_version=1 AND new_version IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'legacy head cannot supersede protective intent' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER runtime_head_requires_lifecycle_lineage
BEFORE UPDATE ON occ.agent_runtime_intent_heads
FOR EACH ROW EXECUTE FUNCTION occ.require_lifecycle_head_lineage();
--> statement-breakpoint
CREATE FUNCTION occ.require_cleanup_membership_owner() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE
  responsibility occ.runtime_cleanup_responsibilities%ROWTYPE;
  allocation occ.runtime_assignment_allocations%ROWTYPE;
BEGIN
  SELECT * INTO responsibility FROM occ.runtime_cleanup_responsibilities
    WHERE responsibility_ref=NEW.responsibility_ref AND responsibility_version=NEW.responsibility_version;
  SELECT * INTO allocation FROM occ.runtime_assignment_allocations WHERE assignment_ref=NEW.assignment_ref;
  IF responsibility.predecessor_generation IS NULL OR allocation.assignment_ref IS NULL
    OR allocation.lifecycle_generation>responsibility.predecessor_generation
    OR allocation.installation_id IS DISTINCT FROM NEW.installation_id
    OR allocation.namespace_id IS DISTINCT FROM NEW.namespace_id
    OR allocation.agent_id IS DISTINCT FROM NEW.agent_id THEN
    RAISE EXCEPTION 'cleanup membership requires exact retained allocation lineage' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cleanup_membership_requires_original_owner
BEFORE INSERT ON occ.runtime_cleanup_responsibility_allocations
FOR EACH ROW EXECUTE FUNCTION occ.require_cleanup_membership_owner();
--> statement-breakpoint
CREATE FUNCTION occ.require_lifecycle_admission_complete() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
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
    OR intent.desired_mode IS DISTINCT FROM CASE admission.kind WHEN 'disable' THEN 'disabled' ELSE 'stopped' END
    OR admission.work_id=original_ref
    OR admission.expected_generation IS DISTINCT FROM CASE WHEN intent.generation=1 THEN NULL ELSE intent.generation-1 END
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
    OR responsibility.kind IS DISTINCT FROM CASE admission.kind WHEN 'disable' THEN 'protective-fence' ELSE 'retained-stop' END
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
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.require_work_runtime_admission() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  admission occ.agent_revision_runtime_admissions%ROWTYPE;
  original_actor text;
BEGIN
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
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.require_admission_original_work() RETURNS trigger
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
    WHERE work_schema_version=0 AND idempotency_key = 'agent_revision:' || NEW.revision_id || ':reconcile'
      AND namespace_id = NEW.namespace_id AND agent_id = NEW.agent_id
      AND revision_id = NEW.revision_id AND namespace_target IS NULL
      AND runtime_transition_ref = NEW.runtime_transition_ref
      AND lifecycle_generation = NEW.lifecycle_generation AND actor_id = original_actor
  ) OR EXISTS (
    SELECT 1 FROM occ.controller_work
    WHERE work_schema_version=0 AND namespace_id = NEW.namespace_id AND agent_id = NEW.agent_id AND revision_id = NEW.revision_id
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
CREATE FUNCTION occ.lock_lifecycle_capability_write() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE owner_id text;
BEGIN
  IF TG_OP='DELETE' THEN owner_id:=OLD.installation_id; ELSE owner_id:=NEW.installation_id; END IF;
  IF TG_OP='UPDATE' AND (NEW.installation_id IS DISTINCT FROM OLD.installation_id
    OR NEW.schema_version IS DISTINCT FROM OLD.schema_version OR NEW.protocol IS DISTINCT FROM OLD.protocol
    OR NEW.capability_version<=OLD.capability_version) THEN
    RAISE EXCEPTION 'capability updates must preserve identity and advance version' USING ERRCODE='23514';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('occ.lifecycle-capabilities-v1:'||owner_id,0));
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER lifecycle_capability_writes_are_serialized
BEFORE INSERT OR UPDATE OR DELETE ON occ.lifecycle_capabilities
FOR EACH ROW EXECUTE FUNCTION occ.lock_lifecycle_capability_write();
--> statement-breakpoint
CREATE FUNCTION occ.require_lifecycle_work_capability() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
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
  SELECT installation_id INTO owner_id FROM occ.agent_lifecycle_admissions WHERE operation_ref=OLD.runtime_transition_ref;
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
    OR capability.maintenance_version IS DISTINCT FROM 1 OR capability.receiving_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'lifecycle consumers are not compatible and live' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER controller_work_requires_lifecycle_capability
BEFORE UPDATE ON occ.controller_work
FOR EACH ROW EXECUTE FUNCTION occ.require_lifecycle_work_capability();
--> statement-breakpoint
CREATE TRIGGER controller_work_protocol_is_immutable
BEFORE UPDATE OF work_schema_version,handler ON occ.controller_work
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER lifecycle_complete_agent_runtime_intents
AFTER INSERT ON occ.agent_runtime_intents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION occ.require_lifecycle_admission_complete();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER lifecycle_complete_agent_lifecycle_admissions
AFTER INSERT ON occ.agent_lifecycle_admissions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION occ.require_lifecycle_admission_complete();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER lifecycle_complete_controller_work
AFTER INSERT ON occ.controller_work
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION occ.require_lifecycle_admission_complete();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER lifecycle_complete_runtime_cleanup_responsibilities
AFTER INSERT ON occ.runtime_cleanup_responsibilities
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION occ.require_lifecycle_admission_complete();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER lifecycle_complete_runtime_cleanup_responsibility_allocations
AFTER INSERT ON occ.runtime_cleanup_responsibility_allocations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION occ.require_lifecycle_admission_complete();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER lifecycle_complete_audit_export_outbox
AFTER INSERT ON occ.audit_export_outbox
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION occ.require_lifecycle_admission_complete();
--> statement-breakpoint
CREATE TRIGGER agent_lifecycle_admissions_are_immutable
BEFORE UPDATE OR DELETE ON occ.agent_lifecycle_admissions
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER runtime_cleanup_responsibilities_are_immutable
BEFORE UPDATE OR DELETE ON occ.runtime_cleanup_responsibilities
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER runtime_cleanup_responsibility_allocations_are_immutable
BEFORE UPDATE OR DELETE ON occ.runtime_cleanup_responsibility_allocations
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_export_outbox_are_immutable
BEFORE UPDATE OR DELETE ON occ.audit_export_outbox
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
REVOKE ALL ON occ.agent_lifecycle_admissions,occ.runtime_cleanup_responsibilities,
  occ.runtime_cleanup_responsibility_allocations,occ.audit_export_outbox,occ.lifecycle_capabilities FROM PUBLIC,occ_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON occ.agent_lifecycle_admissions,occ.runtime_cleanup_responsibilities,
  occ.runtime_cleanup_responsibility_allocations,occ.audit_export_outbox TO occ_app;
--> statement-breakpoint
GRANT SELECT ON occ.lifecycle_capabilities TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.require_lifecycle_intent_lineage(),occ.require_lifecycle_head_lineage(),occ.require_cleanup_membership_owner(),
  occ.require_lifecycle_admission_complete(),occ.lock_lifecycle_capability_write(),
  occ.require_lifecycle_work_capability() FROM PUBLIC,occ_app;
