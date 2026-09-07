-- Versioned draft selection and FIRST-INSERT revision Use. Historical rows stay
-- absent; closed data checks confer no admission or execution authority.
CREATE FUNCTION occ.workload_profile_selection_valid_v1(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $selection$
DECLARE
  uuid_pattern CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
BEGIN
  RETURN (jsonb_typeof(value)='object'
    AND value ?& ARRAY['manifestRef','manifestDigest','admissionRef','admissionVersion']
    AND value - 'manifestRef' - 'manifestDigest' - 'admissionRef' - 'admissionVersion' = '{}'::jsonb
    AND jsonb_typeof(value->'manifestRef')='string' AND value->>'manifestRef' ~ uuid_pattern
    AND jsonb_typeof(value->'admissionRef')='string' AND value->>'admissionRef' ~ uuid_pattern
    AND jsonb_typeof(value->'manifestDigest')='string' AND value->>'manifestDigest' ~ '^sha256:[0-9a-f]{64}$'
    AND jsonb_typeof(value->'admissionVersion')='number'
    AND (value->>'admissionVersion')::numeric BETWEEN 1 AND 9007199254740991
    AND trunc((value->>'admissionVersion')::numeric)=(value->>'admissionVersion')::numeric) IS TRUE;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$selection$;
--> statement-breakpoint
CREATE FUNCTION occ.revision_workload_profile_use_valid_v2(value jsonb, namespace_id text) RETURNS boolean
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
    AND value->'profileRefs' - 'provider' - 'runtime' - 'identity' - 'containment' - 'storage' = '{}'::jsonb
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
ALTER TABLE occ.agents ADD COLUMN workload_profile_selection jsonb;
--> statement-breakpoint
ALTER TABLE occ.agents ADD CONSTRAINT agents_workload_profile_selection CHECK (
  workload_profile_selection IS NULL OR occ.workload_profile_selection_valid_v1(workload_profile_selection)
);
--> statement-breakpoint
ALTER TABLE occ.agent_revisions ADD CONSTRAINT agent_revisions_workload_profile_use CHECK (
  NOT (admitted_spec ? 'workload_profile_use')
  OR occ.revision_workload_profile_use_valid_v2(admitted_spec->'workload_profile_use',namespace_id)
);
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
    - 'secret_driver_id' - 'secret_bindings' - 'service_account' - 'credential_workload_selection' - 'workload_profile_use' = '{}'::jsonb
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
-- The retained public command has fixed ASCII keys, safe integers, and one
-- potentially non-ASCII ProviderId. Match its original trim/UTF16 refinement.
CREATE FUNCTION occ.lifecycle_deploy_command_valid_v2(value jsonb) RETURNS boolean
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
    AND draft ?& ARRAY['configurationId','configurationGeneration','providerId','executionMode','serviceAccountId','workloadProfileSelection']
    AND draft - 'configurationId' - 'configurationGeneration' - 'providerId' - 'executionMode' - 'serviceAccountId' - 'workloadProfileSelection' = '{}'::jsonb
    AND jsonb_typeof(draft->'configurationId')='string'
    AND draft->>'configurationId' ~ ('^cfg_' || substring(uuid_pattern FROM 2))
    AND jsonb_typeof(draft->'configurationGeneration')='number'
    AND (draft->>'configurationGeneration')::numeric BETWEEN 1 AND 9007199254740991
    AND trunc((draft->>'configurationGeneration')::numeric)=(draft->>'configurationGeneration')::numeric
    AND draft->>'executionMode' IN ('embedded','dedicated')
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
ALTER TABLE occ.agent_revision_runtime_admissions
  ADD COLUMN deploy_actor_id text,
  ADD COLUMN deploy_command jsonb,
  ADD COLUMN deploy_canonical text;
--> statement-breakpoint
ALTER TABLE occ.agent_revision_runtime_admissions ADD CONSTRAINT revision_runtime_admissions_deploy_binding CHECK (
  (deploy_actor_id IS NULL AND deploy_command IS NULL AND deploy_canonical IS NULL)
  OR (deploy_actor_id IS NOT NULL AND deploy_command IS NOT NULL AND deploy_canonical IS NOT NULL
    AND deploy_actor_id ~ '^[A-Za-z0-9._:/-]{1,200}$'
    AND occ.lifecycle_deploy_command_valid_v2(deploy_command)
    AND deploy_command->>'operationRef'=runtime_transition_ref
    AND octet_length(deploy_canonical) BETWEEN 1 AND 65536)
);
--> statement-breakpoint
CREATE FUNCTION occ.require_deploy_command_association_v2() RETURNS trigger
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
    OR NEW.deploy_command#>'{expectedDraft,executionMode}' IS DISTINCT FROM revision.admitted_spec#>'{harness,mode}'
    OR NEW.deploy_command#>'{expectedDraft,serviceAccountId}' IS DISTINCT FROM coalesce(revision.admitted_spec#>'{service_account,id}','null'::jsonb)
    OR NEW.deploy_command#>'{expectedDraft,workloadProfileSelection}' IS DISTINCT FROM
      (use_value - 'schemaVersion' - 'installationId' - 'namespaceId' - 'component' - 'canonicalFormat' - 'profileRefs' - 'admittedConfigurationDigest')
    THEN RAISE EXCEPTION 'deployment command association mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$association$;
--> statement-breakpoint
CREATE TRIGGER revision_runtime_deploy_command_v2 BEFORE INSERT ON occ.agent_revision_runtime_admissions
FOR EACH ROW EXECUTE FUNCTION occ.require_deploy_command_association_v2();

--> statement-breakpoint
ALTER TABLE occ.workload_profile_operations DROP CONSTRAINT workload_profile_record_shape,
  ADD CONSTRAINT workload_profile_record_shape CHECK ((
          "record" = jsonb_build_object(
            'schemaVersion', "record"->'schemaVersion', 'kind', 'inert-profile-preparation',
            'scope', jsonb_build_object('installationId', "installation_id",
              'namespaceId', "namespace_id", 'component', CASE "record"->>'schemaVersion' WHEN '1' THEN 'harness' ELSE 'gateway-harness-pair' END),
            'actor', jsonb_build_object('principalRef', "principal_ref", 'accountRef', "account_ref"),
            'operationRef', "operation_ref", 'action', "record"->>'action',
            'canonicalClientIntent', ("record"->>'canonicalClientIntent'), 'clientIntentDigest', "record"->>'clientIntentDigest',
            'allocated', ("record"->'allocated'), 'canonicalOperation', ("record"->>'canonicalOperation'),
            'operationDigest', "record"->>'operationDigest', 'preparedAt', "record"->>'preparedAt')
          AND "record"->'schemaVersion' IN ('1'::jsonb,'2'::jsonb)
          AND "record"->>'action' IN ('admit', 'replace')
          AND "record"->>'preparedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
          AND octet_length("record"::text) BETWEEN 1 AND 270336
          AND octet_length(("record"->>'canonicalClientIntent')) BETWEEN 1 AND 65536
          AND octet_length(("record"->>'canonicalOperation')) BETWEEN 1 AND 65536
          AND "record"->>'clientIntentDigest' ~ '^sha256:[0-9a-f]{64}$'
          AND "record"->>'operationDigest' ~ '^sha256:[0-9a-f]{64}$'
        ) IS TRUE);

--> statement-breakpoint
ALTER TABLE occ.workload_profile_operations DROP CONSTRAINT workload_profile_intent,
  ADD CONSTRAINT workload_profile_intent CHECK ((
          (("record"->>'canonicalClientIntent')::jsonb) = jsonb_build_object('schemaVersion', "record"->'schemaVersion', 'operationRef', "operation_ref",
            'namespaceId', "namespace_id", 'component', CASE "record"->>'schemaVersion' WHEN '1' THEN 'harness' ELSE 'gateway-harness-pair' END,
            'action', "record"->>'action', 'expectedAdmission', ((("record"->>'canonicalClientIntent')::jsonb)->'expectedAdmission'), 'manifest', ((("record"->>'canonicalClientIntent')::jsonb)->'manifest'))
          AND CASE "record"->>'action' WHEN 'admit' THEN ((("record"->>'canonicalClientIntent')::jsonb)->'expectedAdmission') = 'null'::jsonb
            ELSE (((("record"->>'canonicalClientIntent')::jsonb)->'expectedAdmission') = jsonb_build_object(
    'manifestRef', ((("record"->>'canonicalClientIntent')::jsonb)->'expectedAdmission')->>'manifestRef', 'manifestDigest', ((("record"->>'canonicalClientIntent')::jsonb)->'expectedAdmission')->>'manifestDigest',
    'admissionRef', ((("record"->>'canonicalClientIntent')::jsonb)->'expectedAdmission')->>'admissionRef', 'admissionVersion', ((("record"->>'canonicalClientIntent')::jsonb)->'expectedAdmission')->'admissionVersion')
    AND ((("record"->>'canonicalClientIntent')::jsonb)->'expectedAdmission')->>'manifestRef' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND ((("record"->>'canonicalClientIntent')::jsonb)->'expectedAdmission')->>'manifestDigest' ~ '^sha256:[0-9a-f]{64}$'
    AND ((("record"->>'canonicalClientIntent')::jsonb)->'expectedAdmission')->>'admissionRef' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND jsonb_typeof(((("record"->>'canonicalClientIntent')::jsonb)->'expectedAdmission')->'admissionVersion') = 'number'
    AND (((("record"->>'canonicalClientIntent')::jsonb)->'expectedAdmission')->>'admissionVersion')::numeric BETWEEN 1 AND 9007199254740991
    AND trunc((((("record"->>'canonicalClientIntent')::jsonb)->'expectedAdmission')->>'admissionVersion')::numeric) = (((("record"->>'canonicalClientIntent')::jsonb)->'expectedAdmission')->>'admissionVersion')::numeric) END
          AND ((("record"->>'canonicalClientIntent')::jsonb)->'manifest') = jsonb_build_object('format', 'oce.workload-profile.canonical-json.v1',
            'canonicalUtf8', ((("record"->>'canonicalClientIntent')::jsonb)->'manifest')->>'canonicalUtf8', 'manifestDigest', ((("record"->>'canonicalClientIntent')::jsonb)->'manifest')->>'manifestDigest')
          AND octet_length((((("record"->>'canonicalClientIntent')::jsonb)->'manifest')->>'canonicalUtf8')) BETWEEN 1 AND 65536
          AND ((("record"->>'canonicalClientIntent')::jsonb)->'manifest')->>'manifestDigest' = 'sha256:' || encode(sha256(convert_to('oce.workload-profile.manifest.v1
' || (((("record"->>'canonicalClientIntent')::jsonb)->'manifest')->>'canonicalUtf8'), 'UTF8')), 'hex')
          AND "record"->>'clientIntentDigest' = 'sha256:' || encode(sha256(convert_to('oce.workload-profile.operator-intent.v1
' || ("record"->>'canonicalClientIntent'), 'UTF8')), 'hex')
        ) IS TRUE);

--> statement-breakpoint
ALTER TABLE occ.workload_profile_operations DROP CONSTRAINT workload_profile_operation_envelope,
  ADD CONSTRAINT workload_profile_operation_envelope CHECK ((
          ("record"->>'canonicalOperation')::jsonb = jsonb_build_object('schemaVersion', "record"->'schemaVersion',
            'kind', 'inert-profile-preparation', 'scope', "record"->'scope', 'actor', "record"->'actor',
            'operationRef', "operation_ref", 'action', "record"->>'action',
            'clientIntentDigest', "record"->>'clientIntentDigest', 'allocated', ("record"->'allocated'),
            'preparedAt', "record"->>'preparedAt')
          AND "record"->>'operationDigest' = 'sha256:' || encode(sha256(convert_to('oce.workload-profile.operator-operation.v1
' || ("record"->>'canonicalOperation'), 'UTF8')), 'hex')
        ) IS TRUE);

--> statement-breakpoint
-- These helpers constrain retained bytes; the original canonical decoder and
-- genuine definition source still own semantic acceptance and authority.
CREATE FUNCTION occ.workload_profile_attribution_valid_v2(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,occ AS $$
DECLARE item text;
BEGIN
  IF (value=jsonb_build_object('actor',value->'actor','operationRef',value->>'operationRef',
      'requestRef',value->>'requestRef','decisionRef',value->>'decisionRef')
    AND value->'actor'=jsonb_build_object('accountRef',value#>>'{actor,accountRef}','principalRef',value#>>'{actor,principalRef}')
    AND value->>'operationRef' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS NOT TRUE THEN RETURN false; END IF;
  FOREACH item IN ARRAY ARRAY[value#>>'{actor,accountRef}',value#>>'{actor,principalRef}',value->>'requestRef',value->>'decisionRef'] LOOP
    IF (octet_length(item) BETWEEN 1 AND 1024 AND item !~ ('[[:cntrl:]' || chr(127) || '-' || chr(159) || ']')) IS NOT TRUE THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;
--> statement-breakpoint
CREATE FUNCTION occ.workload_profile_timestamp_valid_v2(value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,occ AS $$
BEGIN
  RETURN (value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    AND make_date(CASE substring(value,1,4)::integer WHEN 0 THEN -1 ELSE substring(value,1,4)::integer END,
      substring(value,6,2)::integer,substring(value,9,2)::integer) IS NOT NULL
    AND substring(value,12,2)::integer BETWEEN 0 AND 23
    AND substring(value,15,2)::integer BETWEEN 0 AND 59
    AND substring(value,18,2)::integer BETWEEN 0 AND 59) IS TRUE;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION occ.workload_profile_head_valid_v2(value jsonb, i text, n text, ref text, version bigint, status text, manifest_ref text, manifest_digest text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,occ AS $$
DECLARE base jsonb; manifest jsonb; launch jsonb; projections jsonb; role text; item jsonb; domain text; ids text[]; identity text; accepted jsonb; withdrawn jsonb;
BEGIN
  base:=jsonb_build_object('schemaVersion',2,'scope',jsonb_build_object('installationId',i,'namespaceId',n,'component','gateway-harness-pair'),
    'selection',jsonb_build_object('manifestRef',manifest_ref,'manifestDigest',manifest_digest,'admissionRef',ref,'admissionVersion',version),
    'canonicalFormat','oce.workload-profile.canonical-json.v1','canonicalManifest',value->>'canonicalManifest',
    'profileRefs',value->'profileRefs','acceptance',value->'acceptance','terminal',value->'terminal','state',status);
  IF status='withdrawn' THEN base:=base||jsonb_build_object('withdrawal',value->'withdrawal'); END IF;
  IF (value=base AND occ.workload_profile_selection_valid_v1(value->'selection')
    AND ((status='admitted' AND version=1) OR (status='withdrawn' AND version=2))
    AND octet_length(value::text)<=286720 AND octet_length(value->>'canonicalManifest') BETWEEN 1 AND 65536
    AND i ~ '^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND n ~ '^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS NOT TRUE THEN RETURN false; END IF;
  manifest:=(value->>'canonicalManifest')::jsonb; launch:=manifest->'launchConfiguration';
  PERFORM occ.workload_profile_json_nodes(manifest,false);
  IF (occ.runtime_preparation_canonical(manifest)=value->>'canonicalManifest'
    AND manifest_digest='sha256:'||encode(sha256(convert_to(E'oce.workload-profile.manifest.v1\n'||(value->>'canonicalManifest'),'UTF8')),'hex')) IS NOT TRUE THEN RETURN false; END IF;
  projections:=jsonb_build_object(
    'provider',jsonb_build_object('target',manifest->'target','placement',launch->'placement','physicalCreator',manifest#>'{evidenceRequirements,physicalCreator}'),
    'runtime',jsonb_build_object('artifactSet',manifest->'artifactSet','launchConfiguration',launch),
    'identity',jsonb_build_object('identity',manifest#>'{endpoints,identity}','bootstrap',manifest#>'{evidenceRequirements,bootstrap}','credentials',launch->'credentials'),
    'containment',manifest->'containment',
    'storage',jsonb_build_object('mountPolicy',jsonb_build_object('gateway',launch#>'{gateway,mounts}','harness',launch#>'{harness,mounts}'),
      'context',manifest#>'{evidenceRequirements,context}','replacement',manifest#>'{evidenceRequirements,replacement}'));
  IF (value->'profileRefs'=jsonb_build_object('provider',value#>'{profileRefs,provider}','runtime',value#>'{profileRefs,runtime}',
    'identity',value#>'{profileRefs,identity}','containment',value#>'{profileRefs,containment}','storage',value#>'{profileRefs,storage}')) IS NOT TRUE THEN RETURN false; END IF;
  ids:=ARRAY[manifest_ref,ref];
  FOREACH role IN ARRAY ARRAY['provider','runtime','identity','containment','storage'] LOOP
    item:=value->'profileRefs'->role;
    domain:=CASE role WHEN 'containment' THEN 'containment' ELSE role||'-profile' END;
    IF (item=jsonb_build_object('ref',item->>'ref','version',1,'contentDigest',item->>'contentDigest')
      AND item->>'contentDigest'='sha256:'||encode(sha256(convert_to('oce.workload-profile.'||domain||E'.v1\n'||occ.runtime_preparation_canonical(projections->role),'UTF8')),'hex')) IS NOT TRUE THEN RETURN false; END IF;
    ids:=array_append(ids,item->>'ref');
  END LOOP;
  accepted:=value->'acceptance'; withdrawn:=value->'withdrawal';
  IF (accepted=jsonb_build_object('actor',accepted->'actor','operationRef',accepted->>'operationRef','requestRef',accepted->>'requestRef',
      'decisionRef',accepted->>'decisionRef','historyRef',accepted->>'historyRef','auditRef',accepted->>'auditRef','acceptedAt',accepted->>'acceptedAt')
    AND occ.workload_profile_attribution_valid_v2(accepted-'historyRef'-'auditRef'-'acceptedAt')
    AND occ.workload_profile_timestamp_valid_v2(accepted->>'acceptedAt')
    AND value->'terminal'=jsonb_build_object('templateRef',value#>>'{terminal,templateRef}','historyRef',value#>>'{terminal,historyRef}',
      'auditRef',value#>>'{terminal,auditRef}','invalidationRef',value#>>'{terminal,invalidationRef}')) IS NOT TRUE THEN RETURN false; END IF;
  ids:=ids||ARRAY[accepted->>'historyRef',accepted->>'auditRef',value#>>'{terminal,templateRef}',value#>>'{terminal,historyRef}',value#>>'{terminal,auditRef}',value#>>'{terminal,invalidationRef}'];
  FOREACH identity IN ARRAY ids LOOP
    IF (char_length(identity)=36 AND identity ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') IS NOT TRUE THEN RETURN false; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT v) FROM unnest(ids) v)<>13 THEN RETURN false; END IF;
  IF status='withdrawn' AND (withdrawn=jsonb_build_object('actor',withdrawn->'actor','operationRef',withdrawn->>'operationRef',
      'requestRef',withdrawn->>'requestRef','decisionRef',withdrawn->>'decisionRef','previousVersion',1,'reason',withdrawn->>'reason','acceptedAt',withdrawn->>'acceptedAt')
    AND occ.workload_profile_attribution_valid_v2(withdrawn-'previousVersion'-'reason'-'acceptedAt')
    AND withdrawn->>'reason' IN ('withdrawn','replaced') AND occ.workload_profile_timestamp_valid_v2(withdrawn->>'acceptedAt')
    AND withdrawn->>'acceptedAt'>=accepted->>'acceptedAt') IS NOT TRUE THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE TABLE occ.workload_profile_admissions (
  installation_id text NOT NULL REFERENCES occ.installation(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  namespace_id text NOT NULL REFERENCES occ.namespaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  admission_ref text NOT NULL, admission_version bigint NOT NULL, state text NOT NULL,
  manifest_ref text NOT NULL, manifest_digest text NOT NULL, record jsonb NOT NULL,
  CONSTRAINT workload_profile_admissions_pk PRIMARY KEY(installation_id,admission_ref),
  CONSTRAINT workload_profile_admissions_owner UNIQUE(installation_id,namespace_id,admission_ref,manifest_ref,manifest_digest),
  CONSTRAINT workload_profile_admissions_version CHECK(admission_version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT workload_profile_admissions_state CHECK(state IN ('admitted','withdrawn')),
  CONSTRAINT workload_profile_admissions_selection CHECK(occ.workload_profile_selection_valid_v1(jsonb_build_object(
    'manifestRef',manifest_ref,'manifestDigest',manifest_digest,'admissionRef',admission_ref,'admissionVersion',admission_version))),
  CONSTRAINT workload_profile_admissions_record CHECK(occ.workload_profile_head_valid_v2(record,installation_id,namespace_id,admission_ref,admission_version,state,manifest_ref,manifest_digest))
);
--> statement-breakpoint
CREATE TABLE occ.workload_profile_admission_history (
  installation_id text NOT NULL,namespace_id text NOT NULL,admission_ref text NOT NULL,admission_version bigint NOT NULL,
  manifest_ref text NOT NULL,manifest_digest text NOT NULL,history_ref text NOT NULL,record jsonb NOT NULL,
  CONSTRAINT workload_profile_admission_history_pk PRIMARY KEY(installation_id,admission_ref,admission_version),
  CONSTRAINT workload_profile_admission_history_ref UNIQUE(installation_id,history_ref),
  CONSTRAINT workload_profile_history_owner FOREIGN KEY(installation_id,namespace_id,admission_ref,manifest_ref,manifest_digest)
    REFERENCES occ.workload_profile_admissions(installation_id,namespace_id,admission_ref,manifest_ref,manifest_digest) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT workload_profile_history_version CHECK(admission_version BETWEEN 1 AND 9007199254740991),
  CONSTRAINT workload_profile_history_record CHECK((record=jsonb_build_object('schemaVersion',2,'historyRef',history_ref,'head',record->'head')
    AND history_ref=(CASE record#>>'{head,state}' WHEN 'admitted' THEN record#>>'{head,acceptance,historyRef}' ELSE record#>>'{head,terminal,historyRef}' END)
    AND occ.workload_profile_head_valid_v2(record->'head',installation_id,namespace_id,admission_ref,admission_version,record#>>'{head,state}',manifest_ref,manifest_digest)) IS TRUE)
);
CREATE UNIQUE INDEX workload_profile_primary_command ON occ.workload_profile_admission_history(installation_id,
  (CASE record#>>'{head,state}' WHEN 'admitted' THEN record#>>'{head,acceptance,actor,principalRef}' ELSE record#>>'{head,withdrawal,actor,principalRef}' END),
  (CASE record#>>'{head,state}' WHEN 'admitted' THEN record#>>'{head,acceptance,operationRef}' ELSE record#>>'{head,withdrawal,operationRef}' END))
  WHERE record#>>'{head,state}'='admitted' OR record#>>'{head,withdrawal,reason}'='withdrawn';
--> statement-breakpoint
CREATE TABLE occ.workload_profile_invalidations (
  installation_id text NOT NULL,namespace_id text NOT NULL,admission_ref text NOT NULL,admission_version bigint NOT NULL,
  manifest_ref text NOT NULL,manifest_digest text NOT NULL,invalidation_ref text NOT NULL,record jsonb NOT NULL,
  CONSTRAINT workload_profile_invalidations_pk PRIMARY KEY(installation_id,invalidation_ref),
  CONSTRAINT workload_profile_invalidations_version UNIQUE(installation_id,admission_ref,admission_version),
  CONSTRAINT workload_profile_invalidation_owner FOREIGN KEY(installation_id,namespace_id,admission_ref,manifest_ref,manifest_digest)
    REFERENCES occ.workload_profile_admissions(installation_id,namespace_id,admission_ref,manifest_ref,manifest_digest) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT workload_profile_invalidation_history FOREIGN KEY(installation_id,admission_ref,admission_version)
    REFERENCES occ.workload_profile_admission_history(installation_id,admission_ref,admission_version) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT workload_profile_invalidation_version CHECK(admission_version BETWEEN 2 AND 9007199254740991),
  CONSTRAINT workload_profile_invalidation_record CHECK((record=jsonb_build_object('schemaVersion',2,'kind','profile-admission-invalidated',
    'requestRef',invalidation_ref,'operationRef',record->>'operationRef','installationId',installation_id,'namespaceId',namespace_id,
    'component','gateway-harness-pair','manifestRef',manifest_ref,'manifestDigest',manifest_digest,'admissionRef',admission_ref,
    'previousVersion',admission_version-1,'currentVersion',admission_version,'reason',record->>'reason','acceptedAt',record->>'acceptedAt')
    AND record->>'operationRef' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND record->>'reason' IN ('withdrawn','replaced') AND occ.workload_profile_timestamp_valid_v2(record->>'acceptedAt')) IS TRUE)
);

--> statement-breakpoint
-- Every management writer takes the original Installation capacity prefix before
-- acquiring target tuples, including direct application DML and nested triggers.
CREATE FUNCTION occ.lock_workload_profile_management_v2()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,occ AS $$
DECLARE i text; count_i integer;
BEGIN
  SELECT min(id),count(*) INTO i,count_i FROM occ.installation;
  IF count_i<>1 THEN RAISE EXCEPTION 'profile Installation unavailable' USING ERRCODE='23514'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('workload-profile-capacity:'||i,0));
  PERFORM installation_id FROM occ.workload_profile_capacity WHERE installation_id=i FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile capacity prefix unavailable' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER workload_profile_head_prefix BEFORE INSERT OR UPDATE OR DELETE ON occ.workload_profile_admissions
  FOR EACH STATEMENT EXECUTE FUNCTION occ.lock_workload_profile_management_v2();
CREATE TRIGGER workload_profile_history_prefix BEFORE INSERT OR UPDATE OR DELETE ON occ.workload_profile_admission_history
  FOR EACH STATEMENT EXECUTE FUNCTION occ.lock_workload_profile_management_v2();
CREATE TRIGGER workload_profile_invalidation_prefix BEFORE INSERT OR UPDATE OR DELETE ON occ.workload_profile_invalidations
  FOR EACH STATEMENT EXECUTE FUNCTION occ.lock_workload_profile_management_v2();
--> statement-breakpoint
CREATE FUNCTION occ.validate_workload_profile_head_transition_v2()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,occ AS $$
DECLARE prepared jsonb; allocated jsonb; expected jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'profile head retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF (OLD.state='admitted' AND OLD.admission_version=1 AND NEW.state='withdrawn' AND NEW.admission_version=2
      AND ROW(NEW.installation_id,NEW.namespace_id,NEW.admission_ref,NEW.manifest_ref,NEW.manifest_digest)
        IS NOT DISTINCT FROM ROW(OLD.installation_id,OLD.namespace_id,OLD.admission_ref,OLD.manifest_ref,OLD.manifest_digest)
      AND NEW.record-'state'-'withdrawal'-'selection'=OLD.record-'state'-'selection'
      AND NEW.record->'selection'=(OLD.record->'selection')||jsonb_build_object('admissionVersion',2)) IS NOT TRUE THEN
      RAISE EXCEPTION 'profile transition changes retained association' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.state<>'admitted' OR NEW.admission_version<>1 THEN RAISE EXCEPTION 'profile initial version' USING ERRCODE='23514'; END IF;
  SELECT record INTO prepared FROM occ.workload_profile_operations WHERE installation_id=NEW.installation_id
    AND principal_ref=NEW.record#>>'{acceptance,actor,principalRef}' AND operation_ref=NEW.record#>>'{acceptance,operationRef}';
  allocated:=jsonb_build_object('manifestRef',NEW.manifest_ref,'admissionRef',NEW.admission_ref,
    'providerRef',NEW.record#>>'{profileRefs,provider,ref}','runtimeRef',NEW.record#>>'{profileRefs,runtime,ref}',
    'identityRef',NEW.record#>>'{profileRefs,identity,ref}','containmentRef',NEW.record#>>'{profileRefs,containment,ref}',
    'storageRef',NEW.record#>>'{profileRefs,storage,ref}','historyRef',NEW.record#>>'{acceptance,historyRef}',
    'auditRef',NEW.record#>>'{acceptance,auditRef}','terminalTemplateRef',NEW.record#>>'{terminal,templateRef}',
    'terminalHistoryRef',NEW.record#>>'{terminal,historyRef}','terminalAuditRef',NEW.record#>>'{terminal,auditRef}',
    'terminalInvalidationRef',NEW.record#>>'{terminal,invalidationRef}');
  IF (prepared->'schemaVersion'='2'::jsonb AND prepared->'scope'=NEW.record->'scope'
    AND prepared->'actor'=NEW.record#>'{acceptance,actor}' AND prepared->'allocated'=allocated
    AND ((prepared->>'canonicalClientIntent')::jsonb)#>>'{manifest,canonicalUtf8}'=NEW.record->>'canonicalManifest'
    AND ((prepared->>'canonicalClientIntent')::jsonb)#>>'{manifest,manifestDigest}'=NEW.manifest_digest
    AND NEW.record#>>'{acceptance,acceptedAt}'>=prepared->>'preparedAt') IS NOT TRUE THEN
    RAISE EXCEPTION 'profile initial record differs from original preparation' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workload_profile_head_transition BEFORE INSERT OR UPDATE OR DELETE ON occ.workload_profile_admissions
  FOR EACH ROW EXECUTE FUNCTION occ.validate_workload_profile_head_transition_v2();
CREATE TRIGGER workload_profile_history_retained BEFORE UPDATE OR DELETE ON occ.workload_profile_admission_history
  FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
CREATE TRIGGER workload_profile_invalidation_retained BEFORE UPDATE OR DELETE ON occ.workload_profile_invalidations
  FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.validate_workload_profile_capacity_change()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,occ AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.ordinary_operations<>0 OR NEW.pending_ordinary_operations<>0 OR NEW.terminal_slots<>0 THEN
      RAISE EXCEPTION 'profile initial capacity' USING ERRCODE='23514'; END IF;
  ELSIF NOT (
    (NEW.ordinary_operations=OLD.ordinary_operations+1 AND NEW.pending_ordinary_operations=OLD.pending_ordinary_operations+1 AND NEW.terminal_slots=OLD.terminal_slots)
    OR (NEW.ordinary_operations=OLD.ordinary_operations AND NEW.pending_ordinary_operations=OLD.pending_ordinary_operations-1 AND NEW.terminal_slots=OLD.terminal_slots+1)
    OR (NEW.ordinary_operations=OLD.ordinary_operations+1 AND NEW.pending_ordinary_operations=OLD.pending_ordinary_operations AND NEW.terminal_slots=OLD.terminal_slots-1)
    OR (NEW.ordinary_operations=OLD.ordinary_operations+1 AND NEW.pending_ordinary_operations=OLD.pending_ordinary_operations-1 AND NEW.terminal_slots=OLD.terminal_slots)
  ) OR NEW.installation_id IS DISTINCT FROM OLD.installation_id THEN
    RAISE EXCEPTION 'profile capacity transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION occ.check_workload_profile_capacity()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,occ AS $$
DECLARE p bigint; h bigint; w bigint; a bigint; capacity occ.workload_profile_capacity%ROWTYPE;
BEGIN
  SELECT * INTO capacity FROM occ.workload_profile_capacity WHERE installation_id=NEW.installation_id;
  SELECT count(*) INTO p FROM occ.workload_profile_operations WHERE installation_id=NEW.installation_id;
  SELECT count(*) FILTER(WHERE record#>>'{head,state}'='admitted'),count(*) FILTER(WHERE record#>>'{head,state}'='withdrawn')
    INTO h,w FROM occ.workload_profile_admission_history WHERE installation_id=NEW.installation_id;
  SELECT count(*) INTO a FROM occ.workload_profile_admissions WHERE installation_id=NEW.installation_id AND state='admitted';
  IF (capacity.ordinary_operations=p+w AND capacity.pending_ordinary_operations=p-h AND capacity.terminal_slots=a) IS NOT TRUE THEN
    RAISE EXCEPTION 'profile exact retained capacity differs' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE FUNCTION occ.check_workload_profile_admission_complete_v2()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,occ AS $$
DECLARE head occ.workload_profile_admissions%ROWTYPE; item record; h jsonb; original jsonb; prepared jsonb; intent jsonb; previous jsonb;
  attribution jsonb; event_id text; event occ.audit_events%ROWTYPE; invalidation jsonb; matching integer;
BEGIN
  SELECT * INTO head FROM occ.workload_profile_admissions WHERE installation_id=NEW.installation_id AND admission_ref=NEW.admission_ref;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile head missing at completion' USING ERRCODE='23514'; END IF;
  SELECT record->'head' INTO original FROM occ.workload_profile_admission_history
    WHERE installation_id=head.installation_id AND admission_ref=head.admission_ref AND admission_version=1;
  IF (original=(head.record-'withdrawal')||jsonb_build_object('state','admitted','selection',(head.record->'selection')||jsonb_build_object('admissionVersion',1))) IS NOT TRUE THEN
    RAISE EXCEPTION 'profile original history missing or rewritten' USING ERRCODE='23514'; END IF;
  SELECT record INTO prepared FROM occ.workload_profile_operations WHERE installation_id=head.installation_id
    AND principal_ref=original#>>'{acceptance,actor,principalRef}' AND operation_ref=original#>>'{acceptance,operationRef}';
  intent:=(prepared->>'canonicalClientIntent')::jsonb;
  IF NOT EXISTS(SELECT 1 FROM occ.workload_profile_admission_history WHERE installation_id=head.installation_id
    AND admission_ref=head.admission_ref AND admission_version=head.admission_version AND record->'head'=head.record) THEN
    RAISE EXCEPTION 'profile current history missing' USING ERRCODE='23514'; END IF;
  FOR item IN SELECT record FROM occ.workload_profile_admission_history WHERE installation_id=head.installation_id AND admission_ref=head.admission_ref LOOP
    h:=item.record->'head';
    attribution:=CASE h->>'state' WHEN 'admitted' THEN h->'acceptance' ELSE h->'withdrawal' END;
    event_id:='aud_'||(CASE h->>'state' WHEN 'admitted' THEN h#>>'{acceptance,auditRef}' ELSE h#>>'{terminal,auditRef}' END);
    SELECT * INTO event FROM occ.audit_events WHERE id=event_id;
    IF (event.kind='mutation' AND event.outcome='success' AND event.actor_id=attribution#>>'{actor,principalRef}'
      AND event.namespace_id=head.namespace_id AND event.resource_kind='namespace' AND event.resource_id=head.namespace_id
      AND event.action=(CASE h->>'state' WHEN 'admitted' THEN 'openclaw.workload-profile.accept' ELSE 'openclaw.workload-profile.withdraw' END)
      AND event.occurred_at=(attribution->>'acceptedAt')::timestamptz
      AND event.details#>>'{__occAuditMetadata,requestId}'=attribution->>'requestRef'
      AND event.details#>>'{__occAuditMetadata,admissionDecisionId}'=attribution->>'decisionRef'
      AND event.details->>'accountRef'=attribution#>>'{actor,accountRef}' AND event.details->>'operationRef'=attribution->>'operationRef'
      AND event.details->>'historyRef'=item.record->>'historyRef' AND event.details->>'admissionRef'=head.admission_ref
      AND event.details->'admissionVersion'=h#>'{selection,admissionVersion}'
      AND event.details->>'manifestRef'=head.manifest_ref AND event.details->>'manifestDigest'=head.manifest_digest) IS NOT TRUE THEN
      RAISE EXCEPTION 'profile attributable audit missing' USING ERRCODE='23514'; END IF;
    IF h->>'state'='withdrawn' THEN
      invalidation:=jsonb_build_object('schemaVersion',2,'kind','profile-admission-invalidated','requestRef',h#>>'{terminal,invalidationRef}',
        'operationRef',attribution->>'operationRef','installationId',head.installation_id,'namespaceId',head.namespace_id,
        'component','gateway-harness-pair','manifestRef',head.manifest_ref,'manifestDigest',head.manifest_digest,'admissionRef',head.admission_ref,
        'previousVersion',1,'currentVersion',2,'reason',attribution->>'reason','acceptedAt',attribution->>'acceptedAt');
      IF NOT EXISTS(SELECT 1 FROM occ.workload_profile_invalidations WHERE installation_id=head.installation_id
        AND admission_ref=head.admission_ref AND admission_version=2 AND record=invalidation) THEN
        RAISE EXCEPTION 'profile terminal invalidation missing' USING ERRCODE='23514'; END IF;
      IF attribution->>'reason'='withdrawn' THEN
        IF EXISTS(SELECT 1 FROM occ.workload_profile_operations WHERE installation_id=head.installation_id
          AND principal_ref=attribution#>>'{actor,principalRef}' AND operation_ref=attribution->>'operationRef') THEN
          RAISE EXCEPTION 'withdrawal conflicts with ordinary operation' USING ERRCODE='23514'; END IF;
      ELSE
        SELECT count(*) INTO matching FROM occ.workload_profile_admission_history x JOIN occ.workload_profile_operations o
          ON o.installation_id=x.installation_id AND o.principal_ref=x.record#>>'{head,acceptance,actor,principalRef}'
          AND o.operation_ref=x.record#>>'{head,acceptance,operationRef}'
          WHERE x.installation_id=head.installation_id AND x.record#>>'{head,state}'='admitted'
            AND x.record#>'{head,acceptance,actor}'=attribution->'actor' AND x.record#>>'{head,acceptance,operationRef}'=attribution->>'operationRef'
            AND x.record#>>'{head,acceptance,requestRef}'=attribution->>'requestRef' AND x.record#>>'{head,acceptance,decisionRef}'=attribution->>'decisionRef'
            AND x.record#>>'{head,acceptance,acceptedAt}'=attribution->>'acceptedAt' AND o.record->>'action'='replace'
            AND ((o.record->>'canonicalClientIntent')::jsonb)->'expectedAdmission'=original->'selection';
        IF matching<>1 THEN RAISE EXCEPTION 'replacement new primary history missing' USING ERRCODE='23514'; END IF;
      END IF;
    END IF;
  END LOOP;
  IF prepared->>'action'='replace' THEN
    previous:=intent->'expectedAdmission';
    IF NOT EXISTS(SELECT 1 FROM occ.workload_profile_admission_history x WHERE x.installation_id=head.installation_id
      AND x.namespace_id=head.namespace_id AND x.admission_ref=previous->>'admissionRef' AND x.admission_version=2
      AND (x.record#>'{head,selection}')=(previous||jsonb_build_object('admissionVersion',2))
      AND x.record#>>'{head,withdrawal,reason}'='replaced' AND x.record#>'{head,withdrawal,actor}'=original#>'{acceptance,actor}'
      AND x.record#>>'{head,withdrawal,operationRef}'=original#>>'{acceptance,operationRef}'
      AND x.record#>>'{head,withdrawal,requestRef}'=original#>>'{acceptance,requestRef}'
      AND x.record#>>'{head,withdrawal,decisionRef}'=original#>>'{acceptance,decisionRef}'
      AND x.record#>>'{head,withdrawal,acceptedAt}'=original#>>'{acceptance,acceptedAt}') THEN
      RAISE EXCEPTION 'replacement old terminal history missing' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER workload_profile_head_complete AFTER INSERT OR UPDATE ON occ.workload_profile_admissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occ.check_workload_profile_admission_complete_v2();
CREATE CONSTRAINT TRIGGER workload_profile_history_complete AFTER INSERT ON occ.workload_profile_admission_history
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occ.check_workload_profile_admission_complete_v2();
CREATE CONSTRAINT TRIGGER workload_profile_invalidation_complete AFTER INSERT ON occ.workload_profile_invalidations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occ.check_workload_profile_admission_complete_v2();
CREATE CONSTRAINT TRIGGER workload_profile_head_capacity AFTER INSERT OR UPDATE ON occ.workload_profile_admissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occ.check_workload_profile_capacity();
CREATE CONSTRAINT TRIGGER workload_profile_history_capacity AFTER INSERT ON occ.workload_profile_admission_history
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occ.check_workload_profile_capacity();

--> statement-breakpoint
CREATE FUNCTION occ.require_revision_workload_profile_admission_v2()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,occ AS $$
DECLARE value jsonb; admitted occ.workload_profile_admissions%ROWTYPE;
BEGIN
  value:=NEW.admitted_spec->'workload_profile_use';
  IF value IS NULL THEN RETURN NEW; END IF;
  -- The immutable head row cannot disappear. SHARE conflicts with withdrawal and
  -- remains held by this original revision INSERT through outer transaction end.
  SELECT * INTO admitted FROM occ.workload_profile_admissions WHERE installation_id=value->>'installationId'
    AND namespace_id=NEW.namespace_id AND admission_ref=value->>'admissionRef' FOR SHARE;
  IF (admitted.state='admitted' AND admitted.admission_version=(value->>'admissionVersion')::bigint
    AND admitted.manifest_ref=value->>'manifestRef' AND admitted.manifest_digest=value->>'manifestDigest'
    AND admitted.record->'profileRefs'=value->'profileRefs') IS NOT TRUE THEN
    RAISE EXCEPTION 'revision profile admission unavailable or changed' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER revision_workload_profile_admission BEFORE INSERT ON occ.agent_revisions
  FOR EACH ROW EXECUTE FUNCTION occ.require_revision_workload_profile_admission_v2();
--> statement-breakpoint
REVOKE ALL ON occ.workload_profile_admissions,occ.workload_profile_admission_history,occ.workload_profile_invalidations FROM PUBLIC,occ_app;
GRANT SELECT,INSERT,UPDATE ON occ.workload_profile_admissions TO occ_app;
GRANT SELECT,INSERT ON occ.workload_profile_admission_history,occ.workload_profile_invalidations TO occ_app;
REVOKE ALL ON FUNCTION occ.lock_workload_profile_management_v2(),occ.validate_workload_profile_head_transition_v2(),
  occ.check_workload_profile_admission_complete_v2(),occ.require_revision_workload_profile_admission_v2(),
  occ.require_deploy_command_association_v2() FROM PUBLIC,occ_app;
REVOKE ALL ON FUNCTION occ.workload_profile_attribution_valid_v2(jsonb),occ.workload_profile_timestamp_valid_v2(text),
  occ.workload_profile_head_valid_v2(jsonb,text,text,text,bigint,text,text,text),
  occ.workload_profile_selection_valid_v1(jsonb),occ.revision_workload_profile_use_valid_v2(jsonb,text),
  occ.lifecycle_deploy_command_valid_v2(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.workload_profile_attribution_valid_v2(jsonb),occ.workload_profile_timestamp_valid_v2(text),
  occ.workload_profile_head_valid_v2(jsonb,text,text,text,bigint,text,text,text),
  occ.workload_profile_selection_valid_v1(jsonb),occ.revision_workload_profile_use_valid_v2(jsonb,text),
  occ.lifecycle_deploy_command_valid_v2(jsonb) TO occ_app;
