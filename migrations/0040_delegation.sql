-- Delegation storage only: the accepting owner supplies genuine current authority and audit.
CREATE TABLE occ.delegation_roots (
 installation_id text NOT NULL REFERENCES occ.installation(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
 namespace_id text NOT NULL, agent_id text NOT NULL, grant_ref text NOT NULL,
 mediation_context_ref text NOT NULL, root_grant jsonb NOT NULL,
 status text NOT NULL CHECK (status IN ('active','closed','revoked')),
 version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY (installation_id,namespace_id,agent_id,grant_ref),
 UNIQUE (installation_id,namespace_id,agent_id,mediation_context_ref),
 FOREIGN KEY (namespace_id,agent_id) REFERENCES occ.agents(namespace_id,id) ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE occ.delegation_operations (
 installation_id text NOT NULL, namespace_id text NOT NULL, agent_id text NOT NULL,
 grant_ref text NOT NULL, operation_ref text NOT NULL, admission jsonb NOT NULL,
 status text NOT NULL CHECK (status IN ('accepted','dispatched','unknown','completed','cancelled')),
 outcome text, dispatched_at text,
 root_version bigint NOT NULL CHECK (root_version BETWEEN 1 AND 9007199254740991),
 version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
 PRIMARY KEY (installation_id,namespace_id,agent_id,operation_ref),
 UNIQUE (installation_id,namespace_id,agent_id,grant_ref,operation_ref),
 FOREIGN KEY (installation_id,namespace_id,agent_id,grant_ref)
 REFERENCES occ.delegation_roots(installation_id,namespace_id,agent_id,grant_ref) ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE occ.delegation_root_history (
 installation_id text NOT NULL, namespace_id text NOT NULL, agent_id text NOT NULL,
 grant_ref text NOT NULL, version bigint NOT NULL, record jsonb NOT NULL,
 PRIMARY KEY (installation_id,namespace_id,agent_id,grant_ref,version),
 FOREIGN KEY (installation_id,namespace_id,agent_id,grant_ref)
 REFERENCES occ.delegation_roots(installation_id,namespace_id,agent_id,grant_ref) ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE occ.delegation_operation_history (
 installation_id text NOT NULL, namespace_id text NOT NULL, agent_id text NOT NULL,
 grant_ref text NOT NULL, operation_ref text NOT NULL, version bigint NOT NULL, record jsonb NOT NULL,
 PRIMARY KEY (installation_id,namespace_id,agent_id,operation_ref,version),
 FOREIGN KEY (installation_id,namespace_id,agent_id,grant_ref,operation_ref)
 REFERENCES occ.delegation_operations(installation_id,namespace_id,agent_id,grant_ref,operation_ref) ON UPDATE RESTRICT ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE FUNCTION occ.delegation_root_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Delegation mutations require READ COMMITTED' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Delegation roots cannot be deleted' USING ERRCODE='23514'; END IF;
 PERFORM id FROM occ.namespaces WHERE id=NEW.namespace_id FOR UPDATE;
 PERFORM id FROM occ.agents WHERE namespace_id=NEW.namespace_id AND id=NEW.agent_id FOR UPDATE;
 IF TG_OP='INSERT' THEN
  IF NOT occ.runtime_authority_shape(NEW.root_grant,$grant${"type":"object","properties":{"schemaVersion":{"type":"integer","const":1},"grantRef":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"mediationContextRef":{"type":"string","pattern":"^[A-Za-z0-9._:-]{1,128}$"},"holder":{"type":"object","properties":{"installationId":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"namespaceId":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"agentId":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"agentRevisionId":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"servicePrincipalId":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"providerProfileRef":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"runtimeProfileRef":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"identityProfileRef":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"assignmentRef":{"type":"object","properties":{"schemaVersion":{"type":"integer","const":1},"id":{"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}},"required":["schemaVersion","id"],"additionalProperties":false},"component":{"type":"string","const":"harness"},"lifecycleGeneration":{"type":"integer","minimum":1,"maximum":9007199254740991},"runtimeGeneration":{"type":"integer","minimum":1,"maximum":9007199254740991}},"required":["installationId","namespaceId","agentId","agentRevisionId","servicePrincipalId","providerProfileRef","runtimeProfileRef","identityProfileRef","assignmentRef","component","lifecycleGeneration","runtimeGeneration"],"additionalProperties":false},"turn":{"type":"object","properties":{"principalId":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"conversationRef":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"turnRef":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"attemptRef":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"commonGrantRef":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"}},"required":["principalId","conversationRef","turnRef","attemptRef","commonGrantRef"],"additionalProperties":false},"audienceRef":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"operations":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"object","properties":{"kind":{"type":"string","const":"model.generate"},"providerBindingRef":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"modelId":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"transportProfileRef":{"type":"string","const":"codex-responses-http-v1"}},"required":["kind","providerBindingRef","modelId","transportProfileRef"],"additionalProperties":false}},"issuedAt":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"notBefore":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"expiresAt":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"maxRequests":{"type":"integer","minimum":1,"maximum":9007199254740991},"maxConcurrentRequests":{"type":"integer","minimum":1,"maximum":9007199254740991},"status":{"enum":["active","closed","revoked"]}},"required":["schemaVersion","grantRef","mediationContextRef","holder","turn","audienceRef","operations","issuedAt","notBefore","expiresAt","maxRequests","maxConcurrentRequests","status"],"additionalProperties":false}$grant$::jsonb)
   OR NEW.version<>1 OR NEW.status IS DISTINCT FROM NEW.root_grant->>'status'
   OR NEW.installation_id IS DISTINCT FROM NEW.root_grant#>>'{holder,installationId}'
   OR NEW.namespace_id IS DISTINCT FROM NEW.root_grant#>>'{holder,namespaceId}'
   OR NEW.agent_id IS DISTINCT FROM NEW.root_grant#>>'{holder,agentId}'
   OR NEW.grant_ref IS DISTINCT FROM NEW.root_grant->>'grantRef'
   OR NEW.mediation_context_ref IS DISTINCT FROM NEW.root_grant->>'mediationContextRef'
   OR (NEW.root_grant->>'issuedAt')::timestamptz>(NEW.root_grant->>'notBefore')::timestamptz
   OR (NEW.root_grant->>'notBefore')::timestamptz>=(NEW.root_grant->>'expiresAt')::timestamptz
   OR (NEW.root_grant->>'maxConcurrentRequests')::bigint>(NEW.root_grant->>'maxRequests')::bigint
   OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(NEW.root_grant->'operations'))<>jsonb_array_length(NEW.root_grant->'operations')
  THEN RAISE EXCEPTION 'Invalid delegation root' USING ERRCODE='23514'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['status','version']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version'])
   OR NEW.version<>OLD.version+1
   OR NOT ((OLD.status='active' AND NEW.status IN ('closed','revoked')) OR (OLD.status='closed' AND NEW.status='revoked'))
  THEN RAISE EXCEPTION 'Invalid delegation retirement' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER delegation_root_guard BEFORE INSERT OR UPDATE OR DELETE ON occ.delegation_roots
FOR EACH ROW EXECUTE FUNCTION occ.delegation_root_guard();
--> statement-breakpoint
CREATE FUNCTION occ.delegation_operation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE parent occ.delegation_roots%ROWTYPE; now_time timestamptz; used_count bigint; active_count bigint;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'Delegation mutations require READ COMMITTED' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Delegation operations cannot be deleted' USING ERRCODE='23514'; END IF;
 PERFORM id FROM occ.namespaces WHERE id=NEW.namespace_id FOR UPDATE;
 PERFORM id FROM occ.agents WHERE namespace_id=NEW.namespace_id AND id=NEW.agent_id FOR UPDATE;
 SELECT * INTO STRICT parent FROM occ.delegation_roots WHERE
 (installation_id,namespace_id,agent_id,grant_ref)=(NEW.installation_id,NEW.namespace_id,NEW.agent_id,NEW.grant_ref) FOR UPDATE;
 now_time:=clock_timestamp();
 IF TG_OP='INSERT' THEN
  IF NOT occ.runtime_authority_shape(NEW.admission,$operation${"type":"object","properties":{"operationRef":{"type":"string","pattern":"^[0-9a-f]{64}$"},"grantRef":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"operation":{"type":"object","properties":{"kind":{"type":"string","const":"model.generate"},"providerBindingRef":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"modelId":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"transportProfileRef":{"type":"string","const":"codex-responses-http-v1"}},"required":["kind","providerBindingRef","modelId","transportProfileRef"],"additionalProperties":false},"requestDigest":{"type":"string","pattern":"^[0-9a-f]{64}$"},"decisionRef":{"type":"string","pattern":"^[A-Za-z0-9._:/-]{1,200}$"},"acceptedAt":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"dispatchBefore":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"expiresAt":{"type":"string","pattern":"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"},"dispatchedAt":{"type":"null"},"status":{"type":"string","const":"accepted"},"outcome":{"type":"null"}},"required":["operationRef","grantRef","operation","requestDigest","decisionRef","acceptedAt","dispatchBefore","expiresAt","dispatchedAt","status","outcome"],"additionalProperties":false}$operation$::jsonb)
   OR NEW.version<>1 OR NEW.status<>'accepted' OR NEW.outcome IS NOT NULL OR NEW.dispatched_at IS NOT NULL
   OR NEW.operation_ref IS DISTINCT FROM NEW.admission->>'operationRef'
   OR NEW.grant_ref IS DISTINCT FROM NEW.admission->>'grantRef'
   OR (NEW.admission->>'acceptedAt')::timestamptz>=(NEW.admission->>'dispatchBefore')::timestamptz
   OR (NEW.admission->>'dispatchBefore')::timestamptz>(NEW.admission->>'expiresAt')::timestamptz
   OR (NEW.admission->>'acceptedAt')::timestamptz<(parent.root_grant->>'notBefore')::timestamptz
   OR (NEW.admission->>'expiresAt')::timestamptz>(parent.root_grant->>'expiresAt')::timestamptz
   OR NOT parent.root_grant->'operations' @> jsonb_build_array(NEW.admission->'operation')
  THEN RAISE EXCEPTION 'Invalid delegation admission' USING ERRCODE='23514'; END IF;
  SELECT count(*),count(*) FILTER (WHERE status IN ('accepted','dispatched','unknown')) INTO used_count,active_count
   FROM occ.delegation_operations WHERE
   (installation_id,namespace_id,agent_id,grant_ref)=(NEW.installation_id,NEW.namespace_id,NEW.agent_id,NEW.grant_ref);
  IF used_count>=(parent.root_grant->>'maxRequests')::bigint OR active_count>=(parent.root_grant->>'maxConcurrentRequests')::bigint
  THEN RAISE EXCEPTION 'Delegation request budget exhausted' USING ERRCODE='23514'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['status','outcome','dispatched_at','root_version','version']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['status','outcome','dispatched_at','root_version','version'])
   OR NEW.version<>OLD.version+1
   OR OLD.status IN ('completed','cancelled')
   OR NOT ((OLD.status='accepted' AND NEW.status IN ('dispatched','cancelled','unknown'))
     OR (OLD.status='dispatched' AND NEW.status IN ('completed','cancelled','unknown'))
     OR (OLD.status='unknown' AND NEW.status IN ('completed','cancelled')))
  THEN RAISE EXCEPTION 'Invalid delegation operation transition' USING ERRCODE='23514'; END IF;
  IF NEW.status='dispatched' THEN
   IF NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at THEN RAISE EXCEPTION 'Dispatch time is database-owned' USING ERRCODE='23514'; END IF;
   NEW.dispatched_at:=to_char(now_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  ELSIF NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at OR NEW.root_version<>OLD.root_version THEN
   RAISE EXCEPTION 'Consumed dispatch binding is immutable' USING ERRCODE='23514';
  END IF;
 END IF;
 IF TG_OP='INSERT' OR NEW.status='dispatched' THEN
  IF parent.status<>'active' OR parent.version<>NEW.root_version
   OR now_time<(parent.root_grant->>'notBefore')::timestamptz OR now_time>=(parent.root_grant->>'expiresAt')::timestamptz
   OR now_time<(NEW.admission->>'acceptedAt')::timestamptz OR now_time>=(NEW.admission->>'dispatchBefore')::timestamptz
  THEN RAISE EXCEPTION 'Delegation is inactive, stale or outside dispatch window' USING ERRCODE='23514'; END IF;
 END IF;
 IF NOT coalesce(((NEW.status IN ('accepted','dispatched') AND NEW.outcome IS NULL)
   OR (NEW.status='completed' AND NEW.outcome IN ('ended','stopped') AND NEW.dispatched_at IS NOT NULL)
   OR (NEW.status='cancelled' AND NEW.outcome='not-dispatched')
   OR (NEW.status='unknown' AND NEW.outcome='unknown')),false)
   OR (NEW.status='accepted' AND NEW.dispatched_at IS NOT NULL)
 THEN RAISE EXCEPTION 'Invalid delegation outcome' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER delegation_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON occ.delegation_operations
FOR EACH ROW EXECUTE FUNCTION occ.delegation_operation_guard();
--> statement-breakpoint
CREATE FUNCTION occ.delegation_history_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
DECLARE current_record jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Delegation history is immutable' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='delegation_root_history' THEN
  SELECT to_jsonb(r) INTO current_record FROM occ.delegation_roots r WHERE
   (installation_id,namespace_id,agent_id,grant_ref,version)=(NEW.installation_id,NEW.namespace_id,NEW.agent_id,NEW.grant_ref,NEW.version);
 ELSE
  SELECT to_jsonb(o) INTO current_record FROM occ.delegation_operations o WHERE
   (installation_id,namespace_id,agent_id,grant_ref,operation_ref,version)=(NEW.installation_id,NEW.namespace_id,NEW.agent_id,NEW.grant_ref,NEW.operation_ref,NEW.version);
 END IF;
 IF current_record IS NULL OR NEW.record IS DISTINCT FROM current_record THEN
  RAISE EXCEPTION 'Delegation history does not match its transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER delegation_root_history_guard BEFORE INSERT OR UPDATE OR DELETE ON occ.delegation_root_history
FOR EACH ROW EXECUTE FUNCTION occ.delegation_history_guard();
--> statement-breakpoint
CREATE TRIGGER delegation_operation_history_guard BEFORE INSERT OR UPDATE OR DELETE ON occ.delegation_operation_history
FOR EACH ROW EXECUTE FUNCTION occ.delegation_history_guard();
--> statement-breakpoint
CREATE FUNCTION occ.delegation_append_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, occ AS $$
BEGIN
 IF TG_TABLE_NAME='delegation_roots' THEN
  INSERT INTO occ.delegation_root_history VALUES (NEW.installation_id,NEW.namespace_id,NEW.agent_id,NEW.grant_ref,NEW.version,to_jsonb(NEW));
 ELSE
  INSERT INTO occ.delegation_operation_history VALUES (NEW.installation_id,NEW.namespace_id,NEW.agent_id,NEW.grant_ref,NEW.operation_ref,NEW.version,to_jsonb(NEW));
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER delegation_root_history AFTER INSERT OR UPDATE ON occ.delegation_roots
FOR EACH ROW EXECUTE FUNCTION occ.delegation_append_history();
--> statement-breakpoint
CREATE TRIGGER delegation_operation_history AFTER INSERT OR UPDATE ON occ.delegation_operations
FOR EACH ROW EXECUTE FUNCTION occ.delegation_append_history();
--> statement-breakpoint
REVOKE ALL ON occ.delegation_roots,occ.delegation_operations,occ.delegation_root_history,occ.delegation_operation_history FROM PUBLIC,occ_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON occ.delegation_roots,occ.delegation_operations,occ.delegation_root_history,occ.delegation_operation_history TO occ_app;
--> statement-breakpoint
GRANT UPDATE (status,version) ON occ.delegation_roots TO occ_app;
--> statement-breakpoint
GRANT UPDATE (status,outcome,dispatched_at,root_version,version) ON occ.delegation_operations TO occ_app;
--> statement-breakpoint
REVOKE ALL ON FUNCTION occ.delegation_root_guard(),occ.delegation_operation_guard(),occ.delegation_history_guard(),occ.delegation_append_history() FROM PUBLIC,occ_app;
