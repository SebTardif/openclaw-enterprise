CREATE TABLE occ.gateway_startup_operations (
  installation_id text NOT NULL REFERENCES occ.installation(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  operation_ref text PRIMARY KEY,
  operation_digest text NOT NULL,
  canonical_command text NOT NULL,
  kind text NOT NULL,
  startup_operation_ref text NOT NULL,
  startup_operation_digest text NOT NULL,
  process_ref text NOT NULL,
  process_generation bigint NOT NULL,
  create_effect_ref text NOT NULL,
  before_head_version bigint NOT NULL,
  after_head_version bigint NOT NULL,
  before_record_version bigint NOT NULL,
  after_record_version bigint NOT NULL,
  previous_operation_ref text,
  audit_event_id text NOT NULL REFERENCES occ.audit_events(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  record jsonb NOT NULL,
  CONSTRAINT gateway_startup_operation_bounds CHECK ((kind IN ('accept-startup','submit-create','consume-startup','withdraw')
 AND operation_digest ~ '^[0-9a-f]{64}$' AND startup_operation_digest ~ '^[0-9a-f]{64}$'
 AND process_generation BETWEEN 1 AND 9007199254740991
 AND before_head_version BETWEEN 0 AND 9007199254740990 AND after_head_version=before_head_version+1
 AND (previous_operation_ref IS NULL)=(before_head_version=0)
 AND ((kind='accept-startup' AND before_record_version=0 AND after_record_version=1)
 OR (kind='submit-create' AND before_record_version=1 AND after_record_version=2)
 OR (kind='consume-startup' AND before_record_version=2 AND after_record_version=3)
 OR (kind='withdraw' AND before_record_version BETWEEN 1 AND 3 AND after_record_version=before_record_version+1))
 AND octet_length(canonical_command) BETWEEN 1 AND 262144
 AND octet_length(record::text) BETWEEN 1 AND 524288) IS TRUE),
  CONSTRAINT gateway_startup_refs CHECK (((char_length(operation_ref) BETWEEN 1 AND 512 AND octet_length(operation_ref)<=2048 AND operation_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND (char_length(startup_operation_ref) BETWEEN 1 AND 512 AND octet_length(startup_operation_ref)<=2048 AND startup_operation_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND (char_length(process_ref) BETWEEN 1 AND 512 AND octet_length(process_ref)<=2048 AND process_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND (char_length(create_effect_ref) BETWEEN 1 AND 512 AND octet_length(create_effect_ref)<=2048 AND create_effect_ref !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) AND (previous_operation_ref IS NULL OR (char_length(previous_operation_ref) BETWEEN 1 AND 512 AND octet_length(previous_operation_ref)<=2048))) IS TRUE),
  CONSTRAINT gateway_startup_command_digest CHECK ((operation_digest=encode(sha256(convert_to('{"command":'||canonical_command||',"domain":"oce.installation-gateway.startup-operation.v1"}', 'UTF8')), 'hex')) IS TRUE),
  CONSTRAINT gateway_startup_record_core CHECK ((record=jsonb_build_object('kind',kind,'command',jsonb_build_object('installationId',installation_id,'operationRef',operation_ref,'operationDigest',operation_digest,'startup',CASE WHEN kind='accept-startup' THEN 'null'::jsonb ELSE jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest) END),'canonicalCommand',canonical_command,'beforeHeadVersion',before_head_version,'afterHeadVersion',after_head_version,'beforeRecordVersion',before_record_version,'afterRecordVersion',after_record_version,'previousOperationRef',previous_operation_ref,'startup',jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'createEffectRef',create_effect_ref,'acceptance',record->'acceptance','submissionInput',record->'submissionInput','recipient',record->'recipient','withdrawalReason',record->'withdrawalReason','auditEventId',audit_event_id)) IS TRUE),
  CONSTRAINT gateway_startup_command_core CHECK ((CASE kind
 WHEN 'accept-startup' THEN (canonical_command::jsonb)=jsonb_build_object('schemaVersion',1,'kind',kind,'operationRef',operation_ref,'expectedHead',(canonical_command::jsonb)->'expectedHead','selectedDefinition',(canonical_command::jsonb)->'selectedDefinition','predecessorDisposition',(canonical_command::jsonb)->'predecessorDisposition')
 WHEN 'submit-create' THEN (canonical_command::jsonb)=jsonb_build_object('schemaVersion',1,'kind',kind,'operationRef',operation_ref,'startup',jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'expectedHead',(canonical_command::jsonb)->'expectedHead','input',record->'submissionInput')
 WHEN 'consume-startup' THEN (canonical_command::jsonb)=jsonb_build_object('schemaVersion',1,'kind',kind,'operationRef',operation_ref,'startup',jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'expectedHead',(canonical_command::jsonb)->'expectedHead','recipient',record->'recipient')
 WHEN 'withdraw' THEN (canonical_command::jsonb)=jsonb_build_object('schemaVersion',1,'kind',kind,'operationRef',operation_ref,'startup',jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest),'expectedHead',(canonical_command::jsonb)->'expectedHead','reason',record->'withdrawalReason') ELSE false END) IS TRUE),
  CONSTRAINT gateway_startup_variant CHECK ((CASE kind
 WHEN 'accept-startup' THEN startup_operation_ref=operation_ref AND startup_operation_digest=operation_digest
 AND record->'acceptance'=jsonb_build_object('binding',record#>'{acceptance,binding}','predecessor',record#>'{acceptance,predecessor}','auditEventId',audit_event_id)
 AND record#>'{acceptance,binding,startup}'=jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest)
 AND record#>'{acceptance,binding,createEffectRef}'=to_jsonb(create_effect_ref)
 AND record#>'{acceptance,binding,selection}'=(canonical_command::jsonb)->'selectedDefinition'
 AND record#>'{acceptance,predecessor,disposition}'=(canonical_command::jsonb)->'predecessorDisposition'
 AND record#>'{acceptance,predecessor}'=jsonb_build_object('disposition',record#>'{acceptance,predecessor,disposition}','previousStartup',record#>'{acceptance,predecessor,previousStartup}','processOwner',record#>'{acceptance,predecessor,processOwner}','settlement',record#>'{acceptance,predecessor,settlement}')
 AND record->'submissionInput'='null'::jsonb AND record->'recipient'='null'::jsonb AND record->'withdrawalReason'='null'::jsonb
 WHEN 'submit-create' THEN record->'acceptance'='null'::jsonb AND record->'recipient'='null'::jsonb AND record->'withdrawalReason'='null'::jsonb
 AND record->'submissionInput'=jsonb_build_object('binding',record#>'{submissionInput,binding}','target',record#>'{submissionInput,target}','launchPlan',record#>'{submissionInput,launchPlan}')
 AND record#>'{submissionInput,binding,startup}'=jsonb_build_object('installationId',installation_id,'processRef',process_ref,'processGeneration',process_generation,'operationRef',startup_operation_ref,'operationDigest',startup_operation_digest) AND record#>'{submissionInput,binding,createEffectRef}'=to_jsonb(create_effect_ref)
 WHEN 'consume-startup' THEN record->'acceptance'='null'::jsonb AND record->'submissionInput'='null'::jsonb AND record->'withdrawalReason'='null'::jsonb AND jsonb_typeof(record->'recipient')='object'
 WHEN 'withdraw' THEN record->'acceptance'='null'::jsonb AND record->'submissionInput'='null'::jsonb AND record->'recipient'='null'::jsonb AND record->>'withdrawalReason' IN ('administrative','selection-withdrawn','recipient-revoked')
 ELSE false END) IS TRUE),
 CONSTRAINT gateway_startup_operation_scope UNIQUE(installation_id,operation_ref),
 CONSTRAINT gateway_startup_operation_version UNIQUE(installation_id,operation_ref,after_head_version),
 CONSTRAINT gateway_startup_head_version_unique UNIQUE(installation_id,after_head_version),
 CONSTRAINT gateway_startup_audit_unique UNIQUE(audit_event_id)
);
--> statement-breakpoint
CREATE TABLE occ.gateway_startup_heads (
  installation_id text PRIMARY KEY REFERENCES occ.installation(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  head_version bigint NOT NULL,
  process_generation bigint NOT NULL,
  latest_operation_ref text,
  startup_operation_ref text,
  record_version bigint NOT NULL,
  state text NOT NULL,
  CONSTRAINT gateway_startup_head_shape CHECK (((state='empty' AND head_version=0 AND process_generation=0 AND latest_operation_ref IS NULL AND startup_operation_ref IS NULL AND record_version=0)
 OR (head_version BETWEEN 1 AND 9007199254740991 AND process_generation BETWEEN 1 AND 9007199254740991 AND latest_operation_ref IS NOT NULL AND startup_operation_ref IS NOT NULL AND ((state='accepted' AND record_version=1) OR (state='create-submitted' AND record_version=2) OR (state='consumed' AND record_version=3) OR (state='withdrawn' AND record_version BETWEEN 2 AND 4)))) IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX gateway_startup_generation_unique ON occ.gateway_startup_operations(installation_id,process_generation) WHERE kind='accept-startup';
--> statement-breakpoint
CREATE UNIQUE INDEX gateway_startup_process_unique ON occ.gateway_startup_operations(process_ref) WHERE kind='accept-startup';
--> statement-breakpoint
CREATE UNIQUE INDEX gateway_startup_effect_unique ON occ.gateway_startup_operations(create_effect_ref) WHERE kind='accept-startup';
--> statement-breakpoint
CREATE UNIQUE INDEX gateway_startup_submission_unique ON occ.gateway_startup_operations(installation_id,startup_operation_ref) WHERE kind='submit-create';
--> statement-breakpoint
CREATE UNIQUE INDEX gateway_startup_consume_unique ON occ.gateway_startup_operations(installation_id,startup_operation_ref) WHERE kind='consume-startup';
--> statement-breakpoint
CREATE UNIQUE INDEX gateway_startup_withdraw_unique ON occ.gateway_startup_operations(installation_id,startup_operation_ref) WHERE kind='withdraw';
--> statement-breakpoint
ALTER TABLE occ.gateway_startup_operations ADD CONSTRAINT gateway_startup_operations_startup_fk FOREIGN KEY(installation_id,startup_operation_ref) REFERENCES occ.gateway_startup_operations(installation_id,operation_ref) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE occ.gateway_startup_operations ADD CONSTRAINT gateway_startup_operations_predecessor_fk FOREIGN KEY(installation_id,previous_operation_ref,before_head_version) REFERENCES occ.gateway_startup_operations(installation_id,operation_ref,after_head_version) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE occ.gateway_startup_heads ADD CONSTRAINT gateway_startup_heads_latest_fk FOREIGN KEY(installation_id,latest_operation_ref,head_version) REFERENCES occ.gateway_startup_operations(installation_id,operation_ref,after_head_version) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE occ.gateway_startup_heads ADD CONSTRAINT gateway_startup_heads_startup_fk FOREIGN KEY(installation_id,startup_operation_ref) REFERENCES occ.gateway_startup_operations(installation_id,operation_ref) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE FUNCTION occ.guard_gateway_startup_operation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $gateway$
DECLARE
  h occ.gateway_startup_heads%ROWTYPE;
  p occ.gateway_startup_operations%ROWTYPE;
  a occ.gateway_startup_operations%ROWTYPE;
  expected_head jsonb;
  c jsonb := NEW.canonical_command::jsonb;
BEGIN
  SELECT * INTO h FROM occ.gateway_startup_heads
    WHERE installation_id=NEW.installation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Gateway startup head missing' USING ERRCODE='23514';
  END IF;
  IF NEW.before_head_version IS DISTINCT FROM h.head_version
     OR NEW.previous_operation_ref IS DISTINCT FROM h.latest_operation_ref
     OR NEW.after_head_version IS DISTINCT FROM h.head_version+1
  THEN
    RAISE EXCEPTION 'Gateway startup predecessor mismatch' USING ERRCODE='23514';
  END IF;

  IF h.state='empty' THEN
    expected_head := 'null'::jsonb;
  ELSE
    SELECT * INTO p FROM occ.gateway_startup_operations
      WHERE installation_id=h.installation_id
        AND operation_ref=h.latest_operation_ref;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Gateway startup predecessor missing' USING ERRCODE='23514';
    END IF;
    expected_head := jsonb_build_object(
      'version',h.head_version,'startup',p.record->'startup',
      'recordVersion',h.record_version);
  END IF;
  IF c->'expectedHead' IS DISTINCT FROM expected_head THEN
    RAISE EXCEPTION 'Gateway startup expectation mismatch' USING ERRCODE='23514';
  END IF;

  IF NEW.kind='accept-startup' THEN
    IF h.state NOT IN ('empty','withdrawn')
       OR NEW.process_generation IS DISTINCT FROM h.process_generation+1
       OR NEW.before_record_version<>0 OR NEW.after_record_version<>1
       OR NEW.startup_operation_ref IS DISTINCT FROM NEW.operation_ref
       OR NEW.startup_operation_digest IS DISTINCT FROM NEW.operation_digest
    THEN
      RAISE EXCEPTION 'Gateway startup allocation mismatch' USING ERRCODE='23514';
    END IF;
    IF NEW.record#>'{acceptance,predecessor,previousStartup}'
       IS DISTINCT FROM
       (CASE WHEN h.state='empty' THEN 'null'::jsonb ELSE p.record->'startup' END)
    THEN
      RAISE EXCEPTION 'Gateway startup disposition target mismatch'
        USING ERRCODE='23514';
    END IF;
  ELSE
    IF h.state IN ('empty','withdrawn')
       OR NEW.startup_operation_ref IS DISTINCT FROM h.startup_operation_ref
       OR NEW.process_generation IS DISTINCT FROM h.process_generation
       OR NEW.before_record_version IS DISTINCT FROM h.record_version
       OR NEW.after_record_version IS DISTINCT FROM h.record_version+1
    THEN
      RAISE EXCEPTION 'Gateway startup transition mismatch' USING ERRCODE='23514';
    END IF;
    SELECT * INTO a FROM occ.gateway_startup_operations
      WHERE installation_id=NEW.installation_id
        AND operation_ref=NEW.startup_operation_ref
        AND kind='accept-startup';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Gateway startup acceptance missing' USING ERRCODE='23514';
    END IF;
    IF NEW.record->'startup' IS DISTINCT FROM a.record->'startup'
       OR NEW.create_effect_ref IS DISTINCT FROM a.create_effect_ref
    THEN
      RAISE EXCEPTION 'Gateway startup identity mismatch' USING ERRCODE='23514';
    END IF;
    CASE NEW.kind
    WHEN 'submit-create' THEN
      IF h.state<>'accepted' OR h.record_version<>1
         OR NEW.record#>'{submissionInput,binding}'
           IS DISTINCT FROM a.record#>'{acceptance,binding}'
      THEN
        RAISE EXCEPTION 'Gateway startup submission mismatch' USING ERRCODE='23514';
      END IF;
    WHEN 'consume-startup' THEN
      IF h.state<>'create-submitted' OR h.record_version<>2
         OR p.kind<>'submit-create'
      THEN
        RAISE EXCEPTION 'Gateway startup consumption mismatch' USING ERRCODE='23514';
      END IF;
    WHEN 'withdraw' THEN
      IF h.state NOT IN ('accepted','create-submitted','consumed')
         OR h.record_version NOT IN (1,2,3)
      THEN
        RAISE EXCEPTION 'Gateway startup withdrawal mismatch' USING ERRCODE='23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'Gateway startup kind mismatch' USING ERRCODE='23514';
    END CASE;
  END IF;
  RETURN NEW;
END;
$gateway$;
--> statement-breakpoint
CREATE FUNCTION occ.guard_gateway_startup_head() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $gateway$
DECLARE e occ.gateway_startup_operations%ROWTYPE; expected_state text;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT (NEW.head_version=0 AND NEW.process_generation=0 AND NEW.latest_operation_ref IS NULL AND NEW.startup_operation_ref IS NULL AND NEW.record_version=0 AND NEW.state='empty') THEN
   RAISE EXCEPTION 'Gateway startup head must begin empty' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.installation_id IS DISTINCT FROM OLD.installation_id OR NEW.head_version IS DISTINCT FROM OLD.head_version+1 THEN
  RAISE EXCEPTION 'Gateway startup head mutation mismatch' USING ERRCODE='23514';
 END IF;
 SELECT * INTO e FROM occ.gateway_startup_operations WHERE installation_id=NEW.installation_id AND operation_ref=NEW.latest_operation_ref;
 IF NOT FOUND THEN RAISE EXCEPTION 'Gateway startup event missing' USING ERRCODE='23514'; END IF;
 expected_state:=CASE e.kind WHEN 'accept-startup' THEN 'accepted' WHEN 'submit-create' THEN 'create-submitted' WHEN 'consume-startup' THEN 'consumed' ELSE 'withdrawn' END;
 IF e.before_head_version IS DISTINCT FROM OLD.head_version OR e.previous_operation_ref IS DISTINCT FROM OLD.latest_operation_ref
 OR NEW.head_version IS DISTINCT FROM e.after_head_version OR NEW.process_generation IS DISTINCT FROM e.process_generation
 OR NEW.record_version IS DISTINCT FROM e.after_record_version OR NEW.startup_operation_ref IS DISTINCT FROM e.startup_operation_ref OR NEW.state IS DISTINCT FROM expected_state
 OR (e.kind<>'accept-startup' AND (e.before_record_version IS DISTINCT FROM OLD.record_version OR NEW.startup_operation_ref IS DISTINCT FROM OLD.startup_operation_ref OR NEW.process_generation IS DISTINCT FROM OLD.process_generation)) THEN
  RAISE EXCEPTION 'Gateway startup head/event mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$gateway$;
--> statement-breakpoint
CREATE FUNCTION occ.check_gateway_startup_final_state() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $gateway$
DECLARE h occ.gateway_startup_heads%ROWTYPE; e occ.gateway_startup_operations%ROWTYPE; generation bigint; expected_state text;
BEGIN
 SELECT * INTO h FROM occ.gateway_startup_heads WHERE installation_id=NEW.installation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Gateway startup head missing' USING ERRCODE='23514'; END IF;
 SELECT * INTO e FROM occ.gateway_startup_operations WHERE installation_id=NEW.installation_id ORDER BY after_head_version DESC LIMIT 1;
 IF NOT FOUND THEN
  IF h.state<>'empty' OR h.head_version<>0 OR h.process_generation<>0 OR h.record_version<>0 OR h.latest_operation_ref IS NOT NULL OR h.startup_operation_ref IS NOT NULL THEN RAISE EXCEPTION 'Gateway startup empty history mismatch' USING ERRCODE='23514'; END IF;
  RETURN NULL;
 END IF;
 expected_state:=CASE e.kind WHEN 'accept-startup' THEN 'accepted' WHEN 'submit-create' THEN 'create-submitted' WHEN 'consume-startup' THEN 'consumed' ELSE 'withdrawn' END;
 SELECT process_generation INTO generation FROM occ.gateway_startup_operations WHERE installation_id=NEW.installation_id AND kind='accept-startup' ORDER BY process_generation DESC LIMIT 1;
 IF h.head_version IS DISTINCT FROM e.after_head_version OR h.latest_operation_ref IS DISTINCT FROM e.operation_ref
 OR h.record_version IS DISTINCT FROM e.after_record_version OR h.startup_operation_ref IS DISTINCT FROM e.startup_operation_ref
 OR h.process_generation IS DISTINCT FROM e.process_generation OR h.process_generation IS DISTINCT FROM generation OR h.state IS DISTINCT FROM expected_state THEN
  RAISE EXCEPTION 'Gateway startup final history mismatch' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$gateway$;
--> statement-breakpoint
CREATE FUNCTION occ.reject_gateway_startup_rewrite() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $gateway$
BEGIN RAISE EXCEPTION 'Gateway startup history is immutable' USING ERRCODE='23514'; END;
$gateway$;
--> statement-breakpoint
CREATE TRIGGER gateway_startup_operation_insert BEFORE INSERT ON occ.gateway_startup_operations FOR EACH ROW EXECUTE FUNCTION occ.guard_gateway_startup_operation();
--> statement-breakpoint
CREATE TRIGGER gateway_startup_head_write BEFORE INSERT OR UPDATE ON occ.gateway_startup_heads FOR EACH ROW EXECUTE FUNCTION occ.guard_gateway_startup_head();
--> statement-breakpoint
CREATE TRIGGER gateway_startup_operation_rewrite BEFORE UPDATE OR DELETE ON occ.gateway_startup_operations FOR EACH ROW EXECUTE FUNCTION occ.reject_gateway_startup_rewrite();
--> statement-breakpoint
CREATE TRIGGER gateway_startup_head_delete BEFORE DELETE ON occ.gateway_startup_heads FOR EACH ROW EXECUTE FUNCTION occ.reject_gateway_startup_rewrite();
--> statement-breakpoint
CREATE TRIGGER gateway_startup_operations_truncate BEFORE TRUNCATE ON occ.gateway_startup_operations FOR EACH STATEMENT EXECUTE FUNCTION occ.reject_gateway_startup_rewrite();
--> statement-breakpoint
CREATE TRIGGER gateway_startup_heads_truncate BEFORE TRUNCATE ON occ.gateway_startup_heads FOR EACH STATEMENT EXECUTE FUNCTION occ.reject_gateway_startup_rewrite();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER gateway_startup_operations_final AFTER INSERT ON occ.gateway_startup_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occ.check_gateway_startup_final_state();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER gateway_startup_heads_final AFTER INSERT OR UPDATE ON occ.gateway_startup_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION occ.check_gateway_startup_final_state();
--> statement-breakpoint
REVOKE ALL ON occ.gateway_startup_operations,occ.gateway_startup_heads FROM PUBLIC;
--> statement-breakpoint
REVOKE UPDATE,DELETE,TRUNCATE ON occ.gateway_startup_operations FROM occ_app;
--> statement-breakpoint
REVOKE DELETE,TRUNCATE ON occ.gateway_startup_heads FROM occ_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON occ.gateway_startup_operations TO occ_app;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON occ.gateway_startup_heads TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.guard_gateway_startup_operation() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.guard_gateway_startup_head() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.check_gateway_startup_final_state() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.reject_gateway_startup_rewrite() FROM PUBLIC;
