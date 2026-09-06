-- Inert, original-actor preparation only. No active admission or terminal authority.
CREATE TABLE occ.workload_profile_capacity (
  installation_id text PRIMARY KEY REFERENCES occ.installation(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ordinary_operations integer NOT NULL DEFAULT 0,
  pending_ordinary_operations integer NOT NULL DEFAULT 0,
  terminal_slots integer NOT NULL DEFAULT 0,
  CONSTRAINT workload_profile_capacity_bounds CHECK (
        "ordinary_operations" BETWEEN 0 AND 4096
        AND "pending_ordinary_operations" BETWEEN 0 AND 32
        AND "terminal_slots" BETWEEN 0 AND 4096
        AND "pending_ordinary_operations" <= "ordinary_operations"
        AND "ordinary_operations"::bigint + "terminal_slots"::bigint <= 4096)
);
--> statement-breakpoint
CREATE TABLE occ.workload_profile_operations (
  installation_id text NOT NULL REFERENCES occ.installation(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  namespace_id text NOT NULL REFERENCES occ.namespaces(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  principal_ref text NOT NULL,
  account_ref text NOT NULL,
  operation_ref text NOT NULL,
  record jsonb NOT NULL,
  CONSTRAINT workload_profile_operations_pk PRIMARY KEY (installation_id,principal_ref,operation_ref),
  CONSTRAINT workload_profile_operation_ref CHECK ("operation_ref" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT workload_profile_actor CHECK (
          octet_length("account_ref") BETWEEN 1 AND 1024
          AND octet_length("principal_ref") BETWEEN 1 AND 1024
          AND "account_ref" !~ ('[[:cntrl:]' || chr(127) || '-' || chr(159) || ']')
          AND "principal_ref" !~ ('[[:cntrl:]' || chr(127) || '-' || chr(159) || ']')),
  CONSTRAINT workload_profile_record_shape CHECK ((
          "record" = jsonb_build_object(
            'schemaVersion', 1, 'kind', 'inert-profile-preparation',
            'scope', jsonb_build_object('installationId', "installation_id",
              'namespaceId', "namespace_id", 'component', 'harness'),
            'actor', jsonb_build_object('principalRef', "principal_ref", 'accountRef', "account_ref"),
            'operationRef', "operation_ref", 'action', "record"->>'action',
            'canonicalClientIntent', ("record"->>'canonicalClientIntent'), 'clientIntentDigest', "record"->>'clientIntentDigest',
            'allocated', ("record"->'allocated'), 'canonicalOperation', ("record"->>'canonicalOperation'),
            'operationDigest', "record"->>'operationDigest', 'preparedAt', "record"->>'preparedAt')
          AND "record"->>'action' IN ('admit', 'replace')
          AND "record"->>'preparedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
          AND octet_length("record"::text) BETWEEN 1 AND 270336
          AND octet_length(("record"->>'canonicalClientIntent')) BETWEEN 1 AND 65536
          AND octet_length(("record"->>'canonicalOperation')) BETWEEN 1 AND 65536
          AND "record"->>'clientIntentDigest' ~ '^sha256:[0-9a-f]{64}$'
          AND "record"->>'operationDigest' ~ '^sha256:[0-9a-f]{64}$'
        ) IS TRUE),
  CONSTRAINT workload_profile_prepared_at CHECK ((
          make_date(
            CASE substring("record"->>'preparedAt', 1, 4)::integer WHEN 0 THEN -1
              ELSE substring("record"->>'preparedAt', 1, 4)::integer END,
            substring("record"->>'preparedAt', 6, 2)::integer,
            substring("record"->>'preparedAt', 9, 2)::integer) IS NOT NULL
          AND substring("record"->>'preparedAt', 12, 2)::integer BETWEEN 0 AND 23
          AND substring("record"->>'preparedAt', 15, 2)::integer BETWEEN 0 AND 59
          AND substring("record"->>'preparedAt', 18, 2)::integer BETWEEN 0 AND 59
        ) IS TRUE),
  CONSTRAINT workload_profile_allocations CHECK ((
          ("record"->'allocated') = jsonb_build_object('manifestRef', ("record"->'allocated')->>'manifestRef', 'admissionRef', ("record"->'allocated')->>'admissionRef', 'providerRef', ("record"->'allocated')->>'providerRef', 'runtimeRef', ("record"->'allocated')->>'runtimeRef', 'identityRef', ("record"->'allocated')->>'identityRef', 'containmentRef', ("record"->'allocated')->>'containmentRef', 'storageRef', ("record"->'allocated')->>'storageRef', 'historyRef', ("record"->'allocated')->>'historyRef', 'auditRef', ("record"->'allocated')->>'auditRef', 'terminalTemplateRef', ("record"->'allocated')->>'terminalTemplateRef', 'terminalHistoryRef', ("record"->'allocated')->>'terminalHistoryRef', 'terminalAuditRef', ("record"->'allocated')->>'terminalAuditRef', 'terminalInvalidationRef', ("record"->'allocated')->>'terminalInvalidationRef')
          AND ("record"->'allocated')->>'manifestRef' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ("record"->'allocated')->>'admissionRef' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ("record"->'allocated')->>'providerRef' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ("record"->'allocated')->>'runtimeRef' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ("record"->'allocated')->>'identityRef' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ("record"->'allocated')->>'containmentRef' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ("record"->'allocated')->>'storageRef' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ("record"->'allocated')->>'historyRef' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ("record"->'allocated')->>'auditRef' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ("record"->'allocated')->>'terminalTemplateRef' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ("record"->'allocated')->>'terminalHistoryRef' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ("record"->'allocated')->>'terminalAuditRef' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ("record"->'allocated')->>'terminalInvalidationRef' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND ("record"->'allocated')->>'manifestRef' <> ("record"->'allocated')->>'admissionRef' AND ("record"->'allocated')->>'manifestRef' <> ("record"->'allocated')->>'providerRef' AND ("record"->'allocated')->>'manifestRef' <> ("record"->'allocated')->>'runtimeRef' AND ("record"->'allocated')->>'manifestRef' <> ("record"->'allocated')->>'identityRef' AND ("record"->'allocated')->>'manifestRef' <> ("record"->'allocated')->>'containmentRef' AND ("record"->'allocated')->>'manifestRef' <> ("record"->'allocated')->>'storageRef' AND ("record"->'allocated')->>'manifestRef' <> ("record"->'allocated')->>'historyRef' AND ("record"->'allocated')->>'manifestRef' <> ("record"->'allocated')->>'auditRef' AND ("record"->'allocated')->>'manifestRef' <> ("record"->'allocated')->>'terminalTemplateRef' AND ("record"->'allocated')->>'manifestRef' <> ("record"->'allocated')->>'terminalHistoryRef' AND ("record"->'allocated')->>'manifestRef' <> ("record"->'allocated')->>'terminalAuditRef' AND ("record"->'allocated')->>'manifestRef' <> ("record"->'allocated')->>'terminalInvalidationRef' AND ("record"->'allocated')->>'admissionRef' <> ("record"->'allocated')->>'providerRef' AND ("record"->'allocated')->>'admissionRef' <> ("record"->'allocated')->>'runtimeRef' AND ("record"->'allocated')->>'admissionRef' <> ("record"->'allocated')->>'identityRef' AND ("record"->'allocated')->>'admissionRef' <> ("record"->'allocated')->>'containmentRef' AND ("record"->'allocated')->>'admissionRef' <> ("record"->'allocated')->>'storageRef' AND ("record"->'allocated')->>'admissionRef' <> ("record"->'allocated')->>'historyRef' AND ("record"->'allocated')->>'admissionRef' <> ("record"->'allocated')->>'auditRef' AND ("record"->'allocated')->>'admissionRef' <> ("record"->'allocated')->>'terminalTemplateRef' AND ("record"->'allocated')->>'admissionRef' <> ("record"->'allocated')->>'terminalHistoryRef' AND ("record"->'allocated')->>'admissionRef' <> ("record"->'allocated')->>'terminalAuditRef' AND ("record"->'allocated')->>'admissionRef' <> ("record"->'allocated')->>'terminalInvalidationRef' AND ("record"->'allocated')->>'providerRef' <> ("record"->'allocated')->>'runtimeRef' AND ("record"->'allocated')->>'providerRef' <> ("record"->'allocated')->>'identityRef' AND ("record"->'allocated')->>'providerRef' <> ("record"->'allocated')->>'containmentRef' AND ("record"->'allocated')->>'providerRef' <> ("record"->'allocated')->>'storageRef' AND ("record"->'allocated')->>'providerRef' <> ("record"->'allocated')->>'historyRef' AND ("record"->'allocated')->>'providerRef' <> ("record"->'allocated')->>'auditRef' AND ("record"->'allocated')->>'providerRef' <> ("record"->'allocated')->>'terminalTemplateRef' AND ("record"->'allocated')->>'providerRef' <> ("record"->'allocated')->>'terminalHistoryRef' AND ("record"->'allocated')->>'providerRef' <> ("record"->'allocated')->>'terminalAuditRef' AND ("record"->'allocated')->>'providerRef' <> ("record"->'allocated')->>'terminalInvalidationRef' AND ("record"->'allocated')->>'runtimeRef' <> ("record"->'allocated')->>'identityRef' AND ("record"->'allocated')->>'runtimeRef' <> ("record"->'allocated')->>'containmentRef' AND ("record"->'allocated')->>'runtimeRef' <> ("record"->'allocated')->>'storageRef' AND ("record"->'allocated')->>'runtimeRef' <> ("record"->'allocated')->>'historyRef' AND ("record"->'allocated')->>'runtimeRef' <> ("record"->'allocated')->>'auditRef' AND ("record"->'allocated')->>'runtimeRef' <> ("record"->'allocated')->>'terminalTemplateRef' AND ("record"->'allocated')->>'runtimeRef' <> ("record"->'allocated')->>'terminalHistoryRef' AND ("record"->'allocated')->>'runtimeRef' <> ("record"->'allocated')->>'terminalAuditRef' AND ("record"->'allocated')->>'runtimeRef' <> ("record"->'allocated')->>'terminalInvalidationRef' AND ("record"->'allocated')->>'identityRef' <> ("record"->'allocated')->>'containmentRef' AND ("record"->'allocated')->>'identityRef' <> ("record"->'allocated')->>'storageRef' AND ("record"->'allocated')->>'identityRef' <> ("record"->'allocated')->>'historyRef' AND ("record"->'allocated')->>'identityRef' <> ("record"->'allocated')->>'auditRef' AND ("record"->'allocated')->>'identityRef' <> ("record"->'allocated')->>'terminalTemplateRef' AND ("record"->'allocated')->>'identityRef' <> ("record"->'allocated')->>'terminalHistoryRef' AND ("record"->'allocated')->>'identityRef' <> ("record"->'allocated')->>'terminalAuditRef' AND ("record"->'allocated')->>'identityRef' <> ("record"->'allocated')->>'terminalInvalidationRef' AND ("record"->'allocated')->>'containmentRef' <> ("record"->'allocated')->>'storageRef' AND ("record"->'allocated')->>'containmentRef' <> ("record"->'allocated')->>'historyRef' AND ("record"->'allocated')->>'containmentRef' <> ("record"->'allocated')->>'auditRef' AND ("record"->'allocated')->>'containmentRef' <> ("record"->'allocated')->>'terminalTemplateRef' AND ("record"->'allocated')->>'containmentRef' <> ("record"->'allocated')->>'terminalHistoryRef' AND ("record"->'allocated')->>'containmentRef' <> ("record"->'allocated')->>'terminalAuditRef' AND ("record"->'allocated')->>'containmentRef' <> ("record"->'allocated')->>'terminalInvalidationRef' AND ("record"->'allocated')->>'storageRef' <> ("record"->'allocated')->>'historyRef' AND ("record"->'allocated')->>'storageRef' <> ("record"->'allocated')->>'auditRef' AND ("record"->'allocated')->>'storageRef' <> ("record"->'allocated')->>'terminalTemplateRef' AND ("record"->'allocated')->>'storageRef' <> ("record"->'allocated')->>'terminalHistoryRef' AND ("record"->'allocated')->>'storageRef' <> ("record"->'allocated')->>'terminalAuditRef' AND ("record"->'allocated')->>'storageRef' <> ("record"->'allocated')->>'terminalInvalidationRef' AND ("record"->'allocated')->>'historyRef' <> ("record"->'allocated')->>'auditRef' AND ("record"->'allocated')->>'historyRef' <> ("record"->'allocated')->>'terminalTemplateRef' AND ("record"->'allocated')->>'historyRef' <> ("record"->'allocated')->>'terminalHistoryRef' AND ("record"->'allocated')->>'historyRef' <> ("record"->'allocated')->>'terminalAuditRef' AND ("record"->'allocated')->>'historyRef' <> ("record"->'allocated')->>'terminalInvalidationRef' AND ("record"->'allocated')->>'auditRef' <> ("record"->'allocated')->>'terminalTemplateRef' AND ("record"->'allocated')->>'auditRef' <> ("record"->'allocated')->>'terminalHistoryRef' AND ("record"->'allocated')->>'auditRef' <> ("record"->'allocated')->>'terminalAuditRef' AND ("record"->'allocated')->>'auditRef' <> ("record"->'allocated')->>'terminalInvalidationRef' AND ("record"->'allocated')->>'terminalTemplateRef' <> ("record"->'allocated')->>'terminalHistoryRef' AND ("record"->'allocated')->>'terminalTemplateRef' <> ("record"->'allocated')->>'terminalAuditRef' AND ("record"->'allocated')->>'terminalTemplateRef' <> ("record"->'allocated')->>'terminalInvalidationRef' AND ("record"->'allocated')->>'terminalHistoryRef' <> ("record"->'allocated')->>'terminalAuditRef' AND ("record"->'allocated')->>'terminalHistoryRef' <> ("record"->'allocated')->>'terminalInvalidationRef' AND ("record"->'allocated')->>'terminalAuditRef' <> ("record"->'allocated')->>'terminalInvalidationRef'
        ) IS TRUE),
  CONSTRAINT workload_profile_intent CHECK ((
          (("record"->>'canonicalClientIntent')::jsonb) = jsonb_build_object('schemaVersion', 1, 'operationRef', "operation_ref",
            'namespaceId', "namespace_id", 'component', 'harness',
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
        ) IS TRUE),
  CONSTRAINT workload_profile_operation_envelope CHECK ((
          ("record"->>'canonicalOperation')::jsonb = jsonb_build_object('schemaVersion', 1,
            'kind', 'inert-profile-preparation', 'scope', "record"->'scope', 'actor', "record"->'actor',
            'operationRef', "operation_ref", 'action', "record"->>'action',
            'clientIntentDigest', "record"->>'clientIntentDigest', 'allocated', ("record"->'allocated'),
            'preparedAt', "record"->>'preparedAt')
          AND "record"->>'operationDigest' = 'sha256:' || encode(sha256(convert_to('oce.workload-profile.operator-operation.v1
' || ("record"->>'canonicalOperation'), 'UTF8')), 'hex')
        ) IS TRUE)
);
--> statement-breakpoint
-- Each same-kind reserved identity belongs to one retained preparation.
CREATE UNIQUE INDEX "workload_profile_manifestRef_unique" ON occ.workload_profile_operations (installation_id, (record->'allocated'->>'manifestRef'));
CREATE UNIQUE INDEX "workload_profile_admissionRef_unique" ON occ.workload_profile_operations (installation_id, (record->'allocated'->>'admissionRef'));
CREATE UNIQUE INDEX "workload_profile_providerRef_unique" ON occ.workload_profile_operations (installation_id, (record->'allocated'->>'providerRef'));
CREATE UNIQUE INDEX "workload_profile_runtimeRef_unique" ON occ.workload_profile_operations (installation_id, (record->'allocated'->>'runtimeRef'));
CREATE UNIQUE INDEX "workload_profile_identityRef_unique" ON occ.workload_profile_operations (installation_id, (record->'allocated'->>'identityRef'));
CREATE UNIQUE INDEX "workload_profile_containmentRef_unique" ON occ.workload_profile_operations (installation_id, (record->'allocated'->>'containmentRef'));
CREATE UNIQUE INDEX "workload_profile_storageRef_unique" ON occ.workload_profile_operations (installation_id, (record->'allocated'->>'storageRef'));
CREATE UNIQUE INDEX "workload_profile_historyRef_unique" ON occ.workload_profile_operations (installation_id, (record->'allocated'->>'historyRef'));
CREATE UNIQUE INDEX "workload_profile_auditRef_unique" ON occ.workload_profile_operations (installation_id, (record->'allocated'->>'auditRef'));
CREATE UNIQUE INDEX "workload_profile_terminalTemplateRef_unique" ON occ.workload_profile_operations (installation_id, (record->'allocated'->>'terminalTemplateRef'));
CREATE UNIQUE INDEX "workload_profile_terminalHistoryRef_unique" ON occ.workload_profile_operations (installation_id, (record->'allocated'->>'terminalHistoryRef'));
CREATE UNIQUE INDEX "workload_profile_terminalAuditRef_unique" ON occ.workload_profile_operations (installation_id, (record->'allocated'->>'terminalAuditRef'));
CREATE UNIQUE INDEX "workload_profile_terminalInvalidationRef_unique" ON occ.workload_profile_operations (installation_id, (record->'allocated'->>'terminalInvalidationRef'));
--> statement-breakpoint
-- Match the shared bounded lexical domain; full selected-manifest semantics remain
-- the repository decoder's responsibility. Count all values, including containers.
CREATE FUNCTION occ.workload_profile_json_nodes(value jsonb, allow_null boolean, depth integer DEFAULT 0)
RETURNS integer LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; property text; count_value integer := 1; entries integer;
BEGIN
  IF value IS NULL THEN RAISE EXCEPTION 'profile JSON missing' USING ERRCODE='23514'; END IF;
  CASE jsonb_typeof(value)
  WHEN 'object' THEN
    SELECT count(*) INTO entries FROM jsonb_object_keys(value);
    IF depth>=32 OR entries>1024 THEN RAISE EXCEPTION 'profile JSON bounds' USING ERRCODE='23514'; END IF;
    FOR property,item IN SELECT * FROM jsonb_each(value) LOOP
      IF octet_length(property)<>char_length(property) OR octet_length(property)>65536 THEN
        RAISE EXCEPTION 'profile JSON key' USING ERRCODE='23514';
      END IF;
      count_value:=count_value+occ.workload_profile_json_nodes(item,allow_null,depth+1);
      IF count_value>8192 THEN RAISE EXCEPTION 'profile JSON nodes' USING ERRCODE='23514'; END IF;
    END LOOP;
  WHEN 'array' THEN
    IF depth>=32 OR jsonb_array_length(value)>1024 THEN RAISE EXCEPTION 'profile JSON bounds' USING ERRCODE='23514'; END IF;
    FOR item IN SELECT jsonb_array_elements(value) LOOP
      count_value:=count_value+occ.workload_profile_json_nodes(item,allow_null,depth+1);
      IF count_value>8192 THEN RAISE EXCEPTION 'profile JSON nodes' USING ERRCODE='23514'; END IF;
    END LOOP;
  WHEN 'number' THEN
    IF value::numeric<>trunc(value::numeric) OR value::numeric<0 OR value::numeric>9007199254740991 THEN
      RAISE EXCEPTION 'profile JSON integer' USING ERRCODE='23514';
    END IF;
  WHEN 'null' THEN
    IF NOT allow_null THEN RAISE EXCEPTION 'profile manifest null' USING ERRCODE='23514'; END IF;
  ELSE NULL;
  END CASE;
  RETURN count_value;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.validate_workload_profile_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intent jsonb:= (NEW.record->>'canonicalClientIntent')::jsonb;
  operation jsonb:= (NEW.record->>'canonicalOperation')::jsonb;
  manifest_text text:=intent#>>'{manifest,canonicalUtf8}';
  manifest jsonb:=manifest_text::jsonb;
BEGIN
  PERFORM occ.workload_profile_json_nodes(intent,true);
  PERFORM occ.workload_profile_json_nodes(operation,true);
  PERFORM occ.workload_profile_json_nodes(manifest,false);
  IF NEW.record->>'canonicalClientIntent' IS DISTINCT FROM occ.runtime_preparation_canonical(intent)
    OR NEW.record->>'canonicalOperation' IS DISTINCT FROM occ.runtime_preparation_canonical(operation)
    OR manifest_text IS DISTINCT FROM occ.runtime_preparation_canonical(manifest) THEN
    RAISE EXCEPTION 'profile canonical bytes differ' USING ERRCODE='23514';
  END IF;
  -- The owner already holds capacity -> operation -> Namespace. Direct app writes
  -- must also retain a capacity row, an eligible Namespace and a matching charge.
  PERFORM installation_id FROM occ.workload_profile_capacity WHERE installation_id=NEW.installation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile capacity missing' USING ERRCODE='23514'; END IF;
  PERFORM id FROM occ.namespaces WHERE id=NEW.namespace_id AND status='ready' AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'profile Namespace unavailable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RAISE EXCEPTION 'profile persisted JSON invalid' USING ERRCODE='23514';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.validate_workload_profile_capacity_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.ordinary_operations<>0 OR NEW.pending_ordinary_operations<>0 OR NEW.terminal_slots<>0 THEN
      RAISE EXCEPTION 'profile capacity must start empty' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.installation_id<>OLD.installation_id OR NEW.ordinary_operations<>OLD.ordinary_operations+1
      OR NEW.pending_ordinary_operations<>OLD.pending_ordinary_operations+1 OR NEW.terminal_slots<>0 THEN
      RAISE EXCEPTION 'profile capacity only permits one inert preparation charge' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.check_workload_profile_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE capacity occ.workload_profile_capacity%ROWTYPE; retained bigint;
BEGIN
  SELECT * INTO capacity FROM occ.workload_profile_capacity WHERE installation_id=NEW.installation_id;
  SELECT count(*) INTO retained FROM occ.workload_profile_operations WHERE installation_id=NEW.installation_id;
  IF capacity.installation_id IS NULL OR capacity.ordinary_operations<>retained
    OR capacity.pending_ordinary_operations<>retained OR capacity.terminal_slots<>0 THEN
    RAISE EXCEPTION 'profile retained history and capacity differ' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER workload_profile_prepare_valid BEFORE INSERT ON occ.workload_profile_operations
  FOR EACH ROW EXECUTE FUNCTION occ.validate_workload_profile_preparation();
CREATE TRIGGER workload_profile_prepare_immutable BEFORE UPDATE OR DELETE ON occ.workload_profile_operations
  FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
CREATE TRIGGER workload_profile_capacity_change BEFORE INSERT OR UPDATE ON occ.workload_profile_capacity
  FOR EACH ROW EXECUTE FUNCTION occ.validate_workload_profile_capacity_change();
CREATE TRIGGER workload_profile_capacity_retained BEFORE DELETE ON occ.workload_profile_capacity
  FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
CREATE CONSTRAINT TRIGGER workload_profile_operation_charge AFTER INSERT ON occ.workload_profile_operations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occ.check_workload_profile_capacity();
CREATE CONSTRAINT TRIGGER workload_profile_capacity_exact AFTER INSERT OR UPDATE ON occ.workload_profile_capacity
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occ.check_workload_profile_capacity();
--> statement-breakpoint
REVOKE ALL ON occ.workload_profile_operations,occ.workload_profile_capacity FROM PUBLIC,occ_app;
GRANT SELECT,INSERT ON occ.workload_profile_operations TO occ_app;
GRANT SELECT,INSERT,UPDATE ON occ.workload_profile_capacity TO occ_app;
REVOKE ALL ON FUNCTION occ.validate_workload_profile_preparation(),occ.validate_workload_profile_capacity_change(),occ.check_workload_profile_capacity() FROM PUBLIC,occ_app;
REVOKE ALL ON FUNCTION occ.workload_profile_json_nodes(jsonb,boolean,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.workload_profile_json_nodes(jsonb,boolean,integer) TO occ_app;
