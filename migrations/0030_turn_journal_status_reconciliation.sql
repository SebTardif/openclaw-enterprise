-- Preserve the delivery episode and permit only a classified unknown status
-- to consume the existing single known-message update allowance.
LOCK TABLE occ.turn_journal_deliveries, occ.turn_journal_delivery_attempts IN ACCESS EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION occ.turn_journal_delivery_value_matches(row_value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, occ AS $$
  SELECT (
    row_value->'operation'->'attempt' = jsonb_build_object(
      'installationRef', row_value->'installation_id',
      'namespaceRef', row_value->'namespace_id',
      'agentRef', row_value->'agent_id',
      'conversationRef', row_value->'conversation_ref',
      'turnRef', row_value->'turn_ref',
      'attemptRef', row_value->'attempt_ref',
      'reservationRef', row_value->'reservation_ref')
    AND row_value->'operation'->>'operationRef' = row_value->>'operation_ref'
    AND row_value->'operation'->>'slot' = row_value->>'slot'
    AND row_value->'operation'#>>'{operation,kind}' IN ('create', 'update')
    -- Validate the only added member before projecting it out of the retained
    -- closed base definition. Every other operation member remains checked.
    AND (NOT (row_value->'operation' ? 'statusNoticeCode') OR (
      jsonb_typeof(row_value->'operation'->'statusNoticeCode') = 'string'
      AND row_value->'operation'->>'slot' = 'outcome-status'
      AND row_value->'operation'->>'statusNoticeCode' IN
        ('failed','interrupted','cancelled','outcome-unknown',
         'unavailable-before-dispatch','resolved-completed')
      AND CASE row_value->'operation'->>'statusNoticeCode'
        WHEN 'resolved-completed' THEN row_value->'operation'#>>'{operation,kind}' = 'update'
        WHEN 'outcome-unknown' THEN row_value->'operation'#>>'{operation,kind}' = 'create'
        WHEN 'unavailable-before-dispatch' THEN row_value->'operation'#>>'{operation,kind}' = 'create'
        ELSE true END
    ))
    AND occ.turn_journal_phase_value_valid('deliveryOperation',
      (row_value->'operation') - 'statusNoticeCode')
    AND (row_value->'outcome' = 'null'::jsonb OR (
      row_value->'outcome'->'operation' = row_value->'operation'
      AND occ.turn_journal_phase_value_valid('delivery', jsonb_set(
        row_value->'outcome', '{operation}',
        (row_value->'outcome'->'operation') - 'statusNoticeCode', false))
      AND row_value->'outcome'->>'deliveryAttemptRef' = row_value->>'delivery_attempt_ref'
      AND row_value->'outcome'#>>'{outcome,kind}' IN
        ('delivered', 'definitive-no-effect', 'delivery-unknown', 'suppressed')
    ))
  ) IS TRUE;
$$;

CREATE OR REPLACE FUNCTION occ.turn_journal_delivery_slot_transition()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  reserving boolean := false;
  current_attempt occ.turn_journal_attempts%ROWTYPE;
  completed occ.turn_journal_operations%ROWTYPE;
  current_head occ.turn_journal_heads%ROWTYPE;
  expected_head jsonb;
  notice_code text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Immutable turn journal delivery slot' USING ERRCODE = '23514';
  END IF;
  IF NOT occ.turn_journal_delivery_value_matches(to_jsonb(NEW)) THEN
    RAISE EXCEPTION 'Turn journal delivery value mismatch' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.operation #>> '{operation,kind}' IS DISTINCT FROM 'create'
      OR NEW.update_used OR NEW.attempt_number NOT IN (0, 1)
      OR NEW.outcome IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid initial turn journal delivery slot' USING ERRCODE = '23514';
    END IF;
    reserving := NEW.attempt_number = 1;
  ELSE
    IF to_jsonb(NEW) - ARRAY['operation_ref','operation','delivery_attempt_ref',
         'attempt_number','episode_started_at','outcome','update_used']
       IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY['operation_ref','operation','delivery_attempt_ref',
         'attempt_number','episode_started_at','outcome','update_used'] THEN
      RAISE EXCEPTION 'Turn journal delivery slot cannot be retargeted' USING ERRCODE = '23514';
    END IF;
    IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    IF OLD.episode_started_at IS NOT NULL
      AND NEW.episode_started_at IS DISTINCT FROM OLD.episode_started_at THEN
      RAISE EXCEPTION 'Turn journal delivery episode is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.update_used AND NOT NEW.update_used THEN
      RAISE EXCEPTION 'Turn journal delivery update budget is sticky' USING ERRCODE = '23514';
    END IF;
    IF NEW.operation IS DISTINCT FROM OLD.operation
      OR NEW.operation_ref IS DISTINCT FROM OLD.operation_ref THEN
      -- This is the sole operation replacement permitted in a slot. An exact
      -- prior delivered ID is required; ambiguous creates cannot become updates.
      IF OLD.slot <> 'outcome-status' OR OLD.update_used OR NOT NEW.update_used
        OR OLD.operation #>> '{operation,kind}' IS DISTINCT FROM 'create'
        OR OLD.operation->>'statusNoticeCode' IS DISTINCT FROM 'outcome-unknown'
        OR (NEW.operation->>'statusNoticeCode' IN ('failed','interrupted','cancelled','resolved-completed')) IS NOT TRUE
        OR ((NEW.operation->>'outcomeVersion')::numeric > (OLD.operation->>'outcomeVersion')::numeric) IS NOT TRUE
        OR NEW.operation #>> '{operation,kind}' IS DISTINCT FROM 'update'
        OR NEW.operation_ref = OLD.operation_ref
        OR OLD.outcome #>> '{outcome,kind}' IS DISTINCT FROM 'delivered'
        OR OLD.outcome #>> '{outcome,providerMessageRef}' IS NULL
        OR NEW.operation #>> '{operation,providerMessageRef}' IS DISTINCT FROM
           OLD.outcome #>> '{outcome,providerMessageRef}'
        OR NEW.operation - ARRAY['operationRef','outputRef','outputDigest','outcomeVersion','operation','statusNoticeCode']
           IS DISTINCT FROM
           OLD.operation - ARRAY['operationRef','outputRef','outputDigest','outcomeVersion','operation','statusNoticeCode']
        OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
        OR NEW.delivery_attempt_ref IS NULL
        OR NEW.delivery_attempt_ref IS NOT DISTINCT FROM OLD.delivery_attempt_ref
        OR NEW.outcome IS NOT NULL THEN
        RAISE EXCEPTION 'Invalid turn journal known-ID status update' USING ERRCODE = '23514';
      END IF;
      reserving := true;
    ELSIF NEW.delivery_attempt_ref IS DISTINCT FROM OLD.delivery_attempt_ref THEN
      IF OLD.operation #>> '{operation,kind}' IS DISTINCT FROM 'create'
        OR NEW.update_used IS DISTINCT FROM OLD.update_used OR OLD.update_used
        OR NEW.attempt_number <> OLD.attempt_number + 1
        OR NEW.attempt_number > 3 OR NEW.delivery_attempt_ref IS NULL
        OR NEW.outcome IS NOT NULL
        OR (OLD.attempt_number > 0 AND (
          OLD.outcome #>> '{outcome,kind}' IS DISTINCT FROM 'definitive-no-effect'
          OR OLD.outcome #>> '{outcome,retryClass}' IS DISTINCT FROM 'transient')) THEN
        RAISE EXCEPTION 'Invalid turn journal delivery retry' USING ERRCODE = '23514';
      END IF;
      reserving := true;
    ELSE
      IF NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
        OR NEW.update_used IS DISTINCT FROM OLD.update_used
        OR NEW.episode_started_at IS DISTINCT FROM OLD.episode_started_at
        OR OLD.outcome IS NOT NULL OR NEW.outcome IS NULL
        OR OLD.delivery_attempt_ref IS NULL THEN
        RAISE EXCEPTION 'Turn journal delivery outcome is immutable' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  IF reserving AND NEW.slot = 'outcome-status' THEN
    notice_code := NEW.operation->>'statusNoticeCode';
    -- The accepting boundary must authenticate output evidence. Here the
    -- classification must also name this exact canonical attempt state.
    SELECT * INTO current_attempt FROM occ.turn_journal_attempts a
    WHERE a.installation_id = NEW.installation_id AND a.namespace_id = NEW.namespace_id
      AND a.agent_id = NEW.agent_id AND a.conversation_ref = NEW.conversation_ref
      AND a.turn_ref = NEW.turn_ref AND a.attempt_ref = NEW.attempt_ref
      AND a.reservation_ref = NEW.reservation_ref FOR SHARE;
    IF NOT FOUND OR current_attempt.record IS NULL
      OR NEW.operation->'attempt' IS DISTINCT FROM current_attempt.record#>'{binding,attempt}'
      OR NEW.operation->'outcomeVersion' IS DISTINCT FROM current_attempt.record->'version'
      OR (NEW.operation->>'outcomeVersion')::numeric IS DISTINCT FROM current_attempt.version::numeric
      OR NEW.operation->'replyDestinationRef' IS DISTINCT FROM current_attempt.record#>'{binding,identity,replyDestinationRef}'
      OR NEW.operation->'replyBindingVersion' IS DISTINCT FROM current_attempt.record#>'{binding,identity,replyBindingVersion}' THEN
      RAISE EXCEPTION 'Turn journal status does not match the canonical attempt' USING ERRCODE = '23514';
    END IF;
    IF notice_code = 'resolved-completed' THEN
      IF current_attempt.record#>>'{outcome,kind}' IS DISTINCT FROM 'completed'
        OR NEW.operation#>>'{operation,kind}' IS DISTINCT FROM 'update' THEN
        RAISE EXCEPTION 'Turn journal completed status requires reconciliation' USING ERRCODE = '23514';
      END IF;
      SELECT * INTO completed FROM occ.turn_journal_operations op
      WHERE op.installation_id = NEW.installation_id AND op.namespace_id = NEW.namespace_id
        AND op.agent_id = NEW.agent_id AND op.conversation_ref = NEW.conversation_ref
        AND op.turn_ref = NEW.turn_ref AND op.attempt_ref = NEW.attempt_ref
        AND op.reservation_ref = NEW.reservation_ref AND op.operation_kind = 'completion'
        AND op.operation_ref = current_attempt.record#>>'{outcome,completionOperationRef}';
      expected_head := current_attempt.record#>'{binding,expectedHead}';
      IF NOT FOUND OR NOT occ.turn_journal_phase_value_valid('completion', completed.record)
        OR completed.record->'operation' IS DISTINCT FROM completed.request
        OR completed.request->'operationRef' IS DISTINCT FROM current_attempt.record#>'{outcome,completionOperationRef}'
        OR completed.request->'attempt' IS DISTINCT FROM NEW.operation->'attempt'
        OR completed.record->'checkpoint' IS DISTINCT FROM current_attempt.record#>'{outcome,checkpoint}'
        OR ((completed.record->'checkpoint') @> (NEW.operation->'attempt')) IS NOT TRUE
        OR completed.record#>'{checkpoint,workspaceBindingRef}' IS DISTINCT FROM current_attempt.record#>'{binding,identity,workspace,bindingRef}'
        OR completed.record#>'{checkpoint,revisionRef}' IS DISTINCT FROM current_attempt.record#>'{binding,identity,admittedRevisionRef}'
        OR completed.record#>'{checkpoint,admittedConfigurationDigest}' IS DISTINCT FROM current_attempt.record#>'{binding,identity,admittedConfigurationDigest}'
        OR completed.record#>'{checkpoint,producingGatewayAssignmentRef}' IS DISTINCT FROM current_attempt.record#>'{binding,identity,gatewayAssignment,id}'
        OR completed.record#>'{checkpoint,producingHarnessAssignmentRef}' IS DISTINCT FROM current_attempt.record#>'{binding,identity,harnessAssignment,id}'
        OR completed.record#>'{head,context}' IS DISTINCT FROM expected_head->'context'
        OR completed.record#>'{head,creationRef}' IS DISTINCT FROM expected_head->'creationRef'
        OR completed.record#>'{head,checkpointId}' IS DISTINCT FROM completed.record#>'{checkpoint,checkpointId}'
        OR completed.record#>'{head,completionSequence}' IS DISTINCT FROM completed.record#>'{checkpoint,completionSequence}'
        OR completed.record#>'{checkpoint,parentCheckpointId}' IS DISTINCT FROM expected_head->'checkpointId'
        OR ((completed.record#>>'{head,headVersion}')::numeric = (expected_head->>'headVersion')::numeric + 1) IS NOT TRUE
        OR ((completed.record#>>'{head,completionSequence}')::numeric = (expected_head->>'completionSequence')::numeric + 1) IS NOT TRUE
        OR ((completed.record->>'outcomeVersion')::numeric = (completed.request->>'expectedAttemptVersion')::numeric + 1) IS NOT TRUE
        OR ((completed.record->>'outcomeVersion')::numeric > (OLD.operation->>'outcomeVersion')::numeric
          AND (completed.record->>'outcomeVersion')::numeric <= current_attempt.version) IS NOT TRUE THEN
        RAISE EXCEPTION 'Turn journal completed status has no exact publication' USING ERRCODE = '23514';
      END IF;
      SELECT * INTO current_head FROM occ.turn_journal_heads h
      WHERE h.installation_id = NEW.installation_id AND h.namespace_id = NEW.namespace_id
        AND h.agent_id = NEW.agent_id AND h.conversation_ref = NEW.conversation_ref;
      -- The immutable completion operation was atomically published with this
      -- exact head. The same creation can advance without erasing that record.
      IF NOT FOUND
        OR current_head.record->'context' IS DISTINCT FROM completed.record#>'{head,context}'
        OR current_head.record->'creationRef' IS DISTINCT FROM completed.record#>'{head,creationRef}'
        OR ((current_head.record->>'completionSequence')::numeric >= (completed.record#>>'{head,completionSequence}')::numeric) IS NOT TRUE
        OR ((current_head.record->>'headVersion')::numeric - (completed.record#>>'{head,headVersion}')::numeric
          = (current_head.record->>'completionSequence')::numeric - (completed.record#>>'{head,completionSequence}')::numeric) IS NOT TRUE
        OR (current_head.record->'completionSequence' = completed.record#>'{head,completionSequence}' AND (
          current_head.record IS DISTINCT FROM completed.record->'head'
          OR current_head.checkpoint IS DISTINCT FROM completed.record->'checkpoint')) THEN
        RAISE EXCEPTION 'Turn journal completed status publication lineage mismatch' USING ERRCODE = '23514';
      END IF;
    ELSIF (notice_code IN ('failed','interrupted','cancelled','outcome-unknown')
      AND notice_code = current_attempt.record#>>'{outcome,kind}') IS NOT TRUE THEN
      -- A null consumption field is not affirmative no-intent evidence for an
      -- unavailable-before-dispatch notice. This guard adds no such producer.
      RAISE EXCEPTION 'Turn journal status classification is not established' USING ERRCODE = '23514';
    END IF;
  END IF;
  now_at := clock_timestamp();
  IF reserving AND (NEW.episode_started_at IS NULL
    OR NOT isfinite(NEW.episode_started_at)
    OR NEW.episode_started_at > now_at
    OR now_at >= NEW.episode_started_at + interval '120 seconds') THEN
    RAISE EXCEPTION 'Turn journal delivery episode is expired' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION occ.turn_journal_delivery_history_complete()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE
  slot_row occ.turn_journal_deliveries%ROWTYPE;
  history_row occ.turn_journal_delivery_attempts%ROWTYPE;
  create_operation jsonb;
  previous_outcome jsonb;
  last_create_outcome jsonb;
  create_count integer := 0;
  update_count integer := 0;
  current_found boolean := false;
BEGIN
  SELECT * INTO slot_row FROM occ.turn_journal_deliveries
  WHERE installation_id = NEW.installation_id AND namespace_id = NEW.namespace_id
    AND agent_id = NEW.agent_id AND conversation_ref = NEW.conversation_ref
    AND turn_ref = NEW.turn_ref AND attempt_ref = NEW.attempt_ref
    AND reservation_ref = NEW.reservation_ref AND slot = NEW.slot;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Turn journal delivery history has no slot' USING ERRCODE = '23514';
  END IF;
  -- Read final transaction state, not the potentially superseded deferred NEW
  -- snapshot. Each update/reserve has already passed its immediate transition.
  FOR history_row IN
    SELECT * FROM occ.turn_journal_delivery_attempts
    WHERE installation_id = slot_row.installation_id AND namespace_id = slot_row.namespace_id
      AND agent_id = slot_row.agent_id AND conversation_ref = slot_row.conversation_ref
      AND turn_ref = slot_row.turn_ref AND attempt_ref = slot_row.attempt_ref
      AND reservation_ref = slot_row.reservation_ref AND slot = slot_row.slot
    ORDER BY CASE WHEN operation #>> '{operation,kind}' = 'create' THEN 0 ELSE 1 END,
      attempt_number
  LOOP
    IF history_row.episode_started_at IS DISTINCT FROM slot_row.episode_started_at THEN
      RAISE EXCEPTION 'Turn journal delivery history episode mismatch' USING ERRCODE = '23514';
    END IF;
    IF history_row.operation #>> '{operation,kind}' = 'create' THEN
      create_count := create_count + 1;
      IF create_count = 1 THEN create_operation := history_row.operation; END IF;
      IF history_row.attempt_number <> create_count
        OR history_row.operation IS DISTINCT FROM create_operation
        OR (create_count > 1 AND (
          previous_outcome #>> '{outcome,kind}' IS DISTINCT FROM 'definitive-no-effect'
          OR previous_outcome #>> '{outcome,retryClass}' IS DISTINCT FROM 'transient')) THEN
        RAISE EXCEPTION 'Turn journal delivery create history mismatch' USING ERRCODE = '23514';
      END IF;
      previous_outcome := history_row.outcome;
      last_create_outcome := history_row.outcome;
    ELSE
      update_count := update_count + 1;
      IF update_count > 1 OR history_row.attempt_number <> 1
        OR history_row.slot <> 'outcome-status' OR NOT slot_row.update_used
        -- Unclassified history remains unclassified. The immediate slot guard
        -- prevents any new update from using that historical exception.
        OR ((create_operation ? 'statusNoticeCode' OR history_row.operation ? 'statusNoticeCode') AND (
          create_operation->>'statusNoticeCode' IS DISTINCT FROM 'outcome-unknown'
          OR (history_row.operation->>'statusNoticeCode' IN ('failed','interrupted','cancelled','resolved-completed')) IS NOT TRUE
          OR ((history_row.operation->>'outcomeVersion')::numeric > (create_operation->>'outcomeVersion')::numeric) IS NOT TRUE))
        OR history_row.operation IS DISTINCT FROM slot_row.operation
        OR last_create_outcome #>> '{outcome,kind}' IS DISTINCT FROM 'delivered'
        OR last_create_outcome #>> '{outcome,providerMessageRef}' IS NULL
        OR history_row.operation #>> '{operation,providerMessageRef}' IS DISTINCT FROM
           last_create_outcome #>> '{outcome,providerMessageRef}'
        OR history_row.operation - ARRAY['operationRef','outputRef','outputDigest','outcomeVersion','operation','statusNoticeCode']
           IS DISTINCT FROM
           create_operation - ARRAY['operationRef','outputRef','outputDigest','outcomeVersion','operation','statusNoticeCode'] THEN
        RAISE EXCEPTION 'Turn journal delivery update history mismatch' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF history_row.delivery_attempt_ref = slot_row.delivery_attempt_ref THEN
      IF history_row.operation IS DISTINCT FROM slot_row.operation
        OR history_row.operation_ref IS DISTINCT FROM slot_row.operation_ref
        OR history_row.outcome IS DISTINCT FROM slot_row.outcome
        OR history_row.attempt_number <> (CASE WHEN slot_row.update_used THEN 1 ELSE slot_row.attempt_number END) THEN
        RAISE EXCEPTION 'Turn journal current delivery history mismatch' USING ERRCODE = '23514';
      END IF;
      current_found := true;
    END IF;
  END LOOP;
  IF create_count <> slot_row.attempt_number
    OR update_count <> (CASE WHEN slot_row.update_used THEN 1 ELSE 0 END)
    OR (slot_row.attempt_number > 0 AND NOT current_found)
    OR (NOT slot_row.update_used AND slot_row.attempt_number > 0
      AND slot_row.operation IS DISTINCT FROM create_operation) THEN
    RAISE EXCEPTION 'Turn journal delivery reservation history is incomplete' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
