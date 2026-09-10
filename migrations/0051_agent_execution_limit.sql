-- New drafts are uncapped by default. Historical revision and attempt records
-- remain unchanged and do not acquire an execution policy from this default.
ALTER TABLE occ.agents ADD COLUMN maximum_execution_ms bigint;
--> statement-breakpoint
ALTER TABLE occ.agents ADD CONSTRAINT agents_maximum_execution_ms CHECK (
  maximum_execution_ms IS NULL OR maximum_execution_ms BETWEEN 1 AND 9007199254740991
);
--> statement-breakpoint
GRANT UPDATE (maximum_execution_ms) ON occ.agents TO occ_app;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions DROP CONSTRAINT agent_revisions_admitted_snapshot;
--> statement-breakpoint
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_admitted_snapshot CHECK (
  admitted_spec ?& ARRAY[
    'configuration_id', 'configuration_kind', 'configuration_generation',
    'draft_spec', 'harness', 'compute'
  ]
  AND admitted_spec
    - 'configuration_id' - 'configuration_kind' - 'configuration_generation'
    - 'draft_spec' - 'harness' - 'compute' - 'sandbox_driver_id'
    - 'secret_driver_id' - 'secret_bindings' - 'service_account' - 'credential_workload_selection' - 'workload_profile_use' - 'maximum_execution_ms' = '{}'::jsonb
  AND jsonb_typeof(admitted_spec->'configuration_id') = 'string'
  AND (admitted_spec->>'configuration_id')
    ~ '^cfg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND jsonb_typeof(admitted_spec->'configuration_kind') = 'string'
  AND admitted_spec->>'configuration_kind' = 'agent'
  AND jsonb_typeof(admitted_spec->'configuration_generation') = 'number'
  AND (admitted_spec->>'configuration_generation')::numeric
    BETWEEN 1 AND 9007199254740991
  AND mod((admitted_spec->>'configuration_generation')::numeric, 1) = 0
  AND jsonb_typeof(admitted_spec->'draft_spec') = 'object'
  AND jsonb_typeof(admitted_spec->'harness') = 'object'
  AND (admitted_spec->'harness') ?& ARRAY['id', 'version', 'mode']
  AND (admitted_spec->'harness') - 'id' - 'version' - 'mode' = '{}'::jsonb
  AND jsonb_typeof(admitted_spec #> '{harness,id}') = 'string'
  AND COALESCE(btrim(admitted_spec #>> '{harness,id}'), '') <> ''
  AND jsonb_typeof(admitted_spec #> '{harness,version}') = 'string'
  AND COALESCE(btrim(admitted_spec #>> '{harness,version}'), '') <> ''
  AND jsonb_typeof(admitted_spec #> '{harness,mode}') = 'string'
  AND (admitted_spec #>> '{harness,mode}') IN ('embedded', 'dedicated')
  AND jsonb_typeof(admitted_spec->'compute') = 'object'
  AND (admitted_spec->'compute') ?& ARRAY['id', 'implementation']
  AND (admitted_spec->'compute') - 'id' - 'implementation' = '{}'::jsonb
  AND jsonb_typeof(admitted_spec #> '{compute,id}') = 'string'
  AND COALESCE(btrim(admitted_spec #>> '{compute,id}'), '') <> ''
  AND jsonb_typeof(admitted_spec #> '{compute,implementation}') = 'string'
  AND COALESCE(btrim(admitted_spec #>> '{compute,implementation}'), '') <> ''
  AND (
    NOT (admitted_spec ? 'sandbox_driver_id')
    OR (
      jsonb_typeof(admitted_spec->'sandbox_driver_id') = 'string'
      AND COALESCE(btrim(admitted_spec->>'sandbox_driver_id'), '') <> ''
    )
  )
  AND (
    NOT (admitted_spec ? 'secret_driver_id')
    OR (
      jsonb_typeof(admitted_spec->'secret_driver_id') = 'string'
      AND COALESCE(btrim(admitted_spec->>'secret_driver_id'), '') <> ''
    )
  )
  AND (
    NOT (admitted_spec ? 'secret_bindings')
    OR occ.secret_bindings_are_valid(admitted_spec->'secret_bindings', namespace_id)
  )
  AND (
    NOT (admitted_spec ? 'service_account')
    OR (
      jsonb_typeof(admitted_spec->'service_account') = 'object'
      AND (admitted_spec->'service_account') ?& ARRAY['id', 'credential']
      AND (admitted_spec->'service_account')
        - 'id' - 'credential' = '{}'::jsonb
      AND jsonb_typeof(admitted_spec #> '{service_account,id}') = 'string'
      AND (admitted_spec #>> '{service_account,id}')
        ~ '^sa_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND jsonb_typeof(admitted_spec #> '{service_account,credential}') = 'object'
      AND (admitted_spec #> '{service_account,credential}') ?& ARRAY['kind', 'secretRef']
      AND (admitted_spec #> '{service_account,credential}')
        - 'kind' - 'secretRef' = '{}'::jsonb
      AND jsonb_typeof(admitted_spec #> '{service_account,credential,kind}') = 'string'
      AND (admitted_spec #>> '{service_account,credential,kind}')
        IN ('api_key', 'access_token')
      AND jsonb_typeof(admitted_spec #> '{service_account,credential,secretRef}') = 'object'
      AND (admitted_spec #> '{service_account,credential,secretRef}')
        ?& ARRAY['name', 'key']
      AND (admitted_spec #> '{service_account,credential,secretRef}')
        - 'name' - 'key' = '{}'::jsonb
      AND jsonb_typeof(admitted_spec #> '{service_account,credential,secretRef,name}')
        = 'string'
      AND char_length(admitted_spec #>> '{service_account,credential,secretRef,name}')
        BETWEEN 1 AND 253
      AND (admitted_spec #>> '{service_account,credential,secretRef,name}')
        ~ '^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$'
      AND jsonb_typeof(admitted_spec #> '{service_account,credential,secretRef,key}')
        = 'string'
      AND char_length(admitted_spec #>> '{service_account,credential,secretRef,key}')
        BETWEEN 1 AND 253
      AND (admitted_spec #>> '{service_account,credential,secretRef,key}')
        ~ '^[-._a-zA-Z0-9]+$'
      AND (admitted_spec #>> '{service_account,credential,secretRef,key}')
        NOT IN ('.', '..')
    )
  )
);

--> statement-breakpoint
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_execution_limit CHECK (
  admitted_spec ? 'maximum_execution_ms'
  AND CASE
    WHEN admitted_spec->'maximum_execution_ms' = 'null'::jsonb THEN true
    WHEN jsonb_typeof(admitted_spec->'maximum_execution_ms') = 'number' THEN
      (admitted_spec->>'maximum_execution_ms')::numeric BETWEEN 1 AND 9007199254740991
      AND mod((admitted_spec->>'maximum_execution_ms')::numeric, 1) = 0
    ELSE false
  END
) NOT VALID;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.lifecycle_deploy_command_valid_v2(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $command$
DECLARE
  draft jsonb := value->'expectedDraft';
  provider text;
  utf16_length bigint;
  uuid_pattern CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
BEGIN
  IF (jsonb_typeof(value)='object'
    AND value ?& ARRAY['schemaVersion','operationRef','expectedLifecycleGeneration','revisionSource','expectedDraft']
    AND value - 'schemaVersion' - 'operationRef' - 'expectedLifecycleGeneration' - 'revisionSource' - 'expectedDraft' = '{}'::jsonb
    AND value->'schemaVersion'='2'::jsonb AND value->>'revisionSource'='saved-draft'
    AND jsonb_typeof(value->'operationRef')='string' AND char_length(value->>'operationRef')=36
    AND value->>'operationRef' ~ uuid_pattern
    AND (value->'expectedLifecycleGeneration'='null'::jsonb OR
      (jsonb_typeof(value->'expectedLifecycleGeneration')='number'
       AND (value->>'expectedLifecycleGeneration')::numeric BETWEEN 1 AND 9007199254740991
       AND trunc((value->>'expectedLifecycleGeneration')::numeric)=(value->>'expectedLifecycleGeneration')::numeric))
    AND jsonb_typeof(draft)='object'
    AND draft ?& ARRAY['configurationId','configurationGeneration','providerId','executionMode','maximumExecutionMs','serviceAccountId','workloadProfileSelection']
    AND draft - 'configurationId' - 'configurationGeneration' - 'providerId' - 'executionMode' - 'maximumExecutionMs' - 'serviceAccountId' - 'workloadProfileSelection' = '{}'::jsonb
    AND jsonb_typeof(draft->'configurationId')='string'
    AND draft->>'configurationId' ~ ('^cfg_' || substring(uuid_pattern FROM 2))
    AND jsonb_typeof(draft->'configurationGeneration')='number'
    AND (draft->>'configurationGeneration')::numeric BETWEEN 1 AND 9007199254740991
    AND trunc((draft->>'configurationGeneration')::numeric)=(draft->>'configurationGeneration')::numeric
    AND draft->>'executionMode' IN ('embedded','dedicated')
    AND CASE WHEN draft->'maximumExecutionMs'='null'::jsonb THEN true
      WHEN jsonb_typeof(draft->'maximumExecutionMs')='number' THEN
        (draft->>'maximumExecutionMs')::numeric BETWEEN 1 AND 9007199254740991
        AND trunc((draft->>'maximumExecutionMs')::numeric)=(draft->>'maximumExecutionMs')::numeric
      ELSE false END
    AND (draft->'serviceAccountId'='null'::jsonb OR (jsonb_typeof(draft->'serviceAccountId')='string'
      AND draft->>'serviceAccountId' ~ ('^sa_' || substring(uuid_pattern FROM 2))))
    AND (draft->'providerId'='null'::jsonb OR jsonb_typeof(draft->'providerId')='string')
    AND occ.workload_profile_selection_valid_v1(draft->'workloadProfileSelection')
  ) IS NOT TRUE THEN RETURN false; END IF;
  IF draft->'providerId'<>'null'::jsonb THEN
    provider := draft->>'providerId';
    SELECT coalesce(sum(CASE WHEN ascii(c)>65535 THEN 2 ELSE 1 END),0)
      INTO utf16_length FROM regexp_split_to_table(provider,'') AS chars(c);
    IF utf16_length NOT BETWEEN 1 AND 200
      OR btrim(provider,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')<>provider
      OR translate(provider,(SELECT string_agg(chr(n),'') FROM generate_series(1,31) AS codes(n))||chr(127)||chr(8232)||chr(8233),'')<>provider
      THEN RETURN false; END IF;
  END IF;
  RETURN octet_length(occ.runtime_authority_canonical(value))<=65536;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$command$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.require_deploy_command_association_v2() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $association$
DECLARE
  intent occ.agent_runtime_intents%ROWTYPE;
  revision occ.agent_revisions%ROWTYPE;
  binding jsonb;
  use_value jsonb;
BEGIN
  IF NEW.deploy_command IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO STRICT intent FROM occ.agent_runtime_intents WHERE transition_ref=NEW.runtime_transition_ref;
  SELECT * INTO STRICT revision FROM occ.agent_revisions WHERE id=NEW.revision_id;
  binding := jsonb_build_object('action','agent.deploy',
    'scope',jsonb_build_object('installationId',intent.installation_id,'namespaceId',NEW.namespace_id,'agentId',NEW.agent_id),
    'command',NEW.deploy_command);
  use_value := revision.admitted_spec->'workload_profile_use';
  IF NEW.deploy_actor_id IS DISTINCT FROM intent.actor_id
    OR NEW.deploy_canonical IS DISTINCT FROM occ.runtime_authority_canonical(binding)
    OR (CASE WHEN NEW.deploy_command->'expectedLifecycleGeneration'='null'::jsonb THEN 1
      ELSE (NEW.deploy_command->>'expectedLifecycleGeneration')::numeric+1 END) IS DISTINCT FROM intent.generation::numeric
    OR NEW.deploy_command#>'{expectedDraft,configurationId}' IS DISTINCT FROM revision.admitted_spec->'configuration_id'
    OR NEW.deploy_command#>'{expectedDraft,configurationGeneration}' IS DISTINCT FROM revision.admitted_spec->'configuration_generation'
    OR NEW.deploy_command#>'{expectedDraft,providerId}' IS DISTINCT FROM coalesce(to_jsonb(revision.provider_id),'null'::jsonb)
    OR NEW.deploy_command#>'{expectedDraft,maximumExecutionMs}' IS DISTINCT FROM revision.admitted_spec->'maximum_execution_ms'
    OR NEW.deploy_command#>'{expectedDraft,executionMode}' IS DISTINCT FROM revision.admitted_spec#>'{harness,mode}'
    OR NEW.deploy_command#>'{expectedDraft,serviceAccountId}' IS DISTINCT FROM coalesce(revision.admitted_spec#>'{service_account,id}','null'::jsonb)
    OR NEW.deploy_command#>'{expectedDraft,workloadProfileSelection}' IS DISTINCT FROM
      (use_value - 'schemaVersion' - 'installationId' - 'namespaceId' - 'component' - 'canonicalFormat' - 'profileRefs' - 'admittedConfigurationDigest')
    THEN RAISE EXCEPTION 'deployment command association mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$association$;
