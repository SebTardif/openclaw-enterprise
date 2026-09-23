CREATE FUNCTION occ.agent_oauth_secret_metadata_valid(identity jsonb, staged jsonb, owner text, driver text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE entry jsonb;
BEGIN
  IF identity IS NULL OR jsonb_typeof(identity) <> 'object'
    OR NOT identity ?& ARRAY['id','namespaceId','name']
    OR identity - ARRAY['id','namespaceId','name'] <> '{}'::jsonb
    OR jsonb_typeof(identity->'id') <> 'string'
    OR identity->>'id' !~ '^sec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR identity->>'namespaceId' IS DISTINCT FROM owner
    OR jsonb_typeof(identity->'name') <> 'string'
    OR char_length(identity->>'name') NOT BETWEEN 1 AND 512
    OR identity->>'name' ~ '[[:cntrl:]]' THEN RETURN false; END IF;
  IF staged IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(staged) <> 'object'
    OR NOT staged ?& ARRAY['id','namespaceId','name','driverId','backendRef','createdAt']
    OR staged - ARRAY['id','namespaceId','name','driverId','backendRef','createdAt'] <> '{}'::jsonb
    OR staged->'id' IS DISTINCT FROM identity->'id'
    OR staged->'namespaceId' IS DISTINCT FROM identity->'namespaceId'
    OR staged->'name' IS DISTINCT FROM identity->'name'
    OR jsonb_typeof(staged->'driverId') <> 'string'
    OR staged->>'driverId' IS DISTINCT FROM driver
    OR jsonb_typeof(staged->'createdAt') <> 'string'
    OR jsonb_typeof(staged->'backendRef') <> 'object'
    OR NOT (staged->'backendRef') ?& ARRAY['namespaceName','name','key','uid']
    OR (staged->'backendRef') - ARRAY['namespaceName','name','key','uid'] <> '{}'::jsonb THEN RETURN false; END IF;
  IF NOT isfinite((staged->>'createdAt')::timestamptz) THEN RETURN false; END IF;
  FOR entry IN SELECT value FROM jsonb_each(staged->'backendRef') LOOP
    IF jsonb_typeof(entry) <> 'string' OR char_length(entry #>> '{}') NOT BETWEEN 1 AND 512
      OR entry #>> '{}' ~ '[[:cntrl:]]' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE TABLE occ.agent_oauth_attempts (
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  provider_connection_id text NOT NULL,
  connection_id text NOT NULL,
  generation bigint NOT NULL,
  attempt_id text NOT NULL UNIQUE,
  actor_id text NOT NULL,
  provider_id text NOT NULL,
  method_id text NOT NULL,
  profile_id text NOT NULL,
  phase text NOT NULL,
  deadline_at timestamptz NOT NULL,
  secret_driver_id text NOT NULL,
  secret_identity jsonb NOT NULL,
  staged_secret jsonb,
  storage_uid text,
  failure_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT agent_oauth_attempts_pkey PRIMARY KEY (namespace_id, agent_id, generation),
  CONSTRAINT agent_oauth_connection_generation_unique UNIQUE (connection_id, generation),
  CONSTRAINT agent_oauth_agent_owner FOREIGN KEY (namespace_id, agent_id)
    REFERENCES occ.agents(namespace_id, id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT agent_oauth_provider_connection_valid CHECK (provider_connection_id ~ '^pco_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT agent_oauth_generation_valid CHECK (generation BETWEEN 1 AND 9007199254740991),
  CONSTRAINT agent_oauth_connection_valid CHECK (connection_id ~ '^aoc_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT agent_oauth_strings_valid CHECK (
    char_length(attempt_id) BETWEEN 1 AND 512 AND attempt_id !~ '[[:cntrl:]]'
    AND char_length(actor_id) BETWEEN 1 AND 512 AND actor_id !~ '[[:cntrl:]]'
    AND char_length(provider_id) BETWEEN 1 AND 512 AND provider_id !~ '[[:cntrl:]]'
    AND char_length(method_id) BETWEEN 1 AND 512 AND method_id !~ '[[:cntrl:]]'
    AND char_length(profile_id) BETWEEN 1 AND 512 AND profile_id !~ '[[:cntrl:]]'
    AND char_length(secret_driver_id) BETWEEN 1 AND 512 AND secret_driver_id !~ '[[:cntrl:]]'
    AND (storage_uid IS NULL OR (char_length(storage_uid) BETWEEN 1 AND 512 AND storage_uid !~ '[[:cntrl:]]'))
  ),
  CONSTRAINT agent_oauth_phase_valid CHECK (phase IN ('authorizing','staging','authenticated','handoff_pending','ready','reconnect_required','cancelled','superseded')),
  CONSTRAINT agent_oauth_failure_valid CHECK (failure_code IN ('OAUTH_FAILED','OAUTH_EXPIRED','OAUTH_CANCELLED','CREDENTIAL_STAGING_FAILED','NATIVE_STORE_MISSING','NATIVE_IMPORT_FAILED','MODEL_ACCESS_DENIED','RUNTIME_UNSUPPORTED')),
  CONSTRAINT agent_oauth_timestamps_valid CHECK (isfinite(created_at) AND isfinite(updated_at) AND isfinite(deadline_at) AND deadline_at > created_at AND updated_at >= created_at),
  CONSTRAINT agent_oauth_metadata_valid CHECK (occ.agent_oauth_secret_metadata_valid(secret_identity, staged_secret, namespace_id, secret_driver_id)),
  CONSTRAINT agent_oauth_custody_valid CHECK ((phase NOT IN ('authenticated','handoff_pending') OR staged_secret IS NOT NULL) AND (phase NOT IN ('handoff_pending','ready') OR storage_uid IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_oauth_secret_identity_unique ON occ.agent_oauth_attempts ((secret_identity->>'id'));
--> statement-breakpoint
CREATE FUNCTION occ.validate_agent_oauth_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous occ.agent_oauth_attempts; owner_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO owner_status FROM occ.agents WHERE namespace_id=OLD.namespace_id AND id=OLD.agent_id FOR UPDATE;
    IF owner_status NOT IN ('deleting','deleted') OR OLD.staged_secret IS NOT NULL OR OLD.phase IN ('authorizing','staging') THEN
      RAISE EXCEPTION 'Agent OAuth custody must be cleaned before final deletion' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  SELECT status INTO owner_status FROM occ.agents WHERE namespace_id=NEW.namespace_id AND id=NEW.agent_id FOR UPDATE;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO previous FROM occ.agent_oauth_attempts WHERE namespace_id=NEW.namespace_id AND agent_id=NEW.agent_id ORDER BY generation DESC LIMIT 1;
    IF owner_status IS DISTINCT FROM 'active' OR NEW.phase <> 'authorizing' OR NEW.staged_secret IS NOT NULL OR NEW.storage_uid IS NOT NULL OR NEW.failure_code IS NOT NULL OR NEW.updated_at <> NEW.created_at
      OR NEW.generation <> COALESCE(previous.generation,0)+1
      OR (previous.connection_id IS NOT NULL AND NEW.connection_id <> previous.connection_id) THEN
      RAISE EXCEPTION 'Agent OAuth generation or initial state is invalid' USING ERRCODE='23514';
    END IF;
  ELSE
    IF (NEW.namespace_id, NEW.agent_id, NEW.provider_connection_id, NEW.connection_id, NEW.generation, NEW.attempt_id, NEW.actor_id, NEW.provider_id, NEW.method_id, NEW.profile_id, NEW.deadline_at, NEW.secret_driver_id, NEW.secret_identity, NEW.created_at)
      IS DISTINCT FROM (OLD.namespace_id, OLD.agent_id, OLD.provider_connection_id, OLD.connection_id, OLD.generation, OLD.attempt_id, OLD.actor_id, OLD.provider_id, OLD.method_id, OLD.profile_id, OLD.deadline_at, OLD.secret_driver_id, OLD.secret_identity, OLD.created_at)
      OR NEW.updated_at < OLD.updated_at
      OR (OLD.storage_uid IS NOT NULL AND NEW.storage_uid IS DISTINCT FROM OLD.storage_uid)
      OR (OLD.staged_secret IS NOT NULL AND NEW.staged_secret IS NOT NULL AND OLD.staged_secret <> NEW.staged_secret)
      OR (OLD.staged_secret IS NULL AND NEW.staged_secret IS NOT NULL AND NOT (OLD.phase='staging' AND NEW.phase='authenticated'))
      OR (NEW.phase <> OLD.phase AND NOT CASE OLD.phase
        WHEN 'authorizing' THEN NEW.phase IN ('staging','reconnect_required','cancelled','superseded')
        WHEN 'staging' THEN NEW.phase IN ('authenticated','reconnect_required','cancelled','superseded')
        WHEN 'authenticated' THEN NEW.phase IN ('handoff_pending','reconnect_required','cancelled','superseded')
        WHEN 'handoff_pending' THEN NEW.phase IN ('ready','reconnect_required','cancelled','superseded')
        WHEN 'ready' THEN NEW.phase IN ('reconnect_required','cancelled','superseded')
        WHEN 'reconnect_required' THEN NEW.phase IN ('cancelled','superseded')
        ELSE false END) THEN
      RAISE EXCEPTION 'Agent OAuth transition is invalid' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_oauth_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON occ.agent_oauth_attempts FOR EACH ROW EXECUTE FUNCTION occ.validate_agent_oauth_attempt();
--> statement-breakpoint
REVOKE ALL ON occ.agent_oauth_attempts FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON occ.agent_oauth_attempts TO occ_app;
--> statement-breakpoint
GRANT UPDATE (phase, staged_secret, storage_uid, failure_code, updated_at) ON occ.agent_oauth_attempts TO occ_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.agent_oauth_secret_metadata_valid(jsonb,jsonb,text,text) TO occ_app;
