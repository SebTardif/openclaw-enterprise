-- Original asynchronous admission association. This never stores a bearer or
-- turns historical authentication into a current session or effect permit.
CREATE TABLE occ.runtime_preparation_admission_origins (
  installation_id text NOT NULL,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  revision_id text PRIMARY KEY,
  intent_ref text NOT NULL UNIQUE,
  lifecycle_generation bigint NOT NULL,
  actor_id text NOT NULL,
  request_id text NOT NULL,
  admission_decision_id text NOT NULL CHECK(length(admission_decision_id) BETWEEN 1 AND 1024),
  session_origin jsonb NOT NULL,
  CONSTRAINT runtime_preparation_origin_admission FOREIGN KEY
    (namespace_id,agent_id,revision_id,intent_ref,lifecycle_generation)
    REFERENCES occ.agent_revision_runtime_admissions
      (namespace_id,agent_id,revision_id,runtime_transition_ref,lifecycle_generation)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT runtime_preparation_origin_identity CHECK ((
    session_origin=jsonb_build_object(
      'installationId',installation_id,'accountId',actor_id,
      'issuer','occ:installation:'||installation_id||':better-auth','subject',actor_id,
      'sessionId',session_origin->>'sessionId',
      'sessionCredentialDigest',session_origin->>'sessionCredentialDigest',
      'accountIncarnation',session_origin->>'accountIncarnation',
      'accountVersion',session_origin->'accountVersion')
    AND jsonb_typeof(session_origin->'accountVersion')='number'
    AND (session_origin->>'accountVersion') ~ '^[1-9][0-9]{0,15}$'
    AND (session_origin->>'accountVersion')::numeric <= 9007199254740991
    AND (session_origin->>'sessionCredentialDigest') ~ '^[0-9a-f]{64}$'
    AND length(session_origin->>'sessionId') BETWEEN 1 AND 1024
    AND length(session_origin->>'accountIncarnation') BETWEEN 1 AND 1024
  ) IS TRUE)
);
--> statement-breakpoint
CREATE FUNCTION occ.check_runtime_preparation_origin_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE current_session record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Runtime preparation origin is immutable' USING ERRCODE='23514';
  END IF;
  -- The existing session reader is owner-only until the operator binds the actual
  -- controller role. Ordinary application INSERT cannot invent session origin.
  SELECT * INTO current_session FROM occ.read_locked_workload_profile_session_v1(
    NEW.installation_id,NEW.actor_id,NEW.session_origin->>'issuer',
    NEW.session_origin->>'subject',NEW.session_origin->>'sessionId',
    NEW.session_origin->>'sessionCredentialDigest');
  IF NOT FOUND OR current_session.incarnation::text IS DISTINCT FROM NEW.session_origin->>'accountIncarnation'
    OR current_session.account_version IS DISTINCT FROM NEW.session_origin->>'accountVersion'
  THEN RAISE EXCEPTION 'Runtime preparation origin session is unavailable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM occ.agent_runtime_intents i
      JOIN occ.agent_revision_runtime_admissions a
        ON a.namespace_id=i.namespace_id AND a.agent_id=i.agent_id
       AND a.runtime_transition_ref=i.transition_ref AND a.lifecycle_generation=i.generation
     WHERE i.installation_id=NEW.installation_id AND i.namespace_id=NEW.namespace_id
       AND i.agent_id=NEW.agent_id AND i.transition_ref=NEW.intent_ref
       AND i.generation=NEW.lifecycle_generation AND i.revision_id=NEW.revision_id
       AND i.actor_id=NEW.actor_id AND i.request_id=NEW.request_id
       AND i.desired_mode='running' AND a.deploy_actor_id=NEW.actor_id
       AND a.deploy_command->>'operationRef'=NEW.intent_ref
       -- Preserve first-admission provenance even for a direct application-role
       -- INSERT: a committed historical admission cannot acquire a new origin.
       AND a.xmin::text=(pg_current_xact_id()::text::numeric % 4294967296)::text
  ) THEN
    RAISE EXCEPTION 'Runtime preparation origin association differs' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER runtime_preparation_origin_guard
