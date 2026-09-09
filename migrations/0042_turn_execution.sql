-- Extend the original journal with immutable selected execution records. This
-- migration runs in the table owner's existing outer transaction, after draining
-- old writers. It installs no alternative journal or authority issuer.
LOCK TABLE occ.turn_journal_operations, occ.turn_journal_attempts IN ACCESS EXCLUSIVE MODE;

ALTER TABLE occ.turn_journal_operations DROP CONSTRAINT turn_journal_operations_kind;
ALTER TABLE occ.turn_journal_operations ADD CONSTRAINT turn_journal_operations_kind
  CHECK (operation_kind IN ('checkpoint-allocation','completion','outcome','cancellation','release',
    'execution-intent','execution-start','execution-interruption'));
CREATE UNIQUE INDEX turn_journal_execution_once ON occ.turn_journal_operations
  (installation_id,namespace_id,agent_id,conversation_ref,turn_ref,attempt_ref,reservation_ref,operation_kind)
  WHERE operation_kind IN ('execution-intent','execution-start','execution-interruption');
CREATE UNIQUE INDEX turn_journal_execution_lookup ON occ.turn_journal_operations
  (installation_id,(request#>>'{execution,executionRef}')) WHERE operation_kind='execution-intent';
CREATE UNIQUE INDEX turn_journal_native_execution ON occ.turn_journal_operations
  (installation_id,(request->>'nativeIncarnationRef'),(request->>'nativeExecutionRef')) WHERE operation_kind='execution-start';

CREATE UNIQUE INDEX turn_journal_native_turn ON occ.turn_journal_operations
  (installation_id,(request->>'nativeIncarnationRef'),(request->>'nativeSessionRef'),(request->>'nativeTurnRef')) WHERE operation_kind='execution-start';

-- Captured closed value schemas use the existing finite journal evaluator.
CREATE FUNCTION occ.turn_journal_execution_definition(kind text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,occ AS $definition$
  SELECT CASE kind
    WHEN 'selectedExecution' THEN $schema${"type":"object","required":["attempt","dispatchOperationRef","consumption","executionRef","recipientRef"],"properties":{"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"dispatchOperationRef":{"type":"string","minLength":1,"maxLength":512},"consumption":{"type":"object","required":["schemaVersion","attempt","operationRef","claimantRef","requestDigest"],"properties":{"schemaVersion":{"type":"number","const":1},"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"claimantRef":{"type":"string","minLength":1,"maxLength":512},"requestDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"additionalProperties":false},"executionRef":{"type":"string","minLength":1,"maxLength":512},"recipientRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false}$schema$::jsonb
    WHEN 'executionIntent' THEN $schema${"type":"object","required":["execution","operationRef","operationDigest","executionLimitRef","executionLimitVersion","maximumExecutionMs","dispatchClock"],"properties":{"execution":{"type":"object","required":["attempt","dispatchOperationRef","consumption","executionRef","recipientRef"],"properties":{"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"dispatchOperationRef":{"type":"string","minLength":1,"maxLength":512},"consumption":{"type":"object","required":["schemaVersion","attempt","operationRef","claimantRef","requestDigest"],"properties":{"schemaVersion":{"type":"number","const":1},"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"claimantRef":{"type":"string","minLength":1,"maxLength":512},"requestDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"additionalProperties":false},"executionRef":{"type":"string","minLength":1,"maxLength":512},"recipientRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"operationDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"executionLimitRef":{"type":"string","minLength":1,"maxLength":512},"executionLimitVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"maximumExecutionMs":{"type":"integer","minimum":1,"maximum":900000},"dispatchClock":{"type":"object","required":["clockSourceRef","clockEpochRef","committedAtMs","deadlineAtMs"],"properties":{"clockSourceRef":{"type":"string","minLength":1,"maxLength":512},"clockEpochRef":{"type":"string","minLength":1,"maxLength":512},"committedAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991},"deadlineAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991}},"additionalProperties":false}},"additionalProperties":false}$schema$::jsonb
    WHEN 'executionStart' THEN $schema${"type":"object","required":["intent","operationRef","operationDigest","nativeExecutionRef","nativeIncarnationRef","nativeReservationRef","nativeSessionRef","nativeTurnRef","acceptanceEvidenceRef","clockSourceRef","clockEpochRef","startedAtMs","deadlineAtMs","dispatchDeadlineAtMs","clockCorrespondenceEvidenceRef"],"properties":{"intent":{"type":"object","required":["execution","operationRef","operationDigest","executionLimitRef","executionLimitVersion","maximumExecutionMs","dispatchClock"],"properties":{"execution":{"type":"object","required":["attempt","dispatchOperationRef","consumption","executionRef","recipientRef"],"properties":{"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"dispatchOperationRef":{"type":"string","minLength":1,"maxLength":512},"consumption":{"type":"object","required":["schemaVersion","attempt","operationRef","claimantRef","requestDigest"],"properties":{"schemaVersion":{"type":"number","const":1},"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"claimantRef":{"type":"string","minLength":1,"maxLength":512},"requestDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"additionalProperties":false},"executionRef":{"type":"string","minLength":1,"maxLength":512},"recipientRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"operationDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"executionLimitRef":{"type":"string","minLength":1,"maxLength":512},"executionLimitVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"maximumExecutionMs":{"type":"integer","minimum":1,"maximum":900000},"dispatchClock":{"type":"object","required":["clockSourceRef","clockEpochRef","committedAtMs","deadlineAtMs"],"properties":{"clockSourceRef":{"type":"string","minLength":1,"maxLength":512},"clockEpochRef":{"type":"string","minLength":1,"maxLength":512},"committedAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991},"deadlineAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991}},"additionalProperties":false}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"operationDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"nativeExecutionRef":{"type":"string","minLength":1,"maxLength":512},"nativeIncarnationRef":{"type":"string","minLength":1,"maxLength":512},"nativeReservationRef":{"type":"string","minLength":1,"maxLength":512},"nativeSessionRef":{"type":"string","minLength":1,"maxLength":512},"nativeTurnRef":{"type":"string","minLength":1,"maxLength":512},"acceptanceEvidenceRef":{"type":"string","minLength":1,"maxLength":512},"clockSourceRef":{"type":"string","minLength":1,"maxLength":512},"clockEpochRef":{"type":"string","minLength":1,"maxLength":512},"startedAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991},"deadlineAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991},"dispatchDeadlineAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991},"clockCorrespondenceEvidenceRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false}$schema$::jsonb
    WHEN 'executionInterruption' THEN $schema${"type":"object","required":["start","operationRef","operationDigest","responsibilityRef","responsibilityVersion"],"properties":{"start":{"type":"object","required":["intent","operationRef","operationDigest","nativeExecutionRef","nativeIncarnationRef","nativeReservationRef","nativeSessionRef","nativeTurnRef","acceptanceEvidenceRef","clockSourceRef","clockEpochRef","startedAtMs","deadlineAtMs","dispatchDeadlineAtMs","clockCorrespondenceEvidenceRef"],"properties":{"intent":{"type":"object","required":["execution","operationRef","operationDigest","executionLimitRef","executionLimitVersion","maximumExecutionMs","dispatchClock"],"properties":{"execution":{"type":"object","required":["attempt","dispatchOperationRef","consumption","executionRef","recipientRef"],"properties":{"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"dispatchOperationRef":{"type":"string","minLength":1,"maxLength":512},"consumption":{"type":"object","required":["schemaVersion","attempt","operationRef","claimantRef","requestDigest"],"properties":{"schemaVersion":{"type":"number","const":1},"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"claimantRef":{"type":"string","minLength":1,"maxLength":512},"requestDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"additionalProperties":false},"executionRef":{"type":"string","minLength":1,"maxLength":512},"recipientRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"operationDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"executionLimitRef":{"type":"string","minLength":1,"maxLength":512},"executionLimitVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"maximumExecutionMs":{"type":"integer","minimum":1,"maximum":900000},"dispatchClock":{"type":"object","required":["clockSourceRef","clockEpochRef","committedAtMs","deadlineAtMs"],"properties":{"clockSourceRef":{"type":"string","minLength":1,"maxLength":512},"clockEpochRef":{"type":"string","minLength":1,"maxLength":512},"committedAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991},"deadlineAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991}},"additionalProperties":false}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"operationDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"nativeExecutionRef":{"type":"string","minLength":1,"maxLength":512},"nativeIncarnationRef":{"type":"string","minLength":1,"maxLength":512},"nativeReservationRef":{"type":"string","minLength":1,"maxLength":512},"nativeSessionRef":{"type":"string","minLength":1,"maxLength":512},"nativeTurnRef":{"type":"string","minLength":1,"maxLength":512},"acceptanceEvidenceRef":{"type":"string","minLength":1,"maxLength":512},"clockSourceRef":{"type":"string","minLength":1,"maxLength":512},"clockEpochRef":{"type":"string","minLength":1,"maxLength":512},"startedAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991},"deadlineAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991},"dispatchDeadlineAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991},"clockCorrespondenceEvidenceRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"operationDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"responsibilityRef":{"type":"string","minLength":1,"maxLength":512},"responsibilityVersion":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false}$schema$::jsonb
    ELSE NULL END;
$definition$;
CREATE FUNCTION occ.turn_journal_execution_valid(kind text,value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,occ AS $$
DECLARE intent jsonb; start jsonb; execution jsonb; dispatch jsonb; duration numeric;
BEGIN
  IF NOT (occ.turn_journal_phase_schema_matches(occ.turn_journal_execution_definition(kind),value)
    AND occ.turn_journal_phase_intrinsic(value) AND octet_length(value::text)<=65536) IS TRUE THEN RETURN false; END IF;
  IF kind='executionInterruption' THEN start:=value->'start'; intent:=start->'intent';
  ELSIF kind='executionStart' THEN start:=value; intent:=value->'intent';
  ELSIF kind='executionIntent' THEN intent:=value;
  ELSIF kind='selectedExecution' THEN execution:=value;
  ELSE RETURN false; END IF;
  IF intent IS NOT NULL THEN execution:=intent->'execution'; dispatch:=intent->'dispatchClock';
    duration:=(intent->>'maximumExecutionMs')::numeric;
    IF (dispatch->>'deadlineAtMs')::numeric<=(dispatch->>'committedAtMs')::numeric
      OR (dispatch->>'deadlineAtMs')::numeric-(dispatch->>'committedAtMs')::numeric>900000 THEN RETURN false; END IF;
  END IF;
  IF execution->'attempt' IS DISTINCT FROM execution#>'{consumption,attempt}' THEN RETURN false; END IF;
  IF start IS NOT NULL THEN
    IF (start->>'startedAtMs')::numeric+duration>9007199254740991
      OR (start->>'deadlineAtMs')::numeric<=(start->>'startedAtMs')::numeric
      OR (start->>'deadlineAtMs')::numeric<>least((start->>'dispatchDeadlineAtMs')::numeric,(start->>'startedAtMs')::numeric+duration)
      OR (start->'clockSourceRef'=dispatch->'clockSourceRef' AND start->'clockEpochRef'=dispatch->'clockEpochRef'
        AND (start->'dispatchDeadlineAtMs' IS DISTINCT FROM dispatch->'deadlineAtMs' OR (start->>'startedAtMs')::numeric<(dispatch->>'committedAtMs')::numeric)) THEN RETURN false; END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$$;

-- Keep the prior guard byte-for-byte for its existing operation kinds. The
-- selected guard independently owns every new INSERT and immutable UPDATE/DELETE.
DROP TRIGGER turn_journal_operation_guard ON occ.turn_journal_operations;
CREATE TRIGGER turn_journal_operation_guard BEFORE INSERT ON occ.turn_journal_operations
  FOR EACH ROW WHEN (NEW.operation_kind NOT IN ('execution-intent','execution-start','execution-interruption'))
  EXECUTE FUNCTION occ.turn_journal_operation_guard();
CREATE TRIGGER turn_journal_operation_immutable BEFORE UPDATE OR DELETE ON occ.turn_journal_operations
  FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_operation_guard();

CREATE FUNCTION occ.turn_journal_execution_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,occ AS $$
DECLARE exact jsonb; intent jsonb; start jsonb; execution jsonb; current_record jsonb; expected jsonb;
  kind text;
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'Selected execution requires read committed' USING ERRCODE='25001'; END IF;
  kind:=CASE NEW.operation_kind WHEN 'execution-intent' THEN 'executionIntent'
    WHEN 'execution-start' THEN 'executionStart' ELSE 'executionInterruption' END;
  IF NOT occ.turn_journal_execution_valid(kind,NEW.request) OR NEW.request IS DISTINCT FROM NEW.record
    OR NEW.request->>'operationRef' IS DISTINCT FROM NEW.operation_ref THEN
    RAISE EXCEPTION 'Invalid selected execution record' USING ERRCODE='23514'; END IF;
  IF NEW.operation_kind='execution-intent' THEN intent:=NEW.request;
  ELSIF NEW.operation_kind='execution-start' THEN start:=NEW.request; intent:=start->'intent';
  ELSE start:=NEW.request->'start'; intent:=start->'intent'; END IF;
  execution:=intent->'execution'; exact:=occ.turn_journal_phase_exact_attempt(to_jsonb(NEW));
  IF execution->'attempt' IS DISTINCT FROM exact THEN
    RAISE EXCEPTION 'Selected execution attempt mismatch' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM occ.agents WHERE namespace_id=NEW.namespace_id AND id=NEW.agent_id FOR UPDATE;
  SELECT record INTO current_record FROM occ.turn_journal_attempts a WHERE
    a.installation_id=NEW.installation_id AND a.namespace_id=NEW.namespace_id AND a.agent_id=NEW.agent_id
    AND a.conversation_ref=NEW.conversation_ref AND a.turn_ref=NEW.turn_ref AND a.attempt_ref=NEW.attempt_ref
    AND a.reservation_ref=NEW.reservation_ref FOR UPDATE;
  IF NOT FOUND OR current_record ? 'phase' OR current_record#>'{binding,dispatchOperationRef}' IS DISTINCT FROM execution->'dispatchOperationRef'
    OR NOT EXISTS (SELECT 1 FROM occ.turn_journal_reservations r WHERE r.installation_id=NEW.installation_id
      AND r.namespace_id=NEW.namespace_id AND r.agent_id=NEW.agent_id AND r.conversation_ref=NEW.conversation_ref
      AND r.turn_ref=NEW.turn_ref AND r.attempt_ref=NEW.attempt_ref AND r.reservation_ref=NEW.reservation_ref) THEN
    RAISE EXCEPTION 'Selected execution lacks original reserved dispatch' USING ERRCODE='23514'; END IF;
  IF NEW.operation_kind='execution-intent' THEN
    IF current_record->'consumption' IS DISTINCT FROM 'null'::jsonb OR current_record#>>'{outcome,kind}' IS DISTINCT FROM 'dispatch-intent' THEN
      RAISE EXCEPTION 'Selected intent must join original consumption' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT record INTO expected FROM occ.turn_journal_operations o WHERE o.installation_id=NEW.installation_id
      AND o.namespace_id=NEW.namespace_id AND o.agent_id=NEW.agent_id AND o.conversation_ref=NEW.conversation_ref
      AND o.turn_ref=NEW.turn_ref AND o.attempt_ref=NEW.attempt_ref AND o.reservation_ref=NEW.reservation_ref
      AND o.operation_kind='execution-intent';
    IF expected IS DISTINCT FROM intent OR current_record#>'{consumption,operation}' IS DISTINCT FROM execution->'consumption' THEN
      RAISE EXCEPTION 'Selected execution changed original consumption or intent' USING ERRCODE='23514'; END IF;
    IF NEW.operation_kind='execution-start' THEN
      IF current_record#>>'{outcome,kind}' IS DISTINCT FROM 'consumed' OR EXISTS (SELECT 1 FROM occ.turn_journal_operations o
        WHERE o.installation_id=NEW.installation_id AND o.namespace_id=NEW.namespace_id AND o.agent_id=NEW.agent_id
          AND o.conversation_ref=NEW.conversation_ref AND o.turn_ref=NEW.turn_ref AND o.attempt_ref=NEW.attempt_ref
          AND o.reservation_ref=NEW.reservation_ref AND o.operation_kind='cancellation') THEN
        RAISE EXCEPTION 'Selected execution is no longer startable' USING ERRCODE='23514'; END IF;
    ELSE
      SELECT record INTO expected FROM occ.turn_journal_operations o WHERE o.installation_id=NEW.installation_id
        AND o.namespace_id=NEW.namespace_id AND o.agent_id=NEW.agent_id AND o.conversation_ref=NEW.conversation_ref
        AND o.turn_ref=NEW.turn_ref AND o.attempt_ref=NEW.attempt_ref AND o.reservation_ref=NEW.reservation_ref
        AND o.operation_kind='execution-start';
      IF expected IS DISTINCT FROM start THEN
        RAISE EXCEPTION 'Interruption changed original native start' USING ERRCODE='23514'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER turn_journal_execution_guard BEFORE INSERT ON occ.turn_journal_operations
  FOR EACH ROW WHEN (NEW.operation_kind IN ('execution-intent','execution-start','execution-interruption'))
  EXECUTE FUNCTION occ.turn_journal_execution_guard();

CREATE FUNCTION occ.turn_journal_execution_atomic() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,occ AS $$
DECLARE current_record jsonb;
BEGIN
  SELECT record INTO current_record FROM occ.turn_journal_attempts a WHERE a.installation_id=NEW.installation_id
    AND a.namespace_id=NEW.namespace_id AND a.agent_id=NEW.agent_id AND a.conversation_ref=NEW.conversation_ref
    AND a.turn_ref=NEW.turn_ref AND a.attempt_ref=NEW.attempt_ref AND a.reservation_ref=NEW.reservation_ref;
  IF current_record#>'{consumption,operation}' IS DISTINCT FROM NEW.request#>'{execution,consumption}' THEN
    RAISE EXCEPTION 'Selected intent and original consumption must commit together' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER turn_journal_execution_atomic AFTER INSERT ON occ.turn_journal_operations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.operation_kind='execution-intent')
  EXECUTE FUNCTION occ.turn_journal_execution_atomic();

CREATE FUNCTION occ.turn_journal_selected_running_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,occ AS $$
DECLARE start jsonb;
BEGIN
  IF NEW.record#>>'{outcome,kind}'='running' AND EXISTS (SELECT 1 FROM occ.turn_journal_operations o
    WHERE o.installation_id=NEW.installation_id AND o.namespace_id=NEW.namespace_id AND o.agent_id=NEW.agent_id
      AND o.conversation_ref=NEW.conversation_ref AND o.turn_ref=NEW.turn_ref AND o.attempt_ref=NEW.attempt_ref
      AND o.reservation_ref=NEW.reservation_ref AND o.operation_kind='execution-intent') THEN
    SELECT record INTO start FROM occ.turn_journal_operations o WHERE o.installation_id=NEW.installation_id
      AND o.namespace_id=NEW.namespace_id AND o.agent_id=NEW.agent_id AND o.conversation_ref=NEW.conversation_ref
      AND o.turn_ref=NEW.turn_ref AND o.attempt_ref=NEW.attempt_ref AND o.reservation_ref=NEW.reservation_ref
      AND o.operation_kind='execution-start';
    IF start IS NULL OR NEW.record#>'{outcome,nativeSessionRef}' IS DISTINCT FROM start->'nativeSessionRef'
      OR NEW.record#>'{outcome,nativeTurnRef}' IS DISTINCT FROM start->'nativeTurnRef' THEN
      RAISE EXCEPTION 'Selected running outcome requires original native start' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER turn_journal_selected_running_guard BEFORE UPDATE ON occ.turn_journal_attempts
  FOR EACH ROW EXECUTE FUNCTION occ.turn_journal_selected_running_guard();
REVOKE ALL ON FUNCTION occ.turn_journal_execution_definition(text),occ.turn_journal_execution_valid(text,jsonb),
  occ.turn_journal_execution_guard(),occ.turn_journal_execution_atomic(),occ.turn_journal_selected_running_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION occ.turn_journal_execution_definition(text),occ.turn_journal_execution_valid(text,jsonb),
  occ.turn_journal_execution_guard(),occ.turn_journal_execution_atomic(),occ.turn_journal_selected_running_guard() TO occ_app;
