-- Materialize canonical predispatch records without inventing dispatch facts.
-- The existing migrator owns ONE outer transaction. LOCK TABLE deliberately fails
-- outside it. This body never commits, rolls back, disables triggers, or installs
-- an application-controlled maintenance switch. All original 0022 data outside
-- the two preflight-classified NULL states remains byte-identical.
-- Run with the actual table-owning migration role, after stopping old writers.
-- ACCESS EXCLUSIVE locks also exclude writers which were not stopped correctly;
-- after commit the final NOT NULL check and guards reject their old write shape.

LOCK TABLE occ.turn_journal_attempts, occ.turn_journal_deliveries,
  occ.turn_journal_delivery_attempts, occ.turn_journal_heads,
  occ.turn_journal_incoming_links, occ.turn_journal_keys,
  occ.turn_journal_operations, occ.turn_journal_owners,
  occ.turn_journal_reservations IN ACCESS EXCLUSIVE MODE;

DO $phase_owner$
BEGIN
  IF current_user <> pg_get_userbyid((SELECT relowner FROM pg_class
    WHERE oid='occ.turn_journal_attempts'::regclass)) THEN
    RAISE EXCEPTION 'Turn journal phase upgrade requires the table-owning migration role'
      USING ERRCODE='42501';
  END IF;
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'Turn journal phase upgrade requires UTF8' USING ERRCODE='23514';
  END IF;
END;
$phase_owner$;

-- PostgreSQL text counts scalar values; the accepted JS codecs count UTF-16
-- units. JSONB/UTF8 already excludes unpaired surrogates and U+0000. Raw JSON
-- duplicate-key spelling and -0 spelling have been lost before persistence and
-- cannot be certified by this migration. Runtime decoding still owns raw input.
CREATE FUNCTION occ.turn_journal_phase_utf16_length(value text) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,occ AS $$
  SELECT coalesce(sum(CASE WHEN ascii(substr(value,n,1))>65535 THEN 2 ELSE 1 END),0)::integer
  FROM generate_series(1,length(value)) n;
$$;