BEFORE INSERT OR UPDATE OR DELETE ON occ.runtime_preparation_admission_origins
FOR EACH ROW EXECUTE FUNCTION occ.check_runtime_preparation_origin_v1();
--> statement-breakpoint
REVOKE ALL ON occ.runtime_preparation_admission_origins FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON occ.runtime_preparation_admission_origins TO occ_app;
-- INSERT remains owner-only. The operator must explicitly bind the original
-- controller role alongside its existing profile-session helper permission.
--> statement-breakpoint
-- A committed row retains responsibility for this exact possible submission.
-- It grants no permission to send an effect and is never deleted when the
-- caller, worker claim or current profile later disappears.
CREATE TABLE occ.runtime_preparation_submissions (
  effect_ref text PRIMARY KEY REFERENCES occ.runtime_preparation_operations(child_effect_ref) ON UPDATE RESTRICT ON DELETE RESTRICT,
  submission_ref uuid NOT NULL UNIQUE,
  installation_id text NOT NULL,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  revision_id text NOT NULL REFERENCES occ.runtime_preparation_admission_origins(revision_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  preparation_ref text NOT NULL,
  preparation_version bigint NOT NULL CHECK(preparation_version BETWEEN 1 AND 9007199254740991),
  request_digest text NOT NULL,
  provider_wire_digest text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT runtime_preparation_submission_digests CHECK(request_digest ~ '^sha256:[0-9a-f]{64}$' AND provider_wire_digest ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE occ.runtime_preparation_submission_responses (
  effect_ref text PRIMARY KEY REFERENCES occ.runtime_preparation_submissions(effect_ref) ON UPDATE RESTRICT ON DELETE RESTRICT,
  namespace_name text NOT NULL,
  deployment_name text NOT NULL,
  deployment_uid text NOT NULL,
  resource_version text NOT NULL,
  received_at timestamptz NOT NULL,
  CHECK(length(namespace_name) BETWEEN 1 AND 253 AND length(deployment_name) BETWEEN 1 AND 253 AND length(deployment_uid) BETWEEN 1 AND 1024 AND length(resource_version) BETWEEN 1 AND 1024 AND isfinite(received_at))
);
--> statement-breakpoint
CREATE FUNCTION occ.check_runtime_preparation_submission_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Runtime preparation submission is immutable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM occ.runtime_preparation_operations child
      JOIN occ.runtime_preparation_admission_origins origin ON origin.revision_id=NEW.revision_id
     WHERE child.child_effect_ref=NEW.effect_ref AND child.preparation_ref=NEW.preparation_ref
       AND child.installation_id=NEW.installation_id AND child.namespace_id=NEW.namespace_id AND child.agent_id=NEW.agent_id
       AND origin.installation_id=NEW.installation_id AND origin.namespace_id=NEW.namespace_id AND origin.agent_id=NEW.agent_id
       AND child.record->'target'->>'revisionId'=NEW.revision_id
       AND child.local_version<=NEW.preparation_version
       AND NEW.preparation_version=(SELECT max(head.local_version)
         FROM occ.runtime_preparation_operations head WHERE head.preparation_ref=NEW.preparation_ref)
       AND child.canonical_request::jsonb->'child'->'request'->>'kind'='create'
       AND child.canonical_request::jsonb->'child'->'effect'->>'requestDigest'=NEW.request_digest
       AND child.canonical_request::jsonb->'child'->'providerWire'->>'bytesDigest'=NEW.provider_wire_digest
  ) THEN RAISE EXCEPTION 'Runtime preparation submission differs from retained child' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER runtime_preparation_submission_guard BEFORE INSERT OR UPDATE OR DELETE ON occ.runtime_preparation_submissions
FOR EACH ROW EXECUTE FUNCTION occ.check_runtime_preparation_submission_v1();
--> statement-breakpoint
CREATE FUNCTION occ.immutable_runtime_preparation_response_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Runtime preparation response is immutable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM occ.runtime_preparation_submissions submitted
      JOIN occ.runtime_preparation_operations child ON child.child_effect_ref=submitted.effect_ref
    WHERE submitted.effect_ref=NEW.effect_ref
      AND child.canonical_request::jsonb->'child'->'providerTarget'->>'apiKind'='Deployment'
      AND child.canonical_request::jsonb->'child'->'providerTarget'->>'name'=NEW.deployment_name
      AND (child.canonical_request::jsonb->'child'->'predicate'->>'kind'='expected-absent'
        OR child.canonical_request::jsonb->'child'->'predicate'->>'uid'=NEW.deployment_uid)
      AND NEW.received_at>=submitted.submitted_at
  ) THEN RAISE EXCEPTION 'Runtime preparation response differs from submitted child' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER runtime_preparation_response_guard BEFORE INSERT OR UPDATE OR DELETE ON occ.runtime_preparation_submission_responses
FOR EACH ROW EXECUTE FUNCTION occ.immutable_runtime_preparation_response_v1();
--> statement-breakpoint
REVOKE ALL ON occ.runtime_preparation_submissions,occ.runtime_preparation_submission_responses FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT,INSERT ON occ.runtime_preparation_submissions,occ.runtime_preparation_submission_responses TO occ_app;
