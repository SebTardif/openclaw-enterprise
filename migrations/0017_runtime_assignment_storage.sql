CREATE TABLE occ.agent_runtime_intents (
  transition_ref text PRIMARY KEY,
  installation_id text NOT NULL REFERENCES occ.installation(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  generation bigint NOT NULL,
  desired_mode text NOT NULL,
  revision_id text NOT NULL,
  actor_id text NOT NULL,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT runtime_intents_agent_generation_unique UNIQUE (namespace_id, agent_id, generation),
  CONSTRAINT runtime_intents_head_identity_unique UNIQUE (namespace_id, agent_id, generation, transition_ref),
  CONSTRAINT runtime_intents_allocation_identity_unique UNIQUE (installation_id, namespace_id, agent_id, generation, revision_id),
  CONSTRAINT runtime_intents_agent_owner FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT runtime_intents_revision_owner FOREIGN KEY (namespace_id, agent_id, revision_id)
    REFERENCES occ.agent_revisions(namespace_id, agent_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT runtime_intents_transition_ref_format CHECK (
    transition_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT runtime_intents_generation_valid CHECK (generation BETWEEN 1 AND 9007199254740991),
  CONSTRAINT runtime_intents_mode_valid CHECK (desired_mode IN ('running', 'disabled', 'stopped')),
  CONSTRAINT runtime_intents_actor_id_valid CHECK (
    char_length(actor_id) BETWEEN 1 AND 200 AND actor_id ~ '^[A-Za-z0-9._:/-]+$'
  ),
  CONSTRAINT runtime_intents_request_id_valid CHECK (
    char_length(request_id) BETWEEN 1 AND 200 AND request_id ~ '^[A-Za-z0-9._:/-]+$'
  ),
  CONSTRAINT runtime_intents_created_at_finite CHECK (isfinite(created_at))
);
--> statement-breakpoint
CREATE TABLE occ.agent_runtime_intent_heads (
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  generation bigint NOT NULL,
  transition_ref text NOT NULL,
  CONSTRAINT runtime_intent_heads_agent_unique UNIQUE (namespace_id, agent_id),
  CONSTRAINT runtime_intent_heads_history_owner FOREIGN KEY (namespace_id, agent_id, generation, transition_ref)
    REFERENCES occ.agent_runtime_intents(namespace_id, agent_id, generation, transition_ref)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT runtime_intent_heads_generation_valid CHECK (generation BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE occ.runtime_assignment_allocations (
  assignment_ref text PRIMARY KEY,
  create_effect_ref text NOT NULL,
  installation_id text NOT NULL,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  revision_id text NOT NULL,
  service_principal_id text NOT NULL,
  lifecycle_generation bigint NOT NULL,
  component text NOT NULL,
  runtime_generation bigint NOT NULL,
  provider_profile_ref text NOT NULL,
  runtime_profile_ref text NOT NULL,
  identity_profile_ref text NOT NULL,
  created_at timestamptz NOT NULL,
  binding_condition text NOT NULL DEFAULT 'unbound',
  CONSTRAINT runtime_allocations_create_effect_unique UNIQUE (create_effect_ref),
  CONSTRAINT runtime_allocations_component_generation_unique UNIQUE (namespace_id, agent_id, component, runtime_generation),
  CONSTRAINT runtime_allocations_intent_owner FOREIGN KEY (installation_id, namespace_id, agent_id, lifecycle_generation, revision_id)
    REFERENCES occ.agent_runtime_intents(installation_id, namespace_id, agent_id, generation, revision_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT runtime_allocations_agent_principal_owner FOREIGN KEY (namespace_id, agent_id, service_principal_id)
    REFERENCES occ.agents(namespace_id, id, service_principal_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT runtime_allocations_assignment_ref_format CHECK (
    assignment_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT runtime_allocations_create_effect_ref_format CHECK (
    create_effect_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  CONSTRAINT runtime_allocations_lifecycle_generation_valid CHECK (lifecycle_generation BETWEEN 1 AND 9007199254740991),
  CONSTRAINT runtime_allocations_runtime_generation_valid CHECK (runtime_generation BETWEEN 1 AND 9007199254740991),
  CONSTRAINT runtime_allocations_component_valid CHECK (component IN ('gateway', 'harness')),
  CONSTRAINT runtime_allocations_binding_condition_valid CHECK (binding_condition = 'unbound'),
  CONSTRAINT runtime_allocations_provider_profile_ref_valid CHECK (
    char_length(provider_profile_ref) BETWEEN 1 AND 200 AND provider_profile_ref ~ '^[A-Za-z0-9._:/-]+$'
  ),
  CONSTRAINT runtime_allocations_runtime_profile_ref_valid CHECK (
    char_length(runtime_profile_ref) BETWEEN 1 AND 200 AND runtime_profile_ref ~ '^[A-Za-z0-9._:/-]+$'
  ),
  CONSTRAINT runtime_allocations_identity_profile_ref_valid CHECK (
    char_length(identity_profile_ref) BETWEEN 1 AND 200 AND identity_profile_ref ~ '^[A-Za-z0-9._:/-]+$'
  ),
  CONSTRAINT runtime_allocations_created_at_finite CHECK (isfinite(created_at))
);
--> statement-breakpoint
CREATE TRIGGER runtime_intents_are_immutable
BEFORE UPDATE OR DELETE ON occ.agent_runtime_intents
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER runtime_allocations_are_immutable
BEFORE UPDATE OR DELETE ON occ.runtime_assignment_allocations
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER runtime_intent_head_owner_is_immutable
BEFORE UPDATE OF namespace_id, agent_id ON occ.agent_runtime_intent_heads
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE TRIGGER runtime_intent_head_cannot_be_deleted
BEFORE DELETE ON occ.agent_runtime_intent_heads
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE FUNCTION occ.require_next_runtime_intent_head() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.generation <> 1 THEN
      RAISE EXCEPTION 'runtime intent head must begin at generation one' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.generation <> OLD.generation + 1 THEN
    RAISE EXCEPTION 'runtime intent head must advance exactly once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER runtime_intent_head_requires_next_generation
BEFORE INSERT OR UPDATE ON occ.agent_runtime_intent_heads
FOR EACH ROW EXECUTE FUNCTION occ.require_next_runtime_intent_head();
--> statement-breakpoint
CREATE FUNCTION occ.require_running_runtime_allocation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_generation bigint;
  current_revision text;
  current_mode text;
  previous_runtime_generation bigint;
BEGIN
  -- Every allocator uses this owner lock before reading the component sequence.
  PERFORM 1 FROM occ.agents
    WHERE namespace_id = NEW.namespace_id AND id = NEW.agent_id
    FOR UPDATE;
  SELECT h.generation, i.revision_id, i.desired_mode
    INTO current_generation, current_revision, current_mode
    FROM occ.agent_runtime_intent_heads h
    JOIN occ.agent_runtime_intents i ON i.transition_ref = h.transition_ref
    WHERE h.namespace_id = NEW.namespace_id AND h.agent_id = NEW.agent_id
      AND i.installation_id = NEW.installation_id
    FOR UPDATE OF h;
  IF current_generation IS DISTINCT FROM NEW.lifecycle_generation
    OR current_revision IS DISTINCT FROM NEW.revision_id
    OR current_mode IS DISTINCT FROM 'running' THEN
    RAISE EXCEPTION 'runtime allocation requires the exact current running intent' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(max(runtime_generation), 0) INTO previous_runtime_generation
    FROM occ.runtime_assignment_allocations
    WHERE namespace_id = NEW.namespace_id AND agent_id = NEW.agent_id
      AND component = NEW.component;
  IF NEW.runtime_generation <> previous_runtime_generation + 1 THEN
    RAISE EXCEPTION 'runtime allocation must advance component generation exactly once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER runtime_allocation_requires_running_intent
BEFORE INSERT ON occ.runtime_assignment_allocations
FOR EACH ROW EXECUTE FUNCTION occ.require_running_runtime_allocation();
--> statement-breakpoint
REVOKE ALL ON occ.agent_runtime_intents, occ.agent_runtime_intent_heads,
  occ.runtime_assignment_allocations FROM PUBLIC, occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.require_running_runtime_allocation() FROM PUBLIC, occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.require_next_runtime_intent_head() FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.agent_runtime_intents, occ.agent_runtime_intent_heads,
  occ.runtime_assignment_allocations TO occ_app;
--> statement-breakpoint
GRANT UPDATE (generation, transition_ref) ON occ.agent_runtime_intent_heads TO occ_app;