CREATE FUNCTION occ.turn_journal_phase_reference(value jsonb, allow_empty boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,occ AS $$
DECLARE text_value text; code integer; n integer;
  edge_whitespace integer[]:=ARRAY[9,10,11,12,13,32,160,5760,8192,8193,8194,8195,
    8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279];
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  text_value:=value#>>'{}';
  IF (NOT allow_empty AND text_value='') OR octet_length(text_value)>1024
    OR occ.turn_journal_phase_utf16_length(text_value)>512 OR strpos(text_value,'://')>0 THEN RETURN false; END IF;
  FOR n IN 1..length(text_value) LOOP
    code:=ascii(substr(text_value,n,1));
    IF code<32 OR code=127 OR ((n=1 OR n=length(text_value)) AND code=ANY(edge_whitespace)) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;

-- Calendar arithmetic preserves the accepted ISO year 0000 domain without
-- PostgreSQL's BC/AD formatting differences or DateStyle/timezone dependencies.
CREATE FUNCTION occ.turn_journal_phase_instant(value text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,occ AS $$
DECLARE y integer; m integer; d integer; days integer;
BEGIN
  IF value IS NULL OR value COLLATE "C" !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN RETURN false; END IF;
  y:=substr(value,1,4)::integer; m:=substr(value,6,2)::integer; d:=substr(value,9,2)::integer;
  IF m NOT BETWEEN 1 AND 12 OR substr(value,12,2)::integer>23
    OR substr(value,15,2)::integer>59 OR substr(value,18,2)::integer>59 THEN RETURN false; END IF;
  days:=CASE WHEN m=2 THEN CASE WHEN y%4=0 AND (y%100<>0 OR y%400=0) THEN 29 ELSE 28 END
    WHEN m IN (4,6,9,11) THEN 30 ELSE 31 END;
  RETURN d BETWEEN 1 AND days;
END;
$$;

-- This is a finite evaluator for the constructs present in the captured accepted
-- schemas, not a general JSON Schema implementation. Unknown constructs fail.
CREATE FUNCTION occ.turn_journal_phase_schema_matches(definition jsonb, value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,occ AS $$
DECLARE entry record; branch jsonb; actual_type text; expected_type text; size integer;
BEGIN
  IF definition IS NULL OR value IS NULL OR jsonb_typeof(definition)<>'object' THEN RETURN false; END IF;
  IF definition-ARRAY['type','required','properties','additionalProperties','anyOf','const','enum',
    'minLength','maxLength','pattern','minimum','maximum','items','minItems','maxItems','uniqueItems']<>'{}'::jsonb THEN RETURN false; END IF;
  IF definition ? 'const' AND value IS DISTINCT FROM definition->'const' THEN RETURN false; END IF;
  IF definition ? 'enum' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(definition->'enum') AS e(candidate) WHERE e.candidate=value) THEN RETURN false; END IF;
  IF definition ? 'anyOf' THEN
    FOR branch IN SELECT jsonb_array_elements(definition->'anyOf') LOOP
      IF occ.turn_journal_phase_schema_matches(branch,value) THEN RETURN true; END IF;
    END LOOP;
    RETURN false;
  END IF;
  actual_type:=jsonb_typeof(value); expected_type:=definition->>'type';
  IF expected_type IS NOT NULL AND actual_type IS DISTINCT FROM
    CASE WHEN expected_type='integer' THEN 'number' ELSE expected_type END THEN RETURN false; END IF;
  IF actual_type='object' THEN
    IF definition ? 'required' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(definition->'required') AS required_key(key_name) WHERE NOT value ? required_key.key_name) THEN RETURN false; END IF;
    FOR entry IN SELECT * FROM jsonb_each(value) LOOP
      IF definition->'properties' ? entry.key THEN
        IF NOT occ.turn_journal_phase_schema_matches(definition->'properties'->entry.key,entry.value) THEN RETURN false; END IF;
      ELSIF definition->'additionalProperties'='false'::jsonb THEN RETURN false;
      END IF;
    END LOOP;
  ELSIF actual_type='array' THEN
    size:=jsonb_array_length(value);
    IF (definition ? 'minItems' AND size<(definition->>'minItems')::integer)
      OR (definition ? 'maxItems' AND size>(definition->>'maxItems')::integer) THEN RETURN false; END IF;
    IF definition->'uniqueItems'='true'::jsonb AND size<>(SELECT count(DISTINCT e) FROM jsonb_array_elements(value) e) THEN RETURN false; END IF;
    IF definition ? 'items' THEN
      FOR branch IN SELECT jsonb_array_elements(value) LOOP
        IF NOT occ.turn_journal_phase_schema_matches(definition->'items',branch) THEN RETURN false; END IF;
      END LOOP;
    END IF;
  ELSIF actual_type='string' THEN
    size:=occ.turn_journal_phase_utf16_length(value#>>'{}');
    IF (definition ? 'minLength' AND size<(definition->>'minLength')::integer)
      OR (definition ? 'maxLength' AND size>(definition->>'maxLength')::integer)
      OR (definition ? 'pattern' AND (value#>>'{}') COLLATE "C" !~ replace(definition->>'pattern',E'\\d','[0-9]')) THEN RETURN false; END IF;
  ELSIF actual_type='number' THEN
    IF (expected_type='integer' AND (value#>>'{}')::numeric<>trunc((value#>>'{}')::numeric))
      OR (definition ? 'minimum' AND (value#>>'{}')::numeric<(definition->>'minimum')::numeric)
      OR (definition ? 'maximum' AND (value#>>'{}')::numeric>(definition->>'maximum')::numeric) THEN RETURN false; END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$$;

CREATE FUNCTION occ.turn_journal_phase_sdk_carrier(kind text,value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,occ AS $$
DECLARE required_keys text[]; ref_keys text[]; digest_keys text[]; k text;
BEGIN
  -- Both hosted carrier codecs require these exact keys and reference domains.
  -- Their freeze transform changes no data.
  IF kind='locator' THEN
    ref_keys:=ARRAY['installationRef','channelInstallationRef']; digest_keys:=ARRAY['eventKey','logicalMessageKey'];
  ELSIF kind='receipt' THEN
    ref_keys:=ARRAY['receiptRef']; digest_keys:=ARRAY['eventKey','logicalMessageKey','eventDigest','contentDigest','profileConfigurationDigest'];
  ELSE RETURN false; END IF;
  required_keys:=ARRAY['schemaVersion']||ref_keys||digest_keys;
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR NOT value ?& required_keys
    OR value-required_keys<>'{}'::jsonb OR value->'schemaVersion' IS DISTINCT FROM '1'::jsonb THEN RETURN false; END IF;
  FOREACH k IN ARRAY ref_keys LOOP IF NOT occ.turn_journal_phase_reference(value->k) THEN RETURN false; END IF; END LOOP;
  FOREACH k IN ARRAY digest_keys LOOP
    IF jsonb_typeof(value->k) IS DISTINCT FROM 'string' OR (value->>k) COLLATE "C" !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE FUNCTION occ.turn_journal_phase_context(value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,occ AS $$
  SELECT jsonb_build_object('installationRef',value->'installationRef','namespaceRef',value->'namespaceRef',
    'agentRef',value->'agentRef','conversationRef',value->'conversationRef');
$$;

-- These helpers check nominal persisted fields. Open scope extensions are
-- excluded only from that validation view; their full semantic validation is
-- owned by the actual application codecs, including the locked upgrade step.
CREATE FUNCTION occ.turn_journal_phase_truthy(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,occ AS $$
  SELECT value IS NOT NULL AND value NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb);
$$;

CREATE FUNCTION occ.turn_journal_phase_same_context(left_value jsonb,right_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,occ AS $$
  SELECT (left_value IS NOT NULL AND right_value IS NOT NULL AND left_value<>'null'::jsonb AND right_value<>'null'::jsonb
    AND left_value->'installationRef' IS NOT DISTINCT FROM right_value->'installationRef'
    AND left_value->'namespaceRef' IS NOT DISTINCT FROM right_value->'namespaceRef'
    AND left_value->'agentRef' IS NOT DISTINCT FROM right_value->'agentRef'
    AND left_value->'conversationRef' IS NOT DISTINCT FROM right_value->'conversationRef') IS TRUE;
$$;

CREATE FUNCTION occ.turn_journal_phase_includes(values_value jsonb,needle jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,occ AS $$
  SELECT CASE jsonb_typeof(values_value)
    WHEN 'array' THEN EXISTS (SELECT 1 FROM jsonb_array_elements(values_value) AS e(candidate) WHERE e.candidate=needle)
    WHEN 'string' THEN CASE WHEN jsonb_typeof(needle)='string' THEN strpos(values_value#>>'{}',needle#>>'{}')>0 ELSE false END
    ELSE false END;
$$;

CREATE FUNCTION occ.turn_journal_phase_intrinsic(value jsonb, depth integer DEFAULT 0) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,occ AS $$
DECLARE entry record; child jsonb; checkpoint jsonb; h jsonb; a jsonb; c jsonb; r jsonb; i jsonb; o jsonb;
  l jsonb; original jsonb; linked_record jsonb; receipt jsonb; locator jsonb;
BEGIN
  IF value IS NULL OR depth>16 THEN RETURN false; END IF;
  IF jsonb_typeof(value)='number' THEN
    RETURN (value#>>'{}')::numeric BETWEEN 0 AND 9007199254740991
      AND (value#>>'{}')::numeric=trunc((value#>>'{}')::numeric);
  ELSIF jsonb_typeof(value)='array' THEN
    IF jsonb_array_length(value)>128 THEN RETURN false; END IF;
    FOR child IN SELECT jsonb_array_elements(value) LOOP IF NOT occ.turn_journal_phase_intrinsic(child,depth+1) THEN RETURN false; END IF; END LOOP;
    RETURN true;
  ELSIF jsonb_typeof(value)<>'object' THEN RETURN true;
  END IF;
  -- No nominal persisted field checked here is a rejected-envelope wrapper.
  -- Complete nested SDK validation remains with the actual codec step.
  IF value ? 'envelope' THEN RETURN false; END IF;
  FOR entry IN SELECT * FROM jsonb_each(value) LOOP
    IF entry.key IN ('__proto__','prototype','constructor') OR depth+1>16 THEN RETURN false; END IF;
    IF jsonb_typeof(entry.value)='string' AND (NOT occ.turn_journal_phase_reference(entry.value,true)
      OR (right(entry.key,2)='At' AND NOT occ.turn_journal_phase_instant(entry.value#>>'{}'))) THEN RETURN false; END IF;
    IF NOT occ.turn_journal_phase_intrinsic(entry.value,depth+1) THEN RETURN false; END IF;
  END LOOP;
  IF value ? 'locator' THEN
    IF value->'locator' ? 'classification' THEN
      IF NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('nonTurnIntake'),value->'locator') THEN RETURN false; END IF;
    ELSIF NOT occ.turn_journal_phase_sdk_carrier('locator',value->'locator') THEN RETURN false;
    END IF;
  END IF;
  IF value ? 'receipt' THEN
    IF value->'receipt' ? 'intake' THEN
      IF NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('nonTurnReceipt'),value->'receipt') THEN RETURN false; END IF;
    ELSIF NOT occ.turn_journal_phase_sdk_carrier('receipt',value->'receipt') THEN RETURN false;
    END IF;
  END IF;
  IF value ? 'originalReceipt' THEN
    IF NOT occ.turn_journal_phase_sdk_carrier('receipt',value->'originalReceipt')
      OR NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('incomingLink'),value->'incomingLink')
      OR NOT occ.turn_journal_phase_includes(value#>'{incomingLink,originalReceiptRefs}',value#>'{originalReceipt,receiptRef}') THEN RETURN false; END IF;
  END IF;
  IF value ?& ARRAY['completionSequence','checkpointId'] AND
    ((value->'completionSequence'='0'::jsonb) IS DISTINCT FROM (value->'checkpointId'='null'::jsonb)) THEN RETURN false; END IF;
  IF occ.turn_journal_phase_truthy(value->'locator') AND occ.turn_journal_phase_truthy(value->'receipt') THEN
    IF NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('admissionIdentity')#>'{properties,context}',value->'context')
      OR NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('admissionIdentity')#>'{properties,workspace}',value->'workspace') THEN RETURN false; END IF;
    IF (value#>'{locator,installationRef}'=value#>'{context,installationRef}'
      AND value#>'{locator,eventKey}'=value#>'{receipt,eventKey}'
      AND value#>'{locator,logicalMessageKey}'=value#>'{receipt,logicalMessageKey}'
      AND value#>'{workspace,scope,installationId}'=value#>'{context,installationRef}'
      AND value#>'{workspace,scope,namespaceId}'=value#>'{context,namespaceRef}'
      AND value#>'{workspace,scope,agentId}'=value#>'{context,agentRef}') IS NOT TRUE THEN RETURN false; END IF;
  END IF;
  a:=value->'attempt'; h:=value->'expectedHead'; r:=value->'reservation'; i:=value->'identity';
  -- These are nominal fields, already structurally validated. The finite
  -- scope projection prevents arbitrary extension keys from reaching them.
  IF occ.turn_journal_phase_truthy(h) AND occ.turn_journal_phase_truthy(a) THEN
    IF NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('head'),h)
      OR NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('commonAttemptBinding')#>'{properties,attempt}',a)
      OR NOT occ.turn_journal_phase_same_context(h->'context',a) THEN RETURN false; END IF;
  END IF;
  IF occ.turn_journal_phase_truthy(r) AND occ.turn_journal_phase_truthy(a) THEN
    IF NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('commonAttemptBinding')#>'{properties,reservation}',r)
      OR NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('commonAttemptBinding')#>'{properties,attempt}',a)
      OR (r->'reservationRef'=a->'reservationRef' AND r#>'{scope,installationId}'=a->'installationRef'
        AND r#>'{scope,namespaceId}'=a->'namespaceRef' AND r#>'{scope,agentId}'=a->'agentRef') IS NOT TRUE THEN RETURN false; END IF;
  END IF;
  IF occ.turn_journal_phase_truthy(i) AND occ.turn_journal_phase_truthy(h) THEN
    IF NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('admissionIdentity'),i)
      OR NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('head'),h)
      OR NOT occ.turn_journal_phase_same_context(i->'context',h->'context') OR (value#>>'{decision,kind}'='accepted'
        AND NOT occ.turn_journal_phase_same_context(i->'context',value#>'{decision,attempt}')) THEN RETURN false; END IF;
  END IF;
  IF occ.turn_journal_phase_truthy(value->'binding') AND occ.turn_journal_phase_truthy(value->'outcome') AND value ? 'consumption' THEN
    IF NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('attempt'),value) THEN RETURN false; END IF;
    c:=value->'consumption'; o:=value->'outcome';
    IF c<>'null'::jsonb AND c#>'{operation,attempt}' IS DISTINCT FROM value#>'{binding,attempt}' THEN RETURN false; END IF;
    IF o->>'kind'='dispatch-intent' AND (value ? 'phase' OR o->'dispatchOperationRef' IS DISTINCT FROM value#>'{binding,dispatchOperationRef}') THEN RETURN false; END IF;
    IF o->>'kind' IN ('accepted-undispatched','dispatch-intent') AND c<>'null'::jsonb THEN RETURN false; END IF;
    IF o->>'kind' IN ('consumed','running','completed') AND c='null'::jsonb THEN RETURN false; END IF;
    IF o->>'kind'='consumed' AND (o->'consumptionOperationRef' IS DISTINCT FROM c#>'{operation,operationRef}'
      OR o->'consumedAt' IS DISTINCT FROM c->'consumedAt') THEN RETURN false; END IF;
    IF o->>'stage'='before-dispatch' AND c<>'null'::jsonb THEN RETURN false; END IF;
    IF o->>'stage' IN ('execution','checkpoint') AND c='null'::jsonb THEN RETURN false; END IF;
  END IF;
  IF value ? 'checkpoint' THEN
    checkpoint:=value->'checkpoint';
    IF NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('checkpointRef'),checkpoint) THEN RETURN false; END IF;
    -- The nested checkpoint schema and these additional intrinsic rules both
    -- apply; matching the structural shape alone is insufficient.
    IF ((checkpoint->'completionSequence'='1'::jsonb) IS DISTINCT FROM (checkpoint->'parentCheckpointId'='null'::jsonb))
      OR checkpoint->'parentCheckpointId'=checkpoint->'checkpointId'
      OR (checkpoint->>'itemCount')::numeric<=0
      OR checkpoint->'producingGatewayAssignmentRef'=checkpoint->'producingHarnessAssignmentRef'
      OR checkpoint->'gatewayStoreBindingRef'=checkpoint->'workspaceBindingRef' THEN RETURN false; END IF;
  END IF;
  IF value->>'kind'='reserved' AND value ? 'attemptNumber' AND occ.turn_journal_phase_truthy(value->'operation') THEN
    IF NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('deliveryOperation'),value->'operation')
      OR (value#>>'{operation,operation,kind}'='update' AND value->'attemptNumber' IS DISTINCT FROM '1'::jsonb) THEN RETURN false; END IF;
  END IF;
  IF value->>'kind'='new-context' AND occ.turn_journal_phase_truthy(value->'head') THEN
    IF NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('head'),value->'head')
      OR value#>'{head,completionSequence}' IS DISTINCT FROM '0'::jsonb THEN RETURN false; END IF;
  END IF;
  IF occ.turn_journal_phase_truthy(value->'head') AND occ.turn_journal_phase_truthy(value->'checkpoint') THEN
    h:=value->'head'; checkpoint:=value->'checkpoint';
    IF NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('head'),h)
      OR NOT occ.turn_journal_phase_same_context(h->'context',checkpoint)
      OR h->'checkpointId' IS DISTINCT FROM checkpoint->'checkpointId'
      OR h->'completionSequence' IS DISTINCT FROM checkpoint->'completionSequence' THEN RETURN false; END IF;
    IF occ.turn_journal_phase_truthy(value->'operation') THEN
      o:=value->'operation';
      IF NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('completionOperation'),o)
        OR NOT occ.turn_journal_phase_same_context(o->'attempt',checkpoint)
        OR checkpoint->'checkpointId' IS DISTINCT FROM o->'checkpointId'
        OR (checkpoint->>'completionSequence')::numeric<>(o->>'expectedCompletionSequence')::numeric+1
        OR value->'outcomeVersion' IS DISTINCT FROM to_jsonb((o->>'expectedAttemptVersion')::numeric+1)
        OR checkpoint->'turnRef' IS DISTINCT FROM o#>'{attempt,turnRef}'
        OR checkpoint->'attemptRef' IS DISTINCT FROM o#>'{attempt,attemptRef}'
        OR checkpoint->'reservationRef' IS DISTINCT FROM o#>'{attempt,reservationRef}' THEN RETURN false; END IF;
    END IF;
  END IF;
  IF occ.turn_journal_phase_truthy(value->'record') AND occ.turn_journal_phase_truthy(value->'incomingLink') THEN
    linked_record:=value->'record'; l:=value->'incomingLink';
    IF NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('admission'),linked_record)
      OR NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('incomingLink'),l) THEN RETURN false; END IF;
    receipt:=linked_record#>'{identity,receipt}'; locator:=linked_record#>'{identity,locator}';
    IF NOT occ.turn_journal_phase_includes(l->'originalReceiptRefs',receipt->'receiptRef')
      OR l#>'{locator,installationRef}' IS DISTINCT FROM locator->'installationRef'
      OR l#>'{locator,channelInstallationRef}' IS DISTINCT FROM locator->'channelInstallationRef'
      OR ((value->'duplicate'='true'::jsonb OR value->>'kind' IN ('rejected-existing','resolved-existing')) AND l->>'disposition'<>'duplicate')
      OR (value->'duplicate'='false'::jsonb AND l->>'disposition'<>'original') THEN RETURN false; END IF;
  END IF;
  IF occ.turn_journal_phase_truthy(value->'link') AND occ.turn_journal_phase_truthy(value->'original') THEN
    l:=value->'link'; original:=value->'original';
    IF NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('incomingLink'),l) THEN RETURN false; END IF;
    IF original ? 'intake' THEN
      IF NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('nonTurnReceipt'),original) THEN RETURN false; END IF;
      receipt:=original;
    ELSE
      IF NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('admission'),original) THEN RETURN false; END IF;
      receipt:=original#>'{identity,receipt}';
    END IF;
    IF NOT occ.turn_journal_phase_includes(l->'originalReceiptRefs',receipt->'receiptRef') THEN RETURN false; END IF;
  END IF;
  IF value->>'kind'='non-turn-owned' AND occ.turn_journal_phase_truthy(value->'original') AND occ.turn_journal_phase_truthy(value->'incomingLink') THEN
    original:=value->'original'; l:=value->'incomingLink';
    IF NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('nonTurnReceipt'),original)
      OR NOT occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition('incomingLink'),l)
      OR NOT occ.turn_journal_phase_includes(l->'originalReceiptRefs',original->'receiptRef')
      OR l->>'disposition' IS DISTINCT FROM 'conflict'
      OR l#>'{locator,installationRef}' IS DISTINCT FROM original#>'{intake,installationRef}'
      OR l#>'{locator,channelInstallationRef}' IS DISTINCT FROM original#>'{intake,channelInstallationRef}' THEN RETURN false; END IF;
  END IF;
  IF occ.turn_journal_phase_truthy(value->'slot') AND value#>>'{operation,kind}'='update'
    AND value->'slot' IS DISTINCT FROM '"outcome-status"'::jsonb THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$$;

-- Accepted journal schema metadata for persisted values.
-- checkpointRef is the identical nested accepted CheckpointRefSchema, not a
-- separate definition. The Unknown SDK leaves are checked above from SDK source.
CREATE FUNCTION occ.turn_journal_phase_definition(kind text) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,occ AS $function$
  SELECT $schemas${"lookup":{"anyOf":[{"type":"object","required":["schemaVersion","kind","installationRef","channelInstallationRef","eventKey"],"properties":{"schemaVersion":{"type":"number","const":1},"kind":{"type":"string","const":"event"},"installationRef":{"type":"string","minLength":1,"maxLength":512},"channelInstallationRef":{"type":"string","minLength":1,"maxLength":512},"eventKey":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"additionalProperties":false},{"type":"object","required":["schemaVersion","kind","installationRef","channelInstallationRef","logicalMessageKey"],"properties":{"schemaVersion":{"type":"number","const":1},"kind":{"type":"string","const":"logical-message"},"installationRef":{"type":"string","minLength":1,"maxLength":512},"channelInstallationRef":{"type":"string","minLength":1,"maxLength":512},"logicalMessageKey":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"additionalProperties":false}]},"head":{"type":"object","required":["context","headVersion","completionSequence","checkpointId","creationRef"],"properties":{"context":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"headVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"completionSequence":{"type":"integer","minimum":0,"maximum":9007199254740991},"checkpointId":{"anyOf":[{"type":"string","minLength":1,"maxLength":512},{"type":"null"}]},"creationRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},"admissionIdentity":{"type":"object","required":["locator","receipt","context","principalRef","principalVersion","externalIdentityBindingRef","providerSubjectRef","routeKey","conversationBindingVersion","routingPolicyVersion","commonGrantRef","commonGrantVersion","workspace","audiencePolicyRef","audienceEvidenceRef","audienceVersion","replyDestinationRef","replyBindingVersion","admittedRevisionRef","admittedConfigurationDigest","gatewayAssignment","harnessAssignment","harnessRuntimeGeneration","contentRef"],"properties":{"locator":{},"receipt":{},"context":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"principalRef":{"type":"string","minLength":1,"maxLength":512},"principalVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"externalIdentityBindingRef":{"type":"string","minLength":1,"maxLength":512},"providerSubjectRef":{"type":"string","minLength":1,"maxLength":512},"routeKey":{"type":"string","pattern":"^[a-f0-9]{64}$"},"conversationBindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"routingPolicyVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"commonGrantRef":{"type":"string","minLength":1,"maxLength":512},"commonGrantVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"workspace":{"type":"object","required":["schemaVersion","scope","logicalStoreRef","bindingRef","bindingVersion"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}}},"logicalStoreRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"bindingRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"bindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false},"audiencePolicyRef":{"type":"string","minLength":1,"maxLength":512},"audienceEvidenceRef":{"type":"string","minLength":1,"maxLength":512},"audienceVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"replyDestinationRef":{"type":"string","minLength":1,"maxLength":512},"replyBindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"admittedRevisionRef":{"type":"string","minLength":1,"maxLength":512},"admittedConfigurationDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"gatewayAssignment":{"type":"object","required":["schemaVersion","id"],"properties":{"schemaVersion":{"type":"number","const":1},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"harnessAssignment":{"type":"object","required":["schemaVersion","id"],"properties":{"schemaVersion":{"type":"number","const":1},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"harnessRuntimeGeneration":{"type":"integer","minimum":1,"maximum":9007199254740991},"contentRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},"admission":{"type":"object","required":["schemaVersion","identity","decision","expectedHead","decisionRef","auditIntentRef","decidedAt"],"properties":{"schemaVersion":{"type":"number","const":1},"identity":{"type":"object","required":["locator","receipt","context","principalRef","principalVersion","externalIdentityBindingRef","providerSubjectRef","routeKey","conversationBindingVersion","routingPolicyVersion","commonGrantRef","commonGrantVersion","workspace","audiencePolicyRef","audienceEvidenceRef","audienceVersion","replyDestinationRef","replyBindingVersion","admittedRevisionRef","admittedConfigurationDigest","gatewayAssignment","harnessAssignment","harnessRuntimeGeneration","contentRef"],"properties":{"locator":{},"receipt":{},"context":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"principalRef":{"type":"string","minLength":1,"maxLength":512},"principalVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"externalIdentityBindingRef":{"type":"string","minLength":1,"maxLength":512},"providerSubjectRef":{"type":"string","minLength":1,"maxLength":512},"routeKey":{"type":"string","pattern":"^[a-f0-9]{64}$"},"conversationBindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"routingPolicyVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"commonGrantRef":{"type":"string","minLength":1,"maxLength":512},"commonGrantVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"workspace":{"type":"object","required":["schemaVersion","scope","logicalStoreRef","bindingRef","bindingVersion"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}}},"logicalStoreRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"bindingRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"bindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false},"audiencePolicyRef":{"type":"string","minLength":1,"maxLength":512},"audienceEvidenceRef":{"type":"string","minLength":1,"maxLength":512},"audienceVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"replyDestinationRef":{"type":"string","minLength":1,"maxLength":512},"replyBindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"admittedRevisionRef":{"type":"string","minLength":1,"maxLength":512},"admittedConfigurationDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"gatewayAssignment":{"type":"object","required":["schemaVersion","id"],"properties":{"schemaVersion":{"type":"number","const":1},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"harnessAssignment":{"type":"object","required":["schemaVersion","id"],"properties":{"schemaVersion":{"type":"number","const":1},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"harnessRuntimeGeneration":{"type":"integer","minimum":1,"maximum":9007199254740991},"contentRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},"decision":{"anyOf":[{"type":"object","required":["kind","attempt"],"properties":{"kind":{"type":"string","const":"accepted"},"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false}},"additionalProperties":false},{"type":"object","required":["kind"],"properties":{"kind":{"type":"string","const":"busy"}},"additionalProperties":false},{"type":"object","required":["kind","reason"],"properties":{"kind":{"type":"string","const":"denied"},"reason":{"enum":["unavailable","not-current","unsupported","conflict"]}},"additionalProperties":false},{"type":"object","required":["kind","reason"],"properties":{"kind":{"type":"string","const":"ignored"},"reason":{"enum":["not-addressed","non-turn"]}},"additionalProperties":false}]},"expectedHead":{"type":"object","required":["context","headVersion","completionSequence","checkpointId","creationRef"],"properties":{"context":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"headVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"completionSequence":{"type":"integer","minimum":0,"maximum":9007199254740991},"checkpointId":{"anyOf":[{"type":"string","minLength":1,"maxLength":512},{"type":"null"}]},"creationRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},"decisionRef":{"type":"string","minLength":1,"maxLength":512},"auditIntentRef":{"type":"string","minLength":1,"maxLength":512},"decidedAt":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"}},"additionalProperties":false},"incomingLink":{"type":"object","required":["incomingLinkRef","incomingIdentityDigest","locator","incomingEventDigest","incomingContentDigest","originalReceiptRefs","disposition","auditIntentRef"],"properties":{"incomingLinkRef":{"type":"string","minLength":1,"maxLength":512},"incomingIdentityDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"locator":{},"incomingEventDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"incomingContentDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"originalReceiptRefs":{"type":"array","items":{"type":"string","minLength":1,"maxLength":512},"minItems":1,"maxItems":2,"uniqueItems":true},"disposition":{"enum":["original","duplicate","conflict"]},"auditIntentRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},"commonAttemptBinding":{"type":"object","required":["attempt","identity","reservation","expectedHead"],"properties":{"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"identity":{"type":"object","required":["locator","receipt","context","principalRef","principalVersion","externalIdentityBindingRef","providerSubjectRef","routeKey","conversationBindingVersion","routingPolicyVersion","commonGrantRef","commonGrantVersion","workspace","audiencePolicyRef","audienceEvidenceRef","audienceVersion","replyDestinationRef","replyBindingVersion","admittedRevisionRef","admittedConfigurationDigest","gatewayAssignment","harnessAssignment","harnessRuntimeGeneration","contentRef"],"properties":{"locator":{},"receipt":{},"context":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"principalRef":{"type":"string","minLength":1,"maxLength":512},"principalVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"externalIdentityBindingRef":{"type":"string","minLength":1,"maxLength":512},"providerSubjectRef":{"type":"string","minLength":1,"maxLength":512},"routeKey":{"type":"string","pattern":"^[a-f0-9]{64}$"},"conversationBindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"routingPolicyVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"commonGrantRef":{"type":"string","minLength":1,"maxLength":512},"commonGrantVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"workspace":{"type":"object","required":["schemaVersion","scope","logicalStoreRef","bindingRef","bindingVersion"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}}},"logicalStoreRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"bindingRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"bindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false},"audiencePolicyRef":{"type":"string","minLength":1,"maxLength":512},"audienceEvidenceRef":{"type":"string","minLength":1,"maxLength":512},"audienceVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"replyDestinationRef":{"type":"string","minLength":1,"maxLength":512},"replyBindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"admittedRevisionRef":{"type":"string","minLength":1,"maxLength":512},"admittedConfigurationDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"gatewayAssignment":{"type":"object","required":["schemaVersion","id"],"properties":{"schemaVersion":{"type":"number","const":1},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"harnessAssignment":{"type":"object","required":["schemaVersion","id"],"properties":{"schemaVersion":{"type":"number","const":1},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"harnessRuntimeGeneration":{"type":"integer","minimum":1,"maximum":9007199254740991},"contentRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},"reservation":{"type":"object","required":["schemaVersion","scope","reservationRef","reservationVersion"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}}},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationVersion":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false},"expectedHead":{"type":"object","required":["context","headVersion","completionSequence","checkpointId","creationRef"],"properties":{"context":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"headVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"completionSequence":{"type":"integer","minimum":0,"maximum":9007199254740991},"checkpointId":{"anyOf":[{"type":"string","minLength":1,"maxLength":512},{"type":"null"}]},"creationRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false}},"additionalProperties":false},"attemptBinding":{"type":"object","required":["attempt","identity","reservation","expectedHead","dispatchOperationRef","authorityDecisionRef","expiresAt"],"properties":{"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"identity":{"type":"object","required":["locator","receipt","context","principalRef","principalVersion","externalIdentityBindingRef","providerSubjectRef","routeKey","conversationBindingVersion","routingPolicyVersion","commonGrantRef","commonGrantVersion","workspace","audiencePolicyRef","audienceEvidenceRef","audienceVersion","replyDestinationRef","replyBindingVersion","admittedRevisionRef","admittedConfigurationDigest","gatewayAssignment","harnessAssignment","harnessRuntimeGeneration","contentRef"],"properties":{"locator":{},"receipt":{},"context":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"principalRef":{"type":"string","minLength":1,"maxLength":512},"principalVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"externalIdentityBindingRef":{"type":"string","minLength":1,"maxLength":512},"providerSubjectRef":{"type":"string","minLength":1,"maxLength":512},"routeKey":{"type":"string","pattern":"^[a-f0-9]{64}$"},"conversationBindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"routingPolicyVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"commonGrantRef":{"type":"string","minLength":1,"maxLength":512},"commonGrantVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"workspace":{"type":"object","required":["schemaVersion","scope","logicalStoreRef","bindingRef","bindingVersion"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}}},"logicalStoreRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"bindingRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"bindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false},"audiencePolicyRef":{"type":"string","minLength":1,"maxLength":512},"audienceEvidenceRef":{"type":"string","minLength":1,"maxLength":512},"audienceVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"replyDestinationRef":{"type":"string","minLength":1,"maxLength":512},"replyBindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"admittedRevisionRef":{"type":"string","minLength":1,"maxLength":512},"admittedConfigurationDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"gatewayAssignment":{"type":"object","required":["schemaVersion","id"],"properties":{"schemaVersion":{"type":"number","const":1},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"harnessAssignment":{"type":"object","required":["schemaVersion","id"],"properties":{"schemaVersion":{"type":"number","const":1},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"harnessRuntimeGeneration":{"type":"integer","minimum":1,"maximum":9007199254740991},"contentRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},"reservation":{"type":"object","required":["schemaVersion","scope","reservationRef","reservationVersion"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}}},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationVersion":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false},"expectedHead":{"type":"object","required":["context","headVersion","completionSequence","checkpointId","creationRef"],"properties":{"context":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"headVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"completionSequence":{"type":"integer","minimum":0,"maximum":9007199254740991},"checkpointId":{"anyOf":[{"type":"string","minLength":1,"maxLength":512},{"type":"null"}]},"creationRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},"dispatchOperationRef":{"type":"string","minLength":1,"maxLength":512},"authorityDecisionRef":{"type":"string","minLength":1,"maxLength":512},"expiresAt":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"}},"additionalProperties":false},"attempt":{"anyOf":[{"type":"object","required":["phase","binding","version","consumption","outcome"],"properties":{"phase":{"type":"string","const":"admitted-undispatched"},"binding":{"type":"object","required":["attempt","identity","reservation","expectedHead"],"properties":{"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"identity":{"type":"object","required":["locator","receipt","context","principalRef","principalVersion","externalIdentityBindingRef","providerSubjectRef","routeKey","conversationBindingVersion","routingPolicyVersion","commonGrantRef","commonGrantVersion","workspace","audiencePolicyRef","audienceEvidenceRef","audienceVersion","replyDestinationRef","replyBindingVersion","admittedRevisionRef","admittedConfigurationDigest","gatewayAssignment","harnessAssignment","harnessRuntimeGeneration","contentRef"],"properties":{"locator":{},"receipt":{},"context":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"principalRef":{"type":"string","minLength":1,"maxLength":512},"principalVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"externalIdentityBindingRef":{"type":"string","minLength":1,"maxLength":512},"providerSubjectRef":{"type":"string","minLength":1,"maxLength":512},"routeKey":{"type":"string","pattern":"^[a-f0-9]{64}$"},"conversationBindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"routingPolicyVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"commonGrantRef":{"type":"string","minLength":1,"maxLength":512},"commonGrantVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"workspace":{"type":"object","required":["schemaVersion","scope","logicalStoreRef","bindingRef","bindingVersion"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}}},"logicalStoreRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"bindingRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"bindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false},"audiencePolicyRef":{"type":"string","minLength":1,"maxLength":512},"audienceEvidenceRef":{"type":"string","minLength":1,"maxLength":512},"audienceVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"replyDestinationRef":{"type":"string","minLength":1,"maxLength":512},"replyBindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"admittedRevisionRef":{"type":"string","minLength":1,"maxLength":512},"admittedConfigurationDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"gatewayAssignment":{"type":"object","required":["schemaVersion","id"],"properties":{"schemaVersion":{"type":"number","const":1},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"harnessAssignment":{"type":"object","required":["schemaVersion","id"],"properties":{"schemaVersion":{"type":"number","const":1},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"harnessRuntimeGeneration":{"type":"integer","minimum":1,"maximum":9007199254740991},"contentRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},"reservation":{"type":"object","required":["schemaVersion","scope","reservationRef","reservationVersion"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}}},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationVersion":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false},"expectedHead":{"type":"object","required":["context","headVersion","completionSequence","checkpointId","creationRef"],"properties":{"context":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"headVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"completionSequence":{"type":"integer","minimum":0,"maximum":9007199254740991},"checkpointId":{"anyOf":[{"type":"string","minLength":1,"maxLength":512},{"type":"null"}]},"creationRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false}},"additionalProperties":false},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"consumption":{"type":"null"},"outcome":{"anyOf":[{"type":"object","required":["kind"],"properties":{"kind":{"type":"string","const":"accepted-undispatched"}},"additionalProperties":false},{"type":"object","required":["kind","stage","evidenceRef"],"properties":{"kind":{"enum":["failed","interrupted","outcome-unknown","cancelled"]},"stage":{"type":"string","const":"before-dispatch"},"evidenceRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false}]}},"additionalProperties":false},{"type":"object","required":["binding","version","consumption","outcome"],"properties":{"binding":{"type":"object","required":["attempt","identity","reservation","expectedHead","dispatchOperationRef","authorityDecisionRef","expiresAt"],"properties":{"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"identity":{"type":"object","required":["locator","receipt","context","principalRef","principalVersion","externalIdentityBindingRef","providerSubjectRef","routeKey","conversationBindingVersion","routingPolicyVersion","commonGrantRef","commonGrantVersion","workspace","audiencePolicyRef","audienceEvidenceRef","audienceVersion","replyDestinationRef","replyBindingVersion","admittedRevisionRef","admittedConfigurationDigest","gatewayAssignment","harnessAssignment","harnessRuntimeGeneration","contentRef"],"properties":{"locator":{},"receipt":{},"context":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"principalRef":{"type":"string","minLength":1,"maxLength":512},"principalVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"externalIdentityBindingRef":{"type":"string","minLength":1,"maxLength":512},"providerSubjectRef":{"type":"string","minLength":1,"maxLength":512},"routeKey":{"type":"string","pattern":"^[a-f0-9]{64}$"},"conversationBindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"routingPolicyVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"commonGrantRef":{"type":"string","minLength":1,"maxLength":512},"commonGrantVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"workspace":{"type":"object","required":["schemaVersion","scope","logicalStoreRef","bindingRef","bindingVersion"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}}},"logicalStoreRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"bindingRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"bindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false},"audiencePolicyRef":{"type":"string","minLength":1,"maxLength":512},"audienceEvidenceRef":{"type":"string","minLength":1,"maxLength":512},"audienceVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"replyDestinationRef":{"type":"string","minLength":1,"maxLength":512},"replyBindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"admittedRevisionRef":{"type":"string","minLength":1,"maxLength":512},"admittedConfigurationDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"gatewayAssignment":{"type":"object","required":["schemaVersion","id"],"properties":{"schemaVersion":{"type":"number","const":1},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"harnessAssignment":{"type":"object","required":["schemaVersion","id"],"properties":{"schemaVersion":{"type":"number","const":1},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"harnessRuntimeGeneration":{"type":"integer","minimum":1,"maximum":9007199254740991},"contentRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},"reservation":{"type":"object","required":["schemaVersion","scope","reservationRef","reservationVersion"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}}},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationVersion":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false},"expectedHead":{"type":"object","required":["context","headVersion","completionSequence","checkpointId","creationRef"],"properties":{"context":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"headVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"completionSequence":{"type":"integer","minimum":0,"maximum":9007199254740991},"checkpointId":{"anyOf":[{"type":"string","minLength":1,"maxLength":512},{"type":"null"}]},"creationRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},"dispatchOperationRef":{"type":"string","minLength":1,"maxLength":512},"authorityDecisionRef":{"type":"string","minLength":1,"maxLength":512},"expiresAt":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"}},"additionalProperties":false},"version":{"type":"integer","minimum":1,"maximum":9007199254740991},"consumption":{"anyOf":[{"type":"null"},{"type":"object","required":["operation","consumedAt"],"properties":{"operation":{"type":"object","required":["schemaVersion","attempt","operationRef","claimantRef","requestDigest"],"properties":{"schemaVersion":{"type":"number","const":1},"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"claimantRef":{"type":"string","minLength":1,"maxLength":512},"requestDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"additionalProperties":false},"consumedAt":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"}},"additionalProperties":false}]},"outcome":{"anyOf":[{"type":"object","required":["kind"],"properties":{"kind":{"type":"string","const":"accepted-undispatched"}},"additionalProperties":false},{"type":"object","required":["kind","dispatchOperationRef"],"properties":{"kind":{"type":"string","const":"dispatch-intent"},"dispatchOperationRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},{"type":"object","required":["kind","consumptionOperationRef","consumedAt"],"properties":{"kind":{"type":"string","const":"consumed"},"consumptionOperationRef":{"type":"string","minLength":1,"maxLength":512},"consumedAt":{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"}},"additionalProperties":false},{"type":"object","required":["kind","nativeSessionRef","nativeTurnRef"],"properties":{"kind":{"type":"string","const":"running"},"nativeSessionRef":{"type":"string","minLength":1,"maxLength":512},"nativeTurnRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},{"type":"object","required":["kind","checkpoint","completionOperationRef"],"properties":{"kind":{"type":"string","const":"completed"},"checkpoint":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef","schemaVersion","checkpointId","completionSequence","parentCheckpointId","contentDigest","byteLength","itemCount","revisionRef","admittedConfigurationDigest","revisionLineageRef","producingGatewayAssignmentRef","producingHarnessAssignmentRef","producerTuple","gatewayStoreBindingRef","workspaceBindingRef","workspaceCompletionRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"schemaVersion":{"type":"number","const":1},"checkpointId":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"completionSequence":{"type":"integer","minimum":1,"maximum":9007199254740991},"parentCheckpointId":{"anyOf":[{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},{"type":"null"}]},"contentDigest":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[0-9a-f]{64}$"},"byteLength":{"type":"integer","minimum":1,"maximum":8388608},"itemCount":{"type":"integer","minimum":0,"maximum":16384},"revisionRef":{"type":"string","pattern":"^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"admittedConfigurationDigest":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[0-9a-f]{64}$"},"revisionLineageRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"producingGatewayAssignmentRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"producingHarnessAssignmentRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"producerTuple":{"type":"object","required":["enterpriseCommit","upstreamCommit","codexCommit","codexVersion","gatewayProtocol","nativeStateSchema","nativeAgentSchema","adapterSchema","contextFormat","nativeImportContract","nativeImportAdapterDigest","artifactLedgerRef"],"properties":{"enterpriseCommit":{"type":"string","minLength":40,"maxLength":40,"pattern":"^[0-9a-f]{40}$"},"upstreamCommit":{"type":"string","minLength":40,"maxLength":40,"pattern":"^[0-9a-f]{40}$"},"codexCommit":{"type":"string","minLength":40,"maxLength":40,"pattern":"^[0-9a-f]{40}$"},"codexVersion":{"type":"string","const":"0.153.0"},"gatewayProtocol":{"type":"number","const":4},"nativeStateSchema":{"type":"number","const":15},"nativeAgentSchema":{"type":"number","const":19},"adapterSchema":{"type":"number","const":1},"contextFormat":{"type":"string","const":"completed-context-text-v1"},"nativeImportContract":{"type":"number","const":1},"nativeImportAdapterDigest":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[0-9a-f]{64}$"},"artifactLedgerRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"gatewayStoreBindingRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"workspaceBindingRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"workspaceCompletionRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"completionOperationRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},{"type":"object","required":["kind","stage","evidenceRef"],"properties":{"kind":{"enum":["failed","interrupted","outcome-unknown","cancelled"]},"stage":{"enum":["before-dispatch","dispatch","execution","checkpoint"]},"evidenceRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false}]}},"additionalProperties":false}]},"consumption":{"type":"object","required":["schemaVersion","attempt","operationRef","claimantRef","requestDigest"],"properties":{"schemaVersion":{"type":"number","const":1},"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"claimantRef":{"type":"string","minLength":1,"maxLength":512},"requestDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"additionalProperties":false},"checkpointAllocation":{"type":"object","required":["schemaVersion","attempt","operationRef","checkpointId","expectedHead"],"properties":{"schemaVersion":{"type":"number","const":1},"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"checkpointId":{"type":"string","minLength":1,"maxLength":512},"expectedHead":{"type":"object","required":["context","headVersion","completionSequence","checkpointId","creationRef"],"properties":{"context":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"headVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"completionSequence":{"type":"integer","minimum":0,"maximum":9007199254740991},"checkpointId":{"anyOf":[{"type":"string","minLength":1,"maxLength":512},{"type":"null"}]},"creationRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false}},"additionalProperties":false},"completionOperation":{"type":"object","required":["schemaVersion","attempt","operationRef","checkpointId","expectedCompletionSequence","expectedAttemptVersion","requestDigest"],"properties":{"schemaVersion":{"type":"number","const":1},"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"checkpointId":{"type":"string","minLength":1,"maxLength":512},"expectedCompletionSequence":{"type":"integer","minimum":0,"maximum":9007199254740991},"expectedAttemptVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"requestDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"additionalProperties":false},"completion":{"type":"object","required":["operation","checkpoint","head","outcomeVersion","pendingDelivery"],"properties":{"operation":{"type":"object","required":["schemaVersion","attempt","operationRef","checkpointId","expectedCompletionSequence","expectedAttemptVersion","requestDigest"],"properties":{"schemaVersion":{"type":"number","const":1},"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"checkpointId":{"type":"string","minLength":1,"maxLength":512},"expectedCompletionSequence":{"type":"integer","minimum":0,"maximum":9007199254740991},"expectedAttemptVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"requestDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"additionalProperties":false},"checkpoint":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef","schemaVersion","checkpointId","completionSequence","parentCheckpointId","contentDigest","byteLength","itemCount","revisionRef","admittedConfigurationDigest","revisionLineageRef","producingGatewayAssignmentRef","producingHarnessAssignmentRef","producerTuple","gatewayStoreBindingRef","workspaceBindingRef","workspaceCompletionRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"schemaVersion":{"type":"number","const":1},"checkpointId":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"completionSequence":{"type":"integer","minimum":1,"maximum":9007199254740991},"parentCheckpointId":{"anyOf":[{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},{"type":"null"}]},"contentDigest":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[0-9a-f]{64}$"},"byteLength":{"type":"integer","minimum":1,"maximum":8388608},"itemCount":{"type":"integer","minimum":0,"maximum":16384},"revisionRef":{"type":"string","pattern":"^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"admittedConfigurationDigest":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[0-9a-f]{64}$"},"revisionLineageRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"producingGatewayAssignmentRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"producingHarnessAssignmentRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"producerTuple":{"type":"object","required":["enterpriseCommit","upstreamCommit","codexCommit","codexVersion","gatewayProtocol","nativeStateSchema","nativeAgentSchema","adapterSchema","contextFormat","nativeImportContract","nativeImportAdapterDigest","artifactLedgerRef"],"properties":{"enterpriseCommit":{"type":"string","minLength":40,"maxLength":40,"pattern":"^[0-9a-f]{40}$"},"upstreamCommit":{"type":"string","minLength":40,"maxLength":40,"pattern":"^[0-9a-f]{40}$"},"codexCommit":{"type":"string","minLength":40,"maxLength":40,"pattern":"^[0-9a-f]{40}$"},"codexVersion":{"type":"string","const":"0.153.0"},"gatewayProtocol":{"type":"number","const":4},"nativeStateSchema":{"type":"number","const":15},"nativeAgentSchema":{"type":"number","const":19},"adapterSchema":{"type":"number","const":1},"contextFormat":{"type":"string","const":"completed-context-text-v1"},"nativeImportContract":{"type":"number","const":1},"nativeImportAdapterDigest":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[0-9a-f]{64}$"},"artifactLedgerRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"gatewayStoreBindingRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"workspaceBindingRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"workspaceCompletionRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"head":{"type":"object","required":["context","headVersion","completionSequence","checkpointId","creationRef"],"properties":{"context":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"headVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"completionSequence":{"type":"integer","minimum":0,"maximum":9007199254740991},"checkpointId":{"anyOf":[{"type":"string","minLength":1,"maxLength":512},{"type":"null"}]},"creationRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},"outcomeVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"pendingDelivery":{"type":"object","required":["schemaVersion","attempt","operationRef","outputRef","outputDigest","outcomeVersion","slot","replyDestinationRef","replyBindingVersion","operation"],"properties":{"schemaVersion":{"type":"number","const":1},"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"outputRef":{"type":"string","minLength":1,"maxLength":512},"outputDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"outcomeVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"slot":{"enum":["completed-result","outcome-status","cancel-ack"]},"replyDestinationRef":{"type":"string","minLength":1,"maxLength":512},"replyBindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"operation":{"anyOf":[{"type":"object","required":["kind"],"properties":{"kind":{"type":"string","const":"create"}},"additionalProperties":false},{"type":"object","required":["kind","providerMessageRef"],"properties":{"kind":{"type":"string","const":"update"},"providerMessageRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false}]}},"additionalProperties":false}},"additionalProperties":false},"outcomeOperation":{"type":"object","required":["schemaVersion","attempt","operationRef","expectedAttemptVersion","outcome","requestDigest"],"properties":{"schemaVersion":{"type":"number","const":1},"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"expectedAttemptVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"outcome":{"anyOf":[{"type":"object","required":["kind","nativeSessionRef","nativeTurnRef"],"properties":{"kind":{"type":"string","const":"running"},"nativeSessionRef":{"type":"string","minLength":1,"maxLength":512},"nativeTurnRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},{"type":"object","required":["kind","stage","evidenceRef"],"properties":{"kind":{"enum":["failed","interrupted","outcome-unknown","cancelled"]},"stage":{"enum":["before-dispatch","dispatch","execution","checkpoint"]},"evidenceRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false}]},"requestDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"additionalProperties":false},"cancellation":{"type":"object","required":["schemaVersion","attempt","operationRef","requesterPrincipalRef","originalPrincipalRef","expectedAttemptVersion","requestDigest"],"properties":{"schemaVersion":{"type":"number","const":1},"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"requesterPrincipalRef":{"type":"string","minLength":1,"maxLength":512},"originalPrincipalRef":{"type":"string","minLength":1,"maxLength":512},"expectedAttemptVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"requestDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"additionalProperties":false},"deliveryOperation":{"type":"object","required":["schemaVersion","attempt","operationRef","outputRef","outputDigest","outcomeVersion","slot","replyDestinationRef","replyBindingVersion","operation"],"properties":{"schemaVersion":{"type":"number","const":1},"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"outputRef":{"type":"string","minLength":1,"maxLength":512},"outputDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"outcomeVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"slot":{"enum":["completed-result","outcome-status","cancel-ack"]},"replyDestinationRef":{"type":"string","minLength":1,"maxLength":512},"replyBindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"operation":{"anyOf":[{"type":"object","required":["kind"],"properties":{"kind":{"type":"string","const":"create"}},"additionalProperties":false},{"type":"object","required":["kind","providerMessageRef"],"properties":{"kind":{"type":"string","const":"update"},"providerMessageRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false}]}},"additionalProperties":false},"delivery":{"type":"object","required":["operation","deliveryAttemptRef","outcome"],"properties":{"operation":{"type":"object","required":["schemaVersion","attempt","operationRef","outputRef","outputDigest","outcomeVersion","slot","replyDestinationRef","replyBindingVersion","operation"],"properties":{"schemaVersion":{"type":"number","const":1},"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"operationRef":{"type":"string","minLength":1,"maxLength":512},"outputRef":{"type":"string","minLength":1,"maxLength":512},"outputDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"outcomeVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"slot":{"enum":["completed-result","outcome-status","cancel-ack"]},"replyDestinationRef":{"type":"string","minLength":1,"maxLength":512},"replyBindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"operation":{"anyOf":[{"type":"object","required":["kind"],"properties":{"kind":{"type":"string","const":"create"}},"additionalProperties":false},{"type":"object","required":["kind","providerMessageRef"],"properties":{"kind":{"type":"string","const":"update"},"providerMessageRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false}]}},"additionalProperties":false},"deliveryAttemptRef":{"type":"string","minLength":1,"maxLength":512},"outcome":{"anyOf":[{"type":"object","required":["kind","providerMessageRef"],"properties":{"kind":{"type":"string","const":"delivered"},"providerMessageRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false},{"type":"object","required":["kind","retryClass"],"properties":{"kind":{"type":"string","const":"definitive-no-effect"},"retryClass":{"enum":["transient","permanent"]}},"additionalProperties":false},{"type":"object","required":["kind"],"properties":{"kind":{"type":"string","const":"delivery-unknown"}},"additionalProperties":false},{"type":"object","required":["kind","reason"],"properties":{"kind":{"type":"string","const":"suppressed"},"reason":{"enum":["not-current","unsupported","slot-unavailable"]}},"additionalProperties":false}]}},"additionalProperties":false},"releaseObservation":{"type":"object","required":["attempt","reservation","workspace","releaseOperationRef","noMutatorEvidenceRef","closedOwnerInventoryRef","closedOwnerInventoryVersion","closedOwnerInventoryDigest","expectedAttemptVersion"],"properties":{"attempt":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"reservation":{"type":"object","required":["schemaVersion","scope","reservationRef","reservationVersion"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}}},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationVersion":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false},"workspace":{"type":"object","required":["schemaVersion","scope","logicalStoreRef","bindingRef","bindingVersion"],"properties":{"schemaVersion":{"type":"number","const":1},"scope":{"type":"object","required":["installationId","namespaceId","agentId"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}}},"logicalStoreRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"bindingRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"bindingVersion":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false},"releaseOperationRef":{"type":"string","minLength":1,"maxLength":512},"noMutatorEvidenceRef":{"type":"string","minLength":1,"maxLength":512},"closedOwnerInventoryRef":{"type":"string","minLength":1,"maxLength":512},"closedOwnerInventoryVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"closedOwnerInventoryDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"expectedAttemptVersion":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false},"checkpointRef":{"type":"object","required":["installationRef","namespaceRef","agentRef","conversationRef","turnRef","attemptRef","reservationRef","schemaVersion","checkpointId","completionSequence","parentCheckpointId","contentDigest","byteLength","itemCount","revisionRef","admittedConfigurationDigest","revisionLineageRef","producingGatewayAssignmentRef","producingHarnessAssignmentRef","producerTuple","gatewayStoreBindingRef","workspaceBindingRef","workspaceCompletionRef"],"properties":{"installationRef":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceRef":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentRef":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"conversationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"turnRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"attemptRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"reservationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"schemaVersion":{"type":"number","const":1},"checkpointId":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"completionSequence":{"type":"integer","minimum":1,"maximum":9007199254740991},"parentCheckpointId":{"anyOf":[{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},{"type":"null"}]},"contentDigest":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[0-9a-f]{64}$"},"byteLength":{"type":"integer","minimum":1,"maximum":8388608},"itemCount":{"type":"integer","minimum":0,"maximum":16384},"revisionRef":{"type":"string","pattern":"^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"admittedConfigurationDigest":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[0-9a-f]{64}$"},"revisionLineageRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"producingGatewayAssignmentRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"producingHarnessAssignmentRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"producerTuple":{"type":"object","required":["enterpriseCommit","upstreamCommit","codexCommit","codexVersion","gatewayProtocol","nativeStateSchema","nativeAgentSchema","adapterSchema","contextFormat","nativeImportContract","nativeImportAdapterDigest","artifactLedgerRef"],"properties":{"enterpriseCommit":{"type":"string","minLength":40,"maxLength":40,"pattern":"^[0-9a-f]{40}$"},"upstreamCommit":{"type":"string","minLength":40,"maxLength":40,"pattern":"^[0-9a-f]{40}$"},"codexCommit":{"type":"string","minLength":40,"maxLength":40,"pattern":"^[0-9a-f]{40}$"},"codexVersion":{"type":"string","const":"0.153.0"},"gatewayProtocol":{"type":"number","const":4},"nativeStateSchema":{"type":"number","const":15},"nativeAgentSchema":{"type":"number","const":19},"adapterSchema":{"type":"number","const":1},"contextFormat":{"type":"string","const":"completed-context-text-v1"},"nativeImportContract":{"type":"number","const":1},"nativeImportAdapterDigest":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[0-9a-f]{64}$"},"artifactLedgerRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"gatewayStoreBindingRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"workspaceBindingRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"workspaceCompletionRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"}},"additionalProperties":false},"nonTurnIntake":{"anyOf":[{"type":"object","required":["schemaVersion","installationRef","channelInstallationRef","platform","providerTenantRef","recipientAppRef","eventKey","eventDigest","normalizationProfileRef","classification","logicalMessage"],"properties":{"schemaVersion":{"type":"number","const":1},"installationRef":{"type":"string","minLength":1,"maxLength":512},"channelInstallationRef":{"type":"string","minLength":1,"maxLength":512},"platform":{"enum":["slack","msteams"]},"providerTenantRef":{"type":"string","minLength":1,"maxLength":512},"recipientAppRef":{"type":"string","minLength":1,"maxLength":512},"eventKey":{"type":"string","pattern":"^[a-f0-9]{64}$"},"eventDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"normalizationProfileRef":{"type":"string","minLength":1,"maxLength":512},"classification":{"enum":["bot-original","unaddressed-original"]},"logicalMessage":{"type":"object","required":["kind","logicalMessageKey"],"properties":{"kind":{"type":"string","const":"equivalent-original"},"logicalMessageKey":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"additionalProperties":false}},"additionalProperties":false},{"type":"object","required":["schemaVersion","installationRef","channelInstallationRef","platform","providerTenantRef","recipientAppRef","eventKey","eventDigest","normalizationProfileRef","classification","logicalMessage"],"properties":{"schemaVersion":{"type":"number","const":1},"installationRef":{"type":"string","minLength":1,"maxLength":512},"channelInstallationRef":{"type":"string","minLength":1,"maxLength":512},"platform":{"enum":["slack","msteams"]},"providerTenantRef":{"type":"string","minLength":1,"maxLength":512},"recipientAppRef":{"type":"string","minLength":1,"maxLength":512},"eventKey":{"type":"string","pattern":"^[a-f0-9]{64}$"},"eventDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"normalizationProfileRef":{"type":"string","minLength":1,"maxLength":512},"classification":{"enum":["edit","delete","reaction"]},"logicalMessage":{"type":"object","required":["kind","logicalMessageKey"],"properties":{"kind":{"type":"string","const":"related-only"},"logicalMessageKey":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"additionalProperties":false}},"additionalProperties":false},{"type":"object","required":["schemaVersion","installationRef","channelInstallationRef","platform","providerTenantRef","recipientAppRef","eventKey","eventDigest","normalizationProfileRef","classification","logicalMessage"],"properties":{"schemaVersion":{"type":"number","const":1},"installationRef":{"type":"string","minLength":1,"maxLength":512},"channelInstallationRef":{"type":"string","minLength":1,"maxLength":512},"platform":{"enum":["slack","msteams"]},"providerTenantRef":{"type":"string","minLength":1,"maxLength":512},"recipientAppRef":{"type":"string","minLength":1,"maxLength":512},"eventKey":{"type":"string","pattern":"^[a-f0-9]{64}$"},"eventDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"normalizationProfileRef":{"type":"string","minLength":1,"maxLength":512},"classification":{"type":"string","const":"typing-control"},"logicalMessage":{"type":"object","required":["kind"],"properties":{"kind":{"type":"string","const":"not-applicable"}},"additionalProperties":false}},"additionalProperties":false}]},"nonTurnReceipt":{"type":"object","required":["schemaVersion","receiptRef","intake","disposition","incomingLinkRef","originalReceiptRefs","auditIntentRef"],"properties":{"schemaVersion":{"type":"number","const":1},"receiptRef":{"type":"string","minLength":1,"maxLength":512},"intake":{"anyOf":[{"type":"object","required":["schemaVersion","installationRef","channelInstallationRef","platform","providerTenantRef","recipientAppRef","eventKey","eventDigest","normalizationProfileRef","classification","logicalMessage"],"properties":{"schemaVersion":{"type":"number","const":1},"installationRef":{"type":"string","minLength":1,"maxLength":512},"channelInstallationRef":{"type":"string","minLength":1,"maxLength":512},"platform":{"enum":["slack","msteams"]},"providerTenantRef":{"type":"string","minLength":1,"maxLength":512},"recipientAppRef":{"type":"string","minLength":1,"maxLength":512},"eventKey":{"type":"string","pattern":"^[a-f0-9]{64}$"},"eventDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"normalizationProfileRef":{"type":"string","minLength":1,"maxLength":512},"classification":{"enum":["bot-original","unaddressed-original"]},"logicalMessage":{"type":"object","required":["kind","logicalMessageKey"],"properties":{"kind":{"type":"string","const":"equivalent-original"},"logicalMessageKey":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"additionalProperties":false}},"additionalProperties":false},{"type":"object","required":["schemaVersion","installationRef","channelInstallationRef","platform","providerTenantRef","recipientAppRef","eventKey","eventDigest","normalizationProfileRef","classification","logicalMessage"],"properties":{"schemaVersion":{"type":"number","const":1},"installationRef":{"type":"string","minLength":1,"maxLength":512},"channelInstallationRef":{"type":"string","minLength":1,"maxLength":512},"platform":{"enum":["slack","msteams"]},"providerTenantRef":{"type":"string","minLength":1,"maxLength":512},"recipientAppRef":{"type":"string","minLength":1,"maxLength":512},"eventKey":{"type":"string","pattern":"^[a-f0-9]{64}$"},"eventDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"normalizationProfileRef":{"type":"string","minLength":1,"maxLength":512},"classification":{"enum":["edit","delete","reaction"]},"logicalMessage":{"type":"object","required":["kind","logicalMessageKey"],"properties":{"kind":{"type":"string","const":"related-only"},"logicalMessageKey":{"type":"string","pattern":"^[a-f0-9]{64}$"}},"additionalProperties":false}},"additionalProperties":false},{"type":"object","required":["schemaVersion","installationRef","channelInstallationRef","platform","providerTenantRef","recipientAppRef","eventKey","eventDigest","normalizationProfileRef","classification","logicalMessage"],"properties":{"schemaVersion":{"type":"number","const":1},"installationRef":{"type":"string","minLength":1,"maxLength":512},"channelInstallationRef":{"type":"string","minLength":1,"maxLength":512},"platform":{"enum":["slack","msteams"]},"providerTenantRef":{"type":"string","minLength":1,"maxLength":512},"recipientAppRef":{"type":"string","minLength":1,"maxLength":512},"eventKey":{"type":"string","pattern":"^[a-f0-9]{64}$"},"eventDigest":{"type":"string","pattern":"^[a-f0-9]{64}$"},"normalizationProfileRef":{"type":"string","minLength":1,"maxLength":512},"classification":{"type":"string","const":"typing-control"},"logicalMessage":{"type":"object","required":["kind"],"properties":{"kind":{"type":"string","const":"not-applicable"}},"additionalProperties":false}},"additionalProperties":false}]},"disposition":{"enum":["ignored","conflict"]},"incomingLinkRef":{"type":"string","minLength":1,"maxLength":512},"originalReceiptRefs":{"type":"array","items":{"type":"string","minLength":1,"maxLength":512},"maxItems":2,"uniqueItems":true},"auditIntentRef":{"type":"string","minLength":1,"maxLength":512}},"additionalProperties":false}}$schemas$::jsonb->kind;
$function$;

-- This is a validation view, never a retained value or an equality projection.
-- Keep the three nominal owner fields only at the exact open schema paths.
-- Arbitrary scope extensions are validated by the original JavaScript codecs;
-- no recursive search for similarly named properties is performed here.
CREATE FUNCTION occ.turn_journal_phase_core_value(kind text,value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,occ AS $$
DECLARE paths jsonb:='[]'::jsonb; path_value jsonb; scope_path text[];
  scope_value jsonb; projected jsonb:=value;
BEGIN
  CASE kind
    WHEN 'admissionIdentity' THEN paths:='[["workspace","scope"]]'::jsonb;
    WHEN 'admission' THEN paths:='[["identity","workspace","scope"]]'::jsonb;
    WHEN 'commonAttemptBinding','attemptBinding' THEN
      paths:='[["identity","workspace","scope"],["reservation","scope"]]'::jsonb;
    WHEN 'attempt' THEN
      paths:='[["binding","identity","workspace","scope"],["binding","reservation","scope"]]'::jsonb;
    WHEN 'releaseObservation' THEN paths:='[["workspace","scope"],["reservation","scope"]]'::jsonb;
    ELSE NULL;
  END CASE;
  FOR path_value IN SELECT jsonb_array_elements(paths) LOOP
    SELECT array_agg(e.value ORDER BY e.ordinality) INTO scope_path
      FROM jsonb_array_elements_text(path_value) WITH ORDINALITY AS e(value,ordinality);
    scope_value:=value#>scope_path;
    projected:=jsonb_set(projected,scope_path,jsonb_build_object(
      'installationId',scope_value->'installationId',
      'namespaceId',scope_value->'namespaceId','agentId',scope_value->'agentId'),false);
  END LOOP;
  RETURN projected;
END;
$$;

CREATE FUNCTION occ.turn_journal_phase_value_valid(kind text,value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,occ AS $$
BEGIN
  IF (value IS NOT NULL AND octet_length(value::text) BETWEEN 1 AND 65536
    AND occ.turn_journal_phase_schema_matches(occ.turn_journal_phase_definition(kind),value)) IS NOT TRUE THEN
    RETURN false;
  END IF;
  RETURN (occ.turn_journal_phase_intrinsic(occ.turn_journal_phase_core_value(kind,value))
    AND (kind<>'checkpointRef' OR occ.turn_journal_phase_intrinsic(jsonb_build_object('checkpoint',value)))) IS TRUE;
END;
$$;

CREATE FUNCTION occ.turn_journal_phase_exact_attempt(row_value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,occ AS $$
  SELECT jsonb_build_object('installationRef',row_value->'installation_id','namespaceRef',row_value->'namespace_id',
    'agentRef',row_value->'agent_id','conversationRef',row_value->'conversation_ref','turnRef',row_value->'turn_ref',
    'attemptRef',row_value->'attempt_ref','reservationRef',row_value->'reservation_ref');
$$;

CREATE FUNCTION occ.turn_journal_phase_common_binding(record_value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,occ AS $$
  SELECT record_value->'binding'-ARRAY['dispatchOperationRef','authorityDecisionRef','expiresAt'];
$$;

CREATE FUNCTION occ.turn_journal_phase_before_cancel(record_value jsonb,operation_value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,occ AS $$
  SELECT (occ.turn_journal_phase_value_valid('attempt',record_value)
    AND occ.turn_journal_phase_value_valid('cancellation',operation_value)
    AND record_value->'version'=operation_value->'expectedAttemptVersion'
    AND (record_value->>'version')::numeric<9007199254740991
    AND record_value#>'{binding,attempt}'=operation_value->'attempt'
    AND record_value#>'{binding,identity,principalRef}'=operation_value->'originalPrincipalRef'
    AND record_value#>>'{outcome,kind}'='accepted-undispatched'
    AND record_value->'consumption'='null'::jsonb) IS TRUE;
$$;

CREATE FUNCTION occ.turn_journal_phase_operation_value(row_value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,occ AS $$
DECLARE request_value jsonb:=row_value->'request'; record_value jsonb:=row_value->'record'; kind text:=row_value->>'operation_kind';
BEGIN
  IF request_value->'attempt' IS DISTINCT FROM occ.turn_journal_phase_exact_attempt(row_value)
    OR (CASE WHEN kind='release' THEN request_value->'releaseOperationRef' ELSE request_value->'operationRef' END)
      IS DISTINCT FROM row_value->'operation_ref' THEN RETURN false; END IF;
  CASE kind
    WHEN 'checkpoint-allocation' THEN RETURN occ.turn_journal_phase_value_valid('checkpointAllocation',request_value) AND request_value=record_value;
    WHEN 'completion' THEN RETURN occ.turn_journal_phase_value_valid('completionOperation',request_value)
      AND occ.turn_journal_phase_value_valid('completion',record_value) AND record_value->'operation'=request_value;
    WHEN 'outcome' THEN RETURN occ.turn_journal_phase_value_valid('outcomeOperation',request_value)
      AND occ.turn_journal_phase_value_valid('attempt',record_value)
      AND record_value#>'{binding,attempt}'=request_value->'attempt' AND record_value->'outcome'=request_value->'outcome'
      AND (record_value->>'version')::numeric=(request_value->>'expectedAttemptVersion')::numeric+1;
    WHEN 'cancellation' THEN RETURN occ.turn_journal_phase_value_valid('cancellation',request_value)
      AND jsonb_typeof(record_value)='object' AND record_value ?& ARRAY['operation','outcome']
      AND record_value-ARRAY['operation','outcome']='{}'::jsonb AND record_value->'operation'=request_value
      AND record_value->'outcome' IN ('"requested"'::jsonb,'"cancelled-before-dispatch"'::jsonb);
    WHEN 'release' THEN RETURN occ.turn_journal_phase_value_valid('releaseObservation',request_value) AND request_value=record_value;
    ELSE RETURN false;
  END CASE;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$$;

-- No row is changed until every retained attempt and its immutable owner/history
-- has passed preflight. This table binds the exact old bytes to their one allowed
-- replacement; it is private to the owning migration session and dropped at end.
CREATE TEMP TABLE turn_journal_phase_conversion (
  installation_id text NOT NULL, namespace_id text NOT NULL, agent_id text NOT NULL,
  conversation_ref text NOT NULL, turn_ref text NOT NULL, attempt_ref text NOT NULL,
  reservation_ref text NOT NULL,
  old_row jsonb NOT NULL,
  new_record jsonb NOT NULL,
  PRIMARY KEY (installation_id,namespace_id,agent_id,conversation_ref,turn_ref,attempt_ref,reservation_ref)
) ON COMMIT DROP;
REVOKE ALL ON TABLE pg_temp.turn_journal_phase_conversion FROM PUBLIC;

DO $phase_preflight$
DECLARE a occ.turn_journal_attempts%ROWTYPE; owner_record jsonb; exact_attempt jsonb;
  common_binding jsonb; candidate jsonb; cancelled jsonb; op record; head_row record;
  operation_count bigint; cancellation_count bigint; reservation_held boolean;
  history_record jsonb; slot_row record;
BEGIN
  FOR a IN SELECT * FROM occ.turn_journal_attempts LOOP
    exact_attempt:=occ.turn_journal_phase_exact_attempt(to_jsonb(a));
    SELECT o.record INTO owner_record FROM occ.turn_journal_owners o
      WHERE o.installation_id=a.installation_id AND o.channel_installation_id=a.channel_installation_id
        AND o.receipt_ref=a.admission_receipt_ref AND o.owner_kind='admission';
    IF NOT FOUND OR NOT occ.turn_journal_phase_value_valid('admission',owner_record)
      OR owner_record#>>'{decision,kind}' IS DISTINCT FROM 'accepted'
      OR owner_record#>'{decision,attempt}' IS DISTINCT FROM exact_attempt
      OR owner_record#>'{identity,locator,installationRef}' IS DISTINCT FROM to_jsonb(a.installation_id)
      OR owner_record#>'{identity,locator,channelInstallationRef}' IS DISTINCT FROM to_jsonb(a.channel_installation_id)
      OR owner_record#>'{identity,receipt,receiptRef}' IS DISTINCT FROM to_jsonb(a.admission_receipt_ref)
      OR NOT isfinite(a.first_received_at)
      OR ((owner_record->>'decidedAt')::timestamptz BETWEEN a.first_received_at AND a.first_received_at+interval '30 seconds') IS NOT TRUE THEN
      RAISE EXCEPTION 'Turn journal phase preflight: invalid accepted owner or first receipt' USING ERRCODE='23514';
    END IF;
    common_binding:=jsonb_build_object('attempt',exact_attempt,'identity',owner_record->'identity',
      'reservation',a.reservation,'expectedHead',owner_record->'expectedHead');
    IF NOT occ.turn_journal_phase_value_valid('commonAttemptBinding',common_binding) THEN
      RAISE EXCEPTION 'Turn journal phase preflight: invalid immutable common binding' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM occ.turn_journal_keys k WHERE k.installation_id=a.installation_id
      AND k.channel_installation_id=a.channel_installation_id AND k.receipt_ref=a.admission_receipt_ref
      AND k.key_kind='event' AND k.key_digest=owner_record#>>'{identity,receipt,eventKey}')
      OR NOT EXISTS (SELECT 1 FROM occ.turn_journal_keys k WHERE k.installation_id=a.installation_id
      AND k.channel_installation_id=a.channel_installation_id AND k.receipt_ref=a.admission_receipt_ref
      AND k.key_kind='logical-message' AND k.key_digest=owner_record#>>'{identity,receipt,logicalMessageKey}')
      OR NOT EXISTS (SELECT 1 FROM occ.turn_journal_incoming_links l WHERE l.installation_id=a.installation_id
      AND l.channel_installation_id=a.channel_installation_id AND l.event_owner AND l.link_kind='admission'
      AND l.event_key=owner_record#>>'{identity,receipt,eventKey}'
      AND l.record->'originalReceiptRefs'=jsonb_build_array(a.admission_receipt_ref)
      AND l.record->>'disposition'='original' AND l.record->'locator'=owner_record#>'{identity,locator}'
      AND l.record->>'incomingEventDigest'=owner_record#>>'{identity,receipt,eventDigest}'
      AND l.record->>'incomingContentDigest'=owner_record#>>'{identity,receipt,contentDigest}'
      AND occ.turn_journal_phase_value_valid('incomingLink',l.record)) THEN
      RAISE EXCEPTION 'Turn journal phase preflight: original key or incoming linkage missing' USING ERRCODE='23514';
    END IF;
    SELECT * INTO head_row FROM occ.turn_journal_heads h WHERE h.installation_id=a.installation_id
      AND h.namespace_id=a.namespace_id AND h.agent_id=a.agent_id AND h.conversation_ref=a.conversation_ref;
    IF NOT FOUND OR NOT occ.turn_journal_phase_value_valid('head',head_row.record)
      OR head_row.record->'context' IS DISTINCT FROM owner_record#>'{expectedHead,context}'
      OR head_row.record->'creationRef' IS DISTINCT FROM owner_record#>'{expectedHead,creationRef}'
      OR (head_row.record->>'headVersion')::numeric<(owner_record#>>'{expectedHead,headVersion}')::numeric
      OR (head_row.record->>'completionSequence')::numeric<(owner_record#>>'{expectedHead,completionSequence}')::numeric
      OR ((head_row.record->>'headVersion')::numeric-(owner_record#>>'{expectedHead,headVersion}')::numeric)
        <>((head_row.record->>'completionSequence')::numeric-(owner_record#>>'{expectedHead,completionSequence}')::numeric) THEN
      RAISE EXCEPTION 'Turn journal phase preflight: exact context head missing or incompatible' USING ERRCODE='23514';
    END IF;
    IF head_row.checkpoint IS NOT NULL AND (NOT occ.turn_journal_phase_value_valid('checkpointRef',head_row.checkpoint)
      OR head_row.record->'checkpointId' IS DISTINCT FROM head_row.checkpoint->'checkpointId'
      OR head_row.record->'completionSequence' IS DISTINCT FROM head_row.checkpoint->'completionSequence'
      OR head_row.record->'context' IS DISTINCT FROM occ.turn_journal_phase_context(head_row.checkpoint)) THEN
      RAISE EXCEPTION 'Turn journal phase preflight: invalid retained head checkpoint' USING ERRCODE='23514';
    END IF;
    IF (head_row.record->'checkpointId'='null'::jsonb) IS DISTINCT FROM (head_row.checkpoint IS NULL)
      OR (head_row.checkpoint IS NOT NULL AND NOT EXISTS (SELECT 1 FROM occ.turn_journal_operations completed
        WHERE completed.installation_id=a.installation_id AND completed.namespace_id=a.namespace_id
          AND completed.agent_id=a.agent_id AND completed.conversation_ref=a.conversation_ref
          AND completed.operation_kind='completion' AND completed.record->'head'=head_row.record
          AND completed.record->'checkpoint'=head_row.checkpoint)) THEN
      RAISE EXCEPTION 'Turn journal phase preflight: head publication missing' USING ERRCODE='23514';
    END IF;
    reservation_held:=EXISTS (SELECT 1 FROM occ.turn_journal_reservations r WHERE r.installation_id=a.installation_id
      AND r.namespace_id=a.namespace_id AND r.agent_id=a.agent_id AND r.conversation_ref=a.conversation_ref
      AND r.turn_ref=a.turn_ref AND r.attempt_ref=a.attempt_ref AND r.reservation_ref=a.reservation_ref);
    operation_count:=0; cancellation_count:=0; cancelled:=NULL;
    IF EXISTS (SELECT 1 FROM occ.turn_journal_operations o WHERE o.installation_id=a.installation_id
      AND o.namespace_id=a.namespace_id AND o.agent_id=a.agent_id AND o.conversation_ref=a.conversation_ref
      AND o.turn_ref=a.turn_ref AND o.attempt_ref=a.attempt_ref AND o.reservation_ref=a.reservation_ref
      AND o.operation_kind='cancellation' GROUP BY o.request->'expectedAttemptVersion' HAVING count(*)>1) THEN
      RAISE EXCEPTION 'Turn journal phase preflight: duplicate cancellation version' USING ERRCODE='23514';
    END IF;
    FOR op IN SELECT * FROM occ.turn_journal_operations o WHERE o.installation_id=a.installation_id
      AND o.namespace_id=a.namespace_id AND o.agent_id=a.agent_id AND o.conversation_ref=a.conversation_ref
      AND o.turn_ref=a.turn_ref AND o.attempt_ref=a.attempt_ref AND o.reservation_ref=a.reservation_ref LOOP
      operation_count:=operation_count+1;
      IF NOT occ.turn_journal_phase_operation_value(to_jsonb(op)) THEN
        RAISE EXCEPTION 'Turn journal phase preflight: malformed retained operation' USING ERRCODE='23514';
      END IF;
      IF op.operation_kind='cancellation' THEN
        cancellation_count:=cancellation_count+1;
        IF op.request->'originalPrincipalRef' IS DISTINCT FROM owner_record#>'{identity,principalRef}' THEN
          RAISE EXCEPTION 'Turn journal phase preflight: original cancellation principal mismatch' USING ERRCODE='23514';
        END IF;
        IF op.record->>'outcome'='cancelled-before-dispatch' THEN
          IF cancelled IS NOT NULL THEN RAISE EXCEPTION 'Turn journal phase preflight: contradictory cancellation' USING ERRCODE='23514'; END IF;
          cancelled:=op.request;
        END IF;
      END IF;
      IF a.record IS NULL THEN CONTINUE; END IF;
      IF op.request ? 'expectedAttemptVersion' AND (op.request->>'expectedAttemptVersion')::numeric
        >a.version-CASE WHEN op.operation_kind='release' THEN 0 ELSE 1 END THEN
        RAISE EXCEPTION 'Turn journal phase preflight: operation version exceeds retained publication' USING ERRCODE='23514';
      END IF;
      CASE op.operation_kind
        WHEN 'outcome' THEN
          IF occ.turn_journal_phase_common_binding(op.record) IS DISTINCT FROM common_binding
            OR (NOT op.record ? 'phase' AND op.record->'binding' IS DISTINCT FROM a.record->'binding')
            OR (op.record->'consumption'<>'null'::jsonb AND op.record->'consumption' IS DISTINCT FROM a.record->'consumption') THEN
            RAISE EXCEPTION 'Turn journal phase preflight: outcome history binding changed' USING ERRCODE='23514';
          END IF;
        WHEN 'checkpoint-allocation' THEN
          IF op.request->'expectedHead' IS DISTINCT FROM owner_record->'expectedHead'
            OR a.record->'consumption' IS NOT DISTINCT FROM 'null'::jsonb THEN
            RAISE EXCEPTION 'Turn journal phase preflight: checkpoint allocation lacks consumed owner' USING ERRCODE='23514';
          END IF;
        WHEN 'completion' THEN
          IF a.record#>>'{outcome,kind}' IS DISTINCT FROM 'completed'
            OR a.record#>'{outcome,checkpoint}' IS DISTINCT FROM op.record->'checkpoint'
            OR a.record->'version' IS DISTINCT FROM op.record->'outcomeVersion'
            OR a.record#>'{outcome,completionOperationRef}' IS DISTINCT FROM op.request->'operationRef'
            OR op.record#>'{head,creationRef}' IS DISTINCT FROM owner_record#>'{expectedHead,creationRef}'
            OR (op.record#>>'{head,headVersion}')::numeric<>(owner_record#>>'{expectedHead,headVersion}')::numeric+1
            OR op.record#>'{checkpoint,parentCheckpointId}' IS DISTINCT FROM owner_record#>'{expectedHead,checkpointId}'
            OR NOT EXISTS (SELECT 1 FROM occ.turn_journal_operations allocation WHERE allocation.installation_id=a.installation_id
              AND allocation.namespace_id=a.namespace_id AND allocation.agent_id=a.agent_id AND allocation.conversation_ref=a.conversation_ref
              AND allocation.turn_ref=a.turn_ref AND allocation.attempt_ref=a.attempt_ref AND allocation.reservation_ref=a.reservation_ref
              AND allocation.operation_kind='checkpoint-allocation' AND allocation.record->'checkpointId'=op.request->'checkpointId')
            OR NOT EXISTS (SELECT 1 FROM occ.turn_journal_deliveries d WHERE d.installation_id=a.installation_id
              AND d.namespace_id=a.namespace_id AND d.agent_id=a.agent_id AND d.conversation_ref=a.conversation_ref
              AND d.turn_ref=a.turn_ref AND d.attempt_ref=a.attempt_ref AND d.reservation_ref=a.reservation_ref
              AND d.operation=op.record->'pendingDelivery') THEN
            RAISE EXCEPTION 'Turn journal phase preflight: incomplete retained completion' USING ERRCODE='23514';
          END IF;
        WHEN 'release' THEN
          IF reservation_held OR op.request->'reservation' IS DISTINCT FROM a.reservation
            OR op.request->'workspace' IS DISTINCT FROM owner_record#>'{identity,workspace}' THEN
            RAISE EXCEPTION 'Turn journal phase preflight: incompatible retained release' USING ERRCODE='23514';
          END IF;
        ELSE NULL;
      END CASE;
    END LOOP;
    IF a.record IS NULL THEN
      IF a.version<>1 OR NOT reservation_held OR EXISTS (SELECT 1 FROM occ.turn_journal_deliveries d
        WHERE d.installation_id=a.installation_id AND d.namespace_id=a.namespace_id AND d.agent_id=a.agent_id
          AND d.conversation_ref=a.conversation_ref AND d.turn_ref=a.turn_ref AND d.attempt_ref=a.attempt_ref AND d.reservation_ref=a.reservation_ref)
        OR EXISTS (SELECT 1 FROM occ.turn_journal_delivery_attempts d
        WHERE d.installation_id=a.installation_id AND d.namespace_id=a.namespace_id AND d.agent_id=a.agent_id
          AND d.conversation_ref=a.conversation_ref AND d.turn_ref=a.turn_ref AND d.attempt_ref=a.attempt_ref AND d.reservation_ref=a.reservation_ref)
        OR NOT (operation_count=0 OR (operation_count=1 AND cancellation_count=1 AND cancelled IS NOT NULL
          AND cancelled->'expectedAttemptVersion'='1'::jsonb)) THEN
        RAISE EXCEPTION 'Turn journal phase preflight: unsupported legacy NULL history' USING ERRCODE='23514';
      END IF;
      candidate:=jsonb_build_object('phase','admitted-undispatched','binding',common_binding,
        'version',CASE WHEN cancelled IS NULL THEN 1 ELSE 2 END,'consumption',NULL,
        'outcome',CASE WHEN cancelled IS NULL THEN jsonb_build_object('kind','accepted-undispatched')
          ELSE jsonb_build_object('kind','cancelled','stage','before-dispatch','evidenceRef',cancelled->'operationRef') END);
      IF NOT occ.turn_journal_phase_value_valid('attempt',candidate) THEN
        RAISE EXCEPTION 'Turn journal phase preflight: invalid canonical conversion' USING ERRCODE='23514';
      END IF;
      INSERT INTO pg_temp.turn_journal_phase_conversion VALUES
        (a.installation_id,a.namespace_id,a.agent_id,a.conversation_ref,a.turn_ref,a.attempt_ref,a.reservation_ref,
          to_jsonb(a),candidate);
    ELSE
      IF a.record ? 'phase' OR NOT occ.turn_journal_phase_value_valid('attempt',a.record)
        OR a.record->'version' IS DISTINCT FROM to_jsonb(a.version)
        OR occ.turn_journal_phase_common_binding(a.record) IS DISTINCT FROM common_binding THEN
        RAISE EXCEPTION 'Turn journal phase preflight: invalid retained full attempt' USING ERRCODE='23514';
      END IF;
      IF NOT reservation_held AND NOT EXISTS (SELECT 1 FROM occ.turn_journal_operations o WHERE o.installation_id=a.installation_id
        AND o.namespace_id=a.namespace_id AND o.agent_id=a.agent_id AND o.conversation_ref=a.conversation_ref
        AND o.turn_ref=a.turn_ref AND o.attempt_ref=a.attempt_ref AND o.reservation_ref=a.reservation_ref AND o.operation_kind='release') THEN
        RAISE EXCEPTION 'Turn journal phase preflight: reservation owner missing' USING ERRCODE='23514';
      END IF;
      IF cancelled IS NOT NULL THEN
        RAISE EXCEPTION 'Turn journal phase preflight: full history contradicts legacy local cancellation' USING ERRCODE='23514';
      END IF;
      IF a.record#>>'{outcome,kind}'='completed' AND NOT EXISTS (SELECT 1 FROM occ.turn_journal_operations o
        WHERE o.installation_id=a.installation_id AND o.namespace_id=a.namespace_id AND o.agent_id=a.agent_id
          AND o.conversation_ref=a.conversation_ref AND o.turn_ref=a.turn_ref AND o.attempt_ref=a.attempt_ref
          AND o.reservation_ref=a.reservation_ref AND o.operation_kind='completion'
          AND o.record->'outcomeVersion'=to_jsonb(a.version)
          AND o.request->'operationRef'=a.record#>'{outcome,completionOperationRef}') THEN
        RAISE EXCEPTION 'Turn journal phase preflight: completion publication missing' USING ERRCODE='23514';
      END IF;
      IF a.record#>>'{outcome,kind}' IN ('running','failed','interrupted','outcome-unknown','cancelled') AND NOT EXISTS (
        SELECT 1 FROM occ.turn_journal_operations o WHERE o.installation_id=a.installation_id
        AND o.namespace_id=a.namespace_id AND o.agent_id=a.agent_id AND o.conversation_ref=a.conversation_ref
        AND o.turn_ref=a.turn_ref AND o.attempt_ref=a.attempt_ref AND o.reservation_ref=a.reservation_ref
        AND o.operation_kind='outcome' AND o.record-'version'=a.record-'version'
        AND (o.record->>'version')::numeric<=a.version) THEN
        RAISE EXCEPTION 'Turn journal phase preflight: outcome publication missing' USING ERRCODE='23514';
      END IF;
    END IF;
    FOR slot_row IN SELECT to_jsonb(d) AS value FROM occ.turn_journal_deliveries d
      WHERE d.installation_id=a.installation_id AND d.namespace_id=a.namespace_id AND d.agent_id=a.agent_id
        AND d.conversation_ref=a.conversation_ref AND d.turn_ref=a.turn_ref AND d.attempt_ref=a.attempt_ref AND d.reservation_ref=a.reservation_ref
      UNION ALL SELECT to_jsonb(d) FROM occ.turn_journal_delivery_attempts d
      WHERE d.installation_id=a.installation_id AND d.namespace_id=a.namespace_id AND d.agent_id=a.agent_id
        AND d.conversation_ref=a.conversation_ref AND d.turn_ref=a.turn_ref AND d.attempt_ref=a.attempt_ref AND d.reservation_ref=a.reservation_ref LOOP
      IF NOT occ.turn_journal_phase_value_valid('deliveryOperation',slot_row.value->'operation')
        OR NOT occ.turn_journal_delivery_value_matches(slot_row.value)
        OR (slot_row.value->'outcome'<>'null'::jsonb AND NOT occ.turn_journal_phase_value_valid('delivery',slot_row.value->'outcome'))
        OR slot_row.value#>'{operation,attempt}' IS DISTINCT FROM exact_attempt
        OR (slot_row.value#>>'{operation,outcomeVersion}')::numeric>a.version THEN
        RAISE EXCEPTION 'Turn journal phase preflight: incompatible delivery history' USING ERRCODE='23514';
      END IF;
    END LOOP;
  END LOOP;
END;
$phase_preflight$;

--> statement-breakpoint
DO $turn_journal_codec_step$
BEGIN
  RAISE EXCEPTION 'This migration requires the original locked journal codec step'
    USING ERRCODE = '0A000';
END;
$turn_journal_codec_step$;
--> statement-breakpoint

-- This replacement exists only inside the exclusive migration transaction. It
-- cannot insert/delete, touch a full row, or change any original owner bytes.
-- The final replacement below has no migration branch or temporary-table port.
CREATE OR REPLACE FUNCTION occ.turn_journal_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,occ AS $$
DECLARE replacement jsonb;
BEGIN
  IF current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='occ.turn_journal_attempts'::regclass))
    OR TG_OP<>'UPDATE' OR OLD.record IS NOT NULL OR OLD.version<>1 THEN
    RAISE EXCEPTION 'Turn journal phase conversion is owner-only' USING ERRCODE='23514';
  END IF;
  SELECT c.new_record INTO replacement FROM pg_temp.turn_journal_phase_conversion c WHERE c.old_row=to_jsonb(OLD);
  IF NOT FOUND OR (to_jsonb(NEW)-ARRAY['record','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['record','version'])
    OR NEW.record IS DISTINCT FROM replacement OR to_jsonb(NEW.version) IS DISTINCT FROM replacement->'version' THEN
    RAISE EXCEPTION 'Turn journal phase conversion does not match preflight' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

UPDATE occ.turn_journal_attempts a
SET record=c.new_record, version=(c.new_record->>'version')::bigint
FROM pg_temp.turn_journal_phase_conversion c
WHERE a.record IS NULL AND to_jsonb(a)=c.old_row;

CREATE OR REPLACE FUNCTION occ.turn_journal_attempt_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,occ AS $$
DECLARE admission jsonb; exact_attempt jsonb; common_binding jsonb; previous_kind text; next_kind text;
  cancellation_record jsonb;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Turn journal attempts are immutable history' USING ERRCODE='23514'; END IF;
  IF NEW.record IS NULL OR NOT occ.turn_journal_phase_value_valid('attempt',NEW.record)
    OR NEW.record->'version' IS DISTINCT FROM to_jsonb(NEW.version) THEN
    RAISE EXCEPTION 'Turn journal canonical attempt record required' USING ERRCODE='23514';
  END IF;
  exact_attempt:=occ.turn_journal_phase_exact_attempt(to_jsonb(NEW));
  SELECT record INTO admission FROM occ.turn_journal_owners
    WHERE installation_id=NEW.installation_id AND channel_installation_id=NEW.channel_installation_id
      AND receipt_ref=NEW.admission_receipt_ref AND owner_kind='admission';
  IF admission IS NULL OR NOT occ.turn_journal_phase_value_valid('admission',admission)
    OR admission#>>'{decision,kind}' IS DISTINCT FROM 'accepted'
    OR admission#>'{decision,attempt}' IS DISTINCT FROM exact_attempt THEN
    RAISE EXCEPTION 'Turn journal attempt admission mismatch' USING ERRCODE='23514';
  END IF;
  common_binding:=jsonb_build_object('attempt',exact_attempt,'identity',admission->'identity',
    'reservation',NEW.reservation,'expectedHead',admission->'expectedHead');
  IF occ.turn_journal_phase_common_binding(NEW.record) IS DISTINCT FROM common_binding THEN
    RAISE EXCEPTION 'Turn journal attempt binding mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NOT isfinite(NEW.first_received_at) OR ((admission->>'decidedAt')::timestamptz
      BETWEEN NEW.first_received_at AND NEW.first_received_at+interval '30 seconds') IS NOT TRUE THEN
      RAISE EXCEPTION 'Turn journal first receipt admission window mismatch' USING ERRCODE='23514';
    END IF;
    IF NEW.version<>1 OR NEW.record IS DISTINCT FROM jsonb_build_object('phase','admitted-undispatched',
      'binding',common_binding,'version',1,'consumption',NULL,'outcome',jsonb_build_object('kind','accepted-undispatched')) THEN
      RAISE EXCEPTION 'Turn journal attempt must start in canonical common phase' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF OLD.record IS NULL OR NOT occ.turn_journal_phase_value_valid('attempt',OLD.record)
    OR OLD.version>=9007199254740991 OR NEW.version<>OLD.version+1
    OR (to_jsonb(NEW)-ARRAY['record','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['record','version']) THEN
    RAISE EXCEPTION 'Turn journal attempt transition mismatch' USING ERRCODE='23514';
  END IF;
  previous_kind:=OLD.record#>>'{outcome,kind}'; next_kind:=NEW.record#>>'{outcome,kind}';
  IF previous_kind IN ('completed','failed','interrupted','cancelled') THEN
    RAISE EXCEPTION 'Turn journal terminal attempt is immutable' USING ERRCODE='23514';
  END IF;
  SELECT op.record INTO cancellation_record FROM occ.turn_journal_operations op
    WHERE op.installation_id=OLD.installation_id AND op.namespace_id=OLD.namespace_id AND op.agent_id=OLD.agent_id
      AND op.conversation_ref=OLD.conversation_ref AND op.turn_ref=OLD.turn_ref AND op.attempt_ref=OLD.attempt_ref
      AND op.reservation_ref=OLD.reservation_ref AND op.operation_kind='cancellation'
      AND op.request->'expectedAttemptVersion'=to_jsonb(OLD.version);
  IF FOUND THEN
    IF cancellation_record->>'outcome'='requested' THEN
      IF OLD.record ? 'phase' OR previous_kind='accepted-undispatched'
        OR (previous_kind='outcome-unknown' AND OLD.record#>>'{outcome,stage}'='before-dispatch')
        OR NEW.record-'version' IS DISTINCT FROM OLD.record-'version' THEN
        RAISE EXCEPTION 'Turn journal cancellation metadata transition mismatch' USING ERRCODE='23514';
      END IF;
    ELSIF cancellation_record->>'outcome'='cancelled-before-dispatch' THEN
      IF NOT occ.turn_journal_phase_before_cancel(OLD.record,cancellation_record->'operation')
        OR NEW.record-ARRAY['version','outcome'] IS DISTINCT FROM OLD.record-ARRAY['version','outcome']
        OR NEW.record->'outcome' IS DISTINCT FROM jsonb_build_object('kind','cancelled','stage','before-dispatch',
          'evidenceRef',cancellation_record#>'{operation,operationRef}') THEN
        RAISE EXCEPTION 'Turn journal local cancellation transition mismatch' USING ERRCODE='23514';
      END IF;
    ELSE RAISE EXCEPTION 'Turn journal cancellation outcome invalid' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF next_kind='dispatch-intent' THEN
    IF previous_kind<>'accepted-undispatched' OR OLD.record->'consumption'<>'null'::jsonb
      OR NEW.record ? 'phase' OR NEW.record->'consumption'<>'null'::jsonb
      OR occ.turn_journal_phase_common_binding(NEW.record) IS DISTINCT FROM occ.turn_journal_phase_common_binding(OLD.record)
      OR (NOT OLD.record ? 'phase' AND NEW.record->'binding' IS DISTINCT FROM OLD.record->'binding')
      OR clock_timestamp()>=OLD.first_received_at+interval '30 seconds'
      OR (NEW.record#>>'{binding,expiresAt}')::timestamptz<=clock_timestamp()
      OR NOT EXISTS (SELECT 1 FROM occ.turn_journal_reservations r WHERE r.installation_id=OLD.installation_id
        AND r.namespace_id=OLD.namespace_id AND r.agent_id=OLD.agent_id AND r.conversation_ref=OLD.conversation_ref
        AND r.turn_ref=OLD.turn_ref AND r.attempt_ref=OLD.attempt_ref AND r.reservation_ref=OLD.reservation_ref)
      OR NOT EXISTS (SELECT 1 FROM occ.turn_journal_heads h WHERE h.installation_id=OLD.installation_id
        AND h.namespace_id=OLD.namespace_id AND h.agent_id=OLD.agent_id AND h.conversation_ref=OLD.conversation_ref
        AND h.record=OLD.record#>'{binding,expectedHead}') THEN
      RAISE EXCEPTION 'Turn journal dispatch no longer admissible' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.record->'phase' IS DISTINCT FROM OLD.record->'phase'
    OR NEW.record->'binding' IS DISTINCT FROM OLD.record->'binding'
    OR (OLD.record->'consumption'<>'null'::jsonb AND NEW.record->'consumption' IS DISTINCT FROM OLD.record->'consumption') THEN
    RAISE EXCEPTION 'Turn journal attempt history changed' USING ERRCODE='23514';
  END IF;
  IF next_kind='consumed' THEN
    IF OLD.record ? 'phase' OR previous_kind<>'dispatch-intent' OR OLD.record->'consumption'<>'null'::jsonb
      OR NEW.record->'consumption'='null'::jsonb
      OR NOT EXISTS (SELECT 1 FROM occ.turn_journal_reservations r WHERE r.installation_id=OLD.installation_id
        AND r.namespace_id=OLD.namespace_id AND r.agent_id=OLD.agent_id AND r.conversation_ref=OLD.conversation_ref
        AND r.turn_ref=OLD.turn_ref AND r.attempt_ref=OLD.attempt_ref AND r.reservation_ref=OLD.reservation_ref) THEN
      RAISE EXCEPTION 'Turn journal consumption transition invalid' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.record->'consumption' IS DISTINCT FROM OLD.record->'consumption' THEN
      RAISE EXCEPTION 'Turn journal consumption must be committed separately' USING ERRCODE='23514';
    END IF;
    IF next_kind='running' THEN
      IF previous_kind<>'consumed' OR OLD.record ? 'phase' THEN RAISE EXCEPTION 'Turn journal running transition invalid' USING ERRCODE='23514'; END IF;
    ELSIF next_kind='completed' THEN
      IF NOT (NEW.record#>'{outcome,checkpoint}' @> exact_attempt) OR OLD.record ? 'phase'
        OR NOT EXISTS (SELECT 1 FROM occ.turn_journal_reservations r WHERE r.installation_id=OLD.installation_id
          AND r.namespace_id=OLD.namespace_id AND r.agent_id=OLD.agent_id AND r.conversation_ref=OLD.conversation_ref
          AND r.turn_ref=OLD.turn_ref AND r.attempt_ref=OLD.attempt_ref AND r.reservation_ref=OLD.reservation_ref)
        OR (previous_kind NOT IN ('consumed','running') AND NOT
          (previous_kind='outcome-unknown' AND OLD.record#>>'{outcome,stage}' IN ('execution','checkpoint'))) THEN
        RAISE EXCEPTION 'Turn journal completion transition invalid' USING ERRCODE='23514';
      END IF;
    ELSIF next_kind IN ('failed','interrupted','outcome-unknown','cancelled') THEN
      IF NEW.record#>>'{outcome,stage}'='before-dispatch' THEN
        IF OLD.record->'consumption'<>'null'::jsonb OR (previous_kind<>'accepted-undispatched' AND NOT
          (previous_kind='outcome-unknown' AND OLD.record#>>'{outcome,stage}'='before-dispatch')) THEN
          RAISE EXCEPTION 'Turn journal before-dispatch outcome transition invalid' USING ERRCODE='23514';
        END IF;
      ELSIF OLD.record ? 'phase' OR previous_kind='accepted-undispatched'
        OR (previous_kind='outcome-unknown' AND OLD.record#>>'{outcome,stage}'='before-dispatch') THEN
        RAISE EXCEPTION 'Turn journal outcome lacks dispatched history' USING ERRCODE='23514';
      END IF;
    ELSE RAISE EXCEPTION 'Turn journal attempt cannot return to acceptance or dispatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION occ.turn_journal_operation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE
  exact_attempt jsonb;
  current_attempt occ.turn_journal_attempts%ROWTYPE;
  allocation jsonb;
  expected_head jsonb;
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Turn journal operations are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
  IF NOT occ.turn_journal_phase_operation_value(to_jsonb(NEW)) THEN
    RAISE EXCEPTION 'Turn journal canonical operation required' USING ERRCODE='23514';
  END IF;
  exact_attempt := jsonb_build_object('installationRef', NEW.installation_id,
    'namespaceRef', NEW.namespace_id, 'agentRef', NEW.agent_id,
    'conversationRef', NEW.conversation_ref, 'turnRef', NEW.turn_ref,
    'attemptRef', NEW.attempt_ref, 'reservationRef', NEW.reservation_ref);
  SELECT * INTO current_attempt FROM occ.turn_journal_attempts a WHERE
    a.installation_id=NEW.installation_id AND a.namespace_id=NEW.namespace_id AND a.agent_id=NEW.agent_id
    AND a.conversation_ref=NEW.conversation_ref AND a.turn_ref=NEW.turn_ref AND a.attempt_ref=NEW.attempt_ref AND a.reservation_ref=NEW.reservation_ref;
  IF NOT FOUND OR current_attempt.record IS NULL
    OR NOT occ.turn_journal_phase_value_valid('attempt',current_attempt.record)
    OR NEW.request->'attempt' IS DISTINCT FROM exact_attempt
    OR (CASE WHEN NEW.operation_kind='release' THEN NEW.request->>'releaseOperationRef'
      ELSE NEW.request->>'operationRef' END) IS DISTINCT FROM NEW.operation_ref THEN
    RAISE EXCEPTION 'Turn journal operation identity mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT o.record->'expectedHead' INTO expected_head FROM occ.turn_journal_owners o WHERE
    o.installation_id=NEW.installation_id AND o.channel_installation_id=current_attempt.channel_installation_id
    AND o.receipt_ref=current_attempt.admission_receipt_ref;
  CASE NEW.operation_kind
    WHEN 'checkpoint-allocation' THEN
      IF NEW.record IS DISTINCT FROM NEW.request OR NEW.request->'expectedHead' IS DISTINCT FROM expected_head
        OR current_attempt.record IS NULL OR current_attempt.record->'consumption' IS NOT DISTINCT FROM 'null'::jsonb
        OR NOT EXISTS (SELECT 1 FROM occ.turn_journal_reservations r WHERE r.installation_id=NEW.installation_id
          AND r.namespace_id=NEW.namespace_id AND r.agent_id=NEW.agent_id AND r.conversation_ref=NEW.conversation_ref
          AND r.turn_ref=NEW.turn_ref AND r.attempt_ref=NEW.attempt_ref AND r.reservation_ref=NEW.reservation_ref) THEN
        RAISE EXCEPTION 'Turn journal checkpoint allocation mismatch' USING ERRCODE='23514';
      END IF;
    WHEN 'completion' THEN
      SELECT op.record INTO allocation FROM occ.turn_journal_operations op WHERE op.installation_id=NEW.installation_id
        AND op.namespace_id=NEW.namespace_id AND op.agent_id=NEW.agent_id AND op.conversation_ref=NEW.conversation_ref
        AND op.turn_ref=NEW.turn_ref AND op.attempt_ref=NEW.attempt_ref AND op.reservation_ref=NEW.reservation_ref
        AND op.operation_kind='checkpoint-allocation';
      IF allocation IS NULL OR NEW.record->'operation' IS DISTINCT FROM NEW.request
        OR (NEW.record#>>'{checkpoint,checkpointId}') IS DISTINCT FROM (allocation->>'checkpointId')
        OR (NEW.request->>'checkpointId') IS DISTINCT FROM (allocation->>'checkpointId')
        OR (NEW.request->'expectedCompletionSequence') IS DISTINCT FROM (expected_head->'completionSequence')
        OR (NEW.record->>'outcomeVersion')::numeric <> (NEW.request->>'expectedAttemptVersion')::numeric+1
        OR NOT (NEW.record->'checkpoint' @> exact_attempt)
        OR (NEW.record#>'{head,context}') IS DISTINCT FROM (expected_head->'context')
        OR (NEW.record#>>'{head,completionSequence}')::numeric <> (expected_head->>'completionSequence')::numeric+1
        OR (NEW.record#>>'{head,headVersion}')::numeric <> (expected_head->>'headVersion')::numeric+1
        OR (NEW.record#>>'{head,creationRef}') IS DISTINCT FROM (expected_head->>'creationRef')
        OR (NEW.record#>>'{checkpoint,parentCheckpointId}') IS DISTINCT FROM (expected_head->>'checkpointId')
        OR (NEW.record#>'{pendingDelivery,attempt}') IS DISTINCT FROM exact_attempt
        OR (NEW.record#>>'{pendingDelivery,slot}') IS DISTINCT FROM 'completed-result' THEN
        RAISE EXCEPTION 'Turn journal completion allocation mismatch' USING ERRCODE='23514';
      END IF;
    WHEN 'outcome' THEN
      IF NEW.record IS DISTINCT FROM current_attempt.record
        OR (NEW.record#>'{binding,attempt}') IS DISTINCT FROM exact_attempt OR NEW.record->'outcome' IS DISTINCT FROM NEW.request->'outcome'
        OR (NEW.record->>'version')::numeric <> (NEW.request->>'expectedAttemptVersion')::numeric+1 THEN
        RAISE EXCEPTION 'Turn journal outcome operation mismatch' USING ERRCODE='23514';
      END IF;
    WHEN 'cancellation' THEN
      -- Serialize direct operation INSERT with the canonical attempt even when
      -- the accepting adapter already holds its enclosing Agent owner lock.
      SELECT * INTO current_attempt FROM occ.turn_journal_attempts a WHERE
        a.installation_id=NEW.installation_id AND a.namespace_id=NEW.namespace_id AND a.agent_id=NEW.agent_id
        AND a.conversation_ref=NEW.conversation_ref AND a.turn_ref=NEW.turn_ref
        AND a.attempt_ref=NEW.attempt_ref AND a.reservation_ref=NEW.reservation_ref FOR UPDATE;
      IF EXISTS (SELECT 1 FROM occ.turn_journal_operations op
        WHERE op.installation_id=NEW.installation_id AND op.namespace_id=NEW.namespace_id AND op.agent_id=NEW.agent_id
          AND op.conversation_ref=NEW.conversation_ref AND op.turn_ref=NEW.turn_ref
          AND op.attempt_ref=NEW.attempt_ref AND op.reservation_ref=NEW.reservation_ref
          AND op.operation_kind='cancellation'
          AND (op.request->>'expectedAttemptVersion')::numeric=(NEW.request->>'expectedAttemptVersion')::numeric)
        OR current_attempt.record#>>'{outcome,kind}' IN ('completed','failed','interrupted','cancelled') THEN
        RAISE EXCEPTION 'Turn journal cancellation version is no longer current' USING ERRCODE='23514';
      END IF;
      IF NEW.record->'operation' IS DISTINCT FROM NEW.request
        OR (NEW.record->>'outcome') IS NULL OR (NEW.record->>'outcome') NOT IN ('requested','cancelled-before-dispatch')
        OR (NEW.request->>'expectedAttemptVersion')::numeric <> current_attempt.version
        OR (NEW.request->>'originalPrincipalRef') IS DISTINCT FROM (
          SELECT o.record#>>'{identity,principalRef}' FROM occ.turn_journal_owners o
          WHERE o.installation_id=NEW.installation_id AND o.channel_installation_id=current_attempt.channel_installation_id AND o.receipt_ref=current_attempt.admission_receipt_ref)
        OR current_attempt.version>=9007199254740991
        OR ((NEW.record->>'outcome'='cancelled-before-dispatch') IS DISTINCT FROM
          occ.turn_journal_phase_before_cancel(current_attempt.record,NEW.request))
        OR (NEW.record->>'outcome'='requested' AND (current_attempt.record ? 'phase'
          OR current_attempt.record#>>'{outcome,kind}'='accepted-undispatched'
          OR (current_attempt.record#>>'{outcome,kind}'='outcome-unknown'
            AND current_attempt.record#>>'{outcome,stage}'='before-dispatch')))
        OR NOT EXISTS (SELECT 1 FROM occ.turn_journal_reservations r WHERE r.installation_id=NEW.installation_id
          AND r.namespace_id=NEW.namespace_id AND r.agent_id=NEW.agent_id AND r.conversation_ref=NEW.conversation_ref
          AND r.turn_ref=NEW.turn_ref AND r.attempt_ref=NEW.attempt_ref AND r.reservation_ref=NEW.reservation_ref) THEN
        RAISE EXCEPTION 'Turn journal cancellation operation mismatch' USING ERRCODE='23514';
      END IF;
    WHEN 'release' THEN
      IF NEW.record IS DISTINCT FROM NEW.request OR current_attempt.record IS NULL
        OR NEW.request->'reservation' IS DISTINCT FROM current_attempt.reservation
        OR NEW.request->'workspace' IS DISTINCT FROM current_attempt.record#>'{binding,identity,workspace}'
        OR (NEW.request->>'expectedAttemptVersion')::numeric <> current_attempt.version THEN
        RAISE EXCEPTION 'Turn journal release operation mismatch' USING ERRCODE='23514';
      END IF;
    ELSE RAISE EXCEPTION 'Turn journal unknown operation' USING ERRCODE='23514';
  END CASE;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION occ.turn_journal_completion_atomic_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE completed jsonb;
BEGIN
  IF TG_TABLE_NAME='turn_journal_heads' THEN
    IF NEW.record->>'completionSequence'='0' THEN
      IF NOT EXISTS (SELECT 1 FROM occ.turn_journal_owners o WHERE o.installation_id=NEW.installation_id
        AND o.owner_kind='admission' AND o.record#>>'{decision,kind}'='accepted'
        AND o.record->'expectedHead'=NEW.record) THEN
        RAISE EXCEPTION 'Turn journal creation head admission absent' USING ERRCODE='23514';
      END IF;
      RETURN NULL;
    END IF;
    SELECT op.record INTO completed FROM occ.turn_journal_operations op WHERE op.installation_id=NEW.installation_id
      AND op.namespace_id=NEW.namespace_id AND op.agent_id=NEW.agent_id AND op.conversation_ref=NEW.conversation_ref
      AND op.operation_kind='completion' AND op.record->'head'=NEW.record AND op.record->'checkpoint'=NEW.checkpoint;
  ELSIF TG_TABLE_NAME='turn_journal_attempts' THEN
    IF NEW.record IS NULL THEN RAISE EXCEPTION 'Turn journal canonical publication required' USING ERRCODE='23514'; END IF;
    IF TG_OP='UPDATE' AND OLD.record IS NOT NULL AND NEW.version=OLD.version+1
      AND (NEW.record-'version') IS NOT DISTINCT FROM (OLD.record-'version')
      AND NEW.record->'version' IS NOT DISTINCT FROM to_jsonb(NEW.version)
      AND EXISTS (SELECT 1 FROM occ.turn_journal_operations op
        WHERE op.installation_id=NEW.installation_id AND op.namespace_id=NEW.namespace_id AND op.agent_id=NEW.agent_id
          AND op.conversation_ref=NEW.conversation_ref AND op.turn_ref=NEW.turn_ref
          AND op.attempt_ref=NEW.attempt_ref AND op.reservation_ref=NEW.reservation_ref
          AND op.operation_kind='cancellation' AND op.record->>'outcome'='requested'
          AND (op.request->>'expectedAttemptVersion')::numeric=OLD.version) THEN
      RETURN NULL;
    END IF;
    -- A local predispatch cancellation owns its own publication; no synthetic
    -- outcome operation or claim of native termination is introduced.
    IF NEW.record#>>'{outcome,kind}'='cancelled' AND NEW.record#>>'{outcome,stage}'='before-dispatch'
      AND NEW.record->'consumption'='null'::jsonb
      AND EXISTS (SELECT 1 FROM occ.turn_journal_operations op WHERE op.installation_id=NEW.installation_id
        AND op.namespace_id=NEW.namespace_id AND op.agent_id=NEW.agent_id AND op.conversation_ref=NEW.conversation_ref
        AND op.turn_ref=NEW.turn_ref AND op.attempt_ref=NEW.attempt_ref AND op.reservation_ref=NEW.reservation_ref
        AND op.operation_kind='cancellation' AND op.record->>'outcome'='cancelled-before-dispatch'
        AND op.request->'operationRef'=NEW.record#>'{outcome,evidenceRef}'
        AND (op.request->>'expectedAttemptVersion')::numeric+1=NEW.version) THEN RETURN NULL; END IF;
    IF NEW.record#>>'{outcome,kind}' IN ('running','failed','interrupted','outcome-unknown','cancelled') THEN
      IF NOT EXISTS (SELECT 1 FROM occ.turn_journal_operations op WHERE op.installation_id=NEW.installation_id
        AND op.namespace_id=NEW.namespace_id AND op.agent_id=NEW.agent_id AND op.conversation_ref=NEW.conversation_ref
        AND op.turn_ref=NEW.turn_ref AND op.attempt_ref=NEW.attempt_ref AND op.reservation_ref=NEW.reservation_ref
        AND op.operation_kind='outcome' AND op.record=NEW.record) THEN
        RAISE EXCEPTION 'Turn journal outcome transition operation absent' USING ERRCODE='23514';
      END IF;
      RETURN NULL;
    END IF;
    IF NEW.record#>>'{outcome,kind}' <> 'completed' THEN RETURN NULL; END IF;
    SELECT op.record INTO completed FROM occ.turn_journal_operations op WHERE op.installation_id=NEW.installation_id
      AND op.namespace_id=NEW.namespace_id AND op.agent_id=NEW.agent_id AND op.conversation_ref=NEW.conversation_ref
      AND op.turn_ref=NEW.turn_ref AND op.attempt_ref=NEW.attempt_ref AND op.reservation_ref=NEW.reservation_ref
      AND op.operation_kind='completion' AND op.operation_ref=NEW.record#>>'{outcome,completionOperationRef}'
      AND op.record->'checkpoint'=NEW.record#>'{outcome,checkpoint}' AND op.record->'outcomeVersion'=NEW.record->'version';
  ELSE
    IF NEW.operation_kind='cancellation' THEN
      IF NOT EXISTS (SELECT 1 FROM occ.turn_journal_attempts a
        WHERE a.installation_id=NEW.installation_id AND a.namespace_id=NEW.namespace_id AND a.agent_id=NEW.agent_id
          AND a.conversation_ref=NEW.conversation_ref AND a.turn_ref=NEW.turn_ref
          AND a.attempt_ref=NEW.attempt_ref AND a.reservation_ref=NEW.reservation_ref
          AND CASE NEW.record->>'outcome'
            WHEN 'requested' THEN a.record IS NOT NULL
              AND a.version >= (NEW.request->>'expectedAttemptVersion')::numeric+1
            WHEN 'cancelled-before-dispatch' THEN a.record IS NOT NULL
              AND a.version=(NEW.request->>'expectedAttemptVersion')::numeric+1
              AND a.record#>>'{outcome,kind}'='cancelled' AND a.record#>>'{outcome,stage}'='before-dispatch'
              AND a.record->'consumption'='null'::jsonb
              AND a.record#>'{outcome,evidenceRef}'=NEW.request->'operationRef'
              AND a.record#>'{binding,attempt}'=NEW.request->'attempt'
            ELSE false END) THEN
        RAISE EXCEPTION 'Turn journal cancellation version publication is not atomic' USING ERRCODE='23514';
      END IF;
      RETURN NULL;
    END IF;
    IF NEW.operation_kind <> 'completion' THEN RETURN NULL; END IF;
    completed:=NEW.record;
  END IF;
  IF completed IS NULL OR NOT EXISTS (SELECT 1 FROM occ.turn_journal_attempts a
    WHERE a.installation_id=NEW.installation_id
      AND a.namespace_id=completed#>>'{operation,attempt,namespaceRef}' AND a.agent_id=completed#>>'{operation,attempt,agentRef}'
      AND a.conversation_ref=completed#>>'{operation,attempt,conversationRef}' AND a.turn_ref=completed#>>'{operation,attempt,turnRef}'
      AND a.attempt_ref=completed#>>'{operation,attempt,attemptRef}' AND a.reservation_ref=completed#>>'{operation,attempt,reservationRef}'
      AND a.record#>'{outcome,checkpoint}'=completed->'checkpoint'
      AND a.record#>>'{outcome,kind}'='completed' AND a.record->'version'=completed->'outcomeVersion')
    OR NOT EXISTS (SELECT 1 FROM occ.turn_journal_heads h WHERE h.installation_id=NEW.installation_id
      AND h.namespace_id=completed#>>'{operation,attempt,namespaceRef}' AND h.agent_id=completed#>>'{operation,attempt,agentRef}'
      AND h.conversation_ref=completed#>>'{operation,attempt,conversationRef}'
      AND h.record=completed->'head' AND h.checkpoint=completed->'checkpoint')
    OR NOT EXISTS (SELECT 1 FROM occ.turn_journal_deliveries d WHERE d.installation_id=NEW.installation_id
      AND d.namespace_id=completed#>>'{operation,attempt,namespaceRef}' AND d.agent_id=completed#>>'{operation,attempt,agentRef}'
      AND d.conversation_ref=completed#>>'{operation,attempt,conversationRef}' AND d.turn_ref=completed#>>'{operation,attempt,turnRef}'
      AND d.attempt_ref=completed#>>'{operation,attempt,attemptRef}' AND d.reservation_ref=completed#>>'{operation,attempt,reservationRef}'
      AND d.operation=completed->'pendingDelivery') THEN
    RAISE EXCEPTION 'Turn journal completion publication is not atomic' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;

-- Validate the final installed shape before the outer migrator may commit.
-- IS TRUE closes the old CHECK's SQL-NULL hole for a missing JSON version.
-- Drain conversion-trigger events before ALTER TABLE; PostgreSQL refuses schema
-- alteration while this relation still has pending deferred trigger events.
SET CONSTRAINTS occ.turn_journal_attempt_atomic IMMEDIATE;
ALTER TABLE occ.turn_journal_attempts
  DROP CONSTRAINT turn_journal_attempts_record,
  ADD CONSTRAINT turn_journal_attempts_record CHECK (
    (jsonb_typeof(record)='object' AND octet_length(record::text) BETWEEN 1 AND 65536
      AND record->'version'=to_jsonb(version)
      AND occ.turn_journal_phase_value_valid('attempt',record)) IS TRUE) NOT VALID;
ALTER TABLE occ.turn_journal_attempts VALIDATE CONSTRAINT turn_journal_attempts_record;
ALTER TABLE occ.turn_journal_attempts ALTER COLUMN record SET NOT NULL;

DO $phase_converted$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_temp.turn_journal_phase_conversion c WHERE NOT EXISTS (
    SELECT 1 FROM occ.turn_journal_attempts a WHERE to_jsonb(a)=
      c.old_row||jsonb_build_object('record',c.new_record,'version',c.new_record->'version'))) THEN
    RAISE EXCEPTION 'Turn journal phase conversion was incomplete' USING ERRCODE='23514';
  END IF;
END;
$phase_converted$;
SET CONSTRAINTS occ.turn_journal_attempt_atomic DEFERRED;
DROP TABLE pg_temp.turn_journal_phase_conversion;

-- The original schema revokes default PUBLIC function execution. Preserve that
-- posture while allowing the application's invoker-security guards and CHECKs
-- to call the finite nominal validation graph. These functions confer no authority.
REVOKE ALL ON FUNCTION
  occ.turn_journal_phase_utf16_length(text),
  occ.turn_journal_phase_reference(jsonb,boolean),
  occ.turn_journal_phase_instant(text),
  occ.turn_journal_phase_schema_matches(jsonb,jsonb),
  occ.turn_journal_phase_sdk_carrier(text,jsonb),
  occ.turn_journal_phase_context(jsonb),
  occ.turn_journal_phase_truthy(jsonb),
  occ.turn_journal_phase_same_context(jsonb,jsonb),
  occ.turn_journal_phase_includes(jsonb,jsonb),
  occ.turn_journal_phase_intrinsic(jsonb,integer),
  occ.turn_journal_phase_definition(text),
  occ.turn_journal_phase_core_value(text,jsonb),
  occ.turn_journal_phase_value_valid(text,jsonb),
  occ.turn_journal_phase_exact_attempt(jsonb),
  occ.turn_journal_phase_common_binding(jsonb),
  occ.turn_journal_phase_before_cancel(jsonb,jsonb),
  occ.turn_journal_phase_operation_value(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  occ.turn_journal_phase_utf16_length(text),
  occ.turn_journal_phase_reference(jsonb,boolean),
  occ.turn_journal_phase_instant(text),
  occ.turn_journal_phase_schema_matches(jsonb,jsonb),
  occ.turn_journal_phase_sdk_carrier(text,jsonb),
  occ.turn_journal_phase_context(jsonb),
  occ.turn_journal_phase_truthy(jsonb),
  occ.turn_journal_phase_same_context(jsonb,jsonb),
  occ.turn_journal_phase_includes(jsonb,jsonb),
  occ.turn_journal_phase_intrinsic(jsonb,integer),
  occ.turn_journal_phase_definition(text),
  occ.turn_journal_phase_core_value(text,jsonb),
  occ.turn_journal_phase_value_valid(text,jsonb),
  occ.turn_journal_phase_exact_attempt(jsonb),
  occ.turn_journal_phase_common_binding(jsonb),
  occ.turn_journal_phase_before_cancel(jsonb,jsonb),
  occ.turn_journal_phase_operation_value(jsonb) TO occ_app;
