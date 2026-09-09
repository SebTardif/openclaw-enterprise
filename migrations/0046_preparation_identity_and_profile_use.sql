-- Preserve the existing validation and privileges while making JSON extraction
-- explicit before PostgreSQL applies the higher-precedence subtraction operator.
CREATE OR REPLACE FUNCTION occ.revision_workload_profile_use_valid_v2(value jsonb, namespace_id text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $use$
DECLARE
  item jsonb;
  role_count integer;
  distinct_count integer;
  uuid_pattern CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
BEGIN
  IF (jsonb_typeof(value)='object'
    AND value ?& ARRAY['schemaVersion','installationId','namespaceId','component','manifestRef','manifestDigest',
                      'admissionRef','admissionVersion','canonicalFormat','profileRefs','admittedConfigurationDigest']
    AND value - 'schemaVersion' - 'installationId' - 'namespaceId' - 'component' - 'manifestRef' - 'manifestDigest'
              - 'admissionRef' - 'admissionVersion' - 'canonicalFormat' - 'profileRefs' - 'admittedConfigurationDigest' = '{}'::jsonb
    AND value->'schemaVersion'='2'::jsonb AND value->>'component'='gateway-harness-pair'
    AND value->>'canonicalFormat'='oce.workload-profile.canonical-json.v1'
    AND jsonb_typeof(value->'installationId')='string'
    AND value->>'installationId' ~ ('^ins_' || substring(uuid_pattern FROM 2))
    AND (SELECT count(*)=1 AND bool_and(id=value->>'installationId') FROM occ.installation)
    AND jsonb_typeof(value->'namespaceId')='string' AND value->>'namespaceId'=namespace_id
    AND value->>'namespaceId' ~ ('^ns_' || substring(uuid_pattern FROM 2))
    AND occ.workload_profile_selection_valid_v1(value - 'schemaVersion' - 'installationId' - 'namespaceId'
      - 'component' - 'canonicalFormat' - 'profileRefs' - 'admittedConfigurationDigest')
    AND jsonb_typeof(value->'admittedConfigurationDigest')='string'
    AND value->>'admittedConfigurationDigest' ~ '^sha256:[0-9a-f]{64}$'
    AND jsonb_typeof(value->'profileRefs')='object'
    AND value->'profileRefs' ?& ARRAY['provider','runtime','identity','containment','storage']
    AND (value->'profileRefs') - 'provider' - 'runtime' - 'identity' - 'containment' - 'storage' = '{}'::jsonb
  ) IS NOT TRUE THEN RETURN false; END IF;
  FOR item IN SELECT entry FROM jsonb_each(value->'profileRefs') AS roles(name,entry) LOOP
    IF (jsonb_typeof(item)='object' AND item ?& ARRAY['ref','version','contentDigest']
      AND item - 'ref' - 'version' - 'contentDigest' = '{}'::jsonb
      AND jsonb_typeof(item->'ref')='string' AND item->>'ref' ~ uuid_pattern
      AND jsonb_typeof(item->'contentDigest')='string' AND item->>'contentDigest' ~ '^sha256:[0-9a-f]{64}$'
      AND jsonb_typeof(item->'version')='number' AND (item->>'version')::numeric BETWEEN 1 AND 9007199254740991
      AND trunc((item->>'version')::numeric)=(item->>'version')::numeric) IS NOT TRUE THEN RETURN false; END IF;
  END LOOP;
  SELECT count(*),count(DISTINCT entry->>'ref') INTO role_count,distinct_count
    FROM jsonb_each(value->'profileRefs') AS roles(name,entry);
  RETURN role_count=5 AND distinct_count=5;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$use$;
--> statement-breakpoint
-- BetterAuth account/session subjects and NativeIAM principal IDs are distinct.
-- Preserve the original admission actor while checking its actual account link.
ALTER TABLE occ.runtime_preparation_admission_origins DROP CONSTRAINT runtime_preparation_origin_identity,
  ADD CONSTRAINT runtime_preparation_origin_identity CHECK ((
    session_origin=jsonb_build_object(
      'installationId',installation_id,'accountId',session_origin->>'accountId',
      'issuer','occ:installation:'||installation_id||':better-auth','subject',session_origin->>'accountId',
      'sessionId',session_origin->>'sessionId',
      'sessionCredentialDigest',session_origin->>'sessionCredentialDigest',
      'accountIncarnation',session_origin->>'accountIncarnation',
      'accountVersion',session_origin->'accountVersion')
    AND length(session_origin->>'accountId') BETWEEN 1 AND 200
    AND jsonb_typeof(session_origin->'accountVersion')='number'
    AND (session_origin->>'accountVersion') ~ '^[1-9][0-9]{0,15}$'
    AND (session_origin->>'accountVersion')::numeric <= 9007199254740991
    AND (session_origin->>'sessionCredentialDigest') ~ '^[0-9a-f]{64}$'
    AND length(session_origin->>'sessionId') BETWEEN 1 AND 1024
    AND length(session_origin->>'accountIncarnation') BETWEEN 1 AND 1024
  ) IS TRUE);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.check_runtime_preparation_origin_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE current_session record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Runtime preparation origin is immutable' USING ERRCODE='23514';
  END IF;
  -- The existing session reader is owner-only until the operator binds the actual
  -- controller role. Ordinary application INSERT cannot invent session origin.
  SELECT * INTO current_session FROM occ.read_locked_workload_profile_session_v1(
    NEW.installation_id,NEW.session_origin->>'accountId',NEW.session_origin->>'issuer',
    NEW.session_origin->>'subject',NEW.session_origin->>'sessionId',
    NEW.session_origin->>'sessionCredentialDigest');
  IF NOT FOUND OR current_session.incarnation::text IS DISTINCT FROM NEW.session_origin->>'accountIncarnation'
    OR current_session.account_version IS DISTINCT FROM NEW.session_origin->>'accountVersion'
  THEN RAISE EXCEPTION 'Runtime preparation origin session is unavailable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM occ.agent_runtime_intents i
      JOIN occ.iam_identities actor ON actor.id=NEW.actor_id AND actor.kind='principal'
       AND actor.issuer=NEW.session_origin->>'issuer' AND actor.subject=NEW.session_origin->>'accountId'
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
-- SDK-host receipt time and database submission time do not share a clock.
-- Retain the finite reported time without inferring cross-host causal ordering.
CREATE OR REPLACE FUNCTION occ.immutable_runtime_preparation_response_v1() RETURNS trigger
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
  ) THEN RAISE EXCEPTION 'Runtime preparation response differs from submitted child' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
