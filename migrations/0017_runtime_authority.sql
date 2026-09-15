-- Immutable operation records retain initial binding and exact operation readback.
-- A record/receipt is one atomic insert; current authority is a projection, not a second head.
ALTER TABLE occ.runtime_assignment_allocations ADD CONSTRAINT runtime_allocations_authority_owner
  UNIQUE (installation_id, namespace_id, agent_id, assignment_ref);
--> statement-breakpoint
CREATE TABLE occ.runtime_authority_operations (
  operation_ref text PRIMARY KEY,
  installation_id text NOT NULL,
  namespace_id text NOT NULL,
  agent_id text NOT NULL,
  assignment_ref text NOT NULL,
  assignment_record_version bigint NOT NULL,
  operation_kind text NOT NULL,
  canonical_payload text NOT NULL,
  receipt jsonb NOT NULL,
  CONSTRAINT runtime_authority_allocation_owner FOREIGN KEY (installation_id, namespace_id, agent_id, assignment_ref)
    REFERENCES occ.runtime_assignment_allocations(installation_id, namespace_id, agent_id, assignment_ref)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT runtime_authority_assignment_version UNIQUE (assignment_ref, assignment_record_version),
  CONSTRAINT runtime_authority_operation_ref CHECK (operation_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT runtime_authority_version CHECK (assignment_record_version BETWEEN 2 AND 9007199254740991),
  CONSTRAINT runtime_authority_kind CHECK (operation_kind = 'bind'),
  CONSTRAINT runtime_authority_payload_size CHECK (octet_length(canonical_payload) BETWEEN 1 AND 262144),
  CONSTRAINT runtime_authority_receipt_object CHECK (jsonb_typeof(receipt) = 'object')
);
--> statement-breakpoint
-- Closed structural validation from the accepted JSON schemas. No external trust decision.
CREATE FUNCTION occ.runtime_authority_shape(value jsonb, spec jsonb, depth integer DEFAULT 0) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  item jsonb;
  property text;
  child jsonb;
  scalar text;
  kind text := spec ->> 'type';
  source_time timestamptz;
  received_time timestamptz;
  valid_time timestamptz;
  previous_name text;
  image_name text;
BEGIN
  IF depth > 24 OR value IS NULL THEN
    RETURN false;
  END IF;
  IF spec ? 'anyOf' THEN
    FOR item IN SELECT jsonb_array_elements(spec -> 'anyOf') LOOP
      IF occ.runtime_authority_shape(value, item, depth + 1) THEN
        RETURN true;
      END IF;
    END LOOP;
    RETURN false;
  END IF;
  IF spec ? 'const' AND value IS DISTINCT FROM spec -> 'const' THEN
    RETURN false;
  END IF;
  IF spec ? 'enum' THEN
    RETURN EXISTS (
      SELECT 1
      FROM jsonb_array_elements(spec -> 'enum') AS choices(candidate)
      WHERE choices.candidate = value
    );
  END IF;
  IF kind = 'object' THEN
    IF jsonb_typeof(value) <> 'object' THEN
      RETURN false;
    END IF;
    FOR property IN
      SELECT jsonb_array_elements_text(coalesce(spec -> 'required', '[]'::jsonb))
    LOOP
      IF NOT value ? property THEN
        RETURN false;
      END IF;
    END LOOP;
    FOR property, child IN SELECT * FROM jsonb_each(value) LOOP
      IF NOT (spec -> 'properties') ? property
        OR NOT occ.runtime_authority_shape(child, spec -> 'properties' -> property, depth + 1) THEN
        RETURN false;
      END IF;
    END LOOP;
    source_time := (value ->> 'sourceObservedAt')::timestamptz;
    received_time := (value ->> 'receivedAt')::timestamptz;
    valid_time := (value ->> 'validUntil')::timestamptz;
    IF source_time > received_time + interval '2 seconds'
      OR valid_time < source_time
      OR valid_time > source_time + interval '15 seconds' THEN
      RETURN false;
    END IF;
    IF value ? 'imageDigests' THEN
      FOR item IN SELECT jsonb_array_elements(value -> 'imageDigests') LOOP
        image_name := item ->> 'name';
        IF previous_name COLLATE "C" >= image_name COLLATE "C" THEN
          RETURN false;
        END IF;
        previous_name := image_name;
      END LOOP;
    END IF;
  ELSIF kind = 'array' THEN
    IF jsonb_typeof(value) <> 'array' THEN
      RETURN false;
    END IF;
    IF jsonb_array_length(value) < coalesce((spec ->> 'minItems')::integer, 0)
      OR jsonb_array_length(value) > coalesce((spec ->> 'maxItems')::integer, 2147483647) THEN
      RETURN false;
    END IF;
    FOR item IN SELECT jsonb_array_elements(value) LOOP
      IF NOT occ.runtime_authority_shape(item, spec -> 'items', depth + 1) THEN
        RETURN false;
      END IF;
    END LOOP;
  ELSIF kind = 'integer' OR kind = 'number' THEN
    IF jsonb_typeof(value) <> 'number' THEN
      RETURN false;
    END IF;
    IF kind = 'integer' AND value::numeric <> trunc(value::numeric) THEN
      RETURN false;
    END IF;
    IF (spec ? 'minimum' AND value::numeric < (spec ->> 'minimum')::numeric)
      OR (spec ? 'maximum' AND value::numeric > (spec ->> 'maximum')::numeric) THEN
      RETURN false;
    END IF;
  ELSIF kind = 'string' THEN
    IF jsonb_typeof(value) <> 'string' THEN
      RETURN false;
    END IF;
    scalar := value #>> '{}';
    IF char_length(scalar) < coalesce((spec ->> 'minLength')::integer, 0)
      OR char_length(scalar) > coalesce((spec ->> 'maxLength')::integer, 2147483647)
      OR (spec ? 'pattern' AND scalar !~ (spec ->> 'pattern')) THEN
      RETURN false;
    END IF;
    -- Patterned canonical timestamps must also be real finite calendar instants.
    IF spec ->> 'pattern' LIKE '%T%Z$' THEN
      IF NOT isfinite(scalar::timestamptz)
        OR to_char(
          scalar::timestamptz AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) <> scalar THEN
        RETURN false;
      END IF;
    END IF;
  ELSIF kind = 'null' THEN
    IF value <> 'null'::jsonb THEN
      RETURN false;
    END IF;
  ELSIF kind = 'boolean' THEN
    IF jsonb_typeof(value) <> 'boolean' THEN
      RETURN false;
    END IF;
  ELSE
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION
  WHEN invalid_text_representation
    OR datetime_field_overflow
    OR invalid_datetime_format
    OR numeric_value_out_of_range THEN
    RETURN false;
END;
$$;
--> statement-breakpoint
-- The accepted values have ASCII field names and only safe integer numbers.
-- Comparing canonical bytes also rejects duplicate keys erased by jsonb parsing.
CREATE FUNCTION occ.runtime_authority_canonical(value jsonb, depth integer DEFAULT 0) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result text;
BEGIN
  IF depth > 24 THEN
    RAISE EXCEPTION 'runtime authority canonical depth invalid' USING ERRCODE = '23514';
  END IF;
  CASE jsonb_typeof(value)
  WHEN 'object' THEN
    SELECT '{' || coalesce(
      string_agg(
        to_jsonb(pair.key)::text || ':' || occ.runtime_authority_canonical(pair.item, depth + 1),
        ',' ORDER BY pair.key COLLATE "C"
      ),
      ''
    ) || '}'
    INTO result
    FROM jsonb_each(value) AS pair(key, item);
    RETURN result;
  WHEN 'array' THEN
    SELECT '[' || coalesce(
      string_agg(
        occ.runtime_authority_canonical(entry.item, depth + 1),
        ',' ORDER BY entry.position
      ),
      ''
    ) || ']'
    INTO result
    FROM jsonb_array_elements(value) WITH ORDINALITY AS entry(item, position);
    RETURN result;
  WHEN 'number' THEN
    RETURN trunc(value::numeric)::text;
  ELSE
    RETURN value::text;
  END CASE;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION occ.validate_runtime_authority_operation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  request jsonb := NEW.canonical_payload::jsonb;
  allocation occ.runtime_assignment_allocations%ROWTYPE;
  previous_version bigint;
  current_generation bigint;
  current_mode text;
  bound jsonb;
  expected_outcome jsonb;
  expected_receipt jsonb;
BEGIN
  IF NOT occ.runtime_authority_shape(request || jsonb_build_object('requestRef','storage/retained'), $runtime_mutation${"type":"object","required":["schemaVersion","operationRef","requestRef","target","expectedLifecycleGeneration","expectedAssignmentRecordVersion","kind","binding","expectedBindingVersion","observation","responsibilityRef","expectedResponsibilityVersion"],"properties":{"schemaVersion":{"type":"number","const":1},"operationRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"requestRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"target":{"type":"object","required":["installationId","namespaceId","agentId","assignmentRef","revisionId","component","lifecycleGeneration","runtimeGeneration","createEffectRef"],"properties":{"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"assignmentRef":{"type":"object","required":["schemaVersion","id"],"properties":{"schemaVersion":{"type":"number","const":1},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"revisionId":{"type":"string","pattern":"^rev_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"component":{"enum":["gateway","harness"]},"lifecycleGeneration":{"type":"integer","minimum":1,"maximum":9007199254740991},"runtimeGeneration":{"type":"integer","minimum":1,"maximum":9007199254740991},"createEffectRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"expectedLifecycleGeneration":{"type":"integer","minimum":1,"maximum":9007199254740991},"expectedAssignmentRecordVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"kind":{"type":"string","const":"bind"},"binding":{"type":"object","required":["schemaVersion","bindingVersion","clusterRef","kubernetesNamespaceUid","podUid","deploymentUid","replicaSetUid","imageDigests","policyRevision","admittedConfigurationDigest","profileDigests","provider","component","runtimeClass","runtimeHandler","runtimeType","platform","isolation","runscSandboxId","runtimeInstanceRef","protectedRestartDiscriminator","runtimeBinaryDigest","runtimeDistributionDigest","runtimeFlagsDigest"],"properties":{"schemaVersion":{"type":"number","const":1},"bindingVersion":{"type":"number","const":1},"clusterRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"kubernetesNamespaceUid":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"podUid":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"deploymentUid":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"replicaSetUid":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"imageDigests":{"type":"array","items":{"type":"object","required":["name","digest"],"properties":{"name":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"digest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"minItems":1,"maxItems":16},"policyRevision":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"admittedConfigurationDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"profileDigests":{"type":"object","required":["provider","runtime","identity"],"properties":{"provider":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"runtime":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"identity":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"provider":{"type":"string","const":"occ/kubernetes-gvisor"},"component":{"type":"string","const":"harness"},"runtimeClass":{"type":"string","const":"oce-gvisor-systrap"},"runtimeHandler":{"type":"string","const":"oce-gvisor-systrap"},"runtimeType":{"type":"string","const":"io.containerd.runsc.v1"},"platform":{"type":"string","const":"systrap"},"isolation":{"type":"string","const":"STRICT"},"runscSandboxId":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"runtimeInstanceRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"protectedRestartDiscriminator":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"runtimeBinaryDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"runtimeDistributionDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"runtimeFlagsDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"expectedBindingVersion":{"type":"null"},"observation":{"type":"object","required":["observationRef","ownerChainEvidenceRef","createEffectCorrelationRef","instanceEvidenceRef","sourceObservedAt","receivedAt","validUntil","uncertaintyMs"],"properties":{"observationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"ownerChainEvidenceRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"createEffectCorrelationRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"instanceEvidenceRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"sourceObservedAt":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"receivedAt":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"validUntil":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"uncertaintyMs":{"type":"integer","minimum":0,"maximum":2000}},"additionalProperties":false},"responsibilityRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"expectedResponsibilityVersion":{"type":"integer","minimum":1,"maximum":9007199254740991}},"additionalProperties":false}$runtime_mutation$::jsonb)
    OR NOT occ.runtime_authority_shape(jsonb_build_object('schemaVersion',1,'result','committed','receipt',NEW.receipt), $runtime_operationState${"anyOf":[{"type":"object","required":["schemaVersion","result","receipt"],"properties":{"schemaVersion":{"type":"number","const":1},"result":{"type":"string","const":"committed"},"receipt":{"type":"object","required":["schemaVersion","installationId","namespaceId","agentId","operationRef","operationKind","canonicalPayloadDigest","assignmentRef","acceptedServiceIdentityRef","committedAt","assignmentRecordVersion","outcome"],"properties":{"schemaVersion":{"type":"number","const":1},"installationId":{"type":"string","pattern":"^ins_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"namespaceId":{"type":"string","pattern":"^ns_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"agentId":{"type":"string","pattern":"^agt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"operationRef":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},"operationKind":{"type":"string","const":"bind"},"canonicalPayloadDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"assignmentRef":{"type":"object","required":["schemaVersion","id"],"properties":{"schemaVersion":{"type":"number","const":1},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"additionalProperties":false},"acceptedServiceIdentityRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"committedAt":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"assignmentRecordVersion":{"type":"integer","minimum":1,"maximum":9007199254740991},"outcome":{"type":"object","required":["kind","binding"],"properties":{"kind":{"type":"string","const":"bind"},"binding":{"type":"object","required":["schemaVersion","bindingVersion","clusterRef","kubernetesNamespaceUid","podUid","deploymentUid","replicaSetUid","imageDigests","policyRevision","admittedConfigurationDigest","profileDigests","provider","component","runtimeClass","runtimeHandler","runtimeType","platform","isolation","runscSandboxId","runtimeInstanceRef","protectedRestartDiscriminator","runtimeBinaryDigest","runtimeDistributionDigest","runtimeFlagsDigest"],"properties":{"schemaVersion":{"type":"number","const":1},"bindingVersion":{"type":"number","const":1},"clusterRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"kubernetesNamespaceUid":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"podUid":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"deploymentUid":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"replicaSetUid":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"imageDigests":{"type":"array","items":{"type":"object","required":["name","digest"],"properties":{"name":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"digest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"minItems":1,"maxItems":16},"policyRevision":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"admittedConfigurationDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"profileDigests":{"type":"object","required":["provider","runtime","identity"],"properties":{"provider":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"runtime":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"identity":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false},"provider":{"type":"string","const":"occ/kubernetes-gvisor"},"component":{"type":"string","const":"harness"},"runtimeClass":{"type":"string","const":"oce-gvisor-systrap"},"runtimeHandler":{"type":"string","const":"oce-gvisor-systrap"},"runtimeType":{"type":"string","const":"io.containerd.runsc.v1"},"platform":{"type":"string","const":"systrap"},"isolation":{"type":"string","const":"STRICT"},"runscSandboxId":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"runtimeInstanceRef":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"protectedRestartDiscriminator":{"type":"string","minLength":1,"maxLength":200,"pattern":"^[A-Za-z0-9._:/-]+$"},"runtimeBinaryDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"runtimeDistributionDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"},"runtimeFlagsDigest":{"type":"string","pattern":"^sha256:[0-9a-f]{64}$"}},"additionalProperties":false}},"additionalProperties":false}},"additionalProperties":false}},"additionalProperties":false},{"type":"object","required":["schemaVersion","result","nextAction"],"properties":{"schemaVersion":{"type":"number","const":1},"result":{"type":"string","const":"not-found"},"nextAction":{"type":"string","const":"exact-readback-only"}},"additionalProperties":false},{"type":"object","required":["schemaVersion","result","nextAction"],"properties":{"schemaVersion":{"type":"number","const":1},"result":{"type":"string","const":"unavailable"},"nextAction":{"type":"string","const":"exact-readback-only"}},"additionalProperties":false},{"type":"object","required":["schemaVersion","result","reasonCode"],"properties":{"schemaVersion":{"type":"number","const":1},"result":{"type":"string","const":"not-visible"},"reasonCode":{"type":"string","const":"scope-hidden"}},"additionalProperties":false},{"type":"object","required":["schemaVersion","result","reasonCode"],"properties":{"schemaVersion":{"type":"number","const":1},"result":{"type":"string","const":"conflict"},"reasonCode":{"type":"string","const":"operation-payload-mismatch"}},"additionalProperties":false}]}$runtime_operationState$::jsonb) THEN
    RAISE EXCEPTION 'runtime authority closed persisted shape invalid' USING ERRCODE = '23514';
  END IF;
  IF NEW.canonical_payload IS DISTINCT FROM occ.runtime_authority_canonical(request) THEN
    RAISE EXCEPTION 'runtime authority payload is not canonical' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('runtime-authority-operation:' || NEW.operation_ref, 0)
  );
  -- Same owner lock as admission/allocation; covers separate clients and direct SQL writers.
  PERFORM 1
  FROM occ.agents
  WHERE namespace_id = NEW.namespace_id AND id = NEW.agent_id
  FOR UPDATE;
  SELECT * INTO allocation
  FROM occ.runtime_assignment_allocations
  WHERE installation_id = NEW.installation_id AND namespace_id = NEW.namespace_id
    AND agent_id = NEW.agent_id AND assignment_ref = NEW.assignment_ref;
  IF NOT FOUND OR request -> 'target' IS DISTINCT FROM jsonb_build_object(
      'installationId', allocation.installation_id,
      'namespaceId', allocation.namespace_id,
      'agentId', allocation.agent_id,
      'assignmentRef', jsonb_build_object('schemaVersion', 1, 'id', allocation.assignment_ref),
      'revisionId', allocation.revision_id,
      'component', allocation.component,
      'lifecycleGeneration', allocation.lifecycle_generation,
      'runtimeGeneration', allocation.runtime_generation,
      'createEffectRef', allocation.create_effect_ref
    )
    OR request -> 'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR request ->> 'kind' IS DISTINCT FROM NEW.operation_kind
    OR request ->> 'operationRef' IS DISTINCT FROM NEW.operation_ref
    OR request ? 'requestRef' THEN
    RAISE EXCEPTION 'runtime authority exact owner/payload mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(max(assignment_record_version), 1)
  INTO previous_version
  FROM occ.runtime_authority_operations
  WHERE assignment_ref = NEW.assignment_ref;
  IF NEW.assignment_record_version <> previous_version + 1
    OR request -> 'expectedAssignmentRecordVersion' IS DISTINCT FROM to_jsonb(previous_version) THEN
    RAISE EXCEPTION 'runtime authority record version mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT head.generation, intent.desired_mode INTO current_generation, current_mode
  FROM occ.agent_runtime_intent_heads head
  JOIN occ.agent_runtime_intents intent ON intent.transition_ref = head.transition_ref
  WHERE head.namespace_id = NEW.namespace_id AND head.agent_id = NEW.agent_id;
  IF current_generation IS NULL
    OR request -> 'expectedLifecycleGeneration' IS DISTINCT FROM to_jsonb(current_generation) THEN
    RAISE EXCEPTION 'runtime authority lifecycle mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT receipt #> '{outcome,binding}' INTO bound
  FROM occ.runtime_authority_operations
  WHERE assignment_ref = NEW.assignment_ref AND operation_kind = 'bind'
  ORDER BY assignment_record_version
  LIMIT 1;
  IF current_mode <> 'running' OR current_generation <> allocation.lifecycle_generation
    OR request -> 'expectedBindingVersion' IS DISTINCT FROM 'null'::jsonb
    OR bound IS NOT NULL
    OR jsonb_typeof(request -> 'binding') IS DISTINCT FROM 'object'
    OR request #>> '{binding,component}' IS DISTINCT FROM allocation.component
    OR request #> '{binding,bindingVersion}' IS DISTINCT FROM '1'::jsonb THEN
    RAISE EXCEPTION 'runtime authority immutable binding mismatch' USING ERRCODE = '23514';
  END IF;
  expected_outcome := jsonb_build_object('kind', 'bind', 'binding', request -> 'binding');
  IF NEW.receipt ->> 'acceptedServiceIdentityRef' IS NULL
    OR NEW.receipt ->> 'acceptedServiceIdentityRef' !~ '^[A-Za-z0-9._:/-]{1,200}$'
    OR NEW.receipt ->> 'committedAt' IS NULL
    OR NOT isfinite((NEW.receipt ->> 'committedAt')::timestamptz) THEN
    RAISE EXCEPTION 'runtime authority attribution required' USING ERRCODE = '23514';
  END IF;
  expected_receipt := jsonb_build_object(
    'schemaVersion', 1,
    'installationId', NEW.installation_id,
    'namespaceId', NEW.namespace_id,
    'agentId', NEW.agent_id,
    'operationRef', NEW.operation_ref,
    'operationKind', NEW.operation_kind,
    'canonicalPayloadDigest', 'sha256:' || encode(sha256(convert_to(NEW.canonical_payload, 'UTF8')), 'hex'),
    'assignmentRef', jsonb_build_object('schemaVersion', 1, 'id', NEW.assignment_ref),
    'acceptedServiceIdentityRef', NEW.receipt -> 'acceptedServiceIdentityRef',
    'committedAt', NEW.receipt -> 'committedAt',
    'assignmentRecordVersion', NEW.assignment_record_version,
    'outcome', expected_outcome
  );
  IF NEW.receipt IS DISTINCT FROM expected_receipt THEN
    RAISE EXCEPTION 'runtime authority receipt does not match the exact mutation' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER runtime_authority_requires_exact_transition BEFORE INSERT ON occ.runtime_authority_operations
FOR EACH ROW EXECUTE FUNCTION occ.validate_runtime_authority_operation();
--> statement-breakpoint
CREATE TRIGGER runtime_authority_operations_are_immutable BEFORE UPDATE OR DELETE ON occ.runtime_authority_operations
FOR EACH ROW EXECUTE FUNCTION occ.reject_row_mutation();
--> statement-breakpoint
REVOKE ALL ON occ.runtime_authority_operations FROM PUBLIC, occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.validate_runtime_authority_operation() FROM PUBLIC, occ_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON occ.runtime_authority_operations TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.runtime_authority_shape(jsonb,jsonb,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.runtime_authority_shape(jsonb,jsonb,integer) TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.runtime_authority_canonical(jsonb,integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION occ.runtime_authority_canonical(jsonb,integer) TO occ_app;
